/**
 * Rich text as visitors get it: format 2 documents migrated to structured rich text keep listing what they listed,
 * wherever a value is shown. Each case is server-rendered from the generated site.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, RichText, TextNode } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { migrateProject } from '@shared/migrations';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { UTIL_JS } from '@generator/runtime-files';
import { publicationPlan, renderedContent } from '@generator/checks';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { checkPropName } from '@engine/schema';
import { normalizeRichText } from '@engine/values';
import { blocksFromDom, storedEdit } from '../../src/renderer/src/lib/richtext';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page, whitespace between tags removed. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'richtext-render-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} })
    .body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><');
}

/** A project component as format 2 wrote it: rich text as strings, and `list` on a node that showed a list. */
function v2Def(s: ProjectState, id: string, properties: Record<string, unknown>, nodes: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}): ComponentDefinition {
  const tree = { rootIds: ['root'], nodes: Object.fromEntries(Object.entries(nodes).map(([nid, n]) => [nid, { id: nid, ...n }])) };
  const def = { schemaVersion: 2, id, componentId: id, contractVersion: 1, kind: 'managed', owner: 'project', name: id, description: '', category: 'custom', tags: [], icon: 'component', properties, parts: { root: { nodeId: 'root', label: 'Root' } }, tree, provenance: { createdBy: 'user' }, license: 'Project', ...extra };
  s.components[id] = def as unknown as ComponentDefinition;
  return def as unknown as ComponentDefinition;
}

const rich = (label: string, def: unknown = []) => ({ type: 'richtext', label, default: def });
const section = (...children: string[]) => ({ kind: 'element', tag: 'section', children });
const richNode = (text: unknown, list?: 'check' | 'bullet') => ({ kind: 'text', tag: 'div', rich: true, text, ...(list ? { list } : {}) });

function placeAt(s: ProjectState, defId: string, props: Record<string, unknown>): InstanceNode {
  const node = { id: `n_${defId.replace(/\W/g, '_')}_${home(s).rootIds.length}`, kind: 'instance', definitionId: defId, props } as InstanceNode;
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

/** Every document stamped format 2, then migrated. */
function migrated(s: ProjectState): ProjectState {
  for (const d of [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)]) d.schemaVersion = 2;
  return migrateProject(s)!.state;
}

const checkList = (...items: string[]) => `<ul class="so-rich--check">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const bulletList = (...items: string[]) => `<ul class="so-rich--bullet">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const paragraphs = (...items: string[]) => items.map((i) => `<p>${i}</p>`).join('');
const count = (html: string, part: string) => html.split(part).length - 1;

/** A component that shows its `items` as a check list. */
const checks = (s: ProjectState) => v2Def(s, 'project.checks', { items: rich('Items', ['Default item']) }, { root: section('list'), list: richNode({ $prop: 'items' }, 'check') });

