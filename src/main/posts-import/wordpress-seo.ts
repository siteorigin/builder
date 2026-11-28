/**
 * A WordPress post's search settings as its SEO plugin kept them in the post's meta (#1514): Yoast SEO's first, then
 * Rank Math's, then SEOPress's, field by field. A value written with the plugin's placeholders (`%%title%% %%sep%%
 * %%sitename%%`) is filled in as the plugin filled it; the plugin's stock title is left out, since the post's page
 * shows its title and the site's name without one.
 */
import { checkCanonicalUrl } from '@shared/seo';
import { childElements, childText, type XmlElement } from './xml';
import { decodeEntities } from './html';
import type { SourceSeo } from './source';

/** The most characters of a search title or description read: the plan shortens what it keeps to the project's limits, and says so. */
const META_CHARS = 4000;

/**
 * Each plugin's meta keys, in the order they are read, and how it writes a placeholder: `%%title%%` (Yoast, SEOPress),
 * or `%title%` and `%date(F j, Y)%` (Rank Math, whose names are lowercase), so other text with percent signs stays text.
 */
const PLUGINS = [
  { title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc', canonical: '_yoast_wpseo_canonical', token: /%%([a-z0-9_]+)%%/gi },
  { title: 'rank_math_title', description: 'rank_math_description', canonical: 'rank_math_canonical_url', token: /%([a-z_]+)(?:\([^()%]*\))?%/g },
  { title: '_seopress_titles_title', description: '_seopress_titles_desc', canonical: '_seopress_robots_canonical', token: /%%([a-z0-9_]+)%%/gi }
] as const;

/** Placeholders the plugins write, by name: a post's title, the site's name, the separator, and the page number (none on a post's own page). */
const TITLE_TOKENS = new Set(['title', 'post_title']);
const SITE_TOKENS = new Set(['sitename', 'sitetitle', 'site_title']);

/** The separator a plugin puts between a post's title and the site's name unless its settings choose another. */
const SEPARATOR = '-';

/** A meta value as the plugin saved it, trimmed. */
function metaText(item: XmlElement, key: string): string {
  const m = childElements(item, 'wp:postmeta').find((p) => childText(p, 'wp:meta_key') === key);
  return m ? childText(m, 'wp:meta_value').trim() : '';
}

type Filled = { text: string } | { stock: true } | { unknown: string };

/**
 * `raw`, plain text as the plugins save it (its character references read, never parsed as HTML), with its
 * placeholders filled in; or the placeholder that can't be; or, for a title, `stock` when it is only the post's title
 * and the site's name, as every page here is titled without one of its own.
 */
function fill(raw: string, token: RegExp, title: string, site: string, isTitle: boolean): Filled {
  const text = decodeEntities(raw.slice(0, META_CHARS), true);
  const names = [...text.matchAll(token)].map((m) => m[1].toLowerCase());
  const unknown = names.find((n) => !TITLE_TOKENS.has(n) && !(SITE_TOKENS.has(n) && site) && n !== 'sep' && n !== 'page');
  if (unknown) return { unknown };
  const words = text.replace(token, '').replace(/[\s\-–—|·•:]+/g, '');
  if (isTitle && !words && names.some((n) => TITLE_TOKENS.has(n)) && names.some((n) => SITE_TOKENS.has(n))) return { stock: true };
  const filled = text.replace(token, (_m, name: string) => {
    const n = name.toLowerCase();
    return TITLE_TOKENS.has(n) ? title : SITE_TOKENS.has(n) ? site : n === 'sep' ? SEPARATOR : '';
  });
  // A placeholder used many times never makes more text than a value read.
  return { text: filled.replace(/\s+/g, ' ').trim().slice(0, META_CHARS) };
}

/** A URL part with its percent escapes in capitals, so `%C3%A9` and `%c3%a9` are one letter; `%26` stays apart from `&`. */
const escapes = (s: string) => s.replace(/%[0-9a-f]{2}/gi, (e) => e.toUpperCase());

/** Whether `a` and `b` are one address, whatever slash ends its path and however its letters are escaped. */
function sameAddress(a: URL, b: URL): boolean {
  const path = (u: URL) => escapes(u.pathname.replace(/\/+$/, ''));
  return a.origin === b.origin && path(a) === path(b) && escapes(a.search) === escapes(b.search);
}

/** What the post's robots settings say: `true` asks search engines not to list it, `false` to list it, undefined leaves it to the site. */
function robots(item: XmlElement): { noindex?: boolean; conflict?: true } {
  const said: boolean[] = [];
  const yoast = metaText(item, '_yoast_wpseo_meta-robots-noindex');
  if (yoast === '1') said.push(true);
  else if (yoast === '2') said.push(false);
  // Rank Math keeps its directives as a PHP-serialized list of words: `a:1:{i:0;s:7:"noindex";}`.
  const rank = [...metaText(item, 'rank_math_robots').slice(0, META_CHARS).matchAll(/s:\d+:"([^"]*)"/g)].map((m) => m[1].toLowerCase());
  if (rank.includes('noindex')) said.push(true);
  else if (rank.includes('index')) said.push(false);
  if (metaText(item, '_seopress_robots_index').toLowerCase() === 'yes') said.push(true);
  if (!said.length) return {};
  // Two plugins that disagree (one the site has left behind): the site's own setting, never a guess.
  if (said.some((s) => s !== said[0])) return { conflict: true };
  return { noindex: said[0] };
}

/**
 * The search settings `item`'s SEO plugin gave it, and notes on what was left out. `title` is the post's own, `site`
 * the site's name, and `ownLink` the post's address on the old site, which a canonical address naming it leaves to
 * the new site (each page tells search engines its own).
 */
export function wordpressSeo(item: XmlElement, title: string, site: string, ownLink: string, siteOrigin: string | undefined): { seo?: SourceSeo; notes: string[] } {
  const seo: SourceSeo = {};
  const notes: string[] = [];
  for (const field of ['title', 'description'] as const) {
    const what = field === 'title' ? 'search title' : 'search description';
    let refused: string | undefined;
    for (const plugin of PLUGINS) {
      const raw = metaText(item, plugin[field]);
      if (!raw) continue;
      const f = fill(raw, plugin.token, title, site, field === 'title');
      if ('stock' in f) break;
      if ('unknown' in f) {
        refused ??= `Its ${what} was left out: it uses the SEO plugin’s “${f.unknown}” placeholder, which the import can’t fill in.`;
        continue;
      }
      if (f.text) {
        seo[field] = f.text;
        refused = undefined;
        break;
      }
    }
    if (refused) notes.push(refused);
  }
  let own: URL | undefined;
  try {
    own = ownLink ? new URL(ownLink, siteOrigin ? `${siteOrigin}/` : undefined) : undefined;
  } catch {
    own = undefined;
  }
  let canonicalRefused: string | undefined;
  for (const plugin of PLUGINS) {
    const raw = metaText(item, plugin.canonical);
    if (!raw) continue;
    const check = checkCanonicalUrl(raw);
    if (!check.ok || !check.url) {
      canonicalRefused ??= `Its canonical address (${raw.slice(0, 200)}) was left out: ${check.ok ? 'it is empty' : check.message.charAt(0).toLowerCase() + check.message.slice(1).replace(/\.$/, '')}.`;
      continue;
    }
    canonicalRefused = undefined;
    const url = new URL(check.url);
    // Its own old address: the new page tells search engines its new one.
    if (own && sameAddress(url, own)) break;
    seo.canonical = check.url;
    if (siteOrigin && url.origin === siteOrigin) notes.push(`Its canonical address (${check.url}) is on the old site: change it in Search & sharing if the new site replaces that address.`);
    break;
  }
  if (canonicalRefused) notes.push(canonicalRefused);
  const r = robots(item);
  if (r.noindex) seo.noindex = true;
  if (r.conflict) notes.push('Its SEO plugins disagree on whether search engines may list it, so it is listed as the site’s other posts are: check Search & sharing.');
  return { ...(Object.keys(seo).length ? { seo } : {}), notes };
}
