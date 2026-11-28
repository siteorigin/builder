/**
 * The main window's own chrome on each platform (#1355): macOS keeps hiddenInset and its menu bar; Windows draws its
 * caption buttons over the top bar in the editor's colors; Linux keeps its frame; both of those open the application
 * menu from a button (or F10) instead of a menu bar.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MENU_BUTTON, MENU_BUTTON_ROOM, TOP_BAR_HEIGHT, opensMenuKey, popupPoint, titleBarOverlay, windowChrome, windowChromeOptions } from '@shared/window-chrome';
import { createMenuPopups } from '../../src/main/app-menu-popup';
import { MAC_TOOLBAR_CHROME, captionButtonsWidth, toolbarChromeFor } from '../../src/renderer/src/lib/layout';

const tokens = readFileSync('src/renderer/src/styles/tokens.css', 'utf8');
/** A token's value in the light scheme (the first) or the dark one (under data-appearance='dark'). */
const token = (name: string, scheme: 'light' | 'dark') => {
  const dark = tokens.indexOf("[data-appearance='dark']");
  const part = scheme === 'light' ? tokens.slice(0, dark) : tokens.slice(dark);
  return part.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
};

describe('the window chrome by platform', () => {
  it('keeps macOS as it is: the traffic lights over the top bar and no menu button', () => {
    expect(windowChrome('darwin')).toEqual({ titleBar: 'inset', menuButton: false });
    expect(windowChromeOptions('darwin', 'light')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 } });
  });

  it('hides Windows’s title bar, drawing its caption buttons over the top bar in the bar’s colors', () => {
    expect(windowChrome('win32')).toEqual({ titleBar: 'overlay', menuButton: true });
    expect(windowChromeOptions('win32', 'dark')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay('dark') });
    for (const scheme of ['light', 'dark'] as const) {
      const o = titleBarOverlay(scheme);
      expect(o.color).toBe(token('panel', scheme));
      expect(o.symbolColor).toBe(token('text', scheme));
      expect(o.height).toBe(TOP_BAR_HEIGHT);
    }
    expect(tokens).toMatch(new RegExp(`--toolbar-h:\\s*${TOP_BAR_HEIGHT}px;`));
  });

  it('keeps Linux’s frame, with the menu button in place of its menu bar', () => {
    expect(windowChrome('linux')).toEqual({ titleBar: 'system', menuButton: true });
    expect(windowChromeOptions('linux', 'light')).toEqual({ titleBarStyle: 'default' });
  });

  it('opens the menu with F10 alone, where the menu button is, never repeated or with a modifier', () => {
    const k = { key: 'F10', meta: false, ctrl: false, shift: false, alt: false };
    expect(opensMenuKey('win32', k)).toBe(true);
    expect(opensMenuKey('linux', k)).toBe(true);
    expect(opensMenuKey('darwin', k)).toBe(false);
    expect(opensMenuKey('win32', { ...k, shift: true })).toBe(false);
    expect(opensMenuKey('win32', { ...k, ctrl: true })).toBe(false);
    expect(opensMenuKey('win32', { ...k, alt: true })).toBe(false);
    expect(opensMenuKey('win32', { ...k, meta: true })).toBe(false);
    expect(opensMenuKey('win32', { ...k, isAutoRepeat: true })).toBe(false);
    expect(opensMenuKey('win32', { ...k, key: 'F9' })).toBe(false);
    expect(MENU_BUTTON_ROOM).toBeGreaterThanOrEqual(MENU_BUTTON.size + MENU_BUTTON.left - 10);
  });
});

describe('where the menu pops up', () => {
  const content = { width: 1480, height: 920 };
  it('turns the page’s CSS pixels into the window’s at the editor’s zoom', () => {
    expect(popupPoint({ x: 10, y: 40 }, 1, content)).toEqual({ x: 10, y: 40 });
    expect(popupPoint({ x: 10, y: 40 }, 1.25, content)).toEqual({ x: 13, y: 50 });
    expect(popupPoint({ x: 10.4, y: 39.6 }, 0.9, content)).toEqual({ x: 9, y: 36 });
  });

  it('keeps it inside the window, and refuses anything that is not a point', () => {
    expect(popupPoint({ x: -5, y: 5000 }, 1, content)).toEqual({ x: 0, y: 919 });
    expect(popupPoint({ x: 10, y: 40 }, Number.NaN, content)).toEqual({ x: 10, y: 40 });
    for (const bad of [null, undefined, 3, 'x', {}, { x: 1 }, { x: '1', y: 2 }, { x: Infinity, y: 2 }, { x: 1, y: Number.NaN }]) expect(popupPoint(bad, 1, content)).toBeNull();
  });
});

