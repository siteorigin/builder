/**
 * Where the canvas draws its edge Add (+) buttons, kept off the site's header (#1141): the first section's top edge
 * meets the header, and a header that stays in view has other sections pass under it.
 */
import { describe, expect, it } from 'vitest';
import { placeAdd, spreadAdds, underHeader, type AddBox } from '../../src/renderer/src/lib/add-place';

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

  it('leaves an inside button where it is', () => {
    expect(placeAdd('inside', section(0, 80), frame, false, [header])).toEqual(placeAdd('inside', section(0, 80), frame));
  });

  it('steps one of two on the same spot along, without stepping it onto a narrow header', () => {
    const two = [{ side: 'before' as const, at: { left: 600, top: 79 } }, { side: 'after' as const, at: { left: 600, top: 79 } }];
    expect(spreadAdds(two, [header]).map((b) => b.at)).toEqual([{ left: 600, top: 79 }, { left: 566, top: 79 }]);
    const beside = { left: 400, top: 40, width: 170, height: 60 };
    expect(spreadAdds(two, [beside]).map((b) => b.at.left)).toEqual([600, 634]);
  });

  it('leaves out the line of an edge scrolled under the header, and keeps the one at its foot', () => {
    expect(underHeader(60, section(60), [header])).toBe(false);
    expect(underHeader(10, section(10), [header])).toBe(true);
    expect(underHeader(0, section(0), [header])).toBe(true);
  });
});
