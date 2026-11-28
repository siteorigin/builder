/**
 * The site's business details where its sections show them (#1368): the email address, telephone number, street
 * address and opening hours Site details keeps for the publisher (`SiteDoc.identity`), which search engines read from
 * the pages' structured data. A text or a link that shows one of them, or still shows the catalogue's sample for it
 * (shared/sample-contact.ts), follows the site's: changing the detail in Site details changes it there too, on every
 * page, in the shared header and footer, in the collections' layouts and in the project's own designs. A text or link
 * that shows anything else is the author's own and is kept.
 *
 * What a place shows decides, as for the site's name (shared/site-name.ts), so an edit made anywhere, by hand or by
 * the AI, gives a place its own value simply by showing another one. The one case the text cannot tell is a value of
 * the author's own that a change of the site's detail makes equal to it (a "press" address the site's email then
 * becomes): the placement keeps it through later changes (`InstanceNode.keepsText`, as `detail:` and its field)
 * until the author edits that property. Clearing a detail changes nothing on the pages: each place keeps what it
 * shows, as its own from then on. A contact form's settings, submission keys and placeholders are never touched.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, LinkValue, ListItem, NodeTree, OwnerRef, ProjectState, PropSchema, SiteDoc } from '@shared/types';
import { openingHoursText, sitePublisher } from '@shared/site-identity';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { dialString } from '@shared/contact-links';
import { siteLanguage } from '@shared/languages';
import { isFormContract } from '@shared/form-contract';
import { allTrees, displayName } from './tree';
import { clone } from './install';
import { DEFAULT_TEXT_MAX } from './values';

export type BusinessDetail = 'email' | 'telephone' | 'address' | 'openingHours';
export const BUSINESS_DETAILS: readonly BusinessDetail[] = ['email', 'telephone', 'address', 'openingHours'];

/** How each detail is named in what the editor says. */
export const DETAIL_NAMES: Record<BusinessDetail, string> = { email: 'email address', telephone: 'telephone number', address: 'address', openingHours: 'opening hours' };

/** What the catalogue's sections show for each detail until the site has its own. */
const SAMPLES: Record<BusinessDetail, string> = { email: SAMPLE_CONTACT.email, telephone: SAMPLE_CONTACT.phone, address: SAMPLE_CONTACT.address, openingHours: SAMPLE_CONTACT.hours };

type Texts = Partial<Record<BusinessDetail, string>>;

/** Each detail the site has, as its sections show it: the hours written out in the site's language. */
export function detailTexts(site: SiteDoc): Texts {
  const p = sitePublisher(site, () => true);
  const out: Texts = {};
  if (p.email) out.email = p.email;
  if (p.telephone) out.telephone = p.telephone;
  if (p.address) out.address = p.address;
  const hours = p.openingHours.length ? openingHoursText(p.openingHours, siteLanguage(site)) : '';
  if (hours) out.openingHours = hours;
  return out;
}

/** Text on one line, as a field shows it. */
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
const squash = (t: string) => oneLine(t).toLowerCase();
/** A number written on its own: digits with a leading +, spaces, brackets, dots, hyphens or slashes. */
const PHONE_TEXT = /^\+?[\d\s().\-/    ‐‑]+$/;
/** The number a telephone text or link dials, or '' when it dials none. */
const dials = (t: string) => {
  const d = dialString(t);
  return /\d/.test(d) ? d : '';
};

/** Whether a text shows `value` as the detail: the same address or hours, however spaced or cased, or the number it dials. */
function says(detail: BusinessDetail, text: string, value: string): boolean {
  if (detail === 'telephone') return PHONE_TEXT.test(text.trim()) && !!dials(text) && dials(text) === dials(value);
  return !!squash(value) && squash(text) === squash(value);
}

