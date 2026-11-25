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
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import { REUSABILITY_CODES } from '@engine/reusability';
import { STATE_OFF_CLASS, defFile, generateProject, nodeClass } from '@generator/index';
import { notFoundSectionRoutes, publicationPlan, renderedContent } from '@generator/checks';
import { UTIL_JS } from '@generator/runtime-files';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { P, eq, prop, uiState, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { OPERATION_SCHEMAS, validateOperation } from '@shared/ops';
import { MIGRATIONS, migrateProject } from '@shared/migrations';
import { SCHEMA_VERSION } from '@shared/types';
import { OP_REACH } from '@agent/scope';
import { toolDefinitions } from '@agent/tools';
import { executeTool } from '@agent/tools';
import { startingVariants } from '@shared/variants';
import { conditionSources, describeConditions, readRule, ruleOp } from '../../src/renderer/src/lib/conditions';

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

/** Every compiler warning (accessibility ones included) for the generated files of these definitions. */
function compileWarnings(s: ProjectState, defs: ComponentDefinition[]): string[] {
  const out: string[] = [];
  const files = new Set(defs.map(defFile));
  for (const instrument of [false, true]) {
    for (const [path, source] of generateProject(s, { instrument })) {
      if (!files.has(path)) continue;
      for (const generate of ['server', 'client'] as const) out.push(...compile(source, { filename: path, generate, runes: true }).warnings.map((w) => `${path} (${generate}): ${w.code}`));
    }
  }
  return out;
}

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
    // A change that leaves out the starting value or the label keeps them while they still fit: relabelling a choice
    // never moves every placement to another option.
    r = apply(r, [
      { type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', options: ['weekly', 'monthly', 'annual'], initial: 'monthly' } },
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean', label: 'Open', initial: true } }
    ]);
    r = apply(r, [
      { type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', options: ['annual', 'weekly', 'monthly'] } },
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } }
    ]);
    expect(r.components[def.id].state!.billing).toMatchObject({ label: 'Plan period', initial: 'monthly' });
    expect(r.components[def.id].state!.open).toEqual({ type: 'boolean', label: 'Open', initial: true });
    // Without its old starting value among the options, a choice starts at its first.
    r = apply(r, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', options: ['weekly', 'annual'] } }]);
    expect(r.components[def.id].state!.billing.initial).toBe('weekly');
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
    expect(set('tab', { type: 'enum', options: Array.from({ length: 51 }, (_, i) => `o${i}`) })).toThrow(/2 to 50 options/);
    expect(set('tab', { type: 'enum', options: Array.from({ length: 50 }, (_, i) => `o${i}`) })).not.toThrow();
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
    // A fork carries the theme's state as its own.
    theme.state = { open: structuredClone(OPEN) };
    const forked = applyOperations(s, [{ type: 'component.fork', definitionId: theme.id }]);
    const copy = forked.results[0].definitionId as string;
    expect(copy).not.toBe(theme.id);
    const changed = apply(forked.state, [{ type: 'component.setState', definitionId: copy, state: 'open', schema: { type: 'boolean', initial: true } }]);
    expect(changed.components[copy].state!.open.initial).toBe(true);
    expect(changed.components[theme.id].state!.open.initial).toBe(false);
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
    // A rule the Inspector saves for state keeps its comparison.
    const saved = apply(r, [ruleOp(owner(def), 'title', 'when', { binding: { $state: 'billing' }, test: 'ne', value: 'monthly' })]);
    expect(node(saved, def, 'title').when).toEqual({ ref: { $state: 'billing' }, ne: 'monthly' });
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
    const startsMonthly = apply(r, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { ...BILLING, initial: 'monthly' } }]);
    r = apply(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'price', field: 'variant', axis: 'period', binding: null }]);
    expect((node(r, def, 'price') as InstanceNode).variants).toEqual({ period: 'annual' });
    const unboundMonthly = apply(startsMonthly, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'price', field: 'variant', axis: 'period', binding: null }]);
    expect((node(unboundMonthly, def, 'price') as InstanceNode).variants).toEqual({ period: 'monthly' });
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
    // A "hide when" alone keeps it in use too.
    delete tree.nodes.details.when;
    delete (tree.nodes['toggle-btn'] as LinkNode).stateAction;
    expect(() => apply(s, [{ type: 'component.removeState', definitionId: def.id, state: 'open' }])).toThrow(/"Open" is still used by a text element \(hides when it\)\. Unbind/);
    const t = fresh();
    const built = billingDef(t);
    const set = (state: string, schema: Record<string, unknown>) => () => apply(t, [{ type: 'component.setState', definitionId: built.def.id, state, schema } as EditOperation]);
    // The nested component cannot lose an option the state can choose.
    expect(() => apply(t, [{ type: 'component.removeVariant', definitionId: built.price.id, variant: 'annual', axis: 'period' }])).toThrow(/can choose the period "annual" through its "Billing" UI state/);
    expect(() => apply(t, [{ type: 'component.removeVariant', definitionId: built.price.id, variant: 'monthly', axis: 'period' }])).toThrow(/can choose the period "monthly" through its "Billing" UI state/);
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
    expect((node(act({ state: 'billing', op: 'prev', wrap: false })(), def, 'btn') as LinkNode).stateAction).toEqual({ state: 'billing', op: 'prev', wrap: false });
    expect(act({ state: 'billing', op: 'toggle' })).toThrow(/toggles the choice "billing"/);
    expect(act({ state: 'open', op: 'prev' })).toThrow(/steps the yes\/no state "open" to its prev option/);
    expect(act({ state: 'open', op: 'next' })).toThrow(/steps the yes\/no state "open" to its next option/);
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
    // The fixture holds every kind of read and change.
    const n = s.components[def.id].tree!.nodes;
    expect(Object.keys(s.components[def.id].state!)).toEqual(['billing', 'open']);
    expect([n['annual-note'].when, n.details.when, n['closed-note'].unless, (n.price as InstanceNode).variants]).toEqual([
      { ref: { $state: 'billing' }, eq: 'annual' },
      { $state: 'open' },
      { $state: 'open' },
      { period: { $state: 'billing' } }
    ]);
    expect((n['toggle-btn'] as LinkNode).stateAction).toEqual({ state: 'open', op: 'toggle' });
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
    expect(
      problems((_, d) => {
        d.state!.size = { type: 'enum', label: 'Size', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }], initial: 'monthly' };
        nodes(d).price.variants = { period: { $state: 'size' } };
      })
    ).toEqual([['BINDING_INVALID', 'price', expect.stringMatching(/options "weekly" are not options of "Price"/)]]);
    // A read of state that also names a property is neither, wherever it is.
    expect(problems((_, d) => (nodes(d).price.variants = { period: { $prop: 'title', $state: 'billing' } }))).toEqual([['BINDING_INVALID', 'price', expect.stringMatching(/reads UI state and something else at once/)]]);
    // A comparison has no place on a variant: it would be silently dropped.
    expect(problems((_, d) => (nodes(d).price.variants = { period: { $state: 'billing', eq: 'annual' } as never }))).toEqual([['BINDING_INVALID', 'price', expect.stringMatching(/reads UI state and something else at once/)]]);
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
    expect(problems((_, d) => ((d.state!.billing as { options: unknown[] }).options = [{ value: 'annual', label: 'A' }, { value: 'annual', label: 'B' }]))).toEqual([
      ['STATE_INVALID', undefined, expect.stringMatching(/lists the option "annual" twice/)]
    ]);
    expect(problems((_, d) => (d.state = null as never))).toEqual([['STATE_INVALID', undefined, expect.stringMatching(/its UI state is not in the expected form/)]]);
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
    // A read and an action on one button are two problems, so an action added beside a read is new.
    const before = validateState(button);
    home(button).nodes[id].when = { $state: 'open' };
    const read = validateState(button);
    delete (home(button).nodes[id] as LinkNode).stateAction;
    const readOnly = validateState(button);
    expect(introducedDiagnostics(readOnly, read).map((d) => d.code)).toEqual(['BINDING_SCOPE']);
    expect(introducedDiagnostics(before, read).map((d) => d.code)).toEqual(['BINDING_SCOPE']);
    // The shared header has no state either.
    const shell = fresh();
    const header = shell.site.shell.header;
    header.nodes[header.rootIds[0]].when = { $state: 'open' };
    expect(errors(shell).map((d) => [d.code, d.owner])).toEqual([['BINDING_SCOPE', { kind: 'shell', id: 'header' }]]);
  });
});

