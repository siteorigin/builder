/**
 * Edits on their way into the project: text typed but not committed yet (drafts) and changes still being
 * applied. Settling them is what an explicit save does, and what every way of leaving a project does first
 * (Close Project, switching projects, closing the window, quitting), so nothing typed is dropped on the way
 * out. A settle commits drafts the way leaving their field does, waits for every change to land, and
 * reports what could not be saved, so the author can keep editing or leave without it.
 *
 * Plain module state with no DOM or store import, so the rules are tested on their own; lib/leave.ts wires
 * it to the page.
 */

export interface ApplyOutcome {
  ok: boolean;
  message?: string;
}

/** Inline text editing on the canvas (one draft for every open edit). */
export const CANVAS_DRAFT = 'canvas-text';
/** A titled Add page form: leaving it never creates a page, so it is still waiting when a settle ends. */
export const PAGE_ADD_DRAFT = 'page-add';
/** Unsaved code in a code editor dialog: only its own Save keeps it. */
export const CODE_DRAFT = 'code-editor';
/** Typed edits that could not be saved as they were made (the AI was working, or the field changed somewhere
 *  else meanwhile), kept until the author applies or discards them. */
export const HELD_DRAFT = 'held-edits';

/** What a draft still open after a settle means, by key; any other is a field still being typed in. */
const LEFT_OPEN: Record<string, string> = {
  [CANVAS_DRAFT]: 'The text you are editing on the page has not been saved.',
  [PAGE_ADD_DRAFT]: 'The page you started adding has not been created yet.',
  [CODE_DRAFT]: 'Your code changes have not been saved.',
  [HELD_DRAFT]: 'An edit you made has not been saved yet.'
};

/** Something that can take focus back: the field whose text was refused. */
export interface Refocusable {
  focus: () => void;
  readonly isConnected: boolean;
  /** Whether the field is inside `root` (the element of a list about to be replaced). */
  inside?: (root: object) => boolean;
}

interface Active {
  problems: string[];
  /** Drafts whose problem is already explained (a field that refused its text), so it is not said twice. */
  explained: Set<string>;
  /** The first field that refused its text, for Keep editing to return to. */
  refused: Refocusable | null;
}

const drafts = new Set<string>();
/** Fields keeping text they refused after the author left them (a public URL without https://), by draft key:
 *  what a later settle says about each, and where Keep editing returns. */
const retained = new Map<string, { message: string; field: Refocusable | null }>();
/** What a draft still open after a settle means, said by the field that holds it (text too long to save). */
const notes = new Map<string, string>();
const draftListeners = new Set<() => void>();
const inflight = new Set<Promise<ApplyOutcome>>();
const active: Active[] = [];
let deferred: Array<() => void> = [];
let canvasCommit: (() => void) | null = null;

/** Mark or clear an uncommitted edit. Returns whether anything changed. `note` says why it is still open, for a
 *  settle to report when the field is not on screen to say so itself; marking it again without one keeps it. A
 *  draft being typed that is then refused (too long to save) stays open and changes only by its note. */
export function setDraft(key: string, on: boolean, note?: string): boolean {
  const before = notes.get(key);
  if (!on) notes.delete(key);
  else if (note) notes.set(key, note);
  if (on === drafts.has(key)) {
    if (notes.get(key) === before) return false;
    draftListeners.forEach((f) => f());
    return true;
  }
  if (on) drafts.add(key);
  else drafts.delete(key);
  draftListeners.forEach((f) => f());
  return true;
}

export const draftCount = () => drafts.size;
/** Open drafts whose field refused its text and said why (too long to save), rather than ones still being typed. */
export const refusedDraftCount = () => [...notes.keys()].filter((k) => drafts.has(k)).length;
export const hasDraft = (key: string) => drafts.has(key);
export function onDraftsChange(fn: () => void): () => void {
  draftListeners.add(fn);
  return () => void draftListeners.delete(fn);
}

/** Follow a change until it lands: a settle running meanwhile waits for it and hears if it failed, even one
 *  started before the settle (by leaving a field just before choosing Close Project). */
