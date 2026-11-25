/**
 * Planning the edits Edit everywhere's UI State & Interaction controls make (panels/InteractionControls): a
 * component's UI state variables (which tab shows, whether a panel is open), what clicking one of its buttons does to
 * them, and a container shown over the page as a dialog or drawer while a yes/no state is on. Each function plans
 * one operation from the definition as the project holds it when the author acts; the engine still checks it, and
 * refuses a change that would leave a button or a condition reading a value the state no longer has.
 */
import type { ComponentDefinition, ElementNode, GraphNode, OverlayMode, StateAction, UiStateSchema } from '@shared/types';
import { OVERLAY_MODES } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { booleanStateGuard, checkPropName, declaredState, itemScopeProblem, overlayProblem, stateUsers, MAX_UI_STATES } from '@engine/schema';

/** The most options a choice takes (see normalizeUiState). */
export const MAX_STATE_OPTIONS = 50;

/** The words an option value or a state name is made from: letters and digits, split at everything else. */
const words = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/** Whether a name can be a UI state variable's: a property-style name (camelCase, not reserved). */
function validName(name: string): boolean {
  try {
    checkPropName(name, 'State');
    return name !== 'prototype';
  } catch {
    return false;
  }
}

/** A new state's name, from its label: camelCase, free of the component's properties and states ("Billing period" → "billingPeriod"). */
export function stateNameFor(def: ComponentDefinition, label: string): string {
  const w = words(label).map((x) => x.toLowerCase());
  let base = w.length ? w[0] + w.slice(1).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('') : 'state';
  if (!/^[a-z]/.test(base)) base = `state${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  base = base.slice(0, 30);
  const free = (n: string) => validName(n) && !Object.hasOwn(def.properties, n) && !Object.hasOwn(def.state ?? {}, n);
  // A reserved word ("item", whose numbered forms are reserved too) takes a suffix first.
  for (const stem of validName(base) ? [base] : [`${base}State`, 'state']) {
    if (free(stem)) return stem;
    for (let i = 2; i < 1000; i++) if (free(`${stem}${i}`)) return `${stem}${i}`;
  }
  for (let i = 1; ; i++) if (free(`uiState${i}`)) return `uiState${i}`;
}

/** An option's stored value, from its label: lowercase words joined by hyphens, free of the others ("Pay yearly" → "pay-yearly"). */
export function optionValueFor(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = words(label).join('-').toLowerCase().slice(0, 50) || 'option';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The labels a comma-separated list of options names, each once, in order. */
export function optionLabels(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((t) => t.trim().slice(0, 80))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/** The component's list properties an item state can hold the active item of, by name, with their labels. */
export function itemStateLists(def: ComponentDefinition): Array<{ name: string; label: string }> {
  return Object.entries(def.properties)
    .filter(([, p]) => p.type === 'list')
    .map(([name, p]) => ({ name, label: p.label || name }));
}

/**
 * The positions an item state can start at (or be previewed at), named by the items ("2. Design"): one for each of
 * `items` (the design's own unless a preview shows others), and `current`, the one in use, even past the end of the
 * list (where it shows the last item).
 */
export function itemStatePositions(def: ComponentDefinition, s: Extract<UiStateSchema, { type: 'item' }>, items?: unknown[], current: number = s.initial): Array<{ value: number; label: string }> {
  const list = def.properties[s.list];
  const rows = items ?? (list?.type === 'list' && Array.isArray(list.default) ? list.default : []);
  const titleField = list?.type === 'list' ? list.titleField : undefined;
  const noun = list?.type === 'list' ? list.itemLabel || 'Item' : 'Item';
  const label = (i: number) => {
    const title = titleField ? (rows[i] as Record<string, unknown> | undefined)?.[titleField] : undefined;
    return typeof title === 'string' && title.trim() ? `${i + 1}. ${title.trim().slice(0, 60)}` : `${noun} ${i + 1}`;
  };
  const out = Array.from({ length: Math.min(Math.max(rows.length, 1), 50) }, (_, i) => ({ value: i, label: label(i) }));
  if (current >= out.length) out.push({ value: current, label: label(current) });
  return out;
}

/** Why a new state cannot be added with these, or null: a label, for a choice two options or more, and for an item state its list. */
export function newStateProblem(def: ComponentDefinition, label: string, type: UiStateSchema['type'], options: string[], list?: string): string | null {
  if (!label.trim()) return 'Name the state.';
  if (Object.keys(def.state ?? {}).length >= MAX_UI_STATES) return `A component can have at most ${MAX_UI_STATES} UI states.`;
  if (type === 'item' && !itemStateLists(def).some((l) => l.name === list)) return 'Choose the list whose active item it holds.';
  if (type === 'enum' && options.length < 2) return 'A choice needs two options or more, separated by commas.';
  if (type === 'enum' && options.length > MAX_STATE_OPTIONS) return `A choice can have at most ${MAX_STATE_OPTIONS} options.`;
  return null;
}

/** Add a UI state variable: yes/no (starting off), a choice between options (starting at the first), or the active item of a list (starting at the first). */
export function addStateOp(def: ComponentDefinition, label: string, type: UiStateSchema['type'], options: string[], list?: string): EditOperation {
  const name = stateNameFor(def, label);
  if (type === 'item') return { type: 'component.setState', definitionId: def.id, state: name, schema: { type, label: label.trim(), list } };
  const values = new Set<string>();
  const opts = options.map((l) => {
    const value = optionValueFor(l, values);
    values.add(value);
    return { value, label: l };
  });
  return { type: 'component.setState', definitionId: def.id, state: name, schema: type === 'boolean' ? { type, label: label.trim() } : { type, label: label.trim(), options: opts } };
}

/** The state as declared, for an edit of it; null when it is gone or a hand edit damaged it. */
const declared = (def: ComponentDefinition, name: string) => declaredState(def, name) ?? null;

/** Rename a state (its name, and so every button and condition using it, stays). */
export function renameStateOp(def: ComponentDefinition, name: string, label: string): EditOperation | null {
  const s = declared(def, name);
  if (!s || !label.trim() || label.trim() === s.label) return null;
  return { type: 'component.setState', definitionId: def.id, state: name, schema: { ...s, label: label.trim() } };
}

/** Where every placement starts: on or off, one option, or (an item state) the item at one position. */
export function initialStateOp(def: ComponentDefinition, name: string, initial: boolean | string | number): EditOperation | null {
  const s = declared(def, name);
  if (!s || s.initial === initial) return null;
  return { type: 'component.setState', definitionId: def.id, state: name, schema: { ...s, initial } as UiStateSchema };
}

/** A new option at the end of a choice. */
export function addOptionOp(def: ComponentDefinition, name: string, label: string): EditOperation | null {
  const s = declared(def, name);
  if (!s || s.type !== 'enum' || !label.trim() || s.options.length >= MAX_STATE_OPTIONS) return null;
  const value = optionValueFor(label, s.options.map((o) => o.value));
  return { type: 'component.setState', definitionId: def.id, state: name, schema: { ...s, options: [...s.options, { value, label: label.trim() }] } };
}

/** Rename one option of a choice: its value, which buttons and conditions name, stays. */
export function renameOptionOp(def: ComponentDefinition, name: string, value: string, label: string): EditOperation | null {
  const s = declared(def, name);
  if (!s || s.type !== 'enum' || !label.trim()) return null;
  const at = s.options.findIndex((o) => o.value === value);
  if (at < 0 || s.options[at].label === label.trim()) return null;
  return { type: 'component.setState', definitionId: def.id, state: name, schema: { ...s, options: s.options.map((o, i) => (i === at ? { ...o, label: label.trim() } : o)) } };
}

/** Remove one option of a choice (it keeps two or more): one placements start at gives way to the first left. */
export function removeOptionOp(def: ComponentDefinition, name: string, value: string): EditOperation | null {
  const s = declared(def, name);
  if (!s || s.type !== 'enum' || s.options.length <= 2 || !s.options.some((o) => o.value === value)) return null;
  const options = s.options.filter((o) => o.value !== value);
  return { type: 'component.setState', definitionId: def.id, state: name, schema: { ...s, options, initial: s.initial === value ? options[0].value : s.initial } };
}

export function removeStateOp(def: ComponentDefinition, name: string): EditOperation {
  return { type: 'component.removeState', definitionId: def.id, state: name };
}

/** What uses a state, in the words the Inspector lists them: "Annual (button), Annual panel (shown for it)". */
export function stateUseWords(def: ComponentDefinition, name: string): string[] {
  return stateUsers(def, name).map(({ node, field }) => `${node.name?.trim() || node.id} (${field === 'stateAction' ? 'its click' : field === 'when' ? 'shown for it' : field === 'unless' ? 'hidden for it' : 'its look'})`);
}

/** One choice of what clicking a button does, as the Inspector offers it, and the action it sets (null: nothing). */
export interface ClickChoice {
  key: string;
  label: string;
  action: StateAction | null;
}

const optionLabel = (s: UiStateSchema, value: unknown) => (s.type === 'enum' ? (s.options.find((o) => o.value === value)?.label ?? String(value)) : s.type === 'item' ? `item ${Number(value) + 1}` : value ? 'on' : 'off');

/** A state action in words: "Switch Billing to Annual", "Toggle Details", "Next Slide". */
export function actionWords(def: ComponentDefinition, action: StateAction): string {
  const s = declared(def, action.state);
  const label = s?.label || action.state;
  switch (action.op) {
    case 'toggle':
      return `Toggle ${label}`;
    case 'next':
      return `Next ${label}`;
    case 'prev':
      return `Previous ${label}`;
    case 'select': {
      // A hand-edited action may name no state.
      const words = String(label ?? 'active item');
      return `Make its item the ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
    }
    default:
      return s?.type === 'boolean' ? `Turn ${label} ${action.value ? 'on' : 'off'}` : `Switch ${label} to ${s ? optionLabel(s, action.value) : String(action.value)}`;
  }
}

