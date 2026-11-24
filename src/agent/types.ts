/** Provider-independent model contract. Adapters translate to and from provider protocols. */

export interface ModelCapabilities {
  toolCalling: 'native' | 'constrained-json';
  streaming: boolean;
  strictSchemas: boolean;
  parallelToolCalls: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** The window was reported by the server or set by the author, rather than assumed from the model's profile. */
  contextWindowKnown?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * What a grammar-constrained local model reads beside the tool's signature, which already shows every field: the
   * description's rules in fewer words, or nothing when the name and signature say it all. Absent: the description.
   */
  brief?: string;
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

/** What a context error says about the loaded window and the request, in tokens, when it says anything. */
export interface ContextOverflow {
  windowTokens?: number;
  promptTokens?: number;
  /** The refused request carried the adapter's own correction, so it is not the request the caller sent. */
  retried?: boolean;
}

export type ModelErrorCode = 'auth' | 'rate_limit' | 'overloaded' | 'network' | 'invalid_request' | 'cancelled' | 'unknown';

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: StopReason; text: string; toolCalls: ToolCall[]; providerData?: unknown; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: ModelErrorCode; message: string; retryAfterMs?: number; context?: ContextOverflow };

export interface AgentModelAdapter {
  capabilities(): ModelCapabilities;
  streamTurn(request: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** How the author gives the model a context of at least `tokens` tokens, when the adapter knows its server. */
  contextHelp?(tokens: number): string;
}

/** Options shared by the provider adapters. Tests inject `fetch` to replay recorded wire traffic. */
export interface AdapterOptions {
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
}

const QUOTA = 'The provider account has no remaining credit or quota. Check billing for this API key.';
export const redact = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…');

/**
 * Build something with these environment variables out of sight, then put them back exactly as they were. The
 * provider SDKs read headers such as `ANTHROPIC_CUSTOM_HEADERS` only while a client is constructed, which is
 * synchronous, so nothing else can observe the gap.
 */
export function withoutEnv<T>(names: string[], make: () => T): T {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    return make();
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

/**
 * Classify a provider error code or type that arrived without an HTTP status, such as an SSE `error` or
 * `response.failed` event after a 200 response. Returns null when the code says nothing useful.
 */
export function classifyProviderCode(code: unknown, message?: string, retryAfterMs?: number): { code: ModelErrorCode; message: string; retryAfterMs?: number } | null {
  const c = String(code ?? '').toLowerCase();
  const msg = redact(String(message ?? ''));
  if (!c) return null;
  if (/insufficient_quota|billing/.test(c)) return { code: 'invalid_request', message: QUOTA };
  if (/rate_limit|too_many_requests/.test(c)) return { code: 'rate_limit', message: 'The provider is rate limiting requests.', retryAfterMs };
  if (/overloaded|server_error|internal_error|api_error|service_unavailable|timeout|unavailable/.test(c)) return { code: 'overloaded', message: 'The provider is temporarily unavailable.', retryAfterMs };
  if (/authentication|permission|invalid_api_key|unauthorized/.test(c)) return { code: 'auth', message: 'The API key was rejected. Check it in Settings.' };
  if (/invalid_request|invalid_prompt|not_found|context_length|bad_request|unsupported/.test(c)) return { code: 'invalid_request', message: msg || c };
  return null;
}

/** Every structured code or type on an SDK error, joined, so a generic value never masks a specific one. */
export function errorCodes(e: unknown): string {
  const err = e as { code?: unknown; type?: unknown; error?: { type?: unknown; code?: unknown; error?: { type?: unknown } } } | null;
  return [err?.code, err?.type, err?.error?.code, err?.error?.type, err?.error?.error?.type].filter((x) => typeof x === 'string' && x).join(' ');
}

/** A request the caller aborted, as opposed to a provider error whose text happens to mention aborting. */
export function isAbort(e: unknown): boolean {
  const err = e as { name?: string; message?: string; status?: number } | null;
  if (err?.status) return false;
  return err?.name === 'AbortError' || err?.name === 'APIUserAbortError' || /^(request was aborted|this operation was aborted|the operation was aborted)/i.test(String(err?.message ?? ''));
}

export function classifyHttpError(e: unknown): { code: ModelErrorCode; message: string; retryAfterMs?: number } {
  const err = e as { status?: number; message?: string; name?: string; headers?: Record<string, string> | Headers };
  if (isAbort(e)) return { code: 'cancelled', message: 'Cancelled' };
  const status = err?.status;
  const header = (k: string): string | undefined => {
    const h = err?.headers;
    if (!h) return undefined;
    if (typeof (h as Headers).get === 'function') return (h as Headers).get(k) ?? undefined;
    return (h as Record<string, string>)[k];
  };
  const retryAfter = Number(header('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const msg = redact(String(err?.message ?? e));
  if (status === 401 || status === 403) return { code: 'auth', message: 'The API key was rejected. Check it in Settings.' };
  const codes = errorCodes(e);
  if (status === 429 && /insufficient_quota/.test(`${codes} ${msg}`)) return { code: 'invalid_request', message: QUOTA };
  if (status === 429) return { code: 'rate_limit', message: 'The provider is rate limiting requests.', retryAfterMs };
  if (status === 529 || (status && status >= 500)) return { code: 'overloaded', message: 'The provider is temporarily unavailable.', retryAfterMs };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { code: 'invalid_request', message: msg };
  // Errors delivered inside a stream carry a code or type instead of a status.
  if (!status) {
    const byCode = classifyProviderCode(codes, msg, retryAfterMs);
    if (byCode) return byCode;
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|terminated|timed out/i.test(msg)) return { code: 'network', message: 'Could not reach the provider. Check your network connection.' };
  return { code: 'unknown', message: msg };
}
