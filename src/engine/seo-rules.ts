/**
 * The baseline SEO and agentic readiness rules (see seo-audit.ts), over what every project already holds: its public
 * URL, the Home page's search setting, each page's and entry's title and description, sharing images and the site
 * icon, links between pages and the words on them, the pictures and headings in collection entries' text, who
 * publishes the site (its identity, and the profiles that confirm it), and the facts of the pages typed for structured data.
 *
 * Titles and descriptions are judged on the documents search engines may list; links and entries' text on everything
 * the website publishes. Drafts are never judged: they are not on the website. A page the author says is a service,
 * product, event or guide is judged on the facts its structured data needs.
 */
import type { EditorDestination } from '@shared/api';
import type { EffectiveSeo, SeoFinding, SeoPillar } from '@shared/seo';
import { seoLength, seoText } from '@shared/seo';
import type { Collection, EntryDoc, OwnerRef, ProjectState } from '@shared/types';
import { isImageBlock, isRichBlock } from '@shared/richtext';
import { archivePages } from '@shared/archives';
import { checkPublicUrl } from '@shared/public-url';
import { agentDiscovery } from '@shared/llms';
import { crawlerAction, crawlerRules, isWholeSitePattern, KNOWN_CRAWLERS, presetAction, type CrawlerKind, type CrawlerRules } from '@shared/crawler-policy';
import { pagesShowing, SHELL_PARTS } from '@shared/page-shell';
import { showsEntryText, type SiteLink } from '@generator/checks';
import { showsFormTool, showsSiteSearch } from '@generator/webmcp';
import { webMcpOn } from '@shared/webmcp';
import { isLibraryImage } from '@generator/seo-graph';
import { sitePublisher } from '@shared/site-identity';
import { inspectPageStructuredData, typePhrase } from '@shared/page-structured-data';
import { publishedState } from '@generator/index';
import { bodyImageProblems } from './collections';
import type { SeoAuditContext, SeoAuditRule } from './seo-audit';

/**
 * The browser title lengths, in characters, that read well in search results: shorter says little about the page;
 * longer is cut short in most results.
 */
export const SEO_TITLE_RANGE = { min: 15, max: 60 } as const;
/** The description lengths, in characters, search results show whole and that say enough to choose the page by. */
export const SEO_DESCRIPTION_RANGE = { min: 50, max: 160 } as const;

/**
 * Link words that say nothing of where the link goes, compared lowercased with the punctuation after them left off.
 * Only phrases no destination is named by: a link to a guide called "Go" says where it goes.
 */
export const GENERIC_LINK_TEXT: ReadonlySet<string> = new Set(['click here', 'click', 'here', 'read more', 'learn more', 'more', 'more info', 'more information', 'find out more', 'see more', 'this link', 'this page']);

/** Link words as GENERIC_LINK_TEXT holds them: lowercased, spaces collapsed, and arrows and full stops around them left off. */
export function linkWords(label: string): string {
  return seoText(label)
    .toLowerCase()
    .replace(/^[\s→›»>]+|[\s.!…:→›»>]+$/gu, '');
}

type Owner = NonNullable<SeoFinding['owner']>;

const finding = (pillar: SeoPillar, f: Omit<SeoFinding, 'pillar'>): SeoFinding => ({ pillar, ...f });

/** The entry a document is, with its collection, when it is one. */
function entryOf(state: ProjectState, meta: EffectiveSeo): { collection: Collection; entry: EntryDoc } | undefined {
  if (meta.subject.kind !== 'entry') return undefined;
  const collection = state.collections[meta.subject.collectionId];
  return { collection, entry: collection.entries[meta.subject.entryId] };
}

/** A document as the author knows it: a page by its title, an entry by its title and its collection's name. */
function named(state: ProjectState, meta: EffectiveSeo): string {
  const e = entryOf(state, meta);
  if (!e) return `“${seoText(state.pages[(meta.subject as { pageId: string }).pageId].title) || meta.route}”`;
  return `“${seoText(e.entry.title) || meta.route}” (${seoText(e.collection.settings.name) || e.collection.settings.id})`;
}

const ownerOf = (meta: EffectiveSeo): Owner => (meta.subject.kind === 'page' ? { kind: 'page', id: meta.subject.pageId } : { kind: 'entry', id: meta.subject.entryId });

