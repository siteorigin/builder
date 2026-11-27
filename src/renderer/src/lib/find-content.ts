/**
 * Find and replace across the site's content: the words visitors read and where links go, on every page and in the
 * shared header and footer, each labelled by page, section and field. A replacement is one batch of ordinary edits,
 * reviewed against a dry run first, so it undoes in one step and shows every text and destination it changes.
 */
import type { ElementRef, GraphNode, InstanceNode, LinkValue, ListItem, NodeTree, OwnerRef, ProjectState, RichListType, RichSpan, RichText } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { cleanBlocks, cleanSpans, isImageBlock, isListBlock, toRichText } from '@shared/richtext';
import { collectionIndexRoutes } from '@shared/archives';
import { renderedContent, type ContentSource, type RenderedContent } from '@generator/checks';
import { applyOperations } from '@engine/apply';
import { normalizeLink } from '@engine/values';
import { childLists, displayName, itemLinkPairs } from '@engine/tree';
import { partIdFor } from './model';
import { pageShowing, pagesShowing } from '@shared/page-shell';
import { SAMPLE_CONTACT, SAMPLE_CONTACT_VALUES, type SampleContactKind } from '@shared/sample-contact';
import { dialString } from '@shared/contact-links';
import { publishedState } from '@generator/index';
import { isSyncedCollection, orderedEntries } from '@shared/collections';

/** A collection entry, as the owner of its title and excerpt: `id` is the entry's. */
export interface EntryOwner {
  kind: 'entry';
  id: string;
  collectionId: string;
}

/** Where a field of the site is kept: a page, the shared header or footer, a layout, a component, or an entry. */
export type ContentOwner = OwnerRef | EntryOwner;

/** One field of the site that shows content: a text, a button's label, a list item's field, or a destination. */
export interface ContentField {
  /** Names this field in any revision of the project: its document, node and where in that node it is stored. */
  key: string;
  owner: ContentOwner;
  /** The page or shell node: the content's own node, or the placement that shows it. For an entry, the entry's ID. */
  nodeId: string;
  kind: 'text' | 'link';
  value: unknown;
  rich: boolean;
  /** Rich text whose inline links render as links (and so are destinations to search). */
  richLinks: boolean;
  plainAs?: RichListType;
  /** Where to change it. None: fixed in a component's design. */
  source?: ContentSource;
  /** A custom code component's property: found and opened, but changed in the inspector. */
  custom?: boolean;
  /** Shown by a News list or Article header from a page's article settings, and changed there. */
  computed?: boolean;
  defNodeId?: string;
  itemPath?: string[];
  direct: boolean;
  /** The page's title, or Header / Footer. */
  where: string;
  /** For the shared header and footer: how many pages show it. */
  sharedPages?: number;
  /** The section on the page (or the header or footer itself) it belongs to. */
  section: string;
  /** The field, as the inspector names it: "Heading", "Contact links › Email › Destination". */
  label: string;
  /** A collection entry's title or excerpt, changed with an entry edit (or, synced from a source, not here). */
  entry?: { collectionId: string; entryId: string; field: 'title' | 'excerpt'; draft: boolean; synced: boolean };
}

/** A searchable run of one field: its text, a block or list item of rich text, a destination. */
interface Part {
  path: string;
  kind: 'text' | 'link';
  text: string;
  /** Characters shown before the stored value (the # of a section link). */
  offset?: number;
  /** Why matches in it cannot be replaced from here. */
  blocked?: string;
  /** Rich text: its block, list item and spans; for a link, the first span of the linked run. */
  block?: number;
  item?: number;
  spans?: RichSpan[];
  span?: number;
  /** For a link in rich text: the span after its linked run. */
  spanEnd?: number;
}

export interface ContentMatch {
  /** Names this match: its field, the part of the field and where in it the match starts. */
  id: string;
  field: ContentField;
  part: string;
  kind: 'text' | 'link';
  start: number;
  end: number;
  /** The words around the match, for the result list. */
  before: string;
  match: string;
  after: string;
  /** Why this match cannot be replaced here. It can still be opened. */
  blocked?: string;
}

