/** What reading a post left out or changed, as the import's report says it. */
import type { LinkValue } from '@shared/types';
import { linkQuery, linkFromTarget, MAX_LINK_QUERY, type RichPages } from '@shared/richtext';
import { MAX_POST_GALLERY_PICTURES, type HtmlReport } from './html';
import { POST_LINK_PREFIX } from './source';

const count = (n: number, one: string, many: string) => (n === 1 ? `${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}` : `${n} ${many}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function reportNotes(r: HtmlReport): string[] {
  const out: string[] = [];
  if (r.scripts) out.push(`Removed ${count(r.scripts, 'script', 'scripts')}.`);
  if (r.embeds.length) {
    const where = [...new Set(r.embeds.filter(Boolean))];
    out.push(`Left out ${count(r.embeds.length, 'embedded frame or player', 'embedded frames and players')}${where.length ? ` (${where.slice(0, 3).join(', ')}${where.length > 3 ? '…' : ''})` : ''}.`);
  }
  if (r.embedLinks) out.push(`Kept ${count(r.embedLinks, 'embedded video or post', 'embedded videos and posts')} as a link to ${r.embedLinks === 1 ? 'it' : 'them'}.`);
  if (r.forms) out.push(`Removed ${count(r.forms, 'form', 'forms')}.`);
  if (r.tables) out.push(`${cap(count(r.tables, 'table', 'tables'))} became plain lines of text.`);
  if (r.shortcodes.length) out.push(`Removed the shortcode${r.shortcodes.length === 1 ? '' : 's'} ${r.shortcodes.map((s) => `[${s}]`).join(', ')}.`);
  if (r.code) out.push(`${cap(count(r.code, 'block of code or preformatted text', 'blocks of code or preformatted text'))} became ordinary text.`);
  if (r.raised) out.push(`${cap(count(r.raised, 'superscript or subscript', 'superscripts and subscripts'))} became ordinary text on the line.`);
  if (r.struck) out.push(`Kept ${count(r.struck, 'struck-through passage', 'struck-through passages')} as ordinary text, no longer struck through.`);
  if (r.ticked) out.push(`Left out the tick of ${count(r.ticked, 'done task', 'done tasks')}: a check list shows every item alike.`);
  const empty = r.galleries.filter((g) => !g.pictures).length;
  if (empty) out.push(`Left out ${empty === 1 ? 'a gallery' : `${empty} galleries`}: the export lists no pictures for ${empty === 1 ? 'it' : 'them'}.`);
  const short = r.galleries.filter((g) => g.missing);
  if (short.length) {
    const missing = short.reduce((n, g) => n + g.missing, 0);
    const { pictures, missing: one } = short[0];
    const what =
      short.length > 1
        ? `${missing} pictures of ${short.length} galleries (${short.map((g) => `${g.missing} of ${g.pictures}`).join(', ')})`
        : one === pictures
          ? pictures === 1
            ? 'a gallery’s picture'
            : `a gallery’s ${pictures} pictures`
          : `${one} of a gallery’s ${pictures} pictures`;
    out.push(`Left out ${what}: the export does not include ${missing === 1 ? 'it' : 'them'}. Export All content to bring pictures’ details along.`);
  }
  if (r.galleryOverflow) out.push(`Left out ${count(r.galleryOverflow, 'gallery picture', 'gallery pictures')} past the first ${MAX_POST_GALLERY_PICTURES}: a post brings at most ${MAX_POST_GALLERY_PICTURES} from its galleries.`);
  if (r.footnotes) out.push(r.footnotes === 1 ? 'Its footnote is under a Footnotes heading, and its number no longer links to it.' : `Its ${r.footnotes} footnotes are a numbered list under a Footnotes heading, and their numbers no longer link to them.`);
  if (r.lostFootnotes) out.push(r.lostFootnotes === 1 ? 'The text of its footnote was not in the export: its number is left without a note.' : `The text of ${r.lostFootnotes} of its footnotes was not in the export: their numbers are left without notes.`);
  if (r.inPostLinks) out.push(`${r.inPostLinks === 1 ? 'A link to a place in the post itself (a note number, say) is plain words now' : `${r.inPostLinks} links to places in the post itself (its note numbers, say) are plain words now`}: an imported post can’t link within itself.`);
  if (r.droppedLinks) out.push(`Kept the words of ${count(r.droppedLinks, 'link', 'links')} whose address could not be kept.`);
  return out;
}

/** The most links of one post named one by one; the rest are counted. */
const NAMED_LINKS = 20;
const shownHref = (href: string) => (href.length > 200 ? `${href.slice(0, 200)}…` : href);

/** The links of one post that lose part of their address, each named once as the post wrote it. */
export function linkNotes() {
  // By the whole address, so two that read alike once shortened stay two.
  const found = new Map<string, Set<string>>();
  return {
    add(href: string, what: string): void {
      let said = found.get(href);
      if (!said) found.set(href, (said = new Set()));
      said.add(what);
    },
    list(): string[] {
      const out = [...found].slice(0, NAMED_LINKS).flatMap(([href, said]) => [...said].map((what) => `The link “${shownHref(href)}” ${what}`));
      const rest = found.size - NAMED_LINKS;
      if (rest > 0) out.push(`${rest} more ${rest === 1 ? 'link also needs' : 'links also need'} checking.`);
      return out;
    }
  };
}
export type LinkNotes = ReturnType<typeof linkNotes>;

/** An address's query ("?…") and section ("#…"), each empty when it has none or only the mark. */
export function splitHref(href: string): { path: string; query: string; section: string } {
  const hash = href.indexOf('#');
  const before = hash < 0 ? href : href.slice(0, hash);
  const section = hash < 0 ? '' : href.slice(hash);
  const at = before.indexOf('?');
  const query = at < 0 ? '' : before.slice(at);
  return { path: at < 0 ? before : before.slice(0, at), query: query.length > 1 ? query : '', section: section.length > 1 ? section : '' };
}

/** A link to the imported post `post`: its query goes with it, and what it can't carry is named. */
export function postLink(post: string, href: string, query: string, section: string, newTab: boolean, notes: LinkNotes): LinkValue {
  return entryLink(`${POST_LINK_PREFIX}${post}`, href, query, section, newTab, notes);
}

/** A link to the entry `target` (an imported post's, or one already in the project), as postLink makes one. */
export function entryLink(target: string, href: string, query: string, section: string, newTab: boolean, notes: LinkNotes): LinkValue {
  let kept = linkQuery(query);
  if (kept.length > MAX_LINK_QUERY) {
    kept = '';
    notes.add(href, 'goes to its post without its query, which is too long to keep.');
  }
  if (section) notes.add(href, `opens its post at the top: an imported post has no section “${shownHref(section)}” to go to.`);
  return { type: 'entry', target, ...(kept ? { query: kept } : {}), ...(newTab ? { newTab: true } : {}) };
}

/**
 * A link to the project's page at `path`, or null when none has that address. It keeps a section ID; a query, or a
 * section that is no ID, is named.
 */
export function pageLink(path: string, href: string, query: string, section: string, pages: RichPages, newTab: boolean, notes: LinkNotes): LinkValue | null {
  const whole = linkFromTarget(`${path}${section}`, pages, newTab);
  const page = whole ?? (section ? linkFromTarget(path, pages, newTab) : null);
  if (!page) return null;
  if (query) notes.add(href, `goes to its page without “${shownHref(query)}”: only a link to an imported post keeps a query.`);
  if (section && !whole) notes.add(href, `opens its page at the top: “${shownHref(section)}” is not a section ID.`);
  return page;
}
