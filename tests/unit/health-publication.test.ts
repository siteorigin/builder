/**
 * What Project health says about the published website before an export does (#1633): links on it to drafts, which
 * stop the website export; the starter's sample contact details still on it, which the Export dialog reviews; and
 * images it shows as empty placeholder boxes. The status bar counts all three with the rest of the project's findings.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState } from '@shared/types';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState, type Diagnostic } from '@engine/validate';
import { describeDraftLink, publicationPlan, unfilledImages } from '@generator/checks';
import { draftLinksStop } from '../../src/main/export';
import { destinationForDiagnostic } from '../../src/renderer/src/lib/destinations';
import { healthNotes } from '../../src/renderer/src/lib/export-summary';
import { sampleContactMatches } from '../../src/renderer/src/lib/find-content';
import { healthDiagnostics, sampleDiagnostics, sampleKindOf } from '../../src/renderer/src/lib/sample-review';
import { P, item, prop } from '@catalogue/dsl';
import { projectDesign, type DesignSpec } from './fixtures/packs';
import { SPLIT_HERO, TEAM } from './fixtures/image-drop-designs';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const of = (s: ProjectState, code: string) => validateState(s).filter((d) => d.code === code);

/** A business site with a draft page Soon and a blog: a published post, and a draft one. */
function site(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', true),
    { type: 'site.update', baseUrl: 'https://example.com' },
    { type: 'page.create', pageId: 'pg_soon', title: 'Soon', route: '/soon/' },
    { type: 'page.update', pageId: 'pg_soon', draft: true },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', publishedAt: '2026-01-12', draft: false, body: ['Bring an apron.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-04-01', body: ['Not yet.'] }
  );
}

/** A Call to action banner at the end of a tree, its button leading where `link` says. */
const banner = (s: ProjectState, owner: OwnerRef, nodeId: string, link: unknown) =>
  run(
    s,
    { type: 'node.insert', newNodeId: nodeId, owner, parentId: null, componentId: 'cta.banner' },
    { type: 'instance.setProp', owner, nodeId, prop: 'primaryLabel', value: 'Coming soon' },
    { type: 'instance.setProp', owner, nodeId, prop: 'primaryLink', value: link }
  );

describe('links on the published website to drafts', () => {
  it('are problems in Project health, the same links the website export stops on, and never stop a save', () => {
    const start = site();
    const home = start.site.homePageId;
    const s = banner(start, { kind: 'page', id: home }, 'n_soon', { type: 'page', target: 'pg_soon' });
    const found = of(s, 'LINK_TO_DRAFT');
    expect(found).toEqual([expect.objectContaining({ severity: 'error', owner: { kind: 'page', id: home }, nodeId: 'n_soon' })]);
    expect(found[0].message).toBe(`${describeDraftLink(s, publicationPlan(s).draftLinks[0])}, a draft the website leaves out. The website export stops until the link is changed or the page is published.`);
    expect(draftLinksStop(s)).not.toBeNull();
    // A content error: a save, an edit or an import that brings one in is never refused for it.
    expect(found.some(blocksSaving)).toBe(false);
    // On a page, the row shows the element itself.
    expect(destinationForDiagnostic(s, found[0])).toBeNull();
    // Publishing the page clears it, as it clears the export's stop.
    const published = run(s, { type: 'page.update', pageId: 'pg_soon', draft: false });
    expect(of(published, 'LINK_TO_DRAFT')).toEqual([]);
    expect(draftLinksStop(published)).toBeNull();
  });

  it('include a typed address on the public URL, the shared footer, and a published entry’s text, each opening where it is', () => {
    let s = banner(site(), { kind: 'shell', id: 'footer' }, 'n_typed', { type: 'url', target: 'https://example.com/soon/' });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](entry:en_secret).'] });
    const found = of(s, 'LINK_TO_DRAFT');
    expect(found.map((d) => [d.owner, d.nodeId])).toEqual(
      expect.arrayContaining([
        [{ kind: 'shell', id: 'footer' }, 'n_typed'],
        [{ kind: 'entry', id: 'en_winter' }, undefined]
      ])
    );
    expect(found).toHaveLength(publicationPlan(s).draftLinks.length);
    const inText = found.find((d) => d.owner?.kind === 'entry')!;
    expect(inText.message).toContain('goes to Secret plans');
    expect(inText.message).toContain('or the entry is published.');
    expect(destinationForDiagnostic(s, inText)).toEqual({ kind: 'entry', collectionId: 'posts', entryId: 'en_winter', field: 'body' });
    // Two links in one node, or in one entry's text, are two problems: each has a place of its own.
    expect(new Set(found.map((d) => d.site)).size).toBe(found.length);
  });

  it('in a collection’s layout open the layout on the entry whose page shows the link', () => {
    const s = banner(site(), { kind: 'template', id: 'posts' }, 'n_layout', { type: 'page', target: 'pg_soon' });
    const found = of(s, 'LINK_TO_DRAFT').filter((d) => d.owner?.kind === 'template');
    expect(found).toHaveLength(1);
    expect(destinationForDiagnostic(s, found[0])).toEqual({ kind: 'element', owner: { kind: 'template', id: 'posts' }, nodeId: 'n_layout', entryId: 'en_winter' });
  });

  it('are left out of the Export dialog’s count of other notes, since the dialog lists them itself', () => {
    const start = site();
    const s = banner(start, { kind: 'page', id: start.site.homePageId }, 'n_soon', { type: 'page', target: 'pg_soon' });
    const diagnostics = validateState(s);
    const without = diagnostics.filter((d) => d.code !== 'LINK_TO_DRAFT');
    expect(healthNotes({ seo: [], diagnostics, shown: [] })).toEqual(healthNotes({ seo: [], diagnostics: without, shown: [] }));
  });
});

