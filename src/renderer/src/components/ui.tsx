import { isImeComposing } from '../lib/ime';
import { oneLine } from '../lib/one-line';
import { shortcutLabel } from '../lib/shortcut-keys';
import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode, type RefObject } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createPortal, flushSync } from 'react-dom';
import { Check, ChevronDown, CircleAlert, CircleCheck, Info, Pencil, X } from 'lucide-react';
import { aiActivity, api, applyHeld, commitDraft, discardHeld, dismissToast, editRunStatus, markDraft, StoreViewContext, toast, undoAvailable, useStore, type HeldEdit, type PendingEdit } from '../store';
import { afterLanding, isSettling, reportRefused, retainRefused, type Refocusable } from '../lib/pending';
import { heldPrompt, type HeldAction } from '../lib/held';
import { dropKeptDraft, goneReport, keepDraft, keptDraft, keptDraftKey, keptField, keptOnLeave, keptRefusal, limitNote, tooLongReport, unsavedReport } from '../lib/kept-drafts';
import { runPhase } from '../lib/savestate';
import type { ProjectSnapshot } from '@shared/api';
import type { PropSchema } from '@shared/types';
import { isEmptyPropValue, requiredHint } from '@shared/required';
import { RenameOffer } from './RenameOffer';
import { JoinRequests } from './JoinRequests';

// Editable content counts (the code editor's text area is one), so Tab order and wrapping inside a dialog see it.
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Whether an element is on screen and can take focus: rendered and visible (not in a hidden panel), enabled,
 *  and not inert. */
const reachable = (n: HTMLElement) => n.offsetParent !== null && !n.closest('[inert]') && !n.matches(':disabled') && getComputedStyle(n).visibility !== 'hidden';
/** The Tab stops inside `root` (within `scope` when given): focusable, on screen and not left out of the Tab
 *  order, so a roving group (radios, tabs) counts once, at its current option. */
const tabStops = (root: HTMLElement, scope?: string) => [...root.querySelectorAll<HTMLElement>(scope ? `${scope} :is(${FOCUSABLE})` : FOCUSABLE)].filter((n) => n.tabIndex >= 0 && reachable(n));

/** The notices' dismiss buttons. They sit outside every dialog, and stay in its Tab order so a notice can be
 *  dismissed from the keyboard while it is open. */
const dismissStops = () => [...document.querySelectorAll<HTMLElement>('.toasts .toast-dismiss')].filter(reachable);

/** Dialogs currently open, innermost last; global shortcuts stay out of the way while any is open. */
export const openDialogs: HTMLElement[] = [];
const dialogWatchers = new Set<() => void>();
const dialogsChanged = () => dialogWatchers.forEach((fn) => fn());
const watchDialogs = (fn: () => void) => {
  dialogWatchers.add(fn);
  return () => void dialogWatchers.delete(fn);
};
/** Whether any dialog is open, kept current as dialogs open and close. */
export const useDialogOpen = () => useSyncExternalStore(watchDialogs, () => openDialogs.length > 0);

/**
 * Keyboard model shared by every dialog (WAI-ARIA APG dialog pattern). Dialogs render in a portal and the
 * app root is made inert while any is open, so nothing behind can be reached. Focus moves inside on open
 * (explicit autofocus, else the first control in the body, else the footer's first action), Tab and
 * Shift+Tab stay inside (and on the notices' dismiss buttons, which come after its last control), Escape
 * closes (unless a control inside already handled it), and focus returns to whatever opened the dialog. Attach the returned handler as the dialog's onKeyDown.
 */
export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Captured during render, before any autofocus inside the dialog moves focus.
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== 'undefined') {
    const a = (document.activeElement as HTMLElement | null) ?? document.body;
    // Opened from a menu item: return to what opened the menu, since the item is about to disappear.
    openerRef.current = a.closest('[role="menu"]') ? (menuReturn.target ?? a) : a;
  }
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = openerRef.current;
    // If the opener is gone when the dialog closes (the panel re-rendered, say after connecting AI), focus
    // lands in the same panel instead of jumping across the window.
    const region = opener?.closest<HTMLElement>('[role="tabpanel"], .side-panel-view, .toolbar') ?? null;
    openDialogs.push(el);
    const root = document.getElementById('root');
    if (root && !root.contains(el)) root.inert = true;
    // Only the top dialog is live: the one below (and toasts) wait until it closes.
    const below = openDialogs[openDialogs.length - 2]?.closest<HTMLElement>('.overlay-backdrop');
    if (below) below.inert = true;
    document.body.classList.add('dialog-open');
    dialogsChanged();
    if (!el.contains(document.activeElement)) {
      const asked = [...el.querySelectorAll<HTMLElement>('[data-autofocus]')].find(reachable);
      const first = asked ?? tabStops(el, '.modal-body')[0] ?? tabStops(el, '.modal-foot')[0] ?? el;
      first.focus();
      // A control that refused focus leaves it on the dialog itself, never outside it.
      if (!el.contains(document.activeElement)) el.focus();
    }
    // If focus falls out of the dialog (a button inside disabled or unmounted itself), keys still belong
    // to the dialog: Escape closes it and Tab brings focus back in.
    const stray = (e: KeyboardEvent) => {
      // A menu opened from the dialog (portalled outside it) handles its own keys, and so does an input method.
      if (e.defaultPrevented || openMenus.count || openDialogs[openDialogs.length - 1] !== el || el.contains(e.target as Node)) return;
      if (e.isComposing || e.keyCode === 229) return;
      // Holding Escape on a field that has just let go of focus is still one press.
      if (e.key === 'Escape') (e.preventDefault(), !e.repeat && closeRef.current());
      else if (e.key === 'Tab') {
        e.preventDefault();
        const stops = tabStops(el);
        const cycle = [...stops, ...dismissStops()];
        const at = cycle.indexOf(e.target as HTMLElement);
        // From a notice, on to the next stop; from anywhere else, back in, in the direction pressed (the dialog
        // itself when it has no stops left).
        const next = at < 0 ? (e.shiftKey ? stops[stops.length - 1] : stops[0]) : cycle[(at + (e.shiftKey ? -1 : 1) + cycle.length) % cycle.length];
        (next ?? el).focus();
      }
    };
    window.addEventListener('keydown', stray);
    return () => {
      window.removeEventListener('keydown', stray);
      openDialogs.splice(openDialogs.indexOf(el), 1);
      if (root && !openDialogs.length) root.inert = false;
      if (below) below.inert = false;
      if (!openDialogs.length) document.body.classList.remove('dialog-open');
      dialogsChanged();
      const visible = (n: HTMLElement | null) => !!n && document.contains(n) && reachable(n);
      const inRegion = region && document.contains(region) ? [...region.querySelectorAll<HTMLElement>('textarea, input, [tabindex="0"], button:not([disabled])')].find(visible) : undefined;
      const back = visible(opener) && !opener!.closest('[role="menu"]') ? opener : inRegion ?? [...document.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"], [role="option"][aria-selected="true"]')].find(visible) ?? null;
      // Only restore when focus has nowhere better to be (a dialog action may have focused something new), or is
      // still on a notice it went to from this dialog.
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body || at.closest('.toast-dismiss')) back?.focus();
      });
    };
  }, [ref]);
  return (e: React.KeyboardEvent) => {
    const el = ref.current;
    if (!el || openDialogs[openDialogs.length - 1] !== el || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (isImeComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = tabStops(el);
    const notices = dismissStops();
    if (!items.length && !notices.length) return e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const outside = i === -1 && (document.activeElement === el || !el.contains(document.activeElement));
    if (e.shiftKey && ((items.length > 0 && i === 0) || outside)) (e.preventDefault(), (notices[notices.length - 1] ?? items[items.length - 1]).focus());
    // Focus on a programmatically focusable element (tabindex -1, such as a result region) tabs on natively.
    else if (!e.shiftKey && ((items.length > 0 && i === items.length - 1) || outside)) (e.preventDefault(), (outside ? (items[0] ?? notices[0]) : (notices[0] ?? items[0])).focus());
  };
}

/**
 * The one dialog shell. `footer` holds the actions: the dismiss-only action is always a secondary "Close".
 * The title icon is quiet (--text-2) unless the dialog gives it a meaning hue. A press on the backdrop closes
 * it, except with `dismissOnBackdrop={false}`: a dialog over work in progress, whose close would cancel that
 * work, ends only by its own buttons, Escape, or the close button.
 */
export function Modal({ title, icon, onClose, children, footer, wide, describedBy, busy, dismissOnBackdrop = true }: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; describedBy?: string; busy?: boolean; dismissOnBackdrop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // While busy (creating a project, opening a trusted one), only the dialog's own buttons can end it.
  const close = () => !busy && onClose();
  const onKeyDown = useDialogFocus(ref, close);
  // A dialog is on screen whatever opened it: one opened from a hidden panel (lib/hideable) still reads the store as
  // it is now.
  return createPortal(
    <StoreViewContext.Provider value={null}>
      <div className="overlay-backdrop" onMouseDown={(e) => dismissOnBackdrop && e.target === e.currentTarget && close()}>
        <div ref={ref} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} onKeyDown={onKeyDown}>
          <div className="modal-head">
            {icon}
            <h2 className="grow" id={titleId}>
              {title}
            </h2>
            <button className="icon-btn" onClick={close} disabled={busy} aria-label="Close" title={busy ? undefined : 'Close (Esc)'}>
              <X />
            </button>
          </div>
          {/* Scrolled, the dialog is marked so its header draws a rule over the content that has gone under it. */}
          <div className="modal-body" onScroll={(e) => ref.current?.toggleAttribute('data-scrolled', e.currentTarget.scrollTop > 0)}>
            {children}
          </div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    </StoreViewContext.Provider>,
    document.body
  );
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  hint?: string;
  /** A second, quieter line under the label that says what the item means. */
  description?: string;
  /** The item's full accessible name, when its visible words are shorter. */
  ariaLabel?: string;
  /** A radio choice: the run of neighbouring items with `checked` set is one group, and one of them is chosen. */
  checked?: boolean;
  /** With `checked`, an independent on/off item (menuitemcheckbox) instead: any number of them can be on. */
  toggle?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  heading?: string;
}

