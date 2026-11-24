import { isImeComposing } from '../lib/ime';
import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, CircleAlert, CircleCheck, Info, Pencil, X } from 'lucide-react';
import { aiActivity, applyHeld, commitDraft, discardHeld, editRunStatus, getConfirm, markDraft, onConfirmChange, undoAvailable, useStore, type HeldEdit } from '../store';
import { afterSettle, isSettling, reportRefused } from '../lib/pending';
import { heldPrompt, type HeldAction } from '../lib/held';
import { runPhase } from '../lib/savestate';
import type { ProjectSnapshot } from '@shared/api';

const setToasts = (toasts: ReturnType<typeof useStore.getState>['toasts']) => useStore.setState({ toasts });

// Editable content counts (the code editor's text area is one), so Tab order and wrapping inside a dialog see it.
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Dialogs currently open, innermost last; global shortcuts stay out of the way while any is open. */
export const openDialogs: HTMLElement[] = [];

/**
 * Keyboard model shared by every dialog (WAI-ARIA APG dialog pattern). Dialogs render in a portal and the
 * app root is made inert while any is open, so nothing behind can be reached. Focus moves inside on open
 * (explicit autofocus, else the first control in the body, else the footer's first action), Tab and
 * Shift+Tab stay inside, Escape closes (unless a control inside already handled it), and focus returns to
 * whatever opened the dialog. Attach the returned handler as the dialog's onKeyDown.
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
    if (!el.contains(document.activeElement)) {
      const inBody = el.querySelector<HTMLElement>('.modal-body ' + FOCUSABLE.split(', ').join(', .modal-body '));
      const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? inBody ?? el.querySelector<HTMLElement>('.modal-foot ' + FOCUSABLE.split(', ').join(', .modal-foot ')) ?? el;
      first.focus();
    }
    // If focus falls out of the dialog (a button inside disabled or unmounted itself), keys still belong
    // to the dialog: Escape closes it and Tab brings focus back in.
    const stray = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== el || el.contains(e.target as Node)) return;
      if (e.key === 'Escape') (e.preventDefault(), closeRef.current());
      else if (e.key === 'Tab') (e.preventDefault(), el.querySelector<HTMLElement>(FOCUSABLE)?.focus());
    };
    window.addEventListener('keydown', stray);
    return () => {
      window.removeEventListener('keydown', stray);
      openDialogs.splice(openDialogs.indexOf(el), 1);
      if (root && !openDialogs.length) root.inert = false;
      if (below) below.inert = false;
      if (!openDialogs.length) document.body.classList.remove('dialog-open');
      const visible = (n: HTMLElement | null) => !!n && document.contains(n) && n.offsetParent !== null;
      const inRegion = region && document.contains(region) ? [...region.querySelectorAll<HTMLElement>('textarea, input, [tabindex="0"], button:not([disabled])')].find(visible) : undefined;
      const back = visible(opener) && !opener!.closest('[role="menu"]') ? opener : inRegion ?? [...document.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"], [role="option"][aria-selected="true"]')].find(visible) ?? null;
      // Only restore when focus has nowhere better to be; a dialog action may have focused something new.
      requestAnimationFrame(() => (!document.activeElement || document.activeElement === document.body) && back?.focus());
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
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && (i === 0 || (i === -1 && (document.activeElement === el || !el.contains(document.activeElement))))) (e.preventDefault(), items[items.length - 1].focus());
    // Focus on a programmatically focusable element (tabindex -1, such as a result region) tabs on natively.
    else if (!e.shiftKey && (i === items.length - 1 || (i === -1 && (document.activeElement === el || !el.contains(document.activeElement))))) (e.preventDefault(), items[0].focus());
  };
}

/** The one dialog shell. `footer` holds the actions: the dismiss-only action is always a secondary "Close". */
export function Modal({ title, icon, onClose, children, footer, wide, describedBy, busy }: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; describedBy?: string; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // While busy (creating a project, opening a trusted one), only the dialog's own buttons can end it.
  const close = () => !busy && onClose();
  const onKeyDown = useDialogFocus(ref, close);
  return createPortal(
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} onKeyDown={onKeyDown}>
        <div className="modal-head">
          {icon}
          <h2 className="grow" id={titleId}>
            {title}
          </h2>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label="Close" title="Close (Esc)">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  hint?: string;
  checked?: boolean;
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
const ITEM = '[role^="menuitem"]:not([data-disabled])';

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
 * its first item (its last with `focusLast`); Up/Down wrap, Home/End jump, letters jump by label,
 * Enter/Space choose, Escape or Tab close. It is modal, so the first press outside (in the page preview too)
 * only closes it. Focus returns to the trigger (else whatever had focus when it opened) unless an action
 * moved it somewhere, such as into a dialog.
 */
export function Menu({ x, y, items, onClose, label, alignEnd, returnTo, trigger, focusLast }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string; alignEnd?: boolean; returnTo?: HTMLElement | null; trigger?: HTMLElement; focusLast?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Who gets focus back when the menu closes: the trigger, else whatever had focus when it opened.
  const opener = useRef<HTMLElement | null>(returnTo ?? (document.activeElement as HTMLElement | null));
  // If an action removes the opener (Delete removes the chip), focus stays in the same region instead.
  const region = useRef<HTMLElement | null>(opener.current?.closest<HTMLElement>('.canvas, [role="tabpanel"], .side-panel-view, .toolbar') ?? null);
  /** Set when Tab closed the menu: focus then continues from the opener in that direction (APG menu). */
  const tabbed = useRef<0 | 1 | -1>(0);
  const [anchor, setAnchor] = useState<Box>(() => (trigger ? boxOf(trigger) : { left: x, top: y, width: 0, height: 0 }));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const checked = items.findIndex((it) => it.checked);
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
        const radio = it.checked !== undefined;
        const indicator = (
          <DropdownMenu.ItemIndicator className="check">
            <Check />
          </DropdownMenu.ItemIndicator>
        );
        const props = { className: `menu-item${it.danger ? ' danger' : ''}`, disabled: it.disabled, textValue: it.label, onSelect: () => choose(it) };
        const inner = (
          <>
            {lead && <span className="menu-lead">{it.icon ?? (radio ? indicator : null)}</span>}
            <span className="grow">{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
            {it.shortcut && <span className="kbd">{it.shortcut}</span>}
            {radio && it.icon && <span className="menu-trail">{indicator}</span>}
          </>
        );
        return radio ? (
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
          side="bottom"
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
    if (items[i].checked === undefined) {
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
  const [menu, setMenu] = useState<{ key: number; x: number; y: number; items: MenuItem[]; label?: string; trigger?: HTMLElement; alignEnd?: boolean; returnTo?: HTMLElement | null; focusLast?: boolean } | null>(null);
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
     *  `focusLast` (Up arrow on the trigger), a keyboard-opened menu starts on its last item. */
    openAt: (el: HTMLElement, items: MenuItem[], label?: string, opts?: { focusLast?: boolean }) => {
      if (menu?.trigger === el) return setMenu(null);
      const r = el.getBoundingClientRect();
      const narrow = r.width < 48;
      setMenu({ key: ++menuKey, x: narrow ? r.right : r.left, y: r.bottom + 4, items, label, trigger: el, alignEnd: narrow, focusLast: opts?.focusLast });
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
export function Section({ title, children, defaultOpen = true, actions, id, scope, level }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string; scope?: ReactNode; level?: number }) {
  const key = id ? `section:${id}` : null;
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => (key && localStorage.getItem(key) !== null ? localStorage.getItem(key) === '1' : defaultOpen));
  useEffect(() => {
    if (!id) return;
    let frame = 0;
    const onOpen = (e: Event) => {
      // The section's ID alone (as older callers send it) opens and scrolls to it.
      const detail = (e as CustomEvent<string | { id: string; scroll?: boolean; focus?: string }>).detail;
      const { id: target, scroll = true, focus } = typeof detail === 'string' ? { id: detail } : (detail ?? { id: '' });
      if (target !== id) return;
      setOpen(true);
      if (key) localStorage.setItem(key, '1');
      // Opened on the way to something inside it, which then takes the scroll and the focus itself.
      if (!scroll) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = rootRef.current;
        const scroller = el?.closest<HTMLElement>('.panel-body');
        if (!el || !scroller) return;
        // A control inside the section, when one was named and has rendered; else the section itself.
        const control = (focus && el.querySelector<HTMLElement>(focus)) || null;
        // Land below the sticky inspector header, and only animate when motion is welcome.
        const head = scroller.querySelector<HTMLElement>('.insp-head')?.offsetHeight ?? 0;
        const top = (control ?? el).getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - head;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
        (control ?? el.querySelector<HTMLElement>('.section-head'))?.focus({ preventScroll: true });
      });
    };
    window.addEventListener('inspector-open-section', onOpen);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('inspector-open-section', onOpen);
    };
  }, [id, key]);
  return (
    <div className="section" ref={rootRef}>
      <div className="row" style={{ paddingRight: 8 }} role={level ? 'heading' : undefined} aria-level={level}>
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
      {open ? (
        <div className="section-body" id={bodyId}>
          {children}
        </div>
      ) : (
        <div id={bodyId} hidden />
      )}
    </div>
  );
}

/** A labelled field. The label, hint and error are wired to the single control child (id, aria-describedby). */
/**
 * Open (and scroll to) a collapsible Section by its id. `scroll: false` only opens it; `focus`, a selector
 * inside it, names the control to scroll to and focus instead of the section's heading.
 */
export function openSection(id: string, opts: { scroll?: boolean; focus?: string } = {}) {
  window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: { id, scroll: opts.scroll ?? true, focus: opts.focus } }));
}

