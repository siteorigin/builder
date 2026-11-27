/**
 * Which section a panel's jump links mark as the current one. Scrolling marks the section that owns the reading line
 * below the sticky header, and the end of the scroll marks the last. A click on a jump link marks its own section and
 * holds it through the scroll it starts, since a short section near the end can never reach the reading line: the
 * scroll would otherwise keep marking the one above while the clicked link still looks chosen. The author's own
 * scrolling (wheel, touch, keys, the scrollbar) lets the scroll mark the section again.
 */
export interface JumpMark {
  here: number;
  /** Set by a jump link, until the author scrolls on their own. */
  held: boolean;
}

export type JumpEvent =
  | { type: 'jump'; index: number }
  /** The tops of the sections, in order, the reading line, and whether the scroll is at its end. */
  | { type: 'scroll'; tops: number[]; line: number; atEnd: boolean; count: number }
  | { type: 'input' };

export const startMark: JumpMark = { here: 0, held: false };

/** The section the scroll position alone marks. */
export function sectionAtLine(tops: number[], line: number, atEnd: boolean, count: number): number {
  if (count <= 0) return 0;
  if (atEnd) return count - 1;
  let i = 0;
  tops.forEach((top, n) => top <= line && (i = n));
  return Math.min(i, count - 1);
}

export function nextMark(mark: JumpMark, e: JumpEvent): JumpMark {
  if (e.type === 'jump') return mark.here === e.index && mark.held ? mark : { here: e.index, held: true };
  if (e.type === 'input') return mark.held ? { ...mark, held: false } : mark;
  if (mark.held) return mark;
  const here = sectionAtLine(e.tops, e.line, e.atEnd, e.count);
  return here === mark.here ? mark : { here, held: false };
}
