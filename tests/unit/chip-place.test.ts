/**
 * Where the canvas's selection chip goes (#905): parked in the strip above the page, never over the page, lined up with
 * the selection and inside the frame.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHIP_H, chipLeft } from '../../src/renderer/src/lib/chip-place';

describe('the selection chip', () => {
  it('lines up with the selection, inside the frame', () => {
    expect(chipLeft(120, 200, 1000)).toBe(120);
    expect(chipLeft(-40, 200, 1000)).toBe(0);
    // Near the frame's right edge it ends at the edge rather than past it.
    expect(chipLeft(900, 200, 1000)).toBe(800);
    // Wider than the frame: from its left.
    expect(chipLeft(50, 1200, 1000)).toBe(0);
  });

  it('takes the strip’s whole width, whatever width it had for the last selection', () => {
    // A short chip near the right edge, then a longer one: it moves left to fit rather than keeping the short one's place.
    expect(chipLeft(900, 80, 1000)).toBe(900);
    expect(chipLeft(900, 300, 1000)).toBe(700);
  });

  it('is drawn above the page frame, never on it', () => {
    // The canvas parks it its own height and a gap above the frame's top edge: nothing of it reaches the page.
    const canvas = readFileSync('src/renderer/src/panels/Canvas.tsx', 'utf8');
    expect(canvas).toMatch(/const top = -CHIP_H - 6;/);
    expect(canvas).not.toMatch(/chipPlacement|placement === 'inside'/);
    // Both chips (selected, and text being typed) line up with the selection and may be as wide as the frame: a
    // collection layout's band has a row of its own, so nothing else shares the strip.
    expect(canvas.match(/chipLeft\(box\.left, w, frameWidth\)/g)).toHaveLength(1);
    expect(canvas.match(/maxWidth: frameWidth \}/g)).toHaveLength(2);
    // The height the canvas parks it by is the height the stylesheet draws it at.
    expect(readFileSync('src/renderer/src/panels/Canvas.css', 'utf8')).toMatch(new RegExp(`\\.ov-chip \\{[^}]*height: ${CHIP_H}px;`));
  });
});