export function Field({ label, children, hint, error, extra, controlId: explicitId }: { label?: ReactNode; children: ReactNode; hint?: ReactNode; error?: string | null; extra?: ReactNode; controlId?: string }) {
  const generated = useId();
  const id = explicitId ?? generated;
  const noteId = `${id}-note`;
  const labelable = (t: unknown) => t === 'input' || t === 'select' || t === 'textarea' || t === DraftInput;
  const only = Children.count(children) === 1 && isValidElement(children) && labelable(children.type) ? (children as ReactElement<Record<string, unknown>>) : null;
  // A composite child (a field plus its buttons) passes controlId and wires `${controlId}-note` itself.
  const controlId = explicitId ?? (only ? ((only.props.id as string | undefined) ?? id) : undefined);
  const note = error || hint;
  const control = only && !explicitId ? cloneElement(only, { id: controlId, 'aria-describedby': note ? noteId : undefined, 'aria-invalid': error ? true : undefined }) : children;
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
export function Segmented<T extends string>({ value, options, onChange, full, label, radio, labelledBy, describedBy }: { value: T; options: Array<{ value: T; label?: ReactNode; icon?: ReactNode; title?: string }>; onChange: (v: T) => void; full?: boolean; label?: string; radio?: boolean; labelledBy?: string; describedBy?: string }) {
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || !options.length) return;
    e.preventDefault();
    // From the focused option, since a saved value can lag behind quick presses.
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = ((from < 0 ? current : from) + step + options.length) % options.length;
    onChange(options[next].value);
    buttons[next]?.focus();
  };
  return (
    <div className={`segmented${full ? ' full' : ''}`} role={radio ? 'radiogroup' : 'group'} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={radio ? move : undefined}>
      {options.map((o, i) => (
        <button key={o.value} {...(radio ? { role: 'radio', 'aria-checked': value === o.value, tabIndex: i === current ? 0 : -1 } : { 'aria-pressed': value === o.value })} onClick={() => onChange(o.value)} title={o.title} aria-label={o.title}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, id, labelledBy, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string; labelledBy?: string; describedBy?: string }) {
  return <button id={id} className="switch" role="switch" aria-checked={checked} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} onClick={() => onChange(!checked)} />;
}

/** A switch with its visible label and optional hint, all clickable and wired together. */
export function SwitchRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  const id = useId();
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
      <Switch id={id} checked={checked} onChange={onChange} labelledBy={`${id}-l`} describedBy={hint ? `${id}-h` : undefined} />
    </div>
  );
}

