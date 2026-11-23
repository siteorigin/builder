/** Provider-independent model contract. Adapters translate to and from provider protocols. */

export interface ModelCapabilities {
  toolCalling: 'native' | 'constrained-json';
  streaming: boolean;
  strictSchemas: boolean;
  parallelToolCalls: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as produced by the model. */
  arguments: string;
}

export type CanonicalItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; toolCalls: ToolCall[]; providerData?: unknown }
  | { kind: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface CanonicalModelRequest {
  model: string;
  system: string;
  items: CanonicalItem[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type ModelErrorCode = 'auth' | 'rate_limit' | 'overloaded' | 'network' | 'invalid_request' | 'cancelled' | 'unknown';

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: StopReason; text: string; toolCalls: ToolCall[]; providerData?: unknown; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: ModelErrorCode; message: string; retryAfterMs?: number };

export interface AgentModelAdapter {
  capabilities(): ModelCapabilities;
  streamTurn(request: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export function classifyHttpError(e: unknown): { code: ModelErrorCode; message: string; retryAfterMs?: number } {
  const err = e as { status?: number; message?: string; name?: string; headers?: Record<string, string> | Headers };
  if (err?.name === 'AbortError' || /aborted/i.test(String(err?.message))) return { code: 'cancelled', message: 'Cancelled' };
  const status = err?.status;
  const header = (k: string): string | undefined => {
    const h = err?.headers;
    if (!h) return undefined;
    if (typeof (h as Headers).get === 'function') return (h as Headers).get(k) ?? undefined;
    return (h as Record<string, string>)[k];
  };
  const retryAfter = Number(header('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const msg = String(err?.message ?? e).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…');
  if (status === 401 || status === 403) return { code: 'auth', message: 'The API key was rejected. Check it in Settings.' };
  if (status === 429) return { code: 'rate_limit', message: 'The provider is rate limiting requests.', retryAfterMs };
  if (status === 529 || (status && status >= 500)) return { code: 'overloaded', message: 'The provider is temporarily unavailable.', retryAfterMs };
  if (status === 400 || status === 404 || status === 422) return { code: 'invalid_request', message: msg };
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return { code: 'network', message: 'Could not reach the provider. Check your network connection.' };
  return { code: 'unknown', message: msg };
}