/** Whether a link opens `value`: an email link to that one address (whatever it adds after it), or a call to that number. */
function opens(detail: BusinessDetail, link: LinkValue, value: string): boolean {
  if (detail === 'email') return link.type === 'email' && link.target.split('?')[0].trim().toLowerCase() === value.trim().toLowerCase();
  if (detail === 'telephone') return link.type === 'tel' && !!dials(link.target) && dials(link.target) === dials(value);
  return false;
}

/** The link that opens `value` instead, keeping what the link adds: an email's ?subject=, its options. Null when no link can. */
function relinked(detail: BusinessDetail, link: LinkValue, value: string): LinkValue | null {
  if (detail === 'email') {
    const q = link.target.indexOf('?');
    return { ...link, target: value + (q < 0 ? '' : link.target.slice(q)) };
  }
  const target = dials(value);
  return target ? { ...link, target } : null;
}

const isLink = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && typeof (v as LinkValue).target === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether `value`, a text or a link, shows `detail` as `as`. */
function shows(detail: BusinessDetail, kind: 'text' | 'link', value: unknown, as: string): boolean {
  return kind === 'text' ? typeof value === 'string' && says(detail, value, as) : isLink(value) && opens(detail, value, as);
}

/** Only an email address and a telephone number have links that open them. */
const linkable = (detail: BusinessDetail) => detail === 'email' || detail === 'telephone';

/** One detail changing: the values that follow it (the site's old value, the sample) and what they show next. */
export interface DetailSwap {
  detail: BusinessDetail;
  from: string[];
  to: string;
  /** Whether a value of the author's own that already shows `to` keeps it from now on: the site had another one before. */
  keepOwn: boolean;
}

/** One place that shows a detail: a text or a link, at a property, an object's field or a list item's field. */
export interface DetailPlace {
  owner: OwnerRef;
  /** Where it is: "Footer", or the page's title. */
  where: string;
  node: GraphNode;
  /** The placement's property, or a primitive's own field (`text`, `label`, `link`). */
  prop: string;
  itemId?: string;
  field?: string;
  detail: BusinessDetail;
  kind: 'text' | 'link';
  /** What it shows: the site's own value, or the catalogue's sample. */
  shows: 'site' | 'sample';
  /** A value of the author's own that is the site's too for now, kept when the site's changes. */
  kept?: boolean;
}

/** One text or link a node shows, as the walk finds it. */
interface Spot {
  /** Its name among the placement's kept values. */
  key: string;
  prop: string;
  itemId?: string;
  field?: string;
  kind: 'text' | 'link';
  value: unknown;
  /** The most characters it holds. */
  max: number;
  label: string;
}

/** A node's new value for one property, worked out on a copy and written only when the whole change can be made. */
interface Write {
  owner: OwnerRef;
  node: GraphNode;
  prop: string;
  value: unknown;
}

const KEEP = 'detail:';

/** The detail values a placement keeps through changes of the site's details. */
const keptOf = (node: GraphNode): Set<string> => new Set(node.kind === 'instance' && Array.isArray(node.keepsText) ? node.keepsText.filter((k): k is string => typeof k === 'string' && k.startsWith(KEEP)) : []);

/** Sets which detail values a placement keeps, leaving what it keeps through renames of the site (shared/site-name.ts). */
function setKept(node: InstanceNode, keys: Set<string>) {
  const others = Array.isArray(node.keepsText) ? node.keepsText.filter((k) => typeof k === 'string' && !k.startsWith(KEEP)) : [];
  const list = [...others, ...[...keys].sort()];
  if (list.length) node.keepsText = list;
  else delete node.keepsText;
}

/** An edit of a property makes its values the author's choice again: each follows the site's details if it shows them. */
export function releaseDetailKeeps(node: InstanceNode, prop: string): void {
  const kept = keptOf(node);
  const mine = [...kept].filter((k) => k === `${KEEP}${prop}` || k.startsWith(`${KEEP}${prop}.`) || k.startsWith(`${KEEP}${prop}[`));
  if (!mine.length) return;
  for (const k of mine) kept.delete(k);
  setKept(node, kept);
}

