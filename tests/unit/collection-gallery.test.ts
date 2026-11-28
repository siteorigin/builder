/**
 * Gallery fields (#1320): a structured collection's entries each hold an ordered list of library photos, each with its
 * own description and caption. Entries write them as one value, layouts show them in a Gallery or Carousel (the
 * ready-made one in a Gallery of its own), and Assets and exports count every photo.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AssetRecord, GalleryItem, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { MAX_GALLERY_PHOTOS } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, assetUsages } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { isDefaultLayout } from '@engine/collection-layouts';
import { generateProject, publishedState } from '@generator/index';
import { entryFieldSchema, entryFieldValue } from '@shared/entry-fields';
import { galleryFitProblem, galleryListProp } from '@shared/gallery-field';
import { imageUseRows } from '../../src/renderer/src/lib/asset-uses';
import { editGallery } from '../../src/renderer/src/lib/gallery-value';
import { publishedGalleryFiles } from '../../src/main/export';
import { mappingFieldsProblem } from '../../src/main/sources/mapping';
import { executeTool, type ToolHost } from '@agent/tools';
import { checkAuthority } from '@agent/scope';
import { collectionGrantRefusal } from '@shared/collection-grant';
import { removeRendered, serverHtml } from './generated-site';

afterAll(removeRendered);

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const LISTINGS: OwnerRef = { kind: 'template', id: 'listings' };

const image = (id: string, name: string, altSuggestion?: string): AssetRecord => ({
  id,
  name,
  file: `static/assets/${id.slice(2)}-1a2b3c4d.jpg`,
  mime: 'image/jpeg',
  bytes: 10,
  hash: `hash-${id}`,
  kind: 'image',
  width: 1200,
  height: 800,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...(altSuggestion !== undefined ? { altSuggestion } : {})
});

/** A listings collection with a gallery, two published listings and a draft, and three library pictures. */
function agency() {
  return run(
    createStarterState('business', 'Harbour Homes', false),
    { type: 'asset.add', asset: image('a_front', 'Front', 'The house from the street') },
    { type: 'asset.add', asset: image('a_garden', 'Garden') },
    { type: 'asset.add', asset: image('a_kitchen', 'Kitchen') },
    { type: 'asset.add', asset: { ...image('a_brochure', 'Brochure'), kind: 'document', mime: 'application/pdf', file: 'static/assets/brochure-1a2b3c4d.pdf' } },
    { type: 'collection.create', collectionId: 'listings', kind: 'structured', singularName: 'Listing', route: '/homes/', fields: { price: { type: 'string', label: 'Price' }, photos: { type: 'gallery', label: 'Photos' } } },
    {
      type: 'entry.create',
      collectionId: 'listings',
      entryId: 'en_harbour',
      title: 'Harbour View',
      draft: false,
      values: {
        photos: [
          { id: 'i_front', image: 'a_front', caption: 'Street elevation' },
          { id: 'i_again', image: { assetId: 'a_front', alt: 'The original entrance' }, caption: 'Original entrance' },
          { id: 'i_garden', image: { assetId: 'a_garden', alt: 'The back garden in spring' } }
        ]
      }
    },
    { type: 'entry.create', collectionId: 'listings', entryId: 'en_mill', title: 'Mill Cottage', draft: false },
    { type: 'entry.create', collectionId: 'listings', entryId: 'en_draft', title: 'Coming soon', values: { photos: [{ image: 'a_kitchen' }] } }
  );
}

const photos = (s: ProjectState, entryId = 'en_harbour') => s.collections.listings.entries[entryId].values.photos as GalleryItem[];

