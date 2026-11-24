/**
 * Actions for the test driver (issue #493): the half that does what a person could. Every action names its target as
 * an observation gave it (a ref, or a point on the latest screenshot), checks that a person could act on it now, and
 * sends real input through the editor window's pointer and keyboard, so the app's own handlers run.
 *
 * The driver aims the pointer itself. The live preview is an out-of-process iframe inside the canvas's scaled frame,
 * and Playwright's own element actions place points there without the canvas zoom (and skip the hit test of the editor
 * over the frame), so a point is measured in the target's own document, mapped through the frame's box and scale, and
 * hit-tested in both documents: the editor must show the frame there, and the page the target.
 *
 * Before any input: the target is connected, visible, not under a modal (inert), enabled and editable where that
 * matters, in view (a ref target of a single-target action is scrolled into view first), stable across two reads and
 * the topmost thing at the point (a nested control of its own counts as something else). These are retried until
 * `waitMs` runs out, and a target that never qualifies fails as NOT_ACTIONABLE with nothing sent. The pointer moves to
 * the point and the checks run once more, so a hover that brings something up under the pointer stops the action.
 * While a button is pressed a guard in the receiving document lets through only events that reach the target, so a
 * row a timer scrolled under the pointer in between gets nothing.
 *
 * Nothing in this module is reachable from a request but the typed actions: no script, selector, IPC or engine
 * operation goes over the wire.
 */
import type { ElementHandle, Frame, Page } from 'playwright';
import { DriverError } from './protocol.ts';
import type { ActionResult, Hit, Modifier, PointTarget, PointerTarget, RefTarget, XY } from './protocol.ts';
import { PREVIEW_IFRAME, frameSecrets, resolveInto, sealed } from './observe.ts';
import type { ObserveEnv, Resolved, Resolution } from './observe.ts';
import { looksLikeRef } from './snapshot.ts';
import { SHOT_WITNESS_KEY, imagePoint, intoFrame, looksLikeObservation, readScene, sceneChange } from './shots.ts';
import type { ShotRecord, ShotRegistry, Witness } from './shots.ts';

type Dom = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const ACTION_OPS = ['ui.click', 'ui.hover', 'ui.fill', 'ui.type', 'ui.select', 'ui.press', 'ui.scroll', 'ui.drag'] as const;
export type ActionOp = (typeof ACTION_OPS)[number];

export const ACTION_LIMITS = {
  waitMs: { default: 3000, max: 10_000 },
  /** Characters a fill may insert, and a type may type (typed one key at a time). */
  fill: 100_000,
  type: 2000,
  /** CSS pixels: a wheel turn, a drag offset, a position in an element or on an image. */
  wheel: 10_000,
  offset: 10_000,
  position: 100_000,
  steps: { default: 12, max: 100 },
  key: 100
};

export interface Chord {
  /** As written, for Playwright (ControlOrMeta stays: Playwright resolves it for the platform). */
  text: string;
  modifiers: Modifier[];
  key: string;
}

export type Action =
  | { op: 'ui.click'; target: PointerTarget; button: 'left' | 'right'; count: 1 | 2; modifiers: Modifier[]; waitMs: number }
  | { op: 'ui.hover'; target: PointerTarget; waitMs: number }
  | { op: 'ui.fill'; target: RefTarget; text: string; waitMs: number }
  | { op: 'ui.type'; target: RefTarget | null; text: string; waitMs: number }
  | { op: 'ui.select'; target: RefTarget; option: { label: string } | { value: string }; waitMs: number }
  | { op: 'ui.press'; target: RefTarget | null; chord: Chord; waitMs: number }
  | { op: 'ui.scroll'; target: PointerTarget; deltaX: number; deltaY: number; waitMs: number }
  | { op: 'ui.drag'; from: PointerTarget; to: PointerTarget | null; by: XY | null; steps: number; waitMs: number };

const bad = (message: string) => new DriverError('BAD_REQUEST', message);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function known(a: Record<string, unknown>, what: string, keys: string[]) {
  for (const k of Object.keys(a)) if (!keys.includes(k)) throw bad(`${what} does not take "${k}".`);
}

function num(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`"${what}" is a number from ${min} to ${max}.`);
  return v;
}

function xy(v: unknown, what: string, min: number, max: number): XY {
  if (!isRecord(v)) throw bad(`"${what}" is { "x": number, "y": number }.`);
  known(v, `"${what}"`, ['x', 'y']);
  return { x: num(v.x, `${what}.x`, min, max), y: num(v.y, `${what}.y`, min, max) };
}

function refTarget(v: unknown, what: string): RefTarget {
  if (!isRecord(v) || v.ref === undefined) throw bad(`"${what}" is { "ref": a ref from an observation }.`);
  known(v, `"${what}"`, ['ref']);
  if (!looksLikeRef(v.ref)) throw bad(`"${what}.ref" is a ref from an observation, such as "a1b2c3:12".`);
  return { ref: v.ref };
}

function pointerTarget(v: unknown, what: string): PointerTarget {
  if (!isRecord(v)) throw bad(`"${what}" is { "ref" } (with an optional "position"), or { "observation", "surface", "x", "y" } for a point on the latest screenshot.`);
  if (v.ref !== undefined && v.observation !== undefined) throw bad(`"${what}" is a ref or a screenshot point, not both.`);
  if (v.ref !== undefined) {
    known(v, `"${what}"`, ['ref', 'position']);
    if (!looksLikeRef(v.ref)) throw bad(`"${what}.ref" is a ref from an observation, such as "a1b2c3:12".`);
    return { ref: v.ref, ...(v.position !== undefined ? { position: xy(v.position, `${what}.position`, 0, ACTION_LIMITS.position) } : {}) };
  }
  if (v.observation === undefined) throw bad(`"${what}" needs a "ref", or an "observation" token for a screenshot point.`);
  known(v, `"${what}"`, ['observation', 'surface', 'x', 'y']);
  if (!looksLikeObservation(v.observation)) throw bad(`"${what}.observation" is the token a screenshot gave (screenshots.observation), such as "oa1b2c3-4".`);
  if (v.surface !== 'editor' && v.surface !== 'preview') throw bad(`"${what}.surface" is "editor" or "preview": the image the point is on.`);
  const p: PointTarget = { observation: v.observation, surface: v.surface, x: num(v.x, `${what}.x`, 0, ACTION_LIMITS.position), y: num(v.y, `${what}.y`, 0, ACTION_LIMITS.position) };
  return p;
}

function waitMs(v: unknown): number {
  if (v === undefined) return ACTION_LIMITS.waitMs.default;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > ACTION_LIMITS.waitMs.max) throw bad(`"waitMs" is a whole number of milliseconds from 0 to ${ACTION_LIMITS.waitMs.max}.`);
  return v as number;
}

function text(v: unknown, max: number, allowEmpty: boolean): string {
  if (typeof v !== 'string') throw bad('"text" is a string.');
  if (!allowEmpty && !v) throw bad('"text" is a non-empty string.');
  if (v.length > max) throw bad(`"text" is at most ${max} characters.`);
  return v;
}

export const MODIFIERS: readonly Modifier[] = ['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta'];

/** Named keys a chord may end in (Playwright's names). */
const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ContextMenu',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)
]);

/** Split a chord as Playwright does: a "+" right after another separator is the plus key itself. */
function splitChord(s: string): string[] {
  const out: string[] = [];
  let building = '';
  for (const c of s) {
    if (c === '+' && building) {
      out.push(building);
      building = '';
    } else building += c;
  }
  out.push(building);
  return out;
}

/**
 * One key chord: distinct modifiers, then one key (a named key, or one printable character of the US layout). The
 * whole chord is checked first: Playwright presses each modifier before it finds out the last key is unknown.
 */
export function parseChord(v: unknown, platform: NodeJS.Platform = process.platform): Chord {
  if (typeof v !== 'string' || !v) throw bad('"key" is a key chord, such as "Escape", "Shift+Tab" or "ControlOrMeta+z".');
  if (v.length > ACTION_LIMITS.key) throw bad(`"key" is at most ${ACTION_LIMITS.key} characters.`);
  const parts = splitChord(v);
  const key = parts.pop()!;
  const modifiers: Modifier[] = [];
  const seen = new Set<string>();
  for (const m of parts) {
    const found = MODIFIERS.find((x) => x === m);
    if (!found) {
      const like = MODIFIERS.find((x) => x.toLowerCase() === m.toLowerCase() || (m.toLowerCase() === 'ctrl' && x === 'Control') || (m.toLowerCase() === 'cmd' && x === 'Meta'));
      throw bad(`"${m}" is not a modifier${like ? ` (did you mean "${like}"?)` : ''}; a chord is modifiers (${MODIFIERS.join(', ')}) then one key, joined by "+".`);
    }
    const resolved = found === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : found;
    if (seen.has(resolved)) throw bad(`"${v}" names ${resolved} twice.`);
    seen.add(resolved);
    modifiers.push(found);
  }
  if (!key) throw bad(`"${v}" ends without a key.`);
  if ((MODIFIERS as readonly string[]).includes(key)) throw bad(`"${v}" ends in a modifier: a chord ends in the key pressed with them.`);
  if (!NAMED_KEYS.has(key) && !(key.length === 1 && key >= ' ' && key <= '~')) {
    const like = [...NAMED_KEYS].find((k) => k.toLowerCase() === key.toLowerCase() || (key.toLowerCase() === 'esc' && k === 'Escape') || (key.toLowerCase() === 'return' && k === 'Enter'));
    throw bad(`"${key}" is not a key${like ? ` (did you mean "${like}"?)` : ''}: use a named key such as Enter, Escape, Tab, ArrowDown, F2, or one printable character.`);
  }
  // Pasting reads the system clipboard, which belongs to the person running the session, not to it (menu.invoke
  // refuses the system Paste command for the same reason).
  const primary = modifiers.some((m) => m === 'Meta' || m === 'Control' || m === 'ControlOrMeta');
  if ((primary && (key === 'v' || key === 'V' || key === 'KeyV')) || (key === 'Insert' && modifiers.includes('Shift')))
    throw bad(`"${v}" pastes from the system clipboard, which is outside the session: put text in with ui.fill or ui.type.`);
  return { text: v, modifiers, key };
}

