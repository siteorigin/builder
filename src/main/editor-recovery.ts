/**
 * A way back from a crashed editor (#886). When the editor window's page dies, the window would otherwise stay open and
 * blank: the person is asked instead, over that window, whether to reload the editor or close the window. The project
 * stays open in the main process, so the reloaded editor returns to it (App asks for the open project's snapshot).
 *
 * Each crash is asked about once, a turn after the crash's own cleanup has run (the leave gate it settles may be about
 * to close the window), and only while the window is still meant to stay: not when it is closing, the app is quitting,
 * or something else has already loaded the editor again (a File menu command does that through `recover`). An answer
 * that arrives after that is ignored, so a late one never reloads or closes an editor that has come back.
 *
 * No electron import: the caller passes the window's dialog, reload and close, so this is tested with stand-ins.
 */

export type RecoveryChoice = 'reload' | 'close';

export interface EditorRecoveryOptions {
  /** Whether the window is still meant to stay open: not destroyed or closing, and the app not quitting. */
  mayOffer: () => boolean;
  /** Ask the person what to do; aborting the signal withdraws the question. */
  ask: (signal: AbortSignal) => Promise<RecoveryChoice>;
  /** Load the editor again. */
  reload: () => void;
  /** Close the window. */
  close: () => void;
  /** Run after the current turn. Default: setImmediate. */
  defer?: (fn: () => void) => void;
}

/** Buttons of the crash question, in order: Reload Editor is the default and what Esc chooses. */
export const RECOVERY_BUTTONS = ['Reload Editor', 'Close Window'] as const;

/** The crash question's wording: the project open in the main process is what a reload returns to. */
export function crashQuestion(projectOpen: boolean) {
  return {
    type: 'warning' as const,
    buttons: [...RECOVERY_BUTTONS],
    defaultId: 0,
    // Closing the window is never what Esc does: on Windows and Linux it quits the app.
    cancelId: 0,
    message: 'The editor stopped unexpectedly',
    detail: projectOpen
      ? 'Reload the editor to return to your project. Text you were still typing may need to be entered again.'
      : 'Reload the editor to return to SiteOrigin Builder.'
  };
}

export function createEditorRecovery(opts: EditorRecoveryOptions) {
  const defer = opts.defer ?? ((fn: () => void) => void setImmediate(fn));
  /** Counts the window's crashes; `settled` is the last one dealt with (reloaded, closed, or replaced). */
  let crashes = 0;
  let settled = 0;
  let question: AbortController | null = null;

  const withdraw = () => {
    question?.abort();
    question = null;
  };
  const stillOpen = (crash: number) => crash === crashes && settled < crash && opts.mayOffer();

  const recover = (): boolean => {
    if (settled >= crashes) return false;
    settled = crashes;
    withdraw();
    opts.reload();
    return true;
  };

  return {
    /** The window's page died. */
    gone() {
      const crash = ++crashes;
      withdraw();
      defer(() => {
        if (!stillOpen(crash)) return;
        const q = new AbortController();
        question = q;
        opts.ask(q.signal).then(
          (choice) => {
            if (question === q) question = null;
            if (q.signal.aborted || !stillOpen(crash)) return;
            if (choice === 'reload') recover();
            else {
              settled = crash;
              opts.close();
            }
          },
          () => {
            if (question === q) question = null;
          }
        );
      });
    },
    /** Load a crashed editor again (Reload Editor, or a File menu command). Says whether it had crashed. */
    recover,
    /** A new page replaced the editor, or the window went: nothing is asked or done for a crash before it. */
    settle() {
      settled = crashes;
      withdraw();
    }
  };
}

export type EditorRecovery = ReturnType<typeof createEditorRecovery>;
