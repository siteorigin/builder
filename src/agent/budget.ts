/**
 * Context budgeting. Keeps a run inside the model's context window by collapsing old read results to a
 * one-line summary. Only the content of a tool result changes: every call keeps its result, in order, and
 * assistant turns (with their provider reasoning) are replayed exactly as they were received.
 *
 * Nothing changes until the context is half full, and a collapsed result stays collapsed, so the start of
 * the conversation stays stable for prompt caches on providers and local runtimes.
 */
import { estimateTokens } from '@shared/tokens';
import type { CanonicalItem, ContextOverflow, ModelCapabilities, ToolDefinition } from './types';
import { envelopeInstructions } from './constrained';
import { layoutScope } from './layout-targets';

export { estimateTokens };

/** Above this share of the usable window, reads that a newer read of the same thing replaced are collapsed. */
export const SOFT_LIMIT = 0.5;
/** Above this share, reads made stale by a later change are collapsed too. Their IDs stay in the summary. */
export const HARD_LIMIT = 0.8;
/** The latest turns are what the model is working from, and are never collapsed. */
const PROTECTED_TURNS = 2;
/** A collapsed result says so in this field beside its `ok` and `revision`, with the one line that stands in for it. */
const SUPERSEDED = 'superseded';
/** The smallest reply worth asking for: a request that leaves less room than this cannot be answered usefully. */
export const MIN_OUTPUT_TOKENS = 1024;


function itemTokens(item: CanonicalItem): number {
  if (item.kind === 'user') return estimateTokens(item.text);
  if (item.kind === 'tool_result') return estimateTokens(item.content) + 8;
  // Replayed provider data (reasoning included) is what is really sent for this turn.
  if (item.providerData !== undefined) return estimateTokens(JSON.stringify(item.providerData));
  return estimateTokens(item.text) + item.toolCalls.reduce((n, c) => n + estimateTokens(c.arguments) + 8, 0);
}

/**
 * `constrained`: the tools go out as they are sent to a grammar-constrained model, as signatures in the system prompt
 * (see constrained.ts), not as their JSON schemas, which only the grammar reads.
 */
export function estimateRequestTokens(system: string, tools: ToolDefinition[], items: CanonicalItem[], constrained = false): number {
  const toolTokens = constrained ? estimateTokens(envelopeInstructions(tools)) : tools.reduce((n, t) => n + estimateTokens(t.name + t.description + JSON.stringify(t.parameters)), 0);
  return estimateTokens(system) + toolTokens + items.reduce((n, i) => n + itemTokens(i), 0);
}

const parse = (s: string): Record<string, any> | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

interface ReadInfo {
  index: number;
  name: string;
  /** What was read. Only a later read of exactly this replaces it: a page read is depth-limited, so it may omit a subtree. */
  target: string;
  pageId?: string;
  /** Cut short by the result size limit: it shows only its start, so it never stands in for a complete read. */
  partial?: boolean;
  /** read_source: the definition, the lines shown, and the hash of the source they came from. */
  definitionId?: string;
  lines?: [number, number];
  hash?: string;
  /** read_project: the optional sections it included. The summary itself comes with every read. */
  extras?: string[];
  /** The project revision it was read at, when the result says. */
  revision?: number;
  /** read_collection_entry and list_collection_entries: the collection, and the entry, it read. */
  collectionId?: string;
  entryId?: string;
  /** inspect_layout: the elements it was narrowed to (see layoutScope), absent for a check of the whole page. */
  scope?: string;
}

/** What read_project adds to the summary on request; pages and the shared header and footer come with every read. */
export const PROJECT_SECTIONS = ['tokens', 'catalogue', 'components', 'siteCode'] as const;
const PROJECT_EXTRAS: readonly string[] = PROJECT_SECTIONS;