describe('format 2 rich text keeps its lists after migration', () => {
  it('lists a value a chain of wrappers passes to a check list', async () => {
    const s = fresh();
    // The outermost first, so one pass over the definitions in order could not carry the list all the way out.
    v2Def(s, 'project.outer', { lines: rich('Lines') }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.wrap', props: { points: { $prop: 'lines' } } } });
    v2Def(s, 'project.wrap', { points: rich('Points', ['Wrapped default']) }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.checks', props: { items: { $prop: 'points' } } } });
    checks(s);
    placeAt(s, 'project.outer', { lines: ['Alpha', 'Beta **bold**'] });
    placeAt(s, 'project.wrap', {});
    const out = migrated(s);
    const value = (home(out).nodes[home(out).rootIds.at(-2)!] as InstanceNode).props.lines;
    expect(value).toEqual([{ type: 'check', items: [[{ text: 'Alpha' }], [{ text: 'Beta ' }, { text: 'bold', strong: true }]] }]);
    for (const [id, name] of [['project.wrap', 'points'], ['project.outer', 'lines']]) expect(out.components[id].properties[name]).toMatchObject({ plainAs: 'check' });
    const html = await renderHome(out);
    expect(html).toContain(checkList('Alpha', 'Beta <strong>bold</strong>'));
    expect(html).toContain(checkList('Wrapped default'));
  });

  it('lists the fields of a whole list passed to a component that lists them', async () => {
    const s = fresh();
    // Each definition holds its own copy of the fields, in its own order, as separate documents do; only `perks` is listed.
    const fields = () => ({ intro: rich('Intro'), perks: rich('Perks') });
    v2Def(s, 'project.tierwrap', { tiers: { type: 'list', label: 'Tiers', itemLabel: 'Tier', fields: { perks: rich('Perks'), intro: rich('Intro') }, default: [] } }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.tiers', props: { rows: { $prop: 'tiers' } } } });
    v2Def(s, 'project.tiers', { rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: fields(), default: [] } }, { root: section('each'), each: { kind: 'repeat', list: { $prop: 'rows' }, children: ['intro', 'perks'] }, intro: richNode({ $item: 'intro' }), perks: richNode({ $item: 'perks' }, 'check') });
    placeAt(s, 'project.tierwrap', { tiers: [{ id: 't1', intro: ['Intro one'], perks: ['Perk one', 'Perk two'] }] });
    const out = migrated(s);
    const wrapFields = (out.components['project.tierwrap'].properties.tiers as { fields: Record<string, unknown> }).fields;
    expect(wrapFields.perks).toMatchObject({ plainAs: 'check' });
    expect(wrapFields.intro).not.toHaveProperty('plainAs');
    const html = await renderHome(out);
    expect(html).toContain(checkList('Perk one', 'Perk two'));
    expect(html).toContain(paragraphs('Intro one'));
  });

  /** A list `cards` passed item by item to a component that lists it, beside a list `others` with the same field shown as paragraphs. */
  const twoLists = { cards: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { notes: rich('Notes') }, default: [] }, others: { type: 'list', label: 'Others', itemLabel: 'Other', fields: { notes: rich('Notes') }, default: [] } };
  const others = { more: { kind: 'repeat', list: { $prop: 'others' }, children: ['plain'] }, plain: richNode({ $item: 'notes' }) };

  it('lists a list item field passed to a nested component that lists it', async () => {
    const s = fresh();
    checks(s);
    v2Def(s, 'project.cards', twoLists, { root: section('each', 'more'), each: { kind: 'repeat', list: { $prop: 'cards' }, children: ['inner'] }, inner: { kind: 'instance', definitionId: 'project.checks', props: { items: { $item: 'notes' } } }, ...others });
    placeAt(s, 'project.cards', { cards: [{ id: 'c1', notes: ['Note one', 'Note two'] }], others: [{ id: 'o1', notes: ['Other one', 'Other two'] }] });
    const html = await renderHome(migrated(s));
    expect(html).toContain(checkList('Note one', 'Note two'));
    expect(html).toContain(paragraphs('Other one', 'Other two'));
  });

  it('lists a list item field shown in content placed in an instance slot', async () => {
    const s = fresh();
    v2Def(s, 'project.box', {}, { root: section('content'), content: { kind: 'slot', slot: 'content' } }, { slots: { content: { label: 'Content' } } });
    v2Def(s, 'project.slotted', twoLists, {
      root: section('each', 'more'),
      each: { kind: 'repeat', list: { $prop: 'cards' }, children: ['box'] },
      box: { kind: 'instance', definitionId: 'project.box', props: {}, slots: { content: ['notes'] } },
      notes: richNode({ $item: 'notes' }, 'check'),
      ...others
    });
    placeAt(s, 'project.slotted', { cards: [{ id: 'c1', notes: ['Slot one', 'Slot two'] }], others: [{ id: 'o1', notes: ['Other one', 'Other two'] }] });
    const out = migrated(s);
    const lists = out.components['project.slotted'].properties as unknown as Record<string, { fields: Record<string, unknown> }>;
    expect(lists.cards.fields.notes).toMatchObject({ plainAs: 'check' });
    expect(lists.others.fields.notes).not.toHaveProperty('plainAs');
    const html = await renderHome(out);
    expect(html).toContain(checkList('Slot one', 'Slot two'));
    expect(html).toContain(paragraphs('Other one', 'Other two'));
  });

  it('keeps each place showing one value as it did: a check list beside paragraphs, and beside bullets', async () => {
    const s = fresh();
    v2Def(s, 'project.both', { body: rich('Body') }, { root: section('listed', 'plain'), listed: richNode({ $prop: 'body' }, 'check'), plain: richNode({ $prop: 'body' }) });
    v2Def(s, 'project.kinds', { body: rich('Body') }, { root: section('checked', 'bulleted'), checked: richNode({ $prop: 'body' }, 'check'), bulleted: richNode({ $prop: 'body' }, 'bullet') });
    placeAt(s, 'project.both', { body: ['One', 'Two **2**'] });
    placeAt(s, 'project.kinds', { body: ['Three', 'Four'] });
    const out = migrated(s);
    // One value, stored as the paragraphs it was; each place that listed it lists it, in its own kind of list.
    expect(out.components['project.both'].properties.body).not.toHaveProperty('plainAs');
    expect((home(out).nodes[home(out).rootIds.at(-2)!] as InstanceNode).props.body).toEqual([{ type: 'p', spans: [{ text: 'One' }] }, { type: 'p', spans: [{ text: 'Two ' }, { text: '2', strong: true }] }]);
    const nodes = out.components['project.both'].tree!.nodes as Record<string, GraphNode & { list?: unknown }>;
    expect(nodes.listed).toMatchObject({ paragraphList: 'check' });
    expect(nodes.plain).not.toHaveProperty('paragraphList');
    expect(nodes.listed).not.toHaveProperty('list');
    const kinds = out.components['project.kinds'].tree!.nodes;
    expect([kinds.checked, kinds.bulleted]).toMatchObject([{ paragraphList: 'check' }, { paragraphList: 'ul' }]);
    for (const n of Object.values(kinds)) expect(n).not.toHaveProperty('list');
    const html = await renderHome(out);
    expect(count(html, checkList('One', 'Two <strong>2</strong>'))).toBe(1);
    expect(count(html, paragraphs('One', 'Two <strong>2</strong>'))).toBe(1);
    expect(count(html, checkList('Three', 'Four'))).toBe(1);
    expect(count(html, bulletList('Three', 'Four'))).toBe(1);
  });

  it('lists paragraphs a wrapper passes on, however deep, and the nested component’s own values, at the nested list', async () => {
    const s = fresh();
    checks(s);
    v2Def(s, 'project.mixed', { points: rich('Points') }, { root: section('plain', 'inner'), plain: richNode({ $prop: 'points' }), inner: { kind: 'instance', definitionId: 'project.checks', props: { items: { $prop: 'points' } } } });
    // Paragraphs passed through a component that only passes them on.
    v2Def(s, 'project.relay', { lines: rich('Lines') }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.relay2', props: { more: { $prop: 'lines' } } } });
    v2Def(s, 'project.relay2', { more: rich('More') }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.checks', props: { items: { $prop: 'more' } } } });
    v2Def(s, 'project.deep', { text: rich('Text') }, { root: section('plain', 'inner'), plain: richNode({ $prop: 'text' }), inner: { kind: 'instance', definitionId: 'project.relay', props: { lines: { $prop: 'text' } } } });
    placeAt(s, 'project.mixed', { points: ['Shared one', 'Shared two'] });
    placeAt(s, 'project.deep', { text: ['Deep one', 'Deep two'] });
    placeAt(s, 'project.checks', { items: ['Own item'] });
    const out = migrated(s);
    // The nested component's own values stay a check list; its list also takes the paragraphs passed to it.
    expect(out.components['project.checks'].properties.items).toMatchObject({ plainAs: 'check' });
    expect((home(out).nodes[home(out).rootIds.at(-1)!] as InstanceNode).props.items).toEqual([{ type: 'check', items: [[{ text: 'Own item' }]] }]);
    expect(out.components['project.checks'].tree!.nodes.list).toMatchObject({ paragraphList: 'check' });
    const html = await renderHome(out);
    expect(count(html, paragraphs('Shared one', 'Shared two'))).toBe(1);
    expect(count(html, checkList('Shared one', 'Shared two'))).toBe(1);
    expect(count(html, paragraphs('Deep one', 'Deep two'))).toBe(1);
    expect(count(html, checkList('Deep one', 'Deep two'))).toBe(1);
    expect(count(html, checkList('Own item'))).toBe(1);
  });

  it('lists paragraphs a current design passes to a definition restored from format 2', async () => {
    const s = fresh();
    checks(s);
    // A current design: its value is stored as paragraphs, shown as such, and passed to the list.
    v2Def(s, 'project.current', { points: rich('Points') }, { root: section('plain', 'inner'), plain: richNode({ $prop: 'points' }), inner: { kind: 'instance', definitionId: 'project.checks', props: { items: { $prop: 'points' } } } });
    placeAt(s, 'project.current', { points: [{ type: 'p', spans: [{ text: 'Kept one' }] }, { type: 'p', spans: [{ text: 'Kept two' }] }] });
    const latest = s.manifest.schemaVersion;
    for (const d of [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)]) d.schemaVersion = latest;
    s.components['project.checks'].schemaVersion = 2;
    const out = migrateProject(s)!.state;
    expect(out.components['project.checks'].tree!.nodes.list).toMatchObject({ paragraphList: 'check' });
    expect(out.components['project.current']).toEqual(s.components['project.current']);
    const html = await renderHome(out);
    expect(count(html, paragraphs('Kept one', 'Kept two'))).toBe(1);
    expect(count(html, checkList('Kept one', 'Kept two'))).toBe(1);
  });

  it('gives a value listed one way no hint, as a definition installed today has none', () => {
    const s = fresh();
    checks(s);
    const out = migrated(s);
    expect(out.components['project.checks'].tree!.nodes.list).not.toHaveProperty('paragraphList');
    expect(out.components['project.checks'].properties.items).toMatchObject({ plainAs: 'check', default: [{ type: 'check', items: [[{ text: 'Default item' }]] }] });
  });

  it('ends on a cycle of definitions passing a value around', () => {
    const s = fresh();
    v2Def(s, 'project.a', { x: rich('X') }, { root: section('b', 'shown'), b: { kind: 'instance', definitionId: 'project.b', props: { y: { $prop: 'x' } } }, shown: richNode({ $prop: 'x' }, 'check') });
    v2Def(s, 'project.b', { y: rich('Y') }, { root: section('a', 'plain'), a: { kind: 'instance', definitionId: 'project.a', props: { x: { $prop: 'y' } } }, plain: richNode({ $prop: 'y' }) });
    const out = migrated(s);
    // Each value is shown both ways around the cycle, so it stays paragraphs and the list keeps listing it.
    for (const [id, name] of [['project.a', 'x'], ['project.b', 'y']]) expect(out.components[id].properties[name]).not.toHaveProperty('plainAs');
    expect(out.components['project.a'].tree!.nodes.shown).toMatchObject({ paragraphList: 'check' });
  });

  it('reads no kind of list from a hand-edited schema that names none', () => {
    const s = fresh();
    v2Def(s, 'project.odd', { items: { ...rich('Items'), plainAs: 'constructor' } }, { root: section('list'), list: richNode({ $prop: 'items' }) });
    v2Def(s, 'project.feed', { lines: rich('Lines') }, { root: section('inner'), inner: { kind: 'instance', definitionId: 'project.odd', props: { items: { $prop: 'lines' } } } });
    placeAt(s, 'project.feed', { lines: ['Alpha'] });
    for (const d of [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)]) d.schemaVersion = 2;
    // Only the definition with the odd schema is current; the value passed to it is converted with the rest.
    s.components['project.odd'].schemaVersion = SCHEMA_VERSION;
    const out = migrateProject(s)!.state;
    expect((home(out).nodes[home(out).rootIds.at(-1)!] as InstanceNode).props.lines).toEqual([{ type: 'p', spans: [{ text: 'Alpha' }] }]);
  });
});

describe('editing text that a place lists', () => {
  const listed = { id: 'n', kind: 'text', tag: 'div', rich: true, paragraphList: 'check', text: { $prop: 'body' } } as TextNode;
  const p = (text: string) => ({ type: 'p' as const, spans: [{ text }] });
  const check = (...items: string[]) => ({ type: 'check' as const, items: items.map((text) => [{ text }]) });
  /** The edited element's children, as the bridge copies them from `<div class="so-rich"><ul ...>...</ul></div>`. */
  const shownAsList = (...items: string[]) => [{ tag: 'ul', check: true, children: items.map((i) => ({ tag: 'li', children: [i] })) }];
  const edit = (stored: RichText, ...items: string[]) => storedEdit(listed, stored, blocksFromDom(shownAsList(...items), {}).blocks);

  it('keeps paragraphs as paragraphs, and changes nothing when nothing changed', () => {
    const stored: RichText = [p('One'), p('Two')];
    expect(edit(stored, 'One', 'Two')).toEqual(stored);
    expect(edit(stored, 'One', 'Two changed')).toEqual([p('One'), p('Two changed')]);
  });

  it('keeps each item what it was in text that holds paragraphs and list items', () => {
    const stored: RichText = [p('Intro'), check('A', 'B'), p('Outro')];
    expect(edit(stored, 'Intro', 'A', 'B', 'Outro')).toEqual(stored);
    expect(edit(stored, 'Introduction', 'A', 'B', 'Outro')).toEqual([p('Introduction'), check('A', 'B'), p('Outro')]);
    // Items are found by their words; a new one is a paragraph, the form the text is stored in.
    expect(edit(stored, 'Intro', 'A', 'B', 'C', 'Outro')).toEqual([p('Intro'), check('A', 'B'), p('C'), p('Outro')]);
    expect(edit([p('Intro'), check('A'), p('Outro')], 'A', 'Outro', 'New')).toEqual([check('A'), p('Outro'), p('New')]);
    // Changed to the words of a later item, a paragraph is still the paragraph in its place.
    expect(edit(stored, 'B', 'A', 'B', 'Outro')).toEqual([p('B'), check('A', 'B'), p('Outro')]);
    // The same words twice are each matched once, in order.
    expect(edit([check('A'), p('A')], 'A', 'A')).toEqual([check('A'), p('A')]);
  });

  it('keeps a stored list a list', () => {
    expect(edit([check('One')], 'One more')).toEqual([check('One more')]);
    expect(edit([check('One')], 'One')).toEqual([check('One')]);
  });

  it('stores anything else as written', () => {
    const stored: RichText = [p('One')];
    const next: RichText = [{ type: 'h3', spans: [{ text: 'Title' }] }, check('One')];
    expect(storedEdit(listed, stored, next)).toEqual(next);
    expect(storedEdit({ ...listed, paragraphList: undefined }, stored, [check('One')])).toEqual([check('One')]);
  });
});

describe('code components take each rich text property in the form it declares', () => {
  const source = [
    '<script>',
    "\timport SoRichText from '../runtime/RichText.svelte';",
    "\tlet { intro = [], body = [], rows = [], class: className = '' } = $props();",
    '</script>',
    '<section class={className}>',
    '\t<SoRichText value={intro} class="intro" />',
    "\t<p class=\"joined\">{body.join(' / ')}</p>",
    "\t{#each rows as row (row.id)}<div class=\"row\"><SoRichText value={row.rich} /><span class=\"plain\">{row.plain.join(' | ')}</span></div>{/each}",
    '</section>',
    ''
  ].join('\n');
  const properties = {
    intro: { type: 'richtext', label: 'Intro', default: [], codeForm: 'blocks' },
    body: { type: 'richtext', label: 'Body', default: [] },
    rows: { type: 'list', label: 'Rows', itemLabel: 'Row', default: [], fields: { rich: { type: 'richtext', label: 'Rich', default: [], codeForm: 'blocks' }, plain: { type: 'richtext', label: 'Plain', default: [], codeForm: 'paragraphs' } } }
  };

  function mixed() {
    const r = applyOperations(fresh(), [{ type: 'component.createCode', name: 'Mixed', source, properties }]);
    const s = r.state;
    const def = s.components[r.results[0].definitionId as string];
    const about = Object.values(s.pages).find((x) => x.title === 'About')!;
    const values = {
      intro: normalizeRichText(`Read [our story](${about.route}#team) **now**`, s, 'Intro'),
      body: normalizeRichText('First **one**\n\nSecond', s, 'Body'),
      rows: [{ id: 'r1', rich: normalizeRichText('- [x] Checked', s, 'Rich'), plain: normalizeRichText('Plain *a*\n\nPlain b', s, 'Plain') }]
    };
    return { s, def, about, values };
  }
  const expectBoth = (html: string) => {
    expect(html).toContain('<p>Read <a href="/about/#team" class="so-link">our story</a><strong>now</strong></p>');
    expect(html).toContain('<p class="joined">First **one** / Second</p>');
    expect(html).toContain('<ul class="so-rich--check"><li>Checked</li></ul>');
    expect(html).toContain('<span class="plain">Plain *a* | Plain b</span>');
    expect(html).not.toContain('[object Object]');
  };

  it('renders both forms in one placement', async () => {
    const { s, def, values } = mixed();
    const node = makeInstance(def, values);
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    expectBoth(await renderHome(s));
    // Only the property that gets its links shows them.
    const content = renderedContent(s, home(s)).filter((c) => c.nodeId === node.id && c.rich);
    expect(content.map((c) => [c.source && 'prop' in c.source ? `${c.source.prop}${'field' in c.source && c.source.field ? `.${c.source.field}` : ''}` : '', c.richLinks]).sort()).toEqual([
      ['body', false],
      ['intro', true],
      ['rows.plain', false],
      ['rows.rich', true]
    ]);
  });

  it('renders both forms when a design passes them on, a whole list included', async () => {
    const { s, def, values } = mixed();
    const inner = makeInstance(def, { intro: { $prop: 'lead' }, body: { $prop: 'text' }, rows: { $prop: 'items' } });
    const wrapper = {
      ...structuredClone(def),
      id: 'project.mixwrap',
      componentId: 'project.mixwrap',
      kind: 'managed',
      source: undefined,
      sourcePath: undefined,
      properties: { lead: { ...properties.intro, codeForm: undefined }, text: properties.body, items: { ...properties.rows, fields: { rich: { type: 'richtext', label: 'Rich', default: [] }, plain: { type: 'richtext', label: 'Plain', default: [] } } } },
      parts: { root: { nodeId: inner.id, label: 'Root' } },
      tree: { rootIds: [inner.id], nodes: { [inner.id]: inner } }
    } as unknown as ComponentDefinition;
    s.components[wrapper.id] = wrapper;
    const node = makeInstance(wrapper, { lead: values.intro, text: values.body, items: values.rows });
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    const generated = [...generateProject(s).values()].find((t) => t.includes('richParagraphs(items'))!;
    expect(generated).toContain('rows={richParagraphs(items, ["plain"])}');
    expect(generated).toContain('body={richParagraphs(text)}');
    expect(generated).toContain('intro={lead}');
    expectBoth(await renderHome(s));
  });
});

describe('links a code component shows', () => {
  it('counts a link in the default of a list field its items leave out', () => {
    const s = fresh();
    const about = Object.values(s.pages).find((x) => x.title === 'About')!;
    about.draft = true;
    const r = applyOperations(s, [
      {
        type: 'component.createCode',
        name: 'Rows',
        source: "<script>\n\timport SoRichText from '../runtime/RichText.svelte';\n\tlet { rows = [] } = $props();\n</script>\n{#each rows as row (row.id)}<SoRichText value={row.body} />{/each}\n",
        properties: { rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { body: { type: 'richtext', label: 'Body', codeForm: 'blocks' } } } }
      }
    ]);
    const def = r.state.components[r.results[0].definitionId as string];
    (def.properties.rows as unknown as { fields: { body: { default: unknown } } }).fields.body.default = [{ type: 'p', spans: [{ text: 'draft', link: { type: 'page', target: about.id } }] }];
    const node = makeInstance(def, { rows: [{ id: 'r1' }] });
    home(r.state).nodes[node.id] = node;
    home(r.state).rootIds.push(node.id);
    expect(publicationPlan(r.state).draftLinks).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: node.id, pageId: about.id, inText: true })]));
  });
});