/** Number of popup menus open; global editor shortcuts stay out of the way while one is. */
export const openMenus = { count: 0 };
/** The trigger of the most recently used menu, so a dialog opened from a menu item can return focus to it. */
const menuReturn: { target: HTMLElement | null } = { target: null };
const ITEM = '[role^="menuitem"]:not([data-disabled], [aria-disabled="true"])';

/** Whether the last input was a key. A keyboard-opened menu lands on its first item (its last for
 *  `focusLast`); a pointer-opened one focuses the menu itself and waits for the arrow keys, so a click never
 *  shows a highlight the pointer did not make. Tracked here rather than by Radix, because the menu mounts
 *  after the key that opened it. */
let keyboardInput = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (keyboardInput = true), true);
  window.addEventListener('pointerdown', () => (keyboardInput = false), true);
}
/** Pointer input this window cannot see (a click in the page preview frame) reported by whoever saw it. */
export function notePointerInput() {
  keyboardInput = false;
}

type Box = { left: number; top: number; width: number; height: number };
const boxOf = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/**
 * Popup menu, built on Radix DropdownMenu (WAI-ARIA APG menu pattern). It opens at a point (right-click) or
 * against a trigger, flipping and shifting to stay 8px inside the window. A keyboard-opened menu focuses
 * its first available item (its last with `focusLast`); Up/Down wrap, Home/End jump, letters jump by label,
 * Enter/Space choose, Escape or Tab close. Unavailable items are reached by the arrows but do nothing. It is
 * modal, so the first press outside (in the page preview too) only closes it. Focus returns to the trigger (else whatever had focus when it opened) unless an action
 * moved it somewhere, such as into a dialog.
 */
export function Menu({ x, y, items, onClose, label, alignEnd, returnTo, trigger, focusLast, above }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string; alignEnd?: boolean; returnTo?: HTMLElement | null; trigger?: HTMLElement; focusLast?: boolean; above?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  // Who gets focus back when the menu closes: the trigger, else whatever had focus when it opened.
  const opener = useRef<HTMLElement | null>(returnTo ?? (document.activeElement as HTMLElement | null));
  // If an action removes the opener (Delete removes the chip), focus stays in the same region instead.
  const region = useRef<HTMLElement | null>(opener.current?.closest<HTMLElement>('.canvas, [role="tabpanel"], .side-panel-view, .toolbar') ?? null);
  /** Set when Tab closed the menu: focus then continues from the opener in that direction (APG menu). */
  const tabbed = useRef<0 | 1 | -1>(0);
  const [anchor, setAnchor] = useState<Box>(() => (trigger ? boxOf(trigger) : { left: x, top: y, width: 0, height: 0 }));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const checked = items.findIndex((it) => it.checked && !it.toggle);
  const radios = items.some((it) => it.checked !== undefined);
  // One leading slot holds an item's icon or its check, so every label starts in the same column.
  const lead = radios || items.some((it) => it.icon);
  useEffect(() => {
    if (!keyboardInput) return;
    requestAnimationFrame(() => {
      const list = [...(contentRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
      (focusLast ? list[list.length - 1] : list[0])?.focus();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    openMenus.count++;
    const close = () => closeRef.current();
    // Follow a trigger that moves with the layout; close if it goes away.
    const follow = () => (trigger ? (trigger.isConnected ? setAnchor(boxOf(trigger)) : close()) : undefined);
    window.addEventListener('blur', close);
    window.addEventListener('resize', follow);
    return () => {
      openMenus.count--;
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', follow);
      const dir = tabbed.current;
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const o = opener.current;
        const back = o && o.isConnected ? o : fallbackIn(region.current);
        back?.focus({ preventScroll: true });
        if (dir && back) stepTab(back, dir);
      }, 0);
    };
  }, [trigger]);
  const choose = (it: MenuItem) => {
    menuReturn.target = opener.current;
    it.onSelect?.();
  };
  const body = items.map((it, i) =>
    it.separator ? (
      <DropdownMenu.Separator key={i} className="menu-sep" />
    ) : it.heading ? (
      <DropdownMenu.Label key={i} className="menu-label">
        {it.heading}
      </DropdownMenu.Label>
    ) : (
      (() => {
        const toggle = it.checked !== undefined && !!it.toggle;
        const radio = it.checked !== undefined && !toggle;
        const indicator = (
          <DropdownMenu.ItemIndicator className="check">
            <Check />
          </DropdownMenu.ItemIndicator>
        );
        // An unavailable item stays in the arrow-key order (APG menu: disabled items are focusable, so the
        // author can find what exists), but choosing it does nothing and leaves the menu open.
        const props = { className: `menu-item${it.danger ? ' danger' : ''}${it.description ? ' described' : ''}`, 'aria-disabled': it.disabled || undefined, 'aria-label': it.ariaLabel, 'aria-describedby': it.ariaLabel && it.description ? `${idBase}-d${i}` : undefined, textValue: it.label, onSelect: (e: Event) => (it.disabled ? e.preventDefault() : choose(it)) };
        const inner = (
          <>
            {lead && <span className="menu-lead">{it.icon ?? (radio || toggle ? indicator : null)}</span>}
            {it.description ? (
              <span className="grow menu-text">
                <span>{it.label}</span>
                <span className="menu-desc" id={`${idBase}-d${i}`}>
                  {it.description}
                </span>
              </span>
            ) : (
              <span className="grow">{it.label}</span>
            )}
            {it.hint && <span className="hint">{it.hint}</span>}
            {/* Written the Mac way (⌘D, ⌫) and named as this platform names the keys. */}
            {it.shortcut && <span className="kbd">{shortcutLabel(it.shortcut, api.platform)}</span>}
            {(radio || toggle) && it.icon && <span className="menu-trail">{indicator}</span>}
          </>
        );
        return toggle ? (
          <DropdownMenu.CheckboxItem key={i} checked={!!it.checked} {...props}>
            {inner}
          </DropdownMenu.CheckboxItem>
        ) : radio ? (
          <DropdownMenu.RadioItem key={i} value={String(i)} {...props}>
            {inner}
          </DropdownMenu.RadioItem>
        ) : (
          <DropdownMenu.Item key={i} {...props}>
            {inner}
          </DropdownMenu.Item>
        );
      })()
    )
  );
  return (
    <DropdownMenu.Root open modal onOpenChange={(o) => !o && closeRef.current()}>
      {createPortal(
        <DropdownMenu.Trigger asChild>
          <span className="menu-anchor" aria-hidden="true" tabIndex={-1} style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }} />
        </DropdownMenu.Trigger>,
        document.body
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          className={`menu${lead ? ' has-lead' : ''}`}
          // Named by its label, not by the hidden anchor Radix would otherwise point at.
          aria-label={label}
          aria-labelledby={undefined}
          side={above ? 'top' : 'bottom'}
          align={alignEnd ? 'end' : 'start'}
          sideOffset={trigger ? 4 : 0}
          collisionPadding={8}
          loop
          // Focus goes back to the opener in the cleanup above, and only when nothing else claimed it.
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Keys used by the menu stay in the menu: the menu closes before the event would reach the editor's
          // shortcuts, so without this Escape would also deselect and Enter would act on the page.
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== 'Tab') return;
            e.preventDefault();
            tabbed.current = e.shiftKey ? -1 : 1;
            closeRef.current();
          }}
        >
          {radioRuns(items, body, checked)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Wrap each run of consecutive checkable items in its own radio group; everything else stays a plain item. */
function radioRuns(items: MenuItem[], body: ReactNode[], checked: number): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < items.length; ) {
    if (items[i].checked === undefined || items[i].toggle) {
      out.push(body[i]);
      i++;
      continue;
    }
    const start = i;
    while (i < items.length && items[i].checked !== undefined) i++;
    out.push(
      <DropdownMenu.RadioGroup key={`radio-${start}`} value={checked >= start && checked < i ? String(checked) : ''}>
        {body.slice(start, i)}
      </DropdownMenu.RadioGroup>
    );
  }
  return out;
}

const visibleEl = (n: HTMLElement) => n.isConnected && n.offsetParent !== null;
/** The first thing to focus in a region whose own control went away: itself if it takes focus, else its first control. */
function fallbackIn(region: HTMLElement | null): HTMLElement | null {
  if (!region || !region.isConnected) return null;
  if (region.tabIndex >= 0 || region.hasAttribute('tabindex')) return region;
  return [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visibleEl) ?? null;
}
/** Move focus one Tab stop on from `from`, as the Tab that closed a menu would have. */
function stepTab(from: HTMLElement, dir: 1 | -1) {
  const stops = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.tabIndex >= 0 && visibleEl(n) && !n.closest('[inert]'));
  const i = stops.indexOf(from);
  const next = i < 0 ? null : stops[i + dir];
  next?.focus();
}

let menuKey = 0;

const onWindowResize = (fn: () => void) => {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
};
/** The window's width in CSS pixels (the editor fills the window), kept current as it is resized. */
export const useWindowWidth = () => useSyncExternalStore(onWindowResize, () => window.innerWidth);