export interface FindOptions {
  matchCase?: boolean;
  /** Stop after this many matches. */
  limit?: number;
}

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);
/** The indexes' addresses, worked out once for each snapshot searched (a snapshot never changes). */
const indexRoutes = new WeakMap<ProjectState, Record<string, string>>();
const indexRoute = (state: ProjectState, id: string): string | undefined => {
  let routes = indexRoutes.get(state);
  if (!routes) indexRoutes.set(state, (routes = collectionIndexRoutes(state)));
  return own(routes, id);
};
const isLink = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && typeof (v as LinkValue).target === 'string';
const sameLink = (a: LinkValue | undefined, b: LinkValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const oneLine = (t: string) => t.replace(/\s+/g, ' ');
/** A line break inside rich text, shown where text is shown on one line, so a change that only adds or removes one shows. */
const breaksShown = (t: string) => t.replace(/[ \t]*\n[ \t]*/g, ' ↵ ');
/** Text as a page shows it: the whitespace HTML collapses, collapsed (a non-breaking space is deliberate and stays). */
const shownText = (t: string) => t.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');

function sourceKey(c: RenderedContent): unknown[] {
  const s = c.source;
  if (!s) return ['design', c.at ?? null];
  return s.kind === 'node' ? ['node', s.field] : ['prop', s.prop, s.itemId ?? null, s.field ?? null];
}

/** Each node's top-level ancestor in its tree, for the section it belongs to. */
function sectionsOf(tree: NodeTree): (id: string) => string {
  const parent = new Map<string, string>();
  for (const n of Object.values(tree.nodes)) for (const cl of childLists(n)) for (const c of cl.ids) parent.set(c, n.id);
  return (id) => {
    let cur = id;
    for (let guard = 0; parent.has(cur) && guard < 100; guard++) cur = parent.get(cur)!;
    return cur;
  };
}

/** The items a placement's list shows: its own, or the default ones it has not changed. */
function listItems(inst: InstanceNode, prop: string, schemaDefault: unknown): ListItem[] {
  const v = own(inst.props, prop);
  return (Array.isArray(v) ? v : Array.isArray(schemaDefault) ? schemaDefault : []) as ListItem[];
}

/** The field's name as the inspector shows it, and the rich text kind its plain lines take. */
function fieldLabel(state: ProjectState, tree: NodeTree, c: RenderedContent): { label: string; plainAs?: RichListType } {
  const node = own(tree.nodes, c.nodeId);
  const s = c.source;
  if (!node) return { label: c.kind === 'link' ? 'Destination' : 'Text' };
  if (!s) {
    const def = node.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
    return { label: `${c.kind === 'link' ? 'Link' : 'Text'} in the ${def?.name ?? 'component'} design` };
  }
  if (s.kind === 'node') {
    const name = displayName(state, node);
    if (node.kind === 'link') return { label: `${name} ${s.field === 'link' ? 'destination' : 'label'}` };
    return { label: name };
  }
  const def = node.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
  const schema = def ? own(def.properties, s.prop) : undefined;
  if (!schema) return { label: s.prop };
  if (!s.itemId && s.field !== undefined && schema.type === 'object') {
    const field = own(schema.fields, s.field);
    return { label: field ? `${schema.label} ${field.label.toLowerCase()}` : schema.label, plainAs: field?.type === 'richtext' ? field.plainAs : undefined };
  }
  if (!s.itemId || schema.type !== 'list' || node.kind !== 'instance') return { label: schema.label, plainAs: schema.type === 'richtext' ? schema.plainAs : undefined };
  const items = listItems(node, s.prop, schema.default);
  const i = items.findIndex((x) => x?.id === s.itemId);
  const titled = i >= 0 ? items[i][schema.titleField ?? 'label'] : undefined;
  const title = typeof titled === 'string' && titled.trim() ? oneLine(titled.trim()).slice(0, 40) : `${schema.itemLabel} ${i + 1}`;
  const field = s.field ? own(schema.fields, s.field) : undefined;
  return { label: `${schema.label} › ${title} › ${field?.label ?? s.field}`, plainAs: field?.type === 'richtext' ? field.plainAs : undefined };
}

/**
 * Every field of the site that shows content, in reading order: the shared header, each page, the shared footer,
 * then each collection's entries, by their title and excerpt. The header or footer is left out when no page shows it.
 */
export function contentFields(state: ProjectState): ContentField[] {
  return [...pageFields(state), ...entryFields(state)];
}

/** The fields the pages and the shared header and footer show, in reading order. */
function pageFields(state: ProjectState): ContentField[] {
  const pages = state.site.pageOrder.filter((id) => own(state.pages, id));
  const headerPages = pagesShowing(state, 'header').length;
  const footerPages = pagesShowing(state, 'footer').length;
  const trees: Array<{ owner: OwnerRef; tree: NodeTree; where: string; shared?: number }> = [];
  if (headerPages) trees.push({ owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header, where: 'Header', shared: headerPages });
  for (const id of pages) trees.push({ owner: { kind: 'page', id }, tree: state.pages[id], where: state.pages[id].title });
  if (footerPages) trees.push({ owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer, where: 'Footer', shared: footerPages });
  const out: ContentField[] = [];
  for (const { owner, tree, where, shared } of trees) {
    const sectionOf = sectionsOf(tree);
    for (const c of renderedContent(state, tree)) {
      const root = own(tree.nodes, sectionOf(c.nodeId));
      const { label, plainAs } = fieldLabel(state, tree, c);
      out.push({
        key: JSON.stringify([owner.kind, owner.id, c.nodeId, c.kind, ...sourceKey(c)]),
        owner,
        nodeId: c.nodeId,
        kind: c.kind,
        value: c.value,
        rich: !!c.rich,
        richLinks: !!c.richLinks,
        ...(plainAs ? { plainAs } : {}),
        ...(c.source ? { source: c.source } : {}),
        ...(c.custom ? { custom: true } : {}),
        ...(c.computed ? { computed: true } : {}),
        ...(c.defNodeId ? { defNodeId: c.defNodeId } : {}),
        ...(c.itemPath ? { itemPath: c.itemPath } : {}),
        direct: !!c.direct,
        where,
        ...(shared ? { sharedPages: shared } : {}),
        section: root ? displayName(state, root) : where,
        label
      });
    }
  }
  return out;
}

/**
 * The title and excerpt of every collection entry, collection by collection in the order their entries are listed.
 * Drafts are included, as draft pages are; a synced collection's entries are found but changed only at their source.
 */
function entryFields(state: ProjectState): ContentField[] {
  const out: ContentField[] = [];
  // By name, as the Content panel lists them.
  const collections = Object.values(state.collections ?? {}).sort((a, b) => a.settings.name.localeCompare(b.settings.name) || a.settings.id.localeCompare(b.settings.id));
  for (const c of collections) {
    const synced = isSyncedCollection(c.settings);
    for (const e of orderedEntries(c)) {
      const fields: Array<['title' | 'excerpt', string | undefined]> = [
        ['title', e.title],
        ['excerpt', e.excerpt]
      ];
      for (const [field, value] of fields) {
        if (typeof value !== 'string' || !value.trim()) continue;
        out.push({
          key: JSON.stringify(['entry', c.settings.id, e.id, 'text', field]),
          owner: { kind: 'entry', id: e.id, collectionId: c.settings.id },
          nodeId: e.id,
          kind: 'text',
          value,
          rich: false,
          richLinks: false,
          direct: false,
          where: e.title.trim() || 'Untitled entry',
          section: c.settings.name,
          label: field === 'title' ? 'Title' : 'Excerpt',
          entry: { collectionId: c.settings.id, entryId: e.id, field, draft: e.draft !== false, synced }
        });
      }
    }
  }
  return out;
}

/** A destination as a visitor would read it, and as search finds it: an address, a number, a URL, a page's route. */
function linkPart(state: ProjectState, link: LinkValue, path: string): Part | null {
  switch (link.type) {
    case 'email':
    case 'tel':
    case 'url':
      return link.target ? { path, kind: 'link', text: link.target } : null;
    case 'anchor':
      return { path, kind: 'link', text: `#${link.target}`, offset: 1 };
    case 'page': {
      // A link to a page that is gone goes nowhere: the site shows only its words.
      const page = own(state.pages, link.target);
      if (!page) return null;
      return { path, kind: 'link', text: page.route + (link.anchor ? `#${link.anchor}` : ''), blocked: 'This goes to a page of the site. Choose another page for it in the inspector.' };
    }
    case 'collection': {
      // Found by the index's address, while the website has one; the collection is chosen in the inspector.
      const route = indexRoute(state, link.target);
      return route ? { path, kind: 'link', text: route, blocked: 'This goes to a collection’s index. Choose another destination for it in the inspector.' } : null;
    }
    case 'document': {
      // Found by the file visitors download; the link itself names the document, which is chosen in the inspector.
      const doc = own(state.assets.assets, link.target);
      const text = doc?.kind === 'document' ? [doc.originalName, doc.name].find((t) => typeof t === 'string' && t.trim()) : undefined;
      if (!text) return null;
      return { path, kind: 'link', text, blocked: 'This downloads a document from Assets. Choose another document for it in the inspector, or give the document a new file in Assets.' };
    }
    default:
      return null;
  }
}

/** A destination in words, for the review. */
export function describeLink(state: ProjectState, link: unknown): string {
  if (!isLink(link) || link.type === 'none') return 'No link';
  switch (link.type) {
    case 'email':
      return `Email ${link.target}`;
    case 'tel':
      return `Phone ${link.target}`;
    case 'anchor':
      return `#${link.target} on the same page`;
    case 'page': {
      const page = own(state.pages, link.target);
      return `${page?.title ?? 'Missing page'} (${(page?.route ?? link.target) + (link.anchor ? `#${link.anchor}` : '')})`;
    }
    case 'collection': {
      const c = own(state.collections ?? {}, link.target);
      const route = indexRoute(state, link.target);
      return c ? `${c.settings.name} index${route ? ` (${route})` : ''}` : 'Missing collection';
    }
    case 'document': {
      const doc = own(state.assets.assets, link.target);
      const name = doc?.kind === 'document' ? [doc.originalName, doc.name].find((t) => typeof t === 'string' && t.trim()) : undefined;
      return doc?.kind === 'document' ? `Download ${name ?? 'a document'}` : 'Missing document';
    }
    default:
      return link.target;
  }
}

function richOf(f: ContentField): RichText {
  try {
    return toRichText(f.value, f.plainAs);
  } catch {
    return [];
  }
}

/** The runs of a field that search reads. */
function partsOf(state: ProjectState, f: ContentField): Part[] {
  if (f.kind === 'link') {
    const p = isLink(f.value) ? linkPart(state, f.value, 'l') : null;
    return p ? [p] : [];
  }
  if (!f.rich) return typeof f.value === 'string' ? [{ path: 't', kind: 'text', text: f.value }] : [];
  const parts: Part[] = [];
  richOf(f).forEach((b, block) => {
    // A picture between paragraphs (an article's) holds no words of its own to find.
    const runs: Array<{ spans: RichSpan[]; item: number | undefined }> = isListBlock(b) ? b.items.map((spans, item) => ({ spans, item })) : isImageBlock(b) ? [] : [{ spans: b.spans, item: undefined }];
    for (const { spans, item } of runs) {
      const path = item === undefined ? `b${block}` : `b${block}.${item}`;
      parts.push({ path, kind: 'text', text: spans.map((s) => s.text).join(''), block, item, spans });
      if (!f.richLinks) continue;
      spans.forEach((sp, span) => {
        if (!sp.link || (span > 0 && sameLink(spans[span - 1].link, sp.link))) return;
        const p = linkPart(state, sp.link, `${path}@${span}`);
        let spanEnd = span + 1;
        while (spanEnd < spans.length && sameLink(spans[spanEnd].link, sp.link)) spanEnd++;
        if (p) parts.push({ ...p, block, item, spans, span, spanEnd });
      });
    }
  });
  return parts;
}

/** The search as a pattern: the words in order, any spacing between them, literal characters only. */
export function contentPattern(query: string, opts: FindOptions = {}): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), opts.matchCase ? 'gu' : 'giu');
}