describe('Convert to code keeps page links following their pages', () => {
  const blank = (s: ProjectState, id: string, properties: Record<string, unknown>, nodes: Array<[string, Record<string, unknown>]>) => {
    const def = {
      schemaVersion: s.manifest.schemaVersion,
      id,
      componentId: id,
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: id.replace('project.', ''),
      description: '',
      category: 'custom',
      tags: [],
      icon: 'component',
      properties,
      parts: { root: { nodeId: nodes[0][0], label: 'Root' } },
      tree: { rootIds: [nodes[0][0]], nodes: Object.fromEntries(nodes.map(([nid, node]) => [nid, { id: nid, ...node }])) },
      provenance: { createdBy: 'user' },
      license: 'Project'
    } as unknown as ComponentDefinition;
    s.components[id] = def;
    return def;
  };

  function converted() {
    const s = fresh();
    const about = Object.values(s.pages).find((x) => x.title === 'About')!;
    const contact = Object.values(s.pages).find((x) => x.title === 'Contact')!;
    const text = s.components[installComponent(s, 'content.text')];
    const nested = makeInstance(text, { body: normalizeRichText(`A [nested link](${about.route})`, s, 'Body') });
    // A nested design whose list field and link property have page links only in their defaults.
    const rows = blank(
      s,
      'project.rows',
      {
        rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { body: { type: 'richtext', label: 'Body', default: normalizeRichText(`A [row link](${about.route})`, s, 'Body') } }, default: [] },
        more: { type: 'link', label: 'More', default: { type: 'page', target: about.id } },
        // A name the generated code reads for a variant axis: the copy's property takes another.
        variant_style: { type: 'link', label: 'Style link', default: { type: 'page', target: about.id } }
      },
      [
        ['rroot', { kind: 'element', tag: 'section', children: ['each', 'more'] }],
        ['each', { kind: 'repeat', list: { $prop: 'rows' }, children: ['rbody'] }],
        ['rbody', { kind: 'text', tag: 'div', rich: true, text: { $item: 'body' } }],
        ['more', { kind: 'link', link: { $prop: 'more' }, label: 'More', appearance: 'link' }]
      ]
    );
    const sparse = makeInstance(rows, { rows: [{ id: 'r1' }] });
    delete sparse.props.more;
    delete sparse.props.variant_style;
    // Code that takes its rich text as paragraph strings shows no links, and list data that only looks like a link is none.
    const notes = {
      ...structuredClone(text),
      id: 'project.notes',
      componentId: 'project.notes',
      kind: 'code',
      tree: undefined,
      source: '<script>\n\tlet { notes = [], data = [] } = $props();\n</script>\n<p>{notes.length} {data.length}</p>\n',
      sourcePath: 'src/lib/siteorigin/custom/Notes-x.svelte',
      properties: {
        notes: { type: 'list', label: 'Notes', itemLabel: 'Note', fields: { body: { type: 'richtext', label: 'Body', default: normalizeRichText(`[hidden](${about.route})`, s, 'Body') } }, default: [] },
        data: { type: 'list', label: 'Data', itemLabel: 'Row', fields: { type: { type: 'string', label: 'Type', default: '' }, target: { type: 'string', label: 'Target', default: '' } }, default: [{ id: 'd1', type: 'page', target: 'landing' }] }
      },
      parts: { root: { nodeId: 'root', label: 'Root' } }
    } as unknown as ComponentDefinition;
    s.components[notes.id] = notes;
    const codeNested = { id: 'n_codenest', kind: 'instance', definitionId: notes.id, props: { notes: [{ id: 'k1' }] } } as InstanceNode;
    const def = blank(
      s,
      'project.linked',
      // `linkLabel` would read as the label of a property named `link`, deciding whether the link shows.
      { body: { type: 'richtext', label: 'Body', default: normalizeRichText('Own words', s, 'Body') }, linkLabel: { type: 'string', label: 'Link label', default: '' } },
      [
        ['root', { kind: 'element', tag: 'section', children: ['own', 'literal', 'button', 'card', 'quiet', nested.id, sparse.id, codeNested.id] }],
        ['own', { kind: 'text', tag: 'div', rich: true, text: { $prop: 'body' } }],
        ['literal', { kind: 'text', tag: 'div', rich: true, text: normalizeRichText(`See [the team](${about.route}#team) today`, s, 'Text') }],
        ['button', { kind: 'link', link: { type: 'page', target: about.id }, label: 'Visit us', appearance: 'primary' }],
        ['card', { kind: 'element', tag: 'div', link: { type: 'page', target: about.id }, children: ['cardText'] }],
        ['cardText', { kind: 'text', tag: 'p', text: 'Card words' }],
        ['quiet', { kind: 'element', tag: 'div', action: 'none', link: { type: 'page', target: about.id }, children: ['quietText'] }],
        ['quietText', { kind: 'text', tag: 'p', text: 'Quiet words' }],
        [nested.id, nested as unknown as Record<string, unknown>],
        [sparse.id, sparse as unknown as Record<string, unknown>],
        [codeNested.id, codeNested as unknown as Record<string, unknown>]
      ]
    );
    const node = makeInstance(def, {});
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }]);
    const copy = r.state.components[r.results[0].definitionId as string];
    return { s: r.state, about, contact, copy };
  }
  const followed = ['the team', 'Visit us', 'Card words', 'nested link', 'row link', 'More'];
  const linkTo = (route: string, label: string, anchor = label === 'the team' ? '#team' : '') => new RegExp(`href="${route}${anchor}"[^>]*>(<[^>]+>)*${label}<`);

  it('moves each literal page link into a property the project tracks', () => {
    const { copy, about } = converted();
    expect(Object.keys(copy.properties).sort()).toEqual(['body', 'body2', 'body3', 'link2', 'link3', 'linkLabel', 'more', 'rows', 'variantStyle']);
    // Every name is one the copy's property editor accepts when the schema is saved again.
    for (const k of Object.keys(copy.properties)) expect(() => checkPropName(k), k).not.toThrow();
    expect(JSON.stringify(copy.properties.body2.default)).toContain(about.id);
    for (const k of ['link2', 'link3', 'more', 'variantStyle']) expect(copy.properties[k].default).toEqual({ type: 'page', target: about.id });
    // A list item without the field moves as it is, and the copied schema keeps the field's default it shows.
    expect(copy.properties.rows.default).toEqual([{ id: expect.any(String) }]);
    expect(JSON.stringify((copy.properties.rows as { fields: Record<string, { default: unknown }> }).fields.body.default)).toContain(about.id);
    // Every rich text property and list field is passed as the blocks the converted source renders.
    for (const k of ['body', 'body2', 'body3']) expect(copy.properties[k]).toMatchObject({ type: 'richtext', codeForm: 'blocks' });
    expect((copy.properties.rows as { fields: Record<string, unknown> }).fields.body).toMatchObject({ codeForm: 'blocks' });
    // The source keeps no address a page may move from, the inert element's included.
    expect(copy.source!.split('\n').filter((l) => l.includes(about.route))).toEqual([]);
    expect(copy.source).not.toContain(about.id);
  });

  it('follows a renamed page, and moves to the replacement of a removed one', async () => {
    const { s, about, contact } = converted();
    const before = await renderHome(s);
    for (const label of followed) expect(before).toMatch(linkTo('/about/', label));
    expect(before).not.toMatch(/href="[^"]*"[^>]*>(<[^>]+>)*Quiet words/);
    const moved = applyOperations(s, [{ type: 'page.update', pageId: about.id, route: '/our-story/' }]).state;
    const after = await renderHome(moved);
    for (const label of followed) expect(after, label).toMatch(linkTo('/our-story/', label));
    const replaced = applyOperations(moved, [{ type: 'page.remove', pageId: about.id, replacementPageId: contact.id }]).state;
    const last = await renderHome(replaced);
    // The replacement has no section called "team", so that link goes to the page itself.
    for (const label of followed) expect(last, label).toMatch(linkTo(contact.route, label, ''));
  });
});

