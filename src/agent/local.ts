import { lookup as dnsLookup } from 'node:dns/promises';
import { newId } from '@shared/ids';
import type { LocalCheck, TokenUsage } from '@shared/api';
import { checkLocalBaseURL, localContextWindow, localKeyProblem, type LocalToolMode, type LocalURLCheck } from '@shared/local';
import type { AdapterNote, AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ContextOverflow, ModelCapabilities, ModelErrorCode, ModelEvent, StopReason, ToolCall, ToolDefinition } from './types';
import type { JsonSchema } from './strict-schema';
import { redact } from './types';
import { envelopeInstructions, envelopeSchema, FINISH_ACTION, parseEnvelope, partialStatus, stripThinking } from './constrained';
import { localModelProfile, localWindow, type LocalModelProfile } from '@shared/local-models';
import { MIN_OUTPUT_TOKENS, WORKING_WINDOW_TOKENS } from './budget';

/** A loaded model can take minutes to read a long prompt before its first token. */
export const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** Once tokens are flowing, a gap this long means the server has stalled. */
export const IDLE_TIMEOUT_MS = 30_000;
/** After the finish reason only a usage chunk can follow, and not every server closes the stream promptly. */
const FINISH_GRACE_MS = 2_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** A connection test waits this long for the model's first token: long enough for a small model to load. */
export const TEST_FIRST_TOKEN_MS = 60_000;
/** And ends within this however slowly the reply comes, including any request sent again. */
export const TEST_DEADLINE_MS = 90_000;
const TEST_STOPPED = 'The test was stopped.';
/** Reading the loaded context size is optional, so a server that is slow to report it never holds up a request. */
const CONTEXT_DISCOVERY_MS = 1_000;

/** How long a failed response gets to deliver its error text. */
const ERROR_BODY_MS = 5_000;
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const MAX_CORRECTIONS = 2;
const MAX_FALLBACKS = 4;

/**
 * Where a local model is served. Deliberately independent of Settings: a process the app manages itself can
 * construct one directly from the port and model it started.
 */
export interface LocalEndpoint {
  baseURL: string;
  model: string;
  apiKey?: string | null;
  allowRemote?: boolean;
  toolMode?: LocalToolMode;
  /** The context size the author set in Settings. It caps whatever the server reports. */
  contextWindow?: number | null;
}

/** Servers whose report of the loaded context size the app reads, and whose setup it can explain. */
export type LocalServerKind = 'llama.cpp' | 'ollama' | 'lm-studio' | 'vllm';

/** What the server reported about the loaded model. */
export interface LocalContext {
  windowTokens?: number;
  server?: LocalServerKind;
}

export interface LocalAdapterOptions {
  fetch?: typeof globalThis.fetch;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  profile?: LocalModelProfile;
  /** Every address a name resolves to. Tests stand in for the system resolver. */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  /** The loaded context size the server reported before the run, from `discoverLocalContext`. */
  context?: LocalContext;
  /**
   * Told whether a request showed the server and model can chat: a finished reply, or a failure that says the
   * setup is wrong (nothing answered, the key or the request was refused). A busy server or a model's odd reply
   * says nothing about the setup and is not reported.
   */
  onCheck?: (check: LocalCheck) => void;
}

const LOOKUP_TIMEOUT_MS = 2_000;
const LOOPBACK_ADDRESS = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * `localhost` is only a name, and the hosts file or resolver can point it anywhere. Before anything is sent, every
 * address it resolves to must be this computer. The name stays in the request, so proxy exclusions and certificates
 * written for it still apply.
 */
async function localhostProblem(url: string, lookup: LocalAdapterOptions['lookup'] = (host) => dnsLookup(host, { all: true }), signal?: AbortSignal): Promise<string | null> {
  if (new URL(url).hostname !== 'localhost') return null;
  const instead = 'so nothing was sent. Use http://127.0.0.1 in the server address instead.';
  // A resolver that stalls must not hold a request past its own timeouts, or past Stop.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => undefined as void;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS);
    onAbort = () => reject(new Error('aborted'));
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const elsewhere = (await Promise.race([lookup('localhost'), gaveUp])).find((a) => !LOOPBACK_ADDRESS.test(a.address));
    return elsewhere ? `localhost on this computer points to ${elsewhere.address}, which is not this computer, ${instead}` : null;
  } catch {
    return `localhost could not be looked up on this computer, ${instead}`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    gaveUp.catch(() => undefined);
  }
}

/** `setup`: the server or model is not usable as set up, rather than this request failing (see `setupStage`). */
type LocalError = { code: ModelErrorCode; message: string; retryAfterMs?: number; context?: ReturnType<typeof contextOverflow>; setup?: 'server' | 'chat' };
type TurnResult =
  | { kind: 'done'; event: Extract<ModelEvent, { type: 'done' }> }
  /** `streamed`: part of the reply had already arrived, so asking again would show it twice. */
  /** `errorBody`: an error the server sent inside the stream, as it sent it. */
  | { kind: 'error'; error: LocalError; streamed?: boolean; errorBody?: string }
  | { kind: 'http'; status: number; body: string; retryAfterMs?: number }
  | { kind: 'unusable'; problem: string; raw: string };
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string };

const CANCELLED: LocalError = { code: 'cancelled', message: 'Canceled' };

