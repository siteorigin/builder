import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { installComponent } from '@engine/install';
import { compile } from 'svelte/compiler';
import { COMPONENT_PREVIEW_ROUTE, PREVIEW_COMPONENT_STYLES, PREVIEW_KEY, PREVIEW_META, PREVIEW_MODULE, previewKeyOf } from '@shared/component-preview';
import { devPlugin } from '@runtime/dev-plugin';
import { clearComponentPreviews, previewSpec, removeComponentPreview, writeComponentPreview } from '../../src/main/runtime/component-preview';
import { generateComponentPreview, PREVIEW_NODE_ID } from '@generator/preview';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';

const starter = () => createStarterState('blank', 'Preview Studio', false);

/** The files of a preview that is expected to work. */
function preview(state: ProjectState, spec: Parameters<typeof generateComponentPreview>[1]) {
  const out = generateComponentPreview(state, spec);
  if ('error' in out) throw new Error(out.error);
  return out;
}

/** A code component with a variant axis, made through the same operations the editor uses. */
function withCodeComponent(state: ProjectState) {
  const source = `<script>\n\tlet { title = 'Hello', variant = 'plain', variant_size = 'small', so_o, class: className = '' } = $props();\n</script>\n\n<p class="sample {className} sample--{variant} sample--{variant_size}">{title}</p>\n`;
  const made = applyOperations(state, [{ type: 'component.createCode', name: 'Sample note', source, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }]);
  const id = made.results[0].definitionId as string;
  const withAxis = applyOperations(made.state, [
    { type: 'component.setVariant', definitionId: id, axis: 'tone', axisLabel: 'Tone', variant: 'plain', label: 'Plain', makeDefault: true },
    { type: 'component.setVariant', definitionId: id, axis: 'tone', variant: 'loud', label: 'Loud' },
    { type: 'component.setVariant', definitionId: id, axis: 'size', axisLabel: 'Size', variant: 'small', label: 'Small', makeDefault: true },
    { type: 'component.setVariant', definitionId: id, axis: 'size', variant: 'big', label: 'Big' }
  ]);
  return { state: withAxis.state, id };
}

