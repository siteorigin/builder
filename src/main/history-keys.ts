import { matchesShortcut, type ShortcutChord } from '@shared/shortcuts';
import { visitorStepKey } from '@shared/preview-keys';

/**
 * Whether an Edit → Undo or Redo activation came from its key (Cmd/Ctrl+Z and so on) rather than from choosing
 * the item. Electron reports any activation without a mouse button as `triggeredByAccelerator`, including Return
 * in a menu worked with the keyboard; only a key press holds the accelerator's Command (macOS) or Ctrl key.
 */
export function menuKeyCopy(event: { triggeredByAccelerator?: boolean; metaKey?: boolean; ctrlKey?: boolean } | undefined, mac: boolean): boolean {
  return !!event?.triggeredByAccelerator && !!(mac ? event.metaKey : event.ctrlKey);
}

/**
 * Whether the main process hands a real key press to the editor as a shortcut (it may have been pressed with the
 * preview frame focused, where the editor cannot see it). `askAi` is the Edit with AI binding in use (#750), so a moved
 * shortcut works from the preview too and the old one is no longer passed on for it.
 */
export function forwardsKey(k: ShortcutChord, askAi: string, mac: boolean): boolean {
  const mod = k.meta || k.ctrl;
  const key = k.key.toLowerCase();
  return (
    // With Shift held, macOS reports the backslash key as "|".
    (mod && ['z', 'y', 'k', 'd', 'c', 'v', 's', 'e', 'f', '\\', '|', 'arrowup', 'arrowdown'].includes(key)) ||
    matchesShortcut(k, askAi, mac) ||
    // Wrap in Stack and Ungroup; with Alt it is another key (AltGr on some layouts).
    (mod && !k.alt && key === 'g') ||
    (!mod && ['delete', 'backspace', 'escape'].includes(key)) ||
    // Back and Forward through a visitor's journey in Preview.
    !!visitorStepKey(k, mac)
  );
}
