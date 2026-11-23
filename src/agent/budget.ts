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
}

function describeRead(item: Extract<CanonicalItem, { kind: 'tool_result' }>, index: number, args: Record<string, any>): ReadInfo | null {
  if (item.isError || item.content.startsWith(TOMBSTONE)) return null;
  const body = parse(item.content);
  if (item.name === 'read_page') {
    const pageId = String(body?.owner?.id ?? body?.id ?? args.pageId ?? '');
    if (!pageId) return null;
    const nodeId = args.nodeId ? String(args.nodeId) : '';
    return { index, name: item.name, target: `page:${pageId}:${nodeId}`, pageId };
  }
  if (item.name === 'read_component') {
    const id = args.definitionId ?? args.componentId ?? body?.definitionId;
    return id ? { index, name: item.name, target: `component:${id}` } : null;
  }
  if (item.name === 'read_project') return { index, name: item.name, target: `project:${[...(args.sections ?? [])].sort().join(',')}` };
  return null;
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
  return `${TOMBSTONE}read_project${rev}${args.sections?.length ? ` (${args.sections.join(', ')})` : ''}. Read it again if you need it.]`;
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
export function applyContextBudget(items: CanonicalItem[], opts: { system: string; tools: ToolDefinition[]; capabilities: Pick<ModelCapabilities, 'contextWindowTokens' | 'maxOutputTokens'>; isMutation: (toolName: string) => boolean }): BudgetResult {
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
      const line = tombstoneFor(r, it.content, argsByCall.get(it.callId) ?? {});
      if (line.length >= it.content.length) return;
      estimate -= estimateTokens(it.content) - estimateTokens(line);
      it.content = line;
      tombstoned++;
    };
    const collapsed = new Set<ReadInfo>();
    for (const r of reads) {
      if (r.index >= protectedFrom) continue;
      const replaced = reads.some((n) => n.index > r.index && n.target === r.target);
      if (replaced) {
        collapse(r);
        collapsed.add(r);
      }
    }
    if (estimate > available * HARD_LIMIT) {
      for (const r of reads) {
        if (collapsed.has(r) || r.index >= protectedFrom || estimate <= available * HARD_LIMIT) continue;
        // A contract does not go stale, so it is only given up after the page reads it was used for.
        if (r.name === 'read_page' && changes.some((c) => c.index > r.index && c.text.includes(r.pageId!))) collapse(r);
      }
      for (const r of reads) {
        if (collapsed.has(r) || r.index >= protectedFrom || estimate <= available * HARD_LIMIT) continue;
        if (r.name === 'read_component' && r.index < lastMutation) collapse(r);
      }
    }
  }
  // The compaction target leaves generous room; the hard limit is whether a useful answer still fits at all.
  const room = window - estimate;
  return { estimate, available, tombstoned, overflow: room < Math.min(MIN_OUTPUT_TOKENS, maxOutputTokens), maxOutputTokens: Math.max(1, Math.min(maxOutputTokens, room)) };
}
