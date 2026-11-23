import { newId } from '@shared/ids';
import { checkLocalBaseURL, type LocalToolMode, type LocalURLCheck } from '@shared/local';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelErrorCode, ModelEvent, StopReason, ToolCall } from './types';
import { redact } from './types';
import { envelopeInstructions, envelopeSchema, parseEnvelope, partialStatus, stripThinking } from './constrained';
import { localModelProfile, type LocalModelProfile } from './models';

/** A loaded model can take minutes to read a long prompt before its first token. */
export const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** Once tokens are flowing, a gap this long means the server has stalled. */
export const IDLE_TIMEOUT_MS = 30_000;
/** After the finish reason only a usage chunk can follow, and not every server closes the stream promptly. */
const FINISH_GRACE_MS = 2_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** How long a failed response gets to deliver its error text. */
const ERROR_BODY_MS = 5_000;
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const MAX_CORRECTIONS = 2;
const MAX_FALLBACKS = 3;

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
}

export interface LocalAdapterOptions {
  fetch?: typeof globalThis.fetch;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  profile?: LocalModelProfile;
}

type LocalError = { code: ModelErrorCode; message: string; retryAfterMs?: number };
type TurnResult =
  | { kind: 'done'; event: Extract<ModelEvent, { type: 'done' }> }
  | { kind: 'error'; error: LocalError }
  | { kind: 'http'; status: number; body: string; retryAfterMs?: number }
  | { kind: 'unusable'; problem: string; raw: string };
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string };

const CANCELLED: LocalError = { code: 'cancelled', message: 'Cancelled' };

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

const CONTEXT_FULL = /context (size|length|window)|exceeds? .*context|n_ctx|too many tokens|prompt is too long/i;
const contextMessage = 'The conversation is too long for this model\'s context window. Start a new conversation, or load the model with a larger context size.';

function httpError(status: number, body: string, model: string, retryAfterMs?: number, apiKey?: string | null): LocalError {
  const message = serverMessage(body, apiKey);
  if (status === 401 || status === 403) return { code: 'auth', message: 'The local server rejected the API key. Check it in Settings.' };
  if (CONTEXT_FULL.test(message)) return { code: 'invalid_request', message: contextMessage };
  if (status === 404) return { code: 'invalid_request', message: message ? `The local server could not use ${model}: ${message}` : `The local server has no model called ${model}.` };
  if (status === 429) return { code: 'rate_limit', message: 'The local server is busy.', retryAfterMs };
  // llama-server answers 503 while the model is still loading.
  if (status >= 500) return { code: 'overloaded', message: /loading/i.test(message) ? 'The local model is still loading.' : `The local server reported an error${message ? `: ${message}` : '.'}`, retryAfterMs };
  return { code: 'invalid_request', message: message || `The local server answered with status ${status}.` };
}

/** Errors with no HTTP response. A server that is not running will not start during a retry, so that fails at once. */
function connectionError(e: unknown, url: string): LocalError {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const text = `${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''} ${err?.message ?? ''}`;
  if (/redirect/i.test(text)) return { code: 'invalid_request', message: `The server at ${url} tried to redirect the request, so nothing was sent on.` };
  // A connection that was made and then lost can come back, unlike a server that is not there.
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(err?.cause?.code ?? '')) return { code: 'network', message: 'The local server closed the connection before the response finished.' };
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EADDRNOTAVAIL|ENETUNREACH|fetch failed/i.test(text)) return { code: 'unknown', message: `Could not connect to a model server at ${url}. Is your local server running?` };
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

