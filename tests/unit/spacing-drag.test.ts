import { describe, expect, it } from 'vitest';
import { SPACING_HANDLES, dragLabel, dragValue, draggedSize, onScreen, spaceScale, type SpaceStop } from '../../src/renderer/src/lib/spacing-drag';

// The foundation theme's spacing scale, as the page measures it at a desktop width.
const SCALE: SpaceStop[] = [
  { token: 'space.2xs', label: '2XS', px: 4 },
  { token: 'space.xs', label: 'XS', px: 8 },
  { token: 'space.sm', label: 'Small', px: 12 },
  { token: 'space.md', label: 'Medium', px: 16 },
  { token: 'space.lg', label: 'Large', px: 24 },
  { token: 'space.xl', label: 'XL', px: 32 },
  { token: 'space.2xl', label: '2XL', px: 48 },
  { token: 'space.3xl', label: '3XL', px: 72 },
  { token: 'space.section', label: 'Section', px: 120 }
];

describe('draggedSize: pointer travel at the canvas zoom', () => {
  it('takes screen pixels back through the zoom', () => {
    expect(draggedSize(24, 20, 1, 1)).toBe(44);
    expect(draggedSize(24, 20, 0.5, 1)).toBe(64);
    expect(draggedSize(24, 20, 2, 1)).toBe(34);
  });

  it('grows the way the handle faces and shrinks the other way', () => {
    const bottom = SPACING_HANDLES.find((h) => h.box === 'padding' && h.side === 'bottom')!;
    expect(draggedSize(48, -30, 1, bottom.grow)).toBe(78);
    expect(draggedSize(48, 30, 1, bottom.grow)).toBe(18);
  });

  it('never goes below zero', () => {
    expect(draggedSize(16, -200, 1, 1)).toBe(0);
  });

  it('treats a missing or broken zoom as 1', () => {
    expect(draggedSize(10, 10, 0, 1)).toBe(20);
    expect(draggedSize(10, 10, Number.NaN, 1)).toBe(20);
    expect(draggedSize(Number.NaN, 10, 1, 1)).toBe(10);
  });

  it('draws frame pixels at the zoom', () => {
    expect(onScreen(24, 0.5)).toBe(12);
    expect(onScreen(24, 1.25)).toBe(30);
    expect(onScreen(24, 0)).toBe(24);
  });
});

describe('dragValue: snapping to the spacing scale', () => {
  it('snaps to the nearest spacing site style', () => {
    expect(dragValue(25, SCALE, false)).toEqual({ value: { token: 'space.lg' }, px: 24, stop: SCALE[4] });
    expect(dragValue(60, SCALE, false).value).toEqual({ token: 'space.2xl' });
    expect(dragValue(61, SCALE, false).value).toEqual({ token: 'space.3xl' });
    expect(dragValue(500, SCALE, false).value).toEqual({ token: 'space.section' });
  });

  it('takes the smaller style on an even split', () => {
    expect(dragValue(20, SCALE, false).value).toEqual({ token: 'space.md' });
    expect(dragValue(96, SCALE, false).value).toEqual({ token: 'space.3xl' });
  });

  it('writes no space when zero is nearer than the smallest style', () => {
    expect(dragValue(1.9, SCALE, false)).toEqual({ value: '0', px: 0 });
    expect(dragValue(2, SCALE, false)).toEqual({ value: '0', px: 0 });
    expect(dragValue(2.1, SCALE, false).value).toEqual({ token: 'space.2xs' });
  });

  it('works from the sizes the page measured, in any order, whatever the styles are called', () => {
    const shuffled = [SCALE[8], SCALE[0], SCALE[5], SCALE[3]];
    expect(dragValue(30, shuffled, false).value).toEqual({ token: 'space.xl' });
    const custom = [{ token: 'space.roomy', label: 'Roomy', px: 40 }];
    expect(dragValue(35, custom, false).value).toEqual({ token: 'space.roomy' });
  });

  it('keeps the first of two styles the same size', () => {
    const alias = [...SCALE, { token: 'space.gutter', label: 'Gutter', px: 24 }];
    expect(dragValue(24, alias, false).value).toEqual({ token: 'space.lg' });
    expect(spaceScale(alias).map((s) => s.token)).not.toContain('space.gutter');
  });

  it('ignores a style the page could not measure', () => {
    const broken = [{ token: 'space.bad', label: 'Bad', px: Number.NaN }, { token: 'space.none', label: 'None', px: 0 }, SCALE[4]];
    expect(spaceScale(broken).map((s) => s.token)).toEqual(['space.lg']);
    expect(dragValue(3, broken, false)).toEqual({ value: '0', px: 0 });
  });

  it('writes whole pixels when dragged exactly, or with no styles to snap to', () => {
    expect(dragValue(37.4, SCALE, true)).toEqual({ value: '37px', px: 37 });
    expect(dragValue(37.6, [], false)).toEqual({ value: '38px', px: 38 });
    expect(dragValue(0.3, SCALE, true)).toEqual({ value: '0', px: 0 });
  });

  it('labels the HUD with the style and its size, or the size alone', () => {
    expect(dragLabel(dragValue(25, SCALE, false))).toBe('Large · 24px');
    expect(dragLabel(dragValue(37.4, SCALE, true))).toBe('37px');
    expect(dragLabel(dragValue(1, SCALE, false))).toBe('0px');
    expect(dragLabel(dragValue(100, [{ token: 'space.section', label: 'Section', px: 101.25 }], false))).toBe('Section · 101.3px');
  });
});

describe('the handles', () => {
  it('write padding on four sides and margin above and below', () => {
    expect(SPACING_HANDLES.map((h) => `${h.box}:${h.side}:${h.edge}`)).toEqual([
      'padding:top:paddingBlockStart',
      'padding:bottom:paddingBlockEnd',
      'padding:left:paddingInlineStart',
      'padding:right:paddingInlineEnd',
      'margin:top:marginBlockStart',
      'margin:bottom:marginBlockEnd'
    ]);
  });
});
