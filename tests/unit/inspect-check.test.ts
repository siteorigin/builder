import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { failedImages, missingImages, missingSections, staleImages } from '../../src/renderer/src/lib/inspect-check';

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
    const stale = { images: { failed: 0, sources: ['/assets/a-11111111.jpg', '/assets/hero.jpg'] }, sections: [] };
    expect(missingImages(state, home, stale)).toEqual(['/assets/b-22222222.jpg']);
    // Photo A is a library image the page no longer uses; hero.jpg is not in the library, so it is left alone.
    expect(staleImages(state, home, stale)).toEqual(['/assets/a-11111111.jpg']);
    const current = { images: { failed: 0, sources: ['/assets/b-22222222.jpg'] } };
    expect(missingImages(state, home, current)).toEqual([]);
    expect(staleImages(state, home, current)).toEqual([]);
    // Older bridges, failed loads and unknown pages are not second-guessed.
    expect(missingImages(state, home, { images: { failed: 0 } })).toEqual([]);
    expect(missingImages(state, home, { error: 'The preview is not running.' })).toEqual([]);
    expect(missingImages(state, 'pg_none', stale)).toEqual([]);
    expect(staleImages(state, home, { error: 'x', images: stale.images })).toEqual([]);
    // A page with more images than the bridge lists cannot be compared image by image.
    const many = { images: { failed: 0, sources: ['/assets/a-11111111.jpg', ...Array(199).fill('/assets/hero.jpg')] } };
    expect(missingImages(state, home, many)).toEqual([]);
    expect(staleImages(state, home, many)).toEqual([]);
  });

  it('counts a library image still in use in the shared header as current, not stale', () => {
    let { state, home } = page();
    const header = { kind: 'shell' as const, id: 'header' };
    const r = applyOperations(state, [{ type: 'node.insert', owner: header, primitive: 'image' }]);
    state = applyOperations(r.state, [{ type: 'node.setContent', owner: header, nodeId: (r.results[0] as { nodeId: string }).nodeId, field: 'image', value: 'as_a' }]).state;
    expect(staleImages(state, home, { images: { failed: 0, sources: ['/assets/a-11111111.jpg'] } })).toEqual([]);
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