/** Whether a range of rich text runs across the edge of a link (part of it linked, part not, or two links). */
function crossesLink(spans: RichSpan[], start: number, end: number): boolean {
  let pos = 0;
  let first: LinkValue | null | undefined;
  for (const sp of spans) {
    const a = pos;
    pos += sp.text.length;
    if (pos <= start || a >= end) continue;
    if (first === undefined) first = sp.link ?? null;
    else if (!sameLink(first ?? undefined, sp.link)) return true;
  }
  return false;
}

function blockedReason(f: ContentField, part: Part, start: number, end: number): string | undefined {
  if (f.entry) return f.entry.synced ? `The ${f.section} collection is synced from an external source, so its entries are read-only here. Change this in the source, or detach the collection from it.` : undefined;
  if (f.computed) return 'This is shown from an article’s page settings or a collection entry. Change its title, date, byline or excerpt there.';
  if (!f.source) return 'This is part of a component’s design. Open it to change it everywhere, or to make this placement its own.';
  if (f.custom) return 'This belongs to a custom code component, which may use it as a setting. Change it in the inspector.';
  if (part.blocked) return part.blocked;
  if (part.offset && start < part.offset) return 'Change the # of a section link in the inspector.';
  if (part.kind === 'text' && part.spans && crossesLink(part.spans, start, end)) return 'Part of this is a link and part is not. Change it in the inspector.';
  return undefined;
}