/**
 * Where a document's title or description is changed: a page's own Search & sharing field; an entry's own search
 * title or description when it has one (it is what search engines are shown), else its title or excerpt. The AI can
 * set a page's (update_page_seo); collections and their entries are changed only in the editor for now.
 */
function fieldFix(state: ProjectState, meta: EffectiveSeo, field: 'title' | 'description'): { destination: EditorDestination; aiFixable: boolean } {
  if (meta.subject.kind === 'page') return { destination: { kind: 'pageSeo', pageId: meta.subject.pageId, field }, aiFixable: true };
  const seo = entryOf(state, meta)?.entry.seo;
  const own = seo && typeof seo === 'object' && seoText(field === 'title' ? seo.title : seo.description) !== '';
  return { destination: { kind: 'entry', collectionId: meta.subject.collectionId, entryId: meta.subject.entryId, field: field === 'title' ? (own ? 'seoTitle' : 'title') : own ? 'seoDescription' : 'excerpt' }, aiFixable: false };
}

const baseUrl: SeoAuditRule = {
  id: 'base-url',
  check({ state }) {
    // A value of another kind (a number written by hand) is a URL that can't be used, not a missing one.
    const raw: unknown = state.site.baseUrl;
    const saved = typeof raw === 'string' ? raw.trim() : raw == null ? '' : JSON.stringify(raw);
    const check = checkPublicUrl(saved);
    const destination: EditorDestination = { kind: 'site', field: 'baseUrl' };
    const why = 'Without it the website has no canonical links, sitemap, sharing image addresses or structured data, so search engines and link previews cannot tell which address is the site’s own.';
    if (!check.ok)
      return [finding('technical', { severity: 'warning', code: 'SEO_BASE_URL_INVALID', message: `The public site URL “${saved}” can’t be used. ${check.message}`, site: 'baseUrl', explanation: why, aiFixable: false, destination })];
    if (!check.url) return [finding('technical', { severity: 'warning', code: 'SEO_BASE_URL_MISSING', message: 'No public site URL is set.', site: 'baseUrl', explanation: why, aiFixable: false, destination })];
    return [];
  }
};

const homeNoindex: SeoAuditRule = {
  id: 'home-noindex',
  check({ state, resolver }) {
    const home = resolver.resolve({ kind: 'page', pageId: state.site.homePageId });
    if (!home?.visibility.website || !home.noindex) return [];
    return [
      finding('technical', {
        severity: 'warning',
        code: 'SEO_HOME_NOINDEX',
        message: 'The Home page asks search engines not to list it.',
        owner: { kind: 'page', id: state.site.homePageId },
        site: 'noindex',
        explanation: 'The Home page is where search engines and AI answer engines start reading a site; hidden, the site is unlikely to be found by its name.',
        aiFixable: true,
        destination: { kind: 'pageSeo', pageId: state.site.homePageId, field: 'noindex' }
      })
    ];
  }
};

/**
 * What two documents share when they have the same title or description: the same words in one language (documents in
 * different languages may share a name), told apart regardless of case and spacing. Empty for a document with none.
 */
export function seoDuplicateKey(d: Pick<EffectiveSeo, 'language' | 'title' | 'description'>, field: 'title' | 'description'): string {
  const value = seoText(d[field]);
  return value ? `${d.language.toLowerCase()}\n${value.toLowerCase()}` : '';
}

