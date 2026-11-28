/**
 * A collection's archive layout (#1348): its index is a public page from the start, with no entry yet, so what the
 * layout shows is checked before an export as a page's is: its links to drafts stop the website export, its forms
 * visitors cannot send are listed, its Netlify form names are told apart from the rest of the site's, and Site search
 * placed in it is offered to AI agents.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { formNameDiagnostics, validateState, websiteFormNotes, websiteFormProblems } from '@engine/validate';
import { describeDraftLink, netlifyFormClashes, publicationPlan } from '@generator/checks';
import { generateProject } from '@generator/index';
import { showsSiteSearch } from '@generator/webmcp';
import { draftLinksStop, formNameWarnings } from '../../src/main/export';
import { withSupportedForm } from './fixtures/webmcp-designs';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const ARCHIVE: OwnerRef = { kind: 'archive', id: 'notes' };
const LAYOUT: OwnerRef = { kind: 'template', id: 'notes' };

/** The issue's project: a draft page Soon, and a Notes collection with an index layout of its own and no entry yet. */
function notes(pages: { detail: boolean; archive: boolean } = { detail: true, archive: true }): ProjectState {
  return run(
    createStarterState('business', 'Test Studio', false),
    { type: 'page.create', pageId: 'pg_soon', title: 'Soon', route: '/soon/' },
    { type: 'page.update', pageId: 'pg_soon', draft: true },
    { type: 'collection.create', collectionId: 'notes', name: 'Notes', kind: 'editorial', route: '/notes/', pages },
    { type: 'collection.update', collectionId: 'notes', archiveTemplate: 'start' }
  );
}

/** A Call to action banner at the end of a tree, its button leading to the draft page Soon. */
const withBanner = (s: ProjectState, owner: OwnerRef = ARCHIVE) =>
  run(
    s,
    { type: 'node.insert', newNodeId: 'n_soonbanner', owner, parentId: null, componentId: 'cta.banner' },
    { type: 'instance.setProp', owner, nodeId: 'n_soonbanner', prop: 'primaryLabel', value: 'Coming soon' },
    { type: 'instance.setProp', owner, nodeId: 'n_soonbanner', prop: 'primaryLink', value: { type: 'page', target: 'pg_soon' } }
  );

/** A contact form at the end of a tree, as inserted (its service setting left blank), with these settings. */
const withForm = (s: ProjectState, owner: OwnerRef, nodeId: string, props: Record<string, unknown> = {}) =>
  run(s, { type: 'node.insert', newNodeId: nodeId, owner, parentId: null, componentId: 'contact.form' }, ...Object.entries(props).map(([prop, value]): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop, value })));

const at = (o: { owner?: { kind: string; id: string }; nodeId?: string }) => `${o.owner?.kind}:${o.owner?.id}:${o.nodeId}`;

describe('a link to a draft in a collection’s archive layout', () => {
  it('stops the website export while the collection has no entry, naming the layout', () => {
    const s = withBanner(notes());
    // The index is published, with the banner's link to the draft in it.
    expect(generateProject(s).get('src/routes/notes/+page.svelte')).toContain('/soon/');
    const links = publicationPlan(s).draftLinks.filter((l) => l.owner.kind === 'archive');
    expect(links).toEqual([expect.objectContaining({ owner: ARCHIVE, nodeId: 'n_soonbanner', pageId: 'pg_soon', label: 'Coming soon' })]);
    expect(describeDraftLink(s, links[0])).toMatch(/^Notes archive layout · .+: “Coming soon” goes to Soon \(\/soon\/\)$/);
    const stop = draftLinksStop(s)!;
    expect(stop.message).toBe('A collection layout links to Soon, which is a draft and is left out of the website. Change the link or publish the page, then export again.');
    expect(stop.warnings).toEqual([describeDraftLink(s, links[0])]);
    // Publishing the page clears it.
    expect(draftLinksStop(run(s, { type: 'page.update', pageId: 'pg_soon', draft: false }))).toBeNull();
  });

  it('says nothing while the collection shows no archive pages, or shows the ready-made cards', () => {
    const s = withBanner(notes());
    const cards = run(s, { type: 'collection.update', collectionId: 'notes', archiveTemplate: null });
    expect(publicationPlan(cards).draftLinks.filter((l) => l.owner.kind === 'archive')).toEqual([]);
    // Archive pages turned off with the layout kept: no index shows it.
    const off = structuredClone(s);
    off.collections.notes.settings.pages = { detail: true, archive: false };
    expect(generateProject(off).has('src/routes/notes/+page.svelte')).toBe(false);
    expect(publicationPlan(off).draftLinks.filter((l) => l.owner.kind === 'archive')).toEqual([]);
  });

  it('is still counted beside the entry layout’s own link once an entry is published', () => {
    let s = withBanner(withBanner(notes()), LAYOUT);
    s = run(s, { type: 'entry.create', collectionId: 'notes', entryId: 'en_first', title: 'First note', publishedAt: '2026-01-01', draft: false, body: ['First.'] } as EditOperation);
    const owners = publicationPlan(s).draftLinks.filter((l) => l.nodeId === 'n_soonbanner').map((l) => l.owner);
    expect(owners).toEqual(expect.arrayContaining([ARCHIVE, LAYOUT]));
    expect(owners.filter((o) => o.kind === 'archive')).toHaveLength(1);
  });
});