describe('isolated component preview files', () => {
  it('shows a catalogue component the project does not have, without adding it to the project', () => {
    const state = starter();
    const source = catalogueComponent(state.site.themeId, 'content.media')!;
    expect(state.components[source.id]).toBeUndefined();
    const before = JSON.stringify(state);
    const out = preview(state, { componentId: 'content.media', variants: { layout: 'media-end' }, props: { heading: 'A sample heading' } });
    expect(JSON.stringify(state)).toBe(before);
    expect(out.definitionId).toBe(source.id);
    const module = out.files.get(PREVIEW_MODULE)!;
    // The component's own generated file comes with the preview, and the preview imports it where it is.
    expect(out.files.has(defFile(source))).toBe(true);
    expect(module).toContain(`from "../generated/${defFile(source).split('/').pop()}"`);
    expect(module).toContain('variant_layout="media-end"');
    expect(module).toContain('heading={"A sample heading"}');
    // Its styles, variants included, are in the preview's component stylesheet.
    expect(out.files.get(PREVIEW_COMPONENT_STYLES)).toMatch(/--layout-media-end/);
    // Identity attributes for the bridge's measurements, under a context no page uses.
    expect(module).toContain(`__so={"preview:${source.id}|${PREVIEW_NODE_ID}"}`);
    // The project's tokens, base styles and fonts are loaded from the project, never copied.
    for (const path of out.files.keys()) expect(path).not.toMatch(/styles\/(tokens|theme|site)\.css$|\/fonts\//);
  });

  it('shows the design’s own list items under their own IDs, the same in every preview of it', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const def = state.components[id];
    const list = Object.entries(def.properties).find(([, s]) => s.type === 'list' && !s.feed && s.default.length);
    expect(list).toBeDefined();
    const ids = (list![1].default as Array<{ id: string }>).map((it) => it.id);
    const first = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    const second = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    // Component Studio keeps an item picked across edits only while the next preview names it the same way.
    expect(second).toBe(first);
    for (const itemId of ids) expect(first).toContain(`{"id":${JSON.stringify(itemId)},`);
  });

  it('gives starting items a hand-edited document left without an ID, or sharing one, IDs of the preview’s own', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const def = state.components[id];
    const [name, schema] = Object.entries(def.properties).find(([, s]) => s.type === 'list' && !s.feed && s.default.length >= 2)!;
    const [a, b] = schema.default as Array<{ id: string }>;
    // A row without an ID, then one that repeats another's.
    def.properties[name] = { ...schema, default: [{ ...b, id: undefined }, { ...a }, { ...a }, { ...b }] } as typeof schema;
    const first = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    expect(preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)).toBe(first);
    const shown = [...first.matchAll(/\{"id":"([^"]+)",/g)].map((m) => m[1]);
    expect(shown).toEqual(['preview-item-0', a.id, 'preview-item-2', b.id]);
  });

  it('renders each variant choice, and an axis left out keeps its default', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const base = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    const two = preview(state, { definitionId: id, variants: { layout: 'two-columns' } }).files.get(PREVIEW_MODULE)!;
    const tone = Object.keys(state.components[id].variantAxes!.tone.options).at(-1)!;
    expect(tone).not.toBe(state.components[id].variantAxes!.tone.default);
    const four = preview(state, { definitionId: id, variants: { layout: 'four-columns', tone } }).files.get(PREVIEW_MODULE)!;
    expect(base).toContain('variant_layout="default"');
    expect(base).toContain(`variant_tone=${JSON.stringify(state.components[id].variantAxes!.tone.default)}`);
    expect(four).toContain(`variant_tone=${JSON.stringify(tone)}`);
    expect(two).toContain('variant_layout="two-columns"');
    expect(four).toContain('variant_layout="four-columns"');
    expect(new Set([base, two, four]).size).toBe(3);
    for (const module of [base, two, four]) expect(() => compile(module, { generate: 'client', filename: 'Preview.svelte' })).not.toThrow();
  });

  it('places the instance exactly as a page placement with the same values would', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    const home = state.site.homePageId;
    const placed = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: home }, definitionId: id, props: { heading: 'Same words' }, variants: { layout: 'media-end' } } as never]);
    // The page holds this placement alone, so its attributes are the only ones there.
    placed.state.pages[home].rootIds = [placed.results[0].nodeId as string];
    const page = [...generateProject(placed.state, { instrument: true }).entries()].find(([path]) => path === 'src/routes/+page.svelte')![1];
    const module = preview(placed.state, { definitionId: id, variants: { layout: 'media-end' }, props: { heading: 'Same words' } }).files.get(PREVIEW_MODULE)!;
    const attrs = (text: string) => [...text.matchAll(/^\s*((?:heading|eyebrow|variant_\w+|image|body|so_eager)=.*)$/gm)].map((m) => m[1]).sort();
    // The first thing on a page loads its images at once, and so does a preview's one component.
    expect(attrs(module)).toContain('so_eager={true}');
    expect(attrs(module).length).toBeGreaterThan(3);
    expect(attrs(module)).toEqual(attrs(page));
  });

  it('shows a code component with its first axis as `variant`, as a placement passes it', () => {
    const { state, id } = withCodeComponent(starter());
    const loud = preview(state, { definitionId: id, variants: { tone: 'loud', size: 'big' }, props: { title: 'Shout' } });
    const module = loud.files.get(PREVIEW_MODULE)!;
    expect(module).toContain('variant="loud"');
    // An axis the source reads by its own name gets it; one it does not read never lands in its other props.
    expect(module).toContain('variant_size="big"');
    expect(module).not.toContain('variant_tone=');
    expect(module).toContain('title={"Shout"}');
    expect(module).toContain('data-so-code="true"');
    expect(loud.files.get(defFile(state.components[id]))).toBe(state.components[id].source);
    expect(preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)).toContain('variant="plain"');
  });

  it('carries an icon that only the sample values name', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const items = (state.components[id].properties.items as { default: Array<Record<string, unknown>> }).default.map((it, i) => (i === 0 ? { ...it, icon: 'stethoscope' } : it));
    const projectIcons = generateProject(state, { instrument: true }).get(`${RUNTIME_DIR}/icons.js`)!;
    expect(projectIcons).not.toContain('"stethoscope"');
    const icons = preview(state, { definitionId: id, props: { items } }).files.get(`${RUNTIME_DIR}/icons.js`)!;
    expect(icons).toContain('"stethoscope"');
    // The icons the project uses are all still there.
    for (const used of ['"compass"', '"pen-tool"', '"hammer"']) expect(projectIcons).toContain(used), expect(icons).toContain(used);
  });

  it('refuses what a placement could not hold', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    const error = (spec: Parameters<typeof generateComponentPreview>[1]) => {
      const out = generateComponentPreview(state, spec);
      return 'error' in out ? out.error : null;
    };
    expect(error({})).toMatch(/Name one component/);
    expect(error({ definitionId: id, componentId: 'content.media' })).toMatch(/Name one component/);
    expect(error({ definitionId: 'missing' })).toMatch(/no component "missing"/);
    expect(error({ componentId: 'no.such' })).toMatch(/theme has no component/);
    expect(error({ definitionId: id, variants: { size: 'big' } })).toMatch(/no variant axis "size"/);
    expect(error({ definitionId: id, variants: { layout: 'sideways' } })).toMatch(/no option "sideways"/);
    expect(error({ definitionId: id, props: { nope: 1 } })).toMatch(/no property "nope"/);
    expect(error({ definitionId: id, props: { heading: { $prop: 'heading' } } })).toMatch(/cannot be bound/);
    expect(error({ definitionId: id, props: { headingLevel: 'h9' } })).toMatch(/Heading level|h9/i);
    state.components[id] = { ...state.components[id], tree: undefined };
    expect(error({ definitionId: id })).toMatch(/nothing to show/);
  });

  it('gives a sample form’s new fields keys of their own, as inserting the form does', () => {
    const state = starter();
    const fields = [
      { label: 'Department', type: 'text' },
      { label: 'Department', type: 'text' }
    ];
    const module = preview(state, { componentId: 'contact.form', props: { fields } }).files.get(PREVIEW_MODULE)!;
    const names = [...module.matchAll(/"name":"([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(['department', 'department-2']);
  });

  it('records the site’s language for the preview’s page', () => {
    const state = starter();
    state.site.language = 'fr-CA';
    expect(JSON.parse(preview(state, { componentId: 'content.media' }).files.get(PREVIEW_META)!)).toEqual({ lang: 'fr-CA', dir: 'ltr' });
    // A site in Arabic runs right to left, unless its author says otherwise (issue #71).
    state.site.language = 'ar';
    expect(JSON.parse(preview(state, { componentId: 'content.media' }).files.get(PREVIEW_META)!)).toEqual({ lang: 'ar', dir: 'rtl' });
    state.site.direction = 'ltr';
    expect(JSON.parse(preview(state, { componentId: 'content.media' }).files.get(PREVIEW_META)!)).toEqual({ lang: 'ar', dir: 'ltr' });
  });

  it('uses the project’s own copy of a catalogue component it already has', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    const def = state.components[id];
    state.components[id] = { ...def, name: 'Our media', properties: { ...def.properties, heading: { ...def.properties.heading, default: 'Our own heading' } as never } };
    const out = preview(state, { componentId: 'content.media' });
    expect(out).toMatchObject({ definitionId: id, name: 'Our media' });
    expect(out.files.get(PREVIEW_MODULE)).toContain('heading={"Our own heading"}');
  });
});