/** Missing, repeated and too short or too long titles or descriptions, on the documents search engines may list. */
function textRule(id: string, field: 'title' | 'description'): SeoAuditRule {
  const what = field === 'title' ? 'browser title' : 'description';
  const CODE = field === 'title' ? 'SEO_TITLE' : 'SEO_DESCRIPTION';
  const range = field === 'title' ? SEO_TITLE_RANGE : SEO_DESCRIPTION_RANGE;
  return {
    id,
    check({ state, documents }) {
      const out: SeoFinding[] = [];
      const listed = documents.filter((d) => d.visibility.indexable);
      const groups = new Map<string, EffectiveSeo[]>();
      for (const d of listed) {
        const key = seoDuplicateKey(d, field);
        if (key) groups.set(key, [...(groups.get(key) ?? []), d]);
      }
      for (const d of listed) {
        const value = seoText(d[field]);
        const where = { owner: ownerOf(d), site: field, ...fieldFix(state, d, field) };
        if (!value) {
          out.push(
            finding('content', {
              severity: 'warning',
              code: `${CODE}_MISSING`,
              message: `${named(state, d)} has no ${what}.`,
              explanation: field === 'title' ? 'The browser title is the link search results show; without one the page is listed by its address.' : 'Search results and AI answers describe a page by its description; without one they pick words from the page themselves.',
              ...where
            })
          );
          continue;
        }
        const peers = groups.get(seoDuplicateKey(d, field))!;
        if (peers.length > 1) {
          const other = peers.find((p) => p !== d)!;
          out.push(
            finding('content', {
              severity: 'warning',
              code: `${CODE}_DUPLICATE`,
              message: `${named(state, d)} has the same ${what} as ${named(state, other)}${peers.length > 2 ? ` and ${peers.length - 2} more` : ''}: “${value}”.`,
              explanation: `Search engines tell pages apart by their ${what}s; pages that share one compete with each other, and the wrong one may be shown.`,
              ...where
            })
          );
        }
        const length = seoLength(value);
        if (length < range.min || length > range.max)
          out.push(
            finding('content', {
              severity: 'info',
              code: `${CODE}_LENGTH`,
              message: `${named(state, d)} has a ${what} of ${length} characters; ${range.min} to ${range.max} reads best.`,
              explanation: length > range.max ? `Search results cut a ${what} this long short.` : `A ${what} this short says little about the page in search results.`,
              ...where
            })
          );
      }
      return out;
    }
  };
}

const socialImage: SeoAuditRule = {
  id: 'social-image',
  check({ state, documents }) {
    const out: SeoFinding[] = [];
    const explanation = 'Links shared in messages and social posts show the sharing image; without one they show only words, and are passed over.';
    // Each document whose own choice has gone from the library is fixed on its own; the rest wait on the site's image.
    const waiting = documents.filter((d) => !d.image && d.imageSource !== 'own');
    for (const d of documents) {
      if (d.image || d.imageSource !== 'own') continue;
      out.push(
        finding('social', {
          severity: 'warning',
          code: 'SEO_SOCIAL_IMAGE_MISSING',
          message: `${named(state, d)}: its sharing image is no longer in the library, so it is shared without one.`,
          owner: ownerOf(d),
          site: 'socialImage',
          explanation,
          aiFixable: false,
          ...(d.subject.kind === 'page' ? { destination: { kind: 'pageSeo', pageId: d.subject.pageId, field: 'socialImage' } } : {})
        })
      );
    }
    // The site's own choice, gone from the library, is said as such: choosing it again is the fix.
    const gone = !!state.site.socialImage && waiting.some((d) => d.imageSource === 'site');
    if (waiting.length)
      out.push(
        finding('social', {
          severity: 'warning',
          code: 'SEO_SOCIAL_IMAGE_MISSING',
          message: gone
            ? `The site’s sharing image is no longer in the library, so ${waiting.length === documents.length ? 'the site is' : `${waiting.length} of its ${documents.length} pages are`} shared without one.`
            : `${waiting.length === documents.length ? 'The site has' : `${waiting.length} of the site’s ${documents.length} pages have`} no sharing image.`,
          site: 'socialImage',
          explanation: `${explanation} The site’s sharing image is used for every page without one of its own.`,
          aiFixable: false,
          destination: { kind: 'site', field: 'socialImage' }
        })
      );
    return out;
  }
};

const favicon: SeoAuditRule = {
  id: 'favicon',
  check({ state }) {
    const id: unknown = state.site.favicon;
    const icon = typeof id === 'string' && Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id] : undefined;
    if (icon?.kind === 'image') return [];
    return [
      finding('social', {
        severity: 'info',
        code: 'SEO_FAVICON_MISSING',
        message: 'The site has no icon of its own: browser tabs and search results show a letter in its place.',
        site: 'favicon',
        explanation: 'Search results and browser tabs show the site’s icon beside its name; one of its own makes the site recognizable at a glance.',
        aiFixable: false,
        destination: { kind: 'site', field: 'favicon' }
      })
    ];
  }
};

/**
 * The links that bring a visitor to a page from somewhere else on the website, each with the page it leads to. A link
 * on the page itself, or in a header or footer only the page itself shows, leads nowhere new.
 */