/** Hook that shows a menu at a position, or below its trigger (which gets aria-expanded while open). */
export function useMenu() {
  const [menu, setMenu] = useState<{ key: number; x: number; y: number; items: MenuItem[]; label?: string; trigger?: HTMLElement; alignEnd?: boolean; returnTo?: HTMLElement | null; focusLast?: boolean; above?: boolean } | null>(null);
  useEffect(() => {
    if (!menu?.trigger) return;
    const t = menu.trigger;
    t.setAttribute('aria-expanded', 'true');
    return () => t.setAttribute('aria-expanded', 'false');
  }, [menu]);
  const close = useCallback(() => setMenu(null), []);
  /** Close the menu if its trigger has left the page (a toolbar control that moved into another menu). */
  const closeIfTriggerGone = useCallback(() => setMenu((m) => (m?.trigger && !m.trigger.isConnected ? null : m)), []);
  const node = menu ? (() => {
    const { key, ...props } = menu;
    return <Menu key={key} {...props} returnTo={menu.trigger ?? menu.returnTo} onClose={close} />;
  })() : null;
  return {
    node,
    isOpen: !!menu,
    close,
    closeIfTriggerGone,
    /** Open at a point (right-click); focus returns to `returnTo` (the row) on close. */
    open: (x: number, y: number, items: MenuItem[], label?: string, returnTo?: HTMLElement | null) => setMenu({ key: ++menuKey, x, y, items, label, returnTo }),
    /** Open below a trigger button; small icon triggers align the menu's right edge with theirs. With
     *  `focusLast` (Up arrow on the trigger), a keyboard-opened menu starts on its last item. With `above`, it opens
     *  over the trigger instead (a control at the foot of a panel, so the menu does not cover what sits under it). */
    openAt: (el: HTMLElement, items: MenuItem[], label?: string, opts?: { focusLast?: boolean; above?: boolean }) => {
      if (menu?.trigger === el) return setMenu(null);
      const r = el.getBoundingClientRect();
      const narrow = r.width < 48;
      setMenu({ key: ++menuKey, x: narrow ? r.right : r.left, y: r.bottom + 4, items, label, trigger: el, alignEnd: narrow, focusLast: opts?.focusLast, above: opts?.above });
    }
  };
}

/**
 * Tabs (WAI-ARIA APG tabs pattern): one tab stop, Left/Right/Home/End move and activate. Tabs renders the
 * panels as well as the tabs, every one of them, so each tab's aria-controls always names an element on the
 * page. A panel's content is rendered only while it is shown, unless `keepMounted` keeps it (and its state)
 * while hidden.
 */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
  idBase,
  className = 'tabs',
  keepMounted = false,
  panelClassName,
  panelStyle,
  panelsStyle
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode; extra?: ReactNode; panel: () => ReactNode }>;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
  className?: string;
  keepMounted?: boolean;
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  /** When set, the panels are wrapped in one element with this style. */
  panelsStyle?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const next = options[(n + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${idBase}-tab-${next.value}`)}`)?.focus());
  };
  const panels = options.map((o) => (
    <div key={o.value} role="tabpanel" id={`${idBase}-panel-${o.value}`} aria-labelledby={`${idBase}-tab-${o.value}`} className={panelClassName} style={panelStyle} hidden={o.value !== value}>
      {keepMounted || o.value === value ? o.panel() : null}
    </div>
  ));
  return (
    <>
      <div ref={ref} className={className} role="tablist" aria-label={label} onKeyDown={move}>
        {options.map((o) => (
          <button key={o.value} id={`${idBase}-tab-${o.value}`} role="tab" className={className === 'tabs' ? 'tab' : 'dock-tab'} aria-selected={value === o.value} aria-controls={`${idBase}-panel-${o.value}`} tabIndex={value === o.value ? 0 : -1} onClick={() => onChange(o.value)}>
            {o.icon}
            {o.label}
            {o.extra}
          </button>
        ))}
      </div>
      {panelsStyle ? <div style={panelsStyle}>{panels}</div> : panels}
    </>
  );
}

/**
 * A collapsible section (WAI-ARIA APG accordion/disclosure). `level` makes its header row a heading at that
 * level, so assistive technology can move between sections by heading. The controlled region always exists
 * (hidden while closed) so aria-controls resolves; its children mount only while open.
 */
export function Section({ title, children, defaultOpen = true, actions, id, scope, level, remember = true, keepMounted }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string; scope?: ReactNode; level?: number; remember?: boolean; /** Keep the fields inside while closed, so text kept in one (refused, unsaved) is still there when it opens. */ keepMounted?: boolean }) {
  // `remember: false` for a section with nothing in it: closing it says nothing about the others that share its ID.
  const key = id && remember ? `section:${id}` : null;
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => (key && localStorage.getItem(key) !== null ? localStorage.getItem(key) === '1' : defaultOpen));
  const [landing, setLanding] = useState<{ focus?: string } | null>(null);
  // A section that starts being remembered (it gained something to show) takes the saved choice.
  useEffect(() => {
    const saved = key ? localStorage.getItem(key) : null;
    if (saved !== null) setOpen(saved === '1');
  }, [key]);
  useEffect(() => {
    if (!id) return;
    const onOpen = (e: Event) => {
      // The section's ID alone (as older callers send it) opens and scrolls to it.
      const detail = (e as CustomEvent<string | { id: string; scroll?: boolean; focus?: string }>).detail;
      const { id: target, scroll = true, focus } = typeof detail === 'string' ? { id: detail } : (detail ?? { id: '' });
      if (target !== id) return;
      setOpen(true);
      if (key) localStorage.setItem(key, '1');
      // Opened on the way to something inside it, which then takes the scroll and the focus itself.
      if (scroll) setLanding({ focus });
    };
    window.addEventListener('inspector-open-section', onOpen);
    return () => window.removeEventListener('inspector-open-section', onOpen);
  }, [id, key]);
  // A kept-mounted field exists while hidden. Start scrolling only after React has opened the section.
  useLayoutEffect(() => {
    if (!landing) return;
    const frame = requestAnimationFrame(() => {
      const el = rootRef.current;
      const scroller = el?.closest<HTMLElement>('.panel-body');
      if (!el || !scroller) return;
      const control = (landing.focus && el.querySelector<HTMLElement>(landing.focus)) || null;
      const head = scroller.querySelector<HTMLElement>('.insp-head')?.offsetHeight ?? 0;
      const top = (control ?? el).getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - head;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroller.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
      (control ?? el.querySelector<HTMLElement>('.section-head'))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [landing]);
  return (
    <div className="section" ref={rootRef}>
      <div className="row" role={level ? 'heading' : undefined} aria-level={level}>
        <button
          className="section-head grow"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            if (key) localStorage.setItem(key, open ? '0' : '1');
          }}
        >
          <ChevronDown className="chev" />
          {title}
          {scope && <span className="scope">{scope}</span>}
        </button>
        {actions}
      </div>
      {open || keepMounted ? (
        <div className="section-body" id={bodyId} hidden={!open}>
          {children}
        </div>
      ) : (
        <div id={bodyId} hidden />
      )}
    </div>
  );
}

/** A field to return to, opening the closed Section that keeps it first (Keep editing after leaving a project). */
function revealable(el: HTMLElement, reveal?: () => void): Refocusable {
  return {
    get isConnected() {
      return el.isConnected;
    },
    inside: (root) => root instanceof Node && root.contains(el),
    focus: () => {
      reveal?.();
      const body = el.closest<HTMLElement>('.section-body[hidden]');
      if (body?.id) document.querySelector<HTMLButtonElement>(`.section-head[aria-controls="${CSS.escape(body.id)}"]`)?.click();
      // What shows it renders over the next frames: keep trying until the field can take focus.
      const tryFocus = (frames: number) => {
        el.focus();
        if (document.activeElement !== el && frames > 0) requestAnimationFrame(() => tryFocus(frames - 1));
      };
      tryFocus(10);
    }
  };
}

/** A labelled field. The label, hint and error are wired to the single control child (id, aria-describedby). */
/**
 * Open (and scroll to) a collapsible Section by its id. `scroll: false` only opens it; `focus`, a selector
 * inside it, names the control to scroll to and focus instead of the section's heading.
 */
export function openSection(id: string, opts: { scroll?: boolean; focus?: string } = {}) {
  window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: { id, scroll: opts.scroll ?? true, focus: opts.focus } }));
}

