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
import { isReusabilityWarning } from '@engine/reusability';
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
    for (const capabilities of [
      { toolCalling: 'native' as const, contextWindowTokens: 200_000 },
      { toolCalling: 'constrained-json' as const, contextWindowTokens: 32_000 }
    ]) {
      const base = { state, selection: null, capabilities, codeEnabled: false, definitionOps: true };
      // A small site run keeps its window for pages unless the request asks for a component.
      expect(names(toolsForRun(base)).includes('upsert_managed_component')).toBe(capabilities.toolCalling === 'native');
      expect(names(toolsForRun({ ...base, componentRequest: true }))).toContain('upsert_managed_component');
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

describe('upsert_managed_component: building in one call (#359)', () => {
  it('creates a component with a list, bindings, conditions, parts, a slot and two variant axes, places it, and undoes both in one step', async () => {
    const { s, call, home } = await session();
    const entries = s.historyInfo().entries.length;
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
    expect(s.state.pages[home].nodes[placed.nodeId]).toBeUndefined();
    await s.redo();
    expect(s.state.components[definitionId]).toEqual(built.components[definitionId]);
    expect(s.state.pages[home]).toEqual(built.pages[home]);
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
    expect(fields(out.content)).toEqual(
      expect.arrayContaining([
        'nodes[0].children[2]',
        'nodes[2].text',
        'nodes[9].text',
        'nodes[11]',
        'nodes[14]',
        'parts[1].nodeId',
        'variantAxes[0].options[1].styles[0].nodeId',
        'variantAxes[1].default',
        'placeOnPage.pageId'
      ])
    );
    // The messages name what is wrong in the model's own terms.
    const msg = (f: string) => (out.content.fields as Array<{ field: string; message: string }>).find((x) => x.field === f)!.message;
    expect(msg('nodes[2].text')).toMatch(/"headline", which is not one of the properties \(heading, intro, level, plans, note\)/);
    expect(msg('nodes[9].text')).toMatch(/"plans" items have no field "cost"/);
    // A node no children list names, because its parent named another ID, is a second root.
    expect(msg('nodes[11]')).toMatch(/"footnote" is inside no other node/);
    expect(msg('nodes[14]')).toMatch(/"stray" is inside no other node/);
    expect(applies()).toBe(0);
    expect(s.state).toEqual(before);
  });

  it('names a wrong shape by its path, and a property whose default does not fit it', async () => {
    const { call } = await session();
    const shape = pricing();
    delete (shape.nodes[8] as Record<string, unknown>).text;
    const out = await call(shape);
    expect(out.ok).toBe(false);
    expect(fields(out.content)).toContain('nodes[8].text');

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

  it('repairs a rejected call from only the corrected node, and refuses a repair with nothing to repair', async () => {
    const { s, call, applies } = await session();
    const none = await call({ name: 'Nothing', repair: true, nodes: [{ kind: 'divider', id: 'x' }] });
    expect(none.ok).toBe(false);
    expect(fields(none.content)).toEqual(['repair']);

    const bad = pricing();
    bad.nodes[8] = { kind: 'text', id: 'name', tag: 'h3', text: { $item: 'title' } } as never;
    const first = await call(bad);
    expect(first.ok).toBe(false);
    expect(fields(first.content)).toEqual(['nodes[8].text']);
    expect(first.content.message).toMatch(/repair: true/);

    const fixed = await call({ name: 'Pricing table', repair: true, nodes: [{ kind: 'text', id: 'name', tag: 'h3', text: { $item: 'name' } }] });
    expect(fixed.ok).toBe(true);
    expect(applies()).toBe(1);
    const def = s.state.components[fixed.content.definitionId];
    expect(def.tree!.nodes.name).toMatchObject({ text: { $item: 'name' } });
    // Everything else came from the rejected call.
    expect(Object.keys(def.tree!.nodes)).toHaveLength(14);
    expect(Object.keys(def.variantAxes!)).toEqual(['tone', 'layout']);
    // Once applied, there is nothing left to repair.
    const again = await call({ name: 'Pricing table', repair: true, nodes: [{ kind: 'divider', id: 'x' }] });
    expect(fields(again.content)).toEqual(['repair']);
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
      // Followed as it is, a blueprint leaves nothing the reusability check would send the model back for.
      expect(validateState(s.state).filter((d) => isReusabilityWarning(d) && d.owner?.kind === 'component' && d.owner.id === def.id).map((d) => d.message), blueprint.id).toEqual([]);
      compiles(s.state, out.content.definitionId);
    }
  });

  it('are retrieved by the words of a request, one or two, or the first when none match', () => {
    const state = createStarterState('blank', 'Test', false);
    expect(retrieveBlueprints(state, 'Create a component with team member cards').map((b) => b.id)).toEqual(['card-grid']);
    expect(retrieveBlueprints(state, 'A newsletter signup banner component').map((b) => b.id)).toEqual(['callout']);
    expect(retrieveBlueprints(state, 'Cards in a grid, and a banner').map((b) => b.id)).toEqual(['card-grid', 'callout']);
    expect(retrieveBlueprints(state, 'A component for opening hours')).toHaveLength(1);
    expect(blueprintSection(COMPONENT_BLUEPRINTS[0])).toEqual({ for: COMPONENT_BLUEPRINTS[0].description, upsert_managed_component: COMPONENT_BLUEPRINTS[0].args });
  });

});