function modifiersArg(v: unknown, platform: NodeJS.Platform): Modifier[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 4) throw bad('"modifiers" is a list of up to four of ' + MODIFIERS.join(', ') + '.');
  // Each one a modifier by itself, then none twice for the platform (as a chord's are checked).
  for (const m of v) if (!(MODIFIERS as readonly unknown[]).includes(m)) throw bad(`"modifiers" holds ${JSON.stringify(m)}: each is one of ${MODIFIERS.join(', ')}.`);
  if (v.length) parseChord([...v, 'a'].join('+'), platform);
  return v as Modifier[];
}

/** Read one action's arguments. Throws BAD_REQUEST, before anything is looked at, for any it cannot do. */
export function parseAction(op: string, args: Record<string, unknown> = {}, platform: NodeJS.Platform = process.platform): Action {
  const a = args;
  switch (op) {
    case 'ui.click': {
      known(a, op, ['target', 'button', 'count', 'modifiers', 'waitMs']);
      const button = a.button ?? 'left';
      if (button !== 'left' && button !== 'right') throw bad('"button" is "left" or "right".');
      const count = a.count ?? 1;
      if (count !== 1 && count !== 2) throw bad('"count" is 1, or 2 for a double click.');
      if (count === 2 && button !== 'left') throw bad('A double click is with the left button.');
      return { op, target: pointerTarget(a.target, 'target'), button, count, modifiers: modifiersArg(a.modifiers, platform), waitMs: waitMs(a.waitMs) };
    }
    case 'ui.hover':
      known(a, op, ['target', 'waitMs']);
      return { op, target: pointerTarget(a.target, 'target'), waitMs: waitMs(a.waitMs) };
    case 'ui.fill':
      known(a, op, ['target', 'text', 'waitMs']);
      return { op, target: refTarget(a.target, 'target'), text: text(a.text, ACTION_LIMITS.fill, true), waitMs: waitMs(a.waitMs) };
    case 'ui.type':
      known(a, op, ['target', 'text', 'waitMs']);
      return { op, target: a.target === undefined ? null : refTarget(a.target, 'target'), text: text(a.text, ACTION_LIMITS.type, false), waitMs: waitMs(a.waitMs) };
    case 'ui.select': {
      known(a, op, ['target', 'option', 'waitMs']);
      const o = a.option;
      if (!isRecord(o) || Object.keys(o).length !== 1 || (typeof o.label !== 'string' && typeof o.value !== 'string')) throw bad('"option" is { "label": string } or { "value": string }.');
      return { op, target: refTarget(a.target, 'target'), option: typeof o.label === 'string' ? { label: o.label } : { value: o.value as string }, waitMs: waitMs(a.waitMs) };
    }
    case 'ui.press':
      known(a, op, ['target', 'key', 'waitMs']);
      return { op, target: a.target === undefined ? null : refTarget(a.target, 'target'), chord: parseChord(a.key, platform), waitMs: waitMs(a.waitMs) };
    case 'ui.scroll': {
      known(a, op, ['target', 'deltaX', 'deltaY', 'waitMs']);
      const deltaX = a.deltaX === undefined ? 0 : num(a.deltaX, 'deltaX', -ACTION_LIMITS.wheel, ACTION_LIMITS.wheel);
      const deltaY = a.deltaY === undefined ? 0 : num(a.deltaY, 'deltaY', -ACTION_LIMITS.wheel, ACTION_LIMITS.wheel);
      if (!deltaX && !deltaY) throw bad('A scroll turns the wheel: give "deltaX" or "deltaY" (CSS pixels, not both zero).');
      return { op, target: pointerTarget(a.target, 'target'), deltaX, deltaY, waitMs: waitMs(a.waitMs) };
    }
    case 'ui.drag': {
      known(a, op, ['from', 'to', 'by', 'steps', 'waitMs']);
      if ((a.to === undefined) === (a.by === undefined)) throw bad('A drag goes "to" a target or "by" an offset: give exactly one.');
      const by = a.by === undefined ? null : xy(a.by, 'by', -ACTION_LIMITS.offset, ACTION_LIMITS.offset);
      if (by && !by.x && !by.y) throw bad('"by" moves the pointer: it is not { "x": 0, "y": 0 }.');
      const steps = a.steps === undefined ? ACTION_LIMITS.steps.default : a.steps;
      if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > ACTION_LIMITS.steps.max) throw bad(`"steps" is a whole number from 1 to ${ACTION_LIMITS.steps.max}.`);
      return { op, from: pointerTarget(a.from, 'from'), to: a.to === undefined ? null : pointerTarget(a.to, 'to'), by, steps: steps as number, waitMs: waitMs(a.waitMs) };
    }
    default:
      throw new DriverError('UNKNOWN_OP', `There is no action "${op}".`);
  }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type NotActionableReason =
  | 'hidden'
  | 'disabled'
  | 'inert'
  | 'obscured'
  | 'offscreen'
  | 'unstable'
  | 'not-editable'
  | 'not-focused'
  | 'not-a-select'
  | 'option-missing'
  | 'option-ambiguous'
  | 'option-disabled'
  | 'position-outside'
  | 'outside-window'
  | 'no-movement'
  | 'moved'
  | 'focus-moved'
  | 'no-time';

export interface Blocker {
  surface: 'editor' | 'preview';
  tag: string;
  role?: string;
  name?: string;
}

/** Reasons the same request cannot succeed later: the gesture itself does not fit the target. */
const INVALID: ReadonlySet<NotActionableReason> = new Set(['not-a-select', 'option-ambiguous', 'position-outside', 'outside-window', 'no-movement']);

const HINTS: Record<NotActionableReason, string> = {
  hidden: 'It is not shown now; observe again to see what is.',
  disabled: 'It is disabled; whatever enables it comes first.',
  inert: 'A dialog covers it: finish or close the dialog first.',
  obscured: 'Something else (details.blocker) is on top of it at the point: close or move that, or aim at another point.',
  offscreen: 'It is out of view: scroll its container (ui.scroll) and observe again.',
  unstable: 'It kept moving; try again once it settles.',
  'not-editable': 'It does not take text now (a field, or text being edited, does).',
  'not-focused': 'The keyboard focus could not be put on it: click it first (ui.click), or in edit mode double-click text to edit it.',
  'not-a-select': 'ui.select chooses in a single-choice <select>; other lists are chosen in with ui.click.',
  'option-missing': 'No option has that label or value; observe the list to see its options.',
  'option-ambiguous': 'More than one option has that label: choose by "value".',
  'option-disabled': 'That option is disabled.',
  'position-outside': '"position" is measured from the element\'s top-left corner and must be inside its box.',
  'outside-window': 'The pointer would leave the editor window: choose a shorter offset.',
  'no-movement': 'A drag ends somewhere other than where it starts.',
  moved: 'Where the drag was going moved before it was released, so it was cancelled; observe again.',
  'focus-moved': 'Something moved the keyboard focus while typing (an Enter that commits, a field that moves on): observe, and type the rest where it belongs.',
  'no-time': 'The request\'s deadline left no time to act safely; give it a longer timeoutMs.'
};

export function notActionable(reason: NotActionableReason, o: { dispatched?: 'none' | 'partial'; waitedMs?: number; target?: Hit; blocker?: Blocker | null; dialog?: string | null; scrolled?: boolean; message?: string } = {}): DriverError {
  const dispatched = o.dispatched ?? 'none';
  const what = o.target ? `${o.target.role ?? o.target.tag ?? 'target'}${o.target.name ? ` "${o.target.name}"` : ''}` : 'the target';
  const message =
    o.message ??
    {
      hidden: `${what} is not visible.`,
      disabled: `${what} is disabled.`,
      inert: `${what} is behind ${o.dialog ? `the dialog "${o.dialog}"` : 'a dialog'}.`,
      obscured: `${what} is covered at the point by ${o.blocker ? `${o.blocker.role ?? o.blocker.tag}${o.blocker.name ? ` "${o.blocker.name}"` : ''}` : 'something else'}.`,
      offscreen: `${what} is out of view.`,
      unstable: `${what} kept moving.`,
      'not-editable': `${what} does not take text.`,
      'not-focused': `The keyboard focus could not be put on ${what}.`,
      'not-a-select': `${what} is not a single-choice <select>.`,
      'option-missing': `${what} has no such option.`,
      'option-ambiguous': `${what} has several options with that label.`,
      'option-disabled': `That option of ${what} is disabled.`,
      'position-outside': `The position is outside ${what}.`,
      'outside-window': 'The drag would end outside the editor window.',
      'no-movement': 'The drag would end where it starts.',
      moved: 'Where the drag was going moved before the release; it was cancelled.',
      'focus-moved': 'The keyboard focus moved while typing; the rest was not typed.',
      'no-time': 'No time was left before the deadline.'
    }[reason];
  return new DriverError('NOT_ACTIONABLE', `${message}${dispatched === 'none' ? ' Nothing was sent.' : ' Some input was sent before it stopped.'}`, {
    retryable: dispatched === 'none' && !INVALID.has(reason),
    details: {
      reason,
      dispatched,
      ...(o.waitedMs !== undefined ? { waitedMs: o.waitedMs } : {}),
      ...(o.target ? { target: o.target } : {}),
      ...(o.blocker ? { blocker: o.blocker } : {}),
      ...(o.dialog ? { dialog: o.dialog } : {}),
      ...(o.scrolled ? { scrolled: true } : {}),
      hint: HINTS[reason]
    }
  });
}

