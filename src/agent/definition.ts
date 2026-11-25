/**
 * Definition tools: the small tool set for a component's own design, edited everywhere, for a model whose window or
 * grammar cannot hold the general operations (#360). Every schema is built from that component as it is now: its
 * nodes, properties, list fields, parts and variant axes. Each call compiles to the same edit operations
 * apply_operations would send, so the run's authority (the whole design, or a node selected in it) still decides
 * what may change.
 */
import { z } from 'zod';
import { DIVIDER_SHAPES, STYLE_SCOPES, STYLE_STATES, isBinding, type ComponentDefinition, type GraphNode, type NodeTree, type ProjectState, type PropSchema, type StateAction } from '@shared/types';
import { BACKGROUND_IMAGE, STYLE_TOKEN_REF, type EditOperation } from '@shared/ops';
import { CONTAINER_SCOPE_HELP, STYLE_PROPS, isStateStyleProp, stateStyleError } from '@shared/styles';
import { axesOf } from '@shared/variants';
import { bindingSlots, declaredState, enclosingList, normalizePropSchema } from '@engine/schema';
import { subtreeIds } from '@engine/tree';
import { selectionAbridged } from './context';
import { checkProps, fieldError, type FieldIssue } from './macros';
import { propsJsonSchema, writableProp, type JsonSchema } from './propschema';
import { applySelected, nodeFields, STYLE_VALUE } from './selection';
import type { Authority, PartAuthority } from './scope';
import type { ToolDefinition } from './types';
import type { ToolHost, ToolOutcome } from './tools';

/** The design a run is about: a component edited everywhere, or one of its nodes selected there. */
export interface DefinitionTarget {
  definitionId: string;
  /** The node selected in the design: the run may change it and what is inside it. Absent: the whole design. */
  nodeId?: string;
  /** A part picked inside a component placed in the design: the run may change only that part's own styles. */
  part?: PartAuthority;
}

/** The design a run's authority is limited to, or null when it is not one (a page, a placement, the whole site). */
export function definitionTarget(authority: Authority): DefinitionTarget | null {
  if (authority.kind === 'component') return { definitionId: authority.definitionId };
  if (authority.kind === 'selection' && authority.owner.kind === 'component') return { definitionId: authority.owner.id, nodeId: authority.nodeId, ...(authority.part ? { part: authority.part } : {}) };
  return null;
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);
/** The property types a small model adds: single values an author fills in. Lists, tables and objects stay with the general tools. */
const ADDED_TYPES = ['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'image', 'icon'] as const;
/** Property types whose default is one plain value, which set_default takes: an image's is its assetId. */
const PLAIN_DEFAULTS = new Set<PropSchema['type']>(['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'icon', 'image']);
/** Bindings a small model makes: content and conditions. A nested placement's properties and variants, and a repeat's list, stay with the general tools. */
const UNOFFERED_BINDINGS = new Set(['prop', 'variant', 'list', 'action', 'filter']);
/** Above this many, node IDs are checked when a call arrives instead of listed in the grammar. */
const MAX_LISTED_NODES = 80;
/** What a small model adds to a design: elements and layout. Repeats and slots need a list or slot of their own first. */
const INSERTED = ['container', 'stack', 'row', 'grid', 'heading', 'paragraph', 'richtext', 'image', 'button', 'icon', 'divider', 'badge', 'figure'] as const;

export const DEFINITION_ARGS = {
  edit_definition_node: z
    .object({
      nodeId: z.string(),
      content: z.record(z.string(), z.unknown()).optional(),
      exposeAsPart: z.object({ partId: z.string(), label: z.string().min(1).max(60) }).strict().optional()
    })
    .strict(),
  bind_definition_field: z
    .object({
      nodeId: z.string(),
      field: z.string(),
      binding: z.union([z.object({ $prop: z.string(), field: z.string().optional() }).strict(), z.object({ $item: z.string() }).strict(), z.object({ $state: z.string() }).strict()]).nullable(),
      eq: scalar.optional(),
      ne: scalar.optional()
    })
    .strict(),
  manage_component_state: z
    .object({
      change: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('add'),
            state: z.string(),
            label: z.string().min(1).max(80),
            type: z.enum(['boolean', 'enum', 'item']),
            options: z.array(z.string().min(1).max(60)).min(2).max(50).optional(),
            list: z.string().optional(),
            initial: z.union([z.boolean(), z.string(), z.number().int().min(0)]).optional()
          })
          .strict(),
        z.object({ action: z.literal('remove'), state: z.string() }).strict(),
        z
          .object({
            action: z.literal('on_click'),
            nodeId: z.string(),
            op: z.enum(['set', 'toggle', 'next', 'prev', 'select', 'none']),
            state: z.string().optional(),
            value: z.union([z.boolean(), z.string()]).optional(),
            wrap: z.boolean().optional()
          })
          .strict()
      ])
    })
    .strict(),
  manage_component_prop: z
    .object({
      change: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('add'),
            prop: z.string(),
            label: z.string().min(1).max(80),
            type: z.enum(ADDED_TYPES),
            options: z.array(z.string()).max(50).optional(),
            default: scalar.optional()
          })
          .strict(),
        z.object({ action: z.literal('set_default'), prop: z.string(), value: scalar }).strict(),
        z.object({ action: z.literal('remove'), prop: z.string() }).strict()
      ])
    })
    .strict(),
  style_definition_element: z
    .object({
      nodeId: z.string().optional(),
      partId: z.string().optional(),
      variant: z.object({ axis: z.string(), option: z.string() }).strict().optional(),
      scope: z.enum(STYLE_SCOPES),
      state: z.enum(STYLE_STATES).optional(),
      styles: z
        .array(z.object({ property: z.string(), value: z.union([z.string(), z.number(), z.boolean(), STYLE_TOKEN_REF, BACKGROUND_IMAGE, z.null()]) }).strict())
        .min(1)
        .max(12)
    })
    .strict(),
  add_definition_variant: z.object({ axis: z.string(), option: z.string(), label: z.string().min(1).max(60) }).strict(),
  insert_definition_node: z
    .object({
      parentId: z.string(),
      primitive: z.enum(INSERTED),
      text: z.string().max(2000).optional(),
      shape: z.enum(DIVIDER_SHAPES).optional(),
      icon: z.string().optional(),
      index: z.number().int().min(0).optional()
    })
    .strict(),
  remove_definition_node: z.object({ nodeId: z.string() }).strict()
} as const;

