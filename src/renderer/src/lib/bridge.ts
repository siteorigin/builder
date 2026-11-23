/** Typed messaging with the preview bridge running inside the site iframe. */
export const PROTOCOL = 1;

export interface BridgeMessage<T = Record<string, unknown>> {
  protocolVersion: number;
  sessionId: string;
  navigationId: string;
  revision: number;
  type: string;
  payload: T;
}

const MAX_MESSAGE_CHARS = 200_000;

export function newSessionId(): string {
  return 'so-' + crypto.getRandomValues(new Uint32Array(3)).join('-');
}

/** Validate sender window, origin, session and size. Returns the message or null. */
export function acceptMessage(e: MessageEvent, frame: HTMLIFrameElement | null, origin: string | null, sessionId: string): BridgeMessage | null {
  if (!frame || e.source !== frame.contentWindow) return null;
  if (!origin || e.origin !== origin) return null;
  const m = e.data as BridgeMessage;
  if (!m || typeof m !== 'object' || m.protocolVersion !== PROTOCOL || m.sessionId !== sessionId || typeof m.type !== 'string') return null;
  try {
    if (JSON.stringify(m).length > MAX_MESSAGE_CHARS) return null;
  } catch {
    return null;
  }
  return m;
}

export function postToFrame(frame: HTMLIFrameElement | null, origin: string | null, sessionId: string, type: string, payload: unknown = {}) {
  if (!frame?.contentWindow || !origin) return;
  frame.contentWindow.postMessage({ protocolVersion: PROTOCOL, sessionId, type, payload }, origin);
}
