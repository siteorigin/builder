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
import { emptyReport, htmlToPlain, htmlToRichText, type HtmlImage } from './html';
import { MediaTable } from './media';
import { readContained } from './files';
import { MAX_EXPORT_BYTES, MAX_IMPORT_POSTS, PICTURE_EXTENSIONS, POST_LINK_PREFIX, POSTS_PER_BATCH, type ParsedSource, type SourcePost, type SourceTerm } from './source';
import { reportNotes } from './notes';

/** The calendar day a WordPress date (`2019-03-01 10:00:00`) or an RSS date (`Fri, 01 Mar 2019 10:00:00 +0000`) names. */
/** The longest title, name or label read: the plan shortens what it keeps, and says so. */
const FIELD_CHARS = 1000;
/** The longest old address kept: as long as an entry's own address can be. */
const MAX_OLD_PATH = 1100;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function wordpressDay(...dates: string[]): string | null {
  for (const raw of dates) {
    const d = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(d) && isArticleDate(d.slice(0, 10))) return d.slice(0, 10);
    // The day as the site wrote it, in its own time zone: never moved across midnight by a conversion.
    const rss = /^[A-Z][a-z]{2}, (\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) \d{2}:\d{2}(?::\d{2})? (?:[+-]\d{4}|[A-Z]{1,5})$/.exec(d);
    const month = rss ? MONTHS.indexOf(rss[2]) + 1 : 0;
    if (rss && month && Number.isFinite(Date.parse(d))) {
      const day = `${rss[3]}-${String(month).padStart(2, '0')}-${rss[1].padStart(2, '0')}`;
      if (isArticleDate(day)) return day;
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

/** Every title, quoted, so the author can check each one: (“About us”, “Contact” and 2 untitled). Empty when none have one. */
function namesOf(titles: string[]): string {
  const named = titles.filter(Boolean).map((t) => `“${t}”`);
  if (!named.length) return '';
  const untitled = titles.length - named.length;
  const all = untitled ? [...named, `${untitled} untitled`] : named;
  return ` (${all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0]})`;
}

/** The plural, for counts in the report. */
const KINDS: Record<string, [string, string]> = { page: ['page', 'pages'], nav_menu_item: ['menu item', 'menu items'], revision: ['revision', 'revisions'], wp_block: ['reusable block', 'reusable blocks'] };

/** The export's text: its bytes, read as the import reads a file, are let go of once it is decoded. */
async function exportText(realRoot: string, file: string, label: string): Promise<string> {
  const bytes = await readContained(realRoot, file, MAX_EXPORT_BYTES).catch((e: Error) => {
    throw new Error(`${label} can’t be read: ${e.message}`);
  });
  return bytes.toString('utf8');
}

/**
 * The posts of WordPress export `file`. With `emit`, posts are handed to it in batches as they are read
 * (POSTS_PER_BATCH at a time, in order), and the source returned holds only those read after the last batch.
 */
export async function readWordPress(file: string, pages: RichPages, emit?: (posts: SourcePost[]) => void): Promise<ParsedSource> {
  const root = dirname(file);
  const realRoot = await fs.realpath(root);
  const label = basename(file);
  const text = await exportText(realRoot, file, label);
  let doc: XmlElement;
  try {
    doc = parseXml(text);
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
  /** Each attachment the export lists, by its ID, and the IDs attached to each post, in WordPress's gallery order. */
  const attachments = new Map<string, HtmlImage>();
  const attachedTo = new Map<string, Array<{ id: string; order: number }>>();
  // What is left out, by kind, with each item's title so the author can tell which page it was. Revisions and menu
  // items are counted only: an export can hold thousands, and none is content the author would look for.
  const skipped = new Map<string, string[]>();
  const UNNAMED = new Set(['revision', 'nav_menu_item']);
  const items: XmlElement[] = [];
  for (const item of childElements(channel, 'item')) {
    const type = childText(item, 'wp:post_type').trim();
    if (type === 'attachment') {
      const id = childText(item, 'wp:post_id').trim();
      const altMeta = metaValue(item, '_wp_attachment_image_alt');
      attachments.set(id, { src: childText(item, 'wp:attachment_url').trim(), alt: altMeta ? childText(altMeta, 'wp:meta_value').trim().slice(0, FIELD_CHARS) : '' });
      const parent = childText(item, 'wp:post_parent').trim();
      // A gallery that names no pictures shows the post's attached images, never its documents or sound.
      if (parent && parent !== '0' && isImageAttachment(item)) {
        const list = attachedTo.get(parent) ?? [];
        list.push({ id, order: Number(childText(item, 'wp:menu_order').trim()) || 0 });
        attachedTo.set(parent, list);
      }
    }
    else if (type === 'post') items.push(item);
    else {
      const kind = type || 'other';
      const titles = skipped.get(kind) ?? [];
      titles.push(UNNAMED.has(kind) ? '' : childText(item, 'title').trim());
      skipped.set(kind, titles);
    }
  }

  // WordPress shows a post's attached pictures by menu order, then by ID.
  const attachedIds = new Map([...attachedTo].map(([parent, list]) => [parent, list.sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id)).map((a) => a.id)]));

  // Every post's old addresses first, so a post's text can link to one read after it.
  const byPath = new Map<string, string>();
  const byId = new Map<string, string>();
  const accepted: Array<{ item: XmlElement; key: string; status: { draft: boolean; reason?: string } }> = [];
  const unpublished: string[] = [];
  let over = 0;
  for (const item of items) {
    const status = statusDraft(childText(item, 'wp:status').trim(), childText(item, 'wp:post_password').trim());
    if (!status) {
      unpublished.push(childText(item, 'title').trim());
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

  // From here each post's part of the export is let go of once the post is read: the tree keeps none of them.
  channel.children = [];
  items.length = 0;
  const posts: SourcePost[] = [];
  const add = (post: SourcePost) => {
    posts.push(post);
    if (emit && posts.length >= POSTS_PER_BATCH) emit(posts.splice(0, posts.length));
  };
  while (accepted.length) {
    const { item, key, status } = accepted.shift()!;
    const report = emptyReport();
    let oldSite = 0;
    // A relative address is read from the post's own address, as a browser on the old site read it.
    const ownLink = childText(item, 'link').trim();
    let base = siteOrigin ? `${siteOrigin}/` : 'relative://site/';
    try {
      const own = new URL(ownLink, base);
      if (own.origin === new URL(base).origin) base = own.href;
    } catch {
      // The site's root, then.
    }
    const link = (href: string, newTab: boolean, rel: string[] = []): LinkValue | null => {
      const t = href.trim();
      if (!t || /^(mailto|tel):/i.test(t) || t.startsWith('#')) return linkFromTarget(t, pages, newTab);
      let url: URL;
      try {
        url = new URL(t, base);
      } catch {
        return null;
      }
      const onSite = url.protocol === 'relative:' || (!!siteOrigin && url.origin === siteOrigin);
      // What the post said about another site (a sponsored link) stays with it; a link to this site says nothing.
      if (!onSite) return /^https?:$/.test(url.protocol) ? linkFromTarget(url.href, pages, newTab, rel) : null;
      const tab = newTab ? { newTab: true } : {};
      // A post by its ID when the link names one: never the post at the path it happens to be read from.
      const p = url.searchParams.get('p') ?? url.searchParams.get('page_id');
      const post = p !== null ? byId.get(p) : byPath.get(sitePath(url.pathname).toLowerCase());
      if (post) return { type: 'entry', target: `${POST_LINK_PREFIX}${post}`, ...tab };
      // A page of the project at the same address, its section kept; never for an address with a query (`/?p=88`),
      // which named something other than the page at its path.
      const page = p !== null ? null : linkFromTarget(`${sitePath(url.pathname)}${url.hash}`, pages, newTab);
      if (page) return page;
      // Somewhere else on the old site: kept going there while it is still up.
      if (url.protocol === 'relative:') return null;
      oldSite++;
      return linkFromTarget(url.href, pages, newTab, rel);
    };
    const content = childText(item, 'content:encoded');
    // Classic posts are stored without paragraphs; block-editor posts have them.
    const blocks = content.includes('<!-- wp:');
    // A web address alone on a line of a classic post is one WordPress shows embedded.
    const prose = blocks ? content : content.replace(/^[ \t]*(https?:\/\/[^\s<>"]+)[ \t]*$/gm, (_m, url: string) => (report.embedLinks++, `<p><a href="${url}">${url}</a></p>`));
    let body;
    try {
      const postId = childText(item, 'wp:post_id').trim();
      const gallery = { picture: (id: string) => attachments.get(id) ?? null, attached: (post: string | null) => attachedIds.get(post ?? postId) ?? [] };
      body = htmlToRichText(prose, { image: (img) => media.key(img.src), link, autop: !blocks, shortcodes: true, gallery }, report);
    } catch (e) {
      add(failedPost(item, key, (e as Error).message));
      continue;
    }
    const title = htmlToPlain(childText(item, 'title').slice(0, FIELD_CHARS)) || 'Untitled post';
    const thumb = metaValue(item, '_thumbnail_id');
    const thumbId = thumb ? childText(thumb, 'wp:meta_value').trim() : '';
    const thumbUrl = thumbId ? attachments.get(thumbId)?.src : undefined;
    const login = childText(item, 'dc:creator').trim();
    const date = wordpressDay(childText(item, 'wp:post_date'), childText(item, 'wp:post_date_gmt'), childText(item, 'pubDate'));
    const linkUrl = childText(item, 'link').trim();
    const notes = reportNotes(report);
    if (oldSite) notes.push(`${oldSite === 1 ? 'A link still goes' : `${oldSite} links still go`} to the old site.`);
    if (thumbId && !thumbUrl) notes.push('Its featured picture was left out: the export does not include it. Export All content to bring pictures’ details along.');
    let oldPath: string | undefined;
    try {
      const url = new URL(linkUrl, siteOrigin ? `${siteOrigin}/` : undefined);
      // An address longer than a site's addresses can be is no old address to keep (and never worth reading whole).
      if (!url.search && (!siteOrigin || url.origin === siteOrigin) && url.pathname.length <= MAX_OLD_PATH) oldPath = sitePath(url.pathname);
    } catch {
      oldPath = undefined;
    }
    add({
      key,
      from: title,
      title,
      slug: decodeSlug(childText(item, 'wp:post_name').trim().slice(0, 400)),
      date,
      draft: status.draft || !date,
      ...(status.reason ? { draftReason: status.reason } : !date && !status.draft ? { draftReason: 'it has no publication date' } : {}),
      ...(login ? { author: (authors.get(login) || login).slice(0, FIELD_CHARS) } : {}),
      ...(() => {
        const excerpt = htmlToPlain(childText(item, 'excerpt:encoded').slice(0, 200 * FIELD_CHARS));
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
  for (const [type, titles] of skipped) {
    const [one, many] = KINDS[type] ?? ['other item', 'other items'];
    const n = titles.length;
    out.push(`${n} ${n === 1 ? one : many}${namesOf(titles)}: only posts are imported.`);
  }
  if (unpublished.length) out.push(`${unpublished.length} ${unpublished.length === 1 ? 'post' : 'posts'}${namesOf(unpublished)} in the trash or never started.`);
  if (over) out.push(`${over} more ${over === 1 ? 'post' : 'posts'}: an import brings at most ${MAX_IMPORT_POSTS}.`);
  return { kind: 'wordpress', label, root, realRoot, ...(siteOrigin ? { site: siteOrigin } : {}), posts, media: media.items, skipped: out };
}

/** An attachment WordPress counts as an image: by its type when the export says, else by its file's extension. */
function isImageAttachment(item: XmlElement): boolean {
  const mime = childText(item, 'wp:post_mime_type').trim().toLowerCase();
  if (mime) return mime.startsWith('image/');
  const ext = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(childText(item, 'wp:attachment_url').trim())?.[1].toLowerCase();
  return !ext || [...PICTURE_EXTENSIONS, 'svg', 'bmp', 'tif', 'tiff', 'heic', 'ico'].includes(ext);
}

/** A post whose text could not be read: imported with its details and no text, the reason in its notes. */
function failedPost(item: XmlElement, key: string, why: string): SourcePost {
  const title = htmlToPlain(childText(item, 'title').slice(0, FIELD_CHARS)) || 'Untitled post';
  return { key, from: title, title, slug: decodeSlug(childText(item, 'wp:post_name').trim().slice(0, 400)), date: null, draft: true, draftReason: 'its text could not be read', categories: [], tags: [], body: [], notes: [`Its text could not be read: ${why}`] };
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
    const label = htmlToPlain(textOf(c).slice(0, FIELD_CHARS));
    const slug = decodeSlug(c.attrs.nicename ?? '');
    if (!label || (domain === 'category' && slug === 'uncategorized')) continue;
    if (!out.some((t) => t.label.toLowerCase() === label.toLowerCase())) out.push({ label, ...(slug ? { slug } : {}) });
  }
  return out;
}
