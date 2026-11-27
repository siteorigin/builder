import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import type { QuickItem } from '../lib/inline-insert';
import { searchItems } from '../lib/insert-search';
import { openInsertSearchFor } from '../lib/insert-focus';
import { openMenus } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { SectionSketch } from './InsertPanel';
import { LucideIcon } from '../components/InsertIcon';

type Box = { left: number; top: number; width: number; height: number };

/** The tallest the list grows before it scrolls: a heading and eleven and a half 30px rows, or eight and a half 40px
 *  rows of section sketches, so the last row shown is always cut and the list reads as going on. */
const LIST_MAX = 345;
const LIST_MAX_PICTURED = 362;
/** The window's edge, kept clear on every side. */
const EDGE = 8;

/**
 * The short list an Add button opens, on the canvas (#387) or on a slot in the Inspector (#654): what fits at its
 * place, searched as it is typed, beside the button. `title` heads it and names it; `search` names its search box.
 * What is listed is grouped under headings in the order it comes (sections, column layouts, basic elements, blocks,
 * the project's own components), with no heading when it is all one group; a section shows a sketch of its layout, as
 * in Insert. The cursor starts in search; the arrows move through what is listed, Enter adds the highlighted one, a
 * click adds the one clicked. Escape puts it away and hands focus back to its button; Tab puts it away and moves on
 * from its button, as from any other control; a press anywhere else only puts it away, and a press on its own words
 * leaves the cursor in search. While it is open the editor's own shortcuts stay out of the way, as for a menu.
 * `anchor`: its button's box on screen as it opened, followed while `trigger` stays on the page. `under`: what it
 * opens below, when that is more than its button (a slot's row, whose words say what the slot takes). `refused`: why
 * the last choice can't go there, said on that choice's row. When nothing fits it says so, and why when `empty` says
 * (a full slot), with a way to put the list away; without a reason it offers Insert, the full catalog. When nothing
 * matches the search it offers to clear it, or Insert opened on the words searched for.
 */