/**
 * Every match of `query` in the site's content: visible words and destinations, each with the words around it.
 * Matches inside one field never overlap. `fields` lets a caller reuse one listing for several searches.
 */
export function findContent(state: ProjectState, query: string, opts: FindOptions = {}, fields: ContentField[] = contentFields(state)): ContentMatch[] {
  const re = contentPattern(query, opts);
  if (!re) return [];
  const out: ContentMatch[] = [];
  const limit = opts.limit ?? Infinity;
  for (const f of fields) {
    for (const part of partsOf(state, f)) {
      for (const m of part.text.matchAll(re)) {
        if (out.length >= limit) return out;
        out.push(matchAt(f, part, m.index ?? 0, (m.index ?? 0) + m[0].length));
      }
    }
  }
  return out;
}

/** The match of the range `start`–`end` of a part of a field, with the words around it; `held` keeps it from replacing. */
function matchAt(f: ContentField, part: Part, start: number, end: number, held?: string): ContentMatch {
  const from = Math.max(0, start - 40);
  const to = Math.min(part.text.length, end + 60);
  const blocked = blockedReason(f, part, start, end) ?? held;
  const shown = (t: string) => oneLine(part.spans ? breaksShown(t) : t);
  return {
    id: `${f.key}|${part.path}|${start}`,
    field: f,
    part: part.path,
    kind: part.kind,
    start,
    end,
    before: (from > 0 ? '…' : '') + shown(part.text.slice(from, start)),
    match: shown(part.text.slice(start, end)),
    after: shown(part.text.slice(end, to)) + (to < part.text.length ? '…' : ''),
    ...(blocked ? { blocked } : {})
  };
}

// ---------------------------------------------------------------------------
// Sample contact details
// ---------------------------------------------------------------------------

/** What may stand between the digits of a written telephone number: spaces (\s covers the non-breaking ones), dots, dashes and brackets. */
const DIAL_GAP = '[\\s().\\p{Pd}]*';
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Each sample detail as visitors may read it, found generously so none goes out unreviewed: the address not inside a
 * longer mailbox or domain (myhello@…, …example.com.au), the number's digits in order with any spacing, the street
 * address with any spacing.
 */
