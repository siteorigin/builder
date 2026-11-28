/**
 * Which search the website's Site search runs: its own index, written with the site (generator/search.ts), or a
 * SearchSocket service the author hosts elsewhere (https://github.com/gregpriday/searchsocket), which indexes the built
 * website and answers searches semantically. The site only ever asks the service's public search address: whatever
 * keys the service needs stay with the service, never in the website.
 *
 * Stored on the site as `search` while it says anything; absent, the site searches its own index.
 */
import type { SiteDoc, SiteSearchSettings } from './types';

/** The search services Site search can use, with what Site settings calls them. */
export const SEARCH_PROVIDERS = [
  ['builtin', 'This site’s own index'],
  ['searchsocket', 'SearchSocket']
] as const;

export type SearchProvider = (typeof SEARCH_PROVIDERS)[number][0];

/** The most characters a search address and a section scope keep. */
export const SEARCH_ENDPOINT_MAX = 400;
export const SEARCH_PATH_PREFIX_MAX = 200;

/** The site's search settings as stored, or none. A hand-edited value that is not an object is none. */
const stored = (site: SiteDoc): SiteSearchSettings => (site.search && typeof site.search === 'object' && !Array.isArray(site.search) ? site.search : {});

/** Which search the site runs. Anything but SearchSocket is the site's own index. */
export function searchProvider(site: SiteDoc): SearchProvider {
  return stored(site).provider === 'searchsocket' ? 'searchsocket' : 'builtin';
}

/** What the website asks SearchSocket with, read as Site settings shows it. */
export interface SearchSocketSettings {
  /** The service's search address, or null while none that works is set. */
  endpoint: string | null;
  /** The part of the site results come from ("/docs/"), or "" for all of it. */
  pathPrefix: string;
  /** Whether a result opens its page scrolled to the passage found. On unless switched off. */
  scrollToText: boolean;
}

/** The SearchSocket settings, whether or not the site uses SearchSocket now. */
export function searchSocketSettings(site: SiteDoc): SearchSocketSettings {
  const s = stored(site);
  const endpoint = typeof s.endpoint === 'string' ? checkSearchEndpoint(s.endpoint) : null;
  const prefix = typeof s.pathPrefix === 'string' ? checkSearchPathPrefix(s.pathPrefix) : null;
  return { endpoint: endpoint?.ok && endpoint.value ? endpoint.value : null, pathPrefix: prefix?.ok ? prefix.value : '', scrollToText: s.scrollToText !== false };
}

/** The SearchSocket service the website asks, or null while it searches its own index. */
export function searchService(site: SiteDoc): SearchSocketSettings | null {
  return searchProvider(site) === 'searchsocket' ? searchSocketSettings(site) : null;
}

/** A setting as checked: the value to store ("" when none is set), or why it can't be used. */
export type SearchSettingCheck = { ok: true; value: string } | { ok: false; message: string };

/**
 * Check a SearchSocket search address: a full HTTPS address with no user name or password, as visitors' browsers
 * will ask it from the published site. Given back as the browser reads it ("https://Search.example.com/api" ->
 * "https://search.example.com/api"), so what is stored is the very address the website asks.
 */
export function checkSearchEndpoint(input: string): SearchSettingCheck {
  const text = input.trim();
  if (!text) return { ok: true, value: '' };
  if (text.length > SEARCH_ENDPOINT_MAX) return { ok: false, message: `The search address can be at most ${SEARCH_ENDPOINT_MAX} characters.` };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, message: 'The search address can’t contain spaces or control characters.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'Type the full search address, such as https://search.example.com/api/search.' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'The search address must start with https://, as browsers ask it from a published site.' };
  // "https:search.example.com" is repaired by the parser here, but read as a path on the site by a page that asks it.
  if (!/^https:\/\/[^/?#\\]/i.test(text) || !url.hostname) return { ok: false, message: 'Write the search address with https:// and a host name, such as https://search.example.com/api/search.' };
  if (url.username || url.password) return { ok: false, message: 'Leave the user name and password out of the search address.' };
  if (url.href.length > SEARCH_ENDPOINT_MAX) return { ok: false, message: `The search address can be at most ${SEARCH_ENDPOINT_MAX} characters.` };
  return { ok: true, value: url.href };
}

/**
 * Check a section scope: an address on the site, from its root ("/docs/"), that results must start with. Given back
 * with its leading slash; "" or "/" is the whole site.
 */
export function checkSearchPathPrefix(input: string): SearchSettingCheck {
  const text = input.trim();
  if (!text || text === '/') return { ok: true, value: '' };
  // Counted as stored, with its leading slash.
  if ((text.startsWith('/') ? text : `/${text}`).length > SEARCH_PATH_PREFIX_MAX) return { ok: false, message: `The section can be at most ${SEARCH_PATH_PREFIX_MAX} characters.` };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, message: 'The section can’t contain spaces or control characters.' };
  if (/[?#\\]/.test(text) || text.includes('://') || text.startsWith('//')) return { ok: false, message: 'Type an address on this site, from its root, such as /docs/.' };
  return { ok: true, value: text.startsWith('/') ? text : `/${text}` };
}
