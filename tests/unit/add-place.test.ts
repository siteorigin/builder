/**
 * Where the canvas draws its edge Add (+) buttons, kept off the site's header (#1141): the first section's top edge
 * meets the header, and a header that stays in view has other sections pass under it.
 */
import { describe, expect, it } from 'vitest';
import { placeAdd, placeAdds, underHeader, type AddBox } from '../../src/renderer/src/lib/add-place';

const frame = { width: 800, height: 600 };
const header: AddBox = { left: 0, top: 0, width: 800, height: 60 };
/** The button's 32px square target, clear of a box. */
const clear = (at: { left: number; top: number }, r: AddBox) => at.left + 16 <= r.left || at.left - 16 >= r.left + r.width || at.top + 16 <= r.top || at.top - 16 >= r.top + r.height;
const section = (top: number, height = 400): AddBox => ({ left: 0, top, width: 800, height });

describe('an edge Add button and the site header (#1141)', () => {
  it('hangs below the header for the first section, whose top edge meets it', () => {
    const at = placeAdd('before', section(60), frame, false, [header])!;
    expect(at).toEqual({ left: 600, top: 79 });
    expect(clear(at, header)).toBe(true);
  });

  it('stays on its edge with no header, or one it does not reach', () => {
    expect(placeAdd('before', section(60), frame)).toEqual({ left: 600, top: 60 });
    expect(placeAdd('before', section(200), frame, false, [header])).toEqual({ left: 600, top: 200 });
    expect(placeAdd('before', section(60), frame, false, [{ left: 0, top: 0, width: 400, height: 60 }])).toEqual({ left: 600, top: 60 });
    // Scrolled away with the page.
    expect(placeAdd('before', section(5), frame, false, [{ left: 0, top: -115, width: 800, height: 60 }])).toEqual({ left: 600, top: 14 });
  });

  it('keeps below the header for a section scrolled under it, while the section shows past it', () => {
    expect(placeAdd('before', section(10), frame, false, [header])).toEqual({ left: 600, top: 79 });
    // A header laid over the top of the first section.
    expect(placeAdd('before', section(0), frame, false, [header])).toEqual({ left: 600, top: 79 });
  });

  it('is not drawn for an edge under the header with nothing of its section to move onto', () => {
    expect(placeAdd('before', section(10, 40), frame, false, [header])).toBeNull();
    expect(placeAdd('after', section(-360), frame, false, [header])).toBeNull();
  });

  it('keeps both buttons of a shallow first section, whose edges show', () => {
    expect(placeAdd('before', section(60, 14), frame, false, [header])).toEqual({ left: 600, top: 79 });
    expect(placeAdd('after', section(60, 14), frame, false, [header])).toEqual({ left: 600, top: 79 });
  });

  it('goes above a header at the foot of the window', () => {
    const foot = { left: 0, top: 540, width: 800, height: 60 };
    expect(placeAdd('after', section(130, 400), frame, false, [foot])).toEqual({ left: 600, top: 521 });
    expect(placeAdd('before', section(590, 200), frame, false, [foot])).toBeNull();
  });

  it('keeps an offset, narrow section’s button on that section, and one beside a header on its edge', () => {
    expect(placeAdd('before', { left: 100, top: 60, width: 200, height: 300 }, frame, false, [header])).toEqual({ left: 258, top: 79 });
    expect(placeAdd('before', section(60), frame, false, [{ left: 700, top: 0, width: 100, height: 60 }])).toEqual({ left: 600, top: 60 });
  });

  it('goes past a second header right under the first', () => {
    expect(placeAdd('before', section(20), frame, false, [{ ...header, height: 50 }, { ...header, top: 50, height: 50 }])).toEqual({ left: 600, top: 119 });
  });

  // 125% display scaling puts boxes between pixels: 111.2 + 19 - 19 comes out just under 111.2.
  it('settles below a header whose foot falls between pixels, and counts that spot clear', () => {
    const scaled = { ...header, height: 111.2 };
    const at = placeAdd('before', section(111.2), frame, false, [scaled])!;
    expect(at.top).toBeCloseTo(130.2);
    const both = placeAdds([{ key: 'a', side: 'before' as const, box: section(111.2, 14) }, { key: 'b', side: 'after' as const, box: section(111.2, 14) }], frame, [scaled]);
    expect(both.map((b) => b.at.left)).toEqual([600, 566]);
  });

  it('draws neither edge of a section wholly under the header, nor an edge scrolled out of view', () => {
    expect(placeAdd('after', section(44, 15), frame, false, [header])).toBeNull();
    expect(placeAdd('before', section(-30), frame, false, [header])).toBeNull();
  });

  it('leaves an inside button where it is', () => {
    expect(placeAdd('inside', section(0, 80), frame, false, [header])).toEqual({ left: 776, top: 56 });
  });
});

describe('the Add buttons the canvas draws', () => {
  const edge = (key: string, side: 'before' | 'after', box: AddBox) => ({ key, side, box });
  const shallow = [edge('a', 'before', section(60, 14)), edge('b', 'after', section(60, 14))];
  const lefts = (headers: AddBox[], width = 800) => placeAdds(shallow, { ...frame, width }, headers).map((b) => b.at);

  it('steps one of two on the same spot along, and leaves two apart alone', () => {
    expect(lefts([header])).toEqual([{ left: 600, top: 79 }, { left: 566, top: 79 }]);
    expect(placeAdds([edge('a', 'before', section(100)), edge('b', 'after', section(100, 300))], frame, []).map((b) => b.at.left)).toEqual([600, 600]);
  });

  it('never steps one onto a header', () => {
    const behind = { left: 400, top: 40, width: 170, height: 60 };
    expect(lefts([behind]).map((at) => at.left)).toEqual([600, 634]);
    expect(lefts([behind, { left: 630, top: 40, width: 100, height: 60 }]).map((at) => at.left)).toEqual([600, 600]);
  });

  it('gives a gap to the second candidate when the first has no place, and holds the open one where it was', () => {
    const gap = [edge('g', 'after', section(-340)), edge('g', 'before', section(60))];
    expect(placeAdds(gap, frame, [header]).map((b) => b.side)).toEqual(['before']);
    expect(placeAdds([shallow[0]], frame, [header], { left: 5, top: 6 })[0].at).toEqual({ left: 5, top: 6 });
  });

  it('leaves out the line of an edge scrolled under the header, and keeps one clear of it', () => {
    expect(underHeader(60, section(60), [header])).toBe(false);
    expect(underHeader(59, section(59), [header])).toBe(false);
    expect(underHeader(10, section(10), [header])).toBe(true);
    expect(underHeader(0, section(0), [header])).toBe(true);
    expect(underHeader(10, section(10), [{ ...header, top: 40 }])).toBe(false);
    expect(underHeader(10, { left: 500, top: 10, width: 100, height: 40 }, [{ ...header, width: 400 }])).toBe(false);
  });
});
