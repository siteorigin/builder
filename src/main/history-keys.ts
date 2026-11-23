/** How long after an Undo or Redo key press the Edit menu's copy of it can still arrive. */
const PAIRING_MS = 1000;

/**
 * Pairs an Edit → Undo or Redo activation with the key press behind it. The main process forwards every Undo and
 * Redo key press to the editor (before-input-event), and the same press reaches the menu's accelerator too when
 * the page leaves it alone. The editor must know which menu activations are that second copy, so it can run each
 * press once. Electron's `triggeredByAccelerator` alone cannot say: it is also set when the menu itself is worked
 * with the keyboard (arrow keys, then Return), which nothing forwarded.
 */
export class HistoryKeyPairing {
  private pressedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Every key press the window receives; `history` when it is an Undo or Redo chord that was forwarded. */
  keyDown(history: boolean) {
    this.pressedAt = history ? this.now() : null;
  }

  /** An Edit → Undo or Redo activation: true when it is the menu's copy of the Undo or Redo key just pressed. */
  menuActivated(triggeredByAccelerator: boolean): boolean {
    const paired = triggeredByAccelerator && this.pressedAt !== null && this.now() - this.pressedAt < PAIRING_MS;
    this.pressedAt = null;
    return paired;
  }
}
