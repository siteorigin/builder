import { useSyncExternalStore } from 'react';
import { windowChrome } from '@shared/window-chrome';
import { captionButtonsWidth, toolbarChromeFor } from './layout';
import type { OverlayLike, ToolbarChrome } from './layout';
import { api } from '../store';

/**
 * The room the window's own chrome takes from the top of every screen (#1355), for the toolbar's tiers and, as CSS
 * variables on the root (`--chrome-start`, `--chrome-end`, with `data-chrome` naming the kind), for every screen's top
 * bar: the menu button at the start off macOS, and Windows's caption buttons at the end, measured from the window
 * controls overlay as the window reports it (zoom, scaling and full screen included). macOS keeps its traffic lights'
 * room in its own rules (`.mac`).
 */

/** The window controls overlay, where the window has one. */
const overlay = (): OverlayLike | null => ((navigator as Navigator & { windowControlsOverlay?: OverlayLike }).windowControlsOverlay ?? null);

/** The chrome's room as the window has it now. */
function read(): ToolbarChrome {
  const platform = api.platform;
  return toolbarChromeFor(platform, windowChrome(platform).titleBar === 'overlay' ? captionButtonsWidth(overlay(), window.innerWidth) : 0);
}

let current: ToolbarChrome | null = null;
const listeners = new Set<() => void>();

/** Mark the root with the chrome's kind and room, for every screen's top bar (CSS). */
function mark(chrome: ToolbarChrome) {
  const root = document.documentElement;
  root.dataset.chrome = windowChrome(api.platform).titleBar;
  if (!windowChrome(api.platform).menuButton) return;
  root.style.setProperty('--chrome-start', `${chrome.start}px`);
  root.style.setProperty('--chrome-end', `${chrome.end}px`);
}

function measure() {
  const next = read();
  mark(next);
  if (current && next.start === current.start && next.end === current.end && next.fullStart === current.fullStart) return;
  current = next;
  for (const l of listeners) l();
}

/** Window listeners, held while anything follows the chrome: as the window resizes, zooms and goes full screen. */
let stop: (() => void) | null = null;
function follow() {
  measure();
  const o = windowChrome(api.platform).titleBar === 'overlay' ? overlay() : null;
  window.addEventListener('resize', measure);
  o?.addEventListener('geometrychange', measure);
  stop = () => {
    window.removeEventListener('resize', measure);
    o?.removeEventListener('geometrychange', measure);
    stop = null;
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  if (!stop) follow();
  return () => {
    listeners.delete(l);
    if (!listeners.size) stop?.();
  };
};

const snapshot = () => (current ??= read());

/** The room the window's chrome takes from the toolbar now, kept up to date while the caller is mounted. */
export const useToolbarChrome = (): ToolbarChrome => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Mark the root before the first paint, so no screen draws its top bar under the chrome first. */
export const markWindowChrome = () => mark(snapshot());