function refusal(s: ProjectState, ...ops: EditOperation[]): string {
  try {
    applyOperations(s, ops);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the change to be refused.');
}

describe('a gallery field and its values', () => {
  it('stores each photo in order with its own ID, description and caption, the same picture twice if asked', () => {
    const s = agency();
    expect(s.collections.listings.settings.fields!.photos).toEqual({ type: 'gallery', label: 'Photos', default: [] });
    expect(photos(s)).toEqual([
      // An asset ID alone takes the library's suggestion as its description, as a picture field's does.
      { id: 'i_front', image: { assetId: 'a_front', alt: 'The house from the street' }, caption: 'Street elevation' },
      { id: 'i_again', image: { assetId: 'a_front', alt: 'The original entrance' }, caption: 'Original entrance' },
      { id: 'i_garden', image: { assetId: 'a_garden', alt: 'The back garden in spring' }, caption: '' }
    ]);
    // A photo sent without an ID is given one of its own.
    expect(photos(s, 'en_draft')[0].id).toMatch(/^i_[a-z0-9]{8}$/);
    expect(errors(s)).toEqual([]);
  });

  it('moves and edits photos by their IDs, so each keeps its own words', () => {
    let s = agency();
    const [front, again, garden] = photos(s);
    s = run(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_harbour', values: { photos: [garden, { ...again, caption: 'Entrance, 1920' }, front] } });
    expect(photos(s).map((p) => [p.id, p.caption])).toEqual([
      ['i_garden', ''],
      ['i_again', 'Entrance, 1920'],
      ['i_front', 'Street elevation']
    ]);
    // [] empties it; null goes back to the field's default, which is no photo.
    expect(photos(run(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_harbour', values: { photos: [] } }))).toEqual([]);
    expect(run(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_harbour', values: { photos: null } }).collections.listings.entries.en_harbour.values).not.toHaveProperty('photos');
  });

  it('refuses a photo without a picture, a picture the library lacks or that is no picture, one photo twice, and too many', () => {
    const s = agency();
    const set = (v: unknown) => refusal(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_mill', values: { photos: v } });
    expect(set([{ caption: 'Nothing' }])).toMatch(/Photo 1: choose its picture from Assets/);
    expect(set([{ image: { assetId: null, alt: '' } }])).toMatch(/choose its picture/);
    expect(set([{ image: 'a_gone' }])).toMatch(/asset "a_gone" does not exist/);
    expect(set([{ image: 'a_brochure' }])).toMatch(/"Brochure" is not an image/);
    expect(set([{ id: 'i_one', image: 'a_front' }, { id: 'i_one', image: 'a_garden' }])).toMatch(/Photo 2: the photo "i_one" is in the gallery twice/);
    expect(set([{ image: 'a_front', link: '/' }])).toMatch(/not "link"/);
    expect(set([{ image: 'a_front', caption: 'x'.repeat(301) }])).toMatch(/caption/);
    expect(set('a_front')).toMatch(/expected a list of photos/);
    expect(set(Array.from({ length: MAX_GALLERY_PHOTOS + 1 }, () => ({ image: 'a_front' })))).toMatch(/at most 24 photos/);
    // Which photos it shows is each entry's own: no default to follow every new entry.
    expect(refusal(s, { type: 'collection.update', collectionId: 'listings', fields: { photos: { type: 'gallery', label: 'Photos', default: [{ image: 'a_front' }] } } })).toMatch(/its default is \[\]/);
  });

  it('keeps a filled image field from turning into a gallery, and a filled gallery from turning into anything else', () => {
    let s = run(agency(), { type: 'collection.update', collectionId: 'listings', fields: { price: { type: 'string', label: 'Price' }, photos: { type: 'gallery', label: 'Photos' }, hero: { type: 'image', label: 'Hero' } } });
    s = run(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_mill', values: { hero: 'a_garden' } });
    expect(refusal(s, { type: 'collection.update', collectionId: 'listings', fields: { price: { type: 'string', label: 'Price' }, photos: { type: 'gallery', label: 'Photos' }, hero: { type: 'gallery', label: 'Hero' } } })).toMatch(/would not keep as it is/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'listings', fields: { price: { type: 'string', label: 'Price' }, photos: { type: 'image', label: 'Photos' }, hero: { type: 'image', label: 'Hero' } } })).toMatch(/Photos|would not keep/);
  });

  it('reports a damaged gallery from disk, and a photo whose picture is gone, without hiding the photos that still show', () => {
    const s = agency();
    const hand = structuredClone(s);
    hand.collections.listings.entries.en_harbour.values.photos = [...photos(s), { id: 'i_lost', image: { assetId: 'a_lost', alt: '' }, caption: '' }, { image: 'a_front' }] as never;
    const found = validateState(hand).filter((d) => d.owner?.kind === 'entry' && d.owner.id === 'en_harbour');
    expect(found.map((d) => d.code).sort()).toEqual(['ASSET_MISSING', 'FIELD_VALUE_INVALID']);
    const read = { state: hand, collection: hand.collections.listings, entry: hand.collections.listings.entries.en_harbour, neighbours: {} };
    expect((entryFieldValue(read, 'field.photos') as GalleryItem[]).map((p) => p.id)).toEqual(['i_front', 'i_again', 'i_garden']);
  });
});

describe('a layout showing the photos', () => {
  it('reads the field as a list of photos, each with its picture (the library\'s words for one without its own) and caption', () => {
    const s = agency();
    const collection = s.collections.listings;
    expect(entryFieldSchema(collection, 'field.photos')).toEqual(galleryListProp({ label: 'Photos' }));
    const hand = structuredClone(s);
    hand.collections.listings.entries.en_harbour.values.photos = [{ id: 'i_front', image: { assetId: 'a_front', alt: '' }, caption: ' Front ' }];
    const read = { state: hand, collection: hand.collections.listings, entry: hand.collections.listings.entries.en_harbour, neighbours: {} };
    expect(entryFieldValue(read, 'field.photos')).toEqual([{ id: 'i_front', image: { assetId: 'a_front', alt: 'The house from the street' }, caption: 'Front' }]);
  });

  it('starts the ready-made layout with a Gallery showing the photos, hidden on a listing with none, and installs it', () => {
    const s = agency();
    const tree = s.collections.listings.settings.template;
    const band = Object.values(tree.nodes).find((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === 'foundation.media.gallery')!;
    expect(band).toMatchObject({ name: 'Photos', props: { eyebrow: '', heading: 'Photos', images: { $entry: 'field.photos' } }, when: { $entry: 'field.photos' } });
    expect(tree.rootIds.at(-1)).toBe(band.id);
    expect(s.components['foundation.media.gallery']).toBeDefined();
    expect(isDefaultLayout(s, s.collections.listings.settings)).toBe(true);
    // The gallery is no fact in the details list.
    expect(Object.values(tree.nodes).some((n) => n.kind === 'text' && JSON.stringify(n.text) === JSON.stringify({ $entry: 'field.photos' }))).toBe(false);
    expect(errors(s)).toEqual([]);
  });

  it('shows every photo in order on the listing\'s page, with its own words, and nothing for a listing without any', async () => {
    const s = agency();
    const files = generateProject(publishedState(s));
    const html = await serverHtml(files, 'entry-gallery-', 'src/routes/homes/harbour-view/+page.svelte');
    const alts = [...html.matchAll(/<img[^>]*alt="([^"]*)"/g)].map((m) => m[1]);
    expect(alts).toEqual(expect.arrayContaining(['The house from the street', 'The original entrance', 'The back garden in spring']));
    expect(html.indexOf('Street elevation')).toBeLessThan(html.indexOf('Original entrance'));
    expect(html).toContain('front-1a2b3c4d.jpg');
    expect(html).toContain('garden-1a2b3c4d.jpg');
    const empty = await serverHtml(files, 'entry-gallery-', 'src/routes/homes/mill-cottage/+page.svelte');
    expect(empty).not.toContain('gallery__grid');
    expect(empty).not.toContain('>Photos<');
  });

  it('binds a placed Carousel to the field, and refuses a list that has no picture for each photo', async () => {
    let s = agency();
    const r = applyOperations(s, [{ type: 'node.insert', owner: LISTINGS, parentId: null, componentId: 'media.carousel' }]);
    s = r.state;
    const carousel = r.results[0].nodeId as string;
    s = run(s, { type: 'node.setBinding', owner: LISTINGS, nodeId: carousel, field: 'prop', prop: 'slides', binding: { $entry: 'field.photos' } });
    expect(errors(s)).toEqual([]);
    const html = await serverHtml(generateProject(publishedState(s)), 'entry-gallery-', 'src/routes/homes/harbour-view/+page.svelte');
    expect(html.match(/kitchen-1a2b3c4d/g)).toBeNull();
    expect(html.match(/garden-1a2b3c4d/g)!.length).toBeGreaterThanOrEqual(2);
    // A list with no picture per item cannot show photos; nor can a field be bound to a list of another kind.
    const f = applyOperations(s, [{ type: 'node.insert', owner: LISTINGS, parentId: null, componentId: 'faq.list' }]);
    const faq = f.results[0].nodeId as string;
    const list = Object.entries(f.state.components[(f.state.collections.listings.settings.template.nodes[faq] as InstanceNode).definitionId].properties).find(([, p]) => p.type === 'list')![0];
    expect(refusal(f.state, { type: 'node.setBinding', owner: LISTINGS, nodeId: faq, field: 'prop', prop: list, binding: { $entry: 'field.photos' } })).toMatch(/has no picture \(“image”\) for each photo/);
    expect(refusal(s, { type: 'node.setBinding', owner: LISTINGS, nodeId: carousel, field: 'prop', prop: 'slides', binding: { $entry: 'field.price' } })).toMatch(/needs a list field/);
  });

  it('judges a list by its fields: a picture called image, and the caption and picture of the kinds a photo has', () => {
    const from = galleryListProp({ label: 'Photos' });
    const list = (fields: Record<string, unknown>) => ({ type: 'list', label: 'Slides', itemLabel: 'Slide', fields, default: [] }) as never;
    expect(galleryFitProblem(from, list({ image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } }, link: { type: 'link', label: 'Link', default: { type: 'none', target: '' } } }))).toBeNull();
    expect(galleryFitProblem(from, list({ photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } } }))).toMatch(/no picture/);
    expect(galleryFitProblem(from, list({ image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } }, caption: { type: 'richtext', label: 'Caption', default: [] } }))).toMatch(/“caption” that is a richtext/);
    expect(galleryFitProblem(from, { ...list({ image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } } }), feed: 'pages' })).toMatch(/fills itself/);
  });
});

