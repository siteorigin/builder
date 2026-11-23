import OpenAI from 'openai';
import type { AgentModelAdapter, CanonicalModelRequest, ModelCapabilities, ModelEvent, ToolCall } from './types';
import { classifyHttpError } from './types';
import { modelInfo } from './models';

/** OpenAI Responses API adapter. Stateless (store: false); reasoning items are carried forward encrypted. */
export class OpenAIAdapter implements AgentModelAdapter {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 });
  }

  capabilities(): ModelCapabilities {
    const info = modelInfo('openai', this.model);
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: false, contextWindowTokens: info.contextWindow, maxOutputTokens: info.maxOutput };
  }

  private buildInput(req: CanonicalModelRequest): unknown[] {
    const input: unknown[] = [];
    for (const it of req.items) {
      if (it.kind === 'user') input.push({ role: 'user', content: it.text });
      else if (it.kind === 'assistant') {
        if (Array.isArray(it.providerData)) input.push(...(it.providerData as unknown[]));
        else {
          if (it.text) input.push({ role: 'assistant', content: it.text });
          for (const c of it.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
        }
      } else input.push({ type: 'function_call_output', call_id: it.callId, output: it.content });
    }
    return input;
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let stream;
    try {
      stream = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.system,
          input: this.buildInput(req) as never,
          tools: req.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })),
          parallel_tool_calls: false,
          max_output_tokens: req.maxOutputTokens,
          store: false,
          include: ['reasoning.encrypted_content'],
          stream: true
        },
        { signal }
      );
    } catch (e) {
      yield { type: 'error', ...classifyHttpError(e) };
      return;
    }
    let text = '';
    try {
      for await (const ev of stream as AsyncIterable<{ type: string; delta?: string; response?: Record<string, unknown>; message?: string; code?: string }>) {
        if (signal.aborted) {
          yield { type: 'error', code: 'cancelled', message: 'Cancelled' };
          return;
        }
        if (ev.type === 'response.output_text.delta' && ev.delta) {
          text += ev.delta;
          yield { type: 'text', delta: ev.delta };
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          const resp = ev.response as { output: Array<Record<string, unknown>>; usage?: { input_tokens: number; output_tokens: number }; incomplete_details?: { reason?: string } };
          const calls: ToolCall[] = [];
          let refusal = false;
          for (const item of resp.output ?? []) {
            if (item.type === 'function_call') calls.push({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? '{}') });
            if (item.type === 'message') for (const c of (item.content as Array<{ type: string }>) ?? []) if (c.type === 'refusal') refusal = true;
          }
          for (const c of calls) yield { type: 'tool_call', call: c };
          const incomplete = ev.type === 'response.incomplete';
          yield {
            type: 'done',
            stopReason: refusal ? 'refusal' : incomplete ? (resp.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other') : calls.length ? 'tool_use' : 'end',
            text,
            toolCalls: calls,
            providerData: resp.output,
            usage: resp.usage ? { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens } : undefined
          };
          return;
        } else if (ev.type === 'response.failed' || ev.type === 'error') {
          const err = (ev.response as { error?: { message?: string } } | undefined)?.error;
          yield { type: 'error', code: 'unknown', message: err?.message ?? ev.message ?? 'The provider reported an error.' };
          return;
        }
      }
      yield { type: 'error', code: 'network', message: 'The response ended unexpectedly.' };
    } catch (e) {
      yield { type: 'error', ...classifyHttpError(e) };
    }
  }
}

export async function testOpenAI(apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const c = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    await c.models.retrieve(model);
    return { ok: true, message: `Connected. ${model} is available.` };
  } catch (e) {
    const err = classifyHttpError(e);
    return { ok: false, message: err.code === 'invalid_request' ? `The model ${model} is not available to this key.` : err.message };
  }
}
