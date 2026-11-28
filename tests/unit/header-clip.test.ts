/** Keeping the canvas's outlines and the hovered element's name off the site's header (#1315). */
import { describe, expect, it } from 'vitest';
import { headerArea, headerClip, inHeader, shownTop, tagPlace } from '../../src/renderer/src/lib/header-clip';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
/** A sticky header across a 1000px page, 80px tall, at the window's top. */
const HEADER = box(0, 0, 1000, 80);

describe('the headers’ area', () => {
  it('covers two overlapping header boxes once, so the clip leaves out their shared part too', () => {
    expect(headerArea([box(0, 0, 1000, 80), box(0, 60, 400, 40)])).toEqual([box(0, 0, 1000, 60), box(0, 60, 1000, 20), box(0, 80, 400, 20)]);
    expect(headerArea([box(0, 0, 100, 10), box(50, 0, 100, 10), box(300, 0, 10, 10)])).toEqual([box(0, 0, 150, 10), box(300, 0, 10, 10)]);
    expect(headerArea([box(0, 0, 0, 10)])).toEqual([]);
  });

  it('cuts the header out of a box’s clip, in the box’s own pixels, and clips nothing without one', () => {
    expect(headerClip([HEADER], { left: 40, top: -30 })).toBe('path(evenodd, "M-100000 -100000H100000V100000H-100000ZM-40 30H960V110H-40Z")');
    expect(headerClip([])).toBeUndefined();
  });

  it('knows the header’s own elements, at any depth of placement, from the page’s', () => {
    expect(inHeader('shell:header')).toBe(true);
    expect(inHeader('shell:header|logo|x')).toBe(true);
    expect(inHeader('shell:footer')).toBe(false);
    expect(inHeader('page:home')).toBe(false);
    expect(inHeader(null)).toBe(false);
  });
});

describe('the part of an element that shows', () => {
  it('starts below a header its top has scrolled under, and below one stacked right under that', () => {
    expect(shownTop(box(40, -30, 600, 400), [HEADER])).toBe(80);
    expect(shownTop(box(40, -30, 600, 400), [HEADER, box(0, 80, 1000, 30)])).toBe(110);
    expect(shownTop(box(40, 120, 600, 400), [HEADER])).toBe(120);
    expect(shownTop(box(40, -30, 600, 400), [])).toBe(0);
    // A header beside it, not across it, takes nothing.
    expect(shownTop(box(600, -30, 300, 400), [box(0, 0, 500, 80)])).toBe(0);
  });
});

describe('where the hovered element’s name goes', () => {
  it('is where it always was with no header in the way', () => {
    expect(tagPlace(box(40, 100, 600, 400), true, [])).toEqual({ at: 'inside', top: 4 });
    expect(tagPlace(box(40, -50, 600, 400), true, [])).toEqual({ at: 'inside', top: 54 });
    expect(tagPlace(box(40, 100, 200, 30), false, [])).toEqual({ at: 'above' });
    expect(tagPlace(box(40, 10, 200, 30), false, [])).toEqual({ at: 'below' });
    expect(tagPlace(box(40, -50, 600, 70), true, [])).toBeNull();
  });

  it('keeps a tall container’s name below the header its top has scrolled under', () => {
    expect(tagPlace(box(40, -30, 600, 400), true, [HEADER])).toEqual({ at: 'inside', top: 114 });
    // Too little of it shows below the header: no name.
    expect(tagPlace(box(40, -30, 600, 130), true, [HEADER])).toBeNull();
  });

  it('puts a short element’s name below it when above would be on the header, and inside when neither side is clear', () => {
    // The heading starts just below the header: above it the name would cover the header's foot.
    expect(tagPlace(box(40, 90, 300, 40), false, [HEADER])).toEqual({ at: 'below' });
    // A heading with a second header right under it: inside, below the header.
    expect(tagPlace(box(40, 60, 300, 60), false, [HEADER, box(0, 120, 1000, 40)])).toEqual({ at: 'inside', top: 24 });
    // Wholly under the header: none.
    expect(tagPlace(box(40, 20, 300, 40), false, [HEADER])).toBeNull();
  });

  it('looks for a header across the name, which can be wider than its element', () => {
    // A 40px icon beside a header that ends at x 100: the name, wider, reaches it.
    expect(tagPlace(box(60, 100, 40, 30), false, [box(100, 0, 500, 90)])).toEqual({ at: 'below' });
    // Anchored right, the name runs left from the element's right edge, away from a header past it.
    expect(tagPlace(box(860, 100, 40, 30), false, [box(0, 0, 800, 90)], true)).toEqual({ at: 'below' });
    expect(tagPlace(box(860, 100, 40, 30), false, [box(0, 0, 700, 90)], true)).toEqual({ at: 'above' });
  });
});