describe('Assets and exports count every photo', () => {
  it('counts each photo as a use, drafts included, so a picture in a gallery cannot be removed', () => {
    const s = agency();
    const uses = assetUsages(s);
    expect(uses.a_front).toBe(2);
    expect(uses.a_garden).toBe(1);
    expect(uses.a_kitchen).toBe(1);
    expect(refusal(s, { type: 'asset.remove', assetId: 'a_kitchen' })).toMatch(/in use|used/i);
  });

  it('lists each photo in Assets by its listing and place, and keeps the row as the gallery is reordered', () => {
    let s = agency();
    const rows = imageUseRows(s, 'a_front');
    expect(rows.map((r) => [r.where, r.what])).toEqual([
      ['Harbour View', 'Photos: photo 1'],
      ['Harbour View', 'Photos: photo 2']
    ]);
    expect(rows[0].post).toEqual({ collectionId: 'listings', entryId: 'en_harbour' });
    const [front, again, garden] = photos(s);
    s = run(s, { type: 'entry.update', collectionId: 'listings', entryId: 'en_harbour', values: { photos: [again, garden, front] } });
    const moved = imageUseRows(s, 'a_front');
    expect(new Set(moved.map((r) => r.key))).toEqual(new Set(rows.map((r) => r.key)));
  });

  it('replaces a picture everywhere in each photo, keeping its ID, place, caption and own description', () => {
    const s = run(agency(), { type: 'asset.add', asset: image('a_new', 'New front', 'The house, repainted') }, { type: 'asset.replace', assetId: 'a_front', withAssetId: 'a_new' });
    expect(photos(s).slice(0, 2)).toEqual([
      // The library's old suggestion follows the new picture; the photo's own words stay.
      { id: 'i_front', image: { assetId: 'a_new', alt: 'The house, repainted' }, caption: 'Street elevation' },
      { id: 'i_again', image: { assetId: 'a_new', alt: 'The original entrance' }, caption: 'Original entrance' }
    ]);
    expect(assetUsages(s).a_front ?? 0).toBe(0);
  });

  it('keeps the original of every published listing\'s photo in the website, and none of a draft\'s', () => {
    const s = agency();
    expect([...publishedGalleryFiles(s)].sort()).toEqual(['static/assets/front-1a2b3c4d.jpg', 'static/assets/garden-1a2b3c4d.jpg']);
  });

  it('leaves a gallery out of what a sync fills in', () => {
    expect(mappingFieldsProblem({ externalId: 'id', title: 'title', values: { photos: 'images' } } as never, { photos: 'gallery' } as never)).toMatch(/gallery of library photos/);
  });
});

