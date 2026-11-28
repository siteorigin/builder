/**
 * The site's business details where its sections show them (#1368): the email address, telephone number, street
 * address and opening hours Site details keeps for the publisher (`SiteDoc.identity`), which search engines read from
 * the pages' structured data. A text or a link that shows one of them, or still shows the catalogue's sample for it
 * (shared/sample-contact.ts), follows the site's: changing the detail in Site details changes it there too, on every
 * page and in the shared header and footer. A text or link that shows anything else is the author's own and is kept.
 *
 * What a place shows decides, as for the site's name (shared/site-name.ts), so an edit made anywhere, by hand or by
 * the AI, gives a place its own value simply by showing another one. Clearing a detail changes nothing on the pages:
 * each place keeps what it shows, as its own from then on.
 */
import type { ComponentDefinition, InstanceNode, LinkValue, ListItem, NodeTree, OwnerRef, ProjectState, PropSchema, SiteDoc } from '@shared/types';
import { openingHoursText, sitePublisher } from '@shared/site-identity';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { dialString } from '@shared/contact-links';
import { siteLanguage } from '@shared/languages';
import { allTrees, displayName } from './tree';
import { clone, placedDefaultItems } from './install';
import { DEFAULT_TEXT_MAX } from './values';

export type BusinessDetail = 'email' | 'telephone' | 'address' | 'openingHours';
export const BUSINESS_DETAILS: readonly BusinessDetail[] = ['email', 'telephone', 'address', 'openingHours'];

/** How each detail is named in what the editor says. */
export const DETAIL_NAMES: Record<BusinessDetail, string> = { email: 'email address', telephone: 'telephone number', address: 'address', openingHours: 'opening hours' };

/** What the catalogue's sections show for each detail until the site has its own. */
const SAMPLES: Record<BusinessDetail, string> = { email: SAMPLE_CONTACT.email, telephone: SAMPLE_CONTACT.phone, address: SAMPLE_CONTACT.address, openingHours: SAMPLE_CONTACT.hours };

