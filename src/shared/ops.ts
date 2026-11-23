import { z } from 'zod';

/**
 * The single, versioned operation union used by manual editing and by the AI agent.
 * Tool schemas and runtime validators are both derived from these definitions.
 */
export const OPS_VERSION = 1;

const owner = z
  .object({
    kind: z.enum(['page', 'shell', 'component']).describe('Document that owns the node: a page, the shared shell (header/footer) or a component definition.'),
    id: z.string().describe('Page ID, "header" or "footer" for the shell, or a component definition ID.')
  })
  .describe('Owner document of the node.');

const scope = z.enum(['base', 'phone', 'tablet', 'desktop']).describe('Responsive scope. "base" applies at all sizes.');
const styleValue = z.union([z.string(), z.number(), z.boolean(), z.object({ token: z.string() })]);
const link = z.object({
  type: z.enum(['none', 'page', 'url', 'email', 'tel', 'anchor']),
  target: z.string().describe('Page ID for page links, https URL, email address, phone number or anchor ID.'),
  anchor: z.string().optional(),
  newTab: z.boolean().optional()
});

export const OPERATION_SCHEMAS = {
  'page.create': z.object({
    type: z.literal('page.create'),
    title: z.string().min(1).max(80),
    route: z.string().optional().describe('Static route such as "/services/". Defaults to a slug of the title.'),
    afterPageId: z.string().optional(),
    starter: z.enum(['empty', 'intro']).optional().describe('"intro" adds a page introduction section.'),
    addToNavigation: z.boolean().optional().describe('Also add a link to the new page at the end of the shared header navigation.')
  }),
  'page.update': z.object({
    type: z.literal('page.update'),
    pageId: z.string(),
    title: z.string().min(1).max(80).optional(),
    route: z.string().optional(),
    navLabel: z.string().max(40).optional(),
    seoTitle: z.string().max(120).optional(),
    description: z.string().max(320).optional(),
    noindex: z.boolean().optional(),
    shell: z.enum(['default', 'none']).optional()
  }),
  'page.duplicate': z.object({ type: z.literal('page.duplicate'), pageId: z.string(), title: z.string().optional() }),
  'page.reorder': z.object({ type: z.literal('page.reorder'), pageIds: z.array(z.string()) }),
  'page.remove': z.object({
    type: z.literal('page.remove'),
    pageId: z.string(),
    replacementPageId: z.string().optional().describe('Links to the removed page are pointed here. Required when other content links to it.')
  }),
  'page.setHome': z.object({ type: z.literal('page.setHome'), pageId: z.string() }),

  'node.insert': z.object({
    type: z.literal('node.insert'),
    owner,
    parentId: z.string().nullable().optional().describe('Parent element or instance node. Omit or null to insert a top-level section.'),
    slot: z.string().optional().describe('Slot name when inserting into a component instance slot (e.g. "content").'),
    index: z.number().int().min(0).optional().describe('Position among siblings. Defaults to the end.'),
    componentId: z.string().optional().describe('Catalogue component ID such as "features.grid".'),
    definitionId: z.string().optional().describe('An installed project component definition ID.'),
    primitive: z.enum(['container', 'stack', 'row', 'grid', 'heading', 'paragraph', 'image', 'button', 'icon', 'divider']).optional(),
    props: z.record(z.string(), z.unknown()).optional().describe('Initial property values for a component.'),
    variant: z.string().optional(),
    text: z.string().optional().describe('Initial text for heading, paragraph or button primitives.')
  }),
  'node.remove': z.object({ type: z.literal('node.remove'), owner, nodeId: z.string() }),
  'node.move': z.object({
    type: z.literal('node.move'),
    owner,
    nodeId: z.string(),
    parentId: z.string().nullable().optional(),
    slot: z.string().optional(),
    index: z.number().int().min(0)
  }),
  'node.duplicate': z.object({ type: z.literal('node.duplicate'), owner, nodeId: z.string() }),
  'node.copy': z
    .object({
      type: z.literal('node.copy'),
      owner,
      nodeId: z.string().describe('The node to copy, in `owner`.'),
      toOwner: owner.describe('Document the copy goes into: another page, or the same one.'),
      parentId: z.string().nullable().optional().describe('Parent element or instance in `toOwner`. Omit or null for a top-level section.'),
      slot: z.string().optional(),
      index: z.number().int().min(0).optional().describe('Position among siblings. Defaults to the end.')
    })
    .describe('Copy a section or element (with everything inside it) to a position in any page. The copy gets new IDs.'),
  'node.rename': z.object({ type: z.literal('node.rename'), owner, nodeId: z.string(), name: z.string().max(60) }),
  'node.setStyle': z.object({
    type: z.literal('node.setStyle'),
    owner,
    nodeId: z.string(),
    partId: z.string().optional().describe('For component instances: the public part to style. Defaults to "root".'),
    scope,
    property: z.string().describe('Style property ID, e.g. paddingBlock, background, textStyle, gap, columns.'),
    value: styleValue.nullable().describe('Literal value or {"token": "space.lg"}. null removes the override.')
  }),
  'node.resetStyles': z.object({
    type: z.literal('node.resetStyles'),
    owner,
    nodeId: z.string(),
    partId: z.string().optional(),
    scope: scope.optional()
  }),
  'node.setContent': z.object({
    type: z.literal('node.setContent'),
    owner,
    nodeId: z.string(),
    field: z.enum(['text', 'image', 'link', 'label', 'appearance', 'icon', 'tag', 'anchor']),
    value: z.unknown()
  }),
  'instance.setProp': z.object({
    type: z.literal('instance.setProp'),
    owner,
    nodeId: z.string().describe('Instance node ID.'),
    prop: z.string(),
    itemId: z.string().optional().describe('For list properties: the stable item ID to edit.'),
    field: z.string().optional().describe('For list properties: the item field to set.'),
    value: z.unknown()
  }),
  'instance.listInsert': z.object({
    type: z.literal('instance.listInsert'),
    owner,
    nodeId: z.string(),
    prop: z.string(),
    index: z.number().int().min(0).optional(),
    item: z.record(z.string(), z.unknown()).optional()
  }),
  'instance.listRemove': z.object({ type: z.literal('instance.listRemove'), owner, nodeId: z.string(), prop: z.string(), itemId: z.string() }),
  'instance.listMove': z.object({ type: z.literal('instance.listMove'), owner, nodeId: z.string(), prop: z.string(), itemId: z.string(), index: z.number().int().min(0) }),
  'instance.setVariant': z.object({ type: z.literal('instance.setVariant'), owner, nodeId: z.string(), variant: z.string() }),

  'token.set': z.object({
    type: z.literal('token.set'),
    tokenId: z.string(),
    value: z.unknown().nullable().describe('New value, or null to use the theme default.')
  }),
  'site.update': z.object({
    type: z.literal('site.update'),
    name: z.string().min(1).max(80).optional(),
    language: z.string().max(20).optional(),
    description: z.string().max(320).optional(),
    baseUrl: z.string().max(200).optional(),
    favicon: z.string().nullable().optional(),
    socialImage: z.string().nullable().optional()
  }),

  'component.createFromNode': z.object({ type: z.literal('component.createFromNode'), owner, nodeId: z.string(), name: z.string().min(1).max(60) }),
  'component.makeUnique': z.object({ type: z.literal('component.makeUnique'), owner, nodeId: z.string(), name: z.string().max(60).optional() }),
  'component.duplicate': z.object({ type: z.literal('component.duplicate'), definitionId: z.string(), name: z.string().min(1).max(60) }),
  'component.rename': z.object({ type: z.literal('component.rename'), definitionId: z.string(), name: z.string().min(1).max(60), description: z.string().max(300).optional() }),
  'component.fork': z.object({ type: z.literal('component.fork'), definitionId: z.string() }),
  'component.convertToCode': z.object({ type: z.literal('component.convertToCode'), owner, nodeId: z.string(), name: z.string().max(60).optional() }),
  'component.createCode': z.object({
    type: z.literal('component.createCode'),
    name: z.string().min(1).max(60),
    description: z.string().max(300).optional(),
    source: z.string().max(60000),
    properties: z.record(z.string(), z.unknown()).optional().describe('Property schema: { propName: { type, label, default } }.')
  }),
  'component.updateSource': z.object({
    type: z.literal('component.updateSource'),
    definitionId: z.string(),
    source: z.string().max(60000),
    expectedHash: z.string().optional()
  }),

  'theme.apply': z.object({ type: z.literal('theme.apply'), themeId: z.string() }),

  'asset.add': z.object({
    type: z.literal('asset.add'),
    asset: z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/), name: z.string().max(200),
      // Only files written by the importer, inside static/assets/.
      file: z.string().regex(/^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|gif|avif|svg|woff2?)$/), mime: z.string(), bytes: z.number(), width: z.number().optional(), height: z.number().optional(),
      hash: z.string(), kind: z.enum(['image', 'font']), createdAt: z.string(), variants: z.array(z.object({ width: z.number(), file: z.string().regex(/^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png)$/) })).optional(), description: z.string().optional(), altSuggestion: z.string().optional()
    })
  }),
  'asset.update': z.object({ type: z.literal('asset.update'), assetId: z.string(), name: z.string().max(120).optional(), description: z.string().max(500).optional(), altSuggestion: z.string().max(300).optional() }),
  'asset.remove': z.object({ type: z.literal('asset.remove'), assetId: z.string() }),
  'asset.replace': z.object({ type: z.literal('asset.replace'), assetId: z.string(), withAssetId: z.string() })
} as const;

