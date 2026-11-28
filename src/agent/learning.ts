/**
 * What learning mode (#1566, src/main/learning.ts) is told about a chat: one record per step, each filed under the
 * conversation it belongs to. The orchestrator and the code fixer only describe the steps; where and how they are kept
 * is the recorder's.
 */
import type { AdapterNote, AgentModelAdapter, CanonicalModelRequest, ModelEvent, ToolCall } from './types';
import type { ProviderId } from '@shared/api';

/** One step. `type` names it; the rest is the step's own data, kept whole. */
export type ChatRecord = { type: string } & Record<string, unknown>;

export interface ChatRecorder {
  /** Keep one step of a conversation. Never throws, and never makes the caller wait. */
  record(conversationId: string, record: ChatRecord): void;
}

/** Where one conversation's steps go. */
export type LearnSink = (record: ChatRecord) => void;

/**
 * Which model call a request is. `call`: `turn` for a run's own turns, `fixer` for the code fixer's. `requestIndex`:
 * the run's requests counted from 1, one for each sent. `step`: the run's turn it was asked for (a turn asked again after
 * the provider found it too long keeps its step); `attempt`: from 0, each retry of that request after a provider error.
 */
export interface CallContext {
  call: 'turn' | 'fixer';
  provider: ProviderId;
  requestIndex?: number;
  step?: number;
  attempt?: number;
}

/**
 * The adapter's stream (`open` starts it), unchanged, with the request recorded as it is sent (turned into its line at
 * once, so items added afterwards are not in it), each time the adapter sends it again changed (AdapterNote), and its
 * reply or error once it arrives. A stream that ends with neither (stopped, cut off at a time limit, or broken)
 * records what had arrived before it ended.
 */
export async function* recordedStream(learn: LearnSink, ctx: CallContext, request: CanonicalModelRequest, open: (note: (n: AdapterNote) => void) => AsyncIterable<ModelEvent>): AsyncIterable<ModelEvent> {
  learn({ type: 'request', ...ctx, model: request.model, request });
  const stream = open((n) => learn({ type: 'resend', ...ctx, ...n }));
  let answered = false;
  let text = '';
  const toolCalls: ToolCall[] = [];
  try {
    for await (const ev of stream) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'tool_call') toolCalls.push(ev.call);
      else {
        answered = true;
        // An error keeps whatever the model had sent before it.
        const partial = ev.type === 'error' && (text || toolCalls.length) ? { partial: { text, toolCalls } } : {};
        learn({ type: 'response', ...ctx, ...(ev.type === 'done' ? { reply: ev } : { error: ev }), ...partial });
      }
      yield ev;
    }
  } finally {
    if (!answered) learn({ type: 'response', ...ctx, ended: 'without an answer', partial: { text, toolCalls } });
  }
}

/** The adapter with every request it is asked for recorded as `recordedStream` records it. */
export function recordedAdapter(adapter: AgentModelAdapter, learn: LearnSink, ctx: CallContext): AgentModelAdapter {
  let attempt = 0;
  return {
    capabilities: () => adapter.capabilities(),
    streamTurn: (request, signal) => recordedStream(learn, { ...ctx, attempt: attempt++ }, request, (note) => adapter.streamTurn(request, signal, note)),
    ...(adapter.contextHelp ? { contextHelp: (tokens: number) => adapter.contextHelp!(tokens) } : {})
  };
}
