/**
 * Selection tools: the small tool set for "change this element". Everything the model needs is in the schema,
 * generated from the selected component's own contract, and each call compiles to ordinary edit operations
 * that the run's authority still checks.
 */
import { variantOptions } from '@shared/variants';
import { z } from 'zod';
import { DIVIDER_ICON, DIVIDER_SHAPES, STYLE_STATES, TEXT_TAGS, isBinding, type ButtonAppearance, type ComponentDefinition, type ElementRef, type GraphNode, type NodeTree, type OwnerRef, type ProjectState, type PropSchema } from '@shared/types';
import { BACKGROUND_IMAGE, STYLE_TOKEN_REF, type EditOperation } from '@shared/ops';
import { STYLE_PROPS, isStateStyleProp, placementStyleControls, stateStyleError } from '@shared/styles';
import { codeTakesOverrides, getTree } from '@engine/tree';
import { TABLE_ACTIONS, TABLE_LIMITS, type TableAction } from '@engine/table';
import { checkProps, chooseVariants, fieldError, variantsJsonSchema, type FieldIssue } from './macros';
import { propJsonSchema, propsJsonSchema, type JsonSchema } from './propschema';
import type { ToolDefinition } from './types';
import type { ToolHost, ToolOutcome } from './tools';
import { repeatedPartList } from '@shared/item-styles';
import { partReach, type PartReach } from './scope';

type ContentField = Extract<EditOperation, { type: 'node.setContent' }>['field'];

export const SELECTION_ARGS = {
  update_selected_props: z.object({ props: z.record(z.string(), z.unknown()).optional(), variant: z.string().optional(), variants: z.record(z.string(), z.string()).optional() }),
  edit_selected_list: z.object({
    prop: z.string(),
    action: z.enum(['update', 'insert', 'remove', 'move']),
    itemId: z.string().optional(),
    index: z.number().int().min(0).optional(),
    fields: z.record(z.string(), z.unknown()).optional()
  }),
  edit_selected_table: z.object({
    prop: z.string(),
    action: z.enum(TABLE_ACTIONS as [TableAction, ...TableAction[]]),
    rowId: z.string().optional(),
    columnId: z.string().optional(),
    index: z.number().int().min(0).optional(),
    value: z.string().optional(),
    cells: z.array(z.string()).optional()
  }),
  // Closed, so a misspelled key (itemID) is refused instead of dropped: dropping it would style every item.
  style_selected_element: z
    .object({
      partId: z.string().optional(),
      itemId: z.string().optional(),
      resetItem: z.boolean().optional(),
      scope: z.enum(['base', 'phone', 'tablet', 'desktop']),
      state: z.enum(STYLE_STATES).optional(),
      styles: z.array(z.object({ property: z.string(), value: z.union([z.string(), z.number(), z.boolean(), STYLE_TOKEN_REF, BACKGROUND_IMAGE, z.null()]) }).strict()).max(12)
    })
    .strict(),
  request_wider_scope: z.object({ question: z.string().min(1).max(300) })
} as const;

export const SELECTION_DESCRIPTIONS: Record<keyof typeof SELECTION_ARGS, string> = {
  update_selected_props: 'Change the content of the selected element. Send only the properties that change.',
  edit_selected_list: 'Change one item of a list in the selected element: update, insert, remove or move it.',
  edit_selected_table:
    'Change one cell, row or column of a table in the selected element, by the row and column IDs in its content: set a cell, rename a column, or insert, remove or move a row or column. Other cells stay where they are.',
  style_selected_element:
    'Style the selected element. Use scope "phone", "tablet" or "desktop" to change one screen size only, and prefer token values such as {"token":"space.lg"}. Add state "hover", "focus" (keyboard focus) or "active" (while pressed) to style how it looks in that state only (colors, background, border, corner radius, shadow, opacity and backdrop blur); state "groupHover" or "groupFocus" styles it while the nearest interaction group around it (a card) is hovered or holds focus, and may also shift, scale or rotate it; set transition on the resting style to animate the change; null values clear the state\'s value. For a see-through surface, give color or background a color token at part strength, {"token":"color.surface","alpha":0.7} for 70% (a plain {"token"} is full strength again); add backdropBlur such as "12px" for frosted glass, "0" for none. For a cropped image, objectPosition takes the focal point as "X% Y%" across and down, each 0 to 100 with at most one decimal, such as "50% 20%". For a picture behind the content of a container or section, backgroundImage takes {"assetId": the ID of a library image, "size": "cover" or "contain", "position": "X% Y%", "scrim": a color such as "rgba(0, 0, 0, 0.55)" or one gradient}; give it a scrim whenever text sits on top. Motion: translateX and translateY take a length such as "-4px", scale a factor such as 1.03, rotate degrees such as -2, transformOrigin "center" or an edge or corner such as "top left", transition a preset (none, colors, shadow, transform, opacity, common), transitionDuration milliseconds such as 200 and transitionEasing ease, ease-out, linear or smooth. Grids: gridTemplate takes a preset or column sizes such as "16rem 1fr 14rem", "2fr repeat(2, 1fr)" or "repeat(auto-fit, minmax(18rem, 1fr))" (as many columns as fit, each at least 18rem or the whole grid when narrower); a grid child spans columns with columnSpan (1 to 12 or full) and rows with rowSpan (1 to 6). Set for all sizes, a template and spans above 1 apply from tablet up, so phones keep their own columns unless scope "phone" sets them. A repeated part (a card) is styled for every item unless itemId names the one item to style; that item then differs from its siblings, and null values return it to the shared style.',
  request_wider_scope: 'Ask the user for permission to change more than the selected element, when the request cannot be done inside it.'
};

