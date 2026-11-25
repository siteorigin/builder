/**
 * Redirects the author manages (#581): old addresses that lead to a page, a post or another address, followed through
 * chains and refused round loops, with the HTTP 301 rules the website's host reads (`_redirects`, `vercel.json`) beside
 * each old address's page, and the drafts left out of both.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState, SiteRedirect } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject, liveRedirects, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { generateHostRedirects, generateVercelConfig, HOST_REDIRECTS_FILE, VERCEL_CONFIG_FILE } from '@generator/host-redirects';
import { resolveRedirects } from '@shared/redirects';
import { archivePages } from '@shared/archives';
import { validateRoute } from '@shared/routes';
import { heldAsMedia } from '../../src/main/project/versions';
import { deliverVercelConfig } from '../../src/main/export';
import { ProjectSession } from '../../src/main/project/session';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const refusal = (s: ProjectState, ...ops: EditOperation[]) => {
  try {
    applyOperations(s, ops);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('The change was not refused.');
};
const pageAt = (s: ProjectState, route: string) => Object.values(s.pages).find((p) => p.route === route)!;
/** The site's redirects, set as a hand-edited site.json would have them. */
const withRedirects = (s: ProjectState, redirects: SiteRedirect[]): ProjectState => ({ ...s, site: { ...s.site, redirects } });
const codes = (s: ProjectState) => validateState(s).filter((d) => d.code.startsWith('REDIRECT_')).map((d) => [d.code, d.site]);

/** A business site with a blog: one published post, one draft, and a draft page. */
function site() {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', publishedAt: '2026-01-12', draft: false, body: ['Bring an apron.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-04-01', body: ['Not yet.'] },
    { type: 'page.create', pageId: 'pg_preview01', title: 'Preview', route: '/preview/' },
    { type: 'page.update', pageId: 'pg_preview01', draft: true }
  );
}

