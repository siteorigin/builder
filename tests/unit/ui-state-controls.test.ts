/**
 * The edits Edit everywhere's UI State & Interaction controls plan (#377): a component's UI state variables, what a
 * button's click does to them, and a container shown as a dialog or drawer. Each plan is one operation the engine
 * checks, as any edit is; its Undo is the editor's own, covered by tests/e2e/ui-state.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ElementNode, LinkNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import {
  actionWords,
  addOptionOp,
  addStateOp,
  clickActionOp,
  clickChoices,
  clickKey,
  initialStateOp,
  newStateProblem,
  optionLabels,
  optionValueFor,
  overlayOp,
  overlayOpensWhen,
  overlayRefusal,
  removeOptionOp,
  removeStateOp,
  renameOptionOp,
  renameStateOp,
  stateNameFor,
  stateUseWords
} from '../../src/renderer/src/lib/ui-state';

const none = { type: 'none' as const, target: '' };

/** A component with a heading, two buttons, two plain panels and a drawer container, and no UI state yet. */
function plain(): { state: ProjectState; id: string } {
  const made = applyOperations(createStarterState('blank', 'Controls', false), [
    {
      type: 'component.upsert',
      name: 'Plan switch',
      properties: { heading: { type: 'string', label: 'Heading', default: 'Plans' } },
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['heading', 'tabs', 'monthly', 'annual', 'drawer'] },
        { kind: 'text', id: 'heading', tag: 'h2', text: { $prop: 'heading' } },
        { kind: 'element', id: 'tabs', children: ['monthlyTab', 'annualTab'] },
        { kind: 'link', id: 'monthlyTab', name: 'Monthly', link: none, label: 'Monthly' },
        { kind: 'link', id: 'annualTab', name: 'Annual', link: none, label: 'Annual' },
        { kind: 'element', id: 'monthly', name: 'Monthly panel', children: [] },
        { kind: 'element', id: 'annual', name: 'Annual panel', children: [] },
        { kind: 'element', id: 'drawer', name: 'Drawer', children: [] }
      ]
    }
  ]);
  return { state: made.state, id: made.results[0].definitionId as string };
}

/** Apply planned operations, as the Inspector sends them. */
function step(s: { state: ProjectState; id: string }, plan: (def: ComponentDefinition) => EditOperation | null) {
  const op = plan(s.state.components[s.id]);
  if (!op) throw new Error('Nothing planned');
  s.state = applyOperations(s.state, [op]).state;
  return s.state.components[s.id];
}

