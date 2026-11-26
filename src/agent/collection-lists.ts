/**
 * connect_collection_list (#679): show a collection's entries in a placed section's list (a Team grid's people from a
 * Team collection), or change which entries a collection loop repeats, in one call with a closed query a
 * grammar-constrained model can send. It compiles to instance.setListSource or node.setRepeatSource, which the engine
 * checks (the collection, its fields, which item fields an entry fills), applied with the run's scope check like any
 * other edit. The two operations are not offered as raw operations: this tool is the assistant's one way to them.
 */
import { z } from 'zod';
import type { OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { CURRENT_COLLECTION, QUERY_OPERATORS } from '@shared/collection-query';
import { getTree, displayName } from '@engine/tree';
import { isCollectionLoop } from '@shared/types';
import { fieldError, type FieldIssue } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';
import { applyFailure } from './result';

/** The owner shape every tool shares, so a constrained grammar spells it once (see tools.ts). */
const owner = z.object({ kind: z.enum(['page', 'shell', 'component', 'template', 'archive']), id: z.string() });

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
export const COLLECTION_QUERY = z
  .object({
    collectionId: z.string().min(1).max(60).describe(`A collection from read_project collections; "${CURRENT_COLLECTION}" in a collection's layout is its own.`),
    where: z
      .array(
        z
          .object({
            field: z.string().min(1).max(80).describe('title, publishedAt, terms.<grouping> (a term by name or ID), field.<name>...'),
            op: z.enum(QUERY_OPERATORS),
            value: z.union([scalar, z.array(scalar).max(50)]).optional().describe('A list for in; true or false for exists (default true); one value for the rest.')
          })
          .strict()
      )
      .max(10)
      .optional()
      .describe('Filters every entry must pass.'),
    sort: z
      .array(z.object({ field: z.string().min(1).max(80).describe('A field, or "entryOrder" for the collection\'s own order.'), direction: z.enum(['asc', 'desc']).optional() }).strict())
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(1000).optional(),
    excludeCurrent: z.boolean().optional().describe("In a collection's entry layout: leave out the entry the page is for.")
  })
  .strict();

export const CONNECT_LIST_ARGS = z
  .object({
    owner,
    nodeId: z.string().min(1).max(80).describe('A placed section with a list property (a Team grid, say), or a collection loop.'),
    prop: z.string().min(1).max(60).optional().describe('A placed section: the list property whose items the entries become.'),
    query: COLLECTION_QUERY.optional().describe('Which entries, in what order, and how many. Drafts are always left out.'),
    fields: z
      .array(z.object({ itemField: z.string().min(1).max(60).describe("The list item's field."), entryField: z.string().min(1).max(80).describe('title, excerpt, publishedAt, featuredImage, categories, terms.<grouping>, field.<name>, id, slug or entryLink (a link to its page).') }).strict())
      .max(30)
      .optional()
      .describe('A placed section: which entry field fills each item field. Every field an item needs must be filled; others show their default.'),
    disconnect: z.boolean().optional().describe('A placed section: show its own items again, as it kept them.'),
    archivePage: z.boolean().optional().describe("A collection loop in a collection's index layout: repeat the entries of the index page shown (its share of the index or of one category, page by page) instead of a query.")
  })
  .strict();
export type ConnectListArgs = z.infer<typeof CONNECT_LIST_ARGS>;

export const CONNECT_LIST_DESCRIPTION =
  "Show a collection's entries on the site: connect a placed section's list property to a collection (each entry one item, its fields mapped to the item's), or change which entries a collection loop repeats. query chooses the entries: filters, sort and how many. disconnect: true shows the section's own items again. Drafts never show.";
export const CONNECT_LIST_BRIEF = "A section's list from a collection (prop and fields map entry fields to item fields), or a collection loop's entries (query only).";

const schemaOf = (args: z.ZodType): JsonSchema & { properties: Record<string, unknown> } => {
  const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as JsonSchema & { properties: Record<string, unknown> };
  delete schema.$schema;
  return schema;
};

/**
 * connect_collection_list's schema for one run: the collections as a closed choice, with "$current" where the run is in
 * a collection's layout. `owner`: the one owner a run limited to a layout writes.
 */
export function connectListSchema(state: ProjectState, pinned?: OwnerRef): JsonSchema {
  const schema = schemaOf(CONNECT_LIST_ARGS);
  const ids = [...Object.keys(state.collections ?? {}).sort(), ...(pinned?.kind === 'template' || pinned?.kind === 'archive' ? [CURRENT_COLLECTION] : [])];
  const query = schema.properties.query as { properties: Record<string, Record<string, unknown>> };
  query.properties.collectionId = { ...query.properties.collectionId, enum: ids };
  if (pinned) schema.properties.owner = { type: 'object', properties: { kind: { type: 'string', enum: [pinned.kind] }, id: { type: 'string', enum: [pinned.id] } }, required: ['kind', 'id'], additionalProperties: false, description: 'This request may change only this layout.' };
  return schema;
}

export async function runConnectList(args: ConnectListArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const revision = host.revision();
  const issues: FieldIssue[] = [];
  let tree;
  try {
    tree = getTree(state, args.owner as OwnerRef);
  } catch {
    return fieldError([{ field: 'owner', message: `there is no ${args.owner.kind} "${args.owner.id}"` }], 'Nothing was applied.');
  }
  const node = Object.hasOwn(tree.nodes, args.nodeId) ? tree.nodes[args.nodeId] : undefined;
  if (!node) return fieldError([{ field: 'nodeId', message: `there is no node "${args.nodeId}" in ${args.owner.kind} ${args.owner.id}` }], 'Nothing was applied.');
  let op: EditOperation;
  if (node.kind === 'instance') {
    if (!args.prop) issues.push({ field: 'prop', message: `${displayName(state, node)} is a placed section: name the list property to connect` });
    if (args.archivePage) issues.push({ field: 'archivePage', message: "only a collection loop in a collection's index layout repeats the index page's entries" });
    if (args.disconnect) {
      if (args.query || args.fields) issues.push({ field: 'disconnect', message: 'disconnect takes no query or fields' });
      if (issues.length) return fieldError(issues, 'Nothing was applied.');
      op = { type: 'instance.setListSource', owner: args.owner as OwnerRef, nodeId: node.id, prop: args.prop!, source: null };
    } else {
      if (!args.query) issues.push({ field: 'query', message: 'name the collection whose entries the list shows' });
      const fields: Record<string, string> = {};
      for (const [i, f] of (args.fields ?? []).entries()) {
        if (Object.hasOwn(fields, f.itemField)) issues.push({ field: `fields[${i}].itemField`, message: `“${f.itemField}” is filled twice` });
        else fields[f.itemField] = f.entryField;
      }
      if (issues.length) return fieldError(issues, 'Nothing was applied.');
      op = { type: 'instance.setListSource', owner: args.owner as OwnerRef, nodeId: node.id, prop: args.prop!, source: { query: args.query as Record<string, unknown>, fields } };
    }
  } else if (node.kind === 'repeat' && isCollectionLoop(node)) {
    if (args.prop !== undefined || args.fields !== undefined) issues.push({ field: args.prop !== undefined ? 'prop' : 'fields', message: `${displayName(state, node)} is a collection loop: its elements show the entry's fields themselves, so send only query` });
    if (args.disconnect) issues.push({ field: 'disconnect', message: 'a collection loop always repeats entries: remove it, or change its query' });
    if (args.archivePage && args.query) issues.push({ field: 'archivePage', message: 'a loop repeats the index page\'s entries or a query\'s, not both' });
    if (!args.query && !args.archivePage) issues.push({ field: 'query', message: 'say which entries the loop repeats' });
    if (issues.length) return fieldError(issues, 'Nothing was applied.');
    op = { type: 'node.setRepeatSource', owner: args.owner as OwnerRef, nodeId: node.id, source: args.archivePage ? { $archive: true } : { $query: args.query as Record<string, unknown> } };
  } else {
    return fieldError([{ field: 'nodeId', message: `${displayName(state, node)} is neither a placed section with a list nor a collection loop` }], 'Nothing was applied.');
  }
  const what = displayName(state, node);
  const label = args.disconnect ? `Disconnect ${what}` : `Show ${args.query?.collectionId === CURRENT_COLLECTION ? 'entries' : (state.collections?.[args.query?.collectionId ?? '']?.settings.name ?? 'entries')} in ${what}`;
  const res = await host.apply([op], revision, label.slice(0, 120), callId);
  if (!res.ok) return applyFailure(res);
  return { ok: true, mutated: true, ops: [op], results: res.results, content: { ok: true, revision: res.revision, owner: args.owner, nodeId: node.id, ...(args.prop ? { prop: args.prop } : {}), connected: !args.disconnect } };
}