function describeRead(item: Extract<CanonicalItem, { kind: 'tool_result' }>, index: number, args: Record<string, any>): ReadInfo | null {
  const body = parse(item.content);
  if (item.isError || body?.[SUPERSEDED] !== undefined) return null;
  // A result cut short still has its revision, beside what it left out.
  const partial = body?.truncated === true;
  const revision = body?.revision;
  const base = { index, name: item.name, ...(partial ? { partial } : {}), ...(typeof revision === 'number' && Number.isFinite(revision) ? { revision } : {}) };
  if (item.name === 'read_page') {
    const pageId = String(body?.owner?.id ?? body?.id ?? args.pageId ?? '');
    if (!pageId) return null;
    const nodeId = args.nodeId ? String(args.nodeId) : '';
    return { ...base, target: `page:${pageId}:${nodeId}`, pageId };
  }
  if (item.name === 'read_layout') {
    // A collection's entry layout and its index layout share the collection's ID: the owner's kind tells them apart.
    const owner = body?.owner;
    if (!owner?.id || !owner?.kind) return null;
    return { ...base, target: `layout-tree:${owner.kind}:${owner.id}:${args.nodeId ? String(args.nodeId) : ''}` };
  }
  if (item.name === 'read_component') {
    const id = args.definitionId ?? args.componentId ?? body?.definitionId;
    // A design read part by part: each part is its own read, and a contract alone never stands in for the design.
    const design = args.structure ? `:structure:${Number(args.offset ?? 0)}` : '';
    return id ? { ...base, target: `component:${id}${design}` } : null;
  }
  if (item.name === 'read_project') {
    // A read of the site's own code holds that alone (tools.ts): it stands in only for another such read, never a summary.
    if (Array.isArray(args.sections) && args.sections.includes('siteCode')) return { ...base, target: 'project:siteCode', extras: [] };
    const extras = PROJECT_EXTRAS.filter((s) => Array.isArray(args.sections) && args.sections.includes(s));
    return { ...base, target: 'project', extras };
  }
  if (item.name === 'read_source') {
    const definitionId = String(body?.definitionId ?? args.definitionId ?? '');
    // A managed component's answer is a one-line note with no source to collapse.
    if (!definitionId || (!partial && typeof body?.source !== 'string')) return null;
    // The lines actually shown. An end before the start (which the tool accepts) does not say what came back: a
    // negative one counts from the end of the file, and a cut result shows an unknown share of what it asked for.
    const start = Number(partial ? (args.startLine ?? 1) : body!.startLine);
    const asked = Number(args.endLine ?? start + 399);
    const shown = body?.source === '' ? 0 : String(body?.source).split('\n').length;
    const end = partial ? (asked < 1 ? Infinity : asked) : start + shown - 1;
    return { ...base, target: `source:${definitionId}`, definitionId, lines: [start, end], ...(partial ? {} : { hash: String(body!.hash) }) };
  }
  if (item.name === 'inspect_element') {
    const owner = args.owner ?? body?.owner;
    if (!owner?.id || !args.nodeId) return null;
    // One field read a part at a time: each part is its own read, never made out of date by the next part or another field.
    const field = args.prop !== undefined ? `:field:${JSON.stringify([args.prop, args.itemId ?? null, args.field ?? null, Number(args.offset ?? 0)])}` : '';
    return { ...base, target: `element:${owner.kind}:${owner.id}:${args.nodeId}${field}` };
  }
  if (item.name === 'inspect_layout') {
    const pageId = body?.pageId ?? args.pageId;
    const viewport = body?.viewport ?? args.viewport;
    // A check of chosen elements stays its own read: only a whole-page check, or one of the same elements, replaces it.
    const scope = layoutScope(args.refs);
    return pageId && viewport ? { ...base, target: `layout:${pageId}:${viewport}`, pageId: String(pageId), ...(scope !== undefined ? { scope } : {}) } : null;
  }
  if (item.name === 'inspect_component') {
    // A component measured with its default content or a placement's, and which window of its cases: a theme
    // component named by its catalogue ID is the same one by its definition ID.
    const id = body?.definitionId ?? args.definitionId ?? args.componentId;
    if (!id) return null;
    // A check that left some of its cases unmeasured never stands in for one that measured them.
    return { ...base, ...(body?.incomplete === true ? { partial: true } : {}), target: `component-check:${componentSample(body, args)}:${id}:${Number(body?.offset ?? args.offset ?? 0)}` };
  }
  if (item.name === 'read_collection_entry' || item.name === 'list_collection_entries') {
    // Each part of a long post, and each page of a list, is its own read: a later part never stands in for an earlier one.
    const collectionId = String(body?.collectionId ?? args.collectionId ?? '');
    const offset = Number(body?.offset ?? args.offset ?? 0);
    if (!collectionId) return null;
    if (item.name === 'list_collection_entries') return { ...base, target: `entries:${JSON.stringify([collectionId, offset])}`, collectionId };
    const entryId = String(body?.entryId ?? args.entryId ?? '');
    // One custom field read a part at a time is its own read too, never one of the text.
    const field = body?.field ?? args.field;
    return entryId ? { ...base, target: `entry:${JSON.stringify([collectionId, entryId, offset, ...(typeof field === 'string' ? [field] : [])])}`, collectionId, entryId } : null;
  }
  if (item.name === 'audit_seo') {
    // The page it was narrowed to as the result names it (a route and its page's ID are one page), the pillar, and
    // which part of each list it showed: each is its own read, never made out of date by a part or a scope it did not show.
    const pageId = body?.scope?.pageId ?? args.pageId ?? null;
    const pillar = body?.scope?.pillar ?? args.pillar ?? null;
    return { ...base, target: `seo-audit:${JSON.stringify([pageId, pillar, Number(args.offset ?? 0), Number(args.linkOffset ?? 0)])}` };
  }
  return null;
}

