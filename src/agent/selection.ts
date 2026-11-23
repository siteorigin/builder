/**
 * Selection tools: the small tool set for "change this element". Everything the model needs is in the schema,
 * generated from the selected component's own contract, and each call compiles to ordinary edit operations
 * that the run's authority still checks.
 */
import { findVariant, variantOptions } from '@shared/variants';
import { z } from 'zod';
import type { ComponentDefinition, ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { STYLE_PROPS } from '@shared/styles';
import { getTree } from '@engine/tree';
import { TABLE_ACTIONS, TABLE_LIMITS, type TableAction } from '@engine/table';
import { checkProps, fieldError, type FieldIssue } from './macros';
import { propJsonSchema, propsJsonSchema, type JsonSchema } from './propschema';
import type { ToolDefinition } from './types';
import type { ToolHost, ToolOutcome } from './tools';

export const SELECTION_ARGS = {
  update_selected_props: z.object({ props: z.record(z.string(), z.unknown()).optional(), variant: z.string().optional() }),
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
  style_selected_element: z.object({
    partId: z.string().optional(),
    scope: z.enum(['base', 'phone', 'tablet', 'desktop']),
    styles: z.array(z.object({ property: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.object({ token: z.string() }), z.null()]) })).min(1).max(12)
  }),
  request_wider_scope: z.object({ question: z.string().min(1).max(300) })
} as const;

export const SELECTION_DESCRIPTIONS: Record<keyof typeof SELECTION_ARGS, string> = {
  update_selected_props: 'Change the content of the selected element. Send only the properties that change.',
  edit_selected_list: 'Change one item of a list in the selected element: update, insert, remove or move it.',
  edit_selected_table:
    'Change one cell, row or column of a table in the selected element, by the row and column IDs in its content: set a cell, rename a column, or insert, remove or move a row or column. Other cells stay where they are.',
  style_selected_element: 'Style the selected element. Use scope "phone", "tablet" or "desktop" to change one screen size only, and prefer token values such as {"token":"space.lg"}.',
  request_wider_scope: 'Ask the user for permission to change more than the selected element, when the request cannot be done inside it.'
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

/** Content fields of a basic element, expressed as properties so one tool edits every kind of selection. */
const NODE_FIELDS: Partial<Record<GraphNode['kind'], Record<string, PropSchema>>> = {
  text: { text: { type: 'string', label: 'Text', default: '', multiline: true, maxLength: 20000 } },
  image: { image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } } },
  link: { label: { type: 'string', label: 'Button label', default: '' }, link: { type: 'link', label: 'Destination', default: { type: 'none', target: '' } } },
  icon: { icon: { type: 'icon', label: 'Icon', default: 'sparkles' } }
};

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
  return { tree, node, properties: NODE_FIELDS[node.kind] ?? {} };
}

const STYLE_VALUE: JsonSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object', properties: { token: { type: 'string', description: 'A site token such as space.lg or color.brand.' } }, required: ['token'], additionalProperties: false },
    { type: 'null' }
  ],
  description: 'A value, a token reference, or null to remove the override.'
};

/**
 * The tools for a selection, or null when they cannot cover it: inside a component's own definition, or on a
 * layout element whose content lives in its children. Those selections use the general tools.
 */