export function staleObservation(reason: string, observation: string): DriverError {
  const why: Record<string, string> = {
    unknown: 'is not a screenshot this session took',
    superseded: 'was replaced by a newer screenshot',
    acted: 'was taken before an action that has since sent input',
    expired: 'is too old',
    window: 'was taken in another editor window',
    project: 'was taken in another project, or another opening of this one',
    document: 'was taken of a page that has since been replaced',
    viewport: 'was taken at another window size',
    zoom: 'was taken at another preview zoom',
    moved: 'no longer shows what is at that point (it moved, or something scrolled)',
    scrolled: 'was taken with the preview scrolled elsewhere'
  };
  return new DriverError('STALE_OBSERVATION', `Observation "${observation}" ${why[reason] ?? 'no longer holds'}.`, {
    details: { observation, reason, hint: 'Take a new ui.snapshot with "screenshot": true and aim at its images (screenshots.observation).' }
  });
}

/** A miss is a reason the target cannot be acted on yet. */
interface Miss {
  miss: NotActionableReason;
  blocker?: Blocker | null;
}

const isMiss = (v: unknown): v is Miss => isRecord(v) && typeof v.miss === 'string';

// ---------------------------------------------------------------------------
// In the documents (each function runs in a page: Playwright sends its source)
// ---------------------------------------------------------------------------

interface Probe {
  connected: boolean;
  visible: boolean;
  inert: boolean;
  disabled: boolean;
  editable: boolean;
  secret: boolean;
  select: { multiple: boolean } | null;
  /** It holds the keyboard focus in its document (it is the active element, or the text it edits holds it). */
  focused: boolean;
  /** `position` is outside its box. */
  outside: boolean;
  scrolled: boolean;
  /** Points on it a person could press, in its document's viewport, best first: each hits it (or a part of it that is
   *  not a control of its own). */
  points: XY[];
  /** No part of it is in view. */
  offscreen: boolean;
  /** What is on top of it at its middle, when no point hits it. */
  blocker: Blocker | null;
  box: { x: number; y: number; width: number; height: number };
}

/** Runs in the element's document. */
function probeIn(el: Dom, a: { position: XY | null; scroll: boolean; center?: boolean; surface: 'editor' | 'preview' }): Probe {
  const w = globalThis as Dom;
  const d = w.document;
  const none = { connected: false, visible: false, inert: false, disabled: false, editable: false, secret: false, select: null, focused: false, outside: false, scrolled: false, points: [], offscreen: false, blocker: null, box: { x: 0, y: 0, width: 0, height: 0 } };
  if (!el.isConnected) return none;
  const CONTROL =
    'a[href],button,input,select,textarea,summary,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="treeitem"],[role="radio"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"],[role="searchbox"],[role="separator"][tabindex]';
  const IMPLICIT: Record<string, string> = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog', NAV: 'navigation', MAIN: 'main', IFRAME: 'iframe' };
  const up = (n: Dom) => n.parentNode ?? n.host ?? null;
  const within = (n: Dom) => {
    for (let x = n; x; x = up(x)) if (x === el) return true;
    return false;
  };
  const desc = (n: Dom) => {
    if (!n || n.nodeType !== 1) return null;
    const role = n.getAttribute('role') || IMPLICIT[n.tagName];
    // Never cut or respaced: a credential cut in two would no longer be found and scrubbed. Too long to give whole, left out.
    const own = n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt') || '';
    const said = n.tagName === 'INPUT' ? '' : String(n.textContent ?? '').trim();
    const name = own ? (own.length <= 200 ? own.trim() : '') : said.length <= 120 ? said : '';
    return { surface: a.surface, tag: String(n.tagName).toLowerCase(), ...(role ? { role } : {}), ...(name ? { name } : {}) };
  };
  const hitAt = (x: number, y: number) => {
    let h = d.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  };
  /** The control of its own between the hit and the target, if any. */
  const nested = (h: Dom) => {
    for (let x = h; x && x !== el; x = up(x)) if (x.nodeType === 1 && x.matches(CONTROL)) return x;
    return null;
  };
  /** The part of the element's box no clipping ancestor or the viewport hides. */
  const visiblePart = () => {
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0);
    let top = Math.max(r.top, 0);
    let right = Math.min(r.right, w.innerWidth);
    let bottom = Math.min(r.bottom, w.innerHeight);
    for (let p = el.parentElement; p && p !== d.documentElement; p = p.parentElement) {
      const o = w.getComputedStyle(p);
      const c = p.getBoundingClientRect();
      if (o.overflowX !== 'visible') {
        left = Math.max(left, c.left);
        right = Math.min(right, c.right);
      }
      if (o.overflowY !== 'visible') {
        top = Math.max(top, c.top);
        bottom = Math.min(bottom, c.bottom);
      }
    }
    return { r, left, top, right, bottom };
  };
  const style = w.getComputedStyle(el);
  // Under a modal nothing is scrolled for it: a person cannot reach it at all.
  const inert = !!el.closest('[inert]');
  let part = visiblePart();
  const visible = part.r.width > 0 && part.r.height > 0 && style.visibility !== 'hidden' && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }));
  const outside = !!a.position && (a.position.x >= part.r.width || a.position.y >= part.r.height);
  const aim = (p: typeof part) => (a.position ? { x: p.r.left + a.position.x, y: p.r.top + a.position.y } : { x: (p.left + p.right) / 2, y: (p.top + p.bottom) / 2 });
  const shown = (p: typeof part, pt: XY) => p.right > p.left && p.bottom > p.top && pt.x >= p.left && pt.x < p.right && pt.y >= p.top && pt.y < p.bottom;
  let scrolled = false;
  // Out of view: the nearest scroll that shows it. Covered (by a sticky header, say): centred, once.
  if (visible && !inert && !outside && a.scroll && (a.center || !shown(part, aim(part)))) {
    const before = part.r;
    el.scrollIntoView(a.center ? { block: 'center', inline: 'nearest' } : { block: 'nearest', inline: 'nearest' });
    part = visiblePart();
    scrolled = part.r.left !== before.left || part.r.top !== before.top;
  }
  const points: XY[] = [];
  let blocker = null;
  let offscreen = !(part.right > part.left && part.bottom > part.top);
  if (visible && !outside && !offscreen) {
    const fractions = [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.12, 0.5],
      [0.88, 0.5],
      [0.25, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
      [0.75, 0.25]
    ];
    const candidates = a.position ? [aim(part)] : fractions.map(([fx, fy]) => ({ x: part.left + (part.right - part.left) * fx, y: part.top + (part.bottom - part.top) * fy }));
    // A position outside the part in view is out of view, not covered.
    if (!candidates.some((c) => shown(part, c))) offscreen = true;
    for (const c of candidates) {
      if (!shown(part, c)) continue;
      const h = hitAt(c.x, c.y);
      const mine = !!h && within(h) && !nested(h);
      if (mine) points.push({ x: c.x, y: c.y });
      else if (!blocker) blocker = desc(h && within(h) ? nested(h) : h);
    }
  }
  let active = d.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const tag = el.tagName;
  const type = String(el.type ?? '').toLowerCase();
  const textual = ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type);
  const fieldOk = !el.disabled && !el.readOnly;
  const auto = el.getAttribute('autocomplete') ?? '';
  return {
    connected: true,
    visible,
    inert,
    disabled: (typeof el.matches === 'function' && el.matches(':disabled')) || el.getAttribute('aria-disabled') === 'true',
    editable: !!el.isContentEditable || (tag === 'TEXTAREA' && fieldOk) || (tag === 'INPUT' && textual && fieldOk),
    secret: tag === 'INPUT' && (type === 'password' || /password/i.test(auto)),
    select: tag === 'SELECT' ? { multiple: !!el.multiple } : null,
    // Exactly it (a control inside it, such as a row's own button, is not it), or inside the text it is editing.
    focused: !!active && (active === el || (!!el.isContentEditable && within(active))),
    outside,
    scrolled,
    points,
    offscreen,
    blocker,
    box: { x: part.r.x, y: part.r.y, width: part.r.width, height: part.r.height }
  };
}

interface FrameProbe {
  inert: boolean;
  /** The frame has the editor's focus (the page inside it can take keys). */
  focused: boolean;
  origin: XY;
  scale: XY;
  /** Each point mapped into the editor window: whether it is in view, and whether the editor shows the frame there. */
  mapped: { x: number; y: number; inView: boolean; frame: boolean; blocker: Blocker | null }[];
}