export type OperationType = keyof typeof OPERATION_SCHEMAS;
export const EditOperationSchema = z.discriminatedUnion(
  'type',
  Object.values(OPERATION_SCHEMAS) as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]
);

export type Op<T extends OperationType> = z.infer<(typeof OPERATION_SCHEMAS)[T]>;
export type EditOperation = { [K in OperationType]: Op<K> }[OperationType];

export interface EditScope {
  kind: 'selection' | 'page' | 'component' | 'site';
  targetIds: string[];
}

export interface EditBatch {
  expectedRevision?: number;
  scope?: EditScope;
  operations: EditOperation[];
  /** Human readable label for history. */
  label?: string;
}

export type ToolErrorCode = 'INVALID_ARGUMENT' | 'STALE_REVISION' | 'SCOPE_MISMATCH' | 'PATH_DENIED' | 'VALIDATION_FAILED' | 'CONFLICT' | 'CANCELLED' | 'BUSY';

export interface ApplyResult {
  ok: boolean;
  revision: number;
  /** Per-operation results such as new node or page IDs. */
  results?: Array<Record<string, unknown>>;
  changed?: string[];
  error?: { code: ToolErrorCode; message: string; recoverable: boolean; details?: unknown };
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Fields whose string values are used as lookup keys. Content (text, labels) may contain any words. */
const KEY_FIELDS = /(^id$|Id$|^prop$|^field$|^property$|^variant$|^slot$|^parentId$)/;
function hasForbidden(v: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbidden(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.entries(v).some(([k, x]) => FORBIDDEN_KEYS.has(k) || (KEY_FIELDS.test(k) && typeof x === 'string' && FORBIDDEN_KEYS.has(x)) || hasForbidden(x, depth + 1));
  return false;
}

export function validateOperation(op: unknown): { ok: true; op: EditOperation } | { ok: false; message: string } {
  if (!op || typeof op !== 'object' || !('type' in op)) return { ok: false, message: 'Operation must be an object with a "type".' };
  // Object-prototype names are never valid IDs or keys; rejecting them keeps lookups safe.
  if (hasForbidden(op)) return { ok: false, message: 'Operation contains a reserved name.' };
  const type = String((op as { type: unknown }).type);
  const schema = Object.hasOwn(OPERATION_SCHEMAS, type) ? OPERATION_SCHEMAS[type as OperationType] : undefined;
  if (!schema) return { ok: false, message: `Unknown operation type "${(op as { type: string }).type}". Valid types: ${Object.keys(OPERATION_SCHEMAS).join(', ')}.` };
  const r = schema.safeParse(op);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.') || 'operation'}: ${i.message}`).join('; ') };
  return { ok: true, op: r.data as EditOperation };
}
