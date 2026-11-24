/** A key press as the main process and the editor both see it. */
export interface KeyChord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * The browser's own Back and Forward keys, which step through a visitor's journey in Preview: Cmd+[ and Cmd+] on
 * macOS, Alt+Left and Alt+Right elsewhere. Exactly those chords, so Cmd+Shift+[ (a tab switch elsewhere) or
 * Alt+Left with Ctrl held stays the page's.
 */
export function visitorStepKey(k: KeyChord, mac: boolean): 'back' | 'forward' | null {
  if (k.shift) return null;
  if (mac) {
    if (!k.meta || k.ctrl || k.alt) return null;
    return k.key === '[' ? 'back' : k.key === ']' ? 'forward' : null;
  }
  if (!k.alt || k.ctrl || k.meta) return null;
  return k.key === 'ArrowLeft' ? 'back' : k.key === 'ArrowRight' ? 'forward' : null;
}
