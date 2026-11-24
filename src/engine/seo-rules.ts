/**
 * The baseline SEO and agentic readiness rules (see seo-audit.ts), over what every project already holds: its public
 * URL, the Home page's search setting, each page's and entry's title and description, sharing images and the site
 * icon, links between pages and the words on them, and the pictures and headings in collection entries' text.
 *
 * Titles and descriptions are judged on the documents search engines may list; links and entries' text on everything
 * the website publishes. Drafts are never judged: they are not on the website.
 */
import type { EditorDestination } from '@shared/api';
import type { EffectiveSeo, SeoFinding, SeoPillar } from '@shared/seo';
import { seoLength, seoText } from '@shared/seo';
import type { Collection, EntryDoc, OwnerRef, ProjectState } from '@shared/types';
import { isImageBlock, isRichBlock } from '@shared/richtext';
import { archivePages } from '@shared/archives';
import { checkPublicUrl } from '@shared/public-url';
import { pagesShowing, SHELL_PARTS } from '@shared/page-shell';
import { showsEntryText, type SiteLink } from '@generator/checks';
import { bodyImageProblems } from './collections';
import type { SeoAuditRule } from './seo-audit';

/**
 * The browser title lengths, in characters, that read well in search results: shorter says little about the page;
 * longer is cut short in most results.
 */
export const SEO_TITLE_RANGE = { min: 15, max: 60 } as const;
/** The description lengths, in characters, search results show whole and that say enough to choose the page by. */
export const SEO_DESCRIPTION_RANGE = { min: 50, max: 160 } as const;

/** Link words that say nothing of where the link goes, compared lowercased with the punctuation after them left off. */
export const GENERIC_LINK_TEXT: ReadonlySet<string> = new Set(['click here', 'click', 'here', 'read more', 'learn more', 'more', 'more info', 'more information', 'find out more', 'see more', 'this link', 'link', 'this page', 'go']);

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
 * Where a document's title or description is changed, and whether the AI can change it: a page's own Search & sharing
 * field; an entry's title or excerpt, unless an SEO override the editor has no field for yet is what it shows.
 */
function fieldFix(state: ProjectState, meta: EffectiveSeo, field: 'title' | 'description'): { destination?: EditorDestination; aiFixable: boolean } {
  if (meta.subject.kind === 'page') return { destination: { kind: 'pageSeo', pageId: meta.subject.pageId, field }, aiFixable: true };
  const { entry } = entryOf(state, meta)!;
  if (seoText(entry.seo?.[field])) return { aiFixable: false };
  return { destination: { kind: 'entry', collectionId: meta.subject.collectionId, entryId: meta.subject.entryId, field: field === 'title' ? 'title' : 'excerpt' }, aiFixable: true };
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
      // The same words in one language: documents in different languages may share a name.
      const groups = new Map<string, EffectiveSeo[]>();
      for (const d of listed) {
        const value = seoText(d[field]);
        if (!value) continue;
        const key = `${d.language.toLowerCase()}\n${value.toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), d]);
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
        const peers = groups.get(`${d.language.toLowerCase()}\n${value.toLowerCase()}`)!;
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
        explanation: 'Search results and browser tabs show the site’s icon beside its name; one of its own makes the site recognisable at a glance.',
        aiFixable: false,
        destination: { kind: 'site', field: 'favicon' }
      })
    ];
  }
};

/** Pages search engines may list that no link on the rest of the website leads to. */
const unlinkedPages: SeoAuditRule = {
  id: 'unlinked-pages',
  check({ state, documents, links }) {
    const pages = documents.filter((d) => d.subject.kind === 'page' && d.visibility.indexable && d.subject.pageId !== state.site.homePageId);
    if (!pages.length) return [];
    // Anything published besides pages shows both shared parts: an entry's page or a collection's index.
    const others = documents.some((d) => d.subject.kind === 'entry') || archivePages(state).length > 0;
    const published = new Set(documents.flatMap((d) => (d.subject.kind === 'page' ? [d.subject.pageId] : [])));
    const showing = Object.fromEntries(SHELL_PARTS.map((part) => [part, pagesShowing(state, part).filter((p) => published.has(p.id)).map((p) => p.id)]));
    const reached = new Set<string>();
    for (const l of links()) {
      if (!l.pageId) continue;
      // A link on the page itself, or in a header or footer only the page itself shows, leads nowhere new.
      if (l.owner.kind === 'page' && l.owner.id === l.pageId) continue;
      if (l.owner.kind === 'shell' && !others && !showing[l.owner.id].some((id) => id !== l.pageId)) continue;
      reached.add(l.pageId);
    }
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
  return { owner, nodeId: l.nodeId, site: `link|${l.nodeId}|${l.key}`, destination: { kind: 'element', owner, nodeId: l.nodeId, ...(l.owner.kind === 'template' && l.entryId ? { entryId: l.entryId } : {}) } };
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
          aiFixable: true,
          ...linkFix(state, l)
        })
      );
    }
    return out;
  }
};

/** The published entries whose page shows their text, each with its collection and a name for messages. */
function shownEntries(state: ProjectState, documents: readonly EffectiveSeo[]) {
  return documents.flatMap((d) => {
    const e = entryOf(state, d);
    // Damaged text (a block that is not one) is Project health's to report.
    return e && Array.isArray(e.entry.body) && e.entry.body.every(isRichBlock) && showsEntryText(state, e.collection, e.entry) ? [{ ...e, what: `${e.collection.settings.name}: “${e.entry.title}”` }] : [];
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
 * Headings in an entry's text that skip a level. The entry's title is its page's Heading 1, so its text's headings
 * start at Heading 2.
 */
const entryHeadings: SeoAuditRule = {
  id: 'entry-headings',
  check({ state, documents }) {
    const out: SeoFinding[] = [];
    for (const { collection, entry, what } of shownEntries(state, documents)) {
      let level = 1;
      entry.body.forEach((b, i) => {
        if (isImageBlock(b) || !Object.hasOwn(HEADING_LEVEL, b.type)) return;
        const next = HEADING_LEVEL[b.type];
        if (next > level + 1) {
          const words = 'spans' in b && Array.isArray(b.spans) ? seoText(b.spans.map((s) => s.text).join('')) : '';
          out.push(
            finding('agentic', {
              severity: 'warning',
              code: 'SEO_ENTRY_HEADING_SKIP',
              message: `${what}: the heading${words ? ` “${words}”` : ''} is a Heading ${next} after a Heading ${level}, skipping a level.`,
              owner: { kind: 'entry', id: entry.id },
              site: `body|heading|${i}`,
              explanation: 'Search engines, screen readers and AI agents read headings as the outline of the text; a skipped level makes that outline look like something is missing.',
              aiFixable: true,
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

/** Every baseline rule, in the order their findings are listed within a pillar. */
export const BASELINE_SEO_RULES: readonly SeoAuditRule[] = [baseUrl, homeNoindex, textRule('titles', 'title'), textRule('descriptions', 'description'), unlinkedPages, genericLinkText, socialImage, favicon, entryImages, entryHeadings];

