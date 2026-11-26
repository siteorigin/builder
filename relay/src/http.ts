/**
 * The headers the Worker uses to tell a SessionRoom what it has already checked about a request. The Worker builds
 * every request it sends a room from scratch, so nothing a client sends ever arrives under these names.
 */
export const INTERNAL_HEADERS = {
  room: 'x-relay-room',
  method: 'x-relay-method',
  target: 'x-relay-target',
  secure: 'x-relay-secure'
} as const;

/** A request from the Worker to a room's object, at one of the object's own paths. */
export function roomRequest(path: '/create' | '/connect' | '/admission' | '/preview', roomId: string | null, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal | null } = {}): Request {
  return new Request(`https://session-room${path}`, {
    method: init.method ?? 'GET',
    // The room's own routes carry the room ID; preview requests come by the preview host alone, which named the object.
    headers: { ...init.headers, ...(roomId ? { [INTERNAL_HEADERS.room]: roomId } : {}) },
    body: init.body,
    signal: init.signal ?? undefined,
    // A preview redirect is the guest's browser's to follow, never the Worker's.
    redirect: 'manual'
  });
}

/** A short plain-text answer that no cache keeps. */
export function textResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

/** The request body as text, or null when it is longer than `max` bytes; reading stops as soon as it is. */
export async function readBoundedText(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