export function selectionTools(state: ProjectState, target: SelectionTarget | null): ToolDefinition[] | null {
  if (!target || target.nested || target.owner.kind === 'component') return null;
  const r = resolve(state, target);
  if (!r || !Object.keys(r.properties).length) return null;
  const tools: ToolDefinition[] = [];
  const variants = r.def ? [...new Set(variantOptions(r.def).map((o) => o.id))] : [];
  tools.push({
    name: 'update_selected_props',
    description: SELECTION_DESCRIPTIONS.update_selected_props,
    parameters: {
      type: 'object',
      properties: { props: propsJsonSchema({ properties: r.properties }), ...(variants.length ? { variant: { type: 'string', enum: variants, description: 'Visual variant.' } } : {}) },
      additionalProperties: false
    }
  });
  const lists = Object.entries(r.properties).filter(([, s]) => s.type === 'list') as Array<[string, Extract<PropSchema, { type: 'list' }>]>;
  if (lists.length) {
    // One closed object with the fields of every list; the app checks them against the list named by `prop`.
    const fields: Record<string, JsonSchema> = {};
    for (const [, s] of lists) Object.assign(fields, ((propJsonSchema(s).items as JsonSchema).properties as Record<string, JsonSchema>));
    delete fields.id;
    tools.push({
      name: 'edit_selected_list',
      description: SELECTION_DESCRIPTIONS.edit_selected_list,
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
  const parts = r.def ? Object.keys(r.def.parts) : [];
  tools.push({
    name: 'style_selected_element',
    description: SELECTION_DESCRIPTIONS.style_selected_element,
    parameters: {
      type: 'object',
      properties: {
        ...(parts.length ? { partId: { type: 'string', enum: parts, description: `Part to style. Defaults to ${target.partId ?? 'root'}.` } } : {}),
        scope: { type: 'string', enum: ['base', 'phone', 'tablet', 'desktop'] },
        styles: {
          type: 'array',
          minItems: 1,
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
    parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 300 } }, required: ['question'], additionalProperties: false }
  });
  return tools;
}

const noSelection = (): ToolOutcome => ({ ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Nothing is selected, or the selected element no longer exists.' } });

async function applySelected(ops: EditOperation[], host: ToolHost, label: string, callId: string): Promise<ToolOutcome> {
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
    const { props, deferred } = checkProps(def, a.props ?? {}, state, 'props', issues);
    // A selection edit cannot create pages, so a link must point at one that exists.
    for (const d of deferred) issues.push({ field: `props.${d.prop}${d.itemIndex !== undefined ? `[${d.itemIndex}].${d.field}` : ''}`, message: `no page uses the route ${d.route}` });
    if (a.variant !== undefined && (!r.def || 'error' in findVariant(r.def, a.variant))) issues.push({ field: 'variant', message: `must be one of: ${(r.def ? [...new Set(variantOptions(r.def).map((o) => o.id))] : []).join(', ') || 'none'}` });
    if (issues.length) return fieldError(issues, note);
    const ops: EditOperation[] = Object.entries(props).map(([prop, value]) =>
      r.node.kind === 'instance' ? { type: 'instance.setProp', owner, nodeId, prop, value } : { type: 'node.setContent', owner, nodeId, field: prop as 'text', value }
    );
    if (a.variant !== undefined) ops.push({ type: 'instance.setVariant', owner, nodeId, variant: a.variant });
    return applySelected(ops, host, 'Edit selection', callId);
  }

  if (name === 'edit_selected_list') {
    const a = args as z.infer<(typeof SELECTION_ARGS)['edit_selected_list']>;
    const schema = Object.hasOwn(r.properties, a.prop) ? r.properties[a.prop] : undefined;
    if (r.node.kind !== 'instance' || schema?.type !== 'list') return fieldError([{ field: 'prop', message: `"${a.prop}" is not a list here` }], note);
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
      // One item is checked here; the list's length rules are the engine's, against the real list.
      const list = { name: schema.label, properties: { [a.prop]: { ...schema, min: undefined, max: undefined } } } as unknown as ComponentDefinition;
      const fieldIssues: FieldIssue[] = [];
      const checked = checkProps(list, { [a.prop]: [a.fields ?? {}] }, state, 'fields', fieldIssues);
      for (const i of fieldIssues) issues.push({ field: i.field.replace(`fields.${a.prop}[0]`, 'fields'), message: i.message });
      if (checked.deferred.length) issues.push({ field: `fields.${checked.deferred[0].field}`, message: `no page uses the route ${checked.deferred[0].route}` });
      fields = (checked.props[a.prop] as Array<Record<string, unknown>>)?.[0] ?? {};
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
  const partId = r.node.kind === 'instance' ? (a.partId ?? target.partId) : undefined;
  if (r.node.kind !== 'instance' && a.partId) return fieldError([{ field: 'partId', message: 'this element has no parts' }], note);
  if (partId && partId !== 'root' && !Object.hasOwn(r.def?.parts ?? {}, partId)) return fieldError([{ field: 'partId', message: `must be one of: ${Object.keys(r.def?.parts ?? {}).join(', ')}` }], note);
  const known = new Set(STYLE_PROPS.map((p) => p.id));
  const issues: FieldIssue[] = [];
  a.styles.forEach((s, i) => {
    if (!known.has(s.property)) issues.push({ field: `styles[${i}].property`, message: `unknown style property "${s.property}"` });
  });
  if (issues.length) return fieldError(issues, note);
  const ops: EditOperation[] = a.styles.map((s) => ({ type: 'node.setStyle', owner, nodeId, ...(partId ? { partId } : {}), scope: a.scope, property: s.property, value: s.value }));
  return applySelected(ops, host, 'Style selection', callId);
}
