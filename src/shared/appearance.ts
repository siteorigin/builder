import type { Appearance } from './api';

/**
 * The editor's Appearance applies to the editor alone. Electron is left following this computer's setting, so the
 * website preview always sees what a visitor's browser here would; the editor draws itself in the chosen scheme
 * from a `data-appearance` attribute on its root element instead of the color-scheme media query.
 */

/** A saved Appearance as one the editor knows: anything but Light or Dark is System. */
export const knownAppearance = (appearance: unknown): Appearance => (appearance === 'light' || appearance === 'dark' ? appearance : 'system');

/** The scheme the editor is drawn in: the one chosen, or this computer's for System (and anything unknown). */
export function editorScheme(appearance: unknown, systemDark: boolean): 'light' | 'dark' {
  const known = knownAppearance(appearance);
  return known !== 'system' ? known : systemDark ? 'dark' : 'light';
}

/** The window's backing color: the editor's --bg in that scheme (styles.css), so it never flashes another color. */
export const editorBackground = (scheme: 'light' | 'dark') => (scheme === 'dark' ? '#11151c' : '#ebeff4');
