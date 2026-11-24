import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { installComponent } from '@engine/install';
import { compile } from 'svelte/compiler';
import { COMPONENT_PREVIEW_ROUTE, PREVIEW_COMPONENT_STYLES, PREVIEW_KEY, PREVIEW_MODULE, previewKeyOf } from '@shared/component-preview';
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
  const source = `<script>\n\tlet { title = 'Hello', variant = 'plain', so_o, class: className = '' } = $props();\n</script>\n\n<p class="sample {className} sample--{variant}">{title}</p>\n`;
  const made = applyOperations(state, [{ type: 'component.createCode', name: 'Sample note', source, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }]);
  const id = made.results[0].definitionId as string;
  const withAxis = applyOperations(made.state, [
    { type: 'component.setVariant', definitionId: id, axis: 'tone', axisLabel: 'Tone', variant: 'plain', label: 'Plain', makeDefault: true },
    { type: 'component.setVariant', definitionId: id, axis: 'tone', variant: 'loud', label: 'Loud' }
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

  it('renders each variant choice, and an axis left out keeps its default', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const base = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    const two = preview(state, { definitionId: id, variants: { layout: 'two-columns' } }).files.get(PREVIEW_MODULE)!;
    const four = preview(state, { definitionId: id, variants: { layout: 'four-columns', tone: Object.keys(state.components[id].variantAxes!.tone.options).at(-1)! } }).files.get(PREVIEW_MODULE)!;
    expect(base).toContain('variant_layout="default"');
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
    const attrs = (text: string) => [...text.matchAll(/^\s*((?:heading|variant_\w+|image|body)=.*)$/gm)].map((m) => m[1]).sort();
    expect(attrs(module).length).toBeGreaterThan(3);
    expect(attrs(module)).toEqual(attrs(page));
  });

  it('shows a code component with its first axis as `variant`, as a placement passes it', () => {
    const { state, id } = withCodeComponent(starter());
    const loud = preview(state, { definitionId: id, variants: { tone: 'loud' }, props: { title: 'Shout' } });
    const module = loud.files.get(PREVIEW_MODULE)!;
    expect(module).toContain('variant="loud"');
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
    expect(preview(state, { definitionId: id, props: { items } }).files.get(`${RUNTIME_DIR}/icons.js`)).toContain('"stethoscope"');
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
  });

  it('uses the project’s own copy of a catalogue component it already has', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    state.components[id] = { ...state.components[id], name: 'Our media' };
    expect(preview(state, { componentId: 'content.media' })).toMatchObject({ definitionId: id, name: 'Our media' });
  });
});

describe('isolated previews stay out of the website', () => {
  it('generates no preview route, module or files for the project, placed components or not', () => {
    const { state } = withCodeComponent(starter());
    installComponent(state, 'content.media');
    for (const instrument of [false, true]) {
      for (const [path, content] of generateProject(state, { instrument })) {
        expect(path).not.toBe(PREVIEW_MODULE);
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
    for (const bad of [`${COMPONENT_PREVIEW_ROUTE}../${key}/`, `${COMPONENT_PREVIEW_ROUTE}${key}/x`, `${COMPONENT_PREVIEW_ROUTE}SHORT/`, '/about/', undefined]) expect(previewKeyOf(bad)).toBeNull();
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
    writeFileSync(join(dir, 'src/app.html'), '<!doctype html>\n<html lang="de-AT">\n</html>\n');
    const made = preview(starter(), { componentId: 'content.media', variants: { layout: 'media-end' } });
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
    expect(res.body).toContain('<html lang="de-AT">');
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
  });

  it('starts with the site’s tokens and base styles, then mounts the preview, then the bridge', async () => {
    const { key, plugin } = await served();
    const id = plugin.resolveId(`virtual:siteorigin-component-preview/${key}.js`);
    expect(id).toBe(`\0virtual:siteorigin-component-preview/${key}.js`);
    expect(plugin.resolveId('virtual:siteorigin-component-preview/../x.js')).toBeNull();
    const entry = plugin.load(id!) as string;
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
    expect(plugin.load(`${at(PREVIEW_MODULE)}?t=1700000000000`)).toBe(made.files.get(PREVIEW_MODULE));
    expect(plugin.load(`${at(PREVIEW_MODULE)}?svelte&type=style&lang.css`)).toBeNull();
    expect(plugin.load(`${at(PREVIEW_MODULE)}?raw`)).toBeNull();
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
    await clearComponentPreviews(dir);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('keeps only well-formed preview requests', () => {
    expect(previewSpec({ definitionId: 'c1', variants: { tone: 'dark' }, props: { heading: 'Hi' } })).toEqual({ definitionId: 'c1', variants: { tone: 'dark' }, props: { heading: 'Hi' } });
    expect(previewSpec({ componentId: 'content.media' })).toEqual({ componentId: 'content.media' });
    for (const bad of [null, 'c1', [], { definitionId: 3 }, { definitionId: '' }, { variants: { tone: 2 } }, { props: [] }, { props: { big: 'x'.repeat(300_000) } }]) expect(previewSpec(bad)).toBeNull();
  });
});
