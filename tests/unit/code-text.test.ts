/**
 * Text a code component marks as showing one of its properties, or one list item's field (#1074): the editor's
 * preview gives its placement the hook it marks the text with and the website gives none, so only the preview carries
 * a marker; the editor resolves a marked element to the property or item field it shows; the code check holds each
 * marker to the hook and to the component's text properties; and typing over it is the inspector's own edit, one step
 * of History.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { EditOperation } from '@shared/ops';
import type { ProjectSnapshot } from '@shared/api';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState, PropSchema, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';
import { parseCodeText } from '@shared/code-text';
import { checkSvelteSource, withoutPartMarkers } from '../../src/main/codecheck';
import { ProjectSession } from '../../src/main/project/session';
import { codeTextShown, codeTextTarget, type CodeTextTarget } from '../../src/renderer/src/lib/model';

const SOURCE = `<script>
\timport SoRichText from '../runtime/RichText.svelte';
\tlet { heading = '', body = [], features = [], so_text } = $props();
</script>

<section class="services">
\t<h2 class="services__heading" data-so-text={so_text?.('heading')}>{heading}</h2>
\t<SoRichText value={body} data-so-text={so_text?.('body')} />
\t<ul>
\t\t{#each features as feature (feature.id)}
\t\t\t<li><h3 data-so-text={so_text?.('features.title', feature.id)}>{feature.title}</h3></li>
\t\t{/each}
\t</ul>
</section>
`;

const PROPERTIES: Record<string, PropSchema> = {
  heading: { type: 'string', label: 'Heading', default: 'Our services' },
  body: { type: 'richtext', label: 'Intro', default: [{ type: 'p', spans: [{ text: 'What we do best.' }] }], codeForm: 'blocks' },
  features: {
    type: 'list',
    label: 'Features',
    itemLabel: 'Feature',
    fields: { title: { type: 'string', label: 'Title', default: 'A feature' }, count: { type: 'number', label: 'Count', default: 1 } },
    default: [
      { id: 'f1', title: 'Planning', count: 1 },
      { id: 'f2', title: 'Building', count: 2 }
    ]
  },
  size: { type: 'number', label: 'Size', default: 3 },
  notes: { type: 'richtext', label: 'Notes', default: [] }
};

/** Home with a placed code component that marks its heading, its intro and each feature's title. */
function services(source = SOURCE, properties = PROPERTIES) {
  let s: ProjectState = createStarterState('business', 'Code Text', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Services', source, properties }]);
  const defId = made.results[0].definitionId as string;
  s = made.state;
  const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId } as EditOperation]);
  const node = placed.results[0].nodeId as string;
  // The placement's own copy of the list, under item IDs of its own.
  const ids = ((placed.state.pages[owner.id].nodes[node] as InstanceNode).props.features as Array<{ id: string }>).map((it) => it.id);
  return { s: placed.state, owner, defId, node, ids };
}

const homeFile = 'src/routes/+page.svelte';
const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render Home as the website builds it, or as the editor's preview shows it. */
async function renderHome(s: ProjectState, instrument: boolean): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'code-text-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s, { instrument })) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true, css: 'external' }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
        .replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, `${homeFile}.js`))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}

describe('only the editor’s preview carries text markers', () => {
  it('gives the hook to a code placement that marks text, in the preview only', () => {
    const { s } = services();
    const dev = generateProject(s, { instrument: true }).get(homeFile)!;
    expect(dev).toContain(`so_text={(path, item) => (item == null ? path : path + '#' + item)}`);
    const clean = generateProject(s, { instrument: false }).get(homeFile)!;
    expect(clean).not.toContain('so_text');
    // Code that marks no text is given no hook.
    const plain = services(SOURCE.replaceAll(/ data-so-text=\{so_text\?\.\([^)]*\)\}/g, '').replace(', so_text }', ' }'));
    expect(generateProject(plain.s, { instrument: true }).get(homeFile)).not.toContain('so_text');
  });

  it('marks the heading, the intro and each item’s field in the preview, and nothing in the website', async () => {
    const { s, ids } = services();
    const dev = await renderHome(s, true);
    expect(dev).toMatch(/<h2 class="services__heading[^"]*" data-so-text="heading">Our services<\/h2>/);
    expect(dev).toMatch(/<div class="so-rich[^"]*" data-so-text="body">/);
    expect(dev).toContain(`<h3 data-so-text="features.title#${ids[0]}">Planning</h3>`);
    expect(dev).toContain(`<h3 data-so-text="features.title#${ids[1]}">Building</h3>`);
    const site = await renderHome(s, false);
    expect(site).toContain('Our services');
    expect(site).toContain('What we do best.');
    expect(site).toContain('Building');
    expect(site).not.toContain('data-so-text');
  });
});