function headers(apiKey: string | null | undefined, accept: string): Record<string, string> {
  return { 'content-type': 'application/json', accept, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

/** Server error text from any of the shapes OpenAI-compatible servers use, with the key in use removed. */
function serverMessage(body: string, apiKey?: string | null): string {
  let text = body;
  try {
    const v = JSON.parse(body) as { error?: string | { message?: string }; detail?: unknown; message?: string };
    const found = typeof v.error === 'string' ? v.error : (v.error?.message ?? v.message ?? (typeof v.detail === 'string' ? v.detail : undefined));
    if (found) text = found;
    // An empty object says nothing, and "{}" is not a message.
    else if (v && typeof v === 'object' && Object.values(v).every((x) => !x || (typeof x === 'object' && !Object.keys(x).length))) text = '';
  } catch {
    /* plain text */
  }
  const clean = apiKey ? text.split(apiKey).join('…') : text;
  return redact(clean).trim().slice(0, 300);
}

/** The request parameter a server's error names, when it names one. */
function serverParam(body: string): string {
  const param = (safeJson(body) as { error?: { param?: unknown } } | undefined)?.error?.param;
  return typeof param === 'string' ? param : '';
}

/** A refusal of the structured response format, or of the grammar the server builds from it. */
const FORMAT_REFUSED =
  /(?:unknown|unsupported|unrecognized|invalid|extra)[^.]*(?:response_format|json_schema)|(?:response_format|json_schema)[^.]*(?:not supported|unsupported|unknown|invalid|not permitted|failed)|failed to (?:parse|compile)[^.]*grammar|grammar[^.]*(?:parse|compile)|(?:invalid|unsupported) grammar/i;
/** A refusal of the structured format itself, which no form of the schema would get past. */
const FORMAT_TYPE_REFUSED =
  /response_format[^.]*type[^.]*(?:not supported|unsupported|not permitted|unknown|invalid)|type[^.]*json_(?:schema|object)[^.]*(?:not supported|unsupported|not permitted)|(?:unsupported|unknown|unrecognized) (?:value for )?response_format\b/i;
/** A reference the server could not follow: always about the schema, whatever else the message says. */
const REFERENCE_REFUSED = /\$ref|\$defs|resolv\w* ref/i;
/**
 * A refusal of what a schema contains, such as a `$ref` or `$defs` the server cannot follow, or the grammar it
 * failed to build (llama.cpp, vLLM, Ollama and LM Studio wordings). Only wording that blames the schema or its
 * grammar counts, so a model named after one is not taken for it.
 */
const SCHEMA_REFUSED =
  /\$ref|\$defs|resolv\w* ref|unrecognized schema|json[ _]schema[^.]*(?:conver|compil|pars|transform|grammar|not supported|unsupported|invalid)|(?:unsupported|unrecognized|invalid)[^.]*json[ _]schema|failed to (?:parse|compile)[^.]*grammar|grammar[^.]*(?:parse|compile)|(?:invalid|unsupported) grammar/i;

/**
 * Whether an error refuses what the schema contains rather than the format, the request's length or anything else.
 * A structured parameter is authoritative; otherwise the wording must blame the schema.
 */
function refusesSchema(text: string, param: string): boolean {
  if (param) return param.startsWith('response_format.json_schema');
  // A request too long for the model is about its length, whatever it quotes.
  if (CONTEXT_FULL.test(text)) return false;
  if (REFERENCE_REFUSED.test(text)) return true;
  return !FORMAT_TYPE_REFUSED.test(text) && SCHEMA_REFUSED.test(text);
}

/**
 * Whether a refused request with the compact schema should go again with the full one, which is exactly what the
 * adapter sent before compact schemas: any refusal but one of the request's length, of the format itself, or of
 * another parameter the server names. A server's wording for what it cannot compile is not known in advance.
 */
function retriesFullSchema(text: string, param: string): boolean {
  if (param) return param.startsWith('response_format.json_schema');
  return !CONTEXT_FULL.test(text) && !FORMAT_TYPE_REFUSED.test(text);
}

const CONTEXT_FULL = /context (size|length|window)|exceeds? .*context|n_ctx|too many tokens|prompt is too long/i;

const contextMessage = "The request is too long for this model's context window.";
const LOADING = 'The local model is still loading.';

/**
 * Whether the server's refusal of a chat request is the setup's (the model, or the key it needs) or this request's: a
 * busy or loading server will answer later, and a conversation or request too large for the model is the request's.
 */
function setupStage(status: number, error: LocalError): 'chat' | undefined {
  return error.code === 'rate_limit' || error.message === LOADING || error.message === contextMessage || status === 413 ? undefined : 'chat';
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
const first = (text: string, patterns: RegExp[]) => {
  for (const p of patterns) {
    const n = count(Number(p.exec(text)?.[1]));
    if (n) return n;
  }
  return undefined;
};

/**
 * The numbers in a context error, from the shapes local servers use: llama.cpp's `n_ctx` and `n_prompt_tokens`
 * fields and its message, vLLM's "maximum context length is X … (A in the messages", and LM Studio's texts.
 * LM Studio's "keep the first N tokens" is only part of the prompt, so it is not taken as the prompt's size.
 */
export function contextOverflow(body: string): ContextOverflow & { server?: LocalServerKind } {
  const v = safeJson(body) as { error?: unknown } | undefined;
  const fields = (v && typeof v.error === 'object' && v.error ? v.error : (v ?? {})) as Record<string, unknown>;
  const text = serverMessage(body);
  const windowTokens = count(fields.n_ctx) ?? first(text, [/available context size \((\d+) tokens?\)/i, /maximum context length is (\d+)/i, /context length of only (\d+)/i, /maximum context size is (\d+)/i]);
  const promptTokens = count(fields.n_prompt_tokens) ?? first(text, [/request \((\d+) tokens?\)/i, /\((\d+) in the messages/i, /but (\d+) tokens were provided/i, /request has (\d+) input tokens/i]);
  const server: LocalServerKind | undefined =
    fields.type === 'exceed_context_size_error' || /available context size/i.test(text) ? 'llama.cpp' : /maximum context length is \d+/i.test(text) ? 'vllm' : /context length of only|maximum context size is/i.test(text) ? 'lm-studio' : undefined;
  return { ...(windowTokens ? { windowTokens } : {}), ...(promptTokens ? { promptTokens } : {}), ...(server ? { server } : {}) };
}

function httpError(status: number, body: string, model: string, retryAfterMs?: number, apiKey?: string | null): LocalError {
  const message = serverMessage(body, apiKey);
  if (status === 401 || status === 403) return { code: 'auth', message: 'The local server rejected the API key. Check it in Settings.' };
  if (CONTEXT_FULL.test(message)) return { code: 'invalid_request', message: contextMessage, context: contextOverflow(body) };
  if (status === 404) return { code: 'invalid_request', message: message ? `The local server could not use ${model}: ${message}` : `The local server has no model called ${model}.` };
  if (status === 429) return { code: 'rate_limit', message: 'The local server is busy.', retryAfterMs };
  // llama-server answers 503 while the model is still loading.
  if (status >= 500) return { code: 'overloaded', message: /loading/i.test(message) ? LOADING : `The local server reported an error${message ? `: ${message}` : '.'}`, retryAfterMs };
  return { code: 'invalid_request', message: message || `The local server answered with status ${status}.` };
}

/** Errors with no HTTP response. A server that is not running will not start during a retry, so that fails at once. */
function connectionError(e: unknown, url: string): LocalError {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const text = `${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''} ${err?.message ?? ''}`;
  if (/redirect/i.test(text)) return { code: 'invalid_request', message: `The server at ${url} tried to redirect the request, so nothing was sent on.`, setup: 'server' };
  // A connection that was made and then lost can come back, unlike a server that is not there.
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(err?.cause?.code ?? '')) return { code: 'network', message: 'The local server closed the connection before the response finished.' };
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EADDRNOTAVAIL|ENETUNREACH|fetch failed/i.test(text)) return { code: 'unreachable', message: `Could not connect to a model server at ${url}. Is your local server running?`, setup: 'server' };
  return { code: 'network', message: 'The local server closed the connection before the response finished.' };
}

/** Splits a server-sent event stream into data payloads, across chunk boundaries and any line ending. */
class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  /** The last chunk ended in CR, so an LF opening the next one belongs to the same line ending. */
  private skipLf = false;

  push(chunk: string): string[] {
    if (chunk && this.skipLf) {
      if (chunk[0] === '\n') chunk = chunk.slice(1);
      this.skipLf = false;
    }
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) return out;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      if (m[0] === '\r' && !this.buffer) this.skipLf = true;
      this.line(line, out);
    }
  }

  flush(): string[] {
    const out: string[] = [];
    if (this.buffer) this.line(this.buffer, out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: string[]) {
    if (!line) {
      if (this.data.length) {
        const payload = this.data.join('\n');
        if (this.event !== 'error') out.push(payload);
        else {
          const v = safeJson(payload);
          out.push(v && typeof v === 'object' && 'error' in v ? payload : JSON.stringify({ error: v ?? payload }));
        }
      }
      this.data = [];
      this.event = '';
    } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) this.event = line.slice(6).trim();
    // llama-server reports a failure after the headers as an `error:` field.
    else if (line.startsWith('error:')) this.data.push(JSON.stringify({ error: safeJson(line.slice(6).trim()) ?? line.slice(6).trim() }));
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

type CallFragment = { index?: number; id?: string; function?: { name?: string; arguments?: unknown } };
type Slot = { index: number | null; serverId?: string; name: string; args: string; objectArgs: boolean };

/**
 * Rebuilds tool calls from stream fragments. Servers differ: some omit `index`, some reuse index 0 for
 * parallel calls with different IDs, some reuse an ID across indexes, some repeat the name, and some send
 * arguments as an object. A fragment that contradicts its call makes the whole turn unusable.
 */
class ToolCallAssembler {
  private slots: Slot[] = [];
  private malformed = false;

  /** One delta's entries. Two entries of the same delta are never the same call. */
  push(fragments: CallFragment[]) {
    const used = new Set<Slot>();
    // Entries naming an ID claim their calls first, so an index-only entry cannot take one of them.
    const order = fragments.map((_, i) => i).sort((a, b) => Number(!fragments[a]?.id) - Number(!fragments[b]?.id));
    order.forEach((position) => {
      const f = fragments[position];
      if (!f || typeof f !== 'object') return;
      const slot = this.find(f, position, used) ?? this.open();
      used.add(slot);
      if (typeof f.index === 'number') slot.index = f.index;
      if (f.id) slot.serverId = f.id;
      const name = f.function?.name;
      if (name && slot.name && name !== slot.name) this.malformed = true;
      if (name) slot.name = name;
      const args = f.function?.arguments;
      if (typeof args === 'string') {
        if (slot.objectArgs && args) this.malformed = true;
        slot.args += args;
      } else if (args && typeof args === 'object') {
        if (slot.args) this.malformed = true;
        slot.args = JSON.stringify(args);
        slot.objectArgs = true;
      }
    });
  }

  private open(): Slot {
    const slot: Slot = { index: null, name: '', args: '', objectArgs: false };
    this.slots.push(slot);
    return slot;
  }

  private find(f: CallFragment, position: number, used: Set<Slot>): Slot | undefined {
    const open = this.slots.filter((s) => !used.has(s)).reverse();
    const index = typeof f.index === 'number' ? f.index : null;
    if (f.id) return open.find((s) => s.serverId === f.id && (index === null || s.index === null || s.index === index)) ?? (index === null ? undefined : open.find((s) => s.index === index && !s.serverId));
    if (index !== null) return open.find((s) => s.index === index) ?? open.find((s) => s.index === null);
    // Neither identifier: only the first entry can continue the latest call, and only under the same name.
    const last = this.slots[this.slots.length - 1];
    return position === 0 && last && !used.has(last) && (!f.function?.name || !last.name || f.function.name === last.name) ? last : undefined;
  }

  /**
   * Null when a call is incomplete or contradictory. The IDs are always generated here: local servers often
   * repeat IDs such as "call_0" between turns, and the session treats a repeated ID as a replay of the same
   * edit. Nine alphanumerics is the strictest format a common chat template (Mistral) accepts.
   */
  calls(): ToolCall[] | null {
    if (this.malformed || this.slots.some((s) => !s.name)) return null;
    return this.slots.map((s) => ({ id: newId('c', 8).replace('_', ''), name: s.name, arguments: s.args.trim() ? s.args : '{}' }));
  }
}

/** Keeps a leading `<think>` block out of the live chat text. */
class ThinkFilter {
  private mode: 'start' | 'inside' | 'after' | 'text' = 'start';
  private held = '';

  push(delta: string): string {
    if (this.mode === 'text') return delta;
    // The blank lines after the block can arrive in a later chunk.
    if (this.mode === 'after') {
      const rest = delta.trimStart();
      if (rest) this.mode = 'text';
      return rest;
    }
    this.held += delta;
    if (this.mode === 'start') {
      const t = this.held.trimStart();
      if ('<think>'.startsWith(t)) return '';
      if (!t.startsWith('<think>')) {
        this.mode = 'text';
        const out = this.held;
        this.held = '';
        return out;
      }
      this.mode = 'inside';
      this.held = t.slice('<think>'.length);
    }
    const end = this.held.indexOf('</think>');
    if (end < 0) {
      this.held = this.held.slice(-'</think>'.length);
      return '';
    }
    const rest = this.held.slice(end + '</think>'.length);
    this.held = '';
    this.mode = 'after';
    return this.push(rest);
  }
}

/** Bridges for strict chat templates, said in the voice of the role that has to fill the gap. */
const TOOL_RESULTS_READ = 'I have read the results.';
const EARLIER_TURNS = 'Earlier in this conversation:';
const GO_ON = 'Go on.';

/**
 * Strict chat templates (Mistral's, for one) set tool calls and their results aside, then require the messages
 * left to alternate user, assistant, user, starting with the user, or refuse the whole request. User messages that
 * meet are merged; two replies in a row, a note that follows tool results, or a transcript that opens with a reply
 * gets a short bridge from the missing role. Tool calls and results are never changed or moved.
 */
function alternate(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let counted: 'user' | 'assistant' | null = null;
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) {
      out.push({ ...m });
      continue;
    }
    // User messages that meet are merged. Replies are not: each may be a JSON envelope, which must stay whole.
    const last = out[out.length - 1];
    if (m.role === 'user' && counted === 'user' && last?.role === 'user') {
      last.content += `\n\n${m.content}`;
      continue;
    }
    if (m.role === counted) out.push(m.role === 'user' ? { role: 'assistant', content: TOOL_RESULTS_READ } : { role: 'user', content: GO_ON });
    else if (counted === null && m.role === 'assistant') out.push({ role: 'user', content: EARLIER_TURNS });
    out.push({ ...m });
    counted = m.role;
  }
  return out;
}

