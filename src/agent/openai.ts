import OpenAI from 'openai';
import type { AdapterOptions, AgentModelAdapter, CanonicalModelRequest, ModelCapabilities, ModelEvent, StopReason, ToolCall } from './types';
import { classifyHttpError, classifyProviderCode, errorCodes, withoutEnv } from './types';
import { modelInfo } from './models';

/** Smallest output budget the Responses API accepts; used by the connection ping. */
const PING_TOKENS = 16;
/** The API's own address, always passed: the SDK would otherwise send the key wherever `OPENAI_BASE_URL` points. */
export const OPENAI_API_URL = 'https://api.openai.com/v1';

/**
 * A client configured only by the app, never by the environment: the SDK reads `OPENAI_BASE_URL`, `OPENAI_ORG_ID`
 * and `OPENAI_PROJECT_ID` for anything not given, and adds `OPENAI_CUSTOM_HEADERS` (a gateway's credentials, say,
 * that would now go to OpenAI) to every request.
 */
function client(apiKey: string, timeout: number, opts: AdapterOptions): OpenAI {
  return withoutEnv(['OPENAI_CUSTOM_HEADERS'], () => new OpenAI({ apiKey, baseURL: opts.baseURL ?? OPENAI_API_URL, organization: null, project: null, adminAPIKey: null, webhookSecret: null, maxRetries: 0, timeout, ...(opts.fetch ? { fetch: opts.fetch } : {}) }));
}

/**
 * OpenAI Responses API adapter. Stateless (store: false); reasoning items are carried forward encrypted.
 *
 * Some request features are not accepted by every model a user can type in as a custom ID (encrypted
 * reasoning, parallel tool calls, a large output budget). When the API rejects one of them before the
 * stream starts, the adapter drops that feature for the rest of its life and sends the request again.
 */
export class OpenAIAdapter implements AgentModelAdapter {
  private client: OpenAI;
  private encryptedReasoning = true;
  private parallelCalls = true;
  private outputCap: number | null = null;

  constructor(apiKey: string, private model: string, opts: AdapterOptions = {}) {
    this.client = client(apiKey, 120_000, opts);
  }

