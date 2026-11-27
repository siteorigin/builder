import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Which section a panel's jump links mark as the current one. Scrolling marks the section that owns the reading line
 * below the sticky header, and the end of the scroll marks the last. A click on a jump link marks its own section and
 * holds it through the scroll it starts, since a short section near the end can never reach the reading line: the
 * scroll would otherwise keep marking the one above while the clicked link still looks chosen. When that scroll
 * settles, the next scroll marks by position again; the author's own scrolling (wheel, touch, scroll keys, the
 * scrollbar), or a section revealed from anywhere else, hands the mark back to the scroll at once.
 */
export interface JumpMark {
  here: number;
  /** Set by a jump link, until its scroll settles or the author scrolls on their own. */
  held: boolean;
  /** The held jump's scroll has started, so the next end of a scroll is its own. */
  moved: boolean;
}

export type JumpEvent =
  | { type: 'jump'; index: number }
  /** The tops of the sections, in order, the reading line, and whether the scroll is at its end. */
  | { type: 'scroll'; tops: number[]; line: number; atEnd: boolean; count: number }
  /** A scroll came to rest. */
  | { type: 'settle' }
  /** The author scrolled on their own, or something else moved the panel. */
  | { type: 'input' };

export const startMark: JumpMark = { here: 0, held: false, moved: false };

/** The section the scroll position alone marks. */
export function sectionAtLine(tops: number[], line: number, atEnd: boolean, count: number): number {
  if (count <= 0) return 0;
  if (atEnd) return count - 1;
  let i = 0;
  tops.forEach((top, n) => top <= line && (i = n));
  return Math.min(i, count - 1);
}

export function nextMark(mark: JumpMark, e: JumpEvent): JumpMark {
  if (e.type === 'jump') return { here: e.index, held: true, moved: false };
  if (e.type === 'input') return mark.held ? { ...mark, held: false, moved: false } : mark;
  // A scroll that ended before the jump's own began (the wheel just before the click) leaves the hold in place.
  if (e.type === 'settle') return mark.held && mark.moved ? { ...mark, held: false, moved: false } : mark;
  if (mark.held) return mark.moved ? mark : { ...mark, moved: true };
  const here = sectionAtLine(e.tops, e.line, e.atEnd, e.count);
  return here === mark.here ? mark : { ...mark, here };
}

/** Keys that scroll the panel when nothing inside takes them. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const takesKeys = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || !!el.closest('input, textarea, select, button, a, [contenteditable], [role="button"], [role="slider"], [role="listbox"], [role="spinbutton"]'));

/**
 * The jump-link mark for a scrolling panel whose direct `.section` children are its sections, under a sticky `head`.
 * Spread `panel` on the scrolling element, and call `jump` from a jump link after opening its section.
 */
export function useJumpMark(count: number, head: string) {
  const [mark, setMark] = useState<JumpMark>(startMark);
  // The panel, once it is drawn: a panel that draws nothing at first still gets its listeners when it appears.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const move = useCallback((e: JumpEvent) => setMark((m) => nextMark(m, e)), []);
  const measure = useCallback(() => {
    if (!el) return;
    // The section that owns the upper third of what is in view below the header is the one being read.
    const top = el.querySelector<HTMLElement>(head)?.offsetHeight ?? 0;
    const line = el.getBoundingClientRect().top + top + (el.clientHeight - top) / 3;
    const tops = [...el.querySelectorAll<HTMLElement>(':scope > .section')].map((s) => s.getBoundingClientRect().top);
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    move({ type: 'scroll', tops, line, atEnd, count });
  }, [el, count, head, move]);
  useEffect(() => {
    let frame = 0;
    // A reveal from anywhere else moves the panel, or focuses a field that does, so the scroll marks again; measured
    // once it has laid out, for a reveal that lands where the panel already was. A jump link holds again right after.
    const onOpen = () => {
      move({ type: 'input' });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(measure)));
    };
    const onEnd = () => move({ type: 'settle' });
    window.addEventListener('inspector-open-section', onOpen);
    el?.addEventListener('scrollend', onEnd);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('inspector-open-section', onOpen);
      el?.removeEventListener('scrollend', onEnd);
    };
  }, [el, measure, move]);
  const release = useCallback(() => move({ type: 'input' }), [move]);
  const jump = useCallback((index: number) => move({ type: 'jump', index }), [move]);
  const panel = {
    ref: setEl,
    onScroll: measure,
    onWheel: release,
    onTouchMove: release,
    onKeyDown: (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && !takesKeys(e.target) && release(),
    // A press on the panel itself, not on anything inside it, is its scrollbar.
    onPointerDown: (e: PointerEvent) => e.target === e.currentTarget && release()
  };
  return { here: mark.here, jump, panel };
}
