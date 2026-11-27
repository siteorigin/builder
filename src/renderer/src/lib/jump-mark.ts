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