describe('following redirects', () => {
  it('sends an old address to a page, a post, or another address, and follows a chain straight to its end', () => {
    const s = site();
    const about = pageAt(s, '/about/');
    const state = withRedirects(s, [
      { from: '/team/', pageId: about.id },
      { from: '/old-winter/', entryId: 'en_winter' },
      { from: '/news/', to: '/blog/' },
      { from: '/campaign/', to: '/team/' },
      { from: '/spring/', to: '/campaign/' }
    ]);
    const live = liveRedirects(state).map((r) => [r.from, r.to, r.via]);
    expect(live).toEqual([
      ['/team/', '/about/', []],
      ['/old-winter/', '/blog/winter-workshop/', []],
      ['/news/', '/blog/', []],
      ['/campaign/', '/about/', ['/team/']],
      ['/spring/', '/about/', ['/campaign/', '/team/']]
    ]);
    // A chain still arrives, so it is a warning; the website goes straight to the end.
    expect(validateState(state).filter((d) => d.code.startsWith('REDIRECT_')).map((d) => [d.code, d.severity, d.site])).toEqual([
      ['REDIRECT_CHAIN', 'warning', 'redirect:/campaign/'],
      ['REDIRECT_CHAIN', 'warning', 'redirect:/spring/']
    ]);
    expect(generateProject(state).get('src/routes/spring/+page.svelte')).toContain('const to = resolve("/about/");');
    expect(validateState(state).find((d) => d.site === 'redirect:/spring/')!.message).toBe(
      'The old address /spring/ reaches /about/ through /campaign/ and /team/. The website sends visitors straight to /about/; send /spring/ there in Site settings, under Redirects, so it keeps arriving if one of those addresses changes.'
    );
  });

  it('leaves out an address that leads to itself, round a loop, into one, or nowhere, and says why', () => {
    const s = site();
    const state = withRedirects(s, [
      { from: '/self/', to: '/self/' },
      { from: '/a/', to: '/b/' },
      { from: '/b/', to: '/a/' },
      { from: '/into/', to: '/a/' },
      { from: '/nowhere/', to: '/gone/' },
      { from: '/fine/', to: '/contact/' }
    ]);
    const { live, problems } = resolveRedirects(state);
    expect(live.map((r) => r.from)).toEqual(['/fine/']);
    expect(problems).toEqual([
      { kind: 'self', from: '/self/' },
      { kind: 'loop', from: '/a/', cycle: ['/a/', '/b/'] },
      { kind: 'loop', from: '/b/', cycle: ['/a/', '/b/'] },
      { kind: 'loop', from: '/into/', cycle: ['/a/', '/b/'] },
      { kind: 'missing', from: '/nowhere/', to: '/gone/' }
    ]);
    const found = validateState(state).filter((d) => d.code.startsWith('REDIRECT_'));
    expect(found.map((d) => [d.code, d.severity, d.site])).toEqual([
      ['REDIRECT_SELF', 'error', 'redirect:/self/'],
      ['REDIRECT_LOOP', 'error', 'redirect:/a/'],
      ['REDIRECT_LOOP', 'error', 'redirect:/b/'],
      ['REDIRECT_LOOP', 'error', 'redirect:/into/'],
      ['REDIRECT_PATH_MISSING', 'warning', 'redirect:/nowhere/']
    ]);
    expect(found[3].message).toBe('The old address /into/ leads into a loop (/a/ → /b/ → /a/) that never arrives anywhere, so the website leaves it out. Send one of them to a page in Site settings, under Redirects.');
    // None of them gets a page or a rule; the one that arrives does.
    const files = generateProject(state);
    expect([...files.keys()].filter((f) => /routes\/(self|a|b|into|nowhere|fine)\//.test(f))).toEqual(['src/routes/fine/+page.svelte']);
    expect(files.get('src/routes/fine/+page.svelte')).toContain('const to = resolve("/contact/");');
    expect(files.get(HOST_REDIRECTS_FILE)).not.toMatch(/\/(self|a|b|into|nowhere)\//);
  });

  it('flags an address that is not one the site can have, and never sends visitors there', () => {
    // /BLOG/ names the blog's index only to a case-insensitive file system: as routes spell it, it is not an address.
    const state = withRedirects(run(site(), { type: 'redirect.add', from: '/x/', to: '/' }), [{ from: '/old/', to: '/Not Valid/' }, { from: '/news/', to: '/BLOG/' }, { from: '/via/', to: '/news/' }]);
    expect(validateState(state).filter((d) => d.code.startsWith('REDIRECT_')).map((d) => [d.code, d.severity, d.site])).toEqual([
      ['REDIRECT_PATH_INVALID', 'error', 'redirect:/old/'],
      ['REDIRECT_PATH_INVALID', 'error', 'redirect:/news/'],
      ['REDIRECT_PATH_MISSING', 'warning', 'redirect:/via/']
    ]);
    expect(liveRedirects(state)).toEqual([]);
    expect(generateHostRedirects(state)).toBeNull();
  });

  it('names the winning redirect’s problem beside a damaged duplicate', () => {
    const state = withRedirects(site(), [{ from: '/a/', to: '/a/' }, { from: '/a/', to: '/bad path/' }]);
    expect(codes(state)).toEqual([
      ['REDIRECT_PATH_INVALID', 'redirect:/a/'],
      ['REDIRECT_SELF', 'redirect:/a/']
    ]);
  });

  it('follows a chain of any length, naming the first few addresses on the way', () => {
    const n = 20_000;
    const redirects: SiteRedirect[] = Array.from({ length: n }, (_, i) => ({ from: `/r${i}/`, to: i === n - 1 ? '/' : `/r${i + 1}/` }));
    const { live, problems } = resolveRedirects(withRedirects(site(), redirects));
    expect(live).toHaveLength(n);
    expect(live[0]).toMatchObject({ to: '/', hops: n - 1 });
    expect(live[0].via).toEqual(['/r1/', '/r2/', '/r3/', '/r4/', '/r5/', '/r6/', '/r7/', '/r8/', '/r9/', '/r10/']);
    // Thirteen in a row: the first passes through twelve, and names ten of them.
    const first = validateState(withRedirects(site(), redirects.slice(-13))).find((d) => d.site === `redirect:/r${n - 13}/`)!;
    expect(first.message).toContain(`reaches / through /r${n - 12}/, /r${n - 11}/,`);
    expect(first.message).toContain(`, /r${n - 3}/ and 2 more. The website sends visitors straight to /;`);
    expect(problems.filter((p) => p.kind === 'chain')).toHaveLength(n - 1);
  });

  it('sends an address to a page of a category archive however deep, and to the archive page where a draft is kept back', () => {
    let s = run(
      site(),
      { type: 'collection.update', collectionId: 'posts', pageSize: 1 },
      { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2026-03-01', draft: false, body: ['Come in.'] }
    );
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', terms: { categories: ['news'] } }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', terms: { categories: ['news'] } });
    s = run(s, { type: 'redirect.add', from: '/older-news/', to: '/blog/category/news/page/2/' });
    expect(liveRedirects(s).map((r) => [r.from, r.to, r.page, r.entry])).toEqual([['/older-news/', '/blog/category/news/page/2/', undefined, undefined]]);
    expect(codes(s)).toEqual([]);
    // A draft made before archive pages, at the blog's second page: the archive page is what the website has there.
    const kept = withRedirects({ ...s, pages: { ...s.pages, pg_preview01: { ...s.pages.pg_preview01, route: '/blog/page/2/' } } }, [{ from: '/older-posts/', to: '/blog/page/2/' }]);
    expect(liveRedirects(kept).map((r) => [r.from, r.to, r.page?.id])).toEqual([['/older-posts/', '/blog/page/2/', undefined]]);
    expect(publishedState(kept).site.redirects).toEqual([{ from: '/older-posts/', to: '/blog/page/2/' }]);
    // A hand-written redirect at an archive page's address gives way to it, with drafts or without.
    const taken = withRedirects(s, [{ from: '/blog/page/2/', to: '/preview/' }]);
    expect(liveRedirects(taken)).toEqual([]);
    expect(archivePages(publishedState(taken)).map((p) => p.route)).toEqual(archivePages(taken).map((p) => p.route));
  });

  it('leaves out of the published website every redirect that ends at a draft, directly or through others', () => {
    const s = site();
    const state = withRedirects(s, [
      { from: '/sneak-peek/', pageId: 'pg_preview01' },
      { from: '/teaser/', to: '/sneak-peek/' },
      { from: '/peek/', to: '/preview/' },
      { from: '/plans/', entryId: 'en_secret' },
      { from: '/old-winter/', entryId: 'en_winter' },
      { from: '/archive/', to: '/blog/' }
    ]);
    // The editable project keeps them all, for the preview.
    expect(liveRedirects(state).map((r) => r.from)).toEqual(['/sneak-peek/', '/teaser/', '/peek/', '/plans/', '/old-winter/', '/archive/']);
    const live = publishedState(state);
    expect(live.site.redirects).toEqual([
      { from: '/old-winter/', entryId: 'en_winter' },
      { from: '/archive/', to: '/blog/' }
    ]);
    const files = generateProject(live);
    expect(files.get(HOST_REDIRECTS_FILE)).toBe(
      [
        '# Old addresses of this website, each sent on to where it is now with a permanent redirect (HTTP 301).',
        '# Written for Cloudflare Pages by SiteOrigin Builder from siteorigin/site.json.',
        '/old-winter/ /blog/winter-workshop/ 301',
        '/old-winter /blog/winter-workshop/ 301',
        '/archive/ /blog/ 301',
        '/archive /blog/ 301',
        ''
      ].join('\n')
    );
    expect([...files.keys()].filter((f) => /routes\/(sneak-peek|teaser|peek|plans)\//.test(f))).toEqual([]);
  });
});

describe('host redirect rules', () => {
  const moved = () => {
    const s = site();
    return withRedirects(s, [
      { from: '/team/', pageId: pageAt(s, '/about/').id },
      { from: '/お問い合わせ/', to: '/contact/' },
      { from: '/studio/old-kiln/', to: '/お知らせ/' },
      { from: '/home-again/', to: '/' }
    ]);
  };
  const withPage = (s: ProjectState) => run(s, { type: 'page.create', title: 'お知らせ', route: '/お知らせ/' });

  it('writes Cloudflare Pages rules by default: both forms of each old address, escaped as browsers send them', () => {
    expect(generateHostRedirects(withPage(moved()))!.split('\n').slice(2)).toEqual([
      '/team/ /about/ 301',
      '/team /about/ 301',
      '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/ /contact/ 301',
      '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B /contact/ 301',
      '/studio/old-kiln/ /%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B/ 301',
      '/studio/old-kiln /%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B/ 301',
      '/home-again/ / 301',
      '/home-again / 301',
      ''
    ]);
  });

  it('forces Netlify’s rules past the page each old address keeps, one rule for both forms', () => {
    const s = run(withPage(moved()), { type: 'site.update', redirectHost: 'netlify' });
    expect(s.site.redirectHost).toBe('netlify');
    const text = generateHostRedirects(s)!;
    expect(text.split('\n')[1]).toBe('# Written for Netlify by SiteOrigin Builder from siteorigin/site.json.');
    expect(text.split('\n').slice(2)).toEqual(['/team/ /about/ 301!', '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/ /contact/ 301!', '/studio/old-kiln/ /%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B/ 301!', '/home-again/ / 301!', '']);
    expect(generateVercelConfig(s)).toBeNull();
    expect(generateHostRedirects(run(s, { type: 'site.update', baseUrl: 'https://example.com/studio' }))!.split('\n')[2]).toBe('/studio/team/ /studio/about/ 301!');
    // Back to the default stores nothing.
    expect(run(s, { type: 'site.update', redirectHost: 'cloudflare' }).site.redirectHost).toBeUndefined();
  });

  it('writes vercel.json with HTTP 301 rules once the host is Vercel, under the site’s sub-path', () => {
    const s = run(withPage(moved()), { type: 'site.update', redirectHost: 'vercel', baseUrl: 'https://example.com/studio.v2' });
    const config = JSON.parse(generateVercelConfig(s)!);
    const contact = '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B';
    const news = '/studio.v2/%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B/';
    expect(config.redirects).toEqual([
      { source: '/studio.v2/team/', destination: '/studio.v2/about/', statusCode: 301 },
      { source: '/studio.v2/team', destination: '/studio.v2/about/', statusCode: 301 },
      { source: `/studio.v2${contact}/`, destination: '/studio.v2/contact/', statusCode: 301 },
      { source: `/studio.v2${contact}`, destination: '/studio.v2/contact/', statusCode: 301 },
      { source: '/studio.v2/studio/old-kiln/', destination: news, statusCode: 301 },
      { source: '/studio.v2/studio/old-kiln', destination: news, statusCode: 301 },
      { source: '/studio.v2/home-again/', destination: '/studio.v2/', statusCode: 301 },
      { source: '/studio.v2/home-again', destination: '/studio.v2/', statusCode: 301 }
    ]);
    expect(config.redirects.every((r: Record<string, unknown>) => !('permanent' in r))).toBe(true);
    // _redirects is still written, as Cloudflare Pages reads it, with no character escaped twice.
    expect(generateHostRedirects(s)).toContain('/studio.v2/team/ /studio.v2/about/ 301\n');
    expect(generateHostRedirects(s)).not.toContain('%25');
    const files = generateProject(s);
    expect(files.get(VERCEL_CONFIG_FILE)).toBe(generateVercelConfig(s));
    expect(files.get(HOST_REDIRECTS_FILE)).toBe(generateHostRedirects(s));
  });

  it('writes no rule files while the site keeps no old address', () => {
    const s = run(site(), { type: 'site.update', redirectHost: 'vercel' });
    const files = generateProject(s);
    expect(files.has(HOST_REDIRECTS_FILE)).toBe(false);
    expect(files.has(VERCEL_CONFIG_FILE)).toBe(false);
    // With redirects, vercel.json is written only for Vercel.
    const kept = run(site(), { type: 'redirect.add', from: '/team/', to: '/about/' });
    expect(generateProject(kept).has(VERCEL_CONFIG_FILE)).toBe(false);
    expect(generateProject(run(kept, { type: 'site.update', redirectHost: 'netlify' })).has(VERCEL_CONFIG_FILE)).toBe(false);
  });

  it('makes the rules again when a redirect in the middle of a chain changes, from the cache as from scratch', () => {
    const s = site();
    const about = pageAt(s, '/about/');
    const contact = pageAt(s, '/contact/');
    let state = run(s, { type: 'redirect.add', from: '/team/', pageId: about.id }, { type: 'redirect.add', from: '/campaign/', to: '/team/' });
    const cache = new GenerationCache();
    expect(generateProject(state, {}, cache).get(HOST_REDIRECTS_FILE)).toContain('/campaign/ /about/ 301');
    state = run(state, { type: 'redirect.update', from: '/team/', pageId: contact.id });
    const cached = generateProject(state, {}, cache);
    expect(cached.get(HOST_REDIRECTS_FILE)).toContain('/campaign/ /contact/ 301');
    expect(cached.get('src/routes/campaign/+page.svelte')).toContain('resolve("/contact/")');
    expect(cached).toEqual(generateProject(state));
  });

  it('keeps the rule files out of the routes a page can take and out of saved versions', () => {
    expect(validateRoute('/_redirects/')).not.toBeNull();
    expect(validateRoute('/vercel.json/')).not.toBeNull();
    expect(heldAsMedia('static/_redirects')).toBe(false);
  });
});

describe('managing redirects', () => {
  it('adds, changes and removes the author’s own redirects, keeping a move’s as it was recorded', () => {
    let s = site();
    const about = pageAt(s, '/about/');
    s = run(s, { type: 'page.update', pageId: about.id, route: '/our-story/' });
    expect(s.site.redirects).toEqual([{ from: '/about/', pageId: about.id }]);
    s = run(s, { type: 'redirect.add', from: '/Old Services', to: '/contact' }, { type: 'redirect.add', from: '/old-winter', entryId: 'en_winter' });
    expect(s.site.redirects).toEqual([
      { from: '/about/', pageId: about.id },
      { from: '/old-services/', custom: true, to: '/contact/' },
      { from: '/old-winter/', custom: true, entryId: 'en_winter' }
    ]);
    // Sending a move's redirect elsewhere keeps it the move's.
    s = run(s, { type: 'redirect.update', from: '/about/', to: '/contact/' }, { type: 'redirect.update', from: '/old-services/', pageId: about.id });
    expect(s.site.redirects).toEqual([
      { from: '/about/', to: '/contact/' },
      { from: '/old-services/', custom: true, pageId: about.id },
      { from: '/old-winter/', custom: true, entryId: 'en_winter' }
    ]);
    s = run(s, { type: 'redirect.remove', from: '/about/' }, { type: 'redirect.remove', from: '/old-services/' }, { type: 'redirect.remove', from: '/old-winter/' });
    expect(s.site.redirects).toBeUndefined();
  });

  it('refuses an address the site already has, one that leads nowhere it can, and a loop', () => {
    const s = run(site(), { type: 'redirect.add', from: '/a/', to: '/contact/' });
    expect(refusal(s, { type: 'redirect.add', from: '/contact/', to: '/' })).toBe('/contact/ is the address of the page “Contact”. Move the page first, or choose another address.');
    expect(refusal(s, { type: 'redirect.add', from: '/blog/winter-workshop/', to: '/' })).toBe('/blog/winter-workshop/ is the address of the entry “Winter workshop”. Choose another address.');
    expect(refusal(s, { type: 'redirect.add', from: '/blog/page/2/', to: '/' })).toContain("archive pages");
    expect(refusal(s, { type: 'redirect.add', from: '/a/', to: '/' })).toBe('/a/ already sends visitors on. Change where it goes instead.');
    expect(refusal(s, { type: 'redirect.add', from: '/', to: '/contact/' })).toBe('The Home page address cannot send visitors elsewhere.');
    expect(refusal(s, { type: 'redirect.add', from: 'https://example.com/x/', to: '/' })).toBe('The old address must be an address of this site starting with "/", such as /old-services/.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/', to: '//evil.example/' })).toBe('Where it goes must be an address of this site starting with "/", such as /old-services/.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/', to: '/x/' })).toBe('/x/ cannot send visitors to itself. Choose another address.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/' })).toBe('Choose where the old address sends visitors: a page, a post, or another address of the site.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/', pageId: 'pg_gone', to: '/' })).toBe('Choose where the old address sends visitors: a page, a post, or another address of the site.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/', pageId: 'pg_gone' })).toBe('The page to send visitors to does not exist.');
    expect(refusal(s, { type: 'redirect.add', from: '/x/', entryId: 'en_gone' })).toBe('The post to send visitors to does not exist.');
    expect(refusal(s, { type: 'redirect.add', from: '/b/', to: '/a/' }, { type: 'redirect.add', from: '/c/', to: '/b/' }, { type: 'redirect.update', from: '/a/', to: '/c/' })).toContain('would make a loop of old addresses (/a/ → /c/ → /b/ → /a/)');
    expect(refusal(run(s, { type: 'redirect.add', from: '/y/', to: '/x/' }), { type: 'redirect.add', from: '/x/', to: '/y/' })).toContain('Sending /x/ there would make a loop of old addresses (/x/ → /y/ → /x/)');
    expect(refusal(run(s, { type: 'redirect.add', from: '/b/', to: '/contact/' }), { type: 'redirect.add', from: '/c/', to: '/b/' }, { type: 'redirect.update', from: '/b/', to: '/c/' })).toContain('(/b/ → /c/ → /b/)');
    const b = run(s, { type: 'redirect.add', from: '/b/', to: '/a/' });
    expect(refusal(b, { type: 'redirect.update', from: '/a/', to: '/b/' })).toBe('Sending /a/ there would make a loop of old addresses (/a/ → /b/ → /a/) that never arrives anywhere. Choose another address.');
    expect(refusal(b, { type: 'redirect.remove', from: '/nope/' })).toBe('/nope/ is not an old address the site keeps.');
    // An address nothing has yet is kept, and left out of the website until something is there.
    const later = run(b, { type: 'redirect.add', from: '/soon/', to: '/coming-soon/' });
    expect(codes(later)).toContainEqual(['REDIRECT_PATH_MISSING', 'redirect:/soon/']);
    expect(liveRedirects(later).map((r) => r.from)).not.toContain('/soon/');
    expect(liveRedirects(run(later, { type: 'page.create', title: 'Coming soon', route: '/coming-soon/' })).find((r) => r.from === '/soon/')?.to).toBe('/coming-soon/');
  });

  it('changes and removes the redirect named exactly, beside one spelled as routes are', () => {
    const s = withRedirects(site(), [{ from: '/old', to: '/about/' }, { from: '/old/', to: '/contact/' }]);
    expect(run(s, { type: 'redirect.remove', from: '/old' }).site.redirects).toEqual([{ from: '/old/', to: '/contact/' }]);
    expect(run(s, { type: 'redirect.update', from: '/old', to: '/' }).site.redirects).toEqual([{ from: '/old', to: '/' }, { from: '/old/', to: '/contact/' }]);
    expect(run(s, { type: 'redirect.remove', from: '/OLD/' }).site.redirects).toEqual([{ from: '/old', to: '/about/' }]);
  });

  it('lets a page take over an author’s redirect, and the redirect lead on to it', () => {
    let s = run(site(), { type: 'redirect.add', from: '/campaign/', to: '/old-post/' }, { type: 'redirect.add', from: '/old-post/', entryId: 'en_winter' });
    expect(liveRedirects(s).map((r) => [r.from, r.to])).toEqual([
      ['/campaign/', '/blog/winter-workshop/'],
      ['/old-post/', '/blog/winter-workshop/']
    ]);
    s = run(s, { type: 'page.create', title: 'Old post', route: '/old-post/' });
    expect(s.site.redirects).toEqual([{ from: '/campaign/', custom: true, to: '/old-post/' }]);
    expect(liveRedirects(s).map((r) => [r.from, r.to, r.page?.title])).toEqual([['/campaign/', '/old-post/', 'Old post']]);
  });
});

