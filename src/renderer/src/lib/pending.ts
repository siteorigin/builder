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
/** Edits typed while the AI worked, kept until the author applies or discards them. */
export const HELD_DRAFT = 'held-edits';

/** What a draft still open after a settle means, by key; any other is a field still being typed in. */
const LEFT_OPEN: Record<string, string> = {
  [CANVAS_DRAFT]: 'The text you are editing on the page has not been saved.',
  [PAGE_ADD_DRAFT]: 'The page you started adding has not been created yet.',
  [CODE_DRAFT]: 'Your code changes have not been saved.',
  [HELD_DRAFT]: 'An edit you made while the AI was working has not been saved yet.'
};

/** Something that can take focus back: the field whose text was refused. */
export interface Refocusable {
  focus: () => void;
  readonly isConnected: boolean;
}

interface Active {
  problems: string[];
  /** Drafts whose problem is already explained (a field that refused its text), so it is not said twice. */
  explained: Set<string>;
  /** The first field that refused its text, for Keep editing to return to. */
  refused: Refocusable | null;
}

const drafts = new Set<string>();
const draftListeners = new Set<() => void>();
const inflight = new Set<Promise<ApplyOutcome>>();
const active: Active[] = [];
let deferred: Array<() => void> = [];
let canvasCommit: (() => void) | null = null;

/** Mark or clear an uncommitted edit. Returns whether anything changed. */
export function setDraft(key: string, on: boolean): boolean {
  if (on === drafts.has(key)) return false;
  if (on) drafts.add(key);
  else drafts.delete(key);
  draftListeners.forEach((f) => f());
  return true;
}

export const draftCount = () => drafts.size;
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

function report(message: string) {
  for (const s of active) if (!s.problems.includes(message)) s.problems.push(message);
}

/** Run `fn` once no settle is running (at once when none is). A field puts back the saved value this way, so
 *  what was typed stays on screen while the author decides, and Keep editing returns to it intact. */
export function afterSettle(fn: () => void): void {
  if (active.length) deferred.push(fn);
  else fn();
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
  try {
    // The preview hands back an inline edit by message; a field commits as it loses focus.
    if (drafts.has(CANVAS_DRAFT)) canvasCommit?.();
    deps.blur();
    // A turn for what the blur started (a commit, an empty form closing) before anything is counted.
    await deps.wait(0);
    await until(() => !drafts.has(CANVAS_DRAFT), deps.canvasTimeoutMs ?? 3000, deps.wait);
    deps.hold?.();
    if (!(await until(() => inflight.size === 0, deps.saveTimeoutMs ?? Infinity, deps.wait))) report('A change is still being saved.');
    else if (deps.barrier) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), deps.barrierTimeoutMs ?? 10000)));
      const saved = await Promise.race([deps.barrier().catch(() => false), late]);
      clearTimeout(timer);
      // This settle's own answer: a Close running meanwhile is about its own changes, not this confirmation.
      const unconfirmed = saved === null ? 'A change is still being saved.' : saved ? null : 'A change could not be confirmed as saved.';
      if (unconfirmed && !s.problems.includes(unconfirmed)) s.problems.push(unconfirmed);
    }
    await deps.wait(0);
    // Whatever is still open was not saved: a titled Add page form, unsaved code, an edit the preview kept, or
    // (a backstop) a field typed in meanwhile.
    for (const key of drafts) {
      if (s.explained.has(key)) continue;
      report(LEFT_OPEN[key] ?? 'A change you were typing has not been saved.');
    }
    return { problems: [...s.problems], refused: s.refused?.isConnected ? s.refused : null, finish };
  } catch (e) {
    finish();
    throw e;
  }
}

/** Test helper: forget every draft, change and settle. */
export function resetPendingForTests(): void {
  drafts.clear();
  inflight.clear();
  active.length = 0;
  deferred = [];
  canvasCommit = null;
}
