import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, InstanceNode, ListItem, ListProp, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { gallery } from '@catalogue/foundation/content';
import { team } from '@catalogue/foundation/people';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';
import { mergeChoice, movePick, overNote, pickAnnouncement, pickedImage, pickImagesField, pickLabel, pickOperations, pickRoom, planChoice, planPicks, sampleRows, startingSamples, togglePick, type PickStep } from '../../src/renderer/src/lib/gallery-picks';

/** Issue #60: build a gallery by choosing several library images in one pass. */

const images = gallery.properties.images as ListProp;
/** The six rows a Gallery used to start with, as a project made then still holds them. */
const EARLIER = ['Garden room, Ashford', 'Kitchen, Millbrook', 'Studio, Harbour Lane', 'Living room, Westfield', 'Library, Old Mill', 'Courtyard, Elm Street'].map((caption, i) => ({ id: `i_old${i}`, image: { assetId: null, alt: '' }, caption }));
/** The installed copy of the component a project made then still has. */
const earlierSchema: ListProp = { ...images, default: EARLIER.map((r, i) => ({ ...r, id: `item-${i + 1}` })) };

const asset = (n: number, extra: Partial<AssetRecord> = {}): AssetRecord => ({ id: `img_p${n}`, name: `swatch-${n}.png`, file: `static/assets/swatch-${n}.png`, mime: 'image/png', bytes: 10, width: 800, height: 600, hash: `h${n}`, kind: 'image', createdAt: '2026-01-01T00:00:00Z', ...extra });

function blankWithGallery(rows?: Array<Record<string, unknown>>) {
  const state = createStarterState('blank', 'Test', false);
  const home = state.site.homePageId;
  const owner: OwnerRef = { kind: 'page', id: home };
  const library = Array.from({ length: 30 }, (_, i) => asset(i + 1, i === 0 ? { altSuggestion: 'A grey swatch' } : {}));
  const ops: EditOperation[] = [...library.map((a) => ({ type: 'asset.add', asset: a }) as EditOperation), { type: 'node.insert', owner, parentId: null, componentId: 'media.gallery', ...(rows ? { props: { images: rows } } : {}) }];
  const r = applyOperations(state, ops);
  const next = r.state;
  const node = Object.values(next.pages[home].nodes).find((n): n is InstanceNode => n.kind === 'instance' && next.components[n.definitionId]?.componentId === 'media.gallery')!;
  return { state: next, owner, nodeId: node.id, library, rows: (s: ProjectState) => (s.pages[home].nodes[node.id] as InstanceNode).props.images as ListItem[] };
}

const toOps = (owner: OwnerRef, nodeId: string, steps: PickStep[]): EditOperation[] => pickOperations(owner, nodeId, 'images', steps);

describe('a new gallery', () => {
  it('starts empty, with no invented rows (the page it renders is checked in foundation-html.test.ts)', () => {
    const { state, rows } = blankWithGallery();
    expect(rows(state)).toEqual([]);
    expect(images.default).toEqual([]);
  });

  it('takes several images only for its own image list, and keeps the action in a copy made unique', () => {
    expect(pickImagesField({ componentId: 'media.gallery' }, 'images', images)).toBe('image');
    expect(pickImagesField({ componentId: 'media.gallery' }, 'heading', gallery.properties.heading)).toBeNull();
    expect(pickImagesField({ componentId: 'team.grid' }, 'people', team.properties.people)).toBeNull();
    expect(pickImagesField(undefined, 'images', images)).toBeNull();
    expect(pickImagesField({ componentId: 'project.our-work', provenance: { componentId: 'media.gallery', forkedFrom: 'foundation.media.gallery' } }, 'images', images)).toBe('image');
    expect(pickImagesField({ componentId: 'project.our-work', provenance: { componentId: 'team.grid' } }, 'images', images)).toBeNull();
    // A copy whose list no longer holds an image in that field has nothing to put chosen images in.
    const textOnly: ListProp = { ...images, fields: { ...images.fields, image: { type: 'string', label: 'Image', default: '' } } };
    expect(pickImagesField({ componentId: 'media.gallery' }, 'images', textOnly)).toBeNull();
  });
});