/** The same rules for a grammar-constrained local model, which reads every byte before it answers. */
export const SELECTION_BRIEFS: Record<keyof typeof SELECTION_ARGS, string> = {
  update_selected_props: 'Send only the properties that change.',
  edit_selected_list: 'Update, insert, remove or move one item of a list.',
  edit_selected_table: 'Set a cell, rename a column, or insert, remove or move a row or column, by the IDs in its content.',
  style_selected_element:
    'scope styles one screen size, base all; state, that state only. Prefer tokens such as {"token":"space.lg"}; a color token with "alpha":0.7 paints at 70%, see-through; backdropBlur "12px" frosts what shows through. objectPosition is a focal point "X% Y%" across and down (each 0 to 100, at most one decimal, such as "50% 20%"). backgroundImage puts a library image behind a container; add a scrim when text sits on it. translateX/Y take a length ("-4px"), scale a factor (1.03), rotate degrees, transformOrigin center or an edge or corner ("top left"), transition a preset (none, colors, shadow, transform, opacity, common), transitionDuration ms, transitionEasing ease, ease-out, linear or smooth. gridTemplate takes a preset or column sizes ("16rem 1fr", "repeat(auto-fit, minmax(18rem, 1fr))"); a grid child spans columnSpan 1 to 12 or full and rowSpan 1 to 6. Set for all sizes, a template and spans above 1 apply from tablet up; phones keep their own unless scope phone sets them. A repeated part (a card) is styled for every item unless itemId names one; null values return it to the shared style.',
  request_wider_scope: 'Ask permission to change more than the selected element.'
};

export interface SelectionTarget {
  owner: OwnerRef;
  nodeId: string;
  partId?: string;
  itemId?: string;
  /** Inside a component nested in the placement: its parts cannot be addressed from the outer instance. */
  nested?: boolean;
}

export function selectionTarget(ref: ElementRef | null | undefined): SelectionTarget | null {
  if (!ref) return null;
  const inInstance = ref.instancePath.length > 0;
  return {
    owner: ref.owner,
    nodeId: ref.instancePath[0] ?? ref.nodeId,
    ...(inInstance && ref.partId ? { partId: ref.partId } : {}),
    ...(ref.itemPath?.length ? { itemId: ref.itemPath[ref.itemPath.length - 1] } : {}),
    ...(ref.instancePath.length > 1 ? { nested: true } : {})
  };
}

const choice = (label: string, values: readonly string[]): PropSchema => ({ type: 'enum', label, default: values[0], options: values.map((value) => ({ value, label: value })) });
/** The tags the engine lets a plain text element change to. */
const TEXT_TAG_CHOICES = TEXT_TAGS;
const APPEARANCES: readonly ButtonAppearance[] = ['primary', 'secondary', 'text', 'light', 'link', 'plain'];

