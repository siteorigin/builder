/**
 * Fix with AI and Optimize with AI (#599): the request the AI chat opens with for a Search & AI readiness finding
 * (Project health, the export dialog) or for a page's or a post's Search & sharing previews, and how far it reaches.
 * The request goes into the message box, never straight to the AI: the author reads it, changes it if they like, and
 * sends it. It names its page as the chat's own starters do (lib/chatSuggestions), so it keeps its target once edited.
 *
 * A finding gets one only when the AI has an edit that fixes it (`aiFixable`) and this knows how to ask for it: a
 * page's search title, meta description or listing goes to that page alone, and the site's llms.txt, robots.txt and
 * shared header or footer to the whole site. Collections and their entries are changed only in the editor for now, so
 * a post's Search & sharing gets a question instead: suggestions to paste in, from what the post holds as typed.
 */
import type { ProjectState } from '@shared/types';
import type { SeoFinding, SeoSubject } from '@shared/seo';
import { seoText } from '@shared/seo';
import { isRichBlock, richTextToPlain } from '@shared/richtext';
import { SEO_DESCRIPTION_RANGE, SEO_TITLE_RANGE } from '@engine/seo-rules';
import { pageName, quoted } from './chatSuggestions';

export type SeoHandoff =
  /** An edit of one page: its own sections and settings, on the canvas when the chat opens. */
  | { mode: 'edit'; scope: 'page'; pageId: string; text: string }
  /** An edit that may change the whole site; the page on screen stays. */
  | { mode: 'edit'; scope: 'site'; text: string }
  /** A question, which changes nothing. */
  | { mode: 'ask'; text: string };

const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

const FIELD_WORDS = { title: 'search title', description: 'meta description' } as const;
const RANGE = { title: SEO_TITLE_RANGE, description: SEO_DESCRIPTION_RANGE } as const;

/** The words of the link a generic-link finding names, as its message quotes them. */
function linkWords(message: string): string | null {
  const m = /^A link says only “([\s\S]*)”(?: in the shared [a-z]+)?\.$/.exec(message);
  return m && m[1].trim() ? m[1] : null;
}

/** The request for one finding, or null when the AI cannot fix it, it is not one this knows, or what it names has gone. */
export function findingHandoff(state: ProjectState, f: SeoFinding): SeoHandoff | null {
  if (!f.aiFixable || !f.destination) return null;
  const d = f.destination;
  if (d.kind === 'pageSeo') {
    const page = own(state.pages, d.pageId);
    if (!page) return null;
    const on = pageName(state, page);
    const edit = (text: string): SeoHandoff => ({ mode: 'edit', scope: 'page', pageId: page.id, text });
    if (d.field === 'noindex') return f.code === 'SEO_HOME_NOINDEX' ? edit(`Let search engines list the ${on} page again`) : null;
    if (d.field !== 'title' && d.field !== 'description') return null;
    const what = FIELD_WORDS[d.field];
    const { min, max } = RANGE[d.field];
    if (f.code.endsWith('_MISSING')) return edit(`Write a ${what} for the ${on} page`);
    if (f.code.endsWith('_DUPLICATE')) return edit(`Give the ${on} page a ${what} of its own that no other page shares`);
    if (f.code.endsWith('_LENGTH')) return edit(`Rewrite the ${what} of the ${on} page in ${min} to ${max} characters`);
    return null;
  }
  if (d.kind === 'site') {
    const site = (text: string): SeoHandoff => ({ mode: 'edit', scope: 'site', text });
    if (f.code === 'SEO_LLMS_TXT_OFF') return site('Turn on llms.txt so AI agents get an index of the site’s pages');
    if (f.code === 'SEO_SEARCH_CRAWLERS_BLOCKED') return site('Let search engines crawl the whole website again in robots.txt, keeping the other crawler rules');
    if (f.code === 'SEO_AI_SEARCH_CRAWLERS_BLOCKED') return site('Let AI search engines crawl the whole website again in robots.txt, keeping AI training crawlers out and the other crawler rules');
    return null;
  }
  if (d.kind === 'element' && f.code === 'SEO_LINK_TEXT_GENERIC') {
    const words = linkWords(f.message);
    const link = words ? `the ${quoted(words)} link` : 'the link that says only “read more” or the like';
    if (d.owner.kind === 'page') {
      const page = own(state.pages, d.owner.id);
      if (!page || !own(page.nodes, d.nodeId)) return null;
      return { mode: 'edit', scope: 'page', pageId: page.id, text: `Reword ${link} on the ${pageName(state, page)} page so its words say where it leads` };
    }
    // The shared header and footer are on every page that shows them: changing them is a change to the whole site.
    if (d.owner.kind === 'shell' && (d.owner.id === 'header' || d.owner.id === 'footer')) {
      if (!own(state.site.shell[d.owner.id].nodes, d.nodeId)) return null;
      return { mode: 'edit', scope: 'site', text: `Reword ${link} in the site ${d.owner.id} so its words say where it leads` };
    }
  }
  return null;
}

/** How much of a post the question quotes, in characters: enough to write from, short enough to read before sending. */
const POST_LINE = 300;
const POST_OPENING = 600;

function clip(text: string, max: number): string {
  const one = seoText(text);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function plainBody(body: unknown): string {
  if (!Array.isArray(body) || !body.every(isRichBlock)) return '';
  try {
    return richTextToPlain(body);
  } catch {
    return '';
  }
}

/**
 * The request for a document's Search & sharing previews. `state` is the project with the text typed into its fields
 * laid over it (lib/seo-preview's `withTypedSeo`), so a description changed a moment ago is the one asked about.
 */
export function previewHandoff(state: ProjectState, subject: SeoSubject): SeoHandoff | null {
  if (subject.kind === 'page') {
    const page = own(state.pages, subject.pageId);
    if (!page) return null;
    return { mode: 'edit', scope: 'page', pageId: page.id, text: `Read the ${pageName(state, page)} page and improve its search title and meta description for search results, link previews and AI answers` };
  }
  const collection = own(state.collections, subject.collectionId);
  const entry = own(collection?.entries, subject.entryId);
  if (!collection || !entry) return null;
  const title = clip(typeof entry.title === 'string' ? entry.title : '', POST_LINE);
  const seo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  const lines = [
    `Suggest a search title (${SEO_TITLE_RANGE.min} to ${SEO_TITLE_RANGE.max} characters) and a meta description (${SEO_DESCRIPTION_RANGE.min} to ${SEO_DESCRIPTION_RANGE.max} characters) for my post ${title ? quoted(title) : 'below'}, for me to paste into its Search & sharing settings.`,
    ['Post title', title],
    ['Search title now', clip(typeof seo.title === 'string' ? seo.title : '', POST_LINE)],
    ['Meta description now', clip(typeof seo.description === 'string' ? seo.description : '', POST_LINE)],
    ['Excerpt', clip(typeof entry.excerpt === 'string' ? entry.excerpt : '', POST_LINE)],
    ['Opening', clip(plainBody(entry.body), POST_OPENING)]
  ];
  return { mode: 'ask', text: lines.flatMap((l) => (typeof l === 'string' ? [l] : l[1] ? [`${l[0]}: ${l[1]}`] : [])).join('\n') };
}
