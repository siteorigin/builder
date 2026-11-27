/**
 * Search & sharing (#221): a page's link preview shows the image, title and description the exported page carries,
 * says whether the image is the page's own or the site's, and the generated og:image tags follow the same choice.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject, pageFile } from '@generator/index';
import { defaultPageTitle, pageSharing } from '@shared/sharing';
import { searchSummary, sharingView } from '../../src/renderer/src/lib/sharing';

const image = (id: string, name: string, extra: Partial<AssetRecord> = {}): AssetRecord => ({ id, name, file: `static/assets/${name.toLowerCase().replace(/ +/g, '-')}.jpg`, mime: 'image/jpeg', bytes: 1, width: 1200, height: 630, hash: id, kind: 'image', createdAt: '', ...extra });

/** The business starter with three photos in its library and a public URL, and the page Kitchens added. */
function site(options: { url?: string | null } = {}) {
  let state: ProjectState = createStarterState('business', 'Test Studio', false);
  for (const a of [image('a_kitchen', 'Kitchen', { altSuggestion: 'An oak kitchen' }), image('a_bedroom', 'Bedroom'), image('a_table', 'Studio table')]) state.assets.assets[a.id] = a;
  state = applyOperations(state, [{ type: 'page.create', title: 'Kitchens', route: '/kitchens/' }]).state;
  if (options.url !== null) state = applyOperations(state, [{ type: 'site.update', baseUrl: options.url ?? 'https://studio.example' }]).state;
  const byTitle = (title: string) => Object.values(state.pages).find((p) => p.title === title) as PageDoc;
  return { state, byTitle };
}
const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const head = (s: ProjectState, page: PageDoc) => generateProject(s).get(pageFile(page))!;
const ogImages = (src: string) => [...src.matchAll(/<meta property="og:image" content=\{"([^"]*)"\} \/>/g)].map((m) => m[1]);

describe('pageSharing', () => {
  it('gives the home page the site name and any other page its name before the site’s', () => {
    const { state, byTitle } = site();
    const home = state.pages[state.site.homePageId];
    expect(pageSharing(state, home).title).toBe('Test Studio');
    expect(pageSharing(state, byTitle('Kitchens')).title).toBe('Kitchens · Test Studio');
    expect(defaultPageTitle(state, byTitle('Kitchens'))).toBe('Kitchens · Test Studio');
    // The site's name is the one the site records now, not the one it started with.
    const renamed = apply(state, { type: 'site.update', name: 'Oak & Steel' });
    expect(pageSharing(renamed, renamed.pages[renamed.site.homePageId]).title).toBe('Oak & Steel');
    expect(pageSharing(renamed, renamed.pages[byTitle('Kitchens').id]).title).toBe('Kitchens · Oak & Steel');
  });

  it('takes the page’s own title and description over the defaults, and the site’s description when it has none', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    const withSite = apply(state, { type: 'site.update', description: 'Kitchens and gardens' });
    expect(pageSharing(withSite, byTitle('Kitchens')).description).toBe('Kitchens and gardens');
    // The home page can have a title and description of its own too, and otherwise takes the site's description.
    const home = withSite.pages[withSite.site.homePageId];
    // The starter's home page carries a description of its own, which the site's does not replace.
    expect(home.seo.description).toBeTruthy();
    expect(pageSharing(withSite, home)).toMatchObject({ title: 'Test Studio', description: home.seo.description });
    const homeBare = apply(withSite, { type: 'page.update', pageId: home.id, description: '' });
    expect(pageSharing(homeBare, homeBare.pages[home.id])).toMatchObject({ title: 'Test Studio', description: 'Kitchens and gardens' });
    const homeTitled = apply(withSite, { type: 'page.update', pageId: home.id, seoTitle: 'Welcome' });
    expect(pageSharing(homeTitled, homeTitled.pages[home.id]).title).toBe('Welcome');
    const own = apply(withSite, { type: 'page.update', pageId: kitchens.id, seoTitle: 'Our kitchens', description: 'Oak and steel' });
    expect(pageSharing(own, own.pages[kitchens.id])).toMatchObject({ title: 'Our kitchens', description: 'Oak and steel' });
    const none = apply(state, { type: 'site.update', description: '' });
    expect(pageSharing(none, none.pages[kitchens.id]).description).toBe('');
    // Each is its own choice: a title alone leaves the description to the site, and the other way round.
    const titleOnly = apply(withSite, { type: 'page.update', pageId: kitchens.id, seoTitle: 'Our kitchens' });
    expect(pageSharing(titleOnly, titleOnly.pages[kitchens.id])).toMatchObject({ title: 'Our kitchens', description: 'Kitchens and gardens' });
    const descriptionOnly = apply(withSite, { type: 'page.update', pageId: kitchens.id, description: 'Oak and steel' });
    expect(pageSharing(descriptionOnly, descriptionOnly.pages[kitchens.id])).toMatchObject({ title: 'Kitchens · Test Studio', description: 'Oak and steel' });
    // Stored empty text is no choice either.
    const blank = apply(withSite, { type: 'site.update', description: 'Kitchens and gardens' });
    blank.pages[kitchens.id].seo.title = '';
    blank.pages[kitchens.id].seo.description = '';
    expect(pageSharing(blank, blank.pages[kitchens.id])).toMatchObject({ title: 'Kitchens · Test Studio', description: 'Kitchens and gardens' });
  });

  it('shares a page with its own image, else the site’s, else none', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: null, image: undefined, source: 'none' });
    const siteImage = apply(state, { type: 'site.update', socialImage: 'a_table' });
    expect(pageSharing(siteImage, siteImage.pages[kitchens.id])).toMatchObject({ imageId: 'a_table', source: 'site' });
    expect(pageSharing(siteImage, siteImage.pages[kitchens.id]).image?.name).toBe('Studio table');
    const own = apply(siteImage, { type: 'page.update', pageId: kitchens.id, socialImage: 'a_kitchen' });
    expect(pageSharing(own, own.pages[kitchens.id])).toMatchObject({ imageId: 'a_kitchen', source: 'page' });
    expect(pageSharing(own, own.pages[kitchens.id]).image?.name).toBe('Kitchen');
    // Another page is not affected.
    expect(pageSharing(own, own.pages[own.site.homePageId])).toMatchObject({ imageId: 'a_table', source: 'site' });
    // Clearing the page's choice returns it to the site's.
    const cleared = apply(own, { type: 'page.update', pageId: kitchens.id, socialImage: null });
    expect(cleared.pages[kitchens.id].seo.socialImage).toBeUndefined();
    expect(pageSharing(cleared, cleared.pages[kitchens.id])).toMatchObject({ imageId: 'a_table', source: 'site' });
    expect(pageSharing(cleared, cleared.pages[kitchens.id]).image?.name).toBe('Studio table');
  });

  it('keeps a page’s own choice when its image has gone, never swapping in the site’s', () => {
    const { state, byTitle } = site();
    const broken = apply(state, { type: 'site.update', socialImage: 'a_table' });
    broken.pages[byTitle('Kitchens').id].seo.socialImage = 'a_gone';
    expect(pageSharing(broken, broken.pages[byTitle('Kitchens').id])).toMatchObject({ imageId: 'a_gone', image: undefined, source: 'page' });
  });

  it('shows only a picture: a document or a font is no sharing image, and an empty ID is no choice', () => {
    const { state, byTitle } = site();
    state.assets.assets['a_doc'] = image('a_doc', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    const kitchens = byTitle('Kitchens');
    kitchens.seo.socialImage = 'a_doc';
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: 'a_doc', image: undefined, source: 'page' });
    state.assets.assets['a_font'] = image('a_font', 'Serif', { kind: 'font', mime: 'font/woff2', file: 'static/assets/serif.woff2' });
    kitchens.seo.socialImage = 'a_font';
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: 'a_font', image: undefined, source: 'page' });
    // The site's own image is held to the same rule.
    delete kitchens.seo.socialImage;
    state.site.socialImage = 'a_doc';
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: 'a_doc', image: undefined, source: 'site' });
    state.site.socialImage = 'a_font';
    expect(pageSharing(state, kitchens).image).toBeUndefined();
    // A name that only the object's prototype has is no asset.
    kitchens.seo.socialImage = 'constructor';
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: 'constructor', image: undefined, source: 'page' });
    kitchens.seo.socialImage = '';
    state.site.socialImage = 'a_table';
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: 'a_table', source: 'site' });
  });
});

