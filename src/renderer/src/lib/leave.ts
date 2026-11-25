import { savesInFlight, settle, type Settled } from './pending';
import { api, confirmDialog, editRunStatus, getConfirm, getState, markDraft, pendingConfirms, setState, toast, useStore } from '../store';
import { clearKeptDrafts, goneReport, keptDraftKey, pruneKeptDrafts } from './kept-drafts';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Settle edits against the real page: a field being typed in commits by losing focus, as it always has on an
 *  explicit save. Focus anywhere else (a Layers row, a button) stays put; an inline edit on the canvas is
 *  handed back by message instead. `hold` stops new input once that is done; `barrier` is waited for last. */
export function settleEdits(hold?: () => void, barrier?: () => Promise<boolean>): Promise<Settled> {
  return settle({
    blur: () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) el.blur();
    },
    hold,
    wait,
    barrier
  });
}

/** Cmd/Ctrl+S: commit the field being typed in, wait for every change to land, then for the project's queued
 *  writes to reach the disk. The notice only describes that moment, in the project it was asked in: a change
 *  that failed (already explained), a new edit started meanwhile, another project open by then, or AI changes
 *  still being made (Stop takes them back) means no notice. */
export async function saveNow() {
  const opening = getState().snapshot?.workspaceKey;
  const { problems, finish } = await settleEdits(undefined, () => api.project.flush(opening));
  finish();
  const s = getState();
  // A save that failed earlier still stands (the toolbar shows it): this one saved nothing to make it untrue.
  if (s.snapshot?.saveFailure && s.snapshot.workspaceKey === opening) {
    if (!problems.length) toast(s.snapshot.saveFailure.kind === 'unfinished' ? 'A save did not finish. Close and reopen the project to finish it.' : 'A change could not be saved. Project health says what to do.', 'error');
    return;
  }
  if (!problems.length && !s.drafting && !s.leaving && !savesInFlight() && !editRunStatus(s) && s.snapshot?.workspaceKey === opening) toast('All changes are saved on this computer.', 'success');
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
  forgetKeptDrafts();
  // A question about the project that just went away has nothing left to decide.
  for (const q of [...pendingConfirms()]) if (q.title === LEAVE_QUESTION) q.resolve(null);
}

/** Text kept for being too long belongs to the opening it was typed in: once that has gone (leaving it was agreed,
 *  or another opening replaced it), the text goes, and so does what it held open. */
export function forgetKeptDrafts() {
  for (const field of clearKeptDrafts()) markDraft(keptDraftKey(field), false);
}

// Text kept for a page, image or row the project no longer has (removed here, by the AI, or by an Undo) goes, and
// is offered to copy: no field can show it again, so nothing should stay open for it. Not while the AI runs: what
// it removes comes back if it is stopped, so the check waits for the run to end.
useStore.subscribe((s, prev) => {
  if (!s.snapshot || s.snapshot.aiBusy) return;
  if (s.snapshot.state === prev.snapshot?.state && !prev.snapshot?.aiBusy) return;
  for (const [field, draft] of pruneKeptDrafts()) {
    markDraft(keptDraftKey(field), false);
    toast(goneReport(draft.name ?? ''), 'error', { label: 'Copy text', run: () => void navigator.clipboard?.writeText(draft.text).catch(() => undefined) });
  }
});

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
    body: problems.join(' '),
    details: [
      { kind: 'keep', text: 'Everything else you changed is saved.' },
      { kind: 'final', text: 'Leaving now discards that text for good.' }
    ],
    confirmLabel: 'Leave without it',
    cancelLabel: 'Keep editing',
    tone: 'caution',
    icon: 'leave'
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