export function trackApply(p: Promise<ApplyOutcome>): void {
  inflight.add(p);
  void p
    .catch((e: unknown): ApplyOutcome => ({ ok: false, message: e instanceof Error ? e.message : undefined }))
    .then((o) => {
      inflight.delete(p);
      if (!o.ok) report(o.message || 'A change could not be saved.');
    });
}

export const savesInFlight = () => inflight.size;

/**
 * The first field inside `root` that keeps text it refused (see retainRefused), and why: a change that would take
 * that field away (replacing the list it is in) waits for the author to correct or discard it. Null when none does.
 */
export function refusedWithin(root: object): { message: string; field: Refocusable } | null {
  for (const [key, kept] of retained) if (drafts.has(key) && kept.field?.isConnected && kept.field.inside?.(root)) return { message: kept.message, field: kept.field };
  return null;
}
/** Resolves once every change on its way into the project now has landed or failed. */
export const appliesLanded = (): Promise<unknown> => Promise.allSettled([...inflight]);
export const isSettling = () => active.length > 0;

/** Something typed was refused before it reached the project (a page with no title, text too long to send).
 *  Counted only while a settle is running; otherwise the field explains it as it always has. `draftKey` is
 *  the refusing field's draft, which stays open and is not reported again as merely unsaved; `field` is
 *  where Keep editing returns. */
export function reportRefused(message: string, draftKey?: string, field?: Refocusable): void {
  report(message);
  for (const s of active) {
    if (draftKey) s.explained.add(draftKey);
    if (field && !s.refused) s.refused = field;
  }
}

/** A field keeps text it refused as an unsaved draft, with its reason beside it, after the author has left it: a
 *  settle started later says so and returns there. Null once the text is corrected, saved or discarded. */
export function retainRefused(draftKey: string, message: string | null, field?: Refocusable): void {
  if (message) retained.set(draftKey, { message, field: field ?? null });
  else retained.delete(draftKey);
}

function report(message: string) {
  for (const s of active) if (!s.problems.includes(message)) s.problems.push(message);
}

/** Run `fn` once no settle is running (at once when none is). A field puts back the saved value this way, so
 *  what was typed stays on screen while the author decides, and Keep editing returns to it intact. */
export function afterSettle(fn: () => void): void {
  if (active.length) deferred.push(fn);
  else fn();
}

/**
 * Run `fn` once no settle is running and every change on its way into the project now has landed or failed. A field
 * left with a change still being saved puts the saved value back this way: what was typed stays on screen until the
 * project holds it (a save can take a while: a slow disk, a preview still taking the save before it), rather than the
 * value from before the change showing in the meantime.
 */
export function afterLanding(fn: () => void): void {
  afterSettle(() => {
    if (!inflight.size) return fn();
    void appliesLanded().then(() => afterSettle(fn));
  });
}

/** Editors that hold typed text without a focused field to blur (the Posts writer): settling asks each to save it. */
const flushers = new Set<() => unknown>();

/**
 * Register how an editor saves what it holds, for every settle (Save, leaving the project) to run and wait for: a
 * blur alone misses text it could not save before (the AI was working, the file changed) once focus has moved on.
 * Returns the unregister.
 */
export function registerFlush(fn: () => unknown): () => void {
  flushers.add(fn);
  return () => void flushers.delete(fn);
}

/** How the canvas asks its preview to commit an inline text edit (set while the canvas is shown). */
export function setCanvasCommit(fn: (() => void) | null): void {
  canvasCommit = fn;
}

export interface SettleDeps {
  /** Commit what the focused control holds, as leaving it does. */
  blur: () => void;
  /** Stop new input, once the preview has handed back its inline edit (holding input earlier would take focus
   *  from a link being typed there, which drops it). */
  hold?: () => void;
  /** Resolve after `ms`. */
  wait: (ms: number) => Promise<void>;
  /** How long the canvas may take to hand back an inline edit. */
  canvasTimeoutMs?: number;
  /** How long to wait for changes to land; by default as long as it takes, since one that is slow to land
   *  is still being saved (the app asks whether to keep waiting when the editor stops answering). */
  saveTimeoutMs?: number;
  /** Run once every tracked change has landed, and waited for: an explicit save also waits here for the
   *  project's other queued writes (the AI's edits, a restore) to reach the disk. It resolves to whether they did. */
  barrier?: () => Promise<boolean>;
  /** How long to wait for the barrier: a write held up for longer (an export copying to a slow drive) goes on, but
   *  the settle ends without confirming it. */
  barrierTimeoutMs?: number;
}