describe('sharingView', () => {
  it('says a page’s own image is its own, and what other pages show instead', () => {
    const { state, byTitle } = site();
    const s = apply(state, { type: 'site.update', socialImage: 'a_table' }, { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: 'a_kitchen' });
    const v = sharingView(s, s.pages[byTitle('Kitchens').id]);
    expect(v).toMatchObject({ imageSource: 'page', imageName: 'Kitchen', host: 'studio.example', addressNote: null });
    expect(v.imageNote).toBe('This page’s own choice. Pages without their own image show the site’s sharing image, Studio table. Page lists that follow this page show it on this page’s card.');
    // Returning to the site's image is offered by name, with the site's picture to stand in for it.
    expect(v.picker).toEqual({ inherited: 'a_table', from: 'The site’s sharing image.', none: 'No sharing image', back: 'Use the site’s image' });
  });

  it('says a page with no image of its own follows the site’s, and a site with none leaves the link bare', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    const bare = sharingView(state, kitchens);
    expect(bare).toMatchObject({ imageSource: 'none', imageName: undefined });
    expect(bare.imageNote).toBe('Neither this page nor the site has a sharing image, so a shared link to this page shows no picture.');
    expect(bare.picker.inherited).toBeNull();
    const inherited = apply(state, { type: 'site.update', socialImage: 'a_table' });
    const v = sharingView(inherited, inherited.pages[kitchens.id]);
    expect(v).toMatchObject({ imageSource: 'site', imageName: 'Studio table' });
    expect(v.imageNote).toBe('This page has no image of its own, so a shared link shows the site’s sharing image. Choose one to use a different image for this page.');
    expect(v.picker.inherited).toBe('a_table');
  });

  it('offers Remove when the site has no image to return to, and says a site image that has gone is missing', () => {
    const { state, byTitle } = site();
    const own = apply(state, { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: 'a_kitchen' });
    const v = sharingView(own, own.pages[byTitle('Kitchens').id]);
    expect(v.picker.back).toBe('Remove image');
    expect(v.imageNote).toContain('Pages without their own image are shared without one.');
    // A page's choice that has gone from the library stays its own, with no picture, and returning to the site's image is offered.
    // Changed by hand below: a copy, since the state applyOperations gives shares what it did not change.
    const dangling = structuredClone(apply(state, { type: 'site.update', socialImage: 'a_table' }));
    dangling.pages[byTitle('Kitchens').id].seo.socialImage = 'a_gone';
    const d = sharingView(dangling, dangling.pages[byTitle('Kitchens').id]);
    expect(d).toMatchObject({ imageSource: 'page', imageName: undefined });
    expect(d.imageNote).toBe('The image chosen for this page is no longer in Assets, so a shared link to it shows no picture. Choose another image, or return to the site’s image.');
    expect(d.picker).toMatchObject({ inherited: 'a_table', back: 'Use the site’s image' });
    // One that is a file but no picture says so, rather than that it has gone.
    const pdf = structuredClone(apply(state, { type: 'site.update', socialImage: 'a_table' }));
    pdf.assets.assets['a_menu'] = image('a_menu', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    pdf.pages[byTitle('Kitchens').id].seo.socialImage = 'a_menu';
    expect(sharingView(pdf, pdf.pages[byTitle('Kitchens').id]).imageNote).toMatch(/^The file chosen for this page is not an image, so/);
    const noSite = structuredClone(apply(state, { type: 'site.update', socialImage: null }));
    noSite.assets.assets['a_menu'] = pdf.assets.assets['a_menu'];
    noSite.pages[byTitle('Kitchens').id].seo.socialImage = 'a_menu';
    expect(sharingView(noSite, noSite.pages[byTitle('Kitchens').id]).imageNote).toMatch(/Choose another image, or remove it\.$/);
    // A site image that is a document is no image to return to.
    const doc = structuredClone(apply(state, { type: 'site.update', socialImage: 'a_table' }));
    doc.assets.assets['a_table'] = image('a_table', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    expect(sharingView(doc, doc.pages[byTitle('Kitchens').id]).picker).toMatchObject({ inherited: null, back: 'Remove image' });
    const gone = structuredClone(apply(state, { type: 'site.update', socialImage: 'a_table' }));
    delete gone.assets.assets['a_table'];
    const g = sharingView(gone, gone.pages[byTitle('Kitchens').id]);
    expect(g.imageSource).toBe('site');
    expect(g.picker.inherited).toBeNull();
    expect(g.imageNote).toMatch(/no longer in Assets/);
    gone.assets.assets['a_table'] = image('a_table', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    expect(sharingView(gone, gone.pages[byTitle('Kitchens').id]).imageNote).toMatch(/^The site’s sharing image is not an image, so/);
  });

  it('names the effective title and description together, wherever each comes from', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    const s = apply(state, { type: 'site.update', description: 'Kitchens and gardens' });
    expect(sharingView(s, s.pages[kitchens.id])).toMatchObject({ title: 'Kitchens · Test Studio', description: 'Kitchens and gardens' });
    const own = apply(s, { type: 'page.update', pageId: kitchens.id, seoTitle: 'Our kitchens', description: 'Oak and steel' });
    expect(sharingView(own, own.pages[kitchens.id])).toMatchObject({ title: 'Our kitchens', description: 'Oak and steel' });
    const none = apply(state, { type: 'site.update', description: '' });
    expect(sharingView(none, none.pages[kitchens.id])).toMatchObject({ description: '' });
  });

  it('says the image’s address needs a usable public URL, and names the host and sub-path site once it has one', () => {
    const { state, byTitle } = site({ url: null });
    const v = sharingView(state, byTitle('Kitchens'));
    expect(v.host).toBeUndefined();
    expect(v.addressNote).toMatch(/no usable public URL/);
    const sub = site({ url: 'https://me.github.io/studio/' });
    expect(sharingView(sub.state, sub.byTitle('Kitchens'))).toMatchObject({ host: 'me.github.io', addressNote: null });
    const port = site({ url: 'https://studio.example:8443' });
    expect(sharingView(port.state, port.byTitle('Kitchens')).host).toBe('studio.example:8443');
    // A stored address the build refuses is no public URL either.
    const bad = site();
    bad.state.site.baseUrl = 'http://studio.example';
    expect(sharingView(bad.state, bad.byTitle('Kitchens'))).toMatchObject({ host: undefined, addressNote: expect.stringMatching(/no usable public URL/) });
  });
});

describe('searchSummary', () => {
  it('lists a page’s own sharing image and where it is kept out of search, nothing when it has neither', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    expect(searchSummary(kitchens)).toBeUndefined();
    kitchens.seo.socialImage = 'a_kitchen';
    expect(searchSummary(kitchens)).toBe('Own sharing image');
    kitchens.seo.noindex = true;
    expect(searchSummary(kitchens)).toBe('Own sharing image · Not in search engines');
    kitchens.seo.searchHidden = true;
    expect(searchSummary(kitchens)).toBe('Own sharing image · Hidden from all search');
    delete kitchens.seo.socialImage;
    expect(searchSummary(kitchens)).toBe('Hidden from all search');
    delete kitchens.seo.searchHidden;
    expect(searchSummary(kitchens)).toBe('Not in search engines');
    delete kitchens.seo.noindex;
    kitchens.seo.searchHidden = true;
    expect(searchSummary(kitchens)).toBe('Not in site search');
    expect(state).toBeTruthy();
  });
});