export type DefinitionToolName = keyof typeof DEFINITION_ARGS;

export const DEFINITION_DESCRIPTIONS: Record<DefinitionToolName, string> = {
  edit_definition_node:
    "Change one node of the component's design: its content (text and heading tag, an image, a button's label, link and style, an icon), which every placement shows unless the node is bound to a property, and/or expose it as a new part (exposeAsPart) that authors can style on each placement.",
  bind_definition_field:
    'Bind a node\'s content or condition to a property ({"$prop": name}, {"$prop": name, "field": objectField}) or, inside a repeat, to a field of each list item ({"$item": field}); a condition can also read UI state ({"$state": name}). null unbinds it, keeping what it shows. A "when" condition shows the node only when the value is set (or equals eq, or differs from ne); "unless" shows it only when it is not. Add a property with manage_component_prop, or UI state with manage_component_state, first.',
  manage_component_prop:
    "Change the component's properties, which every placement fills in: add one (a camelCase name, its label, type and an optional default), set an existing one's default, or remove one.",
  manage_component_state:
    'Change the component\'s UI state, which each placement holds and visitors change with its buttons (tabs, a toggle, a dialog, steps): add a variable (a camelCase name; type "boolean" for yes/no, "enum" with its option values, or "item" with the list property whose active item it holds), remove one nothing uses, or set what clicking a button does (on_click: op "set" with a value, "toggle" a yes/no state, "next" or "prev" through a choice\'s options or a list\'s items, "select" for a button in a repeat of an item state\'s list to make its own item active, "none" to clear). Then show each panel only for one value with bind_definition_field: field "when", binding {"$state": name} and eq the value; for an item state, content in any repeat of its list with binding {"$state": name} and no eq shows only for the active item.',
  style_definition_element:
    'Style a node of the design, by nodeId or by one of its parts. Without variant this is the base style every placement starts from; with variant { axis, option } it is that option\'s rule, which applies only to placements that choose it. scope "phone", "tablet" or "desktop" styles one screen size, "base" all; state "hover", "focus" or "active" styles that state only (colors, background, border, radius, shadow, opacity); "groupHover" or "groupFocus" while the nearest interaction group around it (edit_definition_node content interactionGroup) is hovered or holds focus, and may also shift, scale and rotate it. Prefer token values such as {"token":"space.lg"}; null clears a value.',
  add_definition_variant: 'Add a variant option that placements can choose, on an axis such as tone or layout. Then style it with style_definition_element and its variant.',
  insert_definition_node:
    "Add an element to the design inside one of its containers (at index among its children, by default the end): a heading, paragraph, button, image, icon, divider (a plain line, or a decorative angle, wave or icon band), badge (a pill label with an optional leading icon), figure (an image with a caption) or a layout container. The result names the new node's nodeId, to bind, style or expose in the next step.",
  remove_definition_node: 'Remove a node, and everything inside it, from the design: every placement loses it.'
};

/** The same rules for a grammar-constrained local model, which reads every byte before it answers. */
export const DEFINITION_BRIEFS: Record<DefinitionToolName, string> = {
  edit_definition_node: 'Content every placement shows unless the node is bound; exposeAsPart lets authors style it on each placement.',
  bind_definition_field: '$prop binds a property ($prop with field: one field of an object property), $item a list item field inside a repeat, $state UI state (when/unless only); null unbinds. when shows the node when the value is set (or eq, or not ne); unless when not. Add the property or state first.',
  manage_component_prop: 'add a property (camelCase name), set an existing default, or remove one.',
  manage_component_state: 'add UI state (boolean, enum with options, or item with a list), remove one, or on_click: what a button does (set a value, toggle, next, prev, select its item, none). Show panels with bind_definition_field when {"$state": name} eq a value (an item state: no eq, in a repeat of its list).',
  style_definition_element:
    'Without variant: the base style; with variant: that option\'s rule. scope styles one screen size, base all; state, that state only. Prefer tokens such as {"token":"space.lg"}; null clears.',
  add_definition_variant: 'A new option placements can choose; style it next with style_definition_element.',
  insert_definition_node: 'A new element inside a container (index: its position, default the end). The result names its nodeId.',
  remove_definition_node: 'Removes it and what is inside it from every placement.'
};

const noTarget = (): ToolOutcome => ({ ok: false, content: { error: 'INVALID_ARGUMENT', message: "The component's design, or the node selected in it, is no longer in the site." } });
const NOTHING_APPLIED = 'Nothing was applied.';

interface Scope {
  def: ComponentDefinition;
  tree: NodeTree;
  /** The nodes the run may change, in document order: the selected node and what is inside it, or the whole design. */
  nodes: string[];
  /** A part picked inside a placement in the design: only its own styles, on that placement. */
  part?: PartAuthority;
}

function resolveScope(state: ProjectState, target: DefinitionTarget): Scope | null {
  const def = Object.hasOwn(state.components, target.definitionId) ? state.components[target.definitionId] : undefined;
  // A code component's design is source, not a tree these tools can address.
  if (!def || def.kind !== 'managed' || !def.tree) return null;
  const tree = def.tree;
  if (target.nodeId !== undefined && !Object.hasOwn(tree.nodes, target.nodeId)) return null;
  const nodes = target.nodeId !== undefined ? subtreeIds(tree, target.nodeId) : [...new Set(tree.rootIds.flatMap((id) => subtreeIds(tree, id)))];
  return { def, tree, nodes, ...(target.part ? { part: target.part } : {}) };
}

