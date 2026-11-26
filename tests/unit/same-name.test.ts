/** Images that share a name are told apart by what an author can see of them, never by their asset IDs (issue #894). */
import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '@shared/types';
import { sameNameLabels } from '../../src/renderer/src/lib/same-name';

const image = (id: string, name: string, bytes: number, createdAt: string): AssetRecord => ({ id, name, file: `static/so-assets/${id}.jpg`, mime: 'image/jpeg', bytes, hash: id, kind: 'image', createdAt });
const key = (a: AssetRecord) => (a.name.trim() || 'Untitled image').toLowerCase();

describe('telling apart images with the same name', () => {
  it('names only the facts that differ: size, the day added, and the places that use each', () => {
    const a = image('a_1r6vtfw1', 'Hero', 1_600_000, '2026-11-03T10:00:00.000Z');
    const b = image('a_2x', 'hero', 240_000, '2026-11-20T10:00:00.000Z');
    const labels = sameNameLabels([a, b, image('a_3', 'Team', 1000, '2026-11-03T10:00:00.000Z')], { a_1r6vtfw1: 2 }, key);
    expect(labels.get('a_1r6vtfw1')).toBe('1.5 MB · added 3 Nov 2026 · used in 2 places');
    expect(labels.get('a_2x')).toBe('234 KB · added 20 Nov 2026 · not used');
    // An image whose name no other has needs nothing.
    expect(labels.has('a_3')).toBe(false);
    for (const label of labels.values()) expect(label).not.toMatch(/a_/);
  });

  it('leaves out what they have in common', () => {
    const at = '2026-11-03T10:00:00.000Z';
    const labels = sameNameLabels([image('a_1', 'Hero', 1_600_000, at), image('a_2', 'Hero', 240_000, at)], {}, key);
    expect([labels.get('a_1'), labels.get('a_2')]).toEqual(['1.5 MB', '234 KB']);
  });

  it('numbers images alike in every way in the order they were added', () => {
    const at = '2026-11-03T10:00:00.000Z';
    const labels = sameNameLabels([image('a_z', 'Hero', 6000, '2026-11-03T11:00:00.000Z'), image('a_y', 'Hero', 6000, at), image('a_x', 'Hero', 90_000, at)], {}, key);
    expect(labels.get('a_y')).toBe('6 KB · image 2 of 3');
    expect(labels.get('a_z')).toBe('6 KB · image 3 of 3');
    expect(labels.get('a_x')).toBe('88 KB');
  });

  it('numbers an image whose only difference is a time that cannot be read', () => {
    const labels = sameNameLabels([image('a_1', 'Hero', 6000, '2026-11-03T10:00:00.000Z'), image('a_2', 'Hero', 6000, 'not a time')], { a_1: 1, a_2: 1 }, key);
    expect(labels.get('a_1')).toBe('added 3 Nov 2026');
    expect(labels.get('a_2')).toBe('image 1 of 2');
  });

  it('orders by the time itself, whatever offset it was written with', () => {
    const labels = sameNameLabels([image('a_1', 'Hero', 6000, '2026-11-03T10:00:00.000+02:00'), image('a_2', 'Hero', 6000, '2026-11-03T09:00:00.000Z')], { a_1: 1, a_2: 1 }, key);
    expect([labels.get('a_1'), labels.get('a_2')]).toEqual(['image 1 of 2', 'image 2 of 2']);
  });
});
