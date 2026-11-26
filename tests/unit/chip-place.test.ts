/**
 * Where the canvas's selection chip goes (#905): never over what is around the selection, nor over its own content.
 */
import { describe, expect, it } from 'vitest';
import { CHIP_GAP, CHIP_H, chipPlacement } from '../../src/renderer/src/lib/chip-place';

const FRAME = 800;
const ROOM = CHIP_GAP + 2 + CHIP_H + 2;

describe('the selection chip', () => {
  it('parks above the page for a short element, rather than over the one above it', () => {
    // A second Button pasted into a column, with the first just above it: the chip used to sit over the first.
    expect(chipPlacement({ top: 300, height: 40 }, true, FRAME, 10)).toBe('strip');
    expect(chipPlacement({ top: 300, height: 40 }, true, FRAME, null)).toBe('strip');
  });

  it('sits inside a section only where its own top padding holds the whole chip', () => {
    expect(chipPlacement({ top: 100, height: 400 }, true, FRAME, ROOM)).toBe('inside');
    expect(chipPlacement({ top: 100, height: 400 }, true, FRAME, 96)).toBe('inside');
    // Too little padding (or a zoom that shrinks it): the chip would cover the section's first line.
    expect(chipPlacement({ top: 100, height: 400 }, true, FRAME, ROOM - 1)).toBe('strip');
    expect(chipPlacement({ top: 100, height: 400 }, true, FRAME, 0)).toBe('strip');
    // Not yet measured for this selection.
    expect(chipPlacement({ top: 100, height: 400 }, true, FRAME, null)).toBe('strip');
  });

  it('parks above the page for parts, text being typed, and a box scrolled past the page’s edges', () => {
    expect(chipPlacement({ top: 100, height: 400 }, false, FRAME, 96)).toBe('strip');
    expect(chipPlacement({ top: -20, height: 400 }, true, FRAME, 96)).toBe('strip');
    expect(chipPlacement({ top: FRAME - 10, height: 400 }, true, FRAME, 96)).toBe('strip');
  });
});
