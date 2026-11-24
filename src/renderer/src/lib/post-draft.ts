/**
 * The text of the post open in the writer, between what was typed and what the project has: typing marks it
 * unsaved at once and saves it after a pause, leaving the text, another post, the panel or the project saves it at
 * once, and nothing typed is ever dropped. One save is on its way at a time; text typed while it is goes in the next.
 *
 * The writer's own DOM is the draft: the controller never writes to it, so a save landing, a project change elsewhere
 * or a composition (IME) in progress never moves the caret or loses a character. It reads the DOM only when it saves,
 * and never in the middle of a composition.
 */
import type { RichText } from '@shared/types';

/** How a save ended, as the checked write reports it (store.ts commitIfUnchanged), or `failed` with why. */
export type DraftSaveOutcome =
  | { kind: 'applied' | 'unchanged' }
  | { kind: 'busy'; message?: string }
  | { kind: 'changed' }
  | { kind: 'gone' }
  | { kind: 'closed' }
  | { kind: 'failed'; message?: string };

/** What stops the text from being saved, until it is dealt with. */
export type DraftProblem =
  /** The AI is changing the site: saved once it stops. */
  | { kind: 'busy'; message?: string }
  /** The post's saved text changed elsewhere after the writer showed it: the author chooses which to keep. */
  | { kind: 'changed' }
  /** The post is no longer in the project. */
  | { kind: 'gone' }
  /** Refused (too long, a picture no longer in the library): saved again on the next change or save. */
  | { kind: 'failed'; message?: string };

export interface PostDraftDeps {
  /** The text as the writer shows it now. */
  read: () => RichText;
  /**
   * Save `body` to the post, checked against what the writer last had from the project. `step` names the undo step it
   * belongs to: saves of the same step join one step of the project's history, a new step starts another.
   */
  save: (body: RichText, step: number) => Promise<DraftSaveOutcome>;
  /** Hears when the text becomes unsaved or saved, and every change of problem. */
  onChange?: (state: { dirty: boolean; saving: boolean; problem: DraftProblem | null }) => void;
  /** How long typing pauses before the text is saved. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const POST_SAVE_DELAY = 600;

export class PostDraft {
  /** Bumped by every change to the text; `saved` is the last one the project has. */
  private gen = 0;
  private saved = 0;
  private timer: unknown = null;
  private composing = false;
  private draining: Promise<boolean> | null = null;
  private closed = false;
  private problemNow: DraftProblem | null = null;
  private savingNow = false;
  /** The undo step typing goes into now. */
  private stepNow = 0;
  /** Text read at a step's end (a formatting command), saved in order before the text as it is now. */
  private queued: Array<{ body: RichText; step: number; gen: number }> = [];
  /** Bumped by reset: a save that was on its way before it answers for text the writer no longer shows. */
  private epoch = 0;

  constructor(private readonly deps: PostDraftDeps) {}

  get dirty(): boolean {
    return this.gen !== this.saved;
  }
  get problem(): DraftProblem | null {
    return this.problemNow;
  }
  get isComposing(): boolean {
    return this.composing;
  }

  /** What is typed from now on is an undo step of its own (the writer was left and came back, an Undo ran). */
  newStep(): void {
    if (this.dirty) this.checkpoint(false);
    else this.stepNow++;
  }

  /**
   * End the undo step here: the text as it is now is saved as that step, before anything typed after it, which starts
   * the next. A formatting command calls it before it changes the text (`changed` false: the typing so far) and after
   * (`changed` true: the command's own step). Never in the middle of a composition.
   */
  checkpoint(changed: boolean): void {
    if (this.closed || this.composing) return;
    if (changed) this.gen++;
    if (this.gen !== this.saved && !this.queued.some((q) => q.gen === this.gen)) this.queued.push({ body: this.deps.read(), step: this.stepNow, gen: this.gen });
    this.stepNow++;
    if (this.problemNow?.kind === 'failed') this.problemNow = null;
    this.emit();
    if (this.queued.length) void this.flush();
  }

  /** The author changed the text: unsaved now, saved after a pause (never while composing). */
  input(): void {
    if (this.closed) return;
    this.gen++;
    // A refusal is answered by the next change: the text is tried again (a description shortened, a picture removed).
    // Steps ended before it hold the refused text, so the corrected text takes their place.
    if (this.problemNow?.kind === 'failed') {
      this.problemNow = null;
      this.queued = [];
    }
    this.emit();
    if (!this.composing) this.schedule();
  }

  compositionStart(): void {
    if (this.closed) return;
    this.composing = true;
    this.cancelTimer();
  }

  /** A composition ended: what it typed arrives as input, saved after the usual pause. */
  compositionEnd(): void {
    if (this.closed) return;
    this.composing = false;
    if (this.dirty) this.schedule();
  }