export function incomingLinks({ state, documents, links }: Pick<SeoAuditContext, 'state' | 'documents' | 'links'>): Array<SiteLink & { pageId: string }> {
  // Anything published besides pages shows both shared parts: an entry's page or a collection's index.
  const others = documents.some((d) => d.subject.kind === 'entry') || archivePages(state).length > 0;
  const published = new Set(documents.flatMap((d) => (d.subject.kind === 'page' ? [d.subject.pageId] : [])));
  const showing = Object.fromEntries(SHELL_PARTS.map((part) => [part, pagesShowing(state, part).filter((p) => published.has(p.id)).map((p) => p.id)]));
  return links().filter((l): l is SiteLink & { pageId: string } => {
    if (!l.pageId) return false;
    if (l.owner.kind === 'page' && l.owner.id === l.pageId) return false;
    return l.owner.kind !== 'shell' || others || showing[l.owner.id].some((id) => id !== l.pageId);
  });
}

/** Pages search engines may list that no link on the rest of the website leads to. */
const unlinkedPages: SeoAuditRule = {
  id: 'unlinked-pages',
  check(context) {
    const { state, documents } = context;
    const pages = documents.filter((d) => d.subject.kind === 'page' && d.visibility.indexable && d.subject.pageId !== state.site.homePageId);
    if (!pages.length) return [];
    const reached = new Set(incomingLinks(context).map((l) => l.pageId));
    return pages
      .filter((d) => !reached.has((d.subject as { pageId: string }).pageId))
      .map((d) =>
        finding('content', {
          severity: 'warning',
          code: 'SEO_PAGE_UNLINKED',
          message: `No link on the rest of the site leads to ${named(state, d)}.`,
          owner: ownerOf(d),
          site: 'incoming-links',
          explanation: 'Search engines and visitors find pages by following links; a page nothing links to may never be found. Link to it from a menu or a related page.',
          aiFixable: false
        })
      );
  }
};

/** Where a link is changed: the element that holds it, or the text of the entry it is in. */
function linkFix(state: ProjectState, l: SiteLink): { owner: Owner; nodeId?: string; site: string; destination?: EditorDestination } {
  if (l.owner.kind === 'entry') {
    const at = Object.values(state.collections).find((c) => Object.hasOwn(c.entries, l.owner.id));
    return { owner: l.owner, site: `link|${l.key}`, ...(at ? { destination: { kind: 'entry', collectionId: at.settings.id, entryId: l.owner.id, field: 'body' } } : {}) };
  }
  const owner = l.owner as OwnerRef;
  // A layout's link is told apart by the entry whose page shows it, when its words differ from entry to entry.
  const entryId = l.owner.kind === 'template' ? l.entryId : undefined;
  return { owner, nodeId: l.nodeId, site: `link|${l.nodeId}|${l.key}${entryId ? `|${entryId}` : ''}`, destination: { kind: 'element', owner, nodeId: l.nodeId, ...(entryId ? { entryId } : {}) } };
}

const genericLinkText: SeoAuditRule = {
  id: 'generic-link-text',
  check({ state, links }) {
    const out: SeoFinding[] = [];
    for (const l of links()) {
      if (l.unnamed || !GENERIC_LINK_TEXT.has(linkWords(l.label))) continue;
      out.push(
        finding('content', {
          severity: 'info',
          code: 'SEO_LINK_TEXT_GENERIC',
          message: `A link says only “${seoText(l.label)}”${l.owner.kind === 'shell' ? ` in the shared ${l.owner.id}` : ''}.`,
          explanation: 'Search engines, screen readers and AI agents read a link’s words to learn where it goes; words that name the destination say so where “read more” cannot.',
          // A page's or the shared header's or footer's link is the AI's to reword; an entry's text and a collection's layout are the editor's for now.
          aiFixable: l.owner.kind !== 'entry' && l.owner.kind !== 'template',
          ...linkFix(state, l)
        })
      );
    }
    return out;
  }
};

/** The published entries whose page shows their text, as the website shows it, each with its collection and a name for messages. */
function shownEntries(state: ProjectState, documents: readonly EffectiveSeo[]) {
  const live = publishedState(state);
  return documents.flatMap((d) => {
    const e = entryOf(state, d);
    // Damaged text (a block that is not one) is Project health's to report.
    return e && Array.isArray(e.entry.body) && e.entry.body.every(isRichBlock) && showsEntryText(live, live.collections[e.collection.settings.id] ?? e.collection, e.entry) ? [{ ...e, what: `${e.collection.settings.name}: “${e.entry.title}”` }] : [];
  });
}

