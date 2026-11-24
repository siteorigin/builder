import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { describeOps } from '@agent/report';
import { executeTool, toolDefinitions, type ToolHost } from '@agent/tools';
import type { EditOperation } from '@shared/ops';
import type { AltReview, AssetRecord, ImageNode, ImageValue, InstanceNode, ListItem, ListProp, OwnerRef, ProjectState } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { altChecks } from '../../src/renderer/src/lib/alt-review';
import { valueAt } from '@engine/alt-review';

/** Issue #26: replacing a library image everywhere brings the replacement's suggested alt text with it. */

const KITCHEN = 'A calm kitchen with timber cabinets and a stone worktop';
const PORTRAIT = 'Portrait of Hannah Wells';

const image = (id: string, name: string, altSuggestion?: string): AssetRecord => ({
  id,
  name,
  file: `static/assets/${id}-1a2b3c4d.jpg`,
  mime: 'image/jpeg',
  bytes: 10,
  hash: `hash-${id}`,
  kind: 'image',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...(altSuggestion !== undefined ? { altSuggestion } : {})
});

/** A page with one standalone image and a gallery of four rows, all showing the kitchen. */
function lookbook() {
  const state = createStarterState('blank', 'Test', false);
  const home = state.site.homePageId;
  const owner: OwnerRef = { kind: 'page', id: home };
  const add = (a: AssetRecord): EditOperation => ({ type: 'asset.add', asset: a });
  // Suggestions are compared and given as they read, without the spaces around them.
  let r = applyOperations(state, [
    add(image('a_kitchen', 'Kitchen', `${KITCHEN}\n`)),
    add(image('a_person1', 'Portrait 1', ` ${PORTRAIT} `)),
    add(image('a_plain', 'Plain')),
    add(image('a_blank', 'Blank', '  ')),
    { type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }
  ]);
  const section = r.results.at(-1)!.nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' }]);
  const imageId = r.results[0].nodeId as string;
  const rows: Array<Record<string, unknown>> = [
    { id: 'g0', image: { assetId: 'a_person1', alt: 'Hannah at her desk' }, caption: 'Already the portrait' },
    { id: 'g1', image: { assetId: 'a_kitchen', alt: KITCHEN }, caption: 'Suggested' },
    { id: 'g2', image: { assetId: 'a_kitchen', alt: 'Our kitchen after the refit' }, caption: 'Custom' },
    { id: 'g3', image: { assetId: 'a_kitchen', alt: KITCHEN, decorative: true }, caption: 'Decorative' },
    { id: 'g4', image: { assetId: 'a_kitchen', alt: `  ${KITCHEN} ` }, caption: 'Suggested, spaced' },
    { id: 'g5', image: { assetId: 'a_kitchen', alt: '' }, caption: 'Cleared' },
    { id: 'g6', image: { assetId: 'a_kitchen', alt: PORTRAIT }, caption: 'Written for the portrait' }
  ];
  r = applyOperations(r.state, [
    { type: 'node.setContent', owner, nodeId: imageId, field: 'image', value: { assetId: 'a_kitchen', alt: KITCHEN } },
    { type: 'node.insert', owner, parentId: null, index: 1, componentId: 'media.gallery', props: { images: rows } }
  ]);
  const galleryId = r.results[1].nodeId as string;
  const standalone = (s: ProjectState) => (s.pages[home].nodes[imageId] as ImageNode).image as ImageValue;
  const gallery = (s: ProjectState) => ((s.pages[home].nodes[galleryId] as InstanceNode).props.images as ListItem[]).map((i) => i.image as ImageValue);
  // A component whose image starts as the kitchen, in its list's rows and in a new row's field.
  const def = r.state.components[(r.state.pages[home].nodes[galleryId] as InstanceNode).definitionId];
  const images = def.properties.images as ListProp;
  images.default = [{ id: 'd1', image: { assetId: 'a_kitchen', alt: KITCHEN }, caption: '' }];
  images.fields.image.default = { assetId: 'a_kitchen', alt: 'Our kitchen' };
  return { state: r.state, owner, imageId, galleryId, definitionId: def.id, standalone, gallery };
}

