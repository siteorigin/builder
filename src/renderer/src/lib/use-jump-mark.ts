import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { openSection } from '../components/ui';
import { nextMark, startMark, type JumpEvent, type JumpMark } from './jump-mark';

/** Keys that scroll the panel, or move focus and with it the scroll, wherever focus is inside it. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']);

/**
 * The jump-link mark for a scrolling panel whose direct `.section` children are its sections, under a sticky `head`.
 * Spread `panel` on the scrolling element, and call `jump` from a jump link with its index and section ID.
 */
export function useJumpMark(count: number, head: string) {
  const [mark, setMark] = useState<JumpMark>(startMark);
  // The panel, once it is drawn: a panel that draws nothing at first still gets its listeners when it appears.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const move = useCallback((e: JumpEvent) => setMark((m) => nextMark(m, e)), []);
  const measure = useCallback(() => {
    if (!el) return;
    const box = el.getBoundingClientRect();
    const viewTop = box.top + (el.querySelector<HTMLElement>(head)?.offsetHeight ?? 0);
    const viewBottom = box.top + el.clientHeight;
    const rects = [...el.querySelectorAll<HTMLElement>(':scope > .section')].map((s) => s.getBoundingClientRect());
    move({
      type: 'scroll',
      tops: rects.map((r) => r.top),
      bottoms: rects.map((r) => r.bottom),
      // The section that owns the upper third of what is in view below the header is the one being read.
      line: viewTop + (viewBottom - viewTop) / 3,
      viewTop,
      viewBottom,
      atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
      count
    });
  }, [el, count, head, move]);
  useEffect(() => {
    let frame = 0;
    // A reveal from anywhere else moves the panel, or focuses a field that does, so the scroll marks again; measured
    // once it has laid out, for a reveal that lands where the panel already was. One while the panel is hidden (kept
    // mounted behind another tab, with no size to read) is another tab's. A jump link holds again right after its own reveal, so the measure finds it held.
    const onOpen = () => {
      if (!el?.clientHeight) return;
      move({ type: 'input' });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(measure)));
    };
    window.addEventListener('inspector-open-section', onOpen);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('inspector-open-section', onOpen);
    };
  }, [el, measure, move]);
  const release = useCallback(() => move({ type: 'input' }), [move]);
  /** Open a jump link's section and scroll to it, marking it from the moment the scroll brings it into view. */
  const jump = useCallback(
    (index: number, id: string) => {
      openSection(id);
      move({ type: 'jump', index });
    },
    [move]
  );
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
