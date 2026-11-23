import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { EditOperationSchema, OPERATION_SCHEMAS, type OperationType } from '@shared/ops';
import { STYLE_PROPS } from '@shared/styles';
import { catalogueComponent, searchCatalogue } from '@catalogue/index';
import { ICONS } from '@catalogue/foundation/icons';
import { sourceHash } from '@engine/apply';
import type { Diagnostic } from '@engine/validate';
import type { ToolDefinition } from './types';
import { catalogueIndex, compactNode, componentDetail, pageDetail, projectSummary, tokensSummary } from './context';
import { getTree, findParent, displayName } from '@engine/tree';

const owner = z.object({ kind: z.enum(['page', 'shell', 'component']), id: z.string() });

export const TOOL_ARGS = {
  read_project: z.object({ sections: z.array(z.enum(['pages', 'tokens', 'catalogue', 'components', 'shell'])).optional() }),
  read_page: z.object({ pageId: z.string(), nodeId: z.string().optional().describe('Optional subtree to read.') }),
  inspect_element: z.object({ owner, nodeId: z.string() }),
  search_components: z.object({ query: z.string().describe('Words such as "pricing", "team", "image text".'), limit: z.number().int().min(1).max(20).optional() }),
  read_component: z.object({ componentId: z.string().optional(), definitionId: z.string().optional() }),
  search_assets: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  apply_operations: z.object({
    expectedRevision: z.number().int().describe('The revision you last read. Mismatches are rejected; read again and retry.'),
    scope: z
      .object({ kind: z.enum(['selection', 'page', 'component', 'site']), targetIds: z.array(z.string()).optional() })
      .optional()
      .describe('Optional note of what this batch is meant to change. The app decides what may change.'),
    operations: z.array(EditOperationSchema).min(1).max(30)
  }),
  read_source: z.object({ definitionId: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().optional() }),
  apply_source_patch: z.object({
    definitionId: z.string(),
    expectedHash: z.string().describe('Hash returned by read_source.'),
    edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional().describe('Exact text replacements applied in order. Each find must match exactly once.'),
    source: z.string().optional().describe('Full replacement source, instead of edits.')
  }),
  inspect_layout: z.object({ pageId: z.string(), viewport: z.enum(['phone', 'tablet', 'desktop']) }),
  validate_project: z.object({ profile: z.enum(['schema', 'component']).optional() }),
  request_clarification: z.object({
    question: z.string().max(300),
    choices: z.array(z.string().max(80)).max(4).optional(),
    widenScope: z.boolean().optional().describe('Set true to ask permission to change more than the selected element. The app shows yes/no choices; on yes, the run may change anything.')
  })
} as const;

export type ToolName = keyof typeof TOOL_ARGS;

const DESCRIPTIONS: Record<ToolName, string> = {
  read_project: 'Project summary: revision, pages (IDs and routes), shared header/footer, project components. Optional sections add site tokens, or the theme catalogue: every component with its compact property signature, style parts and variants, plus the valid icon names.',
  read_page: 'Read a page: its sections and their component instances, props (with list item IDs), variants, style overrides and nested content.',
  inspect_element: 'Inspect one node: full props, the component property schema, public parts with allowed style controls, variants, slots and its position in the tree.',
  search_components: 'Search the theme catalogue by keywords. Returns componentIds you can insert with node.insert.',
  read_component: 'Read a component contract: property schema, parts, variants, slots and examples. Use before inserting or editing an unfamiliar component.',
  search_assets: 'List imported images by name and description. You cannot see image contents.',
  apply_operations:
    'Apply a batch of typed edit operations atomically. This is the only way to change the website. Every operation is validated; on error nothing in the batch is applied and you get the exact problem. Call it at most once per turn.',
  read_source: 'Read the Svelte source of a component. Generated managed sources are read-only; project code components can be patched.',
  apply_source_patch: 'Change the source of a project code component (never generated files, config or dependencies). Requires the hash from read_source.',
  inspect_layout: 'Measure a page in the live preview at a viewport width: horizontal overflow, elements outside the viewport, missing images/alt text, heading structure and runtime errors. Structural evidence only; no screenshots.',
  validate_project: 'Run validation: "schema" checks references, routes and structure; "component" also compiles every Svelte component.',
  request_clarification: 'Ask the user one short question when a request is genuinely ambiguous and a wrong guess would change shared content. Offer up to four concrete choices.'
};