const replace = (assetId: string, withAssetId: string): EditOperation => ({ type: 'asset.replace', assetId, withAssetId });
const lookbookOwner = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const galleryOf = (s: ProjectState) => Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'media.gallery')!.id;

describe('replacing a library image everywhere', () => {
  it('gives each use that still has the old suggested alt text the replacement’s, and keeps custom and decorative ones', () => {
    const { state, owner, imageId, galleryId, definitionId, standalone, gallery } = lookbook();
    const r = applyOperations(state, [replace('a_kitchen', 'a_person1')]);
    const next = r.state;
    expect(standalone(next)).toEqual({ assetId: 'a_person1', alt: PORTRAIT });
    expect(gallery(next)).toEqual([
      { assetId: 'a_person1', alt: 'Hannah at her desk' },
      { assetId: 'a_person1', alt: PORTRAIT },
      { assetId: 'a_person1', alt: 'Our kitchen after the refit' },
      { assetId: 'a_person1', alt: KITCHEN, decorative: true },
      { assetId: 'a_person1', alt: PORTRAIT },
      { assetId: 'a_person1', alt: '' },
      { assetId: 'a_person1', alt: PORTRAIT }
    ]);
    const images = next.components[definitionId].properties.images as ListProp;
    expect(images.default[0].image).toEqual({ assetId: 'a_person1', alt: PORTRAIT });
    expect(images.fields.image.default).toEqual({ assetId: 'a_person1', alt: 'Our kitchen' });
    // Only descriptions of the uses' own, and uses with none, are left to check: by row ID, so a row already showing
    // the portrait, or the rows moving, never confuses which one. One that already reads as the portrait's suggestion
    // needs no check.
    expect(r.results[0].altReview).toEqual([
      { owner, nodeId: galleryId, path: ['props', 'images', 'g2', 'image'], reason: 'custom', alt: 'Our kitchen after the refit' },
      { owner, nodeId: galleryId, path: ['props', 'images', 'g5', 'image'], reason: 'missing', alt: '' },
      { definitionId, path: ['images', 'fields', 'image', 'default'], reason: 'custom', alt: 'Our kitchen' }
    ]);
    expect(r.results[0].altReview).not.toContainEqual(expect.objectContaining({ nodeId: imageId }));
  });

  it('clears an inherited description the replacement has no suggestion for, and lists it to review', () => {
    const { state, owner, imageId, galleryId, definitionId, standalone, gallery } = lookbook();
    const r = applyOperations(state, [replace('a_kitchen', 'a_plain')]);
    expect(standalone(r.state)).toEqual({ assetId: 'a_plain', alt: '' });
    expect(gallery(r.state).map((i) => i.alt)).toEqual(['Hannah at her desk', '', 'Our kitchen after the refit', KITCHEN, '', '', PORTRAIT]);
    const review = r.results[0].altReview as AltReview[];
    expect(review.filter((x) => x.reason === 'missing')).toEqual([
      { owner, nodeId: imageId, path: ['image'], reason: 'missing', alt: '' },
      { owner, nodeId: galleryId, path: ['props', 'images', 'g1', 'image'], reason: 'missing', alt: '' },
      { owner, nodeId: galleryId, path: ['props', 'images', 'g4', 'image'], reason: 'missing', alt: '' },
      { owner, nodeId: galleryId, path: ['props', 'images', 'g5', 'image'], reason: 'missing', alt: '' },
      { definitionId, path: ['images', 'default', 'd1', 'image'], reason: 'missing', alt: '' }
    ]);
    expect(review.filter((x) => x.reason === 'custom').map((x) => x.alt)).toEqual(['Our kitchen after the refit', PORTRAIT, 'Our kitchen']);
    // Replaced again with another image that suggests nothing: the uses still have none, and are listed again.
    const again = applyOperations(r.state, [replace('a_plain', 'a_blank')]);
    expect((again.results[0].altReview as AltReview[]).filter((x) => x.reason === 'missing')).toEqual(review.filter((x) => x.reason === 'missing'));
    const ops = [replace('a_kitchen', 'a_plain'), replace('a_plain', 'a_blank')];
    expect(describeOps(ops, state, again.state, [...r.results, ...again.results]).map((c) => c.label)).toEqual([
      'Replaced “Kitchen” with “Plain” wherever it was used',
      'Replaced “Plain” with “Blank” wherever it was used; check the alt text in 8 places'
    ]);
  });

  it('fills an image with no description from an image that had no suggestion either', () => {
    const { state, owner, imageId } = lookbook();
    const plain = applyOperations(state, [{ type: 'node.setContent', owner, nodeId: imageId, field: 'image', value: { assetId: 'a_plain', alt: '' } }]).state;
    const r = applyOperations(plain, [replace('a_plain', 'a_person1')]);
    expect((r.state.pages[owner.id].nodes[imageId] as ImageNode).image).toEqual({ assetId: 'a_person1', alt: PORTRAIT });
    expect(r.results[0].altReview).toEqual([]);
    // From one image with none to another with none: still none, so it is listed to check.
    const blank = applyOperations(plain, [replace('a_plain', 'a_blank')]);
    expect((blank.state.pages[owner.id].nodes[imageId] as ImageNode).image).toEqual({ assetId: 'a_blank', alt: '' });
    expect(blank.results[0].altReview).toEqual([{ owner, nodeId: imageId, path: ['image'], reason: 'missing', alt: '' }]);
  });

  it('leaves every description as it is for a copy of the same picture', () => {
    const { state, standalone, gallery } = lookbook();
    const r = applyOperations(state, [{ type: 'asset.replace', assetId: 'a_kitchen', withAssetId: 'a_plain', keepAlt: true }]);
    expect(standalone(r.state)).toEqual({ assetId: 'a_plain', alt: KITCHEN });
    expect(gallery(r.state)).toEqual(gallery(state).map((i) => (i.assetId === 'a_kitchen' ? { ...i, assetId: 'a_plain' } : i)));
    expect(r.results[0].altReview).toEqual([]);
  });

  it('changes nothing when an image is replaced with itself', () => {
    const { state } = lookbook();
    const r = applyOperations(state, [replace('a_kitchen', 'a_kitchen')]);
    expect(r.state).toEqual(state);
    expect(r.results[0].altReview).toEqual([]);
  });
});