/** A malformed call is still replayed, and templates that parse arguments fail on invalid JSON. */
function replayableArgs(raw: string): string {
  const v = safeJson(raw);
  return v && typeof v === 'object' && !Array.isArray(v) ? raw : '{}';
}

/**
 * OpenAI-compatible `/chat/completions` adapter for models running on the user's machine. llama.cpp's
 * llama-server with grammar-constrained JSON is the primary path; anything model-specific comes from the
 * model's capability profile, so there are no per-runtime branches here.
 */
export class LocalAdapter implements AgentModelAdapter {
  private url: LocalURLCheck;
  private profile: LocalModelProfile;
  private mode: 'native' | 'constrained-json';
  private responseFormat: 'json_schema' | 'json_object' | 'none' = 'json_schema';
  /** The schema goes out compact until a server refuses it; then it is written out in full. */
  private compactSchema = true;
  /** Both forms of the envelope schema for a tool set, built once for the retries and turns that offer it. */
  private envelopes = new WeakMap<ToolDefinition[], { inline: JsonSchema; compact: JsonSchema | null }>();
  private usageOption = true;
  private fetchImpl: typeof globalThis.fetch;
  /** The context size the author set in Settings. */
  private configured: number | undefined;
  /** The context size the server reported, before the run or in a context error during it. */
  private reported: number | undefined;
  /** The server answered `discoverLocalContext`, so the size in Settings can be cleared and read from it instead. */
  private reportsSize: boolean;
  private server: LocalServerKind | undefined;

