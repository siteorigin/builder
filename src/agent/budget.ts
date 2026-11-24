/**
 * Context budgeting. Keeps a run inside the model's context window by collapsing old read results to a
 * one-line summary. Only the content of a tool result changes: every call keeps its result, in order, and
 * assistant turns (with their provider reasoning) are replayed exactly as they were received.
 *
 * Nothing changes until the context is half full, and a collapsed result stays collapsed, so the start of
 * the conversation stays stable for prompt caches on providers and local runtimes.
 */
import type { CanonicalItem, ModelCapabilities, ToolDefinition } from './types';

/** Above this share of the usable window, reads that a newer read of the same thing replaced are collapsed. */
export const SOFT_LIMIT = 0.5;
/** Above this share, reads made stale by a later change are collapsed too. Their IDs stay in the summary. */
export const HARD_LIMIT = 0.8;
/** The latest turns are what the model is working from, and are never collapsed. */
const PROTECTED_TURNS = 2;
const TOMBSTONE = '[Superseded ';
const MIN_OUTPUT_TOKENS = 1024;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function itemTokens(item: CanonicalItem): number {
  if (item.kind === 'user') return estimateTokens(item.text);
  if (item.kind === 'tool_result') return estimateTokens(item.content) + 8;
  // Replayed provider data (reasoning included) is what is really sent for this turn.
  if (item.providerData !== undefined) return estimateTokens(JSON.stringify(item.providerData));
  return estimateTokens(item.text) + item.toolCalls.reduce((n, c) => n + estimateTokens(c.arguments) + 8, 0);
}

export function estimateRequestTokens(system: string, tools: ToolDefinition[], items: CanonicalItem[]): number {
  const toolTokens = tools.reduce((n, t) => n + estimateTokens(t.name + t.description + JSON.stringify(t.parameters)), 0);
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
}

const PROJECT_EXTRAS = ['tokens', 'catalogue', 'components'];

function describeRead(item: Extract<CanonicalItem, { kind: 'tool_result' }>, index: number, args: Record<string, any>): ReadInfo | null {
  if (item.isError || item.content.startsWith(TOMBSTONE)) return null;
  const body = parse(item.content);
  const partial = body?.truncated === true;
  // A result cut short still starts with its revision, when it has one.
  const revision = partial ? Number(/^\{"revision":(\d+)[,}]/.exec(String(body!.partial ?? ''))?.[1] ?? NaN) : body?.revision;
  const base = { index, name: item.name, ...(partial ? { partial } : {}), ...(typeof revision === 'number' && Number.isFinite(revision) ? { revision } : {}) };
  if (item.name === 'read_page') {
    const pageId = String(body?.owner?.id ?? body?.id ?? args.pageId ?? '');
    if (!pageId) return null;
    const nodeId = args.nodeId ? String(args.nodeId) : '';
    return { ...base, target: `page:${pageId}:${nodeId}`, pageId };
  }
  if (item.name === 'read_component') {
    const id = args.definitionId ?? args.componentId ?? body?.definitionId;
    return id ? { ...base, target: `component:${id}` } : null;
  }
  if (item.name === 'read_project') {
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
    return { ...base, target: `element:${owner.kind}:${owner.id}:${args.nodeId}` };
  }
  if (item.name === 'inspect_layout') {
    const pageId = body?.pageId ?? args.pageId;
    const viewport = body?.viewport ?? args.viewport;
    return pageId && viewport ? { ...base, target: `layout:${pageId}:${viewport}`, pageId: String(pageId) } : null;
  }
  return null;
}

/** Whether a later read shows everything an earlier one did, at least as recently. */
function replaces(newer: ReadInfo, older: ReadInfo): boolean {
  if (newer.index <= older.index || newer.target !== older.target || (newer.partial && !older.partial)) return false;
  if (newer.name === 'read_project') return older.extras!.every((s) => newer.extras!.includes(s));
  // Only a complete read is known to show every line it covers.
  if (newer.name === 'read_source') return !newer.partial && newer.lines![0] <= older.lines![0] && newer.lines![1] >= older.lines![1];
  return true;
}

