/**
 * The test driver's wire contract, version 1. A client sends requests and gets back exactly one reply for each, over
 * any line transport (the stdio host frames each as one JSON line). Replies are matched to requests by `id`, which a
 * client keeps unique among its requests still waiting for a reply; they come in the order requests finish, so a
 * refusal (BUSY) can arrive before the reply to the request it was refused behind. Later work adds operations; it
 * never changes the meaning of a field here without raising PROTOCOL_VERSION.
 *
 * Request  { v: 1, id, op, args?, timeoutMs?, expectWindow? }
 * Success  { v: 1, id, op, ok: true,  sessionId, window, elapsedMs, events, result }
 * Failure  { v: 1, id, op, ok: false, sessionId, window, elapsedMs, events, error: { code, message, retryable, details? } }
 *
 * `id` correlates a reply with its request; a frame too broken to read one is answered with `id: null`. `window` names
 * the editor window the session is bound to when the reply was made (null before the app starts and after it ends).
 * `events` are things the session saw happen since the previous reply (any reply), such as the window being replaced.
 *
 * `retryable` on an error says whether the same request may succeed later without the client changing it: after the
 * request it was refused behind has its reply (BUSY), or once the app has brought up a window (WINDOW_CLOSED). Only an
 * `observe` request is safe to repeat blindly; anything else may have taken effect before it failed.
 *
 * session.close always runs to the end of its bounded teardown: a deadline on it does not cut cleanup short.
 *
 * Every operation has a kind, so a record of a run tells what a person could have done from how the test got there:
 * `session` manages the run itself, `observe` only reads, `fixture` prepares state no person made through the UI, and
 * `act` does what a person could (none yet; later issues add them).
 */

export const PROTOCOL_VERSION = 1;

/** The largest request frame accepted, in characters. */
export const MAX_FRAME = 1024 * 1024;

/** The longest deadline a request may ask for. */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export type OpKind = 'session' | 'observe' | 'fixture' | 'act';

export interface Request {
  v: 1;
  id: string;
  op: string;
  args?: Record<string, unknown>;
  /** Overrides the operation's default deadline, in ms. */
  timeoutMs?: number;
  /** Refuse to run against any editor window but this generation (see WindowRef). */
  expectWindow?: number;
}

/** The editor window a session is bound to. A new generation means a different native window. */
export interface WindowRef {
  /** Counts the editor windows the session has bound, from 1. */
  generation: number;
  /** Electron's BrowserWindow id. */
  nativeId: number;
}

export type SessionEvent =
  | { type: 'window.closed'; at: string; generation: number }
  | { type: 'window.replaced'; at: string; from: number; to: number }
  | { type: 'app.exited'; at: string; code: number | null; signal: string | null }
  | { type: 'page.error'; at: string; generation: number; message: string }
  /** More events happened than a reply carries; this many of the oldest were left out. */
  | { type: 'events.dropped'; at: string; count: number };

export const ERROR_CODES = [
  /** The frame is not a request: not JSON, missing fields, a field of the wrong type, or too large. */
  'BAD_REQUEST',
  /** The request names a protocol version this session does not speak. */
  'UNSUPPORTED_VERSION',
  /** No operation by that name; `session.describe` lists the ones there are. */
  'UNKNOWN_OP',
  /** Another request is still running: requests are handled one at a time. */
  'BUSY',
  /** The operation needs a started session. */
  'NOT_STARTED',
  /** The session is already started. */
  'ALREADY_STARTED',
  /** The built app is missing: run `npm run build`. */
  'BUILD_MISSING',
  /** The app did not start, or started without the isolation the session requires. */
  'LAUNCH_FAILED',
  /** The request's deadline passed. `details.phase` says where; `details.sessionState` says whether the session lives on. */
  'TIMEOUT',
  /** The bound editor window is gone and none has replaced it. */
  'WINDOW_CLOSED',
  /** Another editor window replaced the bound one; resend with `expectWindow` set to `details.to` to use it. */
  'WINDOW_REPLACED',
  /** The app is no longer running. */
  'APP_EXITED',
  /** The session is closed or closing. */
  'CLOSED',
  /** The operation ran and failed. */
  'OP_FAILED',
  /** Teardown could not prove every owned process ended, or found data it does not own where it expected its own. */
  'CLEANUP_FAILED'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  /** Whether the same request, unchanged, may succeed later (see the note on `retryable` above). */
  retryable: boolean;
  details?: Record<string, unknown>;
}

interface ReplyBase {
  v: 1;
  id: string | null;
  op: string | null;
  sessionId: string | null;
  window: WindowRef | null;
  elapsedMs: number;
  events: SessionEvent[];
}

export interface Success<T = unknown> extends ReplyBase {
  id: string;
  op: string;
  ok: true;
  result: T;
}

export interface Failure extends ReplyBase {
  ok: false;
  error: ErrorInfo;
}

export type Reply<T = unknown> = Success<T> | Failure;

/** A failure an operation throws; anything else thrown becomes OP_FAILED. */
export class DriverError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.details) this.details = opts.details;
  }
}

export function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof DriverError) return { code: e.code, message: e.message, retryable: e.retryable, ...(e.details ? { details: e.details } : {}) };
  return { code: 'OP_FAILED', message: e instanceof Error ? e.message : String(e), retryable: false };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a frame says about itself, for answering one that is not a valid request. */