export function QuickInsert({ title, search, items, anchor, trigger, under, empty, refused, onChoose, onClose }: { title: string; search: string; items: QuickItem[]; anchor: Box; trigger?: HTMLElement | null; under?: HTMLElement | null; empty?: string | null; refused: string | null; onChoose: (it: QuickItem) => void; onClose: (back: boolean) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  // The choice `refused` is about: the last one made.
  const [chosen, setChosen] = useState<string | null>(null);
  // Searched since it opened, so clearing the search says the whole list is back.
  const [searched, setSearched] = useState(false);
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const insertRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; listMax: number } | null>(null);
  const shown = q.trim() ? searchItems(items, q) : items;
  const none = !items.length;
  const refusedKey = refused && chosen && shown.some((it) => it.key === chosen) ? chosen : null;
  // Runs of one group, in the order they are listed; headed only when there is more than one.
  const groups: { name: string; from: number; items: QuickItem[] }[] = [];
  shown.forEach((it, i) => {
    const last = groups.at(-1);
    if (last && last.name === it.group) last.items.push(it);
    else groups.push({ name: it.group, from: i, items: [it] });
  });
  const headed = groups.length > 1;
  // A new query starts at its first result, so Enter adds what is highlighted.
  useEffect(() => {
    setActive(0);
    if (q.trim()) setSearched(true);
  }, [q]);
  // The row Enter adds stays in view, with the reason a refusal gives it.
  useEffect(() => {
    document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, q, id, refusedKey]);
  useEffect(() => {
    openMenus.count++;
    (none ? insertRef.current : inputRef.current)?.focus({ preventScroll: true });
    return () => {
      openMenus.count--;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Below what it opens under, else above its button, kept inside the window, and placed again as the window or the
  // list changes size. Where neither side holds all of it, it takes the roomier side and the list scrolls within it.
  // Until it is measured it is drawn unseen below the button, never hidden, so search can take the cursor at once.
  useLayoutEffect(() => {
    const place = () => {
      const el = boxRef.current;
      if (!el) return;
      const list = el.querySelector<HTMLElement>('.qi-list');
      const w = el.offsetWidth;
      // The popover without its list's scrolling part, and the list at its full height.
      const chrome = el.offsetHeight - (list?.offsetHeight ?? 0);
      const full = Math.min(shown.some((it) => it.kind === 'section') ? LIST_MAX_PICTURED : LIST_MAX, list?.scrollHeight ?? 0);
      // The window resized moves the page, and the button with it.
      const a = trigger?.isConnected ? trigger.getBoundingClientRect() : anchor;
      const u = under?.isConnected ? under.getBoundingClientRect() : null;
      const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - EDGE));
      const below = Math.max(a.top + a.height, u ? u.top + u.height : 0) + 6;
      const roomBelow = window.innerHeight - EDGE - below - chrome;
      const roomAbove = a.top - 6 - EDGE - chrome;
      const down = roomBelow >= full || roomBelow >= roomAbove;
      // No list (nothing listed) takes no room; a list is never squeezed below three rows.
      const listMax = full ? Math.min(full, Math.max(90, down ? roomBelow : roomAbove)) : 0;
      const top = down ? below : Math.max(EDGE, a.top - 6 - chrome - listMax);
      setPos((p) => (p && p.left === left && p.top === top && p.listMax === listMax ? p : { left, top, listMax }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, trigger, under, q, shown.length, refusedKey]);

  const choose = (it: QuickItem) => {
    if (it.key === refusedKey) return;
    setChosen(it.key);
    onChoose(it);
  };
  // A heading stuck at the top over its group's scrolled rows is marked, so it draws its edge (see Canvas.css).
  const markStuck = (list: HTMLElement | null) => {
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    list.querySelectorAll<HTMLElement>('.qi-group').forEach((g) => {
      const head = g.firstElementChild as HTMLElement | null;
      head?.toggleAttribute('data-stuck', g.getBoundingClientRect().top < top - 0.5 && head.getBoundingClientRect().top <= top + 0.5);
    });
  };
  useLayoutEffect(() => markStuck(boxRef.current?.querySelector('.qi-list') ?? null));

  // Insert, the full catalog, opened on what was searched for here.
  const toInsert = () => {
    onClose(false);
    openInsertSearchFor(q.trim());
  };
  // On the whole list, so its keys work wherever focus is in it. The Enter (or Escape) that settles an input method's
  // candidate is the input method's.
  const onKey = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return;
    const n = shown.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.target !== inputRef.current) return;
      e.preventDefault();
      if (n) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Enter') {
      if (e.target !== inputRef.current) return;
      e.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') {
      // Within the list's own actions Tab moves as usual; past them it leaves, from its button's place on the page.
      const stops = [...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])') ?? [])];
      const at = stops.indexOf(e.target as HTMLElement);
      if (at >= 0 && at + (e.shiftKey ? -1 : 1) >= 0 && at + (e.shiftKey ? -1 : 1) < stops.length) return;
      e.stopPropagation();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else e.preventDefault();
      onClose(!trigger?.isConnected);
    }
  };

  const count = shown.length === 1 ? '1 result' : `${shown.length} results`;
  const status = none ? '' : q.trim() ? (shown.length ? count : `No matches for “${q.trim()}”`) : searched ? `Search cleared. ${count}` : '';

  return createPortal(
    <>
      {/* A press outside (on the page too, which never tells this window) only puts the list away. */}
      <div
        className="quick-insert-veil"
        onPointerDown={(e) => {
          e.preventDefault();
          // A press on its own button (drawn as a close mark while open) puts it away as that button does, handing focus
          // back: anywhere in the button's box and the 5px of target round it (the canvas + is wider than it is drawn).
          const b = trigger?.isConnected ? trigger.getBoundingClientRect() : null;
          onClose(!!b && e.clientX >= b.left - 5 && e.clientX <= b.right + 5 && e.clientY >= b.top - 5 && e.clientY <= b.bottom + 5);
        }}
      />
      <div
        ref={boxRef}
        className={`quick-insert${headed ? ' headed' : ''}`}
        role="dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={none ? `${id}-empty` : undefined}
        style={pos ? { left: pos.left, top: pos.top, ['--qi-list-max' as string]: `${pos.listMax}px` } : { left: anchor.left, top: anchor.top + anchor.height + 6, opacity: 0 }}
        data-testid="quick-insert"
        onKeyDown={onKey}
        // A press on its words (the heading, a note) keeps the cursor where it is.
        onPointerDown={(e) => !(e.target as Element).closest('input, button') && e.preventDefault()}
      >
        <div className="qi-title" id={`${id}-title`}>
          {title}
        </div>
        {none ? (
          <div className="qi-empty" id={`${id}-empty`}>
            <strong>Nothing fits here</strong>
            {/* With its reason (a full slot) the way on is here, so the button puts the list away; without one, Insert. */}
            {empty ? (
              <>
                <span>{empty}</span>
                <button ref={insertRef} type="button" className="btn btn-sm" onClick={() => onClose(true)}>
                  Close
                </button>
              </>
            ) : (
              <>
                <span>Insert has the full catalog for other places on the page.</span>
                <button ref={insertRef} type="button" className="btn btn-sm" onClick={toInsert}>
                  Open Insert
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="qi-search">
              <Search aria-hidden="true" />
              <input
                ref={inputRef}
                className="input"
                type="text"
                role="combobox"
                aria-label={search}
                aria-expanded={shown.length > 0}
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                aria-activedescendant={shown[active] ? `${id}-o${active}` : undefined}
                placeholder={search}
                spellCheck={false}
                autoComplete="off"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {q && (
                <button
                  type="button"
                  className="qi-clear icon-btn"
                  aria-label="Clear search"
                  title="Clear search"
                  tabIndex={-1}
                  onClick={() => {
                    setQ('');
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="qi-list" role="listbox" id={`${id}-list`} aria-label={search} onScroll={(e) => markStuck(e.currentTarget)}>
              {groups.map((g, gi) => {
                const rows = g.items.map((it, j) => {
                  const i = g.from + j;
                  const no = it.key === refusedKey;
                  const sketch = it.kind === 'section' && it.spec.componentId;
                  return (
                    <div
                      key={it.key}
                      id={`${id}-o${i}`}
                      role="option"
                      aria-selected={i === active}
                      aria-disabled={no || undefined}
                      aria-describedby={no ? `${id}-why` : undefined}
                      className={`menu-item qi-item${i === active ? ' focused' : ''}${sketch ? ' pictured' : ''}${no ? ' described' : ''}`}
                      data-key={it.key}
                      data-group={it.group}
                      onPointerMove={() => i !== active && setActive(i)}
                      onClick={() => choose(it)}
                    >
                      {sketch ? (
                        <span className="insert-thumb qi-thumb" aria-hidden="true">
                          <SectionSketch id={it.spec.componentId!} />
                        </span>
                      ) : (
                        <span className="menu-lead" aria-hidden="true">
                          <LucideIcon name={it.icon ?? (it.kind === 'component' ? 'component' : 'layout-template')} size={16} />
                        </span>
                      )}
                      {no ? (
                        <span className="menu-text">
                          <span className="qi-name">{it.name}</span>
                          <span className="menu-desc" id={`${id}-why`}>
                            {refused}
                          </span>
                        </span>
                      ) : (
                        <span className="qi-name">{it.name}</span>
                      )}
                    </div>
                  );
                });
                return headed ? (
                  <div key={`${g.name}-${gi}`} role="group" aria-labelledby={`${id}-g${gi}`} className="qi-group">
                    <div className="menu-label qi-head" id={`${id}-g${gi}`} role="presentation">
                      <span>{g.name}</span>
                    </div>
                    {rows}
                  </div>
                ) : (
                  <Fragment key={`${g.name}-${gi}`}>{rows}</Fragment>
                );
              })}
            </div>
            {!shown.length && (
              <div className="qi-empty">
                <strong>No matches for “{q.trim()}”</strong>
                <span>Only what fits here is listed. Insert has everything.</span>
                <span className="qi-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setQ('');
                      inputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    Clear search
                  </button>
                  <button type="button" className="link-btn" onClick={toInsert}>
                    Open Insert
                  </button>
                </span>
              </div>
            )}
          </>
        )}
        {/* Mounted from the start, so a change to what it says is announced. */}
        <p className="sr-only" role="status">
          {status}
        </p>
        <p className="sr-only" role="alert">
          {refused ?? ''}
        </p>
      </div>
    </>,
    document.body
  );
}