/** The one-line stand-in for a read. A page keeps its section IDs, so the model can still address them. */
export function tombstoneFor(read: Pick<ReadInfo, 'name'>, content: string, args: Record<string, any>): string {
  const body = parse(content);
  const rev = body?.revision !== undefined ? ` at rev ${body.revision}` : '';
  if (read.name === 'read_page') {
    const id = body?.owner?.id ?? body?.id ?? args.pageId;
    const title = body?.title ? ` "${String(body.title).slice(0, 40)}"` : '';
    const list = Array.isArray(body?.sections) ? body!.sections : body?.node ? [body.node] : [];
    const sections = list.slice(0, 12).map((s: Record<string, unknown>) => `${s.id} ${s.componentId ?? s.kind ?? ''}`.trim()).join(', ');
    const more = list.length > 12 ? `, and ${list.length - 12} more` : '';
    return `${TOMBSTONE}read_page ${id}${title}${rev}.${sections ? ` Sections: ${sections}${more}.` : ''} Read it again before relying on its content.]`;
  }
  if (read.name === 'read_component') return `${TOMBSTONE}read_component ${args.definitionId ?? args.componentId ?? body?.definitionId}. Read it again if you need its contract.]`;
  // The hash is left out: only a fresh read gives one a patch can use.
  if (read.name === 'read_source') {
    const lines = typeof body?.source === 'string' ? ` lines ${body.startLine}–${body.endLine} of ${body.totalLines}` : '';
    return `${TOMBSTONE}read_source ${body?.definitionId ?? args.definitionId}${lines}. Read it again for the current source and hash.]`;
  }
  if (read.name === 'inspect_element') {
    const owner = args.owner ?? body?.owner;
    return `${TOMBSTONE}inspect_element ${args.nodeId} on ${owner?.kind} ${owner?.id}${rev}. Inspect it again before relying on it.]`;
  }
  if (read.name === 'inspect_layout') return `${TOMBSTONE}inspect_layout ${body?.pageId ?? args.pageId} ${body?.viewport ?? args.viewport}. Measure it again if you need it.]`;
  const pages = Array.isArray(body?.pages) ? body!.pages : [];
  const list = pages.slice(0, 12).map((p: Record<string, unknown>) => `${p.id} ${p.route ?? ''}`.trim()).join(', ');
  const more = pages.length > 12 ? `, and ${pages.length - 12} more` : '';
  return `${TOMBSTONE}read_project${rev}${args.sections?.length ? ` (${args.sections.join(', ')})` : ''}.${list ? ` Pages: ${list}${more}.` : ''} Read it again if you need it.]`;
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
    capabilities: Pick<ModelCapabilities, 'contextWindowTokens' | 'maxOutputTokens'>;
    isMutation: (toolName: string) => boolean;
    /** The project's revision now. Some changes (links connected when a page is created) are not a tool's result. */
    revision?: number;
  }
): BudgetResult {
  const { contextWindowTokens: window, maxOutputTokens } = opts.capabilities;
  const available = window - Math.min(maxOutputTokens, Math.floor(window / 4));
  let estimate = estimateRequestTokens(opts.system, opts.tools, items);
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
    items.forEach((it, i) => {
      if (it.kind !== 'tool_result') return;
      if (!it.isError && opts.isMutation(it.name)) {
        lastMutation = i;
        changes.push({ index: i, text: `${JSON.stringify(argsByCall.get(it.callId) ?? {})} ${it.content}` });
      }
      const read = describeRead(it, i, argsByCall.get(it.callId) ?? {});
      if (read) reads.push(read);
    });
    const collapse = (r: ReadInfo) => {
      const it = items[r.index] as Extract<CanonicalItem, { kind: 'tool_result' }>;
      const line = tombstoneFor(r, it.content, argsByCall.get(it.callId) ?? {}).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
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
      // A patch names its component; a later read with another hash shows a change made some other way.
      if (r.name === 'read_source') return changedAfter(r.definitionId!) || (!!r.hash && reads.some((n) => n.index > r.index && n.target === r.target && !!n.hash && n.hash !== r.hash));
      // A measurement, an element's props and the project summary all describe the revision they were read at:
      // only a change that moved it (whether or not a tool made it) makes them stale.
      if (r.name !== 'inspect_element' && r.name !== 'inspect_layout' && r.name !== 'read_project') return false;
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