describe('Convert to code within what a copy can keep', () => {
  it('refuses a list filled in from pages whose field default links to a page', () => {
    const s = fresh();
    const about = Object.values(s.pages).find((x) => x.title === 'About')!;
    const managed = (id: string, properties: Record<string, unknown>, nodes: Record<string, Record<string, unknown>>) => {
      const def = {
        schemaVersion: s.manifest.schemaVersion, id, componentId: id, contractVersion: 1, kind: 'managed', owner: 'project', name: id, description: '', category: 'custom', tags: [], icon: 'component',
        properties, parts: { root: { nodeId: 'root', label: 'Root' } },
        tree: { rootIds: ['root'], nodes: Object.fromEntries(Object.entries(nodes).map(([nid, n]) => [nid, { id: nid, ...n }])) },
        provenance: { createdBy: 'user' }, license: 'Project'
      } as unknown as ComponentDefinition;
      s.components[id] = def;
      return def;
    };
    managed(
      'project.news',
      { news: { type: 'list', label: 'News', itemLabel: 'Story', feed: 'articles', default: [], fields: { title: { type: 'string', label: 'Title', default: '' }, note: { type: 'richtext', label: 'Note', default: normalizeRichText(`[about](${about.route})`, s, 'Note') } } } },
      { root: { kind: 'element', tag: 'section', children: ['each'] }, each: { kind: 'repeat', list: { $prop: 'news' }, children: ['note'] }, note: { kind: 'text', tag: 'div', rich: true, text: { $item: 'note' } } }
    );
    const outer = managed('project.outernews', {}, { root: { kind: 'element', tag: 'section', children: ['inner'] }, inner: { kind: 'instance', definitionId: 'project.news', props: {} } });
    const node = makeInstance(outer, {});
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    expect(() => applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }])).toThrow(/a list filled in from pages, with a page link in a field's default/);
    // A field every row supplies itself never shows its default, and text written before blocks holds no link.
    const news = s.components['project.news'].properties.news as unknown as { fields: Record<string, unknown> };
    news.fields.note = { type: 'richtext', label: 'Note', default: ['Written as a string'] };
    news.fields.pageLink = { type: 'link', label: 'Link', default: { type: 'page', target: about.id } };
    outer.properties.intro = { type: 'richtext', label: 'Intro', default: ['Written before blocks', { type: 'p' }] as never };
    expect(() => applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }])).not.toThrow();
  });

  it('refuses rather than give the copy more properties than a component may have', () => {
    const s = fresh();
    const about = Object.values(s.pages).find((x) => x.title === 'About')!;
    const properties = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, { type: 'string', label: `P${i}`, default: '' }]));
    const def = {
      schemaVersion: s.manifest.schemaVersion, id: 'project.full', componentId: 'project.full', contractVersion: 1, kind: 'managed', owner: 'project', name: 'Full', description: '', category: 'custom', tags: [], icon: 'component',
      properties,
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'section', children: ['go'] }, go: { id: 'go', kind: 'link', link: { type: 'page', target: about.id }, label: 'Go', appearance: 'primary' } } },
      provenance: { createdBy: 'user' }, license: 'Project'
    } as unknown as ComponentDefinition;
    s.components[def.id] = def;
    const node = makeInstance(def, {});
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    expect(() => applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }])).toThrow(/too many properties/);
  });
});

