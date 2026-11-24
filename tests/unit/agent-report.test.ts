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
  it('names both address changes, the address kept working and the menu links to check when a page becomes Home (#37)', () => {
    const start = createStarterState('business', 'Test', false);
    const about = Object.values(start.pages).find((p) => p.title === 'About')!.id;
    const { changes } = run(start, [() => [{ type: 'page.setHome', pageId: about }]]);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toBe(
      'Made About the home page: “About” moved from /about/ to / and “Home” moved from / to /home/. /about/ still works and sends visitors to “About”. Check the header and footer links “Home” and “About”: they keep their words and go to the new addresses.'
    );
    expect(changes[0].label).not.toMatch(RAW);
    const declined = run(start, [() => [{ type: 'page.setHome', pageId: about, keepOldAddress: false }]]).changes[0].label;
    expect(declined).not.toContain('still works');
    // A page given the address later in the run takes it over: the report does not promise the redirect.
    const claimed = run(start, [() => [{ type: 'page.setHome', pageId: about }], () => [{ type: 'page.create', title: 'Team', route: '/about/' }]]).changes[0].label;
    expect(claimed).toContain('“About” moved from /about/ to /');
    expect(claimed).not.toContain('still works');
    // Each promotion is described by its own moves, not by where the pages ended up after the run.
    const twice = run(start, [() => [{ type: 'page.setHome', pageId: about }], () => [{ type: 'page.setHome', pageId: start.site.homePageId }]]).changes.map((c) => c.label);
    // /about/ was About's again by the end, so the first promotion no longer claims it still sends visitors on.
    expect(twice[0]).toBe('Made About the home page: “About” moved from /about/ to / and “Home” moved from / to /home/. Check the header and footer links “Home” and “About”: they keep their words and go to the new addresses.');
    expect(twice[1]).toMatch(/^Made Home the home page: “Home” moved from \/home\/ to \/ and “About” moved from \/ to \/about\/\. \/home\/ still works/);
  });

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
        { type: 'node.setStyle', owner, nodeId: imageId, scope: 'base', property: 'radius', value: '0' },
        { type: 'node.setStyle', owner, nodeId: imageId, scope: 'phone', property: 'width', value: '100%' }
      ]
    ]);
    expect(changes.map((c) => c.label)).toEqual(['Changed the alt text of Image on お問い合わせ', 'Changed the corner radius and width (phone) of Image on お問い合わせ']);
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
        { type: 'instance.listInsert', owner: header, nodeId: nav, prop: 'links', item: { label: 'About', link: '/about/' } },
        { type: 'instance.setProp', owner: home, nodeId: hero, prop: 'heading', value: 'Hello' },
        { type: 'instance.setProp', owner: home, nodeId: hero, prop: 'image', value: 'as_office' },
        { type: 'token.set', tokenId: 'color.brand', value: '#123456' },
        { type: 'site.update', name: 'New name', language: 'en' },
        { type: 'page.update', pageId: home.id, seoTitle: 'Welcome' }
      ]
    ]);
    const labels = changes.map((c) => c.label);
    // Two links added to the menu are one entry that counts them, named by the property's label.
    expect(labels[0]).toMatch(/^Added 2 items to the navigation of .+ on the shared header$/);
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
    // The link goes to the new copy: the page's newest section, built from the same component as the hero.
    const copied = after.pages[pageId].nodes[copy.nodeId!];
    expect(copy.nodeId).not.toBe(hero);
    expect(state.pages[pageId].nodes[copy.nodeId!]).toBeUndefined();
    expect(copied).toMatchObject({ kind: 'instance', definitionId: (state.pages[home.id].nodes[hero] as { definitionId: string }).definitionId });
  });

  it('names a component part in a style edit, so two parts are two details', () => {
    const { state } = project();
    const home = { kind: 'page' as const, id: state.site.homePageId };
    const hero = state.pages[home.id].rootIds[0];
    const def = state.components[(state.pages[home.id].nodes[hero] as { definitionId: string }).definitionId];
    const parts = Object.entries(def.parts).filter(([id]) => id !== 'root').slice(0, 2);
    expect(parts).toHaveLength(2);
    const { changes } = run(state, [() => parts.map(([partId]) => ({ type: 'node.setStyle' as const, owner: home, nodeId: hero, partId, scope: 'base' as const, property: 'paddingBlock', value: '1rem' }))]);
    expect(changes).toHaveLength(1);
    for (const [, part] of parts) expect(changes[0].label).toContain(part.label.toLowerCase());
  });

  it('reads an image bound to a component property from the property, so an alt-only edit says only that', () => {
    let { state } = project();
    const home = { kind: 'page' as const, id: state.site.homePageId };
    const hero = state.pages[home.id].rootIds[0];
    // A project copy of the hero, whose image node shows the "image" property.
    state = applyOperations(state, [{ type: 'component.makeUnique', owner: home, nodeId: hero, name: 'My hero' }]).state;
    const def = Object.values(state.components).find((d) => d.name === 'My hero')!;
    state = applyOperations(state, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'image', schema: { ...def.properties.image, default: { assetId: 'as_office', alt: 'Old words' } } }]).state;
    const owner = { kind: 'component' as const, id: def.id };
    const image = Object.values(state.components[def.id].tree!.nodes).find((n) => n.kind === 'image')!;
    const { changes } = run(state, [() => [{ type: 'node.setContent', owner, nodeId: image.id, field: 'image', value: { assetId: 'as_office', alt: 'New words' } }]]);
    expect(changes.map((c) => c.label)).toEqual(['Changed the alt text of Image on the “My hero” component']);
    expect(changes[0]).toMatchObject({ owner, definitionId: def.id, nodeId: image.id });
  });

  it('joins words the way a sentence does', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('names the properties a source update renames', () => {
    const start = createStarterState('business', 'Test', false);
    const created = applyOperations(start, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { label: { type: 'string', label: 'Label' } } }]);
    const definitionId = created.results[0].definitionId as string;
    const update = (renames?: Array<{ from: string; to: string }>): EditOperation => ({
      type: 'component.updateSource',
      definitionId,
      source: '<p>y</p>\n',
      properties: { caption: { type: 'string', label: 'Caption' } },
      ...(renames ? { renames } : {})
    });
    expect(run(created.state, [() => [update([{ from: 'label', to: 'caption' }])]]).changes[0].label).toBe('Updated the code of the “Note” component and renamed “label” to “caption”');
    expect(run(created.state, [() => [update()]]).changes[0].label).toBe('Updated the code of the “Note” component');
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
    expect(inspectionChecks(true, ok({ total: 3, loaded: 1, failed: 1, unverified: 1, failedFiles: ['gone.jpg'] }))[1]).toEqual({ status: 'issue', text: 'An image failed to load at phone width (gone.jpg). 1 other could not be checked.' });
    // The measured widths decide fit even when the capped issue list kept no overflow entry.
    const wide = { pageId: 'p', viewport: 'phone', report: { issues: Array(40).fill({ kind: 'broken-image' }), documentWidth: 600, viewportWidth: 390 } };
    expect(inspectionChecks(true, wide)[0]).toEqual({ status: 'issue', text: 'Content is wider than the screen at phone width.' });
    // A pixel of rounding is not overflow.
    expect(inspectionChecks(true, { ...wide, report: { issues: [], documentWidth: 391, viewportWidth: 390 } })[0].status).toBe('pass');
    // Reports from before images were counted still surface a broken image.
    expect(inspectionChecks(true, ok(undefined, [{ kind: 'broken-image', message: 'x' }]))[1]).toMatchObject({ status: 'issue' });
    // No images: no image line, and no pass claimed for images that are not there.
    expect(inspectionChecks(true, ok({ total: 0, loaded: 0, failed: 0, unverified: 0 }))).toHaveLength(1);
    expect(inspectionChecks(false, { viewport: 'tablet', error: 'VALIDATION_FAILED' })).toEqual([{ status: 'unverified', text: "Couldn't check the layout at tablet width." }]);
  });

  it('says each check once, with its latest result, naming its page', () => {
    let state = createStarterState('business', 'Test', false);
    const [home, about, contact] = state.site.pageOrder;
    const log = new InspectionLog();
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 0, failed: 1, unverified: 0, failedFiles: ['a.jpg'] } } });
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [], images: { total: 1, loaded: 1, failed: 0, unverified: 0 } } });
    expect(log.checks(state)).toEqual([
      { status: 'pass', text: 'Fits the screen at phone width on Home.' },
      { status: 'pass', text: 'The image loads at phone width on Home.' }
    ]);
    // A later check that could not run replaces an earlier pass (with a report): the final state is unknown.
    log.record(home, 'desktop', true, { viewport: 'desktop', report: { issues: [] } });
    log.record(home, 'desktop', false, { viewport: 'desktop', report: { issues: [] } });
    log.record(about, 'phone', true, { viewport: 'phone', report: { issues: [] } });
    log.record(contact, 'phone', true, { viewport: 'phone', report: { issues: [] } });
    // A page removed after its check has nothing left to report.
    state = applyOperations(state, [{ type: 'page.remove', pageId: contact, replacementPageId: home }]).state;
    expect(log.checks(state).map((c) => c.text)).toEqual(['Fits the screen at phone width on Home.', 'The image loads at phone width on Home.', "Couldn't check the layout at desktop width on Home.", `Fits the screen at phone width on ${state.pages[about].title}.`]);
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
    const all = log.checks(state);
    expect(all).toHaveLength(3);
    expect(all.every((c) => c.status === 'unverified')).toBe(true);
  });

  it('knows which pages an edit can change', () => {
    const state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    const page = (id: string) => ({ kind: 'page' as const, id });
    const node = state.pages[home].rootIds[0];
    expect(pagesTouched([{ type: 'node.setStyle', owner: page(home), nodeId: node, scope: 'base', property: 'gap', value: '1rem' }])).toEqual(new Set([home]));
    // A copy changes only the page it lands on.
    expect(pagesTouched([{ type: 'node.copy', owner: page(home), nodeId: node, toOwner: page(about) }])).toEqual(new Set([about]));
    expect(pagesTouched([{ type: 'node.paste', clipboardId: 'c', toOwner: page(home) }])).toEqual(new Set([home]));
    // A new Home moves header and footer links on every page.
    expect(pagesTouched([{ type: 'page.setHome', pageId: home }])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: about, seoTitle: 'x' }, { type: 'page.setHome', pageId: home }])).toBe('all');
    // A removed page's card leaves page lists on other pages.
    expect(pagesTouched([{ type: 'page.remove', pageId: about }, { type: 'page.reorder', pageIds: [about, home] }])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: about, seoTitle: 'x' }, { type: 'page.reorder', pageIds: [about, home] }])).toEqual(new Set([about]));
    expect(pagesTouched([{ type: 'page.create', title: 'New' }])).toEqual(new Set());
    expect(pagesTouched([{ type: 'page.create', title: 'New', addToNavigation: true }])).toBe('all');
    expect(pagesTouched([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: 'n', prop: 'x', value: 1 }])).toBe('all');
    expect(pagesTouched([{ type: 'token.set', tokenId: 'color.brand', value: '#000' }])).toBe('all');
  });
});
