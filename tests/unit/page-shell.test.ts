// Each page shows the shared header and the shared footer independently (#219): a landing page can keep the footer's
// contact details without the header's menu, while the pages around it keep their own choices.
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { pageShowing, pagesShowing, partsShown, showsPart } from '@shared/page-shell';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { missingSectionLinks, pageIds, sharedPageIds, shellPageLinks } from '@generator/checks';
import { unlinkedButtonWarnings } from '../../src/main/export';
import { pageDetail, projectSummary } from '@agent/context';
import { executeTool, type ToolHost } from '@agent/tools';
import { readField } from '../../src/renderer/src/lib/held';
import { changeTarget } from '../../src/renderer/src/lib/result';
import { placementsOn, shellPageNames, shellReach } from '../../src/renderer/src/lib/model';
import { contentTarget, findContent } from '../../src/renderer/src/lib/find-content';
import { sectionOptions } from '../../src/renderer/src/lib/sections';

const LAYOUT = 'src/routes/+layout.svelte';
const header = { kind: 'shell' as const, id: 'header' };
const footer = { kind: 'shell' as const, id: 'footer' };
const footerOf = (s: ProjectState) => s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;

/**
 * The business starter plus a Kitchen landing page, with all four combinations: Home shows both, About only the
 * header, Kitchen only the footer, Contact neither.
 */
function site() {
  let s = createStarterState('business', 'Test Studio', false);
  s = applyOperations(s, [{ type: 'page.create', title: 'Kitchen', route: '/work/kitchen/' }]).state;
  const [home, about, contact, kitchen] = s.site.pageOrder;
  s = applyOperations(s, [
    { type: 'page.update', pageId: about, showFooter: false },
    { type: 'page.update', pageId: kitchen, showHeader: false },
    { type: 'page.update', pageId: contact, showHeader: false, showFooter: false }
  ]).state;
  return { s, home, about, contact, kitchen };
}

/** The markup each layout condition guards. */
function guarded(layout: string) {
  const block = (cond: string) => layout.match(new RegExp(`\\{#if ${cond}\\}\\n([\\s\\S]*?)\\n\\{/if\\}`))?.[1] ?? '';
  const set = (name: string) => JSON.parse(layout.match(new RegExp(`const ${name} = new Set\\((.*)\\);`))![1]) as string[];
  return { header: block('showHeader'), footer: block('showFooter'), withoutHeader: set('pagesWithoutHeader'), withoutFooter: set('pagesWithoutFooter') };
}

