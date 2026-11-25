/**
 * Whether a post already has the values a change asked for (#563): an image the post has, imported again, is only
 * checked and never written, and that is no refusal; a post edited meanwhile, or gone, no longer holds them.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { postHolds } from '../../src/renderer/src/lib/posts';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const ref = { collectionId: 'posts', entryId: 'en_kiln' };

function blog(featuredImage?: string): ProjectState {
  const s = run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_kiln', title: 'Opening the kiln', publishedAt: '2026-05-01' }
  );
  // Only the post's own field is read: the image need not be in the library for this check.
  if (featuredImage) s.collections.posts.entries.en_kiln.featuredImage = featuredImage;
  return s;
}

describe('postHolds', () => {
  it('holds when the post already has the image asked for', () => {
    expect(postHolds(blog('as_glaze'), ref, { featuredImage: 'as_glaze' })).toBe(true);
  });

  it('does not hold when the image was changed or removed meanwhile', () => {
    expect(postHolds(blog('as_kiln'), ref, { featuredImage: 'as_glaze' })).toBe(false);
    expect(postHolds(blog(), ref, { featuredImage: 'as_glaze' })).toBe(false);
  });

  it('treats an empty field as none', () => {
    expect(postHolds(blog(), ref, { featuredImage: null })).toBe(true);
    expect(postHolds(blog('as_glaze'), ref, { featuredImage: null })).toBe(false);
  });

  it('needs every field asked for, and the post itself', () => {
    expect(postHolds(blog('as_glaze'), ref, { featuredImage: 'as_glaze', title: 'Opening the kiln' })).toBe(true);
    expect(postHolds(blog('as_glaze'), ref, { featuredImage: 'as_glaze', title: 'Closing the kiln' })).toBe(false);
    expect(postHolds(blog('as_glaze'), { collectionId: 'posts', entryId: 'en_gone' }, { featuredImage: 'as_glaze' })).toBe(false);
  });
});
