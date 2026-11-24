/**
 * A WordPress export (Tools → Export, a WXR .xml file) read into posts. Only posts are imported: pages, menu items,
 * revisions and other kinds are counted and named in the report. Pictures are looked for in a copy of the site's
 * uploads folder beside the export (`uploads/` or `wp-content/uploads/`), never fetched from the old site.
 */
import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { LinkValue } from '@shared/types';
import { isArticleDate } from '@shared/articles';
import { linkFromTarget, type RichPages } from '@shared/richtext';
import { XmlError, childElement, childElements, childText, parseXml, textOf, type XmlElement } from './xml';
import { emptyReport, htmlToPlain, htmlToRichText } from './html';
import { MediaTable } from './media';
import { readContained } from './files';
import { MAX_EXPORT_BYTES, MAX_IMPORT_POSTS, POST_LINK_PREFIX, type ParsedSource, type SourcePost, type SourceTerm } from './source';
import { reportNotes } from './notes';

/** The calendar day a WordPress date (`2019-03-01 10:00:00`) or an RSS date (`Fri, 01 Mar 2019 10:00:00 +0000`) names. */
export function wordpressDay(...dates: string[]): string | null {
  for (const raw of dates) {
    const d = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(d) && isArticleDate(d.slice(0, 10))) return d.slice(0, 10);
    if (/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4}/.test(d)) {
      const t = Date.parse(d);
      if (Number.isFinite(t)) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (isArticleDate(day)) return day;
      }
    }
  }
  return null;
}

/** Why a WordPress status keeps a post a draft, or null for a published post. Undefined: the item is not imported. */
function statusDraft(status: string, password: string): { draft: boolean; reason?: string } | undefined {
  if (status === 'trash' || status === 'auto-draft' || status === 'inherit') return undefined;
  if (password) return { draft: true, reason: 'it was password-protected' };
  if (status === 'publish') return { draft: false };
  if (status === 'draft') return { draft: true };
  if (status === 'future') return { draft: true, reason: 'it was scheduled, not yet published' };
  if (status === 'pending') return { draft: true, reason: 'it was waiting for review' };
  if (status === 'private') return { draft: true, reason: 'it was private' };
  return { draft: true, reason: `its status (${status.slice(0, 20) || 'none'}) is not one the import knows` };
}

const metaValue = (item: XmlElement, key: string) => childElements(item, 'wp:postmeta').find((m) => childText(m, 'wp:meta_key') === key);

/** A path as a static site writes its addresses: decoded, with a slash at each end. */
function sitePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Kept as written.
  }
  if (!p.startsWith('/')) p = `/${p}`;
  return p.endsWith('/') ? p : `${p}/`;
}

/** The plural, for counts in the report. */
const KINDS: Record<string, [string, string]> = { page: ['page', 'pages'], nav_menu_item: ['menu item', 'menu items'], revision: ['revision', 'revisions'], wp_block: ['reusable block', 'reusable blocks'] };

