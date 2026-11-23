import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { describeOps, InspectionLog, inspectionChecks, joinWords, pagesTouched } from '@agent/report';
import { OPERATION_SCHEMAS, type EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';

/** A project with a library photo and a second page titled お問い合わせ, as in the original report. */
function project() {
  let state = createStarterState('business', 'Test', false);
  state = applyOperations(state, [
    {
      type: 'asset.add',
      asset: { id: 'as_office', name: 'Office photo', file: 'static/assets/office-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 1000, width: 1600, height: 900, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z', altSuggestion: 'A bright office' }
    },
    { type: 'page.create', title: 'お問い合わせ', route: '/inquiries/' }
  ]).state;
  const pageId = Object.values(state.pages).find((p) => p.title === 'お問い合わせ')!.id;
  return { state, pageId, owner: { kind: 'page' as const, id: pageId } };
}

/** Apply `ops` one step at a time, as a run does, and describe them against the state before the first. */
function run(start: ProjectState, steps: Array<(s: ProjectState, results: unknown[]) => EditOperation[]>) {
  let state = start;
  const ops: EditOperation[] = [];
  const results: unknown[] = [];
  for (const step of steps) {
    const batch = step(state, results);
    const r = applyOperations(state, batch);
    state = r.state;
    ops.push(...batch);
    results.push(...r.results);
  }
  return { after: state, changes: describeOps(ops, start, state, results) };
}

const RAW = new RegExp(`\\b(${Object.keys(OPERATION_SCHEMAS).join('|').replace(/\./g, '\\.')})\\b`);

describe('change descriptions', () => {
  it('describes an image inserted and given a photo and alt text in the same request, linked to the image', () => {
    const { state, pageId, owner } = project();
    const { changes } = run(state, [
      () => [{ type: 'node.insert', owner, primitive: 'image', index: 1 }],
      (_s, results) => [{ type: 'node.setContent', owner, nodeId: (results[0] as { nodeId: string }).nodeId, field: 'image', value: { assetId: 'as_office', alt: 'Our office in the morning' } }]
    ]);
    const imageId = changes[0].nodeId;
    expect(imageId).toBeTruthy();
    expect(changes.map((c) => c.label)).toEqual(['Added image to お問い合わせ', 'Set the image (“Office photo”) and alt text of Image on お問い合わせ']);
    for (const c of changes) {
      expect(c).toMatchObject({ pageId, nodeId: imageId, owner });
      expect(c.label).not.toMatch(RAW);
    }
    // The raw operation names stay available as technical detail.
    expect(changes.map((c) => c.operations)).toEqual([['node.insert'], ['node.setContent']]);
  });

  it('names only what changed on an existing image, and merges several edits to one element', () => {
    const { state, owner } = project();
    const placed = run(state, [() => [{ type: 'node.insert', owner, primitive: 'image' }], (_s, r) => [{ type: 'node.setContent', owner, nodeId: (r[0] as { nodeId: string }).nodeId, field: 'image', value: 'as_office' }]]).after;
    const imageId = Object.values(placed.pages[owner.id].nodes).find((n) => n.kind === 'image')!.id;
    const { changes } = run(placed, [
      () => [{ type: 'node.setContent', owner, nodeId: imageId, field: 'image', value: { assetId: 'as_office', alt: 'New words' } }],
      () => [
        { type: 'node.setStyle', owner, nodeId: imageId, property: 'radius', value: '0' },
        { type: 'node.setStyle', owner, nodeId: imageId, scope: 'phone', property: 'width', value: '100%' }
      ]
    ]);
    expect(changes.map((c) => c.label)).toEqual(['Changed the alt text of Image on お問い合わせ', expect.stringMatching(/^Changed the .+ and width \(phone\) of Image on お問い合わせ$/)]);
    expect(changes[1].operations).toEqual(['node.setStyle']);
  });

  it('describes properties by their labels, and shared header edits with a link to the element', () => {
    const { state } = project();
    const header = { kind: 'shell' as const, id: 'header' };
    const nav = state.site.shell.header.rootIds[0];
    const hero = state.pages[state.site.homePageId].rootIds[0];
    const home = { kind: 'page' as const, id: state.site.homePageId };
    const { changes } = run(state, [
      () => [
        { type: 'instance.listInsert', owner: header, nodeId: nav, prop: 'links', item: { label: 'Contact', link: '/contact/' } },
        { type: 'instance.setProp', owner: home, nodeId: hero, prop: 'heading', value: 'Hello' },
        { type: 'instance.setProp', owner: home, nodeId: hero, prop: 'image', value: 'as_office' },
        { type: 'token.set', tokenId: 'color.brand', value: '#123456' },
        { type: 'site.update', name: 'New name', language: 'en' },
        { type: 'page.update', pageId: home.id, seoTitle: 'Welcome' }
      ]
    ]);
    const labels = changes.map((c) => c.label);
    expect(labels[0]).toMatch(/^Added an item to the .+ of .+ on the shared header$/);
    expect(changes[0]).toMatchObject({ owner: header, nodeId: nav });
    expect(changes[0].pageId).toBeUndefined();
    // Both property edits of the hero are one entry; the image names the photo and the alt text it brought.
    expect(labels[1]).toBe('Changed the heading, image (“Office photo”) and alt text of Split hero on Home');
    expect(changes[1]).toMatchObject({ pageId: home.id, nodeId: hero });
    expect(labels[2]).toMatch(/^Changed the site style “.+”$/);
    expect(labels[3]).toBe('Changed the site name and language');
    expect(labels[4]).toBe('Changed the search title of page Home');
    for (const l of labels) expect(l).not.toMatch(RAW);
  });

  it('keeps one entry per element when two elements have the same name, and links a copy to the copy', () => {
    const { state, pageId, owner } = project();
    const home = { kind: 'page' as const, id: state.site.homePageId };
    const hero = state.pages[home.id].rootIds[0];
    const { changes, after } = run(state, [
      () => [
        { type: 'node.insert', owner, primitive: 'image' },
        { type: 'node.insert', owner, primitive: 'image' }
      ],
      (_s, r) => [
        { type: 'node.setContent', owner, nodeId: (r[0] as { nodeId: string }).nodeId, field: 'image', value: 'as_office' },
        { type: 'node.setContent', owner, nodeId: (r[1] as { nodeId: string }).nodeId, field: 'image', value: 'as_office' },
        { type: 'node.copy', owner: home, nodeId: hero, toOwner: owner }
      ]
    ]);
    const sets = changes.filter((c) => c.operations?.includes('node.setContent'));
    expect(sets).toHaveLength(2);
    expect(new Set(sets.map((c) => c.nodeId)).size).toBe(2);
    const copy = changes.find((c) => c.operations?.includes('node.copy'))!;
    expect(copy.label).toMatch(/^Copied .+ from Home to お問い合わせ$/);
    expect(copy.pageId).toBe(pageId);
    expect(after.pages[pageId].nodes[copy.nodeId!]).toBeTruthy();
    expect(copy.nodeId).not.toBe(hero);
  });

  it('joins words the way a sentence does', () => {
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('check results', () => {
  const ok = (images?: object, issues: object[] = []) => ({ pageId: 'p', viewport: 'phone', report: { issues, ...(images ? { images } : {}) } });

  it('reports image loading next to layout fit, and an inspection that failed as unchecked', () => {
    expect(inspectionChecks(true, ok({ total: 2, loaded: 2, failed: 0, unverified: 0 }))).toEqual([
      { status: 'pass', text: 'Fits the screen at phone width.' },
      { status: 'pass', text: 'All 2 images load at phone width.' }
    ]);
    expect(inspectionChecks(true, ok({ total: 2, loaded: 1, failed: 1, unverified: 0, failedFiles: ['missing.jpg'] }))[1]).toEqual({ status: 'issue', text: 'An image failed to load at phone width (missing.jpg).' });
    expect(inspectionChecks(true, ok({ total: 1, loaded: 0, failed: 0, unverified: 1 }))[1]).toEqual({ status: 'unverified', text: "Couldn't confirm that an image loaded at phone width." });
    // Reports from before images were counted still surface a broken image.
    expect(inspectionChecks(true, ok(undefined, [{ kind: 'broken-image', message: 'x' }]))[1]).toMatchObject({ status: 'issue' });
    // No images: no image line, and no pass claimed for images that are not there.
    expect(inspectionChecks(true, ok({ total: 0, loaded: 0, failed: 0, unverified: 0 }))).toHaveLength(1);
    expect(inspectionChecks(false, { viewport: 'tablet', error: 'VALIDATION_FAILED' })).toEqual([{ status: 'unverified', text: "Couldn't check the layout at tablet width." }]);
  });

  it('says each check once, with its latest result, and names pages when several were checked', () => {
    const state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    const log = new InspectionLog();
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 0, failed: 1, unverified: 0, failedFiles: ['a.jpg'] } } });
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 1, failed: 0, unverified: 0 } } });
    expect(log.checks(state)).toEqual([
      { status: 'pass', text: 'Fits the screen at phone width.' },
      { status: 'pass', text: 'The image loads at phone width.' }
    ]);
    // A later check that could not run replaces an earlier pass: the final state is unknown.
    log.record(home, 'desktop', true, { viewport: 'desktop', report: { issues: [] } });
    log.record(home, 'desktop', false, { viewport: 'desktop' });
    log.record(about, 'phone', true, { viewport: 'phone', report: { issues: [] } });
    const texts = log.checks(state).map((c) => c.text);
    expect(texts).toEqual([`Fits the screen at phone width on ${state.pages[home].title}.`, `The image loads at phone width on ${state.pages[home].title}.`, `Couldn't check the layout at desktop width on ${state.pages[home].title}.`, `Fits the screen at phone width on ${state.pages[about].title}.`]);
  });

  it('stops vouching for a page once a later edit changes it, until it is checked again', () => {
    const state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    const log = new InspectionLog();
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 0, failed: 1, unverified: 0, failedFiles: ['old.jpg'] } } });
    log.record(about, 'phone', true, { viewport: 'phone', report: { issues: [] } });
    // The broken image was replaced afterwards: the failure no longer describes the page.
    log.invalidate(new Set([home]));
    expect(log.checks(state)).toEqual([
      { status: 'unverified', text: `Fits the screen at phone width on ${state.pages[home].title}, before later changes.` },
      { status: 'unverified', text: `An image failed to load at phone width on ${state.pages[home].title} (old.jpg), before later changes.` },
      { status: 'pass', text: `Fits the screen at phone width on ${state.pages[about].title}.` }
    ]);
    // Checked again: the latest result stands.
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 1, failed: 0, unverified: 0 } } });
    expect(log.checks(state).slice(0, 2).map((c) => c.status)).toEqual(['pass', 'pass']);
    // A site-wide change reaches every page.
    log.invalidate('all');
    expect(log.checks(state).every((c) => c.status === 'unverified')).toBe(true);
  });

  it('knows which pages an edit can change', () => {
    const state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    const page = (id: string) => ({ kind: 'page' as const, id });
    const node = state.pages[home].rootIds[0];
    expect(pagesTouched([{ type: 'node.setStyle', owner: page(home), nodeId: node, property: 'gap', value: '1rem' }])).toEqual(new Set([home]));
    expect(pagesTouched([{ type: 'node.copy', owner: page(home), nodeId: node, toOwner: page(about) }])).toEqual(new Set([home, about]));
    expect(pagesTouched([{ type: 'page.create', title: 'New' }])).toEqual(new Set());
    expect(pagesTouched([{ type: 'page.create', title: 'New', addToNavigation: true }])).toBe('all');
    expect(pagesTouched([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: 'n', prop: 'x', value: 1 }])).toBe('all');
    expect(pagesTouched([{ type: 'token.set', tokenId: 'color.brand', value: '#000' }])).toBe('all');
  });
});
