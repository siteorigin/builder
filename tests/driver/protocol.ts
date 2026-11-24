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
 * `act` does what a person could: close the window, choose a menu item, and the `ui.*` inputs (click, hover, fill,
 * type, select, press, scroll, drag) on observed targets.
 *
 * Observations (`ui.snapshot`, `ui.locate`) return refs: opaque strings that name one element in one document of one
 * window of this session. A ref stays the same while that element keeps its role and name in that document; anything
 * else (a reload, another page or project, a replaced window, a renamed element) makes it STALE_REF, never a
 * different element.
 *
 * Actions (`ui.click` ... `ui.drag`) take a ref, or a point on the latest screenshot an observation saved (its
 * `observation` token), and send real input: the pointer and keyboard of the editor window, so the app's own handlers
 * run. Before any input they check that a person could do it now (visible, enabled, not under a modal, not covered by
 * something else at the point), waiting at most `waitMs`; a target that never becomes actionable is NOT_ACTIONABLE
 * with `details.dispatched: 'none'`, and nothing was sent. An outdated screenshot point is STALE_OBSERVATION.
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
  'CLEANUP_FAILED',
  /**
   * A ref no longer names what it was given for: another window, project or document, an element gone or renamed, or
   * a ref this session never gave out. `details.reason` says which and `details.hint` how to get a fresh one.
   */
  'STALE_REF',
  /** More than one element fits the target. `details.candidates` lists them with refs and regions to choose by. */
  'AMBIGUOUS_TARGET',
  /** Nothing fits the target. */
  'TARGET_NOT_FOUND',
  /**
   * The target is there but a person could not do this to it now: `details.reason` says why (hidden, disabled, inert
   * under a dialog, obscured by `details.blocker`, offscreen, unstable, not editable, not focused, an option missing),
   * `details.dispatched` whether any input was sent ('none', 'partial'), and `details.waitedMs` how long it waited.
   */
  'NOT_ACTIONABLE',
  /**
   * A screenshot point no longer stands for what the screenshot showed: another screenshot, an action since, the
   * window, project, page, viewport, zoom or scroll changed, or it expired. `details.reason` says which.
   */
  'STALE_OBSERVATION'
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

// ---------------------------------------------------------------------------
// UI observations (issue #492)
// ---------------------------------------------------------------------------

/** Where an observation looks: the editor's own UI, the live preview of the site, or both. */
export type UiScope = 'editor' | 'preview' | 'all';

/** What `ui.snapshot` accepts. */
export interface SnapshotArgs {
  /** Default `all`. */
  scope?: UiScope;
  /** A ref from an earlier observation: show what is inside it (drill-down). Its scope is the ref's own. */
  within?: string;
  /**
   * Continue after this ref among its siblings (a continuation's `after`): inside `within`, or at the top of one
   * `scope`. Siblings added or removed meanwhile do not shift it; a ref that is gone is STALE_REF.
   */
  after?: string;
  /** Continue from this index among the siblings (a continuation's `offset`, for a last child without a ref). */
  offset?: number;
  /** The most nodes to return (default 200, at most 1000), shared between the scopes. */
  maxNodes?: number;
  /** Levels below the roots to return; unbounded unless given (the node budget still applies). */
  depth?: number;
  /** Save PNGs of the editor window and of the preview as it shows in it, in the session's artifacts. */
  screenshot?: boolean;
}

/** What `ui.locate` accepts: a ref to look at again, or a role (and name) to find. */
export interface LocateArgs {
  ref?: string;
  role?: string;
  name?: string;
  /** Name matching: exact (default, after whitespace is collapsed) or a case-insensitive substring. */
  exact?: boolean;
  /** Only inside a region: its role, its name or `role "name"`, as region paths show them. */
  region?: string;
  /** Only inside the element a ref names. */
  within?: string;
  /** Default `all`. */
  scope?: UiScope;
}

// ---------------------------------------------------------------------------
// Actions (issue #493)
// ---------------------------------------------------------------------------

/** A position in CSS pixels. */
export interface XY {
  x: number;
  y: number;
}

/** An element an observation gave a ref for. */
export interface RefTarget {
  ref: string;
}

/**
 * A point on the latest screenshot an observation saved: `observation` is its token (`screenshots.observation`),
 * `surface` the image the point is on, and `x`, `y` are pixels from that image's top-left corner.
 */
export interface PointTarget {
  observation: string;
  surface: 'editor' | 'preview';
  x: number;
  y: number;
}

/** What a pointer acts on: an element (at `position` from its top-left, in its own document's CSS pixels; its middle
 *  by default), or a screenshot point (for handles that have no role of their own). */
export type PointerTarget = (RefTarget & { position?: XY }) | PointTarget;

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift' | 'ControlOrMeta';

/** Every action takes `waitMs`: how long to wait for its target to become actionable (default 3000, at most 10000). */
interface Waits {
  waitMs?: number;
}

export interface ClickArgs extends Waits {
  target: PointerTarget;
  /** Default left. */
  button?: 'left' | 'right';
  /** 2 is a double click (left only). Default 1. */
  count?: 1 | 2;
  /** Held while clicking. */
  modifiers?: Modifier[];
}

export interface HoverArgs extends Waits {
  target: PointerTarget;
}

/** Replace a text field's (or editable text's) contents; empty text clears it. Nothing is committed. */
export interface FillArgs extends Waits {
  target: RefTarget;
  text: string;
}

/** Type key by key: into the target, or into what has the keyboard focus (which must be editable). */
export interface TypeArgs extends Waits {
  target?: RefTarget;
  text: string;
}

/** Choose one option of a single-choice <select>, by its label or value. */
export interface SelectArgs extends Waits {
  target: RefTarget;
  option: { label: string } | { value: string };
}

/** Press one key chord ("Escape", "Shift+Tab", "ControlOrMeta+Shift+z"): on the target, or on what has the focus. */
export interface PressArgs extends Waits {
  target?: RefTarget;
  key: string;
}

/** Turn the mouse wheel over the target, by CSS pixels. */
export interface ScrollArgs extends Waits {
  target: PointerTarget;
  deltaX?: number;
  deltaY?: number;
}

/**
 * Press on `from`, move to `to` (a drop target) or `by` (an offset in the editor window's CSS pixels, for a handle that
 * holds the pointer, such as a resize edge) in `steps` moves (default 12), and release.
 */
export interface DragArgs extends Waits {
  from: PointerTarget;
  to?: PointerTarget;
  by?: XY;
  steps?: number;
}

/** What received the input. */
export interface Hit {
  surface: 'editor' | 'preview';
  /** The target's ref, for a ref target. */
  ref?: string;
  role?: string;
  name?: string;
  /** The element under the pointer, for a screenshot point: its tag, and its role and name where it has them. */
  tag?: string;
  /** Where the pointer was, in the editor window's CSS pixels (pointer actions only). */
  point?: XY;
  /** The same point in the preview page's own CSS pixels, for a preview hit. */
  at?: XY;
}

export interface ActionResult {
  /** Every input the action meant to send was sent. What it changed is for observations to check. */
  dispatched: 'complete';
  /** The element acted on (for a drag, where it started; for keys, what had the focus). */
  target: Hit;
  /** Where a drag was released. */
  destination?: Hit;
  /** The target was scrolled into view first. */
  scrolled?: true;
  /** The option chosen, for ui.select. */
  selected?: { label: string; value: string };
  /** How long it waited for the target to become actionable. */
  waitedMs: number;
}
