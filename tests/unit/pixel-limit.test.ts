/**
 * A picture over the decode cap (100 megapixels) gets no web copies, so a site would send it whole to every visitor
 * (#1444): Project health and a website export name every such image the library holds, however small its file.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '@shared/types';
import { MAX_VARIANT_PIXELS, overPixelLimit } from '@shared/picture-formats';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { assetSizeWarnings } from '../../src/main/export';

const image = (id: string, width: number, height: number, extra: Partial<AssetRecord> = {}) =>
  ({ id, name: 'Poster', kind: 'image', file: `static/assets/${id}.png`, mime: 'image/png', bytes: 500_000, hash: id, createdAt: '2026-01-01T00:00:00.000Z', width, height, ...extra }) as AssetRecord;

describe('a picture too large to make copies of (#1444)', () => {
  it('is any raster picture over 100 megapixels, never one at the cap, an SVG, or one of unknown size', () => {
    expect(MAX_VARIANT_PIXELS).toBe(100_000_000);
    expect(overPixelLimit('image/png', 20_000, 6_000)).toBe(true);
    expect(overPixelLimit('image/jpeg', 10_000, 10_001)).toBe(true);
    for (const mime of ['image/webp', 'image/gif', 'image/avif', 'image/heic']) expect(overPixelLimit(mime, 12_000, 12_000), mime).toBe(true);
    expect(overPixelLimit('image/png', 10_000, 10_000)).toBe(false);
    expect(overPixelLimit('image/svg+xml', 20_000, 6_000)).toBe(false);
    expect(overPixelLimit('image/png', undefined, undefined)).toBe(false);
  });

  it('is a Project health warning on its asset, in place of the large-file one, and only for such a picture', () => {
    const s = structuredClone(createStarterState('business', 'Riverside Studio', false));
    s.assets.assets.a_poster = image('a_poster', 20_000, 6_000);
    s.assets.assets.a_heavy = image('a_heavy', 20_000, 6_000, { name: 'Heavy poster', bytes: 2_000_000 });
    s.assets.assets.a_cap = image('a_cap', 10_000, 10_000, { name: 'At the cap' });
    const found = validateState(s).filter((d) => d.code === 'ASSET_PIXEL_LIMIT' || d.code === 'ASSET_LARGE');
    expect(found).toEqual([
      {
        severity: 'warning',
        code: 'ASSET_PIXEL_LIMIT',
        message: 'Poster is 20,000 × 6,000 pixels, too large to make smaller web copies of, so every visitor downloads all of it. Add a copy under 100 megapixels and use Replace everywhere in Assets.',
        owner: { kind: 'asset', id: 'a_poster' }
      },
      expect.objectContaining({ code: 'ASSET_PIXEL_LIMIT', owner: { kind: 'asset', id: 'a_heavy' } })
    ]);
    // Replaced by a smaller picture, it is no longer a problem.
    s.assets.assets.a_poster = image('a_poster', 2_560, 768);
    s.assets.assets.a_heavy = image('a_heavy', 2_560, 768, { name: 'Heavy poster', bytes: 2_000_000 });
    expect(validateState(s).filter((d) => d.code === 'ASSET_PIXEL_LIMIT').length).toBe(0);
    expect(validateState(s).filter((d) => d.code === 'ASSET_LARGE').length).toBe(1);
  });

  it('is named among a website export’s notes when it ships, and not when it is left out or missing', () => {
    const s = structuredClone(createStarterState('business', 'Riverside Studio', false));
    for (const id of Object.keys(s.assets.assets)) delete s.assets.assets[id];
    s.assets.assets.a_poster = image('a_poster', 20_000, 6_000);
    s.assets.assets.a_heavy = image('a_heavy', 2_000, 1_500, { name: 'Heavy', bytes: 2_000_000 });
    const poster = expect.stringMatching(/^Poster is 20,000 × 6,000 pixels, too large to make smaller web copies of/);
    expect(assetSizeWarnings(s, [], new Set())).toEqual([poster, 'Heavy is 2.0 MB; consider a smaller image.']);
    expect(assetSizeWarnings(s, [s.assets.assets.a_poster], new Set())).toEqual(['Heavy is 2.0 MB; consider a smaller image.']);
    expect(assetSizeWarnings(s, [], new Set(['a_poster', 'a_heavy']))).toEqual([]);
  });
});