describe('the menu popup', () => {
  /** A window that can go, and a menu shown over it that closes when told. */
  const stage = () => {
    const goneWatchers = new Set<() => void>();
    const shown: Array<() => void> = [];
    const watch = (gone: () => void) => {
      goneWatchers.add(gone);
      return () => goneWatchers.delete(gone);
    };
    const show = (closed: () => void) => shown.push(closed);
    return { goneWatchers, shown, watch, show, go: () => [...goneWatchers].forEach((g) => g()) };
  };

  it('shows one menu at a time and settles when it closes, letting go of the window', async () => {
    const popups = createMenuPopups();
    const s = stage();
    const first = popups.open(s.show, s.watch);
    const second = popups.open(s.show, s.watch);
    expect(second).toBe(first);
    expect(s.shown).toHaveLength(1);
    expect(popups.showing).toBe(true);
    s.shown[0]();
    s.shown[0]();
    await first;
    expect(popups.showing).toBe(false);
    expect(s.goneWatchers.size).toBe(0);
    // Closed, it shows again.
    void popups.open(s.show, s.watch);
    expect(s.shown).toHaveLength(2);
  });

  it('settles when its window goes first, and a menu closing after that changes nothing', async () => {
    const popups = createMenuPopups();
    const s = stage();
    const p = popups.open(s.show, s.watch);
    s.go();
    await p;
    expect(popups.showing).toBe(false);
    expect(s.goneWatchers.size).toBe(0);
    s.shown[0]();
    expect(popups.showing).toBe(false);
  });

  it('shows nothing over a window that is already going', async () => {
    const popups = createMenuPopups();
    const show = vi.fn();
    let unwatched = 0;
    await popups.open(show, (gone) => {
      gone();
      return () => void (unwatched += 1);
    });
    expect(show).not.toHaveBeenCalled();
    expect(unwatched).toBe(1);
    expect(popups.showing).toBe(false);
  });

  it('a menu that cannot be shown rejects, and lets go', async () => {
    const popups = createMenuPopups();
    const s = stage();
    await expect(
      popups.open(() => {
        throw new Error('no menu');
      }, s.watch)
    ).rejects.toThrow('no menu');
    expect(popups.showing).toBe(false);
    expect(s.goneWatchers.size).toBe(0);
  });
});

describe('the room the chrome takes from the toolbar', () => {
  it('is the traffic lights on macOS, the menu button on Linux, and the caption buttons too on Windows', () => {
    expect(toolbarChromeFor('darwin', 138)).toBe(MAC_TOOLBAR_CHROME);
    expect(toolbarChromeFor('linux', 138)).toEqual({ start: MENU_BUTTON_ROOM, end: 0, fullStart: MENU_BUTTON_ROOM });
    expect(toolbarChromeFor('win32', 150)).toEqual({ start: MENU_BUTTON_ROOM, end: 150, fullStart: MENU_BUTTON_ROOM });
  });

  it('measures the caption buttons from what the title bar area leaves of the window', () => {
    const overlay = (visible: boolean, x: number, width: number) => ({ visible, getTitlebarAreaRect: () => ({ x, width }) }) as never;
    expect(captionButtonsWidth(overlay(true, 0, 1342), 1480)).toBe(138);
    // Zoomed in to 125%, they take fewer CSS pixels.
    expect(captionButtonsWidth(overlay(true, 0, 1073.6), 1184)).toBe(111);
    // Full screen hides them.
    expect(captionButtonsWidth(overlay(false, 0, 0), 1480)).toBe(0);
    // Before the window reports them, and where it has no overlay, the usual three.
    expect(captionButtonsWidth(overlay(true, 0, 0), 1480)).toBe(138);
    expect(captionButtonsWidth(null, 1480)).toBe(138);
  });
});