describe('UI state controls: names and options', () => {
  it('names a new state after its label, clear of the component’s properties and states', () => {
    const { state, id } = plain();
    const def = state.components[id];
    expect(stateNameFor(def, 'Billing period')).toBe('billingPeriod');
    expect(stateNameFor(def, 'Heading')).toBe('heading2');
    expect(stateNameFor(def, '2 columns')).toBe('state2Columns');
    expect(stateNameFor(def, '   ')).toBe('state');
    expect(stateNameFor({ ...def, state: { open: { type: 'boolean', label: 'Open', initial: false } } }, 'Open')).toBe('open2');
    expect(stateNameFor(def, 'Café menu')).toBe('cafeMenu');
    // A reserved word is never a name it suggests, and the engine takes the one it does.
    expect(stateNameFor(def, 'Prototype')).toBe('prototypeState');
    expect(stateNameFor(def, 'Item')).toBe('itemState');
    expect(() => applyOperations(state, [addStateOp(def, 'Prototype', 'boolean', [])])).not.toThrow();
  });

  it('makes option values from labels, each once, and reads a comma-separated list', () => {
    expect(optionValueFor('Pay yearly', [])).toBe('pay-yearly');
    expect(optionValueFor('Monthly', ['monthly'])).toBe('monthly-2');
    expect(optionValueFor('Pay yearly', ['pay-yearly', 'pay-yearly-2'])).toBe('pay-yearly-3');
    // Labels that read the same as values each get their own.
    const { state, id } = plain();
    const op = addStateOp(state.components[id], 'Plan', 'enum', ['Pay yearly', 'Pay  yearly', 'Pay-yearly']) as { schema: { options: Array<{ value: string }> } };
    expect(op.schema.options.map((o) => o.value)).toEqual(['pay-yearly', 'pay-yearly-2', 'pay-yearly-3']);
    expect(optionValueFor('!!!', [])).toBe('option');
    expect(optionLabels(' Monthly, Annual ,, monthly, Lifetime')).toEqual(['Monthly', 'Annual', 'Lifetime']);
  });

  it('says why a new state cannot be added yet', () => {
    const { state, id } = plain();
    const def = state.components[id];
    expect(newStateProblem(def, '', 'boolean', [])).toBe('Name the state.');
    expect(newStateProblem(def, 'Billing', 'enum', ['Monthly'])).toMatch(/two options or more/);
    expect(newStateProblem(def, 'Billing', 'enum', ['Monthly', 'Annual'])).toBeNull();
    expect(newStateProblem(def, 'Open', 'boolean', [])).toBeNull();
    expect(newStateProblem(def, 'Billing', 'enum', Array.from({ length: 51 }, (_, i) => `Option ${i}`))).toMatch(/at most 50 options/);
    const full = { ...def, state: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { type: 'boolean' as const, label: `S${i}`, initial: false }])) };
    expect(newStateProblem(full, 'Open', 'boolean', [])).toMatch(/at most 20 UI states/);
    const fifty = { ...def, state: { plan: { type: 'enum' as const, label: 'Plan', options: Array.from({ length: 50 }, (_, i) => ({ value: `o${i}`, label: `O${i}` })), initial: 'o0' } } };
    expect(addOptionOp(fifty, 'plan', 'One more')).toBeNull();
  });
});

