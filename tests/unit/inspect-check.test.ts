import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { failedImages, missingImages, missingSections, staleImages, withUnconfirmedImages } from '../../src/renderer/src/lib/inspect-check';

/** Home with an image placed on the page, showing photo B (the page changed from photo A). */
function page() {
  const asset = (id: string, file: string) => ({ type: 'asset.add' as const, asset: { id, name: id, file, mime: 'image/jpeg', bytes: 1, width: 1600, height: 900, hash: id, kind: 'image' as const, createdAt: '2026-01-01T00:00:00Z' } });
  let state = createStarterState('business', 'Test', false);
  const home = state.site.homePageId;
  const owner = { kind: 'page' as const, id: home };
  state = applyOperations(state, [asset('as_a', 'static/assets/a-11111111.jpg'), asset('as_b', 'static/assets/b-22222222.jpg')]).state;
  const r = applyOperations(state, [{ type: 'node.insert', owner, primitive: 'image', index: 1 }]);
  state = r.state;
  const imageId = (r.results[0] as { nodeId: string }).nodeId;
  state = applyOperations(state, [{ type: 'node.setContent', owner, nodeId: imageId, field: 'image', value: 'as_b' }]).state;
  return { state, home };
}

describe('measured preview loads', () => {
  it('finds an image change the measured load had not caught up with', () => {
    const { state, home } = page();
    // A load that still showed photo A, with SvelteKit's relative address resolved by the bridge.
    const src = (path: string, outcome = 'loaded') => ({ path, outcome });
    const stale = { images: { failed: 0, sources: [src('/assets/a-11111111.jpg'), src('/assets/hero.jpg')] }, sections: [] };
    expect(missingImages(state, home, stale)).toEqual(['/assets/b-22222222.jpg']);
    // Photo A is a library image the page no longer uses; hero.jpg is not in the library, so it is left alone.
    expect(staleImages(state, home, stale)).toEqual(['/assets/a-11111111.jpg']);
    const current = { images: { failed: 0, sources: [src('/assets/b-22222222.jpg')] } };
    expect(missingImages(state, home, current)).toEqual([]);
    expect(staleImages(state, home, current)).toEqual([]);
    // Older bridges, failed loads and unknown pages are not second-guessed.
    expect(missingImages(state, home, { images: { failed: 0 } })).toEqual([]);
    expect(missingImages(state, home, { error: 'The preview is not running.' })).toEqual([]);
    expect(missingImages(state, 'pg_none', stale)).toEqual([]);
    expect(staleImages(state, home, { error: 'x', images: stale.images })).toEqual([]);
  });

  it('counts a library image still in use in the shared header as current, not stale', () => {
    let { state, home } = page();
    const header = { kind: 'shell' as const, id: 'header' };
    const r = applyOperations(state, [{ type: 'node.insert', owner: header, primitive: 'image' }]);
    state = applyOperations(r.state, [{ type: 'node.setContent', owner: header, nodeId: (r.results[0] as { nodeId: string }).nodeId, field: 'image', value: 'as_a' }]).state;
    expect(staleImages(state, home, { images: { failed: 0, sources: [{ path: '/assets/a-11111111.jpg', outcome: 'loaded' }] } })).toEqual([]);
  });

  it('turns images a load could not speak for into images that could not be checked', () => {
    const report = { images: { total: 1, loaded: 1, failed: 0, unverified: 0 }, issues: [{ kind: 'text-overflow' }] };
    const out = withUnconfirmedImages(report, ['/assets/b-22222222.jpg']) as { images: Record<string, number>; issues: Array<{ kind: string; message?: string }> };
    expect(out.images).toMatchObject({ total: 2, loaded: 1, failed: 0, unverified: 1 });
    expect(out.issues).toEqual([{ kind: 'text-overflow' }, { kind: 'image-unverified', message: expect.stringContaining('/assets/b-22222222.jpg') }]);
    expect(withUnconfirmedImages(report, [])).toBe(report);
  });

  it('sets aside the result of an image the page no longer shows, so its failure is not reported', () => {
    // The stale load showed photo A, which failed; the page now shows B, which the load never showed.
    const report = {
      images: { total: 2, loaded: 1, failed: 1, unverified: 0, failedFiles: ['a-11111111.jpg'], sources: [{ path: '/assets/a-11111111.jpg', outcome: 'failed' }, { path: '/assets/logo.png', outcome: 'loaded' }] },
      issues: [{ kind: 'broken-image', source: '/assets/a-11111111.jpg', message: 'Image /assets/a-11111111.jpg failed to load.' }, { kind: 'missing-alt' }]
    };
    const out = withUnconfirmedImages(report, ['/assets/b-22222222.jpg'], ['/assets/a-11111111.jpg']) as { images: Record<string, unknown>; issues: Array<{ kind: string }> };
    expect(out.images).toMatchObject({ total: 2, loaded: 1, failed: 0, unverified: 1, failedFiles: [] });
    expect(out.issues.map((i) => i.kind)).toEqual(['missing-alt', 'image-unverified']);
  });

  it('counts failed images and sections a load did not render', () => {
    const { state, home } = page();
    expect(failedImages({ images: { failed: 2 } })).toBe(2);
    expect(failedImages({ error: 'x', images: { failed: 2 } })).toBe(0);
    expect(failedImages({ issues: [] })).toBe(0);
    const ids = state.pages[home].rootIds;
    expect(missingSections(state, home, { sections: [`page:${home}|${ids[0]}`] })).toEqual(ids.slice(1));
    expect(missingSections(state, home, { error: 'x', sections: [] })).toEqual([]);
  });
});