export function frameIdentity(frame: unknown): { id: string | null; op: string | null } {
  if (!isRecord(frame)) return { id: null, op: null };
  return { id: typeof frame.id === 'string' && frame.id ? frame.id : null, op: typeof frame.op === 'string' && frame.op ? frame.op : null };
}

/** Read one request. Throws DriverError (BAD_REQUEST or UNSUPPORTED_VERSION) for anything else. */
export function parseRequest(frame: unknown): Request {
  if (typeof frame === 'string') {
    if (frame.length > MAX_FRAME) throw new DriverError('BAD_REQUEST', `A request may be at most ${MAX_FRAME} characters.`);
    try {
      frame = JSON.parse(frame);
    } catch {
      throw new DriverError('BAD_REQUEST', 'The request is not JSON.');
    }
  }
  if (!isRecord(frame)) throw new DriverError('BAD_REQUEST', 'A request is a JSON object.');
  if (frame.v !== PROTOCOL_VERSION) {
    if (typeof frame.v === 'number') throw new DriverError('UNSUPPORTED_VERSION', `This session speaks protocol version ${PROTOCOL_VERSION}, not ${frame.v}.`, { details: { supported: [PROTOCOL_VERSION] } });
    throw new DriverError('BAD_REQUEST', `A request names its protocol version in "v" (${PROTOCOL_VERSION}).`);
  }
  if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 200) throw new DriverError('BAD_REQUEST', 'A request has an "id": a non-empty string of at most 200 characters.');
  if (typeof frame.op !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(frame.op)) throw new DriverError('BAD_REQUEST', 'A request has an "op" such as "session.describe".');
  if (frame.args !== undefined && !isRecord(frame.args)) throw new DriverError('BAD_REQUEST', '"args" is a JSON object when given.');
  if (frame.timeoutMs !== undefined && (!Number.isInteger(frame.timeoutMs) || (frame.timeoutMs as number) <= 0 || (frame.timeoutMs as number) > MAX_TIMEOUT_MS))
    throw new DriverError('BAD_REQUEST', `"timeoutMs" is a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}.`);
  if (frame.expectWindow !== undefined && (!Number.isInteger(frame.expectWindow) || (frame.expectWindow as number) < 1)) throw new DriverError('BAD_REQUEST', '"expectWindow" is a window generation: a whole number from 1.');
  const request: Request = { v: PROTOCOL_VERSION, id: frame.id, op: frame.op };
  if (frame.args !== undefined) request.args = frame.args as Record<string, unknown>;
  if (frame.timeoutMs !== undefined) request.timeoutMs = frame.timeoutMs as number;
  if (frame.expectWindow !== undefined) request.expectWindow = frame.expectWindow as number;
  return request;
}

export interface ReplyContext {
  sessionId: string | null;
  window: WindowRef | null;
  elapsedMs: number;
  events: SessionEvent[];
}

export function success<T>(request: Pick<Request, 'id' | 'op'>, result: T, ctx: ReplyContext): Success<T> {
  return { v: PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, sessionId: ctx.sessionId, window: ctx.window, elapsedMs: ctx.elapsedMs, events: ctx.events, result };
}

export function failure(request: { id: string | null; op: string | null }, error: unknown, ctx: ReplyContext): Failure {
  return { v: PROTOCOL_VERSION, id: request.id, op: request.op, ok: false, sessionId: ctx.sessionId, window: ctx.window, elapsedMs: ctx.elapsedMs, events: ctx.events, error: errorInfo(error) };
}

/** One operation's entry in `session.describe`. */
export interface Capability {
  op: string;
  kind: OpKind;
  defaultTimeoutMs: number;
  /** Whether it needs a started session. */
  needsApp: boolean;
  /** Whether it runs against the bound editor window (and so honours `expectWindow`). */
  usesWindow: boolean;
  summary: string;
}

/** What `session.start` accepts. Every field is optional. The request's `timeoutMs` is one deadline for the whole start. */
export interface StartArgs {
  /** The state the app opens in: the Welcome screen (default) or a named, reproducible project fixture. */
  fixture?: FixtureName;
  /** The AI provider the app is set up with: a scripted local server that costs nothing (default), or none. */
  provider?: 'scripted' | 'none';
  /** When the session's artifacts outlive it. Default: when the session ended in failure. */
  keepArtifacts?: KeepArtifacts;
  /** A folder the caller owns, to hold this session's artifacts in a new child folder. Never deleted. */
  artifactsDir?: string;
  /** Show the window (for a person debugging a script). Off unless asked for. */
  headed?: boolean;
}

export type FixtureName = 'welcome' | 'business-v1';
export type KeepArtifacts = 'always' | 'on-failure' | 'never';

/** What `session.close` accepts. Only the first close decides; a later one gets the same result. */
export interface CloseArgs {
  /** Overrides the session's keepArtifacts for this close. */
  keepArtifacts?: KeepArtifacts;
  /** Marks the run as failed, for `on-failure`. */
  failed?: boolean;
}

export interface CloseResult {
  /** Where the kept artifacts are, or null when none were kept. */
  artifacts: string | null;
  /** The run-owned folders removed. */
  removed: string[];
  /** Every process the session found it owned while closing. */
  processes: number[];
  /** Whether the app quit on its own before the deadline, or had to be killed. */
  ended: 'quit' | 'killed' | 'not-started' | 'already-exited';
}
