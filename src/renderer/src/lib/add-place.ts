/** Where the canvas draws its Add buttons (see lib/inline-insert for what they offer). Screen pixels from the page's top left. */
import type { AddSide } from './inline-insert';

/** A box in the overlay, in screen pixels from the page's top left. */
export type AddBox = { left: number; top: number; width: number; height: number };

/** An Add button's centre, in the overlay. */
export type AddAt = { left: number; top: number };

/** Where an Add button sits, in the overlay: on its section's edge three quarters across (clear of the chip at the
 *  start and the spacing handles at the middle), or inset in its container's lower trailing corner; kept on the page,
 *  and not drawn for an edge scrolled out of view. A container too short or too narrow to hold it without hiding what it
 *  holds (a Row of one line, a badge) has it hung just outside its trailing lower corner, its rim touching the
 *  outline. Trailing is the left in a right-to-left box. Drawn before the spacing handles and the chip, which stay on
 *  top where a small page brings them together. An edge button never sits on the site's header (`headers`, its boxes
 *  where the page shows them now): see clearOfHeaders. */
export function placeAdd(side: AddSide, b: AddBox, frame: { width: number; height: number }, rtl = false, headers: AddBox[] = []): AddAt | null {
  const { width: frameW, height: h } = frame;
  if (b.top > h || b.top + b.height < 0 || b.left > frameW || b.left + b.width < 0) return null;
  if (side === 'inside') {
    // Inset far enough that its focus ring (18.5px out) clears the selection's 4px outline.
    const inset = 24;
    // Outside, its keylined rim (11px + 2.5px) meets the box's edge, so it hangs from the box like a tab.
    const out = 13.5;
    // Too small to hold it, on either axis: off the box's trailing lower corner, clear of the spacing handles at the
    // middle of each side and of a neighbour stacked above or below (which most often shares the box's width). Where
    // the page's edge leaves no room there it flips to the other side; where neither side has room, it hangs below
    // the trailing end of a short box, or beside the foot of a narrow one.
    const small = 2 * inset + 8;
    if (b.width >= small && b.height >= small) {
      const x = rtl ? b.left + inset : b.left + b.width - inset;
      return { left: Math.max(14, Math.min(x, frameW - 14)), top: Math.max(14, Math.min(b.top + b.height - inset, h - 14)) };
    }
    const start = b.left - out >= 14 ? b.left - out : null;
    const end = b.left + b.width + out <= frameW - 14 ? b.left + b.width + out : null;
    const xOut = rtl ? (start ?? end) : (end ?? start);
    const yOut = b.top + b.height + out <= h - 14 ? b.top + b.height + out : b.top - out >= 14 ? b.top - out : null;
    const x = xOut ?? (rtl ? b.left + inset : b.left + b.width - inset);
    const y = yOut ?? b.top + b.height - inset;
    return { left: Math.max(14, Math.min(x, frameW - 14)), top: Math.max(14, Math.min(y, h - 14)) };
  }
  const y = side === 'before' ? b.top : b.top + b.height;
  if (y < -2 || y > h + 2) return null;
  // On a narrow section, kept past the margin handle, which sits just after the middle (see SpacingHandles).
  const edgeX = b.left + Math.max(b.width * 0.75, b.width / 2 + Math.min(28, b.width / 4) + 30);
  const x = Math.min(edgeX, b.left + b.width - 14);
  return clearOfHeaders({ left: Math.max(14, Math.min(x, frameW - 14)), top: Math.max(14, Math.min(y, h - 14)) }, y, b, h, headers);
}

/** How far an edge button's centre keeps from a header: past its 32px target, its hover growth and its focus ring. */
const CLEAR = 19;

/** Positions fall between pixels at some display scales, where a spot set CLEAR of a header can come out a rounding
 *  error short of it. */
const SLACK = 0.01;
const reach = CLEAR - SLACK;

const onHeader = (at: AddAt, headers: AddBox[]) =>
  headers.filter((r) => at.left + reach > r.left && at.left - reach < r.left + r.width && at.top + reach > r.top && at.top - reach < r.top + r.height);

