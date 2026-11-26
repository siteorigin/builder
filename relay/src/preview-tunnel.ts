import { fromBase64Url } from '../../src/shared/live/crypto';
import type { Frame } from '../../src/shared/live/messages';
import { PREVIEW_CACHE_CONTROL, PreviewStream, isPreviewLocation, type PreviewAbortCode, type PreviewMethod } from '../../src/shared/live/preview';
import { textResponse } from './http';
import { randomToken } from './tokens';

/**
 * Carries guests' preview requests to the host's socket and the host's answers back as streamed HTTP responses. It
 * lives only in the room object's memory: an open request keeps the object awake, so nothing here needs to survive
 * hibernation. The protocol has no flow control, so the host sends a response as fast as its preview server makes it;
 * what the guest has not read yet is held here, within a budget per response and per room, and a response that
 * overruns it is stopped rather than allowed to fill the object's memory. A request holds its guest's slot, and its
 * share of the budget, until its body has been read to the end or the request has failed.
 */

const MiB = 1024 * 1024;
/** What one response may hold unread: body bytes received from the host and not yet read by the guest. */
export const MAX_UNREAD_BYTES_PER_RESPONSE = 4 * MiB;
/** What all of a room's responses may hold unread at once. */
export const MAX_UNREAD_BYTES_PER_ROOM = 16 * MiB;
/**
 * Every held chunk also counts this much against the budgets, for the memory a chunk costs beyond its bytes, so a host
 * sending many tiny chunks reaches the budget long before it can fill the object with them.
 */
export const HELD_CHUNK_OVERHEAD_BYTES = 512;

type HostPreviewFrame = Frame<'host-to-relay', 'preview:response-head' | 'preview:response-chunk' | 'preview:response-end' | 'preview:abort'>;
type ToHost = Frame<'relay-to-host', 'preview:request' | 'preview:abort'>;

export interface TunnelOptions {
  /** Send a frame to the host on this connection; false when that connection is gone. */
  sendToHost(hostConnectionId: string, frame: ToHost): boolean;
  headTimeoutMs: number;
  /** How long the host may go without a frame, and, once it has sent the end, how long the guest may go without reading. */
  idleTimeoutMs: number;
}

export interface PreviewOpen {
  roomId: string;
  guestId: string;
  hostConnectionId: string;
  method: PreviewMethod;
  target: string;
  headers: Array<[string, string]>;
  /** Aborted when the guest's browser goes away. */
  signal: AbortSignal | null;
}

interface Pending {
  requestId: string;
  roomId: string;
  guestId: string;
  hostConnectionId: string;
  method: PreviewMethod;
  stream: PreviewStream;
  /** Answers the guest's request; null once it has been answered. */
  respond: ((response: Response) => void) | null;
  /** The body's controller, once the response has a body. */
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** The answer has no body (HEAD, 204, 205, 304), so nothing waits to read it. */
  bodyless: boolean;
  /** The host has sent its last frame for this request (its end or an abort), or was told to stop. */
  hostDone: boolean;
  /** Body bytes received and not yet read, in order. */
  queue: Uint8Array[];
  /** What the queue counts against the budgets. */
  held: number;
  /** The host sent the end: once the queue is read the body closes. */
  ended: boolean;
  /** Set when the body must fail instead of closing. */
  failure: Error | null;
  /** Wakes a read waiting for the next bytes. */
  wake: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

interface Failure {
  /** The status for a request still waiting for its head. */
  status: number;
  message: string;
  /** What to tell the host, when it is still sending. */
  abort: PreviewAbortCode | null;
}

const BODYLESS_STATUSES = new Set([204, 205, 304]);
const cost = (chunk: Uint8Array) => chunk.byteLength + HELD_CHUNK_OVERHEAD_BYTES;

export class PreviewTunnel {
  private readonly pending = new Map<string, Pending>();
  private roomHeld = 0;

  constructor(private readonly options: TunnelOptions) {}

  /** How many of this guest's requests are open, counting responses whose body the guest is still reading. */
  inFlight(guestId: string): number {
    let count = 0;
    for (const pending of this.pending.values()) if (pending.guestId === guestId) count++;
    return count;
  }