describe('the runtime helpers code components share', () => {
  it('converts only the named fields of a list, and every field without names, as older code expects', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(join(resolve('.tmp'), 'richtext-util-'));
    roots.push(dir);
    writeFileSync(join(dir, 'util.js'), UTIL_JS);
    const { richParagraphs, richList } = await import(/* @vite-ignore */ join(dir, 'util.js'));
    const blocks = [{ type: 'p', spans: [{ text: 'A ' }, { text: 'b', strong: true }, { text: ' ' }, { text: 'c', em: true }] }];
    const line = 'A **b** *c*';
    expect(richParagraphs(blocks)).toEqual([line]);
    expect(richParagraphs([{ id: 'r1', rich: blocks, plain: blocks }, { id: 'r2' }], ['plain'])).toEqual([{ id: 'r1', rich: blocks, plain: [line] }, { id: 'r2' }]);
    expect(richParagraphs([{ id: 'r1', rich: blocks, plain: blocks }])).toEqual([{ id: 'r1', rich: [line], plain: [line] }]);
    expect(richList([...blocks, { type: 'check', items: [[{ text: 'c' }]] }], 'check')).toEqual([{ type: 'check', items: [blocks[0].spans, [{ text: 'c' }]] }]);
    const heading = [{ type: 'h3', spans: [{ text: 'T' }] }, ...blocks];
    expect(richList(heading, 'check')).toBe(heading);
  });
});
