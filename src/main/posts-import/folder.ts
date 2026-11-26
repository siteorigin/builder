/**
 * A folder of Markdown posts, as Jekyll, Hugo, Eleventy or Astro keep them: each `*.md` file in the folder is a post,
 * and so is each subfolder's `index.md` (a post kept with its pictures). Files named with a leading `_` or `.`, and
 * a README, are not posts. Frontmatter gives the title, date, draft state, author, excerpt, categories, tags and
 * featured picture; a file without them is still a post, titled from its first heading or its name.
 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { LinkValue, RichText } from '@shared/types';
import { isArticleDate } from '@shared/articles';
import { linkFromTarget, type RichPages } from '@shared/richtext';
import { emptyReport, htmlToPlain, htmlToRichText } from './html';
import { markdownToHtml, readFrontmatter, type FrontValue } from './markdown';
import { MediaTable, segmentsWithin } from './media';
import { readContained } from './files';
import { MAX_EXPORT_BYTES, MAX_IMPORT_POSTS, MAX_MARKDOWN_FILE_BYTES, POST_LINK_PREFIX, type ParsedSource, type SourcePost, type SourceTerm } from './source';
import { reportNotes } from './notes';

const MARKDOWN = /\.(md|markdown)$/i;
/** Jekyll names a post's file after its date: `2019-03-01-winter-workshop.md`. */
const DATED_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

interface Found {
  /** From the chosen folder: `winter.md` or `winter/index.md`. */
  rel: string;
  /** The segments of the folder it is in, from the chosen folder. */
  dir: string[];
  /** The name its slug and title fall back to. */
  stem: string;
}

async function findPosts(root: string): Promise<{ found: Found[]; over: number }> {
  const found: Found[] = [];
  let over = 0;
  const add = (f: Found) => (found.length < MAX_IMPORT_POSTS ? found.push(f) : over++);
  const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries.slice(0, 20_000)) {
    if (/^[._]/.test(e.name)) continue;
    if (e.isFile() && MARKDOWN.test(e.name) && !/^readme\./i.test(e.name)) add({ rel: e.name, dir: [], stem: e.name.replace(MARKDOWN, '') });
    else if (e.isDirectory() && e.name !== 'node_modules') {
      for (const index of ['index.md', 'index.markdown']) {
        const st = await fs.lstat(join(root, e.name, index)).catch(() => null);
        if (st?.isFile()) {
          add({ rel: `${e.name}/${index}`, dir: [e.name], stem: e.name });
          break;
        }
      }
    }
  }
  return { found, over };
}

/** The longest title, name or label read: the plan shortens what it keeps, and says so. */
const FIELD_CHARS = 1000;
const text = (v: FrontValue | undefined): string | undefined => {
  const t = typeof v === 'string' ? v.trim() : Array.isArray(v) ? v[0]?.trim() : undefined;
  return t ? t.slice(0, FIELD_CHARS) : undefined;
};

/** A date as frontmatter writes one (`2019-03-01`, `2019-03-01T10:00:00Z`, `2019-03-01 10:00`), as a calendar day. */
function day(v: FrontValue | undefined): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(t) && isArticleDate(t.slice(0, 10)) ? t.slice(0, 10) : null;
}

/** The settings a post's date is read from, first to last. */
const DATE_KEYS = ['date', 'pubdate', 'publishdate', 'published_at', 'published'] as const;

/**
 * Why a post whose settings give a date has none: the first date setting that is not a day of the calendar, quoted, or
 * one that could not be read. `published: true` (Jekyll) is a draft setting, not a date.
 */
function unreadDate(data: Record<string, FrontValue>, unreadable: string[]): string | undefined {
  for (const k of DATE_KEYS) {
    if (unreadable.includes(k)) return `its ${k} setting could not be read`;
    const v = data[k];
    if (v === undefined || (k === 'published' && typeof v === 'boolean')) continue;
    const shown = (Array.isArray(v) ? v.join(', ') : String(v)).trim();
    if (!shown) continue;
    return `its ${k} “${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}” is not a date, such as 2024-03-01`;
  }
  return undefined;
}