  capabilities(): ModelCapabilities {
    const info = modelInfo('openai', this.model);
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: this.parallelCalls, contextWindowTokens: info.contextWindow, maxOutputTokens: this.outputCap ?? info.maxOutput };
  }

  private buildInput(req: CanonicalModelRequest): unknown[] {
    const input: unknown[] = [];
    for (const it of req.items) {
      if (it.kind === 'user') input.push({ role: 'user', content: it.text });
      else if (it.kind === 'assistant') {
        if (Array.isArray(it.providerData)) {
          // Without encrypted content a reasoning item cannot be replayed statelessly, so it is left out.
          for (const item of it.providerData as Array<{ type?: string; encrypted_content?: unknown }>) if (item?.type !== 'reasoning' || (this.encryptedReasoning && item.encrypted_content)) input.push(item);
        } else {
          if (it.text) input.push({ role: 'assistant', content: it.text });
          for (const c of it.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
        }
      } else input.push({ type: 'function_call_output', call_id: it.callId, output: it.content });
    }
    return input;
  }

  private params(req: CanonicalModelRequest): Record<string, unknown> {
    const p: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: this.buildInput(req),
      max_output_tokens: this.outputCap ? Math.min(this.outputCap, req.maxOutputTokens) : req.maxOutputTokens,
      store: false,
      stream: true
    };
    // The API rejects tool options without tools (the code fixer sends none).
    if (req.tools.length) {
      p.tools = req.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      // A model that rejects the option gets none at all (and so its own default).
      if (this.parallelCalls) p.parallel_tool_calls = true;
    }
    if (this.encryptedReasoning) p.include = ['reasoning.encrypted_content'];
    return p;
  }

  /**
   * Turn off a feature the model rejected. Only an HTTP 400 that names the feature (by the SDK's `param`,
   * or explicitly in its message) counts; anything else is a real error. Returns false when there is
   * nothing to fall back from.
   */
  private fallBack(e: unknown, requested: number): boolean {
    const err = e as { status?: number; param?: unknown; message?: string };
    if (err?.status !== 400) return false;
    const param = typeof err.param === 'string' ? err.param : '';
    const msg = String(err.message ?? '');
    if (this.encryptedReasoning && (param.startsWith('include') || /reasoning\.encrypted_content|encrypted.content/i.test(msg))) {
      this.encryptedReasoning = false;
      return true;
    }
    if (this.parallelCalls && (param === 'parallel_tool_calls' || /parallel_tool_calls/.test(msg))) {
      this.parallelCalls = false;
      return true;
    }
    if ((param === 'max_output_tokens' || /max_output_tokens/.test(msg)) && !/context.length|context window/i.test(msg)) {
      // Use the ceiling the API reports when it gives one; otherwise step down.
      const reported = [...msg.matchAll(/\d{3,6}/g)].map((m) => Number(m[0])).filter((n) => n >= 256 && n < requested);
      const next = reported.length ? Math.max(...reported) : requested > 16000 ? 16000 : requested > 4096 ? 4096 : 0;
      if (!next || next >= requested) return false;
      this.outputCap = next;
      return true;
    }
    return false;
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let stream: AsyncIterable<unknown> | undefined;
    for (let attempt = 0; !stream; attempt++) {
      const params = this.params(req);
      try {
        stream = (await this.client.responses.create(params as never, { signal })) as unknown as AsyncIterable<unknown>;
      } catch (e) {
        if (!signal.aborted && attempt < 5 && this.fallBack(e, Number(params.max_output_tokens))) continue;
        yield signal.aborted ? { type: 'error', code: 'cancelled', message: 'Canceled' } : { type: 'error', ...classifyHttpError(e) };
        return;
      }
    }
    let text = '';
    try {
      for await (const ev of stream as AsyncIterable<{ type: string; delta?: string; response?: Record<string, unknown>; message?: string; code?: string }>) {
        if (signal.aborted) {
          yield { type: 'error', code: 'cancelled', message: 'Canceled' };
          return;
        }
        if (ev.type === 'response.output_text.delta' && ev.delta) {
          text += ev.delta;
          yield { type: 'text', delta: ev.delta };
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          const resp = ev.response as { output: Array<Record<string, unknown>>; usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } }; incomplete_details?: { reason?: string } };
          // OpenAI caches a repeated prompt prefix by itself; `input_tokens` counts what it read from the cache too.
          const cached = resp.usage?.input_tokens_details?.cached_tokens;
          const usage = resp.usage ? { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens, ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}) } : undefined;
          let refusal = false;
          let finalText = '';
          for (const item of resp.output ?? [])
            if (item.type === 'message')
              for (const c of (item.content as Array<{ type: string; text?: string }>) ?? []) {
                if (c.type === 'refusal') refusal = true;
                if (c.type === 'output_text' && c.text) finalText += c.text;
              }
          // The finished response is the record; streamed deltas are only for live display.
          if (finalText) text = finalText;
          if (ev.type === 'response.incomplete') {
            // A cut-off response may end in a half-written function call. Nothing from it is executed or
            // replayed: the caller retries the turn and asks for smaller steps.
            const reason = resp.incomplete_details?.reason;
            const stopReason: StopReason = refusal || reason === 'content_filter' ? 'refusal' : reason === 'max_output_tokens' ? 'max_tokens' : 'other';
            yield { type: 'done', stopReason, text, toolCalls: [], usage };
            return;
          }
          const calls: ToolCall[] = [];
          for (const item of resp.output ?? []) {
            if (item.type === 'function_call' && item.status !== 'incomplete') calls.push({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? '{}') });
          }
          for (const c of calls) yield { type: 'tool_call', call: c };
          yield { type: 'done', stopReason: refusal ? 'refusal' : calls.length ? 'tool_use' : 'end', text, toolCalls: calls, providerData: resp.output, usage };
          return;
        } else if (ev.type === 'response.failed' || ev.type === 'error') {
          const err = (ev.response as { error?: unknown } | undefined)?.error ?? ev;
          const message = (err as { message?: string })?.message ?? 'The provider reported an error.';
          yield { type: 'error', ...(classifyProviderCode(errorCodes(err), message) ?? { code: 'unknown' as const, message }) };
          return;
        }
      }
      yield signal.aborted ? { type: 'error', code: 'cancelled', message: 'Canceled' } : { type: 'error', code: 'network', message: 'The response ended unexpectedly.' };
    } catch (e) {
      yield signal.aborted ? { type: 'error', code: 'cancelled', message: 'Canceled' } : { type: 'error', ...classifyHttpError(e) };
    }
  }
}

/**
 * Check a key and model. Project keys restricted to the Responses API cannot read model metadata (403),
 * so a refused lookup falls back to the smallest possible request, which is what the assistant needs.
 */
export async function testOpenAI(apiKey: string, model: string, opts: AdapterOptions = {}): Promise<{ ok: boolean; message: string }> {
  const c = client(apiKey, 30_000, opts);
  try {
    await c.models.retrieve(model);
    return { ok: true, message: `Connected. ${model} is available.` };
  } catch (e) {
    if ((e as { status?: number }).status === 403) {
      try {
        const r = await c.responses.create({ model, input: 'Reply with OK.', max_output_tokens: PING_TOKENS, store: false });
        // A tiny budget usually ends "incomplete", which still proves the key can use the model.
        if (r.status === 'completed' || r.status === 'incomplete') return { ok: true, message: `Connected. ${model} responded.` };
        return { ok: false, message: r.error?.message ? `${model}: ${r.error.message}` : `${model} did not respond.` };
      } catch (e2) {
        return failure(e2, model);
      }
    }
    return failure(e, model);
  }
}

function failure(e: unknown, model: string): { ok: false; message: string } {
  const err = classifyHttpError(e);
  return { ok: false, message: err.code === 'invalid_request' && (e as { status?: number }).status === 404 ? `The model ${model} is not available to this key.` : err.code === 'invalid_request' ? `${model}: ${err.message}` : err.message };
}
