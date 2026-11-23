/**
 * Asks the editor window whether the open project may be left (closed, switched, or the app quit), after it
 * has saved what is still being typed. The editor answers 'leave' or 'stay', or 'asking' while the author
 * decides about a change that cannot be saved; only the time before that is bounded, since a person may
 * take as long as they like. Requests made while one is pending share its answer, so Close Project and
 * Quit pressed together show the author one question.
 *
 * No electron import: the caller passes how to reach the editor, so the gate is tested on its own.
 */

export type LeaveAnswer = 'leave' | 'stay' | 'asking';

export interface LeaveGateOptions {
  /** Send the request to the editor. False when there is no editor to ask (no window, or it crashed). */
  request: (requestId: string) => boolean;
  /** How long the editor may take before it answers or starts asking the author. */
  timeoutMs?: number;
  /** The editor has not answered in time (its page may be hung): ask the person whether to keep waiting or to
   *  leave anyway. The signal aborts when the editor answers meanwhile. Without it, waiting goes on. */
  onTimeout?: (signal: AbortSignal) => Promise<'wait' | 'leave'>;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function createLeaveGate(opts: LeaveGateOptions) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const newId = opts.newId ?? (() => Math.random().toString(36).slice(2));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  type Request = {
    id: string;
    promise: Promise<boolean>;
    resolve: (leave: boolean) => void;
    timer: unknown;
    question: AbortController | null;
    /** The editor said the author is deciding: no timeout runs, only a hang brings the question back. */
    asking: boolean;
  };
  let current: Request | null = null;

  const end = (leave: boolean) => {
    const c = current;
    if (!c) return;
    current = null;
    if (c.timer !== null) clearTimer(c.timer);
    c.question?.abort();
    c.resolve(leave);
  };

  // An editor that neither answers nor starts asking the author in time may be hung. Leaving on its own could
  // drop a change it is about to save; never leaving would make a hung page impossible to close or quit. So
  // the person decides: keep waiting (asked again later) or leave anyway.
  const askPerson = (c: Request) => {
    if (current !== c || c.question || !opts.onTimeout) return;
    const q = new AbortController();
    c.question = q;
    // Waiting goes on: on a timer while the editor has not answered, or until it hangs again while the
    // author is deciding.
    const keepWaiting = () => {
      c.question = null;
      if (!c.asking) arm(c);
    };
    void opts.onTimeout(q.signal).then(
      (choice) => {
        // The editor answered (or started asking the author) meanwhile: this question no longer counts.
        if (current !== c || q.signal.aborted) return;
        if (choice === 'leave') end(true);
        else keepWaiting();
      },
      // The question could not be shown: keep waiting rather than drop a change.
      () => current === c && !q.signal.aborted && keepWaiting()
    );
  };
  const arm = (c: Request) => {
    c.timer = setTimer(() => {
      c.timer = null;
      askPerson(c);
    }, timeoutMs);
  };

  return {
    /** Resolves true when the project may be left, false when the author chose to keep editing. */
    ask(): Promise<boolean> {
      if (current) return current.promise;
      let resolve!: (leave: boolean) => void;
      const promise = new Promise<boolean>((r) => (resolve = r));
      const id = newId();
      const c: Request = { id, promise, resolve, timer: null, question: null, asking: false };
      current = c;
      // With no editor to ask, nothing typed can be waiting: whatever reached the project is saved.
      if (!opts.request(id)) {
        end(true);
        return promise;
      }
      if (current === c) arm(c);
      return promise;
    },
    /** The editor's reply. Replies to an earlier or unknown request are ignored. */
    reply(requestId: string, answer: LeaveAnswer) {
      const c = current;
      if (!c || c.id !== requestId) return;
      if (answer === 'asking') {
        c.asking = true;
        if (c.timer !== null) clearTimer(c.timer);
        c.timer = null;
        c.question?.abort();
        c.question = null;
        return;
      }
      if (answer === 'leave' || answer === 'stay') end(answer === 'leave');
    },
    /** The editor window closed or its page crashed: nothing it held can be saved, so leaving goes ahead. */
    editorGone() {
      end(true);
    },
    /** The editor page stopped responding (it hung, perhaps with the author's question open): ask the person
     *  now whether to keep waiting or leave anyway. */
    editorUnresponsive() {
      const c = current;
      if (!c) return;
      if (c.timer !== null) clearTimer(c.timer);
      c.timer = null;
      askPerson(c);
    },
    /** The editor page responds again: it can answer for itself, so the person's question is withdrawn. */
    editorResponsive() {
      const c = current;
      if (!c?.question) return;
      c.question.abort();
      c.question = null;
      if (!c.asking) arm(c);
    },
    /** The editor page was replaced (reloaded) mid-question: the request it never answered is dropped, and
     *  the action that asked does not go ahead; asking again reaches the new page. */
    editorReplaced() {
      end(false);
    },
    get pending() {
      return current !== null;
    }
  };
}

export type LeaveGate = ReturnType<typeof createLeaveGate>;