  /** What the room's open responses hold unread, as counted against the budgets. */
  get heldBytes(): number {
    return this.roomHeld;
  }

  /** Ask the host for a preview address. Resolves with the response once its head arrives, or with an error status. */
  open(request: PreviewOpen): Promise<Response> {
    const pending: Pending = {
      requestId: randomToken(12),
      roomId: request.roomId,
      guestId: request.guestId,
      hostConnectionId: request.hostConnectionId,
      method: request.method,
      stream: new PreviewStream(request.method),
      respond: null,
      controller: null,
      bodyless: false,
      hostDone: false,
      queue: [],
      held: 0,
      ended: false,
      failure: null,
      wake: null,
      timer: null,
      detach: () => {}
    };
    const answered = new Promise<Response>((resolve) => (pending.respond = resolve));
    this.pending.set(pending.requestId, pending);

    const signal = request.signal;
    if (signal) {
      const onAbort = () => this.fail(pending, { status: 499, message: 'The request was cancelled.', abort: 'CANCELLED' });
      if (signal.aborted) {
        onAbort();
        return answered;
      }
      signal.addEventListener('abort', onAbort);
      pending.detach = () => signal.removeEventListener('abort', onAbort);
    }

    const sent = this.options.sendToHost(request.hostConnectionId, {
      type: 'preview:request',
      requestId: pending.requestId,
      guestId: request.guestId,
      method: request.method,
      target: request.target,
      headers: request.headers
    });
    if (!sent) this.fail(pending, { status: 503, message: 'The host is not connected right now.', abort: null });
    else this.arm(pending, this.options.headTimeoutMs, { status: 504, message: 'The host did not answer in time.', abort: 'TIMEOUT' });
    return answered;
  }

  /** A preview frame from the host on `hostConnectionId`. Frames for requests that ended, or that another host connection owns, are dropped. */
  acceptHostFrame(hostConnectionId: string, frame: HostPreviewFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.hostConnectionId !== hostConnectionId || pending.hostDone) return;
    const step = pending.stream.accept(frame);
    if (!step.ok) {
      this.fail(pending, { status: 502, message: step.message, abort: step.code });
      return;
    }
    switch (frame.type) {
      case 'preview:abort':
        pending.hostDone = true;
        this.fail(pending, { status: frame.code === 'TIMEOUT' ? 504 : frame.code === 'UNAVAILABLE' ? 503 : 502, message: `The host stopped the response (${frame.code}).`, abort: null });
        return;
      case 'preview:response-head':
        this.armIdle(pending);
        this.respondHead(pending, frame);
        return;
      case 'preview:response-chunk': {
        this.armIdle(pending);
        const bytes = fromBase64Url(frame.data);
        if (!bytes) return this.fail(pending, { status: 502, message: 'The host sent a chunk that is not base64url.', abort: 'INVALID_RESPONSE' });
        pending.queue.push(bytes);
        pending.held += cost(bytes);
        this.roomHeld += cost(bytes);
        if (pending.held > MAX_UNREAD_BYTES_PER_RESPONSE || this.roomHeld > MAX_UNREAD_BYTES_PER_ROOM) {
          this.fail(pending, { status: 503, message: 'The preview is arriving faster than it is being read.', abort: 'UNAVAILABLE' });
          return;
        }
        pending.wake?.();
        return;
      }
      case 'preview:response-end':
        pending.hostDone = true;
        pending.ended = true;
        if (pending.bodyless) return this.forget(pending);
        if (pending.wake) return pending.wake();
        if (pending.queue.length === 0) return this.finish(pending);
        // What is left is the guest's to read; a guest that stops reading lets it go after the idle deadline.
        this.armIdle(pending);
        return;
    }
  }