describe('redirects in the project session', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('writes the rules with each change and takes them back with undo and redo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-redirects-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
    const rules = join(dir, HOST_REDIRECTS_FILE);
    const ok = async (operations: EditOperation[]) => expect((await s.apply({ operations }, { label: 'Redirects' })).ok).toBe(true);
    await ok([{ type: 'redirect.add', from: '/team/', to: '/about/' }]);
    expect(readFileSync(rules, 'utf8')).toContain('/team/ /about/ 301\n');
    expect(readFileSync(join(dir, 'src/routes/team/+page.svelte'), 'utf8')).toContain('const to = resolve("/about/");');
    await ok([{ type: 'redirect.update', from: '/team/', to: '/contact/' }]);
    await ok([{ type: 'site.update', redirectHost: 'vercel' }]);
    expect(JSON.parse(readFileSync(join(dir, VERCEL_CONFIG_FILE), 'utf8')).redirects[0]).toEqual({ source: '/team/', destination: '/contact/', statusCode: 301 });
    await ok([{ type: 'redirect.remove', from: '/team/' }]);
    expect(existsSync(rules)).toBe(false);
    expect(existsSync(join(dir, VERCEL_CONFIG_FILE))).toBe(false);
    expect(existsSync(join(dir, 'src/routes/team'))).toBe(false);
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.site.redirects).toEqual([{ from: '/team/', custom: true, to: '/contact/' }]);
    expect(readFileSync(rules, 'utf8')).toContain('/team/ /contact/ 301\n');
    expect(JSON.parse(readFileSync(join(dir, VERCEL_CONFIG_FILE), 'utf8')).redirects).toEqual([
      { source: '/team/', destination: '/contact/', statusCode: 301 },
      { source: '/team', destination: '/contact/', statusCode: 301 }
    ]);
    await s.undo();
    await s.undo();
    expect(s.state.site.redirects).toEqual([{ from: '/team/', custom: true, to: '/about/' }]);
    expect(existsSync(join(dir, VERCEL_CONFIG_FILE))).toBe(false);
    await s.undo();
    expect(s.state.site.redirects).toBeUndefined();
    expect(existsSync(rules)).toBe(false);
    expect((await s.redo()).ok).toBe(true);
    expect(readFileSync(rules, 'utf8')).toContain('/team/ /about/ 301\n');
    await s.close();
  });

  it('keeps rules edited outside the app named once the website has none, so a forced rule never hides a new page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-redirects-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
    s.settleMs = 0;
    const ok = async (operations: EditOperation[]) => expect((await s.apply({ operations }, { label: 'Redirects' })).ok).toBe(true);
    await ok([{ type: 'site.update', redirectHost: 'netlify' }, { type: 'redirect.add', from: '/sale/', to: '/contact/' }]);
    const rules = join(dir, HOST_REDIRECTS_FILE);
    const edited = readFileSync(rules, 'utf8') + '/shop/ https://shop.example/ 301!\n';
    writeFileSync(rules, edited);
    // The last redirect goes and a page takes its address: the edited rules stay, named, so the forced 301 is seen.
    await ok([{ type: 'redirect.remove', from: '/sale/' }, { type: 'page.create', title: 'Sale', route: '/sale/' }]);
    expect(readFileSync(rules, 'utf8')).toBe(edited);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: HOST_REDIRECTS_FILE, kind: 'generated', builderMissing: true }));
    expect(s.conflicts.find((c) => c.path === HOST_REDIRECTS_FILE)!.reason).toContain('its host would still follow them, even past a page at one of those addresses');
    // Restored, it goes, and what was written in it is kept as a copy.
    await s.restoreGeneratedFile(HOST_REDIRECTS_FILE);
    expect(existsSync(rules)).toBe(false);
    expect(s.conflicts.some((c) => c.path === HOST_REDIRECTS_FILE)).toBe(false);
    expect(readFileSync(join(dir, s.savedCopies.find((c) => c.path === HOST_REDIRECTS_FILE)!.file), 'utf8')).toBe(edited);
    await s.close();
  });
});

