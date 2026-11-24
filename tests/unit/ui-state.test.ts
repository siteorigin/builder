/**
 * UI state on managed components (#375): boolean and enum state a design declares, conditions and nested variants
 * that read it (`{ $state }`), buttons that change it (`stateAction`), and the checks that keep every read and every
 * change pointing at state the design has, in the form it has it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, GraphNode, InstanceNode, LinkNode, ProjectState, UiStateSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { generateProject, nodeClass } from '@generator/index';
import { P, eq, prop, uiState, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { OPERATION_SCHEMAS, validateOperation } from '@shared/ops';
import { MIGRATIONS, migrateProject } from '@shared/migrations';
import { SCHEMA_VERSION } from '@shared/types';
import { OP_REACH } from '@agent/scope';
import { toolDefinitions } from '@agent/tools';
import { conditionSources, describeConditions, readRule } from '../../src/renderer/src/lib/conditions';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

/** Place a component at the end of Home. */
function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(def, props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function compileErrors(s: ProjectState): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    for (const [path, source] of generateProject(s, { instrument })) {
      if (!path.endsWith('.svelte')) continue;
      for (const generate of ['server', 'client'] as const) {
        try {
          compile(source, { filename: path, generate, runes: true });
        } catch (e) {
          out.push(`${path} (${generate}${instrument ? ', editor' : ''}): ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

/** Server-render the exported Home page. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'ui-state-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
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
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}

/** The opening tag of the element carrying `cls` in its class list. */
const openTag = (html: string, cls: string) => new RegExp(`<[a-z0-9]+\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`).exec(html)?.[0] ?? '';

const NONE = { type: 'none' as const, target: '' };
const BILLING: UiStateSchema = { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }], initial: 'annual' };
const OPEN: UiStateSchema = { type: 'boolean', label: 'Open', initial: false };

/** A price shown monthly by default: its period axis is what a billing switch chooses. */
function priceDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'test.price',
    name: 'Price',
    properties: { amount: P.str('Amount', '$10') },
    parts: {},
    variantAxes: { period: { label: 'Period', default: 'monthly', options: { monthly: { label: 'Monthly' }, annual: { label: 'Annual' } } } },
    build: (b) => b.el('price-root', 'div', {}, [b.text('amount', 'p', prop('amount'))])
  });
}

/**
 * A pricing table with a billing switch: two buttons set the period, a third shows the small print, notes show for
 * one period each, and the nested price takes its period from the switch. Billing starts annual, which is not the
 * price's own default, so a rendering that ignored the state would show the other period.
 */
function billingDef(s: ProjectState, opts: { state?: Record<string, UiStateSchema>; extra?: (b: Parameters<ComponentSpec['build']>[0]) => string[] } = {}) {
  const price = priceDef(s);
  const def = addDef(s, {
    componentId: 'test.billing',
    name: 'Billing switch',
    properties: { title: P.str('Title', 'Plans') },
    parts: {},
    state: structuredClone(opts.state ?? { billing: BILLING, open: OPEN }),
    build: (b) => {
      const nested = makeInstance(price, {});
      nested.id = 'price';
      nested.variants = { period: uiState('billing') };
      b.nodes.price = nested;
      return b.el('root', 'section', {}, [
        b.text('title', 'h2', prop('title')),
        b.link('monthly-btn', NONE, 'Monthly', 'secondary', { name: 'Monthly', stateAction: { state: 'billing', op: 'set', value: 'monthly' } }),
        b.link('annual-btn', NONE, 'Annual', 'secondary', { name: 'Annual', stateAction: { state: 'billing', op: 'set', value: 'annual' } }),
        b.link('toggle-btn', NONE, 'Small print', 'text', { name: 'Toggle', stateAction: { state: 'open', op: 'toggle' } }),
        b.text('monthly-note', 'p', 'Billed monthly', { name: 'Monthly note', when: eq(uiState('billing'), 'monthly') }),
        b.text('annual-note', 'p', 'Billed yearly', { name: 'Annual note', when: eq(uiState('billing'), 'annual') }),
        b.text('details', 'p', 'Cancel any time', { name: 'Details', when: uiState('open') }),
        b.text('closed-note', 'p', 'Read the terms', { unless: uiState('open') }),
        'price',
        ...(opts.extra?.(b) ?? [])
      ]);
    }
  });
  return { def, price };
}

/** A design with no UI state yet, and nodes to give it to. */
function plainDef(s: ProjectState) {
  const price = priceDef(s);
  const def = addDef(s, {
    componentId: 'test.plain',
    name: 'Plain',
    properties: { title: P.str('Title', 'Plans'), tone: P.choice('Tone', 'calm', [['calm', 'Calm'], ['loud', 'Loud']]) },
    parts: {},
    build: (b) => {
      const nested = makeInstance(price, {});
      nested.id = 'price';
      b.nodes.price = nested;
      return b.el('root', 'section', {}, [b.text('title', 'h2', prop('title')), b.text('note', 'p', 'A note'), b.link('btn', NONE, 'Next', 'primary', { name: 'Next' }), 'price']);
    }
  });
  return { def, price };
}

const node = (s: ProjectState, def: ComponentDefinition, id: string) => s.components[def.id].tree!.nodes[id];

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe('UI state a component declares', () => {
  it('adds, changes and removes yes/no and choice state through operations', () => {
    const s = fresh();
    const { def } = plainDef(s);
    const setOpen: EditOperation = { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } };
    expect(validateOperation(setOpen).ok).toBe(true);
    let r = apply(s, [setOpen, { type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', label: 'Billing', options: ['monthly', { value: 'annual', label: 'Annual' }], initial: 'annual' } }]);
    expect(r.components[def.id].state).toEqual({
      open: { type: 'boolean', label: 'open', initial: false },
      billing: { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'monthly' }, { value: 'annual', label: 'Annual' }], initial: 'annual' }
    });
    // A choice without an initial value starts at its first option.
    r = apply(r, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', label: 'Plan period', options: ['annual', 'monthly'] } }]);
    expect(r.components[def.id].state!.billing).toMatchObject({ label: 'Plan period', initial: 'annual' });
    expect(errors(r)).toEqual([]);
    r = apply(r, [{ type: 'component.removeState', definitionId: def.id, state: 'open' }]);
    expect(Object.keys(r.components[def.id].state!)).toEqual(['billing']);
    r = apply(r, [{ type: 'component.removeState', definitionId: def.id, state: 'billing' }]);
    expect('state' in r.components[def.id]).toBe(false);
    expect(() => apply(r, [{ type: 'component.removeState', definitionId: def.id, state: 'billing' }])).toThrow(/has no UI state "billing"/);
  });

  it('refuses names, types and starting values state cannot have', () => {
    const s = fresh();
    const { def } = plainDef(s);
    const set = (state: string, schema: Record<string, unknown>) => () => apply(s, [{ type: 'component.setState', definitionId: def.id, state, schema } as EditOperation]);
    expect(set('Open', { type: 'boolean' })).toThrow(/camelCase/);
    expect(set('class', { type: 'boolean' })).toThrow(/reserved/);
    expect(set('prototype', { type: 'boolean' })).toThrow(/reserved/);
    expect(set('title', { type: 'boolean' })).toThrow(/already has a property "title"/);
    expect(set('tab', { type: 'enum', options: ['one'] })).toThrow(/2 to 50 options/);
    expect(set('tab', { type: 'enum', options: ['one', 'one'] })).toThrow(/listed twice/);
    expect(set('tab', { type: 'enum', options: ['one', 'two'], initial: 'three' })).toThrow(/starts as "three", which is not one of its options \("one", "two"\)/);
    expect(set('open', { type: 'boolean', initial: 'false' })).toThrow(/true or false/);
    expect(set('open', { type: 'boolean', options: ['a', 'b'] })).toThrow(/no options/);
    expect(set('count', { type: 'number' })).toThrow(/boolean or enum/);
    // A property may not take a state's name either: both become names in the component's code.
    const withOpen = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } }]);
    expect(() => apply(withOpen, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'open', schema: { type: 'boolean', label: 'Open' } }])).toThrow(/already has UI state "open"/);
    const many = Array.from({ length: 20 }, (_, i): EditOperation => ({ type: 'component.setState', definitionId: def.id, state: `flag${i}`, schema: { type: 'boolean' } }));
    const full = apply(s, many);
    expect(() => apply(full, [{ type: 'component.setState', definitionId: def.id, state: 'oneMore', schema: { type: 'boolean' } }])).toThrow(/at most 20/);
    // Changing one of the twenty is still allowed.
    expect(apply(full, [{ type: 'component.setState', definitionId: def.id, state: 'flag3', schema: { type: 'boolean', initial: true } }]).components[def.id].state!.flag3.initial).toBe(true);
  });

  it('belongs to project designs only: not to code components, and not to theme components until forked', () => {
    const s = fresh();
    const code = apply(s, [{ type: 'component.createCode', name: 'Widget', source: '<p>Hi</p>\n' }]);
    const codeId = Object.values(code.components).find((d) => d.name === 'Widget')!.id;
    expect(() => apply(code, [{ type: 'component.setState', definitionId: codeId, state: 'open', schema: { type: 'boolean' } }])).toThrow(/code component/);
    const theme = s.components[installComponent(s, 'features.grid')];
    expect(() => apply(s, [{ type: 'component.setState', definitionId: theme.id, state: 'open', schema: { type: 'boolean' } }])).toThrow(/belongs to the theme/);
  });
});

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

describe('conditions and variants that read UI state', () => {
  it('binds conditions to state with the same strict checks as properties', () => {
    const s = fresh();
    const { def } = plainDef(s);
    const r = apply(s, [
      { type: 'component.setState', definitionId: def.id, state: 'billing', schema: BILLING },
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'note', field: 'when', binding: { $state: 'billing' }, eq: 'annual' },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'unless', binding: { $state: 'open' } }
    ]);
    expect(node(r, def, 'note').when).toEqual({ ref: { $state: 'billing' }, eq: 'annual' });
    expect(node(r, def, 'title').unless).toEqual({ $state: 'open' });
    expect(errors(r)).toEqual([]);
    const bind = (op: Partial<Extract<EditOperation, { type: 'node.setBinding' }>>) => () => apply(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'note', field: 'when', binding: null, ...op } as EditOperation]);
    expect(bind({ binding: { $state: 'billing' }, eq: 'weekly' })).toThrow(/compares a choice with "weekly", which is not one of its options \("monthly", "annual"\)/);
    expect(bind({ binding: { $state: 'open' }, eq: 'true' })).toThrow(/compares a yes\/no state with "true"; compare it with true or false/);
    expect(bind({ binding: { $state: 'nope' } })).toThrow(/has no UI state "nope"/);
    expect(bind({ field: 'text', binding: { $state: 'billing' } })).toThrow(/cannot read UI state as its text/);
    // A value naming two sources is refused before it reaches the engine, not read as whichever comes first.
    expect(validateOperation({ type: 'node.setBinding', owner: owner(def), nodeId: 'note', field: 'when', binding: { $prop: 'title', $state: 'open' } }).ok).toBe(false);
    // The Inspector reads a state rule as it reads a property's.
    const d = r.components[def.id];
    expect(conditionSources(d, 'note').state.map((x) => x.key)).toEqual(['state:billing', 'state:open']);
    expect(readRule(d, d.tree!.nodes.note, 'when')).toMatchObject({ binding: { $state: 'billing' }, test: 'eq', value: 'annual', source: { key: 'state:billing' } });
    expect(describeConditions(d, d.tree!.nodes.note)).toEqual(['Show when Billing is Annual']);
  });

  it('chooses a nested variant from state whose options are all options of the axis, and keeps the option when unbound', () => {
    const s = fresh();
    const { def } = plainDef(s);
    let r = apply(s, [
      { type: 'component.setState', definitionId: def.id, state: 'billing', schema: BILLING },
      { type: 'component.setState', definitionId: def.id, state: 'size', schema: { type: 'enum', options: ['monthly', 'weekly'] } },
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } }
    ]);
    const variant = (binding: unknown) => () => apply(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'price', field: 'variant', axis: 'period', binding } as EditOperation]);
    expect(variant({ $state: 'size' })).toThrow(/options "weekly" are not options of "Price"/);
    expect(variant({ $state: 'open' })).toThrow(/A boolean state cannot be used as the variant/);
    r = variant({ $state: 'billing' })();
    expect((node(r, def, 'price') as InstanceNode).variants).toEqual({ period: { $state: 'billing' } });
    expect(errors(r)).toEqual([]);
    // Unbound, the placement keeps the option the state starts at.
    r = apply(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'price', field: 'variant', axis: 'period', binding: null }]);
    expect((node(r, def, 'price') as InstanceNode).variants).toEqual({ period: 'annual' });
  });

  it('keeps state in use: a removal or change that would leave a reader or a button behind is refused', () => {
    const s = fresh();
    const { def } = billingDef(s);
    expect(() => apply(s, [{ type: 'component.removeState', definitionId: def.id, state: 'billing' }])).toThrow(
      /"Billing" is still used by a nested component \(chooses a variant from it\), Monthly note \(shows only when it\), Annual note \(shows only when it\), Monthly \(changes it\), Annual \(changes it\)\. Unbind/
    );
    // A button alone keeps it in use.
    const tree = s.components[def.id].tree!;
    delete tree.nodes['monthly-note'].when;
    delete tree.nodes['annual-note'].when;
    delete (tree.nodes.price as InstanceNode).variants;
    delete (tree.nodes['annual-btn'] as LinkNode).stateAction;
    expect(() => apply(s, [{ type: 'component.removeState', definitionId: def.id, state: 'billing' }])).toThrow(/still used by Monthly \(changes it\)\. Unbind/);
    const t = fresh();
    const built = billingDef(t);
    const set = (state: string, schema: Record<string, unknown>) => () => apply(t, [{ type: 'component.setState', definitionId: built.def.id, state, schema } as EditOperation]);
    // The nested component cannot lose an option the state can choose.
    expect(() => apply(t, [{ type: 'component.removeVariant', definitionId: built.price.id, variant: 'annual', axis: 'period' }])).toThrow(/can choose the period "annual" through its "Billing" UI state/);
    // Relabelling or reordering keeps every reader.
    expect(errors(set('billing', { type: 'enum', label: 'Pay', options: ['annual', 'monthly'], initial: 'monthly' })())).toEqual([]);
    // Dropping an option the nested variant, a comparison or a button uses: each is enough to refuse it.
    const drop = set('billing', { type: 'enum', options: ['monthly', 'weekly'] });
    expect(drop).toThrow(/"billing" cannot change this way: a nested component takes its Period from a choice whose options "weekly" are not options of "Price"/);
    const tt = t.components[built.def.id].tree!;
    delete (tt.nodes.price as InstanceNode).variants;
    expect(drop).toThrow(/"billing" cannot change this way: Annual note compares a choice with "annual", which is not one of its options/);
    delete tt.nodes['annual-note'].when;
    expect(drop).toThrow(/"billing" cannot change this way: Annual sets "billing" to "annual", which is not one of its options/);
    delete (tt.nodes['annual-btn'] as LinkNode).stateAction;
    expect(drop).not.toThrow();
    // A yes/no state its button toggles cannot become a choice.
    expect(set('open', { type: 'enum', options: ['shut', 'ajar'] })).toThrow(/"open" cannot change this way: Toggle toggles the choice "open"/);
  });
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

describe('buttons that change UI state', () => {
  it('sets, toggles and steps state, keeps the button’s link, and refuses what does not fit', () => {
    const s = fresh();
    const { def } = plainDef(s);
    (s.components[def.id].tree!.nodes.btn as LinkNode).link = { type: 'anchor', target: 'plans' };
    const r = apply(s, [
      { type: 'component.setState', definitionId: def.id, state: 'billing', schema: BILLING },
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } }
    ]);
    const act = (action: unknown, nodeId = 'btn', o: { kind: 'component' | 'page'; id: string } = owner(def)) => () =>
      apply(r, [{ type: 'node.setStateAction', owner: o, nodeId, action } as EditOperation]);
    const next = act({ state: 'billing', op: 'next', wrap: true })();
    expect(node(next, def, 'btn')).toMatchObject({ stateAction: { state: 'billing', op: 'next', wrap: true }, link: { type: 'anchor', target: 'plans' } });
    expect(errors(next)).toEqual([]);
    expect((node(act({ state: 'open', op: 'toggle' })(), def, 'btn') as LinkNode).stateAction).toEqual({ state: 'open', op: 'toggle' });
    expect((node(act({ state: 'billing', op: 'set', value: 'monthly' })(), def, 'btn') as LinkNode).stateAction).toEqual({ state: 'billing', op: 'set', value: 'monthly' });
    expect((node(act({ state: 'open', op: 'set', value: true })(), def, 'btn') as LinkNode).stateAction).toEqual({ state: 'open', op: 'set', value: true });
    expect(act({ state: 'billing', op: 'toggle' })).toThrow(/toggles the choice "billing"/);
    expect(act({ state: 'open', op: 'prev' })).toThrow(/steps the yes\/no state "open" to its prev option/);
    expect(act({ state: 'billing', op: 'set', value: 'weekly' })).toThrow(/sets "billing" to "weekly", which is not one of its options/);
    expect(act({ state: 'open', op: 'set', value: 'yes' })).toThrow(/sets the yes\/no state "open" to "yes"; set it to true or false/);
    expect(act({ state: 'ghost', op: 'toggle' })).toThrow(/changes the UI state "ghost", which the component does not declare/);
    expect(act({ state: 'open', op: 'toggle' }, 'note')).toThrow(/not a button/);
    expect(act({ state: 'open', op: 'toggle' }, home(r).rootIds[0], { kind: 'page', id: home(r).id })).toThrow(/only inside a component's design/);
    // Cleared, the button keeps its link.
    const cleared = apply(next, [{ type: 'node.setStateAction', owner: owner(def), nodeId: 'btn', action: null }]);
    expect(node(cleared, def, 'btn')).not.toHaveProperty('stateAction');
    expect((node(cleared, def, 'btn') as LinkNode).link).toEqual({ type: 'anchor', target: 'plans' });
    // Each action takes only its own fields.
    const shaped = (action: unknown) => validateOperation({ type: 'node.setStateAction', owner: owner(def), nodeId: 'btn', action }).ok;
    expect(shaped({ state: 'billing', op: 'set', value: 'monthly', wrap: true })).toBe(false);
    expect(shaped({ state: 'open', op: 'toggle', value: true })).toBe(false);
    expect(shaped({ state: 'billing', op: 'next' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Load validation
// ---------------------------------------------------------------------------

describe('documents that declare, read and change UI state', () => {
  it('load without a problem when every read and change fits', () => {
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    expect(errors(s)).toEqual([]);
  });

  /** The blocking problems a hand edit to a placed billing switch brings in, as [code, node, message]. */
  function problems(edit: (s: ProjectState, def: ComponentDefinition) => void): Array<[string, string | undefined, string]> {
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    edit(s, s.components[def.id]);
    return errors(s).map((d) => [d.code, d.nodeId, d.message]);
  }
  const nodes = (def: ComponentDefinition) => def.tree!.nodes as Record<string, GraphNode & Record<string, unknown>>;

  it('reports reads of state the design lacks, of the wrong type, or where content belongs', () => {
    expect(problems((_, d) => (nodes(d).details.when = { $state: 'nope' }))).toEqual([['BINDING_INVALID', 'details', expect.stringMatching(/“Details” reads the UI state "nope", which the component does not declare/)]]);
    expect(problems((_, d) => (nodes(d).details.when = { ref: { $state: 'open' }, eq: 'true' }))).toEqual([['BINDING_INVALID', 'details', expect.stringMatching(/compares a yes\/no state with "true"/)]]);
    expect(problems((_, d) => (nodes(d)['annual-note'].when = { ref: { $state: 'billing' }, ne: 'weekly' }))).toEqual([['BINDING_INVALID', 'annual-note', expect.stringMatching(/not one of its options/)]]);
    expect(problems((_, d) => (nodes(d).title.text = { $state: 'billing' }))).toEqual([['BINDING_INVALID', 'title', expect.stringMatching(/reads the UI state "billing" as its text; only conditions and the variants of a nested component read UI state/)]]);
    expect(problems((_, d) => (nodes(d).price.variants = { period: { $state: 'open' } }))).toEqual([['BINDING_INVALID', 'price', expect.stringMatching(/shows a boolean state as its variant/)]]);
    // Two sources in one condition is not a condition.
    expect(problems((_, d) => (nodes(d).details.when = { $state: 'open', $prop: 'title' }))).toEqual([['BINDING_INVALID', 'details', expect.stringMatching(/neither a property, a list item field, UI state/)]]);
  });

  it('reports declarations and button actions that do not fit, once each', () => {
    // A damaged declaration is reported on its own, not again by everything that reads it.
    expect(problems((_, d) => ((d.state!.billing as { initial: string }).initial = 'weekly'))).toEqual([['STATE_INVALID', undefined, expect.stringMatching(/the UI state "billing" starts as "weekly", which is not one of its options/)]]);
    expect(problems((_, d) => ((d.state!.open as { initial: unknown }).initial = 'no'))).toEqual([['STATE_INVALID', undefined, expect.stringMatching(/a yes\/no state starts as true or false/)]]);
    expect(problems((_, d) => (d.state!.billing = { ...BILLING, options: [{ value: 'monthly', label: 'Monthly' }], initial: 'monthly' } as UiStateSchema))).toEqual([
      ['STATE_INVALID', undefined, expect.stringMatching(/needs 2 to 50 options/)]
    ]);
    expect(problems((_, d) => (d.state!.title = OPEN))).toEqual([['STATE_INVALID', undefined, expect.stringMatching(/"title" is both a property and UI state/)]]);
    expect(problems((_, d) => (nodes(d)['toggle-btn'].stateAction = { state: 'billing', op: 'toggle' }))).toEqual([['STATE_ACTION_INVALID', 'toggle-btn', expect.stringMatching(/toggles the choice "billing"/)]]);
    expect(problems((_, d) => (nodes(d)['monthly-btn'].stateAction = { state: 'billing', op: 'set', value: 'monthly', wrap: true }))).toEqual([
      ['STATE_ACTION_INVALID', 'monthly-btn', expect.stringMatching(/also says "wrap"/)]
    ]);
    expect(problems((_, d) => (nodes(d).title.stateAction = { state: 'open', op: 'toggle' }))).toEqual([['STATE_ACTION_INVALID', 'title', expect.stringMatching(/changes UI state, which only a button can/)]]);
  });

  it('keeps state to managed designs: a code component, a page or the shared header has none', () => {
    const s = fresh();
    const code = apply(s, [{ type: 'component.createCode', name: 'Widget', source: '<p>Hi</p>\n' }]);
    const widget = Object.values(code.components).find((d) => d.name === 'Widget')!;
    widget.state = { open: OPEN };
    expect(errors(code).map((d) => [d.code, d.message])).toEqual([['STATE_INVALID', expect.stringMatching(/a code component declares UI state/)]]);
    const page = fresh();
    const pageNode = home(page).nodes[home(page).rootIds[0]];
    pageNode.when = { $state: 'open' };
    expect(errors(page).map((d) => [d.code, d.message])).toEqual([['BINDING_SCOPE', expect.stringMatching(/UI state, which only an element inside a component definition can/)]]);
    const button = fresh();
    const id = 'n_trigger';
    home(button).nodes[id] = { id, kind: 'link', link: NONE, label: 'Open', appearance: 'primary', stateAction: { state: 'open', op: 'toggle' } };
    home(button).rootIds.push(id);
    expect(errors(button).map((d) => [d.code, d.message])).toEqual([['BINDING_SCOPE', expect.stringMatching(/changes UI state, which only a button inside a component definition can/)]]);
  });
});

// ---------------------------------------------------------------------------
// Card links
// ---------------------------------------------------------------------------

describe('state buttons inside cards that link', () => {
  it('refuses a button that changes state inside a card of the same design', () => {
    const s = fresh();
    const { def } = billingDef(s, { extra: (b) => [b.el('card', 'article', { link: { type: 'url', target: 'https://example.com/plans' } }, [b.link('card-btn', NONE, 'Switch', 'secondary', { stateAction: { state: 'open', op: 'toggle' } })])] });
    place(s, def);
    const found = errors(s);
    expect(found.map((d) => [d.code, d.nodeId])).toEqual([['CARD_LINK_INTERACTIVE', 'card']]);
    expect(found[0].message).toMatch(/Billing switch: a button that changes UI state sits inside a card that links somewhere/);
  });

  it('refuses a component with state buttons placed inside another design’s card, on that card', () => {
    const s = fresh();
    const { def: inner } = billingDef(s);
    const outer = addDef(s, {
      componentId: 'test.outer',
      name: 'Outer',
      properties: {},
      parts: {},
      build: (b) => {
        const nested = makeInstance(inner, {});
        nested.id = 'inner';
        b.nodes.inner = nested;
        return b.el('root', 'section', {}, [b.el('card', 'article', { link: { type: 'url', target: 'https://example.com' } }, ['inner'])]);
      }
    });
    place(s, outer);
    const found = errors(s);
    expect(found.map((d) => [d.code, d.owner?.id, d.nodeId])).toEqual([['CARD_LINK_INTERACTIVE', outer.id, 'card']]);
    expect(found[0].message).toMatch(/“Billing switch”, which holds the “Monthly” button/);
  });
});

// ---------------------------------------------------------------------------
// The generated site
// ---------------------------------------------------------------------------

describe('the generated site', () => {
  it('shows what the initial state shows, and the nested variant the state chooses', async () => {
    const s = fresh();
    const { def, price } = billingDef(s);
    place(s, def);
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const html = await renderHome(s);
    expect(html).toContain('Billed yearly');
    expect(html).not.toContain('Billed monthly');
    expect(html).toContain('Read the terms');
    expect(html).not.toContain('Cancel any time');
    const period = (p: string) => `so-${price.id.replace(/[^a-zA-Z0-9]/g, '-')}--period-${p}`;
    const priceRoot = openTag(html, nodeClass(price, 'price-root'));
    expect(priceRoot).toContain(period('annual'));
    expect(priceRoot).not.toContain(period('monthly'));
    // Starting monthly instead shows the other note and the price's own default.
    const monthly = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { ...BILLING, initial: 'monthly' } }]);
    const other = await renderHome(monthly);
    expect(other).toContain('Billed monthly');
    expect(other).not.toContain('Billed yearly');
    expect(openTag(other, nodeClass(price, 'price-root'))).toContain(period('monthly'));
  });

  it('decides the editor’s checks the way the site renders: a link behind state counts only while the state shows it', () => {
    const s = fresh();
    const { def } = billingDef(s, { extra: (b) => [b.link('jump', { type: 'anchor', target: 'nowhere' }, 'Compare', 'link', { when: eq(uiState('billing'), 'monthly') })] });
    place(s, def);
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    const monthly = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { ...BILLING, initial: 'monthly' } }]);
    expect(validateState(monthly).filter((d) => d.code === 'LINK_SECTION_MISSING')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Copies and conversions
// ---------------------------------------------------------------------------

describe('copies and conversions', () => {
  it('refuses to make a component of content that reads or changes the state around it', () => {
    const s = fresh();
    const { def } = billingDef(s);
    const create = (nodeId: string) => () => apply(s, [{ type: 'component.createFromNode', owner: owner(def), nodeId, name: 'Part' }]);
    expect(create('annual-note')).toThrow(/reads or changes the UI state of the component around it/);
    expect(create('monthly-btn')).toThrow(/reads or changes the UI state of the component around it/);
    // Content that uses no state still can, and the design is left as it was by the refusals.
    const made = create('title')();
    expect(errors(made)).toEqual([]);
    expect(s.components[def.id].tree!.nodes['annual-note'].when).toEqual({ ref: { $state: 'billing' }, eq: 'annual' });
  });

  it('refuses to convert a design with state to code, and gives a duplicate state of its own', () => {
    const s = fresh();
    const { def } = billingDef(s);
    const inst = place(s, def);
    expect(() => apply(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: home(s).id }, nodeId: inst.id }])).toThrow(/has UI state its buttons change, which a code copy would not keep/);
    const r = applyOperations(s, [{ type: 'component.duplicate', definitionId: def.id, name: 'Billing copy' }]);
    const copy = r.state.components[r.results[0].definitionId as string];
    expect(copy.state).toEqual(def.state);
    const changed = apply(r.state, [{ type: 'component.setState', definitionId: copy.id, state: 'open', schema: { type: 'boolean', initial: true } }]);
    expect(changed.components[copy.id].state!.open.initial).toBe(true);
    expect(changed.components[def.id].state!.open.initial).toBe(false);
    expect(errors(changed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Format and the assistant
// ---------------------------------------------------------------------------

describe('the document format and the assistant', () => {
  it('marks the format with a version-only step, so an older editor opens a project with state read-only', () => {
    expect(MIGRATIONS.at(-1)!.id).toBe('ui-state');
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    const docs = (p: ProjectState) => [p.manifest, p.site, p.tokens, p.assets, p.themeLock, ...Object.values(p.pages), ...Object.values(p.components)];
    for (const d of docs(s)) d.schemaVersion = SCHEMA_VERSION - 1;
    const out = migrateProject(s)!.state;
    expect(docs(out).every((d) => d.schemaVersion === SCHEMA_VERSION)).toBe(true);
    // Nothing else changes: state stays as written, and no component gains a state it did not have.
    expect(out.components[def.id].state).toEqual(def.state);
    expect(Object.values(out.components).filter((d) => 'state' in d).map((d) => d.id)).toEqual([def.id]);
    expect(errors(out)).toEqual([]);
  });

  it('classifies the state operations, but offers none to the assistant until generated buttons work', () => {
    const types = ['component.setState', 'component.removeState', 'node.setStateAction'] as const;
    for (const t of types) expect(Object.hasOwn(OPERATION_SCHEMAS, t) && OP_REACH[t]).toBeTruthy();
    const offered = JSON.stringify(toolDefinitions({ codeEnabled: true, definitionOps: true }).find((t) => t.name === 'apply_operations')!.parameters);
    expect(offered).toContain('component.setPropSchema');
    for (const t of types) expect(offered).not.toContain(t);
  });
});
