/**
 * The one shape every AI tool result takes: whether the call worked and the project revision it
 * reflects, then the tool's own fields beside them on success, or why it failed. A model handles every tool's failure
 * the same way: read `ok`, look at `error.code`, and try again only when `error.recoverable` is true.
 */
import type { EditorOpening, FieldLocation } from '@shared/api';
import type { EditOperation, ToolError, ToolErrorCode } from '@shared/ops';

export type { ToolError, ToolErrorCode };

/** A success: the tool's own fields sit beside `ok` and `revision`, which no tool's fields may reuse. */
export type ToolSuccessResult = { ok: true; revision: number } & Record<string, any>;
export interface ToolFailureResult {
  ok: false;
  revision: number;
  error: ToolError;
}
export type ToolResult = ToolSuccessResult | ToolFailureResult;

interface Landed {
  /** A field locate_field found, for the answer's "Open in inspector". */
  location?: FieldLocation;
  /** The page open_page resolved, for the editor to show (#1357). Nothing in the site changes. */
  openPage?: string;
  /** The entry, section or editor view open_in_editor resolved, for the editor to show (#1406). Nothing in the site changes. */
  openEditor?: EditorOpening;
  mutated?: boolean;
  ops?: EditOperation[];
  results?: unknown[];
  /** A page measurement as the preview gave it, before it was cut to fit the result (inspect_layout). */
  report?: unknown;
}

/**
 * What a tool's handler returns. `content` is the tool's own fields on success, or the failure; either may name the
 * revision it reflects (a change names the one it made), and executeTool gives the rest the revision the call read.
 */
export type ToolOutcome = ({ ok: true; content: Record<string, unknown> } & Landed) | { ok: false; content: { revision?: number; error: ToolError } };

/** An outcome whose content is the whole result the model sees; its `ok` is always the result's. */
export interface ResultOutcome extends Landed {
  ok: boolean;
  content: ToolResult;
}

/**
 * Whether a call that failed with a code can succeed when corrected or sent later in the same run, where the place that
 * refuses it does not say. A refusal no call in this run can get past (a read-only question, Developer mode, a held
 * update) says so itself.
 */
const RECOVERABLE: Record<ToolErrorCode, boolean> = {
  INVALID_ARGUMENT: true,
  STALE_REVISION: true,
  SCOPE_MISMATCH: true,
  PATH_DENIED: false,
  VALIDATION_FAILED: true,
  CONFLICT: false,
  CANCELLED: false,
  BUSY: true,
  ONE_CHANGE_PER_TURN: true,
  UPDATE_HELD: false,
  SAVE_FAILED: false
};

/** A failed call. `details`: what else the model needs to correct it, such as each field's problem. */
export function toolError(code: ToolErrorCode, message: string, opts: { details?: unknown; recoverable?: boolean; revision?: number } = {}): Extract<ToolOutcome, { ok: false }> {
  const error: ToolError = { code, message, recoverable: opts.recoverable ?? RECOVERABLE[code], ...(opts.details !== undefined ? { details: opts.details } : {}) };
  return { ok: false, content: { ...(opts.revision !== undefined ? { revision: opts.revision } : {}), error } };
}

/**
 * A change that was refused, as the session (or the run's own guard) said, at the revision it reports. `also`: what
 * the tool adds to the message, such as how to send the change so it can work.
 */
export function applyFailure(res: { revision: number; error?: ToolError }, also?: string): Extract<ToolOutcome, { ok: false }> {
  const error: ToolError = res.error ?? { code: 'VALIDATION_FAILED', message: 'The change was not applied.', recoverable: true };
  return { ok: false, content: { revision: res.revision, error: also ? { ...error, message: `${error.message} ${also}` } : error } };
}

/** The outcome with its whole result: `revision` is the one the call read, where the outcome does not name its own. */
export function stamp(outcome: ToolOutcome | ResultOutcome, revision: number): ResultOutcome {
  const { ok: _ok, revision: own, error, ...fields } = outcome.content as Record<string, unknown> & { error?: ToolError };
  const at = typeof own === 'number' ? own : revision;
  if (!outcome.ok) return { ok: false, content: { ok: false, revision: at, error: error! } };
  // The envelope's own fields are never a tool's: a tool's `error` or `ok` would contradict it.
  return { ...outcome, ok: true, content: { ok: true, revision: at, ...fields } };
}

/** A result given again as it was, for a call delivered twice. */
export const replayed = (result: ToolResult): ResultOutcome => ({ ok: result.ok, content: result });

export const MAX_RESULT_CHARS = 24000;

/** How to see what a cut read left out, by tool. */
const MORE: Record<string, string> = {
  read_project: 'Read it with fewer sections.',
  read_page: 'Read one section at a time with read_page and its nodeId.',
  read_component: 'Read its structure a part at a time with structure and offset.',
  read_source: 'Read fewer lines at a time with startLine and endLine.',
  inspect_element: 'Read one field at a time with prop (and offset for a long one).',
  search_components: 'Search with a lower limit or narrower words.',
  search_assets: 'Search with a lower limit or narrower words.',
  list_collection_entries: 'List the rest from a later offset.',
  read_collection_entry: 'Read the rest from a later offset.',
  read_layout: 'Read one section at a time with read_layout and its nodeId.',
  audit_seo: 'Audit one page or one pillar, or page through the findings with offset.',
  audit_performance: 'Audit one page with route, or page through the rows with offset.'
};

/** The longest start of `s` whose JSON form fits in `room` characters, never splitting a character in two. */
function fitText(s: string, room: number): string {
  if (JSON.stringify(s).length <= room) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(s.slice(0, mid)).length <= room) lo = mid;
    else hi = mid - 1;
  }
  return /[\uD800-\uDBFF]/.test(s.charAt(lo - 1)) ? s.slice(0, lo - 1) : s.slice(0, lo);
}