describe('the editor names the text a marked element shows', () => {
  const desc = (owner: OwnerRef, node: string, bind: string) => ({ ctx: `${owner.kind}:${owner.id}`, node, items: '', bind });

  it('resolves a marker to the placement’s property, or one item’s field of its list, with the value shown', () => {
    const { s, owner, node, ids } = services();
    const heading = codeTextTarget(s, desc(owner, node, 'heading'));
    expect(heading).toEqual({ owner, nodeId: node, prop: 'heading', rich: false, label: 'Heading' });
    // The property's default while the placement has no value of its own, then the placement's.
    expect(codeTextShown(s, heading!)).toBe('Our services');
    const own = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: node, prop: 'heading', value: 'What we offer' }]).state;
    expect(codeTextShown(own, heading!)).toBe('What we offer');

    const second = codeTextTarget(s, desc(owner, node, `features.title#${ids[1]}`));
    expect(second).toEqual({ owner, nodeId: node, prop: 'features', field: 'title', itemId: ids[1], rich: false, label: 'Title' });
    expect(codeTextShown(s, second!)).toBe('Building');

    const body = codeTextTarget(s, desc(owner, node, 'body'));
    expect(body).toMatchObject({ prop: 'body', rich: true });
    expect(codeTextShown(s, body!)).toEqual(PROPERTIES.body.default);
  });

  it('names nothing the page cannot be typed into', () => {
    const { s, owner, node, ids } = services();
    const none = (bind: string, st = s, ctx = `page:${owner.id}`) => expect(codeTextTarget(st, { ctx, node, bind }), bind).toBeNull();
    // Not declared, not text, rich text given as paragraphs, a list itself, an item it does not have, a field without
    // its item and a property with one.
    for (const bind of ['subtitle', 'size', 'notes', 'features', 'features.title#gone', `features.count#${ids[0]}`, 'features.title', `heading#${ids[0]}`, `features.title.x#${ids[0]}`, '']) none(bind);
    // A placement inside another component's design.
    none('heading', s, `page:${owner.id}|${node}`);
    // A value read from a collection entry.
    const bound = structuredClone(s);
    (bound.pages[owner.id].nodes[node] as InstanceNode).props.heading = { $entry: 'title' } as never;
    none('heading', bound);
    // A list filled from a collection, or worked out from the site's pages.
    const connected = structuredClone(s);
    (connected.pages[owner.id].nodes[node] as InstanceNode).listSources = { features: { collection: 'posts' } } as never;
    none(`features.title#${ids[1]}`, connected);
    const fed = structuredClone(s);
    ((fed.components[(fed.pages[owner.id].nodes[node] as InstanceNode).definitionId] as ComponentDefinition).properties.features as { feed?: string }).feed = 'articles';
    none(`features.title#${ids[1]}`, fed);
  });

  it('reads a marker’s value as the preview writes it, an item ID with any character in it included', () => {
    expect(parseCodeText('heading')).toEqual({ prop: 'heading' });
    expect(parseCodeText('features.title#a#b c')).toEqual({ prop: 'features', field: 'title', itemId: 'a#b c' });
    // A theme's property may hold underscores.
    expect(parseCodeText('hero_title')).toEqual({ prop: 'hero_title' });
    for (const bad of ['', '#x', 'features.title#', 'a.b.c#x', 'bad-name', 'heading#x', 'features.bad-name#x', '_x']) expect(parseCodeText(bad), bad).toBeNull();
  });
});

