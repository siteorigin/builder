/**
 * A synced record's featured image description (#1419): the description a source maps to an entry's featured image
 * reaches the published picture and the page's sharing image tags, stays the entry's own when another entry shows the
 * same file, follows a source edit of the description alone, and gives way to the library's suggested alt text only
 * when the record gives none.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateEntry } from '@generator/index';
import { planSourceSync, syncedEntryId, syncOperations } from '../../src/main/sources/reconcile';
import type { NormalizedRecord } from '../../src/main/sources/protocol';
import { image } from './fixtures/seo-site';

const AT = '2026-11-20T10:00:00.000Z';
const LATER = '2026-11-21T10:00:00.000Z';
const HARBOUR = 'https://feed.example/photos/harbour.jpg';

/** A blank site with a public URL and a posts collection synced from a feed, the harbour photo already in the library. */
function project(altSuggestion?: string): ProjectState {
  let s = createStarterState('blank', 'Harbour News', false);
  s.assets.assets.img_harbour = image('img_harbour', altSuggestion ? { altSuggestion } : {});
  s = applyOperations(s, [
    { type: 'site.update', baseUrl: 'https://news.example' },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'source.upsert', sourceId: 'feed', name: 'Feed', adapter: 'fixture', collectionId: 'posts', config: {} }
  ] as EditOperation[]).state;
  return s;
}

const story = (id: string, alt: string | undefined, extra: Partial<NormalizedRecord> = {}): NormalizedRecord => ({
  externalId: id,
  title: `Story ${id}`,
  slug: `story-${id}`,
  publishedAt: '2026-11-01',
  featuredImage: { $image: { url: HARBOUR, ...(alt !== undefined ? { alt } : {}) } },
  ...extra
});

/** One sync of `records`, as the session lands it, with the harbour photo brought in as img_harbour. */
function sync(s: ProjectState, records: NormalizedRecord[], at = AT): ProjectState {
  const source = s.sources!.feed;
  const plan = planSourceSync(s, source, records, at);
  const ops = syncOperations(plan, s, new Map([[`url:${HARBOUR}`, 'img_harbour']]));
  return applyOperations(s, ops, { sourceSync: { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance } }).state;
}

const entryId = (externalId: string) => syncedEntryId('feed', externalId, () => false);

const STRING = '("(?:[^"\\\\]|\\\\.)*")';
const read = (svelte: string, pattern: string): string | undefined => {
  const m = new RegExp(pattern).exec(svelte)?.[1];
  return m === undefined ? undefined : (JSON.parse(m) as string);
};

/** The exported page of a synced story: its featured picture's alt, and its Open Graph and Twitter image alt. */
function exported(s: ProjectState, externalId: string) {
  const svelte = generateEntry(s, 'posts', entryId(externalId));
  return {
    svelte,
    picture: read(svelte, `<SoImage image=\\{\\{"src":"/assets/img_harbour-[^"]*","alt":${STRING}`),
    og: read(svelte, `<meta property="og:image:alt" content=\\{${STRING}\\} />`),
    twitter: read(svelte, `<meta name="twitter:image:alt" content=\\{${STRING}\\} />`)
  };
}

describe('a synced featured image description', () => {
  it('reaches the published picture and both sharing image tags, each story keeping its own on one shared file', () => {
    const s = sync(project(), [story('1', 'Fishing boats moored in the harbour at dawn'), story('2', 'قوارب صيد راسية في الميناء عند الفجر')]);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const boats = 'Fishing boats moored in the harbour at dawn';
    const arabic = 'قوارب صيد راسية في الميناء عند الفجر';
    expect(exported(s, '1')).toMatchObject({ picture: boats, og: boats, twitter: boats });
    expect(exported(s, '2')).toMatchObject({ picture: arabic, og: arabic, twitter: arabic });
    expect(exported(s, '2').svelte).not.toContain('Fishing boats');
  });

  it('follows a source edit of the description alone, and gives way to the library suggestion once the record drops it', () => {
    const first = sync(project('The harbour'), [story('1', 'Boats at dawn')]);
    // The story's own words, over the library's suggestion for the file.
    expect(exported(first, '1')).toMatchObject({ picture: 'Boats at dawn', og: 'Boats at dawn', twitter: 'Boats at dawn' });
    const edited = sync(first, [story('1', 'Boats at first light')], LATER);
    expect(exported(edited, '1')).toMatchObject({ picture: 'Boats at first light', og: 'Boats at first light', twitter: 'Boats at first light' });
    expect(exported(edited, '1').svelte).not.toContain('Boats at dawn');
    // Nothing of its own: the library's suggestion for the file, as for any featured image.
    const dropped = sync(edited, [story('1', undefined)], '2026-11-22T10:00:00.000Z');
    expect(exported(dropped, '1')).toMatchObject({ picture: 'The harbour', og: 'The harbour', twitter: 'The harbour' });
    expect(exported(dropped, '1').svelte).not.toContain('Boats at first light');
  });
});
