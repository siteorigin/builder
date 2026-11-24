import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { pageLinkUses } from '@engine/page-links';
import { describeDraftLink, publicationPlan } from '@generator/checks';
import { defFile, defKey, generateProject, isDraftPage, pageFile, publishedState, redirectFile } from '@generator/index';
import { draftLinksStop, draftSourceNotes, editedGeneratedFile, isGeneratedReadme, leaveOutDrafts, projectReadme, publishedChanged, pruneWebsiteAssets } from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';

const fresh = () => createStarterState('business', 'Test Studio', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;

/** The starter site with a new page, linked from nothing, kept as a draft. */
function withDraft(title = 'Winter stock preview', route?: string): { s: ProjectState; draft: string } {
  let s = fresh();
  s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_winter01', title, ...(route ? { route } : {}) }, { type: 'page.update', pageId: 'pg_winter01', draft: true }]).state;
  return { s, draft: 'pg_winter01' };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('draft pages in the project', () => {
  it('keeps a draft as a flag of its own, apart from search visibility', () => {
    const { s, draft } = withDraft();
    expect(s.pages[draft].draft).toBe(true);
    expect(s.pages[draft].seo.noindex).toBeUndefined();
    let t = applyOperations(s, [{ type: 'page.update', pageId: draft, noindex: true }]).state;
    expect(t.pages[draft]).toMatchObject({ draft: true, seo: { noindex: true } });
    t = applyOperations(t, [{ type: 'page.update', pageId: draft, draft: false }]).state;
    // Publishing clears the flag from the document and leaves "Hide from search engines" as it was.
    expect('draft' in t.pages[draft]).toBe(false);
    expect(t.pages[draft].seo.noindex).toBe(true);
    // A setting changed without naming the draft flag keeps it.
    const kept = applyOperations(s, [{ type: 'page.update', pageId: draft, title: 'Winter stock' }]).state;
    expect(kept.pages[draft].draft).toBe(true);
  });

  it('never makes the Home page a draft', () => {
    const s = fresh();
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: s.site.homePageId, draft: true }])).toThrow(/Home page cannot be a draft/);
    const { s: t, draft } = withDraft();
    expect(() => applyOperations(t, [{ type: 'page.setHome', pageId: draft }])).toThrow(/is a draft/);
    // A Home flag written by hand is ignored: the Home page is always published.
    const hand = fresh();
    const home = hand.site.homePageId;
    hand.pages[home].draft = true;
    expect(isDraftPage(hand, hand.pages[home])).toBe(false);
    expect(publishedState(hand)).toBe(hand);
    expect('draft' in applyOperations(hand, [{ type: 'page.update', pageId: home, draft: false }]).state.pages[home]).toBe(false);
    // Only `true` makes a draft: a value written by hand in another form is a published page everywhere.
    const odd = fresh();
    (odd.pages[byTitle(odd, 'About').id] as { draft?: unknown }).draft = 'true';
    expect(isDraftPage(odd, byTitle(odd, 'About'))).toBe(false);
    expect(applyOperations(odd, [{ type: 'page.setHome', pageId: byTitle(odd, 'About').id }]).state.site.homePageId).toBe(byTitle(odd, 'About').id);
    // Nor does it come back when another page becomes Home: the old Home stays published at its new address.
    const moved = applyOperations(hand, [{ type: 'page.setHome', pageId: byTitle(hand, 'About').id }]).state;
    expect(moved.pages[home].route).not.toBe('/');
    expect(isDraftPage(moved, moved.pages[home])).toBe(false);
    expect(publishedState(moved).pages[home]).toBeDefined();
  });

  it('hands Home to the first published page when Home is removed, never to a draft', () => {
    let { s, draft } = withDraft();
    // The draft comes first after Home: it is skipped.
    s = applyOperations(s, [{ type: 'page.reorder', pageIds: [s.site.homePageId, draft, ...s.site.pageOrder.filter((id) => id !== s.site.homePageId && id !== draft)] }]).state;
    const home = s.site.homePageId;
    const replaced = applyOperations(s, [{ type: 'page.remove', pageId: home, replacementPageId: byTitle(s, 'Contact').id }]).state;
    expect(replaced.site.homePageId).toBe(byTitle(s, 'Contact').id);
    expect(replaced.pages[byTitle(s, 'Contact').id].route).toBe('/');
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: home, replacementPageId: draft }])).toThrow(/is a draft/);
    // Nothing links to Home: the first page after it that is published takes over.
    const unlinked = structuredClone(s);
    for (const { link } of pageLinkUses(unlinked, home)) link.target = byTitle(unlinked, 'Contact').id;
    const next = applyOperations(unlinked, [{ type: 'page.remove', pageId: home }]).state;
    expect(next.site.homePageId).toBe(unlinked.site.pageOrder.find((id) => id !== home && id !== draft));
    expect(next.pages[draft].route).toBe('/winter-stock-preview/');
    // With every other page a draft, Home cannot be removed.
    for (const id of unlinked.site.pageOrder) if (id !== home) unlinked.pages[id].draft = true;
    expect(() => applyOperations(unlinked, [{ type: 'page.remove', pageId: home }])).toThrow(/Every other page is a draft/);
  });

  it('keeps a duplicated draft a draft', () => {
    const { s, draft } = withDraft();
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: draft }]);
    const copy = r.state.pages[(r.results[0] as { pageId: string }).pageId];
    expect(copy.draft).toBe(true);
    const about = byTitle(s, 'About').id;
    const plain = applyOperations(s, [{ type: 'page.duplicate', pageId: about }]);
    expect(plain.state.pages[(plain.results[0] as { pageId: string }).pageId].draft).toBeUndefined();
  });
});

