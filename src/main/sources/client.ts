/**
 * The main process's side of the sync worker: each sync runs in a utility process of its own, which is ended as soon
 * as it answers, fails, or takes too long, so a source that stalls or a reader that crashes can never hold the editor
 * up. A sync the project no longer wants (it closed, the app is quitting) is ended with `stop()`, or its own signal.
 * What the worker says is put in the app's own words here: a server's reply never reaches the author as it is.
 */
import { redactSecrets } from './redact';
import { isDroppedLinks, MAX_DETAIL, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES, MAX_RECORDS, recordProblem, SAMPLE_SIZE, type DroppedLinks, type NormalizedRecord, type SyncFailure, type SyncImage, type SyncReply, type SyncRequest } from './protocol';

/**
 * A picture as a reply may give it: its size within a picture's limit and, for a sync with a spool, no bytes (its file
 * holds them), or else its bytes, of that size.
 */
const isSyncImage = (i: unknown, spooled: boolean): i is SyncImage => {
  const img = i as SyncImage;
  if (!img || typeof img.key !== 'string' || typeof img.mime !== 'string' || typeof img.ext !== 'string') return false;
  if (!Number.isSafeInteger(img.size) || img.size < 0 || img.size > MAX_IMAGE_BYTES) return false;
  return spooled ? img.bytes === undefined : img.bytes instanceof Uint8Array && img.bytes.byteLength === img.size;
};

/** A reply's pictures: every place in the list a picture, each named once, and no more bytes than one sync brings. */
const areSyncImages = (images: unknown[], spooled: boolean): images is SyncImage[] => {
  const keys = new Set<string>();
  let total = 0;
  // By index, so a list with a hole in it is refused rather than passed over.
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!isSyncImage(img, spooled) || keys.has(img.key)) return false;
    keys.add(img.key);
    total += img.size;
  }
  return total <= MAX_IMAGES_BYTES;
};

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
  converter: 'its converter could not put its records in shape',
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
  /** The pictures fetched; with a spool, the file at each one's place in the list holds its bytes (protocol.ts spoolFile). */
  images: SyncImage[];
  /** For a sample: the first few records as the source sent them. */
  raw?: unknown[];
  /** For an inspection: how many records the source has. */
  total?: number;
  /** The links in the records' text that kept only their words, when there were any. */
  droppedLinks?: DroppedLinks;
}

export interface SyncRunner {
  /**
   * Every record of a source, and the pictures of those that changed. Rejects with a SyncError whose message names
   * `name`, the source, and holds none of `request.secrets`.
   */
  run(name: string, request: Omit<SyncRequest, 'id'>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SyncResult>;
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
    run(name, request, { signal, timeoutMs: own } = {}) {
      return new Promise<SyncResult>((resolve, reject) => {
        const secrets = Object.values(request.secrets ?? {});
        // Always rejects: a detail that cannot be put in words is left out, never left to stop the sync from settling.
        const refuse = (code: SyncErrorCode, detail?: string) => {
          let message: string;
          try {
            message = syncFailureMessage(name, code, typeof detail === 'string' && detail ? redactSecrets(detail, secrets).slice(0, MAX_DETAIL) : undefined);
          } catch {
            message = syncFailureMessage(name, code);
          }
          reject(new SyncError(code, message));
        };
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
        const timer = setTimeout(() => fail('timeout'), own ?? timeoutMs);
        live.set(w, fail);
        signal?.addEventListener('abort', onAbort, { once: true });
        w.on('message', (m) => {
          if (!m || m.id !== id) return;
          if (m.ok === true && Array.isArray(m.records) && Array.isArray(m.images)) {
            // Checked again here: a reply is the worker's word, and the worker reads someone else's server.
            const inspected = request.mode === 'inspect';
            if (
              m.records.length > MAX_RECORDS ||
              !m.records.every((r) => recordProblem(r) === null) ||
              !areSyncImages(m.images, request.spool !== undefined) ||
              (m.raw !== undefined && (!Array.isArray(m.raw) || m.raw.length > SAMPLE_SIZE)) ||
              // An inspection is only ever the records as sent and how many there are: never one that reads as a sync of none.
              (inspected && (m.records.length || m.images.length || !Array.isArray(m.raw) || !Number.isSafeInteger(m.total) || (m.total as number) < m.raw.length)) ||
              (!inspected && m.total !== undefined) ||
              // Only records read into entries have links that were dropped.
              (m.droppedLinks !== undefined && (inspected || !isDroppedLinks(m.droppedLinks, m.records.length, typeof request.converter === 'string')))
            )
              fail('invalid');
            else
              finish(() =>
                resolve({
                  records: m.records,
                  images: m.images,
                  ...(m.raw ? { raw: m.raw } : {}),
                  ...(inspected ? { total: m.total } : {}),
                  ...(m.droppedLinks ? { droppedLinks: { count: m.droppedLinks.count, records: m.droppedLinks.records, first: [...m.droppedLinks.first] } } : {})
                })
              );
          }
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
