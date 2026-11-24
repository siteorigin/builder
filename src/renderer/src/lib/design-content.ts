import type { ComponentDefinition, GraphNode, InstanceNode, OwnerRef, ProjectState, ScalarPropSchema } from '@shared/types';
import { propBindingSchema, propBindingValue } from '@shared/bindings';
import { isBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { enclosingRepeatProp, instancesOf } from '@engine/tree';

/** A node's content that a component's design can hold: what Edit everywhere offers to change. */
export type ContentField = 'text' | 'label' | 'link' | 'image' | 'icon';

/**
 * One content value of a node in a component's design, and who owns it.
 * - `default`: bound to one of the component's properties. Each placement fills it in; one that has no value of its
 *   own shows the property's default, which is what changes here (and what new placements start with).
 * - `design`: fixed in the design, the same in every placement.
 * - `item`: each item of a repeated list has its own, edited with the list.
 */
export type DesignContent =
  | { field: ContentField; source: 'default'; prop: string; schema: ScalarPropSchema; value: unknown }
  | { field: ContentField; source: 'design'; value: unknown }
  | { field: ContentField; source: 'item'; list: string | null; itemField: string };

/** The content fields each kind of node has, in the order the Inspector shows them. */
function fieldsOf(node: GraphNode): ContentField[] {
  switch (node.kind) {
    case 'text':
      return ['text'];
    case 'link':
      // A button's icon is offered when the design shows one; adding one is a design change made on the canvas.
      return node.icon !== undefined ? ['label', 'link', 'icon'] : ['label', 'link'];
    case 'image':
      return ['image'];
    case 'icon':
      return ['icon'];
    case 'element':
      // A container that is one link (a card) has a destination.
      return node.link !== undefined ? ['link'] : [];
    default:
      return [];
  }
}

/** The content a node of a component's design holds, field by field, with where each value comes from. */
export function designContent(def: ComponentDefinition, node: GraphNode): DesignContent[] {
  const out: DesignContent[] = [];
  for (const field of fieldsOf(node)) {
    const raw = (node as unknown as Record<string, unknown>)[field];
    if (isBinding(raw)) {
      if ('$item' in raw) {
        out.push({ field, source: 'item', list: enclosingRepeatProp(def, node.id) ?? null, itemField: raw.$item });
        continue;
      }
      if (!('$prop' in raw)) continue;
      const schema = propBindingSchema(def.properties, raw);
      // A list or table can only feed a repeat or a table, never one field; a missing property has nothing to change.
      if (!schema || schema.type === 'list' || schema.type === 'table' || schema.type === 'object') continue;
      // One field of an object shows that field of the object's default.
      const value = raw.field === undefined ? schema.default : (propBindingValue(def.properties[raw.$prop].default, raw) ?? schema.default);
      out.push({ field, source: 'default', prop: raw.$prop, schema: (raw.field === undefined ? schema : { ...schema, default: value }) as ScalarPropSchema, value });
      continue;
    }
    out.push({ field, source: 'design', value: raw });
  }
  return out;
}

/**
 * The element of a design whose `field` (its image, its link) shows a property's starting value, so its Content is
 * where that value is changed. Null when no one element shows it that way: a list's or a table's starting rows, a
 * property nothing shows, or one shown only as another field (a button's text, from the same property as its link).
 */
export function defaultEditorNode(def: ComponentDefinition, prop: string, field: ContentField): string | null {
  for (const node of Object.values(def.tree?.nodes ?? {})) if (designContent(def, node).some((f) => f.source === 'default' && f.prop === prop && f.field === field)) return node.id;
  return null;
}

/** The edit that changes one content field of a design's node: the value fixed in it, or its property's default. */
export function designContentOp(def: ComponentDefinition, nodeId: string, field: ContentField, value: unknown): EditOperation {
  return { type: 'node.setContent', owner: { kind: 'component', id: def.id }, nodeId, field, value };
}

/** The edit that changes a property's default and nothing else about it: not its schema, not any placement's own value. */
export function propDefaultOp(definitionId: string, prop: string, value: unknown): EditOperation {
  return { type: 'component.setPropDefault', definitionId, prop, value };
}

export interface Placement {
  owner: OwnerRef;
  node: InstanceNode;
  label: string;
}

/**
 * Who a change to a property's default reaches: every placement of the component, and the ones among them that
 * show the default because they have no value of their own (new placements start with the default too). A stored
 * null is no value: the site shows the default there.
 */
export function defaultReach(state: ProjectState, definitionId: string, prop: string): { placements: Placement[]; showing: Placement[] } {
  const placements = instancesOf(state, definitionId);
  return { placements, showing: placements.filter((p) => !Object.hasOwn(p.node.props, prop) || p.node.props[prop] === null) };
}

/** A forwarded value: a nested placement's property filled in from a property of the component it sits in. */
export function forwardedProp(value: unknown): string | null {
  return isBinding(value) && '$prop' in value ? value.$prop : null;
}

/** The same, as the binding itself: one field of an object property keeps its field. */
export function forwardedBinding(value: unknown): { $prop: string; field?: string } | null {
  return isBinding(value) && '$prop' in value ? value : null;
}

/** The words for who a default reaches: "Shown on Home and About (2 of 3 placements). New placements start with it." */
export function reachText(reach: { placements: Placement[]; showing: Placement[] }): string {
  const { placements, showing } = reach;
  const later = 'New placements start with it.';
  if (!placements.length) return `Not placed anywhere yet. ${later}`;
  if (!showing.length) return `Every placement has its own, so none change. ${later}`;
  const names = [...new Set(showing.map((p) => p.label))];
  const where = names.length <= 3 ? listJoin(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const count = showing.length === placements.length ? (placements.length === 1 ? 'its only placement' : `all ${placements.length} placements`) : `${showing.length} of ${placements.length} placements`;
  return `Shown on ${where} (${count}). ${later}`;
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