const SAMPLE_PATTERNS: Record<SampleContactKind, RegExp> = {
  email: new RegExp(`(?<![\\p{L}\\p{N}_.+-])${escapeRe(SAMPLE_CONTACT.email)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'giu'),
  phone: new RegExp(`(?<![\\p{N}_+])(?:\\+${DIAL_GAP})?${[...SAMPLE_CONTACT.phoneDial.replace(/\D/g, '')].join(DIAL_GAP)}(?![\\p{N}_])`, 'gu'),
  address: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(SAMPLE_CONTACT.address).replace(/,\s*/g, ',\\s*').replace(/ +/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu')
};

/**
 * Why a sample in words is not replaced from here: it runs into more of an address, number or name, so it may be part
 * of someone else's (o'hello@example.com, +44 (20) 1555 0134, Millbrook-East). It is still reviewed and opened.
 */
function joinedReason(kind: SampleContactKind, text: string, start: number, end: number): string | undefined {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (kind === 'email' && (/[!#$%&'*/=?^`{|}~@]$/.test(before) || /^["']?@/.test(after))) return 'This address runs into other characters, so it may be someone else’s. Check it in the inspector.';
  if (kind === 'address' && (/[\p{L}\p{N}]\s*\p{Pd}+\s*$/u.test(before) || /^\s*\p{Pd}+\s*[\p{L}\p{N}]/u.test(after))) return 'This address runs into another name, so it may be a different place. Check it in the inspector.';
  const joined = /[\p{L}_]$/u.test(before) || /^[\p{L}_]|^[\s()./\p{Pd}]*\d/u.test(after) || (text[start] !== '+' && /\d[\s()./\p{Pd}]*$/u.test(before));
  return kind === 'phone' && joined ? 'This number runs into other digits, so it may be a different number. Check it in the inspector.' : undefined;
}

/** Whether a number dials the sample: its digits, as a telephone link sends them, with or without the leading +. */
const dialsSample = (t: string) => {
  const dial = t.replace(/[^+\d]/g, '');
  return dial === SAMPLE_CONTACT.phoneDial || dial === SAMPLE_CONTACT.phoneDial.replace(/^\+/, '');
};

/**
 * Where each sample detail is in a destination: each recipient of an email link that is the sample address (the
 * other recipients, the subject and the rest stay as they are), or a telephone link that dials the sample number, as
 * a whole.
 */
function sampleInLink(kind: SampleContactKind, type: 'email' | 'tel', target: string): Array<[number, number, string?]> {
  if (kind === 'email' && type === 'email') {
    const out: Array<[number, number, string?]> = [];
    const to = target.split('?')[0];
    // A link to several recipients (as a pasted mailto: names them) is changed in the inspector, which can keep it.
    const held = to.includes(',') ? 'This link has other recipients too. Change it in the inspector.' : undefined;
    for (const m of to.matchAll(/[^,]+/g)) {
      const lead = m[0].length - m[0].trimStart().length;
      const address = m[0].trim();
      if (address.toLowerCase() === SAMPLE_CONTACT.email) out.push([(m.index ?? 0) + lead, (m.index ?? 0) + lead + address.length, held]);
    }
    // Copied in (?cc=…, ?bcc=…), it is still sent to: reviewed, and changed in the inspector.
    let query = target.slice(to.length);
    try {
      query = decodeURIComponent(query);
    } catch {
      // Left as written.
    }
    if (new RegExp(SAMPLE_PATTERNS.email.source, 'iu').test(query)) out.push([to.length, target.length, 'This link copies the sample address in too. Change it in the inspector.']);
    return out;
  }
  // Read as the site dials it, so a bracketed trunk zero ("+1 (0)555 0134") still dials the sample.
  return kind === 'phone' && type === 'tel' && dialsSample(dialString(target)) ? [[0, target.length]] : [];
}

/** The kind of contact a destination reaches, when it reaches one: only email and phone links send anything. */
function linkKind(f: ContentField, part: Part): 'email' | 'tel' | null {
  const link = part.span !== undefined ? part.spans?.[part.span]?.link : f.kind === 'link' && isLink(f.value) ? f.value : undefined;
  return link?.type === 'email' || link?.type === 'tel' ? link.type : null;
}

export interface SampleContactGroup {
  kind: SampleContactKind;
  /** The detail as the review names it. */
  value: string;
  label: string;
  /** Every text and destination the published website shows it in. */
  matches: ContentMatch[];
}

/**
 * The catalogue's sample contact details the published website still shows (see @shared/sample-contact), one group
 * for each that it does: in words visitors read, and in the email and phone links they use. Drafts are left out, as
 * the website leaves them out, and the shared header and footer count when a published page shows them. The matches
 * are ordinary find results, so Find and Replace changes a group in one step and the inspector opens each one.
 */
export function sampleContactMatches(state: ProjectState): SampleContactGroup[] {
  // What the published website shows, worked out as it is built (a condition on a link to a draft reads it as gone).
  // A shared part's reach is every page one edit to it changes, drafts too, as Find says it.
  const live = publishedState(state);
  const reach = { header: pagesShowing(state, 'header').length, footer: pagesShowing(state, 'footer').length };
  // The pages and shared parts only, where the starters put their sample details; entries are left to Find.
  const fields = pageFields(live).map((f) => (f.owner.kind === 'shell' && f.sharedPages !== undefined && (f.owner.id === 'header' || f.owner.id === 'footer') ? { ...f, sharedPages: reach[f.owner.id] } : f));
  const groups: SampleContactGroup[] = [];
  for (const sample of SAMPLE_CONTACT_VALUES) {
    const matches: ContentMatch[] = [];
    for (const f of fields) {
      for (const part of partsOf(live, f)) {
        if (part.kind === 'link') {
          const type = linkKind(f, part);
          for (const [start, end, held] of type ? sampleInLink(sample.kind, type, part.text) : []) matches.push(matchAt(f, part, start, end, held));
          continue;
        }
        for (const m of part.text.matchAll(SAMPLE_PATTERNS[sample.kind])) {
          const start = m.index ?? 0;
          const end = start + m[0].length;
          matches.push(matchAt(f, part, start, end, joinedReason(sample.kind, part.text, start, end)));
        }
      }
    }
    if (matches.length) groups.push({ ...sample, matches });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Replacing
// ---------------------------------------------------------------------------

export interface ContentChange {
  field: ContentField;
  kind: 'text' | 'link';
  before: string;
  after: string;
  /** Not a chosen match: a change the edit makes along with them, listed so nothing changes unseen. */
  knockOn?: boolean;
}

export interface ReplacePlan {
  /** The edits, as one batch: one step to undo. Empty when nothing would change. */
  operations: EditOperation[];
  /** Every text and destination the edits change. */
  changes: ContentChange[];
  /** Why the edits cannot be made (the project refused them in a dry run, or one would remove a link). */
  error?: string;
  /** Chosen matches that cannot be replaced here. */
  skipped: number;
}

/** Replaces the ranges (right to left, so earlier offsets hold) in a string. */
function spliceText(text: string, ranges: Array<{ start: number; end: number }>, replacement: string): string {
  let out = text;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + replacement + out.slice(r.end);
  return out;
}

/** Replaces a range of a run of spans: the new words take the formatting (and link) of the span the range starts in. */
function spliceSpans(spans: RichSpan[], start: number, end: number, replacement: string) {
  let pos = 0;
  let placed = false;
  for (const sp of spans) {
    const a = pos;
    const b = pos + sp.text.length;
    pos = b;
    if (b <= start || a >= end) continue;
    const from = Math.max(a, start) - a;
    const to = Math.min(b, end) - a;
    sp.text = sp.text.slice(0, from) + (placed ? '' : replacement) + sp.text.slice(to);
    placed = true;
  }
}

/** A destination as the project will store it (an anchor without its #, say), or as given when it would refuse it. */
function stored(state: ProjectState, link: LinkValue): LinkValue {
  try {
    return normalizeLink(link, state, 'Link');
  } catch {
    return link;
  }
}

/** Each linked run of spans that has words: the spans it covers. Emptying every span of one removes that link. */
function linkedRuns(spans: RichSpan[]): number[][] {
  const runs: number[][] = [];
  spans.forEach((sp, i) => {
    if (!sp.link) return;
    if (i > 0 && sameLink(spans[i - 1].link, sp.link)) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });
  return runs.filter((r) => r.some((i) => spans[i].text.trim()));
}

const spansText = (spans: RichSpan[]) => shownText(breaksShown(spans.map((s) => s.text).join('')));

/** The field's next value with the chosen matches replaced, and what that changes in words. */
function replaceIn(state: ProjectState, f: ContentField, matches: ContentMatch[], replacement: string): { value: unknown; changes: ContentChange[]; error?: string } | null {
  const parts = new Map(partsOf(state, f).map((p) => [p.path, p]));
  const byPart = new Map<string, ContentMatch[]>();
  for (const m of matches) {
    const part = parts.get(m.part);
    // A match that already reads as the replacement changes nothing, and must not take another span's formatting.
    if (!part || part.text.slice(m.start, m.end) === replacement) continue;
    byPart.set(m.part, [...(byPart.get(m.part) ?? []), m]);
  }
  if (f.kind === 'link') {
    const part = parts.get('l');
    const ms = byPart.get('l');
    if (!part || !ms || !isLink(f.value)) return null;
    const text = spliceText(part.text, ms, replacement);
    const next: LinkValue = { ...f.value, target: text.slice(part.offset ?? 0) };
    if (sameLink(next, f.value)) return null;
    return { value: next, changes: [{ field: f, kind: 'link', before: describeLink(state, f.value), after: describeLink(state, next) }] };
  }
  if (!f.rich) {
    const ms = byPart.get('t');
    if (typeof f.value !== 'string' || !ms) return null;
    const next = spliceText(f.value, ms, replacement);
    if (next === f.value) return null;
    return { value: next, changes: [{ field: f, kind: 'text', before: shownText(f.value), after: shownText(next) }] };
  }
  const blocks = structuredClone(richOf(f));
  const spansAt = (p: Part): RichSpan[] => {
    const b = blocks[p.block!];
    return isListBlock(b) ? b.items[p.item!] : isImageBlock(b) ? [] : b.spans;
  };
  const changes: ContentChange[] = [];
  // Destinations first, each over the spans its run covered before any change: they keep every span's words, so
  // the text ranges below still line up.
  for (const [path, ms] of byPart) {
    const part = parts.get(path);
    if (!part || part.kind !== 'link' || part.span === undefined) continue;
    const spans = spansAt(part);
    const was = part.spans![part.span].link!;
    const next: LinkValue = { ...was, target: spliceText(part.text, ms, replacement).slice(part.offset ?? 0) };
    if (sameLink(next, was)) continue;
    for (let i = part.span; i < (part.spanEnd ?? part.span + 1); i++) spans[i].link = { ...next };
    changes.push({ field: f, kind: 'link', before: describeLink(state, was), after: describeLink(state, stored(state, next)) });
  }
  for (const [path, ms] of byPart) {
    const part = parts.get(path);
    if (!part || part.kind !== 'text') continue;
    const spans = spansAt(part);
    const was = structuredClone(spans);
    // The links as they were, before any destination above changed: two links made the same are still two.
    const runs = linkedRuns(part.spans!);
    for (const m of [...ms].sort((a, b) => b.start - a.start)) spliceSpans(spans, m.start, m.end, replacement);
    if (runs.some((r) => !r.some((i) => spans[i].text.trim()))) return { value: f.value, changes: [], error: `Replacing “${ms[0].match}” would remove a link from ${f.label} on ${f.where}. Leave that match out, or change it in the inspector.` };
    // Compared as the project stores them: formatting and a non-breaking space are changes too.
    if (JSON.stringify(cleanSpans(structuredClone(spans))) !== JSON.stringify(cleanSpans(was))) changes.push({ field: f, kind: 'text', before: spansText(was), after: spansText(spans) });
  }
  if (!changes.length) return null;
  return { value: cleanBlocks(blocks), changes };
}

/** The value of one field of a list item, as the placement shows it. */
function itemValue(state: ProjectState, owner: OwnerRef, nodeId: string, prop: string, itemId: string, field: string): unknown {
  const tree = treeOf(state, owner);
  const inst = tree && own(tree.nodes, nodeId);
  if (inst?.kind !== 'instance') return undefined;
  const schema = own(state.components, inst.definitionId)?.properties[prop];
  if (schema?.type !== 'list') return undefined;
  const item = listItems(inst, prop, schema.default).find((x) => x?.id === itemId);
  if (!item) return undefined;
  return Object.hasOwn(item, field) ? item[field] : (own(schema.fields, field) as { default?: unknown } | undefined)?.default;
}

function treeOf(state: ProjectState, owner: OwnerRef): NodeTree | undefined {
  if (owner.kind === 'page') return own(state.pages, owner.id);
  if (owner.kind === 'shell') return owner.id === 'header' || owner.id === 'footer' ? state.site.shell[owner.id] : undefined;
  if (owner.kind === 'template') return own(state.collections ?? {}, owner.id)?.settings.template;
  return own(state.components, owner.id)?.tree;
}

/** The destinations and words each field shows, to find what an edit changes besides the chosen matches. */
function shownBy(state: ProjectState, fields: ContentField[]): Map<string, { field: ContentField; text: string; links: string[] }> {
  const out = new Map<string, { field: ContentField; text: string; links: string[] }>();
  for (const f of fields) {
    const parts = partsOf(state, f);
    // One destination per linked run of each paragraph or list item, as search reads them.
    const links = f.kind === 'link' ? [describeLink(state, f.value)] : parts.filter((p) => p.kind === 'link' && p.spans && p.span !== undefined).map((p) => describeLink(state, p.spans![p.span!].link));
    out.set(f.key, { field: f, text: parts.filter((p) => p.kind === 'text').map((p) => shownText(p.text)).join(' / '), links: links.sort() });
  }
  return out;
}

/** The longest title and excerpt an entry edit takes (see entry.update in @shared/ops). */
const ENTRY_TITLE_MAX = 200;
const ENTRY_EXCERPT_MAX = 320;
const clipped = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);

/** The error a dry run raised, without the batch position the project adds for its own logs. */
const plainError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Operation \d+ \([^)]*\): /, '');