  /** Stop every open request of a guest that is no longer allowed to see the preview. */
  abortGuest(guestId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.guestId === guestId) this.fail(pending, { status: 403, message: 'Your access to this live session has ended.', abort: 'CANCELLED' });
  }

  /** Fail every request the host on this connection was answering: it has gone or been replaced. */
  abortHost(hostConnectionId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.hostConnectionId === hostConnectionId) this.fail(pending, { status: 503, message: 'The host disconnected.', abort: null });
  }

  /** The session is over: fail everything. */
  abortAll(): void {
    for (const pending of [...this.pending.values()]) this.fail(pending, { status: 404, message: 'This live session has ended.', abort: null });
  }

  private respondHead(pending: Pending, frame: Frame<'host-to-relay', 'preview:response-head'>): void {
    const headers = new Headers();
    for (const [name, value] of frame.headers) {
      // The body is streamed, so the runtime frames it; a length the host claims is checked, not passed on.
      if (name === 'content-length') continue;
      // The preview is the site at its origin's root, so a redirect within it goes to the browser as the host gave it.
      if (name === 'location' && !isPreviewLocation(value)) continue;
      headers.append(name, value);
    }
    headers.set('cache-control', PREVIEW_CACHE_CONTROL);
    pending.bodyless = pending.method === 'HEAD' || BODYLESS_STATUSES.has(frame.status);
    const body = pending.bodyless
      ? null
      : new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              pending.controller = controller;
            },
            pull: () => this.pull(pending),
            cancel: () => this.fail(pending, { status: 499, message: 'The guest stopped reading.', abort: 'CANCELLED' })
          },
          { highWaterMark: 0 }
        );
    const respond = pending.respond;
    pending.respond = null;
    respond?.(new Response(body, { status: frame.status, headers }));
  }

  /** Hand the guest's reader the next bytes, waiting for the host when there are none yet. */
  private pull(pending: Pending): Promise<void> | void {
    const controller = pending.controller!;
    if (pending.failure) {
      controller.error(pending.failure);
      return;
    }
    const chunk = pending.queue.shift();
    if (chunk) {
      pending.held -= cost(chunk);
      this.roomHeld -= cost(chunk);
      controller.enqueue(chunk);
      if (pending.ended) {
        // That was the last of it: the body ends once this chunk is read. Otherwise reading is progress, and the
        // guest gets a fresh deadline for the rest.
        if (pending.queue.length === 0) this.finish(pending);
        else this.armIdle(pending);
      }
      return;
    }
    if (pending.ended) return this.finish(pending);
    return new Promise<void>((resolve) => {
      pending.wake = () => {
        pending.wake = null;
        resolve();
      };
    }).then(() => this.pull(pending));
  }

  /** The body has been read to its end: close it and let the request go. */
  private finish(pending: Pending): void {
    try {
      pending.controller?.close();
    } catch {
      // Already closed or failed.
    }
    this.forget(pending);
  }

  /** End a request that did not finish: answer it with an error, or fail its body midway, and tell the host to stop. */
  private fail(pending: Pending, failure: Failure): void {
    if (!this.pending.has(pending.requestId)) return;
    if (failure.abort && !pending.hostDone) this.options.sendToHost(pending.hostConnectionId, { type: 'preview:abort', requestId: pending.requestId, code: failure.abort });
    pending.hostDone = true;
    this.forget(pending);
    const respond = pending.respond;
    pending.respond = null;
    if (respond) return respond(textResponse(failure.status, failure.message));
    pending.failure = new Error(failure.message);
    // A read waiting for bytes fails as it wakes; otherwise the body fails now, so a reader waiting on it is told.
    if (pending.wake) return pending.wake();
    try {
      pending.controller?.error(pending.failure);
    } catch {
      // Already closed or failed.
    }
  }

  /** Let a request go: its timer, its listener and whatever of its body is still held. */
  private forget(pending: Pending): void {
    this.clearTimer(pending);
    pending.detach();
    this.roomHeld -= pending.held;
    pending.held = 0;
    pending.queue = [];
    this.pending.delete(pending.requestId);
  }

  /** (Re)start the deadline for what this request waits on next: the host's next frame, or the guest's next read. */
  private armIdle(pending: Pending): void {
    this.arm(pending, this.options.idleTimeoutMs, pending.ended ? { status: 504, message: 'The preview was not read in time.', abort: null } : { status: 504, message: 'The host stopped sending.', abort: 'TIMEOUT' });
  }

  private arm(pending: Pending, ms: number, failure: Failure): void {
    this.clearTimer(pending);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.fail(pending, failure);
    }, ms);
  }

  private clearTimer(pending: Pending): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
  }
}
