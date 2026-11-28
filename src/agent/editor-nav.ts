import type { Collection, ElementRef, EntryDoc, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { childLists, displayName } from '@engine/tree';
import { entryRoute, findEntry } from '@shared/collections';
import { pageShowing } from '@shared/page-shell';
import { normalizeRoute } from '@shared/routes';

/**
 * Going somewhere in the editor from Chat (#1357, #1406): the words that ask for it, and finding what was asked for.
 * Nothing here changes the site.
 */

// "Open" is going somewhere, but not a link that opens in a new tab or on a click; "show" and "display" are going
// there when they are "show me", or say a page within a few words ("show the About page", never "show the phone
// number on the Contact page").
export const GO_TO =
  /\b(?:take|bring|get)\s+me\b|\b(?:go|navigate|jump|switch|head|move|skip|return)\s+(?:back\s+|over\s+|straight\s+)?(?:to|into)\b|\bgo\s+(?:back\s+)?home\b|\bopen\b(?!\s+(?:in\s+(?:a\s+)?new|a\s+new|on\s+(?:a\s+)?(?:click|hover|tap))\b)|\bshow\s+me\b|\b(?:show|display)\s+(?:the\s+)?(?:[\p{L}\p{N}/'’-]+\s+){0,2}?page\b|\b(?:view|visit)\b|\b(?:bring|pull)\s+up\b/iu;

/** Folded for comparing, ignoring case; anything not text (a damaged document's) is nothing. */
const fold = (v: unknown) => (typeof v === 'string' ? v.normalize('NFKC').trim().toLowerCase() : '');

/**
 * Whether `text` names `name` as a whole word or phrase (ignoring case). One Latin letter is a word of the request
 * ("a"), never a name in it; a name in another script is found wherever it is, as those are not written with spaces.
 */
export function namedIn(text: string): (name: unknown) => boolean {
  const words = fold(text);
  return (raw) => {
    const n = fold(raw);
    if (!n || !words.includes(n)) return false;
    if (!/^[\p{Script=Latin}\p{N}\s\p{P}]+$/u.test(n)) return true;
    if (n.length < 2) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(words);
  };
}

/** The editor's views by the names the author calls them (the rail's, the toolbar's and the dialogs' own words). */
const VIEW_NAMES =
  /\b(?:site\s+styles?|styles\s+panel|theme\s+settings|seo(?:\s+(?:view|panel|mode))?|search\s+(?:&|and)\s+sharing|content\s+(?:panel|tab|list)|pages\s+(?:panel|list|tab)|layers?(?:\s+panel)?|outline|assets?(?:\s+(?:panel|library))?|media\s+library|image\s+library|settings|preferences|project\s+health|health\s+check|history|versions?(?:\s+(?:list|panel|tab))?|saved\s+versions|project\s+brief|brief|export(?:\s+(?:dialog|panel|window))?|share(?:\s+(?:menu|popover|panel|button))?|live\s+session)\b/iu;
/** "Export my website" and "share this site" are asking for those dialogs, without a word for opening one. */
const EXPORT_OR_SHARE = /\b(?:export|publish|download)\s+(?:my|the|this|our)\s+(?:web\s*)?site\b|\bshare\s+(?:my|the|this|our)\s+(?:web\s*)?(?:site|project)\b|\bstart\s+a\s+live\s+session\b/iu;
/** A question about how to do something asks for directions, not to be taken there. */
const HOW_TO = /^\s*(?:how|where)\s+(?:do|can|would|should|could)\s+(?:i|we|you)\b/iu;
/** Words for a placed section, and for being brought to one ("scroll to the testimonials", "select the hero section"). */
const SECTION_WORDS = /\bsections?\b/iu;
const SECTION_VERBS = /\b(?:scroll|jump|skip)\s+(?:down\s+|up\s+|back\s+)?to\b|\b(?:select|highlight|focus\s+on|find)\b/iu;
/** A request that starts by asking to be brought to something ("Select Testimonials", "Scroll to pricing"). */
const LEADING_NAV = /^\s*(?:please\s+)?(?:select|highlight|scroll\s+(?:down\s+|up\s+|back\s+)?to|jump\s+to)\b/iu;
/** What a link or button does for visitors ("make the footer link scroll to Pricing") is an edit, not going there. */
const VISITOR_BEHAVIOUR = /\b(?:links?|buttons?|anchors?|menu\s+items?|ctas?|clicks?|visitors?)\b/iu;
/** "show Site styles" and "display the SEO view": a view named right after showing it. */
const SHOW_VIEW = new RegExp(`\\b(?:show|display)\\s+(?:me\\s+)?(?:the\\s+)?${VIEW_NAMES.source}(?=\\s*(?:$|[.,!?;:]|(?:and|then|please|now|too)\\b))`, 'iu');
/** An edit that says what something does for visitors: "make the button jump to the contact section". */
const EDIT_LEAD = /^\s*(?:please\s+)?(?:make|set|change|add|let|have|link|point)\b/iu;
/** An entry named by its ID. */
const ENTRY_ID = /\ben_[a-z0-9]{4,32}\b/u;
/** Words for an entry, when its collection is not named ("open the blog post about pricing"). */
const ENTRY_WORDS = /\b(?:posts?|blog\s+posts?|articles?|entr(?:y|ies)|collections?|content)\b/iu;

/**
 * Whether a request typed into the chat asks to open an entry, a section or one of the editor's views (#1406): a word
 * for going there with one of them named, a section asked to be scrolled to or selected, or Export or Share asked for.
 */
export function asksToOpenInEditor(text: string, state?: ProjectState): boolean {
  if (HOW_TO.test(text)) return false;
  if (EXPORT_OR_SHARE.test(text) || LEADING_NAV.test(text) || SHOW_VIEW.test(text)) return true;
  const visitorEdit = EDIT_LEAD.test(text) && VISITOR_BEHAVIOUR.test(text);
  if (!visitorEdit && ((SECTION_VERBS.test(text) && SECTION_WORDS.test(text)) || /\b(?:scroll|jump)\s+(?:down\s+|up\s+|back\s+)?to\b/iu.test(text))) return true;
  if (!GO_TO.test(text)) return false;
  if (VIEW_NAMES.test(text) || ENTRY_WORDS.test(text) || (!visitorEdit && SECTION_WORDS.test(text)) || ENTRY_ID.test(text)) return true;
  const named = namedIn(text);
  for (const c of Object.values(state?.collections ?? {})) {
    if (!c?.settings) continue;
    if (named(c.settings.name) || named(c.settings.singularName)) return true;
    for (const e of Object.values(c.entries ?? {})) if (named(e?.title)) return true;
  }
  return false;
}

/**
 * Whether a request asks to save a version of the site (#1406): "save a version called …", "take a snapshot". A version
 * of one part of the site ("make a version of the hero in blue") is an edit, not a saved version.
 */
export function asksToSaveVersion(text: string): boolean {
  if (HOW_TO.test(text)) return false;
  // A snapshot is always the site's; a version is when it is saved or kept ("save a version"), or named as the site's
  // ("create a version of the website"). Making a version of something else ("a mobile version") is an edit.
  // "Of" something other than the site is a copy of that part ("a backup of the hero"), never a saved version.
  const site = String.raw`(?:(?=\s+of\s+(?:the\s+|my\s+|this\s+|our\s+)?(?:whole\s+|entire\s+)?(?:web\s*)?(?:site|project)\b)|(?!\s+of\b))`;
  return (
    new RegExp(String.raw`\b(?:save|create|take|make|keep|add)\b[^.?!\n]{0,40}?\b(?:snapshots?|checkpoints?|restore\s+points?|backups?)\b` + site, 'iu').test(text) ||
    new RegExp(String.raw`\b(?:save|keep|take)\b[^.?!\n]{0,40}?\bversions?\b` + site, 'iu').test(text) ||
    // Made, a version is the site's when nothing describes it ("create a version called Launch", never "a mobile version").
    new RegExp(String.raw`\b(?:create|make|add)\s+(?:(?:a|an|another|one)\s+)?(?:new\s+)?versions?\b` + site, 'iu').test(text)
  );
}

/** "On this page", "here": a section the author asks for is on the page they are on, and only there (#1406). */
export function asksForThisPage(text: string): boolean {
  return /\b(?:this|the\s+current|my\s+current)\s+page\b|\bon\s+here\b|\bhere\s*[.?!]?\s*$/iu.test(text);
}

type Found<T> = { ok: true; value: T } | { ok: false; message: string };

const list = <T>(items: T[], label: (t: T) => string, max = 20) => items.slice(0, max).map(label).join(', ') + (items.length > max ? `, and ${items.length - max} more` : '');

/** A collection named by its ID, its name or what one entry is called, ignoring case. */
function collectionsNamed(state: ProjectState, ref: string): Collection[] {
  const wanted = fold(ref);
  const all = Object.values(state.collections ?? {}).filter((c) => !!c?.settings);
  const exact = all.filter((c) => c.settings.id === ref);
  if (exact.length) return exact;
  return all.filter((c) => [c.settings.id, c.settings.name, c.settings.singularName].some((n) => fold(n) !== '' && fold(n) === wanted));
}

/**
 * The entry the author named to open: by its ID, by its address when it is written as one, by its title (ignoring
 * case), and last by its slug. `collection` narrows it to one collection. A title more than one entry has names none
 * of them: the model is told each, with its collection and address, to ask which.
 */
export function findEntryToOpen(state: ProjectState, ref: string, collection?: string): Found<{ collectionId: string; entryId: string }> {
  const collections = Object.values(state.collections ?? {}).filter((c) => !!c?.settings);
  if (!collections.length) return { ok: false, message: 'This site has no collections, so it has no entries to open. Nothing was opened: tell the author so.' };
  const within = collection ? collectionsNamed(state, collection) : collections;
  if (collection && !within.length) return { ok: false, message: `No collection is called "${collection.trim()}". The site's collections are ${list(collections, (c) => `"${c.settings.name}" (${c.settings.id})`)}. Nothing was opened.` };
  const found = findEntry(state, ref);
  if (found && within.includes(found.collection)) return { ok: true, value: { collectionId: found.collection.settings.id, entryId: found.entry.id } };
  const entries = within.flatMap((c) => Object.values(c.entries ?? {}).filter((e): e is EntryDoc => !!e && typeof e === 'object').map((entry) => ({ c, entry })));
  const wanted = fold(ref);
  const pick = (hits: typeof entries) => (hits.length === 1 ? { ok: true as const, value: { collectionId: hits[0].c.settings.id, entryId: hits[0].entry.id } } : null);
  const describe = (h: (typeof entries)[number]) => {
    const route = entryRoute(h.c, h.entry);
    return `"${h.entry.title}" in ${h.c.settings.name} (${route ?? h.entry.id})`;
  };
  if (ref.includes('/')) {
    const route = normalizeRoute(ref);
    const hit = pick(entries.filter((h) => entryRoute(h.c, h.entry) === route));
    if (hit) return hit;
  }
  const several = (hits: typeof entries, what: string) => ({ ok: false as const, message: `More than one entry has the ${what} "${ref.trim()}": ${list(hits, describe)}. Nothing was opened. Ask the author which one they meant, then open it by its ID.` });
  const titled = entries.filter((h) => fold(h.entry.title) === wanted);
  if (titled.length > 1) return several(titled, 'title');
  const slugged = titled.length ? [] : entries.filter((h) => fold(h.entry.slug) === wanted);
  if (slugged.length > 1) return several(slugged, 'slug');
  const hit = pick(titled) ?? pick(slugged);
  if (hit) return hit;
  const where = collection ? `in ${within.map((c) => c.settings.name).join(', ')}` : 'in any collection';
  return { ok: false, message: `No entry ${where} has the ID, address, title or slug "${ref.trim()}". Nothing was opened. Tell the author so; list_collection_entries lists what each collection has.` };
}

interface PlacedSection {
  ref: ElementRef;
  /** The page it opens on. */
  pageId: string;
  name: string;
  component: string;
  where: string;
}

/** The sections placed on `pageId` (its own, and the header and footer when it shows them), as the command menu lists them. */
function sectionsOn(state: ProjectState, pageId: string): PlacedSection[] {
  const out: PlacedSection[] = [];
  const add = (owner: OwnerRef, tree: NodeTree, where: string) => {
    const seen = new Set<string>();
    const visit = (id: string, top: boolean) => {
      const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
      if (!n || seen.has(id)) return;
      seen.add(id);
      if (top || n.kind === 'instance') {
        const component = n.kind === 'instance' ? (state.components[n.definitionId]?.name ?? '') : '';
        out.push({ ref: { owner, instancePath: [], nodeId: id }, pageId, name: displayName(state, n), component, where });
      }
      for (const cl of childLists(n)) for (const c of cl.ids) visit(c, false);
    };
    for (const id of tree.rootIds) visit(id, true);
  };
  const page = state.pages[pageId];
  if (!page) return out;
  add({ kind: 'page', id: pageId }, page, `the ${page.title} page`);
  for (const part of ['header', 'footer'] as const) if (pageShowing(state, part, pageId) === pageId) add({ kind: 'shell', id: part }, state.site.shell[part], `the ${part}`);
  return out;
}

/**
 * The placed section the author named to go to (#1406): by its node ID, by its name or its component's name (ignoring
 * case, and a trailing "section"), then by every word of what was named. Looked for on `page` when the model names
 * one, else on the page the author was on and, when that has none (and they did not ask for that page alone,
 * `onlyShown`), on every page (header and footer on the first page that shows them). Several that fit name none of them: the model is told each, with where it is, to ask which.
 */
export function findSectionToOpen(state: ProjectState, ref: string, shownPageId: string, page?: { pageId: string }, onlyShown = false): Found<{ pageId: string; ref: ElementRef }> {
  const order = (state.site.pageOrder ?? []).filter((id) => Object.hasOwn(state.pages, id));
  const shown = Object.hasOwn(state.pages, shownPageId) ? shownPageId : state.site.homePageId;
  const wanted = fold(ref)
    .replace(/^the\s+/, '')
    .replace(/\s+section$/, '');
  const match = (all: PlacedSection[]) => {
    const byId = all.filter((s) => s.ref.nodeId === ref.trim());
    if (byId.length) return byId.slice(0, 1);
    const exact = all.filter((s) => fold(s.name) === wanted || (s.component && fold(s.component) === wanted));
    if (exact.length) return exact;
    const words = wanted.split(/\s+/).filter(Boolean);
    // A shared part is also known by where it is ("footer contact links"); a page's own, never by its page's title.
    return words.length ? all.filter((s) => words.every((w) => `${fold(s.name)} ${fold(s.component)} ${s.ref.owner.kind === 'shell' ? fold(s.where) : ''}`.includes(w))) : [];
  };
  const pick = (hits: PlacedSection[]): Found<{ pageId: string; ref: ElementRef }> | null => {
    // The header or footer found on several pages is one section: it opens on the first of them.
    const one = hits.filter((h, i) => hits.findIndex((o) => o.ref.owner.kind === h.ref.owner.kind && o.ref.owner.id === h.ref.owner.id && o.ref.nodeId === h.ref.nodeId) === i);
    if (one.length === 1) return { ok: true, value: { pageId: one[0].pageId, ref: one[0].ref } };
    if (one.length > 1) return { ok: false, message: `More than one section fits "${ref.trim()}": ${list(one, (s) => `"${s.name}" (${s.ref.nodeId}) on ${s.where}`)}. Nothing was opened. Ask the author which one they meant, then open it by its ID.` };
    return null;
  };
  if (page) {
    const all = sectionsOn(state, page.pageId);
    return pick(match(all)) ?? { ok: false, message: `No section on ${state.pages[page.pageId]?.title ?? 'that'} page fits "${ref.trim()}". Its sections are ${list(all, (s) => `"${s.name}" (${s.ref.nodeId})`)}. Nothing was opened.` };
  }
  const here = sectionsOn(state, shown);
  const local = pick(match(here));
  if (local) return local;
  // Asked for on this page: one elsewhere is not what was asked for.
  if (onlyShown) return { ok: false, message: `No section on the page the author is on, ${state.pages[shown]?.title ?? 'Home'}, fits "${ref.trim()}". Its sections are ${list(here, (s) => `"${s.name}" (${s.ref.nodeId})`) || 'none'}. Nothing was opened: tell the author so.` };
  const everywhere = pick(match(order.flatMap((id) => sectionsOn(state, id))));
  if (everywhere) return everywhere;
  return { ok: false, message: `No section in the site fits "${ref.trim()}". The page the author is on, ${state.pages[shown]?.title ?? 'Home'}, has ${list(here, (s) => `"${s.name}" (${s.ref.nodeId})`) || 'no sections'}. Nothing was opened: tell the author so.` };
}