/** Whose content an inspect_component result was measured with: the defaults, or one placement's. */
function componentSample(body: Record<string, any> | null, args: Record<string, any>): string {
  const p = body?.placement ?? (args.owner && args.nodeId ? { owner: args.owner, nodeId: args.nodeId } : null);
  return p?.owner ? `${p.owner.kind}:${p.owner.id}:${p.nodeId}` : 'defaults';
}

/** Whether a later read shows everything an earlier one did, at least as recently. */
function replaces(newer: ReadInfo, older: ReadInfo): boolean {
  if (newer.index <= older.index || newer.target !== older.target || (newer.partial && !older.partial)) return false;
  if (newer.name === 'read_project') return older.extras!.every((s) => newer.extras!.includes(s));
  // A check of some elements never stands in for one of the page, nor of other elements.
  if (newer.name === 'inspect_layout' && newer.scope !== undefined) return newer.scope === older.scope;
  // Only a complete read is known to show every line it covers.
  if (newer.name === 'read_source') return !newer.partial && newer.lines![0] <= older.lines![0] && newer.lines![1] >= older.lines![1];
  return true;
}

/**
 * The one line that stands in for a read once it is collapsed, as its result's `superseded` field. A page keeps its
 * section IDs, so the model can still address them.
 */
export function tombstoneFor(read: Pick<ReadInfo, 'name'>, content: string, args: Record<string, any>): string {
  const body = parse(content);
  const rev = body?.revision !== undefined ? ` at rev ${body.revision}` : '';
  if (read.name === 'read_page') {
    const id = body?.owner?.id ?? body?.id ?? args.pageId;
    const title = body?.title ? ` "${String(body.title).slice(0, 40)}"` : '';
    const list = Array.isArray(body?.sections) ? body!.sections : body?.node ? [body.node] : [];
    const sections = list.slice(0, 12).map((s: Record<string, unknown>) => `${s.id} ${s.componentId ?? s.kind ?? ''}`.trim()).join(', ');
    const more = list.length > 12 ? `, and ${list.length - 12} more` : '';
    return `read_page ${id}${title}${rev}.${sections ? ` Sections: ${sections}${more}.` : ''} Read it again before relying on its content.`;
  }
  if (read.name === 'read_component') return `read_component ${args.definitionId ?? args.componentId ?? body?.definitionId}. Read it again if you need its contract.`;
  // The hash is left out: only a fresh read gives one a patch can use.
  if (read.name === 'read_source') {
    const lines = typeof body?.source === 'string' ? ` lines ${body.startLine}–${body.endLine} of ${body.totalLines}` : '';
    return `read_source ${body?.definitionId ?? args.definitionId}${lines}. Read it again for the current source and hash.`;
  }
  if (read.name === 'inspect_element') {
    const owner = args.owner ?? body?.owner;
    return `inspect_element ${args.nodeId} on ${owner?.kind} ${owner?.id}${rev}. Inspect it again before relying on it.`;
  }
  if (read.name === 'read_layout') {
    const list = Array.isArray(body?.sections) ? body!.sections : body?.node ? [body.node] : [];
    const ids = list.slice(0, 12).map((n: Record<string, unknown>) => `${n.id} ${n.componentId ?? n.kind ?? ''}`.trim()).join(', ');
    return `read_layout ${body?.owner?.kind ?? ''} ${body?.owner?.id ?? ''}${args.nodeId ? ` node ${args.nodeId}` : ''}${rev}${ids ? `: ${ids}${list.length > 12 ? `, and ${list.length - 12} more` : ''}` : ''}. Read it again before relying on it.`;
  }
  if (read.name === 'inspect_layout') {
    const n = Array.isArray(args.refs) ? args.refs.length : 0;
    return `inspect_layout ${body?.pageId ?? args.pageId} ${body?.viewport ?? args.viewport}${n ? `, ${n} element${n === 1 ? '' : 's'} only` : ''}. Measure it again if you need it.`;
  }
  if (read.name === 'inspect_component') {
    const sample = componentSample(body, args);
    const offset = Number(body?.offset ?? args.offset ?? 0);
    return `inspect_component ${body?.definitionId ?? args.definitionId ?? args.componentId}${sample === 'defaults' ? '' : ` placed at ${sample}`}${offset ? ` from offset ${offset}` : ''}${rev}. Inspect it again if you need it.`;
  }
  if (read.name === 'read_collection_entry') {
    const at = Number(body?.offset ?? args.offset ?? 0);
    const title = typeof body?.title === 'string' ? ` "${body.title.slice(0, 40)}"` : '';
    const of = typeof body?.length === 'number' ? ` of ${body.length} characters` : '';
    return `read_collection_entry ${String(body?.collectionId ?? args.collectionId).slice(0, 60)}/${String(body?.entryId ?? args.entryId).slice(0, 40)}${title}${at ? ` from offset ${at}` : ''}${of}${rev}. Read this part again before relying on its text or rewriting it.`;
  }
  if (read.name === 'list_collection_entries') {
    const at = Number(body?.offset ?? args.offset ?? 0);
    const total = typeof body?.total === 'number' ? `, ${body.total} entries` : '';
    return `list_collection_entries ${String(body?.collectionId ?? args.collectionId).slice(0, 60)}${at ? ` from offset ${at}` : ''}${total}${rev}. List it again for the current entries.`;
  }
  if (read.name === 'audit_seo') {
    // A page the model named that no result confirmed is shown as far as a line allows.
    const scope = [String(body?.scope?.pageId ?? args.pageId ?? 'site').slice(0, 80), body?.scope?.pillar ?? args.pillar].filter(Boolean).join(' ');
    const offset = Number(args.offset ?? 0);
    const linkOffset = Number(args.linkOffset ?? 0);
    // What it found, so the model knows what it saw without the findings themselves.
    const n = (v: unknown, one: string, many = `${one}s`) => `${Number(v ?? 0)} ${Number(v ?? 0) === 1 ? one : many}`;
    const counts = body?.counts && typeof body.counts === 'object' ? ` ${n(body.total, 'finding')} (${n(body.counts.error, 'error')}, ${n(body.counts.warning, 'warning')}, ${n(body.counts.info, 'info', 'info')})` : '';
    const orphans = Number(body?.links?.orphans ?? (body?.links?.orphan ? 1 : 0));
    return `audit_seo ${scope}${offset ? ` from offset ${offset}` : ''}${linkOffset ? ` from linkOffset ${linkOffset}` : ''}${rev}.${counts}${counts && orphans ? `, ${n(orphans, 'orphan page')}` : ''}${counts ? '.' : ''} Audit again for details.`;
  }
  const pages = Array.isArray(body?.pages) ? body!.pages : [];
  const list = pages.slice(0, 12).map((p: Record<string, unknown>) => `${p.id} ${p.route ?? ''}`.trim()).join(', ');
  const more = pages.length > 12 ? `, and ${pages.length - 12} more` : '';
  return `read_project${rev}${args.sections?.length ? ` (${args.sections.join(', ')})` : ''}.${list ? ` Pages: ${list}${more}.` : ''} Read it again if you need it.`;
}