describe('the Content writer\'s gallery edits', () => {
  const rows: GalleryItem[] = [
    { id: 'i_a', image: { assetId: 'a_front', alt: '' }, caption: 'One' },
    { id: 'i_b', image: { assetId: 'a_garden', alt: 'Garden' }, caption: '' }
  ];
  const assets = { a_front: { id: 'a_front', kind: 'image' as const }, a_garden: { id: 'a_garden', kind: 'image' as const }, a_doc: { id: 'a_doc', kind: 'document' as const } };
  let n = 0;
  const makeId = () => `i_new${n++}`;

  it('adds chosen pictures at the end in the order chosen, each a new photo with the library\'s words', () => {
    expect(editGallery(rows, { kind: 'pick', assetIds: ['a_garden', 'a_front'] }, assets, makeId)).toEqual({
      rows: [...rows, { id: 'i_new0', image: { assetId: 'a_garden', alt: '' }, caption: '' }, { id: 'i_new1', image: { assetId: 'a_front', alt: '' }, caption: '' }],
      added: ['i_new0', 'i_new1']
    });
    expect(editGallery(rows, { kind: 'pick', assetIds: ['a_doc'] }, assets, makeId)).toBeNull();
    expect(editGallery(Array.from({ length: MAX_GALLERY_PHOTOS }, (_, i) => ({ ...rows[0], id: `i_${i}` })), { kind: 'pick', assetIds: ['a_front'] }, assets, makeId)).toBeNull();
  });

  it('moves, removes and edits the photo it names, and leaves the rest as they are', () => {
    expect(editGallery(rows, { kind: 'move', itemId: 'i_b', index: 0 }, assets)?.rows.map((r) => r.id)).toEqual(['i_b', 'i_a']);
    expect(editGallery(rows, { kind: 'remove', itemId: 'i_a' }, assets)?.rows).toEqual([rows[1]]);
    expect(editGallery(rows, { kind: 'field', itemId: 'i_b', field: 'caption', value: 'Spring' }, assets)?.rows[1]).toEqual({ ...rows[1], caption: 'Spring' });
    expect(editGallery(rows, { kind: 'field', itemId: 'i_a', field: 'image', value: { assetId: 'a_front', alt: 'Front door', decorative: false } }, assets)?.rows[0].image).toEqual({ assetId: 'a_front', alt: 'Front door' });
    // A photo always has its picture, and an edit of one that is gone changes nothing.
    expect(editGallery(rows, { kind: 'field', itemId: 'i_a', field: 'image', value: { assetId: null, alt: '' } }, assets)).toBeNull();
    expect(editGallery(rows, { kind: 'remove', itemId: 'i_gone' }, assets)).toBeNull();
    expect(editGallery(rows, { kind: 'move', itemId: 'i_a', index: 0 }, assets)).toBeNull();
  });
});