/** Operations the assistant never sends: images are added only by the verified importer. */
const NEVER_OFFERED = new Set<OperationType>(['asset.add']);
/** Operations that need Developer mode. */
export const CODE_OPERATIONS = new Set<OperationType>(['component.createCode', 'component.updateSource', 'component.convertToCode']);
const CODE_TOOLS = new Set<ToolName>(['read_source', 'apply_source_patch']);

/** The operation union the model is shown for a run; the app still checks every operation it receives. */
function offeredOperations(codeEnabled: boolean) {
  const schemas = (Object.keys(OPERATION_SCHEMAS) as OperationType[]).filter((t) => !NEVER_OFFERED.has(t) && (codeEnabled || !CODE_OPERATIONS.has(t))).map((t) => OPERATION_SCHEMAS[t]);
  return z.discriminatedUnion('type', schemas as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]);
}

/** Tool definitions for one run. Without Developer mode, code tools and code operations are left out. */
export function toolDefinitions(opts: { codeEnabled?: boolean } = {}): ToolDefinition[] {
  const codeEnabled = opts.codeEnabled ?? true;
  return (Object.keys(TOOL_ARGS) as ToolName[])
    .filter((name) => codeEnabled || !CODE_TOOLS.has(name))
    .map((name) => {
      const args = name === 'apply_operations' ? TOOL_ARGS.apply_operations.extend({ operations: z.array(offeredOperations(codeEnabled)).min(1).max(30) }) : TOOL_ARGS[name];
      const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: DESCRIPTIONS[name], parameters: schema };
    });
}

export const MUTATING_TOOLS = new Set<ToolName>(['apply_operations', 'apply_source_patch']);

export interface ToolHost {
  state(): ProjectState;
  revision(): number;
  diagnostics(): Diagnostic[];
  apply(operations: EditOperation[], expectedRevision: number, label: string, idempotencyKey: string): Promise<{ ok: boolean; revision: number; results?: unknown[]; error?: { code: string; message: string } }>;
  compileAll(): Promise<Diagnostic[]>;
  inspectLayout(pageId: string, width: number): Promise<unknown>;
  ask(question: string, choices: string[], widenScope?: boolean): Promise<string>;
}

export interface ToolOutcome {
  ok: boolean;
  content: unknown;
  mutated?: boolean;
  ops?: EditOperation[];
  results?: unknown[];
}

const WIDTHS = { phone: 390, tablet: 834, desktop: 1280 };
const MAX_RESULT_CHARS = 24000;

export function serializeResult(content: unknown): string {
  const s = JSON.stringify(content);
  if (s.length <= MAX_RESULT_CHARS) return s;
  return JSON.stringify({ truncated: true, note: `Result was ${s.length} characters; showing the first ${MAX_RESULT_CHARS}. Request a narrower range (for example read_page with nodeId).`, partial: s.slice(0, MAX_RESULT_CHARS) });
}

