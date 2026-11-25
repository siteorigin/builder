import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { QuickItem } from '../lib/inline-insert';
import { searchItems } from '../lib/insert-search';
import { openMenus } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { LucideIcon } from './InsertPanel';

type Box = { left: number; top: number; width: number; height: number };

/**
 * The short list an Add button opens, on the canvas (#387) or on a slot in the Inspector (#654): what fits at its
 * place, searched as it is typed, beside the button. `title` heads it and names it; `search` names its search box.
 * The cursor starts in search; the arrows move through what is listed, Enter adds the highlighted one, a click adds
 * the one clicked. Escape (or Tab) puts it away and hands focus back to its button; a press anywhere else only puts it
 * away, and a press on its own words leaves the cursor in search. While it is open the editor's own shortcuts stay out
 * of the way, as for a menu. `anchor`: its button's box on screen as it opened, followed while `trigger` stays on the
 * page. `refused`: why the last choice can't go there, said in the list.
 */
export function QuickInsert({ title, search, items, anchor, trigger, refused, onChoose, onClose }: { title: string; search: string; items: QuickItem[]; anchor: Box; trigger?: HTMLElement | null; refused: string | null; onChoose: (it: QuickItem) => void; onClose: (back: boolean) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const shown = q.trim() ? searchItems(items, q) : items;
  // A new query starts at its first result, so Enter adds what is highlighted.
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, q, id]);
  useEffect(() => {
    openMenus.count++;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      openMenus.count--;
    };
  }, []);
  // Below its button, else above it, kept 8px inside the window, and placed again as the window or the list changes size.
  // Until it is measured it is drawn unseen below the button, never hidden, so search can take the cursor at once.
  useLayoutEffect(() => {
    const place = () => {
      const el = boxRef.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // The window resized moves the page, and the button with it.
      const a = trigger?.isConnected ? trigger.getBoundingClientRect() : anchor;
      const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8));
      const below = a.top + a.height + 6;
      const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, a.top - 6 - h);
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, trigger, shown.length, refused]);

  // On the whole list, so its keys work wherever focus is in it. The Enter (or Escape) that settles an input method's
  // candidate is the input method's.
  const onKey = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return;
    const n = shown.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) onChoose(shown[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  return createPortal(
    <>
      {/* A press outside (on the page too, which never tells this window) only puts the list away. */}
      <div
        className="quick-insert-veil"
        onPointerDown={(e) => {
          e.preventDefault();
          onClose(false);
        }}
      />
      <div
        ref={boxRef}
        className="quick-insert"
        role="dialog"
        aria-label={title}
        style={pos ?? { left: anchor.left, top: anchor.top + anchor.height + 6, opacity: 0 }}
        data-testid="quick-insert"
        onKeyDown={onKey}
        // A press on its words (the heading, a note) keeps the cursor in search, where its keys are.
        onPointerDown={(e) => e.target !== inputRef.current && e.preventDefault()}
      >
        <div className="qi-title">{title}</div>
        <div className="qi-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={search}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${id}-o${active}` : undefined}
            placeholder={search}
            spellCheck={false}
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul className="qi-list" role="listbox" id={`${id}-list`} aria-label={title}>
          {shown.map((it, i) => (
            <li
              key={it.key}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              className={`qi-item${i === active ? ' active' : ''}`}
              data-key={it.key}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => onChoose(it)}
            >
              <span className="qi-icon" aria-hidden="true">
                <LucideIcon name={it.icon ?? (it.kind === 'component' ? 'component' : 'layout-template')} size={14} />
              </span>
              <span className="qi-name">{it.name}</span>
              <span className="qi-group">{it.group}</span>
            </li>
          ))}
        </ul>
        {!shown.length && <p className="qi-note">{q.trim() ? `Nothing here matches “${q.trim()}”.` : 'Nothing can go here.'}</p>}
        <p className="qi-note refused" role="alert">
          {refused ?? ''}
        </p>
      </div>
    </>,
    document.body
  );
}
