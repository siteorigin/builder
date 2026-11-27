import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import type { ElementNode, InstanceNode, LinkNode, ListItem, ProjectState, RepeatNode, TextNode } from '@shared/types';
import { validateOperation, type EditOperation, type Op } from '@shared/ops';
import { projectDefinitionId } from '@shared/component-ids';
import { styleSetFor } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { defFile, generateManagedComponent } from '@generator/index';
import { executeTool, toolDefinitions } from '@agent/tools';
import { OP_REACH } from '@agent/scope';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'so-upsert-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Expo', false));
  const page = await s.apply({ operations: [{ type: 'page.create', title: 'Pricing' }] }, { label: 'Add page' });
  return { s, home: { kind: 'page' as const, id: s.state.site.homePageId }, other: { kind: 'page' as const, id: page.results![0].pageId as string } };
}

type Upsert = Op<'component.upsert'>;

/**
 * A pricing table: a heading and an introduction shown only when set, a repeated list of plans whose cards show a
 * badge only for the featured one and a button each, a footnote slot, and two variant axes (tone and layout).
 */
function pricing(extra: Partial<Upsert> = {}): Upsert {
  return {
    type: 'component.upsert',
    name: 'Pricing table',
    description: 'Plans side by side.',
    category: 'conversion',
    tags: ['pricing', 'plans'],
    icon: 'tag',
    properties: {
      heading: { type: 'string', label: 'Heading', default: 'Plans' },
      intro: { type: 'richtext', label: 'Introduction', default: ['Pick the plan that fits.'] },
      level: { type: 'enum', label: 'Heading level', default: 'h2', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }] },
      plans: {
        type: 'list',
        label: 'Plans',
        itemLabel: 'Plan',
        fields: {
          name: { type: 'string', label: 'Name', default: 'Plan' },
          price: { type: 'string', label: 'Price', default: '$0' },
          featured: { type: 'boolean', label: 'Featured', default: false },
          cta: { type: 'link', label: 'Button link', default: { type: 'none', target: '' } },
          ctaLabel: { type: 'string', label: 'Button text', default: 'Choose' }
        },
        default: [
          { id: 'basic', name: 'Basic', price: '$9', featured: false, ctaLabel: 'Start' },
          { id: 'pro', name: 'Pro', price: '$29', featured: true, ctaLabel: 'Go pro' }
        ]
      }
    },
    nodes: [
      { kind: 'element', id: 'root', tag: 'section', children: ['header', 'list', 'footnote'], styles: { paddingBlock: { token: 'space.xl' } } },
      { kind: 'element', id: 'header', tag: 'header', children: ['title', 'intro'], styles: { base: { layout: 'stack', gap: { token: 'space.sm' } } } },
      { kind: 'text', id: 'title', tag: { $prop: 'level' }, text: { $prop: 'heading' }, styles: { textStyle: { token: 'text.h2' } } },
      { kind: 'text', id: 'intro', rich: true, text: { $prop: 'intro' }, when: { $prop: 'intro' } },
      { kind: 'element', id: 'list', tag: 'ul', children: ['plans'], styles: { base: { layout: 'stack', gap: { token: 'space.md' } }, desktop: { layout: 'grid', columns: 3 } } },
      { kind: 'repeat', id: 'plans', list: 'plans', children: ['card'] },
      { kind: 'element', id: 'card', tag: 'li', children: ['badge', 'name', 'price', 'cta'], styles: { base: { paddingBlock: { token: 'space.lg' } }, 'base:hover': { background: { token: 'color.surface-alt' } } } },
      { kind: 'text', id: 'badge', tag: 'span', text: 'Most popular', when: { ref: { $item: 'featured' }, eq: true } },
      { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } },
      { kind: 'text', id: 'price', tag: 'p', text: { $item: 'price' }, unless: { ref: { $item: 'price' }, eq: '' } },
      { kind: 'link', id: 'cta', link: { $item: 'cta' }, label: { $item: 'ctaLabel' }, appearance: 'secondary' },
      { kind: 'element', id: 'footnote', tag: 'footer', children: ['notes'], collapseEmpty: true },
      { kind: 'slot', id: 'notes', slot: 'notes' }
    ],
    parts: {
      card: { nodeId: 'card', label: 'Plan card' },
      title: { nodeId: 'title', label: 'Heading', styleControls: ['textStyle', 'color'] },
      cta: { nodeId: 'cta', label: 'Button' }
    },
    slots: { notes: { label: 'Notes', description: 'Small print under the plans.', primitives: ['text', 'link'], max: 2 } },
    variantAxes: {
      tone: { label: 'Tone', options: { light: { label: 'Light' }, dark: { label: 'Dark', styles: { root: { background: { token: 'color.inverse' }, color: { token: 'color.on-inverse' } } } } } },
      layout: { label: 'Layout', default: 'grid', options: { stack: { label: 'Stacked' }, grid: { label: 'Grid', styles: { list: { desktop: { columns: 2 } } } } } }
    },
    ...extra
  };
}

/** Problems that stop a project from being saved. */
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

/** A design as the app writes it, compiled for the server and the browser, in the exported site and in the editor. */
function compiles(s: ProjectState, defId: string) {
  const def = s.components[defId];
  for (const instrument of [false, true])
    for (const generate of ['server', 'client'] as const) compile(generateManagedComponent(s, def, { instrument }), { filename: defFile(def), generate, runes: true });
}

