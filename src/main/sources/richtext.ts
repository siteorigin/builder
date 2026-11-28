/**
 * A source's formatted text as an entry's text: Contentful's Rich Text document, and the HTML that WordPress and
 * others send. A picture inside the text keeps its place as an image block naming its web address (see TEXT_IMAGE),
 * which a sync brings into the library; anything an entry's text cannot hold is left out (tables become lines). A link
 * whose address cannot be kept keeps its words, and is counted so the author is told (LinkRead).
 */
import type { LinkValue, RichBlock, RichSpan, RichText } from '@shared/types';
import { cleanBlocks, cleanSpans, isTelephone } from '@shared/richtext';
import { emptyReport, htmlToRichText } from '../posts-import/html';
import { markdownToHtml } from '../posts-import/markdown';
import { TEXT_IMAGE } from './protocol';

type CfNode = { nodeType?: unknown; value?: unknown; marks?: unknown; data?: unknown; content?: unknown };

/**
 * How a record's formatted text is read: the address of the page it was shown on, which its relative links are read
 * from (a WordPress post's own), and how many links it had whose address an entry cannot keep.
 */
export interface LinkRead {
  base?: string;
  dropped: number;
}

/** The longest address a relative link becomes, as the longest a source's own may be: a long page's sections are not read. */
const MAX_RESOLVED = 2048;
/** A web address as a link holds it (engine/values.ts normalizeLink): anything else would stop the whole sync. */
const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * A page's own address that relative links can be read from: a whole http(s) address, without the name and password
 * the server may have been asked with (never one its links gave a reader), or undefined.
 */
