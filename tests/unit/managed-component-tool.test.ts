/**
 * upsert_managed_component (#359): a whole managed component built, rebuilt and placed in one tool call, with a closed,
 * finite schema a grammar-constrained model can be held to, field errors named by their path, and a repair that sends
 * only what was wrong.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import type { ElementNode, InstanceNode, ListItem, ProjectState, RepeatNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { defFile, generateManagedComponent } from '@generator/index';
import { executeTool, toolsForRun, type ToolHost } from '@agent/tools';
import { newMacroMemory } from '@agent/macros';
import { managedComponentSchema, MANAGED_COMPONENT_ARGS } from '@agent/managed-component';
import { COMPONENT_BLUEPRINTS, blueprintSection, retrieveBlueprints } from '@agent/examples';
import { findForbiddenShapes, OPEN_VALUE_KEY, toStrictSchema } from '@agent/strict-schema';
import { envelopeInstructions, envelopeSchema } from '@agent/constrained';
import { estimateRequestTokens, estimateTokens } from '@agent/budget';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project session behind the tool host, so history and undo are the app's own. */
async function session(starter: 'business' | 'blank' = 'blank') {
  const dir = mkdtempSync(join(tmpdir(), 'so-managed-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState(starter, 'Expo', false));
  let applies = 0;
  const host: ToolHost = {
    state: () => s.state,
    revision: () => s.revision,
    diagnostics: () => validateState(s.state),
    apply: async (operations, expectedRevision, label) => {
      applies++;
      const r = await s.apply({ operations, expectedRevision }, { label });
      return { ok: r.ok, revision: r.revision, results: r.results, error: r.error };
    },
    compileAll: async () => [],
    inspectLayout: async () => ({}),
    ask: async () => '',
    macros: newMacroMemory()
  };
  let n = 0;
  const call = async (args: unknown, id = `c${++n}`) => {
    const out = await executeTool('upsert_managed_component', JSON.stringify(args), host, id);
    return { ...out, content: out.content as Record<string, any> };
  };
  return { s, host, call, applies: () => applies, home: s.state.site.homePageId };
}

/** Problems that stop a project from being saved. */
const errors = (st: ProjectState) => validateState(st).filter((d) => d.severity === 'error');

/** A design as the app writes it, compiled for the server and the browser, in the exported site and in the editor. */
function compiles(st: ProjectState, defId: string) {
  const def = st.components[defId];
  for (const instrument of [false, true])
    for (const generate of ['server', 'client'] as const) compile(generateManagedComponent(st, def, { instrument }), { filename: defFile(def), generate, runes: true });
}

const tok = (token: string) => ({ token });

/** Plans side by side: a list of plans with a featured badge and a button each, a footnote slot, tone and layout axes. */
function pricing(extra: Record<string, unknown> = {}) {
  return {
    name: 'Pricing table',
    description: 'Plans side by side.',
    category: 'conversion',
    tags: ['pricing'],
    properties: [
      { type: 'string', name: 'heading', label: 'Heading', default: 'Plans' },
      { type: 'richtext', name: 'intro', label: 'Introduction', default: 'Pick the plan that fits.' },
      { type: 'enum', name: 'level', label: 'Heading level', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }], default: 'h2' },
      {
        type: 'list',
        name: 'plans',
        label: 'Plans',
        itemLabel: 'Plan',
        titleField: 'name',
        fields: [
          { type: 'string', name: 'name', label: 'Name', default: 'Plan' },
          { type: 'string', name: 'price', label: 'Price', default: '$0' },
          { type: 'boolean', name: 'featured', label: 'Featured', default: false },
          { type: 'link', name: 'cta', label: 'Button link' },
          { type: 'string', name: 'ctaLabel', label: 'Button text', default: 'Choose' }
        ],
        default: [
          { id: 'basic', values: [{ field: 'name', value: 'Basic' }, { field: 'price', value: '$9' }, { field: 'ctaLabel', value: 'Start' }] },
          { values: [{ field: 'name', value: 'Pro' }, { field: 'price', value: '$29' }, { field: 'featured', value: true }, { field: 'ctaLabel', value: 'Go pro' }] }
        ]
      },
      { type: 'object', name: 'note', label: 'Note', fields: [{ type: 'string', name: 'text', label: 'Text' }, { type: 'link', name: 'link', label: 'Link' }], default: [{ field: 'text', value: 'Prices include tax.' }] }
    ],
    nodes: [
      { kind: 'element', id: 'root', tag: 'section', children: ['header', 'list', 'footnote'], styles: [{ property: 'paddingBlock', value: tok('space.xl') }] },
      { kind: 'element', id: 'header', tag: 'header', children: ['title', 'intro'], styles: [{ property: 'layout', value: 'stack' }, { property: 'gap', value: tok('space.sm') }] },
      { kind: 'text', id: 'title', tag: { $prop: 'level' }, text: { $prop: 'heading' }, styles: [{ property: 'textStyle', value: tok('text.h2') }] },
      { kind: 'text', id: 'intro', rich: true, text: { $prop: 'intro' }, when: { $prop: 'intro' } },
      {
        kind: 'element',
        id: 'list',
        tag: 'ul',
        children: ['plans'],
        styles: [
          { property: 'layout', value: 'stack' },
          { property: 'gap', value: tok('space.md') },
          { property: 'layout', value: 'grid', scope: 'desktop' },
          { property: 'columns', value: 3, scope: 'desktop' }
        ]
      },
      { kind: 'repeat', id: 'plans', list: 'plans', children: ['card'] },
      { kind: 'element', id: 'card', tag: 'li', children: ['badge', 'name', 'price', 'cta'], styles: [{ property: 'paddingBlock', value: tok('space.lg') }, { property: 'background', value: tok('color.surface-alt'), state: 'hover' }] },
      { kind: 'text', id: 'badge', tag: 'span', text: 'Most popular', when: { ref: { $item: 'featured' }, eq: true } },
      { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } },
      { kind: 'text', id: 'price', tag: 'p', text: { $item: 'price' } },
      { kind: 'link', id: 'cta', link: { $item: 'cta' }, label: { $item: 'ctaLabel' }, appearance: 'secondary' },
      { kind: 'element', id: 'footnote', tag: 'footer', children: ['noteText', 'notes'], collapseEmpty: true },
      { kind: 'text', id: 'noteText', tag: 'p', text: { $prop: 'note', field: 'text' } },
      { kind: 'slot', id: 'notes', slot: 'notes' }
    ],
    parts: [
      { id: 'card', nodeId: 'card', label: 'Plan card' },
      { id: 'title', nodeId: 'title', label: 'Heading', styleControls: ['textStyle', 'color'] }
    ],
    slots: [{ name: 'notes', label: 'Notes', primitives: ['text', 'link'], max: 2 }],
    variantAxes: [
      { name: 'tone', label: 'Tone', options: [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark', styles: [{ nodeId: 'root', property: 'background', value: tok('color.inverse') }, { nodeId: 'root', property: 'color', value: tok('color.on-inverse') }] }] },
      { name: 'layout', label: 'Layout', default: 'grid', options: [{ id: 'stack', label: 'Stacked' }, { id: 'grid', label: 'Grid', styles: [{ nodeId: 'list', property: 'columns', value: 2, scope: 'desktop' }] }] }
    ],
    ...extra
  };
}

const fields = (content: Record<string, any>) => (content.fields as Array<{ field: string; message: string }>).map((f) => f.field);

/**
 * Whether a value is one the strict subset accepts, as a grammar compiled from it would: types, enums, closed
 * objects and their required keys, items, unions and the bounds the subset keeps. References are already resolved.
 */
function accepts(schema: Record<string, any>, v: unknown): boolean {
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((b: Record<string, any>) => accepts(b, v));
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) return false;
  const type = schema.type;
  if (type === 'string') return typeof v === 'string' && (schema.minLength === undefined || v.length >= schema.minLength) && (schema.maxLength === undefined || v.length <= schema.maxLength);
  if (type === 'number') return typeof v === 'number';
  if (type === 'integer') return Number.isInteger(v) && (schema.minimum === undefined || (v as number) >= schema.minimum) && (schema.maximum === undefined || (v as number) <= schema.maximum);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'null') return v === null;
  if (type === 'array')
    return Array.isArray(v) && (schema.minItems === undefined || v.length >= schema.minItems) && (schema.maxItems === undefined || v.length <= schema.maxItems) && v.every((x) => accepts(schema.items, x));
  if (type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    return Object.keys(o).every((k) => Object.hasOwn(schema.properties, k) && accepts(schema.properties[k], o[k])) && (schema.required ?? []).every((k: string) => Object.hasOwn(o, k));
  }
  return type === undefined && Array.isArray(schema.enum);
}

