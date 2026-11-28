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
 * becomes): the placement keeps it through later changes (`InstanceNode.keepsText`, as `detail:`, the detail and its
 * field) until the author edits that field. Clearing a detail changes nothing on the pages: each place keeps what it
 * shows, as its own from then on.
 *
 * Only placements' fields follow: their properties, objects and list items, where the theme's sections and the
 * project's designs show contact details. A primitive text or button holds only what the author typed into it. A
 * contact form's settings, submission keys and placeholders are never touched, nor a design's property that it hands
 * on to a form inside it.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, LinkValue, ListItem, NodeTree, OwnerRef, ProjectState, PropSchema, SiteDoc } from '@shared/types';
import { isBinding } from '@shared/types';
import { openingHoursText, sitePublisher } from '@shared/site-identity';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { dialString } from '@shared/contact-links';
import { siteLanguage } from '@shared/languages';
import { isFormContract, sendsFormMessages } from '@shared/form-contract';
import { formDestinationLookup, type FormDestinationLookup } from './form-destinations';
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

/** An address as mail hosts compare it: the mailbox as written, the domain in any case. */
const mailbox = (t: string) => t.trim().replace(/@[^@]*$/, (d) => d.toLowerCase());

/** Whether a link opens `value`: an email link to that one address (whatever it adds after it), or a call to that number. */
function opens(detail: BusinessDetail, link: LinkValue, value: string): boolean {
  if (detail === 'email') return link.type === 'email' && mailbox(link.target.split('?')[0]) === mailbox(value);
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
  node: InstanceNode;
  /** The placement's property. */
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
  node: InstanceNode;
  prop: string;
  value: unknown;
}

const KEEP = 'detail:';
/** A kept value's name: the detail it matched, and the field that shows it (`items[i1].value`, `actionLink`). */
const keepKey = (detail: BusinessDetail, path: string) => `${KEEP}${detail}:${path}`;
/** The field a kept value's name names. */
const keptPath = (key: string) => key.slice(key.indexOf(':', KEEP.length) + 1);
/** A list item's field, its ID written so no ID can be read as more of the path. */
const itemPath = (prop: string, itemId: string, field: string) => `${prop}[${itemId.replace(/[%[\]]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}].${field}`;
/** The property, item and field a path names. */
function parsePath(path: string): { prop: string; itemId?: string; field?: string } {
  const item = /^([^.[]+)\[([^\]]*)\]\.(.+)$/.exec(path);
  if (item) return { prop: item[1], itemId: item[2].replace(/%(25|5b|5d)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), field: item[3] };
  const dot = path.indexOf('.');
  return dot < 0 ? { prop: path } : { prop: path.slice(0, dot), field: path.slice(dot + 1) };
}
/** What a property's value shows at a path (a field it leaves out, its design's), as text to compare. */
function valueAt(value: unknown, path: string, schema: PropSchema | undefined): string {
  const { itemId, field } = parsePath(path);
  const fields = schema && (schema.type === 'list' || schema.type === 'object') ? schema.fields : {};
  const shown = (holder: unknown, base: unknown) => (isRecord(holder) && Object.hasOwn(holder, field!) ? holder[field!] : isRecord(base) && Object.hasOwn(base, field!) ? base[field!] : fields[field!]?.default);
  let v: unknown = value;
  if (itemId !== undefined) v = Array.isArray(value) ? shown(value.find((it) => isRecord(it) && it.id === itemId), undefined) : undefined;
  else if (field !== undefined) v = shown(value, schema?.type === 'object' ? schema.default : undefined);
  return JSON.stringify(v ?? null);
}

/** The detail values a placement keeps through changes of the site's details. */
const keptOf = (node: InstanceNode): Set<string> => new Set(Array.isArray(node.keepsText) ? node.keepsText.filter((k): k is string => typeof k === 'string' && k.startsWith(KEEP)) : []);

/** Sets which detail values a placement keeps, leaving what it keeps through renames of the site (shared/site-name.ts). */
function setKept(node: InstanceNode, keys: Set<string>) {
  const others = Array.isArray(node.keepsText) ? node.keepsText.filter((k) => typeof k === 'string' && !k.startsWith(KEEP)) : [];
  const list = [...others, ...[...keys].sort()];
  if (list.length) node.keepsText = list;
  else delete node.keepsText;
}

/**
 * Watches an edit of one property: call what it returns with the property's value after the edit. Each kept value the
 * edit changed (its text, its link, even a link that moved with its text) is the author's choice again, and follows
 * the site's details if it shows them; one it left as it was stays kept. `before` is the value the placement showed.
 */