/** The key a click choice is known by in the Inspector's list: the same action, the same key, whatever `wrap` says. */
export const clickKey = (action: StateAction | null | undefined): string => (!action ? '' : JSON.stringify([action.op, action.state, action.op === 'set' ? action.value : null]));

/**
 * Everything a button can do to the component's UI state: each option of each choice, a toggle, on and off, next and
 * previous, and (for a button in a repeat of an item state's list) making its own item the active one.
 */
export function clickChoices(def: ComponentDefinition, nodeId?: string): ClickChoice[] {
  const out: ClickChoice[] = [{ key: '', label: 'Nothing else', action: null }];
  for (const name of Object.keys(def.state ?? {})) {
    const s = declared(def, name);
    if (!s) continue;
    const selects = s.type === 'item' && nodeId !== undefined && !!def.tree?.nodes[nodeId] && !itemScopeProblem(def, nodeId, name, s, 'selects');
    const actions: StateAction[] =
      s.type === 'boolean'
        ? [{ state: name, op: 'toggle' }, { state: name, op: 'set', value: true }, { state: name, op: 'set', value: false }]
        : s.type === 'item'
          ? [...(selects ? [{ state: name, op: 'select' } as StateAction] : []), { state: name, op: 'next' }, { state: name, op: 'prev' }]
          : [...s.options.map((o): StateAction => ({ state: name, op: 'set', value: o.value })), { state: name, op: 'next' }, { state: name, op: 'prev' }];
    for (const action of actions) out.push({ key: clickKey(action), label: actionWords(def, action), action });
  }
  return out;
}