/** Each detail the site has, as its sections show it: the hours written out in the site's language. */
export function detailTexts(site: SiteDoc): Partial<Record<BusinessDetail, string>> {
  const p = sitePublisher(site, () => true);
  const out: Partial<Record<BusinessDetail, string>> = {};
  if (p.email) out.email = p.email;
  if (p.telephone) out.telephone = p.telephone;
  if (p.address) out.address = p.address;
  const hours = p.openingHours.length ? openingHoursText(p.openingHours, siteLanguage(site)) : '';
  if (hours) out.openingHours = hours;
  return out;
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
/** A number written on its own: digits with a leading +, spaces, brackets, dots, hyphens or slashes. */
const PHONE_TEXT = /^\+?[\d\s().\-/    ‐‑]+$/;
/** The number a telephone text or link dials, or '' when it dials none. */
const dials = (t: string) => {
  const d = dialString(t);
  return /\d/.test(d) ? d : '';
};

/** Whether a text shows `value` as the detail: the same address or hours, however spaced, or the number it dials. */
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

/** One detail changing: the texts that show it now (the site's old value, the sample) and what they show next. */
export interface DetailSwap {
  detail: BusinessDetail;
  from: string[];
  to: string;
}

/** One place that shows a detail: a text or a link, at a property, an object's field or a list item's field. */
export interface DetailPlace {
  owner: OwnerRef;
  /** Where it is: "Footer", or the page's title. */
  where: string;
  node: InstanceNode;
  prop: string;
  itemId?: string;
  field?: string;
  detail: BusinessDetail;
  kind: 'text' | 'link';
  /** What it shows: the site's own value, or the catalogue's sample. */
  shows: 'site' | 'sample';
}

/** A property's new value, worked out on a copy and written only when the whole change can be made. */
interface Write {
  node: InstanceNode;
  prop: string;
  value: unknown;
}

/** The trees whose placements show the site's details to visitors: the pages, the shared header and footer, and the collections' layouts. */
function trees(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  return allTrees(state).filter((t) => t.owner.kind !== 'component');
}

/** A field's value, or its default when the item or object leaves it out. */
const fieldValue = (holder: Record<string, unknown>, key: string, schema: PropSchema) => (Object.hasOwn(holder, key) ? holder[key] : schema.default);

type Visit = (at: { prop: string; value: unknown; schema: PropSchema; itemId?: string; field?: string }) => unknown;

/**
 * Visits every plain text and link a placement shows: its own properties, an object's fields and each list item's
 * fields, using the design's defaults for what it leaves out. `visit` returns the field's new value, or undefined to
 * leave it; the properties that change are returned with their new values, each a copy, and nothing is written.
 */
function visitPlacement(owner: OwnerRef, node: InstanceNode, def: ComponentDefinition, visit: Visit): Write[] {
  const writes: Write[] = [];
  for (const [prop, schema] of Object.entries(def.properties)) {
    const own = Object.hasOwn(node.props, prop) ? node.props[prop] : undefined;
    const value = own === undefined ? schema.default : own;
    if (schema.type === 'string' || schema.type === 'link') {
      const next = visit({ prop, value, schema });
      if (next !== undefined) writes.push({ node, prop, value: next });
    } else if (schema.type === 'object' && isRecord(value)) {
      let copy: Record<string, unknown> | null = null;
      for (const [field, f] of Object.entries(schema.fields)) {
        if (f.type !== 'string' && f.type !== 'link') continue;
        const next = visit({ prop, value: fieldValue(value, field, f), schema: f, field });
        if (next !== undefined) (copy ??= clone(value))[field] = next;
      }
      if (copy) writes.push({ node, prop, value: copy });
    } else if (schema.type === 'list' && !schema.feed && !Object.hasOwn(node.listSources ?? {}, prop)) {
      // A list the placement leaves to the design's default gets its own copy only when something in it changes.
      const items: ListItem[] | null = Array.isArray(own) ? (own as ListItem[]) : own === undefined && Array.isArray(schema.default) ? placedDefaultItems(owner, node, schema.default) : null;
      if (!items) continue;
      let copy: ListItem[] | null = null;
      items.forEach((item, i) => {
        if (!isRecord(item)) return;
        for (const [field, f] of Object.entries(schema.fields)) {
          if (f.type !== 'string' && f.type !== 'link') continue;
          const next = visit({ prop, value: fieldValue(item, field, f), schema: f, itemId: item.id, field });
          if (next === undefined) continue;
          copy ??= clone(items);
          copy[i][field] = next;
        }
      });
      if (copy) writes.push({ node, prop, value: copy });
    }
  }
  return writes;
}

/** The placements in the trees that show content (or only `only`), with their designs. */
function* placements(state: ProjectState, only?: InstanceNode): Generator<{ owner: OwnerRef; where: string; node: InstanceNode; def: ComponentDefinition }> {
  for (const { owner, tree, label } of trees(state)) {
    for (const node of Object.values(tree.nodes)) {
      if (node?.kind !== 'instance' || (only && node !== only)) continue;
      const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
      if (def) yield { owner, where: label, node, def };
    }
  }
}

/** What a text or link that shows `swap`'s old value shows next, or undefined when it shows something else. */
function swapped(swaps: readonly DetailSwap[], value: unknown, schema: PropSchema): { value: unknown; detail: BusinessDetail } | undefined {
  for (const s of swaps) {
    if (schema.type === 'string' && typeof value === 'string') {
      if (s.from.some((f) => says(s.detail, value, f)) && !says(s.detail, value, s.to)) return { value: s.to, detail: s.detail };
    } else if (schema.type === 'link' && isLink(value)) {
      if (s.from.some((f) => opens(s.detail, value, f)) && !opens(s.detail, value, s.to)) {
        const link = relinked(s.detail, value, s.to);
        if (link) return { value: link, detail: s.detail };
      }
    }
  }
  return undefined;
}

/** The most a text field holds when `value` is longer than that, or null when it fits. */
function tooLong(schema: PropSchema, value: unknown): number | null {
  if (schema.type !== 'string' || typeof value !== 'string') return null;
  const max = schema.maxLength ?? DEFAULT_TEXT_MAX;
  return value.length > max ? max : null;
}

/**
 * The writes that carry `swaps` into every placement, or why they cannot be made: a text that would grow past what
 * its field holds. Nothing is changed.
 */
function planSwaps(state: ProjectState, swaps: readonly DetailSwap[]): { writes: Write[] } | { problem: string } {
  const writes: Write[] = [];
  if (!swaps.length) return { writes };
  for (const { owner, where, node, def } of placements(state)) {
    const refused: { problem?: string } = {};
    const found = visitPlacement(owner, node, def, ({ value, schema }) => {
      const next = refused.problem ? undefined : swapped(swaps, value, schema);
      if (!next) return undefined;
      const max = tooLong(schema, next.value);
      if (max === null) return next.value;
      const name = DETAIL_NAMES[next.detail];
      refused.problem = `${displayName(state, node, def)} in ${owner.kind === 'shell' ? `the ${where.toLowerCase()}` : `“${where}”`} shows the site's ${name} in ${schema.label}, which holds at most ${max} characters. Use a shorter ${name}, or give it its own text first.`;
      return undefined;
    });
    if (refused.problem) return { problem: refused.problem };
    writes.push(...found);
  }
  return { writes };
}

/** The swaps that take the site's details from `before` to `after`: each detail given a new value, from its old one and the sample. */
export function detailSwaps(before: Partial<Record<BusinessDetail, string>>, after: Partial<Record<BusinessDetail, string>>): DetailSwap[] {
  const out: DetailSwap[] = [];
  for (const detail of BUSINESS_DETAILS) {
    const to = after[detail];
    // A detail cleared leaves the places that showed it as they are.
    if (!to || to === before[detail]) continue;
    out.push({ detail, from: [before[detail], SAMPLES[detail]].filter((v): v is string => !!v), to });
  }
  return out;
}

/**
 * Carries a change of the site's details from `before` into every place that showed the old value or the sample,
 * in the pages, the shared header and footer, and the collections' layouts. Returns why it cannot be carried,
 * changing nothing, when a text would grow past what its field holds.
 */
export function carryBusinessDetails(state: ProjectState, before: Partial<Record<BusinessDetail, string>>, after: Partial<Record<BusinessDetail, string>> = detailTexts(state.site)): string | null {
  const plan = planSwaps(state, detailSwaps(before, after));
  if ('problem' in plan) return plan.problem;
  for (const w of plan.writes) w.node.props[w.prop] = w.value;
  return null;
}

/**
 * A newly placed section shows the site's details where its design shows the samples, so a Contact section added
 * after Site details are filled in says the real ones from the start. A text too long for its field keeps the sample.
 */
export function fillBusinessDetails(state: ProjectState, owner: OwnerRef, node: InstanceNode): void {
  const site = detailTexts(state.site);
  const swaps = BUSINESS_DETAILS.filter((d) => site[d]).map((d) => ({ detail: d, from: [SAMPLES[d]], to: site[d]! }));
  const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!swaps.length || !def) return;
  const writes = visitPlacement(owner, node, def, ({ value, schema }) => {
    const next = swapped(swaps, value, schema);
    return next && tooLong(schema, next.value) === null ? next.value : undefined;
  });
  for (const w of writes) w.node.props[w.prop] = w.value;
}

/** Every place that shows one of the site's details or its sample (in `only`, when it is given), in the trees' order. */
export function detailPlaces(state: ProjectState, only?: InstanceNode): DetailPlace[] {
  const site = detailTexts(state.site);
  const out: DetailPlace[] = [];
  for (const { owner, where, node, def } of placements(state, only)) {
    visitPlacement(owner, node, def, ({ prop, value, schema, itemId, field }) => {
      for (const detail of BUSINESS_DETAILS) {
        const shows = (v: string) => (schema.type === 'string' ? typeof value === 'string' && says(detail, value, v) : isLink(value) && opens(detail, value, v));
        const as = site[detail] && shows(site[detail]!) ? 'site' : shows(SAMPLES[detail]) ? 'sample' : null;
        if (!as) continue;
        out.push({ owner, where, node, prop, detail, kind: schema.type === 'link' ? 'link' : 'text', shows: as, ...(itemId ? { itemId } : {}), ...(field ? { field } : {}) });
        break;
      }
      return undefined;
    });
  }
  return out;
}