describe('component.upsert: building a managed component in one operation (#358)', () => {
  it('creates a multi-part component with lists, bindings, conditions, a slot and two variant axes, and places it in the same batch', async () => {
    const { s, home } = await session();
    const entries = s.historyInfo().entries.length;
    const definitionId = projectDefinitionId('Pricing table');
    const r = await s.apply(
      { operations: [pricing({ newDefinitionId: definitionId }), { type: 'node.insert', owner: home, parentId: null, definitionId, variants: { tone: 'dark' } }] },
      { label: 'Build Pricing table' }
    );
    expect(r.error).toBeUndefined();
    expect(r.results![0]).toEqual({ definitionId, rootNodeId: 'root' });
    const def = s.state.components[definitionId];
    expect(def).toMatchObject({ kind: 'managed', owner: 'project', name: 'Pricing table', description: 'Plans side by side.', category: 'conversion', tags: ['pricing', 'plans'], icon: 'tag' });
    expect(Object.keys(def.properties)).toEqual(['heading', 'intro', 'level', 'plans']);
    // The design keeps the IDs it was described with, in one tree under its root.
    expect(def.tree!.rootIds).toEqual(['root']);
    expect(Object.keys(def.tree!.nodes).sort()).toEqual(['badge', 'card', 'cta', 'footnote', 'header', 'intro', 'list', 'name', 'notes', 'plans', 'price', 'root', 'title'].sort());
    expect(def.tree!.nodes.title).toMatchObject({ kind: 'text', tag: { $prop: 'level' }, text: { $prop: 'heading' }, styles: { base: { textStyle: { token: 'text.h2' } } } });
    expect(def.tree!.nodes.badge).toMatchObject({ when: { ref: { $item: 'featured' }, eq: true } });
    expect(def.tree!.nodes.price).toMatchObject({ unless: { ref: { $item: 'price' }, eq: '' } });
    expect(def.tree!.nodes.intro).toMatchObject({ kind: 'text', rich: true, tag: 'div', when: { $prop: 'intro' } });
    expect((def.tree!.nodes.plans as RepeatNode).list).toEqual({ $prop: 'plans' });
    expect(def.tree!.nodes.card.styles).toEqual({ base: { paddingBlock: { token: 'space.lg' } }, 'base:hover': { background: { token: 'color.surface-alt' } } });
    expect((def.tree!.nodes.footnote as ElementNode).collapseEmpty).toBe(true);
    // Parts: the root is implied; the others keep the controls given, or offer what their kind takes.
    expect(Object.keys(def.parts)).toEqual(['root', 'card', 'title', 'cta']);
    expect(def.parts.root).toMatchObject({ nodeId: 'root', label: 'Root' });
    expect(def.parts.title.styleControls).toEqual(['textStyle', 'color']);
    expect(def.parts.card.styleControls).toEqual(styleSetFor({ kind: 'element' }));
    expect(def.parts.cta.styleControls).toEqual(styleSetFor({ kind: 'link' }));
    expect(def.slots).toEqual({ notes: { label: 'Notes', description: 'Small print under the plans.', primitives: ['text', 'link'], max: 2 } });
    expect(def.variantAxes!.tone).toMatchObject({ label: 'Tone', default: 'light' });
    expect(def.variantAxes!.tone.options.dark.styles).toEqual({ root: { base: { background: { token: 'color.inverse' }, color: { token: 'color.on-inverse' } } } });
    expect(def.variantAxes!.layout).toMatchObject({ default: 'grid', options: { grid: { styles: { list: { desktop: { columns: 2 } } } } } });

    // The placement got its own copies of the default plans, and the chosen tone.
    const placed = s.state.pages[home.id].nodes[r.results![1].nodeId as string] as InstanceNode;
    expect(placed).toMatchObject({ kind: 'instance', definitionId, variants: { tone: 'dark' } });
    expect((placed.props.plans as ListItem[]).map((p) => p.name)).toEqual(['Basic', 'Pro']);
    for (const p of placed.props.plans as ListItem[]) expect(['basic', 'pro']).not.toContain(p.id);

    expect(errors(s.state)).toEqual([]);
    compiles(s.state, definitionId);

    // One history entry, undone and redone whole.
    expect(s.historyInfo().entries.length).toBe(entries + 1);
    const built = structuredClone(s.state);
    await s.undo();
    expect(s.state.components[definitionId]).toBeUndefined();
    expect(s.state.pages[home.id].nodes[placed.id]).toBeUndefined();
    await s.redo();
    expect(s.state.components[definitionId]).toEqual(built.components[definitionId]);
    expect(s.state.pages[home.id]).toEqual(built.pages[home.id]);
  });

  it('describes a design of any depth in one flat list that passes the operation checks', () => {
    const depth = 20;
    const nodes = Array.from({ length: depth }, (_, i) => ({ kind: 'element' as const, id: `level${i}`, children: i < depth - 1 ? [`level${i + 1}`] : [] }));
    const op = pricing();
    const deep = { ...op, nodes: [...op.nodes.map((n) => (n.id === 'footnote' ? { ...n, children: ['notes', 'level0'] } : n)), ...nodes] };
    expect(validateOperation(deep)).toMatchObject({ ok: true });
    const st = applyOperations(createStarterState('blank', 'Expo', false), [deep as EditOperation]).state;
    const tree = Object.values(st.components).find((d) => d.name === 'Pricing table')!.tree!;
    expect(Object.keys(tree.nodes)).toHaveLength(13 + depth);
    expect((tree.nodes.footnote as ElementNode).children).toEqual(['notes', 'level0']);
    for (let i = 0; i < depth - 1; i++) expect((tree.nodes[`level${i}`] as ElementNode).children).toEqual([`level${i + 1}`]);
    // Object-prototype names are never node IDs.
    expect(validateOperation({ ...op, nodes: [...op.nodes, { kind: 'divider', id: 'constructor' }] }).ok).toBe(false);
    expect(() => applyOperations(createStarterState('blank', 'Expo', false), [{ ...op, nodes: [{ kind: 'element', id: 'toString', children: [] }] } as EditOperation])).toThrow(/cannot be a node ID/);
  });

  it('refuses a design that breaks its root, its bindings, its slots or its parts, and changes nothing', async () => {
    const { s } = await session();
    const before = structuredClone(s.state);
    const entries = s.historyInfo().entries.length;
    const op = pricing();
    const withNodes = (f: (nodes: Upsert['nodes']) => Upsert['nodes']) => ({ ...op, nodes: f(structuredClone(op.nodes)) });
    const node = (nodes: Upsert['nodes'], id: string) => nodes.find((n) => n.id === id)! as Record<string, unknown>;
    const refused: Array<[Upsert, RegExp]> = [
      // Root invariants.
      [withNodes((n) => [...n, { kind: 'element', id: 'stray', children: [] }]), /2 top-level nodes \("root", "stray"\)/],
      [withNodes((n) => (node(n, 'list').children = ['plans', 'header'], n)), /"header" is inside both "root" and "list"/],
      [withNodes((n) => (node(n, 'card').children = ['badge', 'name', 'price', 'cta', 'ghost'], n)), /holds "ghost", which is not one of the nodes/],
      [withNodes((n) => [{ kind: 'repeat', id: 'top', list: 'plans', children: ['root'] }, ...n]), /root "top" is a repeat/],
      [withNodes((n) => [{ kind: 'element', id: 'a', children: ['b'] }, { kind: 'element', id: 'b', children: ['a'] }, ...n]), /"a" is inside itself/],
      [withNodes((n) => [...n, { kind: 'divider', id: 'title' }]), /Two nodes have the ID "title"/],
      // Bindings.
      [withNodes((n) => (node(n, 'title').text = { $prop: 'missing' }, n)), /"title" shows "missing", which is not one of the component's properties/],
      [withNodes((n) => (node(n, 'title').text = { $item: 'name' }, n)), /"title" shows the item field "name" outside any repeat/],
      [withNodes((n) => (node(n, 'name').text = { $item: 'nope' }, n)), /"name" shows the item field "nope", which the list it repeats does not have/],
      [withNodes((n) => (node(n, 'title').text = { $prop: 'plans' }, n)), /"title" cannot show a list as its text/],
      [withNodes((n) => (node(n, 'plans').list = 'heading', n)), /"plans" cannot show a string as its list/],
      [withNodes((n) => (node(n, 'badge').when = { ref: { $item: 'featured' }, eq: 'yes' }, n)), /compares a yes\/no property with "yes"/],
      // Slots, parts and variants.
      [withNodes((n) => (node(n, 'notes').slot = 'other', n)), /shows the slot "other", which the component does not declare/],
      [{ ...withNodes((n) => n.filter((x) => x.id !== 'notes').map((x) => (x.id === 'footnote' ? { ...x, children: [] } : x))) }, /slot "notes" is declared but no slot node shows it/],
      [{ ...op, parts: { list: { nodeId: 'plans', label: 'Plans' } } }, /is a repeat, which renders no element of its own/],
      [{ ...op, parts: { root: { nodeId: 'card', label: 'Root' } } }, /root part is always the root node/],
      [{ ...op, parts: { a: { nodeId: 'card', label: 'A' }, b: { nodeId: 'card', label: 'B' } } }, /both the "a" and the "b" part/],
      [{ ...op, variantAxes: { tone: { label: 'Tone', options: { dark: { label: 'Dark', styles: { gone: { color: 'red' } } } } } } }, /styles "gone", which is not one of the nodes/],
      [{ ...op, variantAxes: { tone: { label: 'Tone', default: 'loud', options: { dark: { label: 'Dark' } } } } }, /default of the "tone" axis \("loud"\) is not one of its options/],
      // Values and styles, checked as the single-step edits check them.
      [withNodes((n) => (node(n, 'card').styles = { paddingBlock: { token: 'space.nope' } }, n)), /"card":.*space\.nope/],
      [withNodes((n) => (node(n, 'card').styles = { 'base:hover': { layout: 'grid' } }, n)), /"card": Layout cannot change on hover/],
      [withNodes((n) => (node(n, 'card').styles = { wobble: 3 }, n)), /"card": Unknown style property "wobble"/],
      [withNodes((n) => (node(n, 'title').tag = 'h9', n)), /"title": Text’s tag must be one of/],
      [withNodes((n) => (node(n, 'title').tag = { $prop: 'heading' }, n)), /cannot show a string as its tag/],
      // A list item outside its list, judged once the whole design is in place.
      [withNodes((n) => (node(n, 'footnote').tag = 'li', n)), /is a list item, so it goes directly inside a list/],
      // A repeat of the same list inside it, however deep.
      [
        withNodes((n) => {
          node(n, 'card').children = ['badge', 'name', 'price', 'cta', 'deep0'];
          const chain = Array.from({ length: 60 }, (_, i) => ({ kind: 'element' as const, id: `deep${i}`, children: [i < 59 ? `deep${i + 1}` : 'again'] }));
          return [...n, ...chain, { kind: 'repeat', id: 'again', list: 'plans', children: [] }];
        }),
        /"again" repeats "plans" inside "plans", a repeat of the same list/
      ],
      // A literal that looks like a binding but is not one.
      [withNodes((n) => [...n.map((x) => (x.id === 'header' ? { ...x, children: ['title', 'intro', 'pic'] } : x)), { kind: 'image', id: 'pic', image: { $state: 'photo' } as never }]), /"pic": a binding is/],
      [withNodes((n) => [...n.map((x) => (x.id === 'header' ? { ...x, children: ['title', 'intro', 'pic'] } : x)), { kind: 'image', id: 'pic', image: { $prop: ['heading'] } as never }]), /"pic": a binding is/],
      [withNodes((n) => [...n.map((x) => (x.id === 'header' ? { ...x, children: ['title', 'intro', 'mark'] } : x)), { kind: 'icon', id: 'mark', icon: 'not-an-icon' }]), /"not-an-icon" is not an available icon/]
    ];
    for (const [bad, why] of refused) {
      expect(validateOperation(bad), String(why)).toMatchObject({ ok: true });
      const r = await s.apply({ operations: [bad] }, { label: 'Build' });
      expect(r.ok, String(why)).toBe(false);
      expect(r.error?.message).toMatch(why);
    }
    expect(s.state).toEqual(before);
    expect(s.historyInfo().entries.length).toBe(entries);
    // The engine itself refuses a list item outside its list, naming the operation that built the design...
    const li = withNodes((n) => (node(n, 'footnote').tag = 'li', n));
    expect(() => applyOperations(before, [li, { type: 'page.create', title: 'Later' }])).toThrow(/^Operation 1 \(component\.upsert\): A container is a list item/);
    // ...but not one that a later operation of the batch moved out of place.
    const fine = applyOperations(before, [pricing()]);
    const id = fine.results[0].definitionId as string;
    const extra = pricing({ definitionId: id });
    extra.nodes = [...extra.nodes.map((n) => (n.id === 'root' ? { ...n, children: ['header', 'list', 'footnote', 'facts'] } : n)), { kind: 'element', id: 'facts', tag: 'ul', children: ['fact'] }, { kind: 'element', id: 'fact', tag: 'li', children: [] }];
    expect(() => applyOperations(fine.state, [extra])).not.toThrow();
    const moved = [extra, { type: 'node.move', owner: { kind: 'component', id }, nodeId: 'fact', parentId: 'root', index: 0 }] as EditOperation[];
    expect(() => applyOperations(fine.state, moved)).toThrow(/^A container is a list item/);
  });

  it('rebuilds a placed component, keeping placement values, list items, variant choices and part styles across pages, in one undoable step', async () => {
    const { s, home, other } = await session();
    const made = await s.apply({ operations: [pricing({ insertAs: 'section', parts: { ...pricing().parts, footnote: { nodeId: 'footnote', label: 'Footnote' } } })] }, { label: 'Build' });
    const id = made.results![0].definitionId as string;
    const placed = await s.apply(
      {
        operations: [
          { type: 'node.insert', owner: home, parentId: null, definitionId: id, variants: { tone: 'dark', layout: 'stack' }, props: { heading: 'Our plans', plans: [{ id: 'p1', name: 'Solo', price: '$5' }, { id: 'p2', name: 'Team', price: '$50', featured: true }] } },
          { type: 'node.insert', owner: other, parentId: null, definitionId: id, props: { heading: 'Prices' } }
        ]
      },
      { label: 'Place' }
    );
    expect(made.ok && placed.ok).toBe(true);
    const a = placed.results![0].nodeId as string;
    const b = placed.results![1].nodeId as string;
    await s.apply(
      {
        operations: [
          { type: 'node.setStyle', owner: home, nodeId: a, partId: 'title', scope: 'base', property: 'color', value: { token: 'color.brand' } },
          { type: 'node.setStyle', owner: home, nodeId: a, partId: 'card', itemId: 'p2', scope: 'base', property: 'background', value: { token: 'color.surface-alt' } },
          { type: 'node.setStyle', owner: home, nodeId: a, partId: 'footnote', scope: 'base', property: 'paddingBlock', value: { token: 'space.sm' } },
          { type: 'node.setStyle', owner: other, nodeId: b, partId: 'cta', scope: 'base', property: 'radius', value: { token: 'radius.pill' } },
          { type: 'node.insert', owner: other, parentId: b, slot: 'notes', primitive: 'paragraph', text: 'Prices include tax.' }
        ]
      },
      { label: 'Style' }
    );
    const before = structuredClone(s.state);
    const entries = s.historyInfo().entries.length;

    // The rebuild: the card and heading are new nodes under the same part IDs, plans gain a "note" and lose their
    // button text, a subtitle is new, the footnote part and the "stack" layout are gone.
    const next = pricing({ definitionId: id, name: 'Price list', description: undefined, category: undefined, tags: undefined, icon: undefined, insertAs: null });
    next.properties = {
      heading: { type: 'string', label: 'Title', default: 'Plans' },
      subtitle: { type: 'string', label: 'Subtitle', default: 'Cancel any time.' },
      intro: next.properties.intro,
      level: next.properties.level,
      plans: {
        type: 'list',
        label: 'Plans',
        itemLabel: 'Plan',
        fields: {
          name: { type: 'string', label: 'Name', default: 'Plan' },
          price: { type: 'string', label: 'Price', default: '$0' },
          featured: { type: 'boolean', label: 'Featured', default: false },
          cta: { type: 'link', label: 'Button link', default: { type: 'none', target: '' } },
          note: { type: 'string', label: 'Note', default: '' }
        },
        default: [{ id: 'only', name: 'Only plan', price: '$1' }]
      }
    };
    next.nodes = next.nodes
      .filter((n) => !['title', 'card', 'cta'].includes(n.id))
      .map((n) => (n.id === 'header' ? { ...n, children: ['heading2', 'subtitle', 'intro'] } : n.id === 'plans' ? { ...n, children: ['tile'] } : n));
    next.nodes.push(
      { kind: 'text', id: 'heading2', tag: 'h2', text: { $prop: 'heading' } },
      { kind: 'text', id: 'subtitle', tag: 'p', text: { $prop: 'subtitle' } },
      { kind: 'element', id: 'tile', tag: 'li', children: ['badge', 'name', 'price', 'note', 'button'] },
      { kind: 'text', id: 'note', tag: 'p', text: { $item: 'note' }, when: { $item: 'note' } },
      { kind: 'link', id: 'button', link: { $item: 'cta' }, label: 'Choose' }
    );
    next.parts = { card: { nodeId: 'tile', label: 'Plan card' }, title: { nodeId: 'heading2', label: 'Heading' }, cta: { nodeId: 'button', label: 'Button' } };
    next.variantAxes = { tone: next.variantAxes!.tone, layout: { label: 'Layout', options: { grid: { label: 'Grid' } } } };
    const r = await s.apply({ operations: [next] }, { label: 'Rebuild Pricing table' });
    expect(r.error).toBeUndefined();
    expect(r.results![0]).toEqual({ definitionId: id, rootNodeId: 'root' });

    const def = s.state.components[id];
    // The same component, renamed, with what the description left out kept.
    expect(def).toMatchObject({ id, componentId: before.components[id].componentId, name: 'Price list', description: 'Plans side by side.', category: 'conversion', icon: 'tag' });
    expect(before.components[id].insertAs).toBe('section');
    expect(def.insertAs).toBeUndefined();
    expect(def.tree!.nodes.title).toBeUndefined();
    expect(def.parts.footnote).toBeUndefined();
    expect(Object.keys(def.variantAxes!.layout.options)).toEqual(['grid']);

    const pa = s.state.pages[home.id].nodes[a] as InstanceNode;
    const pb = s.state.pages[other.id].nodes[b] as InstanceNode;
    // Values the new schema still has stay; a new property shows its default; list items keep their IDs and fields.
    expect(pa.props.heading).toBe('Our plans');
    expect(pa.props.subtitle).toBeUndefined();
    expect(def.properties.subtitle.default).toBe('Cancel any time.');
    // A part on another element offers what that element's kind takes.
    expect(def.parts.title).toEqual({ nodeId: 'heading2', label: 'Heading', styleControls: styleSetFor({ kind: 'text' }) });
    expect(pb.props.heading).toBe('Prices');
    expect(pa.props.plans).toEqual([
      { id: 'p1', name: 'Solo', price: '$5', featured: false, cta: { type: 'none', target: '' }, note: '' },
      { id: 'p2', name: 'Team', price: '$50', featured: true, cta: { type: 'none', target: '' }, note: '' }
    ]);
    expect((pb.props.plans as ListItem[]).map((p) => [p.name, p.note])).toEqual([['Basic', ''], ['Pro', '']]);
    // The tone choice stays; the layout option that is gone falls back to the default.
    expect(pa.variants).toEqual({ tone: 'dark' });
    // Styles on parts that are still there follow them to their new elements; a removed part's styles go.
    expect(pa.overrides).toEqual({ title: { base: { color: { token: 'color.brand' } } } });
    expect(pa.itemOverrides).toEqual({ card: { list: 'plans', items: { p2: { base: { background: { token: 'color.surface-alt' } } } } } });
    expect(pb.overrides).toEqual({ cta: { base: { radius: { token: 'radius.pill' } } } });
    // Slot content stays where it was put.
    expect(pb.slots!.notes).toEqual(before.pages[other.id].nodes[b].kind === 'instance' ? (before.pages[other.id].nodes[b] as InstanceNode).slots!.notes : []);

    expect(errors(s.state)).toEqual([]);
    compiles(s.state, id);

    expect(s.historyInfo().entries.length).toBe(entries + 1);
    const rebuilt = structuredClone(s.state);
    await s.undo();
    expect(s.state.components).toEqual(before.components);
    expect(s.state.pages).toEqual(before.pages);
    await s.redo();
    expect(s.state.components).toEqual(rebuilt.components);
    expect(s.state.pages).toEqual(rebuilt.pages);
  });

  it('drops single-item styles whose part no longer repeats over the same list, or whose item is gone', () => {
    let st = createStarterState('blank', 'Expo', false);
    const home = { kind: 'page' as const, id: st.site.homePageId };
    const made = applyOperations(st, [pricing()]);
    const id = made.results[0].definitionId as string;
    st = made.state;
    const placed = applyOperations(st, [{ type: 'node.insert', owner: home, parentId: null, definitionId: id, props: { plans: [{ id: 'x1', name: 'One' }] } }]);
    const nodeId = placed.results[0].nodeId as string;
    st = applyOperations(placed.state, [
      { type: 'node.setStyle', owner: home, nodeId, partId: 'card', itemId: 'x1', scope: 'base', property: 'background', value: { token: 'color.surface-alt' } },
      { type: 'node.setStyle', owner: home, nodeId, partId: 'card', scope: 'base', property: 'radius', value: { token: 'radius.md' } }
    ]).state;
    expect((st.pages[home.id].nodes[nodeId] as InstanceNode).itemOverrides).toEqual({ card: { list: 'plans', items: { x1: { base: { background: { token: 'color.surface-alt' } } } } } });
    // The card now repeats over "offers": the styles set for one plan are no item's of that list.
    const next = pricing({ definitionId: id });
    next.properties = { ...next.properties, offers: next.properties.plans };
    next.nodes = next.nodes.map((n) => (n.id === 'plans' ? { ...n, list: 'offers' } : n));
    const after = applyOperations(st, [next]).state;
    const inst = after.pages[home.id].nodes[nodeId] as InstanceNode;
    expect(inst.itemOverrides).toBeUndefined();
    expect(inst.overrides).toEqual({ card: { base: { radius: { token: 'radius.md' } } } });
    expect((inst.props.offers as ListItem[]).length).toBe(2);

    // A part kept on the same element keeps the controls it offered.
    const same = applyOperations(st, [pricing({ definitionId: id, parts: { ...pricing().parts, title: { nodeId: 'title', label: 'Heading' } } })]).state;
    expect(same.components[id].parts.title.styleControls).toEqual(['textStyle', 'color']);

    // A placement showing the default plans (saved before placements had their own): the styles of a default plan go
    // when the new defaults leave it out, and stay while they keep it.
    const older = structuredClone(st);
    delete (older.pages[home.id].nodes[nodeId] as InstanceNode).props.plans;
    const styled = applyOperations(older, [{ type: 'node.setStyle', owner: home, nodeId, partId: 'card', itemId: 'pro', scope: 'base', property: 'background', value: { token: 'color.surface-alt' } }]).state;
    const fewer = pricing({ definitionId: id });
    (fewer.properties.plans as { default: unknown[] }).default = [{ id: 'basic', name: 'Basic', price: '$9' }];
    expect((applyOperations(styled, [fewer]).state.pages[home.id].nodes[nodeId] as InstanceNode).itemOverrides).toBeUndefined();
    expect((applyOperations(styled, [pricing({ definitionId: id })]).state.pages[home.id].nodes[nodeId] as InstanceNode).itemOverrides?.card.items.pro).toBeDefined();
  });

  it('refuses a rebuild a placement anywhere cannot take, leaving every page as it was', async () => {
    const { s, home, other } = await session();
    const made = await s.apply({ operations: [pricing()] }, { label: 'Build' });
    const id = made.results![0].definitionId as string;
    await s.apply(
      {
        operations: [
          { type: 'node.insert', owner: home, parentId: null, definitionId: id, props: { heading: 'Kept' } },
          { type: 'node.insert', owner: other, parentId: null, definitionId: id, props: { plans: [{ id: 'q1', name: 'Gold', price: 'free' }] } }
        ]
      },
      { label: 'Place' }
    );
    const placedOther = Object.values(s.state.pages[other.id].nodes).find((n) => n.kind === 'instance' && n.definitionId === id) as InstanceNode;
    expect((await s.apply({ operations: [{ type: 'node.insert', owner: other, parentId: placedOther.id, slot: 'notes', primitive: 'paragraph', text: 'Small print.' }] }, { label: 'Note' })).ok).toBe(true);
    const before = structuredClone(s.state);
    const entries = s.historyInfo().entries.length;

    const rebuild = (f: (op: Upsert) => void) => {
      const op = pricing({ definitionId: id });
      f(op);
      return op;
    };
    const cases: Array<[Upsert, RegExp]> = [
      // A price that is no longer one of the choices on the other page, though the new defaults are.
      [
        rebuild((op) => {
          const plans = op.properties.plans as { fields: Record<string, unknown>; default: Array<Record<string, unknown>> };
          plans.fields.price = { type: 'enum', label: 'Price', default: 'low', options: [{ value: '$9', label: 'Low' }, { value: '$29', label: 'High' }, { value: 'low', label: 'Lowest' }] };
          op.nodes = op.nodes.map((n) => (n.id === 'price' ? { ...n, unless: undefined } : n));
        }),
        /^Pricing: .*Price: must be one of \$9, \$29, low\. Change that content first/
      ],
      // The notes slot holds content on the other page.
      [rebuild((op) => ((op.slots = undefined), (op.nodes = op.nodes.filter((n) => n.id !== 'notes').map((n) => (n.id === 'footnote' ? { ...n, children: [] } : n))))), /"Notes" slot has content/],
      // Or it would take no text any more.
      [rebuild((op) => (op.slots = { notes: { label: 'Notes', primitives: ['link'] } })), /already holds .*which it would no longer take/],
      // Or it would only show inside a list of offers, which no placement has.
      [
        rebuild((op) => {
          op.properties = { ...op.properties, offers: { type: 'list', label: 'Offers', itemLabel: 'Offer', fields: { name: { type: 'string', label: 'Name', default: '' } }, default: [] } };
          op.nodes = [
            ...op.nodes.map((n) => (n.id === 'footnote' ? { ...n, children: ['offers'] } : n)),
            { kind: 'repeat', id: 'offers', list: 'offers', children: ['offer'] },
            { kind: 'element', id: 'offer', children: ['notes'] }
          ];
        }),
        /would no longer show the content in its "notes" slot/
      ]
    ];
    for (const [op, why] of cases) {
      const r = await s.apply({ operations: [op] }, { label: 'Rebuild' });
      expect(r.ok, String(why)).toBe(false);
      expect(r.error?.message).toMatch(why);
      expect(s.state).toEqual(before);
    }
    expect(s.historyInfo().entries.length).toBe(entries);
  });

  it('refuses a rebuild that a component placing this one cannot keep passing its property to', () => {
    let st = createStarterState('blank', 'Expo', false);
    const inner = applyOperations(st, [pricing()]);
    const id = inner.results[0].definitionId as string;
    st = inner.state;
    const outer = applyOperations(st, [{ type: 'component.create', name: 'Wrapper' }]);
    const { definitionId: wrapper, rootNodeId } = outer.results[0] as { definitionId: string; rootNodeId: string };
    const owner = { kind: 'component' as const, id: wrapper };
    st = outer.state;
    const placed = applyOperations(st, [{ type: 'node.insert', owner, parentId: rootNodeId, definitionId: id }]);
    const nodeId = placed.results[0].nodeId as string;
    st = applyOperations(placed.state, [
      { type: 'component.setPropSchema', definitionId: wrapper, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Plans' } },
      { type: 'node.setBinding', owner, nodeId, field: 'prop', prop: 'heading', binding: { $prop: 'title' } }
    ]).state;
    const retyped = pricing({ definitionId: id });
    retyped.properties = { ...retyped.properties, heading: { type: 'boolean', label: 'Heading', default: true } };
    retyped.nodes = retyped.nodes.map((n) => (n.id === 'title' ? { ...n, text: 'Plans' } : n));
    expect(() => applyOperations(st, [retyped])).toThrow(/"Wrapper" passes its string property to "heading"/);
  });

  it('rebuilds only managed designs of the project that it can describe whole', () => {
    const st = createStarterState('blank', 'Expo', false);
    const theme = Object.values(st.components).find((d) => d.owner === 'theme' && d.kind === 'managed')!;
    expect(() => applyOperations(st, [pricing({ definitionId: theme.id })])).toThrow(/belongs to the theme/);
    expect(() => applyOperations(st, [pricing({ definitionId: 'proj.nothing-abcde' })])).toThrow(/does not exist/);
    const code = applyOperations(st, [{ type: 'component.createCode', name: 'Code', source: '<p>Hi</p>' }]);
    expect(() => applyOperations(code.state, [pricing({ definitionId: code.results[0].definitionId as string })])).toThrow(/is a code component/);
    // A design that places another component can be rebuilt whole (#1146).
    const made = applyOperations(st, [{ type: 'component.create', name: 'Holder' }]);
    const { definitionId, rootNodeId } = made.results[0] as { definitionId: string; rootNodeId: string };
    const nested = applyOperations(made.state, [{ type: 'node.insert', owner: { kind: 'component', id: definitionId }, parentId: rootNodeId, componentId: 'content.text' }]).state;
    expect(Object.values(nested.components[definitionId].tree!.nodes).some((n) => n.kind === 'instance')).toBe(true);
    expect(applyOperations(nested, [pricing({ definitionId })]).state.components[definitionId].tree!.nodes.root.kind).toBe('element');
    expect(() => applyOperations(st, [pricing({ definitionId, newDefinitionId: projectDefinitionId('X') })])).toThrow(/not both/);
    // A design whose buttons change its UI state, or whose elements read it.
    const own = applyOperations(st, [pricing()]);
    const ownId = own.results[0].definitionId as string;
    // A managed design of the shared header or footer.
    const shell = structuredClone(own.state);
    shell.components[ownId].category = 'shell';
    expect(() => applyOperations(shell, [pricing({ definitionId: ownId })])).toThrow(/shared header or footer/);
    const withState = applyOperations(own.state, [
      { type: 'component.setState', definitionId: ownId, state: 'open', schema: { type: 'boolean' } },
      { type: 'node.setBinding', owner: { kind: 'component', id: ownId }, nodeId: 'intro', field: 'when', binding: { $state: 'open' } }
    ]).state;
    expect(() => applyOperations(withState, [pricing({ definitionId: ownId })])).toThrow(/UI state its design reads or its buttons change \(open\)/);
    // Declared but unused, the state stays as it is.
    const declared = applyOperations(own.state, [{ type: 'component.setState', definitionId: ownId, state: 'open', schema: { type: 'boolean' } }]).state;
    expect(applyOperations(declared, [pricing({ definitionId: ownId })]).state.components[ownId].state).toEqual(declared.components[ownId].state);
  });

  it('describes UI state, the buttons that change it, the content it shows and a drawer it opens, checked as the finished component (#377)', () => {
    const st = createStarterState('blank', 'Expo', false);
    const tabs = (extra: Partial<Upsert> = {}): Upsert => ({
      type: 'component.upsert',
      name: 'Plan switch',
      properties: {},
      state: { plan: { type: 'enum', label: 'Plan', options: ['monthly', { value: 'annual', label: 'Annual' }] }, open: { type: 'boolean' } },
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['tabs', 'annual', 'more', 'drawer'] },
        { kind: 'element', id: 'tabs', children: ['monthlyTab', 'annualTab'] },
        { kind: 'link', id: 'monthlyTab', link: { type: 'none', target: '' }, label: 'Monthly', stateAction: { state: 'plan', op: 'set', value: 'monthly' } },
        { kind: 'link', id: 'annualTab', link: { type: 'none', target: '' }, label: 'Annual', stateAction: { state: 'plan', op: 'set', value: 'annual' } },
        { kind: 'text', id: 'annual', text: 'Billed yearly', when: { ref: { $state: 'plan' }, eq: 'annual' } },
        { kind: 'link', id: 'more', link: { type: 'none', target: '' }, label: 'More', stateAction: { state: 'open', op: 'toggle' } },
        { kind: 'element', id: 'drawer', overlay: 'drawer-bottom', children: ['terms'], when: { $state: 'open' } },
        { kind: 'text', id: 'terms', text: 'Terms' }
      ],
      ...extra
    });
    expect(validateOperation(tabs()).ok).toBe(true);
    const made = applyOperations(st, [tabs()]);
    const id = made.results[0].definitionId as string;
    const def = made.state.components[id];
    // Settled as component.setState settles one: a label from the name, an option's label from its value, the first option to start.
    expect(def.state).toEqual({ plan: { type: 'enum', label: 'Plan', options: [{ value: 'monthly', label: 'monthly' }, { value: 'annual', label: 'Annual' }], initial: 'monthly' }, open: { type: 'boolean', label: 'open', initial: false } });
    expect(def.tree!.nodes.annualTab).toMatchObject({ stateAction: { state: 'plan', op: 'set', value: 'annual' } });
    expect(def.tree!.nodes.drawer).toMatchObject({ overlay: 'drawer-bottom' });
    expect(validateState(made.state).filter((d) => d.severity === 'error')).toEqual([]);
    const node = (nid: string, patch: Record<string, unknown>) => tabs({ nodes: tabs().nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n)) as Upsert['nodes'] });
    expect(() => applyOperations(st, [node('annual', { when: { ref: { $state: 'period' }, eq: 'annual' } })])).toThrow(/"annual" reads the UI state "period", which the component does not declare/);
    expect(() => applyOperations(st, [node('annualTab', { stateAction: { state: 'plan', op: 'set', value: 'yearly' } })])).toThrow(/"annualTab" sets "plan" to "yearly", which is not one of its options/);
    expect(() => applyOperations(st, [node('more', { stateAction: { state: 'open', op: 'next' } })])).toThrow(/steps the yes\/no state "open"/);
    expect(() => applyOperations(st, [node('drawer', { when: undefined })])).toThrow(/"drawer" is a dialog or drawer that no yes\/no UI state of the component opens/);
    expect(() => applyOperations(st, [tabs({ properties: { open: { type: 'boolean', label: 'Open' } } })])).toThrow(/already has a property "open"/);
    expect(() => applyOperations(st, [tabs({ state: { plan: { type: 'enum', options: ['only'] } } })])).toThrow(/a choice needs 2 to 50 options/);
    // A rebuild replaces it whole: a new option, and {} with a design that no longer uses any.
    const rebuilt = applyOperations(made.state, [tabs({ definitionId: id, state: { plan: { type: 'enum', label: 'Plan', options: ['monthly', 'annual', 'lifetime'], initial: 'annual' }, open: { type: 'boolean' } } })]).state;
    expect(rebuilt.components[id].state!.plan).toMatchObject({ initial: 'annual', options: [{ value: 'monthly' }, { value: 'annual' }, { value: 'lifetime' }] });
    const plain = applyOperations(rebuilt, [{ type: 'component.upsert', definitionId: id, name: 'Plan switch', properties: {}, nodes: [{ kind: 'element', id: 'root', children: [] }], state: {} }]).state;
    expect(plain.components[id].state).toBeUndefined();
    // Left out, the state of a design that uses it is refused rather than dropped unseen.
    expect(() => applyOperations(rebuilt, [{ type: 'component.upsert', definitionId: id, name: 'Plan switch', properties: {}, nodes: [{ kind: 'element', id: 'root', children: [] }] }])).toThrow(/\(plan, open\)\. Describe it again with state/);
    // At most 20 variables, as component.setState allows.
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { type: 'boolean' as const }]));
    expect(() => applyOperations(st, [tabs({ state: { ...many(18), ...tabs().state } })])).not.toThrow();
    expect(() => applyOperations(st, [tabs({ state: { ...many(19), ...tabs().state } })])).toThrow(/at most 20 UI state variables/);
  });

  it('keeps unused state a rebuild leaves out: checked against the new properties, refused where a hand edit damaged it, kept as it is when the map itself is damaged (#377)', () => {
    const st = createStarterState('blank', 'Expo', false);
    const plain = (extra: Partial<Upsert> = {}): Upsert => ({ type: 'component.upsert', name: 'Toggle', properties: {}, nodes: [{ kind: 'element', id: 'root', children: ['more'] }, { kind: 'link', id: 'more', link: { type: 'none', target: '' }, label: 'More' }], ...extra });
    const made = applyOperations(st, [plain({ state: { open: { type: 'boolean', label: 'Open' } } })]);
    const id = made.results[0].definitionId as string;
    const toggling = (extra: Partial<Upsert> = {}) => plain({ definitionId: id, nodes: [{ kind: 'element', id: 'root', children: ['more'] }, { kind: 'link', id: 'more', link: { type: 'none', target: '' }, label: 'More', stateAction: { state: 'open', op: 'toggle' } }], ...extra });
    // Kept, and the rebuilt design may use it again.
    expect(applyOperations(made.state, [toggling()]).state.components[id].state).toEqual({ open: { type: 'boolean', label: 'Open', initial: false } });
    // A new property under its name is refused, rather than leaving two things called "open".
    expect(() => applyOperations(made.state, [plain({ definitionId: id, properties: { open: { type: 'boolean', label: 'Open' } } })])).toThrow(/"open" is both a new property and UI state/);
    // A declaration a hand edit damaged is kept for validation to report, but nothing new may use it.
    const damaged = structuredClone(made.state);
    (damaged.components[id].state!.open as { initial: unknown }).initial = 'yes';
    expect(() => applyOperations(damaged, [toggling()])).toThrow(/"more" changes the UI state "open", which is damaged/);
    expect(applyOperations(damaged, [plain({ definitionId: id })]).state.components[id].state).toEqual(damaged.components[id].state);
    const nulled = structuredClone(made.state);
    (nulled.components[id] as { state: unknown }).state = null;
    expect((applyOperations(nulled, [plain({ definitionId: id })]).state.components[id] as { state: unknown }).state).toBeNull();
  });

  it('is never offered to the assistant as a raw operation, and is refused if sent anyway', async () => {
    const offered = JSON.stringify(toolDefinitions({ codeEnabled: true, definitionOps: true }).find((t) => t.name === 'apply_operations')!.parameters);
    expect(offered).toContain('component.create');
    expect(offered).not.toContain('component.upsert');
    expect(OP_REACH['component.upsert']).toBe('wider');
    const s = createStarterState('blank', 'Expo', false);
    let applied = 0;
    const host = { state: () => s, revision: () => 1, diagnostics: () => validateState(s), apply: async () => ((applied += 1), { ok: true, revision: 2, results: [] }) } as unknown as Parameters<typeof executeTool>[2];
    const out = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 1, operations: [pricing()] }), host, 'c1');
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.content)).toMatch(/component.upsert is not available here/);
    expect(applied).toBe(0);
  });

  it('keeps list and object field content through a lossless type change, and refuses one that would empty it', () => {
    let st = createStarterState('blank', 'Expo', false);
    const home = { kind: 'page' as const, id: st.site.homePageId };
    const made = applyOperations(st, [pricing()]);
    const id = made.results[0].definitionId as string;
    const placed = applyOperations(made.state, [
      { type: 'node.insert', owner: home, parentId: null, definitionId: id, props: { plans: [{ id: 'a', name: 'Solo', cta: { type: 'url', target: 'https://example.org/solo' } }, { id: 'b', name: 'Team' }] } }
    ]);
    st = placed.state;
    const nodeId = placed.results[0].nodeId as string;
    const retype = (field: string, schema: Record<string, unknown>) => {
      const op = pricing({ definitionId: id });
      const plans = op.properties.plans as { fields: Record<string, unknown>; default: Array<Record<string, unknown>> };
      plans.fields[field] = schema;
      for (const d of plans.default) delete d[field];
      if (field === 'cta') op.nodes = op.nodes.map((n) => (n.id === 'cta' ? { ...n, link: { type: 'none', target: '' } } : n));
      if (field === 'name') op.nodes = op.nodes.map((n) => (n.id === 'name' ? { ...n, rich: true, tag: undefined } : n));
      return op;
    };
    // Plain text to rich text keeps every word.
    const rich = applyOperations(st, [retype('name', { type: 'richtext', label: 'Name', default: ['Plan'] })]).state;
    const items = (rich.pages[home.id].nodes[nodeId] as InstanceNode).props.plans as ListItem[];
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(items[0].name)).toMatch(/Solo/);
    // A link that becomes an image would lose its destination; an item still at the old default just starts over.
    expect(() => applyOperations(st, [retype('cta', { type: 'image', label: 'Picture', default: { assetId: null, alt: '' } })])).toThrow(/"Button link" in "Plans" holds content that a image field cannot keep/);
    const fresh = applyOperations(made.state, [{ type: 'node.insert', owner: home, parentId: null, definitionId: id }]);
    const pictured = applyOperations(fresh.state, [retype('cta', { type: 'image', label: 'Picture', default: { assetId: null, alt: '' } })]).state;
    for (const it of (pictured.pages[home.id].nodes[fresh.results[0].nodeId as string] as InstanceNode).props.plans as ListItem[]) expect(it.cta).toEqual({ assetId: null, alt: '' });
    // An object's placements start from the object's own default: a value equal only to the field's default was set.
    const withAction = pricing();
    withAction.properties = { ...withAction.properties, action: { type: 'object', label: 'Action', fields: { target: { type: 'link', label: 'Target', default: { type: 'url', target: 'https://a.example' } } }, default: { target: { type: 'url', target: 'https://b.example' } } } };
    const built = applyOperations(createStarterState('blank', 'Expo', false), [withAction]);
    const actionId = built.results[0].definitionId as string;
    const homeId = built.state.site.homePageId;
    const two = applyOperations(built.state, [
      { type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, definitionId: actionId },
      { type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, definitionId: actionId, props: { action: { target: { type: 'url', target: 'https://a.example' } } } }
    ]);
    const pictureAction = { ...withAction, definitionId: actionId, properties: { ...withAction.properties, action: { type: 'object', label: 'Action', fields: { target: { type: 'image', label: 'Target', default: { assetId: null, alt: '' } } } } } };
    expect(() => applyOperations(two.state, [pictureAction])).toThrow(/"Target" in "Action" holds content that a image field cannot keep/);
    const untouched = applyOperations(built.state, [{ type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, definitionId: actionId }]);
    expect((applyOperations(untouched.state, [pictureAction]).state.pages[homeId].nodes[untouched.results[0].nodeId as string] as InstanceNode).props.action).toEqual({ target: { assetId: null, alt: '' } });
  });

  it('refuses a rebuild that hides a filled slot a placement shows now, judged by its values before they move', () => {
    let st = createStarterState('blank', 'Expo', false);
    const home = { kind: 'page' as const, id: st.site.homePageId };
    const rowsOf = (name: string) => ({ type: 'list', label: name, itemLabel: 'Row', fields: { text: { type: 'string', label: 'Text', default: '' } }, default: [] });
    const inRows = (list: string) => {
      const op = pricing();
      op.properties = { ...op.properties, [list]: rowsOf(list) };
      op.nodes = [
        ...op.nodes.map((n) => (n.id === 'footnote' ? { ...n, children: ['rows'] } : n)),
        { kind: 'repeat', id: 'rows', list, children: ['row'] },
        { kind: 'element', id: 'row', children: ['notes'] }
      ];
      return op;
    };
    const made = applyOperations(st, [inRows('oldRows')]);
    const id = made.results[0].definitionId as string;
    const placed = applyOperations(made.state, [{ type: 'node.insert', owner: home, parentId: null, definitionId: id, props: { oldRows: [{ id: 'r1', text: 'One' }] } }]);
    const nodeId = placed.results[0].nodeId as string;
    st = applyOperations(placed.state, [{ type: 'node.insert', owner: home, parentId: nodeId, slot: 'notes', primitive: 'paragraph', text: 'Small print.' }]).state;
    expect(() => applyOperations(st, [{ ...inRows('newRows'), definitionId: id }])).toThrow(/would no longer show the content in its "notes" slot/);
    // Under the list it already shows, it stays.
    expect(() => applyOperations(st, [{ ...inRows('oldRows'), definitionId: id }])).not.toThrow();
  });

  it('waits for an outside edit to a page the rebuild only reads', async () => {
    const { s, other } = await session();
    const made = await s.apply({ operations: [pricing()] }, { label: 'Build' });
    const id = made.results![0].definitionId as string;
    expect((await s.apply({ operations: [{ type: 'node.insert', owner: other, parentId: null, definitionId: id }] }, { label: 'Place' })).ok).toBe(true);
    const file = `siteorigin/pages/${other.id}.json`;
    const path = join(dirs.at(-1)!, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"Pricing"', '"Pricing (edited)"'));
    // Only the heading text changes, so the rebuild writes no page; it still read them all.
    const next = pricing({ definitionId: id });
    next.properties = { ...next.properties, heading: { type: 'string', label: 'Heading', default: 'Our plans' } };
    const r = await s.apply({ operations: [next] }, { label: 'Rebuild' });
    expect(r.error).toMatchObject({ code: 'CONFLICT' });
    expect(r.error!.message).toMatch(new RegExp(`^${file} was changed outside SiteOrigin Builder`));
  });

  it('checks what components placing this one pass it, and leaves their own UI state reads alone', () => {
    let st = createStarterState('blank', 'Expo', false);
    const base = pricing();
    base.properties = {
      ...base.properties,
      cta: { type: 'object', label: 'Call to action', fields: { label: { type: 'string', label: 'Label', default: 'Go' }, link: { type: 'link', label: 'Link', default: { type: 'none', target: '' } } } },
      extras: { type: 'list', label: 'Extras', itemLabel: 'Extra', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] }
    };
    const inner = applyOperations(st, [base]);
    const id = inner.results[0].definitionId as string;
    const outer = applyOperations(inner.state, [{ type: 'component.create', name: 'Wrapper' }]);
    const { definitionId: wrapper, rootNodeId } = outer.results[0] as { definitionId: string; rootNodeId: string };
    const owner = { kind: 'component' as const, id: wrapper };
    const placed = applyOperations(outer.state, [{ type: 'node.insert', owner, parentId: rootNodeId, definitionId: id }]);
    const nodeId = placed.results[0].nodeId as string;
    st = applyOperations(placed.state, [
      { type: 'component.setPropSchema', definitionId: wrapper, prop: 'action', schema: base.properties.cta as Record<string, unknown> },
      { type: 'component.setPropSchema', definitionId: wrapper, prop: 'rows', schema: base.properties.extras as Record<string, unknown> },
      { type: 'node.setBinding', owner, nodeId, field: 'prop', prop: 'cta', binding: { $prop: 'action' } },
      { type: 'node.setBinding', owner, nodeId, field: 'prop', prop: 'extras', binding: { $prop: 'rows' } },
      { type: 'component.setState', definitionId: wrapper, state: 'open', schema: { type: 'boolean' } },
      { type: 'node.setBinding', owner, nodeId, field: 'when', binding: { $state: 'open' } }
    ]).state;
    // Rebuilt as it is, it goes through: the wrapper's own UI state read is the wrapper's.
    expect(() => applyOperations(st, [{ ...base, definitionId: id }])).not.toThrow();
    // An object whose fields change no longer takes what the wrapper passes it.
    const reshaped = { ...base, definitionId: id, properties: { ...base.properties, cta: { ...(base.properties.cta as object), fields: { label: { type: 'string', label: 'Label', default: 'Go' } } } } };
    expect(() => applyOperations(st, [reshaped])).toThrow(/"Wrapper" places "Pricing table" as .*whose fields differ/);
    // A list that now fills itself from the site's pages takes nothing passed to it.
    // A list passed on whole must keep the kind of value of each field the two lists share.
    const pictured = { ...base, definitionId: id, properties: { ...base.properties, extras: { type: 'list', label: 'Extras', itemLabel: 'Extra', fields: { title: { type: 'number', label: 'Title', default: 0 } }, default: [] } } };
    expect(() => applyOperations(st, [pictured])).toThrow(/"Wrapper" places "Pricing table" as .*whose "title" takes a number, not a string/);
    const fed = { ...base, definitionId: id, properties: { ...base.properties, extras: { type: 'list', label: 'Extras', itemLabel: 'Extra', feed: 'articles', fields: { title: { type: 'string', label: 'Title', default: '' } } } } };
    expect(() => applyOperations(st, [fed])).toThrow(/fills itself from the site's pages and cannot take a property/);
  });

  it('forgets an option saved under an ID no variant can have', () => {
    const st = createStarterState('blank', 'Expo', false);
    const home = { kind: 'page' as const, id: st.site.homePageId };
    const made = applyOperations(st, [pricing()]);
    const id = made.results[0].definitionId as string;
    const placed = applyOperations(made.state, [{ type: 'node.insert', owner: home, parentId: null, definitionId: id }]);
    const legacy = structuredClone(placed.state);
    legacy.components[id].variantAxes!.tone.options['old option'] = { label: 'Old' };
    (legacy.pages[home.id].nodes[placed.results[0].nodeId as string] as InstanceNode).variants = { tone: 'old option' };
    const after = applyOperations(legacy, [pricing({ definitionId: id })]).state;
    expect(Object.keys(after.components[id].variantAxes!.tone.options)).toEqual(['light', 'dark']);
    expect((after.pages[home.id].nodes[placed.results[0].nodeId as string] as InstanceNode).variants).toBeUndefined();
  });

  it('keeps a button label, link and the text kinds as the single-step edits store them', () => {
    const st = createStarterState('blank', 'Expo', false);
    const home = st.site.homePageId;
    const op = pricing({
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['when', 'body', 'go', 'mark', 'line', 'pic'], link: { type: 'none', target: '' } },
        { kind: 'text', id: 'when', tag: 'p', text: 'Opening', datetime: '2026-03-01' },
        { kind: 'text', id: 'body', rich: true, text: ['First **bold** line', '- a point'] },
        { kind: 'link', id: 'go', link: { type: 'page', target: home }, label: 'Visit', icon: 'arrow-right', iconPosition: 'end' },
        { kind: 'icon', id: 'mark', icon: 'sparkles', ariaLabel: 'Sparkle' },
        { kind: 'divider', id: 'line', anchor: 'rule' },
        { kind: 'image', id: 'pic', image: { assetId: null, alt: '' }, fallbackAlt: 'A photo' }
      ],
      parts: {},
      slots: undefined,
      variantAxes: undefined
    });
    const after = applyOperations(st, [op]);
    const def = after.state.components[after.results[0].definitionId as string];
    const n = def.tree!.nodes;
    // A container with no destination is not a card.
    expect((n.root as ElementNode).link).toBeUndefined();
    expect(n.when).toMatchObject({ datetime: '2026-03-01' });
    expect((n.body as TextNode).rich).toBe(true);
    expect(Array.isArray((n.body as TextNode).text)).toBe(true);
    expect(n.go as LinkNode).toMatchObject({ link: { type: 'page', target: home }, label: 'Visit', appearance: 'primary', icon: 'arrow-right', iconPosition: 'end' });
    expect(n.line).toMatchObject({ anchor: 'rule' });
    expect(n.mark).toMatchObject({ kind: 'icon', icon: 'sparkles', ariaLabel: 'Sparkle' });
    expect(n.pic).toMatchObject({ kind: 'image', image: { assetId: null, alt: '' }, fallbackAlt: 'A photo' });
    expect((n.body as TextNode).text).toHaveLength(2);
    expect(JSON.stringify((n.body as TextNode).text)).toMatch(/bold/);
    expect(errors(after.state)).toEqual([]);
    compiles(after.state, def.id);
  });
});