/**
 * A part picked inside a placement, which the run may style: a public part of it, not one deeper inside. One item of a
 * repeated part is never one: a design styles every item alike, and the selection reaches that item alone.
 */
const styledPart = (s: Scope): string | undefined => (s.part && !s.part.nested && s.part.partId && s.part.itemId === undefined ? s.part.partId : undefined);

/** The IDs as an enum, or a plain string checked when the call arrives when there are too many to list. */
function idSchema(ids: string[], description: string): JsonSchema {
  return ids.length <= MAX_LISTED_NODES ? { type: 'string', enum: ids, description } : { type: 'string', description: `${description} read_component with structure lists them.` };
}

/** Nodes that render an element of their own: repeats and slots only hold others. */
const rendered = (n: GraphNode | undefined) => !!n && n.kind !== 'repeat' && n.kind !== 'slot';

/** Fields of each node that a small model may bind. */
const bindableFields = (n: GraphNode) => bindingSlots(n).map((s) => s.field).filter((f) => !UNOFFERED_BINDINGS.has(f));

/** List item fields a node can show: those of the list its nearest repeat repeats, as the engine finds it. */
const itemFields = (def: ComponentDefinition, nodeId: string): string[] => Object.keys(enclosingList(def, nodeId)?.fields ?? {});

/** Whether content the context shows of the design is shortened, so it must be read whole before it is rewritten. */
export function definitionAbridged(state: ProjectState, target: DefinitionTarget): boolean {
  const s = resolveScope(state, target);
  return !!s && !s.part && s.nodes.some((nodeId) => selectionAbridged(state, { owner: { kind: 'component', id: s.def.id }, nodeId }));
}

const closed = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const oneOf = (branches: JsonSchema[]): JsonSchema => (branches.length === 1 ? branches[0] : { anyOf: branches });
const SCALAR: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] };

/**
 * The tools for a component's design, or null when there is no design to edit (a code component, or one no longer in
 * the site). A part picked inside a placement in the design gets its style tool alone, and a pick deeper inside that
 * placement gets none: anything more needs the author's approval.
 */