export async function executeTool(name: string, rawArgs: string, host: ToolHost, callId: string): Promise<ToolOutcome> {
  if (!(name in TOOL_ARGS)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `Unknown tool "${name}".` } };
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Arguments were not valid JSON.' } };
  }
  const schema = TOOL_ARGS[name as ToolName];
  const r = schema.safeParse(parsed);
  if (!r.success) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') } };
  const args = r.data as never;
  const state = host.state();
  switch (name as ToolName) {
    case 'read_project': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_project']>;
      const out: Record<string, unknown> = projectSummary(state, host.revision());
      if (a.sections?.includes('tokens')) out.tokens = tokensSummary(state);
      if (a.sections?.includes('catalogue')) {
        out.catalogue = catalogueIndex(state.site.themeId);
        out.icons = Object.keys(ICONS);
      }
      if (a.sections?.includes('components'))
        out.installedComponents = Object.values(state.components).map((d) => ({ definitionId: d.id, componentId: d.componentId, name: d.name, owner: d.owner, kind: d.kind }));
      out.styleProperties = STYLE_PROPS.map((p) => `${p.id}${p.tokenGroup ? ` (token: ${p.tokenGroup})` : ''}${p.options ? ` [${p.options.map((o) => o.value).join('|')}]` : ''}`);
      return { ok: true, content: out };
    }
    case 'read_page': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_page']>;
      a.pageId = pageIdFor(state, a.pageId);
      const detail = pageDetail(state, a.pageId);
      if (!detail) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No page "${a.pageId}". Pages: ${state.site.pageOrder.join(', ')}` } };
      if (a.nodeId) {
        const page = state.pages[a.pageId];
        if (!page.nodes[a.nodeId]) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No node "${a.nodeId}" on this page.` } };
        return { ok: true, content: { revision: host.revision(), owner: detail.owner, node: compactNode(state, page, a.nodeId) } };
      }
      return { ok: true, content: { revision: host.revision(), ...detail } };
    }
    case 'inspect_element': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_element']>;
      try {
        const tree = getTree(state, a.owner);
        const n = tree.nodes[a.nodeId];
        if (!n) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No node "${a.nodeId}".` } };
        const parent = findParent(tree, a.nodeId);
        const out: Record<string, unknown> = {
          revision: host.revision(),
          owner: a.owner,
          node: { ...n },
          displayName: displayName(state, n),
          parent: parent ? { parentId: parent.parentId, slot: parent.slot, index: parent.index, siblings: parent.list.length } : null
        };
        if (n.kind === 'instance' && state.components[n.definitionId]) out.component = componentDetail(state.components[n.definitionId]);
        return { ok: true, content: out };
      } catch (e) {
        return { ok: false, content: { error: 'INVALID_ARGUMENT', message: (e as Error).message } };
      }
    }
    case 'search_components': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_components']>;
      const themed = searchCatalogue(state.site.themeId, a.query, a.limit ?? 8).map((e) => ({ componentId: e.componentId, name: e.name, description: e.description, variants: e.variants.map((v) => v.id) }));
      const q = a.query.toLowerCase();
      const project = Object.values(state.components)
        .filter((d) => d.owner === 'project' && d.category !== 'shell' && `${d.name} ${d.description}`.toLowerCase().includes(q))
        .map((d) => ({ definitionId: d.id, name: d.name, description: d.description, projectComponent: true }));
      return { ok: true, content: { results: [...themed, ...project] } };
    }
    case 'read_component': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_component']>;
      const def = a.definitionId ? state.components[a.definitionId] : a.componentId ? catalogueComponent(state.site.themeId, a.componentId) : undefined;
      if (!def) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Component not found. Use search_components.' } };
      return { ok: true, content: componentDetail(def) };
    }
    case 'search_assets': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_assets']>;
      const q = (a.query ?? '').toLowerCase();
      const list = Object.values(state.assets.assets)
        .filter((x) => !q || `${x.name} ${x.description ?? ''} ${x.altSuggestion ?? ''}`.toLowerCase().includes(q))
        .slice(0, a.limit ?? 20)
        .map((x) => ({ assetId: x.id, name: x.name, width: x.width, height: x.height, description: x.description, altSuggestion: x.altSuggestion }));
      return { ok: true, content: { assets: list, note: 'Image contents are not available; rely on names and descriptions.' } };
    }
    case 'apply_operations': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_operations']>;
      const ops = a.operations as unknown as EditOperation[];
      const res = await host.apply(ops, a.expectedRevision, labelForOps(ops, state), callId);
      if (!res.ok) return { ok: false, content: { ok: false, revision: res.revision, error: res.error } };
      return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, results: res.results } };
    }
    case 'read_source': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_source']>;
      const def = state.components[a.definitionId];
      if (!def) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Unknown component.' } };
      if (def.kind !== 'code') return { ok: true, content: { definitionId: def.id, editable: false, note: 'This is a managed component. Its source is generated; edit it with operations, or convert a copy to code with component.convertToCode.' } };
      const lines = (def.source ?? '').split('\n');
      const start = (a.startLine ?? 1) - 1;
      const end = Math.min(lines.length, a.endLine ?? start + 400);
      return { ok: true, content: { definitionId: def.id, editable: def.owner === 'project', hash: sourceHash(def.source ?? ''), totalLines: lines.length, startLine: start + 1, endLine: end, source: lines.slice(start, end).join('\n') } };
    }
    case 'apply_source_patch': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_source_patch']>;
      const def = state.components[a.definitionId];
      if (!def || def.kind !== 'code' || def.owner !== 'project') return { ok: false, content: { error: 'PATH_DENIED', message: 'Only project code components can be patched.' } };
      let src = def.source ?? '';
      if (sourceHash(src) !== a.expectedHash) return { ok: false, content: { error: 'STALE_REVISION', message: 'The source changed. Call read_source again.' } };
      if (a.source !== undefined) src = a.source;
      else for (const e of a.edits ?? []) {
        const count = src.split(e.find).length - 1;
        if (count !== 1) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `"${e.find.slice(0, 60)}" matched ${count} times; it must match exactly once.` } };
        src = src.replace(e.find, e.replace);
      }
      const ops: EditOperation[] = [{ type: 'component.updateSource', definitionId: def.id, source: src, expectedHash: a.expectedHash }];
      const res = await host.apply(ops, host.revision(), `Edit ${def.name} source`, callId);
      if (!res.ok) return { ok: false, content: { ok: false, error: res.error } };
      const compile = (await host.compileAll()).filter((d) => d.severity === 'error');
      return { ok: true, mutated: true, ops, content: { ok: true, revision: res.revision, hash: sourceHash(src), compileErrors: compile.map((d) => d.message) } };
    }
    case 'inspect_layout': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_layout']>;
      a.pageId = pageIdFor(state, a.pageId);
      if (!state.pages[a.pageId]) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Unknown page.' } };
      try {
        const report = (await host.inspectLayout(a.pageId, WIDTHS[a.viewport])) as { error?: unknown } | null;
        // A preview that is not running or did not load is a failed check, never a clean result.
        if (!report || typeof report !== 'object' || report.error)
          return { ok: false, content: { error: 'VALIDATION_FAILED', viewport: a.viewport, message: `Layout could not be inspected: ${String(report?.error ?? 'no report')}` } };
        return { ok: true, content: { viewport: a.viewport, width: WIDTHS[a.viewport], report } };
      } catch (e) {
        return { ok: false, content: { error: 'VALIDATION_FAILED', viewport: a.viewport, message: `Layout could not be inspected: ${(e as Error).message}` } };
      }
    }
    case 'validate_project': {
      const a = args as z.infer<(typeof TOOL_ARGS)['validate_project']>;
      const diags = [...host.diagnostics(), ...(a.profile === 'component' ? await host.compileAll() : [])];
      return { ok: true, content: { revision: host.revision(), errors: diags.filter((d) => d.severity === 'error').map((d) => d.message), warnings: diags.filter((d) => d.severity === 'warning').slice(0, 20).map((d) => d.message) } };
    }
    case 'request_clarification': {
      const a = args as z.infer<(typeof TOOL_ARGS)['request_clarification']>;
      const answer = await host.ask(a.question, a.choices ?? [], a.widenScope);
      return { ok: true, content: { answer } };
    }
  }
}

/** Models often pass a route ("/about/") where a page ID is expected; both find the page. */
function pageIdFor(state: ProjectState, ref: string): string {
  if (state.pages[ref]) return ref;
  const route = `/${ref.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  return Object.values(state.pages).find((p) => p.route === route || p.route === ref)?.id ?? ref;
}

export function labelForOps(ops: EditOperation[], state: ProjectState): string {
  const first = ops[0];
  if (!first) return 'Edit';
  const page = (id: string) => state.pages[id]?.title ?? 'page';
  switch (first.type) {
    case 'page.create':
      return `Add page ${first.title}`;
    case 'node.insert':
      return `Insert ${first.componentId ?? first.primitive ?? 'component'}`;
    case 'instance.setProp':
      return `Edit ${first.prop}`;
    case 'token.set':
      return `Change ${first.tokenId}`;
    case 'page.update':
      return `Update ${page(first.pageId)}`;
    default:
      return first.type.replace('.', ' ');
  }
}

/** Human readable change list for the completion card. */
export function describeOps(ops: EditOperation[], before: ProjectState, after: ProjectState, results: unknown[]): Array<{ label: string; pageId?: string; nodeId?: string; definitionId?: string }> {
  const out: Array<{ label: string; pageId?: string; nodeId?: string; definitionId?: string }> = [];
  const ownerName = (o: { kind: string; id: string }) =>
    o.kind === 'page' ? after.pages[o.id]?.title ?? before.pages[o.id]?.title ?? 'page' : o.kind === 'shell' ? (o.id === 'header' ? 'Header' : 'Footer') : after.components[o.id]?.name ?? 'component';
  const nodeName = (o: { kind: string; id: string }, nodeId: string) => {
    try {
      const t = getTree(after, o as never);
      const n = t.nodes[nodeId];
      return n ? displayName(after, n) : 'element';
    } catch {
      return 'element';
    }
  };
  ops.forEach((op, i) => {
    const res = (results[i] ?? {}) as Record<string, string>;
    switch (op.type) {
      case 'page.create':
        out.push({ label: `Added page “${op.title}” (${res.route ?? ''})`, pageId: res.pageId });
        break;
      case 'page.update':
        out.push({ label: `Updated page settings for ${ownerName({ kind: 'page', id: op.pageId })}`, pageId: op.pageId });
        break;
      case 'page.remove':
        out.push({ label: `Removed page ${before.pages[op.pageId]?.title ?? ''}` });
        break;
      case 'node.insert':
        out.push({ label: `Added ${op.componentId ? catalogueComponent(after.site.themeId, op.componentId)?.name ?? op.componentId : op.primitive ?? 'component'} to ${ownerName(op.owner)}`, pageId: op.owner.kind === 'page' ? op.owner.id : undefined, nodeId: res.nodeId });
        break;
      case 'node.remove':
        out.push({ label: `Removed an element from ${ownerName(op.owner)}`, pageId: op.owner.kind === 'page' ? op.owner.id : undefined });
        break;
      case 'instance.setProp':
      case 'instance.listInsert':
      case 'instance.listRemove':
      case 'instance.listMove':
        out.push({ label: `Edited ${nodeName(op.owner, op.nodeId)} content on ${ownerName(op.owner)}`, pageId: op.owner.kind === 'page' ? op.owner.id : undefined, nodeId: op.nodeId });
        break;
      case 'node.setStyle':
      case 'node.resetStyles':
      case 'instance.setVariant':
        out.push({ label: `Adjusted ${nodeName(op.owner, op.nodeId)} styling on ${ownerName(op.owner)}`, pageId: op.owner.kind === 'page' ? op.owner.id : undefined, nodeId: op.nodeId });
        break;
      case 'token.set':
        out.push({ label: `Changed site style ${op.tokenId}` });
        break;
      default:
        out.push({ label: op.type });
    }
  });
  // Collapse duplicates
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)));
}