describe('upsert_managed_component: its schema (#359)', () => {
  it('compiles to the strict subset with no forbidden shape and no value carried as encoded JSON', () => {
    const schema = managedComponentSchema();
    const strict = toStrictSchema(schema);
    expect(findForbiddenShapes(strict)).toEqual([]);
    expect(JSON.stringify(strict)).not.toContain(`"${OPEN_VALUE_KEY}"`);
    // The envelope a constrained run sends, inline and with shared definitions.
    const tool = { name: 'upsert_managed_component', description: '', parameters: schema };
    for (const compact of [false, true]) {
      const env = envelopeSchema([tool], { compact });
      expect(findForbiddenShapes(env)).toEqual([]);
      expect(JSON.stringify(env)).not.toContain(`"${OPEN_VALUE_KEY}"`);
    }
    // Nothing in the signature a small model reads is a json field it would have to escape.
    expect(envelopeInstructions([tool])).not.toMatch(/(?<![\w-])json(?![\w-])|json-object/);
  });

  it('takes real calls in its strict form, as a grammar compiled from it would, and refuses malformed ones', () => {
    const strict = toStrictSchema(managedComponentSchema());
    const chain = Array.from({ length: 300 }, (_, i) => ({ kind: 'element', id: `level${i}`, children: i < 299 ? [`level${i + 1}`] : [] }));
    const calls = [
      pricing({ placeOnPage: { pageId: '/', index: 0 } }),
      { name: 'Deep', nodes: chain },
      { name: 'Pricing table', repair: true, removeNodes: ['badge'], removeProperties: ['note'], nodes: [{ kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } }] },
      { name: 'Notes', properties: [{ type: 'table', name: 'hours', label: 'Hours', default: { columns: ['Day', 'Open'], rows: [['Mon', '9–5']] } }, { type: 'choices', name: 'topics', label: 'Topics', default: [{ label: 'Kitchens' }] }], nodes: [{ kind: 'element', id: 'root' }] },
      ...COMPONENT_BLUEPRINTS.map((b) => b.args)
    ];
    for (const c of calls) expect(accepts(strict, JSON.parse(JSON.stringify(c))), JSON.stringify(c).slice(0, 80)).toBe(true);
    // A node without its kind, a key no shape names, and a value sent as encoded JSON are each refused.
    expect(accepts(strict, { name: 'X', nodes: [{ id: 'root' }] })).toBe(false);
    expect(accepts(strict, { name: 'X', nodes: [{ kind: 'element', id: 'root', colour: 'red' }] })).toBe(false);
    expect(accepts(strict, { name: 'X', properties: { [OPEN_VALUE_KEY]: '[]' }, nodes: [{ kind: 'element', id: 'root' }] })).toBe(false);
  });

  it('has the same, finite depth for a design of any depth: the nodes are a flat list that name their children', () => {
    const depthOf = (v: unknown): number => (v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v as object).map(depthOf)) : 0);
    const strict = toStrictSchema(managedComponentSchema());
    expect(depthOf(strict)).toBeLessThan(40);
    // The engine's limit: 300 nodes, each inside the one before it.
    const chain = Array.from({ length: 300 }, (_, i) => ({ kind: 'element', id: `level${i}`, children: i < 299 ? [`level${i + 1}`] : [] }));
    expect(MANAGED_COMPONENT_ARGS.safeParse({ name: 'Deep', nodes: chain }).success).toBe(true);
  });

  it('is offered without Developer mode to runs that may change the whole site, and to Create component, never to narrower runs', () => {
    const state = createStarterState('business', 'Test', false);
    const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name);
    const home = state.pages[state.site.homePageId];
    const reads = (r: { tools: Array<{ name: string; parameters: unknown }> }) => JSON.stringify(r.tools.find((t) => t.name === 'read_component')!.parameters);
    for (const capabilities of [
      { toolCalling: 'native' as const, contextWindowTokens: 200_000 },
      { toolCalling: 'native' as const, contextWindowTokens: 32_000 },
      { toolCalling: 'constrained-json' as const, contextWindowTokens: 32_000 },
      { toolCalling: 'constrained-json' as const, contextWindowTokens: 200_000 }
    ]) {
      const base = { state, selection: null, capabilities, codeEnabled: false, definitionOps: true };
      const small = capabilities.toolCalling === 'constrained-json' || capabilities.contextWindowTokens < 64_000;
      // A small site run keeps its window for pages unless the request asks for a component; then it can also read a
      // design whole, to rebuild it.
      expect(names(toolsForRun(base)).includes('upsert_managed_component')).toBe(!small);
      expect(names(toolsForRun({ ...base, componentRequest: true }))).toContain('upsert_managed_component');
      expect(reads(toolsForRun({ ...base, componentRequest: true }))).toContain('"structure"');
      if (small) expect(reads(toolsForRun(base))).not.toContain('"structure"');
      expect(names(toolsForRun({ ...base, task: 'component' }))[0]).toBe('upsert_managed_component');
      expect(names(toolsForRun({ ...base, ask: true }))).not.toContain('upsert_managed_component');
      expect(names(toolsForRun({ ...base, page: { route: home.route } }))).not.toContain('upsert_managed_component');
      const def = Object.values(state.components).find((d) => d.tree && d.category !== 'shell')!;
      expect(names(toolsForRun({ ...base, definition: true, definitionTarget: { definitionId: def.id } }))).not.toContain('upsert_managed_component');
    }
  });

  it('is counted as a constrained model reads it: its signature, not its JSON schema', () => {
    const state = createStarterState('business', 'Test', false);
    const { tools } = toolsForRun({ state, selection: null, capabilities: { toolCalling: 'constrained-json', contextWindowTokens: 16_384 }, codeEnabled: false, definitionOps: true, componentRequest: true });
    expect(estimateRequestTokens('', tools, [], true)).toBe(estimateTokens(envelopeInstructions(tools)));
    // The grammar reads the schemas; the prompt carries only the much shorter signatures.
    expect(estimateRequestTokens('', tools, [], true) * 3).toBeLessThan(estimateRequestTokens('', tools, []));
  });
});