/** Text input that commits on blur/Enter and keeps a local draft while focused. `onCommit` returns false when
 *  it refuses the value (its own check, such as a page with no title), so leaving the project can say so. */
export function DraftInput({
  value,
  onCommit,
  onLive,
  multiline,
  className = 'input',
  placeholder,
  rows,
  ariaLabel,
  autoFocus,
  id,
  type,
  maxLength,
  'aria-describedby': describedBy,
  'aria-invalid': invalid
}: {
  id?: string;
  /** For a single-line field: the input type, such as "date". */
  type?: string;
  /** The most characters the project keeps for this field. */
  maxLength?: number;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  value: string;
  onCommit: (v: string) => unknown;
  onLive?: (v: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  // Report an uncommitted edit to the toolbar, so it never says "Saved" over text that is still a draft.
  const draftKey = useId();
  const mark = (on: boolean) => markDraft(draftKey, on);
  useEffect(() => () => markDraft(draftKey, false), [draftKey]);
  // A commit the project rejects (an empty title) leaves the stored value unchanged: show it again.
  const valueRef = useRef(value);
  valueRef.current = value;
  // What the author started from, recorded at the first keystroke: the text, the project, and the commit
  // as they were then. If the AI ran while they typed, the edit is built from exactly that and checked
  // against it before it is applied (at once when the AI is idle), so it never lands on a field or value
  // the AI changed meanwhile. Otherwise it is applied now, built from the field as it is now. A field
  // nobody typed in commits nothing. Text the project refused stays a draft, start and all.
  const startedAt = useRef<{ base: ProjectSnapshot | null; value: string; commit: (v: string) => unknown; ai: number } | null>(null);
  const forget = () => (startedAt.current = null);
  // A field follows the project until the author types in it, focused or not, so typing always starts
  // from what the project holds.
  useEffect(() => {
    if (!focused.current) forget();
    if (!startedAt.current) setDraft(value);
  }, [value]);
  const aiRan = (from: { ai: number }) => !!useStore.getState().snapshot?.aiBusy || aiActivity() !== from.ai;
  /** Commit what was typed; returns what the commit returned (false: the project refused it). */
  const commit = (): unknown => {
    const from = startedAt.current;
    if (!from || draft === from.value) return forget();
    const result = aiRan(from) ? commitDraft(from.base, () => from.commit(draft), draft, { check: true }) : commitDraft(null, () => onCommit(draft), draft);
    if (result !== false) forget();
    return result;
  };
  // A field removed while the author is typing in it and the AI ran (it removed the page the field belongs
  // to, so the panel moved on) keeps what was typed, checked before it is applied.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(
    () => () => {
      const from = startedAt.current;
      const text = draftRef.current;
      if (!focused.current || !from || cancelled.current || text === from.value || !aiRan(from)) return;
      const snap = useStore.getState().snapshot;
      if (from.base && snap?.workspaceKey === from.base.workspaceKey) commitDraft(from.base, () => from.commit(text), text, { check: true });
    },
    []
  );
  // Each focus or keystroke starts a new edit: putting the saved value back for an earlier one must not
  // overwrite it. And text held back while the project was being left (Keep editing) is still a draft.
  const edit = useRef(0);
  const held = useRef(false);
  const refusedLast = useRef(false);
  const common = {
    value: draft,
    placeholder,
    'aria-label': ariaLabel,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    id,
    autoFocus,
    onFocus: () => {
      focused.current = true;
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
      const refused = commit() === false;
      refusedLast.current = refused;
      // While the project is being left, refused text stays a draft until the author decides about it.
      held.current = isSettling();
      mark(refused && held.current);
      if (refused) {
        const label = e.currentTarget.labels?.[0];
        const name = (label?.querySelector('.grow')?.textContent ?? label?.textContent ?? ariaLabel ?? '').trim();
        reportRefused(name ? `What you typed in ${name} can’t be saved.` : 'Something you typed can’t be saved.', draftKey, e.currentTarget);
      }
      // The saved value comes back once the change has landed or been refused. While the project is being
      // left, the typed text stays until the author decides, so Keep editing returns to it intact.
      const at = edit.current;
      afterSettle(() =>
        setTimeout(() => {
          if (focused.current || edit.current !== at) return;
          held.current = false;
          mark(false);
          forget();
          setDraft(valueRef.current);
        }, 400)
      );
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      edit.current++;
      startedAt.current ??= { base: useStore.getState().snapshot, value: draft, commit: onCommit, ai: aiActivity() };
      setDraft(e.target.value);
      mark(e.target.value !== value);
      onLive?.(e.target.value);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        // Revert: blur must not commit the abandoned draft.
        cancelled.current = true;
        forget();
        setDraft(value);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        // Blur is the single commit path, so one Enter makes one edit.
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    }
  };
  return multiline ? <textarea className={className === 'input' ? 'textarea' : className} rows={rows ?? 3} maxLength={maxLength} {...common} /> : <input className={className} type={type} maxLength={maxLength} {...common} />;
}

const HELD_LABELS: Record<HeldAction, string> = {
  'stop-apply': 'Stop AI and apply my edit',
  apply: 'Apply my edit',
  replace: 'Replace with my edit',
  copy: 'Copy text',
  retry: 'Try again',
  discard: 'Discard'
};

/** A typed edit made while the AI was working: kept, with what can be done with it now. */
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

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const held = useStore((s) => s.heldEdits);
  const snapshot = useStore((s) => s.snapshot);
  const aiRunId = useStore((s) => (s.snapshot?.aiBusy ? (s.snapshot.aiRunId ?? null) : null));
  // Rendered outside the app root, so toasts stay readable (and actionable) while a dialog makes the root inert.
  return createPortal(
    <div className="toasts">
      {held.length > 0 && (
        <div className="toast-group" role="region" aria-label="Edits not saved yet">
          {held.map((h) => (
            <HeldEditRow key={h.id} h={h} aiRunId={aiRunId} />
          ))}
        </div>
      )}
      <div className="toast-group" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            {t.kind === 'error' ? <CircleAlert /> : t.kind === 'success' ? <CircleCheck /> : <Info />}
            <span className="grow">{t.text}</span>
            {/* An Undo whose change has been undone some other way, or whose project has closed, is withdrawn. */}
            {t.action && (!t.action.undoes || undoAvailable(t.action.undoes, snapshot)) && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  t.action!.run();
                  setToasts(useStore.getState().toasts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
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

/** Hosts confirmDialog(): the app's own confirmation, styled and themed like every other dialog. */
export function ConfirmHost() {
  const [req, setReq] = useState(getConfirm());
  useEffect(() => {
    const off = onConfirmChange(() => setReq(getConfirm()));
    return () => void off();
  }, []);
  if (!req) return null;
  return (
    <Modal
      key={req.id}
      title={req.title}
      icon={req.danger ? <CircleAlert style={{ color: 'var(--red)' }} /> : <Info />}
      onClose={() => req.resolve(null)}
      describedBy="confirm-body"
      footer={
        <>
          {req.stayLabel && (
            <button className="btn btn-ghost" data-autofocus onClick={() => req.resolve(null)} style={{ marginRight: 'auto' }}>
              {req.stayLabel}
            </button>
          )}
          <button className="btn" data-autofocus={req.stayLabel ? undefined : true} onClick={() => req.resolve(false)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button className={`btn ${req.danger ? 'btn-danger-fill' : 'btn-primary'}`} onClick={() => req.resolve(true)}>
            {req.confirmLabel}
          </button>
        </>
      }
    >
      <p id="confirm-body" style={{ margin: 0, overflowWrap: 'anywhere' }}>
        {req.body}
      </p>
    </Modal>
  );
}

/** Run fn once the menu or dialog that launched it has closed (a command that opens its own flow, such as
 *  New project, must not be refused by the guard that blocks shortcuts while an overlay is open). */
export function afterOverlaysClose(fn: () => void) {
  let frames = 0;
  const go = () => (openDialogs.length || openMenus.count) && frames++ < 30 ? requestAnimationFrame(go) : fn();
  requestAnimationFrame(go);
}

export const sendCommand = (detail: string) => afterOverlaysClose(() => window.dispatchEvent(new CustomEvent('builder-command', { detail })));