/**
 * The edits that replace the chosen matches with `replacement`, as one batch, and what they change. Destinations
 * change only where a destination match was chosen: an address shown as text and its link are two matches, and the
 * link of a list item whose text changes is kept as it is unless its own match was chosen too. A link's label is
 * never touched by a change to its destination. The batch is tried on a copy of the project first: its error is
 * returned instead of being found on Replace, and anything else it would change is listed with the changes.
 */
export function planReplace(state: ProjectState, chosen: ContentMatch[], replacement: string): ReplacePlan {
  const usable = chosen.filter((m) => !m.blocked);
  const skipped = chosen.length - usable.length;
  const groups = new Map<string, ContentMatch[]>();
  for (const m of usable) groups.set(m.field.key, [...(groups.get(m.field.key) ?? []), m]);
  const operations: EditOperation[] = [];
  const changes: ContentChange[] = [];
  const planned = new Set<string>();
  // One patch per list item, so its fields (and a kept link) are set together.
  const patches = new Map<string, { owner: OwnerRef; nodeId: string; prop: string; itemId: string; value: Record<string, unknown> }>();
  const entryEdits = new Map<string, { collectionId: string; entryId: string; value: { title?: string; excerpt?: string } }>();
  for (const ms of groups.values()) {
    const f = ms[0].field;
    const s = f.source;
    if (!s && !f.entry) continue;
    const next = replaceIn(state, f, ms, replacement);
    if (!next) continue;
    if (next.error) return { operations: [], changes: [], error: next.error, skipped };
    planned.add(f.key);
    changes.push(...next.changes);
    const owner = f.owner;
    if (owner.kind === 'entry') {
      // One edit per entry, so its title and excerpt change together.
      const { collectionId, entryId, field } = f.entry!;
      const k = JSON.stringify([collectionId, entryId]);
      const edit = entryEdits.get(k) ?? { collectionId, entryId, value: {} };
      edit.value[field] = next.value as string;
      entryEdits.set(k, edit);
    } else if (!s) continue;
    else if (s.kind === 'node') operations.push({ type: 'node.setContent', owner, nodeId: f.nodeId, field: s.field, value: next.value });
    // One field of an object property is replaced alone; the object's other fields stay as they are.
    else if (!s.itemId || !s.field) operations.push({ type: 'instance.setProp', owner, nodeId: f.nodeId, prop: s.prop, ...(!s.itemId && s.field !== undefined ? { field: s.field } : {}), value: next.value });
    else {
      const k = JSON.stringify([owner.kind, owner.id, f.nodeId, s.prop, s.itemId]);
      const patch = patches.get(k) ?? { owner, nodeId: f.nodeId, prop: s.prop, itemId: s.itemId, value: {} };
      patch.value[s.field] = next.value;
      patches.set(k, patch);
    }
  }
  for (const p of patches.values()) {
    const inst = treeOf(state, p.owner)?.nodes[p.nodeId];
    const def = inst?.kind === 'instance' ? own(state.components, inst.definitionId) : undefined;
    // An address shown as text carries its link along when edited alone; here the link moves only if chosen.
    for (const pair of def ? itemLinkPairs(def, p.prop) : []) {
      if (Object.hasOwn(p.value, pair.text) && !Object.hasOwn(p.value, pair.link)) {
        const link = itemValue(state, p.owner, p.nodeId, p.prop, p.itemId, pair.link);
        if (link !== undefined) p.value[pair.link] = structuredClone(link);
      }
    }
    operations.push({ type: 'instance.setProp', owner: p.owner, nodeId: p.nodeId, prop: p.prop, itemId: p.itemId, value: p.value });
  }
  for (const e of entryEdits.values()) {
    const entry = own(state.collections ?? {}, e.collectionId)?.entries[e.entryId];
    const name = `“${clipped(entry?.title ?? 'the entry')}”`;
    // As the entry edit stores them: trimmed, and an excerpt left empty removed.
    const edit: { title?: string; excerpt?: string | null } = {};
    if (e.value.title !== undefined) {
      const title = e.value.title.trim();
      if (!title) return { operations: [], changes: [], error: `Replacing would leave ${name} without a title. Use other words, or leave that match out.`, skipped };
      if (title.length > ENTRY_TITLE_MAX) return { operations: [], changes: [], error: `Replacing would make the title of ${name} longer than ${ENTRY_TITLE_MAX} characters. Use shorter words, or leave that match out.`, skipped };
      if (title !== entry?.title) edit.title = title;
    }
    if (e.value.excerpt !== undefined) {
      const excerpt = e.value.excerpt.trim();
      if (excerpt.length > ENTRY_EXCERPT_MAX) return { operations: [], changes: [], error: `Replacing would make the excerpt of ${name} longer than ${ENTRY_EXCERPT_MAX} characters. Use shorter words, or leave that match out.`, skipped };
      if (excerpt !== (entry?.excerpt ?? '')) edit.excerpt = excerpt || null;
    }
    // A field that reads as it is stored already changes nothing, and is not listed as a change.
    for (const field of ['title', 'excerpt'] as const) {
      if (Object.hasOwn(e.value, field) && !Object.hasOwn(edit, field)) {
        const key = JSON.stringify(['entry', e.collectionId, e.entryId, 'text', field]);
        planned.delete(key);
        for (let i = changes.length - 1; i >= 0; i--) if (changes[i].field.key === key) changes.splice(i, 1);
      }
    }
    if (Object.keys(edit).length) operations.push({ type: 'entry.update', collectionId: e.collectionId, entryId: e.entryId, ...edit });
  }
  if (!operations.length) return { operations, changes, skipped };
  // Checked as the project checks an edit it is sent (a title's length, say), which a dry run alone does not.
  const checked: EditOperation[] = [];
  for (const op of operations) {
    const v = validateOperation(op);
    if (!v.ok) return { operations: [], changes, error: v.message, skipped };
    checked.push(v.op);
  }
  let after: ProjectState;
  try {
    after = applyOperations(state, checked).state;
  } catch (e) {
    return { operations: [], changes, error: plainError(e), skipped };
  }
  const was = shownBy(state, contentFields(state));
  const now = shownBy(after, contentFields(after));
  // The chosen changes as the project stores and shows them: a field the edit hides is no longer shown, and one the
  // project reads back as it was (after tidying it) is not a change.
  const reviewed = changes.flatMap((c): ContentChange[] => {
    const b = now.get(c.field.key);
    if (c.field.rich) return [b ? c : { ...c, after: c.kind === 'link' ? 'No link' : 'Not shown' }];
    if (b && JSON.stringify(b.field.value) === JSON.stringify(c.field.value)) return [];
    const after = c.kind === 'link' ? (b?.links[0] ?? 'No link') : b ? b.text : 'Not shown';
    // Spaces a page collapses still change what is stored: say so rather than show two equal lines.
    return [{ ...c, after: after === c.before ? `${after} (spacing changed)` : after }];
  });
  // Anything else the edits change: a field that shows or hides with them, or a link the project moves itself.
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if (planned.has(key)) continue;
    const a = was.get(key);
    const b = now.get(key);
    const field = (b ?? a)!.field;
    if ((a?.text ?? '') !== (b?.text ?? '')) reviewed.push({ field, kind: 'text', before: a ? a.text : 'Not shown', after: b ? b.text : 'Not shown', knockOn: true });
    if (JSON.stringify(a?.links ?? []) !== JSON.stringify(b?.links ?? [])) reviewed.push({ field, kind: 'link', before: a?.links.join(', ') || 'No link', after: b?.links.join(', ') || 'No link', knockOn: true });
  }
  return { operations, changes: reviewed, skipped };
}