export interface BudgetResult {
  estimate: number;
  /** Input tokens the model can take while leaving room to answer. */
  available: number;
  tombstoned: number;
  /** Too large for a useful answer to fit, after collapsing everything that is safe to collapse. */
  overflow: boolean;
  /** Output budget for this request: never more than what is left in the window. */
  maxOutputTokens: number;
}

/** Collapse what is safe to collapse, in place, and report where the request stands against the window. */
export function applyContextBudget(
  items: CanonicalItem[],
  opts: {
    system: string;
    tools: ToolDefinition[];
    capabilities: Pick<ModelCapabilities, 'contextWindowTokens' | 'maxOutputTokens'> & Partial<Pick<ModelCapabilities, 'toolCalling'>>;
    isMutation: (toolName: string) => boolean;
    /** The project's revision now. Some changes (links connected when a page is created) are not a tool's result. */
    revision?: number;
  }
): BudgetResult {
  const { contextWindowTokens: window, maxOutputTokens } = opts.capabilities;
  const available = window - Math.min(maxOutputTokens, Math.floor(window / 4));
  let estimate = estimateRequestTokens(opts.system, opts.tools, items, opts.capabilities.toolCalling === 'constrained-json');
  let tombstoned = 0;

  if (estimate > available * SOFT_LIMIT) {
    const argsByCall = new Map<string, Record<string, any>>();
    const assistants: number[] = [];
    items.forEach((it, i) => {
      if (it.kind !== 'assistant') return;
      assistants.push(i);
      for (const c of it.toolCalls) argsByCall.set(c.id, parse(c.arguments) ?? {});
    });
    // Results of the latest turns are still being worked from (the very latest have not been read yet).
    const protectedFrom = assistants.length ? assistants[Math.max(0, assistants.length - PROTECTED_TURNS)] : 0;
    const reads: ReadInfo[] = [];
    let lastMutation = -1;
    const changes: Array<{ index: number; text: string }> = [];
    /** Each post a write landed on, as its result names it: never words in a post that happen to name another. */
    const entryWrites: Array<{ index: number; collectionId: string; entryId: string }> = [];
    items.forEach((it, i) => {
      if (it.kind !== 'tool_result') return;
      if (!it.isError && opts.isMutation(it.name)) {
        lastMutation = i;
        changes.push({ index: i, text: `${JSON.stringify(argsByCall.get(it.callId) ?? {})} ${it.content}` });
        const written = it.name === 'upsert_collection_entry' ? parse(it.content) : null;
        if (written?.ok === true && typeof written.collectionId === 'string' && typeof written.entryId === 'string') entryWrites.push({ index: i, collectionId: written.collectionId, entryId: written.entryId });
      }
      const read = describeRead(it, i, argsByCall.get(it.callId) ?? {});
      if (read) reads.push(read);
    });
    const collapse = (r: ReadInfo) => {
      const it = items[r.index] as Extract<CanonicalItem, { kind: 'tool_result' }>;
      // Still a result like any other: it worked, at the revision it was read at.
      const text = tombstoneFor(r, it.content, argsByCall.get(it.callId) ?? {}).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
      const line = JSON.stringify({ ok: true, revision: r.revision ?? opts.revision ?? 0, [SUPERSEDED]: text });
      if (line.length >= it.content.length) return;
      estimate -= estimateTokens(it.content) - estimateTokens(line);
      it.content = line;
      tombstoned++;
    };
    const collapsed = new Set<ReadInfo>();
    for (const r of reads) {
      if (r.index >= protectedFrom) continue;
      if (reads.some((n) => replaces(n, r))) {
        collapse(r);
        collapsed.add(r);
      }
    }
    /** Made out of date by a later change: what it reports may no longer be true. */
    const stale = (r: ReadInfo): boolean => {
      const changedAfter = (id: string) => changes.some((c) => c.index > r.index && c.text.includes(id));
      if (r.name === 'read_page') return changedAfter(r.pageId!);
      // A post goes out of date when a later write lands on it, and a list of a collection when one lands on any of its posts.
      if (r.name === 'read_collection_entry') return entryWrites.some((w) => w.index > r.index && w.collectionId === r.collectionId && w.entryId === r.entryId);
      if (r.name === 'list_collection_entries') return entryWrites.some((w) => w.index > r.index && w.collectionId === r.collectionId);
      // A patch names its component; a later read with another hash shows a change made some other way.
      if (r.name === 'read_source') return changedAfter(r.definitionId!) || (!!r.hash && reads.some((n) => n.index > r.index && n.target === r.target && !!n.hash && n.hash !== r.hash));
      // A measurement, an element's props, an audit and the project summary all describe the revision they were read at:
      // only a change that moved it (whether or not a tool made it) makes them stale.
      if (r.name !== 'inspect_element' && r.name !== 'inspect_layout' && r.name !== 'inspect_component' && r.name !== 'read_project' && r.name !== 'audit_seo' && r.name !== 'read_layout') return false;
      return r.revision !== undefined && opts.revision !== undefined ? r.revision < opts.revision : r.index < lastMutation;
    };
    if (estimate > available * HARD_LIMIT) {
      for (const r of reads) {
        if (collapsed.has(r) || r.index >= protectedFrom || estimate <= available * HARD_LIMIT) continue;
        if (stale(r)) {
          collapse(r);
          collapsed.add(r);
        }
      }
      // A contract or a source does not go stale by itself (a change that removes one need not name it), so it
      // is only given up after the reads it was used with, once anything has changed.
      for (const r of reads) {
        if (collapsed.has(r) || r.index >= protectedFrom || estimate <= available * HARD_LIMIT) continue;
        if ((r.name === 'read_component' || r.name === 'read_source') && r.index < lastMutation) collapse(r);
      }
    }
  }
  // The compaction target leaves generous room; the hard limit is whether a useful answer still fits at all.
  const room = window - estimate;
  return { estimate, available, tombstoned, overflow: room < Math.min(MIN_OUTPUT_TOKENS, maxOutputTokens), maxOutputTokens: Math.max(1, Math.min(maxOutputTokens, room)) };
}