/** A field this small stays whole beside a cut, so the IDs, hashes, ranges and counts a reader goes on are never lost. */
const KEEP_CHARS = 300;
/** How much of a cut result the fields kept whole may take. */
const KEEP_ROOM = MAX_RESULT_CHARS / 4;
/** The names a cut result gives its own fields: a tool's field of the same name goes into partial instead. */
const CUT_FIELDS = new Set(['truncated', 'leftOut', 'note', 'partial']);
/** At most this many names in leftOut, each at most NAME_CHARS long, so naming what was cut never overflows the cut. */
const MAX_NAMED = 20;
const NAME_CHARS = 60;

/**
 * A result as the model receives it: whole when it fits the size limit, else cut so `ok`, `revision`, any `error` (its
 * code, recoverable and message) and every small field stay fields of their own, `leftOut` names what was cut short or
 * left out, `note` says how to see it, and `partial` holds the start of the rest as JSON text.
 * `tool`: which tool it came from; `applied`: the call changed the project, so it must never be sent again for the rest.
 */
export function serializeResult(result: ToolResult, tool = '', applied = false): string {
  // What the author is shown of a failure is theirs: the model reads its own message.
  if (!result.ok && result.error.author !== undefined) {
    const { author: _author, ...error } = result.error;
    result = { ...result, error };
  }
  const whole = JSON.stringify(result);
  if (whole.length <= MAX_RESULT_CHARS) return whole;
  let head: Record<string, unknown>;
  let rest: Record<string, unknown>;
  let at = '';
  let how: string;
  let shortened = false;
  if (result.ok) {
    const { ok, revision, ...fields } = result;
    const kept: Record<string, unknown> = {};
    rest = {};
    let room = KEEP_ROOM;
    for (const [k, v] of Object.entries(fields)) {
      const size = k.length + (JSON.stringify(v) ?? '').length + 4;
      if (!CUT_FIELDS.has(k) && k.length <= NAME_CHARS && size <= KEEP_CHARS && size <= room) {
        kept[k] = v;
        room -= size;
      } else rest[k] = v;
    }
    head = { ok, revision, ...kept };
    how = applied ? 'The change was applied: only this report of it was cut. Do not send the call again; read what it changed to see the rest.' : (MORE[tool] ?? 'Ask for less (one item or a narrower range) to see the rest.');
  } else {
    const { details, ...error } = result.error;
    // What went wrong comes first, so a message too long to sit beside anything else keeps its start.
    const message = fitText(error.message, MAX_RESULT_CHARS / 2);
    shortened = message !== error.message;
    head = { ok: false, revision: result.revision, error: { ...error, message: shortened ? `${message}… (cut)` : message } };
    rest = details === undefined ? {} : { details };
    at = 'error.';
    how = error.recoverable ? 'Correct what the message names and try again.' : 'No call can do this in this request: do not try it again, and follow what the message says instead.';
  }
  const keys = Object.keys(rest);
  const body = JSON.stringify(rest);
  // Where each field of the rest ends in its JSON text, to name the ones a cut reaches.
  const ends = keys.map((_, i) => JSON.stringify(Object.fromEntries(Object.entries(rest).slice(0, i + 1))).length - 1);
  const named = (n: number) => {
    const out = [...(shortened ? ['error.message'] : []), ...keys.filter((_, i) => ends[i] > n).map((k) => `${at}${k.length > NAME_CHARS ? `${k.slice(0, NAME_CHARS)}…` : k}`)];
    return out.length > MAX_NAMED ? [...out.slice(0, MAX_NAMED), `and ${out.length - MAX_NAMED} more`] : out;
  };
  const note = (n: number) => `This result was ${whole.length} characters, more than the ${MAX_RESULT_CHARS} one result holds: leftOut names what was cut short or left out${n > 0 ? ', and partial holds the start of it as JSON text' : ''}. ${how}`;
  const cut = (n: number) => ({ ...head, truncated: true, leftOut: named(n), note: note(n), ...(n > 0 ? { partial: body.slice(0, n) } : {}) });
  let lo = 0;
  // A start of the rest longer than a whole result never fits, whatever it escapes to.
  let hi = keys.length ? Math.min(body.length, MAX_RESULT_CHARS) : 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(cut(mid)).length <= MAX_RESULT_CHARS) lo = mid;
    else hi = mid - 1;
  }
  // Never half a character: a lone surrogate is valid JSON text but not a character.
  if (lo > 0 && /[\uD800-\uDBFF]/.test(body.charAt(lo - 1))) lo--;
  const out = JSON.stringify(cut(lo));
  if (out.length <= MAX_RESULT_CHARS) return out;
  // Bounded as everything above is, this is never reached; the envelope alone is the last resort.
  const { ok, revision } = result;
  return JSON.stringify({ ok, revision, ...(result.ok ? {} : { error: head.error }), truncated: true, leftOut: ['everything else'], note: note(0) });
}

/** What the model is told when the author saved edits of their own while it waited for their answer (#1281). */
export const AUTHOR_EDITS_NOTE =
  'While you waited for this answer, the author saved edits of their own (authorEdits), so the project has changed since you last read it. Keep their edits: read what they changed again before you change anything there.';

/** A question's answer, with what the author saved while it waited (ToolHost.authorEdits in tools.ts), if anything. */
export function answered(answer: string, host: { authorEdits?(): string[] }): { answer: string; authorEdits?: string[]; note?: string } {
  const edits = host.authorEdits?.() ?? [];
  return edits.length ? { answer, authorEdits: edits, note: AUTHOR_EDITS_NOTE } : { answer };
}