describe('the website’s build takes text markers out of the code too', () => {
  it('cuts each one, written out or through the hook, and leaves words that only mention one', async () => {
    const clean = await withoutPartMarkers(SOURCE.replace(`data-so-text={so_text?.('heading')}`, 'data-so-text="heading"'));
    expect(clean).not.toContain('data-so-text');
    expect(clean).toContain('<h2 class="services__heading">{heading}</h2>');
    expect(clean).toContain('<SoRichText value={body} />');
    const said = '<p>Mark text with data-so-text.</p>\n';
    expect(await withoutPartMarkers(said)).toBe(said);
  });
});

describe('the code check holds text markers to the hook and to the component’s text', () => {
  const contract = { parts: { root: { nodeId: 'root', label: 'Root' } }, properties: PROPERTIES };
  const errors = async (source: string, known = true) =>
    (await checkSvelteSource(source, { contract: known ? contract : { parts: contract.parts } })).filter((p) => p.severity === 'error').map((p) => p.message);
  const mark = (attr: string) => SOURCE.replace(`data-so-text={so_text?.('heading')}`, attr);

  it('accepts text marked through the hook, a list item’s field with its item', async () => {
    expect(await errors(SOURCE)).toEqual([]);
  });

  it('refuses a marker the published site would carry: written out, not through the hook, or a hook with a default', async () => {
    expect(await errors(mark('data-so-text="heading"'))).toEqual([expect.stringContaining('published site')]);
    expect(await errors(mark('data-so-text={heading}'))).toEqual([expect.stringContaining("through the placement's hook")]);
    expect(await errors(SOURCE.replace(', so_text }', ' }'))).toEqual(expect.arrayContaining([expect.stringContaining('so_text taken from $props()')]));
    expect(await errors(SOURCE.replace(', so_text }', ', so_text = (p) => p }'))).toEqual([expect.stringContaining('Give so_text no default')]);
    expect(await errors(mark(`data-so-text={so_text('heading')}`))).toEqual([expect.stringContaining('Call so_text with ?.')]);
    expect(await errors(mark(`{...{ 'data-so-text': so_text?.('heading') }}`))).toEqual(expect.arrayContaining([expect.stringContaining('attribute of its own')]));
    expect(await errors(mark('DATA-SO-TEXT="heading"'))).toEqual([expect.stringContaining('published site')]);
  });

  it('follows the hook under another name, and refuses it anywhere but the call that marks text', async () => {
    const aliased = SOURCE.replace(', so_text }', ', so_text: mark }').replaceAll('so_text?.(', 'mark?.(');
    expect(await errors(aliased)).toEqual([]);
    expect(await errors(aliased.replace(`mark?.('heading')`, `mark('heading')`))).toEqual([expect.stringContaining('Call mark with ?.')]);
    // Handed to a component the code places (by name, in a spread), replaced, or passed on, it could write a marker
    // into the published site or have that component's text name this one's properties.
    const onward = "never pass it on or replace it";
    for (const [what, source] of [
      ['given by name', SOURCE.replace('</section>', '\t<SoRichText value={body} so_text={so_text} />\n</section>')],
      ['a stand-in', SOURCE.replace('</section>', '\t<SoRichText value={body} so_text={(p) => p} />\n</section>')],
      ['in a spread', SOURCE.replace('</section>', '\t<SoRichText value={body} {...{ so_text }} />\n</section>')],
      ['replaced', SOURCE.replace('</script>', '\tso_text ??= (p) => p;\n</script>')],
      ['passed to a function', SOURCE.replace('</script>', '\tconst keep = (f) => f;\n\tconst kept = keep(so_text);\n</script>')]
    ] as const) {
      const found = await errors(source);
      expect(found.length, what).toBeGreaterThan(0);
      for (const m of found) expect(m, what).toContain(onward);
    }
    // Only the name is shared: a property of something else, a name the code gives its own values under the hook's
    // alias, or a type.
    expect(await errors(SOURCE.replace('</script>', '\tconst note = { so_text: 1 };\n\tconst other = note.so_text;\n</script>'))).toEqual([]);
    expect(await errors(aliased.replace('</script>', '\tconst titles = $derived(features.map((mark) => mark.title));\n</script>'))).toEqual([]);
    expect(await errors(aliased.replace('</script>', '\tconst names = $derived(features.map((mark) => String(mark)));\n</script>').replace('</section>', '\t<SoRichText value={body} label={features.mark} />\n\t{#each features as mark}{String(mark)}{/each}\n</section>'))).toEqual([]);
    const typed = SOURCE.replace('<script>', '<script lang="ts">\n\ttype Hook = (path: string, item?: string) => string;\n\tinterface Marks { so_text?: Hook }\n\tconst none: Marks = {};');
    expect(await errors(typed)).toEqual([]);
  });

  it('names a marker naming no text property or field, with or without its item, or not written out', async () => {
    expect(await errors(mark(`data-so-text={so_text?.('subtitle')}`))).toEqual([expect.stringContaining('“subtitle” is not one of the component’s properties')]);
    expect(await errors(mark(`data-so-text={so_text?.('size')}`))).toEqual([expect.stringContaining('“size” is not text')]);
    expect(await errors(mark(`data-so-text={so_text?.('notes')}`))).toEqual([expect.stringContaining('as blocks')]);
    expect(await errors(mark(`data-so-text={so_text?.('features.subtitle', 'x')}`))).toEqual([expect.stringContaining('“features” items have no “subtitle” field')]);
    expect(await errors(mark(`data-so-text={so_text?.('heading.title', 'x')}`))).toEqual([expect.stringContaining('“heading” is not a list')]);
    expect(await errors(SOURCE.replace(`so_text?.('features.title', feature.id)`, `so_text?.('features.title')`))).toEqual([expect.stringContaining("item's ID")]);
    expect(await errors(mark(`data-so-text={so_text?.('heading', 'x')}`))).toEqual([expect.stringContaining('without an item')]);
    for (const extra of [`feature.id, 2`, `null`, `undefined`]) expect(await errors(SOURCE.replace(`so_text?.('features.title', feature.id)`, `so_text?.('features.title', ${extra})`)), extra).toEqual([expect.stringContaining("item's ID")]);
    expect(await errors(mark(`data-so-text={so_text?.(which)}`))).toEqual([expect.stringContaining('written out')]);
    // Without the component's properties, only how each marker is written is checked.
    expect(await errors(mark(`data-so-text={so_text?.('subtitle')}`), false)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Typing over marked text, against a real project session behind a stand-in for the preload bridge
// ---------------------------------------------------------------------------

let session: ProjectSession;
const opening = 'opening#code-text';
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh),
    undo: () => session.undo().then(refresh),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};

// The editor's store and actions are DOM code, outside this test project's types: loaded by a path the type checker
// does not follow, with just the shapes this test uses.
const load = (path: string) => import(/* @vite-ignore */ path);
let actions: {
  commitCodeText: (t: CodeTextTarget, text: string | RichText, snapshot?: ProjectSnapshot) => Promise<'restore' | void>;
  canInlineEditCode: (t: CodeTextTarget | null) => boolean;
  showsCodeText: (snapshot: ProjectSnapshot, t: CodeTextTarget, shown: string) => boolean;
};
let setState: (p: Record<string, unknown>) => void;

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

describe('typing over a code component’s marked text', () => {
  const dirs: string[] = [];
  let owner: OwnerRef;
  let node: string;
  let ids: string[];
  beforeEach(async () => {
    vi.stubGlobal('window', { builder: bridge });
    actions = await load('../../src/renderer/src/lib/actions');
    ({ setState } = await load('../../src/renderer/src/store'));
    const dir = mkdtempSync(join(tmpdir(), 'so-code-text-'));
    dirs.push(dir);
    const made = services();
    owner = made.owner;
    node = made.node;
    ids = made.ids;
    session = await ProjectSession.create(dir, made.s);
    setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'edit' });
    refresh(null);
  });
  afterEach(async () => {
    await session.close();
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    vi.unstubAllGlobals();
  });

  const props = () => (session.state.pages[owner.id].nodes[node] as InstanceNode).props;
  const target = (bind: string) => codeTextTarget(session.state, { ctx: `page:${owner.id}`, node, bind })!;
  const entries = () => session.historyInfo().entries;

  it('sets the heading and one item’s title as the inspector does, each one step that Undo takes back', async () => {
    const before = entries().length;
    expect(actions.canInlineEditCode(target('heading'))).toBe(true);
    await actions.commitCodeText(target('heading'), 'What we offer');
    expect(props().heading).toBe('What we offer');
    expect(entries().at(-1)!.label).toBe('Edit Heading in Services on Home');

    await actions.commitCodeText(target(`features.title#${ids[1]}`), 'Making');
    expect(entries().at(-1)!.label).toBe('Edit Title of “Building” in Features (Services on Home)');
    const items = props().features as Array<Record<string, unknown>>;
    expect(items.map((it) => [it.id, it.title])).toEqual([
      [ids[0], 'Planning'],
      [ids[1], 'Making']
    ]);
    expect(items[1].count).toBe(2);
    expect(entries().length).toBe(before + 2);

    // One Undo takes back the title alone; the next one the heading.
    await bridge.project.undo();
    expect((props().features as Array<Record<string, unknown>>)[1].title).toBe('Building');
    expect(props().heading).toBe('What we offer');
    await bridge.project.undo();
    expect(props().heading).toBe('Our services');
  });

  it('stores rich text as blocks, and makes no edit when the text is left as it was', async () => {
    const before = entries().length;
    expect(await actions.commitCodeText(target('heading'), 'Our services')).toBe('restore');
    expect(await actions.commitCodeText(target('body'), PROPERTIES.body.default as RichText)).toBe('restore');
    expect(entries().length).toBe(before);
    const bold: RichText = [{ type: 'p', spans: [{ text: 'What we do ' }, { text: 'best', strong: true }, { text: '.' }] }];
    await actions.commitCodeText(target('body'), bold);
    expect(props().body).toEqual(bold);
    expect(entries().length).toBe(before + 1);
  });

  it('writes nothing to an item removed meanwhile, and tells text typed over something else', async () => {
    const t = target(`features.title#${ids[1]}`);
    const now = () => ({ state: session.state, revision: session.revision }) as unknown as ProjectSnapshot;
    expect(actions.showsCodeText(now(), t, 'Building')).toBe(true);
    expect(actions.showsCodeText(now(), t, 'Planning')).toBe(false);
    await bridge.project.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: node, prop: 'features', value: [{ id: ids[0], title: 'Planning', count: 1 }] }] }, { label: 'Remove item' });
    expect(actions.canInlineEditCode(t)).toBe(false);
    const before = entries().length;
    expect(await actions.commitCodeText(t, 'Making')).toBe('restore');
    expect(entries().length).toBe(before);
    expect((props().features as unknown[]).length).toBe(1);
  });

  it('writes nothing to a list connected to a collection after the edit began', async () => {
    const t = target(`features.title#${ids[1]}`);
    const began = { state: session.state, revision: session.revision } as unknown as ProjectSnapshot;
    // Connected meanwhile (in another window, say): the list keeps its stored items but shows the collection's.
    const connected = structuredClone(session.state);
    (connected.pages[owner.id].nodes[node] as InstanceNode).listSources = { features: { collection: 'posts' } } as never;
    setState({ snapshot: { state: connected, revision: session.revision + 1, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
    const before = entries().length;
    expect(await actions.commitCodeText(t, 'Making', began)).toBe('restore');
    expect(entries().length).toBe(before);
  });
});
