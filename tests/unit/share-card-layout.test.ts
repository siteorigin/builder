/**
 * How each platform's share card (#705) lays out a link: which pictures it crops, shrinks to a thumbnail or leaves
 * out, and how many lines of title and description it keeps.
 */
import { describe, expect, it } from 'vitest';
import { fitWithin, SHARE_PLATFORMS, shareCardLayout } from '../../src/renderer/src/lib/share-card-layout';

const size = (width?: number, height?: number) => ({ width, height });
const slot = (platform: Parameters<typeof shareCardLayout>[0], width?: number, height?: number) => shareCardLayout(platform, size(width, height)).image;

describe('shareCardLayout', () => {
  it('covers a social feed, X, a message thread and a team chat', () => {
    expect(SHARE_PLATFORMS.map((p) => p.id)).toEqual(['feed', 'x', 'messages', 'chat']);
  });

  it('keeps each platform’s lines of title and description, with a picture or without', () => {
    const lines = (picture: { width: number; height: number } | null) => SHARE_PLATFORMS.map((p) => shareCardLayout(p.id, picture)).map((l) => [l.width, l.titleLines, l.descriptionLines]);
    expect(lines(size(1200, 630) as { width: number; height: number })).toEqual([[500, 2, 1], [500, 1, 0], [280, 2, 2], [380, 2, 3]]);
    // Without a picture X asks for its small card, which has a description.
    expect(lines(null)).toEqual([[500, 2, 1], [500, 1, 2], [280, 2, 2], [380, 2, 3]]);
  });

  it('centre-crops a large picture to each platform’s own shape', () => {
    // A tall picture: the wide slots crop most of it away.
    for (const [platform, ratio] of [['feed', 1.91], ['x', 2], ['messages', 1.91]] as const) {
      const box = slot(platform, 1200, 1600)!;
      expect(box).toMatchObject({ at: 'top', fit: 'cover', width: shareCardLayout(platform, null).width });
      expect(box.width / box.height!).toBeCloseTo(ratio, 5);
    }
  });

  it('shrinks a feed’s picture to a thumbnail under 600 × 315, and leaves it out under 200 either way', () => {
    expect(slot('feed', 600, 315)).toMatchObject({ at: 'top' });
    for (const [w, h] of [[599, 315], [600, 314], [200, 200]]) {
      expect(slot('feed', w, h), `${w} × ${h}`).toMatchObject({ at: 'side', width: 100, height: 100, fit: 'cover' });
      expect(shareCardLayout('feed', size(w, h)).note).toMatch(/small thumbnail/);
    }
    for (const [w, h] of [[199, 900], [900, 199]]) {
      expect(slot('feed', w, h), `${w} × ${h}`).toBeNull();
      expect(shareCardLayout('feed', size(w, h)).note).toMatch(/leaves the picture out/);
    }
  });

  it('gives X the large card for any picture, warning of one under its minimum, and a square placeholder without', () => {
    expect(shareCardLayout('x', size(300, 157))).toMatchObject({ overlay: true, host: 'outside', note: 'With a large picture, X shows no description.' });
    for (const [w, h] of [[299, 157], [300, 156]]) expect(shareCardLayout('x', size(w, h)).note, `${w} × ${h}`).toMatch(/may leave the picture out/);
    expect(shareCardLayout('x', null)).toMatchObject({ overlay: false, image: { at: 'side', width: 96, height: 96 }, note: null });
  });

  it('shrinks a message’s picture to a thumbnail under 300 wide, and leaves it out under 100', () => {
    expect(slot('messages', 300, 100)).toMatchObject({ at: 'top' });
    expect(slot('messages', 299, 100)).toMatchObject({ at: 'side', width: 64, height: 64 });
    expect(slot('messages', 100, 100)).toMatchObject({ at: 'side' });
    expect(slot('messages', 99, 900)).toBeNull();
    expect(slot('messages', 900, 99)).toBeNull();
  });

  it('shows a chat’s picture whole under the text, shrunk to fit and never grown', () => {
    expect(slot('chat', 1200, 630)).toMatchObject({ at: 'below', fit: 'whole', width: 360, height: 189 });
    expect(slot('chat', 1000, 2000)).toMatchObject({ width: 250, height: 500 });
    expect(slot('chat', 120, 80)).toMatchObject({ width: 120, height: 80 });
    const panorama = slot('chat', 4000, 500)!;
    expect(panorama.width).toBe(360);
    expect(panorama.height).toBeCloseTo(45, 5);
  });

  it('takes an unmeasured picture as one it can’t call large', () => {
    for (const unknown of [size(), size(1200), size(0, 0), size(NaN, 630)]) {
      expect(slot('feed', unknown.width, unknown.height)).toMatchObject({ at: 'side' });
      expect(slot('chat', unknown.width, unknown.height)).toMatchObject({ at: 'below', width: 360, height: null, maxHeight: 500 });
    }
    expect(slot('messages')).toMatchObject({ at: 'side' });
    expect(slot('messages', 1200)).toMatchObject({ at: 'top' });
    expect(shareCardLayout('x', size()).note).toBe('With a large picture, X shows no description.');
  });

  it('has no picture slot without a picture, X’s placeholder aside', () => {
    for (const platform of ['feed', 'messages', 'chat'] as const) expect(shareCardLayout(platform, null).image).toBeNull();
  });
});

describe('fitWithin', () => {
  it('keeps the shape and respects both bounds', () => {
    expect(fitWithin(720, 720, 360, 500)).toEqual({ width: 360, height: 360 });
    expect(fitWithin(200, 100, 360, 500)).toEqual({ width: 200, height: 100 });
  });
});