export async function readWordPress(file: string, pages: RichPages): Promise<ParsedSource> {
  const root = dirname(file);
  const realRoot = await fs.realpath(root);
  const label = basename(file);
  const bytes = await readContained(realRoot, file, MAX_EXPORT_BYTES).catch((e: Error) => {
    throw new Error(`${label} can’t be read: ${e.message}`);
  });
  let doc: XmlElement;
  try {
    doc = parseXml(bytes.toString('utf8'));
  } catch (e) {
    throw new Error(`${label} is not a WordPress export that can be read: ${e instanceof XmlError ? e.message : 'it is damaged.'}`);
  }
  const channel = doc.name === 'rss' ? childElement(doc, 'channel') : undefined;
  if (!channel || !childText(channel, 'wp:wxr_version').trim()) throw new Error(`${label} is not a WordPress export. In WordPress, choose Tools → Export, then All content or Posts.`);

  const base = (childText(channel, 'wp:base_blog_url') || childText(channel, 'link')).trim();
  let siteOrigin: string | undefined;
  try {
    siteOrigin = base ? new URL(base).origin : undefined;
  } catch {
    siteOrigin = undefined;
  }
  const media = new MediaTable(root, realRoot, siteOrigin);
  const authors = new Map(childElements(channel, 'wp:author').map((a) => [childText(a, 'wp:author_login').trim(), childText(a, 'wp:author_display_name').trim()]));
  const attachments = new Map<string, string>();
  const skipped = new Map<string, number>();
  const items: XmlElement[] = [];
  for (const item of childElements(channel, 'item')) {
    const type = childText(item, 'wp:post_type').trim();
    if (type === 'attachment') attachments.set(childText(item, 'wp:post_id').trim(), childText(item, 'wp:attachment_url').trim());
    else if (type === 'post') items.push(item);
    else skipped.set(type || 'other', (skipped.get(type || 'other') ?? 0) + 1);
  }

  // Every post's old addresses first, so a post's text can link to one read after it.
  const byPath = new Map<string, string>();
  const byId = new Map<string, string>();
  const accepted: Array<{ item: XmlElement; key: string; status: { draft: boolean; reason?: string } }> = [];
  let unpublished = 0;
  let over = 0;
  for (const item of items) {
    const status = statusDraft(childText(item, 'wp:status').trim(), childText(item, 'wp:post_password').trim());
    if (!status) {
      unpublished++;
      continue;
    }
    if (accepted.length >= MAX_IMPORT_POSTS) {
      over++;
      continue;
    }
    const id = childText(item, 'wp:post_id').trim();
    const key = `wp:${id || accepted.length + 1}`;
    if (accepted.some((a) => a.key === key)) continue;
    accepted.push({ item, key, status });
    if (id) byId.set(id, key);
    const link = childText(item, 'link').trim();
    try {
      const url = new URL(link, siteOrigin ? `${siteOrigin}/` : undefined);
      if (!url.search) byPath.set(sitePath(url.pathname).toLowerCase(), key);
    } catch {
      // No address to link by.
    }
  }

  const posts: SourcePost[] = [];
  for (const { item, key, status } of accepted) {
    const report = emptyReport();
    let oldSite = 0;
    const link = (href: string, newTab: boolean): LinkValue | null => {
      const t = href.trim();
      if (!t || /^(mailto|tel):/i.test(t) || t.startsWith('#')) return linkFromTarget(t, pages, newTab);
      let url: URL;
      try {
        url = new URL(t, siteOrigin ? `${siteOrigin}/` : 'relative://site/');
      } catch {
        return null;
      }
      const onSite = url.protocol === 'relative:' || (!!siteOrigin && url.origin === siteOrigin);
      if (!onSite) return /^https?:$/.test(url.protocol) ? linkFromTarget(url.href, pages, newTab) : null;
      const tab = newTab ? { newTab: true } : {};
      const p = url.searchParams.get('p');
      const post = (p && byId.get(p)) || byPath.get(sitePath(url.pathname).toLowerCase());
      if (post) return { type: 'entry', target: `${POST_LINK_PREFIX}${post}`, ...tab };
      const page = linkFromTarget(sitePath(url.pathname), pages, newTab);
      if (page) return page;
      // Somewhere else on the old site: kept going there while it is still up.
      if (url.protocol === 'relative:') return null;
      oldSite++;
      return linkFromTarget(url.href, pages, newTab);
    };
    const content = childText(item, 'content:encoded');
    // Classic posts are stored without paragraphs; block-editor posts have them.
    const blocks = content.includes('<!-- wp:');
    // A web address alone on a line of a classic post is one WordPress shows embedded.
    const prose = blocks ? content : content.replace(/^[ \t]*(https?:\/\/[^\s<>"]+)[ \t]*$/gm, (_m, url: string) => (report.embedLinks++, `<p><a href="${url}">${url}</a></p>`));
    let body;
    try {
      body = htmlToRichText(prose, { image: (img) => media.key(img.src), link, autop: !blocks, shortcodes: true }, report);
    } catch (e) {
      posts.push(failedPost(item, key, (e as Error).message));
      continue;
    }
    const title = htmlToPlain(childText(item, 'title')) || 'Untitled post';
    const thumb = metaValue(item, '_thumbnail_id');
    const thumbUrl = thumb ? attachments.get(childText(thumb, 'wp:meta_value').trim()) : undefined;
    const login = childText(item, 'dc:creator').trim();
    const date = wordpressDay(childText(item, 'wp:post_date'), childText(item, 'wp:post_date_gmt'), childText(item, 'pubDate'));
    const linkUrl = childText(item, 'link').trim();
    const notes = reportNotes(report);
    if (oldSite) notes.push(`${oldSite === 1 ? 'A link still goes' : `${oldSite} links still go`} to the old site.`);
    let oldPath: string | undefined;
    try {
      const url = new URL(linkUrl, siteOrigin ? `${siteOrigin}/` : undefined);
      if (!url.search && (!siteOrigin || url.origin === siteOrigin)) oldPath = sitePath(url.pathname);
    } catch {
      oldPath = undefined;
    }
    posts.push({
      key,
      from: title,
      title,
      slug: decodeSlug(childText(item, 'wp:post_name').trim()),
      date,
      draft: status.draft || !date,
      ...(status.reason ? { draftReason: status.reason } : !date && !status.draft ? { draftReason: 'it has no publication date' } : {}),
      ...(login ? { author: authors.get(login) || login } : {}),
      ...(() => {
        const excerpt = htmlToPlain(childText(item, 'excerpt:encoded'));
        return excerpt ? { excerpt } : {};
      })(),
      categories: terms(item, 'category'),
      tags: terms(item, 'post_tag'),
      body,
      ...(thumbUrl ? { featured: media.key(thumbUrl) } : {}),
      ...(oldPath ? { oldPath } : {}),
      notes
    });
  }
  await media.resolve();

  const out: string[] = [];
  for (const [type, n] of skipped) {
    const [one, many] = KINDS[type] ?? ['other item', 'other items'];
    out.push(`${n} ${n === 1 ? one : many}: only posts are imported.`);
  }
  if (unpublished) out.push(`${unpublished} ${unpublished === 1 ? 'post' : 'posts'} in the trash or never started.`);
  if (over) out.push(`${over} more ${over === 1 ? 'post' : 'posts'}: an import brings at most ${MAX_IMPORT_POSTS}.`);
  return { kind: 'wordpress', label, root, ...(siteOrigin ? { site: siteOrigin } : {}), posts, media: media.items, skipped: out };
}

/** A post whose text could not be read: imported with its details and no text, the reason in its notes. */
function failedPost(item: XmlElement, key: string, why: string): SourcePost {
  const title = htmlToPlain(childText(item, 'title')) || 'Untitled post';
  return { key, from: title, title, slug: decodeSlug(childText(item, 'wp:post_name').trim()), date: null, draft: true, draftReason: 'its text could not be read', categories: [], tags: [], body: [], notes: [`Its text could not be read: ${why}`] };
}

function decodeSlug(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The post's categories or tags: their names, and the IDs WordPress gave them. WordPress's own "Uncategorized" is left out. */
function terms(item: XmlElement, domain: string): SourceTerm[] {
  const out: SourceTerm[] = [];
  for (const c of childElements(item, 'category')) {
    if (c.attrs.domain !== domain) continue;
    const label = htmlToPlain(textOf(c));
    const slug = decodeSlug(c.attrs.nicename ?? '');
    if (!label || (domain === 'category' && slug === 'uncategorized')) continue;
    if (!out.some((t) => t.label.toLowerCase() === label.toLowerCase())) out.push({ label: label.slice(0, 80), ...(slug ? { slug } : {}) });
  }
  return out;
}
