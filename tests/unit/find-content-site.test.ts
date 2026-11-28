import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { contentFields, contentTarget, entryTarget, findContent, planReplace, type ContentMatch } from '../../src/renderer/src/lib/find-content';

const NAME = 'Quill Harbour';
const starter = () => createStarterState('business', NAME, false);
/** Every time the site and page documents say `text`, as stored. */
const stored = (s: ProjectState, text: string) => (JSON.stringify({ site: s.site, pages: s.pages }).match(new RegExp(text, 'g')) ?? []).length;
const siteName = (m: ContentMatch) => m.field.setting?.kind === 'site' && m.field.setting.field === 'name';
const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
const pageAt = (s: ProjectState, route: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === route)!;
const replaced = (s: ProjectState, ms: ContentMatch[], replacement: string) => {
  const plan = planReplace(s, ms, replacement);
  expect(plan.error).toBeUndefined();
  return { plan, after: applyOperations(s, plan.operations).state };
};

describe('site details and search settings (#1494)', () => {
  it('finds the name everywhere a starter writes it: the site details first, each page’s search settings with the page', () => {
    const s = starter();
    const ms = findContent(s, NAME);
    expect(ms).toHaveLength(stored(s, NAME));
    const settings = ms.filter((m) => m.field.setting).map((m) => [m.field.where, m.field.section, m.field.label]);
    expect(settings).toEqual([
      ['Site details', 'Site details', 'Site name'],
      ['Site details', 'Site details', 'Default description'],
      ['Home', 'Search & sharing', 'Search description'],
      ['About', 'Search & sharing', 'Search description'],
      ['Contact', 'Search & sharing', 'Search description']
    ]);
    expect(ms[0].field.owner).toEqual({ kind: 'site', id: 'site' });
    // A page's search settings come after its content, in the page's own group.
    const about = ms.filter((m) => m.field.owner.kind === 'page' && m.field.owner.id === pageAt(s, '/about/').id);
    expect(about.at(-1)!.field.label).toBe('Search description');
    expect(ms.every((m) => !m.blocked)).toBe(true);
    // Each opens where it is set by hand, not on the canvas.
    expect(ms[0].field.destination).toEqual({ kind: 'site', field: 'name' });
    expect(about.at(-1)!.field.destination).toEqual({ kind: 'pageSeo', pageId: pageAt(s, '/about/').id, field: 'description' });
    expect(contentTarget(s, ms[0].field, null)).toBeNull();
    expect(contentTarget(s, about.at(-1)!.field, null)).toBeNull();
  });

  it('renames the site in the same step as its header, footer and search descriptions, and the header keeps following the name', () => {
    const s = starter();
    const { plan, after } = replaced(s, findContent(s, NAME), 'Saltmarsh Studio');
    // The rename goes first, so the header given the new name is not taken for a label of the author's own.
    expect(plan.operations[0]).toEqual({ type: 'site.update', name: 'Saltmarsh Studio', description: s.site.description.replace(NAME, 'Saltmarsh Studio') });
    expect(plan.operations.filter((o) => o.type === 'page.update').map((o) => o.type === 'page.update' && o.pageId)).toEqual(['Home', 'About', 'Contact'].map((t) => s.site.pageOrder.find((id) => s.pages[id].title === t)));
    expect(plan.changes.filter((c) => c.knockOn)).toEqual([]);
    expect(plan.notice).toBeUndefined();
    expect(after.site.name).toBe('Saltmarsh Studio');
    for (const route of ['/', '/about/']) expect(pageAt(after, route).seo.description).toBe(pageAt(s, route).seo.description!.replaceAll(NAME, 'Saltmarsh Studio'));
    expect(pageAt(after, '/contact/').seo.description).toBe(pageAt(s, '/contact/').seo.description!.replace(NAME, 'Saltmarsh Studio'));
    expect(stored(after, NAME)).toBe(0);
    expect(findContent(after, NAME)).toEqual([]);
    expect(headerOf(after).keepsText).toBeUndefined();
    const again = applyOperations(after, [{ type: 'site.update', name: 'Tidewater' }]).state;
    expect(headerOf(again).props.siteName).toBe('Tidewater');
  });

  it('lists the header following a rename as a change of its own when only the site name is chosen', () => {
    const s = starter();
    const name = findContent(s, NAME).filter((m) => siteName(m));
    const { plan } = replaced(s, name, 'Saltmarsh Studio');
    expect(plan.changes.filter((c) => !c.knockOn).map((c) => [c.field.label, c.before, c.after])).toEqual([['Site name', NAME, 'Saltmarsh Studio']]);
    expect(plan.changes.some((c) => c.knockOn && c.field.owner.kind === 'shell' && c.after.includes('Saltmarsh Studio'))).toBe(true);
  });

  it('says when the header would stop naming the site, and not once the site name is chosen too', () => {
    const s = starter();
    const ms = findContent(s, NAME);
    const header = ms.filter((m) => m.field.owner.kind === 'shell' && m.field.owner.id === 'header');
    expect(header.length).toBeGreaterThan(0);
    const plan = planReplace(s, header, 'Saltmarsh Studio');
    expect(plan.error).toBeUndefined();
    expect(plan.notice).toMatch(/shared header will show “Saltmarsh Studio” while the site is still named “Quill Harbour”/);
    expect(planReplace(s, [...ms.filter((m) => siteName(m)), ...header], 'Saltmarsh Studio').notice).toBeUndefined();
  });

  it('refuses a site name the site cannot have before anything changes', () => {
    const s = starter();
    const name = findContent(s, NAME).filter((m) => siteName(m));
    expect(planReplace(s, name, '  ')).toMatchObject({ operations: [], error: 'Replacing would leave the site without a name. Use other words, or leave that match out.' });
    expect(planReplace(s, name, 'x'.repeat(80)).error).toBeUndefined();
    expect(planReplace(s, name, 'x'.repeat(81))).toMatchObject({ operations: [], error: expect.stringMatching(/site name longer than 80 characters/) });
    const about = findContent(s, NAME).filter((m) => m.field.label === 'Search description' && m.field.where === 'About');
    expect(planReplace(s, about, 'x'.repeat(320))).toMatchObject({ operations: [], error: expect.stringMatching(/search description of “About” longer than 320 characters/) });
  });

  it('reviews a search description left empty as the default showing, not as a field that disappears', () => {
    const s = starter();
    const about = pageAt(s, '/about/');
    about.seo.description = NAME;
    const { plan, after } = replaced(s, findContent(s, NAME).filter((m) => m.field.where === 'About' && m.field.setting), '');
    expect(plan.changes.map((c) => [c.before, c.after])).toEqual([[NAME, 'Empty: the default shows']]);
    expect(pageAt(after, '/about/').seo.description).toBeUndefined();
  });

  it('finds a draft page’s search title and a post’s search settings, changing a post in one edit, and leaves a synced post’s to its source', () => {
    let s = starter();
    const about = pageAt(s, '/about/');
    s = applyOperations(s, [
      { type: 'page.update', pageId: about.id, seoTitle: 'Meet Quill Harbour' },
      { type: 'collection.create', collectionId: 'posts', name: 'Posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Quill Harbour opens', excerpt: 'News.', seoTitle: 'Quill Harbour is open', description: 'Quill Harbour opens its doors.' },
      { type: 'collection.create', collectionId: 'work', name: 'Work', kind: 'structured' },
      { type: 'entry.create', collectionId: 'work', entryId: 'en_boat', title: 'A boat', seoTitle: 'A Quill Harbour boat' }
    ]).state;
    const contact = pageAt(s, '/contact/');
    s = applyOperations(s, [{ type: 'page.update', pageId: contact.id, draft: true, seoTitle: 'Write to Quill Harbour' }]).state;
    s.collections.work.settings.sourceId = 'airtable';
    const ms = findContent(s, NAME);
    expect(ms.filter((m) => m.field.label === 'Search title').map((m) => [m.field.where, m.field.section])).toEqual([
      ['About', 'Search & sharing'],
      ['Contact', 'Search & sharing'],
      ['Quill Harbour opens', 'Posts'],
      ['A boat', 'Work']
    ]);
    const post = ms.filter((m) => m.field.entry?.entryId === 'en_open');
    expect(post.map((m) => m.field.label)).toEqual(['Title', 'Search title', 'Search description']);
    expect(entryTarget(s, post[2].field)).toEqual({ collectionId: 'posts', entryId: 'en_open', field: 'seoDescription' });
    const synced = ms.find((m) => m.field.entry?.entryId === 'en_boat')!;
    expect(synced.blocked).toMatch(/synced from an external source/);
    const { plan, after } = replaced(s, ms, 'Saltmarsh Studio');
    expect(plan.skipped).toBe(1);
    expect(plan.operations.filter((o) => o.type === 'entry.update')).toEqual([
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_open', title: 'Saltmarsh Studio opens', seoTitle: 'Saltmarsh Studio is open', description: 'Saltmarsh Studio opens its doors.' }
    ]);
    expect(pageAt(after, '/contact/').seo.title).toBe('Write to Saltmarsh Studio');
    expect(pageAt(after, '/about/').seo.title).toBe('Meet Saltmarsh Studio');
    expect(findContent(after, NAME).map((m) => m.field.entry?.entryId)).toEqual(['en_boat']);
  });

  it('says when a rename and a header edit leave the header naming the site differently', () => {
    const s = createStarterState('business', 'Quill Harbour Quill', false);
    const ms = findContent(s, 'Quill');
    const site = ms.filter(siteName);
    const header = ms.filter((m) => m.field.owner.kind === 'shell' && m.field.owner.id === 'header' && m.field.value === 'Quill Harbour Quill');
    expect([site.length, header.length]).toEqual([2, 2]);
    // Both renamed alike: the header goes on naming the site.
    expect(planReplace(s, [site[0], header[0]], 'Tide').notice).toBeUndefined();
    // Spaced differently, the header stops following the name, and the dialog says so.
    const plain = starter();
    const plainHeader = findContent(plain, NAME).filter((m) => m.field.owner.kind === 'shell' && m.field.owner.id === 'header');
    expect(planReplace(plain, plainHeader, 'Quill  Harbour').notice).toMatch(/shared header will show “Quill {2}Harbour”/);
    // The site's first word and the header's last: the rename carries, then the header's own edit wins.
    const { plan, after } = replaced(s, [site[0], header[1]], 'Tide');
    expect(after.site.name).toBe('Tide Harbour Quill');
    expect(headerOf(after).props.siteName).toBe('Quill Harbour Tide');
    expect(plan.notice).toBe('The shared header will show “Quill Harbour Tide” while the site is named “Tide Harbour Quill” in the browser tab and search results.');
  });

  it('clears a search setting replaced with spaces, and says a cleared site description leaves no default', () => {
    const s = starter();
    pageAt(s, '/about/').seo.description = NAME;
    const about = findContent(s, NAME).filter((m) => m.field.setting?.kind === 'page' && m.field.where === 'About');
    const { plan, after } = replaced(s, about, '  ');
    expect(plan.operations).toEqual([{ type: 'page.update', pageId: pageAt(s, '/about/').id, description: '' }]);
    expect(pageAt(after, '/about/').seo.description).toBeUndefined();
    s.site.description = NAME;
    const site = replaced(s, findContent(s, NAME).filter((m) => m.field.setting?.kind === 'site' && m.field.setting.field === 'description'), '');
    expect(site.plan.changes.map((c) => c.after)).toEqual(['Empty']);
    expect(replaced(s, findContent(s, NAME).filter((m) => m.field.setting?.kind === 'site' && m.field.setting.field === 'description'), '  ').plan.operations).toEqual([{ type: 'site.update', description: '' }]);
  });

  it('leaves out the search settings of entries without pages of their own, and stores a post’s trimmed', () => {
    let s = starter();
    s = applyOperations(s, [
      { type: 'collection.create', collectionId: 'posts', name: 'Posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Open', seoTitle: NAME }
    ]).state;
    const title = findContent(s, NAME).filter((m) => m.field.entry?.field === 'seoTitle');
    expect(title).toHaveLength(1);
    // Spaces around a replacement are trimmed as the entry stores them: the same title again changes nothing.
    expect(planReplace(s, title, ' Quill Harbour ').operations).toEqual([]);
    s.collections.posts.settings.pages = { ...(s.collections.posts.settings.pages as object), detail: false } as typeof s.collections.posts.settings.pages;
    expect(findContent(s, NAME).filter((m) => m.field.entry)).toEqual([]);
  });

  it('finds no search settings a page leaves to its defaults', () => {
    const s = starter();
    const about = pageAt(s, '/about/');
    delete about.seo.description;
    expect(contentFields(s).filter((f) => f.owner.kind === 'page' && f.owner.id === about.id && f.setting)).toEqual([]);
  });
});