export function watchDetailKeeps(node: InstanceNode, prop: string, before: unknown, schema?: PropSchema): (after: unknown) => void {
  const mine = [...keptOf(node)].filter((k) => parsePath(keptPath(k)).prop === prop);
  if (!mine.length) return () => {};
  const was = new Map(mine.map((k) => [k, valueAt(before, keptPath(k), schema)]));
  return (after) => {
    const kept = keptOf(node);
    let changed = false;
    for (const [k, v] of was) if (valueAt(after, keptPath(k), schema) !== v && kept.delete(k)) changed = true;
    if (changed) setKept(node, kept);
  };
}

/** A property removed from the design takes its kept values with it. */
export function dropDetailKeeps(node: InstanceNode, prop: string): void {
  const kept = keptOf(node);
  const mine = [...kept].filter((k) => parsePath(keptPath(k)).prop === prop);
  if (!mine.length) return;
  for (const k of mine) kept.delete(k);
  setKept(node, kept);
}

/** Properties renamed in the design (old name to new) keep their kept values; whatever was kept under a new name goes. */
export function renameDetailKeeps(node: InstanceNode, renamed: ReadonlyMap<string, string>): void {
  const kept = keptOf(node);
  if (!kept.size) return;
  const targets = new Set(renamed.values());
  const out = new Set<string>();
  for (const key of kept) {
    const path = keptPath(key);
    const { prop } = parsePath(path);
    const to = renamed.get(prop);
    if (to !== undefined) out.add(`${key.slice(0, key.length - path.length)}${to}${path.slice(prop.length)}`);
    else if (!targets.has(prop)) out.add(key);
  }
  setKept(node, out);
}

/** A copy's list items take new IDs (`before` holds its properties with the old ones): its kept values move with them. */
export function remapDetailKeeps(node: InstanceNode, before: Record<string, unknown>): void {
  const kept = keptOf(node);
  if (!kept.size) return;
  const out = new Set<string>();
  for (const key of kept) {
    const path = keptPath(key);
    const { prop, itemId, field } = parsePath(path);
    const from = before[prop];
    const to = node.props[prop];
    if (itemId === undefined || !Array.isArray(from) || !Array.isArray(to) || from === to) {
      out.add(key);
      continue;
    }
    const at = from.findIndex((it) => (it as ListItem | undefined)?.id === itemId);
    const id = at >= 0 ? (to[at] as ListItem | undefined)?.id : undefined;
    if (typeof id === 'string') out.add(`${key.slice(0, key.length - path.length)}${itemPath(prop, id, field!)}`);
  }
  setKept(node, out);
}

/**
 * A design's own properties it hands on to a contact form inside it, however deep: a form's settings, fields and
 * submission keys, which a change of the site's details must never rewrite.
 */
function formFed(state: ProjectState, def: ComponentDefinition, seen = new Map<string, Set<string>>()): Set<string> {
  const known = seen.get(def.id);
  if (known) return known;
  const out = new Set<string>();
  seen.set(def.id, out);
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    if (n?.kind !== 'instance') continue;
    const inner = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
    if (!inner) continue;
    const fed = isForm(inner) ? null : formFed(state, inner, seen);
    for (const [k, v] of Object.entries(n.props)) if (isBinding(v) && '$prop' in v && typeof v.$prop === 'string' && (fed === null || fed.has(k))) out.add(v.$prop);
  }
  return out;
}

/** A text or link field, of a placement's property or of one of its objects or items. */
const textOrLink = (schema: PropSchema) => schema.type === 'string' || schema.type === 'link';
const maxOf = (schema: PropSchema) => (schema.type === 'string' ? (schema.maxLength ?? DEFAULT_TEXT_MAX) : Infinity);
const kindOf = (schema: PropSchema): 'text' | 'link' => (schema.type === 'link' ? 'link' : 'text');

/** A design whose settings are a form service's (an endpoint, an access key, a form name) and whose items are fields to fill in. */
const isForm = (def: ComponentDefinition) => isFormContract(def.componentId) || isFormContract(def.provenance?.componentId) || sendsFormMessages(def);

/**
 * Visits every plain text and link a placement shows: its own properties, its objects' fields and each list item's
 * fields, using the design's defaults for what it leaves out.
 * `visit` returns the spot's new value, or undefined to leave it; the properties that change are returned with their
 * new values, each a copy, and nothing is written.
 */
