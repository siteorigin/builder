import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { EditOperationSchema, OPERATION_SCHEMAS, type OperationType } from '@shared/ops';
import { STYLE_PROPS } from '@shared/styles';
import { catalogueComponent, searchCatalogue } from '@catalogue/index';
import { ICONS } from '@catalogue/foundation/icons';
import { sourceHash } from '@engine/apply';
import type { Diagnostic } from '@engine/validate';
import type { ModelCapabilities, ToolDefinition } from './types';
import { catalogueIndex, compactNode, componentDetail, pageDetail, projectSummary, tokensSummary } from './context';
import { getTree, findParent, displayName } from '@engine/tree';
import { newMacroMemory, runUpsert, UPSERT_ARGS, UPSERT_DESCRIPTION, upsertToolSchema, type MacroMemory } from './macros';
import { BRAND_ARGS, BRAND_DESCRIPTION, brandToolSchema, runBrand } from './brand';
import { runSelectionTool, SELECTION_ARGS, SELECTION_DESCRIPTIONS, selectionTools, type SelectionTarget } from './selection';
import { examplesFor, exampleSection } from './examples';

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
  }),
  upsert_page_with_sections: UPSERT_ARGS,
  update_site_brand: BRAND_ARGS,
  ...SELECTION_ARGS
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
  inspect_layout: 'Measure a page in the live preview at a viewport width: horizontal overflow, elements outside the viewport, whether each image loaded (report.images: failed images are files that could not be loaded; unverified ones were still loading when the check ran out of time, which is not a problem with the site), missing alt text, heading structure and runtime errors. Structural evidence only; no screenshots.',
  validate_project: 'Run validation: "schema" checks references, routes and structure; "component" also compiles every Svelte component.',
  request_clarification: 'Ask the user one short question when a request is genuinely ambiguous and a wrong guess would change shared content. Offer up to four concrete choices.',
  upsert_page_with_sections: UPSERT_DESCRIPTION,
  update_site_brand: BRAND_DESCRIPTION,
  ...SELECTION_DESCRIPTIONS
};

/** Operations the assistant never sends: images are added only by the verified importer, theme updates by the
 *  user, and pastes come from the editor's own Copy. */
const NEVER_OFFERED = new Set<OperationType>(['asset.add', 'theme.refresh', 'node.paste']);
/** Operations that need Developer mode. */
export const CODE_OPERATIONS = new Set<OperationType>(['component.createCode', 'component.updateSource', 'component.convertToCode']);
const CODE_TOOLS = new Set<ToolName>(['read_source', 'apply_source_patch']);
/** Editing a component's own contract. Rarely needed, so left out of the schema unless the run can use it. */
const DEFINITION_OPERATIONS = new Set<OperationType>([
  'node.setBinding',
  'component.setPropSchema',
  'component.removePropSchema',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot'
]);

/** The operation union the model is shown for a run; the app still checks every operation it receives. */
function offeredOperations(codeEnabled: boolean, definitionOps: boolean) {
  const schemas = (Object.keys(OPERATION_SCHEMAS) as OperationType[])
    .filter((t) => !NEVER_OFFERED.has(t) && (codeEnabled || !CODE_OPERATIONS.has(t)) && (definitionOps || !DEFINITION_OPERATIONS.has(t)))
    .map((t) => (t === 'page.create' ? OPERATION_SCHEMAS[t].omit({ pageId: true }) : OPERATION_SCHEMAS[t]));
  return z.discriminatedUnion('type', schemas as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]);
}

/**
 * Tool definitions for one run. Without Developer mode, code tools and code operations are left out, and
 * component contract operations are offered only when the run is working inside a component definition.
 */
export function toolDefinitions(opts: { codeEnabled?: boolean; definitionOps?: boolean } = {}): ToolDefinition[] {
  const codeEnabled = opts.codeEnabled ?? true;
  const definitionOps = opts.definitionOps ?? codeEnabled;
  return (Object.keys(TOOL_ARGS) as ToolName[])
    .filter((name) => !TASK_TOOLS.has(name) && (codeEnabled || !CODE_TOOLS.has(name)))
    .map((name) => {
      const args = name === 'apply_operations' ? TOOL_ARGS.apply_operations.extend({ operations: z.array(offeredOperations(codeEnabled, definitionOps)).min(1).max(30) }) : TOOL_ARGS[name];
      const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: DESCRIPTIONS[name], parameters: schema };
    });
}

/** Tools that take a revision or hash the model read earlier: only one of these can run per turn. */
export const REVISION_BOUND_TOOLS = new Set<ToolName>(['apply_operations', 'apply_source_patch']);
const MACRO_TOOLS: ToolName[] = ['upsert_page_with_sections', 'update_site_brand'];
const SELECTION_TOOLS = Object.keys(SELECTION_ARGS) as ToolName[];
/** Offered by task mode (see toolsForRun), never as part of the general set. */
const TASK_TOOLS = new Set<ToolName>([...MACRO_TOOLS, ...SELECTION_TOOLS]);
export const MUTATING_TOOLS = new Set<ToolName>([...REVISION_BOUND_TOOLS, ...MACRO_TOOLS, 'update_selected_props', 'edit_selected_list', 'style_selected_element']);

/** Below this window a model only gets the focused tools: the general operation schema alone would crowd it out. */
export const FOCUSED_WINDOW_TOKENS = 64_000;

export type ToolMode = 'selection' | 'site' | 'general';