describe('upsert_managed_component: the role Insert gives it (#670)', () => {
  it('records insertAs, keeps it through a rebuild that leaves it out, and keeps it for a repair', async () => {
    const { s, call } = await session();
    const card = { name: 'Card', nodes: [{ kind: 'element', id: 'root', tag: 'div' }] };
    const made = await call({ ...card, insertAs: 'element' });
    expect(made.ok).toBe(true);
    const { definitionId } = made.content;
    expect(s.state.components[definitionId].insertAs).toBe('element');
    expect((await call({ ...card, definitionId, description: 'A card.' })).ok).toBe(true);
    expect(s.state.components[definitionId].insertAs).toBe('element');
    // A rejected call's insertAs is held with the rest of it, so the repair need not send it again.
    expect((await call({ name: 'Banner', insertAs: 'section', nodes: [{ kind: 'element', id: 'root', children: ['gone'] }] })).ok).toBe(false);
    const repaired = await call({ name: 'Banner', repair: true, nodes: [{ kind: 'element', id: 'root' }] });
    expect(repaired.ok).toBe(true);
    expect(s.state.components[repaired.content.definitionId].insertAs).toBe('section');
    expect(accepts(toStrictSchema(managedComponentSchema()), { ...card, insertAs: 'element' })).toBe(true);
    expect(accepts(toStrictSchema(managedComponentSchema()), { ...card, insertAs: 'row' })).toBe(false);
  });
});