const entryImages: SeoAuditRule = {
  id: 'entry-image-alt',
  check({ state, documents }) {
    const out: SeoFinding[] = [];
    for (const { collection, entry, what } of shownEntries(state, documents))
      for (const d of bodyImageProblems(state, entry.body, what, { kind: 'entry', id: entry.id })) {
        if (d.code !== 'ALT_MISSING') continue;
        const picture = Number(d.site?.split('|')[2]);
        out.push(
          finding('agentic', {
            ...d,
            explanation: 'Search engines, screen readers and AI agents know a picture only by its description. Mark it decorative if it adds nothing to the text.',
            aiFixable: false,
            destination: { kind: 'entry', collectionId: collection.settings.id, entryId: entry.id, field: 'body', ...(picture ? { picture } : {}) }
          })
        );
      }
    return out;
  }
};

const HEADING_LEVEL: Record<string, number> = { h2: 2, h3: 3, h4: 4 };

/**
 * Headings in an entry's text that skip a level below the one before them (a Heading 4 straight after a Heading 2).
 * The first is not judged: what comes before it is the entry's layout, which may give it a heading of its own.
 */
const entryHeadings: SeoAuditRule = {
  id: 'entry-headings',
  check({ state, documents }) {
    const out: SeoFinding[] = [];
    for (const { collection, entry, what } of shownEntries(state, documents)) {
      let level = 0;
      entry.body.forEach((b, i) => {
        if (isImageBlock(b) || !Object.hasOwn(HEADING_LEVEL, b.type)) return;
        const next = HEADING_LEVEL[b.type];
        if (level && next > level + 1) {
          const words = 'spans' in b && Array.isArray(b.spans) ? seoText(b.spans.map((sp) => (typeof sp?.text === 'string' ? sp.text : '')).join('')) : '';
          out.push(
            finding('agentic', {
              severity: 'warning',
              code: 'SEO_ENTRY_HEADING_SKIP',
              message: `${what}: the heading${words ? ` “${words}”` : ''} is a Heading ${next} after a Heading ${level}, skipping a level.`,
              owner: { kind: 'entry', id: entry.id },
              site: `body|heading|${i}`,
              explanation: 'Search engines, screen readers and AI agents read headings as the outline of the text; a skipped level makes that outline look like something is missing.',
              // An entry's text is changed only in the editor for now.
              aiFixable: false,
              destination: { kind: 'entry', collectionId: collection.settings.id, entryId: entry.id, field: 'body' }
            })
          );
        }
        level = next;
      });
    }
    return out;
  }
};

/**
 * What the website offers AI agents beside its pages (shared/llms.ts): its llms.txt index, which the author may have
 * turned off, and the pages and posts that index lists, which may be none.
 */
const agenticDiscovery: SeoAuditRule = {
  id: 'agentic-discovery',
  check({ state, documents }) {
    if (!agentDiscovery(state.site).llmsTxt)
      return [
        finding('agentic', {
          severity: 'info',
          code: 'SEO_LLMS_TXT_OFF',
          message: 'The website has no llms.txt: AI agents get no index of its pages and posts.',
          site: 'llmsTxt',
          explanation: 'AI assistants and answer engines read llms.txt to learn what a site covers and which pages to read, without picking through its menus and layout.',
          aiFixable: true,
          destination: { kind: 'site', field: 'llmsTxt' }
        })
      ];
    if (documents.some((d) => d.visibility.llms)) return [];
    return [
      finding('agentic', {
        severity: 'warning',
        code: 'SEO_LLMS_TXT_EMPTY',
        message: 'llms.txt lists no pages or posts: every one is a draft or hidden from search engines.',
        site: 'llmsTxt',
        explanation: 'llms.txt lists only what search engines may list, so AI agents are told of nothing on the site. Let search engines list the pages you want found.',
        aiFixable: false
      })
    ];
  }
};

/**
 * WebMCP readiness: a website with a contact form or its own search, which agents in a visitor's browser could use
 * through declared tools (shared/webmcp.ts), while the author has not turned WebMCP on. A suggestion only: it is off by
 * choice until the author decides agents may fill in the site's forms.
 */
