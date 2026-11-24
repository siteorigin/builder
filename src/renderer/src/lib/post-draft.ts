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
  /** Save `body` to the post, checked against what the writer last had from the project. */
  save: (body: RichText) => Promise<DraftSaveOutcome>;
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

  /** The author changed the text: unsaved now, saved after a pause (never while composing). */
  input(): void {
    if (this.closed) return;
    this.gen++;
    // A refusal is answered by the next change: the text is tried again (a description shortened, a picture removed).
    if (this.problemNow?.kind === 'failed') this.problemNow = null;
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

  /**
   * The writer shows the project's text again (another post, an Undo, the saved version chosen): nothing it holds is
   * unsaved. Text typed meanwhile was read into the DOM already, so the caller only does this when it is clean or the
   * author chose to drop it.
   */
  reset(): void {
    this.cancelTimer();
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
      if (this.composing) return false;
      const gen = this.gen;
      let outcome: DraftSaveOutcome;
      this.savingNow = true;
      this.emit();
      try {
        outcome = await this.deps.save(this.deps.read());
      } catch (e) {
        outcome = { kind: 'failed', message: e instanceof Error ? e.message : undefined };
      } finally {
        this.savingNow = false;
      }
      if (outcome.kind === 'applied' || outcome.kind === 'unchanged') {
        // Only what was read is saved: text typed while it was on its way goes in the next turn of the loop.
        this.saved = Math.max(this.saved, gen);
        this.problemNow = null;
        this.emit();
        continue;
      }
      if (outcome.kind === 'closed') {
        this.close();
        return false;
      }
      this.problemNow = outcome;
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