describe('upsert_managed_component: building in one call (#359)', () => {
  it('creates a component with a list, bindings, conditions, parts, a slot and two variant axes, places it, and undoes both in one step', async () => {
    const { s, call, home } = await session();
    const entries = s.historyInfo().entries.length;
    const pageBefore = structuredClone(s.state.pages[home]);
    const out = await call(pricing({ placeOnPage: { pageId: '/', index: 0 } }));
    expect(out.ok).toBe(true);
    const { definitionId, rootNodeId, placed } = out.content;
    expect(rootNodeId).toBe('root');
    expect(placed.pageId).toBe(home);
    const def = s.state.components[definitionId];
    expect(def).toMatchObject({ kind: 'managed', owner: 'project', name: 'Pricing table', description: 'Plans side by side.', category: 'conversion', tags: ['pricing'] });
    expect(Object.keys(def.properties)).toEqual(['heading', 'intro', 'level', 'plans', 'note']);
    // List items as rows: an ID given is kept, and the fields left out start from their defaults.
    const plans = def.properties.plans as unknown as { default: ListItem[] };
    expect(plans.default.map((p) => [p.name, p.price, p.featured])).toEqual([
      ['Basic', '$9', false],
      ['Pro', '$29', true]
    ]);
    expect(plans.default[0].id).toBe('basic');
    expect((def.properties.note as unknown as { default: Record<string, unknown> }).default).toMatchObject({ text: 'Prices include tax.' });
    // The design keeps its IDs; style rows are kept by size and state.
    expect(def.tree!.rootIds).toEqual(['root']);
    expect(def.tree!.nodes.title).toMatchObject({ kind: 'text', tag: { $prop: 'level' }, text: { $prop: 'heading' } });
    expect(def.tree!.nodes.badge).toMatchObject({ when: { ref: { $item: 'featured' }, eq: true } });
    expect(def.tree!.nodes.noteText).toMatchObject({ text: { $prop: 'note', field: 'text' } });
    expect((def.tree!.nodes.plans as RepeatNode).list).toEqual({ $prop: 'plans' });
    expect(def.tree!.nodes.list.styles).toEqual({ base: { layout: 'stack', gap: tok('space.md') }, desktop: { layout: 'grid', columns: 3 } });
    expect(def.tree!.nodes.card.styles).toEqual({ base: { paddingBlock: tok('space.lg') }, 'base:hover': { background: tok('color.surface-alt') } });
    expect((def.tree!.nodes.footnote as ElementNode).collapseEmpty).toBe(true);
    expect(Object.keys(def.parts)).toEqual(['root', 'card', 'title']);
    expect(def.slots).toEqual({ notes: { label: 'Notes', primitives: ['text', 'link'], max: 2 } });
    expect(def.variantAxes!.tone.options.dark.styles).toEqual({ root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } });
    expect(def.variantAxes!.layout).toMatchObject({ default: 'grid', options: { grid: { styles: { list: { desktop: { columns: 2 } } } } } });
    // Placed first on the home page, with its own copies of the default plans.
    const page = s.state.pages[home];
    expect(page.rootIds[0]).toBe(placed.nodeId);
    const node = page.nodes[placed.nodeId] as InstanceNode;
    expect(node).toMatchObject({ kind: 'instance', definitionId });
    expect((node.props.plans as ListItem[]).map((p) => p.name)).toEqual(['Basic', 'Pro']);
    expect(errors(s.state)).toEqual([]);
    compiles(s.state, definitionId);

    expect(s.historyInfo().entries.length).toBe(entries + 1);
    const built = structuredClone(s.state);
    await s.undo();
    expect(s.state.components[definitionId]).toBeUndefined();
    expect(s.state.pages[home]).toEqual(pageBefore);
    await s.redo();
    expect(s.state.components[definitionId]).toEqual(built.components[definitionId]);
    expect(s.state.pages[home]).toEqual(built.pages[home]);
  });

  it('keeps a see-through site color and a backdrop blur in a design, and refuses a strength out of range (#353)', async () => {
    const { s, call } = await session();
    const glass = (alpha: number) => {
      const args = pricing() as { nodes: Array<{ id: string; styles?: unknown[] }> };
      args.nodes.find((n) => n.id === 'card')!.styles!.push({ property: 'background', value: { token: 'color.surface', alpha } }, { property: 'backdropBlur', value: '12px' });
      return args;
    };
    expect(accepts(toStrictSchema(managedComponentSchema()), JSON.parse(JSON.stringify(glass(0.7))))).toBe(true);
    const out = await call(glass(0.7));
    expect(out.ok).toBe(true);
    expect(s.state.components[out.content.definitionId].tree!.nodes.card.styles?.base).toMatchObject({ background: { token: 'color.surface', alpha: 0.7 }, backdropBlur: '12px' });
    const bad = await call(glass(1.5));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.content)).toContain('from 0 to 1');
    // A link holds its token and strength only: another key is refused by the tool, not dropped.
    const extra = pricing() as { nodes: Array<{ id: string; styles?: unknown[] }> };
    extra.nodes.find((n) => n.id === 'card')!.styles!.push({ property: 'background', value: { token: 'color.surface', alpha: 0.5, opacity: 0.5 } });
    expect((await call(extra)).ok).toBe(false);
  });

  it('names each problem by its path, in the arguments as sent, and applies nothing', async () => {
    const { s, call, applies } = await session();
    const bad = pricing({ placeOnPage: { pageId: '/nowhere/' } });
    bad.nodes[0].children = ['header', 'list', 'footer'];
    bad.nodes[2] = { kind: 'text', id: 'title', tag: 'h2', text: { $prop: 'headline' } } as never;
    bad.nodes[9] = { kind: 'text', id: 'price', tag: 'p', text: { $item: 'cost' } } as never;
    bad.nodes.push({ kind: 'text', id: 'stray', tag: 'p', text: { $item: 'name' } } as never);
    bad.parts[1].nodeId = 'heading';
    bad.variantAxes[0].options[1].styles![0].nodeId = 'base';
    bad.variantAxes[1].default = 'masonry';
    const before = structuredClone(s.state);
    const out = await call(bad);
    expect(out.ok).toBe(false);
    expect(out.content.error).toBe('VALIDATION_FAILED');
    expect(fields(out.content).sort()).toEqual(
      [
        'nodes[0].children[2]',
        'nodes[2].text',
        'nodes[9].text',
        'nodes[11]',
        'nodes[14]',
        'nodes[14].text',
        'parts[1].nodeId',
        'variantAxes[0].options[1].styles[0].nodeId',
        'variantAxes[1].default',
        'placeOnPage.pageId'
      ].sort()
    );
    // The messages name what is wrong in the model's own terms.
    const msg = (f: string) => (out.content.fields as Array<{ field: string; message: string }>).find((x) => x.field === f)!.message;
    expect(msg('nodes[2].text')).toMatch(/"headline", which is not one of the properties \(heading, intro, level, plans, note\)/);
    expect(msg('nodes[9].text')).toMatch(/"plans" items have no field "cost"/);
    // A node no children list names, because its parent named another ID, is a second root.
    expect(msg('nodes[11]')).toMatch(/"footnote" is inside no other node/);
    expect(msg('nodes[14]')).toMatch(/"stray" is inside no other node/);
    expect(msg('nodes[14].text')).toMatch(/"stray" shows the item field "name" outside any repeat/);
    expect(applies()).toBe(0);
    expect(s.state).toEqual(before);
  });

  it('refuses a name every object already has as a key, by its path, instead of failing on it', async () => {
    const { call, applies } = await session();
    const args = pricing();
    args.nodes.push({ kind: 'divider', id: 'constructor' } as never);
    (args.nodes[11] as { children: string[] }).children.push('constructor');
    args.parts.push({ id: '__proto__', nodeId: 'card', label: 'Card' });
    args.slots[0].name = 'toString';
    (args.properties[3] as { fields: Array<{ name: string }> }).fields[0].name = 'hasOwnProperty';
    args.variantAxes[0].options[1].styles!.push({ nodeId: 'constructor', property: 'color', value: tok('color.brand') } as never);
    args.variantAxes[1].name = 'valueOf';
    args.variantAxes[0].options[0].id = 'prototype';
    const out = await call(args);
    expect(out.ok).toBe(false);
    expect(fields(out.content)).toEqual(expect.arrayContaining(['nodes[14].id', 'parts[2].id', 'slots[0].name', 'properties[3].fields[0].name', 'variantAxes[1].name', 'variantAxes[0].options[0].id']));
    const msg = (f: string) => (out.content.fields as Array<{ field: string; message: string }>).find((x) => x.field === f)!.message;
    for (const f of ['nodes[14].id', 'parts[2].id', 'variantAxes[1].name', 'variantAxes[0].options[0].id']) expect(msg(f)).toMatch(/is a reserved name/);
    expect(applies()).toBe(0);
  });

  it('names a wrong shape by its path, and a property whose default does not fit it', async () => {
    const { call } = await session();
    const shape = pricing();
    delete (shape.nodes[8] as Record<string, unknown>).text;
    // An image whose alt is a number matches none of the image field's shapes: the image's own is named.
    shape.nodes.push({ kind: 'image', id: 'pic', image: { assetId: null, alt: 42 } } as never);
    (shape.nodes[6] as { children: string[] }).children.push('pic');
    const out = await call(shape);
    expect(out.ok).toBe(false);
    expect(fields(out.content)).toEqual(['nodes[8].text', 'nodes[14].image.alt']);

    const typed = pricing();
    (typed.properties[3] as { default: unknown[] }).default = [{ values: [{ field: 'name', value: 'Basic' }, { field: 'cost', value: '$9' }] }];
    (typed.properties[2] as { default: string }).default = 'h5';
    const second = await call(typed);
    expect(second.ok).toBe(false);
    expect(fields(second.content)).toEqual(expect.arrayContaining(['properties[3].default[0].values[1].field', 'properties[2].default']));
  });

  it('names a problem only the engine finds by the node it is about', async () => {
    const { call } = await session();
    const args = pricing();
    // A list item outside a list: the engine's tag checks find it.
    args.nodes[1] = { ...args.nodes[1], tag: 'li' } as never;
    const out = await call(args);
    expect(out.ok).toBe(false);
    expect(fields(out.content)).toEqual(['nodes[1]']);
  });

  it('names the root part pointed at another node by its row, and a placement outside the page by placeOnPage', async () => {
    const { s, call, home } = await session();
    const args = pricing();
    args.parts.push({ id: 'root', nodeId: 'header', label: 'Section' });
    expect(fields((await call(args)).content)).toEqual(['parts[2].nodeId']);
    const count = s.state.pages[home].rootIds.length;
    expect(fields((await call(pricing({ placeOnPage: { pageId: home, index: count + 1 } }))).content)).toEqual(['placeOnPage.index']);
    // A list item may be a component's root, but not placed straight on a page: only the two together break it.
    const item = pricing({ placeOnPage: { pageId: home } });
    item.nodes[0] = { ...item.nodes[0], tag: 'li' } as never;
    expect(fields((await call(item)).content)).toEqual(['placeOnPage']);
    const last = await call(pricing({ placeOnPage: { pageId: home, index: count } }));
    expect(last.ok).toBe(true);
    expect(s.state.pages[home].rootIds.at(-1)).toBe(last.content.placed.nodeId);
  });

  it('repairs a rejected call from only the corrected node, and refuses a repair with nothing to repair', async () => {
    const { s, call, applies } = await session();
    const none = await call({ name: 'Nothing', repair: true, nodes: [{ kind: 'divider', id: 'x' }] });
    expect(none.ok).toBe(false);
    expect(fields(none.content)).toEqual(['repair']);

    const bad = pricing();
    bad.nodes[8] = { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'title' } } as never;
    (bad.properties[2] as { default: string }).default = 'h5';
    const first = await call(bad);
    expect(first.ok).toBe(false);
    expect(fields(first.content).sort()).toEqual(['nodes[8].text', 'properties[2].default']);
    expect(first.content.message).toMatch(/repair: true/);

    const level = { type: 'enum', name: 'level', label: 'Heading level', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }], default: 'h3' };
    const fixed = await call({ name: 'Pricing table', repair: true, nodes: [{ kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } }], properties: [level] });
    expect(fixed.ok).toBe(true);
    expect(applies()).toBe(1);
    const def = s.state.components[fixed.content.definitionId];
    expect(def.tree!.nodes.name).toMatchObject({ text: { $item: 'name' } });
    // The property was replaced in its place, by its name; the others are the rejected call's.
    expect(Object.keys(def.properties)).toEqual(['heading', 'intro', 'level', 'plans', 'note']);
    expect(def.properties.level.default).toBe('h3');
    // Everything else came from the rejected call.
    expect(Object.keys(def.tree!.nodes)).toHaveLength(14);
    expect(Object.keys(def.variantAxes!)).toEqual(['tone', 'layout']);
    // Once applied, there is nothing left to repair.
    const again = await call({ name: 'Pricing table', repair: true, nodes: [{ kind: 'divider', id: 'x' }] });
    expect(fields(again.content)).toEqual(['repair']);
  });

  it('repairs only the component it names, and never from a call made before that component changed', async () => {
    const { s, call } = await session();
    const a = await call(pricing({ name: 'Alpha' }));
    const b = await call(pricing({ name: 'Beta' }));
    const [alpha, beta] = [a.content.definitionId, b.content.definitionId];
    const broken = (definitionId: string, name: string) => {
      const args = pricing({ definitionId, name });
      args.nodes[8] = { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'title' } } as never;
      return args;
    };
    expect((await call(broken(alpha, 'Alpha'))).ok).toBe(false);
    expect((await call(broken(beta, 'Beta'))).ok).toBe(false);
    const name = { kind: 'text', id: 'name', tag: 'h4', text: { $item: 'name' } };
    // Beta's rejected call came last; a repair of Alpha still mends Alpha's.
    const repaired = await call({ definitionId: alpha, name: 'Alpha', repair: true, nodes: [name] });
    expect(repaired.ok).toBe(true);
    expect(s.state.components[alpha].tree!.nodes.name).toMatchObject({ tag: 'h4' });
    expect(s.state.components[beta].tree!.nodes.name).toMatchObject({ tag: 'h3', text: { $item: 'name' } });
    // Beta changes after its call was rejected: a repair would put back what that call saw, so it is refused.
    const r = await s.apply({ operations: [{ type: 'component.rename', definitionId: beta, name: 'Beta', description: 'Changed since.' }] }, { label: 'Edit' });
    expect(r.ok).toBe(true);
    const before = structuredClone(s.state.components[beta]);
    const stale = await call({ definitionId: beta, name: 'Beta', repair: true, nodes: [name] });
    expect(fields(stale.content)).toEqual(['repair']);
    expect(stale.content.message).toMatch(/changed since that call was rejected/);
    expect(s.state.components[beta]).toEqual(before);
  });

  it('repairs a node given twice, leaves out what removeNodes names, and never takes a malformed flag for a whole new call', async () => {
    const { s, call, applies } = await session();
    const twice = pricing();
    twice.nodes.push({ kind: 'text', id: 'price', tag: 'p', text: 'Twice' } as never);
    expect(fields((await call(twice)).content)).toEqual(['nodes[14].id']);
    // "true" as text: refused, and the rejected call is still there to repair.
    const flag = await call({ name: 'Pricing table', repair: 'true', nodes: [{ kind: 'element', id: 'root', tag: 'section' }] });
    expect(fields(flag.content)).toEqual(['repair']);
    const misuse = await call({ name: 'Pricing table', removeNodes: ['badge'], nodes: [{ kind: 'element', id: 'root' }] });
    expect(fields(misuse.content)).toEqual(['removeNodes']);
    const loose = await call({ name: 'Pricing table', repair: true, removeNodes: 'badge' });
    expect(fields(loose.content)).toEqual(['removeNodes']);
    // Sending "price" once leaves it once; removeNodes takes the badge out of the design, and a property of the same
    // name as a node would stay.
    const card = { kind: 'element', id: 'card', tag: 'li', children: ['name', 'price', 'cta'] };
    const done = await call({ name: 'Pricing table', repair: true, removeNodes: ['badge'], nodes: [{ kind: 'text', id: 'price', tag: 'p', text: { $item: 'price' } }, card] });
    expect(done.ok).toBe(true);
    expect(applies()).toBe(1);
    const nodes = s.state.components[done.content.definitionId].tree!.nodes;
    expect(nodes.badge).toBeUndefined();
    expect(nodes.price).toMatchObject({ text: { $item: 'price' } });
    expect(Object.keys(nodes)).toHaveLength(13);
  });

  it('repairs a rebuild only by its definitionId, and never reads a list sent as something else as an empty one', async () => {
    const { s, call } = await session();
    const made = await call(pricing({ name: 'Alpha' }));
    const id = made.content.definitionId;
    const before = structuredClone(s.state.components[id]);
    const bad = pricing({ definitionId: id, name: 'Alpha' }) as Record<string, any>;
    bad.properties = { heading: { type: 'string', label: 'Heading' } };
    expect(fields((await call(bad)).content)).toEqual(['properties']);
    const name = { kind: 'text', id: 'name', tag: 'h4', text: { $item: 'name' } };
    // Named only, a repair is for a new component called that: not this rebuild.
    expect(fields((await call({ name: 'Alpha', repair: true, nodes: [name] })).content)).toEqual(['repair']);
    // By its definitionId, the properties sent as a map are still what is wrong, not an empty contract.
    expect(fields((await call({ definitionId: id, name: 'Alpha', repair: true, nodes: [name] })).content)).toEqual(['properties']);
    expect(s.state.components[id]).toEqual(before);
  });

  it('takes back as whole a text, default or item value a read shortened, and nothing that only ends in an ellipsis', async () => {
    const { s, call } = await session();
    const long = 'Every plan includes setup, training and a named contact. '.repeat(6).trim();
    const shown = `${long.slice(0, 219)}…`;
    const args = pricing();
    args.nodes[3] = { kind: 'text', id: 'intro', tag: 'p', text: long } as never;
    (args.properties[0] as { default: string }).default = long;
    (args.properties[3] as { default: Array<{ id?: string; values: unknown[] }> }).default[0].values.push({ field: 'price', value: long } as never);
    (args.properties[3] as { default: Array<{ id?: string; values: unknown[] }> }).default[0].values.splice(1, 1);
    const made = await call(args);
    expect(made.ok).toBe(true);
    const id = made.content.definitionId;
    // The rebuild sends them as read_component shows them: cut to 220 characters, ending in …, with an entrance it read.
    const again = pricing({ definitionId: id });
    again.nodes[0] = { ...again.nodes[0], appear: 'fade' } as never;
    again.nodes[3] = { kind: 'text', id: 'intro', tag: 'p', text: shown } as never;
    (again.properties[0] as { default: string }).default = shown;
    (again.properties[3] as { default: Array<{ id?: string; values: unknown[] }> }).default[0].values.splice(1, 1, { field: 'price', value: shown } as never);
    again.nodes[8] = { kind: 'text', id: 'name', tag: 'h3', text: 'Plans…' } as never;
    expect((await call(again)).ok).toBe(true);
    const def = s.state.components[id];
    expect(def.tree!.nodes.intro).toMatchObject({ text: long });
    expect(def.tree!.nodes.root).toMatchObject({ appear: 'fade' });
    expect(def.properties.heading.default).toBe(long);
    expect((def.properties.plans.default as ListItem[]).find((p) => p.id === 'basic')!.price).toBe(long);
    // An ellipsis the call means is kept as it is.
    expect(def.tree!.nodes.name).toMatchObject({ text: 'Plans…' });
  });

  it('keeps a row a repair cannot address, and names a malformed definitionId instead of failing on it', async () => {
    const { s, call } = await session();
    const bad = pricing();
    bad.properties.push({ type: 'string', label: 'Internal note' } as never);
    bad.nodes[8] = { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'title' } } as never;
    const first = await call(bad);
    expect(fields(first.content)).toEqual(expect.arrayContaining(['properties[5].name']));
    const msg = (out: { content: Record<string, any> }, f: string) => (out.content.fields as Array<{ field: string; message: string }>).find((x) => x.field === f)?.message;
    expect(msg(first, 'properties[5].name')).toMatch(/cannot be repaired by it: send the whole component again/);
    // Mending the node leaves the nameless property where it was, still refused, rather than dropping it unseen.
    const again = await call({ name: 'Pricing table', repair: true, nodes: [{ kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } }] });
    expect(fields(again.content)).toEqual(['properties[5].name']);
    const count = Object.keys(s.state.components).length;
    const odd = await executeTool('upsert_managed_component', JSON.stringify({ name: 'Cards', repair: true, definitionId: { toString: null } }), { ...{ state: () => s.state, revision: () => s.revision }, macros: newMacroMemory() } as unknown as ToolHost, 'odd');
    expect(odd.ok).toBe(false);
    expect((odd.content as { fields: Array<{ field: string }> }).fields.map((f) => f.field)).toEqual(['definitionId']);
    expect(Object.keys(s.state.components)).toHaveLength(count);
  });

  it('names a rebuild its existing placements cannot take by the design, whether or not it asks for another placement', async () => {
    const { call, home } = await session();
    const made = await call(pricing({ placeOnPage: { pageId: home } }));
    for (const placeOnPage of [undefined, { pageId: home }]) {
      const next = pricing({ definitionId: made.content.definitionId, ...(placeOnPage ? { placeOnPage } : {}) });
      next.nodes[0] = { ...next.nodes[0], tag: 'li' } as never;
      const out = await call(next);
      expect(out.ok).toBe(false);
      expect(fields(out.content)).toEqual(['nodes']);
    }
  });

  it('refuses a rebuild a placement cannot take, leaving the page, the design and the history as they were', async () => {
    const { s, call, home } = await session();
    const made = await call(pricing({ placeOnPage: { pageId: home } }));
    const { definitionId, placed } = made.content;
    const owner = { kind: 'page' as const, id: home };
    const filled = await s.apply({ operations: [{ type: 'node.insert', owner, parentId: placed.nodeId, slot: 'notes', primitive: 'paragraph', text: 'Prices include tax.' }] }, { label: 'Fill' });
    expect(filled.ok).toBe(true);
    const before = structuredClone(s.state);
    const [revision, entries] = [s.revision, s.historyInfo().entries.length];
    // The slot goes, while it holds this placement's note; and another placement is asked for in the same call.
    const next = pricing({ definitionId, placeOnPage: { pageId: home } });
    next.slots = [];
    next.nodes = next.nodes.filter((n) => n.id !== 'notes');
    next.nodes.find((n) => n.id === 'footnote')!.children = ['noteText'];
    const out = await call(next);
    expect(out.ok).toBe(false);
    expect(s.state).toEqual(before);
    expect([s.revision, s.historyInfo().entries.length]).toEqual([revision, entries]);
  });

  it('keeps through a rebuild what a link written as its address cannot say, while it goes to the same place (#582)', async () => {
    const { s, call } = await session();
    const args = pricing();
    args.nodes = args.nodes.map((n) => ((n as { id: string }).id === 'cta' ? { ...n, link: 'https://shop.example/' } : n)) as never;
    const made = await call(args);
    expect(made.ok).toBe(true);
    const id = made.content.definitionId;
    // The author opened it in a new tab and marked it paid, in the Inspector.
    s.state.components[id].tree!.nodes.cta = { ...s.state.components[id].tree!.nodes.cta, link: { type: 'url', target: 'https://shop.example/', newTab: true, rel: ['sponsored'] } } as never;
    expect((await call(pricing({ definitionId: id, nodes: args.nodes }))).ok).toBe(true);
    expect(s.state.components[id].tree!.nodes.cta).toMatchObject({ link: { type: 'url', target: 'https://shop.example/', newTab: true, rel: ['sponsored'] } });
    // Somewhere else, it is a new link.
    const moved = args.nodes.map((n) => ((n as { id: string }).id === 'cta' ? { ...n, link: 'https://other.example/' } : n));
    expect((await call(pricing({ definitionId: id, nodes: moved }))).ok).toBe(true);
    expect((s.state.components[id].tree!.nodes.cta as { link: unknown }).link).toEqual({ type: 'url', target: 'https://other.example/' });
  });

  it('keeps through a rebuild what the tool has no field for: a slot\'s categories', async () => {
    const { s, call } = await session();
    const args = pricing();
    args.slots = [{ name: 'notes', label: 'Notes', categories: ['media'] } as never];
    const made = await call(args);
    expect(made.ok).toBe(true);
    const id = made.content.definitionId;
    const again = pricing({ definitionId: id });
    again.slots = [{ name: 'notes', label: 'Small print' }] as never;
    expect((await call(again)).ok).toBe(true);
    expect(s.state.components[id].slots!.notes).toMatchObject({ label: 'Small print', categories: ['media'] });
  });

  it('rebuilds a placed component whole, keeping its placement values, and places it again', async () => {
    const { s, call, home } = await session();
    const made = await call(pricing({ placeOnPage: { pageId: home } }));
    const { definitionId, placed } = made.content;
    const owner = { kind: 'page' as const, id: home };
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: placed.nodeId, prop: 'heading', value: 'Our prices' }] }, { label: 'Edit' });
    expect(r.ok).toBe(true);

    const next = pricing({ definitionId, name: 'Price list', placeOnPage: { pageId: home } });
    // The badge goes; the heading becomes a plain h2.
    next.nodes = next.nodes.filter((n) => n.id !== 'badge');
    next.nodes.find((n) => n.id === 'card')!.children = ['name', 'price', 'cta'];
    next.nodes[2] = { kind: 'text', id: 'title', tag: 'h2', text: { $prop: 'heading' } } as never;
    const rebuilt = await call(next);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.content.definitionId).toBe(definitionId);
    const def = s.state.components[definitionId];
    expect(def.name).toBe('Price list');
    expect(def.tree!.nodes.badge).toBeUndefined();
    const page = s.state.pages[home];
    expect((page.nodes[placed.nodeId] as InstanceNode).props.heading).toBe('Our prices');
    expect(page.rootIds.filter((id) => (page.nodes[id] as InstanceNode).definitionId === definitionId)).toHaveLength(2);
  });

  it('returns the first result for a replayed call and changes nothing more', async () => {
    const { s, call, applies } = await session();
    const first = await call(pricing(), 'same');
    const count = Object.keys(s.state.components).length;
    const again = await call(pricing(), 'same');
    expect(again.content).toEqual(first.content);
    expect(applies()).toBe(1);
    expect(Object.keys(s.state.components)).toHaveLength(count);
    const other = await call(pricing({ name: 'Other' }), 'same');
    expect(other.ok).toBe(false);
  });
});