/** A text or link field, of a placement's property or of one of its objects or items. */
const textOrLink = (schema: PropSchema) => schema.type === 'string' || schema.type === 'link';
const maxOf = (schema: PropSchema) => (schema.type === 'string' ? (schema.maxLength ?? DEFAULT_TEXT_MAX) : Infinity);
const kindOf = (schema: PropSchema): 'text' | 'link' => (schema.type === 'link' ? 'link' : 'text');

/** A design whose settings are a form service's (an endpoint, an access key, a form name) and whose items are fields to fill in. */
const isForm = (def: ComponentDefinition) => isFormContract(def.componentId) || isFormContract(def.provenance?.componentId);

/**
 * Visits every plain text and link a node shows: a placement's own properties, its objects' fields and each list
 * item's fields, using the design's defaults for what it leaves out, or a primitive text's, link's or card's own.
 * `visit` returns the spot's new value, or undefined to leave it; the properties that change are returned with their
 * new values, each a copy, and nothing is written.
 */
function visitNode(state: ProjectState, owner: OwnerRef, node: GraphNode, visit: (spot: Spot) => unknown): Write[] {
  const writes: Write[] = [];
  const put = (prop: string, value: unknown) => writes.push({ owner, node, prop, value });
  if (node.kind === 'text') {
    if (!node.rich && typeof node.text === 'string') {
      const next = visit({ key: ':text', prop: 'text', kind: 'text', value: node.text, max: DEFAULT_TEXT_MAX, label: 'Text' });
      if (next !== undefined) put('text', next);
    }
    return writes;
  }
  if (node.kind === 'link' || node.kind === 'element') {
    if (node.kind === 'link' && typeof node.label === 'string') {
      const next = visit({ key: ':label', prop: 'label', kind: 'text', value: node.label, max: DEFAULT_TEXT_MAX, label: 'Label' });
      if (next !== undefined) put('label', next);
    }
    if (isLink(node.link)) {
      const next = visit({ key: ':link', prop: 'link', kind: 'link', value: node.link, max: Infinity, label: 'Link' });
      if (next !== undefined) put('link', next);
    }
    return writes;
  }
  if (node.kind !== 'instance') return writes;
  const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!def || isForm(def)) return writes;
  for (const [prop, schema] of Object.entries(def.properties)) {
    const own = Object.hasOwn(node.props, prop) ? node.props[prop] : undefined;
    if (textOrLink(schema)) {
      const next = visit({ key: prop, prop, kind: kindOf(schema), value: own === undefined ? schema.default : own, max: maxOf(schema), label: schema.label });
      if (next !== undefined) put(prop, next);
    } else if (schema.type === 'object') {
      // What the site build shows of each field: the placement's own, then the object's default, then the field's.
      const value = own === undefined ? schema.default : own;
      if (!isRecord(value)) continue;
      const base = isRecord(schema.default) ? schema.default : {};
      let copy: Record<string, unknown> | null = null;
      for (const [field, f] of Object.entries(schema.fields)) {
        if (!textOrLink(f)) continue;
        const shown = Object.hasOwn(value, field) ? value[field] : Object.hasOwn(base, field) ? base[field] : f.default;
        const next = visit({ key: `${prop}.${field}`, prop, field, kind: kindOf(f), value: shown, max: maxOf(f), label: `${schema.label} → ${f.label}` });
        if (next !== undefined) (copy ??= clone(value))[field] = next;
      }
      if (copy) put(prop, copy);
    } else if (schema.type === 'list' && !schema.feed && !Object.hasOwn(node.listSources ?? {}, prop)) {
      // A list the placement leaves to its design is copied as an edit of one of its items copies it: the items keep
      // the IDs the design gives them (see placedItemIndex), and so do their single-item styles.
      const items: ListItem[] | null = Array.isArray(own) ? (own as ListItem[]) : own === undefined && Array.isArray(schema.default) ? (schema.default as ListItem[]) : null;
      if (!items) continue;
      let copy: ListItem[] | null = null;
      items.forEach((item, i) => {
        if (!isRecord(item)) return;
        for (const [field, f] of Object.entries(schema.fields)) {
          if (!textOrLink(f)) continue;
          const next = visit({ key: `${prop}[${item.id}].${field}`, prop, itemId: item.id, field, kind: kindOf(f), value: Object.hasOwn(item, field) ? item[field] : f.default, max: maxOf(f), label: `${schema.label} → ${f.label}` });
          if (next === undefined) continue;
          copy ??= clone(items);
          copy[i][field] = next;
        }
      });
      if (copy) put(prop, copy);
    }
  }
  return writes;
}