  constructor(private endpoint: LocalEndpoint, private opts: LocalAdapterOptions = {}) {
    this.url = checkLocalBaseURL(endpoint.baseURL, endpoint.allowRemote);
    this.profile = opts.profile ?? localModelProfile(endpoint.model);
    this.mode = endpoint.toolMode === 'native' || endpoint.toolMode === 'constrained-json' ? endpoint.toolMode : this.profile.toolCalling;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.configured = localContextWindow(endpoint.contextWindow) ?? undefined;
    this.reported = count(opts.context?.windowTokens);
    this.reportsSize = this.reported !== undefined;
    this.server = opts.context?.server;
  }

  private window(): number {
    return localWindow(this.configured, this.reported, this.profile).tokens;
  }

  capabilities(): ModelCapabilities {
    return {
      toolCalling: this.mode,
      streaming: true,
      strictSchemas: this.mode === 'constrained-json',
      parallelToolCalls: this.mode === 'native',
      contextWindowTokens: this.window(),
      maxOutputTokens: this.profile.maxOutput,
      contextWindowKnown: localWindow(this.configured, this.reported, this.profile).known
    };
  }

  /**
   * What to change so the model has a context of at least `tokens` tokens: the server's setting when the model is
   * not loaded with that much (or nothing says how much it has), and the size in Settings whenever that would still
   * hold it back.
   */
  contextHelp(tokens: number): string {
    const n = (t: number) => t.toLocaleString('en-US');
    const steps: string[] = [];
    if (this.reported === undefined || this.reported < tokens) {
      const { capacity, contextWindow } = this.profile;
      if (capacity && this.reported !== undefined && this.reported < contextWindow) steps.push(`${capacity.name} itself takes up to ${n(capacity.tokens)} tokens.`);
      switch (this.server) {
        case 'llama.cpp':
          steps.push(`Restart llama-server with --ctx-size ${tokens} or more. With --parallel, each parallel request gets an equal share of that size.`);
          break;
        case 'ollama':
          steps.push(`Set OLLAMA_CONTEXT_LENGTH=${tokens} or more and restart Ollama, or set PARAMETER num_ctx ${tokens} in the model's Modelfile. Requests through Ollama's OpenAI-compatible address cannot change it.`);
          break;
        case 'lm-studio':
          steps.push(`In LM Studio, load the model again with its Context Length set to ${tokens} or more.`);
          break;
        case 'vllm':
          steps.push(`Restart vLLM with --max-model-len ${tokens} or more.`);
          break;
        default:
          steps.push(`Load the model again with a context size of ${tokens} tokens or more in your model app.`);
      }
    } else steps.push(`The server already has the model loaded with ${n(this.reported)} tokens.`);
    // Clearing it helps only when the server reports its own size; otherwise the assistant falls back to a guess.
    if (this.configured !== undefined && this.configured < tokens)
      steps.push(`The context size set in Settings, ${n(this.configured)} tokens, also limits the assistant: raise it under Advanced server options${this.reportsSize ? ', or clear it to use the size the server reports' : ' to the size the model is loaded with'}.`);
    else if (this.configured === undefined && this.reported === undefined) steps.push('This server does not report its context size, so also enter the new size under Advanced server options in Settings.');
    return steps.join(' ');
  }