/** Content fields of a basic element, expressed as properties so one tool edits every kind of selection. */
const NODE_FIELDS: Partial<Record<GraphNode['kind'], Record<string, PropSchema>>> = {
  text: { text: { type: 'string', label: 'Text', default: '', multiline: true, maxLength: 20000 }, tag: choice('HTML tag: heading level, paragraph, or inline, quote, term or caption text', TEXT_TAG_CHOICES) },
  image: { image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } } },
  link: {
    label: { type: 'string', label: 'Button label', default: '' },
    link: { type: 'link', label: 'Destination', default: { type: 'none', target: '' } },
    appearance: choice('Button style', APPEARANCES)
  },
  icon: { icon: { type: 'icon', label: 'Icon', default: 'sparkles' } },
  divider: { shape: choice('Shape: a plain line, or a decorative angle, wave or icon band in the divider\'s text color', DIVIDER_SHAPES) },
  element: { interactionGroup: { type: 'boolean', label: 'Interaction group: hovering it, or focus inside it, shows the groupHover and groupFocus styles of what is inside', default: false } }
};

/**
 * The fields this element can change. Rich text keeps its paragraph structure, and a tag or style bound to a
 * repeated item is set by the item, so neither is offered.
 */
export function nodeFields(node: GraphNode): Record<string, PropSchema> {
  const fields = { ...NODE_FIELDS[node.kind] };
  if (node.kind === 'text' && (node.rich || isBinding(node.tag))) delete fields.tag;
  if (node.kind === 'link' && isBinding(node.appearance)) delete fields.appearance;
  // Only an icon divider shows an icon: its shape is set first, then its icon.
  if (node.kind === 'divider' && node.shape === 'icon') fields.icon = { type: 'icon', label: 'Icon', default: DIVIDER_ICON };
  return fields;
}

interface Resolved {
  tree: NodeTree;
  node: GraphNode;
  def?: ComponentDefinition;
  properties: Record<string, PropSchema>;
}

function resolve(state: ProjectState, target: SelectionTarget): Resolved | null {
  let tree: NodeTree;
  try {
    tree = getTree(state, target.owner);
  } catch {
    return null;
  }
  const node = Object.hasOwn(tree.nodes, target.nodeId) ? tree.nodes[target.nodeId] : undefined;
  if (!node) return null;
  if (node.kind === 'instance') {
    const def = state.components[node.definitionId];
    return def ? { tree, node, def, properties: def.properties } : null;
  }
  return { tree, node, properties: nodeFields(node) };
}

/**
 * What a part selected inside a placement shows, or null when the selection is the whole placement (or a code
 * component's, whose parts cannot say what they show). The run may change only that; see checkAuthority.
 */
function selectedPartReach(r: Resolved, target: SelectionTarget): PartReach | null {
  if (!target.partId || !r.def || !Object.hasOwn(r.def.parts, target.partId)) return null;
  // A code component has no tree to say what its parts show: only the part's own styles.
  if (!r.def.tree) return target.partId === 'root' ? null : partReach(r.def, '');
  const nodeId = r.def.parts[target.partId].nodeId;
  return r.def.tree.rootIds[0] === nodeId ? null : partReach(r.def, nodeId);
}

export const STYLE_VALUE: JsonSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'A site token such as space.lg or color.brand.' },
        alpha: { type: 'number', minimum: 0, maximum: 1, description: 'color and background only: the color token at part strength, 0 to 1 (0.7 is 70%), for a see-through surface. Leave it out for full strength.' }
      },
      required: ['token'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'backgroundImage only: the ID of a library image (search_assets finds one).' },
        size: { type: 'string', enum: ['cover', 'contain'], description: 'cover (the default) fills the box and crops; contain shows the whole picture.' },
        position: { type: 'string', description: 'The focus kept in view when cropped: "X% Y%" across and down, such as "50% 30%". Defaults to the center.' },
        scrim: { type: 'string', description: 'A color such as "rgba(0, 0, 0, 0.55)" or one linear-gradient() painted over the picture, so text on top stays readable.' }
      },
      required: ['assetId'],
      additionalProperties: false
    },
    { type: 'null' }
  ],
  description: 'A value, a token reference, a background image (backgroundImage only), or null to remove the override.'
};

type ListSchema = Extract<PropSchema, { type: 'list' }>;
type Shape = { lists: Array<{ key: string; description?: string }>; schema: JsonSchema };