const webMcpReadiness: SeoAuditRule = {
  id: 'webmcp-readiness',
  check({ state }) {
    if (webMcpOn(state.site)) return [];
    // Only forms whose code can declare a tool: an edited copy would declare none, whatever the switch says.
    const forms = showsFormTool(state);
    const search = showsSiteSearch(state);
    if (!forms && !search) return [];
    const what = forms && search ? 'a contact form and site search' : forms ? 'a contact form' : 'site search';
    return [
      finding('agentic', {
        severity: 'info',
        code: 'SEO_WEBMCP_OFF',
        message: `The website has ${what} but declares no WebMCP tools: AI agents in visitors’ browsers have to work ${forms && search ? 'them' : 'it'} out from the page.`,
        site: 'webmcp',
        explanation: 'With WebMCP on, each contact form tells AI assistants in the browser what it is for and what each field asks, and the site’s search can be used as a tool. The visitor still checks and sends every message.',
        aiFixable: true,
        destination: { kind: 'site', field: 'webmcp' }
      })
    ];
  }
};

/**
 * Whether robots.txt keeps a crawler out of the whole site when its preset would let it in: Custom keeps it out by
 * name, or closes every path ("/") to every crawler it lets in. A crawler the preset itself keeps out (Traditional
 * search engines only keeps out AI search) is the author's choice, and is never reported.
 */
function unexpectedlyBlocked(rules: CrawlerRules, token: string): 'named' | 'path' | null {
  const { action } = crawlerAction(rules, token);
  if (action === 'disallow') return presetAction(rules.base, token) === 'allow' ? 'named' : null;
  return rules.paths.some(isWholeSitePattern) ? 'path' : null;
}

/** Search engines, and AI search engines, robots.txt keeps out of the whole site without its preset saying so. */
const crawlerPolicy: SeoAuditRule = {
  id: 'crawler-policy',
  check({ state }) {
    const rules = crawlerRules(state.site);
    const found: SeoFinding[] = [];
    const report = (kind: CrawlerKind, pillar: SeoPillar, code: string, who: string, explanation: string) => {
      const blocked = KNOWN_CRAWLERS.filter((c) => c.kind === kind).map((c) => ({ token: c.token, why: unexpectedlyBlocked(rules, c.token) })).filter((c) => c.why);
      if (!blocked.length) return;
      const why = blocked.some((c) => c.why === 'path') ? 'a path closes every page to all crawlers' : 'Custom keeps them out by name';
      found.push(
        finding(pillar, {
          severity: 'warning',
          code,
          message: `robots.txt keeps ${who} out of the whole website (${blocked.map((c) => c.token).join(', ')}): ${why}.`,
          site: 'crawlerPolicy',
          explanation,
          aiFixable: true,
          destination: { kind: 'site', field: 'crawlerPolicy' }
        })
      );
    };
    report('search', 'technical', 'SEO_SEARCH_CRAWLERS_BLOCKED', 'search engines', 'A search engine kept out of every page can’t crawl the website: its results show the pages without their titles and descriptions, if at all. Let it in, or close only the paths you mean to.');
    report('ai-search', 'agentic', 'SEO_AI_SEARCH_CRAWLERS_BLOCKED', 'AI search engines', 'AI answer engines kept out of every page can’t read or cite the website when people ask about what it covers. Let them in, or choose “Traditional search engines only” if keeping them out is the intent.');
    return found;
  }
};

/**
 * Whether the site says who publishes it: its kind (organization, local business or person) and a name, and the
 * addresses of profiles elsewhere that confirm who that is. AI answer engines and search engines match an entity across
 * the web by those links, so without them the site's own claims stand alone. Neither can be filled in for the author:
 * only they know who they are and which profiles are theirs.
 */