describe('vercel.json in an exported website', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'so-vercel-'));
    dirs.push(d);
    return d;
  };

  it('goes beside the website only when SiteOrigin Builder generated it, and never over a file already there', async () => {
    const project = temp();
    const live = run(site(), { type: 'site.update', redirectHost: 'vercel' });
    const manifest = (files: Record<string, string>) => writeFileSync(join(project, 'siteorigin/generated-manifest.json'), JSON.stringify({ files }));
    mkdirSync(join(project, 'siteorigin'));
    writeFileSync(join(project, VERCEL_CONFIG_FILE), '{"redirects":[]}\n');
    // The author's own vercel.json configures their project, not the website.
    manifest({});
    const out = temp();
    expect(await deliverVercelConfig(project, out, live)).toBeNull();
    expect(existsSync(join(out, VERCEL_CONFIG_FILE))).toBe(false);
    manifest({ [VERCEL_CONFIG_FILE]: 'hash' });
    expect(await deliverVercelConfig(project, out, run(live, { type: 'site.update', redirectHost: 'netlify' }))).toBeNull();
    expect(existsSync(join(out, VERCEL_CONFIG_FILE))).toBe(false);
    expect(await deliverVercelConfig(project, out, live)).toBeNull();
    expect(readFileSync(join(out, VERCEL_CONFIG_FILE), 'utf8')).toBe('{"redirects":[]}\n');
    writeFileSync(join(out, VERCEL_CONFIG_FILE), '{"own":true}');
    expect(await deliverVercelConfig(project, out, live)).toBe('static/vercel.json takes the place of the redirect rules SiteOrigin Builder writes for Vercel. Delete or rename it, or choose another host in Site settings under Redirects, then export again.');
    expect(readFileSync(join(out, VERCEL_CONFIG_FILE), 'utf8')).toBe('{"own":true}');
  });
});
