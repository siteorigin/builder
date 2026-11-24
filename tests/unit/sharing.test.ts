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
  });

  it('takes the page’s own title and description over the defaults, and the site’s description when it has none', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    const withSite = apply(state, { type: 'site.update', description: 'Kitchens and gardens' });
    expect(pageSharing(withSite, byTitle('Kitchens')).description).toBe('Kitchens and gardens');
    const own = apply(withSite, { type: 'page.update', pageId: kitchens.id, seoTitle: 'Our kitchens', description: 'Oak and steel' });
    expect(pageSharing(own, own.pages[kitchens.id])).toMatchObject({ title: 'Our kitchens', description: 'Oak and steel' });
    const none = apply(state, { type: 'site.update', description: '' });
    expect(pageSharing(none, none.pages[kitchens.id]).description).toBe('');
  });

  it('shares a page with its own image, else the site’s, else none', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    expect(pageSharing(state, kitchens)).toMatchObject({ imageId: null, image: undefined, source: 'none' });
    const siteImage = apply(state, { type: 'site.update', socialImage: 'a_table' });
    expect(pageSharing(siteImage, siteImage.pages[kitchens.id])).toMatchObject({ imageId: 'a_table', source: 'site' });
    const own = apply(siteImage, { type: 'page.update', pageId: kitchens.id, socialImage: 'a_kitchen' });
    expect(pageSharing(own, own.pages[kitchens.id])).toMatchObject({ imageId: 'a_kitchen', source: 'page' });
    expect(pageSharing(own, own.pages[kitchens.id]).image?.name).toBe('Kitchen');
    // Another page is not affected.
    expect(pageSharing(own, own.pages[own.site.homePageId])).toMatchObject({ imageId: 'a_table', source: 'site' });
    // Clearing the page's choice returns it to the site's.
    const cleared = apply(own, { type: 'page.update', pageId: kitchens.id, socialImage: null });
    expect(cleared.pages[kitchens.id].seo.socialImage).toBeUndefined();
    expect(pageSharing(cleared, cleared.pages[kitchens.id])).toMatchObject({ imageId: 'a_table', source: 'site' });
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
    expect(v.imageNote).toBe('Only this page uses it. Pages without their own image show the site’s sharing image, Studio table. It also shows on this page’s card in page lists.');
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
    expect(v.imageNote).toContain('The site has no sharing image, so other pages are shared without one.');
    const gone = apply(state, { type: 'site.update', socialImage: 'a_table' });
    delete gone.assets.assets['a_table'];
    const g = sharingView(gone, gone.pages[byTitle('Kitchens').id]);
    expect(g.imageSource).toBe('site');
    expect(g.picker.inherited).toBeNull();
    expect(g.imageNote).toMatch(/no longer in Assets/);
  });

  it('names the effective title and description together, wherever each comes from', () => {
    const { state, byTitle } = site();
    const kitchens = byTitle('Kitchens');
    const s = apply(state, { type: 'site.update', description: 'Kitchens and gardens' });
    expect(sharingView(s, s.pages[kitchens.id])).toMatchObject({ title: 'Kitchens · Test Studio', titleOwn: false, description: 'Kitchens and gardens', descriptionFrom: 'site' });
    const own = apply(s, { type: 'page.update', pageId: kitchens.id, seoTitle: 'Our kitchens', description: 'Oak and steel' });
    expect(sharingView(own, own.pages[kitchens.id])).toMatchObject({ title: 'Our kitchens', titleOwn: true, description: 'Oak and steel', descriptionFrom: 'page' });
    const none = apply(state, { type: 'site.update', description: '' });
    expect(sharingView(none, none.pages[kitchens.id])).toMatchObject({ description: '', descriptionFrom: 'none' });
  });

  it('says the image’s address needs a usable public URL, and names the host and sub-path site once it has one', () => {
    const { state, byTitle } = site({ url: null });
    const v = sharingView(state, byTitle('Kitchens'));
    expect(v.host).toBeUndefined();
    expect(v.addressNote).toMatch(/no usable public URL/);
    const sub = site({ url: 'https://me.github.io/studio/' });
    expect(sharingView(sub.state, sub.byTitle('Kitchens'))).toMatchObject({ host: 'me.github.io', addressNote: null });
    // A stored address the build refuses is no public URL either.
    const bad = site();
    bad.state.site.baseUrl = 'http://studio.example';
    expect(sharingView(bad.state, bad.byTitle('Kitchens')).addressNote).toMatch(/no usable public URL/);
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
    delete kitchens.seo.noindex;
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
    expect(head(s, s.pages[noUrl.byTitle('Kitchens').id])).not.toMatch(/og:image"/);
  });

  it('leaves out a picture that is not a picture, where it used to name the file as the sharing image', () => {
    const { state, byTitle } = site();
    state.assets.assets['a_doc'] = image('a_doc', 'Menu', { kind: 'document', mime: 'application/pdf', file: 'static/assets/menu.pdf' });
    state.pages[byTitle('Kitchens').id].seo.socialImage = 'a_doc';
    expect(ogImages(head(state, state.pages[byTitle('Kitchens').id]))).toEqual([]);
  });

  it('carries the title and description the preview shows', () => {
    const { state, byTitle } = site();
    const s = apply(state, { type: 'site.update', description: 'Kitchens and gardens' }, { type: 'page.update', pageId: byTitle('Kitchens').id, seoTitle: 'Our kitchens' });
    const src = head(s, s.pages[byTitle('Kitchens').id]);
    expect(src).toContain('<meta property="og:title" content={"Our kitchens"} />');
    expect(src).toContain('<meta property="og:description" content={"Kitchens and gardens"} />');
  });
});