/**
 * The trees whose nodes show the site's details to visitors: the pages, the shared header and footer, the
 * collections' layouts, and the project's own designs (a theme's designs are the theme's).
 */
function trees(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  return allTrees(state).filter((t) => t.owner.kind !== 'component' || state.components[t.owner.id]?.owner !== 'theme');
}

/** The nodes of the trees that show content (only `only`'s, when it is given), with where they are. */
function* nodesOf(state: ProjectState, only?: { owner: OwnerRef; node: GraphNode }): Generator<{ owner: OwnerRef; where: string; node: GraphNode }> {
  for (const { owner, tree, label } of trees(state)) {
    if (only && (only.owner.kind !== owner.kind || only.owner.id !== owner.id)) continue;
    for (const node of Object.values(tree.nodes)) if (node && (!only || node === only.node)) yield { owner, where: label, node };
  }
}

/** A planned change: the writes, and the detail values each placement keeps after it. */
interface Plan {
  writes: Write[];
  keeps: Array<{ node: InstanceNode; keys: Set<string> }>;
}

/** What a spot that follows `s` shows next, or undefined when it already does or no link can open it. */
function nextValue(s: DetailSwap, spot: Spot): unknown {
  if (spot.kind === 'text') return oneLine(String(spot.value)) === oneLine(s.to) ? undefined : s.to;
  if (shows(s.detail, 'link', spot.value, s.to)) return undefined;
  return relinked(s.detail, spot.value as LinkValue, s.to) ?? undefined;
}

/**
 * The writes that carry `swaps` into every node (or `only`), or why they cannot be made: a text that would grow past
 * what its field holds. Nothing is changed.
 */
function planSwaps(state: ProjectState, swaps: readonly DetailSwap[], only?: { owner: OwnerRef; node: GraphNode }): Plan | { problem: string } {
  const plan: Plan = { writes: [], keeps: [] };
  if (!swaps.length) return plan;
  for (const { owner, where, node } of nodesOf(state, only)) {
    const kept = keptOf(node);
    let keepsChanged = false;
    const refused: { problem?: string } = {};
    const writes = visitNode(state, owner, node, (spot) => {
      if (refused.problem) return undefined;
      const k = `${KEEP}${spot.key}`;
      for (const s of swaps) {
        if (spot.kind === 'link' && !linkable(s.detail)) continue;
        const follows = s.from.some((f) => shows(s.detail, spot.kind, spot.value, f));
        const already = shows(s.detail, spot.kind, spot.value, s.to);
        if (!follows && !already) continue;
        if (kept.delete(k)) {
          // Kept until now: it keeps its value, which differs from the site's from here on unless it still matches.
          keepsChanged = true;
          if (already) kept.add(k);
          return undefined;
        }
        if (!follows) {
          // A value of the author's own that the site's new one happens to match stays the author's.
          if (s.keepOwn && node.kind === 'instance') {
            kept.add(k);
            keepsChanged = true;
          }
          return undefined;
        }
        const next = nextValue(s, spot);
        if (typeof next === 'string' && next.length > spot.max) {
          const name = DETAIL_NAMES[s.detail];
          const def = node.kind === 'instance' ? state.components[node.definitionId] : undefined;
          const placed = owner.kind === 'shell' ? `The ${where.toLowerCase()}` : `${displayName(state, node, def)} in “${where}”`;
          refused.problem = `${placed} shows the site's ${name} in ${spot.label}, which holds at most ${spot.max} characters. Use a shorter ${name}, or give it its own text first.`;
          return undefined;
        }
        return next;
      }
      return undefined;
    });
    if (refused.problem) return { problem: refused.problem };
    plan.writes.push(...writes);
    if (node.kind === 'instance' && keepsChanged) plan.keeps.push({ node, keys: kept });
  }
  return plan;
}