function visitNode(state: ProjectState, owner: OwnerRef, node: InstanceNode, visit: (spot: Spot) => unknown, routing: FormDestinationLookup = formDestinationLookup(state)): Write[] {
  const writes: Write[] = [];
  const put = (prop: string, value: unknown) => writes.push({ owner, node, prop, value });
  const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!def || isForm(def)) return writes;
  // A design's property it hands on to a form: where the form sends (engine/form-destinations.ts), or its fields.
  const fed = def.tree ? formFed(state, def) : null;
  const toForm = (prop: string) => !!fed?.has(prop) || routing(def.id, prop);
  for (const [prop, schema] of Object.entries(def.properties)) {
    if (toForm(prop)) continue;
    const own = Object.hasOwn(node.props, prop) ? node.props[prop] : undefined;
    if (textOrLink(schema)) {
      const next = visit({ key: prop, prop, kind: kindOf(schema), value: own === undefined ? schema.default : own, max: maxOf(schema), label: schema.label });
      if (next !== undefined) put(prop, next);
    } else if (schema.type === 'object') {
      // What the site build shows of each field: the placement's own, then the object's default, then the field's.
      const value = own === undefined ? schema.default : own;
      // An object handed in from the design around it is that design's to change.
      if (!isRecord(value) || isBinding(value)) continue;
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
          const next = visit({ key: itemPath(prop, item.id, field), prop, itemId: item.id, field, kind: kindOf(f), value: Object.hasOwn(item, field) ? item[field] : f.default, max: maxOf(f), label: `${schema.label} → ${f.label}` });
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
function* nodesOf(state: ProjectState, only?: { owner: OwnerRef; node: GraphNode }): Generator<{ owner: OwnerRef; where: string; node: InstanceNode }> {
  for (const { owner, tree, label } of trees(state)) {
    if (only && (only.owner.kind !== owner.kind || only.owner.id !== owner.id)) continue;
    for (const node of Object.values(tree.nodes)) if (node?.kind === 'instance' && (!only || node === only.node)) yield { owner, where: label, node };
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
  const link = spot.value as LinkValue;
  // An address corrected in case alone is corrected in its links too: a mail host may tell the two apart.
  if (s.detail === 'email' ? link.target.split('?')[0].trim() === s.to : shows(s.detail, 'link', link, s.to)) return undefined;
  return relinked(s.detail, link, s.to) ?? undefined;
}

/**
 * The writes that carry `swaps` into every node (or `only`), or why they cannot be made: a text that would grow past
 * what its field holds. Nothing is changed.
 */
function planSwaps(state: ProjectState, swaps: readonly DetailSwap[], only?: { owner: OwnerRef; node: GraphNode }): Plan | { problem: string } {
  const plan: Plan = { writes: [], keeps: [] };
  if (!swaps.length) return plan;
  const routing = formDestinationLookup(state);
  for (const { owner, where, node } of nodesOf(state, only)) {
    const kept = keptOf(node);
    let keepsChanged = false;
    const refused: { problem?: string } = {};
    const writes = visitNode(state, owner, node, (spot) => {
      if (refused.problem) return undefined;
      for (const s of swaps) {
        if (spot.kind === 'link' && !linkable(s.detail)) continue;
        const k = keepKey(s.detail, spot.key);
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
          if (s.keepOwn) {
            kept.add(k);
            keepsChanged = true;
          }
          continue;
        }
        const next = nextValue(s, spot);
        // Already as this detail has it: another detail may still change it.
        if (next === undefined) continue;
        if (typeof next === 'string' && next.length > spot.max) {
          const name = DETAIL_NAMES[s.detail];
          const def = state.components[node.definitionId];
          const placed = owner.kind === 'shell' ? `The ${where.toLowerCase()}` : `${displayName(state, node, def)} in “${where}”`;
          refused.problem = `${placed} shows the site's ${name} in ${spot.label}, which holds at most ${spot.max} characters. Use a shorter ${name}, or give it its own text first.`;
          return undefined;
        }
        return next;
      }
      return undefined;
    }, routing);
    if (refused.problem) return { problem: refused.problem };
    plan.writes.push(...writes);
    if (keepsChanged) plan.keeps.push({ node, keys: kept });
  }
  return plan;
}

function commit(plan: Plan): void {
  for (const w of plan.writes) w.node.props[w.prop] = w.value;
  for (const { node, keys } of plan.keeps) setKept(node, keys);
}

/**
 * The swaps that take the site's details from `before` to `after`: each detail given a new value, from its old one and
 * the sample. A detail in `samples` (one an edit names) that stays as it was still replaces any sample left (a
 * section pasted in).
 */
export function detailSwaps(before: Texts, after: Texts, samples: Iterable<BusinessDetail> = []): DetailSwap[] {
  const resent = new Set(samples);
  const out: DetailSwap[] = [];
  for (const detail of BUSINESS_DETAILS) {
    const to = after[detail];
    // A detail cleared leaves the places that showed it as they are.
    if (!to) continue;
    const was = before[detail];
    if (to !== was) out.push({ detail, from: [was, SAMPLES[detail]].filter((v): v is string => !!v), to, keepOwn: !!was });
    else if (resent.has(detail)) out.push({ detail, from: [SAMPLES[detail]], to, keepOwn: false });
  }
  return out;
}

/**
 * Carries a change of the site's details from `before` into every place that showed the old value or the sample. The
 * details in `samples` (those an edit names) also replace any sample still shown when their value stays as it was.
 * Returns why it cannot be carried, changing nothing, when a text would grow past what its field holds.
 */
export function carryBusinessDetails(state: ProjectState, before: Texts, samples: Iterable<BusinessDetail> = []): string | null {
  const plan = planSwaps(state, detailSwaps(before, detailTexts(state.site), samples));
  if ('problem' in plan) return plan.problem;
  commit(plan);
  return null;
}

/**
 * Where the site's details becoming `site`'s would change what visitors see: the trees whose texts or links change.
 * Empty when nothing shows a detail that changes, or when the change would be refused.
 */
export function changedDetailOwners(state: ProjectState, site: SiteDoc, samples: Iterable<BusinessDetail> = []): OwnerRef[] {
  const plan = planSwaps(state, detailSwaps(detailTexts(state.site), detailTexts(site), samples));
  if ('problem' in plan) return [];
  const seen = new Map<string, OwnerRef>();
  for (const w of plan.writes) seen.set(`${w.owner.kind}:${w.owner.id}`, w.owner);
  return [...seen.values()];
}

/**
 * A newly placed section shows the site's details where its design shows the samples, so a Contact section added
 * after Site details are filled in says the real ones from the start. The values the placement was `given` are its own
 * and stay as they are (an object's fields it was not given are its design's). A detail one of its fields has no room
 * for keeps its samples throughout the section, so no text says one address while its link opens another.
 */
export function fillBusinessDetails(state: ProjectState, owner: OwnerRef, node: InstanceNode, given: Record<string, unknown> = {}): void {
  const site = detailTexts(state.site);
  const all = BUSINESS_DETAILS.filter((d) => site[d]).map((d): DetailSwap => ({ detail: d, from: [SAMPLES[d]], to: site[d]!, keepOwn: false }));
  if (!all.length) return;
  const own = (spot: Spot) => {
    if (!Object.hasOwn(given, spot.prop)) return false;
    const v = given[spot.prop];
    return spot.itemId !== undefined || spot.field === undefined || !isRecord(v) || Object.hasOwn(v, spot.field);
  };
  const routing = formDestinationLookup(state);
  // Placed but not yet in its tree, so it is visited on its own; `tooLong` collects the details a field has no room for.
  const fill = (swaps: readonly DetailSwap[], tooLong?: Set<BusinessDetail>) =>
    visitNode(
      state,
      owner,
      node,
      (spot) => {
        if (own(spot)) return undefined;
        for (const s of swaps) {
          if (spot.kind === 'link' && !linkable(s.detail)) continue;
          if (!s.from.some((f) => shows(s.detail, spot.kind, spot.value, f))) continue;
          const next = nextValue(s, spot);
          if (typeof next === 'string' && next.length > spot.max) tooLong?.add(s.detail);
          return next;
        }
        return undefined;
      },
      routing
    );
  // A detail some field has no room for keeps its samples everywhere in the section, its links too; the others fill.
  const tooLong = new Set<BusinessDetail>();
  fill(all, tooLong);
  commit({ writes: fill(all.filter((s) => !tooLong.has(s.detail))), keeps: [] });
}

/** Every place that shows one of the site's details or its sample (only in `only`, when it is given), in the trees' order. */
export function detailPlaces(state: ProjectState, only?: { owner: OwnerRef; node: GraphNode }): DetailPlace[] {
  const site = detailTexts(state.site);
  const out: DetailPlace[] = [];
  const routing = formDestinationLookup(state);
  for (const { owner, where, node } of nodesOf(state, only)) {
    const kept = keptOf(node);
    visitNode(state, owner, node, (spot) => {
      for (const detail of BUSINESS_DETAILS) {
        if (spot.kind === 'link' && !linkable(detail)) continue;
        const as = site[detail] && shows(detail, spot.kind, spot.value, site[detail]!) ? 'site' : shows(detail, spot.kind, spot.value, SAMPLES[detail]) ? 'sample' : null;
        if (!as) continue;
        const own = as === 'site' && kept.has(keepKey(detail, spot.key));
        out.push({ owner, where, node, prop: spot.prop, detail, kind: spot.kind, shows: as, ...(own ? { kept: true } : {}), ...(spot.itemId !== undefined ? { itemId: spot.itemId } : {}), ...(spot.field !== undefined ? { field: spot.field } : {}) });
        break;
      }
      return undefined;
    }, routing);
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