describe('the assistant\'s gallery values', () => {
  function host(start: ProjectState) {
    let state = start;
    let revision = 1;
    const h: ToolHost = {
      state: () => state,
      revision: () => revision,
      diagnostics: () => [],
      apply: async (ops, expected, _label, _key, grant) => {
        if (expected !== revision) return { ok: false, revision, error: { code: 'STALE_REVISION', message: 'stale', recoverable: true } };
        const denied = checkAuthority(state, ops, { kind: 'site' }, grant) ?? (grant?.collectionWrite ? collectionGrantRefusal(ops, grant.collectionWrite) : 'no grant');
        if (denied) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: denied, recoverable: true } };
        try {
          state = applyOperations(state, ops).state;
          revision++;
          return { ok: true, revision, results: [] };
        } catch (e) {
          return { ok: false, revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
        }
      },
      compileAll: async () => [],
      inspectLayout: async () => ({}),
      ask: async () => '',
      entryLimit: () => null
    };
    return { h, now: () => state };
  }
  const tool = (h: ToolHost, name: string, args: unknown) => executeTool(name, JSON.stringify(args), h, `call_${name}`);

  it('reads every photo with its ID, and writes them back reordered with a new one, keeping each photo\'s own words', async () => {
    const { h, now } = host(agency());
    const read = await tool(h, 'read_collection_entry', { collectionId: 'listings', entryId: 'en_harbour' });
    expect(read.ok).toBe(true);
    const shown = read.content as unknown as { values: Array<{ field: string; value: unknown }> };
    const photosRead = shown.values.find((v) => v.field === 'photos')!.value as Array<{ id: string; assetId: string; alt?: string; caption?: string }>;
    expect(photosRead.map((p) => p.id)).toEqual(['i_front', 'i_again', 'i_garden']);
    expect(photosRead[1]).toEqual({ id: 'i_again', assetId: 'a_front', alt: 'The original entrance', caption: 'Original entrance' });
    const write = await tool(h, 'upsert_collection_entry', {
      collectionId: 'listings',
      entryId: 'en_harbour',
      values: [{ field: 'photos', value: [{ id: 'i_garden', assetId: 'a_garden' }, { id: 'i_again', assetId: 'a_front', caption: 'Entrance' }, { assetId: 'a_kitchen', caption: 'Kitchen' }] }]
    });
    expect(write.ok).toBe(true);
    const after = photos(now());
    expect(after.map((p) => [p.id.startsWith('i_') ? (p.id.length > 8 ? 'new' : p.id) : p.id, p.image.alt, p.caption])).toEqual([
      ['i_garden', 'The back garden in spring', ''],
      ['i_again', 'The original entrance', 'Entrance'],
      ['new', '', 'Kitchen']
    ]);
  });

  it('defines a gallery field and refuses a value of the wrong shape', async () => {
    const { h, now } = host(agency());
    const made = await tool(h, 'define_collection', { action: 'update', collectionId: 'listings', fields: [{ name: 'plans', type: 'gallery', label: 'Floor plans' }] });
    expect(made.ok).toBe(true);
    expect(now().collections.listings.settings.fields!.plans).toEqual({ type: 'gallery', label: 'Floor plans', default: [] });
    const wrong = await tool(h, 'upsert_collection_entry', { collectionId: 'listings', entryId: 'en_mill', values: [{ field: 'plans', value: 'a_front' }] });
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).toMatch(/gallery field: send every photo in order/);
  });
});