/** Room for a request's reads and edits as well as its first reply: the window the local default profile assumes. */
export const WORKING_WINDOW_TOKENS = 32_768;

export interface ContextVerdict {
  /**
   * setup: even a new conversation holding only this message cannot fit, so the model needs a larger context.
   * conversation: the earlier messages are what no longer fit, so a new conversation helps.
   * run: this request's own reads and results filled the window.
   * unclear: the window is unknown and the request held earlier messages, so either could be the cause.
   */
  kind: 'setup' | 'conversation' | 'run' | 'unclear';
  /** A request with only this message and room for a short reply, rounded up to the next 1,024 tokens. */
  minimumTokens: number;
  /** A size to load the model with, so a request has room to work as well as to answer. */
  recommendedTokens: number;
  /** The minimum comes from the app's estimate, not from the server's count of exactly that request. */
  estimated: boolean;
}

/**
 * Why a request does not fit the model's window, and what would make it fit. `current` is this request's own
 * message: everything before it in `items` was replayed from the conversation, and everything after it is this run's
 * own work. The server's count of the whole request, when its error gave one, scales the estimate of each part; how
 * the count splits between them is still an estimate.
 */
export function contextVerdict(o: { system: string; tools: ToolDefinition[]; items: CanonicalItem[]; current: CanonicalItem; windowTokens?: number; maxOutputTokens: number; reported?: ContextOverflow; rejected: boolean; constrained?: boolean }): ContextVerdict {
  const at = Math.max(0, o.items.indexOf(o.current));
  const whole = estimateRequestTokens(o.system, o.tools, o.items, o.constrained);
  const counted = o.reported?.promptTokens;
  const scale = counted && whole > 0 ? counted / whole : 1;
  const reply = Math.min(MIN_OUTPUT_TOKENS, o.maxOutputTokens);
  const size = (items: CanonicalItem[]) => Math.ceil(estimateRequestTokens(o.system, o.tools, items, o.constrained) * scale) + reply;
  const history = at > 0;
  // The request that was measured or refused held nothing but this message.
  const onlyThisMessage = !history && o.items.length === 1;
  let fresh = size([o.current]);
  const thisRun = size(o.items.slice(at));
  const window = o.windowTokens;
  // Refused with no count from the server, a request holding only this message still proves it does not fit.
  if (o.rejected && onlyThisMessage && !counted && window) fresh = Math.max(fresh, window + reply);
  const kind: ContextVerdict['kind'] = !window
    ? o.rejected && onlyThisMessage
      ? 'setup'
      : 'unclear'
    : fresh > window
      ? 'setup'
      : thisRun > window || !history
        ? 'run'
        : 'conversation';
  const minimumTokens = Math.ceil(fresh / 1024) * 1024;
  return { kind, minimumTokens, recommendedTokens: Math.max(WORKING_WINDOW_TOKENS, 2 ** Math.ceil(Math.log2(minimumTokens))), estimated: !(counted && onlyThisMessage) };
}
