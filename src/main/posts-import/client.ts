/**
 * The main process's side of the import reader: each read runs in a utility process of its own, which is ended as
 * soon as it answers, fails, or takes too long, so a damaged or hostile file can never hold the editor up. A read
 * the project no longer wants (it closed, the app is quitting) is ended with `stop()`.
 */
import { basename } from 'node:path';
import type { RichPages } from '@shared/richtext';
import type { ParsedSource, SourceKind } from './source';

export interface ReadRequest {
  id: number;
  kind: SourceKind;
  path: string;
  /** The project's pages, so a link to one of them stays one. */
  pages: RichPages;
}
export type ReadReply = { id: number; ok: true; source: ParsedSource } | { id: number; ok: false; error: string };

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
  read(kind: SourceKind, path: string, pages: RichPages): Promise<ParsedSource>;
  /** End every read in progress; each rejects. */
  stop(): void;
}

export function createSourceReader(spawn: () => ReaderHandle, opts: { timeoutMs?: number } = {}): SourceReader {
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
    read(kind, path, pages) {
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
        const finish = (settle: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          end(w);
          settle();
        };
        const fail = (why: string) => finish(() => reject(new Error(why)));
        const timer = setTimeout(() => fail(`${name} took too long to read, so it was stopped. It may be damaged, or larger than an import can read.`), timeoutMs);
        live.set(w, fail);
        w.on('message', (m) => {
          if (!m || m.id !== id) return;
          if (m.ok && m.source && Array.isArray(m.source.posts) && Array.isArray(m.source.media)) finish(() => resolve(m.source));
          else fail(m.ok ? `${name} could not be read.` : m.error);
        });
        w.on('exit', () => fail(`${name} could not be read: the reader stopped. It may be damaged, or larger than an import can read.`));
        w.on('error', () => fail(`${name} could not be read: the reader stopped.`));
        try {
          w.postMessage({ id, kind, path, pages });
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