export interface Settled {
  /** What could not be saved, in plain words; empty when everything typed is in the project. */
  problems: string[];
  /** The field that refused its text, if one did and is still on screen: Keep editing returns there. */
  refused: Refocusable | null;
  /** End the settle once the author has decided: fields put back what is saved, except one being edited again. */
  finish: () => void;
}

const POLL_MS = 20;

async function until(cond: () => boolean, ms: number, wait: SettleDeps['wait']): Promise<boolean> {
  for (let waited = 0; !cond(); waited += POLL_MS) {
    if (waited >= ms) return false;
    await wait(POLL_MS);
  }
  return true;
}

/** Commit every draft and wait for every change to land, collecting what could not be saved. */
export async function settle(deps: SettleDeps): Promise<Settled> {
  // A settle already running (Save just before Close) may have heard of a refusal this one must answer too.
  const s: Active = { problems: [...new Set(active.flatMap((a) => a.problems))], explained: new Set(active.flatMap((a) => [...a.explained])), refused: active.find((a) => a.refused)?.refused ?? null };
  active.push(s);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    active.splice(active.indexOf(s), 1);
    if (active.length) return;
    const run = deferred;
    deferred = [];
    run.forEach((f) => f());
  };
  const barrier = deps.barrier;
  let unconfirmed: string | null = null;
  try {
    // The preview hands back an inline edit by message; a field commits as it loses focus.
    if (drafts.has(CANVAS_DRAFT)) canvasCommit?.();
    deps.blur();
    if (flushers.size) await Promise.allSettled([...flushers].map((f) => Promise.resolve().then(f)));
    // A turn for what the blur started (a commit, an empty form closing) before anything is counted.
    await deps.wait(0);
    await until(() => !drafts.has(CANVAS_DRAFT), deps.canvasTimeoutMs ?? 3000, deps.wait);
    deps.hold?.();
    if (!(await until(() => inflight.size === 0, deps.saveTimeoutMs ?? Infinity, deps.wait))) report('A change is still being saved.');
    else if (barrier) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), deps.barrierTimeoutMs ?? 10000)));
      const saved = await Promise.race([Promise.resolve().then(barrier).catch(() => false), late]);
      clearTimeout(timer);
      unconfirmed = saved === null ? 'A change is still being saved.' : saved ? null : 'A change could not be confirmed as saved.';
    }
    await deps.wait(0);
    // Whatever is still open was not saved: a titled Add page form, unsaved code, an edit the preview kept, or
    // (a backstop) a field typed in meanwhile.
    for (const key of drafts) {
      if (s.explained.has(key)) continue;
      const kept = retained.get(key);
      if (kept && !s.refused && kept.field?.isConnected) s.refused = kept.field;
      report(kept?.message ?? LEFT_OPEN[key] ?? notes.get(key) ?? 'A change you were typing has not been saved.');
    }
    // The barrier's answer is this settle's alone, kept out of what an overlapping one (a Close) copies.
    const problems = unconfirmed && !s.problems.includes(unconfirmed) ? [...s.problems, unconfirmed] : [...s.problems];
    return { problems, refused: s.refused?.isConnected ? s.refused : null, finish };
  } catch (e) {
    finish();
    throw e;
  }
}

/**
 * Start `start` only once everything typed has been committed and every change on its way into the project has landed
 * (`settled`, as an explicit save does), so what it reads holds what is on screen: an export started while a canvas edit
 * or a field is still open includes it. When something could not be saved, `start` never runs and the reasons come back.
 */
export async function afterEditsSettle<T>(settled: () => Promise<Settled>, start: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; problems: string[] }> {
  const { problems, finish } = await settled();
  finish();
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: await start() };
}

/** Test helper: forget every draft, change and settle. */
export function resetPendingForTests(): void {
  drafts.clear();
  retained.clear();
  notes.clear();
  inflight.clear();
  active.length = 0;
  deferred = [];
  canvasCommit = null;
  flushers.clear();
}