/** Each list field's shapes by name, with the lists using each. Fields that differ only in their label are one shape. */
function listShapes(lists: Array<[string, ListSchema]>): Map<string, Shape[]> {
  const shapes = new Map<string, Shape[]>();
  for (const [key, s] of lists)
    for (const [name, schema] of Object.entries((propJsonSchema(s).items as JsonSchema).properties as Record<string, JsonSchema>)) {
      if (name === 'id') continue;
      const seen = shapes.get(name) ?? [];
      const shape = JSON.stringify({ ...schema, description: undefined });
      const entry = { key, ...(schema.description !== undefined ? { description: String(schema.description) } : {}) };
      const same = seen.find((x) => JSON.stringify({ ...x.schema, description: undefined }) === shape);
      if (same) same.lists.push(entry);
      else seen.push({ lists: [entry], schema });
      shapes.set(name, seen);
    }
  return shapes;
}

/** A shape's description, naming its lists when it is one of several or when they describe it differently. */
function describeShape(shape: Shape, name: string, alone: boolean): string | undefined {
  const descriptions = [...new Set(shape.lists.map((l) => l.description ?? name))];
  if (descriptions.length > 1) return shape.lists.map((l) => `When prop is "${l.key}": ${l.description ?? name}`).join('. ');
  return alone ? (shape.schema.description as string | undefined) : `When prop is ${shape.lists.map((l) => `"${l.key}"`).join(' or ')}: ${descriptions[0]}`;
}

/**
 * One closed object with the fields of every list; the app checks them against the list named by `prop`. A
 * name two lists use differently takes either list's shape, each labelled with its lists, rather than one
 * list's shape silently replacing the other's.
 */
function listFields(lists: Array<[string, ListSchema]>): Record<string, JsonSchema> {
  const fields: Record<string, JsonSchema> = {};
  for (const [name, seen] of listShapes(lists)) {
    const branches = seen.map((x) => {
      const description = describeShape(x, name, seen.length === 1);
      return { ...x.schema, ...(description !== undefined ? { description } : {}) };
    });
    fields[name] = branches.length === 1 ? branches[0] : { anyOf: branches };
  }
  return fields;
}

/**
 * Another list's shape for a field this list's check would quietly empty rather than refuse: a number for an
 * image, or an image or a list of choices for a link.
 */
function emptiedBy(field: PropSchema, v: unknown): string | null {
  if (field.type === 'image' && (typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v))) return 'must be an image: an asset ID or { assetId, alt }';
  if (field.type === 'link' && !!v && typeof v === 'object' && (Array.isArray(v) || !('type' in v))) return 'must be a link: a route, a URL or { type, target }';
  return null;
}

/**
 * The tools for a selection, or null when they cannot cover it: inside a component's own definition (which has tools of
 * its own, see definition.ts), or on a layout element whose content lives in its children. `widened`: the user has let
 * the run change more than the selection, so a selected item no longer limits its styles.
 */
/** Whether the selected placement (or its selected part) can take a background image, which names a library image by ID. */
export function selectionTakesBackground(state: ProjectState, target: SelectionTarget | null): boolean {
  const r = target && !target.nested && target.owner.kind !== 'component' ? resolve(state, target) : null;
  if (!r?.def) return false;
  const list = placementStyleControls(r.def, target!.partId ?? 'root', codeTakesOverrides(r.def));
  return list === undefined || !!list?.includes('backgroundImage');
}

