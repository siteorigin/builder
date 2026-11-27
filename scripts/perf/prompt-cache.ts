/**
 * What a provider can reuse of each request an AI run sends (scripts/perf/README.md, "Prompts"). A request is read as
 * the provider reads it, a sequence of blocks: for the Messages API its tools, then its system blocks, then each
 * message's content blocks; for the Responses API its tools, its instructions, then each input item. Each block is
 * sized by its JSON as sent, with any `cache_control` marker left out (a marker is where the cache keeps a prefix, not
 * part of what it keeps), and carries the hash of every block up to and including it.
 *
 * `PromptCache` applies Anthropic's documented prompt caching rule to a run's requests in order: a prefix is kept only
 * at a breakpoint (a block marked `cache_control`, or the last block when the request has a top-level `cache_control`)
 * and only when it is long enough; a breakpoint reads the longest kept prefix it can find among the 20 positions that
 * end at it, its own included (a run of tool_use blocks, or of tool_result blocks, in one message is one position);
 * what follows the read, up
 * to the request's last breakpoint, is written; the rest is processed afresh. Entries do not expire: a run's turns are
 * seconds apart, inside the shortest lifetime. `commonPrefix` is what any prefix cache could reuse of a request: the
 * bytes of its leading blocks identical to the request before it.
 *
 * Nothing here talks to a provider or to the app; the bench (prompt.ts) and the unit tests drive it.
 */
import { createHash } from 'node:crypto';

export interface RenderedRequest {
  /** Each block's JSON, as compared and hashed. */
  blocks: string[];
  /** Each block's size in bytes. */
  bytes: number[];
  /** The hash of every block up to and including each one. */
  hashes: string[];
  /** Each block's position, as the cache's lookback counts them. */
  units: number[];
  /** The blocks marked as breakpoints, in order. */
  breakpoints: number[];
  /** Every `cache_control` marker the request carries, the top-level one included. */
  markers: number;
  /** Where the request's parts begin: its system or instructions, and its messages or input. */
  systemAt: number;
  messagesAt: number;
}

type Json = Record<string, unknown>;

/** A block without its cache marker, so two requests that differ only in where their marker is compare equal. */
const unmarked = (block: unknown): unknown => {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
  const { cache_control: _marker, ...rest } = block as Json;
  return rest;
};

const isMarked = (block: unknown): boolean => !!block && typeof block === 'object' && !Array.isArray(block) && (block as Json).cache_control != null;

function rendered(model: string, parts: Array<{ json: string; marked: boolean; run?: string; message?: number }>, systemAt: number, messagesAt: number, topLevel: boolean): RenderedRequest {
  const blocks: string[] = [];
  const bytes: number[] = [];
  const hashes: string[] = [];
  const units: number[] = [];
  const breakpoints: number[] = [];
  let hash = createHash('sha256').update(model).digest('hex');
  let unit = -1;
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    // Consecutive tool_use blocks, or tool_result blocks, of one message take one position of the lookback.
    if (!(prev && p.run && prev.run === p.run && prev.message === p.message)) unit++;
    hash = createHash('sha256').update(hash).update('\n').update(p.json).digest('hex');
    blocks.push(p.json);
    bytes.push(Buffer.byteLength(p.json));
    hashes.push(hash);
    units.push(unit);
    if (p.marked) breakpoints.push(i);
  });
  // A top-level marker caches the last block of the request.
  if (topLevel && parts.length && !breakpoints.includes(parts.length - 1)) breakpoints.push(parts.length - 1);
  return { blocks, bytes, hashes, units, breakpoints, markers: parts.filter((p) => p.marked).length + (topLevel ? 1 : 0), systemAt, messagesAt };
}