/** Runs in the editor, on the preview's iframe: where points of the page are in the window, and what is over them. */
function frameProbe(iframe: Dom, pts: XY[]): FrameProbe {
  const w = globalThis as Dom;
  const d = w.document;
  const r = iframe.getBoundingClientRect();
  const cs = w.getComputedStyle(iframe);
  const sx = iframe.offsetWidth ? r.width / iframe.offsetWidth : 0;
  const sy = iframe.offsetHeight ? r.height / iframe.offsetHeight : 0;
  const ox = r.left + (iframe.clientLeft + parseFloat(cs.paddingLeft || '0')) * sx;
  const oy = r.top + (iframe.clientTop + parseFloat(cs.paddingTop || '0')) * sy;
  const IMPLICIT: Record<string, string> = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', DIALOG: 'dialog', IFRAME: 'iframe' };
  const desc = (n: Dom) => {
    if (!n || n.nodeType !== 1) return null;
    const role = n.getAttribute('role') || IMPLICIT[n.tagName];
    // Never cut or respaced: a credential cut in two would no longer be found and scrubbed. Too long to give whole, left out.
    const own = n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt') || '';
    const said = n.tagName === 'INPUT' ? '' : String(n.textContent ?? '').trim();
    const name = own ? (own.length <= 200 ? own.trim() : '') : said.length <= 120 ? said : '';
    return { surface: 'editor', tag: String(n.tagName).toLowerCase(), ...(role ? { role } : {}), ...(name ? { name } : {}) };
  };
  let active = d.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return {
    inert: !!iframe.closest('[inert]'),
    focused: active === iframe,
    origin: { x: ox, y: oy },
    scale: { x: sx, y: sy },
    mapped: pts.map((p) => {
      const x = ox + p.x * sx;
      const y = oy + p.y * sy;
      const inView = sx > 0 && sy > 0 && x >= 0 && y >= 0 && x < w.innerWidth && y < w.innerHeight;
      const h = inView ? d.elementFromPoint(x, y) : null;
      return { x, y, inView, frame: h === iframe, blocker: h && h !== iframe ? (desc(h) as Blocker) : null };
    })
  };
}

interface PointHit {
  inView: boolean;
  hit: Blocker | null;
  /** The control the pixel belongs to is disabled. */
  disabled: boolean;
  /** The editor shows the preview's frame there. */
  frame: boolean;
  inert: boolean;
  witness: Witness;
  /** The frame's placement, when the point is on it. */
  origin?: XY;
  scale?: XY;
}

/** Runs in a document: what is at a point, whether a person can reach it, and whether it was there in the screenshot. */
function pointIn(a: { x: number; y: number; surface: 'editor' | 'preview'; selector: string | null; token: string; key: string }): PointHit {
  const w = globalThis as Dom;
  const d = w.document;
  const IMPLICIT: Record<string, string> = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog', IFRAME: 'iframe' };
  const inView = a.x >= 0 && a.y >= 0 && a.x < w.innerWidth && a.y < w.innerHeight;
  let h = inView ? d.elementFromPoint(a.x, a.y) : null;
  while (h && h.shadowRoot) {
    const inner = h.shadowRoot.elementFromPoint(a.x, a.y);
    if (!inner || inner === h) break;
    h = inner;
  }
  if (!h) return { inView, hit: null, disabled: false, frame: false, inert: false, witness: 'new' };
  const role = h.getAttribute('role') || IMPLICIT[h.tagName];
  // Never cut or respaced: a credential cut in two would no longer be found and scrubbed. Too long to give whole, left out.
    const own = h.getAttribute('aria-label') || h.getAttribute('title') || h.getAttribute('alt') || '';
    const said = h.tagName === 'INPUT' ? '' : String(h.textContent ?? '').trim();
    const name = own ? (own.length <= 200 ? own.trim() : '') : said.length <= 120 ? said : '';
  const shot = w[Symbol.for(a.key)];
  let witness: Witness = 'ok';
  if (!shot || shot.token !== a.token) witness = 'superseded';
  else {
    const same = (el: Dom, box: number[]) => {
      const r = el.getBoundingClientRect();
      return Math.abs(r.x - box[0]) <= 1 && Math.abs(r.y - box[1]) <= 1 && Math.abs(r.width - box[2]) <= 1 && Math.abs(r.height - box[3]) <= 1;
    };
    const box = shot.boxes.get(h);
    if (!box) witness = 'new';
    else if (!same(h, box)) witness = 'moved';
    else
      // Whatever covered the pixel then is still there, unchanged (a toast that has gone showed something else there).
      for (const el of shot.list) {
        const b = shot.boxes.get(el);
        if (!b || b[2] <= 0 || b[3] <= 0 || a.x < b[0] || a.x >= b[0] + b[2] || a.y < b[1] || a.y >= b[1] + b[3]) continue;
        if (!el.isConnected || !same(el, b)) {
          witness = 'moved';
          break;
        }
      }
  }
  const control = h.closest('button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="treeitem"], [role="checkbox"], [role="radio"], [role="switch"]');
  const disabled = !!control && ((typeof control.matches === 'function' && control.matches(':disabled')) || control.getAttribute('aria-disabled') === 'true');
  const frame = !!a.selector && h.matches(a.selector);
  const out: PointHit = { inView, hit: { surface: a.surface, tag: String(h.tagName).toLowerCase(), ...(role ? { role } : {}), ...(name ? { name } : {}) }, disabled, frame, inert: !!h.closest('[inert]'), witness };
  if (frame) {
    const r = h.getBoundingClientRect();
    const cs = w.getComputedStyle(h);
    const sx = h.offsetWidth ? r.width / h.offsetWidth : 0;
    const sy = h.offsetHeight ? r.height / h.offsetHeight : 0;
    out.origin = { x: r.left + (h.clientLeft + parseFloat(cs.paddingLeft || '0')) * sx, y: r.top + (h.clientTop + parseFloat(cs.paddingTop || '0')) * sy };
    out.scale = { x: sx, y: sy };
  }
  return out;
}

const GUARD_KEY = 'siteorigin.driver.guard';

/**
 * Runs in a document: until disarmed, stop every trusted press (pointer or mouse down) that does not reach the admitted
 * element (none for `el: null`), before the app's own handlers see it, and every event after a stopped press (its
 * release and click); record what it stopped. A release after a press that reached the target is the app's to place:
 * the press may have opened a menu or drawn a chip that the release lands on. The wheel is not guarded: the compositor
 * scrolls before the page's wheel event, which then lands on whatever scrolled under the pointer.
 */
function armGuard(a: { el: Dom; key: string; at: XY | null; clicksOnly?: boolean }) {
  const w = globalThis as Dom;
  const old = w[Symbol.for(a.key)];
  if (old) old.off();
  let el = a.el;
  if (!el && a.at) el = w.document.elementFromPoint(a.at.x, a.at.y);
  // `clicksOnly`, for a drag's release: a drag is never a click, so every click it would cause is stopped (a tile that
  // never started dragging would otherwise take the release as a click), and nothing else is touched.
  const types = a.clicksOnly ? ['click', 'dblclick', 'auxclick'] : ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  const presses = ['pointerdown', 'mousedown'];
  const state = { stopped: [] as { type: string; tag: string; role?: string; name?: string }[], admitted: 0, pressed: 0 };
  let missed = !!a.clicksOnly;
  const fn = (e: Dom) => {
    if (!e.isTrusted) return;
    const press = presses.includes(e.type);
    if (press ? !!el && e.composedPath().includes(el) : !missed) {
      state.admitted++;
      if (press) state.pressed++;
      return;
    }
    if (press) missed = true;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    const t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (state.stopped.length < 5)
      state.stopped.push({
        type: e.type,
        tag: t ? String(t.tagName).toLowerCase() : 'document',
        ...(t?.getAttribute('role') ? { role: t.getAttribute('role') } : {}),
        ...(t ? { name: ((own: string, said: string) => (own ? (own.length <= 200 ? own.trim() : '') : said.length <= 120 ? said : ''))(t.getAttribute('aria-label') || '', String(t.textContent ?? '').trim()) } : {})
      });
  };
  for (const t of types) w.addEventListener(t, fn, { capture: true, passive: false });
  Object.defineProperty(w, Symbol.for(a.key), {
    configurable: true,
    enumerable: false,
    value: {
      state,
      off: () => {
        for (const t of types) w.removeEventListener(t, fn, { capture: true });
        delete w[Symbol.for(a.key)];
      }
    }
  });
}

/** Runs in a document: what its guard has let through and stopped so far, leaving it armed. */
function peekGuard(key: string): { stopped: { type: string; tag: string; role?: string; name?: string }[]; admitted: number; pressed: number } | null {
  const g = (globalThis as Dom)[Symbol.for(key)];
  return g ? { stopped: [...g.state.stopped], admitted: g.state.admitted, pressed: g.state.pressed } : null;
}

/** Runs in a document: disarm its guard, and say what it let through and what it stopped. */
function disarmGuard(key: string): { stopped: { type: string; tag: string; role?: string; name?: string }[]; admitted: number; pressed: number } | null {
  const w = globalThis as Dom;
  const g = w[Symbol.for(key)];
  if (!g) return null;
  g.off();
  return g.state;
}

/** Runs in a document: wait (bounded) until nothing in it has changed for `idle` ms. */
function quietIn(a: { idle: number; max: number }): Promise<boolean> {
  const w = globalThis as Dom;
  return new Promise((resolve) => {
    const start = w.performance.now();
    let last = start;
    const mo = new w.MutationObserver(() => (last = w.performance.now()));
    mo.observe(w.document, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = w.performance.now();
      if (now - last >= a.idle || now - start >= a.max) {
        mo.disconnect();
        resolve(now - last >= a.idle);
      } else w.setTimeout(tick, 15);
    };
    w.setTimeout(tick, 15);
  });
}