describe('the uses left to check', () => {
  it('names each with its page, element and row, and follows a row that moves', () => {
    const { state, owner, galleryId } = lookbook();
    const r = applyOperations(state, [replace('a_kitchen', 'a_person1')]);
    const review = r.results[0].altReview as AltReview[];
    const listed = altChecks(r.state, 'a_person1', review);
    expect(listed.map(({ icon, where, what, reason, alt, at }) => ({ icon, where, what, reason, alt, at }))).toEqual([
      { icon: 'page', where: 'Home', what: 'Gallery · Image 3: Custom', reason: 'custom', alt: 'Our kitchen after the refit', at: { owner, nodeId: galleryId } },
      { icon: 'page', where: 'Home', what: 'Gallery · Image 6: Cleared', reason: 'missing', alt: '', at: { owner, nodeId: galleryId } },
      { icon: 'component', where: 'Gallery default', what: 'Images: starting image for new copies', reason: 'custom', alt: 'Our kitchen', at: undefined }
    ]);
    const moved = applyOperations(r.state, [{ type: 'instance.listMove', owner, nodeId: galleryId, prop: 'images', itemId: 'g2', index: 0 }]).state;
    expect(altChecks(moved, 'a_person1', review)[0]).toMatchObject({ what: 'Gallery · Image 1: Custom', alt: 'Our kitchen after the refit' });
    expect(valueAt((moved.pages[owner.id].nodes[galleryId] as InstanceNode).props, ['images', 'g2', 'image'])).toEqual({ assetId: 'a_person1', alt: 'Our kitchen after the refit' });
  });

  it('drops a use once its alt text is edited, it is made decorative, given another image or removed', () => {
    const { state, owner, galleryId } = lookbook();
    const r = applyOperations(state, [replace('a_kitchen', 'a_person1')]);
    const review = (r.results[0].altReview as AltReview[]).filter((x) => x.path.includes('g2'));
    const set = (value: ImageValue): EditOperation => ({ type: 'instance.setProp', owner, nodeId: galleryId, prop: 'images', itemId: 'g2', field: 'image', value });
    expect(altChecks(r.state, 'a_person1', review)).toHaveLength(1);
    for (const op of [
      set({ assetId: 'a_person1', alt: 'Hannah in the kitchen' }),
      set({ assetId: 'a_person1', alt: 'Our kitchen after the refit', decorative: true }),
      set({ assetId: 'a_plain', alt: 'Our kitchen after the refit' }),
      { type: 'instance.listRemove', owner, nodeId: galleryId, prop: 'images', itemId: 'g2' } as EditOperation
    ])
      expect(altChecks(applyOperations(r.state, [op]).state, 'a_person1', review)).toEqual([]);
    // Before the replacement (undone), the uses show the old image: there is nothing to check.
    expect(altChecks(state, 'a_person1', review)).toEqual([]);
  });
});