/** A file's text, and whether it was not UTF-8: its bytes that are not are read as replacement characters. */
function decodeText(bytes: Uint8Array): { text: string; notUtf8: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), notUtf8: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), notUtf8: true };
  }
}

/** Categories or tags: a list, or words in one value (separated by commas, or for Jekyll's categories by spaces). */
function termList(v: FrontValue | undefined, spaces: boolean): SourceTerm[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? (v.includes(',') ? v.split(',') : spaces ? v.split(/\s+/) : [v]) : [];
  const out: SourceTerm[] = [];
  for (const r of raw) {
    const label = r.trim().slice(0, FIELD_CHARS);
    if (label && !out.some((t) => t.label.toLowerCase() === label.toLowerCase())) out.push({ label });
  }
  return out;
}

export async function readMarkdownFolder(root: string, pages: RichPages): Promise<ParsedSource> {
  const realRoot = await fs.realpath(root);
  const label = basename(root);
  const { found, over } = await findPosts(root);
  if (!found.length) throw new Error(`${label} has no Markdown posts (.md files) in it. Choose the folder that holds them, such as _posts or content/posts.`);
  const media = new MediaTable(root, realRoot);
  const skipped: string[] = [];
  let total = 0;
  const read: Array<{ f: Found; key: string; text: string; notUtf8: boolean }> = [];
  for (const [n, f] of found.entries()) {
    try {
      const bytes = await readContained(realRoot, join(root, f.rel), MAX_MARKDOWN_FILE_BYTES);
      total += bytes.length;
      if (total > MAX_EXPORT_BYTES) {
        const rest = found.length - n;
        skipped.push(`${rest} ${rest === 1 ? 'post' : 'posts'} from ${f.rel} on: the folder’s posts are larger than an import reads at once.`);
        break;
      }
      const { text, notUtf8 } = decodeText(bytes);
      read.push({ f, key: `md:${f.rel}`, text, notUtf8 });
    } catch (e) {
      skipped.push(`${f.rel}: ${(e as Error).message}`);
    }
  }
  // Every post's file and slug first, so a post can link to one read after it.
  const byFile = new Map(read.map((r) => [r.f.rel.toLowerCase(), r.key]));
  const slugs = new Map<string, string | null>();
  const fronts = read.map((r) => {
    const fm = readFrontmatter(r.text);
    const named = DATED_NAME.exec(r.f.stem);
    // A day the calendar has, or none: `2023-02-30-notes.md` is named, not dated.
    const dated = named && isArticleDate(named[1]) ? named : null;
    const slug = text(fm.data.slug) ?? (named ? named[2] : r.f.stem);
    const s = slug.toLowerCase();
    slugs.set(s, slugs.has(s) ? null : r.key);
    return { ...r, fm, slug, dated: dated?.[1] ?? null };
  });

  const posts: SourcePost[] = [];
  for (const { f, key, fm, slug, dated, notUtf8 } of fronts) {
    const report = emptyReport();
    const notes: string[] = notUtf8 ? ['It is not saved as UTF-8 text, so some of its letters may have come out wrong. Check its text, or save the file as UTF-8 and import it again.'] : [];
    if (fm.problems.length) notes.push(`Some of its settings could not be read (${fm.problems.slice(0, 3).join('; ')}).`);
    const link = (href: string, newTab: boolean, rel: string[] = []): LinkValue | null => {
      const t = href.trim();
      const tab = newTab ? { newTab: true } : {};
      if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('//')) return linkFromTarget(t.startsWith('//') ? `https:${t}` : t, pages, newTab, rel);
      const path = t.split(/[?#]/)[0];
      // Another post of the folder, by its file.
      if (MARKDOWN.test(path)) {
        const segs = segmentsWithin(f.dir, path);
        const post = segs && byFile.get(segs.join('/').toLowerCase());
        return post ? { type: 'entry', target: `${POST_LINK_PREFIX}${post}`, ...tab } : null;
      }
      const page = path.startsWith('/') ? linkFromTarget(t, pages, newTab) : null;
      if (page) return page;
      // An address ending in another post's slug (`/blog/winter-workshop/`, `../winter-workshop/`).
      const last = path.split('/').filter(Boolean).pop()?.toLowerCase();
      const post = last ? slugs.get(last) : undefined;
      return post ? { type: 'entry', target: `${POST_LINK_PREFIX}${post}`, ...tab } : null;
    };
    let body = fm.body;
    let title = text(fm.data.title);
    if (!title) {
      // A file without a title in its settings is titled by its first heading, which then leaves the text.
      const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
      if (h1 && !body.slice(0, h1.index).trim()) {
        try {
          title = htmlToPlain(markdownToHtml(h1[1])).slice(0, FIELD_CHARS);
          body = body.slice(h1.index + h1[0].length);
        } catch {
          // Titled by its name instead, the heading left in its text.
        }
      }
    }
    title ||= f.stem.replace(DATED_NAME, '$2').replace(/[-_]+/g, ' ').trim() || 'Untitled post';
    let blocks: RichText;
    let unread = false;
    try {
      blocks = htmlToRichText(markdownToHtml(body), { image: (img) => media.key(img.src, f.dir), link }, report);
    } catch (e) {
      blocks = [];
      unread = true;
      notes.push(`Its text could not be read: ${(e as Error).message}`);
    }
    notes.push(...reportNotes(report));
    const date = DATE_KEYS.map((k) => day(fm.data[k])).find((d) => d !== null) ?? dated;
    const badDate = date ? undefined : unreadDate(fm.data, fm.unreadable);
    const { draft, reason } = unread ? { draft: true, reason: 'its text could not be read' } : draftOf(fm.data, fm.unreadable);
    const full = (v: FrontValue | undefined) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 20 * FIELD_CHARS) : undefined);
    const summary = full(fm.data.description) ?? full(fm.data.excerpt) ?? full(fm.data.summary);
    let excerpt: string | undefined;
    try {
      excerpt = summary ? htmlToPlain(markdownToHtml(summary)) : undefined;
    } catch {
      notes.push('Its excerpt could not be read, so it was left out.');
    }
    const picture = text(fm.data.image) ?? text(fm.data.featured_image) ?? text(fm.data.featuredimage) ?? text(fm.data.cover) ?? text(fm.data.thumbnail) ?? text(fm.data.hero) ?? text(fm.data.banner);
    const author = text(fm.data.author);
    posts.push({
      key,
      from: f.rel,
      title: title.slice(0, 400),
      slug,
      date,
      draft: draft || !date,
      ...(reason ? { draftReason: reason } : !date && !draft ? { draftReason: badDate ?? 'it has no publication date' } : {}),
      ...(author ? { author } : {}),
      ...(excerpt ? { excerpt } : {}),
      categories: termList(fm.data.categories ?? fm.data.category, true),
      tags: termList(fm.data.tags ?? fm.data.tag ?? fm.data.keywords, false),
      body: blocks,
      ...(picture ? { featured: media.key(picture, f.dir) } : {}),
      notes
    });
  }
  await media.resolve();
  if (over) skipped.push(`${over} more ${over === 1 ? 'post' : 'posts'}: an import brings at most ${MAX_IMPORT_POSTS}.`);
  return { kind: 'markdown', label, root, realRoot, posts, media: media.items, skipped };
}

/**
 * Whether a post is a draft: `draft: true` (Hugo, Eleventy, Astro) or `published: false` (Jekyll). A post saying
 * neither is published, as every generator publishes it; one whose draft setting can't be read stays a draft.
 */
function draftOf(data: Record<string, FrontValue>, unreadable: string[]): { draft: boolean; reason?: string } {
  const d = data.draft;
  const p = data.published;
  if (unreadable.includes('draft') || unreadable.includes('published')) return { draft: true, reason: 'its draft setting could not be read' };
  if (d !== undefined && typeof d !== 'boolean') return { draft: true, reason: 'its draft setting is not true or false' };
  if (p !== undefined && typeof p !== 'boolean' && !day(p)) return { draft: true, reason: 'its published setting is not true or false' };
  if (d === true) return { draft: true };
  if (p === false) return { draft: true };
  return { draft: false };
}