describe('component blueprints (#359)', () => {
  it('each builds a component that renders, from its arguments as they are', async () => {
    for (const blueprint of COMPONENT_BLUEPRINTS) {
      const { s, call, home } = await session('business');
      const out = await call({ ...blueprint.args, placeOnPage: { pageId: home } });
      expect(out.ok, `${blueprint.id}: ${JSON.stringify(out.content)}`).toBe(true);
      const def = s.state.components[out.content.definitionId];
      // Tokens, a part beyond the root, a variant that restyles, and phone/tablet/desktop rules.
      expect(JSON.stringify(def.tree)).toContain('"token"');
      expect(Object.keys(def.parts).length).toBeGreaterThan(1);
      expect(Object.values(def.variantAxes ?? {}).some((a) => Object.values(a.options).some((o) => o.styles))).toBe(true);
      expect(Object.values(def.tree!.nodes).some((n) => n.styles && Object.keys(n.styles).some((k) => k !== 'base'))).toBe(true);
      expect(errors(s.state)).toEqual([]);
      // Followed as it is, a blueprint leaves nothing to warn about, on its design or its placement: nothing the
      // reusability check would send the model back for, and no button hidden for want of a link.
      const mine = (d: { owner?: { kind: string; id: string }; nodeId?: string }) => (d.owner?.kind === 'component' && d.owner.id === def.id) || d.nodeId === out.content.placed.nodeId;
      expect(validateState(s.state).filter((d) => d.severity === 'warning' && mine(d)).map((d) => d.message), blueprint.id).toEqual([]);
      compiles(s.state, out.content.definitionId);
    }
  });

  it('show the conventions they are there for: a list shown by a repeat, phone to desktop columns, parts and a dark tone', () => {
    const grid = COMPONENT_BLUEPRINTS.find((b) => b.id === 'card-grid')!.args;
    const node = (id: string) => grid.nodes!.find((n) => n.id === id)!;
    expect(node('cards')).toMatchObject({ kind: 'repeat', list: 'cards' });
    expect(node('title')).toMatchObject({ text: { $item: 'title' } });
    expect((node('grid') as { styles: unknown[] }).styles).toEqual(expect.arrayContaining([{ property: 'columns', value: 1 }, { property: 'columns', value: 2, scope: 'tablet' }, { property: 'columns', value: 3, scope: 'desktop' }]));
    expect(grid.parts!.map((p) => [p.id, p.nodeId])).toEqual([['heading', 'heading'], ['card', 'card']]);
    for (const b of COMPONENT_BLUEPRINTS) {
      const inverse = b.args.variantAxes![0].options.find((o) => o.id === 'inverse')!;
      expect(inverse.styles).toEqual(expect.arrayContaining([{ nodeId: 'root', property: 'background', value: tok('color.inverse') }, { nodeId: 'root', property: 'color', value: tok('color.on-inverse') }]));
    }
  });

  it('are retrieved by the words of a request, one or two, or the first when none match', () => {
    const state = createStarterState('blank', 'Test', false);
    expect(retrieveBlueprints(state, 'Create a component with team member cards').map((b) => b.id)).toEqual(['card-grid']);
    expect(retrieveBlueprints(state, 'A newsletter signup banner component').map((b) => b.id)).toEqual(['callout']);
    expect(retrieveBlueprints(state, 'Cards in a grid, and a banner').map((b) => b.id)).toEqual(['card-grid', 'callout']);
    expect(retrieveBlueprints(state, 'A component for opening hours').map((b) => b.id)).toEqual(['card-grid']);
    expect(blueprintSection(COMPONENT_BLUEPRINTS[0])).toEqual({ for: COMPONENT_BLUEPRINTS[0].description, upsert_managed_component: COMPONENT_BLUEPRINTS[0].args });
  });

});

