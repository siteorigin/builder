/**
 * The main process's side of the Git worker (#1152). One worker serves every project, started on the first request and
 * stopped once it has been idle for a while, and it takes one request at a time, in order: a save's commit and its
 * branch move can never interleave with another's. Requests waiting their turn are bounded in number and in the bytes
 * they carry, so a burst of saves is refused rather than held in memory.
 *
 * A request can be cancelled (its signal) or time out: one still waiting is dropped; the one in the worker is told to
 * stop, and if it does not answer soon the worker is ended. A worker that ends is always seen to have exited before the
 * next one starts, so two never write at once. A request lost with a worker while it was moving a branch is
 * `outcome-unknown`, never retried: the branch may have moved.
 */
import { GIT_LIMITS, GitError, inlineBytes, type CallOptions, type GitErrorCode, type GitOp, type GitReply, type GitRepository, type GitRequest } from './protocol';

/** The worker process as the client uses it: Electron's UtilityProcess, or a stand-in in tests. */
export interface GitWorkerHandle {
  postMessage(message: GitRequest): void;
  on(event: 'message', listener: (message: GitReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  /** A fatal error in the worker (an exit follows), or the worker having started. */
  on(event: 'error' | 'spawn', listener: () => void): unknown;
  /** False when the process has not started yet, or has already ended. */
  kill(): boolean;
}

export interface GitClientOptions {
  /** How long a request may take from when it is made, its wait for its turn included. */
  timeoutMs?: number;
  /** How long the worker has to stop a cancelled request before it is ended. */
  cancelGraceMs?: number;
  idleMs?: number;
  /** Requests waiting their turn, at most. */
  maxQueued?: number;
  /** The bytes those requests carry themselves, at most. */
  maxQueuedBytes?: number;
}

export interface GitClient {
  /** The versions repository of the project at `root`, an absolute path. */
  repository(root: string): GitRepository;
  /** The bundled Git's version, from the worker: proof that it starts. */
  version(opts?: CallOptions): Promise<string>;
  /** Stop the worker for good (the app is quitting): every request waiting or in progress is refused. */
  stop(): void;
}

const MESSAGES: Record<GitErrorCode, string> = {
  'not-found': 'That is not in the versions repository.',
  invalid: 'The versions repository was asked for something it cannot do.',
  'too-large': 'That is too large for the versions repository.',
  changed: 'A file changed while the version was being saved.',
  conflict: 'The branch moved since it was read.',
  locked: 'Another save is moving the branch.',
  corrupt: 'Part of the versions repository is damaged.',
  cancelled: 'The versions repository operation was stopped.',
  timeout: 'The versions repository took too long, so it was stopped.',
  'outcome-unknown': 'The versions repository stopped while it was moving the branch, which may or may not have moved: read it again.',
  crashed: 'The versions repository stopped unexpectedly.',
  stopped: 'The versions repository was stopped as the app quit.',
  busy: 'Too much is waiting for the versions repository.',
  failed: 'The versions repository could not be used.'
};
const fail = (code: GitErrorCode, message = MESSAGES[code], actual?: string | null) => new GitError(code, message, actual);

interface Job {
  op: GitOp;
  bytes: number;
  resolve: (value: unknown) => void;
  reject: (e: GitError) => void;
  id: number;
  /** Set once the worker has been told to stop it: why, as the caller will hear it. */
  stopping?: 'cancelled' | 'timeout';
  done: boolean;
  timer: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A typed array that owns exactly its bytes: sending a view would copy the whole buffer it is a view of. */
const owned = (b: Uint8Array): Uint8Array => (b instanceof Uint8Array && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b));
function ownBytes(op: GitOp): GitOp {
  if (op.op === 'writeBlob' && 'bytes' in op.input) return { ...op, input: { bytes: owned(op.input.bytes) } };
  if (op.op === 'writeFiles') return { ...op, files: op.files.map((f) => ('bytes' in f ? { path: f.path, bytes: owned(f.bytes) } : { path: f.path, source: f.source })) };
  return op;
}

export function createGitClient(spawn: () => GitWorkerHandle, opts: GitClientOptions = {}): GitClient {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const graceMs = opts.cancelGraceMs ?? 5000;
  const idleMs = opts.idleMs ?? 30_000;
  const maxQueued = opts.maxQueued ?? 16;
  const maxQueuedBytes = opts.maxQueuedBytes ?? 128 * 1024 * 1024;
  const queue: Job[] = [];
  let queuedBytes = 0;
  let active: Job | null = null;
  let worker: GitWorkerHandle | null = null;
  /**
   * A worker that was ended and has not exited yet: no other starts until it has, however long that takes, since a
   * worker still running could still be moving a branch. Requests wait meanwhile, and time out as ever.
   */
  let exiting: GitWorkerHandle | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let ids = 0;
  let stopped = false;

  /** What a request lost with its worker says: a branch move may have happened. */
  const lost = (job: Job, code: GitErrorCode) => (job.op.op === 'advanceRef' ? fail('outcome-unknown') : fail(code));

  const settle = (job: Job, outcome: { value: unknown } | { error: GitError }) => {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (job.grace) clearTimeout(job.grace);
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    if (active === job) active = null;
    const at = queue.indexOf(job);
    if (at >= 0) {
      queue.splice(at, 1);
      queuedBytes -= job.bytes;
    }
    if ('value' in outcome) job.resolve(outcome.value);
    else job.reject(outcome.error);
    queueMicrotask(pump);
  };

  const end = (w: GitWorkerHandle) => {
    if (worker === w) worker = null;
    exiting = w;
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };

  const ensure = (): GitWorkerHandle => {
    if (worker) return worker;
    const w = spawn();
    worker = w;
    w.on('message', (m) => {
      // A reply from a worker that has been replaced, or for a request already settled, belongs to nothing.
      if (worker !== w || !active || !m || m.id !== active.id) return;
      const job = active;
      if (m.ok) settle(job, { value: m.value });
      else if (m.code === 'cancelled' && job.stopping) settle(job, { error: fail(job.stopping) });
      else settle(job, { error: fail(m.code, typeof m.message === 'string' ? m.message : MESSAGES[m.code], m.actual) });
    });
    const gone = () => {
      if (exiting === w) exiting = null;
      if (worker !== w) return queueMicrotask(pump);
      worker = null;
      if (active) settle(active, { error: lost(active, active.stopping ?? 'crashed') });
      queueMicrotask(pump);
    };
    w.on('exit', gone);
    // Unhandled, an 'error' event would be thrown in the main process; an exit follows it.
    w.on('error', () => {
      if (worker !== w) return;
      if (active) settle(active, { error: lost(active, 'crashed') });
      end(w);
    });
    return w;
  };

  function pump() {
    if (stopped || active || exiting) return;
    const job = queue.shift();
    if (!job) {
      if (worker && !idle) {
        const w = worker;
        idle = setTimeout(() => {
          idle = null;
          if (worker === w && !active && !queue.length) end(w);
        }, idleMs);
        idle.unref?.();
      }
      return;
    }
    queuedBytes -= job.bytes;
    if (idle) clearTimeout(idle);
    idle = null;
    active = job;
    try {
      ensure().postMessage({ id: job.id, ...job.op } as GitRequest);
    } catch {
      // Never sent (the worker did not start, or was already gone): nothing was moved.
      const w = worker;
      settle(job, { error: fail('crashed') });
      if (w) end(w);
    }
  }

  /** Stop a request: dropped if it is waiting, told to stop if it is in the worker, and the worker ended if it does not. */
  const stop = (job: Job, why: 'cancelled' | 'timeout') => {
    if (job.done) return;
    if (active !== job) return settle(job, { error: fail(why) });
    if (job.stopping) return;
    job.stopping = why;
    const w = worker;
    try {
      w?.postMessage({ id: ++ids, op: 'cancel', target: job.id });
    } catch {
      // It is going down anyway.
    }
    job.grace = setTimeout(() => {
      if (job.done) return;
      settle(job, { error: lost(job, why) });
      if (w) end(w);
    }, graceMs);
  };

  const submit = (op: GitOp, call: CallOptions = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(fail('stopped'));
      if (call.signal?.aborted) return reject(fail('cancelled'));
      const bytes = inlineBytes(op);
      // More than the worker takes is refused here, before it is copied or sent.
      if (bytes > GIT_LIMITS.maxInlineBytes) return reject(fail('too-large'));
      // A request that has to wait counts against the queue's bounds; one the worker takes at once does not.
      const waits = !!(active || exiting || queue.length);
      if (waits && (queue.length >= maxQueued || queuedBytes + bytes > maxQueuedBytes)) return reject(fail('busy'));
      const job: Job = { op: ownBytes(op), bytes, resolve, reject, id: ++ids, done: false, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      job.timer = setTimeout(() => stop(job, 'timeout'), call.timeoutMs ?? timeoutMs);
      if (call.signal) {
        job.signal = call.signal;
        job.onAbort = () => stop(job, 'cancelled');
        call.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      queue.push(job);
      queuedBytes += bytes;
      pump();
    });

  return {
    repository(root) {
      const r = <T>(op: GitOp, call?: CallOptions) => submit(op, call) as Promise<T>;
      return {
        init: (call) => r<void>({ op: 'init', root }, call).then(() => undefined),
        exists: (call) => r<boolean>({ op: 'exists', root }, call),
        writeBlob: (input, call) => r({ op: 'writeBlob', root, input }, call),
        writeFiles: (files, call) => r({ op: 'writeFiles', root, files: [...files] }, call),
        writeCommit: (commit, call) => r({ op: 'writeCommit', root, commit }, call),
        readBlob: (oid, filepath, call) => r({ op: 'readBlob', root, oid, ...(filepath !== undefined ? { filepath } : {}) }, call),
        readTree: (oid, call) => r({ op: 'readTree', root, oid }, call),
        readCommit: (oid, call) => r({ op: 'readCommit', root, oid }, call),
        listCommits: (ref, limit, call) => r({ op: 'listCommits', root, ref, limit }, call),
        resolveRef: (ref, call) => r({ op: 'resolveRef', root, ref }, call),
        advanceRef: (ref, next, expected, call) => r<void>({ op: 'advanceRef', root, ref, next, expected }, call).then(() => undefined)
      };
    },
    version: (call) => submit({ op: 'version' }, call) as Promise<string>,
    stop() {
      if (stopped) return;
      stopped = true;
      if (idle) clearTimeout(idle);
      idle = null;
      for (const job of [...queue]) settle(job, { error: fail('stopped') });
      if (active) settle(active, { error: lost(active, 'stopped') });
      if (worker) end(worker);
    }
  };
}