  private messages(items: CanonicalItem[], constrained: boolean): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const it of items) {
      if (it.kind === 'user') out.push({ role: 'user', content: it.text });
      else if (it.kind === 'assistant') {
        // A finish is replayed as an envelope too, so a repair turn still shows the format the model must use.
        const envelope = constrained ? (it.providerData as { envelope?: string } | undefined)?.envelope : undefined;
        if (envelope) out.push({ role: 'assistant', content: envelope });
        else if (!it.toolCalls.length && constrained) {
          // An earlier request's answer, read back from the transcript, is shown in the format too: prose in
          // the history leads a model to answer in prose once the server no longer enforces the schema.
          if (it.text.trim()) out.push({ role: 'assistant', content: JSON.stringify({ brief_status: 'Replying', action: { tool: FINISH_ACTION, args: { message: it.text } } }) });
        } else if (!it.toolCalls.length) out.push({ role: 'assistant', content: it.text });
        else if (constrained) {
          const c = it.toolCalls[0];
          out.push({ role: 'assistant', content: JSON.stringify({ brief_status: it.text, action: { tool: c.name, args: safeJson(replayableArgs(c.arguments)) } }) });
        } else
          out.push({
            role: 'assistant',
            content: it.text,
            tool_calls: it.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: replayableArgs(c.arguments) } }))
          });
      } else if (constrained) out.push({ role: 'user', content: `${it.isError ? 'Error from' : 'Result of'} ${it.name}:\n${it.content}` });
      else out.push({ role: 'tool', tool_call_id: it.callId, name: it.name, content: it.content });
    }
    return out;
  }

  private body(req: CanonicalModelRequest, constrained: boolean, corrections: ChatMessage[], replyCap = Infinity): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: alternate([{ role: 'system', content: constrained ? req.system + envelopeInstructions(req.tools) : req.system }, ...this.messages(req.items, constrained), ...corrections]),
      max_tokens: Math.min(req.maxOutputTokens, this.profile.maxOutput, replyCap),
      temperature: this.profile.temperature,
      stream: true
    };
    if (this.usageOption) body.stream_options = { include_usage: true };
    if (constrained) {
      if (this.responseFormat === 'json_schema') {
        const { inline, compact } = this.envelope(req.tools);
        body.response_format = { type: 'json_schema', json_schema: { name: 'agent_action', strict: true, schema: this.compactSchema && compact ? compact : inline } };
      }
      else if (this.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
    } else if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    return body;
  }

  /** The envelope schema for a tool set, and its compact form when that differs. */
  private envelope(tools: ToolDefinition[]): { inline: JsonSchema; compact: JsonSchema | null } {
    let entry = this.envelopes.get(tools);
    if (!entry) {
      const inline = envelopeSchema(tools);
      const compact = envelopeSchema(tools, { compact: true });
      entry = { inline, compact: JSON.stringify(compact) === JSON.stringify(inline) ? null : compact };
      this.envelopes.set(tools, entry);
    }
    return entry;
  }

  /**
   * Drop a request option the server refused by name. The reply is still checked when the grammar is gone. A compact
   * schema the server cannot read steps down to the same schema written out in full before the grammar is given up.
   */
  private fallBack(status: number, body: string, constrained: boolean, tools: ToolDefinition[]): boolean {
    if (status !== 400 && status !== 422) return false;
    const text = serverMessage(body);
    const param = serverParam(body);
    // A structured parameter is authoritative; otherwise the text must actually reject the option.
    const names = (option: string, rejected: RegExp) => (param ? param === option || param.startsWith(`${option}.`) || param.startsWith(`${option}[`) : rejected.test(text));
    if (this.usageOption && names('stream_options', /(?:unknown|unsupported|unrecognized|invalid|extra)[^.]*stream_options|stream_options[^.]*(?:not supported|unsupported|unknown|invalid|not permitted)/i)) {
      this.usageOption = false;
      return true;
    }
    if (!constrained || this.responseFormat === 'none') return false;
    if (retriesFullSchema(text, param) && this.dropCompact(tools)) return true;
    const schemaRefused = this.responseFormat === 'json_schema' && refusesSchema(text, param);
    if (schemaRefused || names('response_format', FORMAT_REFUSED)) {
      this.responseFormat = this.responseFormat === 'json_schema' ? 'json_object' : 'none';
      return true;
    }
    return false;
  }

  /** A schema refusal gets the schema written out in full before the grammar goes. False when that was already sent. */
  private dropCompact(tools: ToolDefinition[]): boolean {
    if (this.responseFormat !== 'json_schema' || !this.compactSchema || !this.envelope(tools).compact) return false;
    this.compactSchema = false;
    return true;
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal, note?: (n: AdapterNote) => void): AsyncIterable<ModelEvent> {
    /** The error a turn ends with. A failure of the setup rather than of this request is reported too. */
    const fail = (error: LocalError, retried = false) => {
      const event = this.errorEvent(error, retried);
      if (event.setup) this.opts.onCheck?.({ ok: false, stage: event.setup, message: event.message });
      return event;
    };
    if (!this.url.ok) {
      yield fail({ code: 'invalid_request', message: this.url.message, setup: 'server' });
      return;
    }
    // A key saved before cloud keys were refused is still never sent.
    const keyProblem = localKeyProblem(this.endpoint.apiKey) ?? (await localhostProblem(this.url.url, this.opts.lookup, signal));
    if (signal.aborted) {
      yield { type: 'error', ...CANCELLED };
      return;
    }
    if (keyProblem) {
      yield fail({ code: 'invalid_request', message: keyProblem, setup: 'server' });
      return;
    }
    // The code fixer sends no tools and expects a plain text answer.
    const constrained = this.mode === 'constrained-json' && req.tools.length > 0;
    const corrections: ChatMessage[] = [];
    let fallbacks = 0;
    let shownStatus = false;
    let replyCap = Infinity;
    for (;;) {
      const body = this.body(req, constrained, corrections, replyCap);
      const result: TurnResult = yield* this.readTurn(`${this.url.url}/chat/completions`, body, req.model, signal, constrained, !shownStatus);
      if (constrained) shownStatus = true;
      if (result.kind === 'done') {
        this.opts.onCheck?.({ ok: true });
        yield result.event;
        return;
      }
      if (result.kind === 'error') {
        // A server may only find out it cannot build the compact grammar once the stream has opened.
        if (!result.streamed && constrained && fallbacks < MAX_FALLBACKS && !signal.aborted && result.errorBody && refusesSchema(serverMessage(result.errorBody), serverParam(result.errorBody)) && this.dropCompact(req.tools)) {
          fallbacks++;
          note?.({ kind: 'resend', reason: 'schema refused', error: result.error });
          continue;
        }
        if (!result.streamed && replyCap === Infinity && !corrections.length && !signal.aborted) {
          const room = this.shorterReply(result.error, Number(body.max_tokens));
          if (room) {
            replyCap = room;
            note?.({ kind: 'resend', reason: 'shorter reply', maxTokens: room, error: result.error });
            continue;
          }
        }
        yield fail(result.error, corrections.length > 0);
        return;
      }
      if (result.kind === 'http') {
        if (fallbacks < MAX_FALLBACKS && this.fallBack(result.status, result.body, constrained, req.tools)) {
          fallbacks++;
          note?.({ kind: 'resend', reason: 'server fallback', status: result.status, message: serverMessage(result.body, this.endpoint.apiKey) });
          continue;
        }
        const error = httpError(result.status, result.body, req.model, result.retryAfterMs, this.endpoint.apiKey);
        // Once per turn, and only for the turn's own prompt: after a correction it is no longer the prompt measured.
        if (replyCap === Infinity && !corrections.length && !signal.aborted) {
          const room = this.shorterReply(error, Number(body.max_tokens));
          if (room) {
            replyCap = room;
            note?.({ kind: 'resend', reason: 'shorter reply', maxTokens: room, error });
            continue;
          }
        }
        yield fail({ ...error, setup: setupStage(result.status, error) }, corrections.length > 0);
        return;
      }
      // The reply could not be read as an action: ask again, without involving the tool loop.
      if (corrections.length >= MAX_CORRECTIONS * 2) {
        yield { type: 'error', code: 'invalid_request', message: `The local model did not return a usable action (${result.problem}). Try again, or choose another model.` };
        return;
      }
      corrections.push({ role: 'assistant', content: result.raw.slice(0, 2000) || '(empty reply)' }, { role: 'user', content: `Your last reply could not be used: ${result.problem}. ${constrained ? 'Reply with exactly one JSON object in the required format, and nothing else.' : 'Send your whole reply again, in the same format.'}` });
      if (note) {
        // The key in use never goes into a note, even from a server that echoes it.
        const key = this.endpoint.apiKey;
        const clean = (text: string) => (key ? text.split(key).join('…') : text);
        note({ kind: 'resend', reason: 'correction', problem: clean(result.problem), reply: clean(result.raw), corrections: corrections.slice(-2).map((c) => ({ ...c, content: clean(String(c.content)) })) });
      }
    }
  }

  /**
   * A server that counts the reply against the window (vLLM) takes the same prompt with a smaller reply. The size
   * comes from the server's own count of the prompt, within any size set in Settings. Zero when that cannot help,
   * such as a prompt that alone overflows the window.
   */
  private shorterReply(error: LocalError, sent: number): number {
    const promptTokens = error.context?.promptTokens;
    if (!promptTokens || !error.context?.windowTokens) return 0;
    this.learn(error.context);
    const room = this.window() - promptTokens;
    return room >= MIN_OUTPUT_TOKENS && room < sent ? room : 0;
  }

  /** Keeps what a context error says about the server for the rest of the run, and passes the numbers on. */
  private learn(context: NonNullable<LocalError['context']>): ContextOverflow {
    const { server, ...numbers } = context;
    if (numbers.windowTokens) this.reported = numbers.windowTokens;
    this.server ??= server;
    return numbers;
  }

  /** `retried`: the refused request carried a correction, so its prompt count is not the caller's request. */
  private errorEvent(error: LocalError, retried = false): Extract<ModelEvent, { type: 'error' }> {
    const { context, ...rest } = error;
    if (!context) return { type: 'error', ...rest };
    const { promptTokens, ...numbers } = this.learn(context);
    return { type: 'error', ...rest, context: retried ? { ...numbers, retried } : { ...numbers, ...(promptTokens ? { promptTokens } : {}) } };
  }

  /** An error sent inside the stream, classified the same way as the same failure in an HTTP status. */
  private streamError(error: unknown, model: string): LocalError {
    const body = JSON.stringify({ error });
    const status = (error as { code?: unknown } | null)?.code;
    if (typeof status === 'number' && status >= 400) {
      const refused = httpError(status, body, model, undefined, this.endpoint.apiKey);
      return { ...refused, setup: setupStage(status, refused) };
    }
    const message = serverMessage(body, this.endpoint.apiKey);
    if (CONTEXT_FULL.test(message)) return { code: 'invalid_request', message: contextMessage, context: contextOverflow(body) };
    // A refusal named in words ("model_not_found") is the setup's, as the same refusal by status would be.
    const named = error && typeof error === 'object' ? [(error as { code?: unknown }).code, (error as { type?: unknown }).type].find((v) => typeof v === 'string') : undefined;
    const setup = typeof named === 'string' && /not_?found|unsupported|unauthori[sz]ed|forbidden|permission/i.test(named) ? ('chat' as const) : undefined;
    return { code: 'unknown', message: `The local server reported an error${message ? `: ${message}` : '.'}`, ...(setup ? { setup } : {}) };
  }

  private async *readTurn(url: string, body: Record<string, unknown>, model: string, signal: AbortSignal, constrained: boolean, showStatus: boolean): AsyncGenerator<ModelEvent, TurnResult> {
    if (signal.aborted) return { kind: 'error', error: CANCELLED };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Raced against every wait, so a transport that ignores the signal cannot outlive a deadline.
    const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    aborted.catch(() => undefined);
    const firstMs = this.opts.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS;
    const idleMs = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    type Deadline = 'first' | 'idle' | 'grace' | 'body';
    let expired = null as Deadline | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, why: Deadline) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expired = why;
        ctl.abort();
      }, ms);
    };
    const contradiction: TurnResult = { kind: 'error', error: { code: 'unknown', message: 'The local server sent a contradictory end to its reply.' } };

    let raw = '';
    let finish: string | null = null;
    let corrupt = false;
    let usage: TokenUsage | undefined;
    let shown = '';
    let statusOpen = constrained && showStatus;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const think = new ThinkFilter();
    const calls = new ToolCallAssembler();

    arm(firstMs, 'first');
    try {
      const res = await Promise.race([this.fetchImpl(url, { method: 'POST', headers: headers(this.endpoint.apiKey, 'text/event-stream'), body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' }), aborted]);
      if (!res.ok) {
        const retryAfter = Number(res.headers.get('retry-after'));
        arm(Math.min(firstMs, ERROR_BODY_MS), 'body');
        let text = '';
        try {
          text = await Promise.race([res.text(), aborted]);
        } catch (e) {
          // A stalled error body still has a status worth reporting; a Stop does not.
          if (signal.aborted) throw e;
        }
        return { kind: 'http', status: res.status, body: text.slice(0, 4000), retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
      }
      if (!res.body) return { kind: 'error', error: { code: 'network', message: 'The local server sent an empty response.' } };
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      read: for (;;) {
        const { done: eof, value } = await Promise.race([reader.read(), aborted]);
        const payloads = eof ? [...parser.push(decoder.decode()), ...parser.flush()] : parser.push(decoder.decode(value, { stream: true }));
        for (const data of payloads) {
          if (data.trim() === '[DONE]') break read;
          const chunk = safeJson(data) as {
            error?: unknown;
            usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
            choices?: Array<{ finish_reason?: string | null; delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: CallFragment[] } }>;
          } | undefined;
          // A lost frame may have held part of a call, so the turn is asked for again rather than trusted.
          if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            corrupt = true;
            continue;
          }
          if (chunk.error) return { kind: 'error', error: this.streamError(chunk.error, model), streamed: !!raw, errorBody: JSON.stringify({ error: chunk.error }) };
          if (typeof chunk.usage?.prompt_tokens === 'number' && typeof chunk.usage?.completion_tokens === 'number') {
            // A server that reuses the prompt it kept from the last request (llama.cpp, vLLM) may say how much.
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
            usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}) };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const content = typeof delta.content === 'string' ? delta.content : '';
          const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          if (finish && (content || fragments.length || delta.reasoning_content || delta.reasoning)) return contradiction;
          // A role-only chunk, a keep-alive or an empty fragment says nothing about progress.
          const progress = content || delta.reasoning_content || delta.reasoning || fragments.some((f) => f?.id || f?.function?.name || f?.function?.arguments);
          if (!finish && progress) arm(idleMs, 'idle');
          if (content) {
            raw += content;
            if (!constrained) {
              const visible = think.push(content);
              if (visible) yield { type: 'text', delta: visible };
            } else if (statusOpen && raw.length < 2000) {
              const status = partialStatus(raw);
              if (status && status.text.length > shown.length) {
                yield { type: 'text', delta: status.text.slice(shown.length) };
                shown = status.text;
              }
              if (status?.complete) statusOpen = false;
            }
          }
          calls.push(fragments);
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (!FINISH_REASONS.has(choice.finish_reason)) return { kind: 'error', error: { code: 'unknown', message: `The local server ended the reply with "${String(choice.finish_reason).slice(0, 40)}".` } };
            if (finish && finish !== choice.finish_reason) return contradiction;
            if (!finish) {
              finish = choice.finish_reason;
              arm(FINISH_GRACE_MS, 'grace');
            }
          }
        }
        if (eof) break;
      }
    } catch (e) {
      if (signal.aborted) return { kind: 'error', error: CANCELLED };
      if (expired === 'first') return { kind: 'error', error: { code: 'unknown', message: `The local model did not start responding within ${Math.round(firstMs / 1000)} seconds. It may still be loading, or be too large for this computer.` } };
      if (expired === 'idle') return { kind: 'error', error: { code: 'unknown', message: `The local model stopped responding for ${Math.round(idleMs / 1000)} seconds in the middle of a reply.` } };
      if (expired !== 'grace') return { kind: 'error', error: connectionError(e, this.url.ok ? this.url.url : url) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Also ends generation on the server when the consumer stops reading early.
      ctl.abort();
      void reader?.cancel().catch(() => undefined);
    }

    if (signal.aborted) return { kind: 'error', error: CANCELLED };
    // Without a finish reason there is no evidence the reply, or any call in it, is complete.
    if (!finish) return { kind: 'error', error: { code: 'network', message: 'The local server closed the connection before the response finished.' } };
    const stop = (reason: StopReason, text: string, toolCalls: ToolCall[], providerData?: unknown): TurnResult => ({ kind: 'done', event: { type: 'done', stopReason: reason, text, toolCalls, ...(providerData ? { providerData } : {}), ...(usage ? { usage } : {}) } });
    // A cut-off reply may end inside a call, so none of it is executed: the orchestrator asks for smaller steps.
    if (finish === 'length') return stop('max_tokens', constrained ? '' : stripThinking(raw).trim(), []);
    if (finish === 'content_filter') return stop('refusal', '', []);
    if (corrupt) return { kind: 'unusable', problem: 'part of it was garbled', raw };

    if (constrained) {
      const parsed = parseEnvelope(raw);
      if (!parsed.ok) return { kind: 'unusable', problem: parsed.problem, raw };
      if (parsed.finish !== null) return stop('end', parsed.finish.trim(), [], { envelope: parsed.wire });
      return stop('tool_use', parsed.status, [{ id: newId('c', 8).replace('_', ''), name: parsed.tool, arguments: parsed.args }], { envelope: parsed.wire });
    }

    const toolCalls = calls.calls();
    if (!toolCalls) return { kind: 'unusable', problem: 'a tool call in it was incomplete or contradictory', raw };
    const text = stripThinking(raw).trim();
    if (toolCalls.length) return stop('tool_use', text, toolCalls);
    if (finish === 'tool_calls') return { kind: 'unusable', problem: 'it announced a tool call but sent none', raw };
    // An empty answer must not read as "finished, nothing to change".
    if (!text) return { kind: 'error', error: { code: 'unknown', message: 'The local model returned an empty response.' } };
    return stop('end', text, []);
  }
}