export function definitionTools(state: ProjectState, target: DefinitionTarget): ToolDefinition[] | null {
  const s = resolveScope(state, target);
  if (!s) return null;
  const { def, tree } = s;
  const tools: ToolDefinition[] = [];
  const describe = (name: DefinitionToolName) => ({ name, description: DEFINITION_DESCRIPTIONS[name], brief: DEFINITION_BRIEFS[name] });
  const styleProps = {
    scope: { type: 'string', enum: [...STYLE_SCOPES], description: CONTAINER_SCOPE_HELP },
    state: { type: 'string', enum: [...STYLE_STATES], description: 'Style only this state: hover, focus (keyboard focus) or active (while pressed); groupHover or groupFocus while the nearest interaction group around it (a card) is hovered or holds focus, which can also shift, scale and rotate it. Omit for the resting style.' },
    styles: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: closed({ property: { type: 'string', enum: STYLE_PROPS.map((p) => p.id) }, value: STYLE_VALUE }, ['property', 'value'])
    }
  };
  if (s.part) {
    const partId = styledPart(s);
    if (partId)
      tools.push({ ...describe('style_definition_element'), parameters: closed({ partId: { type: 'string', enum: [partId], description: 'The selected part of the component placed here.' }, ...styleProps }, ['scope', 'styles']) });
    return tools;
  }
  const whole = target.nodeId === undefined;
  const nodes = s.nodes.filter((id) => Object.hasOwn(tree.nodes, id));
  // Content: the fields of every kind of node here, each checked against the node a call names.
  const content: Record<string, PropSchema> = {};
  for (const id of nodes) Object.assign(content, nodeFields(tree.nodes[id]));
  const partNodes = new Set(Object.values(def.parts).map((p) => p.nodeId));
  const exposable = nodes.filter((id) => rendered(tree.nodes[id]) && !partNodes.has(id));
  const editable = nodes.filter((id) => Object.keys(nodeFields(tree.nodes[id])).length || exposable.includes(id));
  const contentSchema = propsJsonSchema({ properties: content }) as { properties: Record<string, JsonSchema> };
  // New alt text alone keeps the picture (see runDefinitionTool), so an image needs only its alt.
  if (contentSchema.properties.image) contentSchema.properties.image = { ...contentSchema.properties.image, required: ['alt'], description: 'The image: its assetId and alt text, or the alt text alone to keep the picture.' };
  // A field is replaced whole, so text the context shows shortened is read whole first.
  const shortened = nodes.some((nodeId) => selectionAbridged(state, { owner: { kind: 'component', id: def.id }, nodeId }));
  if (editable.length)
    tools.push({
      ...describe('edit_definition_node'),
      parameters: closed(
        {
          nodeId: idSchema(editable, 'The node to change.'),
          ...(Object.keys(content).length
            ? { content: { ...contentSchema, description: `The content fields to change; send only those that change.${shortened ? ' Each replaces the field whole: read text shown shortened (ending in …) whole with inspect_element first.' : ''}` } }
            : {}),
          ...(exposable.length
            ? { exposeAsPart: closed({ partId: { type: 'string', description: 'A new camelCase part name, such as "eyebrow".' }, label: { type: 'string', minLength: 1, maxLength: 60, description: 'What authors see, such as "Eyebrow".' } }, ['partId', 'label']) }
            : {})
        },
        ['nodeId']
      )
    });
  // Bindings: any property, and the item fields of the lists repeated around these nodes. With neither, a binding can
  // still be removed (a condition on the design's UI state, say).
  const props = Object.keys(def.properties);
  const objectFields = [...new Set(Object.values(def.properties).flatMap((p) => (p.type === 'object' ? Object.keys(p.fields) : [])))];
  const fields = [...new Set(nodes.flatMap((id) => itemFields(def, id)))];
  const bindable = [...new Set(nodes.flatMap((id) => bindableFields(tree.nodes[id])))];
  const states = Object.keys(def.state ?? {}).filter((name) => declaredState(def, name));
  if (bindable.length)
    tools.push({
      ...describe('bind_definition_field'),
      parameters: closed(
        {
          nodeId: idSchema(nodes, 'The node to bind.'),
          field: { type: 'string', enum: bindable },
          binding: {
            anyOf: [
              ...(props.length
                ? [closed({ $prop: { type: 'string', enum: props }, ...(objectFields.length ? { field: { type: 'string', enum: objectFields, description: 'One field of an object property.' } } : {}) }, ['$prop'])]
                : []),
              ...(fields.length ? [closed({ $item: { type: 'string', enum: fields } }, ['$item'])] : []),
              ...(states.length && bindable.some((f) => f === 'when' || f === 'unless') ? [{ ...closed({ $state: { type: 'string', enum: states } }, ['$state']), description: 'UI state, for when or unless.' }] : []),
              { type: 'null' }
            ]
          },
          eq: { ...SCALAR, description: 'when/unless only: compare the value with this.' },
          ne: { ...SCALAR, description: 'when/unless only: the value must differ from this.' }
        },
        ['nodeId', 'field', 'binding']
      )
    });
  // Properties: a node selected in the design may add one; changing an existing one reaches every placement's own value.
  const add = closed(
    {
      action: { type: 'string', enum: ['add'] },
      prop: { type: 'string', description: 'A new camelCase name, such as "tagline".' },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      type: { type: 'string', enum: [...ADDED_TYPES] },
      options: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 60 }, description: 'enum only: its option values, in order.' },
      default: { ...SCALAR, description: "Optional: what placements start with, for a text, number, yes/no, enum or link, or an image's assetId." }
    },
    ['action', 'prop', 'label', 'type']
  );
  const plain = Object.entries(def.properties).filter(([, p]) => PLAIN_DEFAULTS.has(p.type) && writableProp(p)).map(([k]) => k);
  const changes = [
    add,
    ...(whole && plain.length ? [closed({ action: { type: 'string', enum: ['set_default'] }, prop: { type: 'string', enum: plain }, value: SCALAR }, ['action', 'prop', 'value'])] : []),
    ...(whole && props.length ? [closed({ action: { type: 'string', enum: ['remove'] }, prop: { type: 'string', enum: props } }, ['action', 'prop'])] : [])
  ];
  tools.push({ ...describe('manage_component_prop'), parameters: closed({ change: oneOf(changes) }, ['change']) });
  // UI state: declaring or removing a variable is the whole design's (a component with state can no longer be detached
  // or converted to code, on every placement); a node selected in it wires its own buttons to the states it has.
  const buttons = nodes.filter((id) => tree.nodes[id]?.kind === 'link');
  const acting = buttons.filter((id) => (tree.nodes[id] as { stateAction?: unknown }).stateAction !== undefined);
  const stateChanges = [
    ...(whole ? [closed(
      {
        action: { type: 'string', enum: ['add'] },
        state: { type: 'string', description: 'A new camelCase name, such as "tab" or "open"; not a property name.' },
        label: { type: 'string', minLength: 1, maxLength: 80 },
        type: { type: 'string', enum: ['boolean', 'enum', 'item'], description: 'item: which item of a list property is the active one (a step whose content shows).' },
        options: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 60 }, description: 'enum only: its option values, in order.' },
        list: { type: 'string', description: 'item only: the list property whose active item it holds.' },
        initial: { anyOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'integer', minimum: 0 }], description: 'What every placement starts with: true or false, an option, or (item) the position of the item from 0. Defaults to false, the first option or the first item.' }
      },
      ['action', 'state', 'label', 'type']
    )] : []),
    ...(whole && states.length ? [closed({ action: { type: 'string', enum: ['remove'] }, state: { type: 'string', enum: states } }, ['action', 'state'])] : []),
    ...(buttons.length && states.length
      ? [
          closed(
            {
              action: { type: 'string', enum: ['on_click'] },
              nodeId: idSchema(buttons, 'The button.'),
              op: { type: 'string', enum: ['set', 'toggle', 'next', 'prev', 'select', 'none'], description: 'select: a button in a repeat of an item state\'s list makes its own item the active one.' },
              state: { type: 'string', enum: states, description: 'The state it changes; leave out for none.' },
              value: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: 'set only: true or false, or an option value.' },
              wrap: { type: 'boolean', description: 'next/prev only: go round from the last option to the first.' }
            },
            ['action', 'nodeId', 'op']
          )
        ]
      : acting.length
        ? // No state it can name: only clearing what a button already does (one naming state the design lost, say).
          [closed({ action: { type: 'string', enum: ['on_click'] }, nodeId: idSchema(acting, 'The button.'), op: { type: 'string', enum: ['none'] } }, ['action', 'nodeId', 'op'])]
        : [])
  ];
  if (stateChanges.length) tools.push({ ...describe('manage_component_state'), parameters: closed({ change: oneOf(stateChanges) }, ['change']) });
  // Styles: any rendered node, by ID or by part; a variant's rule is set on a node of its first top-level element.
  const styled = nodes.filter((id) => rendered(tree.nodes[id]));
  const parts = Object.keys(def.parts).filter((p) => styled.includes(def.parts[p].nodeId));
  const axes = axesOf(def);
  const fallback = styleDefault(s, target);
  if (styled.length)
    tools.push({
      ...describe('style_definition_element'),
      parameters: closed(
        {
          nodeId: idSchema(styled, fallback ? `The node to style. Defaults to ${fallback}.` : 'The node to style: the selected node renders no element of its own, so name one inside it.'),
          ...(parts.length ? { partId: { type: 'string', enum: parts, description: 'Or the part to style, instead of nodeId.' } } : {}),
          ...(axes.length
            ? { variant: { ...oneOf(axes.map(([axis, a]) => closed({ axis: { type: 'string', enum: [axis] }, option: { type: 'string', enum: Object.keys(a.options) } }, ['axis', 'option']))), description: "A variant option's rule instead of the base style." } }
            : {}),
          ...styleProps
        },
        ['scope', 'styles']
      )
    });
  // A node selected in the design may add an option to an axis it has: a new axis is a new choice on every placement.
  if (whole || axes.length)
    tools.push({
      ...describe('add_definition_variant'),
      parameters: closed(
        {
          axis: whole ? { type: 'string', description: `The axis to add to${axes.length ? `: ${axes.map(([a]) => a).join(', ')}` : ''}. A new camelCase name adds an axis.` } : { type: 'string', enum: axes.map(([a]) => a) },
          option: { type: 'string', description: 'The new option ID: lowercase letters, numbers and hyphens, such as "muted".' },
          label: { type: 'string', minLength: 1, maxLength: 60 }
        },
        ['axis', 'option', 'label']
      )
    });
  // Structure: new elements go inside a container here; any node but the design's own root can go.
  // A slot outlet holds its fallback: what the design shows there while a placement leaves the slot empty.
  const containers = nodes.filter((id) => tree.nodes[id]?.kind === 'element' || tree.nodes[id]?.kind === 'slot');
  if (containers.length)
    tools.push({
      ...describe('insert_definition_node'),
      parameters: closed(
        {
          parentId: idSchema(containers, 'The container to add it to, or a slot to add it to its fallback content.'),
          primitive: { type: 'string', enum: [...INSERTED] },
          text: { type: 'string', maxLength: 2000, description: 'Its text, for a heading, paragraph, button or badge, or a figure\'s caption ("" leaves the caption out).' },
          shape: { type: 'string', enum: [...DIVIDER_SHAPES], description: 'A divider only: "line" (default), "angle", "wave" or "icon".' },
          icon: { type: 'string', description: 'A badge\'s leading icon, or the icon of a divider of shape "icon", by name.' },
          index: { type: 'integer', minimum: 0, description: 'Its position among the container\'s children. Omit for the end.' }
        },
        ['parentId', 'primitive']
      )
    });
  const removable = nodes.filter((id) => removableNode(s, id));
  if (removable.length) tools.push({ ...describe('remove_definition_node'), parameters: closed({ nodeId: idSchema(removable, 'The node to remove.') }, ['nodeId']) });
  return tools;
}