describe('UI state controls: building two tabs and a drawer, step by step', () => {
  it('declares, renames, reorders where it starts, adds and removes options, and refuses to remove what is used', () => {
    const s = plain();
    let def = step(s, (d) => addStateOp(d, 'Billing', 'enum', ['Monthly', 'Annual']));
    expect(def.state).toEqual({ billing: { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }], initial: 'monthly' } });
    def = step(s, (d) => renameStateOp(d, 'billing', 'Billing period'));
    expect(def.state!.billing.label).toBe('Billing period');
    def = step(s, (d) => initialStateOp(d, 'billing', 'annual'));
    expect(def.state!.billing.initial).toBe('annual');
    def = step(s, (d) => addOptionOp(d, 'billing', 'Lifetime'));
    def = step(s, (d) => renameOptionOp(d, 'billing', 'lifetime', 'Forever'));
    expect(def.state!.billing).toMatchObject({ options: [{ value: 'monthly' }, { value: 'annual' }, { value: 'lifetime', label: 'Forever' }], initial: 'annual' });
    // Removing an option they do not start at keeps where they start.
    def = step(s, (d) => addOptionOp(d, 'billing', 'Weekly'));
    def = step(s, (d) => removeOptionOp(d, 'billing', 'weekly'));
    expect(def.state!.billing).toMatchObject({ options: [{ value: 'monthly' }, { value: 'annual' }, { value: 'lifetime' }], initial: 'annual' });
    // Removing the option placements start at moves them to the first left; a choice keeps two.
    def = step(s, (d) => removeOptionOp(d, 'billing', 'annual'));
    expect(def.state!.billing).toMatchObject({ options: [{ value: 'monthly' }, { value: 'lifetime' }], initial: 'monthly' });
    expect(removeOptionOp(def, 'billing', 'monthly')).toBeNull();
    // Nothing to change plans nothing.
    expect(renameStateOp(def, 'billing', 'Billing period')).toBeNull();
    expect(initialStateOp(def, 'billing', 'monthly')).toBeNull();

    // Wire both tabs: every option of the choice, a step either way, nothing.
    def = step(s, (d) => addOptionOp(d, 'billing', 'Annual'));
    const choices = clickChoices(def);
    expect(choices.map((c) => c.label)).toEqual(['Nothing else', 'Switch Billing period to Monthly', 'Switch Billing period to Forever', 'Switch Billing period to Annual', 'Next Billing period', 'Previous Billing period']);
    const pick = (label: string) => choices.find((c) => c.label === label)!;
    def = step(s, (d) => clickActionOp(d, d.tree!.nodes.monthlyTab, pick('Switch Billing period to Monthly')));
    def = step(s, (d) => clickActionOp(d, d.tree!.nodes.annualTab, pick('Switch Billing period to Annual')));
    expect((def.tree!.nodes.annualTab as LinkNode).stateAction).toEqual({ state: 'billing', op: 'set', value: 'annual' });
    expect(clickKey((def.tree!.nodes.annualTab as LinkNode).stateAction)).toBe(pick('Switch Billing period to Annual').key);
    // A step that goes round keeps going round when another step replaces it.
    def = step(s, (d) => clickActionOp(d, d.tree!.nodes.monthlyTab, pick('Next Billing period'), true));
    def = step(s, (d) => clickActionOp(d, d.tree!.nodes.monthlyTab, pick('Previous Billing period')));
    expect((def.tree!.nodes.monthlyTab as LinkNode).stateAction).toEqual({ state: 'billing', op: 'prev', wrap: true });
    def = step(s, (d) => clickActionOp(d, d.tree!.nodes.monthlyTab, pick('Switch Billing period to Monthly')));
    expect(actionWords(def, (def.tree!.nodes.monthlyTab as LinkNode).stateAction!)).toBe('Switch Billing period to Monthly');

    // The option a button sets cannot go, and neither can the state while anything uses it: the engine names them.
    expect(() => step(s, (d) => removeOptionOp(d, 'billing', 'annual'))).toThrow(/"billing" cannot change this way: Annual sets "billing" to "annual"/);
    expect(stateUseWords(def, 'billing')).toEqual(['Monthly (its click)', 'Annual (its click)']);
    expect(() => step(s, (d) => removeStateOp(d, 'billing'))).toThrow(/still used by/);
    expect(validateState(s.state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('shows a container as a drawer only once a yes/no state shows it, and in its place again', () => {
    const s = plain();
    let def = step(s, (d) => addStateOp(d, 'Menu open', 'boolean', []));
    expect(def.state).toEqual({ menuOpen: { type: 'boolean', label: 'Menu open', initial: false } });
    expect(clickChoices(def).map((c) => c.label)).toEqual(['Nothing else', 'Toggle Menu open', 'Turn Menu open on', 'Turn Menu open off']);
    // No state shows it yet: refused, with the engine's reason.
    expect(overlayRefusal(def, def.tree!.nodes.drawer as ElementNode)).toMatch(/no yes\/no UI state of the component opens/);
    def = applyOperations(s.state, [{ type: 'node.setBinding', owner: { kind: 'component', id: s.id }, nodeId: 'drawer', field: 'when', binding: { $state: 'menuOpen' } }]).state.components[s.id];
    s.state = { ...s.state, components: { ...s.state.components, [s.id]: def } };
    expect(overlayRefusal(def, def.tree!.nodes.drawer as ElementNode)).toBeNull();
    // The design's top element never can be one.
    expect(overlayRefusal(def, def.tree!.nodes.root as ElementNode)).toMatch(/top element/);
    for (const mode of ['dialog', 'drawer-start', 'drawer-bottom', 'drawer-end'] as const) {
      def = step(s, (d) => overlayOp(d, d.tree!.nodes.drawer, mode));
      expect((def.tree!.nodes.drawer as ElementNode).overlay).toBe(mode);
    }
    expect(overlayOpensWhen(def, def.tree!.nodes.drawer as ElementNode)).toBe('Menu open is on');
    def = step(s, (d) => overlayOp(d, d.tree!.nodes.drawer, null));
    expect((def.tree!.nodes.drawer as ElementNode).overlay).toBeUndefined();
  });
});
