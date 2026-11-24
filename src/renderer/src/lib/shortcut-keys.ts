/** The Mac's modifier glyphs, in the order Windows and Linux write their names. */
const MODIFIERS: ReadonlyArray<[glyph: string, name: string]> = [
  ['⌘', 'Ctrl'],
  ['⌃', 'Ctrl'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift']
];

/** Keys the Mac writes as a glyph and other platforms by name. Arrows read the same everywhere. */
const KEYS: Record<string, string> = { '⌫': 'Del', '⌦': 'Del', '↩': 'Enter', '↵': 'Enter', '⎋': 'Esc', '⇥': 'Tab' };

/**
 * A shortcut hint as a platform writes it (`platform` as Node names it: darwin, win32, linux). Hints are written once,
 * the Mac way (⌘J, ⇧⌘↑, ⌫), and read on Windows and Linux as Ctrl+J, Ctrl+Shift+↑ and Del. A hint already in another
 * platform's words ("Ctrl+C", "F2", "Shift+F10") comes back as it is, so formatting a hint twice changes nothing.
 */
export function shortcutLabel(keys: string, platform: string): string {
  if (platform === 'darwin') return keys;
  let i = 0;
  const held = new Set<string>();
  while (i < keys.length) {
    const mod = MODIFIERS.find(([glyph]) => keys.startsWith(glyph, i));
    if (!mod) break;
    held.add(mod[1]);
    i += mod[0].length;
  }
  const rest = keys.slice(i);
  const key = KEYS[rest] ?? rest;
  if (!held.size) return key;
  const names = ['Ctrl', 'Alt', 'Shift'].filter((n) => held.has(n));
  return `${names.join('+')}+${key}`;
}