/** Runs in a document: what has the keyboard focus, and whether it takes text. */
function activeIn(a: { selector: string | null }): { frame: boolean; editable: boolean; secret: boolean; hit: Omit<Blocker, 'surface'> | null } {
  const w = globalThis as Dom;
  let n = w.document.activeElement;
  while (n && n.shadowRoot && n.shadowRoot.activeElement) n = n.shadowRoot.activeElement;
  if (!n || n === w.document.body) return { frame: false, editable: false, secret: false, hit: null };
  const type = String(n.type ?? '').toLowerCase();
  const fieldOk = !n.disabled && !n.readOnly;
  const textual = ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type);
  const role = n.getAttribute('role');
  // Never cut or respaced: a credential cut in two would no longer be found and scrubbed. Too long to give whole, left out.
    const own = n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt') || '';
    const said = n.tagName === 'INPUT' ? '' : String(n.textContent ?? '').trim();
    const name = own ? (own.length <= 200 ? own.trim() : '') : said.length <= 120 ? said : '';
  return {
    frame: !!a.selector && n.matches(a.selector),
    editable: !!n.isContentEditable || (n.tagName === 'TEXTAREA' && fieldOk) || (n.tagName === 'INPUT' && textual && fieldOk),
    secret: n.tagName === 'INPUT' && (type === 'password' || /password/i.test(n.getAttribute('autocomplete') ?? '')),
    hit: { tag: String(n.tagName).toLowerCase(), ...(role ? { role } : {}), ...(name ? { name } : {}) }
  };
}

const TYPING_KEY = 'siteorigin.driver.typing';

/** Runs in a document: note what has the keyboard focus (`mark`), or say whether it still has it (`check`). */
function focusMark(a: { key: string; mark: boolean }): boolean {
  const w = globalThis as Dom;
  let n = w.document.activeElement;
  while (n && n.shadowRoot && n.shadowRoot.activeElement) n = n.shadowRoot.activeElement;
  if (a.mark) {
    Object.defineProperty(w, Symbol.for(a.key), { value: n, configurable: true, enumerable: false, writable: true });
    return !!n;
  }
  return !!n && w[Symbol.for(a.key)] === n;
}

/** Runs in the element's document: its box. */
function boxIn(el: Dom): { x: number; y: number; width: number; height: number } | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Runs in the element's document: select everything inside a field or editable text, as Select All in it would. */
function selectAllIn(el: Dom) {
  const w = globalThis as Dom;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    el.select();
    return;
  }
  const range = w.document.createRange();
  range.selectNodeContents(el);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Runs in the element's document: the options of a <select> that fit, by label or value. */
function optionsIn(el: Dom, o: { label?: string; value?: string }): { value: string; label: string; disabled: boolean }[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return [...el.options]
    .filter((x: Dom) => (o.value !== undefined ? x.value === o.value : norm(x.label || x.textContent || '') === norm(o.label ?? '')))
    .map((x: Dom) => ({ value: String(x.value), label: norm(x.label || x.textContent || ''), disabled: !!x.disabled || !!x.closest('optgroup[disabled]') }));
}

// ---------------------------------------------------------------------------
// Running an action
// ---------------------------------------------------------------------------

export interface ActEnv {
  observe: ObserveEnv;
  page: Page;
  /** When the request's deadline passes (Date.now() time). */
  deadline: number;
  shots: ShotRegistry;
  platform?: NodeJS.Platform;
}

/** Time kept back from the deadline for sending input and cleaning up. */
const RESERVE_MS = 1500;
/** How long input takes to reach a document's handlers before a guard is read. */
const SETTLE_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A place to put the pointer, checked. */
interface Aim {
  point: XY;
  surface: 'editor' | 'preview';
  /** The point in the preview page's own pixels, for a preview target. */
  at?: XY;
  /** Report of what it is. */
  hit: Hit;
  /** The element the guard admits (a ref target's), or the point to admit whatever is there (a screenshot point). */
  handle: ElementHandle | null;
  frame: Frame | null;
  probe: Probe | null;
  frameProbe: FrameProbe | null;
  scrolled: boolean;
}

interface Need {
  scroll: boolean;
  enabled?: boolean;
  editable?: boolean;
  select?: boolean;
  /** A pointer goes to it: some point must hit it. */
  pointer: boolean;
}

function hitOf(t: Resolved, extra: Partial<Hit> = {}): Hit {
  return { surface: t.scope, ref: t.ref, role: t.role, ...(t.name ? { name: t.name } : {}), ...extra };
}

/** The preview frame and its iframe in the editor, for a preview target. */
async function frameOf(t: Resolved): Promise<{ frame: Frame; iframe: ElementHandle }> {
  const frame = await t.handle.ownerFrame();
  const iframe = frame ? ((await frame.frameElement().catch(() => null)) as ElementHandle | null) : null;
  if (!frame || !iframe) throw new DriverError('STALE_REF', `"${t.ref}" is no longer in the preview.`, { details: { ref: t.ref, reason: 'gone' } });
  return { frame, iframe };
}

/** Evaluate in a target's document, turning a document that went away into STALE_REF. */
async function inTarget<R, A>(t: Resolved, fn: (el: Dom, a: A) => R, arg: A): Promise<R> {
  try {
    return (await t.handle.evaluate(fn as never, arg as never)) as R;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/context was destroyed|detached|not attached|Target closed|has been closed|navigat/i.test(m)) throw new DriverError('STALE_REF', `"${t.ref}" was on a page that has since been replaced.`, { details: { ref: t.ref, reason: 'document' } });
    throw e;
  }
}

/** One look at a ref target: where to put the pointer, or why not yet. */
async function aimOnce(t: Resolved, position: XY | null, need: Need, center = false): Promise<Aim | Miss> {
  if (t.scope === 'editor') return aimWithin(t, position, need, center, null);
  // In the preview: a dialog over the editor covers the whole frame, which the page itself cannot tell; checked first,
  // so nothing in the page is scrolled for a target no one can reach.
  const { frame, iframe } = await frameOf(t);
  try {
    if (await iframe.evaluate((el: Dom) => !!el.closest('[inert]'))) return { miss: 'inert' };
    return await aimWithin(t, position, need, center, { frame, iframe });
  } finally {
    await iframe.dispose().catch(() => undefined);
  }
}

async function aimWithin(t: Resolved, position: XY | null, need: Need, center: boolean, inFrame: { frame: Frame; iframe: ElementHandle } | null): Promise<Aim | Miss> {
  const probe = await inTarget(t, probeIn, { position, scroll: need.scroll, center: center && need.scroll, surface: t.scope });
  if (!probe.connected) throw new DriverError('STALE_REF', `"${t.ref}" (a ${t.role}) is no longer there.`, { details: { ref: t.ref, reason: 'gone' } });
  if (probe.outside) return { miss: 'position-outside' };
  if (need.select && (!probe.select || probe.select.multiple)) return { miss: 'not-a-select' };
  if (!probe.visible) return { miss: 'hidden' };
  if (probe.inert) return { miss: 'inert' };
  if (need.enabled && probe.disabled) return { miss: 'disabled' };
  if (need.editable && !probe.editable) return { miss: 'not-editable' };
  if (probe.offscreen) return { miss: 'offscreen' };
  if (!probe.points.length) return { miss: 'obscured', blocker: probe.blocker };
  if (!inFrame) {
    const point = probe.points[0];
    return { point, surface: 'editor', hit: hitOf(t, { point: round(point) }), handle: t.handle, frame: null, probe, frameProbe: null, scrolled: probe.scrolled };
  }
  const fp = (await inFrame.iframe.evaluate(frameProbe as never, probe.points as never)) as FrameProbe;
  if (fp.inert) return { miss: 'inert' };
  const i = fp.mapped.findIndex((m) => m.inView && m.frame);
  if (i < 0) {
    const anyInView = fp.mapped.some((m) => m.inView);
    return anyInView ? { miss: 'obscured', blocker: fp.mapped.find((m) => m.blocker)?.blocker ?? null } : { miss: 'offscreen' };
  }
  const point = { x: fp.mapped[i].x, y: fp.mapped[i].y };
  return { point, surface: 'preview', at: probe.points[i], hit: hitOf(t, { point: round(point), at: round(probe.points[i]) }), handle: t.handle, frame: inFrame.frame, probe, frameProbe: fp, scrolled: probe.scrolled };
}

const round = (p: XY): XY => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
const samePoint = (a: XY, b: XY) => Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;

/** Wait, until `end`, for a ref target to be actionable and stay put across two looks. */
async function aimRef(t: Resolved, position: XY | null, need: Need, end: number, ctx: { dialog: string | null }): Promise<{ aim: Aim; waitedMs: number; looks: number }> {
  const began = Date.now();
  const delays = [0, 20, 50, 100, 150, 250, 400];
  let last: Miss = { miss: 'hidden' };
  let scrolled = false;
  let centered = false;
  for (let i = 0; ; i++) {
    // Something on top of it in view (a sticky header): a person scrolls it clear, so it is centred once.
    // Not for a position the caller chose: that point is the one to report on.
    const center = need.scroll && !position && !centered && last.miss === 'obscured';
    if (center) centered = true;
    const first = await aimOnce(t, position, need, center);
    if (!isMiss(first)) scrolled ||= first.scrolled || center;
    if (!isMiss(first)) {
      await sleep(30);
      // Looked at again without scrolling: it must be in the same place, still actionable.
      const second = await aimOnce(t, position, { ...need, scroll: false });
      if (!isMiss(second) && samePoint(first.point, second.point)) return { aim: { ...second, scrolled }, waitedMs: Date.now() - began, looks: i + 1 };
      last = isMiss(second) ? second : { miss: 'unstable' };
    } else last = first;
    if (INVALID.has(last.miss)) break;
    if (Date.now() >= end) break;
    await sleep(Math.min(delays[Math.min(i, delays.length - 1)] || 400, Math.max(0, end - Date.now())));
  }
  throw notActionable(last.miss, { waitedMs: Date.now() - began, target: hitOf(t), blocker: last.blocker ?? null, dialog: last.miss === 'inert' ? ctx.dialog : null, scrolled });
}