function commit(plan: Plan): void {
  for (const w of plan.writes) {
    if (w.node.kind === 'instance') w.node.props[w.prop] = w.value;
    else (w.node as unknown as Record<string, unknown>)[w.prop] = w.value;
  }
  for (const { node, keys } of plan.keeps) setKept(node, keys);
}

/**
 * The swaps that take the site's details from `before` to `after`: each detail given a new value, from its old one and
 * the sample. With `samples`, a detail that stays as it was still replaces any sample left (a section pasted in).
 */
export function detailSwaps(before: Texts, after: Texts, samples = false): DetailSwap[] {
  const out: DetailSwap[] = [];
  for (const detail of BUSINESS_DETAILS) {
    const to = after[detail];
    // A detail cleared leaves the places that showed it as they are.
    if (!to) continue;
    const was = before[detail];
    if (to !== was) out.push({ detail, from: [was, SAMPLES[detail]].filter((v): v is string => !!v), to, keepOwn: !!was });
    else if (samples) out.push({ detail, from: [SAMPLES[detail]], to, keepOwn: false });
  }
  return out;
}

/**
 * Carries a change of the site's details from `before` into every place that showed the old value or the sample. With
 * `samples`, an edit of the details also replaces any sample still shown of one that did not change. Returns why it
 * cannot be carried, changing nothing, when a text would grow past what its field holds.
 */
export function carryBusinessDetails(state: ProjectState, before: Texts, samples = false): string | null {
  const plan = planSwaps(state, detailSwaps(before, detailTexts(state.site), samples));
  if ('problem' in plan) return plan.problem;
  commit(plan);
  return null;
}

/**
 * Where the site's details becoming `site`'s would change what visitors see: the trees whose texts or links change.
 * Empty when nothing shows a detail that changes, or when the change would be refused.
 */
export function changedDetailOwners(state: ProjectState, site: SiteDoc, samples = false): OwnerRef[] {
  const plan = planSwaps(state, detailSwaps(detailTexts(state.site), detailTexts(site), samples));
  if ('problem' in plan) return [];
  const seen = new Map<string, OwnerRef>();
  for (const w of plan.writes) seen.set(`${w.owner.kind}:${w.owner.id}`, w.owner);
  return [...seen.values()];
}

/**
 * A newly placed section shows the site's details where its design shows the samples, so a Contact section added
 * after Site details are filled in says the real ones from the start. Run before the values the placement is given:
 * those are its own. A section with a field too short for one keeps every sample, as the design gives them.
 */
export function fillBusinessDetails(state: ProjectState, owner: OwnerRef, node: InstanceNode): void {
  const site = detailTexts(state.site);
  const swaps = BUSINESS_DETAILS.filter((d) => site[d]).map((d): DetailSwap => ({ detail: d, from: [SAMPLES[d]], to: site[d]!, keepOwn: false }));
  if (!swaps.length) return;
  let fits = true;
  // Placed but not yet in its tree, so it is visited on its own.
  const writes = visitNode(state, owner, node, (spot) => {
    for (const s of swaps) {
      if (spot.kind === 'link' && !linkable(s.detail)) continue;
      if (!s.from.some((f) => shows(s.detail, spot.kind, spot.value, f))) continue;
      const next = nextValue(s, spot);
      if (typeof next === 'string' && next.length > spot.max) fits = false;
      return next;
    }
    return undefined;
  });
  if (fits) commit({ writes, keeps: [] });
}

