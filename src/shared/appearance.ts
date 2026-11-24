import type { Appearance } from './api';

/**
 * The editor's Appearance applies to the editor alone. Electron is left following this computer's setting, so the
 * website preview always sees what a visitor's browser here would; the editor draws itself in the chosen scheme
 * from a `data-appearance` attribute on its root element instead of the color-scheme media query.
 */

/** The scheme the editor is drawn in: the one chosen, or this computer's for System (and anything unknown). */
export function editorScheme(appearance: unknown, systemDark: boolean): 'light' | 'dark' {
  return appearance === 'light' || appearance === 'dark' ? appearance : systemDark ? 'dark' : 'light';
}

/** The window's backing color: the editor's --bg in that scheme (styles.css), so it never flashes another color. */
export const editorBackground = (scheme: 'light' | 'dark') => (scheme === 'dark' ? '#11151c' : '#f2f4f7');

/** How a new window is told its Appearance, so the editor's first paint is already in it (see the preload). */
export const APPEARANCE_SWITCH = '--so-appearance=';
export const appearanceSwitch = (appearance: Appearance) => `${APPEARANCE_SWITCH}${appearance}`;

/** The Appearance a window was opened with; System when it was not given one. */
export function appearanceFromArgv(argv: readonly string[]): Appearance {
  const value = argv.find((a) => a.startsWith(APPEARANCE_SWITCH))?.slice(APPEARANCE_SWITCH.length);
  return value === 'light' || value === 'dark' ? value : 'system';
}
