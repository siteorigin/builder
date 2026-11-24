import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import type { ElementNode, InstanceNode, LinkNode, ListItem, ProjectState, RepeatNode, TextNode } from '@shared/types';
import { validateOperation, type EditOperation, type Op } from '@shared/ops';
import { projectDefinitionId } from '@shared/component-ids';
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
    expect((def.tree!.nodes.plans as RepeatNode).list).toEqual({ $prop: 'plans' });
    expect(def.tree!.nodes.card.styles).toEqual({ base: { paddingBlock: { token: 'space.lg' } }, 'base:hover': { background: { token: 'color.surface-alt' } } });
    expect((def.tree!.nodes.footnote as ElementNode).collapseEmpty).toBe(true);
    // Parts: the root is implied; the others keep the controls given, or offer what their kind takes.
    expect(Object.keys(def.parts)).toEqual(['root', 'card', 'title', 'cta']);
    expect(def.parts.root).toMatchObject({ nodeId: 'root', label: 'Root' });
    expect(def.parts.title.styleControls).toEqual(['textStyle', 'color']);
    expect(def.parts.card.styleControls?.length).toBeGreaterThan(0);
    expect(def.slots).toEqual({ notes: { label: 'Notes', description: 'Small print under the plans.', primitives: ['text', 'link'], max: 2 } });
    expect(def.variantAxes!.tone).toMatchObject({ label: 'Tone', default: 'light' });
    expect(def.variantAxes!.tone.options.dark.styles).toEqual({ root: { base: { background: { token: 'color.inverse' }, color: { token: 'color.on-inverse' } } } });
    expect(def.variantAxes!.layout).toMatchObject({ default: 'grid', options: { grid: { styles: { list: { desktop: { columns: 2 } } } } } });

    // The placement got its own copies of the default plans, and the chosen tone.
    const placed = s.state.pages[home.id].nodes[r.results![1].nodeId as string] as InstanceNode;
    expect(placed).toMatchObject({ kind: 'instance', definitionId, variants: { tone: 'dark' } });
    expect((placed.props.plans as ListItem[]).map((p) => p.name)).toEqual(['Basic', 'Pro']);

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
    expect(Object.keys(Object.values(st.components).find((d) => d.name === 'Pricing table')!.tree!.nodes)).toHaveLength(13 + depth);
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
      [withNodes((n) => (node(n, 'footnote').tag = 'li', n)), /is a list item, so it goes directly inside a list/]
    ];
    for (const [bad, why] of refused) {
      expect(validateOperation(bad)).toMatchObject({ ok: true });
      const r = await s.apply({ operations: [bad] }, { label: 'Build' });
      expect(r.ok, String(why)).toBe(false);
      expect(r.error?.message).toMatch(why);
    }
    expect(s.state).toEqual(before);
    expect(s.historyInfo().entries.length).toBe(entries);
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

  it('drops single-item styles whose part no longer repeats over the same list', () => {
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
    // The card now repeats over "offers", whose items reuse the same IDs: the styles set for a plan never reach an offer.
    const next = pricing({ definitionId: id });
    next.properties = { ...next.properties, offers: next.properties.plans };
    next.nodes = next.nodes.map((n) => (n.id === 'plans' ? { ...n, list: 'offers' } : n));
    const after = applyOperations(st, [next]).state;
    const inst = after.pages[home.id].nodes[nodeId] as InstanceNode;
    expect(inst.itemOverrides).toBeUndefined();
    expect(inst.overrides).toEqual({ card: { base: { radius: { token: 'radius.md' } } } });
    expect((inst.props.offers as ListItem[]).length).toBe(2);
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
    await s.apply({ operations: [{ type: 'node.insert', owner: other, parentId: placedOther.id, slot: 'notes', primitive: 'paragraph', text: 'Small print.' }] }, { label: 'Note' });
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
    // A design that places another component holds what the description cannot say yet.
    const made = applyOperations(st, [{ type: 'component.create', name: 'Holder' }]);
    const { definitionId, rootNodeId } = made.results[0] as { definitionId: string; rootNodeId: string };
    const nested = applyOperations(made.state, [{ type: 'node.insert', owner: { kind: 'component', id: definitionId }, parentId: rootNodeId, componentId: 'content.text' }]).state;
    expect(() => applyOperations(nested, [pricing({ definitionId })])).toThrow(/places other components/);
    expect(() => applyOperations(st, [pricing({ definitionId, newDefinitionId: projectDefinitionId('X') })])).toThrow(/not both/);
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
    expect(errors(after.state)).toEqual([]);
    compiles(after.state, def.id);
  });
});