describe('the AI’s report of a replacement', () => {
  it('says how many places have alt text to check', () => {
    const { state } = lookbook();
    const ops = [replace('a_kitchen', 'a_person1')];
    const r = applyOperations(state, ops);
    expect(describeOps(ops, state, r.state, r.results).map((c) => c.label)).toEqual(['Replaced “Kitchen” with “Portrait 1” wherever it was used; check the alt text in 3 places']);
    // A description the run changed since, or a use it removed, is no longer one to check.
    const fix: EditOperation = { type: 'instance.setProp', owner: lookbookOwner(r.state), nodeId: galleryOf(r.state), prop: 'images', itemId: 'g2', field: 'image', value: { assetId: 'a_person1', alt: 'Hannah in the kitchen' } };
    const fixed = applyOperations(r.state, [fix]);
    expect(describeOps([...ops, fix], state, fixed.state, [...r.results, ...fixed.results])[0].label).toBe('Replaced “Kitchen” with “Portrait 1” wherever it was used; check the alt text in 2 places');
    // Nothing to check, nothing said about it.
    const plain = applyOperations(r.state, [replace('a_plain', 'a_kitchen')]);
    expect(plain.results[0].altReview).toEqual([]);
    expect(describeOps([replace('a_plain', 'a_kitchen')], r.state, plain.state, plain.results)[0].label).toBe('Replaced “Plain” with “Kitchen” wherever it was used');
  });
});

describe('the AI replacing an image', () => {
  it('is never offered keepAlt, and is refused it', async () => {
    const apply = toolDefinitions().find((t) => t.name === 'apply_operations');
    expect(JSON.stringify(apply)).toContain('asset.replace');
    expect(JSON.stringify(apply)).not.toContain('keepAlt');
    const { state } = lookbook();
    let applied = false;
    const host = { state: () => state, revision: () => 0, apply: async () => ((applied = true), { ok: true, revision: 1 }) } as unknown as ToolHost;
    const r = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 0, operations: [{ type: 'asset.replace', assetId: 'a_kitchen', withAssetId: 'a_person1', keepAlt: true }] }), host, 'c1');
    expect(r).toMatchObject({ ok: false, content: { error: 'INVALID_ARGUMENT', message: expect.stringContaining('does not take keepAlt') } });
    expect(applied).toBe(false);
  });
});

describe('replacing a library image everywhere in the editor', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('brings the old alt text back on undo and the new one on redo, for a standalone image and gallery rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-replace-alt-'));
    dirs.push(dir);
    const { state, standalone, gallery } = lookbook();
    const session = await ProjectSession.create(dir, state);
    const before = { one: standalone(session.state), rows: gallery(session.state) };
    const applied = await session.apply({ operations: [replace('a_kitchen', 'a_person1')] }, { label: 'Replace Kitchen', source: 'user' });
    expect(applied.ok).toBe(true);
    expect((applied.results?.[0].altReview as AltReview[]).map((x) => x.alt)).toEqual(['Our kitchen after the refit', '', 'Our kitchen']);
    const after = { one: standalone(session.state), rows: gallery(session.state) };
    expect(after.one.alt).toBe(PORTRAIT);
    expect(after.rows.map((i) => i.alt)).toEqual(['Hannah at her desk', PORTRAIT, 'Our kitchen after the refit', KITCHEN, PORTRAIT, '', PORTRAIT]);

    expect((await session.undo()).ok).toBe(true);
    expect({ one: standalone(session.state), rows: gallery(session.state) }).toEqual(before);
    expect((await session.redo()).ok).toBe(true);
    expect({ one: standalone(session.state), rows: gallery(session.state) }).toEqual(after);
  });
});
