import { useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { MENU_BUTTON, windowChrome } from '@shared/window-chrome';
import { api } from '../store';
import { useToolbarChrome } from '../lib/window-chrome';
import './WindowMenuButton.css';

/**
 * The application menu's button, off macOS, where no menu bar shows (#1355): at the top bar's left on every screen the
 * window shows (Welcome, the editor and its skeleton, a guest's shell, the failure screens), as macOS's traffic lights
 * are. It asks the main process to pop up the installed menu under it, so the menu is the very one the accelerators
 * run, with the same items enabled. F10 presses it too (main hears the key wherever focus is: menu:open).
 *
 * Edit's Cut, Copy, Paste and Select All act on what has focus, so the button never takes it from a click, and when it
 * is reached by Tab and pressed (or F10 is, while it has focus), the field (or the preview frame) that last had typing
 * focus gets it back, with its selection, before the menu opens. It draws over a dialog's backdrop, as a menu bar
 * would, and a press of it is never a press outside whatever is open.
 */

/** What takes typing: a text field, a select, an editable region, or the preview's frame (whose own focus Edit acts on). */
const TEXT_INPUT = 'input:not([type=button],[type=checkbox],[type=radio],[type=submit],[type=reset],[type=range],[type=color],[type=file],[type=image])';
export const takesEditing = (el: Element): boolean =>
  el instanceof HTMLIFrameElement || el.matches(`${TEXT_INPUT}, textarea, select`) || !!el.closest('[contenteditable]:not([contenteditable="false"])');

/** Whether focus can go back to `el`: still in the page, not behind a dialog (inert), and drawn. */
const refocusable = (el: HTMLElement) => el.isConnected && !el.closest('[inert]') && el.getClientRects().length > 0;

/**
 * Follows the last element that took typing focus, and its selection when it is an editable region (focusing it again
 * can move the caret), until a press lands somewhere else that does not take typing. Returns how to stop following,
 * and how to give that element its focus back.
 */
export function followEditingTarget(doc: Document, isButton: (el: EventTarget | null) => boolean) {
  let target: HTMLElement | null = null;
  let range: Range | null = null;
  const focusin = (e: FocusEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el || isButton(el)) return;
    if (takesEditing(el)) {
      target = el;
      range = null;
    }
  };
  const focusout = (e: FocusEvent) => {
    if (!target || e.target !== target) return;
    const sel = doc.getSelection();
    range = sel && sel.rangeCount && target.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : null;
  };
  const pointerdown = (e: PointerEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el && !isButton(el) && !takesEditing(el)) target = range = null;
  };
  doc.addEventListener('focusin', focusin, true);
  doc.addEventListener('focusout', focusout, true);
  doc.addEventListener('pointerdown', pointerdown, true);
  return {
    stop() {
      doc.removeEventListener('focusin', focusin, true);
      doc.removeEventListener('focusout', focusout, true);
      doc.removeEventListener('pointerdown', pointerdown, true);
    },
    /** Focus the element that had typing focus, as it was; false when there is none to go back to. */
    restore(): boolean {
      if (!target || !refocusable(target)) return false;
      const saved = range;
      target.focus({ preventScroll: true });
      if (saved) {
        const sel = doc.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(saved);
      }
      return true;
    }
  };
}

export function WindowMenuButton() {
  const button = useRef<HTMLButtonElement>(null);
  const editing = useRef<ReturnType<typeof followEditingTarget> | null>(null);
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  // Keeps the chrome's room (the CSS variables every screen's top bar reads) up to date while the button is shown.
  useToolbarChrome();
  const popup = useRef(() => {});
  popup.current = () => {
    const b = button.current;
    if (!b || opened.current) return;
    // Reached by the keyboard, the button has focus: Edit acts on the field it came from, so that field has it back.
    if (document.activeElement === b) editing.current?.restore();
    const r = b.getBoundingClientRect();
    opened.current = true;
    setOpen(true);
    void api
      .popupMenu({ x: r.left, y: r.bottom })
      .catch(() => undefined)
      .finally(() => {
        opened.current = false;
        setOpen(false);
      });
  };
  useEffect(() => {
    const inButton = (el: EventTarget | null) => el instanceof Node && !!button.current?.contains(el);
    const follower = followEditingTarget(document, inButton);
    editing.current = follower;
    // A press of the button is the window's, as a press of a menu bar is: the page never hears it, so nothing open
    // (a popover, a note being written, a menu, the color picker's own window listener) takes it for a press outside
    // and closes, and focus stays where it is. Registered at startup, so it runs before any listener opened since.
    const press = (e: MouseEvent) => {
      if (!inButton(e.target)) return;
      e.stopImmediatePropagation();
      if (e.type === 'mousedown' && e.button === 0) e.preventDefault();
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('mousedown', press, true);
    // F10 (main hears the key wherever focus is) opens the menu as a press of the button does.
    const off = api.on('menu:open', () => popup.current());
    return () => {
      follower.stop();
      if (editing.current === follower) editing.current = null;
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('mousedown', press, true);
      off();
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className="icon-btn window-menu-button no-drag"
      style={{ left: MENU_BUTTON.left, top: MENU_BUTTON.top, width: MENU_BUTTON.size, height: MENU_BUTTON.size }}
      aria-label="Application menu"
      title="Menu (F10)"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-keyshortcuts="F10"
      data-testid="window-menu-button"
      onClick={(e) => {
        // Nor does the page hear the click.
        e.stopPropagation();
        popup.current();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown') return;
        e.preventDefault();
        popup.current();
      }}
    >
      <Menu aria-hidden="true" />
    </button>
  );
}

/** The menu button where this platform has one (Windows and Linux), and nothing on macOS. */
export function WindowChrome() {
  return windowChrome(api.platform).menuButton ? <WindowMenuButton /> : null;
}