describe('UI state in one call (#377)', () => {
  /** A Monthly/Annual tab list, each tab showing its own panel, and a Details button opening a drawer. */
  function planSwitch(extra: Record<string, unknown> = {}) {
    return {
      name: 'Plan switch',
      category: 'conversion',
      properties: [{ type: 'string', name: 'heading', label: 'Heading', default: 'Plans' }],
      state: [
        { type: 'enum', name: 'plan', label: 'Plan', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }] },
        { type: 'boolean', name: 'open', label: 'Details' }
      ],
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['heading', 'tabs', 'monthly', 'annual', 'more', 'drawer'] },
        { kind: 'text', id: 'heading', tag: 'h2', text: { $prop: 'heading' } },
        { kind: 'element', id: 'tabs', children: ['monthlyTab', 'annualTab'] },
        { kind: 'link', id: 'monthlyTab', link: '', label: 'Monthly', appearance: 'secondary', stateAction: { op: 'set', state: 'plan', value: 'monthly' } },
        { kind: 'link', id: 'annualTab', link: '', label: 'Annual', appearance: 'secondary', stateAction: { op: 'set', state: 'plan', value: 'annual' } },
        { kind: 'element', id: 'monthly', children: ['monthlyPrice'], when: { ref: { $state: 'plan' }, eq: 'monthly' } },
        { kind: 'text', id: 'monthlyPrice', text: '$10 a month' },
        { kind: 'element', id: 'annual', children: ['annualPrice'], when: { ref: { $state: 'plan' }, eq: 'annual' } },
        { kind: 'text', id: 'annualPrice', text: '$100 a year' },
        { kind: 'link', id: 'more', link: '', label: 'Details', appearance: 'text', stateAction: { op: 'toggle', state: 'open' } },
        { kind: 'element', id: 'drawer', overlay: 'drawer-end', children: ['terms'], when: { $state: 'open' } },
        { kind: 'text', id: 'terms', text: 'Cancel any time.' }
      ],
      ...extra
    };
  }
  const nodeAt = (id: string) => planSwitch().nodes.findIndex((n) => n.id === id);

  it('fits the strict schema a constrained model is held to, a state row, an action and a state condition included', () => {
    const strict = toStrictSchema(managedComponentSchema());
    expect(accepts(strict, JSON.parse(JSON.stringify(planSwitch({ placeOnPage: { pageId: '/' } }))))).toBe(true);
    expect(accepts(strict, { ...planSwitch(), state: [{ type: 'enum', name: 'plan', label: 'Plan', options: [{ value: 'monthly', label: 'Monthly' }] }] })).toBe(false);
    expect(accepts(strict, { ...planSwitch(), state: [{ type: 'toggle', name: 'open', label: 'Open' }] })).toBe(false);
  });

  it('builds working tabs and a drawer in one call without Developer mode, placed and undone in one step', async () => {
    const { s, call, home } = await session();
    const out = await call(planSwitch({ placeOnPage: { pageId: '/' } }));
    expect(out.ok, JSON.stringify(out.content)).toBe(true);
    const def = s.state.components[out.content.definitionId];
    expect(def.state).toEqual({
      plan: { type: 'enum', label: 'Plan', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }], initial: 'monthly' },
      open: { type: 'boolean', label: 'Details', initial: false }
    });
    expect(def.tree!.nodes.annualTab).toMatchObject({ kind: 'link', stateAction: { state: 'plan', op: 'set', value: 'annual' } });
    expect(def.tree!.nodes.annual.when).toEqual({ ref: { $state: 'plan' }, eq: 'annual' });
    expect(def.tree!.nodes.drawer).toMatchObject({ overlay: 'drawer-end', when: { $state: 'open' } });
    expect(def.tree!.nodes.more).toMatchObject({ kind: 'link', stateAction: { state: 'open', op: 'toggle' } });
    expect(errors(s.state)).toEqual([]);
    // The generated component holds the state and makes the tab list and the drawer, in the site and the editor.
    const svelte = generateManagedComponent(s.state, def, {});
    expect(svelte).toContain('let so_state_plan = $state("monthly");');
    expect(svelte).toContain('role="tablist"');
    expect(svelte).toContain('<dialog');
    compiles(s.state, def.id);
    expect(s.state.pages[home].nodes[out.content.placed.nodeId]).toMatchObject({ kind: 'instance', definitionId: def.id });
    await s.undo();
    expect(s.state.components[def.id]).toBeUndefined();
    expect(s.state.pages[home].nodes[out.content.placed.nodeId]).toBeUndefined();
  });

  it('names each UI state problem by its path, and applies nothing', async () => {
    const { s, call, applies } = await session();
    const nodes = planSwitch().nodes;
    const withNode = (id: string, patch: Record<string, unknown>) => planSwitch({ nodes: nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
    const fields = async (args: unknown) => {
      const out = await call(args);
      expect(out.ok).toBe(false);
      return out.content.fields as Array<{ field: string; message: string }>;
    };
    expect(await fields(withNode('annual', { when: { ref: { $state: 'period' }, eq: 'annual' } }))).toEqual([{ field: `nodes[${nodeAt('annual')}].when`, message: expect.stringMatching(/reads the UI state "period", which is not one of the state \(plan, open\)/) }]);
    expect(await fields(withNode('annual', { when: { ref: { $state: 'plan' }, eq: 'yearly' } }))).toEqual([{ field: `nodes[${nodeAt('annual')}].when.eq`, message: expect.stringMatching(/"yearly" is not one of the options of "plan" \(monthly, annual\)/) }]);
    expect(await fields(withNode('drawer', { when: { ref: { $state: 'open' }, eq: 'yes' } }))).toEqual([{ field: `nodes[${nodeAt('drawer')}].when.eq`, message: expect.stringMatching(/"open" is yes\/no: compare it with true or false/) }]);
    expect(await fields(withNode('annualTab', { stateAction: { op: 'set', state: 'plan', value: 'yearly' } }))).toEqual([{ field: `nodes[${nodeAt('annualTab')}].stateAction`, message: expect.stringMatching(/"annualTab" sets "plan" to "yearly", which is not one of its options/) }]);
    expect(await fields(withNode('annualTab', { stateAction: { op: 'toggle', state: 'plan' } }))).toEqual([{ field: `nodes[${nodeAt('annualTab')}].stateAction`, message: expect.stringMatching(/toggles the choice "plan"/) }]);
    const states = planSwitch().state;
    expect(await fields(planSwitch({ state: [...states, { type: 'boolean', name: 'plan', label: 'Again' }] }))).toEqual([{ field: 'state[2].name', message: '"plan" is listed twice' }]);
    expect(await fields(planSwitch({ state: [{ type: 'boolean', name: 'heading', label: 'Heading' }, ...states] }))).toEqual([{ field: 'state[0].name', message: expect.stringMatching(/"heading" is already a property/) }]);
    expect(await fields(planSwitch({ state: [{ ...states[0], initial: 'yearly' }, states[1]] }))).toEqual([{ field: 'state[0].initial', message: expect.stringMatching(/starts as "yearly", which is not one of its options/) }]);
    expect(await fields(withNode('annual', { when: undefined, unless: { ref: { $state: 'plan' }, ne: 'yearly' } }))).toEqual([{ field: `nodes[${nodeAt('annual')}].unless.ne`, message: expect.stringMatching(/"yearly" is not one of the options of "plan"/) }]);
    // A drawer no yes/no state opens is the engine's to refuse, named by its node.
    expect(await fields(withNode('drawer', { when: undefined }))).toEqual([{ field: `nodes[${nodeAt('drawer')}]`, message: expect.stringMatching(/no yes\/no UI state of the component opens/) }]);
    expect(applies()).toBe(0);
    expect(Object.values(s.state.components).filter((d) => d.owner === 'project')).toEqual([]);
  });

  it('rebuilds with the state it is given: left out, it is refused while the design uses it; an empty list removes it', async () => {
    const { s, call } = await session();
    const made = await call(planSwitch());
    const definitionId = made.content.definitionId as string;
    const plain = planSwitch().nodes.filter((n) => !['tabs', 'monthlyTab', 'annualTab', 'monthly', 'annual', 'more', 'drawer', 'monthlyPrice', 'annualPrice', 'terms'].includes(n.id)).map((n) => (n.id === 'root' ? { ...n, children: ['heading'] } : n));
    // Rebuilt with no word about its state, its tabs would vanish unseen: refused, naming the field to send.
    const silent = await call({ name: 'Plan switch', definitionId, properties: planSwitch().properties, nodes: plain });
    expect(silent.ok).toBe(false);
    expect(silent.content.fields).toEqual([{ field: 'state', message: expect.stringMatching(/\(plan, open\)\. Send state again with the rebuild; an empty list removes it/) }]);
    // A rebuild that keeps the tabs and drops the drawer describes the state it keeps.
    const kept = await call(
      planSwitch({ definitionId, state: [planSwitch().state[0]], nodes: planSwitch().nodes.filter((n) => !['more', 'drawer', 'terms'].includes(n.id)).map((n) => (n.id === 'root' ? { ...n, children: ['heading', 'tabs', 'monthly', 'annual'] } : n)) })
    );
    expect(kept.ok, JSON.stringify(kept.content)).toBe(true);
    expect(Object.keys(s.state.components[definitionId].state!)).toEqual(['plan']);
    // An empty list removes what is left.
    const cleared = await call({ name: 'Plan switch', definitionId, properties: planSwitch().properties, nodes: plain, state: [] });
    expect(cleared.ok, JSON.stringify(cleared.content)).toBe(true);
    expect(s.state.components[definitionId].state).toBeUndefined();
    expect(errors(s.state)).toEqual([]);
  });

  it('reads state a rebuild leaves out but keeps, and a ne comparison, as the engine does', async () => {
    const { s, call } = await session();
    const made = await call(planSwitch());
    const definitionId = made.content.definitionId as string;
    // Down to one button and its drawer, with the plan state given and kept unused; then a rebuild that leaves state out
    // keeps it and may read it again.
    const drawerOnly = planSwitch().nodes.filter((n) => ['root', 'heading', 'more', 'drawer', 'terms'].includes(n.id)).map((n) => (n.id === 'root' ? { ...n, children: ['heading', 'more', 'drawer'] } : n));
    expect((await call(planSwitch({ definitionId, nodes: drawerOnly }))).ok).toBe(true);
    const back = planSwitch().nodes.map((n) => (n.id === 'annual' ? { ...n, when: undefined, unless: { ref: { $state: 'plan' }, ne: 'annual' } } : n));
    const unused = planSwitch({ definitionId, nodes: drawerOnly.filter((n) => !['more', 'drawer', 'terms'].includes(n.id)).map((n) => (n.id === 'root' ? { ...n, children: ['heading'] } : n)) });
    expect((await call(unused)).ok).toBe(true);
    const reread = await call({ name: 'Plan switch', definitionId, properties: planSwitch().properties, nodes: back });
    expect(reread.ok, JSON.stringify(reread.content)).toBe(true);
    expect(s.state.components[definitionId].tree!.nodes.annual.unless).toEqual({ ref: { $state: 'plan' }, ne: 'annual' });
    expect(Object.keys(s.state.components[definitionId].state!)).toEqual(['plan', 'open']);
  });
});
