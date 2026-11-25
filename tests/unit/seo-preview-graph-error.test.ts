/**
 * A structured data graph that can't be worked out (a feature's contribution refused, #586) is said as an error in the
 * Search & sharing preview (#597), beside the publishing status, rather than breaking the panel.
 */
import { describe, expect, it, vi } from 'vitest';
import { structuredPreview } from '../../src/renderer/src/lib/seo-preview';
import { seoSite } from './fixtures/seo-site';

const failing = vi.hoisted(() => ({ on: true }));
vi.mock('@generator/structured-data', async (original) => {
  const real = await original<typeof import('@generator/structured-data')>();
  return {
    ...real,
    documentGraph: (...args: Parameters<typeof real.documentGraph>) => {
      if (failing.on) throw new Error('Graph contributor 2 added https://example.com/studio/#webpage, which the graph already has: extend it instead.');
      return real.documentGraph(...args);
    }
  };
});

describe('structuredPreview with a graph that fails', () => {
  it('says why, keeps the status, and shows the graph again once it can be worked out', () => {
    const { state } = seoSite();
    failing.on = true;
    const broken = structuredPreview(state, { kind: 'page', pageId: 'pg_services' })!;
    expect(broken.graph).toEqual({ kind: 'error', message: expect.stringMatching(/^Graph contributor 2 added/) });
    expect(broken.status.find((l) => l.id === 'structured')).toMatchObject({ on: true });
    failing.on = false;
    expect(structuredPreview(state, { kind: 'page', pageId: 'pg_services' })!.graph.kind).toBe('graph');
  });
});
