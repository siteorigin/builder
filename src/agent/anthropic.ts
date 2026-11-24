import Anthropic from '@anthropic-ai/sdk';
import type { AdapterOptions, AgentModelAdapter, CanonicalModelRequest, ModelCapabilities, ModelEvent, ToolCall } from './types';
import { classifyHttpError, withoutEnv } from './types';
import { modelInfo } from './models';

/** The API's own address, always passed: the SDK would otherwise send the key wherever `ANTHROPIC_BASE_URL` points. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * A client configured only by the app, never by the environment. A key passed in code already keeps the SDK from
 * reading `ANTHROPIC_AUTH_TOKEN`; the address has to be passed too, and `ANTHROPIC_CUSTOM_HEADERS` (a gateway's
 * credentials, say, that would now go to Anthropic) kept out of sight while the client is built.
 */
function client(apiKey: string, timeout: number, opts: AdapterOptions): Anthropic {
  return withoutEnv(['ANTHROPIC_CUSTOM_HEADERS'], () => new Anthropic({ apiKey, authToken: null, baseURL: opts.baseURL ?? ANTHROPIC_API_URL, webhookKey: null, maxRetries: 0, timeout, ...(opts.fetch ? { fetch: opts.fetch } : {}) }));
}

/** Anthropic Messages API adapter with client-executed tools. */
export class AnthropicAdapter implements AgentModelAdapter {
  private client: Anthropic;
  /** Lowered when a custom model rejects the requested output budget. */
  private outputCap: number | null = null;
  constructor(apiKey: string, private model: string, opts: AdapterOptions = {}) {
    this.client = client(apiKey, 120_000, opts);
  }

  capabilities(): ModelCapabilities {
    const info = modelInfo('anthropic', this.model);
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: info.contextWindow, maxOutputTokens: this.outputCap ?? info.maxOutput };
  }

  private buildMessages(req: CanonicalModelRequest) {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (const it of req.items) {
      if (it.kind === 'user') {
        const last = messages[messages.length - 1];
        if (last?.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push({ type: 'text', text: it.text });
        else messages.push({ role: 'user', content: [{ type: 'text', text: it.text }] });
      } else if (it.kind === 'assistant') {
        const content = Array.isArray(it.providerData)
          ? it.providerData
          : [
              ...(it.text ? [{ type: 'text', text: it.text }] : []),
              ...it.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: safeParse(c.arguments) }))
            ];
        messages.push({ role: 'assistant', content });
      } else {
        const block = { type: 'tool_result', tool_use_id: it.callId, content: it.content, ...(it.isError ? { is_error: true } : {}) };
        const last = messages[messages.length - 1];
        if (last?.role === 'user' && Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')) (last.content as unknown[]).push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    return messages;
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    for (let attempt = 0; ; attempt++) {
      let text = '';
      let yielded = false;
      let settled = false;
      const queue: ModelEvent[] = [];
      const maxTokens = this.outputCap ? Math.min(this.outputCap, req.maxOutputTokens) : req.maxOutputTokens;
      let stream: ReturnType<Anthropic['messages']['stream']> | null = null;
      try {
        stream = this.client.messages.stream(
          {
            model: req.model,
            max_tokens: maxTokens,
            system: req.system,
            messages: this.buildMessages(req) as never,
            // Tool options are only sent with tools (the code fixer sends none).
            ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as never })) } : {})
          },
          { signal }
        );
        let resolveWait: (() => void) | null = null;
        let finished = false;
        stream.on('text', (delta: string) => {
          text += delta;
          queue.push({ type: 'text', delta });
          resolveWait?.();
        });
        const final = stream.finalMessage().finally(() => {
          finished = true;
          resolveWait?.();
        });
        // Observed here so a consumer that stops early never leaves an unhandled rejection behind.
        final.catch(() => undefined);
        while (!finished || queue.length) {
          if (queue.length) {
            yielded = true;
            yield queue.shift()!;
            continue;
          }
          await new Promise<void>((r) => (resolveWait = r));
          resolveWait = null;
        }
        const msg = await final;
        settled = true;
        const sr = msg.stop_reason as string;
        const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
        const blocks = msg.content as Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }>;
        // The finished message is the record; streamed deltas are only for live display.
        const finalText = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        if (finalText) text = finalText;
        if (sr === 'max_tokens') {
          // A cut-off turn may end inside a tool call whose input is incomplete. Nothing from it is
          // executed or replayed: the caller retries the turn and asks for smaller steps.
          yield { type: 'done', stopReason: 'max_tokens', text, toolCalls: [], usage };
          return;
        }
        const calls: ToolCall[] = [];
        for (const b of blocks) if (b.type === 'tool_use') calls.push({ id: b.id!, name: b.name!, arguments: JSON.stringify(b.input ?? {}) });
        for (const c of calls) yield { type: 'tool_call', call: c };
        yield {
          type: 'done',
          stopReason: sr === 'tool_use' ? 'tool_use' : sr === 'refusal' ? 'refusal' : sr === 'end_turn' || sr === 'stop_sequence' ? (calls.length ? 'tool_use' : 'end') : calls.length ? 'tool_use' : 'other',
          text,
          toolCalls: calls,
          providerData: msg.content,
          usage
        };
        return;
      } catch (e) {
        settled = true;
        if (signal.aborted) {
          yield { type: 'error', code: 'cancelled', message: 'Cancelled' };
          return;
        }
        // The SDK parses tool input as it streams; input it cannot parse means the turn was cut off.
        if (e instanceof SyntaxError) {
          yield { type: 'done', stopReason: 'max_tokens', text, toolCalls: [] };
          return;
        }
        const next = !yielded && attempt < 2 ? this.lowerBudget(e, maxTokens) : 0;
        if (next) {
          this.outputCap = next;
          continue;
        }
        yield { type: 'error', ...classifyHttpError(e) };
        return;
      } finally {
        // A consumer that stops early (Stop, or an error upstream) must not leave the request running.
        if (!settled) stream?.abort();
      }
    }
  }

  /** A smaller output budget when an HTTP 400 says the requested max_tokens is above the model's limit. */
  private lowerBudget(e: unknown, requested: number): number {
    const err = e as { status?: number; message?: string };
    const msg = String(err?.message ?? '');
    if (err?.status !== 400 || !/max_tokens/.test(msg) || !/maximum|> ?\d|exceeds|too (large|high)/i.test(msg)) return 0;
    const reported = [...msg.matchAll(/\d{3,6}/g)].map((m) => Number(m[0])).filter((n) => n >= 256 && n < requested);
    const next = reported.length ? Math.max(...reported) : requested > 8192 ? 8192 : requested > 4096 ? 4096 : 0;
    return next && next < requested ? next : 0;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export async function testAnthropic(apiKey: string, model: string, opts: AdapterOptions = {}): Promise<{ ok: boolean; message: string }> {
  try {
    const c = client(apiKey, 30_000, opts);
    await c.models.retrieve(model);
    return { ok: true, message: `Connected. ${model} is available.` };
  } catch (e) {
    const err = classifyHttpError(e);
    return { ok: false, message: err.code === 'invalid_request' ? `The model ${model} is not available to this key.` : err.message };
  }
}