/** A screenshot point, checked against what the screenshot showed. Points never wait: the scene must be as it was. */
async function aimPoint(env: ActEnv, p: PointTarget, preview: Frame | null, need: Need): Promise<{ aim: Aim; record: ShotRecord; point: XY }> {
  const record = env.shots.get(p.observation);
  if (typeof record === 'string') throw staleObservation(record, p.observation);
  if (record.generation !== env.observe.generation) throw staleObservation('window', p.observation);
  const point = imagePoint(record, p.surface, p.x, p.y);
  if (!point) {
    const size = p.surface === 'editor' ? record.editor : record.preview?.clip;
    throw new DriverError('BAD_REQUEST', size ? `(${p.x}, ${p.y}) is not on the ${p.surface} image, which is ${size.width}×${size.height}.` : `Observation "${p.observation}" has no preview image.`);
  }
  const changed = sceneChange(record.scene, await readScene(env.page, preview, PREVIEW_IFRAME));
  if (changed) throw staleObservation(changed, p.observation);
  return { aim: await hitPoint(env, record, p, point, preview, need), record, point };
}

async function hitPoint(env: ActEnv, record: ShotRecord, p: PointTarget, point: XY, preview: Frame | null, need: Need): Promise<Aim> {
  const editor = await env.page.evaluate(pointIn, { x: point.x, y: point.y, surface: 'editor' as const, selector: PREVIEW_IFRAME, token: record.token, key: SHOT_WITNESS_KEY });
  if (!editor.inView || !editor.hit) throw notActionable('offscreen', { message: 'The point is outside the editor window.' });
  if (editor.witness !== 'ok') throw staleObservation(editor.witness === 'superseded' ? 'document' : 'moved', p.observation);
  const shown: Hit = { ...editor.hit, surface: 'editor', point: round(point) };
  if (editor.inert) throw notActionable('inert', { target: shown });
  if (!editor.frame) {
    if (need.enabled && editor.disabled) throw notActionable('disabled', { target: shown });
    return { point, surface: 'editor', hit: shown, handle: null, frame: null, probe: null, frameProbe: null, scrolled: false };
  }
  if (!preview || !editor.origin || !editor.scale) throw staleObservation('document', p.observation);
  const at = intoFrame({ origin: editor.origin, scale: editor.scale }, point);
  const page = await preview.evaluate(pointIn, { x: at.x, y: at.y, surface: 'preview' as const, selector: null, token: record.token, key: SHOT_WITNESS_KEY }).catch(() => null);
  if (!page) throw staleObservation('document', p.observation);
  if (!page.inView || !page.hit) throw notActionable('offscreen', { message: 'The point is outside the preview page.' });
  if (page.witness !== 'ok') throw staleObservation(page.witness === 'superseded' ? 'document' : 'moved', p.observation);
  const inPage: Hit = { ...page.hit, surface: 'preview', point: round(point), at: round(at) };
  if (page.inert) throw notActionable('inert', { target: inPage });
  if (need.enabled && page.disabled) throw notActionable('disabled', { target: inPage });
  return { point, surface: 'preview', at, hit: inPage, handle: null, frame: preview, probe: null, frameProbe: null, scrolled: false };
}

/** The preview's frame now, or null without one. */
async function previewFrame(page: Page): Promise<Frame | null> {
  const el = await page.$(PREVIEW_IFRAME).catch(() => null);
  if (!el) return null;
  try {
    return await el.contentFrame();
  } finally {
    await el.dispose().catch(() => undefined);
  }
}

type GuardRecord = { stopped: { type: string; tag: string; role?: string; name?: string }[]; admitted: number; pressed: number };
/** What each document's guard saw: the one the input is for, and the other one. */
interface Guards {
  target: GuardRecord | null;
  other: GuardRecord | null;
}

/** The document the input is for, and the other one (the editor, or the preview's page; null without a preview). */
function sides(page: Page, aim: Aim, preview: Frame | null): { target: Page | Frame; other: Page | Frame | null; surfaces: ['editor' | 'preview', 'editor' | 'preview'] } {
  return aim.surface === 'editor' ? { target: page, other: preview, surfaces: ['editor', 'preview'] } : { target: aim.frame!, other: page, surfaces: ['preview', 'editor'] };
}

/**
 * Arm both documents for input aimed at `aim`: the one it is for admits only presses on its target; the other admits
 * none (a press that reached it went past the target). With `clicksOnly`, both just stop clicks (a drag's release).
 */