export function selectionTools(state: ProjectState, target: SelectionTarget | null, opts: { widened?: boolean } = {}): ToolDefinition[] | null {
  if (!target || target.nested || target.owner.kind === 'component') return null;
  const r = resolve(state, target);
  // A layout element takes the general tools, as before it could be an interaction group: its content is its children.
  if (!r || r.node.kind === 'element' || !Object.keys(r.properties).length) return null;
  const tools: ToolDefinition[] = [];
  // A selected part offers only what it shows; its placement's variants change the whole section.
  // Widened, the run may change the whole placement: every part and property is offered again.
  const reach = opts.widened ? null : selectedPartReach(r, target);
  // A placement property shown in a repeated part shows in every item, not only the selected one.
  const placementWide = (k: string) => !!reach && reach.props.has(k) && !(target.itemId !== undefined && reach.repeated);
  const shown = reach ? Object.fromEntries(Object.entries(r.properties).filter(([k]) => placementWide(k))) : r.properties;
  const variants = r.def && !reach ? [...new Set(variantOptions(r.def).map((o) => o.id))] : [];
  const byAxis = r.def && !reach ? variantsJsonSchema(r.def, true) : null;
  if (Object.keys(shown).length || variants.length)
    tools.push({
      name: 'update_selected_props',
      description: SELECTION_DESCRIPTIONS.update_selected_props,
      brief: SELECTION_BRIEFS.update_selected_props,
      parameters: {
        type: 'object',
        properties: {
          props: propsJsonSchema({ properties: shown }),
          ...(variants.length ? { variant: { type: 'string', enum: variants, description: 'Visual variant: one option, on whichever axis has it. To set several axes, use variants.' } } : {}),
          ...(byAxis ? { variants: byAxis } : {})
        },
        additionalProperties: false
      }
    });
  // A computed list (news, an article header) is filled from the site's pages: it has no items to edit.
  const lists = Object.entries(r.properties).filter(([k, s]) => s.type === 'list' && !s.feed && (!reach || placementWide(k) || reach.itemFields.has(k))) as Array<[string, ListSchema]>;
  if (lists.length) {
    const fields = listFields(lists);
    tools.push({
      name: 'edit_selected_list',
      description: SELECTION_DESCRIPTIONS.edit_selected_list,
      brief: SELECTION_BRIEFS.edit_selected_list,
      parameters: {
        type: 'object',
        properties: {
          prop: { type: 'string', enum: lists.map(([k]) => k) },
          action: { type: 'string', enum: ['update', 'insert', 'remove', 'move'] },
          itemId: { type: 'string', description: 'The item to change. Not needed for insert.' },
          index: { type: 'integer', minimum: 0, description: 'Position for insert or move.' },
          fields: { type: 'object', properties: fields, additionalProperties: false, description: 'Field values for update or insert.' }
        },
        required: ['prop', 'action'],
        additionalProperties: false
      }
    });
  }
  const tables = Object.entries(r.properties).filter(([, s]) => s.type === 'table');
  if (tables.length && r.node.kind === 'instance')
    tools.push({
      name: 'edit_selected_table',
      description: SELECTION_DESCRIPTIONS.edit_selected_table,
      brief: SELECTION_BRIEFS.edit_selected_table,
      parameters: {
        type: 'object',
        properties: {
          prop: { type: 'string', enum: tables.map(([k]) => k) },
          action: { type: 'string', enum: [...TABLE_ACTIONS] },
          rowId: { type: 'string', description: 'The row to change: setCell, removeRow, moveRow.' },
          columnId: { type: 'string', description: 'The column to change: setCell, renameColumn, removeColumn, moveColumn.' },
          index: { type: 'integer', minimum: 0, description: 'Position for insert or move. Inserts default to the end.' },
          value: { type: 'string', maxLength: TABLE_LIMITS.cell, description: "setCell: the cell's text. renameColumn and insertColumn: the column's name." },
          cells: { type: 'array', maxItems: TABLE_LIMITS.columns, items: { type: 'string', maxLength: TABLE_LIMITS.cell }, description: "insertRow: the new row's cells in column order." }
        },
        required: ['prop', 'action'],
        additionalProperties: false
      }
    });
  const parts = r.def ? Object.keys(r.def.parts).filter((p) => !reach || p === target.partId || reach.nodes.has(r.def!.parts[p].nodeId)) : [];
  // Parts shown once per list item, which can be styled for one item alone.
  const perItem = r.def ? parts.filter((p) => repeatedPartList(r.def!, p)) : [];
  // With one item selected, its part is styled for that item alone unless the user widens the request.
  // A selected item limits a run to its own style until the user widens it: omitted, itemId is that item.
  const itemOnly = !!target.itemId && !!reach && !opts.widened;
  const selectedItem = target.itemId ? ` The selected item is "${target.itemId}".` : '';
  tools.push({
    name: 'style_selected_element',
    description: SELECTION_DESCRIPTIONS.style_selected_element,
      brief: SELECTION_BRIEFS.style_selected_element,
    parameters: {
      type: 'object',
      properties: {
        ...(parts.length ? { partId: { type: 'string', enum: parts, description: `Part to style. Defaults to ${target.partId ?? 'root'}.` } } : {}),
        ...(perItem.length
          ? {
              itemId: {
                type: 'string',
                description: `Style only this list item (its stable ID), on a repeated part (${perItem.join(', ')}); the other items keep the shared style.${itemOnly ? ` Omitted, it is the selected item "${target.itemId}": styling every item needs request_wider_scope first.` : ` Omit to style every item.${selectedItem}`}`
              },
              resetItem: { type: 'boolean', description: 'With itemId: first return that item to the shared style at every size, clearing its own styles (with state, only its rule for that state at scope); then apply styles, which may be empty.' }
            }
          : {}),
        scope: { type: 'string', enum: ['base', 'phone', 'tablet', 'desktop'] },
        state: { type: 'string', enum: [...STYLE_STATES], description: 'Style only this interactive state: hover, focus (keyboard focus) or active (while pressed); groupHover or groupFocus while the nearest interaction group around it (a card) is hovered or holds focus, which can also shift, scale and rotate it. Omit for the resting style.' },
        styles: {
          type: 'array',
          minItems: perItem.length ? 0 : 1,
          maxItems: 12,
          items: { type: 'object', properties: { property: { type: 'string', enum: STYLE_PROPS.map((p) => p.id) }, value: STYLE_VALUE }, required: ['property', 'value'], additionalProperties: false }
        }
      },
      required: ['scope', 'styles'],
      additionalProperties: false
    }
  });
  tools.push({
    name: 'request_wider_scope',
    description: SELECTION_DESCRIPTIONS.request_wider_scope,
      brief: SELECTION_BRIEFS.request_wider_scope,
    parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 300 } }, required: ['question'], additionalProperties: false }
  });
  return tools;
}

