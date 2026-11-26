/**
 * The main process's side of the sync worker: each sync runs in a utility process of its own, which is ended as soon
 * as it answers, fails, or takes too long, so a source that stalls or a reader that crashes can never hold the editor
 * up. A sync the project no longer wants (it closed, the app is quitting) is ended with `stop()`, or its own signal.
 * What the worker says is put in the app's own words here: a server's reply never reaches the author as it is.
 */
import { redactSecrets } from './redact';
import { MAX_DETAIL, type NormalizedRecord, type SyncFailure, type SyncImage, type SyncReply, type SyncRequest } from './protocol';

/** Why a sync failed: the worker's reasons, and the client's own. */
export type SyncErrorCode = SyncFailure | 'timeout' | 'crashed' | 'stopped' | 'not-started';

export class SyncError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string
  ) {
    super(message);
  }
}

const REASONS: Record<SyncErrorCode, string> = {
  'adapter-unavailable': 'this kind of source cannot be read by this version of the app',
  auth: 'the source refused its credentials. Check the secrets it names',
  network: 'the source could not be reached',
  invalid: 'the source sent records that cannot be entries',
  'too-large': 'the source holds more than one sync can bring',
  image: 'a picture could not be fetched',
  failed: 'the source could not be read',
  timeout: 'it took too long, so it was stopped',
  crashed: 'the sync stopped unexpectedly',
  stopped: 'it was stopped',
  'not-started': 'the sync could not start'
};

/** The author's words for a failed sync of `name`, with a detail the worker gave, its secrets already taken out. */
export function syncFailureMessage(name: string, code: SyncErrorCode, detail?: string): string {
  return `“${name}” was not synced: ${REASONS[code] ?? REASONS.failed}${detail ? ` (${detail})` : ''}.`;
}

/** The sync worker as the client uses it: Electron's UtilityProcess, or a stand-in in tests. */
export interface SyncHandle {
  postMessage(message: SyncRequest): void;
  on(event: 'message', listener: (message: SyncReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error' | 'spawn', listener: () => void): unknown;
  kill(): boolean;
}

export interface SyncResult {
  records: NormalizedRecord[];
  images: SyncImage[];
}

export interface SyncRunner {
  /**
   * Every record of a source, and the pictures of those that changed. Rejects with a SyncError whose message names
   * `name`, the source, and holds none of `request.secrets`.
   */
  run(name: string, request: Omit<SyncRequest, 'id'>, opts?: { signal?: AbortSignal }): Promise<SyncResult>;
  /** End every sync in progress; each rejects. */
  stop(): void;
}

export function createSyncRunner(spawn: () => SyncHandle, opts: { timeoutMs?: number } = {}): SyncRunner {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const live = new Map<SyncHandle, (code: SyncErrorCode) => void>();
  let ids = 0;
  const end = (w: SyncHandle) => {
    live.delete(w);
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };
  return {
    run(name, request, { signal } = {}) {
      return new Promise<SyncResult>((resolve, reject) => {
        const secrets = Object.values(request.secrets ?? {});
        const refuse = (code: SyncErrorCode, detail?: string) =>
          reject(new SyncError(code, syncFailureMessage(name, code, typeof detail === 'string' && detail ? redactSecrets(detail, secrets).slice(0, MAX_DETAIL) : undefined)));
        if (signal?.aborted) return refuse('stopped');
        const id = ++ids;
        let w: SyncHandle;
        try {
          w = spawn();
        } catch {
          return refuse('not-started');
        }
        let done = false;
        const onAbort = () => fail('stopped');
        // One way out, whatever ends the sync: the timer, the listeners and the process all go with it, at once.
        const finish = (settle: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          end(w);
          settle();
        };
        const fail = (code: SyncErrorCode, detail?: string) => finish(() => refuse(code, detail));
        const timer = setTimeout(() => fail('timeout'), timeoutMs);
        live.set(w, fail);
        signal?.addEventListener('abort', onAbort, { once: true });
        w.on('message', (m) => {
          if (!m || m.id !== id) return;
          if (m.ok === true && Array.isArray(m.records) && Array.isArray(m.images)) finish(() => resolve({ records: m.records, images: m.images }));
          else if (m.ok === false && typeof m.code === 'string' && Object.hasOwn(REASONS, m.code)) fail(m.code, m.detail);
          else fail('failed');
        });
        w.on('exit', () => fail('crashed'));
        w.on('error', () => fail('crashed'));
        try {
          w.postMessage({ ...request, id });
        } catch {
          fail('not-started');
        }
      });
    },
    stop() {
      for (const fail of [...live.values()]) fail('stopped');
    }
  };
}
