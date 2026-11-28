/**
 * The main process's side of the media worker: hands each picture to a utility process for its responsive
 * copies, so a batch of large photos never blocks the editor window. A client takes one request at a time, or as many
 * as it is told to (`parallel`), within a budget of pixels being decoded at once, so a batch keeps several cores busy
 * without holding more than a few pictures in memory.
 *
 * Copies are an extra: a worker that fails, crashes or takes too long leaves the picture imported without
 * them, as a very large picture already is. The worker starts on the first request and is stopped once it
 * has been idle for a while.
 */
import type { Variant, VariantTarget, WebCopy } from './image-variants';
import type { CopyMime } from '@shared/picture-formats';
import type { PhotoCredits, PhotoMetadata } from './photo-metadata';

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
  /**
   * What the worker is asked for: responsive copies (the default), a web-sized copy, whether it is opaque, or the
   * website's square PNG icons (see site-icons.ts).
   */
  kind?: 'variants' | 'web' | 'opaque' | 'icons' | 'library';
  data: Uint8Array;
  mime: string;
  width: number;
  /** Decode the whole picture first, and say so when it cannot be read. */
  check?: boolean;
  /** Exactly these copies (width and format), instead of the usual ones for the picture's width. */
  targets?: VariantTarget[];
  /**
   * For a web-sized copy: read the picture from this file (a decoded photo too large to send) instead of `data`. For a
   * library image: its file, read here so the editor's main process never holds it.
   */
  path?: string;
  /**
   * For a library image: what its SHA-256 should be (its record's), whether a web-sized copy is to be weighed, and the
   * SHA-256s of pictures whose copy has been weighed already (none is made again for those).
   */
  library?: { expect: string; plan: boolean; known: string[] };
  /** For a web-sized copy: its longest side. */
  maxEdge?: number;
  /** For icons: each one's square size, and the opaque colour behind it when it has one. */
  icons?: IconSpec[];
  /** For icons: the picture is a file of the project's, cleaned here first when it is SVG (see renderSiteIcons). */
  untrusted?: boolean;
  /** Report what the request cost in the worker (MediaStats), for the benchmark's marks. */
  stats?: boolean;
}

/**
 * What one request cost in the worker, reported when it was asked for (`stats`). Times are the request's own, from its
 * message arriving to its reply; the decode and format times are what its pipelines took, added up.
 */
export interface MediaStats {
  pid: number;
  ms: number;
  /** CPU time the worker process used meanwhile, every thread of it, user and system. */
  cpuMs: number;
  /**
   * The CPU time the worker process had used when the request arrived and when it was answered: what requests that
   * overlap used together is the last answer's less the first arrival's, never their own times added up.
   */
  cpuStartMs: number;
  cpuEndMs: number;
  /** The worker process's peak resident memory so far, in bytes. */
  peakRss: number;
  /** Pixel decodes of an encoded picture (a header read is not one), and copies encoded. */
  decodes: number;
  encodes: number;
  /** Decoding a picture to check it or to read it for its copies. */
  decodeMs: number;
  /** Making a web-sized copy: its decode, resize and encode. */
  webCopyMs: number;
  /** Making each format's responsive copies (each one's decode and resize included when it has its own). */
  formatMs: Partial<Record<CopyMime, number>>;
  /** The bytes of the file a request named by its path (a HEIC photo's TIFF), read here or handed to the decoder. */
  readBytes: number;
}

/** One square PNG icon made from a picture: its size, and the colour see-through parts are filled with, if any. */
export interface IconSpec {
  size: number;
  background?: string;
  /** Instead of one PNG, an ICO file holding a PNG at each of these sizes, none over 256; `size` is the largest. */
  ico?: readonly number[];
}

/** The website's icons the worker made, in the order asked for, or why there are none: `unreadable` only when the decoder refused the picture. */
export type IconsResult = { ok: true; icons: Buffer[] } | { ok: false; unreadable: boolean };

/** What the worker found in a library image's file (VariantRequest `library`). */
export interface LibraryReply {
  /** The SHA-256 and length of the bytes it read, and the stat of the file it read them from (stampOf). */
  hash: string;
  bytes: number;
  stamp: string;
  /** What private metadata they carry, and their credits, as cleanPhoto reads them; null metadata when it could not. */
  metadata: PhotoMetadata | null;
  credits?: PhotoCredits;
  /** The picture passed libraryWebCopyPlan's checks, so a web-sized copy of it can be weighed. */
  checked: boolean;
  /** The decoder refused it when its copy was made. */
  unreadable?: boolean;
}