  /**
   * Save now, and resolve once the text the writer shows is in the project (true), or could not be saved (false: a
   * composition still in progress, or a problem that waits for the author). A second call while saving joins it.
   */
  flush(): Promise<boolean> {
    this.cancelTimer();
    if (this.closed) return Promise.resolve(!this.dirty);
    if (this.composing) return Promise.resolve(false);
    if (!this.dirty && !this.draining) return Promise.resolve(true);
    this.draining ??= this.drain().finally(() => (this.draining = null));
    return this.draining;
  }

  /**
   * The author chose their text over the one saved elsewhere (or the reason it waited has gone): try again. The caller
   * has moved the check's starting point to the project as it is now.
   */
  retry(): Promise<boolean> {
    if (this.problemNow?.kind !== 'gone') this.problemNow = null;
    this.emit();
    return this.flush();
  }

  /** The post is no longer in the project: nothing is saved, and the problem says so, whatever it said before. */
  markGone(): void {
    this.cancelTimer();
    this.problemNow = { kind: 'gone' };
    this.emit();
  }

  /** The post is back (an Undo of its removal): its text is saved again as usual. */
  back(): Promise<boolean> {
    if (this.problemNow?.kind === 'gone') this.problemNow = null;
    this.emit();
    return this.flush();
  }

  /**
   * The writer shows the project's text again (another post, an Undo, the saved version chosen): nothing it holds is
   * unsaved. Text typed meanwhile was read into the DOM already, so the caller only does this when it is clean or the
   * author chose to drop it.
   */
  reset(): void {
    this.cancelTimer();
    this.epoch++;
    this.queued = [];
    this.stepNow++;
    this.saved = this.gen;
    this.problemNow = null;
    this.emit();
  }

  /** Stop: no timer runs and nothing more is saved (the writer went away after its last flush). */
  close(): void {
    this.closed = true;
    this.cancelTimer();
  }

  private async drain(): Promise<boolean> {
    while (this.dirty && !this.closed) {
      if (this.problemNow && this.problemNow.kind !== 'failed' && this.problemNow.kind !== 'busy') return false;
      // A step ended earlier goes first, as it was read then; otherwise the text as it is now.
      const item = this.queued[0];
      if (!item && this.composing) return false;
      const gen = item?.gen ?? this.gen;
      const epoch = this.epoch;
      let outcome: DraftSaveOutcome;
      this.savingNow = true;
      this.emit();
      try {
        outcome = await this.deps.save(item?.body ?? this.deps.read(), item?.step ?? this.stepNow);
      } catch (e) {
        outcome = { kind: 'failed', message: e instanceof Error ? e.message : undefined };
      } finally {
        this.savingNow = false;
      }
      // Gone meanwhile, or the writer showed the project's text again: this answer is about text it no longer holds.
      if (this.closed) return false;
      if (epoch !== this.epoch) continue;
      if (outcome.kind === 'applied' || outcome.kind === 'unchanged') {
        // Only what was read is saved: text typed while it was on its way goes in the next turn of the loop.
        if (item && this.queued[0] === item) this.queued.shift();
        this.saved = Math.max(this.saved, gen);
        this.problemNow = null;
        this.emit();
        continue;
      }
      if (outcome.kind === 'closed') {
        this.close();
        return false;
      }
      this.problemNow = outcome as DraftProblem;
      this.emit();
      return false;
    }
    this.emit();
    return !this.dirty;
  }

  private schedule(): void {
    this.cancelTimer();
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.delayMs ?? POST_SAVE_DELAY);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private emit(): void {
    this.deps.onChange?.({ dirty: this.dirty, saving: this.savingNow, problem: this.problemNow });
  }
}

/** How the writer on screen saves its post now: set while a post is open in it. */
let openWriter: (() => Promise<boolean>) | null = null;

/** The writer registers how its open post is saved; returns the unregister. */
export function setOpenWriter(flush: () => Promise<boolean>): () => void {
  openWriter = flush;
  return () => {
    if (openWriter === flush) openWriter = null;
  };
}

/**
 * Save the post open in the writer before something else replaces it (another post, a new one, a duplicate). Resolves
 * true when it is saved; false when it could not be yet, in which case the writer keeps it and says why.
 */
export function flushOpenPost(): Promise<boolean> {
  return openWriter ? openWriter() : Promise.resolve(true);
}

/** Undo and Redo as the writer runs them: its unsaved text first, then the project's history. */
let writerHistory: ((action: 'undo' | 'redo') => void) | null = null;

/** The writer registers its Undo and Redo while its text can have focus; returns the unregister. */
export function setWriterHistory(run: (action: 'undo' | 'redo') => void): () => void {
  writerHistory = run;
  return () => {
    if (writerHistory === run) writerHistory = null;
  };
}

/**
 * Edit → Undo or Redo while the writer's text has focus: the writer's own, never the browser's text history (which
 * would undo something else and save that as a new change). False when no writer takes it.
 */
export function runWriterHistory(action: 'undo' | 'redo'): boolean {
  if (!writerHistory) return false;
  writerHistory(action);
  return true;
}