// ---------------------------------------------------------------------------
// Opening a match
// ---------------------------------------------------------------------------

export interface ContentTarget {
  /** The page to show: the field's own, or for the header and footer one that shows them. */
  pageId: string;
  selection: ElementRef;
  /** The inspector's Content section for that selection, opened so the field is there to focus. */
  section: 'prim-content' | 'part-content' | 'content';
  /** The field to focus there, by its anchor (`data-field`): a node's text, label or link, or a property. */
  focus?: string;
  /** A field of the selected placement's list to open in the inspector (the selection alone does not show it). */
  reveal?: { prop: string; itemId?: string; field?: string };
}

/**
 * Where a field opens in the inspector: its own element, the part of a section that shows it (for one list item),
 * or the section with that field opened. Null when the field is no longer in the project.
 */
export function contentTarget(state: ProjectState, field: ContentField, currentPageId: string | null): ContentTarget | null {
  // An entry's title and excerpt open in the post writer instead (see entryTarget).
  if (field.owner.kind === 'entry') return null;
  const pageId = field.owner.kind === 'page' ? (own(state.pages, field.owner.id) ? field.owner.id : undefined) : pageShowing(state, field.owner.id, currentPageId);
  const tree = treeOf(state, field.owner);
  const node: GraphNode | undefined = tree && own(tree.nodes, field.nodeId);
  if (!pageId || !node) return null;
  const s = field.source;
  const selection: ElementRef = { owner: field.owner, instancePath: [], nodeId: field.nodeId };
  if (s?.kind === 'node' || node.kind !== 'instance') return { pageId, selection, section: 'prim-content', ...(s?.kind === 'node' ? { focus: s.field } : {}) };
  // A part of a section placed here shows its own content in the inspector (for the one list item it was found in).
  const def = own(state.components, node.definitionId);
  if (field.direct && field.defNodeId && def?.tree && own(def.tree.nodes, field.defNodeId)) {
    const part: ElementRef = { owner: field.owner, instancePath: [node.id], nodeId: field.defNodeId };
    const partId = partIdFor(def, field.defNodeId);
    if (partId) part.partId = partId;
    if (field.itemPath?.length) part.itemPath = field.itemPath;
    // The part shows a list item's field by the field's name, a property by its own.
    const focus = s?.kind === 'prop' ? (s.itemId ? s.field : s.prop) : undefined;
    return { pageId, selection: part, section: 'part-content', ...(focus ? { focus } : {}) };
  }
  if (!s) return { pageId, selection, section: 'content' };
  if (!s.itemId) return { pageId, selection, section: 'content', focus: s.prop };
  return { pageId, selection, section: 'content', reveal: { prop: s.prop, itemId: s.itemId, ...(s.field ? { field: s.field } : {}) } };
}