// ---------------------------------------------------------------------------
// Card links
// ---------------------------------------------------------------------------

describe('state buttons inside cards that link', () => {
  it('refuses a button that changes state inside a card of the same design', () => {
    const s = fresh();
    const { def } = billingDef(s, { extra: (b) => [b.el('card', 'article', { link: { type: 'url', target: 'https://example.com/plans' } }, [b.link('card-btn', NONE, 'Switch', 'secondary', { stateAction: { state: 'billing', op: 'set', value: 'monthly' } })])] });
    place(s, def);
    const found = errors(s);
    expect(found.map((d) => [d.code, d.nodeId])).toEqual([['CARD_LINK_INTERACTIVE', 'card']]);
    expect(found[0].message).toMatch(/Billing switch: a button that changes UI state sits inside a card that links somewhere/);
  });

  it('tells two broken cards apart, and keeps a broken card the same problem when its button changes', () => {
    const card = (b: Parameters<ComponentSpec['build']>[0], id: string) =>
      b.el(id, 'article', { link: { type: 'url', target: `https://example.com/${id}` } }, [b.link(`${id}-btn`, NONE, 'Switch', 'secondary', { stateAction: { state: 'open', op: 'toggle' } })]);
    const s = fresh();
    const { def } = billingDef(s, { extra: (b) => [card(b, 'card-a'), card(b, 'card-b')] });
    place(s, def);
    const both = validateState(s);
    const tree = s.components[def.id].tree!;
    const root = tree.nodes[tree.rootIds[0]] as GraphNode & { children: string[] };
    root.children = root.children.filter((c) => c !== 'card-b');
    delete tree.nodes['card-b'];
    delete tree.nodes['card-b-btn'];
    const one = validateState(s);
    // The cards' fixed label and link are also flagged as design content every placement shares; that is not this test's subject.
    const cardProblems = (before: Diagnostic[], after: Diagnostic[]) => introducedDiagnostics(before, after).filter((d) => !REUSABILITY_CODES.has(d.code));
    expect(cardProblems(one, both).map((d) => [d.code, d.nodeId])).toEqual([['CARD_LINK_INTERACTIVE', 'card-b']]);
    // Without its action the button is still a control in the card: the same problem, not a new one. It is now also a
    // button with nowhere to go, which the site leaves out, where its action made it a real button.
    delete (tree.nodes['card-a-btn'] as LinkNode).stateAction;
    const actionless = introducedDiagnostics(one, validateState(s));
    expect(actionless.filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([]);
    expect(validateState(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE').map((d) => d.nodeId)).toEqual(['card-a']);
    expect(actionless.map((d) => [d.code, d.message])).toEqual([['BUTTON_UNLINKED', expect.stringMatching(/the “Switch” button has no link/)]]);
  });

  it('keeps a placement whose content sits in several cards one problem while those cards are repaired one by one', () => {
    const s = fresh();
    const twin = addDef(s, {
      componentId: 'test.twin',
      name: 'Twin cards',
      properties: {},
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) =>
        b.el('t-root', 'section', {}, [
          b.el('t-a', 'article', { link: { type: 'url', target: 'https://example.com/a' } }, [b.slot('t-slot-a', 'extra')]),
          b.el('t-b', 'article', { link: { type: 'url', target: 'https://example.com/b' } }, [b.slot('t-slot-b', 'extra')])
        ])
    });
    const inst = place(s, twin);
    const id = 'n_extrabtn';
    home(s).nodes[id] = { id, kind: 'link', link: { type: 'url', target: 'https://example.com/more' }, label: 'More', appearance: 'primary' };
    inst.slots = { extra: [id] };
    const broken = validateState(s);
    expect(broken.filter((d) => d.code === 'CARD_LINK_INTERACTIVE').map((d) => d.nodeId)).toEqual([inst.id]);
    delete (s.components[twin.id].tree!.nodes['t-a'] as { link?: unknown }).link;
    const fewer = validateState(s);
    expect(fewer.filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toHaveLength(1);
    expect(introducedDiagnostics(broken, fewer)).toEqual([]);
  });

  it('refuses a component with state buttons placed inside another design’s card, on that card', () => {
    const s = fresh();
    // Its one button changes state and nothing else: it is what makes the design interactive.
    const inner = addDef(s, {
      componentId: 'test.disclosure',
      name: 'Disclosure',
      properties: {},
      parts: {},
      state: { open: structuredClone(OPEN) },
      build: (b) => b.el('d-root', 'div', {}, [b.link('d-btn', NONE, 'More', 'text', { stateAction: { state: 'open', op: 'toggle' } }), b.text('d-body', 'p', 'Details', { when: uiState('open') })])
    });
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
    expect(found[0].message).toMatch(/“Disclosure”, which holds a button that changes UI state/);
    // Without its action, the button is an ordinary one that goes nowhere: still a control inside the card.
    delete (s.components[inner.id].tree!.nodes['d-btn'] as LinkNode).stateAction;
    expect(errors(s)[0].message).toMatch(/“Disclosure”, which holds a button or link/);
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
    // The small print its button discloses is in the page, hidden on screen until the button opens it.
    expect(openTag(html, nodeClass(def, 'details'))).toContain(STATE_OFF_CLASS);
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
    // A yes/no state that starts on shows what it guards and hides what it guards against.
    const open = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean', label: 'Open', initial: true } }]);
    const shown = await renderHome(open);
    expect(shown).toContain('Cancel any time');
    expect(shown).not.toContain('Read the terms');
  });

  it('chooses the option a state starts at for readers of a placement’s styles', () => {
    const s = fresh();
    const { def } = billingDef(s);
    const variants = (s.components[def.id].tree!.nodes.price as InstanceNode).variants;
    expect(startingVariants(variants, s.components[def.id])).toEqual({ period: 'annual' });
    // A state the design does not declare, or a choice bound to a property, stays bound.
    expect(startingVariants({ period: { $state: 'nope' }, tone: { $prop: 'tone' } }, s.components[def.id])).toEqual({ period: { $state: 'nope' }, tone: { $prop: 'tone' } });
    expect(startingVariants(variants, undefined)).toBe(variants);
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
// Generated buttons, tabs and disclosures (#376)
// ---------------------------------------------------------------------------

const PLAN: UiStateSchema = { type: 'enum', label: 'Plan', options: [{ value: 'a', label: 'Starter' }, { value: 'b', label: 'Team' }, { value: 'c', label: 'Studio' }], initial: 'b' };

/**
 * A tab list over a three-option choice that starts on its middle option, with the tabs in another order than the
 * options (so the keyboard follows the page and Next follows the options), each with a grid panel; a disclosure whose
 * content sits in a collapsing wrapper; and a Next button.
 */
function tabsDef(
  s: ProjectState,
  opts: {
    panelTag?: 'div' | 'section';
    tabs?: Array<'a' | 'b' | 'c'>;
    extra?: (b: Parameters<ComponentSpec['build']>[0]) => string[];
    panelExtra?: (b: Parameters<ComponentSpec['build']>[0]) => string[];
    properties?: ComponentSpec['properties'];
    listLabel?: string | { $prop: string };
    panelAnchor?: string;
  } = {}
) {
  const tabs = opts.tabs ?? ['a', 'c', 'b'];
  const appearance = { a: 'secondary', b: 'link', c: 'plain' } as const;
  const label = { a: 'Starter', b: 'Team', c: 'Studio' } as const;
  return addDef(s, {
    componentId: 'test.tabs',
    name: 'Plan tabs',
    properties: opts.properties ?? {},
    parts: {},
    state: structuredClone({ plan: PLAN, open: OPEN }),
    build: (b) =>
      b.el('root', 'section', {}, [
        b.el('list', 'div', opts.listLabel !== undefined ? { ariaLabel: opts.listLabel } : {}, tabs.map((v) => b.link(`tab-${v}`, NONE, label[v], appearance[v], { stateAction: { state: 'plan', op: 'set', value: v } }))),
        ...(['a', 'b', 'c'] as const).map((v) =>
          b.el(`panel-${v}`, opts.panelTag ?? 'div', { when: eq(uiState('plan'), v), styles: { layout: 'grid' }, ...(v === 'a' && opts.panelAnchor ? { anchor: opts.panelAnchor } : {}) }, [b.text(`text-${v}`, 'p', `${label[v]} plan details`), ...(v === 'a' ? (opts.panelExtra?.(b) ?? []) : [])])
        ),
        b.link('next', NONE, 'Next plan', 'text', { stateAction: { state: 'plan', op: 'next', wrap: true } }),
        b.link('prev', NONE, 'Previous plan', 'text', { stateAction: { state: 'plan', op: 'prev' } }),
        b.link('more', NONE, 'More', 'secondary', { stateAction: { state: 'open', op: 'toggle' } }),
        b.el('wrap', 'div', { collapseEmpty: true }, [b.el('details', 'div', { when: uiState('open') }, [b.text('details-text', 'p', 'Cancel any time')])]),
        ...(opts.extra?.(b) ?? [])
      ])
  });
}

/** Every opening tag in the html carrying this attribute set to this value (any value when it is undefined). */
const tagsWith = (html: string, attr: string, value?: string) => [...html.matchAll(new RegExp(`<[a-z0-9]+\\b[^>]*\\s${attr}="${value ?? '[^"]*'}"[^>]*>`, 'g'))].map((m) => m[0]);
const attrOf = (tag: string, attr: string) => new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1];

describe('generated buttons, tabs and disclosures', () => {
  it('holds each placement’s state in a $state rune that its buttons change', () => {
    const s = fresh();
    const def = tabsDef(s);
    place(s, def);
    const source = generateProject(s).get(defFile(def))!;
    expect(source).toContain('let so_state_open = $state(false);');
    expect(source).toContain('let so_state_plan = $state("b");');
    expect(source).toContain('onclick={() => (so_state_plan = "a")}');
    expect(source).toContain('onclick={() => (so_state_open = !so_state_open)}');
    expect(source).toContain('onclick={() => (so_state_plan = stepState(["a","b","c"], so_state_plan, 1, true))}');
    expect(source).toContain('onclick={() => (so_state_plan = stepState(["a","b","c"], so_state_plan, -1, false))}');
    // Nothing of the editor's: no Builder runtime, only the site's own helpers.
    expect(source).not.toMatch(/data-so-|__so/);
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    expect(compileWarnings(s, [def])).toEqual([]);
  });

  it('still generates a design whose declaration a hand edit damaged: its buttons do nothing, its reads stay put', () => {
    const s = fresh();
    const { def } = billingDef(s);
    (s.components[def.id].state!.billing as { initial: string }).initial = 'weekly';
    place(s, def);
    const source = generateProject(s).get(defFile(def))!;
    expect(source).not.toContain('so_state_billing');
    // Its reads show the value written, and its buttons are left without an action.
    expect(source).toContain('{#if "weekly" === "annual"}');
    expect(source).not.toMatch(/onclick=\{\(\) => \(so_state_billing/);
    expect(source).toContain('let so_state_open = $state(false);');
    expect(compileErrors(s)).toEqual([]);
  });

  it('compiles a design whose properties are named like its own helpers or like Svelte runes', async () => {
    const s = fresh();
    const def = tabsDef(s, { properties: { state: P.str('State', 'Ready'), tabKey: P.str('Tab key', 'k'), props: P.str('Props', 'p'), derived: P.str('Derived', 'd') }, extra: (b) => [b.text('note', 'p', prop('state'))] });
    place(s, def);
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    expect(compileWarnings(s, [def])).toEqual([]);
    expect(await renderHome(s)).toContain('>Ready</p>');
  });

  it('keeps content in the page beside a list in a collapsing wrapper, which it hides on screen with it', async () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.rows',
      name: 'Rows',
      properties: { rows: P.list('Rows', 'Row', { label: P.str('Label', '') }, []) },
      parts: {},
      state: structuredClone({ open: OPEN }),
      build: (b) =>
        b.el('root', 'section', {}, [
          b.link('more', NONE, 'More', 'secondary', { stateAction: { state: 'open', op: 'toggle' } }),
          b.el('wrap', 'div', { collapseEmpty: true }, [
            // A comparison needs no helper of its own: the list's test is the only use of `has`.
            b.el('details', 'div', { when: eq(uiState('open'), true) }, [b.text('details-text', 'p', 'Cancel any time')]),
            b.repeat('rows', 'rows', [b.text('row', 'p', { $item: 'label' })])
          ])
        ])
    });
    place(s, def);
    expect(compileErrors(s)).toEqual([]);
    const html = await renderHome(s);
    expect(html).toContain('Cancel any time');
    expect(openTag(html, nodeClass(def, 'wrap'))).toContain(STATE_OFF_CLASS);
  });

  it('names a panel with content of its own, and leaves a tab list alone when it cannot name its parts safely', async () => {
    // A plain paragraph is a disclosure's content as well as a container is.
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    const html = await renderHome(s);
    const [toggle] = tagsWith(html, 'aria-expanded');
    const details = openTag(html, nodeClass(def, 'details'));
    expect(details).toMatch(/^<p\b/);
    expect(attrOf(details, 'id')).toBe(attrOf(toggle, 'aria-controls'));
    expect(details).toContain(STATE_OFF_CLASS);
    expect(html).toContain('Cancel any time');
    // A panel with an anchor, which every placement would share, makes no tab list.
    const t = fresh();
    place(t, tabsDef(t, { panelAnchor: 'starter' }));
    const out = await renderHome(t);
    expect(tagsWith(out, 'role', 'tablist')).toEqual([]);
    expect(tagsWith(out, 'aria-pressed')).toHaveLength(3);
  });

  it('names a tab list by its own label, or by its state’s while a bound label is left blank', async () => {
    const s = fresh();
    const def = tabsDef(s, { properties: { listName: P.str('List name', '') }, listLabel: { $prop: 'listName' } });
    place(s, def);
    place(s, def, { listName: 'Choose a plan' });
    expect(compileWarnings(s, [def])).toEqual([]);
    expect(tagsWith(await renderHome(s), 'role', 'tablist').map((t) => attrOf(t, 'aria-label'))).toEqual(['Plan', 'Choose a plan']);
  });

  it('checks what kept panels put in the page, as the site’s build does, and what a visitor sees at first', async () => {
    const s = fresh();
    // A jump to a section the page lacks, inside the panel of a tab not chosen at first: the build would stop on it.
    const def = tabsDef(s, { panelExtra: (b) => [b.link('jump', { type: 'anchor', target: 'nowhere' }, 'Compare', 'link')] });
    place(s, def);
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING').map((d) => d.nodeId)).toHaveLength(1);
    // A section inside that hidden panel is in the HTML, but a jump to it from outside lands on nothing to see.
    const t = fresh();
    const hidden = tabsDef(t, { panelExtra: (b) => [b.text('terms', 'p', 'Starter terms', { anchor: 'starter-terms' })], extra: (b) => [b.link('to-terms', { type: 'anchor', target: 'starter-terms' }, 'Terms', 'link')] });
    place(t, hidden);
    expect(await renderHome(t)).toContain('id="starter-terms"');
    expect(validateState(t).filter((d) => d.code === 'LINK_SECTION_MISSING')).toHaveLength(1);
    // Chosen at first, the section shows and the jump is fine.
    const shown = apply(t, [{ type: 'component.setState', definitionId: hidden.id, state: 'plan', schema: { ...PLAN, initial: 'a' } }]);
    expect(validateState(shown).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    // A jump within that hidden panel shows with its section, so it is fine too.
    const u = fresh();
    place(u, tabsDef(u, { panelExtra: (b) => [b.text('terms', 'p', 'Starter terms', { anchor: 'starter-terms' }), b.link('to-terms', { type: 'anchor', target: 'starter-terms' }, 'Terms', 'link')] }));
    expect(validateState(u).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
  });

  /** A closed disclosure over a summary that jumps to the terms beside it, which carry an anchor. */
  function termsDef(s: ProjectState) {
    return addDef(s, {
      componentId: 'test.terms',
      name: 'Terms',
      properties: {},
      parts: {},
      state: structuredClone({ open: OPEN }),
      build: (b) =>
        b.el('root', 'section', {}, [
          b.link('more', NONE, 'More', 'secondary', { stateAction: { state: 'open', op: 'toggle' } }),
          b.el('summary', 'div', { when: uiState('open') }, [b.link('to-terms', { type: 'anchor', target: 'terms' }, 'See the terms', 'link')]),
          b.el('terms', 'div', { when: uiState('open'), anchor: 'terms' }, [b.text('terms-text', 'p', 'The terms')])
        ])
    });
  }

  it('keeps all of a disclosure’s content in the page, so a jump from one part to another works when it opens', async () => {
    const s = fresh();
    const def = termsDef(s);
    place(s, def);
    expect(compileErrors(s)).toEqual([]);
    const html = await renderHome(s);
    expect(html).toContain('href="#terms"');
    const terms = openTag(html, nodeClass(def, 'terms'));
    expect(attrOf(terms, 'id')).toBe('terms');
    expect(terms).toContain(STATE_OFF_CLASS);
    // The button names only the content without an anchor of its own: an anchor every placement would share.
    const [toggle] = tagsWith(html, 'aria-expanded');
    expect(attrOf(toggle, 'aria-controls')).toBe(attrOf(openTag(html, nodeClass(def, 'summary')), 'id'));
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
  });

  it('follows kept panels where a page’s HTML is copied or served: a copied page’s jumps, the not-found page’s', () => {
    const s = fresh();
    place(s, termsDef(s));
    const jump = { id: 'n_jumpterm', kind: 'link', link: { type: 'page', target: home(s).id, anchor: 'terms' }, label: 'Terms', appearance: 'link' } as GraphNode;
    home(s).nodes[jump.id] = jump;
    home(s).rootIds.push(jump.id);
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: home(s).id }]);
    const copy = r.state.pages[r.results[0].pageId as string];
    const copied = Object.values(copy.nodes).filter((n): n is LinkNode => n.kind === 'link' && n.label === 'Terms');
    expect(copied.map((n) => n.link)).toEqual([{ type: 'page', target: copy.id, anchor: 'terms' }]);
    // A jump in a panel the shared header keeps hidden is served on the not-found page, which sends it to its section.
    const h = fresh();
    const header = h.site.shell.header;
    const inHeader = makeInstance(tabsDef(h, { panelExtra: (b) => [b.link('to-pricing', { type: 'anchor', target: 'pricing' }, 'Pricing', 'link')] }), {});
    header.nodes[inHeader.id] = inHeader;
    header.rootIds.push(inHeader.id);
    home(h).nodes[home(h).rootIds[0]].anchor = 'pricing';
    expect(notFoundSectionRoutes(h)).toMatchObject({ pricing: home(h).route });
  });

  it('renders a tab list whose tabs and panels name each other in every placement, every panel in the page', async () => {
    const s = fresh();
    const def = tabsDef(s);
    place(s, def);
    place(s, def);
    const html = await renderHome(s);
    const lists = tagsWith(html, 'role', 'tablist');
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(attrOf(list, 'aria-label')).toBe('Plan');
    const tabs = tagsWith(html, 'role', 'tab');
    const panels = tagsWith(html, 'role', 'tabpanel');
    expect(tabs).toHaveLength(6);
    expect(panels).toHaveLength(6);
    for (const tab of tabs) expect(tab).toMatch(/^<button\b[^>]*\stype="button"/);
    // Each placement chooses Team at first: one tab selected and in the tab order, the others reached by arrows.
    expect(tabs.map((t) => [attrOf(t, 'aria-selected'), attrOf(t, 'tabindex')])).toEqual([...Array(2)].flatMap(() => [['false', '-1'], ['false', '-1'], ['true', '0']]));
    // Every reference finds exactly one element, and no ID is used twice on the page.
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of tabs) {
      const panel = panels.find((p) => attrOf(p, 'id') === attrOf(tab, 'aria-controls'))!;
      expect(panel).toBeTruthy();
      expect(attrOf(panel, 'aria-labelledby')).toBe(attrOf(tab, 'id'));
      expect(attrOf(panel, 'tabindex')).toBe('0');
      // Only the chosen tab's panel shows on screen; the others are in the page, hidden until printed.
      expect(attrOf(panel, 'class')!.split(' ').includes(STATE_OFF_CLASS)).toBe(attrOf(tab, 'aria-selected') === 'false');
    }
    expect(panels.map((p) => attrOf(p, 'data-tab-label'))).toEqual([...Array(2)].flatMap(() => ['Starter', 'Team', 'Studio']));
    for (const words of ['Starter plan details', 'Team plan details', 'Studio plan details']) expect(html.split(words)).toHaveLength(3);
  });

  it('renders a disclosure that says whether it is expanded, its closed content in the page and hidden on screen', async () => {
    const s = fresh();
    const def = tabsDef(s);
    place(s, def);
    const html = await renderHome(s);
    const [more] = tagsWith(html, 'aria-expanded');
    expect(more).toMatch(/^<button\b[^>]*\stype="button"/);
    expect(attrOf(more, 'aria-expanded')).toBe('false');
    const details = openTag(html, nodeClass(def, 'details'));
    expect(attrOf(details, 'id')).toBe(attrOf(more, 'aria-controls'));
    expect(details).toContain(STATE_OFF_CLASS);
    expect(html).toContain('Cancel any time');
    // The collapsing wrapper stays for the content it holds, and hides on screen with it.
    expect(openTag(html, nodeClass(def, 'wrap'))).toContain(STATE_OFF_CLASS);
    // Opened at first, nothing is hidden.
    const open = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'open', schema: { ...OPEN, initial: true } }]);
    const shown = await renderHome(open);
    expect(attrOf(tagsWith(shown, 'aria-expanded')[0], 'aria-expanded')).toBe('true');
    expect(openTag(shown, nodeClass(def, 'details'))).not.toContain(STATE_OFF_CLASS);
    expect(openTag(shown, nodeClass(def, 'wrap'))).not.toContain(STATE_OFF_CLASS);
  });

  it('falls back to buttons that say whether they are pressed where the shape is not a tab list or disclosure', async () => {
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    const html = await renderHome(s);
    expect(tagsWith(html, 'role', 'tablist')).toEqual([]);
    // The billing buttons share their row with the title and notes: they are real buttons the site shows, saying which
    // choice is on, and the notes stay plain conditions.
    const pressed = tagsWith(html, 'aria-pressed');
    expect(pressed.map((t) => [t.slice(0, 7), attrOf(t, 'aria-pressed')])).toEqual([['<button', 'false'], ['<button', 'true']]);
    for (const t of pressed) expect(t).toContain('type="button"');
    expect(html).not.toContain('Billed monthly');
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    // A missing tab (a choice the list cannot reach) or a panel that is not a plain container makes no tab list either.
    for (const variant of [{ tabs: ['a', 'b'] as Array<'a' | 'b' | 'c'> }, { panelTag: 'section' as const }]) {
      const t = fresh();
      const tabsOnly = tabsDef(t, variant);
      place(t, tabsOnly);
      const out = await renderHome(t);
      expect(tagsWith(out, 'role', 'tablist')).toEqual([]);
      expect(tagsWith(out, 'role', 'tabpanel')).toEqual([]);
      expect(tagsWith(out, 'aria-pressed')).toHaveLength(variant.tabs?.length ?? 3);
      expect(out).toContain('Team plan details');
      expect(out).not.toContain('Starter plan details');
      expect(compileWarnings(t, [tabsOnly])).toEqual([]);
    }
  });

  it('keeps a button that also goes somewhere a link, which changes the state as it goes', async () => {
    const s = fresh();
    const { def } = plainDef(s);
    const r = apply(s, [
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean' } },
      { type: 'node.setStateAction', owner: owner(def), nodeId: 'btn', action: { state: 'open', op: 'toggle' } }
    ]);
    (r.components[def.id].tree!.nodes.btn as LinkNode).link = { type: 'url', target: 'https://example.com/plans' };
    place(r, r.components[def.id]);
    const source = generateProject(r).get(defFile(def))!;
    expect(source).toContain('onclick={() => (so_state_open = !so_state_open)}');
    const html = await renderHome(r);
    const link = openTag(html, nodeClass(def, 'btn'));
    expect(link).toMatch(/^<a\b[^>]*href="https:\/\/example\.com\/plans"/);
    expect(link).not.toMatch(/aria-(pressed|expanded)/);
  });

  it('treats a state button as one the site shows, and checks links a visitor reaches by changing state', () => {
    const plan = apply(fresh(), [{ type: 'page.create', pageId: 'pg_draft001', title: 'Soon', route: '/soon/' }, { type: 'page.update', pageId: 'pg_draft001', draft: true }]);
    // A link to the draft inside the panel of a tab not chosen at first.
    const def = tabsDef(plan, { panelExtra: (b) => [b.link('soon', { type: 'page', target: 'pg_draft001' }, 'Coming soon', 'link')] });
    place(plan, def);
    expect(validateState(plan).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    const words = renderedContent(plan, home(plan)).filter((c) => c.kind === 'text').map((c) => c.value);
    expect(words).toEqual(expect.arrayContaining(['Starter', 'Team', 'Studio', 'Next plan', 'More']));
    expect(publicationPlan(plan).draftLinks.map((l) => l.label)).toEqual(['Coming soon']);
  });

  it('steps a choice through its options in order, staying at the ends unless it wraps', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(join(resolve('.tmp'), 'ui-state-util-'));
    roots.push(dir);
    writeFileSync(join(dir, 'util.mjs'), UTIL_JS);
    const { stepState } = (await import(/* @vite-ignore */ join(dir, 'util.mjs'))) as { stepState: (o: string[], v: string, by: number, wrap: boolean) => string };
    const o = ['a', 'b', 'c'];
    expect([stepState(o, 'a', 1, false), stepState(o, 'c', 1, false), stepState(o, 'a', -1, false), stepState(o, 'b', -1, false)]).toEqual(['b', 'c', 'a', 'a']);
    expect([stepState(o, 'c', 1, true), stepState(o, 'a', -1, true)]).toEqual(['a', 'c']);
    expect([stepState(o, 'gone', 1, true), stepState(o, 'gone', -1, true), stepState(o, 'gone', -1, false)]).toEqual(['a', 'a', 'a']);
  });

  it('hides content a state hides on screen only, and prints every panel under its tab’s label', () => {
    const s = fresh();
    const plain = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(plain).not.toContain(STATE_OFF_CLASS);
    tabsDef(s);
    const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toMatch(new RegExp(`@media not print \\{\\s*\\.${STATE_OFF_CLASS}:not\\(#so-print\\) \\{ display: none !important; \\}`));
    const print = FOUNDATION_BASE_CSS.slice(FOUNDATION_BASE_CSS.indexOf('@media print'));
    expect(print).toContain('.so-tablist:not(#so-print) { display: none !important; }');
    expect(print).toContain("[role='tabpanel'][data-tab-label]:not([data-tab-label=''])::before");
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
    expect(create('price')).toThrow(/reads or changes the UI state of the component around it/);
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
    expect(copy.state!.billing).not.toBe(r.state.components[def.id].state!.billing);
    expect((copy.state!.billing as { options: unknown[] }).options).not.toBe((r.state.components[def.id].state!.billing as { options: unknown[] }).options);
    expect((copy.tree!.nodes['monthly-btn'] as LinkNode).stateAction).toEqual({ state: 'billing', op: 'set', value: 'monthly' });
    const changed = apply(r.state, [{ type: 'component.setState', definitionId: copy.id, state: 'open', schema: { type: 'boolean', initial: true } }]);
    expect(changed.components[copy.id].state!.open.initial).toBe(true);
    expect(changed.components[def.id].state!.open.initial).toBe(false);
    expect(errors(changed)).toEqual([]);
  });

  it('converts a design whose state map is empty, leaving the map out of the code copy', () => {
    const s = fresh();
    const { def } = plainDef(s);
    s.components[def.id].state = {};
    const inst = place(s, def);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: home(s).id }, nodeId: inst.id }]);
    const code = r.state.components[r.results[0].definitionId as string];
    expect(code.kind).toBe('code');
    expect('state' in code).toBe(false);
    expect(errors(r.state).filter((d) => d.code === 'STATE_INVALID')).toEqual([]);
  });

  it('unbinds state a hand edit put where content belongs, leaving the value it starts at', () => {
    const s = fresh();
    const { def } = billingDef(s);
    s.components[def.id].tree!.nodes.title = { ...s.components[def.id].tree!.nodes.title, text: { $state: 'billing' } } as unknown as GraphNode;
    const r = apply(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'text', binding: null }]);
    expect((node(r, def, 'title') as { text: unknown }).text).toBe('annual');
    expect(errors(r)).toEqual([]);
  });

  it('refuses an edit that leans on a damaged declaration, until it is declared again', () => {
    const s = fresh();
    const { def, price } = billingDef(s);
    (s.components[def.id].state!.billing as { initial: string }).initial = 'weekly';
    expect(() => apply(s, [{ type: 'node.setStateAction', owner: owner(def), nodeId: 'toggle-btn', action: { state: 'billing', op: 'toggle' } }])).toThrow(/"billing" of "Billing switch" is damaged/);
    expect(() => apply(s, [{ type: 'component.removeVariant', definitionId: price.id, variant: 'annual', axis: 'period' }])).toThrow(/UI state "billing", which is damaged/);
    // Declared again, it is whole, and keeps the label it had: the edits it guards are judged as usual.
    const repaired = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'billing', schema: { type: 'enum', options: ['monthly', 'annual'], initial: 'annual' } }]);
    expect(repaired.components[def.id].state!.billing).toMatchObject({ label: 'Billing', initial: 'annual' });
    expect(errors(repaired)).toEqual([]);
    expect(() => apply(repaired, [{ type: 'node.setStateAction', owner: owner(def), nodeId: 'toggle-btn', action: { state: 'billing', op: 'toggle' } }])).toThrow(/toggles the choice "billing"/);
  });
});

