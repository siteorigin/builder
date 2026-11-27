/**
 * Which section a panel's jump links mark as the current one. Scrolling marks the section that owns the reading line
 * below the sticky header, and the end of the scroll marks the last. A click on a jump link marks its own section
 * through the scroll it starts and for as long as the section stays in view after, since a short
 * section near the end can never reach the reading line: the scroll would otherwise keep marking the one above while
 * the clicked link still looks chosen. The author's own scrolling (wheel, touch, keys, the scrollbar), a section
 * revealed from anywhere else, or anything that moves the clicked section out of view hands the mark back to the
 * scroll.
 */
export interface JumpMark {
  here: number;
  /** The section a jump link asked for, until the author scrolls on their own or it leaves view after showing. */
  target: number | null;
  /** The target has been in view since its jump. */
  seen: boolean;
}

/** Where the sections are, measured in one coordinate space with the area in view below the header. */
export interface JumpGeometry {
  /** Each section's top and bottom, in order. */
  tops: number[];
  bottoms: number[];
  /** The reading line, and the top and bottom of what is in view below the header. */
  line: number;
  viewTop: number;
  viewBottom: number;
  atEnd: boolean;
  count: number;
}

export type JumpEvent =
  | { type: 'jump'; index: number }
  | ({ type: 'scroll' } & JumpGeometry)
  /** The author scrolled on their own, or something else moved the panel. */
  | { type: 'input' };

export const startMark: JumpMark = { here: 0, target: null, seen: false };

/** The section the scroll position alone marks. */
export function sectionAtLine(tops: number[], line: number, atEnd: boolean, count: number): number {
  if (count <= 0) return 0;
  if (atEnd) return count - 1;
  let i = 0;
  tops.forEach((top, n) => top <= line && (i = n));
  return Math.min(i, count - 1);
}

const inView = (g: JumpGeometry, i: number) => i < g.tops.length && g.bottoms[i] > g.viewTop && g.tops[i] < g.viewBottom;
const same = (a: JumpMark, b: JumpMark) => a.here === b.here && a.target === b.target && a.seen === b.seen;

export function nextMark(mark: JumpMark, e: JumpEvent): JumpMark {
  if (e.type === 'jump') return { here: e.index, target: e.index, seen: false };
  if (e.type === 'input') return mark.target === null ? mark : { ...mark, target: null, seen: false };
  const at = sectionAtLine(e.tops, e.line, e.atEnd, e.count);
  let next: JumpMark;
  if (mark.target === null) next = { here: at, target: null, seen: false };
  else if (inView(e, mark.target)) next = { here: mark.target, target: mark.target, seen: true };
  // Gone from view after showing, the jump is over; on its way there, it stays the one marked.
  else next = mark.seen ? { here: at, target: null, seen: false } : mark;
  return same(mark, next) ? mark : next;
}
