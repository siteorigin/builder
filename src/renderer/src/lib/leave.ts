import { settle, type Settled } from './pending';
import { api, confirmDialog, getConfirm, getState, pendingConfirms, setState, toast } from '../store';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Settle edits against the real page: a field being typed in commits by losing focus, as it always has on an
 *  explicit save. Focus anywhere else (a Layers row, a button) stays put; an inline edit on the canvas is
 *  handed back by message instead. `hold` stops new input once that is done. */
export function settleEdits(hold?: () => void): Promise<Settled> {
  return settle({
    blur: () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) el.blur();
    },
    hold,
    wait
  });
}

/** Cmd/Ctrl+S: commit the field being typed in and wait for every change to land. The notice only describes
 *  that moment: a change that failed (already explained) or a new edit started meanwhile means no notice. */
export async function saveNow() {
  const { problems, finish } = await settleEdits();
  finish();
  if (!problems.length && !getState().drafting) toast('All changes are saved on this computer.', 'success');
}

let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** From the moment leaving starts until the project has gone (stopping the preview can take a few seconds),
 *  the editor takes no input and shortcuts do nothing: an edit made then could escape the save, or be lost.
 *  Keep editing ends the hold, and so do the project closing and a close that failed. */
function holdEditing() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (!getState().leaving) setState({ leaving: true });
}
/** Leaving was agreed: the project closes next. A long timeout ends the hold in case it never does. */
function leaveAgreed() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => setState({ leaving: false }), 60000);
}
export function endEditingHold() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (getState().leaving) setState({ leaving: false });
}

const LEAVE_QUESTION = 'Leave without your last change?';

/** Bumped when the project closes: a leave still settling for it no longer holds input or asks anything. */
let closedCount = 0;
export function projectClosed() {
  closedCount++;
  endEditingHold();
  // A question about the project that just went away has nothing left to decide.
  for (const q of [...pendingConfirms()]) if (q.title === LEAVE_QUESTION) q.resolve(null);
}

/** Close the project from the editor (Close Project, New project, a project to trust). The main process asks
 *  prepareToLeave first. A close that fails gives the editor back, and says why. */
export function closeProject(): Promise<{ ok: boolean }> {
  return api.projects.close().then(
    (r) => {
      if (!r.ok) endEditingHold();
      return r;
    },
    (e: unknown) => {
      endEditingHold();
      toast(`The project could not be closed${e instanceof Error && e.message ? `: ${e.message}` : '.'}`, 'error');
      return { ok: false };
    }
  );
}

/**
 * The app is about to leave the project (Close Project, another project, closing the window, quitting). Save
 * what is being typed, as an explicit save does. If something cannot be saved, ask: keep editing (the field
 * comes back with its text) or leave without it. Resolves whether the project may be left. `asking` is called
 * before the question, so the app waits for the author rather than for the page.
 */
export async function prepareToLeave(asking: () => void): Promise<boolean> {
  const active = document.activeElement;
  const before = active instanceof HTMLElement && active !== document.body ? active : null;
  // Everything here belongs to this project: once it has closed (the app stopped waiting for this page), a
  // late settle takes no hold and asks nothing, so the next project is never frozen by it.
  const closedAt = closedCount;
  const current = () => closedCount === closedAt;
  const { problems, refused, finish } = await settleEdits(() => current() && holdEditing());
  if (!current()) {
    finish();
    return false;
  }
  if (!problems.length) {
    leaveAgreed();
    finish();
    return true;
  }
  // One question at a time: with another one open, the project stays open until that is answered.
  if (getConfirm()) {
    endEditingHold();
    finish();
    toast('Answer the open question first, then try again.', 'error');
    return false;
  }
  asking();
  const choice = await confirmDialog({
    title: LEAVE_QUESTION,
    body: `${problems.join(' ')} Keep editing to fix it, or leave without it.`,
    confirmLabel: 'Leave without it',
    cancelLabel: 'Keep editing',
    danger: true
  });
  if (!current()) {
    finish();
    return false;
  }
  if (choice === true) {
    leaveAgreed();
    finish();
    return true;
  }
  // Back to the field that refused its text (or where focus was), once the dialog and the hold have gone
  // (focus cannot land in an inert editor), and before the dialog puts focus anywhere else.
  endEditingHold();
  const inert = () => !!document.getElementById('root')?.inert || !!document.querySelector<HTMLElement>('.editor')?.inert;
  for (let i = 0; i < 50 && inert(); i++) await wait(10);
  const back = (refused?.isConnected ? refused : null) ?? (before?.isConnected ? before : null);
  back?.focus();
  finish();
  return false;
}