/** Models the server reports through `GET {baseURL}/models`. */
export async function listLocalModels(endpoint: Pick<LocalEndpoint, 'baseURL' | 'apiKey' | 'allowRemote'>, opts: Pick<LocalAdapterOptions, 'fetch' | 'lookup'> & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ ok: boolean; models: string[]; message?: string }> {
  const url = checkLocalBaseURL(endpoint.baseURL, endpoint.allowRemote);
  if (!url.ok) return { ok: false, models: [], message: url.message };
  const keyProblem = localKeyProblem(endpoint.apiKey) ?? (await localhostProblem(url.url, opts.lookup, opts.signal));
  if (keyProblem) return { ok: false, models: [], message: keyProblem };
  if (opts.signal?.aborted) return { ok: false, models: [], message: 'Canceled' };
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
    const res = await (opts.fetch ?? globalThis.fetch)(`${url.url}/models`, { headers: headers(endpoint.apiKey, 'application/json'), redirect: 'error', signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout });
    if (!res.ok) return { ok: false, models: [], message: httpError(res.status, await res.text().catch(() => ''), 'that model', undefined, endpoint.apiKey).message };
    const data = ((await res.json()) as { data?: Array<{ id?: unknown }> }).data;
    if (!Array.isArray(data)) return { ok: false, models: [], message: `The server at ${url.url} did not return a model list.` };
    return { ok: true, models: [...new Set(data.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && !!id))] };
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') return { ok: false, models: [], message: `The server at ${url.url} did not answer. Is your local server running?` };
    return { ok: false, models: [], message: connectionError(e, url.url).message };
  }
}