describe('the generated sharing tags', () => {
  it('writes each page’s own image, else the site’s, as an absolute address under the public URL', () => {
    const { state, byTitle } = site();
    const s = apply(
      state,
      { type: 'site.update', socialImage: 'a_table', baseUrl: 'https://studio.example/work/' },
      { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: 'a_kitchen' },
      { type: 'page.update', pageId: byTitle('About').id, socialImage: 'a_bedroom' }
    );
    expect(ogImages(head(s, s.pages[byTitle('Kitchens').id]))).toEqual(['https://studio.example/work/assets/kitchen.jpg']);
    expect(ogImages(head(s, s.pages[byTitle('About').id]))).toEqual(['https://studio.example/work/assets/bedroom.jpg']);
    // The page on the site's default.
    expect(ogImages(head(s, s.pages[s.site.homePageId]))).toEqual(['https://studio.example/work/assets/studio-table.jpg']);
    const kitchens = head(s, s.pages[byTitle('Kitchens').id]);
    expect(kitchens).toContain('<meta property="og:image:width" content="1200" />');
    expect(kitchens).toContain('<meta property="og:image:height" content="630" />');
    expect(kitchens).toContain('<meta property="og:image:alt" content={"An oak kitchen"} />');
    expect(kitchens).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('returns a cleared page to the site’s image, and writes none without any or without a public URL', () => {
    const { state, byTitle } = site();
    const own = apply(state, { type: 'site.update', socialImage: 'a_table' }, { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: 'a_kitchen' });
    const cleared = apply(own, { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: null });
    expect(ogImages(head(cleared, cleared.pages[byTitle('Kitchens').id]))).toEqual(['https://studio.example/assets/studio-table.jpg']);
    const noImages = apply(cleared, { type: 'site.update', socialImage: null });
    expect(ogImages(head(noImages, noImages.pages[byTitle('Kitchens').id]))).toEqual([]);
    expect(head(noImages, noImages.pages[byTitle('Kitchens').id])).toContain('<meta name="twitter:card" content="summary" />');
    const noUrl = site({ url: null });
    const s = apply(noUrl.state, { type: 'page.update', pageId: noUrl.byTitle('Kitchens').id, socialImage: 'a_kitchen' });
    const bare = head(s, s.pages[noUrl.byTitle('Kitchens').id]);
    expect(bare).not.toMatch(/og:image/);
    expect(bare).toContain('<meta name="twitter:card" content="summary" />');
  });

  it('leaves the picture without alt text when none is suggested, never the library’s note, and keeps its own size', () => {
    const { state, byTitle } = site();
    state.assets.assets['a_wide'] = image('a_wide', 'Wide', { width: 2000, height: 900, description: 'A wide kitchen' });
    const s = apply(state, { type: 'page.update', pageId: byTitle('Kitchens').id, socialImage: 'a_wide' });
    const src = head(s, s.pages[byTitle('Kitchens').id]);
    expect(src).toContain('<meta property="og:image:width" content="2000" />');
    expect(src).toContain('<meta property="og:image:height" content="900" />');
    expect(src).toContain('<meta property="og:image" content=');
    expect(src).not.toContain('image:alt');
    expect(src).not.toContain('A wide kitchen');
  });

  it('writes no image for a page whose own image has gone, even when the site has one', () => {
    const { state, byTitle } = site();
    const s = apply(state, { type: 'site.update', socialImage: 'a_table' });
    s.pages[byTitle('Kitchens').id].seo.socialImage = 'a_gone';
    expect(ogImages(head(s, s.pages[byTitle('Kitchens').id]))).toEqual([]);
    expect(ogImages(head(s, s.pages[s.site.homePageId]))).toEqual(['https://studio.example/assets/studio-table.jpg']);
  });

  it('leaves out a picture that is not a picture, where it used to name the file as the sharing image', () => {
    const { state, byTitle } = site();
    state.assets.assets['a_doc'] = image('a_doc', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    state.pages[byTitle('Kitchens').id].seo.socialImage = 'a_doc';
    expect(ogImages(head(state, state.pages[byTitle('Kitchens').id]))).toEqual([]);
    expect(head(state, state.pages[byTitle('Kitchens').id])).toContain('<meta name="twitter:card" content="summary" />');
    // The site's image is held to it too, and a picture still writes its tag with the same public URL.
    delete state.pages[byTitle('Kitchens').id].seo.socialImage;
    state.site.socialImage = 'a_doc';
    expect(ogImages(head(state, state.pages[byTitle('Kitchens').id]))).toEqual([]);
    state.site.socialImage = 'a_kitchen';
    expect(ogImages(head(state, state.pages[byTitle('Kitchens').id]))).toEqual(['https://studio.example/assets/kitchen.jpg']);
  });

  it('carries the title and description the preview shows, the page’s own over the site’s', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens').id;
    const s = apply(state, { type: 'site.update', description: 'Kitchens and gardens' }, { type: 'page.update', pageId: kitchens, seoTitle: 'Our kitchens' });
    const src = head(s, s.pages[kitchens]);
    expect(src).toContain('<title>{"Our kitchens"}</title>');
    expect(src).toContain('<meta property="og:title" content={"Our kitchens"} />');
    expect(src).toContain('<meta name="description" content={"Kitchens and gardens"} />');
    expect(src).toContain('<meta property="og:description" content={"Kitchens and gardens"} />');
    expect(sharingView(s, s.pages[kitchens])).toMatchObject({ title: 'Our kitchens', description: 'Kitchens and gardens' });
    const own = apply(s, { type: 'page.update', pageId: kitchens, description: 'Oak and steel' });
    expect(head(own, own.pages[kitchens])).toContain('<meta name="description" content={"Oak and steel"} />');
    expect(head(own, own.pages[kitchens])).toContain('<meta property="og:description" content={"Oak and steel"} />');
    expect(sharingView(own, own.pages[kitchens]).description).toBe('Oak and steel');
    // The home page is titled with the site's name, and the head says what the preview does.
    expect(head(own, own.pages[own.site.homePageId])).toContain('<title>{"Test Studio"}</title>');
    expect(sharingView(own, own.pages[own.site.homePageId]).title).toBe('Test Studio');
  });
});