describe('choosing the shared header and footer per page', () => {
  it('starts every page with both, as before', () => {
    let s = createStarterState('business', 'Test Studio', false);
    s = applyOperations(s, [{ type: 'page.create', title: 'Kitchen' }]).state;
    for (const id of s.site.pageOrder) expect(s.pages[id]).toMatchObject({ showHeader: true, showFooter: true });
    expect(createStarterState('blank', 'Blank', false).pages).toSatisfy((pages: ProjectState['pages']) => Object.values(pages).every((p) => p.showHeader && p.showFooter));
  });

  it('changes one part on one page, leaving the other part, the other pages and the shared content alone', () => {
    const before = createStarterState('business', 'Test Studio', false);
    const [home, about, contact] = before.site.pageOrder;
    const hide = applyOperations(before, [{ type: 'page.update', pageId: about, showHeader: false }]).state;
    expect(hide.pages[about]).toMatchObject({ showHeader: false, showFooter: true });
    expect(hide.pages[home]).toEqual(before.pages[home]);
    expect(hide.pages[contact]).toEqual(before.pages[contact]);
    expect(hide.site.shell).toEqual(before.site.shell);
    // Header and footer edits apply in either order without undoing each other.
    const both = applyOperations(hide, [{ type: 'page.update', pageId: about, showFooter: false }]).state;
    expect(both.pages[about]).toMatchObject({ showHeader: false, showFooter: false });
    const back = applyOperations(both, [{ type: 'page.update', pageId: about, showHeader: true }]).state;
    expect(back.pages[about]).toMatchObject({ showHeader: true, showFooter: false });
    expect(applyOperations(back, [{ type: 'page.update', pageId: about, showFooter: true }]).state.pages[about]).toMatchObject({ showHeader: true, showFooter: true });
    // A copy of a page keeps its choices.
    const copied = applyOperations(back, [{ type: 'page.duplicate', pageId: about }]).state;
    const copy = copied.site.pageOrder.find((id) => !back.site.pageOrder.includes(id))!;
    expect(copied.pages[copy]).toMatchObject({ showHeader: true, showFooter: false });
  });

  it('accepts the two settings as booleans and refuses the old single setting', () => {
    expect(validateOperation({ type: 'page.update', pageId: 'pg_x', showHeader: false }).ok).toBe(true);
    expect(validateOperation({ type: 'page.update', pageId: 'pg_x', showHeader: true, showFooter: false }).ok).toBe(true);
    expect(validateOperation({ type: 'page.update', pageId: 'pg_x', showFooter: 'false' }).ok).toBe(false);
    expect(validateOperation({ type: 'page.update', pageId: 'pg_x', showHeader: 0 }).ok).toBe(false);
    const old = validateOperation({ type: 'page.update', pageId: 'pg_x', shell: 'none' });
    expect(old).toMatchObject({ ok: false, message: expect.stringContaining('showHeader and showFooter') });
    expect(validateOperation({ type: 'page.update', pageId: 'pg_x', shell: 'default' }).ok).toBe(false);
  });

  it('renders each combination: the layout guards the header and the footer by their own page lists', () => {
    const { s } = site();
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const g = guarded(generateProject(s).get(LAYOUT)!);
    expect(g.withoutHeader).toEqual(['/contact', '/work/kitchen']);
    expect(g.withoutFooter).toEqual(['/about', '/contact']);
    expect(g.header).toContain('foundation_shell_header');
    expect(g.header).not.toContain('foundation_shell_footer');
    expect(g.footer).toContain('foundation_shell_footer');
    expect(g.footer).not.toContain('foundation_shell_header');
    // Each condition reads its own part's list.
    expect(generateProject(s).get(LAYOUT)).toContain("const showHeader = $derived(!pagesWithoutHeader.has(page.route.id ?? ''));");
    expect(generateProject(s).get(LAYOUT)).toContain("const showFooter = $derived(!pagesWithoutFooter.has(page.route.id ?? ''));");
    // The main landmark and skip link are on every page, whatever it shows.
    expect(generateProject(s).get(LAYOUT)).toMatch(/<a class="so-skip-link" href="#main">\{text\(\)\.skipLink\}<\/a>\n\{#if showHeader\}[\s\S]*\{\/if\}\n<main id="main">/);
    // An instrumented build for the canvas decides the same way.
    const dev = guarded(generateProject(s, { instrument: true }).get(LAYOUT)!);
    expect([dev.withoutHeader, dev.withoutFooter]).toEqual([g.withoutHeader, g.withoutFooter]);
  });

  it('keeps an old address of a page free of both parts, whatever its page shows', () => {
    const { s, home, kitchen } = site();
    // Kitchen becomes Home, keeping /work/kitchen/ working as an address that sends visitors on.
    const moved = applyOperations(s, [{ type: 'page.setHome', pageId: kitchen, keepOldAddress: true }]).state;
    expect(moved.site.redirects).toEqual([{ from: '/work/kitchen/', pageId: kitchen }]);
    const g = guarded(generateProject(moved).get(LAYOUT)!);
    const previous = moved.pages[home].route.replace(/\/$/, '');
    expect(g.withoutHeader).toEqual(['/', '/contact', '/work/kitchen'].sort());
    expect(g.withoutFooter).toEqual(['/about', '/contact', '/work/kitchen'].sort());
    expect(g.withoutHeader).not.toContain(previous);
  });

  it('shows a change to the shared footer on the landing page, and leaves the pages themselves unchanged', () => {
    const { s, kitchen } = site();
    const before = generateProject(s);
    const edited = applyOperations(s, [{ type: 'instance.setProp', owner: footer, nodeId: footerOf(s).id, prop: 'tagline', value: 'Open Tuesday to Saturday.' }]).state;
    const after = generateProject(edited);
    const g = guarded(after.get(LAYOUT)!);
    expect(g.footer).toContain('Open Tuesday to Saturday.');
    expect(g.withoutFooter).not.toContain('/work/kitchen');
    expect(showsPart(edited.pages[kitchen], 'footer')).toBe(true);
    // Every page file is the same: what a page shows is the layout's decision, not the page's.
    for (const [path, text] of before) if (path.startsWith('src/routes/') && path.endsWith('+page.svelte')) expect(after.get(path), path).toBe(text);
  });

  it('publishes a notice from the shared header once, on every page that shows it, and removes it the same way (#269)', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const [, about] = s.site.pageOrder;
    const before = generateProject(s);
    const notice = 'Studio closed on Friday for repairs';
    const set = (state: ProjectState, prop: string, value: unknown) => applyOperations(state, [{ type: 'instance.setProp', owner: header, nodeId: headerOf(state).id, prop, value }]).state;
    const published = set(set(s, 'notice', notice), 'noticeLabel', 'Directions');
    const linked = set(published, 'noticeLink', { type: 'page', target: s.site.pageOrder[2] });
    const after = generateProject(linked);
    const g = guarded(after.get(LAYOUT)!);
    expect(g.header).toContain(`notice={${JSON.stringify(notice)}}`);
    expect(g.header).toContain('noticeLabel={"Directions"}');
    expect(g.header).toContain('noticeLink={{"href":"/contact/"}}');
    // Every page shows the header, so every page shows the notice, and no page's own file changes for it.
    expect(g.withoutHeader).toEqual([]);
    for (const [path, text] of before) if (path.startsWith('src/routes/') && path.endsWith('+page.svelte')) expect(after.get(path), path).toBe(text);
    // The site name and the header's action keep their own fields.
    expect(headerOf(linked).props).toMatchObject({ siteName: 'Test Studio', ctaLabel: 'Book a call' });
    // A page that hides the header hides its notice with it.
    expect(guarded(generateProject(applyOperations(linked, [{ type: 'page.update', pageId: about, showHeader: false }]).state).get(LAYOUT)!).withoutHeader).toEqual(['/about']);
    // Clearing the words removes it everywhere; the header's markup then leaves its link out too (foundation-html).
    const removed = generateProject(set(linked, 'notice', ''));
    expect(guarded(removed.get(LAYOUT)!).header).not.toContain(notice);
    expect(guarded(removed.get(LAYOUT)!).header).toContain('notice={""}');
  });

  it('hiding a part on one page leaves every other page’s generated files as they were', () => {
    const base = createStarterState('business', 'Test Studio', false);
    const [, about] = base.site.pageOrder;
    const before = generateProject(base);
    const after = generateProject(applyOperations(base, [{ type: 'page.update', pageId: about, showHeader: false }]).state);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...after.keys()].filter((p) => after.get(p) !== before.get(p));
    expect(changed).toEqual([LAYOUT]);
    expect(guarded(after.get(LAYOUT)!)).toMatchObject({ withoutHeader: ['/about'], withoutFooter: [] });
  });

  it('checks a header link on the pages with the header and a footer link on the pages with the footer', () => {
    const { s, about, kitchen } = site();
    // The footer jumps to the header's menu, and the header to a section of the footer.
    const f = footerOf(s);
    (f.props.links as Array<{ link: unknown }>)[0].link = { type: 'anchor', target: 'so-site-nav' };
    f.anchor = 'studio-hours';
    (headerOf(s).props.links as Array<{ link: unknown }>)[0].link = { type: 'anchor', target: 'studio-hours' };
    const issues = missingSectionLinks(s);
    const of = (part: string) => issues.filter((i) => i.owner.kind === 'shell' && i.owner.id === part);
    // Kitchen has the footer but not the header's menu; About has the header but not the footer's section.
    expect(of('footer').map((i) => i.pages)).toEqual([[kitchen]]);
    expect(of('header').map((i) => i.pages)).toEqual([[about]]);
    expect(sharedPageIds(s, 'footer').has('so-site-nav')).toBe(false);
    expect(sharedPageIds(s, 'header').has('studio-hours')).toBe(false);
    // A link to that section of the Kitchen page itself is fine from anywhere: the page shows the footer.
    (headerOf(s).props.links as Array<{ link: unknown }>)[0].link = { type: 'page', target: kitchen, anchor: 'studio-hours' };
    expect(missingSectionLinks(s).filter((i) => i.owner.id === 'header')).toEqual([]);
    expect(pageIds(s, kitchen).has('studio-hours')).toBe(true);
    expect(pageIds(s, kitchen).has('so-site-nav')).toBe(false);
    expect(pageIds(s, about).has('studio-hours')).toBe(false);
  });

  it('offers a shared link only the sections every page showing its part has', () => {
    const { s, home } = site();
    footerOf(s).anchor = 'studio-hours';
    const ids = (part?: 'header' | 'footer') => sectionOptions(s, home, part).ids;
    // Home shows both parts, so its own options include both parts' IDs.
    expect(ids().has('studio-hours')).toBe(true);
    expect(ids().has('so-site-nav')).toBe(true);
    // A header link "on this page" also shows on About, which has no footer.
    expect(ids('header').has('studio-hours')).toBe(false);
    // A footer link "on this page" also shows on Kitchen, which has no header.
    expect(ids('footer').has('so-site-nav')).toBe(false);
    expect(ids('footer').has('studio-hours')).toBe(true);
    // The footer's own section is offered by its ID on a page that shows the footer, and not on one that hides it.
    const offered = (pageId: string, part?: 'header' | 'footer') => sectionOptions(s, pageId, part).options.map((o) => o.value);
    expect(offered(home)).toContain('#studio-hours');
    expect(offered(home, 'footer')).toContain('#studio-hours');
    expect(offered(s.site.pageOrder[1])).not.toContain('#studio-hours');
  });

  it('looks for unlinked buttons and visitor links only in the parts some page shows', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const [home, about, contact] = s.site.pageOrder;
    // A button with no destination in the shared footer.
    s.site.shell.footer.nodes.n_book = { id: 'n_book', kind: 'link', label: 'Book a visit', appearance: 'primary', link: { type: 'none', target: '' } };
    s.site.shell.footer.rootIds.push('n_book');
    expect(unlinkedButtonWarnings(s).join(' ')).toContain('Footer: “Book a visit”');
    const noFooter = applyOperations(s, [home, about, contact].map((pageId) => ({ type: 'page.update' as const, pageId, showFooter: false }))).state;
    expect(unlinkedButtonWarnings(noFooter)).toEqual([]);
    const noHeader = applyOperations(s, [home, about, contact].map((pageId) => ({ type: 'page.update' as const, pageId, showHeader: false }))).state;
    expect(unlinkedButtonWarnings(noHeader).join(' ')).toContain('Footer: “Book a visit”');
    expect(shellPageLinks(noHeader, [about]).map((l) => l.part)).toEqual(['footer']);
    expect(shellPageLinks(s, [about]).map((l) => l.part)).toEqual(['header', 'footer']);
    expect(shellPageLinks(noFooter, [about]).map((l) => l.part)).toEqual(['header']);
  });

  it('opens a header element on a page with the header and a footer element on a page with the footer', () => {
    const { s, home, about, contact, kitchen } = site();
    const nav = headerOf(s).id;
    const foot = footerOf(s).id;
    expect(pageShowing(s, 'header', kitchen)).toBe(home);
    expect(pageShowing(s, 'footer', kitchen)).toBe(kitchen);
    expect(pageShowing(s, 'footer', about)).toBe(home);
    expect(pageShowing(s, 'header', about)).toBe(about);
    expect(pageShowing(s, 'nav', home)).toBeUndefined();
    expect(changeTarget(s, kitchen, { label: 'x', owner: header, nodeId: nav })).toMatchObject({ pageId: home });
    expect(changeTarget(s, kitchen, { label: 'x', owner: footer, nodeId: foot })).toMatchObject({ pageId: kitchen });
    // Find and replace matches open the same way: the header's elsewhere, the footer's here.
    const headerMatch = findContent(s, 'Book a call').find((m) => m.field.where === 'Header')!;
    const footerMatch = findContent(s, 'hello@example.com').find((m) => m.field.where === 'Footer')!;
    expect(contentTarget(s, headerMatch.field, kitchen)!.pageId).toBe(home);
    expect(contentTarget(s, footerMatch.field, kitchen)!.pageId).toBe(kitchen);
    expect(contentTarget(s, headerMatch.field, about)!.pageId).toBe(about);
    expect(contentTarget(s, footerMatch.field, about)!.pageId).toBe(home);
    // With no page showing the footer, there is nowhere to show it, and the message says which part.
    const none = applyOperations(s, [home, kitchen].map((pageId) => ({ type: 'page.update' as const, pageId, showFooter: false }))).state;
    expect(pagesShowing(none, 'footer')).toEqual([]);
    expect(changeTarget(none, contact, { label: 'x', owner: footer, nodeId: foot })).toEqual({ error: 'No page shows the shared footer.' });
    expect(partsShown(none.pages[home])).toEqual(['header']);
  });

  it('lists a component’s placements in only the parts the page shows', () => {
    const { s, about, kitchen } = site();
    const footerDef = footerOf(s).definitionId;
    const headerDef = headerOf(s).definitionId;
    expect(placementsOn(s, footerDef, kitchen).map((r) => r.owner)).toEqual([footer]);
    expect(placementsOn(s, headerDef, kitchen)).toEqual([]);
    expect(placementsOn(s, footerDef, about)).toEqual([]);
    expect(placementsOn(s, headerDef, about).map((r) => r.owner)).toEqual([header]);
  });

  it('holds a footer setting edit against footer changes only', () => {
    const { s, kitchen } = site();
    const op = { type: 'page.update' as const, pageId: kitchen, showFooter: false };
    const read = readField(s, op);
    const headerChanged = applyOperations(s, [{ type: 'page.update', pageId: kitchen, showHeader: true }]).state;
    const footerChanged = applyOperations(s, [{ type: 'page.update', pageId: kitchen, showFooter: false }]).state;
    expect(readField(headerChanged, op)).toEqual(read);
    expect(readField(footerChanged, op)).not.toEqual(read);
    const headerOp = { type: 'page.update' as const, pageId: kitchen, showHeader: true };
    expect(readField(footerChanged, headerOp)).toEqual(readField(s, headerOp));
    expect(readField(headerChanged, headerOp)).not.toEqual(readField(s, headerOp));
  });

  it('says when a selected header or footer is not shown on the page on screen', () => {
    const { s, home, about, kitchen } = site();
    expect(shellReach(s, 'header', home)).toEqual({ pages: 2, here: true });
    expect(shellReach(s, 'header', kitchen)).toEqual({ pages: 2, here: false });
    expect(shellReach(s, 'footer', kitchen)).toEqual({ pages: 2, here: true });
    expect(shellReach(s, 'footer', about)).toEqual({ pages: 2, here: false });
    const hidden = applyOperations(s, [{ type: 'page.update', pageId: home, showFooter: false }]).state;
    expect(shellReach(hidden, 'footer', home)).toEqual({ pages: 1, here: false });
    expect(shellReach(hidden, 'footer', null)).toEqual({ pages: 1, here: false });
  });

  it('names the pages a selected header or footer reaches, in site order, marking drafts', () => {
    const { s, home, about, contact, kitchen } = site();
    expect(shellPageNames(s, 'header')).toEqual({ text: 'Home and About', all: 'Home and About' });
    expect(shellPageNames(s, 'footer')).toEqual({ text: 'Home and Kitchen', all: 'Home and Kitchen' });
    // Every page in the business starter shows the header: all three are named, and a draft says it is left out.
    let all = applyOperations(s, [
      { type: 'page.update', pageId: kitchen, showHeader: true, draft: true },
      { type: 'page.update', pageId: contact, showHeader: true }
    ]).state;
    expect(shellPageNames(all, 'header').text).toBe('Home, About, Contact and Kitchen (draft)');
    // A long list names the first pages and counts the rest; the tooltip names them all.
    for (const title of ['Team', 'Services', 'Journal']) all = applyOperations(all, [{ type: 'page.create', title, route: `/${title.toLowerCase()}/` }]).state;
    const many = shellPageNames(all, 'header');
    expect(many.text).toBe('Home, About, Contact, Kitchen (draft) and 3 more');
    expect(many.all).toBe('Home, About, Contact, Kitchen (draft), Team, Services and Journal');
    const none = applyOperations(s, [
      { type: 'page.update', pageId: home, showHeader: false },
      { type: 'page.update', pageId: about, showHeader: false }
    ]).state;
    expect(shellPageNames(none, 'header')).toEqual({ text: '', all: '' });
    // Home is never a draft, whatever its document says; a page with no title goes by its address.
    const odd = structuredClone(s);
    odd.pages[home].draft = true;
    odd.pages[about].title = '  ';
    expect(shellPageNames(odd, 'header').text).toBe('Home and /about/');
    expect(shellPageNames(s, 'sidebar')).toEqual({ text: '', all: '' });
  });

  it('refuses the old single setting from the assistant instead of dropping it', async () => {
    const { s, about } = site();
    const applied: EditOperation[][] = [];
    const host = { state: () => s, revision: () => 1, diagnostics: () => [], apply: async (ops: EditOperation[]) => (applied.push(ops), { ok: true, revision: 2 }) } as unknown as ToolHost;
    const old = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 1, operations: [{ type: 'page.update', pageId: about, title: 'About us' }, { type: 'page.update', pageId: about, shell: 'none' }] }), host, 'c1');
    expect(old).toMatchObject({ ok: false, content: { error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('showHeader and showFooter') } } });
    expect(applied).toEqual([]);
    const now = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 1, operations: [{ type: 'page.update', pageId: about, showHeader: false }] }), host, 'c2');
    expect(now.ok).toBe(true);
    expect(applied).toEqual([[{ type: 'page.update', pageId: about, showHeader: false }]]);
  });

  it('tells the assistant what each page shows', () => {
    const { s, about, kitchen } = site();
    expect(projectSummary(s, 1).pages.find((p) => p.id === kitchen)).toMatchObject({ showHeader: false, showFooter: true });
    expect(projectSummary(s, 1).pages.find((p) => p.id === about)).toMatchObject({ showHeader: true, showFooter: false });
    expect(pageDetail(s, kitchen)).toMatchObject({ showHeader: false, showFooter: true });
    expect(pageDetail(s, about)).toMatchObject({ showHeader: true, showFooter: false });
    expect(JSON.stringify(projectSummary(s, 1).pages)).not.toContain('"shell"');
    expect(pageDetail(s, about)).not.toHaveProperty('shell');
  });
});
