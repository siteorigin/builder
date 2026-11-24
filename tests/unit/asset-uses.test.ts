import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { describeOps } from '@agent/report';
import { executeTool, toolDefinitions, type ToolHost } from '@agent/tools';
import type { EditOperation } from '@shared/ops';
import type { AltReview, AssetRecord, ImageNode, ImageUseTarget, ImageValue, InstanceNode, ListItem, OwnerRef, ProjectState } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { imageUseRows } from '../../src/renderer/src/lib/asset-uses';
import { useKey } from '@engine/image-uses';
import { altChecks } from '../../src/renderer/src/lib/alt-review';

/**
 * Issue #228: Portrait 1 shows in five places. The author replaces it on Home (the hero, two gallery rows) and on
 * the Work page, and keeps it on About's team as it is, in one step that undoes in one step.
 */

const PORTRAIT = 'Portrait of Hannah Wells';
const PUBLICITY = 'Hannah at the studio door';

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

function studio() {
  const state = createStarterState('blank', 'Studio', false);
  const homeId = state.site.homePageId;
  const home: OwnerRef = { kind: 'page', id: homeId };
  let r = applyOperations(state, [
    { type: 'asset.add', asset: image('a_person1', 'Portrait 1', PORTRAIT) },
    { type: 'asset.add', asset: image('a_publicity', 'Publicity 1', PUBLICITY) },
    { type: 'asset.add', asset: image('a_other', 'Other') },
    { type: 'page.create', title: 'Work' },
    { type: 'page.create', title: 'About' }
  ]);
  const work: OwnerRef = { kind: 'page', id: r.results[3].pageId as string };
  const about: OwnerRef = { kind: 'page', id: r.results[4].pageId as string };
  const portrait = (alt: string): ImageValue => ({ assetId: 'a_person1', alt });
  r = applyOperations(r.state, [
    { type: 'node.insert', owner: home, parentId: null, index: 0, componentId: 'hero.split', props: { image: portrait(PORTRAIT) } },
    {
      type: 'node.insert',
      owner: home,
      parentId: null,
      index: 1,
      componentId: 'media.gallery',
      props: {
        images: [
          { id: 'g1', image: portrait(PORTRAIT), caption: 'Studio front' },
          { id: 'g2', image: portrait('Hannah sketching at her desk'), caption: 'At work' },
          { id: 'g3', image: { assetId: 'a_other', alt: 'Samples' }, caption: 'Samples' }
        ]
      }
    },
    {
      type: 'node.insert',
      owner: about,
      parentId: null,
      index: 0,
      componentId: 'team.grid',
      props: { people: [{ id: 'p1', portrait: portrait('  Hannah Wells, founder  '), name: 'Hannah Wells', role: 'Founder', bio: '' }] }
    },
    { type: 'node.insert', owner: work, parentId: null, index: 0, componentId: 'layout.section' }
  ]);
  const [heroId, galleryId, teamId, sectionId] = r.results.map((x) => x.nodeId as string);
  r = applyOperations(r.state, [{ type: 'node.insert', owner: work, parentId: sectionId, slot: 'content', primitive: 'image' }]);
  const workImageId = r.results[0].nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.setContent', owner: work, nodeId: workImageId, field: 'image', value: portrait('') }]);
  const s = r.state;
  const target = (owner: OwnerRef, nodeId: string, path: string[]): NodeUse => ({ kind: 'node', owner, nodeId, path });
  return {
    state: s,
    home,
    work,
    about,
    heroId,
    galleryId,
    teamId,
    workImageId,
    uses: {
      hero: target(home, heroId, ['props', 'image']),
      g1: target(home, galleryId, ['props', 'images', 'g1', 'image']),
      g2: target(home, galleryId, ['props', 'images', 'g2', 'image']),
      work: target(work, workImageId, ['image']),
      team: target(about, teamId, ['props', 'people', 'p1', 'portrait'])
    },
    read: (st: ProjectState) => ({
      hero: (st.pages[home.id].nodes[heroId] as InstanceNode).props.image as ImageValue,
      rows: ((st.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[]).map((i) => i.image as ImageValue),
      work: (st.pages[work.id].nodes[workImageId] as ImageNode).image as ImageValue,
      team: ((st.pages[about.id].nodes[teamId] as InstanceNode).props.people as ListItem[])[0].portrait as ImageValue
    })
  };
}

type NodeUse = Extract<ImageUseTarget, { kind: 'node' }>;
const replaceIn = (uses: ImageUseTarget[]): EditOperation => ({ type: 'asset.replace', assetId: 'a_person1', withAssetId: 'a_publicity', uses });

describe('the uses of an image, one row each', () => {
  it('names each gallery and team row and the field Show opens, in page order', () => {
    const { state, home, work, about, heroId, galleryId, teamId, workImageId, uses } = studio();
    const rows = imageUseRows(state, 'a_person1');
    expect(rows.map(({ icon, where, what, at, field, alt }) => ({ icon, where, what, at, field, alt }))).toEqual([
      { icon: 'page', where: 'Home', what: 'Split hero', at: { owner: home, nodeId: heroId }, field: { prop: 'image' }, alt: PORTRAIT },
      { icon: 'page', where: 'Home', what: 'Gallery · Image 1: Studio front', at: { owner: home, nodeId: galleryId }, field: { prop: 'images', itemId: 'g1', field: 'image' }, alt: PORTRAIT },
      { icon: 'page', where: 'Home', what: 'Gallery · Image 2: At work', at: { owner: home, nodeId: galleryId }, field: { prop: 'images', itemId: 'g2', field: 'image' }, alt: 'Hannah sketching at her desk' },
      { icon: 'page', where: 'Work', what: 'Image', at: { owner: work, nodeId: workImageId }, field: undefined, alt: '' },
      { icon: 'page', where: 'About', what: 'Team · Person 1: Hannah Wells', at: { owner: about, nodeId: teamId }, field: { prop: 'people', itemId: 'p1', field: 'portrait' }, alt: '  Hannah Wells, founder  ' }
    ]);
    expect(rows.map((r) => r.target)).toEqual([uses.hero, uses.g1, uses.g2, uses.work, uses.team]);
    expect(rows.map((r) => r.key)).toEqual(rows.map((r) => useKey(r.target!)));
    expect(new Set(rows.map((r) => r.key)).size).toBe(5);
    // The same path in another element, or on another page, is another use.
    expect(useKey({ ...uses.g1, nodeId: heroId })).not.toBe(useKey(uses.g1));
    expect(useKey({ ...uses.g1, owner: about })).not.toBe(useKey(uses.g1));
  });

  it('keeps a row’s key and target while it moves or is renamed, and its label follows', () => {
    const { state, home, galleryId } = studio();
    const before = imageUseRows(state, 'a_person1').find((r) => r.what.includes('At work'))!;
    const moved = applyOperations(state, [
      { type: 'instance.listMove', owner: home, nodeId: galleryId, prop: 'images', itemId: 'g2', index: 0 },
      { type: 'instance.setProp', owner: home, nodeId: galleryId, prop: 'images', itemId: 'g2', field: 'caption', value: 'Sketching' }
    ]).state;
    const after = imageUseRows(moved, 'a_person1').find((r) => r.key === before.key)!;
    expect(after.what).toBe('Gallery · Image 1: Sketching');
    expect(after.target).toEqual(before.target);
  });

  it('lists a page’s sharing image and the site’s own as uses of their own', () => {
    const { state } = studio();
    const s = structuredClone(state);
    const workId = s.site.pageOrder.find((id) => s.pages[id].title === 'Work')!;
    s.pages[s.site.homePageId].seo.socialImage = 'a_person1';
    s.pages[workId].seo.socialImage = 'a_person1';
    s.site.favicon = 'a_person1';
    s.site.socialImage = 'a_person1';
    const rows = imageUseRows(s, 'a_person1').slice(-4);
    expect(rows.map(({ icon, where, what, setting, target }) => ({ icon, where, what, setting, target }))).toEqual([
      { icon: 'page', where: 'Home', what: 'Sharing image', setting: { pageId: s.site.homePageId }, target: { kind: 'pageSharing', pageId: s.site.homePageId } },
      { icon: 'page', where: 'Work', what: 'Sharing image', setting: { pageId: workId }, target: { kind: 'pageSharing', pageId: workId } },
      { icon: 'site', where: 'Site', what: 'Browser tab icon', setting: 'site', target: { kind: 'site', field: 'favicon' } },
      { icon: 'site', where: 'Site', what: 'Sharing image', setting: 'site', target: { kind: 'site', field: 'socialImage' } }
    ]);
  });

  it('has no target for a row with no ID, which only Replace everywhere changes', () => {
    const { state, home, galleryId } = studio();
    const s = structuredClone(state);
    for (const row of (s.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[]) delete (row as Partial<ListItem>).id;
    const rows = imageUseRows(s, 'a_person1').filter((r) => r.what.startsWith('Gallery'));
    expect(rows.map((r) => [r.what, r.target, r.field])).toEqual([
      ['Gallery · Image 1: Studio front', null, undefined],
      ['Gallery · Image 2: At work', null, undefined]
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    // Replace everywhere still reaches them.
    const all = applyOperations(s, [{ type: 'asset.replace', assetId: 'a_person1', withAssetId: 'a_publicity' }]).state;
    expect(((all.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[]).map((i) => (i.image as ImageValue).assetId)).toEqual(['a_publicity', 'a_publicity', 'a_other']);
  });
});

describe('replacing an image in the places chosen', () => {
  it('changes the hero, two gallery rows and the Work image, and keeps the team portrait and its alt text exactly', () => {
    const { state, uses, read } = studio();
    const before = read(state);
    const r = applyOperations(state, [replaceIn([uses.hero, uses.g1, uses.g2, uses.work])]);
    const after = read(r.state);
    // The suggested description follows the new picture; a description of the use's own stays, to check.
    expect(after.hero).toEqual({ assetId: 'a_publicity', alt: PUBLICITY });
    expect(after.rows).toEqual([{ assetId: 'a_publicity', alt: PUBLICITY }, { assetId: 'a_publicity', alt: 'Hannah sketching at her desk' }, before.rows[2]]);
    expect(after.work).toEqual({ assetId: 'a_publicity', alt: '' });
    // The deliberate exception: untouched, spaces and all.
    expect(after.team).toEqual(before.team);
    expect(after.team).toEqual({ assetId: 'a_person1', alt: '  Hannah Wells, founder  ' });
    expect((r.results[0].altReview as AltReview[]).map(({ reason, alt, path }) => [reason, alt, path])).toEqual([
      ['custom', 'Hannah sketching at her desk', ['props', 'images', 'g2', 'image']],
      ['missing', '', ['image']]
    ]);
    // Portrait 1 is still in use, in the one place left.
    expect(imageUseRows(r.state, 'a_person1').map((x) => x.what)).toEqual(['Team · Person 1: Hannah Wells']);
  });

  it('changes one gallery row and leaves its sibling showing the same image as it was', () => {
    const { state, uses, read } = studio();
    const before = read(state);
    const after = read(applyOperations(state, [replaceIn([uses.work, uses.g2, uses.hero])]).state);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[1]).toEqual({ assetId: 'a_publicity', alt: 'Hannah sketching at her desk' });
    expect([after.hero.assetId, after.work.assetId, after.team.assetId]).toEqual(['a_publicity', 'a_publicity', 'a_person1']);
  });

  it('changes a page’s sharing image or the site’s own only when chosen', () => {
    const { state, uses } = studio();
    const s = structuredClone(state);
    const homeId = s.site.homePageId;
    s.pages[homeId].seo.socialImage = 'a_person1';
    s.site.favicon = 'a_person1';
    s.site.socialImage = 'a_person1';
    const r = applyOperations(s, [replaceIn([uses.hero, { kind: 'site', field: 'favicon' }])]).state;
    expect([r.site.favicon, r.site.socialImage, r.pages[homeId].seo.socialImage]).toEqual(['a_publicity', 'a_person1', 'a_person1']);
    const workId = s.site.pageOrder.find((id) => s.pages[id].title === 'Work')!;
    s.pages[workId].seo.socialImage = 'a_person1';
    const r2 = applyOperations(s, [replaceIn([{ kind: 'pageSharing', pageId: homeId }])]).state;
    expect([r2.site.favicon, r2.site.socialImage, r2.pages[homeId].seo.socialImage, r2.pages[workId].seo.socialImage]).toEqual(['a_person1', 'a_person1', 'a_publicity', 'a_person1']);
    const r4 = applyOperations(s, [replaceIn([{ kind: 'pageSharing', pageId: workId }])]).state;
    expect([r4.pages[homeId].seo.socialImage, r4.pages[workId].seo.socialImage]).toEqual(['a_person1', 'a_publicity']);
    const r3 = applyOperations(s, [replaceIn([{ kind: 'site', field: 'socialImage' }])]).state;
    expect([r3.site.favicon, r3.site.socialImage, r3.pages[homeId].seo.socialImage]).toEqual(['a_person1', 'a_publicity', 'a_person1']);
  });

  it('replaces nothing when a chosen place no longer shows the image, or is named twice', () => {
    const { state, home, galleryId, uses } = studio();
    // Row g1 removed since the places were chosen: g2, the same image now first in the list, is not taken for it.
    const removed = applyOperations(state, [{ type: 'instance.listRemove', owner: home, nodeId: galleryId, prop: 'images', itemId: 'g1' }]).state;
    expect(() => applyOperations(removed, [replaceIn([uses.hero, uses.g1])])).toThrow(/no longer shows the image.*Nothing was replaced/);
    // Given another image meanwhile.
    const other = applyOperations(state, [{ type: 'instance.setProp', owner: home, nodeId: galleryId, prop: 'images', itemId: 'g1', field: 'image', value: { assetId: 'a_other', alt: '' } }]).state;
    expect(() => applyOperations(other, [replaceIn([uses.g1])])).toThrow(/no longer shows the image/);
    expect(() => applyOperations(state, [replaceIn([uses.g1, { ...uses.g1, path: [...uses.g1.path] }])])).toThrow(/named twice/);
    // A row by position, or a field that is not an image of it, names nothing.
    expect(() => applyOperations(state, [replaceIn([{ ...uses.g1, path: ['props', 'images', '0', 'image'] }])])).toThrow(/no longer shows the image/);
    expect(() => applyOperations(state, [replaceIn([{ kind: 'site', field: 'favicon' }])])).toThrow(/no longer shows the image/);
  });

  it('refuses a row whose ID two rows share, rather than guess which', () => {
    const { state, home, galleryId, uses } = studio();
    const s = structuredClone(state);
    ((s.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[])[1].id = 'g1';
    expect(() => applyOperations(s, [replaceIn([uses.g1])])).toThrow(/no longer shows the image/);
    // Listed apart, each by its own row, and only Replace everywhere changes them.
    const rows = imageUseRows(s, 'a_person1').filter((r) => r.what.startsWith('Gallery'));
    expect(rows.map((r) => [r.what, r.target, r.field])).toEqual([
      ['Gallery · Image 1: Studio front', null, undefined],
      ['Gallery · Image 2: At work', null, undefined]
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('never takes a row for another that shares its ID and shows a different image', () => {
    const { state, home, galleryId, uses, read } = studio();
    const s = structuredClone(state);
    // Samples (another image) now has At work's ID: At work is named by its position, and only that row is listed.
    ((s.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[])[2].id = 'g2';
    const row = imageUseRows(s, 'a_person1').find((r) => r.what.includes('At work'))!;
    expect([row.what, row.target, row.field]).toEqual(['Gallery · Image 2: At work', null, undefined]);
    expect(() => applyOperations(s, [replaceIn([uses.g2])])).toThrow(/no longer shows the image/);
    expect(read(applyOperations(s, [replaceIn([uses.g1])]).state).rows.map((i) => i.assetId)).toEqual(['a_publicity', 'a_person1', 'a_other']);
    // The same when the row sharing the ID comes first.
    const first = structuredClone(state);
    ((first.pages[home.id].nodes[galleryId] as InstanceNode).props.images as ListItem[]).unshift({ id: 'g2', image: { assetId: 'a_other', alt: '' }, caption: 'Earlier' });
    const moved = imageUseRows(first, 'a_person1').find((r) => r.what.includes('At work'))!;
    expect([moved.what, moved.target]).toEqual(['Gallery · Image 3: At work', null]);
    expect(() => applyOperations(first, [replaceIn([uses.g2])])).toThrow(/no longer shows the image/);
  });

  it('refuses places for a document, which changes wherever it is linked', () => {
    const s = structuredClone(studio().state);
    s.assets.assets.d1 = { ...image('d1', 'Menu'), kind: 'document', mime: 'application/pdf', file: 'static/assets/d1-1a2b3c4d.pdf' };
    s.assets.assets.d2 = { ...image('d2', 'Menu 2'), kind: 'document', mime: 'application/pdf', file: 'static/assets/d2-1a2b3c4d.pdf' };
    expect(() => applyOperations(s, [{ type: 'asset.replace', assetId: 'd1', withAssetId: 'd2', uses: [{ kind: 'site', field: 'favicon' }] }])).toThrow(/every place it is linked/);
  });

  it('lists only the chosen places with alt text to check, each opening its row', () => {
    const { state, home, galleryId, uses } = studio();
    const r = applyOperations(state, [replaceIn([uses.g2, uses.team])]);
    const listed = altChecks(r.state, 'a_publicity', r.results[0].altReview as AltReview[]);
    expect(listed.map(({ what, field, at }) => ({ what, field, at }))).toEqual([
      { what: 'Gallery · Image 2: At work', field: { prop: 'images', itemId: 'g2', field: 'image' }, at: { owner: home, nodeId: galleryId } },
      { what: 'Team · Person 1: Hannah Wells', field: { prop: 'people', itemId: 'p1', field: 'portrait' }, at: expect.objectContaining({ nodeId: expect.any(String) }) }
    ]);
  });
});

describe('the AI and replacing in some places', () => {
  it('says how many chosen places changed', () => {
    const { state, uses } = studio();
    const ops = [replaceIn([uses.hero, uses.g1, uses.g2])];
    const r = applyOperations(state, ops);
    expect(describeOps(ops, state, r.state, r.results)[0].label).toBe('Replaced “Portrait 1” with “Publicity 1” in 3 chosen places; check the alt text in one place');
    const two = [replaceIn([uses.hero, uses.g1])];
    expect(describeOps(two, state, applyOperations(state, two).state, applyOperations(state, two).results)[0].label).toBe('Replaced “Portrait 1” with “Publicity 1” in 2 chosen places');
    const one = [replaceIn([uses.hero])];
    expect(describeOps(one, state, applyOperations(state, one).state, applyOperations(state, one).results)[0].label).toBe('Replaced “Portrait 1” with “Publicity 1” in one chosen place');
  });

  it('is never offered uses, and is refused them', async () => {
    const apply = toolDefinitions().find((t) => t.name === 'apply_operations');
    expect(JSON.stringify(apply)).toContain('asset.replace');
    expect(JSON.stringify(apply)).not.toContain('pageSharing');
    expect(JSON.stringify(apply)).not.toContain('"uses"');
    const { state, uses } = studio();
    let applied = false;
    const host = { state: () => state, revision: () => 0, apply: async () => ((applied = true), { ok: true, revision: 1 }) } as unknown as ToolHost;
    const r = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 0, operations: [replaceIn([uses.hero])] }), host, 'c1');
    expect(r).toMatchObject({ ok: false, content: { error: 'INVALID_ARGUMENT', message: expect.stringContaining('does not take uses') } });
    expect(applied).toBe(false);
  });
});

describe('replacing in some places in the editor', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('is one step: one undo puts all five places back, one redo makes the same choice again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-replace-some-'));
    dirs.push(dir);
    const { state, uses, read } = studio();
    const session = await ProjectSession.create(dir, state);
    const before = read(session.state);
    const applied = await session.apply({ operations: [replaceIn([uses.hero, uses.g1, uses.g2, uses.work])] }, { label: 'Replace Portrait 1 in 4 places', source: 'user' });
    expect(applied.ok).toBe(true);
    const after = read(session.state);
    expect([after.hero, ...after.rows.slice(0, 2), after.work].map((v) => v.assetId)).toEqual(['a_publicity', 'a_publicity', 'a_publicity', 'a_publicity']);
    expect(after.team).toEqual(before.team);
    expect((await session.undo()).ok).toBe(true);
    expect(read(session.state)).toEqual(before);
    expect((await session.redo()).ok).toBe(true);
    expect(read(session.state)).toEqual(after);
  });

  it('applies nothing when one chosen place has gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-replace-some-'));
    dirs.push(dir);
    const { state, home, galleryId, uses, read } = studio();
    const session = await ProjectSession.create(dir, state);
    await session.apply({ operations: [{ type: 'instance.listRemove', owner: home, nodeId: galleryId, prop: 'images', itemId: 'g2' }] }, { label: 'Remove row', source: 'user' });
    const before = read(session.state);
    const applied = await session.apply({ operations: [replaceIn([uses.hero, uses.g2])] }, { label: 'Replace', source: 'user' });
    expect(applied.ok).toBe(false);
    expect(applied.error?.message).toMatch(/no longer shows the image/);
    expect(read(session.state)).toEqual(before);
  });
});