describe('component.upsert: components placed in a design (#1146)', () => {
  /** A design of one root holding the placements given, each by node ID and definition. */
  const holder = (name: string, placed: Record<string, string>, extra: Partial<Upsert> = {}): Upsert => ({
    type: 'component.upsert',
    name,
    properties: {},
    nodes: [{ kind: 'element', id: 'root', children: Object.keys(placed) }, ...Object.entries(placed).map(([id, definitionId]) => ({ kind: 'instance' as const, id, definitionId }))],
    ...extra
  });
  const made = (st: ProjectState, op: Upsert) => {
    const r = applyOperations(st, [op]);
    return { state: r.state, id: r.results[0].definitionId as string };
  };

  it('places installed components, theme and project alike, with their values and options checked as node.insert checks them', () => {
    const blank = createStarterState('blank', 'Expo', false);
    // A theme component installed by placing it on a page.
    const st = applyOperations(blank, [{ type: 'node.insert', owner: { kind: 'page', id: blank.site.homePageId }, parentId: null, componentId: 'content.text' }]).state;
    const theme = Object.values(st.components).find((d) => d.componentId === 'content.text')!;
    const [prop] = Object.entries(theme.properties).find(([, p]) => p.type === 'string')!;
    const a = made(st, holder('A', { t: theme.id }, { nodes: [{ kind: 'element', id: 'root', children: ['t'] }, { kind: 'instance', id: 't', definitionId: theme.id, props: { [prop]: 'Hello' } }] }));
    const node = a.state.components[a.id].tree!.nodes.t as InstanceNode;
    expect(node).toMatchObject({ kind: 'instance', definitionId: theme.id, props: { [prop]: 'Hello' } });
    // A placement as the root of the design, as a component made from a placement has.
    const b = made(a.state, { type: 'component.upsert', name: 'B', properties: {}, nodes: [{ kind: 'instance', id: 'root', definitionId: a.id }] });
    expect(b.state.components[b.id].tree!.rootIds).toEqual(['root']);
    expect(validateState(b.state).filter((d) => d.severity === 'error')).toEqual([]);
    expect(() => applyOperations(a.state, [holder('C', { x: a.id }, { nodes: [{ kind: 'element', id: 'root', children: ['x'] }, { kind: 'instance', id: 'x', definitionId: a.id, props: { nope: 1 } }] })])).toThrow(/has no property "nope"/);
    expect(() => applyOperations(a.state, [holder('C', { x: theme.id }, { nodes: [{ kind: 'element', id: 'root', children: ['x'] }, { kind: 'instance', id: 'x', definitionId: theme.id, variants: { nope: 'x' } }] })])).toThrow(/no variant axis "nope"/);
    expect(() => applyOperations(a.state, [holder('C', { x: 'proj.nothing-abcde' })])).toThrow(/not an installed component/);
    const shell = Object.values(st.components).find((d) => d.category === 'shell')!;
    expect(() => applyOperations(a.state, [holder('C', { x: shell.id })])).toThrow(/header and footer/);
    expect(() => applyOperations(a.state, [holder('C', { x: a.id }, { nodes: [{ kind: 'element', id: 'root', children: ['x'] }, { kind: 'instance', id: 'x', definitionId: a.id, anchor: 'here' }] })])).toThrow(/anchors can be set on/);
    // A code component places the design's classes and anchor only where its source says: never the root.
    const code = applyOperations(a.state, [{ type: 'component.createCode', name: 'Code', source: '<p>Hi</p>' }]);
    const codeId = code.results[0].definitionId as string;
    expect(() => applyOperations(code.state, [{ type: 'component.upsert', name: 'D', properties: {}, nodes: [{ kind: 'instance', id: 'root', definitionId: codeId }] }])).toThrow(/never places the classes it is given/);
    // Code that places the classes it is handed carries a design's root, on a rebuild too.
    const classed = applyOperations(code.state, [{ type: 'component.createCode', name: 'Classed', source: "<script>let { class: cls = '' } = $props();</script>\n<p class={cls}>Hi</p>" }]);
    const classedId = classed.results[0].definitionId as string;
    const wrap = made(classed.state, { type: 'component.upsert', name: 'E', properties: {}, nodes: [{ kind: 'instance', id: 'root', definitionId: classedId }] });
    expect(applyOperations(wrap.state, [{ type: 'component.upsert', definitionId: wrap.id, name: 'E2', properties: {}, nodes: [{ kind: 'instance', id: 'root', definitionId: classedId }] }]).state.components[wrap.id].name).toBe('E2');
    expect(made(code.state, holder('D', { c: codeId })).state.components).toBeDefined();
  });

  it("gives a placed form's fields keys of their own, and keeps the keys of the fields a rebuild keeps", () => {
    const blank = createStarterState('blank', 'Expo', false);
    const st = applyOperations(blank, [{ type: 'node.insert', owner: { kind: 'page', id: blank.site.homePageId }, parentId: null, componentId: 'contact.form' }]).state;
    const form = Object.values(st.components).find((d) => d.componentId === 'contact.form')!;
    const keys = (s: ProjectState, id: string) => ((s.components[id].tree!.nodes.form as InstanceNode).props.fields as ListItem[]).map((f) => f.name);
    const withFields = (fields: unknown[], extra: Partial<Upsert> = {}) => holder('Enquiry', { form: form.id }, { nodes: [{ kind: 'element', id: 'root', children: ['form'] }, { kind: 'instance', id: 'form', definitionId: form.id, props: { fields } }], ...extra });
    const a = made(st, withFields([{ label: 'Work email', type: 'email' }, { label: 'Work-email', type: 'email' }]));
    const first = keys(a.state, a.id);
    expect(new Set(first).size).toBe(2);
    // The second field relabelled on a rebuild keeps the key its answers arrive under.
    const items = (a.state.components[a.id].tree!.nodes.form as InstanceNode).props.fields as ListItem[];
    const b = applyOperations(a.state, [withFields([items[0], { ...items[1], label: 'Billing email' }], { definitionId: a.id })]).state;
    expect(keys(b, a.id)).toEqual(first);
  });

  it('refuses a design that would place itself, directly, through one component or through two, changing nothing', () => {
    const st = createStarterState('blank', 'Expo', false);
    const leaf = made(st, holder('Leaf', {}, { nodes: [{ kind: 'element', id: 'root' }] }));
    const mid = made(leaf.state, holder('Mid', { leaf: leaf.id }));
    const top = made(mid.state, holder('Top', { mid: mid.id }));
    const before = JSON.stringify(top.state.components);
    expect(() => applyOperations(top.state, [holder('Leaf', { self: leaf.id }, { definitionId: leaf.id })])).toThrow(/cannot contain itself/);
    expect(() => applyOperations(top.state, [holder('Leaf', { up: mid.id }, { definitionId: leaf.id })])).toThrow(/cannot contain itself/);
    expect(() => applyOperations(top.state, [holder('Leaf', { up: top.id }, { definitionId: leaf.id })])).toThrow(/already places this component/);
    // A new component's ID, named by the batch, placed in its own design.
    const id = projectDefinitionId('New');
    expect(() => applyOperations(top.state, [holder('New', { self: id }, { newDefinitionId: id })])).toThrow(/cannot contain itself/);
    expect(JSON.stringify(top.state.components)).toBe(before);
  });
});
