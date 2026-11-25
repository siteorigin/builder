/**
 * Agentic discovery: what the website offers AI agents beside its pages, following the llms.txt proposal
 * (https://llmstxt.org/). An index of the pages and collection entries search engines may list (`/llms.txt`), and,
 * when the author turns them on, every one of them as Markdown in one file (`/llms-full.txt`) and a Markdown copy
 * beside each one's page, at its address with `index.html.md` added (`/about/index.html.md`, `/index.html.md` for
 * Home). The generator writes them (generator/llms.ts) from the same documents as the sitemap.
 */
import type { SiteDoc } from './types';

/** The index, at the root of the website. */
export const LLMS_TXT_FILE = 'llms.txt';
/** Every listed page and entry in one file, at the root of the website. */
export const LLMS_FULL_FILE = 'llms-full.txt';
/**
 * The name of a page's Markdown copy, in its own folder beside its index.html. No address can hold it: an address's
 * parts never hold a dot (see validateSegment), so it is never a page, an entry or an old address of one.
 */
export const MARKDOWN_MIRROR_FILE = 'index.html.md';

/** The site's discovery settings, with their defaults. */
export interface AgentDiscovery {
  /** The index is written: on unless the author turned it off. */
  llmsTxt: boolean;
  llmsFull: boolean;
  markdownMirrors: boolean;
  /** The line the index opens with: the author's own, else the site's description; empty when there is neither. */
  summary: string;
}

/** Text on one line, as the index writes it; anything that is not text is none. */
export const oneLine = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '');

/** The settings as the website reads them: a value of another kind (a hand edit) is no choice, and the default stands. */
export function agentDiscovery(site: Pick<SiteDoc, 'llmsTxt' | 'llmsFull' | 'markdownMirrors' | 'llmsSummary' | 'description'>): AgentDiscovery {
  return {
    llmsTxt: site.llmsTxt !== false,
    llmsFull: site.llmsFull === true,
    markdownMirrors: site.markdownMirrors === true,
    summary: oneLine(site.llmsSummary) || oneLine(site.description)
  };
}

/** Whether a project file is one the generator writes for agents: llms.txt, llms-full.txt or a Markdown copy of a page. */
export const isDiscoveryPath = (path: string) =>
  path === `static/${LLMS_TXT_FILE}` || path === `static/${LLMS_FULL_FILE}` || (path.startsWith('static/') && path.endsWith(`/${MARKDOWN_MIRROR_FILE}`));

/** The address of a page's Markdown copy: "/about/" gives "/about/index.html.md". */
export const markdownMirrorRoute = (route: string) => `${route.endsWith('/') ? route : `${route}/`}${MARKDOWN_MIRROR_FILE}`;
