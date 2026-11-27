/**
 * A native colour picker reports every step of a drag, and each save takes a while: the site is generated again and
 * written durably, a second or more on a large project. Sent one by one, a drag's steps queue dozens of saves that the
 * page then shows one after another, long after the pointer has stopped (#970). A gate, one per swatch, sends a pick at
 * once when none of its own is being saved, and otherwise holds only the newest, sent as soon as the save before it
 * has been answered: never more than one of a swatch's saves waits in the main process, and the last colour picked is
 * the one that lands.
 *
 * A held pick goes where it was picked for (its `send` was made then), even once its swatch has gone: the picker closed
 * mid-drag, the panel changed. Anything else on its way to the project (an edit made elsewhere, an Undo, a request to
 * the AI) sends every held pick first (sendHeldPicks), so the main process takes them in the order the author made
 * them, as it did when every step was sent. Held picks always go in the order they were picked: one whose save before
 * it is answered first sends any picked before it on other swatches. A settle (Save, Close Project) waits for a
 * swatch's picks until the last of them has been answered.
 *
 * Plain module state with no DOM or store import, so the rules are tested on their own.
 */
import { trackApply } from './pending';

/** Saves the pick and returns what its save returns (a promise), for the gate to wait on. */
export type PickSend = () => unknown;

export interface PickGate {
  /** Take a pick: sent now, or held in place of a pick held before it, which is let go (its `dropped` is called). */
  pick(send: PickSend, dropped?: () => void): void;
}

/** Every gate's held pick, by the function that sends it at once, with the order it was picked in. */
const held = new Map<() => void, number>();
let picked = 0;
/** Held picks are being sent: one whose save sends an edit of its own (and so asks for them again) sends no other out of turn. */
let sending = false;

/** Send the held picks picked no later than `upTo`, oldest first. */
function sendHeld(upTo = Infinity): void {
  if (sending) return;
  sending = true;
  try {
    for (const [flush, at] of [...held].sort((a, b) => a[1] - b[1])) if (at <= upTo) flush();
  } finally {
    sending = false;
  }
}

/** Send every held pick now, oldest first, ahead of what is about to reach the project. */
export function sendHeldPicks(): void {
  sendHeld();
}

export function pickGate(): PickGate {
  /** This gate's picks sent and not answered yet. */
  let running = 0;
  let waiting: { send: PickSend; dropped?: () => void } | null = null;
  /** Ends the settle's wait for this gate's picks, once none is held or being saved. */
  let drained: (() => void) | null = null;
  const flush = () => {
    const w = waiting;
    if (!w) return;
    waiting = null;
    held.delete(flush);
    run(w.send);
  };
  const run = (send: PickSend) => {
    running++;
    let saved: Promise<unknown>;
    try {
      saved = Promise.resolve(send());
    } catch (e) {
      saved = Promise.reject(e);
    }
    // A save refused or failed has said so itself (commitOps, the swatch): the next pick goes all the same.
    void saved
      .catch(() => undefined)
      .then(() => {
        running--;
        if (running) return;
        if (waiting) return sendHeld(held.get(flush));
        const done = drained;
        drained = null;
        done?.();
      });
  };
  return {
    pick(send, dropped) {
      if (!drained) trackApply(new Promise((resolve) => (drained = () => resolve({ ok: true }))));
      if (!running) return run(send);
      waiting?.dropped?.();
      waiting = { send, dropped };
      // Its place is the newest pick's: a pick held on another swatch since then goes first.
      held.delete(flush);
      held.set(flush, ++picked);
    }
  };
}
