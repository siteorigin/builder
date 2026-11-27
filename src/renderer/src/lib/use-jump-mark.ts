import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { nextMark, startMark, type JumpEvent, type JumpMark } from './jump-mark';

/** Keys that scroll the panel, or move focus and with it the scroll, wherever focus is inside it. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']);

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
    // A panel kept mounted behind another tab has no size to read: it keeps its mark until it shows and scrolls.
    if (!el || !el.clientHeight) return;
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
    // once it has laid out, for a reveal that lands where the panel already was. A jump link holds again right after
    // its own reveal, so the measure finds it held.
    const onOpen = () => {
      move({ type: 'input' });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(measure)));
    };
    window.addEventListener('inspector-open-section', onOpen);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('inspector-open-section', onOpen);
    };
  }, [measure, move]);
  const release = useCallback(() => move({ type: 'input' }), [move]);
  const jump = useCallback((index: number) => move({ type: 'jump', index }), [move]);
  const panel = {
    ref: setEl,
    onScroll: measure,
    onWheel: release,
    onTouchMove: release,
    onKeyDown: (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && release(),
    // A press on the panel itself, not on anything inside it, is its scrollbar.
    onPointerDown: (e: PointerEvent) => e.target === e.currentTarget && release()
  };
  return { here: mark.here, jump, panel };
}