/** The first spot past every header in the way, going down (`step` 1) or up (-1): one header can sit right under another. */
function past(at: AddAt, headers: AddBox[], step: 1 | -1): AddAt {
  let spot = at;
  let ahead = headers;
  // Each header is passed once, so this ends whatever their positions are.
  for (let over = onHeader(spot, ahead); over.length; over = onHeader(spot, ahead)) {
    spot = { left: at.left, top: step > 0 ? Math.max(...over.map((r) => r.top + r.height)) + CLEAR : Math.min(...over.map((r) => r.top)) - CLEAR };
    ahead = ahead.filter((r) => !over.includes(r));
  }
  return spot;
}

/**
 * An edge button that would cover the header (the first section's top edge meets it, and a header that stays in view
 * has other sections pass under it) moves just below it, or just above one at the foot of the window. It moves only
 * while its edge still shows on that side, or its section reaches that far; otherwise it is not drawn, like one for an
 * edge scrolled out of view.
 */
function clearOfHeaders(at: AddAt, edge: number, b: AddBox, h: number, headers: AddBox[]): AddAt | null {
  if (!onHeader(at, headers).length) return at;
  const below = past(at, headers, 1);
  const end = below.top - CLEAR;
  // The edge shows past the header only with some of its section beside it: a section wholly under it has neither edge.
  if (below.top <= h - 14 && ((edge >= end - 2 && b.top + b.height > end + 2) || b.top + b.height >= below.top)) return below;
  const above = past(at, headers, -1);
  const start = above.top + CLEAR;
  if (above.top >= 14 && ((edge <= start + 2 && b.top < start - 2) || b.top <= above.top)) return above;
  return null;
}

/** Whether an edge's line, at `y` across `b`, would be drawn over a header: the edge is scrolled under it. The line
 *  stays on the edge it stands for, so it is left out rather than moved. */
export function underHeader(y: number, b: AddBox, headers: AddBox[]): boolean {
  return headers.some((r) => b.left + b.width > r.left && b.left < r.left + r.width && y >= r.top && y < r.top + r.height - 2);
}

/** Two edge buttons left on top of each other (above and below a shallow section, the selection's and the hovered
 *  one's) have the later stepped a button's width along its edge, back where there is room, so each stays its own
 *  target: never off the page or onto the header. With no such room it stays where it is. */
function spreadAdds<T extends { side: AddSide; at: AddAt }>(buttons: T[], width: number, headers: AddBox[]): T[] {
  const out: T[] = [];
  for (const b of buttons) {
    const taken = (at: AddAt) => out.some((o) => o.side !== 'inside' && Math.abs(o.at.left - at.left) < 34 && Math.abs(o.at.top - at.top) < 34);
    if (b.side === 'inside' || !taken(b.at)) {
      out.push(b);
      continue;
    }
    const free = [-34, 34, -68, 68]
      .map((step) => ({ left: b.at.left + step, top: b.at.top }))
      .find((at) => at.left >= 14 && at.left <= width - 14 && !taken(at) && !onHeader(at, headers).length);
    out.push(free ? { ...b, at: free } : b);
  }
  return out;
}

/** The buttons the canvas draws, each in its place. Of two for one gap (`key`), the first that can be drawn, so one
 *  with no place leaves the gap to the other. `held`: where the one whose list is open was drawn, which stays. */
export function placeAdds<T extends { key: string; side: AddSide; box: AddBox; rtl?: boolean }>(
  buttons: T[],
  frame: { width: number; height: number },
  headers: AddBox[],
  held?: AddAt
): Array<T & { at: AddAt }> {
  const placed = buttons.flatMap((b) => {
    const at = held ?? placeAdd(b.side, b.box, frame, b.rtl, headers);
    return at ? [{ ...b, at }] : [];
  });
  return spreadAdds(
    placed.filter((b, i) => placed.findIndex((o) => o.key === b.key) === i),
    frame.width,
    headers
  );
}
