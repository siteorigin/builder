/**
 * Whether an Edit → Undo or Redo activation came from its key (Cmd/Ctrl+Z and so on) rather than from choosing
 * the item. Electron reports any activation without a mouse button as `triggeredByAccelerator`, including Return
 * in a menu worked with the keyboard; only a key press holds the accelerator's Command (macOS) or Ctrl key.
 */
export function menuKeyCopy(event: { triggeredByAccelerator?: boolean; metaKey?: boolean; ctrlKey?: boolean } | undefined, mac: boolean): boolean {
  return !!event?.triggeredByAccelerator && !!(mac ? event.metaKey : event.ctrlKey);
}