describe('images the published website shows as empty placeholder boxes', () => {
  it('are warnings for the starter’s sections with no picture chosen, and none once pictures are', () => {
    const empty = createStarterState('business', 'Riverside Studio', false);
    const found = of(empty, 'IMAGE_UNFILLED');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.severity === 'warning')).toBe(true);
    expect(found.map((d) => d.message)).toContain(`${empty.pages[empty.site.homePageId].title}: Split hero shows an image with no picture chosen, so visitors see an empty placeholder box. Choose a picture for it, or remove it.`);
    // Each leads to its placement on the page.
    const hero = found.find((d) => d.message.includes('Split hero'))!;
    expect(empty.pages[empty.site.homePageId].nodes[hero.nodeId!]?.kind).toBe('instance');
    expect(of(createStarterState('business', 'Riverside Studio', true), 'IMAGE_UNFILLED')).toEqual([]);
  });

  it('leave out a code section whose markup shows its image only once it has one', () => {
    const s = createStarterState('blank', 'Studio', true);
    const owner: OwnerRef = { kind: 'page', id: s.site.homePageId };
    const placed = run(s, { type: 'node.insert', newNodeId: 'n_hero', owner, parentId: null, componentId: 'hero.split' }, { type: 'node.insert', newNodeId: 'n_feature', owner, parentId: null, componentId: 'block.feature' });
    // A Split hero shows its image whatever it is; a Feature shows its image only while it has one (`{#if has(image)}`).
    expect(of(placed, 'IMAGE_UNFILLED').map((d) => d.nodeId)).toEqual(['n_hero']);
  });

  it('leave out drafts, images hidden while empty, decorative and filled ones', () => {
    const s = createStarterState('blank', 'Studio', true);
    const hero = projectDesign(s, SPLIT_HERO).id;
    const team = projectDesign(s, TEAM).id;
    const home: OwnerRef = { kind: 'page', id: s.site.homePageId };
    let t = run(
      s,
      { type: 'node.insert', newNodeId: 'n_hero', owner: home, parentId: null, definitionId: hero },
      // People with no portrait show none: the design hides the image while it is empty.
      { type: 'node.insert', newNodeId: 'n_team', owner: home, parentId: null, definitionId: team },
      { type: 'page.create', pageId: 'pg_soon', title: 'Soon', route: '/soon/' },
      { type: 'page.update', pageId: 'pg_soon', draft: true },
      { type: 'node.insert', newNodeId: 'n_hidden', owner: { kind: 'page', id: 'pg_soon' }, parentId: null, definitionId: hero }
    );
    expect(of(t, 'IMAGE_UNFILLED').map((d) => [d.owner?.id, d.nodeId])).toEqual([[home.id, 'n_hero']]);
    expect(unfilledImages(t, t.pages.pg_soon)).toHaveLength(1);
    // Publishing the draft brings its image in.
    expect(of(run(t, { type: 'page.update', pageId: 'pg_soon', draft: false }), 'IMAGE_UNFILLED')).toHaveLength(2);
    // Decorative, or with a picture: no box.
    const asset = { id: 'img_studio', name: 'Studio', file: 'static/assets/img_studio.png', mime: 'image/png', bytes: 1000, width: 1200, height: 800, hash: 'img_studio', kind: 'image' as const, createdAt: '2026-11-24T09:00:00.000Z' };
    t = run(t, { type: 'asset.add', asset });
    t = run(t, { type: 'instance.setProp', owner: home, nodeId: 'n_hero', prop: 'image', value: { assetId: null, alt: '', decorative: true } });
    expect(of(t, 'IMAGE_UNFILLED')).toEqual([]);
    t = run(t, { type: 'instance.setProp', owner: home, nodeId: 'n_hero', prop: 'image', value: { assetId: asset.id, alt: 'A studio' } });
    expect(of(t, 'IMAGE_UNFILLED')).toEqual([]);
  });

  it('report each empty item of a list once, and a portrait the design always shows', () => {
    const SHOWN: DesignSpec = {
      ...TEAM,
      componentId: 'project.team-shown',
      name: 'Team shown',
      build: (b) => b.el('root', 'section', { name: 'Section' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.repeat('members', 'people', [b.el('member', 'div', { name: 'Person' }, [b.image('portrait', item('portrait'), { name: 'Portrait' })])])])
    };
    const s = createStarterState('blank', 'Studio', true);
    const shown = projectDesign(s, SHOWN).id;
    const home: OwnerRef = { kind: 'page', id: s.site.homePageId };
    const t = run(s, { type: 'node.insert', newNodeId: 'n_team', owner: home, parentId: null, definitionId: shown });
    const found = of(t, 'IMAGE_UNFILLED');
    expect(found).toHaveLength(3);
    expect(found[0].message).toBe('Home: Team shown shows “Portrait” for “Hannah Wells” with no picture chosen, so visitors see an empty placeholder box. Choose a picture for it, or remove it.');
    expect(new Set(found.map((d) => d.site)).size).toBe(3);
    void P;
  });
});

