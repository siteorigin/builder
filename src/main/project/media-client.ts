/**
 * The main process's side of the media worker: hands each picture to a utility process for its responsive
 * copies, one at a time, so a batch of large photos never blocks the editor window.
 *
 * Copies are an extra: a worker that fails, crashes or takes too long leaves the picture imported without
 * them, as a very large picture already is. The worker starts on the first request and is stopped once it
 * has been idle for a while.
 */
import type { Variant } from './image-variants';

/**
 * Decoding allocates by pixel count, which a small file can inflate: larger pictures keep only the original.
 * Kept here, not beside the resizing, so the main process never loads the image library.
 */
export const MAX_VARIANT_PIXELS = 100_000_000;

export interface VariantRequest {
  id: number;
  data: Uint8Array;
  mime: string;
  width: number;
}

export type VariantReply = { id: number; ok: true; variants: Array<{ width: number; data: Uint8Array }> } | { id: number; ok: false; error: string };

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
  /** The picture's responsive copies, or none when the worker could not make them. Never rejects. */
  variants(buf: Buffer, mime: string, width: number): Promise<Variant[]>;
  /** Stop the worker for good (the app is quitting): requests in flight or still to come get no copies. */
  stop(): void;
}

export function createVariantClient(spawn: () => WorkerHandle, opts: { timeoutMs?: number; idleMs?: number } = {}): VariantClient {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const idleMs = opts.idleMs ?? 30_000;
  let worker: WorkerHandle | null = null;
  let current: { id: number; resolve: (v: Variant[]) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let stopped = false;

  const settle = (id: number, result: Variant[]) => {
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
      settle(m.id, m.ok ? m.variants.map((v) => ({ width: v.width, data: Buffer.from(v.data.buffer, v.data.byteOffset, v.data.byteLength) })) : []);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      if (current) settle(current.id, []);
    });
    // Unhandled, an 'error' event would be thrown in the main process.
    w.on('error', () => {
      if (worker !== w) return;
      kill();
      if (current) settle(current.id, []);
    });
    return w;
  };
  const run = (buf: Buffer, mime: string, width: number) =>
    new Promise<Variant[]>((resolve) => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (stopped) return resolve([]);
      const id = ++nextId;
      current = { id, resolve, timer: setTimeout(() => (kill(), settle(id, [])), timeoutMs) };
      try {
        ensure().postMessage({ id, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mime, width });
      } catch {
        kill();
        settle(id, []);
      }
    }).finally(() => {
      if (current || idle || stopped) return;
      idle = setTimeout(() => ((idle = null), kill()), idleMs);
      idle.unref?.();
    });

  return {
    variants(buf, mime, width) {
      const p = queue.then(() => run(buf, mime, width));
      queue = p;
      return p;
    },
    stop() {
      stopped = true;
      if (idle) clearTimeout(idle);
      idle = null;
      kill();
      if (current) settle(current.id, []);
    }
  };
}