/** Where an entry's title or excerpt opens: the entry in the writer, at that field. Null when the entry has gone. */
export function entryTarget(state: ProjectState, field: ContentField): { collectionId: string; entryId: string; field: 'title' | 'excerpt' } | null {
  const e = field.entry;
  if (!e) return null;
  const c = own(state.collections ?? {}, e.collectionId);
  return c && own(c.entries, e.entryId) ? { collectionId: e.collectionId, entryId: e.entryId, field: e.field } : null;
}

// ---------------------------------------------------------------------------
// Sections already on the site
// ---------------------------------------------------------------------------

export interface PlacedSection {
  label: string;
  /** Words a search for it can use: its own name and its component's. */
  terms: string;
  pageId: string | null;
  ref: ElementRef;
}

/**
 * The sections already on the site, by page: each page's top-level sections and the components placed anywhere in
 * it, then the shared header and footer. A search for a component's name finds where it is placed.
 */
export function placedSections(state: ProjectState): PlacedSection[] {
  const out: PlacedSection[] = [];
  const add = (owner: OwnerRef, tree: NodeTree, pageId: string | null, where: string) => {
    const seen = new Set<string>();
    const visit = (id: string, top: boolean) => {
      const n = own(tree.nodes, id);
      if (!n || seen.has(id)) return;
      seen.add(id);
      if (top || n.kind === 'instance') {
        const def = n.kind === 'instance' ? own(state.components, n.definitionId) : undefined;
        const name = displayName(state, n);
        out.push({ label: `${name} · ${where}`, terms: [name, def?.name ?? '', where].join(' '), pageId, ref: { owner, instancePath: [], nodeId: id } });
      }
      for (const cl of childLists(n)) for (const c of cl.ids) visit(c, false);
    };
    for (const id of tree.rootIds) visit(id, true);
  };
  for (const id of state.site.pageOrder) if (own(state.pages, id)) add({ kind: 'page', id }, state.pages[id], id, state.pages[id].title);
  if (pagesShowing(state, 'header').length) add({ kind: 'shell', id: 'header' }, state.site.shell.header, null, 'Header');
  if (pagesShowing(state, 'footer').length) add({ kind: 'shell', id: 'footer' }, state.site.shell.footer, null, 'Footer');
  return out;
}

/** Whether every word of a search appears in a section's terms. */
export function sectionMatches(s: PlacedSection, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const terms = s.terms.toLowerCase();
  return words.length > 0 && words.every((w) => terms.includes(w));
}