/** Every place that shows one of the site's details or its sample (only in `only`, when it is given), in the trees' order. */
export function detailPlaces(state: ProjectState, only?: { owner: OwnerRef; node: GraphNode }): DetailPlace[] {
  const site = detailTexts(state.site);
  const out: DetailPlace[] = [];
  for (const { owner, where, node } of nodesOf(state, only)) {
    const kept = keptOf(node);
    visitNode(state, owner, node, (spot) => {
      for (const detail of BUSINESS_DETAILS) {
        if (spot.kind === 'link' && !linkable(detail)) continue;
        const as = site[detail] && shows(detail, spot.kind, spot.value, site[detail]!) ? 'site' : shows(detail, spot.kind, spot.value, SAMPLES[detail]) ? 'sample' : null;
        if (!as) continue;
        const own = as === 'site' && kept.has(`${KEEP}${spot.key}`);
        out.push({ owner, where, node, prop: spot.prop, detail, kind: spot.kind, shows: as, ...(own ? { kept: true } : {}), ...(spot.itemId !== undefined ? { itemId: spot.itemId } : {}), ...(spot.field !== undefined ? { field: spot.field } : {}) });
        break;
      }
      return undefined;
    });
  }
  return out;
}

/** "the footer and “Contact”": where places are, the shared parts first, then the rest by title. */
function whereList(places: readonly DetailPlace[]): string {
  const shared = [...new Set(places.filter((p) => p.owner.kind === 'shell').map((p) => `the ${p.where.toLowerCase()}`))];
  const others = new Map<string, string>();
  for (const p of places) if (p.owner.kind !== 'shell') others.set(`${p.owner.kind}:${p.owner.id}`, p.where);
  const titles = [...others.values()];
  const parts = [...shared, ...(titles.length > 3 ? [`${titles.length} more places`] : titles.map((t) => `“${t}”`))];
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const capitalized = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * What each Site details field says about where its detail shows: the places that follow it, those that keep a value
 * of their own that matches it, and, while the site has none, the samples it will replace.
 */
export function publisherDetailNotes(state: ProjectState): Partial<Record<BusinessDetail, string>> {
  const all = detailPlaces(state);
  const out: Partial<Record<BusinessDetail, string>> = {};
  for (const detail of BUSINESS_DETAILS) {
    const places = all.filter((p) => p.detail === detail);
    const following = places.filter((p) => p.shows === 'site' && !p.kept);
    const kept = places.filter((p) => p.kept);
    const samples = places.filter((p) => p.shows === 'sample');
    const lines: string[] = [];
    if (following.length) lines.push(`Shown in ${whereList(following)}, which change with it.`);
    else if (samples.length) lines.push(`Replaces the sample ${DETAIL_NAMES[detail]} in ${whereList(samples)}.`);
    if (following.length && samples.length) lines.push(`The sample is still in ${whereList(samples)}.`);
    if (kept.length) lines.push(`${capitalized(whereList(kept))} ${new Set(kept.map((p) => `${p.owner.kind}:${p.owner.id}`)).size === 1 ? 'keeps its' : 'keep their'} own, which stays when it changes.`);
    if (lines.length) out[detail] = lines.join(' ');
  }
  return out;
}

/** What the inspector says beside a field that shows one of the site's details, or its sample. */
export function placeNote(place: DetailPlace): string {
  const name = DETAIL_NAMES[place.detail];
  const what = place.kind === 'link' ? 'Opens' : 'Shows';
  const one = place.detail === 'openingHours' ? name : `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
  if (place.kept) return `${what} ${one} of its own, the same as the site's for now. Changing the site's in Site details leaves it.`;
  return place.shows === 'site' ? `${what} the site's ${name} from Site details, and changes with it.` : `${what} a sample ${name}. The site's ${name} in Site details replaces it.`;
}