export type VariantReply = (
  | { id: number; ok: true; variants: Array<{ width: number; mime: CopyMime; data: Uint8Array }>; web?: { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }; opaque?: boolean; icons?: Uint8Array[]; library?: LibraryReply; /** Sent ahead of the reply: what a library image says, before its copy is made. */ early?: true }
  | { id: number; ok: false; error: string; unreadable?: boolean }
) & { stats?: MediaStats };

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
  /**
   * The picture's responsive copies (or exactly `targets`), or none when the worker could not make them. Never rejects.
   * `pixels` (the picture's, when known) is what the request counts against the client's budget.
   */
  variants(buf: Buffer, mime: string, width: number, targets?: VariantTarget[], pixels?: number): Promise<Variant[]>;
  /**
   * Decode the picture to prove it can be shown, and make its copies. A worker that fails, crashes or takes too
   * long proves nothing either way, so the picture counts as readable. Never rejects.
   */
  inspect(buf: Buffer, mime: string, width: number, pixels?: number): Promise<Inspected>;
  /** Decode the picture to prove it can be shown, making no copies (they are made later, #979). As inspect, never rejects. */
  check(buf: Buffer, mime: string, pixels?: number): Promise<Inspected>;
  /**
   * A web-sized copy of a photo, from its bytes or from a file (a decoded HEIC). Unlike the responsive copies it is
   * the picture the author asked for, so a worker that fails says so rather than giving nothing. Never rejects.
   */
  webCopy(source: { data: Buffer; mime: string } | { path: string }, maxEdge: number, pixels?: number): Promise<WebCopyResult>;
  /**
   * A library image read and looked at in the worker (`path`, typed `mime`): its hash, metadata and credits, and with
   * `ask.plan` its web-sized copy, made when its hash is `ask.expect` and not among `ask.known`. Null when the file could
   * not be read or the worker failed. Never rejects.
   */
  library(path: string, mime: string, ask: { expect: string; plan: boolean; known: string[] }, maxEdge: number, pixels?: number, early?: (found: LibraryReply) => void): Promise<{ found: LibraryReply; copy: WebCopy | null } | null>;
  /** Whether every pixel of a picture with an alpha channel is opaque; null when the worker could not tell. Never rejects. */
  opaque(buf: Buffer, mime: string, pixels?: number): Promise<boolean | null>;
  /** Square PNG icons of a picture, one for each of `icons`, or why there are none. Never rejects. */
  icons(buf: Buffer, mime: string, icons: IconSpec[], opts?: { untrusted?: boolean }): Promise<IconsResult>;
  /**
   * End the worker as soon as it has nothing to do (the project that wanted it closed), instead of after the idle time:
   * at once when it is idle, or when the requests already made have finished. A request made after this keeps the
   * worker on its usual idle time, and a worker that has ended starts again for the next request.
   */
  release(): void;
  /** Stop the worker for good (the app is quitting): requests in flight or still to come get no copies. */
  stop(): void;
}

/** A request's answer when the worker went down while it was one of several in it: it is asked again. */
const LOST = Symbol('lost');

/** What a client was asked for, as the benchmark's marks name it. */
export type MediaKind = NonNullable<VariantRequest['kind']>;

/**
 * `parallel` requests at most go to the worker at once (one by default), and while more than one is in flight, the
 * pictures they decode add up to no more than `pixelBudget`: a request over it alone waits for the others and then has
 * the worker to itself. A request whose picture's size is not known counts as an equal share of the budget.
 */