async function arm(page: Page, aim: Aim, preview: Frame | null, clicksOnly = false) {
  const { target, other } = sides(page, aim, preview);
  const at = aim.handle ? null : aim.surface === 'editor' ? aim.point : aim.at!;
  try {
    await target.evaluate(armGuard, { el: aim.handle, key: GUARD_KEY, at, clicksOnly });
  } catch (e) {
    throw new DriverError('OP_FAILED', `The input could not be guarded, so none was sent: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  // A page that cannot be read now has nothing to protect: a press that went there still fails, as unadmitted.
  if (other) await other.evaluate(armGuard, { el: null, key: GUARD_KEY, at: null, clicksOnly }).catch(() => undefined);
}

async function readGuards(page: Page, aim: Aim, preview: Frame | null, fn: typeof peekGuard): Promise<Guards> {
  await sleep(SETTLE_MS);
  const { target, other } = sides(page, aim, preview);
  return {
    target: (await target.evaluate(fn, GUARD_KEY).catch(() => null)) as GuardRecord | null,
    other: other ? ((await other.evaluate(fn, GUARD_KEY).catch(() => null)) as GuardRecord | null) : null
  };
}

const disarm = (page: Page, aim: Aim, preview: Frame | null) => readGuards(page, aim, preview, disarmGuard as typeof peekGuard);
const peek = (page: Page, aim: Aim, preview: Frame | null) => readGuards(page, aim, preview, peekGuard);

/** Throw when a press missed the target: a guard stopped it, or the target's document never took one. */
function guarded(g: Guards, aim: Aim, page: Page, preview: Frame | null) {
  const { surfaces } = sides(page, aim, preview);
  const records: [GuardRecord | null, 'editor' | 'preview'][] = [
    [g.target, surfaces[0]],
    [g.other, surfaces[1]]
  ];
  for (const [record, surface] of records) {
    const stopped = record?.stopped[0];
    if (!stopped) continue;
    const blocker: Blocker = { surface, tag: stopped.tag, ...(stopped.role ? { role: stopped.role } : {}), ...(stopped.name ? { name: stopped.name } : {}) };
    throw notActionable('obscured', {
      dispatched: 'partial',
      target: aim.hit,
      blocker,
      message: `The ${stopped.type} reached ${blocker.role ?? blocker.tag}${blocker.name ? ` "${blocker.name}"` : ''} instead of the target, and was stopped before the app saw it.`
    });
  }
  if (!g.target?.pressed) throw notActionable('obscured', { dispatched: 'partial', target: aim.hit, message: 'The press did not reach the target, and nothing showed where it went.' });
}

/** Move to the aim, settle, and look again: the pointer's arrival must not have brought anything up over it. */
async function arrive(env: ActEnv, aim: Aim, recheck: () => Promise<Aim | Miss>): Promise<Aim> {
  await env.page.mouse.move(aim.point.x, aim.point.y);
  await sleep(SETTLE_MS);
  const again = await recheck().catch((e) => {
    if (e instanceof DriverError) throw new DriverError(e.code, e.message, { retryable: false, details: { ...(e.details ?? {}), dispatched: 'partial' } });
    throw e;
  });
  if (isMiss(again)) throw notActionable(again.miss, { dispatched: 'partial', target: aim.hit, blocker: again.blocker ?? null, message: `Moving the pointer there changed what is under it (${again.miss}); nothing was pressed.` });
  if (!samePoint(again.point, aim.point)) throw notActionable('unstable', { dispatched: 'partial', target: aim.hit, message: 'It moved when the pointer arrived; nothing was pressed.' });
  return again;
}

/** ARIA roles a reply may name. A page's own role attribute could say anything, and roles are not scrubbed. */
const ROLES = new Set(
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading iframe img image insertion link list listbox listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term text textbox time timer toolbar tooltip tree treegrid treeitem'.split(
    ' '
  )
);

/** A reply's roles, only where they are ARIA's own. */
function canon<T>(v: T): T {
  if (Array.isArray(v)) return v.map(canon) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'role' && (typeof x !== 'string' || !ROLES.has(x))) continue;
      out[k] = canon(x);
    }
    return out as T;
  }
  return v;
}

/**
 * Run an action. Nothing it returns or throws carries a credential: what the session already knows, what the page
 * holds in credential fields and the saved keys are scrubbed from it, with whatever its own observation finds.
 */
export async function runAction(env: ActEnv, action: Action): Promise<ActionResult> {
  try {
    return canon(
      await sealed(async (seen) => {
        const [frames, stored] = await Promise.all([frameSecrets(env.page).catch((): string[] => []), env.observe.storedSecrets?.().catch((): string[] => []) ?? Promise.resolve([])]);
        seen.push(...(env.observe.remembered?.() ?? []), ...frames, ...stored);
        return perform(env, action, seen);
      })
    );
  } catch (e) {
    if (e instanceof DriverError) throw new DriverError(e.code, e.message, { retryable: e.retryable, ...(e.details ? { details: canon(e.details) } : {}) });
    throw e;
  }
}

async function perform(env: ActEnv, action: Action, seen: string[]): Promise<ActionResult> {
  const began = Date.now();
  // Before anything is looked at: an observation takes time the deadline may not have.
  if (env.deadline - RESERVE_MS <= began) throw notActionable('no-time');
  const end = Math.min(began + action.waitMs, env.deadline - RESERVE_MS);
  // Resolve every ref the action names in one observation.
  const refs: string[] = [];
  const targets = action.op === 'ui.drag' ? [action.from, action.to] : [action.target];
  for (const t of targets) if (t && 'ref' in t) refs.push(t.ref);
  let resolution: Resolution | null = null;
  try {
    if (refs.length) resolution = await resolveInto(env.observe, seen, refs);
    if (env.deadline - RESERVE_MS <= Date.now()) throw notActionable('no-time');
    const byRef = (ref: string) => resolution!.targets.find((t) => t.ref === ref)!;
    let sent = false;
    try {
      const secret = (text: string) => {
        if (!text) return;
        seen.push(text);
        env.observe.remember?.([text]);
      };
      // A ref that had to be waited for is checked again: what it named may have changed meaning meanwhile (a disabled
      // Undo enabled and renamed for the edit it now undoes), and a renamed element is never acted on.
      const revalidate = async (ref: string) => {
        const again = await resolveInto(env.observe, seen, [ref]);
        await Promise.all(again.targets.map((t) => t.handle.dispose().catch(() => undefined)));
      };
      const result = await dispatch(env, action, { byRef, end, ctx: { dialog: resolution?.dialog ?? null }, mode: resolution?.mode ?? null, secret, revalidate, markSent: () => (sent = true) });
      return { ...result, waitedMs: result.waitedMs ?? 0 };
    } finally {
      // Whatever the screenshot showed may have changed once input went out.
      if (sent) env.shots.consume();
    }
  } finally {
    for (const t of resolution?.targets ?? []) await t.handle.dispose().catch(() => undefined);
  }
}

interface DispatchCtx {
  byRef: (ref: string) => Resolved;
  end: number;
  ctx: { dialog: string | null };
  mode: 'edit' | 'preview' | null;
  /** A credential the action is about to type: kept out of this reply and every later one. */
  secret: (text: string) => void;
  revalidate: (ref: string) => Promise<void>;
  markSent: () => void;
}

interface Aimed {
  aim: Aim;
  waitedMs: number;
  recheck: () => Promise<Aim | Miss>;
  /** Whether the target is still where it was aimed at, for a drop. */
  stays: () => Promise<boolean>;
}

/** Where a ref target is: its box in its document, and the frame's placement for a preview target. */
async function placeOf(t: Resolved): Promise<number[] | null> {
  const box = await t.handle.evaluate(boxIn).catch(() => null);
  if (!box) return null;
  if (t.scope === 'editor') return [box.x, box.y, box.width, box.height];
  const { iframe } = await frameOf(t);
  try {
    const fp = (await iframe.evaluate(frameProbe as never, [] as never)) as FrameProbe;
    return [box.x, box.y, box.width, box.height, fp.origin.x, fp.origin.y, fp.scale.x * 1000, fp.scale.y * 1000];
  } finally {
    await iframe.dispose().catch(() => undefined);
  }
}

async function aimAt(env: ActEnv, target: PointerTarget, need: Need, d: DispatchCtx, preview: () => Promise<Frame | null>): Promise<Aimed> {
  if ('ref' in target) {
    const t = d.byRef(target.ref);
    const { aim, waitedMs, looks } = await aimRef(t, target.position ?? null, need, d.end, d.ctx);
    if (looks > 1) await d.revalidate(target.ref);
    const placed = await placeOf(t);
    return {
      aim,
      waitedMs,
      recheck: () => aimOnce(t, target.position ?? null, { ...need, scroll: false }),
      stays: async () => {
        const now = await placeOf(t);
        return !!placed && !!now && placed.every((v, i) => Math.abs(v - now[i]) <= 1);
      }
    };
  }
  const frame = await preview();
  const { aim, record, point } = await aimPoint(env, target, frame, need);
  return {
    aim,
    waitedMs: 0,
    recheck: async () => {
      const again = await hitPoint(env, record, target, point, frame, need);
      // The same element must still be there.
      if (again.hit.tag !== aim.hit.tag || again.hit.name !== aim.hit.name || again.surface !== aim.surface) return { miss: 'obscured', blocker: { surface: again.surface, tag: again.hit.tag ?? '', ...(again.hit.role ? { role: again.hit.role } : {}), ...(again.hit.name ? { name: again.hit.name } : {}) } };
      return again;
    },
    stays: async () => !sceneChange(record.scene, await readScene(env.page, frame, PREVIEW_IFRAME).catch(() => record.scene))
  };
}

/** Put the keyboard focus on a target (as a person would by clicking or tabbing to it) unless it already has it. */
async function focusOn(t: Resolved, aim: Aim, d: DispatchCtx): Promise<void> {
  const inFrame = aim.surface === 'preview';
  if (aim.probe?.focused && (!inFrame || aim.frameProbe?.focused)) return;
  // In edit mode a click on the page selects what is under it: text there takes keys only while it is being edited.
  if (inFrame && d.mode === 'edit') throw notActionable('not-focused', { target: aim.hit, message: `${aim.hit.role ?? 'The target'} in the page is not being edited, and in edit mode a click selects it rather than focusing it.` });
  d.markSent();
  await t.handle.focus();
  const probe = await inTarget(t, probeIn, { position: null, scroll: false, surface: t.scope });
  let ok = probe.focused;
  if (ok && inFrame) {
    const { iframe } = await frameOf(t);
    try {
      ok = ((await iframe.evaluate(frameProbe as never, [] as never)) as FrameProbe).focused;
    } finally {
      await iframe.dispose().catch(() => undefined);
    }
  }
  if (!ok) throw notActionable('not-focused', { dispatched: 'partial', target: aim.hit });
}

/** What has the keyboard focus now, in the editor or the page inside the preview. */
async function focusNow(page: Page): Promise<{ surface: 'editor' | 'preview'; frame: Frame | null; editable: boolean; secret: boolean; hit: Omit<Blocker, 'surface'> | null }> {
  const editor = await page.evaluate(activeIn, { selector: PREVIEW_IFRAME });
  if (!editor.frame) return { surface: 'editor', frame: null, editable: editor.editable, secret: editor.secret, hit: editor.hit };
  const frame = await previewFrame(page);
  const inside = frame ? await frame.evaluate(activeIn, { selector: null }).catch(() => null) : null;
  return { surface: 'preview', frame, editable: !!inside?.editable, secret: !!inside?.secret, hit: inside?.hit ?? null };
}

/** About how long typing takes per character, with the focus checked before each one. */
const TYPE_MS_PER_CHAR = 8;

/**
 * Type key by key into what has the focus now, checking before each key that it still has it: an Enter that commits a
 * field, or a field that moves the focus on, stops the rest from going somewhere else.
 */
async function typeHeld(env: ActEnv, frame: Frame | null, text: string, target: Hit) {
  const { page } = env;
  const docs: (Page | Frame)[] = frame ? [page, frame] : [page];
  for (const doc of docs) await doc.evaluate(focusMark, { key: TYPING_KEY, mark: true });
  const keys = [...text];
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) {
      const still = await Promise.all(docs.map((doc) => doc.evaluate(focusMark, { key: TYPING_KEY, mark: false }).catch(() => false)));
      if (!still.every(Boolean)) throw notActionable('focus-moved', { dispatched: 'partial', target, message: `The keyboard focus moved after ${i} of ${keys.length} characters; the rest was not typed.` });
      if (Date.now() > env.deadline - RESERVE_MS / 2) throw notActionable('no-time', { dispatched: 'partial', target, message: `Typing ran out of time after ${i} of ${keys.length} characters.` });
    }
    await page.keyboard.type(keys[i]);
  }
}

async function dispatch(env: ActEnv, action: Action, d: DispatchCtx): Promise<Omit<ActionResult, 'waitedMs'> & { waitedMs?: number }> {
  const { page } = env;
  let frame: Frame | null | undefined;
  const preview = async () => (frame === undefined ? (frame = await previewFrame(page)) : frame);
  switch (action.op) {
    case 'ui.hover': {
      const { aim, waitedMs } = await aimAt(env, action.target, { scroll: true, pointer: true }, d, preview);
      d.markSent();
      await page.mouse.move(aim.point.x, aim.point.y);
      return { dispatched: 'complete', target: aim.hit, ...(aim.scrolled ? { scrolled: true as const } : {}), waitedMs };
    }
    case 'ui.click': {
      const need: Need = { scroll: true, enabled: true, pointer: true };
      const { aim: first, waitedMs, recheck } = await aimAt(env, action.target, need, d, preview);
      const pv = await preview();
      d.markSent();
      const aim = await arrive(env, first, recheck);
      await arm(page, aim, pv);
      const held: Modifier[] = [];
      let guards: Guards;
      try {
        for (const m of action.modifiers) {
          await page.keyboard.down(m);
          held.push(m);
        }
        for (let n = 1; n <= action.count; n++) {
          await page.mouse.down({ button: action.button, clickCount: n });
          await page.mouse.up({ button: action.button, clickCount: n });
        }
      } finally {
        for (const m of held.reverse()) await page.keyboard.up(m).catch(() => undefined);
        guards = await disarm(page, aim, pv);
      }
      guarded(guards, aim, page, pv);
      return { dispatched: 'complete', target: aim.hit, ...(first.scrolled ? { scrolled: true as const } : {}), waitedMs };
    }
    case 'ui.scroll': {
      // Checked on arrival only (see armGuard: a guard can neither judge nor stop a wheel).
      const { aim: first, waitedMs, recheck } = await aimAt(env, action.target, { scroll: false, pointer: true }, d, preview);
      d.markSent();
      const aim = await arrive(env, first, recheck);
      await page.mouse.wheel(action.deltaX, action.deltaY);
      return { dispatched: 'complete', target: aim.hit, waitedMs };
    }
    case 'ui.drag':
      return drag(env, action, d, preview);
    case 'ui.fill':
    case 'ui.type':
    case 'ui.press':
    case 'ui.select':
      return keys(env, action, d);
  }
}

async function keys(env: ActEnv, action: Extract<Action, { op: 'ui.fill' | 'ui.type' | 'ui.press' | 'ui.select' }>, d: DispatchCtx): Promise<Omit<ActionResult, 'waitedMs'> & { waitedMs?: number }> {
  const { page } = env;
  if (action.op === 'ui.type' && env.deadline - RESERVE_MS - Date.now() < [...action.text].length * TYPE_MS_PER_CHAR) throw notActionable('no-time', { message: `Typing ${[...action.text].length} characters takes longer than the request's deadline leaves; give it a longer timeoutMs.` });
  if (!action.target) {
    // Into what has the focus now: for typing it must take text (letters on anything else are shortcuts).
    const focus = await focusNow(page);
    const target: Hit = { ...(focus.hit ?? { tag: 'body' }), surface: focus.surface };
    if (action.op === 'ui.type') {
      if (!focus.editable) throw notActionable('not-editable', { target, message: `What has the focus (${target.role ?? target.tag}) does not take text; nothing was typed.` });
      if (focus.secret) d.secret(action.text);
      d.markSent();
      await typeHeld(env, focus.frame, action.text, target);
    } else {
      d.markSent();
      await page.keyboard.press((action as Extract<Action, { op: 'ui.press' }>).chord.text);
    }
    return { dispatched: 'complete', target, waitedMs: 0 };
  }
  const t = d.byRef(action.target.ref);
  const need: Need = { scroll: true, pointer: true, enabled: action.op !== 'ui.press', editable: action.op === 'ui.fill' || action.op === 'ui.type', select: action.op === 'ui.select' };
  const { aim, waitedMs, looks } = await aimRef(t, null, need, d.end, d.ctx);
  if (looks > 1) await d.revalidate(t.ref);
  const done = { dispatched: 'complete' as const, target: aim.hit, ...(aim.scrolled ? { scrolled: true as const } : {}), waitedMs };
  if (action.op === 'ui.select') {
    const found = await inTarget(t, optionsIn, 'label' in action.option ? { label: action.option.label } : { value: action.option.value });
    if (!found.length) throw notActionable('option-missing', { target: aim.hit, waitedMs });
    if (found.length > 1 && 'label' in action.option) throw notActionable('option-ambiguous', { target: aim.hit, waitedMs });
    if (found[0].disabled) throw notActionable('option-disabled', { target: aim.hit, waitedMs });
    // As a person would: the focus moves to the list first (whatever had it is left, and commits), then the choice.
    await focusOn(t, aim, d);
    const selected = { label: found[0].label, value: found[0].value };
    // Choosing the option already chosen changes nothing, and sends no change for the app to act on.
    if ((await inTarget(t, (el: Dom) => String(el.value), undefined)) === found[0].value) return { ...done, selected };
    d.markSent();
    // The list's own input and change events go to the app; what it makes of them (a list the app controls shows the
    // choice once it has applied it) is for observations to check.
    await t.handle.selectOption({ value: found[0].value }, { timeout: Math.max(1000, d.end - Date.now()) });
    return { ...done, selected };
  }
  await focusOn(t, aim, d);
  d.markSent();
  if (action.op === 'ui.press') await page.keyboard.press(action.chord.text);
  else if (action.op === 'ui.type') {
    if (aim.probe?.secret) d.secret(action.text);
    await typeHeld(env, aim.surface === 'preview' ? aim.frame : null, action.text, aim.hit);
  } else {
    if (aim.probe?.secret) d.secret(action.text);
    await inTarget(t, selectAllIn, undefined);
    if (action.text) await page.keyboard.insertText(action.text);
    else await page.keyboard.press('Delete');
  }
  return done;
}

/** The time a drag's gesture needs, beyond its moves: settling after the press, at the destination, and before release. */
const DRAG_SETTLE_MS = 1500 + 250 + 1500 + 4 * SETTLE_MS;

async function drag(env: ActEnv, action: Extract<Action, { op: 'ui.drag' }>, d: DispatchCtx, preview: () => Promise<Frame | null>): Promise<Omit<ActionResult, 'waitedMs'> & { waitedMs?: number }> {
  const { page } = env;
  // Both ends are checked before the button goes down; neither is scrolled to.
  const from = await aimAt(env, action.from, { scroll: false, pointer: true }, d, preview);
  let destination: Hit;
  let end: XY;
  let stays: (() => Promise<boolean>) | null = null;
  if (action.to) {
    const to = await aimAt(env, action.to, { scroll: false, pointer: true }, d, preview);
    end = to.aim.point;
    destination = to.aim.hit;
    stays = to.stays;
  } else {
    end = { x: from.aim.point.x + action.by!.x, y: from.aim.point.y + action.by!.y };
    const vp = await page.evaluate(() => ({ width: (globalThis as Dom).innerWidth as number, height: (globalThis as Dom).innerHeight as number }));
    if (end.x < 0 || end.y < 0 || end.x >= vp.width || end.y >= vp.height) throw notActionable('outside-window', { target: from.aim.hit });
    destination = { surface: 'editor', point: round(end) };
  }
  if (Math.hypot(end.x - from.aim.point.x, end.y - from.aim.point.y) < 1) throw notActionable('no-movement', { target: from.aim.hit });
  const needs = action.steps * 16 + DRAG_SETTLE_MS;
  if (env.deadline - RESERVE_MS - Date.now() < needs) throw notActionable('no-time', { target: from.aim.hit, message: `A drag of ${action.steps} steps takes up to ${(needs / 1000).toFixed(1)}s, more than the request's deadline leaves; give it a longer timeoutMs.` });
  const pv = await preview();
  d.markSent();
  const aim = await arrive(env, from.aim, from.recheck);
  await arm(page, aim, pv);
  let down = false;
  const late = () => {
    if (Date.now() > env.deadline - RESERVE_MS / 2) throw new DriverError('TIMEOUT', 'The drag ran out of time part way.');
  };
  try {
    await page.mouse.down();
    down = true;
    const pressed = await peek(page, aim, pv);
    if (pressed.target?.stopped.length || pressed.other?.stopped.length || !pressed.target?.pressed) {
      // The press missed: it is released where it is under the same guard, so its release and click are stopped too.
      await page.mouse.up();
      down = false;
      await disarm(page, aim, pv);
      guarded(pressed, aim, page, pv);
    }
    await disarm(page, aim, pv);
    // The first step crosses the drag threshold. An app may set the gesture up asynchronously (the canvas measures the
    // sections first), so the moves wait for the editor to settle, go a frame apart, and stay at the destination a
    // while, re-sent, for a handler that started listening late.
    const at = (f: number) => ({ x: aim.point.x + (end.x - aim.point.x) * f, y: aim.point.y + (end.y - aim.point.y) * f });
    const first = at(1 / action.steps);
    await page.mouse.move(first.x, first.y);
    await page.evaluate(quietIn, { idle: 80, max: 1500 }).catch(() => undefined);
    for (let i = 2; i <= action.steps; i++) {
      late();
      const p = at(i / action.steps);
      await page.mouse.move(p.x, p.y);
      await sleep(16);
    }
    for (let t = 0; t < 5; t++) {
      await page.mouse.move(end.x + (t % 2 ? 0 : 1), end.y);
      await sleep(50);
    }
    await page.evaluate(quietIn, { idle: 80, max: 1500 }).catch(() => undefined);
    late();
    // Where it is going must not have moved meanwhile (a panel that scrolled a row under the pointer would take the
    // drop instead): if it has, the drag is cancelled.
    if (stays && !(await stays())) throw notActionable('moved', { dispatched: 'partial', target: aim.hit });
    await page.mouse.move(end.x, end.y);
    await sleep(SETTLE_MS);
    // A drag is never a click: a release that would be one (a tile that never started dragging) is stopped.
    await arm(page, aim, pv, true);
    await page.mouse.up();
    down = false;
    await disarm(page, aim, pv);
  } catch (e) {
    if (down) {
      // Never released where it stopped (a drop there would commit): back to where it started, cancelled, and released
      // with clicks stopped.
      await page.mouse.move(aim.point.x, aim.point.y).catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await arm(page, aim, pv, true).catch(() => undefined);
      await page.mouse.up().catch(() => undefined);
      await disarm(page, aim, pv).catch(() => undefined);
    }
    if (e instanceof DriverError && e.code === 'NOT_ACTIONABLE') throw e;
    throw new DriverError(e instanceof DriverError ? e.code : 'OP_FAILED', `The drag stopped part way and was cancelled: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, { details: { dispatched: 'partial' } });
  }
  return { dispatched: 'complete', target: aim.hit, destination, waitedMs: from.waitedMs };
}
