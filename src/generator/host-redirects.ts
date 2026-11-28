/**
 * The hosts' own rules for the old addresses kept working: an HTTP 301 (moved permanently) from each old address
 * straight to where it leads now, which search engines read as the page having moved. Each old address also keeps its
 * page (see generateRedirect), which sends visitors on from any host, but with HTTP 200, as a page that is there.
 *
 * `_redirects` (in static/, so a build puts it at the root of the website) is read by Cloudflare Pages and Netlify,
 * one rule per line. The two read it differently, so it is written for the host the site names (SiteDoc.redirectHost):
 *
 * - Cloudflare Pages always follows a rule, ahead of any page at the address, but matches the address exactly, so each
 *   old address gets a rule with its trailing slash and one without. It refuses Netlify's forced status (`301!`).
 * - Netlify serves a page that is there ahead of a rule unless the rule is forced (`301!`), and matches an address with
 *   or without its trailing slash, so one forced rule covers both.
 *
 * Vercel reads neither: with the host set to Vercel, `vercel.json` beside the project's package.json (and at the root
 * of an exported website) gives it the same rules. Addresses are written as browsers send them (percent-encoded), under
 * the site's sub-path when its public URL has one.
 *
 * The hosts' caching rules go beside them (#1487): `_headers` (Cloudflare Pages and Netlify, written for every site)
 * and the `headers` of Vercel's `vercel.json` let browsers and the host's CDN keep the files SvelteKit builds into
 * `_app/immutable/` for a year without asking again. The build names each of those files by its contents, so a file
 * that changes gets a new address. Nothing else is: `static/assets/` keeps an author's own file at the name they gave
 * it, and a responsive copy shares its original's hash, so those addresses keep the host's own caching.
 *
 * A website built as a Node.js server (SiteDoc.deployTarget) is not served by these hosts' own static serving, so it
 * gets neither redirect file: each old address keeps its page, which sends visitors on.
 */
import { routeUrl } from '@shared/routes';
import { siteMount } from '@shared/crawler-policy';
import { resolveRedirects } from '@shared/redirects';
import type { ProjectState, RedirectHost, SiteDoc } from '@shared/types';
import { runsOnNode } from '@shared/deploy-target';
import { derived } from './cache';

/** Where the generated project keeps the rules Cloudflare Pages and Netlify read. */
export const HOST_REDIRECTS_FILE = 'static/_redirects';
/** Where it keeps Vercel's, beside package.json; an exported website has it at its root. */
export const VERCEL_CONFIG_FILE = 'vercel.json';
/** Where it keeps the caching rules Cloudflare Pages and Netlify read. */
export const HOST_HEADERS_FILE = 'static/_headers';
/** How long a browser or CDN may keep a file whose address changes with its contents: a year, never asking again. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** SvelteKit's folder of built files named by their contents (its default `appDir`, `_app`). */
const IMMUTABLE_DIR = '/_app/immutable/';

/** The host the site's redirect rules are written for: Cloudflare Pages unless it names another. */
export function redirectHost(site: Pick<SiteDoc, 'redirectHost'>): RedirectHost {
  return site.redirectHost === 'netlify' || site.redirectHost === 'vercel' ? site.redirectHost : 'cloudflare';
}

/** Each old address the website keeps, and where it sends visitors in the end, as routes. */
function redirectPairs(state: ProjectState): Array<[from: string, to: string]> {
  return derived(state, 'redirectPairs', (s) => resolveRedirects(s).live.map((r): [string, string] => [r.from, r.to]));
}

/** An address as the website has it: under its sub-path, escaped as a browser sends it. */
const publicPath = (mount: string, route: string) => mount + routeUrl(route);

/** The old address without its trailing slash, which the website also answers at. */
const withoutSlash = (path: string) => path.replace(/\/$/, '');

/**
 * The site's `_redirects`, for the host it names (see the top of this file): null while it keeps no old address.
 * Rules keep the order the old addresses were kept in.
 */
export function generateHostRedirects(state: ProjectState): string | null {
  // A Node.js server reads no host's rules: its old addresses are their pages alone (shared/deploy-target.ts).
  if (runsOnNode(state.site)) return null;
  const pairs = redirectPairs(state);
  if (!pairs.length) return null;
  const mount = siteMount(state.site);
  const netlify = redirectHost(state.site) === 'netlify';
  const lines = pairs.flatMap(([from, to]) => {
    const source = publicPath(mount, from);
    const target = publicPath(mount, to);
    return netlify ? [`${source} ${target} 301!`] : [`${source} ${target} 301`, `${withoutSlash(source)} ${target} 301`];
  });
  const header = [
    '# Old addresses of this website, each sent on to where it is now with a permanent redirect (HTTP 301).',
    `# Written for ${netlify ? 'Netlify' : 'Cloudflare Pages'} by SiteOrigin Builder from siteorigin/site.json.`
  ];
  return [...header, ...lines].join('\n') + '\n';
}

/**
 * The site's `_headers`, which Cloudflare Pages and Netlify read the same way: the built files named by their
 * contents (see the top of this file) cached for a year, under the site's sub-path when it has one. Written whatever
 * the host, as `_redirects` is, so moving the built website to either host keeps it.
 */
export function generateHostHeaders(state: ProjectState): string {
  return [
    '# Files the build names by their contents, which browsers and the host may keep for a year without asking again.',
    '# Written for Cloudflare Pages and Netlify by SiteOrigin Builder.',
    `${siteMount(state.site)}${IMMUTABLE_DIR}*`,
    `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`
  ].join('\n') + '\n';
}

/**
 * Whether a generated file only tunes caching (#1487), so that a file of the author's own at its path takes its place
 * without a word: `_headers`, and a `vercel.json` with no redirect in it. Redirect rules are not given up that way,
 * since an old address would then answer as a page that is there.
 */
export function yieldsToOwnFile(path: string, content: string | Uint8Array): boolean {
  if (path === HOST_HEADERS_FILE) return true;
  if (path !== VERCEL_CONFIG_FILE || typeof content !== 'string') return false;
  try {
    return !Object.hasOwn(JSON.parse(content) as object, 'redirects');
  } catch {
    return false;
  }
}

/**
 * The site's `vercel.json` while its host is Vercel, null otherwise: the caching rule of `_headers` (see
 * generateHostHeaders), and the HTTP 301 rules while the site keeps an old address.
 */
export function generateVercelConfig(state: ProjectState): string | null {
  if (redirectHost(state.site) !== 'vercel' || runsOnNode(state.site)) return null;
  const pairs = redirectPairs(state);
  const mount = siteMount(state.site);
  const headers = [{ source: `${mount}${IMMUTABLE_DIR}(.*)`, headers: [{ key: 'Cache-Control', value: IMMUTABLE_CACHE_CONTROL }] }];
  if (!pairs.length) return JSON.stringify({ headers }, null, '\t') + '\n';
  // Vercel matches the address as given, so each old address has a rule with its trailing slash and one without.
  const redirects = pairs.flatMap(([from, to]) => {
    const source = publicPath(mount, from);
    const destination = publicPath(mount, to);
    return [source, withoutSlash(source)].map((s) => ({ source: s, destination, statusCode: 301 }));
  });
  return JSON.stringify({ headers, redirects }, null, '\t') + '\n';
}