/** Strict templates reject two user messages in a row. */
function mergeUsers(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === 'user' && last?.role === 'user') last.content += `\n\n${m.content}`;
    else out.push({ ...m });
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
  private usageOption = true;
  private fetchImpl: typeof globalThis.fetch;

  constructor(private endpoint: LocalEndpoint, private opts: LocalAdapterOptions = {}) {
    this.url = checkLocalBaseURL(endpoint.baseURL, endpoint.allowRemote);
    this.profile = opts.profile ?? localModelProfile(endpoint.model);
    this.mode = endpoint.toolMode === 'native' || endpoint.toolMode === 'constrained-json' ? endpoint.toolMode : this.profile.toolCalling;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  capabilities(): ModelCapabilities {
    return {
      toolCalling: this.mode,
      streaming: true,
      strictSchemas: this.mode === 'constrained-json',
      parallelToolCalls: this.mode === 'native',
      contextWindowTokens: this.profile.contextWindow,
      maxOutputTokens: this.profile.maxOutput
    };
  }

  private messages(items: CanonicalItem[], constrained: boolean): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const it of items) {
      if (it.kind === 'user') out.push({ role: 'user', content: it.text });
      else if (it.kind === 'assistant') {
        // A finish is replayed as an envelope too, so a repair turn still shows the format the model must use.
        const envelope = constrained ? (it.providerData as { envelope?: string } | undefined)?.envelope : undefined;
        if (envelope) out.push({ role: 'assistant', content: envelope });
        else if (!it.toolCalls.length) out.push({ role: 'assistant', content: it.text });
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
    return mergeUsers(out);
  }

  private body(req: CanonicalModelRequest, constrained: boolean, corrections: ChatMessage[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: mergeUsers([{ role: 'system', content: constrained ? req.system + envelopeInstructions(req.tools) : req.system }, ...this.messages(req.items, constrained), ...corrections]),
      max_tokens: Math.min(req.maxOutputTokens, this.profile.maxOutput),
      temperature: this.profile.temperature,
      stream: true
    };
    if (this.usageOption) body.stream_options = { include_usage: true };
    if (constrained) {
      if (this.responseFormat === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'agent_action', strict: true, schema: envelopeSchema(req.tools) } };
      else if (this.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
    } else if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    return body;
  }

  /** Drop a request option the server refused by name. The reply is still checked when the grammar is gone. */
  private fallBack(status: number, body: string, constrained: boolean): boolean {
    if (status !== 400 && status !== 422) return false;
    const text = serverMessage(body);
    const param = serverParam(body);
    // A structured parameter is authoritative; otherwise the text must actually reject the option.
    const names = (option: string, rejected: RegExp) => (param ? param === option || param.startsWith(`${option}.`) || param.startsWith(`${option}[`) : rejected.test(text));
    if (this.usageOption && names('stream_options', /(?:unknown|unsupported|unrecognized|invalid|extra)[^.]*stream_options|stream_options[^.]*(?:not supported|unsupported|unknown|invalid|not permitted)/i)) {
      this.usageOption = false;
      return true;
    }
    if (constrained && this.responseFormat !== 'none' && names('response_format', /(?:unknown|unsupported|unrecognized|invalid|extra)[^.]*(?:response_format|json_schema)|(?:response_format|json_schema)[^.]*(?:not supported|unsupported|unknown|invalid|not permitted|failed)|failed to (?:parse|compile)[^.]*grammar|grammar[^.]*(?:parse|compile)|(?:invalid|unsupported) grammar/i)) {
      this.responseFormat = this.responseFormat === 'json_schema' ? 'json_object' : 'none';
      return true;
    }
    return false;
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (!this.url.ok) {
      yield { type: 'error', code: 'invalid_request', message: this.url.message };
      return;
    }
    // The code fixer sends no tools and expects a plain text answer.
    const constrained = this.mode === 'constrained-json' && req.tools.length > 0;
    const corrections: ChatMessage[] = [];
    let fallbacks = 0;
    let shownStatus = false;
    for (;;) {
      const body = this.body(req, constrained, corrections);
      const result: TurnResult = yield* this.readTurn(`${this.url.url}/chat/completions`, body, req.model, signal, constrained, !shownStatus);
      if (constrained) shownStatus = true;
      if (result.kind === 'done') {
        yield result.event;
        return;
      }
      if (result.kind === 'error') {
        yield { type: 'error', ...result.error };
        return;
      }
      if (result.kind === 'http') {
        if (fallbacks < MAX_FALLBACKS && this.fallBack(result.status, result.body, constrained)) {
          fallbacks++;
          continue;
        }
        yield { type: 'error', ...httpError(result.status, result.body, req.model, result.retryAfterMs, this.endpoint.apiKey) };
        return;
      }
      // The reply could not be read as an action: ask again, without involving the tool loop.
      if (corrections.length >= MAX_CORRECTIONS * 2) {
        yield { type: 'error', code: 'invalid_request', message: `The local model did not return a usable action (${result.problem}). Try again, or choose another model.` };
        return;
      }
      corrections.push({ role: 'assistant', content: result.raw.slice(0, 2000) || '(empty reply)' }, { role: 'user', content: `Your last reply could not be used: ${result.problem}. ${constrained ? 'Reply with exactly one JSON object in the required format, and nothing else.' : 'Send your whole reply again, in the same format.'}` });
    }
  }

  /** An error sent inside the stream, classified the same way as the same failure in an HTTP status. */
  private streamError(error: unknown, model: string): LocalError {
    const body = JSON.stringify({ error });
    const status = (error as { code?: unknown } | null)?.code;
    if (typeof status === 'number' && status >= 400) return httpError(status, body, model, undefined, this.endpoint.apiKey);
    const message = serverMessage(body, this.endpoint.apiKey);
    return CONTEXT_FULL.test(message) ? { code: 'invalid_request', message: contextMessage } : { code: 'unknown', message: `The local server reported an error: ${message}` };
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
    let usage: { inputTokens: number; outputTokens: number } | undefined;
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
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
            choices?: Array<{ finish_reason?: string | null; delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: CallFragment[] } }>;
          } | undefined;
          // A lost frame may have held part of a call, so the turn is asked for again rather than trusted.
          if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            corrupt = true;
            continue;
          }
          if (chunk.error) return { kind: 'error', error: this.streamError(chunk.error, model) };
          if (typeof chunk.usage?.prompt_tokens === 'number' && typeof chunk.usage?.completion_tokens === 'number') usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
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
export async function listLocalModels(endpoint: Pick<LocalEndpoint, 'baseURL' | 'apiKey' | 'allowRemote'>, opts: Pick<LocalAdapterOptions, 'fetch'> & { timeoutMs?: number } = {}): Promise<{ ok: boolean; models: string[]; message?: string }> {
  const url = checkLocalBaseURL(endpoint.baseURL, endpoint.allowRemote);
  if (!url.ok) return { ok: false, models: [], message: url.message };
  try {
    const res = await (opts.fetch ?? globalThis.fetch)(`${url.url}/models`, { headers: headers(endpoint.apiKey, 'application/json'), redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, models: [], message: httpError(res.status, await res.text().catch(() => ''), 'that model', undefined, endpoint.apiKey).message };
    const data = ((await res.json()) as { data?: Array<{ id?: unknown }> }).data;
    if (!Array.isArray(data)) return { ok: false, models: [], message: `The server at ${url.url} did not return a model list.` };
    return { ok: true, models: [...new Set(data.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && !!id))] };
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') return { ok: false, models: [], message: `The server at ${url.url} did not answer. Is your local server running?` };
    return { ok: false, models: [], message: connectionError(e, url.url).message };
  }
}

/** Check that the server answers and offers the model. Nothing is generated, so this is quick. */
export async function testLocal(endpoint: LocalEndpoint, opts: Pick<LocalAdapterOptions, 'fetch'> & { timeoutMs?: number } = {}): Promise<{ ok: boolean; message: string }> {
  const r = await listLocalModels(endpoint, opts);
  if (!r.ok) return { ok: false, message: r.message ?? 'Could not reach the local server.' };
  if (!r.models.length) return { ok: false, message: 'Connected, but the server has no models loaded.' };
  if (endpoint.model && !r.models.includes(endpoint.model)) return { ok: false, message: `Connected, but the server does not list ${endpoint.model}. Choose one of its models.` };
  return { ok: true, message: `Connected. ${endpoint.model || r.models[0]} is available.` };
}