describe('what the website publishes', () => {
  it('generates a draft for the preview but leaves it out of the sitemap', () => {
    const { s, draft } = withDraft();
    s.site.baseUrl = 'https://books.example';
    const files = generateProject(s);
    expect(files.has(pageFile(s.pages[draft]))).toBe(true);
    expect(files.get('static/sitemap.xml')).not.toContain('/winter-stock-preview/');
    expect(files.get('static/sitemap.xml')).toContain('/about/');
    // A page hidden from search engines is still published: it keeps its page file and its noindex tag.
    const about = byTitle(s, 'About');
    about.seo.noindex = true;
    const hidden = generateProject(publishedState(s));
    expect(publicationPlan(s).published).toContain(about);
    expect(hidden.get(pageFile(about))).toContain('content="noindex"');
    expect(hidden.get('static/sitemap.xml')).not.toContain('/about/');
    expect(hidden.get('static/sitemap.xml')).toContain('/contact/');
  });

  it('leaves out drafts and the old addresses that lead to them, and nothing else', () => {
    let { s, draft } = withDraft('Shop', '/shop/');
    s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_books001', title: 'Books', route: '/shop/books/' }]).state;
    s = applyOperations(s, [{ type: 'page.update', pageId: draft, route: '/winter-shop/' }]).state;
    s.site.redirects = [
      { from: '/winter-preview/', pageId: draft },
      { from: '/old-books/', pageId: 'pg_books001' }
    ];
    s = applyOperations(s, [{ type: 'page.update', pageId: draft, route: '/shop/' }]).state;
    // An old address of Books that the draft now uses: the draft keeps it, so it stays out of the website too.
    s.site.redirects = [...s.site.redirects!, { from: '/shop/', pageId: 'pg_books001' }];
    const live = publishedState(s);
    expect(live.site.pageOrder).not.toContain(draft);
    expect(Object.hasOwn(live.pages, draft)).toBe(false);
    expect(live.site.redirects).toEqual([{ from: '/old-books/', pageId: 'pg_books001' }]);
    const full = generateProject(s);
    const published = generateProject(live);
    expect(full.has('src/routes/shop/+page.svelte')).toBe(true);
    expect(full.has(redirectFile('/winter-preview/'))).toBe(true);
    expect(published.has('src/routes/shop/+page.svelte')).toBe(false);
    expect(published.has(redirectFile('/winter-preview/'))).toBe(false);
    expect(published.has('src/routes/shop/books/+page.svelte')).toBe(true);
    expect(published.has(redirectFile('/old-books/'))).toBe(true);
    // The editor's state is not changed.
    expect(s.site.pageOrder).toContain(draft);
  });

  it('lists the pages to publish, the drafts left out, and published links that go to a draft', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    expect(publicationPlan(s)).toMatchObject({ drafts: [], draftLinks: [] });
    s.pages[about].draft = true;
    const plan = publicationPlan(s);
    expect(plan.published.map((p) => p.title)).toEqual(['Home', 'Contact']);
    expect(plan.drafts.map((p) => p.title)).toEqual(['About']);
    // Home's buttons, and the shared header and footer menus, all go to About.
    expect(plan.draftLinks.map((l) => l.owner.kind === 'shell' ? l.owner.id : s.pages[l.owner.id].title)).toEqual(['Home', 'Home', 'header', 'footer']);
    expect(plan.draftLinks.every((l) => l.pageId === about)).toBe(true);
    const header = plan.draftLinks.find((l) => l.owner.id === 'header')!;
    expect(describeDraftLink(s, header)).toMatch(/^Header · .+: “About” goes to About \(\/about\/\)$/);
  });

  it('checks a gallery photo’s link only while the photo follows it (#75)', () => {
    const { s, draft } = withDraft();
    const home = s.pages[s.site.homePageId];
    const gallery = Object.values(home.nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'media.gallery') as InstanceNode;
    const images = gallery.props.images as Array<Record<string, unknown>>;
    const fromGallery = () => publicationPlan(s).draftLinks.filter((l) => l.nodeId === gallery.id);
    expect(fromGallery()).toEqual([]);
    // A destination kept while the photo opens full size, or does nothing, is not a link visitors see.
    images[0] = { ...images[0], action: 'image', link: { type: 'page', target: draft } };
    images[1] = { ...images[1], action: 'none', link: { type: 'page', target: draft } };
    // Saved before photos could open: no action, so nothing happens and the destination is not shown.
    const { action: _omitted, ...saved } = images[2];
    images[2] = { ...saved, link: { type: 'page', target: draft, anchor: 'top' } };
    expect(fromGallery()).toEqual([]);
    images[1] = { ...images[1], action: 'link' };
    expect(fromGallery().map((l) => [l.pageId, l.anchor])).toEqual([[draft, undefined]]);
    images[2] = { ...images[2], action: 'link' };
    expect(fromGallery().map((l) => [l.pageId, l.anchor])).toEqual([[draft, undefined], [draft, 'top']]);
  });

  it('does not check links on drafts, or the header and footer when no published page shows them', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    const contact = byTitle(s, 'Contact').id;
    s.pages[about].draft = true;
    s.pages[contact].draft = true;
    for (const id of s.site.pageOrder) if (!s.pages[id].draft) Object.assign(s.pages[id], { showHeader: false, showFooter: false });
    // Home links to About in its own content; the header and footer are shown only on drafts.
    const plan = publicationPlan(s);
    expect(plan.draftLinks.every((l) => l.owner.kind === 'page' && l.owner.id === s.site.homePageId)).toBe(true);
    expect(plan.draftLinks.length).toBeGreaterThan(0);
    // A published page that shows only the footer has the footer's links checked, and still not the header's.
    s.pages[s.site.homePageId].showFooter = true;
    const owners = new Set(publicationPlan(s).draftLinks.map((l) => l.owner.id));
    expect(owners.has('footer')).toBe(true);
    expect(owners.has('header')).toBe(false);
  });

  it('flags a typed address on the site’s own URL that opens a draft or an old address of one', () => {
    let { s, draft } = withDraft();
    s = applyOperations(s, [{ type: 'page.update', pageId: draft, route: '/winter/' }]).state;
    s.site.redirects = [{ from: '/winter-preview/', pageId: draft }];
    s.site.baseUrl = 'https://books.example/shop';
    const typed = (target: string) => {
      const t = structuredClone(s);
      t.pages[t.site.homePageId].nodes['n_typed001'] = { id: 'n_typed001', kind: 'link', label: 'Winter', appearance: 'primary', link: { type: 'url', target } };
      t.pages[t.site.homePageId].rootIds.push('n_typed001');
      return publicationPlan(t).draftLinks.filter((l) => l.nodeId === 'n_typed001');
    };
    expect(typed('https://books.example/shop/winter/#arrivals')).toEqual([{ owner: { kind: 'page', id: s.site.homePageId }, nodeId: 'n_typed001', label: 'Winter', inText: false, pageId: draft, anchor: 'arrivals' }]);
    expect(typed('https://books.example/shop/Winter')).toHaveLength(1);
    expect(typed('https://books.example/shop/%77inter/')).toMatchObject([{ pageId: draft }]);
    expect(typed('https://books.example/shop/winter/index.html#details')).toMatchObject([{ pageId: draft, anchor: 'details' }]);
    expect(typed('https://books.example/shop/winter-preview/')).toHaveLength(1);
    // Another site, another folder, or a published page is not a draft.
    expect(typed('https://elsewhere.example/shop/winter/')).toEqual([]);
    expect(typed('https://books.example/winter/')).toEqual([]);
    expect(typed('https://books.example/shop/about/')).toEqual([]);
    s.site.baseUrl = undefined;
    expect(typed('https://books.example/shop/winter/')).toEqual([]);
  });

  it('stops a website export when the pages it publishes are not the ones the author was shown', () => {
    const { s, draft } = withDraft();
    const shown = publicationPlan(s).published.map((p) => p.id);
    expect(publishedChanged(s, shown)).toBeNull();
    expect(publishedChanged(s, undefined)).toBeNull();
    // Published while the export was starting: the author saw it listed as a draft.
    const published = applyOperations(s, [{ type: 'page.update', pageId: draft, draft: false }]).state;
    expect(publishedChanged(published, shown)?.message).toMatch(/changed while the export was starting/);
    // Order is not publication.
    expect(publishedChanged(s, [...shown].reverse())).toBeNull();
    // As many pages, but not the same ones: one published, another kept back.
    const swapped = applyOperations(s, [
      { type: 'page.update', pageId: draft, draft: false },
      { type: 'page.update', pageId: byTitle(s, 'Contact').id, draft: true }
    ]).state;
    expect(publicationPlan(swapped).published).toHaveLength(shown.length);
    expect(publishedChanged(swapped, shown)).not.toBeNull();
  });

  it('stops a website export over links to drafts, naming each one', () => {
    const s = fresh();
    expect(draftLinksStop(s)).toBeNull();
    const about = byTitle(s, 'About').id;
    s.pages[about].draft = true;
    const stop = draftLinksStop(s)!;
    expect(stop.message).toBe('4 links on published pages go to About, a draft the website leaves out. Change the links or publish the page, then export again.');
    expect(stop.warnings).toEqual([
      expect.stringMatching(/^Home · .+: “About the studio” goes to About \(\/about\/\)$/),
      expect.stringMatching(/^Home · .+: “Meet the team” goes to About \(\/about\/\)$/),
      expect.stringMatching(/^Header · .+: “About” goes to About \(\/about\/\)$/),
      expect.stringMatching(/^Footer · .+: “About” goes to About \(\/about\/\)$/)
    ]);
    const contact = byTitle(s, 'Contact').id;
    s.pages[contact].draft = true;
    expect(draftLinksStop(s)!.message).toMatch(/^\d+ links on published pages go to drafts the website leaves out\. Change the links or publish those pages, then export again\.$/);
    // One link to one draft.
    const one = withDraft().s;
    one.site.shell.header.rootIds = [];
    one.site.shell.footer.rootIds = [];
    const home = one.pages[one.site.homePageId];
    home.nodes['n_one00001'] = { id: 'n_one00001', kind: 'link', label: 'Winter', appearance: 'primary', link: { type: 'page', target: 'pg_winter01' } };
    home.rootIds.push('n_one00001');
    expect(draftLinksStop(one)).toEqual({
      message: 'A published page links to Winter stock preview, which is a draft and is left out of the website. Change the link or publish the page, then export again.',
      warnings: ['Home: “Winter” goes to Winter stock preview (/winter-stock-preview/)']
    });
  });

  it('writes the drafts into the exported README, and still knows it as its own', () => {
    const readme = projectReadme('Bookshop', true);
    expect(readme).toContain('## Draft pages\n\nThis project has draft pages.');
    expect(readme).toContain('Opening the project in SiteOrigin Builder writes their files back');
    expect(isGeneratedReadme(readme)).toBe(true);
    expect(projectReadme('Bookshop', false)).toBe(projectReadme('Bookshop'));
    expect(projectReadme('Bookshop')).not.toContain('## Draft pages');
    // The owner's words, in that section or a section of their own, keep the README theirs.
    expect(isGeneratedReadme(readme.replace('leaves them out.', 'leaves them out. Deploy from main only.'))).toBe(false);
    expect(isGeneratedReadme(projectReadme('Bookshop').replace('## Notices', '## Draft pages\n\nMine.\n\n## Notices'))).toBe(false);
  });
});