// ---------------------------------------------------------------------------
// Format and the assistant
// ---------------------------------------------------------------------------

describe('the document format and the assistant', () => {
  it('marks the format with a version-only step, so an older editor opens a project with state read-only', () => {
    // The step upgrades format 8 to 9; the style state (9 to 10) and entry address (10 to 11) steps after it only
    // change the version too, as the collection layout step (11 to 12) does for a project without collections, and so
    // do the entry article (12 to 13), repeat filter (13 to 14), style strength (14 to 15), color scheme (15 to 16), managed overlay (16 to 17) and project brief (17 to 18) steps.
    const from = MIGRATIONS.findIndex((m) => m.id === 'ui-state') + 1;
    expect(from).toBe(8);
    expect(MIGRATIONS.slice(from).map((m) => m.id)).toEqual(['style-states', 'entry-addresses', 'collection-templates', 'entry-articles', 'repeat-filters', 'style-strength', 'color-schemes', 'managed-overlays', 'project-brief']);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
    const s = fresh();
    const { def } = billingDef(s);
    place(s, def);
    const docs = (p: ProjectState) => [p.manifest, p.site, p.tokens, p.assets, p.themeLock, ...Object.values(p.pages), ...Object.values(p.components)];
    for (const d of docs(s)) d.schemaVersion = from;
    // The step itself changes nothing in the documents.
    const stepped = structuredClone(s);
    MIGRATIONS[from - 1].migrate(stepped, () => true);
    expect(stepped).toEqual(s);
    const before = structuredClone(s);
    const out = migrateProject(s)!.state;
    // Every document is as it was apart from its version, and the theme lock it keeps truthful.
    const unversioned = (p: ProjectState) => JSON.parse(JSON.stringify({ ...p, themeLock: undefined }, (k, v) => (k === 'schemaVersion' ? undefined : v)));
    expect(unversioned(out)).toEqual(unversioned(before));
    expect(docs(out).every((d) => d.schemaVersion === SCHEMA_VERSION)).toBe(true);
    // Nothing else changes: state stays as written, and no component gains a state it did not have.
    expect(out.components[def.id].state).toEqual(def.state);
    expect(Object.values(out.components).filter((d) => 'state' in d).map((d) => d.id)).toEqual([def.id]);
    expect(errors(out)).toEqual([]);
  });

  it('classifies the state operations and offers them to a run that may change a design, now that generated buttons work', () => {
    const types = ['component.setState', 'component.removeState', 'node.setStateAction'] as const;
    for (const t of types) expect(Object.hasOwn(OPERATION_SCHEMAS, t)).toBe(true);
    // A new state is the design's own addition; removing one changes every placement; a button is one node.
    expect(types.map((t) => OP_REACH[t])).toEqual(['definition', 'wider', 'node']);
    const offered = JSON.stringify(toolDefinitions({ codeEnabled: true, definitionOps: true }).find((t) => t.name === 'apply_operations')!.parameters);
    expect(offered).toContain('component.setPropSchema');
    expect(offered).toContain('node.setBinding');
    for (const t of types) expect(offered).toContain(t);
    expect(offered).toContain('$state');
    // A collection entry's field stays the layout's own: never offered for a design.
    expect(offered).not.toContain('$entry');
    // A run that may not change a design is offered none of them.
    const page = JSON.stringify(toolDefinitions({ codeEnabled: true, definitionOps: false }).find((t) => t.name === 'apply_operations')!.parameters);
    for (const t of types) expect(page).not.toContain(t);
  });

  it('applies state the assistant sends, checked by the engine like any edit', async () => {
    const s = fresh();
    const { def } = billingDef(s);
    const sent: unknown[][] = [];
    const host = {
      state: () => s,
      revision: () => 1,
      diagnostics: () => validateState(s),
      apply: async (ops: unknown[]) => (sent.push(ops), { ok: true, revision: 2, results: [] })
    } as unknown as Parameters<typeof executeTool>[2];
    const send = (operations: unknown[]) => executeTool('apply_operations', JSON.stringify({ expectedRevision: 1, operations }), host, 'c1');
    for (const op of [
      { type: 'component.setState', definitionId: def.id, state: 'tab', schema: { type: 'boolean' } },
      { type: 'node.setStateAction', owner: owner(def), nodeId: 'toggle-btn', action: null },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'when', binding: { $state: 'open' } }
    ]) {
      const out = await send([op]);
      expect(out.ok, JSON.stringify(out.content)).toBe(true);
    }
    expect(sent.map((ops) => (ops[0] as { type: string }).type)).toEqual(['component.setState', 'node.setStateAction', 'node.setBinding']);
  });
});