describe('isolated previews stay out of the website', () => {
  it('generates no preview route, module or files for the project, placed components or not', () => {
    const { state } = withCodeComponent(starter());
    installComponent(state, 'content.media');
    for (const instrument of [false, true]) {
      for (const [path, content] of generateProject(state, { instrument })) {
        expect(path).not.toBe(PREVIEW_MODULE);
        expect(path).not.toMatch(/preview\.json$/);
        expect(path).not.toMatch(/__siteorigin|\/preview\//);
        expect(content).not.toContain(COMPONENT_PREVIEW_ROUTE);
        expect(content).not.toMatch(/preview:/);
      }
    }
  });

  it('only answers the preview address with a well-formed key', () => {
    const key = 'a1b2c3d4e5f6a7b8c9d0';
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}/`)).toBe(key);
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}/?x=1`)).toBe(key);
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}`)).toBe(key);
    for (const bad of [`${COMPONENT_PREVIEW_ROUTE}../${key}/`, `${COMPONENT_PREVIEW_ROUTE}${key}/x`, `${COMPONENT_PREVIEW_ROUTE}${key.toUpperCase()}/`, `${COMPONENT_PREVIEW_ROUTE}abc/`, `${COMPONENT_PREVIEW_ROUTE}${'a'.repeat(65)}/`, '/about/', undefined]) expect(previewKeyOf(bad)).toBeNull();
  });
});

describe('serving an isolated preview', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A project folder with a prepared preview of a catalogue component, and the dev plugin serving it. */
  async function served() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-isolated-')));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/app.html'), '<!doctype html>\n<html lang="en">\n</html>\n');
    const state = starter();
    state.site.language = 'de-AT';
    const made = preview(state, { componentId: 'content.media', variants: { layout: 'media-end' } });
    const { key, path } = await writeComponentPreview(dir, made.files);
    const plugin = devPlugin(dir);
    let middleware: ((req: { url?: string; method?: string }, res: ReturnType<typeof response>, next: (e?: unknown) => void) => void) | null = null;
    plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn as never) }, transformIndexHtml: async (_url, html) => html.replace('<head>', '<head><!--transformed-->') });
    /** Ask the middleware for `url`: what it answered, or 'next' when it passed the request on. */
    const request = (url: string, method = 'GET') =>
      new Promise<ReturnType<typeof response> | 'next'>((resolve) => {
        const res = response(() => resolve(res));
        middleware!({ url, method }, res, () => resolve('next'));
      });
    return { dir, key, path, plugin, request, made };
  }

  function response(done: () => void) {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as string | undefined,
      setHeader: (k: string, v: string) => void (res.headers[k.toLowerCase()] = v),
      end: (body?: string) => {
        res.body = body;
        done();
      }
    };
    return res;
  }

  it('answers its address with a page that starts the preview, in the site’s language', async () => {
    const { key, path, request } = await served();
    expect(path).toBe(`${COMPONENT_PREVIEW_ROUTE}${key}/`);
    const res = await request(path);
    if (res === 'next') throw new Error('passed on');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<!--transformed-->');
    expect(res.body).toContain('<html lang="de-AT" dir="ltr">');
    expect(res.body).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(res.body).toContain('<meta name="robots" content="noindex" />');
    const head = await request(path, 'HEAD');
    if (head === 'next') throw new Error('passed on');
    expect([head.statusCode, head.body, head.headers['content-type']]).toEqual([200, undefined, 'text/html; charset=utf-8']);
    expect(res.body).toContain(`<script type="module" src="/@id/virtual:siteorigin-component-preview/${key}.js"></script>`);
    // No site header, footer or page of the site around it.
    expect(res.body).not.toMatch(/<header|<footer|<main/);
  });

  it('passes every other address on, and says when a preview is gone', async () => {
    const { key, path, request, dir } = await served();
    expect(await request('/')).toBe('next');
    expect(await request('/about/')).toBe('next');
    expect(await request(path, 'POST')).toBe('next');
    expect(await request(`${COMPONENT_PREVIEW_ROUTE}..%2F${key}/`)).toBe('next');
    await removeComponentPreview(dir, key);
    const gone = await request(path);
    if (gone === 'next') throw new Error('passed on');
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['cache-control']).toBe('no-store');
  });

  it('starts with the site’s tokens and base styles, then mounts the preview, then the bridge', async () => {
    const { key, plugin } = await served();
    const id = (await plugin.resolveId(`virtual:siteorigin-component-preview/${key}.js`)) as string;
    expect(id).toBe(`\0virtual:siteorigin-component-preview/${key}.js`);
    expect(await plugin.resolveId('virtual:siteorigin-component-preview/../x.js')).toBeNull();
    const entry = plugin.load(id) as string;
    const base = `/.siteorigin/cache/dev/isolated/${key}`;
    const order = ['"/src/lib/siteorigin/styles/tokens.css"', '"/src/lib/siteorigin/styles/theme.css"', `"${base}/${PREVIEW_COMPONENT_STYLES}"`, `import("${base}/${PREVIEW_MODULE}")`, "import('virtual:siteorigin-bridge')"].map((s) => entry.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Form sends are held before anything of the component runs.
    expect(entry.indexOf('__siteoriginHold')).toBeLessThan(entry.indexOf('mount(Preview'));
  });

  it('serves the preview’s own files from the cache, and nothing outside its folder', async () => {
    const { dir, key, plugin, made } = await served();
    const at = (rel: string) => `${dir}/.siteorigin/cache/dev/isolated/${key}/${rel}`;
    expect(plugin.load(at(PREVIEW_MODULE))).toBe(made.files.get(PREVIEW_MODULE));
    // A reload stamp names the same, unchanging file; a stylesheet derived from it goes to the Svelte plugin.
    for (const stamp of ['t=1700000000000', 'import', 'v=3f9a1c2e', 'import&t=1']) expect(plugin.load(`${at(PREVIEW_MODULE)}?${stamp}`), stamp).toBe(made.files.get(PREVIEW_MODULE));
    expect(plugin.load(`${at(PREVIEW_MODULE)}?svelte&type=style&lang.css`)).toBeNull();
    for (const derived of ['raw', 'url', 'inline', 'worker', 'import&raw']) expect(plugin.load(`${at(PREVIEW_MODULE)}?${derived}`), derived).toBeNull();
    expect(plugin.load(`${dir}/.siteorigin/cache/dev/isolated/${key}/../${key}/${PREVIEW_MODULE}`)).toBeNull();
    // A link planted in a preview's folder never serves what it leads to.
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    symlinkSync(join(dir, 'secret.txt'), join(dir, `.siteorigin/cache/dev/isolated/${key}/src/lib/siteorigin/leak.js`));
    expect(() => plugin.load(at('src/lib/siteorigin/leak.js'))).toThrow(/no longer available/);
    await removeComponentPreview(dir, key);
    expect(() => plugin.load(at(PREVIEW_MODULE))).toThrow(/no longer available/);
  });

  it('writes each preview under a new key, all at once, and clears them all', async () => {
    const { dir, key, made } = await served();
    const again = await writeComponentPreview(dir, made.files);
    expect(again.key).not.toBe(key);
    expect(again.key).toMatch(PREVIEW_KEY);
    // Nothing half-written is left beside the finished folders.
    expect(readdirSync(join(dir, '.siteorigin/cache/dev/isolated')).sort()).toEqual([key, again.key].sort());
    await clearComponentPreviews(dir);
    expect(existsSync(join(dir, '.siteorigin/cache/dev/isolated'))).toBe(false);
    // Nothing reached the project's own source.
    expect(readdirSync(join(dir, 'src'))).toEqual(['app.html']);
  });

  it('refuses to write through a cache that leads out of the project', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-isolated-')));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'so-elsewhere-')));
    dirs.push(dir, elsewhere);
    mkdirSync(join(dir, '.siteorigin/cache/dev'), { recursive: true });
    symlinkSync(elsewhere, join(dir, '.siteorigin/cache/dev/isolated'));
    await expect(writeComponentPreview(dir, new Map([[PREVIEW_MODULE, 'x']]))).rejects.toThrow(/not inside the project/);
    expect(readdirSync(elsewhere)).toEqual([]);
    writeFileSync(join(elsewhere, 'keep.txt'), 'theirs');
    await clearComponentPreviews(dir);
    // The link goes; what it led to is never touched.
    expect(existsSync(join(dir, '.siteorigin/cache/dev/isolated'))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual(['keep.txt']);
  });

  it('never writes or clears through a linked folder further up the cache', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-isolated-')));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'so-elsewhere-')));
    dirs.push(dir, elsewhere);
    mkdirSync(join(elsewhere, 'dev/isolated/aaaaaaaaaaaaaaaa'), { recursive: true });
    writeFileSync(join(elsewhere, 'dev/isolated/aaaaaaaaaaaaaaaa/keep.txt'), 'theirs');
    mkdirSync(join(dir, '.siteorigin'), { recursive: true });
    symlinkSync(elsewhere, join(dir, '.siteorigin/cache'));
    await expect(writeComponentPreview(dir, new Map([[PREVIEW_MODULE, 'x']]))).rejects.toThrow(/not inside the project/);
    await removeComponentPreview(dir, 'aaaaaaaaaaaaaaaa');
    await clearComponentPreviews(dir);
    expect(readFileSync(join(elsewhere, 'dev/isolated/aaaaaaaaaaaaaaaa/keep.txt'), 'utf8')).toBe('theirs');
    expect(readdirSync(join(elsewhere, 'dev/isolated'))).toEqual(['aaaaaaaaaaaaaaaa']);
  });

  it('serves nothing through a preview folder that is a link, even to the editor’s other data in the project', async () => {
    const { dir, plugin, request } = await served();
    const linked = 'cccccccccccccccc';
    mkdirSync(join(dir, '.siteorigin/sessions'), { recursive: true });
    writeFileSync(join(dir, '.siteorigin/sessions/chat.json'), '{"private":true}');
    symlinkSync(join(dir, '.siteorigin/sessions'), join(dir, `.siteorigin/cache/dev/isolated/${linked}`));
    expect(() => plugin.load(`${dir}/.siteorigin/cache/dev/isolated/${linked}/chat.json`)).toThrow(/no longer available/);
    expect(await request(`/.siteorigin/cache/dev/isolated/${linked}/chat.json`)).not.toBe('next');
  });

  it('answers a released preview’s modules as gone, and drops what the server kept of them', async () => {
    const { dir, key, plugin, made } = await served();
    const other = await writeComponentPreview(dir, made.files);
    const at = (k: string, rel: string) => `${dir}/.siteorigin/cache/dev/isolated/${k}/${rel}`;
    const invalidated: string[] = [];
    const graph = {
      idToModuleMap: new Map<string, { id: string }>([at(key, PREVIEW_MODULE), at(other.key, PREVIEW_MODULE), `\0virtual:siteorigin-component-preview/${key}.js`, `${dir}/src/routes/+page.svelte`].map((id) => [id, { id }])),
      invalidateModule: (mod: unknown) => void invalidated.push((mod as { id: string }).id)
    };
    let middleware: ((req: { url?: string; method?: string }, res: ReturnType<typeof response>, next: () => void) => void) | null = null;
    plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn as never) }, transformIndexHtml: async (_url, html) => html, environments: { client: { moduleGraph: graph } } });
    const ask = (url: string) =>
      new Promise<number | 'next'>((resolve) => {
        const res = response(() => resolve(res.statusCode));
        middleware!({ url, method: 'GET' }, res, () => resolve('next'));
      });
    expect(await ask(`/.siteorigin/cache/dev/isolated/${key}/${PREVIEW_MODULE}`)).toBe('next');
    await removeComponentPreview(dir, key);
    expect(await ask(`/.siteorigin/cache/dev/isolated/${key}/${PREVIEW_MODULE}?t=1`)).toBe(404);
    expect(await ask(`/@id/virtual:siteorigin-component-preview/${key}.js`)).toBe(404);
    expect(await ask(`/@id/__x00__virtual:siteorigin-component-preview/${key}.js`)).toBe(404);
    // A path that only looks like a preview's, outside this project, is not one.
    expect(await ask(`/@fs/elsewhere/.siteorigin/cache/dev/isolated/${key}/x.js`)).toBe('next');
    expect(await ask(`/docs/.siteorigin/cache/dev/isolated/${key}/x`)).toBe('next');
    // However the address is spelled.
    for (const spelling of [`/.siteorigin/cache/dev/isolated/%${key.charCodeAt(0).toString(16)}${key.slice(1)}/x.js`, `//.siteorigin//cache/dev/isolated/${key}/x.js`, `/.siteorigin/cache/dev/./isolated/${key}/x.js`, `/src/../.siteorigin/cache/dev/isolated/${key}/x.js`, `/@id/${at(key, PREVIEW_MODULE)}`, `/@fs${at(key, PREVIEW_MODULE)}?import`])
      expect(await ask(spelling), spelling).toBe(404);
    expect(invalidated).toEqual([]);
    // Showing the next preview drops the released one's modules, and only those.
    expect(await ask(other.path)).toBe(200);
    expect(invalidated.sort()).toEqual([at(key, PREVIEW_MODULE), `\0virtual:siteorigin-component-preview/${key}.js`].sort());
  });

  it('resolves what a preview’s files import from the preview first, then from the project', async () => {
    const { dir, key, plugin } = await served();
    const at = (rel: string) => `${dir}/.siteorigin/cache/dev/isolated/${key}/${rel}`;
    const importer = at(PREVIEW_MODULE);
    const note = at('src/lib/siteorigin/custom/Note.svelte');
    // Vite's own resolution, as far as these imports need it: relative to the importer, with or without an extension.
    const asked: Array<[string, string | undefined]> = [];
    const vite = {
      resolve: async (id: string, from?: string) => {
        asked.push([id, from]);
        const [bare, query = ''] = id.split('?');
        const base = bare.startsWith('.') ? posix.join(posix.dirname(from!), bare) : bare;
        if (!base.startsWith('/')) return { id: `/node_modules/${id}/index.js` };
        for (const ext of ['', '.js', '.svelte']) if (existsSync(base + ext) && statSync(base + ext).isFile()) return { id: base + ext + (query && `?${query}`) };
        return null;
      }
    };
    const resolve = (id: string, from: string) => plugin.resolveId.call(vite, id, from);
    // Relative imports and $lib (a project path once Vite has applied the alias) reach the preview's own copy.
    expect(await resolve('../runtime/Icon.svelte', importer)).toBe(at('src/lib/siteorigin/runtime/Icon.svelte'));
    expect(await resolve(`${dir}/src/lib/siteorigin/runtime/icons.js`, note)).toBe(at('src/lib/siteorigin/runtime/icons.js'));
    expect(await resolve('../runtime/Icon.svelte?svelte&type=style&lang.css', importer)).toBe(`${at('src/lib/siteorigin/runtime/Icon.svelte')}?svelte&type=style&lang.css`);
    // Without its extension too, whether the project has the file as well or not: the preview's copy carries what only
    // its sample values need.
    mkdirSync(join(dir, 'src/lib/siteorigin/runtime'), { recursive: true });
    writeFileSync(join(dir, 'src/lib/siteorigin/runtime/icons.js'), 'export const ICONS = {};');
    expect(await resolve('../runtime/icons', note)).toEqual({ id: at('src/lib/siteorigin/runtime/icons.js') });
    expect(await resolve(`${dir}/src/lib/siteorigin/runtime/icons`, note)).toBe(at('src/lib/siteorigin/runtime/icons.js'));
    // A file only the project has (a helper a code component imports) is found from the project's own copy of the importer.
    mkdirSync(join(dir, 'src/lib/siteorigin/custom'), { recursive: true });
    writeFileSync(join(dir, 'src/lib/siteorigin/custom/helper.js'), 'export const x = 1;');
    expect(await resolve('./helper', note)).toEqual({ id: `${dir}/src/lib/siteorigin/custom/helper.js` });
    expect(asked.at(-1)).toEqual(['./helper', `${dir}/src/lib/siteorigin/custom/Note.svelte`]);
    // Read as text or as an address, it comes from the project: the server may never read the editor's cache that way.
    expect(await resolve('../runtime/icons.js?raw', note)).toEqual({ id: `${dir}/src/lib/siteorigin/runtime/icons.js?raw` });
    // A package is the same from anywhere.
    expect(await resolve('svelte', importer)).toEqual({ id: '/node_modules/svelte/index.js' });
    // Nothing escapes into the rest of the editor's cache: an import that would is resolved from the project instead.
    expect(await resolve('../../../../../../dev/x.js', importer)).toBeNull();
    // Without Vite to ask, only the preview's own files are answered.
    expect(await plugin.resolveId('./helper', note)).toBeNull();
    // An import from anywhere else is not the preview's business.
    expect(await resolve('../runtime/Icon.svelte', `${dir}/src/lib/siteorigin/preview/Preview.svelte`)).toBeNull();
  });

  it('keeps only well-formed preview requests', () => {
    expect(previewSpec({ definitionId: 'c1', variants: { tone: 'dark' }, props: { heading: 'Hi' } })).toEqual({ definitionId: 'c1', variants: { tone: 'dark' }, props: { heading: 'Hi' } });
    expect(previewSpec({ componentId: 'content.media' })).toEqual({ componentId: 'content.media' });
    expect(previewSpec({ definitionId: 'd'.repeat(200) })).not.toBeNull();
    expect(previewSpec({ componentId: 'c'.repeat(200) })).not.toBeNull();
    for (const bad of [null, 'c1', [], { definitionId: 3 }, { definitionId: '' }, { definitionId: 'd'.repeat(201) }, { componentId: 'c'.repeat(201) }, { variants: { tone: 2 } }, { props: [] }, { props: { big: 'x'.repeat(300_000) } }]) expect(previewSpec(bad)).toBeNull();
  });
});
