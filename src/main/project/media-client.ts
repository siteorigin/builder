/**
 * The main process's side of the media worker: hands each picture to a utility process for its responsive
 * copies, one at a time, so a batch of large photos never blocks the editor window.
 *
 * Copies are an extra: a worker that fails, crashes or takes too long leaves the picture imported without
 * them, as a very large picture already is. The worker starts on the first request and is stopped once it
 * has been idle for a while.
 */
import type { Variant, WebCopy } from './image-variants';

/**
 * Decoding allocates by pixel count, which a small file can inflate: larger pictures keep only the original.
 * Kept here, not beside the resizing, so the main process never loads the image library.
 */
export const MAX_VARIANT_PIXELS = 100_000_000;

/** The longest side of a web-sized copy: sharp on a large, high-density screen, and far lighter than a camera original. */
export const WEB_EDGE = 2560;

/**
 * A web-sized copy's size: the picture as displayed, fitted inside `edge` on its longest side and never enlarged.
 * The copy is made at exactly this size, so what an import review promises is what arrives.
 */
export function webCopySize(width: number, height: number, edge = WEB_EDGE): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface VariantRequest {
  id: number;
  /** What the worker is asked for: responsive copies (the default), a web-sized copy, or whether it is opaque. */
  kind?: 'variants' | 'web' | 'opaque';
  data: Uint8Array;
  mime: string;
  width: number;
  /** Decode the whole picture first, and say so when it cannot be read. */
  check?: boolean;
  /** Exactly these copies, instead of the usual ones for the picture's width. */
  widths?: number[];
  /** For a web-sized copy: read the picture from this file (a decoded photo too large to send) instead of `data`. */
  path?: string;
  /** For a web-sized copy: its longest side. */
  maxEdge?: number;
}

export type VariantReply =
  | { id: number; ok: true; variants: Array<{ width: number; data: Uint8Array }>; web?: { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }; opaque?: boolean }
  | { id: number; ok: false; error: string; unreadable?: boolean };

/** A picture checked by the worker: unreadable only when the decoder refused it, never because the worker failed. */
export interface Inspected {
  unreadable: boolean;
  variants: Variant[];
}

/** A web-sized copy the worker made, or why there is none: `unreadable` only when the decoder refused the picture. */
export type WebCopyResult = { ok: true; copy: WebCopy } | { ok: false; unreadable: boolean };

/** The worker process as the client uses it: Electron's UtilityProcess, or a stand-in in tests. */
export interface WorkerHandle {
  postMessage(message: VariantRequest): void;
  on(event: 'message', listener: (message: VariantReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  /** A fatal error in the worker (an exit follows), or the worker having started. */
  on(event: 'error' | 'spawn', listener: () => void): unknown;
  /** False when the process has not started yet, or has already ended. */
  kill(): boolean;
}

export interface VariantClient {
  /** The picture's responsive copies (or exactly `widths`), or none when the worker could not make them. Never rejects. */
  variants(buf: Buffer, mime: string, width: number, widths?: number[]): Promise<Variant[]>;
  /**
   * Decode the picture to prove it can be shown, and make its copies. A worker that fails, crashes or takes too
   * long proves nothing either way, so the picture counts as readable. Never rejects.
   */
  inspect(buf: Buffer, mime: string, width: number): Promise<Inspected>;
  /**
   * A web-sized copy of a photo, from its bytes or from a file (a decoded HEIC). Unlike the responsive copies it is
   * the picture the author asked for, so a worker that fails says so rather than giving nothing. Never rejects.
   */
  webCopy(source: { data: Buffer; mime: string } | { path: string }, maxEdge: number): Promise<WebCopyResult>;
  /** Whether every pixel of a picture with an alpha channel is opaque; null when the worker could not tell. Never rejects. */
  opaque(buf: Buffer, mime: string): Promise<boolean | null>;
  /** Stop the worker for good (the app is quitting): requests in flight or still to come get no copies. */
  stop(): void;
}

export function createVariantClient(spawn: () => WorkerHandle, opts: { timeoutMs?: number; webTimeoutMs?: number; idleMs?: number } = {}): VariantClient {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // A web-sized copy decodes the whole photo, which for a 48-megapixel camera original takes a while.
  const webTimeoutMs = opts.webTimeoutMs ?? 60_000;
  const idleMs = opts.idleMs ?? 30_000;
  let worker: WorkerHandle | null = null;
  // A request in flight settles with the worker's reply, or null when the worker failed, crashed or took too long.
  let current: { id: number; resolve: (v: VariantReply | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let stopped = false;

  const settle = (id: number, result: VariantReply | null) => {
    if (current?.id !== id) return;
    clearTimeout(current.timer);
    const { resolve } = current;
    current = null;
    resolve(result);
  };
  const kill = () => {
    const w = worker;
    worker = null;
    if (!w) return;
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };
  const ensure = (): WorkerHandle => {
    if (worker) return worker;
    const w = spawn();
    worker = w;
    // Messages and exits from a worker that has been replaced belong to no request.
    w.on('message', (m) => {
      if (worker !== w || !current || m.id !== current.id) return;
      settle(m.id, m);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      if (current) settle(current.id, null);
    });
    // Unhandled, an 'error' event would be thrown in the main process.
    w.on('error', () => {
      if (worker !== w) return;
      kill();
      if (current) settle(current.id, null);
    });
    return w;
  };
  type Ask = Omit<VariantRequest, 'id'>;
  const run = (ask: Ask) =>
    new Promise<VariantReply | null>((resolve) => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (stopped) return resolve(null);
      const id = ++nextId;
      current = { id, resolve, timer: setTimeout(() => (kill(), settle(id, null)), ask.kind === 'web' ? webTimeoutMs : timeoutMs) };
      try {
        ensure().postMessage({ id, ...ask });
      } catch {
        kill();
        settle(id, null);
      }
    }).finally(() => {
      if (current || idle || stopped) return;
      idle = setTimeout(() => ((idle = null), kill()), idleMs);
      idle.unref?.();
    });

  const request = (ask: Ask) => {
    const p = queue.then(() => run(ask));
    queue = p;
    return p;
  };
  const bytes = (buf: Buffer) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const toBuffer = (d: Uint8Array) => Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  const inspected = (r: VariantReply | null): Inspected =>
    r?.ok ? { unreadable: false, variants: (r.variants ?? []).map((v) => ({ width: v.width, data: toBuffer(v.data) })) } : { unreadable: !!r?.unreadable, variants: [] };
  return {
    variants: (buf, mime, width, widths) => request({ data: bytes(buf), mime, width, ...(widths ? { widths } : {}) }).then((r) => inspected(r).variants),
    inspect: (buf, mime, width) => request({ data: bytes(buf), mime, width, check: true }).then(inspected),
    webCopy: (source, maxEdge) =>
      request({ kind: 'web', maxEdge, width: 0, ...('path' in source ? { path: source.path, data: new Uint8Array(0), mime: '' } : { data: bytes(source.data), mime: source.mime }) }).then((r): WebCopyResult =>
        r?.ok && r.web ? { ok: true, copy: { ...r.web, data: toBuffer(r.web.data) } } : { ok: false, unreadable: !!(r && !r.ok && r.unreadable) }
      ),
    opaque: (buf, mime) => request({ kind: 'opaque', data: bytes(buf), mime, width: 0 }).then((r) => (r?.ok && typeof r.opaque === 'boolean' ? r.opaque : null)),
    stop() {
      stopped = true;
      if (idle) clearTimeout(idle);
      idle = null;
      kill();
      if (current) settle(current.id, null);
    }
  };
}
