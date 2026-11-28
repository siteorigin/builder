/**
 * The main process's side of the import reader: each read runs in a utility process of its own, which is ended as
 * soon as it answers, fails, or takes too long, so a damaged or hostile file can never hold the editor up. A read
 * the project no longer wants (it closed, the app is quitting) is ended with `stop()`.
 */
import { basename } from 'node:path';
import type { RichPages } from '@shared/richtext';
import type { KnownPosts, ParsedSource, SourceKind, SourcePost } from './source';

export interface ReadRequest {
  id: number;
  kind: SourceKind;
  path: string;
  /** The project's pages, so a link to one of them stays one. */
  pages: RichPages;
  /** The posts imported before, so a link to one the export leaves out goes to its entry. */
  known?: KnownPosts;
  /** Report what the read cost (asked only while performance marks are on). */
  stats?: boolean;
}
/** What one read cost in the reader, reported after its answer when it was asked for (`stats`). */
export interface ReadStats {
  /** From the request arriving to the answer sent. */
  ms: number;
  /** The reader process's peak resident memory once its answer was sent (the copy sending it made included), in bytes. */
  peakRss: number;
}
/**
 * The reader's messages for a read: its posts in batches as they are read, then its answer (holding the posts read
 * after the last batch), and, when asked for, what the read cost.
 */
export type ReadReply = { id: number; posts: SourcePost[] } | { id: number; ok: true; source: ParsedSource } | { id: number; ok: false; error: string } | { id: number; stats: ReadStats };
/** How long a reader that answered is left for the report of what its read cost, when one was asked for. */
const STATS_WAIT_MS = 1000;

/** The reader process as the client uses it: Electron's UtilityProcess, or a stand-in in tests. */
export interface ReaderHandle {
  postMessage(message: ReadRequest): void;
  on(event: 'message', listener: (message: ReadReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error' | 'spawn', listener: () => void): unknown;
  kill(): boolean;
}

export interface SourceReader {
  /** The posts in `path`. Rejects with a reason the author can read. */
  read(kind: SourceKind, path: string, pages: RichPages, known?: KnownPosts): Promise<ParsedSource>;
  /** End every read in progress; each rejects. */
  stop(): void;
}

export function createSourceReader(spawn: () => ReaderHandle, opts: { timeoutMs?: number; onStats?: (stats: ReadStats) => void } = {}): SourceReader {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const live = new Map<ReaderHandle, (why: string) => void>();
  let ids = 0;
  const end = (w: ReaderHandle) => {
    live.delete(w);
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };
  return {
    read(kind, path, pages, known) {
      const name = basename(path);
      return new Promise<ParsedSource>((resolve, reject) => {
        const id = ++ids;
        let w: ReaderHandle;
        try {
          w = spawn();
        } catch {
          reject(new Error(`${name} could not be read: the reader did not start.`));
          return;
        }
        let done = false;
        // The posts sent so far, in order: the answer is whole only with them.
        const received: SourcePost[] = [];
        // A reader that answered, left until it says what the read cost (asked only while marks are on).
        let lingering: ReturnType<typeof setTimeout> | undefined;
        const finish = (settle: () => void, linger = false) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          received.length = 0;
          if (linger) {
            live.delete(w);
            lingering = setTimeout(() => {
              lingering = undefined;
              end(w);
            }, STATS_WAIT_MS);
          } else end(w);
          settle();
        };
        const fail = (why: string) => finish(() => reject(new Error(why)));
        const timer = setTimeout(() => fail(`${name} took too long to read, so it was stopped. It may be damaged, or larger than an import can read.`), timeoutMs);
        live.set(w, fail);
        w.on('message', (m) => {
          if (!m || m.id !== id) return;
          if ('stats' in m) {
            if (lingering === undefined) return;
            clearTimeout(lingering);
            lingering = undefined;
            end(w);
            opts.onStats?.(m.stats);
          } else if ('posts' in m) {
            if (done) return;
            if (!Array.isArray(m.posts)) return fail(`${name} could not be read.`);
            for (const p of m.posts) received.push(p);
          } else if (m.ok && m.source && Array.isArray(m.source.posts) && Array.isArray(m.source.media)) {
            const source = received.length ? { ...m.source, posts: [...received, ...m.source.posts] } : m.source;
            finish(() => resolve(source), !!opts.onStats);
          }
          else fail(m.ok ? `${name} could not be read.` : m.error);
        });
        w.on('exit', () => fail(`${name} could not be read: the reader stopped. It may be damaged, or larger than an import can read.`));
        w.on('error', () => fail(`${name} could not be read: the reader stopped.`));
        try {
          w.postMessage({ id, kind, path, pages, ...(known ? { known } : {}), ...(opts.onStats ? { stats: true } : {}) });
        } catch {
          fail(`${name} could not be read: the reader did not start.`);
        }
      });
    },
    stop() {
      for (const fail of [...live.values()]) fail('The import was stopped.');
    }
  };
}