const noSelection = (): ToolOutcome => ({ ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Nothing is selected, or the selected element no longer exists.' } });

export async function applySelected(ops: EditOperation[], host: ToolHost, label: string, callId: string): Promise<ToolOutcome> {
  if (!ops.length) return { ok: true, content: { ok: true, revision: host.revision(), note: 'Nothing to change.' } };
  const res = await host.apply(ops, host.revision(), label, callId);
  if (!res.ok) return { ok: false, content: { ok: false, revision: res.revision, error: res.error } };
  return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, ...(res.results?.some((x) => (x as { itemId?: string }).itemId) ? { results: res.results } : {}) } };
}

export async function runSelectionTool(name: keyof typeof SELECTION_ARGS, args: unknown, host: ToolHost, callId: string): Promise<ToolOutcome> {
  if (name === 'request_wider_scope') {
    const a = args as z.infer<(typeof SELECTION_ARGS)['request_wider_scope']>;
    return { ok: true, content: { answer: await host.ask(a.question, [], true) } };
  }
  const target = host.selection?.() ?? null;
  const state = host.state();
  const r = target ? resolve(state, target) : null;
  if (!target || !r) return noSelection();
  const { owner, nodeId } = target;
  const note = 'Nothing was applied.';

  if (name === 'update_selected_props') {
    const a = args as z.infer<(typeof SELECTION_ARGS)['update_selected_props']>;
    const issues: FieldIssue[] = [];
    const def: ComponentDefinition = r.def ?? ({ name: 'Element', properties: r.properties } as ComponentDefinition);
    // Checked against the element's own values, as the engine checks them: one sent back unchanged is kept.
    const { props, deferred } = checkProps(def, a.props ?? {}, state, 'props', issues, r.node.kind === 'instance' ? r.node.props : undefined);
    // A selection edit cannot create pages, so a link must point at one that exists.
    for (const d of deferred) issues.push({ field: `props.${d.prop}${d.itemIndex !== undefined ? `[${d.itemIndex}].${d.field}` : d.field !== undefined ? `.${d.field}` : ''}`, message: `no page uses the route ${d.route}` });
    let chosen: Record<string, string> | undefined;
    if (a.variant === undefined && a.variants === undefined) chosen = undefined;
    else if (!r.def) issues.push({ field: a.variant !== undefined ? 'variant' : 'variants', message: 'this element has no variants' });
    else {
      const found: FieldIssue[] = [];
      chosen = chooseVariants(r.def, a.variant, a.variants, '', found);
      // The selected element's own options are the only ones there are, so the message lists them.
      for (const i of found) issues.push(i.field === 'variant' ? { field: 'variant', message: `must be one of: ${[...new Set(variantOptions(r.def).map((o) => o.id))].join(', ') || 'none'}` } : i);
    }
    if (issues.length) return fieldError(issues, note);
    const ops: EditOperation[] = Object.entries(props).map(([prop, value]) =>
      r.node.kind === 'instance' ? { type: 'instance.setProp', owner, nodeId, prop, value } : { type: 'node.setContent', owner, nodeId, field: prop as ContentField, value }
    );
    // One choice per axis, so tone and layout sent together each keep the other.
    for (const [axis, variant] of Object.entries(chosen ?? {})) ops.push({ type: 'instance.setVariant', owner, nodeId, variant, axis });
    return applySelected(ops, host, 'Edit selection', callId);
  }

  if (name === 'edit_selected_list') {
    const a = args as z.infer<(typeof SELECTION_ARGS)['edit_selected_list']>;
    const schema = Object.hasOwn(r.properties, a.prop) ? r.properties[a.prop] : undefined;
    if (r.node.kind !== 'instance' || schema?.type !== 'list') return fieldError([{ field: 'prop', message: `"${a.prop}" is not a list here` }], note);
    if (schema.feed)
      return fieldError(
        [
          {
            field: 'prop',
            message:
              schema.feed === 'entries'
                ? `"${a.prop}" fills itself from a collection's published entries; choose which with the collection, category, tag and count properties instead`
                : `"${a.prop}" fills itself from the site's article pages; change those pages with page.update (articleDate, byline, excerpt, newsHidden) instead`
          }
        ],
        note
      );
    // A placement without its own list shows (and edits) the definition's items.
    const own = r.node.props[a.prop];
    const items = (Array.isArray(own) ? own : own === undefined && Array.isArray(schema.default) ? schema.default : []) as Array<{ id: string }>;
    const selectedItem = target.itemId && items.some((i) => i.id === target.itemId) ? target.itemId : undefined;
    const itemId = a.itemId ?? selectedItem;
    const issues: FieldIssue[] = [];
    if (a.action !== 'insert' && !itemId) issues.push({ field: 'itemId', message: `required for ${a.action}. Items: ${items.map((i) => i.id).join(', ')}` });
    else if (a.action !== 'insert' && !items.some((i) => i.id === itemId)) issues.push({ field: 'itemId', message: `no item "${itemId}". Items: ${items.map((i) => i.id).join(', ')}` });
    if (a.action === 'move' && a.index === undefined) issues.push({ field: 'index', message: 'required for move' });
    let fields: Record<string, unknown> = {};
    if (a.action === 'update' || a.action === 'insert') {
      // A field another list shapes differently may come in that list's shape, which this list's own check
      // could quietly turn into an empty value.
      const lists = Object.entries(r.properties).filter(([, s]) => s.type === 'list' && !s.feed) as Array<[string, ListSchema]>;
      const misshapen = new Set<string>();
      for (const [name, seen] of listShapes(lists)) {
        if (seen.length < 2 || !Object.hasOwn(a.fields ?? {}, name) || !Object.hasOwn(schema.fields, name)) continue;
        const problem = emptiedBy(schema.fields[name], a.fields![name]);
        if (!problem) continue;
        misshapen.add(`fields.${name}`);
        issues.push({ field: `fields.${name}`, message: `${problem} for "${a.prop}"` });
      }
      // One item is checked here; the list's length rules are the engine's, against the real list.
      const list = { name: schema.label, properties: { [a.prop]: { ...schema, min: undefined, max: undefined } } } as unknown as ComponentDefinition;
      const fieldIssues: FieldIssue[] = [];
      // An update is checked against the item it changes, as the engine checks it: a field sent back unchanged is kept.
      const was = a.action === 'update' ? items.find((i) => i.id === itemId) : undefined;
      const sent = { ...(a.fields ?? {}), ...(was ? { id: was.id } : {}) };
      const checked = checkProps(list, { [a.prop]: [sent] }, state, 'fields', fieldIssues, was ? { [a.prop]: [was] } : undefined);
      for (const i of fieldIssues) {
        const field = i.field.replace(`fields.${a.prop}[0]`, 'fields');
        if (!misshapen.has(field)) issues.push({ field, message: i.message });
      }
      if (checked.deferred.length) issues.push({ field: `fields.${checked.deferred[0].field}`, message: `no page uses the route ${checked.deferred[0].route}` });
      const { id: _id, ...checkedFields } = (checked.props[a.prop] as Array<Record<string, unknown>>)?.[0] ?? {};
      fields = checkedFields;
      if (a.action === 'update' && !Object.keys(fields).length) issues.push({ field: 'fields', message: 'send the fields to change' });
    }
    if (issues.length) return fieldError(issues, note);
    const base = { owner, nodeId, prop: a.prop };
    const op: EditOperation =
      a.action === 'insert'
        ? { type: 'instance.listInsert', ...base, ...(a.index !== undefined ? { index: a.index } : {}), item: fields }
        : a.action === 'update'
          ? { type: 'instance.setProp', ...base, itemId: itemId!, value: fields }
          : a.action === 'remove'
            ? { type: 'instance.listRemove', ...base, itemId: itemId! }
            : { type: 'instance.listMove', ...base, itemId: itemId!, index: a.index! };
    return applySelected([op], host, `Edit ${schema.label}`, callId);
  }

  if (name === 'edit_selected_table') {
    const a = args as z.infer<(typeof SELECTION_ARGS)['edit_selected_table']>;
    const schema = Object.hasOwn(r.properties, a.prop) ? r.properties[a.prop] : undefined;
    if (r.node.kind !== 'instance' || schema?.type !== 'table') return fieldError([{ field: 'prop', message: `"${a.prop}" is not a table here` }], note);
    // The engine checks the row and column against the table as it is when the step lands.
    const op: EditOperation = { type: 'instance.editTable', owner, nodeId, prop: a.prop, action: a.action };
    for (const k of ['rowId', 'columnId', 'index', 'value', 'cells'] as const) if (a[k] !== undefined) Object.assign(op, { [k]: a[k] });
    const res = await applySelected([op], host, `Edit ${schema.label}`, callId);
    // A new row or column's ID, for the next step that fills it in.
    const made = res.ok ? (res.results?.[0] as { rowId?: string; columnId?: string } | undefined) : undefined;
    return made?.rowId || made?.columnId ? { ...res, content: { ...(res.content as Record<string, unknown>), ...made } } : res;
  }

  const a = args as z.infer<(typeof SELECTION_ARGS)['style_selected_element']>;
  const perItem = r.node.kind === 'instance' && r.def ? Object.keys(r.def.parts).filter((p) => repeatedPartList(r.def!, p)) : [];
  // One item's style needs a repeated part: the one named, the selected one, or the only one there is.
  const partId = r.node.kind === 'instance' ? (a.partId ?? target.partId ?? (a.itemId && perItem.length === 1 ? perItem[0] : undefined)) : undefined;
  // While the run is limited to a selected item, a part shown for every item is styled for that item alone.
  if (a.itemId === undefined && target.itemId !== undefined && partId && perItem.includes(partId) && host.selectionLimited?.() !== false && selectedPartReach(r, target)) a.itemId = target.itemId;
  if (r.node.kind !== 'instance' && a.partId) return fieldError([{ field: 'partId', message: 'this element has no parts' }], note);
  if (a.itemId !== undefined && (!partId || !perItem.includes(partId)))
    return fieldError([{ field: a.partId ? 'partId' : 'itemId', message: perItem.length ? `to style one item, name a repeated part: ${perItem.join(', ')}` : 'this element has no part repeated per item' }], note);
  if (a.resetItem && a.itemId === undefined) return fieldError([{ field: 'itemId', message: 'resetItem needs the itemId of the item to return to the shared style' }], note);
  if (!a.styles.length && !a.resetItem) return fieldError([{ field: 'styles', message: 'send at least one style' }], note);
  if (partId && partId !== 'root' && !Object.hasOwn(r.def?.parts ?? {}, partId)) return fieldError([{ field: 'partId', message: `must be one of: ${Object.keys(r.def?.parts ?? {}).join(', ')}` }], note);
  const known = new Set(STYLE_PROPS.map((p) => p.id));
  const issues: FieldIssue[] = [];
  a.styles.forEach((s, i) => {
    if (!known.has(s.property)) issues.push({ field: `styles[${i}].property`, message: `unknown style property "${s.property}"` });
    else if (a.state !== undefined && s.value !== null && !isStateStyleProp(s.property, a.state)) issues.push({ field: `styles[${i}].property`, message: stateStyleError(s.property, a.state)! });
  });
  if (issues.length) return fieldError(issues, note);
  const ops: EditOperation[] = a.styles.map((s) => ({ type: 'node.setStyle', owner, nodeId, ...(partId ? { partId } : {}), ...(a.itemId !== undefined ? { itemId: a.itemId } : {}), scope: a.scope, ...(a.state ? { state: a.state } : {}), property: s.property, value: s.value }));
  // The reset and any new values are one batch: one change in history.
  if (a.resetItem) ops.unshift({ type: 'node.resetStyles', owner, nodeId, partId, itemId: a.itemId, ...(a.state ? { scope: a.scope, state: a.state } : {}) });
  return applySelected(ops, host, a.resetItem && !a.styles.length ? 'Reset one item to the shared style' : a.itemId !== undefined ? 'Style one item' : 'Style selection', callId);
}
