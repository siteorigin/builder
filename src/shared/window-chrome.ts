/**
 * The main window's own chrome on each platform (#1355). macOS keeps its traffic lights over the top bar (hiddenInset)
 * and the menu in the system menu bar. Windows has no native title bar or menu bar: the top bar runs to the window's
 * top edge with the system's caption buttons drawn over its right end (the window controls overlay), in the editor's
 * colors. Linux keeps the system frame, whose window manager draws the title and its buttons, but hides the menu bar.
 * Off macOS the application menu opens from a menu button at the top bar's left instead (WindowMenuButton.tsx), which
 * pops up the installed menu itself, so it can never drift from the one the accelerators run.
 *
 * No Electron import: main reads the window options from here and the editor reads the room to keep free.
 */

export type TitleBar = 'inset' | 'overlay' | 'system';

export interface WindowChrome {
  /** inset: macOS's traffic lights over the top bar; overlay: Windows's caption buttons over it; system: a framed window. */
  titleBar: TitleBar;
  /** The application menu opens from a button in the top bar (no menu bar shows). */
  menuButton: boolean;
}

export function windowChrome(platform: string): WindowChrome {
  if (platform === 'darwin') return { titleBar: 'inset', menuButton: false };
  return { titleBar: platform === 'win32' ? 'overlay' : 'system', menuButton: true };
}

/** The top bar's height (--toolbar-h in styles/tokens.css), which the caption buttons fill on Windows. */
export const TOP_BAR_HEIGHT = 52;

/** Where the menu button sits in the top bar, in CSS pixels: its left edge, top edge and size (28px, as the toolbar's icon buttons). */
export const MENU_BUTTON = { left: 10, top: 12, size: 28 } as const;

/** The room the menu button takes at the start of the top bar: the button and the gap after it. */
export const MENU_BUTTON_ROOM = 36;

/** Where the application menu opens from the keyboard (F10): under the menu button, as a click opens it. */
export const MENU_ANCHOR = { x: MENU_BUTTON.left, y: MENU_BUTTON.top + MENU_BUTTON.size } as const;

/** The caption buttons' width before the window reports it (three of 46px on Windows 11). */
export const CAPTION_BUTTONS_WIDTH = 138;

/** The caption buttons' colors: the top bar's --panel behind them and its --text for their symbols (styles/tokens.css). */
export function titleBarOverlay(scheme: 'light' | 'dark'): { color: string; symbolColor: string; height: number } {
  return scheme === 'dark' ? { color: '#171c25', symbolColor: '#e7ecf4', height: TOP_BAR_HEIGHT } : { color: '#f4f6f9', symbolColor: '#1c2742', height: TOP_BAR_HEIGHT };
}

/** The BrowserWindow options that give a platform its chrome. */
export function windowChromeOptions(platform: string, scheme: 'light' | 'dark') {
  switch (windowChrome(platform).titleBar) {
    case 'inset':
      return { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } };
    case 'overlay':
      return { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay(scheme) };
    default:
      return { titleBarStyle: 'default' as const };
  }
}

/** Whether a key press opens the application menu: F10 alone, as it opens a menu bar, on a platform with the menu button. */
export function opensMenuKey(platform: string, k: { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; isAutoRepeat?: boolean }): boolean {
  return windowChrome(platform).menuButton && k.key === 'F10' && !k.meta && !k.ctrl && !k.shift && !k.alt && !k.isAutoRepeat;
}

/** A point the editor sent (CSS pixels in its page) as the window's own pixels for Menu.popup, inside the window; null when it is not a point. */
export function popupPoint(at: unknown, zoom: number, content: { width: number; height: number }): { x: number; y: number } | null {
  if (!at || typeof at !== 'object') return null;
  const { x, y } = at as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, Math.floor(max) - 1), Math.round(v * z)));
  return { x: clamp(x, content.width), y: clamp(y, content.height) };
}