export interface RunTools {
  tools: ToolDefinition[];
  /** selection: the selected element's tools. site: page and brand tools. general: a selection they cannot cover. */
  mode: ToolMode;
  /** Only the small tool set is offered. */
  focused: boolean;
}

const usesImage = (tools: ToolDefinition[]) => JSON.stringify(tools[0].parameters).includes('"assetId"');

/**
 * The tools for this step of a run, chosen by task. The small sets are the design target: every model gets
 * them. A cloud model with room to spare also keeps the general tools for anything they cannot express, and a
 * selection they cannot cover (a layout element, a component's own definition) always uses the general tools.
 */
export function toolsForRun(opts: { state: ProjectState; selection: SelectionTarget | null; capabilities: Pick<ModelCapabilities, 'toolCalling' | 'contextWindowTokens'>; codeEnabled: boolean; definitionOps: boolean }): RunTools {
  const { state, selection, capabilities, codeEnabled, definitionOps } = opts;
  const general = toolDefinitions({ codeEnabled, definitionOps });
  const focused = capabilities.toolCalling === 'constrained-json' || capabilities.contextWindowTokens < FOCUSED_WINDOW_TOKENS;
  if (selection) {
    const micro = selectionTools(state, selection);
    if (!micro) return { tools: general, mode: 'general', focused: false };
    // An image can only be chosen by its asset ID, so a selection with one can also look them up.
    const assets = usesImage(micro) ? general.filter((t) => t.name === 'search_assets') : [];
    return { tools: focused ? [...micro, ...assets] : [...micro, ...general], mode: 'selection', focused };
  }
  const macros: ToolDefinition[] = [
    { name: 'upsert_page_with_sections', description: DESCRIPTIONS.upsert_page_with_sections, parameters: upsertToolSchema(state) },
    { name: 'update_site_brand', description: DESCRIPTIONS.update_site_brand, parameters: brandToolSchema(state) }
  ];
  return { tools: [...macros, ...(focused ? general.filter((t) => t.name !== 'apply_operations') : general)], mode: 'site', focused };
}

export interface ToolHost {
  state(): ProjectState;
  revision(): number;
  diagnostics(): Diagnostic[];
  apply(operations: EditOperation[], expectedRevision: number, label: string, idempotencyKey: string): Promise<{ ok: boolean; revision: number; results?: unknown[]; error?: { code: string; message: string } }>;
  compileAll(): Promise<Diagnostic[]>;
  inspectLayout(pageId: string, width: number): Promise<unknown>;
  ask(question: string, choices: string[], widenScope?: boolean): Promise<string>;
  /** What the macro tools remember during a run. */
  macros?: MacroMemory;
  /** The element a selection-scoped run is working on. */
  selection?(): SelectionTarget | null;
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
      const resolved = pageIdFor(state, a.pageId);
      if (resolved) a.pageId = resolved;
      const detail = resolved ? pageDetail(state, resolved) : null;
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
      const themed = searchCatalogue(state.site.themeId, a.query, a.limit ?? 8).map((e) => ({ componentId: e.componentId, name: e.name, description: e.description, variants: e.axes }));
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
      const examples = examplesFor(state, def.componentId).map(exampleSection);
      return { ok: true, content: { ...componentDetail(def), ...(examples.length ? { workedExamples: examples } : {}) } };
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
      // Page IDs are allocated by the app; only its own page tool may pass one through.
      if (ops.some((o) => o.type === 'page.create' && o.pageId !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'page.create does not take a pageId.' } };
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
      const resolved = pageIdFor(state, a.pageId);
      if (!resolved) return { ok: false, content: { error: 'INVALID_ARGUMENT', viewport: a.viewport, message: 'Unknown page.' } };
      a.pageId = resolved;
      try {
        const report = (await host.inspectLayout(a.pageId, WIDTHS[a.viewport])) as { error?: unknown } | null;
        // A preview that is not running or did not load is a failed check, never a clean result.
        if (!report || typeof report !== 'object' || report.error)
          return { ok: false, content: { error: 'VALIDATION_FAILED', pageId: resolved, viewport: a.viewport, message: `Layout could not be inspected: ${String(report?.error ?? 'no report')}` } };
        return { ok: true, content: { pageId: resolved, viewport: a.viewport, width: WIDTHS[a.viewport], report } };
      } catch (e) {
        return { ok: false, content: { error: 'VALIDATION_FAILED', pageId: resolved, viewport: a.viewport, message: `Layout could not be inspected: ${(e as Error).message}` } };
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
    case 'upsert_page_with_sections':
      return runUpsert(args as z.infer<typeof UPSERT_ARGS>, host, callId, (host.macros ??= newMacroMemory()));
    case 'update_site_brand':
      return runBrand(args as z.infer<typeof BRAND_ARGS>, host, callId);
    case 'update_selected_props':
    case 'edit_selected_list':
    case 'style_selected_element':
    case 'request_wider_scope':
      return runSelectionTool(name as keyof typeof SELECTION_ARGS, args, host, callId);
  }
}

/** Models often pass a route ("/about/") where a page ID is expected; both find the page. */
function pageIdFor(state: ProjectState, ref: string): string | null {
  if (Object.hasOwn(state.pages, ref)) return ref;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const path = trimmed.replace(/^\/+|\/+$/g, '');
  const route = path ? `/${path}/` : '/';
  return Object.values(state.pages).find((p) => p.route === route)?.id ?? null;
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

