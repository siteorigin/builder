import { describe, expect, it } from 'vitest';
import { SERP_LAYOUT } from '@shared/serp';
import { FILLER_RESULTS, parseSerpView, serpColumnWidth, serpPageWidth, serpScale } from '../../src/renderer/src/lib/serp-page';

describe('the previewed results page (#704)', () => {
  it('lays its column out at the title line the cuts are measured against', () => {
    expect(serpColumnWidth('desktop')).toBe(SERP_LAYOUT.desktop.titleLine);
    expect(serpColumnWidth('mobile')).toBe(SERP_LAYOUT.mobile.titleLine);
  });

  it('is a computer’s width on a computer and a phone’s in a phone’s frame', () => {
    expect(serpPageWidth('desktop')).toBe(640);
    expect(serpPageWidth('mobile')).toBe(376);
  });

  it('shows at its real size where there is room, and is never enlarged', () => {
    for (const device of ['desktop', 'mobile'] as const) {
      expect(serpScale(serpPageWidth(device), device)).toBe(1);
      expect(serpScale(2000, device)).toBe(1);
    }
  });

  it('is scaled down to fit a narrower place, so nothing scrolls sideways', () => {
    expect(serpScale(320, 'desktop')).toBe(0.5);
    expect(serpScale(282, 'mobile')).toBe(0.75);
  });

  it('keeps its real size while the room is unknown (a hidden panel)', () => {
    expect(serpScale(0, 'desktop')).toBe(1);
    expect(serpScale(Number.NaN, 'mobile')).toBe(1);
  });

  it('opens on a computer’s light results page until another choice is saved', () => {
    const first = { device: 'desktop', dark: false };
    for (const saved of [null, undefined, '', 'dark', '{', '7', 'null', '{"device":"watch","dark":"yes"}']) expect(parseSerpView(saved)).toEqual(first);
    expect(parseSerpView(JSON.stringify({ device: 'mobile', dark: true }))).toEqual({ device: 'mobile', dark: true });
  });

  it('surrounds the result with sites on the domains reserved for examples only', () => {
    expect(FILLER_RESULTS.length).toBeGreaterThan(1);
    for (const f of FILLER_RESULTS) expect(f.url).toMatch(/^example\.(com|org|net)( › |$)/);
    expect(JSON.stringify(FILLER_RESULTS)).not.toMatch(/google|bing|duckduckgo|yahoo/i);
  });
});