describe('sample rows', () => {
  it('recognises the six earlier samples, by their content and not their IDs', () => {
    expect(sampleRows(earlierSchema, EARLIER)).toEqual(EARLIER.map((r) => r.id));
    // After the theme refresh the component starts empty, and the old rows are still samples.
    expect(sampleRows(images, EARLIER)).toEqual(EARLIER.map((r) => r.id));
  });

  it('keeps every row the author has touched', () => {
    const rows: ListItem[] = [
      { ...EARLIER[0], caption: 'Garden room, Ashford (2024)' },
      { ...EARLIER[1], image: { assetId: null, alt: 'A kitchen' } },
      { ...EARLIER[2], image: { assetId: 'img_p1', alt: '' } },
      { ...EARLIER[3], image: { assetId: null, alt: '', decorative: true } },
      { id: 'i_blank', image: { assetId: null, alt: '' }, caption: '' },
      EARLIER[4]
    ];
    expect(sampleRows(images, rows)).toEqual([EARLIER[4].id]);
  });

  it('counts a duplicated sample once', () => {
    expect(sampleRows(images, [EARLIER[0], { ...EARLIER[0], id: 'i_copy' }])).toEqual([EARLIER[0].id]);
  });

  it('reads a stored sample however its image was written, and the component’s own starting rows too', () => {
    const stored: ListItem = { caption: 'Studio, Harbour Lane', id: 'i_s', image: { alt: '', decorative: false, assetId: null } };
    expect(sampleRows(images, [stored])).toEqual(['i_s']);
    const own: ListProp = { ...images, default: [{ id: 'item-1', image: { assetId: null, alt: '' }, caption: 'Workshop, Quayside' }] };
    const row: ListItem = { id: 'i_w', image: { assetId: null, alt: '' }, caption: 'Workshop, Quayside' };
    expect(sampleRows(own, [row])).toEqual(['i_w']);
    expect(sampleRows(images, [row])).toEqual([]);
  });
});

describe('samples and what a gallery item can do when clicked', () => {
  it('matches earlier samples stored with or without the click settings, and never an item set to open something', () => {
    expect(Object.keys(images.fields)).toEqual(expect.arrayContaining(['image', 'caption', 'action', 'link']));
    const normalized = EARLIER.map((r) => ({ ...r, action: 'none', link: { target: '', type: 'none' } }));
    expect(sampleRows(images, normalized)).toEqual(normalized.map((r) => r.id));
    expect(startingSamples(images, normalized)).toBe(true);
    const opens: ListItem = { ...EARLIER[0], action: 'image' };
    const links: ListItem = { ...EARLIER[1], action: 'link', link: { type: 'url', target: 'https://example.com' } };
    expect(sampleRows(images, [opens, links])).toEqual([]);
    expect(startingSamples(images, [opens, ...EARLIER.slice(1)])).toBe(false);
  });

  it('gives each added image the item defaults, doing nothing when clicked', () => {
    const { state, owner, nodeId, library, rows } = blankWithGallery();
    const plan = planPicks(images, [], 'image', [pickedImage(library[0])], []);
    if ('error' in plan) throw new Error(plan.error);
    const [row] = rows(applyOperations(state, toOps(owner, nodeId, plan.steps)).state);
    expect(row).toMatchObject({ image: { assetId: 'img_p1', alt: 'A grey swatch' }, caption: '', action: 'none', link: { type: 'none', target: '' } });
  });
});

describe('replacing samples by default', () => {
  it('only while the list is exactly the rows its component started with, in order', () => {
    expect(startingSamples(images, EARLIER)).toBe(true);
    expect(startingSamples(earlierSchema, EARLIER)).toBe(true);
    // Trimmed, reordered or added to: the samples are offered, but kept unless the author says otherwise.
    expect(startingSamples(images, EARLIER.slice(0, 3))).toBe(false);
    expect(startingSamples(images, [EARLIER[1], EARLIER[0], ...EARLIER.slice(2)])).toBe(false);
    expect(startingSamples(images, [...EARLIER, { id: 'i_mine', image: { assetId: null, alt: '' }, caption: 'Mine' }])).toBe(false);
    // A row the author added and captioned like a sample is not one by default.
    const typed: ListItem = { id: 'i_typed', image: { assetId: null, alt: '' }, caption: 'Kitchen, Millbrook' };
    expect(sampleRows(images, [typed])).toEqual(['i_typed']);
    expect(startingSamples(images, [typed])).toBe(false);
    expect(startingSamples(images, [])).toBe(false);
    const own: ListProp = { ...images, default: [{ id: 'item-1', image: { assetId: null, alt: '' }, caption: 'Workshop, Quayside' }] };
    expect(startingSamples(own, [{ id: 'i_w', image: { assetId: null, alt: '' }, caption: 'Workshop, Quayside' }])).toBe(true);
    expect(startingSamples(own, [{ id: 'i_w', image: { assetId: 'img_p1', alt: '' }, caption: 'Workshop, Quayside' }])).toBe(false);
  });
});

