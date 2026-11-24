import type { Binding, ComponentDefinition, ConditionValue, GraphNode, OwnerRef, PropSchema } from '@shared/types';
import { conditionRef, isComparison } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { enclosingList } from '@engine/schema';
import { propBindingName } from '@shared/bindings';

/**
 * The visibility rules of a node in a component's design, as the Inspector offers them: "Show when" (`when`) and
 * "Hide when" (`unless`), each testing a component property or a field of the list item the node is repeated for,
 * for having a value or for being (or not being) one value. The engine (`nodeSetBinding`) stays the judge of what
 * may be saved; this only lists what fits, so every choice offered is one it accepts.
 */

export type ConditionField = 'when' | 'unless';
/** Has a value (the site's `has`), is a value (`eq`), or is not that value (`ne`). */
export type ConditionTest = 'set' | 'eq' | 'ne';

/** Something a node's condition can read: a property of the component, or a field of the enclosing list item. */
export interface ConditionSource {
  /** Unique among a node's sources, also when a property and an item field share a name: `prop:title`, `item:title`. */
  key: string;
  binding: Binding;
  schema: PropSchema;
  label: string;
}

/** How a source's value is compared with a literal, or null when it can only be tested for having a value. */
export type ComparisonInput = { kind: 'boolean' } | { kind: 'number' } | { kind: 'text' } | { kind: 'choice'; options: Array<{ value: string; label: string }> };

/** A node's saved rule, read for the Inspector. `source` is missing when the rule reads something that has gone. */
export interface ConditionRule {
  binding: Binding;
  test: ConditionTest;
  value?: ConditionValue;
  source?: ConditionSource;
}

export const sourceKey = (b: Binding) => ('$prop' in b ? `prop:${propBindingName(b)}` : `item:${b.$item}`);

/** What a condition at this node can read: the component's properties, then the fields of the item it repeats for. */
export function conditionSources(def: ComponentDefinition, nodeId: string): { props: ConditionSource[]; item: ConditionSource[]; itemLabel?: string } {
  // An object is always there: a condition reads one of its fields ("Primary button label").
  const props = Object.entries(def.properties).flatMap(([name, schema]): ConditionSource[] =>
    schema.type === 'object'
      ? Object.entries(schema.fields).map(([f, fs]) => ({ key: `prop:${name}.${f}`, binding: { $prop: name, field: f }, schema: fs, label: `${schema.label || name} ${lower(fs.label || f)}` }))
      : [{ key: `prop:${name}`, binding: { $prop: name }, schema, label: schema.label || name }]
  );
  // The nearest repeat above the node (not the node itself: a repeat's own condition reads the item around it).
  const list = def.tree?.nodes[nodeId] ? enclosingList(def, nodeId) : null;
  const item = Object.entries(list?.fields ?? {}).map(([name, schema]) => ({ key: `item:${name}`, binding: { $item: name }, schema: schema as PropSchema, label: schema.label || name }));
  return { props, item, itemLabel: list?.itemLabel };
}

export function findSource(def: ComponentDefinition, nodeId: string, b: Binding): ConditionSource | undefined {
  const { props, item } = conditionSources(def, nodeId);
  const key = sourceKey(b);
  return [...props, ...item].find((s) => s.key === key);
}

/** How a value of this type is compared, or null for types only tested for having a value (rich text, links, lists…). */
export function comparisonInput(schema: PropSchema): ComparisonInput | null {
  switch (schema.type) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'number':
      return { kind: 'number' };
    case 'string':
    case 'icon':
      return { kind: 'text' };
    case 'enum':
      return schema.options.length ? { kind: 'choice', options: schema.options.map((o) => ({ value: o.value, label: o.label || o.value })) } : null;
    default:
      return null;
  }
}

/** The value a new comparison starts with: what the property shows by default, where the comparison can take it. */
export function startValue(schema: PropSchema): ConditionValue | undefined {
  const input = comparisonInput(schema);
  if (!input) return undefined;
  const d = (schema as { default?: unknown }).default;
  switch (input.kind) {
    // "Is on" reads more naturally than "is off" as the first choice.
    case 'boolean':
      return true;
    case 'number':
      return typeof d === 'number' && Number.isFinite(d) ? d : 0;
    case 'text':
      return typeof d === 'string' ? d : '';
    case 'choice':
      return input.options.some((o) => o.value === d) ? (d as string) : input.options[0].value;
  }
}

/** The rule a node holds for `field`, or null when it has none. */
export function readRule(def: ComponentDefinition, node: GraphNode, field: ConditionField): ConditionRule | null {
  const c = node[field];
  const binding = conditionRef(c);
  if (!binding) return null;
  const source = findSource(def, node.id, binding);
  if (!isComparison(c)) return { binding, test: 'set', source };
  return 'eq' in c ? { binding, test: 'eq', value: c.eq, source } : { binding, test: 'ne', value: c.ne, source };
}

/** The operation that saves a rule (`null` clears it). A comparison without a value is saved as a presence test. */
export function ruleOp(owner: OwnerRef, nodeId: string, field: ConditionField, rule: { binding: Binding; test: ConditionTest; value?: ConditionValue } | null): EditOperation {
  if (!rule) return { type: 'node.setBinding', owner, nodeId, field, binding: null };
  const compared = rule.test !== 'set' && rule.value !== undefined;
  return { type: 'node.setBinding', owner, nodeId, field, binding: { ...rule.binding }, ...(compared ? { [rule.test]: rule.value } : {}) } as EditOperation;
}

/** A compared value as the author reads it: an option's label, Yes or No, a number, or quoted text. */
export function shownLiteral(value: ConditionValue | undefined, source: ConditionSource | undefined): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(value);
  const input = source ? comparisonInput(source.schema) : null;
  const option = input?.kind === 'choice' ? input.options.find((o) => o.value === value) : undefined;
  return option ? option.label : `“${value ?? ''}”`;
}

/** A rule in words: "Show when Featured is on", "Hide when Badge has a value". */
export function describeRule(field: ConditionField, rule: ConditionRule, itemLabel?: string): string {
  const name = rule.source ? (rule.source.key.startsWith('item:') && itemLabel ? `${itemLabel} ${lower(rule.source.label)}` : rule.source.label) : '$prop' in rule.binding ? propBindingName(rule.binding) : rule.binding.$item;
  const test = rule.test === 'set' ? 'has a value' : `${rule.test === 'eq' ? 'is' : 'is not'} ${shownLiteral(rule.value, rule.source)}`;
  return `${field === 'when' ? 'Show' : 'Hide'} when ${name} ${test}`;
}

/** A node's visibility rules in words, for the Layers row; empty when it has none. */
export function describeConditions(def: ComponentDefinition, node: GraphNode): string[] {
  const { itemLabel } = conditionSources(def, node.id);
  const out: string[] = [];
  for (const field of ['when', 'unless'] as const) {
    const rule = readRule(def, node, field);
    if (rule) out.push(describeRule(field, rule, itemLabel));
  }
  if (node.kind === 'element' && node.collapseEmpty) out.push('Hidden when every item inside is hidden');
  return out;
}

const lower = (label: string) => (/^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label);
