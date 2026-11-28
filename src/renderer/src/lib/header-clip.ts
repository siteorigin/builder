/** Keeping the canvas's outlines of the page's own elements, and the hovered element's name, off the site's header
 *  (#1315). Boxes in the overlay, in screen pixels from the page's top left; `headers` are the shared header's boxes
 *  where the page shows them now (one that stays in view has the page's elements scroll under it). */
import type { AddBox } from './add-place';

/** The headers' area as boxes that never overlap one another: one horizontal band between each pair of edges any of
 *  them has, cut at each run of headers across it. Two header boxes that overlap cover their shared part once. */
export function headerArea(headers: AddBox[]): AddBox[] {
  const hs = headers.filter((r) => r.width > 0 && r.height > 0);
  const ys = [...new Set(hs.flatMap((r) => [r.top, r.top + r.height]))].sort((a, b) => a - b);
  const out: AddBox[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const top = ys[i];
    const bottom = ys[i + 1];
    const runs = hs
      .filter((r) => r.top <= top && r.top + r.height >= bottom)
      .map((r) => [r.left, r.left + r.width])
      .sort((a, b) => a[0] - b[0]);
    let run: number[] | null = null;
    for (const [l, r] of runs) {
      if (run && l <= run[1]) run[1] = Math.max(run[1], r);
      else {
        if (run) out.push({ left: run[0], top, width: run[1] - run[0], height: bottom - top });
        run = [l, r];
      }
    }
    if (run) out.push({ left: run[0], top, width: run[1] - run[0], height: bottom - top });
  }
  return out;
}

/**
 * A clip-path for a box of the overlay at `origin` that leaves out the headers' area, so nothing it draws (its outline,
 * an outer ring, its name above or below it) is drawn on the header, however far outside the box; undefined without a
 * header in view. In the box's own pixels.
 */
export function headerClip(headers: AddBox[], origin: { left: number; top: number } = { left: 0, top: 0 }): string | undefined {
  const area = headerArea(headers).map((r) => ({ ...r, left: r.left - origin.left, top: r.top - origin.top }));
  if (!area.length) return undefined;
  const n = (v: number) => String(Math.round(v * 100) / 100);
  const far = 100000;
  // The whole plane, with each part of the headers cut out of it: the parts never overlap, so evenodd leaves each out.
  const holes = area.map((r) => `M${n(r.left)} ${n(r.top)}H${n(r.left + r.width)}V${n(r.top + r.height)}H${n(r.left)}Z`).join('');
  return `path(evenodd, "M${-far} ${-far}H${far}V${far}H${-far}Z${holes}")`;
}

/** Whether a site element (its measured description's context) is in the shared header, at any depth of placement. */
export const inHeader = (ctx: string | null | undefined) => typeof ctx === 'string' && ctx.split('|')[0] === 'shell:header';

const crosses = (left: number, width: number, top: number, bottom: number, headers: AddBox[]) =>
  headers.some((r) => r.left < left + width && r.left + r.width > left && r.top < bottom && r.top + r.height > top);

/** The top of the part of `b` that shows: below the page's top and below every header across it there. Each header
 *  is passed once, so one stacked right under another is passed too. */
export function shownTop(b: AddBox, headers: AddBox[]): number {
  let y = Math.max(b.top, 0);
  let ahead = headers.filter((r) => r.left < b.left + b.width && r.left + r.width > b.left);
  for (let over = ahead.filter((r) => r.top <= y && r.top + r.height > y); over.length; over = ahead.filter((r) => r.top <= y && r.top + r.height > y)) {
    y = Math.max(...over.map((r) => r.top + r.height));
    ahead = ahead.filter((r) => !over.includes(r));
  }
  return y;
}

/** The hovered element's name: inside its box (`top` from the box's top), above it, below it, or not shown. */
export type TagPlace = { at: 'inside'; top: number } | { at: 'above' } | { at: 'below' } | null;

/** The name's height, and how far it keeps from an edge it sits inside. */
const TAG_H = 20;
const TAG_INSET = 4;
/** The widest a name is taken to be when looking for a header in its way: the box's own width at the least. */
const TAG_W = 160;

/**
 * Where the hovered element's name goes. A tall container (`tall`) carries it inside its top left, kept in view below
 * the page's top and any header its top has scrolled under, and drops it once less than 30px of the box shows there. A
 * short element has it above, or below where there is no room above (at the page's top, or under a header), or inside
 * below the header where neither side is clear; with no room anywhere, or nothing of the box showing, it has none.
 * `right`: the name is anchored to the box's right edge (near the page's right edge).
 */
export function tagPlace(b: AddBox, tall: boolean, headers: AddBox[], right = false): TagPlace {
  const shown = shownTop(b, headers);
  const bottom = b.top + b.height;
  const w = Math.max(b.width, TAG_W);
  const left = right ? b.left + b.width - w : b.left;
  const inside = (): TagPlace => (bottom - shown >= TAG_H + TAG_INSET * 2 ? { at: 'inside', top: shown - b.top + TAG_INSET } : null);
  if (tall) return bottom > shown + 30 ? { at: 'inside', top: shown - b.top + TAG_INSET } : null;
  if (bottom <= shown) return null;
  if (b.top >= 24 && !crosses(left, w, b.top - 19, b.top + 1, headers)) return { at: 'above' };
  if (!crosses(left, w, bottom - 1, bottom + 19, headers)) return { at: 'below' };
  return inside();
}