describe('a staged copy without its drafts', () => {
  /** A project folder holding the generated files and manifest an editor session writes, plus canonical documents. */
  function project(s: ProjectState): string {
    const dir = mkdtempSync(join(tmpdir(), 'so-drafts-'));
    dirs.push(dir);
    const files: Record<string, string> = {};
    for (const [path, content] of generateProject(s, { instrument: false })) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
      files[path] = sha(content);
    }
    mkdirSync(join(dir, 'siteorigin', 'pages'), { recursive: true });
    for (const p of Object.values(s.pages)) writeFileSync(join(dir, 'siteorigin', 'pages', `${p.id}.json`), JSON.stringify(p));
    writeFileSync(join(dir, 'siteorigin', 'generated-manifest.json'), JSON.stringify({ generator: 'test', files }));
    mkdirSync(join(dir, 'src', 'routes', 'shop', 'gallery'), { recursive: true });
    writeFileSync(join(dir, 'src', 'routes', 'shop', 'gallery', 'notes.txt'), 'my own file');
    return dir;
  }

  it('removes a draft’s page and old address, keeps pages under it, and leaves a manifest that matches', async () => {
    let { s, draft } = withDraft('Shop', '/shop/');
    s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_books001', title: 'Books', route: '/shop/books/' }]).state;
    s.site.redirects = [{ from: '/winter-preview/', pageId: draft }];
    s.site.baseUrl = 'https://books.example';
    const dir = project(s);
    // A write still recorded as in flight for the draft's page is no longer one the copy has.
    const written = JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8'));
    writeFileSync(join(dir, 'siteorigin/generated-manifest.json'), JSON.stringify({ ...written, pending: { 'src/routes/shop/+page.svelte': 'abc' } }));
    // The draft's old address shows no header or footer while it sends visitors on.
    expect(readFileSync(join(dir, 'src/routes/+layout.svelte'), 'utf8')).toContain('"/winter-preview"');
    await leaveOutDrafts(dir, s);
    expect(existsSync(join(dir, 'src/routes/shop/+page.svelte'))).toBe(false);
    expect(existsSync(join(dir, 'src/routes/winter-preview'))).toBe(false);
    expect(existsSync(join(dir, 'src/routes/shop/books/+page.svelte'))).toBe(true);
    // Files SiteOrigin Builder did not generate stay where they are.
    expect(readFileSync(join(dir, 'src/routes/shop/gallery/notes.txt'), 'utf8')).toBe('my own file');
    // The canonical documents keep the draft, so it can be opened and edited again.
    expect(existsSync(join(dir, 'siteorigin', 'pages', `${draft}.json`))).toBe(true);
    expect(readFileSync(join(dir, 'static/sitemap.xml'), 'utf8')).not.toContain('/shop/<');
    expect(readFileSync(join(dir, 'src/routes/+layout.svelte'), 'utf8')).not.toContain('"/winter-preview"');
    const manifest = JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8'));
    expect(manifest.generator).toBe('test');
    expect(manifest.pending).toEqual({});
    expect(await editedGeneratedFile(dir)).toBeNull();
    // The files and the manifest are exactly the published site's: every path it generates, with its hash, and no other.
    const published = generateProject(publishedState(s), { instrument: false });
    expect(manifest.files).toEqual(Object.fromEntries([...published].map(([path, content]) => [path, sha(content)]).sort()));
    for (const [path, content] of published) expect(readFileSync(join(dir, path), 'utf8'), path).toBe(content);
  });

  it('rewrites published files that link to a draft, and records their new content', async () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    s.pages[about].draft = true;
    const dir = project(s);
    const before = readFileSync(join(dir, 'src/routes/+layout.svelte'), 'utf8');
    expect(before).toContain('/about/');
    expect(readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8')).toContain('"/about/"');
    await leaveOutDrafts(dir, s);
    const after = readFileSync(join(dir, 'src/routes/+layout.svelte'), 'utf8');
    expect(after).not.toContain('"/about/"');
    // Home's own buttons to About lose their address too, and the manifest holds Home's new content.
    const home = readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8');
    expect(home).not.toContain('"/about/"');
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')).files['src/routes/+page.svelte']).toBe(sha(home));
    expect(await editedGeneratedFile(dir)).toBeNull();
    expect(draftSourceNotes(s)[0]).toBe('The draft About is kept in the project to edit in SiteOrigin Builder, and left out of its website build.');
  });

  it('leaves out a picture only a component placed on drafts shows', async () => {
    let { s, draft } = withDraft();
    // A component of the project's own, placed only on the draft.
    s = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: draft }, parentId: null, index: 0, componentId: 'content.media' }]).state;
    const media = (Object.values(s.pages[draft].nodes).find((n) => n.kind === 'instance') as { definitionId: string }).definitionId;
    const copied = applyOperations(s, [{ type: 'component.duplicate', definitionId: media, name: 'Winter shelves' }]);
    const id = (copied.results[0] as { definitionId: string }).definitionId;
    s = applyOperations(copied.state, [{ type: 'node.insert', owner: { kind: 'page', id: draft }, parentId: null, index: 0, definitionId: id }]).state;
    const placed = Object.values(s.pages[draft].nodes).find((n) => n.kind === 'instance' && n.definitionId === id)!;
    const def = s.components[id];
    // The component's own default is the picture, as it is for a component made from a section on the draft.
    (def.properties.image as { default: unknown }).default = { assetId: 'a_winter01', alt: 'Winter shelves' };
    delete (placed as { props: Record<string, unknown> }).props.image;
    s.assets.assets.a_winter01 = { id: 'a_winter01', name: 'Winter shelves', file: 'static/assets/winter-shelves-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 3, width: 10, height: 10, hash: 'h', kind: 'image', createdAt: '' };
    const dir = project(s);
    mkdirSync(join(dir, 'static/assets'), { recursive: true });
    writeFileSync(join(dir, 'static/assets/winter-shelves-1a2b3c4d.jpg'), 'jpg');
    expect(readFileSync(join(dir, defFile(def)), 'utf8')).toContain('winter-shelves-1a2b3c4d.jpg');
    await leaveOutDrafts(dir, s);
    const omitted = await pruneWebsiteAssets(dir, s);
    expect(omitted.map((a) => a.id)).toEqual(['a_winter01']);
    expect(existsSync(join(dir, 'static/assets/winter-shelves-1a2b3c4d.jpg'))).toBe(false);
    // Placed on a published page too, the component is part of the website, and so is its picture.
    const shared = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: byTitle(s, 'About').id }, parentId: null, index: 0, definitionId: def.id }]).state;
    const again = project(shared);
    mkdirSync(join(again, 'static/assets'), { recursive: true });
    writeFileSync(join(again, 'static/assets/winter-shelves-1a2b3c4d.jpg'), 'jpg');
    await leaveOutDrafts(again, shared);
    expect(await pruneWebsiteAssets(again, shared)).toEqual([]);
    expect(existsSync(join(again, 'static/assets/winter-shelves-1a2b3c4d.jpg'))).toBe(true);
    // Imported by a code component of the site's own, it is part of the website too, wherever it is placed.
    const coded = structuredClone(s);
    coded.components['code.wrap'] = { ...def, id: 'code.wrap', name: 'Wrap', kind: 'code', tree: undefined, source: `<script>\n\timport Shelves from '$lib/siteorigin/generated/${defKey(def.id)}.svelte';\n</script>\n\n<Shelves />\n` };
    const third = project(coded);
    mkdirSync(join(third, 'static/assets'), { recursive: true });
    writeFileSync(join(third, 'static/assets/winter-shelves-1a2b3c4d.jpg'), 'jpg');
    await leaveOutDrafts(third, coded);
    expect(await pruneWebsiteAssets(third, coded)).toEqual([]);
    expect(existsSync(join(third, 'static/assets/winter-shelves-1a2b3c4d.jpg'))).toBe(true);
  });

  it('changes nothing without drafts', async () => {
    const s = fresh();
    const dir = project(s);
    const manifest = readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8');
    const files = [...generateProject(s, { instrument: false }).keys()];
    const contents = files.map((f) => readFileSync(join(dir, f), 'utf8'));
    await leaveOutDrafts(dir, s);
    expect(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')).toBe(manifest);
    expect(files.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(contents);
    expect(draftSourceNotes(s)).toEqual([]);
  });
});