describe('a contact form visitors cannot send, in a collection’s archive layout', () => {
  it('is listed before an export, in Project health’s words, while the collection has no entry', () => {
    const s = withForm(notes(), ARCHIVE, 'n_noteform');
    const health = validateState(s).filter((d) => d.code === 'FORM_UNCONNECTED' && d.nodeId === 'n_noteform');
    expect(health.map(at)).toEqual(['archive:notes:n_noteform']);
    expect(health[0].message).toMatch(/^Notes archive layout: the contact form is not connected to a form service/);
    expect(websiteFormProblems(s).filter((d) => d.nodeId === 'n_noteform')).toEqual(health);
    expect(websiteFormNotes(s).filter((n) => n.destination?.kind === 'form' && n.destination.nodeId === 'n_noteform')).toEqual([
      { message: health[0].message, destination: { kind: 'form', owner: ARCHIVE, nodeId: 'n_noteform', setting: 'connection' } }
    ]);
  });

  it('is left out while no archive page shows the layout', () => {
    const s = withForm(notes(), ARCHIVE, 'n_noteform');
    const cards = run(s, { type: 'collection.update', collectionId: 'notes', archiveTemplate: null });
    expect(websiteFormProblems(cards).filter((d) => d.nodeId === 'n_noteform')).toEqual([]);
    const off = structuredClone(s);
    off.collections.notes.settings.pages = { detail: true, archive: false };
    expect(websiteFormProblems(off).filter((d) => d.nodeId === 'n_noteform')).toEqual([]);
  });
});

describe('contact forms in collection layouts that send to Netlify under one name', () => {
  it('flag an archive layout’s form clashing with a page’s', () => {
    let s = withForm(notes(), ARCHIVE, 'n_noteform', { provider: 'netlify' });
    s = withForm(s, { kind: 'page', id: s.site.homePageId }, 'n_homeform', { provider: 'netlify' });
    const clash = netlifyFormClashes(s).find((c) => c.name === 'contact')!;
    expect(clash.forms.map(at)).toEqual(expect.arrayContaining([`page:${s.site.homePageId}:n_homeform`, 'archive:notes:n_noteform']));
    expect(formNameDiagnostics(s).map(at)).toEqual(expect.arrayContaining([`page:${s.site.homePageId}:n_homeform`, 'archive:notes:n_noteform']));
    const warning = formNameWarnings(s).find((w) => w.includes('“contact”'))!;
    expect(warning).toContain('the Notes archive layout');
    expect(warning).not.toContain('a page');
  });

  it('flag an entry layout’s form while an entry is published', () => {
    let s = withForm(notes(), LAYOUT, 'n_layoutform', { provider: 'netlify', formName: 'notes' });
    s = withForm(s, ARCHIVE, 'n_noteform', { provider: 'netlify', formName: 'notes' });
    // No entry: only the index shows a form, once.
    expect(netlifyFormClashes(s).filter((c) => c.name === 'notes')).toEqual([]);
    s = run(s, { type: 'entry.create', collectionId: 'notes', entryId: 'en_first', title: 'First note', publishedAt: '2026-01-01', draft: false, body: ['First.'] } as EditOperation);
    const clash = netlifyFormClashes(s).find((c) => c.name === 'notes')!;
    expect(clash.forms.map(at).sort()).toEqual(['archive:notes:n_noteform', 'template:notes:n_layoutform']);
    expect(formNameWarnings(s).find((w) => w.includes('“notes”'))).toContain('the Notes layout');
  });
});

describe('Site search placed only in a collection’s archive layout', () => {
  it('is offered to agents from the website’s layout', () => {
    let s = run(withSupportedForm(notes()), { type: 'node.insert', owner: ARCHIVE, componentId: 'site.search' }, { type: 'site.update', webmcp: true });
    expect(showsSiteSearch(s)).toBe(true);
    expect(generateProject(s).get('src/routes/+layout.svelte')).toContain('onMount(() => offerSearch(resolve));');
    // Back to the ready-made cards, the box is on no page.
    s = run(s, { type: 'collection.update', collectionId: 'notes', archiveTemplate: null });
    expect(showsSiteSearch(s)).toBe(false);
  });
});