/**
 * The context size the server has `model` loaded with, from whichever report it offers: llama.cpp's `/props` and
 * `/models` metadata, LM Studio's `/api/v0/models`, Ollama's `/api/ps`, or vLLM's `max_model_len`. A training
 * context or a model's maximum is never taken for the loaded size. Every request goes to the saved server, with
 * one short deadline for all of them; a server that reports nothing yields an empty answer, never an error.
 */
export async function discoverLocalContext(endpoint: Pick<LocalEndpoint, 'baseURL' | 'apiKey' | 'allowRemote' | 'model'>, opts: Pick<LocalAdapterOptions, 'fetch' | 'lookup'> & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LocalContext> {
  const url = checkLocalBaseURL(endpoint.baseURL, endpoint.allowRemote);
  if (!url.ok || !endpoint.model || opts.signal?.aborted || localKeyProblem(endpoint.apiKey)) return {};
  // The servers' own routes sit beside the OpenAI-compatible ones, not under them.
  const root = url.url.replace(/\/v1$/, '');
  // One deadline for everything, the `localhost` check included.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? CONTEXT_DISCOVERY_MS);
  // A Stop, or permission for a remote server withdrawn, ends the probes at once.
  const stop = () => ctl.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const get = async (target: string): Promise<Record<string, any> | undefined> => {
    try {
      const res = await (opts.fetch ?? globalThis.fetch)(target, { headers: headers(endpoint.apiKey, 'application/json'), redirect: 'error', signal: ctl.signal });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const v: unknown = await res.json();
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    // The same check as every other request to the server: a `localhost` that is this computer.
    if ((await localhostProblem(url.url, opts.lookup, ctl.signal)) || ctl.signal.aborted) return {};
    const model = endpoint.model;
    let modelPath: string | null = null;
    try {
      modelPath = encodeURIComponent(model);
    } catch {
      /* an ID no URL can carry */
    }
    // Every probe settles by the deadline, even through a transport that ignores the abort.
    const late = new Promise<undefined>((resolve) => ctl.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    const probe = (target: string | null) => (target ? Promise.race([get(target), late]) : Promise.resolve(undefined));
    const [models, props, lmStudio, ollama] = await Promise.all([probe(`${url.url}/models`), probe(`${root}/props`), probe(modelPath && `${root}/api/v0/models/${modelPath}`), probe(`${root}/api/ps`)]);
    const listed: unknown[] | undefined = Array.isArray(models?.data) ? models.data : undefined;
    const entry = listed?.find((m): m is Record<string, any> => !!m && typeof m === 'object' && (m as { id?: unknown }).id === model);
    // `/props` describes the one model a llama-server runs, so it counts only when that model is the one chosen.
    const llama = listed?.length === 1 && entry ? count(props?.default_generation_settings?.n_ctx) : undefined;
    if (llama) return { windowTokens: llama, server: 'llama.cpp' };
    if (count(entry?.meta?.n_ctx)) return { windowTokens: entry!.meta.n_ctx, server: 'llama.cpp' };
    if (lmStudio?.id === model && count(lmStudio.loaded_context_length)) return { windowTokens: lmStudio.loaded_context_length, server: 'lm-studio' };
    const running = Array.isArray(ollama?.models) ? ollama.models.find((m: Record<string, unknown> | null) => m && (m.name === model || m.model === model)) : undefined;
    if (count(running?.context_length)) return { windowTokens: running.context_length, server: 'ollama' };
    if (count(entry?.max_model_len)) return { windowTokens: entry!.max_model_len, server: 'vllm' };
    return {};
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    ctl.abort();
  }
}

/**
 * The adapter for a run against the saved local server: the model the author chose, or the server's only model,
 * and the context size the server reports for it.
 */
export async function openLocalAdapter(
  endpoint: LocalEndpoint,
  opts: Pick<LocalAdapterOptions, 'fetch' | 'lookup' | 'onCheck'> & { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ adapter: LocalAdapter; model: string } | { error: string; setup?: true }> {
  const chosen = { ...endpoint };
  if (opts.signal?.aborted) return { error: 'Canceled' };
  // A server that runs a single model needs no choice in Settings.
  if (!chosen.model) {
    const found = await listLocalModels(chosen, opts);
    if (opts.signal?.aborted) return { error: 'Canceled' };
    // Nothing answered, or nothing is loaded: the setup's to fix, and what the request showed about it.
    const problem = listedProblem(found, '');
    if (problem) {
      opts.onCheck?.({ ok: false, stage: 'server', message: problem });
      return { error: problem, setup: true };
    }
    chosen.model = found.models[0];
  }
  // The loaded context size decides the tools and the reply budget, so it is read before the first request.
  const context = await discoverLocalContext(chosen, opts);
  return { adapter: new LocalAdapter(chosen, { fetch: opts.fetch, lookup: opts.lookup, context, onCheck: opts.onCheck }), model: chosen.model };
}

/** Why a server's model list rules out using `model` ('' for its first model), or null when it does not. */
export function listedProblem(r: { ok: boolean; models: string[]; message?: string }, model: string): string | null {
  if (!r.ok) return r.message ?? 'Could not reach the local server.';
  if (!r.models.length) return 'Connected, but the server has no models loaded.';
  if (model && !r.models.includes(model)) return `Connected, but the server does not list ${model}. Choose one of its models.`;
  return null;
}

/**
 * Check that the server answers, lists the model, and that the model answers a short chat request. Being listed is
 * not enough: a server can list a model it cannot chat with (an embedding model, or one it fails to load), so only
 * a reply passes. `stage` says which step failed: reaching the server and finding the model, or the chat request.
 * `model` is the one tested, the first listed when none is chosen. `signal` stops it, before anything more is sent.
 */
export async function testLocal(
  endpoint: LocalEndpoint,
  opts: Pick<LocalAdapterOptions, 'fetch' | 'lookup' | 'firstTokenTimeoutMs'> & { timeoutMs?: number; deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; message: string; stage?: 'server' | 'chat'; model?: string }> {
  const r = await listLocalModels(endpoint, opts);
  if (opts.signal?.aborted) return { ok: false, stage: 'server', message: TEST_STOPPED };
  const problem = listedProblem(r, endpoint.model);
  if (problem) return { ok: false, stage: 'server', message: problem };
  const model = endpoint.model || r.models[0];
  const deadlineMs = opts.deadlineMs ?? TEST_DEADLINE_MS;
  const ctl = new AbortController();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctl.abort();
  }, deadlineMs);
  const stop = () => ctl.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  let reply: Extract<ModelEvent, { type: 'done' }> | null = null;
  let failure = '';
  try {
    // Plain chat with no tools, the same request path a conversation takes, with a budget only for a word or two.
    const adapter = new LocalAdapter({ ...endpoint, model }, { fetch: opts.fetch, lookup: opts.lookup, firstTokenTimeoutMs: Math.min(opts.firstTokenTimeoutMs ?? TEST_FIRST_TOKEN_MS, deadlineMs) });
    for await (const ev of adapter.streamTurn({ model, system: 'This is a connection test.', items: [{ kind: 'user', text: 'Reply with OK.' }], tools: [], maxOutputTokens: 16 }, ctl.signal)) {
      if (ev.type === 'done') reply = ev;
      else if (ev.type === 'error') failure = ev.message;
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
  if (opts.signal?.aborted) return { ok: false, stage: 'server', model, message: TEST_STOPPED };
  const failed = (why: string) => ({ ok: false, stage: 'chat' as const, model, message: `The server lists ${model}, but a test chat request failed: ${why}` });
  if (late) return failed(`the model did not finish a short reply within ${Math.round(deadlineMs / 1000)} seconds.`);
  if (!reply) return failed(failure || 'the model did not answer.');
  if (reply.stopReason === 'refusal') return failed('the model declined it.');
  // A reply cut off at the small budget still came from the model: a reasoning model may spend all of it thinking.
  const replied = `Connected. ${model} ${reply.text.trim() ? 'answered' : 'started answering'} a test chat request`;
  const discovered = await discoverLocalContext({ ...endpoint, model }, { fetch: opts.fetch, lookup: opts.lookup, signal: opts.signal });
  if (opts.signal?.aborted) return { ok: false, stage: 'server', model, message: TEST_STOPPED };
  // The size a run will use: a size set in Settings below the loaded one holds the run to it.
  const set = localContextWindow(endpoint.contextWindow ?? null);
  const known = [set, discovered.windowTokens].filter((n): n is number => !!n);
  const windowTokens = known.length ? Math.min(...known) : undefined;
  if (!windowTokens) return { ok: true, model, message: `${replied}.` };
  const size = windowTokens.toLocaleString('en-US');
  const held = set === windowTokens && (!discovered.windowTokens || set < discovered.windowTokens);
  const short = windowTokens < WORKING_WINDOW_TOKENS ? ` The assistant works best with ${WORKING_WINDOW_TOKENS.toLocaleString('en-US')} tokens or more, so long requests may not fit.` : '';
  return { ok: true, model, message: `${replied}, ${held ? `held to the ${size}-token context set in Settings` : `loaded with a ${size}-token context`}.${short}` };
}