export function linkBase(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return undefined;
  try {
    const u = new URL(v.trim());
    if (!/^https?:$/.test(u.protocol)) return undefined;
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * An http(s) address a browser can go to, read from `base` when it is relative: a whole one as it is written, unless it
 * has spaces or quotes in it, which a link holds as a browser reads them. Else null: one a link cannot hold as it is.
 */
function webAddress(t: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(t, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!base && URL_RE.test(t)) return t;
  return URL_RE.test(u.href) && (!base || u.href.length <= MAX_RESOLVED) ? u.href : null;
}

/**
 * A web address a link can keep: http(s), mail or a telephone number, never script. A relative one (`/visit/`,
 * `../calendar/`, `#quiet-hours`, `?p=12`, `//host/x`) goes where it went from `base`, the page it was shown on: an
 * entry's text gives its sections no names to jump to, so a section goes to its place on that page.
 */
function externalLink(href: unknown, newTab = false, base?: string): LinkValue | null {
  if (typeof href !== 'string') return null;
  const t = href.trim();
  const tab = newTab ? { newTab: true } : {};
  if (/^https?:\/\//i.test(t)) {
    const url = webAddress(t);
    return url ? { type: 'url', target: url, ...tab } : null;
  }
  // As a link holds them, or not at all: one that is no address would stop the whole sync.
  if (/^mailto:/i.test(t)) return EMAIL_RE.test(t.slice(7).trim()) ? { type: 'email', target: t.slice(7) } : null;
  if (/^tel:/i.test(t)) return isTelephone(t.slice(4).trim()) ? { type: 'tel', target: t.slice(4) } : null;
  // Any other way of going somewhere (script, data, a file) is never kept, nor a link to nowhere.
  if (!t || !base || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  const url = webAddress(t, base);
  return url ? { type: 'url', target: url, ...tab } : null;
}

const MAX_DEPTH = 64;

/** The runs of text inside a Contentful node, marks and links kept. */
function cfSpans(node: CfNode, read: LinkRead, depth = 0, link?: LinkValue): RichSpan[] {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return [];
  if (node.nodeType === 'text') {
    if (typeof node.value !== 'string' || !node.value) return [];
    const marks = Array.isArray(node.marks) ? node.marks.map((m) => (m as { type?: unknown })?.type) : [];
    return [{ text: node.value, ...(marks.includes('bold') ? { strong: true } : {}), ...(marks.includes('italic') ? { em: true } : {}), ...(link ? { link } : {}) }];
  }
  let here = link;
  if (node.nodeType === 'hyperlink') {
    const own = externalLink((node.data as { uri?: unknown } | undefined)?.uri, false, read.base);
    if (own) here = own;
    else read.dropped++;
    // Another entry or file of the space's: nowhere on the site.
  } else if (node.nodeType === 'entry-hyperlink' || node.nodeType === 'asset-hyperlink' || node.nodeType === 'resource-hyperlink') read.dropped++;
  const kids = Array.isArray(node.content) ? (node.content as CfNode[]) : [];
  const out: RichSpan[] = [];
  for (const k of kids) {
    // A paragraph inside a list item or a quote: its own line, joined with a space.
    if (out.length && k && typeof k === 'object' && (k.nodeType === 'paragraph' || String(k.nodeType).startsWith('heading-'))) out.push({ text: ' ' });
    out.push(...cfSpans(k, read, depth + 1, here));
  }
  return out;
}

const HEADINGS: Record<string, 'h2' | 'h3' | 'h4'> = { 'heading-1': 'h2', 'heading-2': 'h2', 'heading-3': 'h3', 'heading-4': 'h4', 'heading-5': 'h4', 'heading-6': 'h4' };

/** The items of a Contentful list, a nested list's items following their parent's. */
function cfListItems(list: CfNode, depth: number, read: LinkRead): RichSpan[][] {
  const items: RichSpan[][] = [];
  for (const item of Array.isArray(list.content) ? (list.content as CfNode[]) : []) {
    if (!item || typeof item !== 'object' || item.nodeType !== 'list-item') continue;
    const own: CfNode[] = [];
    const nested: CfNode[] = [];
    for (const k of Array.isArray(item.content) ? (item.content as CfNode[]) : []) (k?.nodeType === 'ordered-list' || k?.nodeType === 'unordered-list' ? nested : own).push(k);
    const spans = cleanSpans(cfSpans({ content: own }, read, depth + 1));
    if (spans.length) items.push(spans);
    for (const n of nested) if (depth < MAX_DEPTH) items.push(...cfListItems(n, depth + 1, read));
  }
  return items;
}

/**
 * A Contentful Rich Text document as an entry's text. Anything that is no document (a plain string a field holds
 * instead) is read as paragraphs of plain text.
 */
export function contentfulRichText(doc: unknown, read: LinkRead = { dropped: 0 }): RichText {
  if (typeof doc === 'string') return plainRichText(doc);
  if (!doc || typeof doc !== 'object' || (doc as CfNode).nodeType !== 'document') return [];
  const blocks: RichBlock[] = [];
  const walk = (nodes: unknown, depth: number) => {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
    for (const n of nodes as CfNode[]) {
      if (!n || typeof n !== 'object') continue;
      const type = String(n.nodeType);
      if (type === 'paragraph') blocks.push({ type: 'p', spans: cleanSpans(cfSpans(n, read, depth)) });
      else if (Object.hasOwn(HEADINGS, type)) blocks.push({ type: HEADINGS[type], spans: cleanSpans(cfSpans(n, read, depth)) });
      else if (type === 'blockquote') blocks.push({ type: 'blockquote', spans: cleanSpans(cfSpans(n, read, depth)) });
      else if (type === 'unordered-list' || type === 'ordered-list') blocks.push({ type: type === 'ordered-list' ? 'ol' : 'ul', items: cfListItems(n, depth, read) });
      else if (type === 'table') {
        // Each row a line, its cells one after another.
        for (const row of Array.isArray(n.content) ? (n.content as CfNode[]) : []) {
          const cells = (Array.isArray(row?.content) ? (row.content as CfNode[]) : []).map((c) => cleanSpans(cfSpans(c, read, depth + 1)));
          const spans = cells.flatMap((c, i) => (i ? [{ text: ' · ' }, ...c] : c));
          if (spans.length) blocks.push({ type: 'p', spans: cleanSpans(spans) });
        }
      } else if (type === 'embedded-asset-block') {
        // A picture the reply includes, at its place in the text; it is brought into the library as a sync goes.
        const asset = (n.data as { target?: unknown } | undefined)?.target as { fields?: { file?: { url?: unknown; contentType?: unknown }; description?: unknown; title?: unknown } } | undefined;
        const url = typeof asset?.fields?.file?.url === 'string' ? asset.fields.file.url.replace(/^\/\//, 'https://') : '';
        const isImage = asset?.fields?.file?.contentType === undefined || String(asset.fields.file.contentType).startsWith('image/');
        const alt = [asset?.fields?.description, asset?.fields?.title].find((t): t is string => typeof t === 'string' && !!t.trim()) ?? '';
        if (/^https?:\/\//i.test(url) && isImage) blocks.push({ type: 'image', assetId: `${TEXT_IMAGE}${url}`, alt });
      } else if (type === 'embedded-entry-block' || type === 'hr') continue;
      else walk(n.content, depth + 1);
    }
  };
  walk((doc as CfNode).content, 0);
  return cleanBlocks(blocks.filter((b) => !('spans' in b) || b.spans.length));
}

/** Plain text as paragraphs, one per blank-line-separated run. */
export function plainRichText(text: string): RichText {
  return cleanBlocks(
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((p) => ({ type: 'p' as const, spans: [{ text: p }] }))
  );
}

/** HTML (a WordPress post's rendered content) as an entry's text: its pictures on the web where they are, and web links. */
export function htmlRichText(html: unknown, read: LinkRead = { dropped: 0 }): RichText {
  if (typeof html !== 'string' || !html.trim()) return [];
  const report = emptyReport();
  const blocks = htmlToRichText(
    html,
    {
      image: (img) => {
        const src = img.src.trim().replace(/^\/\//, 'https://');
        return /^https?:\/\//i.test(src) && src.length <= 4096 ? `${TEXT_IMAGE}${src}` : null;
      },
      link: (href, newTab) => externalLink(href, newTab, read.base)
    },
    report
  );
  read.dropped += report.droppedLinks;
  return blocks;
}

/** Markdown (Strapi's classic rich text) as an entry's text. */
export function markdownRichText(md: unknown, read: LinkRead = { dropped: 0 }): RichText {
  if (typeof md !== 'string' || !md.trim()) return [];
  return htmlRichText(markdownToHtml(md), read);
}