/** A Messages API request body as Anthropic reads it. Text given as a string is the text block it stands for. */
export function renderMessages(body: Json): RenderedRequest {
  const parts: Array<{ json: string; marked: boolean; run?: string; message?: number }> = [];
  for (const t of (body.tools as unknown[] | undefined) ?? []) parts.push({ json: JSON.stringify(['tool', unmarked(t)]), marked: isMarked(t) });
  const systemAt = parts.length;
  const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : ((body.system as unknown[] | undefined) ?? []);
  for (const s of system) parts.push({ json: JSON.stringify(['system', unmarked(s)]), marked: isMarked(s) });
  const messagesAt = parts.length;
  ((body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []).forEach((m, k) => {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : ((m.content as unknown[]) ?? []);
    content.forEach((c, j) => {
      const type = (c as Json)?.type;
      parts.push({ json: JSON.stringify([m.role, j === 0, unmarked(c)]), marked: isMarked(c), run: type === 'tool_use' || type === 'tool_result' ? String(type) : undefined, message: k });
    });
  });
  return rendered(String(body.model ?? ''), parts, systemAt, messagesAt, body.cache_control != null);
}

/** A Responses API request body, in the order its prompt is put together: tools, instructions, input. */
export function renderResponses(body: Json): RenderedRequest {
  const parts: Array<{ json: string; marked: boolean }> = [];
  for (const t of (body.tools as unknown[] | undefined) ?? []) parts.push({ json: JSON.stringify(['tool', t]), marked: false });
  const systemAt = parts.length;
  if (body.instructions !== undefined) parts.push({ json: JSON.stringify(['instructions', body.instructions]), marked: false });
  const messagesAt = parts.length;
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : ((body.input as unknown[] | undefined) ?? []);
  for (const item of input) parts.push({ json: JSON.stringify(['input', item]), marked: false });
  return rendered(String(body.model ?? ''), parts, systemAt, messagesAt, false);
}

const total = (r: RenderedRequest) => r.bytes.reduce((n, b) => n + b, 0);
const upTo = (r: RenderedRequest, i: number) => r.bytes.slice(0, i + 1).reduce((n, b) => n + b, 0);

/** The bytes of the leading blocks of `next` that are identical to `prev`'s, in order. */
export function commonPrefix(prev: RenderedRequest | null, next: RenderedRequest): number {
  if (!prev) return 0;
  let i = 0;
  while (i < prev.hashes.length && i < next.hashes.length && prev.hashes[i] === next.hashes[i]) i++;
  return i ? upTo(next, i - 1) : 0;
}

/** Whether `next` changed a part of `prev`: its tools, its system or instructions, or a message `prev` already had. */
export function changedParts(prev: RenderedRequest, next: RenderedRequest): { tools: boolean; system: boolean; history: boolean } {
  const slice = (r: RenderedRequest, from: number, to: number) => r.blocks.slice(from, to).join('\n');
  const tools = slice(prev, 0, prev.systemAt) !== slice(next, 0, next.systemAt);
  const system = slice(prev, prev.systemAt, prev.messagesAt) !== slice(next, next.systemAt, next.messagesAt);
  const had = prev.blocks.length - prev.messagesAt;
  const history = slice(prev, prev.messagesAt, prev.blocks.length) !== slice(next, next.messagesAt, next.messagesAt + had);
  return { tools, system, history };
}

export interface Served {
  /** Bytes read from the cache. */
  read: number;
  /** Bytes written to the cache (processed, and kept for the next request). */
  write: number;
  /** Bytes processed afresh and not kept. */
  uncached: number;
  total: number;
}

/** Anthropic's prompt cache over one run's requests, in the order they are sent. */
export class PromptCache {
  private kept = new Set<string>();
  /**
   * `minBytes`: a prefix shorter than this is never kept: the bench's models' minimum of 512 tokens, at about 4 bytes
   * each (bytes stand in for tokens here, which only the provider counts).
   */
  constructor(private readonly opts: { lookback: number; minBytes: number } = { lookback: 20, minBytes: 2048 }) {}

  serve(r: RenderedRequest): Served {
    const all = total(r);
    if (!r.breakpoints.length) return { read: 0, write: 0, uncached: all, total: all };
    let hit = -1;
    for (const b of r.breakpoints)
      for (let p = b; p >= 0 && r.units[b] - r.units[p] < this.opts.lookback; p--)
        if (this.kept.has(r.hashes[p])) {
          hit = Math.max(hit, p);
          break;
        }
    const read = hit >= 0 ? upTo(r, hit) : 0;
    let last = -1;
    for (const b of r.breakpoints)
      if (b > hit && upTo(r, b) >= this.opts.minBytes) {
        this.kept.add(r.hashes[b]);
        last = Math.max(last, b);
      }
    const write = last >= 0 ? upTo(r, last) - read : 0;
    return { read, write, uncached: all - read - write, total: all };
  }
}