describe('choosing images', () => {
  it('keeps the order they were chosen in, and leaves out what has no room', () => {
    let chosen: string[] = [];
    chosen = togglePick(chosen, 'c', 3);
    chosen = togglePick(chosen, 'a', 3);
    chosen = togglePick(chosen, 'b', 3);
    expect(chosen).toEqual(['c', 'a', 'b']);
    expect(togglePick(chosen, 'd', 3)).toEqual(['c', 'a', 'b']);
    expect(togglePick(chosen, 'a', 3)).toEqual(['c', 'b']);
    expect(movePick(chosen, 'b', 'up')).toEqual(['c', 'b', 'a']);
    expect(movePick(chosen, 'c', 'up')).toEqual(['c', 'a', 'b']);
    expect(movePick(chosen, 'b', 'down')).toEqual(['c', 'a', 'b']);
    expect(movePick(chosen, 'a', 'down')).toEqual(['c', 'b', 'a']);
    expect(movePick(chosen, 'z', 'down')).toEqual(['c', 'a', 'b']);
  });

  it('keeps an image that left Assets in its place while the rest of the choice changes', () => {
    // A, B, C chosen; A leaves Assets; the author adds D, then A comes back with an Undo in Assets.
    expect(mergeChoice(['a', 'b', 'c'], ['b', 'c'], ['b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    // It follows the image it came after when that one moves.
    expect(mergeChoice(['b', 'a', 'c'], ['b', 'c'], ['c', 'b'])).toEqual(['c', 'b', 'a']);
    expect(mergeChoice(['a', 'b', 'c'], ['b', 'c'], ['c'])).toEqual(['a', 'c']);
    // Leaving out the image before it keeps it ahead of the one after it.
    expect(mergeChoice(['a', 'x', 'b'], ['a', 'b'], ['b'])).toEqual(['x', 'b']);
    expect(mergeChoice(['a', 'x', 'y', 'b'], ['a', 'b'], ['a', 'b'])).toEqual(['a', 'x', 'y', 'b']);
    expect(mergeChoice(['a', 'b'], ['a', 'b'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
    expect(mergeChoice([], [], ['a'])).toEqual(['a']);
  });

  it('has room for a full gallery when it replaces the samples, and says by how much a choice is over', () => {
    expect(pickRoom(images, 6, 6)).toBe(24);
    expect(pickRoom(images, 6, 0)).toBe(18);
    expect(pickRoom(images, 24, 0)).toBe(0);
    expect(pickRoom({}, 6, 0)).toBe(Number.POSITIVE_INFINITY);
    // A list already over its maximum has no room, never less than none.
    expect(pickRoom(images, 30, 0)).toBe(0);
    expect(overNote(18, 18)).toBeNull();
    expect(overNote(20, 18)).toBe('This gallery has room for 18 more images. Leave out 2 images.');
    expect(overNote(1, 0)).toContain('This gallery is full.');
  });

  it('uses each image’s suggested description, and names the change', () => {
    expect(pickedImage({ id: 'img_a', altSuggestion: 'A grey swatch' })).toEqual({ assetId: 'img_a', alt: 'A grey swatch' });
    expect(pickedImage({ id: 'img_b' })).toEqual({ assetId: 'img_b', alt: '' });
    expect(pickLabel(1, 0)).toBe('Add 1 image');
    expect(pickLabel(3, 6)).toBe('Replace sample images with 3 images');
    expect(pickAnnouncement(3, 6)).toBe('Added 3 images in place of the samples.');
    expect(pickAnnouncement(1, 0)).toBe('Added 1 image.');
  });
});

describe('adding the chosen images', () => {
  it('adds them in the chosen order as one batch, after the rows the author keeps', () => {
    const { state, owner, nodeId, library, rows } = blankWithGallery([{ image: { assetId: 'img_p9', alt: 'Mine' }, caption: 'Kept' }]);
    const kept = rows(state)[0];
    const chosen = [library[2], library[0], library[1]].map(pickedImage);
    const plan = planPicks(images, rows(state), 'image', chosen, []);
    if ('error' in plan) throw new Error(plan.error);
    const next = applyOperations(state, toOps(owner, nodeId, plan.steps)).state;
    const after = rows(next);
    expect(after[0]).toEqual(kept);
    expect(after.slice(1).map((r) => r.image)).toEqual([
      { assetId: 'img_p3', alt: '' },
      { assetId: 'img_p1', alt: 'A grey swatch' },
      { assetId: 'img_p2', alt: '' }
    ]);
    expect(after.slice(1).every((r) => r.caption === '' && typeof r.id === 'string')).toBe(true);
  });

  it('swaps six samples for a full gallery of 24 without passing the maximum', () => {
    const { state, owner, nodeId, library, rows } = blankWithGallery(EARLIER.map(({ id: _, ...r }) => r));
    const before = rows(state);
    const chosen = library.slice(0, 24).map(pickedImage);
    const plan = planPicks(images, before, 'image', chosen, sampleRows(images, before));
    if ('error' in plan) throw new Error(plan.error);
    // Every sample goes before an image comes in.
    expect(plan.steps.slice(0, 6).every((s) => s.kind === 'remove')).toBe(true);
    const after = rows(applyOperations(state, toOps(owner, nodeId, plan.steps)).state);
    expect(after).toHaveLength(24);
    expect(after.map((r) => (r.image as { assetId: string }).assetId)).toEqual(library.slice(0, 24).map((a) => a.id));
    // Inserting first would have passed the maximum.
    const naive: PickStep[] = [...chosen.map((image) => ({ kind: 'insert' as const, item: { image } })), ...before.map((r) => ({ kind: 'remove' as const, itemId: r.id }))];
    expect(() => applyOperations(state, toOps(owner, nodeId, naive))).toThrow(/at most 24/);
  });

  it('refuses a choice that does not fit, and one that would take a list below its minimum', () => {
    expect(planPicks(images, EARLIER, 'image', Array.from({ length: 19 }, (_, i) => pickedImage(asset(i))), [])).toEqual({ error: 'This gallery has room for 18 more images. Leave out 1 image.' });
    expect(planPicks(images, [], 'image', [], [])).toEqual({ error: 'Choose at least one image to add.' });
    // A list that must keep two rows swaps its samples one for one as the images come in.
    const fixed = { ...images, min: 2, max: 3 };
    const plan = planPicks(fixed, EARLIER.slice(0, 2), 'image', [pickedImage(asset(1)), pickedImage(asset(2))], EARLIER.slice(0, 2).map((r) => r.id));
    expect('steps' in plan && plan.steps.map((s) => s.kind)).toEqual(['insert', 'remove', 'insert', 'remove']);
    expect(planPicks(fixed, EARLIER.slice(0, 2), 'image', [pickedImage(asset(1))], EARLIER.slice(0, 2).map((r) => r.id))).toMatchObject({ error: expect.stringContaining('at least 2') });
    // A list fixed at its size can neither lose a row first nor gain one first: it is refused rather than half made.
    const exact = { ...images, min: 2, max: 2 };
    expect(planPicks(exact, EARLIER.slice(0, 2), 'image', [pickedImage(asset(1)), pickedImage(asset(2))], EARLIER.slice(0, 2).map((r) => r.id))).toMatchObject({ error: expect.stringContaining('at least 2') });
  });
});

describe('pressing Add', () => {
  const assets = Object.fromEntries([1, 2, 3].map((n) => [`img_p${n}`, asset(n, n === 2 ? { altSuggestion: 'Two' } : {})]));

  it('plans against the gallery as it is now, replacing only the samples the author was shown that are still samples', () => {
    const shown = EARLIER.map((r) => r.id);
    // Since the picker was drawn, one sample got a picture, and a seventh sample came back with an Undo.
    const now: ListItem[] = [{ ...EARLIER[0], image: { assetId: 'img_p3', alt: '' } }, ...EARLIER.slice(1), { ...EARLIER[0], id: 'i_back' }];
    const plan = planChoice(images, now, 'image', ['img_p2', 'img_p1'], shown, assets);
    if ('error' in plan) throw new Error(plan.error);
    const removed = plan.steps.filter((s) => s.kind === 'remove').map((s) => s.itemId);
    expect(removed).toEqual(shown.slice(1));
    expect(plan.steps.filter((s) => s.kind === 'insert').map((s) => s.item)).toEqual([{ image: { assetId: 'img_p2', alt: 'Two' } }, { image: { assetId: 'img_p1', alt: '' } }]);
    expect(plan.label).toBe('Replace sample images with 2 images');
    expect(planChoice(images, now, 'image', ['img_p1'], [], assets)).toMatchObject({ label: 'Add 1 image' });
  });

  it('stops when a chosen image left Assets, so the author confirms what is left', () => {
    expect(planChoice(images, [], 'image', ['img_p1', 'img_gone'], [], assets)).toEqual({ error: 'An image you chose was removed from Assets. Check your choice, then add again.' });
    expect(planChoice(images, [], 'image', ['img_x', 'img_y'], [], assets)).toEqual({ error: '2 images you chose were removed from Assets. Check your choice, then add again.' });
    // A font is not an image, whatever its ID.
    const withFont = { ...assets, font_a: { ...asset(9), id: 'font_a', kind: 'font' as const } };
    expect(planChoice(images, [], 'image', ['font_a'], [], withFont)).toEqual({ error: 'An image you chose was removed from Assets. Check your choice, then add again.' });
  });
});

describe('one undo step', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('replaces the samples with the chosen images in one change that Undo takes back whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-gallery-picks-'));
    dirs.push(dir);
    const { state, owner, nodeId, library, rows } = blankWithGallery(EARLIER.map(({ id: _, ...r }) => r));
    const session = await ProjectSession.create(dir, state);
    const before = structuredClone(rows(session.state));
    const steps = session.historyInfo().entries.length;
    const chosen = [library[4], library[2], library[3]].map(pickedImage);
    const plan = planPicks(images, before, 'image', chosen, sampleRows(images, before));
    if ('error' in plan) throw new Error(plan.error);
    const label = pickLabel(chosen.length, 6);
    const r = await session.apply({ operations: toOps(owner, nodeId, plan.steps), expectedRevision: session.revision }, { label, source: 'user' });
    expect(r.ok).toBe(true);
    const added = structuredClone(rows(session.state));
    expect(added.map((x) => (x.image as { assetId: string }).assetId)).toEqual(['img_p5', 'img_p3', 'img_p4']);
    expect(session.historyInfo().entries).toHaveLength(steps + 1);
    expect(session.historyInfo().undoLabel).toBe(label);

    expect((await session.undo()).ok).toBe(true);
    expect(rows(session.state)).toEqual(before);
    expect((await session.redo()).ok).toBe(true);
    expect(rows(session.state)).toEqual(added);
  });

  it('changes nothing when the project moved on while the images were being chosen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-gallery-picks-'));
    dirs.push(dir);
    const { state, owner, nodeId, library, rows } = blankWithGallery(EARLIER.map(({ id: _, ...r }) => r));
    const session = await ProjectSession.create(dir, state);
    const seen = session.revision;
    const before = structuredClone(rows(session.state));
    // Meanwhile a sample gets a real picture.
    await session.apply({ operations: [{ type: 'instance.setProp', owner, nodeId, prop: 'images', itemId: before[0].id, field: 'image', value: { assetId: 'img_p30', alt: 'Real' } }] }, { label: 'Edit', source: 'user' });
    const filled = structuredClone(rows(session.state));
    const plan = planPicks(images, before, 'image', [pickedImage(library[0])], sampleRows(images, before));
    if ('error' in plan) throw new Error(plan.error);
    const r = await session.apply({ operations: toOps(owner, nodeId, plan.steps), expectedRevision: seen }, { label: 'Add 1 image', source: 'user' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STALE_REVISION');
    expect(rows(session.state)).toEqual(filled);
    // Planned again against the project as it is now, the filled row is no longer a sample and stays.
    expect(sampleRows(images, filled)).toEqual(filled.slice(1).map((x) => x.id));
  });
});