/**
 * Whether a small model may remove a node: never the design's root, nor anything holding a slot's outlet, which shows
 * the content each placement put there (that needs the author's approval and the general tools).
 */
function removableNode(s: Scope, id: string): boolean {
  return id !== s.tree.rootIds[0] && !subtreeIds(s.tree, id).some((n) => s.tree.nodes[n]?.kind === 'slot');
}

/** The node a style call without nodeId or partId styles: the selected node, or the design's root, when it renders one. */
function styleDefault(s: Scope, target: DefinitionTarget): string | undefined {
  const id = target.nodeId ?? s.tree.rootIds[0];
  return rendered(s.tree.nodes[id]) ? id : undefined;
}

/**
 * The node a call names, checked against the nodes this call can take (`ids`, among the run's); null with an issue when
 * it is not one of them. `cannot` says why a node of the run's is not one (it renders no element, say).
 */
function namedNode(s: Scope, nodeId: string, ids: string[], issues: FieldIssue[], field = 'nodeId', cannot = 'cannot be used here'): GraphNode | null {
  if (ids.includes(nodeId)) return s.tree.nodes[nodeId];
  const listed = ids.length > 20 ? `${ids.slice(0, 20).join(', ')}, …` : ids.join(', ');
  const why = !Object.hasOwn(s.tree.nodes, nodeId) ? `no node "${nodeId}"` : s.nodes.includes(nodeId) ? `"${nodeId}" ${cannot}` : `"${nodeId}" is outside what this request may change`;
  issues.push({ field, message: `${why}. Nodes: ${listed || 'none'}` });
  return null;
}