const entityReadiness: SeoAuditRule = {
  id: 'entity-readiness',
  check({ state }) {
    const who = sitePublisher(state.site, isLibraryImage(state));
    if (!who.chosen || !seoText(who.name))
      return [
        finding('entity', {
          severity: 'warning',
          code: 'SEO_ENTITY_IDENTITY_MISSING',
          message: who.chosen ? 'The site’s publisher has no name.' : 'The site doesn’t say who publishes it: an organization, a local business or a person.',
          site: 'identity',
          explanation: 'Search engines and AI answer engines describe a site by the entity behind it. Saying who that is, by name, lets them connect the site to the business or person people ask about.',
          aiFixable: false,
          destination: { kind: 'site', field: 'identity' }
        })
      ];
    if (who.sameAs.length) return [];
    return [
      finding('entity', {
        severity: 'warning',
        code: 'SEO_ENTITY_SAME_AS_MISSING',
        message: `The site names ${who.kind === 'Person' ? 'its author' : 'its publisher'} but links to no profile that confirms who that is.`,
        site: 'sameAs',
        explanation: 'Profiles elsewhere (Wikidata, LinkedIn, GitHub, X, YouTube) let search engines and AI answer engines confirm the publisher is the one they know, rather than another with the same name.',
        aiFixable: false,
        destination: { kind: 'site', field: 'sameAs' }
      })
    ];
  }
};

/**
 * What the audit says of one document's typed structured data (shared/page-structured-data.ts), or null: a page the
 * author says is a service, a product, an event or a guide whose structured data can't say so yet (a fact it needs is
 * missing, two contradict each other, or the page has no title to name it by), or one saved by hand that can't be used. Only the author knows the facts, so the
 * AI is not offered to fill them in. Judged on the pages whose structured data the website writes, or will once it has
 * a public URL. The editor's structured data preview says the same.
 */
export function pageStructuredDataFinding(state: ProjectState, d: EffectiveSeo): SeoFinding | null {
  if (d.subject.kind !== 'page' || !d.visibility.indexable) return null;
  const page = state.pages[d.subject.pageId];
  const seo = page.seo && typeof page.seo === 'object' ? page.seo : undefined;
  const found = inspectPageStructuredData(seo?.structuredData);
  // A service, product, event or guide is named by the page's own title (generator/structured-data.ts): with a blank
  // one the entity is left out, however complete its facts are.
  const unnamed = found.ready && found.type !== 'WebPage' && found.type !== 'AboutPage' && found.type !== 'ContactPage' && !seoText(page.title);
  if (!found.issues.length && !unnamed) return null;
  const ready = found.ready && !unnamed;
  return finding('entity', {
    severity: 'warning',
    code: ready ? 'SEO_PAGE_STRUCTURED_DATA_UNUSABLE' : 'SEO_PAGE_STRUCTURED_DATA_INCOMPLETE',
    message: unnamed
      ? `${named(state, d)} is marked as ${typePhrase(found.type)}, but its structured data can’t name it until the page has a title: ${['Add the page’s title.', ...found.issues.map((i) => i.message)].join(' ')}`
      : ready
      ? `${named(state, d)} has structured data that can’t all be used: ${found.issues.map((i) => i.message).join(' ')}`
      : found.type === 'WebPage'
        ? `${named(state, d)} has a page type that can’t be used: ${found.issues.map((i) => i.message).join(' ')}`
        : `${named(state, d)} is marked as ${typePhrase(found.type)}, but its structured data can’t name it until its facts are complete: ${found.issues.map((i) => i.message).join(' ')}`,
    owner: ownerOf(d),
    site: 'structuredData',
    explanation: ready
      ? 'Search engines and AI answer engines compare services, products, events and guides by the facts their pages state. A fact that can’t be used is left out on its own; the rest is written as before.'
      : 'Search engines and AI answer engines compare services, products, events and guides by the facts their pages state. Until the facts it needs (a price, a start date) are there, the page’s structured data leaves the entity out; the rest of it is written as before.',
    aiFixable: false,
    destination: { kind: 'pageSeo', pageId: d.subject.pageId, field: unnamed ? 'pageTitle' : 'structuredData' }
  });
}

const pageStructuredData: SeoAuditRule = {
  id: 'page-structured-data',
  check({ state, documents }) {
    return documents.flatMap((d) => pageStructuredDataFinding(state, d) ?? []);
  }
};

/** Every baseline rule, in the order their findings are listed within a pillar. */
export const BASELINE_SEO_RULES: readonly SeoAuditRule[] = [baseUrl, homeNoindex, textRule('titles', 'title'), textRule('descriptions', 'description'), unlinkedPages, genericLinkText, socialImage, favicon, entryImages, entryHeadings, entityReadiness, pageStructuredData, agenticDiscovery, webMcpReadiness, crawlerPolicy];
