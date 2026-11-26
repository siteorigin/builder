/**
 * Where the canvas's selection chip goes (#905): parked in the strip above the page, never over the page, lined up with
 * the selection and clear of what the strip already shows.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHIP_H, CHIP_MIN, chipLeft, chipRoom } from '../../src/renderer/src/lib/chip-place';

describe('the selection chip', () => {
  it('lines up with the selection, inside the frame', () => {
    expect(chipLeft(120, 200, 1000)).toBe(120);
    expect(chipLeft(-40, 200, 1000)).toBe(0);
    // Near the frame's right edge it ends at the edge rather than past it.
    expect(chipLeft(900, 200, 1000)).toBe(800);
    // Wider than the frame: from its left.
    expect(chipLeft(50, 1200, 1000)).toBe(0);
  });

  it('starts after a collection layout’s entry picker and Done, when there is room beside them', () => {
    expect(chipLeft(20, 200, 1000, 360)).toBe(360);
    expect(chipLeft(500, 200, 1000, 360)).toBe(500);
    expect(chipLeft(900, 200, 1000, 360)).toBe(800);
    // Too little room for the whole chip: it still starts after them, and narrows to what is left.
    expect(chipLeft(20, 200, 500, 360)).toBe(360);
    expect(chipRoom(360, 500)).toBe(140);
    // No room at all: it lines up with the selection, at its narrowest.
    expect(chipLeft(20, 200, 400, 360)).toBe(20);
    expect(chipRoom(390, 400)).toBe(CHIP_MIN);
  });

  it('is drawn above the page frame, never on it', () => {
    // The canvas parks it its own height and a gap above the frame's top edge: nothing of it reaches the page.
    const canvas = readFileSync('src/renderer/src/panels/Canvas.tsx', 'utf8');
    expect(canvas).toMatch(/const top = -CHIP_H - 6;/);
    expect(canvas).not.toMatch(/chipPlacement|placement === 'inside'/);
    // Both chips (selected, and text being typed) start after the collection layout's strip and fit the room left.
    expect(canvas.match(/chipLeft\(box\.left, w, frameWidth, taken\)/g)).toHaveLength(1);
    expect(canvas.match(/maxWidth: chipRoom\(left, frameWidth\)/g)).toHaveLength(2);
    expect(canvas).toMatch(/taken=\{chipTaken\}/);
    // The height the canvas parks it by is the height the stylesheet draws it at.
    expect(readFileSync('src/renderer/src/panels/Canvas.css', 'utf8')).toMatch(new RegExp(`\\.ov-chip \\{[^}]*height: ${CHIP_H}px;`));
  });
});