export function createVariantClient(
  spawn: () => WorkerHandle,
  opts: { timeoutMs?: number; copiesTimeoutMs?: number; webTimeoutMs?: number; idleMs?: number; parallel?: number; pixelBudget?: number; onStats?: (kind: MediaKind, stats: MediaStats, ms: number) => void } = {}
): VariantClient {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // A picture's copies come in three formats, each to its full width: a 100-megapixel original (the most copies are
  // made of) takes about 17 seconds on a fast machine, which a slower one must still finish.
  const copiesTimeoutMs = opts.copiesTimeoutMs ?? opts.timeoutMs ?? 120_000;
  // A web-sized copy decodes the whole photo, which for a 48-megapixel camera original takes a while.
  const webTimeoutMs = opts.webTimeoutMs ?? 60_000;
  const idleMs = opts.idleMs ?? 30_000;
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
  const pixelBudget = opts.pixelBudget ?? Infinity;
  let worker: WorkerHandle | null = null;
  // The requests in flight, by id: each settles with the worker's reply, or null when the worker failed, crashed or
  // took too long, or LOST when it went down while this request shared it with others, which may not be this one's doing.
  const inFlight = new Map<number, { resolve: (v: VariantReply | null | typeof LOST) => void; timer: ReturnType<typeof setTimeout>; early?: (m: VariantReply) => void }>();
  let idle: ReturnType<typeof setTimeout> | null = null;
  // Requests waiting their turn, first come first served (one asked again first of all), and those let through: how
  // many, their pixels, and whether one has the worker to itself.
  const waiting: Array<{ pixels: number; alone: boolean; go: () => void }> = [];
  let admitted = 0;
  let admittedPixels = 0;
  let aloneIn = false;
  let nextId = 0;
  let stopped = false;
  /** Requests made and not yet settled, in flight or waiting their turn. */
  let pending = 0;
  /** Set by release(): end the worker once the requests made before it have settled. */
  let releasing = false;

  const settle = (id: number, result: VariantReply | null | typeof LOST) => {
    const r = inFlight.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    inFlight.delete(id);
    r.resolve(result);
  };
  /**
   * The worker is gone (it crashed, failed or was stopped, or `culprit` took too long): the request it had alone, or the
   * one that took too long, gets nothing, as before; any other it had is LOST, to be asked again.
   */
  const lose = (culprit?: number) => {
    const shared = inFlight.size > 1;
    for (const id of [...inFlight.keys()]) settle(id, shared && id !== culprit && !stopped ? LOST : null);
  };
  /** Let waiting requests through, in order, while the worker has room for the next. */
  const admit = () => {
    while (waiting.length && !aloneIn && (admitted === 0 || (!waiting[0].alone && admitted < parallel && admittedPixels + waiting[0].pixels <= pixelBudget))) {
      const next = waiting.shift()!;
      admitted++;
      admittedPixels += next.pixels;
      aloneIn = next.alone;
      next.go();
    }
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
      if (worker !== w) return;
      // A part of the answer sent ahead of it: the request is still in flight.
      if (m.ok && m.early) {
        try {
          inFlight.get(m.id)?.early?.(m);
        } catch {
          // Whoever was told failing changes nothing: the reply still settles the request.
        }
        return;
      }
      settle(m.id, m);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      lose();
    });
    // Unhandled, an 'error' event would be thrown in the main process.
    w.on('error', () => {
      if (worker !== w) return;
      kill();
      lose();
    });
    return w;
  };
  type Ask = Omit<VariantRequest, 'id'>;
  const run = (ask: Ask, early?: (m: VariantReply) => void) =>
    new Promise<VariantReply | null | typeof LOST>((resolve) => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (stopped) return resolve(null);
      const id = ++nextId;
      const posted = performance.now();
      // The worker's account of the request, with the time it took from here (its wait for the worker to start included).
      const answer = opts.onStats ? (r: VariantReply | null | typeof LOST) => (r !== LOST && r?.stats && opts.onStats!(ask.kind ?? 'variants', r.stats, performance.now() - posted), resolve(r)) : resolve;
      // One that takes too long has the worker stopped: it may be stuck, and the others in flight go with it.
      inFlight.set(id, { resolve: answer, timer: setTimeout(() => (kill(), lose(id)), ask.kind === 'web' || ask.kind === 'library' ? webTimeoutMs : !ask.kind || ask.kind === 'variants' ? copiesTimeoutMs : timeoutMs), ...(early ? { early } : {}) });
      try {
        ensure().postMessage({ id, ...ask, ...(opts.onStats ? { stats: true } : {}) });
      } catch {
        kill();
        lose();
      }
    });

  /** One go at a request once it is let through: `alone` with the worker to itself, first in line. */
  const attempt = async (ask: Ask, weight: number, alone: boolean, early?: (m: VariantReply) => void) => {
    await new Promise<void>((go) => {
      const turn = { pixels: weight, alone, go };
      if (alone) waiting.unshift(turn);
      else waiting.push(turn);
      admit();
    });
    try {
      return await run(ask, early);
    } finally {
      admitted--;
      admittedPixels -= weight;
      if (alone) aloneIn = false;
      admit();
    }
  };
  const request = async (ask: Ask, pixels?: number, early?: (m: VariantReply) => void): Promise<VariantReply | null> => {
    pending++;
    // Someone wants the worker again: it keeps its usual idle time.
    releasing = false;
    const weight = !Number.isFinite(pixelBudget) ? 0 : pixels !== undefined && Number.isFinite(pixels) && pixels >= 0 ? Math.min(pixels, pixelBudget) : pixelBudget / parallel;
    try {
      const r = await attempt(ask, weight, false, early);
      // Lost with a worker that went down for another request, or for one of those it had: asked once more with the
      // worker to itself, so it is never left without its copies by another picture, and a picture that brings the
      // worker down again does so alone.
      if (r !== LOST) return r;
      const again = await attempt(ask, weight, true, early);
      return again === LOST ? null : again;
    } finally {
      pending--;
      if (!(inFlight.size || idle || stopped || pending)) {
        if (releasing) {
          releasing = false;
          kill();
        } else {
          idle = setTimeout(() => ((idle = null), kill()), idleMs);
          idle.unref?.();
        }
      }
    }
  };
  const bytes = (buf: Buffer) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const toBuffer = (d: Uint8Array) => Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  const inspected = (r: VariantReply | null): Inspected =>
    r?.ok ? { unreadable: false, variants: (r.variants ?? []).map((v) => ({ width: v.width, mime: v.mime, data: toBuffer(v.data) })) } : { unreadable: !!r?.unreadable, variants: [] };
  return {
    variants: (buf, mime, width, targets, pixels) => request({ data: bytes(buf), mime, width, ...(targets ? { targets } : {}) }, pixels).then((r) => inspected(r).variants),
    inspect: (buf, mime, width, pixels) => request({ data: bytes(buf), mime, width, check: true }, pixels).then(inspected),
    check: (buf, mime, pixels) => request({ data: bytes(buf), mime, width: 0, check: true, targets: [] }, pixels).then(inspected),
    webCopy: (source, maxEdge, pixels) =>
      request({ kind: 'web', maxEdge, width: 0, ...('path' in source ? { path: source.path, data: new Uint8Array(0), mime: '' } : { data: bytes(source.data), mime: source.mime }) }, pixels).then((r): WebCopyResult =>
        r?.ok && r.web ? { ok: true, copy: { ...r.web, data: toBuffer(r.web.data) } } : { ok: false, unreadable: !!(r && !r.ok && r.unreadable) }
      ),
    library: (path, mime, ask, maxEdge, pixels, early) => {
      // Buffers arrive as plain byte arrays.
      const found = (l: LibraryReply): LibraryReply => {
        const c = l.credits;
        const credits = c && { ...(c.tiff ? { tiff: toBuffer(c.tiff) } : {}), ...(c.xmp ? { xmp: toBuffer(c.xmp) } : {}), ...(c.iptc ? { iptc: toBuffer(c.iptc) } : {}), ...(c.text ? { text: c.text.map(toBuffer) } : {}) };
        return { ...l, ...(credits ? { credits } : {}) };
      };
      return request({ kind: 'library', path, data: new Uint8Array(0), mime, width: 0, maxEdge, library: ask }, pixels, early && ((m) => m.ok && m.library && early(found(m.library)))).then((r) =>
        r?.ok && r.library ? { found: found(r.library), copy: r.web ? { ...r.web, data: toBuffer(r.web.data) } : null } : null
      );
    },
    opaque: (buf, mime, pixels) => request({ kind: 'opaque', data: bytes(buf), mime, width: 0 }, pixels).then((r) => (r?.ok && typeof r.opaque === 'boolean' ? r.opaque : null)),
    icons: (buf, mime, icons, opts) =>
      request({ kind: 'icons', data: bytes(buf), mime, width: 0, icons, ...(opts?.untrusted ? { untrusted: true } : {}) }).then((r): IconsResult =>
        // A reply without exactly one icon for each asked for is the worker failing, not the picture.
        r?.ok && r.icons?.length === icons.length ? { ok: true, icons: r.icons.map(toBuffer) } : { ok: false, unreadable: !!(r && !r.ok && r.unreadable) }
      ),
    release() {
      if (stopped) return;
      if (idle) clearTimeout(idle);
      idle = null;
      if (pending) releasing = true;
      else kill();
    },
    stop() {
      stopped = true;
      if (idle) clearTimeout(idle);
      idle = null;
      kill();
      lose();
    }
  };
}