export function Field({ label, children, hint, error, extra, controlId: explicitId }: { label?: ReactNode; children: ReactNode; hint?: ReactNode; error?: ReactNode; extra?: ReactNode; controlId?: string }) {
  const generated = useId();
  const id = explicitId ?? generated;
  const noteId = `${id}-note`;
  const labelable = (t: unknown) => t === 'input' || t === 'select' || t === 'textarea' || t === DraftInput;
  const only = Children.count(children) === 1 && isValidElement(children) && labelable(children.type) ? (children as ReactElement<Record<string, unknown>>) : null;
  // A composite child (a field plus its buttons) passes controlId and wires `${controlId}-note` itself. A single control
  // keeps an ID of its own, and the label names that one.
  const controlId = (only?.props.id as string | undefined) ?? explicitId ?? (only ? id : undefined);
  const note = error || hint;
  // A single control is described by the note (beside any description of its own, in the order it gives when it
  // wires the note itself) and marked by the error, whether its ID was given or generated.
  const own = ((only?.props['aria-describedby'] as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  const describedBy = (note && !own.includes(noteId) ? [noteId, ...own] : own).join(' ') || undefined;
  const control = only ? cloneElement(only, { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : only.props['aria-invalid'] }) : children;
  // A composite child (a segmented control, a row of fields) is named as a group by the label instead.
  const grouped = !controlId && !!label;
  return (
    <div className="field">
      {label &&
        (grouped ? (
          <div className="field-label" id={`${id}-label`}>
            <span className="grow">{label}</span>
            {extra}
          </div>
        ) : (
          <label htmlFor={controlId}>
            <span className="grow">{label}</span>
            {extra}
          </label>
        ))}
      {grouped ? (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={note ? noteId : undefined}>
          {control}
        </div>
      ) : (
        control
      )}
      {error ? (
        <div className="field-error" id={noteId}>
          {error}
        </div>
      ) : hint ? (
        <div className="field-hint" id={noteId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A row of mutually exclusive options. With `radio` it is exposed as a radio group (WAI-ARIA APG): one tab
 * stop, and the arrow keys move and select. `labelledBy` and `describedBy` name it from visible text.
 */
export function Segmented<T extends string>({ value, options, onChange, full, label, radio, labelledBy, describedBy }: { value: T; options: Array<{ value: T; label?: ReactNode; icon?: ReactNode; title?: string; /** Unavailable: shown, skipped by the arrow keys. */ disabled?: boolean }>; onChange: (v: T) => void; full?: boolean; label?: string; radio?: boolean; labelledBy?: string; describedBy?: string }) {
  const chosen = options.findIndex((o) => o.value === value);
  // The tab stop: the chosen option, or the first available one when the chosen one is unavailable (or none is chosen).
  const current = chosen >= 0 && !options[chosen].disabled ? chosen : Math.max(0, options.findIndex((o) => !o.disabled));
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || !options.length) return;
    e.preventDefault();
    // From the focused option, since a saved value can lag behind quick presses.
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = from < 0 ? current : from;
    for (let n = 0; n < options.length; n++) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    if (options[next].disabled) return;
    onChange(options[next].value);
    buttons[next]?.focus();
  };
  return (
    <div className={`segmented${full ? ' full' : ''}`} role={radio ? 'radiogroup' : 'group'} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={radio ? move : undefined}>
      {options.map((o, i) => (
        <button key={o.value} type="button" {...(radio ? { role: 'radio', 'aria-checked': value === o.value, tabIndex: i === current ? 0 : -1 } : { 'aria-pressed': value === o.value })} disabled={o.disabled} onClick={() => onChange(o.value)} title={o.title} aria-label={o.label ? undefined : o.title}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A segmented choice with a visible label above it and, optionally, a hint under it: the label names the group (a
 * radio group, so one tab stop and the arrow keys) and the hint describes it. Use it wherever a Segmented answers a
 * question the surrounding form does not already ask.
 */
export function ChoiceField<T extends string>({ label, hint, value, options, onChange, full }: { label: ReactNode; hint?: ReactNode; value: T; options: Array<{ value: T; label?: ReactNode; icon?: ReactNode; title?: string; /** Unavailable: shown, skipped by the arrow keys. */ disabled?: boolean }>; onChange: (v: T) => void; full?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-label" id={`${id}-label`}>
        {label}
      </div>
      <Segmented radio full={full} labelledBy={`${id}-label`} describedBy={hint ? `${id}-hint` : undefined} value={value} options={options} onChange={onChange} />
      {hint && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Said after a field's name when its component requires a value there: in its label, so its accessible name says so too. */
export function RequiredMark() {
  return (
    <span className="field-required">
      <span className="sr-only">, </span>required
    </span>
  );
}

/** What a field a component requires says while its value is empty: its own, or the default it shows. */
export const missingNote = (schema: PropSchema, value: unknown): string | undefined => (schema.required && isEmptyPropValue(schema, value) ? `Required, but empty: ${requiredHint(schema)}.` : undefined);

export function Switch({ checked, onChange, label, id, labelledBy, describedBy, disabled: own }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string; labelledBy?: string; describedBy?: string; disabled?: boolean }) {
  const disabled = useContext(LockedFieldsContext) || own;
  return <button id={id} className="switch" role="switch" aria-checked={checked} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** A switch with its visible label and optional hint, all clickable and wired together. */
export function SwitchRow({ checked, onChange, label, hint, id: explicitId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; id?: string; disabled?: boolean }) {
  const generated = useId();
  // A switch a destination focuses has an ID of its own (see open-destination).
  const id = explicitId ?? generated;
  return (
    <div className="switch-row">
      <div className="grow">
        <label htmlFor={id} id={`${id}-l`}>
          {label}
        </label>
        {hint && (
          <div className="field-hint" id={`${id}-h`}>
            {hint}
          </div>
        )}
      </div>
      <Switch id={id} checked={checked} onChange={onChange} labelledBy={`${id}-l`} describedBy={hint ? `${id}-h` : undefined} disabled={disabled} />
    </div>
  );
}

/** Why text typed in a checked field can't be saved, and a correction to offer ("Add https://"). */
export interface DraftProblem {
  message: string;
  /** The text most likely meant, for a button beside the field to save instead. */
  suggestion?: string;
  /** That button's label. */
  fix?: string;
}

/** What a control beside a field built on DraftInput can do with it beyond typing. */
export interface DraftHandle {
  /** Put this text in the field and save it, as typing it and leaving the field would (a checked field's fix). */
  commit: (text: string) => void;
  /** Commit `text` now as its own undo step (a formatting command's result), checked as typing is when the AI ran. */
  commitNow: (text: string) => unknown;
}

/** Where the fields inside belong in the project, joined to the place around them: a `root` (a node) starts a
 *  place, a `part` (one of its properties, a list row) narrows one and means nothing outside one. A field that
 *  keeps text too long to save finds it again by this place when it comes back (see lib/kept-drafts). */
interface Home {
  key: string;
  /** Whether the place is still in the project; a part narrows its root's. */
  alive?: () => boolean;
}
const FieldHomeContext = createContext<Home | null>(null);

/**
 * Fields that can be read but not changed (a project open read-only, a synced post): inside it every DraftInput is
 * read-only, so its text can still be focused, selected and copied, and every Switch is disabled. Other controls (an
 * image picker, a select) are disabled by their place, as a fieldset does.
 */
const LockedFieldsContext = createContext(false);
export const LockedFields = LockedFieldsContext.Provider;
export const useLockedFields = () => useContext(LockedFieldsContext);
export function FieldHome({ root, part, alive, children }: { root?: string; part?: string; alive?: () => boolean; children: ReactNode }) {
  const outer = useContext(FieldHomeContext);
  const within = outer?.alive;
  const home: Home | null = root ? { key: root, alive } : outer && part ? { key: `${outer.key}|${part}`, alive: alive && within ? () => within() && alive() : (alive ?? within) } : null;
  return <FieldHomeContext.Provider value={home}>{children}</FieldHomeContext.Provider>;
}
export const useFieldHome = () => useContext(FieldHomeContext);

/** What a commit returns for text over the field's limit: refused before it is sent, and kept for shortening. */
const TOO_LONG = Symbol('too long');

/** A field's visible name, from its label (or its accessible name), for messages about what was typed in it. */
function fieldName(el: HTMLInputElement | HTMLTextAreaElement, ariaLabel?: string): string {
  const label = el.labels?.[0];
  return (label?.querySelector('.grow')?.textContent ?? label?.textContent ?? ariaLabel ?? '').trim();
}

interface DraftInputProps {
  id?: string;
  /** For a single-line field: the input type, such as "date". */
  type?: string;
  /** The most characters the project keeps for this field. The field counts against it as the author types,
   *  and text over it, typed or pasted, is kept whole and refused, with the reason beside the field. */
  limit?: number;
  /** With `limit`, for a short name: the count shows only while the field is focused, or once the text nears or
   *  passes the limit, so a list of names is not a column of counts. Long text keeps its count in view. */
  quietCount?: boolean;
  /** Where this field's text belongs in the project (a page's description, an image's alt text), so text
   *  refused for being too long, or by `check`, is kept for it while it is off screen. Without it, text too long is
   *  offered to copy when the field goes away. */
  keep?: string;
  /** With `keep`: whether what the field belongs to is still in the project. Kept text whose page, image or row is
   *  removed goes, offered to copy. */
  keepWhile?: () => boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  value: string;
  onCommit: (v: string, edit?: PendingEdit) => unknown;
  /** Filled in with the field's DraftHandle. */
  handle?: RefObject<DraftHandle | null>;
  /** The input or textarea itself. */
  inputRef?: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onLive?: (v: string) => void;
  multiline?: boolean;
  /** A single line of text that wraps (a post's title, a table cell): all of it shows, Enter saves it as in any
   *  single-line field, and line breaks, however they arrive, become spaces. Without `multiline`, which keeps lines. */
  wrap?: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
  check?: (v: string) => DraftProblem | null;
  onProblem?: (problem: DraftProblem | null) => void;
  /**
   * Hears whether the field holds text other than the saved value, and the text it shows: as it is typed, when text
   * refused for being too long is shown again, and when Escape puts the saved value back.
   */
  onDirty?: (dirty: boolean, draft: string) => void;
  /** Shows the field (its panel may be closed) before leaving the project's Keep editing returns to it. */
  reveal?: () => void;
  /** Readable, selectable and focusable, never changed (also inside LockedFields). */
  readOnly?: boolean;
}

/** Text input that commits on blur/Enter and keeps a local draft while focused. `onCommit` returns false when
 *  it refuses the value (its own check, such as a page with no title), so leaving the project can say so.
 *  With `check`, text it refuses is never sent: it stays in the field as an unsaved draft, its reason given to
 *  `onProblem` for beside the field, until it is corrected (checked again as it is typed), saved or discarded
 *  with Escape, instead of the saved value coming back. */
export function DraftInput(props: DraftInputProps) {
  // Another place is another field: one that keeps refused text starts afresh, with that place's own.
  return <DraftField key={props.keep ?? ''} {...props} />;
}

/** What is said about text a field's check refused. */
const refusedReport = (name: string) => (name ? `What you typed in ${name} can’t be saved.` : 'Something you typed can’t be saved.');

/** Where the author started typing: the project, the text and the commit as they were then (see DraftField). */
interface DraftStart {
  base: ProjectSnapshot | null;
  value: string;
  commit: (v: string, edit?: PendingEdit) => unknown;
  ai: number;
}

/**
 * Text too long for a field, refused somewhere else (an inline rename), handed to the field that keeps it: the
 * field shows it, refused and marked not saved, until it is shortened and saved or put back, as if typed there.
 */
export function keepRefusedText(keep: string, text: string, start: DraftStart, name: string, limit: number, alive?: () => boolean): void {
  const field = keptField(useStore.getState().snapshot?.workspaceKey, keep);
  keepDraft<DraftStart>(field, { text, start, name, alive });
  markDraft(keptDraftKey(field), true, tooLongReport(name, text.length, limit));
}

function DraftField({
  value,
  onCommit,
  onLive,
  multiline,
  wrap,
  className = 'input',
  placeholder,
  rows,
  ariaLabel,
  autoFocus,
  id,
  type,
  limit,
  quietCount,
  keep,
  keepWhile,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  check,
  onProblem,
  onDirty,
  reveal,
  handle,
  inputRef,
  readOnly: ownReadOnly
}: DraftInputProps) {
  const readOnly = useContext(LockedFieldsContext) || !!ownReadOnly;
  // Text this field refused, kept while it was off screen (another page was open, or the same page's settings showed in
  // another place): too long to save, or refused by `check`.
  const [field] = useState(() => (keep ? keptField(useStore.getState().snapshot?.workspaceKey, keep) : null));
  const [restored] = useState(() => (field ? keptDraft<DraftStart>(field) : undefined));
  const restoredAs = keptRefusal(restored);
  // Each control keeps its place's text as its own; a newer one (text handed over from a rename, or taken up by the
  // same field in another place) is never overwritten or dropped by a control that has gone.
  const owner = useRef({});
  const mine = () => !field || !keptDraft(field) || keptDraft(field)!.owner === owner.current;
  const [draft, setDraft] = useState(restored?.text ?? value);
  // Text over the limit was refused: it stays, marked as not saved, until it is shortened and saved, or the
  // saved text is put back (Escape). The project changing meanwhile never replaces it.
  const [tooLong, setTooLongState] = useState(restoredAs === 'long');
  const tooLongRef = useRef(restoredAs === 'long');
  const setTooLong = (on: boolean) => {
    tooLongRef.current = on;
    setTooLongState(on);
    if (!on && field) dropKeptDraft(field);
  };
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // The field itself, kept here and handed to a parent that asked for it (`inputRef`).
  const setInput = useCallback(
    (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      input.current = el as (HTMLInputElement & HTMLTextAreaElement) | null;
      if (inputRef) inputRef.current = el;
    },
    [inputRef]
  );
  const focused = useRef(false);
  const cancelled = useRef(false);
  // A field that has gone never puts a saved value back, nor clears a mark another control of its place now holds.
  const mounted = useRef(true);
  // Report an uncommitted edit to the toolbar, so it never says "Saved" over text that is still a draft. A field
  // that keeps refused text marks it under its place, so the mark outlives the control while the text is kept.
  const generatedKey = useId();
  const draftKey = field ? keptDraftKey(field) : generatedKey;
  const mark = (on: boolean, note?: string) => markDraft(draftKey, on, note);
  // A commit the project rejects (an empty title) leaves the stored value unchanged: show it again.
  const valueRef = useRef(value);
  valueRef.current = value;
  // What the author started from, recorded at the first keystroke: the text, the project, and the commit
  // as they were then. If the AI ran while they typed, the edit is built from exactly that and checked
  // against it before it is applied (at once when the AI is idle), so it never lands on a field or value
  // the AI changed meanwhile. Otherwise it is applied now, built from the field as it is now, but only while
  // the field still holds what it held when typing began: one changed somewhere else meanwhile (its file
  // saved outside the app) keeps both versions for the author to choose between. A field nobody typed in
  // commits nothing. Text the project refused stays a draft, start and all.
  const startedAt = useRef<DraftStart | null>(restored?.start ?? null);
  // Refused text taken up on mount, until the project's value has first been read against it.
  const restoringRef = useRef(restoredAs === 'check');
  const forget = () => (startedAt.current = null);
  // Text `check` refused, kept as a draft after the field was left (or by another control of its place), and the reason
  // shown for it.
  const kept = useRef(restoredAs === 'check');
  const shown = useRef<DraftProblem | null>(null);
  const showProblem = (p: DraftProblem | null) => {
    if (p?.message === shown.current?.message && p?.suggestion === shown.current?.suggestion) return;
    shown.current = p;
    onProblem?.(p);
  };
  const release = () => {
    // Text its check refused, kept for its place, is settled too (unless a newer control of the place keeps it).
    if (kept.current && field && keptRefusal(keptDraft(field)) === 'check' && mine()) dropKeptDraft(field);
    kept.current = false;
    showProblem(null);
    retainRefused(draftKey, null);
  };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // A field follows the project until the author types in it, focused or not, so typing always starts
  // from what the project holds. Text refused for being too long stays whatever the project does meanwhile.
  // Refused text it keeps stays while the saved value changes under it (an undo, the AI), until the project
  // holds that very text.
  useEffect(() => {
    if (tooLongRef.current) return;
    if (kept.current && startedAt.current) {
      if (draftRef.current === value) {
        forget();
        release();
        mark(false);
        return;
      }
      // The saved value it was refused against is gone, and the refusal beside the field says what is saved
      // instead: the edit that corrects it starts from that. Text already corrected shows no saved value, so it
      // keeps its start, and a change made meanwhile is still caught as one. Refused text taken up from another
      // control of its place starts from what is saved now too, when that changed while it was away (an undo); and
      // what is kept for the place follows, so the control that shows it next starts there as well.
      const restoring = restoringRef.current;
      restoringRef.current = false;
      if (shown.current || (restoring && startedAt.current.value !== value && !!check?.(draftRef.current))) {
        startedAt.current = { base: useStore.getState().snapshot, value, commit: onCommit, ai: aiActivity() };
        if (field) stash(draftRef.current, startedAt.current, 'check');
      }
      return;
    }
    restoringRef.current = false;
    if (!focused.current) forget();
    if (!startedAt.current) setDraft(value);
  }, [value]);
  useEffect(() => onDirty?.(draft !== value, draft), [draft, value, onDirty]);
  // Text once refused is checked again as it is corrected and as the project changes (the translations it named
  // unlinked, or linked again): its reason comes and goes with it.
  useEffect(() => {
    const el = input.current;
    if (!kept.current || !check || !el) return;
    const p = draftRef.current === valueRef.current ? null : check(draftRef.current);
    showProblem(p);
    if (p) retainRefused(draftKey, named(el), revealable(el, reveal));
    else retainRefused(draftKey, null);
  });
  const aiRan = (from: { ai: number }) => !!useStore.getState().snapshot?.aiBusy || aiActivity() !== from.ai;
  /** Commit what was typed; returns what the commit returned (false: the project refused it; TOO_LONG: the
   *  text is over the limit and was not sent). */
  const commit = (text: string): unknown => {
    const from = startedAt.current;
    if (!from || text === from.value) return forget();
    if (limit !== undefined && text.length > limit) return TOO_LONG;
    // Text refused for being too long is corrected in the field as it is shown now (the AI chose another picture
    // meanwhile, say): once the AI is idle the edit is built from that, and still checked against where typing began.
    // While it still runs, stopping it takes the project back there, so the edit is built from that instead.
    const build = tooLongRef.current && !useStore.getState().snapshot?.aiBusy ? onCommit : from.commit;
    const result = aiRan(from) ? commitDraft(from.base, () => build(text), text, { check: true, control: owner.current }) : commitDraft(from.base, () => onCommit(text), text, { control: owner.current });
    if (result !== false) forget();
    return result;
  };
  // A field removed while the author is typing in it and the AI ran (it removed the page the field belongs
  // to, so the panel moved on) keeps what was typed, checked before it is applied. Removed any other way (a
  // file saved outside the app removed its page), what was typed is offered to copy: nothing is written for a
  // field that is no longer there. Text too long to save, focused or not, stays with the field's place when it
  // has one (another page was opened), and is offered to copy when it has none.
  const nameRef = useRef(restored?.name ?? '');
  // Kept as soon as it is refused and kept current as it is edited, so a control of the same place that comes up
  // before this one has gone (the field moved into a group) finds it too.
  const stash = (text: string, start: DraftStart, refused?: 'check') => field && keepDraft<DraftStart>(field, { text, start, name: nameRef.current, alive: keepWhile, owner: owner.current, ...(refused ? { refused } : {}) });
  useEffect(() => {
    mounted.current = true;
    // Text found for this place on mount is this control's to keep from now on, unless the project already holds it
    // (an undo put that very text back while it was away): then it is settled, and nothing is kept.
    const found = field ? keptDraft<DraftStart>(field) : undefined;
    if (field && restored && found) {
      if (tooLongRef.current || kept.current) keepDraft<DraftStart>(field, { ...found, owner: owner.current });
      else if (found.owner === restored.owner) dropKeptDraft(field);
    }
    return () => {
      mounted.current = false;
      retainRefused(draftKey, null);
      const from = startedAt.current;
      const text = draftRef.current;
      const over = limit !== undefined && text.length > limit;
      const snap = useStore.getState().snapshot;
      const open = !!from?.base && !cancelled.current && text !== from.value && snap?.workspaceKey === from.base.workspaceKey;
      // What the field belonged to was removed (its page, image or row): nothing is kept for a place that has gone. Not
      // while the AI runs: what it removed comes back if it is stopped, and the check waits for the run to end.
      const gone = !!field && !!keepWhile && !snap?.aiBusy && !keepWhile();
      const refused = tooLongRef.current || kept.current;
      const fate = field ? keptOnLeave({ open, gone, over, tooLong: tooLongRef.current, checked: kept.current, mine: mine() }) : null;
      // Too long to save, or refused and shortened but not saved yet: it stays with the field's place.
      if (fate === 'long') {
        stash(text, from!);
        markDraft(draftKey, true, over ? tooLongReport(nameRef.current, text.length, limit!) : unsavedReport(nameRef.current));
        return;
      }
      // Refused by its check: it stays with the field's place too, still not saved, and leaving the project says why.
      if (fate === 'check') {
        stash(text, from!, 'check');
        markDraft(draftKey, true);
        retainRefused(draftKey, refusedReport(nameRef.current));
        return;
      }
      // Refused text a newer control of the same place has taken up is that control's.
      if (open && field && !gone && (over || refused) && !mine()) return;
      // Refused text kept for a place that has gone was offered to copy as it went, unless it was kept only after that
      // (the field left as its page went): then it is offered here.
      const offered = gone && refused && !keptDraft(field!);
      // Kept text this field held is settled; text kept by another control of the same place is left to it.
      if (fate === 'drop') dropKeptDraft(field!);
      if (!field || !keptDraft(field)) markDraft(draftKey, false);
      // Refused by its check with no place to keep it, and left before it went (the selection changed): offered to copy.
      const dropped = refused && !field && !focused.current;
      if (!open || offered || !(focused.current || over || (gone && refused) || dropped)) return;
      const copy = { label: 'Copy text', run: () => void navigator.clipboard?.writeText(text).catch(() => undefined) };
      if (over) toast(`${tooLongReport(nameRef.current, text.length, limit!)} The field went away, so copy it to keep it.`, 'error', copy);
      else if (gone && refused) toast(goneReport(nameRef.current), 'error', copy);
      else if (dropped) toast(`${refusedReport(nameRef.current)} The field went away, so copy it to keep it.`, 'error', copy);
      else if (aiRan(from!)) commitDraft(from!.base, () => from!.commit(text), text, { check: true, control: owner.current });
      else if (text.trim()) toast('What you were typing was not saved, because the field went away.', 'error', copy);
    };
  }, []);
  // Each focus or keystroke starts a new edit: putting the saved value back for an earlier one must not
  // overwrite it. And text held back while the project was being left (Keep editing) is still a draft.
  const edit = useRef(0);
  const held = useRef(false);
  const refusedLast = useRef(!!restored);
  const named = (el: HTMLInputElement | HTMLTextAreaElement) => refusedReport(fieldName(el, ariaLabel));
  /** Leave the field with this text: commit it, or (refused) say so; the saved value comes back after, unless
   *  `check` refused it or it is too long to save, which keeps it. */
  const leave = (text: string, el: HTMLInputElement | HTMLTextAreaElement) => {
    const from = startedAt.current;
    const problem = check && from && text !== from.value ? check(text) : null;
    if (problem) {
      // Nothing is sent: the text stays, unsaved, with its reason beside it, until it is corrected or discarded.
      edit.current++;
      kept.current = true;
      refusedLast.current = true;
      held.current = false;
      // Kept for its place at once, so the same field shown elsewhere next (even in the same render) finds it.
      nameRef.current = fieldName(el, ariaLabel);
      stash(text, from!, 'check');
      mark(true);
      showProblem(problem);
      retainRefused(draftKey, named(el), revealable(el, reveal));
      reportRefused(named(el), draftKey, revealable(el, reveal));
      return;
    }
    const result = commit(text);
    // Too long to save: the whole text stays, marked as not saved, for the author to shorten. Nothing is put
    // back, now or once leaving the project is decided.
    if (result === TOO_LONG) {
      nameRef.current = fieldName(el, ariaLabel);
      const report = tooLongReport(nameRef.current, text.length, limit!);
      refusedLast.current = true;
      setTooLong(true);
      stash(text, startedAt.current!);
      mark(true, report);
      reportRefused(report, draftKey, el);
      return;
    }
    if (tooLongRef.current) setTooLong(false);
    const refused = result === false;
    refusedLast.current = refused;
    if (!refused) release();
    // While the project is being left, refused text stays a draft until the author decides about it.
    held.current = isSettling();
    mark(refused && held.current);
    if (refused) reportRefused(named(el), draftKey, el);
    // The saved value comes back once the change has landed or been refused: until then the field shows what was
    // typed, never the value from before it. While the project is being left, the typed text stays until the author
    // decides, so Keep editing returns to it intact.
    const at = edit.current;
    afterLanding(() =>
      setTimeout(() => {
        if (!mounted.current || focused.current || edit.current !== at) return;
        held.current = false;
        mark(false);
        forget();
        setDraft(valueRef.current);
      }, 400)
    );
  };
  if (handle)
    handle.current = {
      commit: (text) => {
        const el = input.current;
        if (!el) return;
        // Still in the field (a click that took no focus): leave it first, as moving to the button would have.
        if (focused.current) el.blur();
        startedAt.current ??= { base: useStore.getState().snapshot, value: draftRef.current, commit: onCommit, ai: aiActivity() };
        edit.current++;
        draftRef.current = text;
        setDraft(text);
        leave(text, el);
        // The button that did this goes with the problem it fixed: focus stays with the field.
        el.focus();
      },
      commitNow: (text) => {
        const from = startedAt.current ?? { base: useStore.getState().snapshot, value: valueRef.current, commit: onCommit, ai: aiActivity() };
        if (text === from.value) return forget();
        const edit: PendingEdit = { operations: [], separate: true };
        const result = aiRan(from) ? commitDraft(from.base, () => from.commit(text, edit), text, { check: true, control: owner.current }) : commitDraft(from.base, () => onCommit(text, edit), text, { control: owner.current });
        if (result !== false) {
          forget();
          mark(false);
        }
        return result;
      }
    };
  const note = limit !== undefined ? limitNote(draft.length, limit, tooLong) : null;
  const noteId = `${generatedKey}-limit`;
  const common = {
    ref: setInput,
    value: draft,
    readOnly: readOnly || undefined,
    'aria-readonly': readOnly || undefined,
    placeholder,
    'aria-label': ariaLabel,
    'aria-describedby': [describedBy, note ? noteId : null].filter(Boolean).join(' ') || undefined,
    'aria-invalid': invalid || note?.over || undefined,
    id,
    autoFocus,
    // Left by the store before the Inspector shows something else (see leaveInspectorField).
    'data-draft-field': '',
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = true;
      nameRef.current = fieldName(e.currentTarget, ariaLabel);
      edit.current++;
      // Back in a field whose text was refused, or held back while leaving (Keep editing): still a draft.
      if ((held.current || refusedLast.current) && draft !== valueRef.current) mark(true);
      else forget();
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = false;
      if (cancelled.current) {
        cancelled.current = false;
        mark(false);
        return;
      }
      leave(draft, e.currentTarget);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      edit.current++;
      startedAt.current ??= { base: useStore.getState().snapshot, value: draft, commit: onCommit, ai: aiActivity() };
      // Text that arrived with line breaks (dropped, or put in by an input method) is one line before anything reads
      // it, and the caret stays where the author was rather than going to the end.
      const raw = e.target.value;
      const text = wrap ? oneLine(raw) : raw;
      if (text !== raw) {
        const at = Math.min(oneLine(raw.slice(0, e.target.selectionStart ?? raw.length)).length, text.length);
        e.target.value = text;
        e.target.setSelectionRange(at, at);
      }
      setDraft(text);
      mark(text !== value);
      if (tooLongRef.current) stash(text, startedAt.current);
      else if (kept.current) stash(text, startedAt.current, 'check');
      onLive?.(text);
    },
    // Pasted line breaks become spaces where the text lands, so the caret stays where it should.
    onPaste: wrap
      ? (e: React.ClipboardEvent) => {
          const text = e.clipboardData.getData('text/plain');
          if (!/[\r\n\u2028\u2029]/.test(text)) return;
          e.preventDefault();
          document.execCommand('insertText', false, oneLine(text));
        }
      : undefined,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        // Revert: blur must not commit the abandoned draft. The key is spent on the field (a dialog around it
        // reads that and stays open); the next Escape, with nothing being edited, closes it. Text kept for
        // being too long goes too: the saved text is back.
        e.preventDefault();
        cancelled.current = true;
        forget();
        release();
        refusedLast.current = false;
        if (tooLongRef.current) setTooLong(false);
        setDraft(value);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Enter' && (!multiline || wrap || e.metaKey || e.ctrlKey)) {
        // Blur is the single commit path, so one Enter makes one edit.
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    }
  };
  const control = multiline || wrap ? <textarea className={className === 'input' ? 'textarea' : className} rows={rows ?? (wrap ? 1 : 3)} {...common} /> : <input className={className} type={type} {...common} />;
  if (!note) return control;
  const count = (
    <div className={`field-count${note.over ? ' field-error' : quietCount && !tooLong && draft.length < limit! * 0.8 ? ' quiet' : ''}`} id={noteId}>
      {note.text}
    </div>
  );
  // A quiet count sits inside the field's trailing edge while it is focused, so focusing a name never moves the
  // rows below it; near or over the limit it takes its line under the field. Always wrapped, so the field is not
  // remounted (and focus lost) when the count changes place.
  if (quietCount)
    return (
      <span className="field-quiet">
        {control}
        {count}
      </span>
    );
  return (
    <>
      {control}
      {count}
    </>
  );
}

const HELD_LABELS: Record<HeldAction, string> = {
  'stop-apply': 'Stop AI and apply my edit',
  apply: 'Apply my edit',
  replace: 'Replace with my edit',
  copy: 'Copy text',
  retry: 'Try again',
  discard: 'Discard'
};

/** A typed edit that could not be saved as it was made (the AI was working, or its field changed somewhere else
 *  meanwhile): kept, with what can be done with it now. */
function HeldEditRow({ h, aiRunId }: { h: HeldEdit; aiRunId: string | null }) {
  const phase = useStore((s) => runPhase(editRunStatus(s)));
  const { message, actions } = heldPrompt(h, !!aiRunId, phase);
  const row = useRef<HTMLDivElement>(null);
  // The buttons change with the edit's state and the AI's. Focus that was on one stays in the row, and a
  // row that goes (saved or discarded) hands focus to the next one, never dropping it on the page.
  const hadFocus = useRef(false);
  const shown = actions.join();
  useEffect(() => {
    const el = row.current;
    if (!el || !hadFocus.current || el.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    (el.querySelector<HTMLElement>('button') ?? el).focus();
  }, [h.phase, h.writing, h.stopping, shown]);
  useLayoutEffect(
    () => () => {
      const el = row.current;
      if (!el?.contains(document.activeElement)) return;
      const next = [...document.querySelectorAll<HTMLElement>('.toast.held')].find((r) => r !== el);
      (next?.querySelector<HTMLElement>('button') ?? next)?.focus();
    },
    []
  );
  const run = (a: HeldAction) => {
    if (a === 'discard') discardHeld(h.id);
    else if (a === 'copy') void navigator.clipboard?.writeText(h.text ?? '').catch(() => undefined);
    // Only "Stop AI and apply my edit" stops anything, and only the request the row showed.
    else void applyHeld(h.id, { replace: a === 'replace', stopRunId: a === 'stop-apply' ? (aiRunId ?? undefined) : undefined });
  };
  return (
    <div
      ref={row}
      className="toast held"
      role="group"
      tabIndex={-1}
      aria-label={`Edit not saved: ${h.label}, ${h.place}`}
      onFocus={() => (hadFocus.current = true)}
      onBlur={(e) => {
        // Moving out of the row on purpose; a button removed under focus moves nowhere.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) hadFocus.current = false;
      }}
    >
      <Pencil />
      <div className="grow held-body">
        <span className="held-where">
          {h.label} · {h.place}
        </span>
        {h.text !== null && <q className="held-text">{h.text || '(empty)'}</q>}
        {/* Only what this edit's state says is announced when it changes, not the whole row. */}
        <span role="status">{message}</span>
        <span className="held-actions">
          {actions.map((a) => (
            <button key={a} className="btn btn-sm btn-ghost" onClick={() => run(a)}>
              {HELD_LABELS[a]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

type ToastItem = ReturnType<typeof useStore.getState>['toasts'][number];
/** How long an action a dialog held back stays on offer once the last dialog has closed. */
const RETURN_MS = 6000;
/** How long an action stays after the pointer and focus have both left it. */
const LINGER_MS = 2000;
/** The most notices shown at once. */
const MAX_SHOWN = 3;

/**
 * The notices on screen, of `ordered` (oldest first): never more than MAX_SHOWN. Those the author is pointing at
 * or in keep their place, so a new arrival never pulls one from under them, and the newest take the rest.
 */
function shownNotices<T extends { id: number }>(ordered: T[], held: (id: number) => boolean): T[] {
  const engaged = ordered.filter((t) => held(t.id)).slice(-MAX_SHOWN);
  const room = MAX_SHOWN - engaged.length;
  const newest = room > 0 ? ordered.filter((t) => !held(t.id)).slice(-room) : [];
  const shown = new Set([...engaged, ...newest]);
  return ordered.filter((t) => shown.has(t));
}

/**
 * Notices with an action (Undo) outlive their store timer while that action cannot be used yet, so it is never
 * lost. While any dialog is open every action notice is held, and one the store has already retired stays out
 * of sight; once the last dialog closes each gets a full RETURN_MS from that moment. While the pointer is over
 * any notice, or focus is in it, it is held too, and goes LINGER_MS after both have left. The store's timer is
 * left alone: a notice it removes early is kept here, in the same place on the page, until its time is up.
 */
function useActionTimes(toasts: ToastItem[], dialogOpen: boolean, savedRetired: number) {
  // Every action notice still in play, and any other the author has pointed at or been in, and when each may go
  // (Infinity while held).
  const known = useRef(new Map<number, ToastItem>());
  const until = useRef(new Map<number, number>());
  // A notice's time when the pointer or focus arrived, so leaving it never shortens that time.
  const before = useRef(new Map<number, number>());
  const hovered = useRef(new Set<number>());
  const focused = useRef(new Set<number>());
  // Bumped for each notice a dialog held back, when the last dialog closes: the notice is put back as a new
  // element, so the live region announces it, and its Undo, again.
  const round = useRef(new Map<number, number>());
  // Notices waiting for one of the visible slots: their time starts when they get one.
  const waiting = useRef(new Set<number>());
  // The text of an error that was said again while focus was in it: focus goes on to the one that replaced it.
  const refocus = useRef<string | null>(null);
  const wasOpen = useRef(dialogOpen);
  const [, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const live = (id: number) => toasts.some((t) => t.id === id);
  const engaged = (id: number) => hovered.current.has(id) || focused.current.has(id);
  const inPlay = (id: number) => live(id) || (until.current.get(id) ?? 0) > Date.now();
  const forget = (id: number) => {
    for (const m of [known.current, until.current, before.current, round.current]) m.delete(id);
    for (const m of [hovered.current, focused.current, waiting.current]) m.delete(id);
  };
  // The last dialog just closed: each notice it held is put back as a new element (re-keyed here, while
  // rendering, so it mounts once), and the live region announces it and its Undo again.
  if (wasOpen.current && !dialogOpen) for (const [id, t] of until.current) if (t === Infinity && !engaged(id)) round.current.set(id, (round.current.get(id) ?? 0) + 1);
  wasOpen.current = dialogOpen;
  for (const t of toasts) if (t.action) known.current.set(t.id, t);
  // The store takes an error away only for good (dismissed, or said again), and so does a new draft a "saved"
  // notice: however they are held, neither is kept.
  for (const t of [...known.current.values()]) {
    const saved = !t.action && t.kind === 'success' && t.id <= savedRetired;
    if (live(t.id) || !(t.kind === 'error' || saved)) continue;
    if (t.kind === 'error' && focused.current.has(t.id)) refocus.current = t.text;
    forget(t.id);
  }
  // Worked out while rendering, so a held notice never leaves the page between the store dropping it and this
  // taking it over: the same element stays, and so does any focus in it.
  const now = Date.now();
  const kept = [...known.current.values()].filter((t) => !live(t.id) && (until.current.get(t.id) ?? 0) > now);
  useEffect(() => {
    if (dialogOpen) {
      // Nothing behind a dialog is pointed at or focused: a notice the dialog hid gets no leave event.
      hovered.current.clear();
      focused.current.clear();
      for (const [id, t] of known.current) {
        // Only an action waits for the dialog: any other notice has no time left once nothing is holding it.
        if (!t.action) until.current.set(id, 0);
        else if (inPlay(id)) until.current.set(id, Infinity);
      }
    } else {
      // The last dialog closed: everything it held back gets a full window from now.
      const end = Date.now() + RETURN_MS;
      for (const [id, t] of until.current) if (t === Infinity && !engaged(id)) until.current.set(id, end);
    }
    refresh();
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dialogOpen) for (const t of toasts) if (t.action) until.current.set(t.id, Infinity);
  }, [toasts, dialogOpen]);
  // Forget notices whose time is up, and wake when the next kept one is due.
  useEffect(() => {
    const at = Date.now();
    for (const id of [...known.current.keys()]) {
      if (live(id) || (until.current.get(id) ?? 0) > at) continue;
      forget(id);
    }
    const next = Math.min(...[...known.current.keys()].filter((id) => !live(id)).map((id) => until.current.get(id) ?? 0));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(refresh, Math.max(0, next - at));
    return () => clearTimeout(timer);
  });
  return {
    kept,
    refocus,
    key: (t: ToastItem) => `${t.id}.${round.current.get(t.id) ?? 0}`,
    held: engaged,
    /** Of `candidates` (every notice that could show), those not in `visible` wait, and their time starts
     *  only once they get a slot. */
    slots: (candidates: ToastItem[], visible: Set<number>) => {
      let changed = false;
      for (const t of candidates) {
        if (!t.action) continue;
        if (!visible.has(t.id)) {
          waiting.current.add(t.id);
          if (until.current.get(t.id) !== Infinity) (until.current.set(t.id, Infinity), (changed = true));
        } else if (waiting.current.delete(t.id) && !engaged(t.id)) {
          until.current.set(t.id, Date.now() + RETURN_MS);
          changed = true;
        }
      }
      if (changed) refresh();
    },
    engage: (t: ToastItem, how: 'hover' | 'focus', on: boolean) => {
      const set = how === 'hover' ? hovered.current : focused.current;
      if (on) {
        if (set.has(t.id)) return;
        known.current.set(t.id, t);
        if (!engaged(t.id)) {
          const was = until.current.get(t.id) ?? 0;
          before.current.set(t.id, Number.isFinite(was) ? was : 0);
        }
        set.add(t.id);
        until.current.set(t.id, Infinity);
      } else {
        if (!set.delete(t.id) || engaged(t.id)) return;
        // While a dialog is open an action notice stays held; its window starts when the dialog closes.
        if (!openDialogs.length || !t.action) until.current.set(t.id, Math.max(before.current.get(t.id) ?? 0, Date.now() + LINGER_MS));
        refresh();
      }
    },
    /** The notice is finished with (its action ran, or it was dismissed): nothing here brings it back. */
    forget: (t: ToastItem) => {
      forget(t.id);
      refresh();
    }
  };
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const held = useStore((s) => s.heldEdits);
  const snapshot = useStore((s) => s.snapshot);
  const aiRunId = useStore((s) => (s.snapshot?.aiBusy ? (s.snapshot.aiRunId ?? null) : null));
  const dialogOpen = useDialogOpen();
  const savedRetired = useStore((s) => s.savedRetired);
  const times = useActionTimes(toasts, dialogOpen, savedRetired);
  // A kept notice is shown only once no dialog holds it back, and only while its action still applies; it then
  // returns as a new status message, so its Undo is announced again.
  const actionable = ({ action: a }: ToastItem) => !!a && (!a.undoes || undoAvailable(a.undoes, snapshot)) && (!a.stops || aiRunId === a.stops) && (!a.opening || snapshot?.workspaceKey === a.opening);
  // A notice the store has retired stays while a dialog's hold or the author's pointer or focus keeps it.
  const kept = times.kept.filter((t) => (!dialogOpen || times.held(t.id)) && (!t.action || actionable(t)));
  // In the order they arrived (a kept notice stays where it was), and at most a few, so the band at the bottom
  // stays small; any others show as those go.
  const ordered = [...toasts, ...kept].sort((a, b) => a.id - b.id);
  const shownToasts = shownNotices(ordered, times.held);
  useEffect(() => {
    if (!dialogOpen) times.slots(ordered, new Set(shownToasts.map((t) => t.id)));
  });
  useLayoutEffect(() => {
    const text = times.refocus.current;
    if (text === null) return;
    times.refocus.current = null;
    const again = [...shownToasts].reverse().find((t) => t.kind === 'error' && t.text === text);
    if (again) document.getElementById(`toast-text-${again.id}`)?.parentElement?.querySelector<HTMLElement>('.toast-dismiss')?.focus();
  });
  // The notices' band at the bottom of the window (their height plus clearance), which dialogs stop short of.
  const stack = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = stack.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      root.style.setProperty('--toast-band', h ? `${Math.ceil(h) + 56}px` : '0px');
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty('--toast-band');
    };
  }, []);
  // Where focus was before it came into the notices, to go back there once none is left to take it.
  const cameFrom = useRef<HTMLElement | null>(null);
  // The dismiss button Enter went down on.
  const pressed = useRef<EventTarget | null>(null);
  const dismiss = (t: ToastItem, button: HTMLButtonElement) => {
    const buttons = () => [...stack.current!.querySelectorAll<HTMLButtonElement>('.toast-dismiss')];
    const at = buttons().indexOf(button);
    // Focus in the row goes with it. A press with the pointer leaves focus where it was, so elsewhere it stays.
    const focused = !!button.closest('.toast')?.contains(document.activeElement);
    flushSync(() => {
      times.forget(t);
      dismissToast(t.id);
    });
    if (!focused) return;
    const left = buttons();
    const next = left[Math.min(at, left.length - 1)];
    if (next) return next.focus();
    const dialog = openDialogs[openDialogs.length - 1];
    const back = cameFrom.current;
    if (back?.isConnected && reachable(back) && (!dialog || dialog.contains(back))) back.focus();
    else if (dialog) (tabStops(dialog)[0] ?? dialog).focus();
  };
  // Rendered outside the app root, so toasts stay readable (and actionable) while a dialog makes the root inert.
  return createPortal(
    <div
      className="toasts"
      ref={stack}
      onFocus={(e) => {
        const from = e.relatedTarget as HTMLElement | null;
        if (from && !e.currentTarget.contains(from)) cameFrom.current = from;
      }}
    >
      <RenameOffer />
      <JoinRequests />
      {held.length > 0 && (
        <div className="toast-group" role="region" aria-label="Edits not saved yet">
          {held.map((h) => (
            <HeldEditRow key={h.id} h={h} aiRunId={aiRunId} />
          ))}
        </div>
      )}
      {/* Not atomic: only what arrives is read out, never again every notice that is still waiting to be dismissed. */}
      <div className="toast-group" role="status" aria-live="polite" aria-atomic="false">
        {shownToasts.map((t) => (
          <div
            key={times.key(t)}
            className={`toast ${t.kind}`}
            role={t.kind === 'error' ? 'alert' : undefined}
            onMouseEnter={() => times.engage(t, 'hover', true)}
            onMouseLeave={() => times.engage(t, 'hover', false)}
            onFocus={() => times.engage(t, 'focus', true)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && times.engage(t, 'focus', false)}
          >
            {t.kind === 'error' ? <CircleAlert /> : t.kind === 'success' ? <CircleCheck /> : <Info />}
            <span className="grow toast-text" id={`toast-text-${t.id}`}>
              {t.text}
            </span>
            {/* An Undo whose change has been undone some other way, or whose project has closed, is withdrawn. */}
            {actionable(t) && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  times.forget(t);
                  t.action!.run();
                  dismissToast(t.id);
                }}
              >
                {t.action!.label}
              </button>
            )}
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notice"
              aria-describedby={`toast-text-${t.id}`}
              title="Dismiss"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => dismiss(t, e.currentTarget)}
              // Enter dismisses as it is let go, as Space does: dismissing moves focus, and a held key's repeats
              // would then press whatever took it, which in a dialog can be the button that deletes.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (!e.repeat) pressed.current = e.currentTarget;
              }}
              onKeyUp={(e) => {
                if (e.key !== 'Enter' || pressed.current !== e.currentTarget) return;
                pressed.current = null;
                e.currentTarget.click();
              }}
            >
              <X />
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}

/** A loading ring. Inside a labelled control pass `decorative`, so it does not add "Loading" to the control's name. */
export function Spinner({ large, decorative }: { large?: boolean; decorative?: boolean }) {
  return decorative ? <span className={`spinner${large ? ' lg' : ''}`} aria-hidden="true" /> : <span className={`spinner${large ? ' lg' : ''}`} role="progressbar" aria-label="Loading" />;
}

/**
 * Keyboard model for a list or tree of rows (WAI-ARIA APG listbox / tree view): the container is one tab
 * stop (the selected row, else the first), Up/Down/Home/End move focus and, by default, selection follows
 * it. With `follow: false` the keys only move focus and the row's own Enter or Space activates it, for rows
 * whose activation is costly (a page row opens that page in the preview). Rows are found by role; each
 * row's own handler does Left/Right for expand and collapse.
 */
export function rovingKeys(e: React.KeyboardEvent<HTMLElement>, role: 'option' | 'treeitem', { follow = true }: { follow?: boolean } = {}) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  // Modified arrows belong to commands (⇧⌘↑/↓ moves the selection); only plain keys navigate.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
  const i = rows.indexOf((document.activeElement as HTMLElement)?.closest(`[role="${role}"]`) as HTMLElement);
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
  const next = rows[n];
  if (!next || n === i) return;
  e.preventDefault();
  next.focus();
  if (follow) next.click();
}

/** After render, make sure exactly one row in the container is tabbable. */
export function useRovingTabStop(ref: React.RefObject<HTMLElement | null>, role: 'option' | 'treeitem') {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
    if (!rows.length) return;
    // Of several selected rows, the one marked as the selection itself (data-primary) keeps the tab stop.
    const keep = rows.find((r) => r.dataset.primary === 'true') ?? rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? rows.find((r) => r.contains(document.activeElement)) ?? rows[0];
    for (const r of rows) r.tabIndex = r === keep ? 0 : -1;
  });
}

/**
 * Keyboard model for a grid of tiles (WAI-ARIA APG grid): each `[role="grid"]` is one tab stop, the arrow
 * keys move between its cells by their on-screen position (so it follows a CSS grid at any column count),
 * Home/End go to the row's ends and Ctrl+Home/End to the grid's. Focus only: activating a cell stays with
 * Enter or Space, because moving through a palette must never insert anything. Each cell holds one
 * focusable control, found with `[role="gridcell"] > *`.
 */
export function gridKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  if (e.metaKey || e.altKey || e.shiftKey || (e.ctrlKey && e.key !== 'Home' && e.key !== 'End')) return;
  const grid = (e.target as HTMLElement).closest<HTMLElement>('[role="grid"]');
  if (!grid) return;
  const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"] > *')];
  const i = cells.indexOf((document.activeElement as HTMLElement | null)?.closest('[role="gridcell"] > *') as HTMLElement);
  if (i < 0) return;
  const boxes = cells.map((c) => c.getBoundingClientRect());
  const cur = boxes[i];
  const sameRow = (b: DOMRect) => Math.abs(b.top - cur.top) < cur.height / 2;
  let n = i;
  if (e.key === 'ArrowLeft') n = Math.max(0, i - 1);
  else if (e.key === 'ArrowRight') n = Math.min(cells.length - 1, i + 1);
  else if (e.key === 'Home') n = e.ctrlKey ? 0 : boxes.findIndex(sameRow);
  else if (e.key === 'End') n = e.ctrlKey ? cells.length - 1 : boxes.length - 1 - [...boxes].reverse().findIndex(sameRow);
  else {
    const down = e.key === 'ArrowDown';
    // The cell directly above or below, in the same column; at the grid's edge (or a short last row) focus stays.
    const cx = cur.left + cur.width / 2;
    const below = boxes
      .map((b, k) => ({ b, k }))
      .filter(({ b }) => (down ? b.top >= cur.bottom - 1 : b.bottom <= cur.top + 1) && b.left <= cx && b.right >= cx)
      .sort((a, b) => (down ? a.b.top - b.b.top : b.b.top - a.b.top));
    if (below.length) n = below[0].k;
  }
  e.preventDefault();
  if (n === i || !cells[n]) return;
  for (const c of cells) {
    c.tabIndex = c === cells[n] ? 0 : -1;
    if (c === cells[n]) c.dataset.rove = '1';
    else delete c.dataset.rove;
  }
  cells[n].focus();
}

/** After render, make each grid inside the container exactly one tab stop (the cell last focused, else the first). */
export function useGridTabStops(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const grid of el.querySelectorAll<HTMLElement>('[role="grid"]')) {
      const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"] > *')];
      const keep = cells.find((c) => c.dataset.rove === '1') ?? cells[0];
      for (const c of cells) c.tabIndex = c === keep ? 0 : -1;
    }
  });
}

/** Run fn once the menu or dialog that launched it has closed (a command that opens its own flow, such as
 *  New project, must not be refused by the guard that blocks shortcuts while an overlay is open). */
export function afterOverlaysClose(fn: () => void) {
  let frames = 0;
  const go = () => (openDialogs.length || openMenus.count) && frames++ < 30 ? requestAnimationFrame(go) : fn();
  requestAnimationFrame(go);
}

export const sendCommand = (detail: string) => afterOverlaysClose(() => window.dispatchEvent(new CustomEvent('builder-command', { detail })));
