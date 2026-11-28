// The text of the sidebar lists (Pages, Posts): words found by a find field marked where they are, the short dates a
// row has room for, and the card that shows a row's whole title when the row cuts it short.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fold, folded } from '../lib/fold';

export { fold, folded };

/**
 * A row's whole title and address, while keyboard focus is on a row that cuts them short (the Pages and Content lists).
 * The card stands beside the sidebar, level with its row, so the rows above and below stay in view as focus moves
 * through them (#1520). `row` finds the focused row as the list is drawn now; `cut` says whether it cuts its text short.
 * The card is placed again after every render of its list and whenever the list scrolls or anything around it changes
 * size, so it follows its row, and it steps aside while the row is out of view, not drawn (its panel hidden) or no
 * longer cut short (a wider sidebar, titles shown in full), coming back without focus having to move. It is for the
 * eye: the row's accessible name and description already carry both. Keyed by its row, so another row starts afresh.
 */
export function ListPeek({ row: find, cut, title, route }: { row: () => HTMLElement | null | undefined; cut: (row: HTMLElement) => boolean; title: string; route?: string }) {
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const place = useRef(() => {});
  place.current = () => {
    const el = card.current;
    const row = find();
    if (!el || !row || !row.getClientRects().length || !cut(row)) return setAt(null);
    const r = row.getBoundingClientRect();
    const view = row.closest<HTMLElement>('.panel-body')?.getBoundingClientRect();
    if (view && (r.bottom <= view.top || r.top >= view.bottom)) return setAt(null);
    const left = Math.round((row.closest<HTMLElement>('.side-panel') ?? row).getBoundingClientRect().right + 8);
    const width = Math.round(Math.max(200, Math.min(320, window.innerWidth - left - 12)));
    // Its height at that width, so a card for a row near the bottom stays on screen.
    el.style.width = `${width}px`;
    const top = Math.round(Math.max(8, Math.min(r.top, window.innerHeight - el.offsetHeight - 8)));
    setAt((was) => (was && was.left === left && was.top === top && was.width === width ? was : { left, top, width }));
  };
  useLayoutEffect(() => place.current());
  useEffect(() => {
    const row = find();
    const list = row?.closest<HTMLElement>('.panel-body');
    const go = () => place.current();
    const sized = new ResizeObserver(go);
    for (const el of [row?.closest<HTMLElement>('.side-panel'), list, row]) if (el) sized.observe(el);
    list?.addEventListener('scroll', go, { passive: true });
    window.addEventListener('resize', go);
    return () => {
      sized.disconnect();
      list?.removeEventListener('scroll', go);
      window.removeEventListener('resize', go);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div ref={card} className="list-peek" aria-hidden="true" style={at ?? { left: 0, top: 0, visibility: 'hidden' }}>
      <span className="list-peek-title">{title}</span>
      {route && <span className="list-peek-route">{route}</span>}
    </div>,
    document.body
  );
}

/** Which characters of `text` the found words cover. */
export function found(text: string, words: string[]): boolean[] {
  const chars = [...text];
  const hit = new Array<boolean>(chars.length).fill(false);
  if (!words.length) return hit;
  const f = folded(text);
  // An empty word (a query of accents alone folds to nothing) matches nowhere, rather than everywhere forever.
  for (const w of words.filter(Boolean))
    for (let i = f.text.indexOf(w); i >= 0; i = f.text.indexOf(w, i + 1)) for (let k = i; k < i + w.length; k++) hit[f.at[k]] = true;
  // A combining mark goes with the letter before it.
  chars.forEach((c, i) => i > 0 && /^\p{M}+$/u.test(c) && (hit[i] = hit[i - 1]));
  return hit;
}

/** Characters `from` to `to` of a text, with the found ones marked. */
export function Runs({ chars, hit, from = 0, to = chars.length }: { chars: string[]; hit: boolean[]; from?: number; to?: number }) {
  const out: React.ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = () => run && out.push(on ? <mark key={out.length}>{run}</mark> : run);
  for (let i = from; i < to; i++) {
    if (hit[i] !== on) (flush(), (run = ''), (on = hit[i]));
    run += chars[i];
  }
  flush();
  return <>{out}</>;
}

/** The text with each of the found words marked. */
export function Marked({ text, words }: { text: string; words: string[] }) {
  return words.length ? <Runs chars={[...text]} hit={found(text, words)} /> : <>{text}</>;
}

type DatePart = 'day' | 'year' | 'full';
const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** The language's format for a calendar day (so in UTC): its day and month, its year alone, or both. */
function dateFormat(tag: string, part: DatePart): Intl.DateTimeFormat {
  const key = `${part}\n${tag}`;
  let f = dateFormats.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'UTC', ...(part === 'year' ? { year: 'numeric' } : { day: 'numeric', month: 'short', ...(part === 'full' ? { year: 'numeric' } : {}) }) };
    try {
      f = new Intl.DateTimeFormat([tag, 'en'], opts);
    } catch {
      f = new Intl.DateTimeFormat('en', opts);
    }
    dateFormats.set(key, f);
  }
  return f;
}

/**
 * An article's date, short enough for a sidebar row beside a Draft badge: "Oct 2" in English for a day in this year,
 * "Oct 2, 2025" for any other, or always with its year (`withYear`: for a row's name and tooltip, where nothing else
 * says the year). This year is today's on the computer's clock, read in the language's own calendar, so a date shows its
 * year whenever that calendar's year differs. A calendar day, so in UTC.
 */
export function shortDate(date: string, language: string | undefined, { withYear = false, now = new Date() }: { withYear?: boolean; now?: Date } = {}): string {
  const tag = language?.trim() || 'en';
  const day = new Date(`${date}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const year = dateFormat(tag, 'year');
  const full = withYear || year.format(day) !== year.format(today);
  return dateFormat(tag, full ? 'full' : 'day').format(day);
}