describe('the starter’s sample contact details in Project health', () => {
  /** A business site whose publisher, in Site settings, is still given the sample details. */
  const withIdentity = () => run(createStarterState('business', 'Riverside Studio', true), { type: 'site.update', identity: { kind: 'Organization', email: SAMPLE_CONTACT.email, telephone: '+1 (555) 0134', address: SAMPLE_CONTACT.address } } as EditOperation);

  it('finds a sample detail in Site settings as well as on the pages', () => {
    const blank = run(createStarterState('blank', 'Studio', true), { type: 'site.update', identity: { kind: 'Organization', email: SAMPLE_CONTACT.email } } as EditOperation);
    const groups = sampleContactMatches(blank);
    expect(groups).toEqual([expect.objectContaining({ kind: 'email', value: SAMPLE_CONTACT.email, matches: [], identity: 'email' })]);
    const all = sampleContactMatches(withIdentity());
    expect(all.map((g) => [g.kind, g.identity])).toEqual([
      ['email', 'email'],
      ['phone', 'telephone'],
      ['address', 'address']
    ]);
    // Another address in Site settings is not the sample.
    expect(sampleContactMatches(run(blank, { type: 'site.update', identity: { kind: 'Organization', email: 'hello@example.com.au' } } as EditOperation))).toEqual([]);
  });

  it('is one warning for each detail not kept, and keeping one takes its warning away', () => {
    const s = withIdentity();
    const groups = sampleContactMatches(s);
    const warned = sampleDiagnostics(groups, []);
    expect(warned.map((d) => [d.severity, d.code, sampleKindOf(d)])).toEqual([
      ['warning', 'SAMPLE_CONTACT', 'email'],
      ['warning', 'SAMPLE_CONTACT', 'phone'],
      ['warning', 'SAMPLE_CONTACT', 'address']
    ]);
    expect(warned[0].message).toMatch(/^Sample email address: hello@example\.com came with the starter and is still on the website \(.+, and in Site settings, under Published by\)/);
    expect(sampleDiagnostics(groups, [SAMPLE_CONTACT.email]).map(sampleKindOf)).toEqual(['phone', 'address']);
  });

  it('is counted with the project’s own findings, the same list while nothing changes', () => {
    const s = withIdentity();
    const own: Diagnostic[] = [{ severity: 'error', code: 'X', message: 'x' }];
    const kept: string[] = [];
    const all = healthDiagnostics(s, own, kept);
    expect(all.slice(0, 1)).toEqual(own);
    expect(all.filter((d) => d.code === 'SAMPLE_CONTACT')).toHaveLength(3);
    expect(healthDiagnostics(s, own, kept)).toBe(all);
    // A detail kept on purpose leaves the list; all three kept, the project's own findings are all there is.
    expect(healthDiagnostics(s, own, [SAMPLE_CONTACT.email]).filter((d) => d.code === 'SAMPLE_CONTACT')).toHaveLength(2);
    expect(healthDiagnostics(s, own, groupsValues(s))).toBe(own);
  });
});

const groupsValues = (s: ProjectState) => sampleContactMatches(s).map((g) => g.value);