export async function runDefinitionTool(name: DefinitionToolName, args: unknown, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const target = host.definitionTarget?.() ?? null;
  const state = host.state();
  const s = target ? resolveScope(state, target) : null;
  if (!target || !s) return noTarget();
  const { def, tree } = s;
  const owner = { kind: 'component' as const, id: def.id };
  const issues: FieldIssue[] = [];
  // A part picked inside a placement is styled on that placement, and nothing else is offered.
  if (s.part && (name !== 'style_definition_element' || !styledPart(s)))
    return fieldError([{ field: 'arguments', message: styledPart(s) ? "only the selected part's styles can change here: use style_definition_element, or ask the author before changing more" : 'this selection is inside another component placed here, or one item of it: ask the author before changing it' }], NOTHING_APPLIED);

  if (name === 'edit_definition_node') {
    const a = args as z.infer<(typeof DEFINITION_ARGS)['edit_definition_node']>;
    const node = namedNode(s, a.nodeId, s.nodes, issues);
    if (!node) return fieldError(issues, NOTHING_APPLIED);
    if (a.content === undefined && a.exposeAsPart === undefined) return fieldError([{ field: 'content', message: 'send the content to change, or exposeAsPart' }], NOTHING_APPLIED);
    const ops: EditOperation[] = [];
    if (a.content !== undefined) {
      const fields = nodeFields(node);
      const sent = Object.keys(a.content);
      const unknown = sent.filter((k) => !Object.hasOwn(fields, k));
      for (const k of unknown) issues.push({ field: `content.${k}`, message: Object.keys(fields).length ? `this ${node.kind} node has ${Object.keys(fields).join(', ')}` : 'this node has no content of its own' });
      if (!sent.length) issues.push({ field: 'content', message: 'send the fields to change' });
      const known = Object.fromEntries(Object.entries(a.content).filter(([k]) => Object.hasOwn(fields, k)));
      // New alt text alone keeps the picture: an image read without its assetId would otherwise become none.
      const image = known.image;
      if (image && typeof image === 'object' && !Array.isArray(image) && !Object.hasOwn(image, 'assetId')) {
        const current = node.kind === 'image' ? node.image : undefined;
        if (current && typeof current === 'object' && !isBinding(current)) known.image = { ...current, ...image };
        else issues.push({ field: 'content.image', message: 'send its assetId with the alt text' });
      }
      const { props, deferred } = checkProps({ name: 'Element', properties: fields } as ComponentDefinition, known, state, 'content', issues);
      // A design's content cannot create pages, so a link must point at one that exists.
      for (const d of deferred) issues.push({ field: `content.${d.prop}`, message: `no page uses the route ${d.route}` });
      for (const [field, value] of Object.entries(props)) ops.push({ type: 'node.setContent', owner, nodeId: node.id, field: field as Extract<EditOperation, { type: 'node.setContent' }>['field'], value });
    }
    if (a.exposeAsPart) {
      const { partId, label } = a.exposeAsPart;
      const held = Object.entries(def.parts).find(([, p]) => p.nodeId === node.id);
      if (!rendered(node)) issues.push({ field: 'exposeAsPart', message: 'repeats and slots render no element of their own: expose an element inside it' });
      else if (held) issues.push({ field: 'exposeAsPart', message: `this node is already the "${held[0]}" part` });
      else if (Object.hasOwn(def.parts, partId)) issues.push({ field: 'exposeAsPart.partId', message: `"${partId}" is already a part. Parts: ${Object.keys(def.parts).join(', ')}` });
      else ops.push({ type: 'component.setPart', definitionId: def.id, partId, nodeId: node.id, label });
    }
    if (issues.length) return fieldError(issues, NOTHING_APPLIED);
    return applySelected(ops, host, a.exposeAsPart && !a.content ? `Expose ${a.exposeAsPart.label}` : `Edit ${def.name}`, callId);
  }

  if (name === 'bind_definition_field') {
    const a = args as z.infer<(typeof DEFINITION_ARGS)['bind_definition_field']>;
    const node = namedNode(s, a.nodeId, s.nodes, issues);
    if (!node) return fieldError(issues, NOTHING_APPLIED);
    const fields: string[] = bindableFields(node);
    if (!fields.includes(a.field)) return fieldError([{ field: 'field', message: `this ${node.kind} node binds ${fields.join(', ')}` }], NOTHING_APPLIED);
    // The fields of every list here are offered; this node shows only those of the list repeated around it.
    if (a.binding && '$item' in a.binding) {
      const own = itemFields(def, node.id);
      if (!own.includes(a.binding.$item)) return fieldError([{ field: 'binding.$item', message: own.length ? `this node is inside a list whose items have ${own.join(', ')}` : 'this node is not inside a repeat, so it has no list item fields' }], NOTHING_APPLIED);
    }
    if (a.binding && '$state' in a.binding) {
      if (a.field !== 'when' && a.field !== 'unless') return fieldError([{ field: 'binding.$state', message: 'UI state shows or hides a node: bind it to when or unless' }], NOTHING_APPLIED);
      if (!declaredState(def, a.binding.$state)) return fieldError([{ field: 'binding.$state', message: `"${def.name}" has no UI state "${a.binding.$state}". ${Object.keys(def.state ?? {}).length ? `States: ${Object.keys(def.state ?? {}).join(', ')}` : 'Add it with manage_component_state first'}` }], NOTHING_APPLIED);
    }
    // The engine checks the property, the item field, the state and the comparison against this node.
    const op = { type: 'node.setBinding', owner, nodeId: node.id, field: a.field, binding: a.binding, ...(a.eq !== undefined ? { eq: a.eq } : {}), ...(a.ne !== undefined ? { ne: a.ne } : {}) } as EditOperation;
    return applySelected([op], host, a.binding === null ? `Unbind ${a.field}` : `Bind ${a.field}`, callId);
  }

  if (name === 'manage_component_prop') {
    const { change } = args as z.infer<(typeof DEFINITION_ARGS)['manage_component_prop']>;
    if (change.action === 'add') {
      // An upsert would replace an existing property's schema, and with it what every placement holds.
      if (Object.hasOwn(def.properties, change.prop)) return fieldError([{ field: 'change.prop', message: `"${def.name}" already has a property "${change.prop}". Properties: ${Object.keys(def.properties).join(', ')}` }], NOTHING_APPLIED);
      if (change.options !== undefined && change.type !== 'enum') return fieldError([{ field: 'change.options', message: 'only an enum property has options' }], NOTHING_APPLIED);
      const raw: Record<string, unknown> = { type: change.type, label: change.label, ...(change.options ? { options: change.options } : {}) };
      let schema: PropSchema;
      try {
        schema = normalizePropSchema(raw, state, change.prop);
      } catch (e) {
        return fieldError([{ field: 'change', message: (e as Error).message }], NOTHING_APPLIED);
      }
      if (change.default !== undefined) {
        if (!PLAIN_DEFAULTS.has(schema.type)) return fieldError([{ field: 'change.default', message: `a ${schema.type} property starts empty: leave default out` }], NOTHING_APPLIED);
        // Anything but an ID would read as an empty image.
        if (schema.type === 'image' && typeof change.default !== 'string') return fieldError([{ field: 'change.default', message: "an image's default is its assetId, from search_assets" }], NOTHING_APPLIED);
        const checked = checkProps({ name: def.name, properties: { [change.prop]: schema } } as unknown as ComponentDefinition, { [change.prop]: change.default }, state, 'change.default', issues);
        for (const d of checked.deferred) issues.push({ field: 'change.default', message: `no page uses the route ${d.route}` });
        if (issues.length) return fieldError(issues.map((i) => ({ ...i, field: 'change.default' })), NOTHING_APPLIED);
        raw.default = checked.props[change.prop];
      }
      return applySelected([{ type: 'component.setPropSchema', definitionId: def.id, prop: change.prop, schema: raw }], host, `Add ${change.label}`, callId);
    }
    if (!Object.hasOwn(def.properties, change.prop)) return fieldError([{ field: 'change.prop', message: `"${def.name}" has no property "${change.prop}". Properties: ${Object.keys(def.properties).join(', ') || 'none'}` }], NOTHING_APPLIED);
    if (change.action === 'remove') return applySelected([{ type: 'component.removePropSchema', definitionId: def.id, prop: change.prop }], host, `Remove ${def.properties[change.prop].label}`, callId);
    const schema = def.properties[change.prop];
    if (!PLAIN_DEFAULTS.has(schema.type)) return fieldError([{ field: 'change.prop', message: `"${change.prop}" is a ${schema.type} property, whose default is not one plain value` }], NOTHING_APPLIED);
    if (schema.type === 'image' && typeof change.value !== 'string') return fieldError([{ field: 'change.value', message: "an image's default is its assetId, from search_assets" }], NOTHING_APPLIED);
    const checked = checkProps(def, { [change.prop]: change.value }, state, 'change.value', issues);
    for (const d of checked.deferred) issues.push({ field: 'change.value', message: `no page uses the route ${d.route}` });
    if (issues.length) return fieldError(issues.map((i) => ({ ...i, field: 'change.value' })), NOTHING_APPLIED);
    return applySelected([{ type: 'component.setPropDefault', definitionId: def.id, prop: change.prop, value: checked.props[change.prop] }], host, `Change ${schema.label}`, callId);
  }

  if (name === 'manage_component_state') {
    const { change } = args as z.infer<(typeof DEFINITION_ARGS)['manage_component_state']>;
    const known = () => (Object.keys(def.state ?? {}).length ? `States: ${Object.keys(def.state ?? {}).join(', ')}` : 'It has none: add one first');
    // Declaring or removing a variable reaches every placement (one with state can no longer be detached): the whole design's.
    if (change.action !== 'on_click' && target.nodeId !== undefined)
      return fieldError([{ field: 'change.action', message: 'adding or removing UI state changes the whole component: ask the author first, or wire this button to a state the component has' }], NOTHING_APPLIED);
    if (change.action === 'add') {
      // Setting one it has would change it, and every button and panel that uses it.
      if (Object.hasOwn(def.state ?? {}, change.state)) return fieldError([{ field: 'change.state', message: `"${def.name}" already has the UI state "${change.state}". ${known()}` }], NOTHING_APPLIED);
      if (change.options !== undefined && change.type !== 'enum') return fieldError([{ field: 'change.options', message: 'only an enum state has options' }], NOTHING_APPLIED);
      if (change.type === 'enum' && change.options === undefined) return fieldError([{ field: 'change.options', message: 'an enum state needs its option values' }], NOTHING_APPLIED);
      if (change.list !== undefined && change.type !== 'item') return fieldError([{ field: 'change.list', message: 'only an item state names a list' }], NOTHING_APPLIED);
      if (change.type === 'item' && change.list === undefined) return fieldError([{ field: 'change.list', message: 'an item state needs the list property whose active item it holds' }], NOTHING_APPLIED);
      const schema = { type: change.type, label: change.label, ...(change.options ? { options: change.options } : {}), ...(change.list !== undefined ? { list: change.list } : {}), ...(change.initial !== undefined ? { initial: change.initial } : {}) };
      return applySelected([{ type: 'component.setState', definitionId: def.id, state: change.state, schema }], host, `Add ${change.label}`, callId);
    }
    if (change.action === 'remove') {
      if (!Object.hasOwn(def.state ?? {}, change.state)) return fieldError([{ field: 'change.state', message: `"${def.name}" has no UI state "${change.state}". ${known()}` }], NOTHING_APPLIED);
      return applySelected([{ type: 'component.removeState', definitionId: def.id, state: change.state }], host, `Remove ${def.state![change.state].label || change.state}`, callId);
    }
    const button = namedNode(s, change.nodeId, s.nodes.filter((id) => tree.nodes[id]?.kind === 'link'), issues, 'change.nodeId', 'is not a button');
    if (!button) return fieldError(issues, NOTHING_APPLIED);
    if (change.op === 'none') return applySelected([{ type: 'node.setStateAction', owner, nodeId: button.id, action: null }], host, `Clear what ${button.name ?? button.id} does`, callId);
    if (change.state === undefined) return fieldError([{ field: 'change.state', message: `name the state it changes. ${known()}` }], NOTHING_APPLIED);
    if (change.op !== 'set' && change.value !== undefined) issues.push({ field: 'change.value', message: 'only op "set" takes a value' });
    if (change.op === 'set' && change.value === undefined) issues.push({ field: 'change.value', message: 'op "set" needs the value: true or false, or an option' });
    if (change.op !== 'next' && change.op !== 'prev' && change.wrap !== undefined) issues.push({ field: 'change.wrap', message: 'only next and prev take wrap' });
    if (issues.length) return fieldError(issues, NOTHING_APPLIED);
    const action = (
      change.op === 'set'
        ? { state: change.state, op: 'set', value: change.value! }
        : change.op === 'toggle' || change.op === 'select'
          ? { state: change.state, op: change.op }
          : { state: change.state, op: change.op, ...(change.wrap !== undefined ? { wrap: change.wrap } : {}) }
    ) as StateAction;
    // The engine checks the state and that the action is one it can make.
    return applySelected([{ type: 'node.setStateAction', owner, nodeId: button.id, action }], host, `Set what ${button.name ?? button.id} does`, callId);
  }

  if (name === 'insert_definition_node') {
    const a = args as z.infer<(typeof DEFINITION_ARGS)['insert_definition_node']>;
    const parent = namedNode(s, a.parentId, s.nodes.filter((id) => tree.nodes[id]?.kind === 'element' || tree.nodes[id]?.kind === 'slot'), issues, 'parentId', 'holds no children: name a container or a slot');
    if (!parent) return fieldError(issues, NOTHING_APPLIED);
    const op: EditOperation = {
      type: 'node.insert',
      owner,
      parentId: parent.id,
      primitive: a.primitive,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.shape !== undefined ? { shape: a.shape } : {}),
      ...(a.icon !== undefined ? { icon: a.icon } : {}),
      ...(a.index !== undefined ? { index: a.index } : {})
    };
    const res = await applySelected([op], host, `Add ${a.primitive}`, callId);
    // The new node's ID, for the next step that binds, styles or exposes it.
    const made = res.ok ? (res.results?.[0] as { nodeId?: string } | undefined)?.nodeId : undefined;
    return made ? { ...res, content: { ...(res.content as Record<string, unknown>), nodeId: made } } : res;
  }

  if (name === 'remove_definition_node') {
    const a = args as z.infer<(typeof DEFINITION_ARGS)['remove_definition_node']>;
    const node = namedNode(s, a.nodeId, s.nodes.filter((id) => removableNode(s, id)), issues, 'nodeId', a.nodeId === tree.rootIds[0] ? "is the design's root, which every placement is" : "holds a slot's outlet, which shows each placement's own content: ask the author first");
    if (!node) return fieldError(issues, NOTHING_APPLIED);
    return applySelected([{ type: 'node.remove', owner, nodeId: node.id }], host, `Remove ${node.name ?? node.id}`, callId);
  }

  if (name === 'add_definition_variant') {
    const a = args as z.infer<(typeof DEFINITION_ARGS)['add_definition_variant']>;
    const axis = axesOf(def).find(([id]) => id === a.axis)?.[1];
    if (axis && Object.hasOwn(axis.options, a.option)) return fieldError([{ field: 'option', message: `"${a.option}" is already an option of ${a.axis}: ${Object.keys(axis.options).join(', ')}` }], NOTHING_APPLIED);
    return applySelected([{ type: 'component.setVariant', definitionId: def.id, axis: a.axis, variant: a.option, label: a.label }], host, `Add ${a.label}`, callId);
  }

  const a = args as z.infer<(typeof DEFINITION_ARGS)['style_definition_element']>;
  a.styles.forEach((st, i) => {
    if (!STYLE_PROPS.some((p) => p.id === st.property)) issues.push({ field: `styles[${i}].property`, message: `unknown style property "${st.property}"` });
    else if (a.state !== undefined && st.value !== null && !isStateStyleProp(st.property, a.state)) issues.push({ field: `styles[${i}].property`, message: stateStyleError(st.property, a.state)! });
  });
  let nodeId: string;
  let partId: string | undefined;
  const part = styledPart(s);
  if (s.part) {
    // The selected part of a placement in the design, styled on that placement.
    if (!part || target.nodeId === undefined) return fieldError([{ field: 'partId', message: 'this selection is inside another component placed here: ask the author before changing it' }], NOTHING_APPLIED);
    if (a.nodeId !== undefined || a.variant !== undefined || (a.partId !== undefined && a.partId !== part)) return fieldError([{ field: a.variant !== undefined ? 'variant' : a.nodeId !== undefined ? 'nodeId' : 'partId', message: `only the selected part "${part}" can be styled here` }], NOTHING_APPLIED);
    nodeId = target.nodeId;
    partId = part;
  } else {
    if (a.nodeId !== undefined && a.partId !== undefined) issues.push({ field: 'partId', message: 'name the node or the part, not both' });
    const styled = s.nodes.filter((id) => rendered(tree.nodes[id]));
    const viaPart = a.partId !== undefined && Object.hasOwn(def.parts, a.partId) ? def.parts[a.partId].nodeId : undefined;
    if (a.partId !== undefined && viaPart === undefined) issues.push({ field: 'partId', message: `no part "${a.partId}". Parts: ${Object.keys(def.parts).join(', ')}` });
    nodeId = viaPart ?? a.nodeId ?? target.nodeId ?? tree.rootIds[0];
    const named = a.partId !== undefined ? 'partId' : 'nodeId';
    if (!namedNode(s, nodeId, styled, issues, named, a.partId === undefined && a.nodeId === undefined ? 'renders no element of its own: name a node inside it' : 'renders no element of its own: style an element inside it'))
      return fieldError(issues, NOTHING_APPLIED);
    if (a.variant) {
      const axis = axesOf(def).find(([id]) => id === a.variant!.axis)?.[1];
      if (!axis) issues.push({ field: 'variant.axis', message: `no variant axis "${a.variant.axis}". Axes: ${axesOf(def).map(([id]) => id).join(', ') || 'none: add one with add_definition_variant'}` });
      else if (!Object.hasOwn(axis.options, a.variant.option)) issues.push({ field: 'variant.option', message: `must be one of: ${Object.keys(axis.options).join(', ')}` });
      // Only the first top-level element carries the variant's class.
      if (tree.rootIds.indexOf(nodeId) > 0) issues.push({ field: a.partId !== undefined ? 'partId' : 'nodeId', message: 'only the first top-level element carries the variant: style an element inside it' });
    }
  }
  if (issues.length) return fieldError(issues, NOTHING_APPLIED);
  const rule = a.variant ? { variant: a.variant.option, axis: a.variant.axis } : {};
  const ops: EditOperation[] = a.styles.map((st) => ({ type: 'node.setStyle', owner, nodeId, ...(partId ? { partId } : {}), ...rule, scope: a.scope, ...(a.state ? { state: a.state } : {}), property: st.property, value: st.value }));
  return applySelected(ops, host, a.variant ? `Style ${a.variant.option}` : `Style ${def.name}`, callId);
}
