import Anthropic from '@anthropic-ai/sdk';
import type { AgentModelAdapter, CanonicalModelRequest, ModelCapabilities, ModelEvent, ToolCall } from './types';
import { classifyHttpError } from './types';
import { modelInfo } from './models';

/** Anthropic Messages API adapter with client-executed tools. */
export class AnthropicAdapter implements AgentModelAdapter {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 });
  }

  capabilities(): ModelCapabilities {
    const info = modelInfo('anthropic', this.model);
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: false, contextWindowTokens: info.contextWindow, maxOutputTokens: info.maxOutput };
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
    let text = '';
    const queue: ModelEvent[] = [];
    try {
      const stream = this.client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: this.buildMessages(req) as never,
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as never }))
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
      while (!finished || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((r) => (resolveWait = r));
        resolveWait = null;
      }
      const msg = await final;
      const calls: ToolCall[] = [];
      for (const b of msg.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
        if (b.type === 'tool_use') calls.push({ id: b.id!, name: b.name!, arguments: JSON.stringify(b.input ?? {}) });
      }
      for (const c of calls) yield { type: 'tool_call', call: c };
      const sr = msg.stop_reason as string;
      yield {
        type: 'done',
        stopReason: sr === 'tool_use' ? 'tool_use' : sr === 'max_tokens' ? 'max_tokens' : sr === 'refusal' ? 'refusal' : sr === 'end_turn' || sr === 'stop_sequence' ? 'end' : calls.length ? 'tool_use' : 'other',
        text,
        toolCalls: calls,
        providerData: msg.content,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
      };
    } catch (e) {
      yield { type: 'error', ...classifyHttpError(e) };
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export async function testAnthropic(apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const c = new Anthropic({ apiKey, maxRetries: 0, timeout: 30_000 });
    await c.models.retrieve(model);
    return { ok: true, message: `Connected. ${model} is available.` };
  } catch (e) {
    const err = classifyHttpError(e);
    return { ok: false, message: err.code === 'invalid_request' ? `The model ${model} is not available to this key.` : err.message };
  }
}