/** Set (or clear) what clicking a button of the design does. A step keeps going round if it already did. */
export function clickActionOp(def: ComponentDefinition, node: GraphNode, choice: ClickChoice, wrap?: boolean): EditOperation {
  let action = choice.action;
  if (action && (action.op === 'next' || action.op === 'prev')) {
    // What the button does now, as the project holds it (not as the Inspector last showed it).
    const live = def.tree?.nodes[node.id] ?? node;
    const was = live.kind === 'link' ? live.stateAction : undefined;
    const keep = wrap ?? (was && (was.op === 'next' || was.op === 'prev') ? was.wrap : undefined);
    action = { ...action, ...(keep ? { wrap: true } : {}) };
  }
  return { type: 'node.setStateAction', owner: { kind: 'component', id: def.id }, nodeId: node.id, action };
}

/** How a container is shown, in the Inspector's words. */
export const OVERLAY_LABEL: Record<OverlayMode, string> = {
  dialog: 'Dialog in the middle',
  'drawer-start': 'Drawer from the start side',
  'drawer-end': 'Drawer from the end side',
  'drawer-bottom': 'Drawer from the bottom'
};

/**
 * Why this container cannot show over the page as a dialog or drawer, as words that follow "This container", or null
 * when it can (or already does). The engine's own check, on the container as it would be with one.
 */
export function overlayRefusal(def: ComponentDefinition, node: ElementNode): string | null {
  const shown: ElementNode = { ...node, overlay: node.overlay ?? OVERLAY_MODES[0] };
  const tree = def.tree ? { ...def.tree, nodes: { ...def.tree.nodes, [node.id]: shown } } : def.tree;
  return overlayProblem({ ...def, tree }, shown);
}

/** The value of its yes/no state a dialog or drawer opens at, in words ("Menu open is on"); null when nothing opens it. */
export function overlayOpensWhen(def: ComponentDefinition, node: ElementNode): string | null {
  const guard = booleanStateGuard(def, node);
  const s = guard ? declared(def, guard.state) : null;
  return guard && s ? `${s.label || guard.state} is ${guard.shows ? 'on' : 'off'}` : null;
}

/** Show a container over the page in one of the ways, or in its place again (null). */
export function overlayOp(def: ComponentDefinition, node: GraphNode, mode: OverlayMode | null): EditOperation {
  return { type: 'node.setContent', owner: { kind: 'component', id: def.id }, nodeId: node.id, field: 'overlay', value: mode };
}
