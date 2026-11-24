/**
 * Who publishes the site (`SiteDoc.identity`): an organization, a local business or a person, with the name, logo,
 * profiles elsewhere and contact details search engines and AI answer engines read from the pages' structured data
 * (generator/seo-graph.ts). Every value is checked here, the same way when Site details saves it, when the engine
 * applies `site.update`, and when the website is built from a file edited by hand, which keeps only what passes.
 */
import type { EntityKind, SiteDoc, SiteIdentity } from './types';

export const ENTITY_KINDS: readonly EntityKind[] = ['Organization', 'LocalBusiness', 'Person'];
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = { Organization: 'Organization', LocalBusiness: 'Local business', Person: 'Person' };
export const isEntityKind = (v: unknown): v is EntityKind => typeof v === 'string' && (ENTITY_KINDS as readonly string[]).includes(v);

/** The most each identity field holds. */
export const IDENTITY_LIMITS = { name: 120, url: 300, profiles: 20, twitterSite: 16, address: 300, telephone: 40, email: 254, hours: 14, hoursLine: 60, priceRange: 40 } as const;

/** The identity fields, in the order Site details shows them. */
export const IDENTITY_FIELDS = ['kind', 'name', 'url', 'logo', 'sameAs', 'twitterSite', 'address', 'telephone', 'email', 'openingHours', 'priceRange', 'geo'] as const satisfies ReadonlyArray<keyof SiteIdentity>;

/** A change to the identity: a field given a value takes it; one given null, "" or an empty list is cleared. */
export type IdentityPatch = { [K in keyof SiteIdentity]?: SiteIdentity[K] | null };

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };
const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const no = <T>(message: string): Checked<T> => ({ ok: false, message });

/** Text on one line, with runs of spaces closed up. */
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();

/**
 * A web address of the publisher or one of its profiles ("https://www.wikidata.org/wiki/Q42"): http or https with a
 * host, and nothing a browser would have to repair. Kept as the parser writes it. Empty text is no address.
 */
export function checkProfileUrl(input: string, what = 'The address'): Checked<string> {
  const text = input.trim();
  if (!text) return ok('');
  if (text.length > IDENTITY_LIMITS.url) return no(`${what} can be at most ${IDENTITY_LIMITS.url} characters.`);
  if (/[\s\u0000-\u001f\u007f\\]/.test(text)) return no(`${what} can’t contain spaces or backslashes.`);
  if (!/^[a-z][a-z\d+.-]*:/i.test(text) || /^[^/:]+:\d/.test(text)) return no(`${what} needs https:// before it, such as https://${text.replace(/^\/+/, '')}.`);
  if (!/^https?:\/\/[^/?#]/i.test(text)) return no(`${what} must start with https:// and a host name.`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return no(`${what} is not one browsers can open.`);
  }
  if (!url.hostname) return no(`${what} needs a host name after https://.`);
  if (url.username || url.password) return no(`Leave the user name and password out of ${what[0].toLowerCase()}${what.slice(1)}.`);
  // The limit is on the address as it is kept, so one saved is never refused when the website reads it again.
  if (url.href.length > IDENTITY_LIMITS.url) return no(`${what} can be at most ${IDENTITY_LIMITS.url} characters, written as browsers send it.`);
  return ok(url.href);
}

/** An X (Twitter) handle, written with its @ ("riverside" and "@riverside" are "@riverside"). */
export function checkTwitterHandle(input: string): Checked<string> {
  const text = input.trim();
  if (!text) return ok('');
  const body = text.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(body)) return no('An X handle is up to 15 letters, numbers and underscores, such as @riverside.');
  return ok(`@${body}`);
}

/** An email address: one mailbox, nothing around it. */
export function checkEmail(input: string): Checked<string> {
  const text = input.trim();
  if (!text) return ok('');
  if (text.length > IDENTITY_LIMITS.email || !/^[^\s@<>()",;:\\]+@(?:[^\s@<>()",;:/\\?#.]+\.)+[^\s@<>()",;:/\\?#.]+$/.test(text)) return no(`“${text}” is not an email address, such as hello@example.com.`);
  return ok(text);
}

/** A telephone number as people dial it: digits, with spaces, “+”, brackets, dots or dashes between them. */
export function checkTelephone(input: string): Checked<string> {
  const text = oneLine(input);
  if (!text) return ok('');
  if (text.length > IDENTITY_LIMITS.telephone || !/^\+?[\d\s().\-/]+$/.test(text) || (text.match(/\d/g) ?? []).length < 3) return no(`“${text}” is not a telephone number, such as +27 21 555 0134.`);
  return ok(text);
}

const DAY = '(?:mo|tu|we|th|fr|sa|su)';
const DAYS = `${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*`;
const HOURS = new RegExp(`^(${DAYS})(?: (\\d{1,2}):([0-5]\\d)-(\\d{1,2}):([0-5]\\d))?$`, 'i');

/**
 * One period a business is open, as Schema.org writes it: two-letter days, ranges and lists of them, then the hours
 * on a 24-hour clock ("Mo-Fr 09:00-17:00", "Sa 10:00-14:00"). Days alone mean open all day. Written as Schema.org
 * writes it, whatever case the days were typed in and however the hours were padded ("mo-fr 9:00-17:00").
 */
export function checkOpeningHours(input: string): Checked<string> {
  const text = oneLine(input).replace(/\s*([-,])\s*/g, '$1');
  if (!text) return ok('');
  const m = text.length > IDENTITY_LIMITS.hoursLine ? null : HOURS.exec(text);
  const refused = no<string>(`“${oneLine(input)}” is not a period such as Mo-Fr 09:00-17:00: two-letter days, then the hours on a 24-hour clock.`);
  if (!m) return refused;
  const days = m[1].toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  if (m[2] === undefined) return ok(days);
  const time = (h: string, min: string) => (Number(h) > 24 || (Number(h) === 24 && min !== '00') ? null : `${h.padStart(2, '0')}:${min}`);
  const from = time(m[2], m[3]);
  const to = time(m[4], m[5]);
  return from && to ? ok(`${days} ${from}-${to}`) : refused;
}

/** A map position typed as “latitude, longitude” (“-33.92, 18.42”). Empty text is none. */
export function checkCoordinates(input: string): Checked<{ latitude: number; longitude: number } | null> {
  const text = input.trim();
  if (!text) return ok(null);
  const parts = text.split(/\s*[,;]\s*|\s+/).filter(Boolean);
  if (parts.length !== 2 || parts.some((p) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(p))) return no('Enter the latitude and the longitude as two numbers, such as -33.92, 18.42.');
  return checkGeo({ latitude: Number(parts[0]), longitude: Number(parts[1]) });
}

/** A map position: a latitude from -90 to 90 and a longitude from -180 to 180. */
export function checkGeo(geo: unknown): Checked<{ latitude: number; longitude: number } | null> {
  const g = (geo && typeof geo === 'object' ? geo : {}) as { latitude?: unknown; longitude?: unknown };
  const { latitude, longitude } = g;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return no('A map position needs both a latitude and a longitude.');
  if (latitude < -90 || latitude > 90) return no(`The latitude ${latitude} is not on the map: it runs from -90 to 90.`);
  if (longitude < -180 || longitude > 180) return no(`The longitude ${longitude} is not on the map: it runs from -180 to 180.`);
  return ok({ latitude, longitude });
}

/** Map positions as Site details shows them: “latitude, longitude”. */
export const coordinatesText = (geo: SiteIdentity['geo']): string => (geo && typeof geo.latitude === 'number' && typeof geo.longitude === 'number' ? `${geo.latitude}, ${geo.longitude}` : '');

/** Profile addresses, one per line or a list, checked and each kept once, in order. A refusal names the line. */
export function checkProfiles(input: string | readonly unknown[]): Checked<string[]> {
  if (typeof input !== 'string' && input.some((v) => typeof v !== 'string')) return no('Each profile address is text, such as https://www.wikidata.org/wiki/Q42.');
  const lines = typeof input === 'string' ? input.split(/\r?\n/) : (input as string[]);
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const c = checkProfileUrl(line, lines.length > 1 ? `The profile address on line ${i + 1}` : 'The profile address');
    if (!c.ok) return c;
    if (c.value && !out.includes(c.value)) out.push(c.value);
  }
  if (out.length > IDENTITY_LIMITS.profiles) return no(`List at most ${IDENTITY_LIMITS.profiles} profile addresses.`);
  return ok(out);
}

/** Opening hours, one period per line or a list, each checked and kept once, in order. */
export function checkHoursList(input: string | readonly unknown[]): Checked<string[]> {
  if (typeof input !== 'string' && input.some((v) => typeof v !== 'string')) return no('Each opening period is text, such as Mo-Fr 09:00-17:00.');
  const lines = typeof input === 'string' ? input.split(/\r?\n/) : (input as string[]);
  const out: string[] = [];
  for (const line of lines) {
    const c = checkOpeningHours(line);
    if (!c.ok) return c;
    if (c.value && !out.includes(c.value)) out.push(c.value);
  }
  if (out.length > IDENTITY_LIMITS.hours) return no(`List at most ${IDENTITY_LIMITS.hours} opening periods.`);
  return ok(out);
}

/** Short text on one line, up to `max` characters. */
function checkLine(value: string, max: number, what: string): Checked<string> {
  const text = oneLine(value);
  return text.length > max ? no(`${what} can be at most ${max} characters.`) : ok(text);
}

/** Checks one field's new value: what to store (empty: clear it), or why it can't be. */
function checkField(key: keyof SiteIdentity, value: unknown, isImage: (id: string) => boolean): Checked<unknown> {
  const text = typeof value === 'string' ? value : '';
  switch (key) {
    case 'kind':
      return isEntityKind(value) ? ok(value) : no(`Choose who publishes the site: ${ENTITY_KINDS.join(', ')}.`);
    case 'name':
      return checkLine(text, IDENTITY_LIMITS.name, 'The name');
    case 'url':
      return checkProfileUrl(text, 'The home page address');
    case 'logo':
      return text && !isImage(text) ? no('Logo image not found.') : ok(text);
    case 'sameAs':
      return Array.isArray(value) ? checkProfiles(value) : no('Profile addresses are a list.');
    case 'twitterSite':
      return checkTwitterHandle(text);
    case 'address':
      return checkLine(text, IDENTITY_LIMITS.address, 'The address');
    case 'telephone':
      return checkTelephone(text);
    case 'email':
      return checkEmail(text);
    case 'openingHours':
      return Array.isArray(value) ? checkHoursList(value) : no('Opening hours are a list.');
    case 'priceRange':
      return checkLine(text, IDENTITY_LIMITS.priceRange, 'The price range');
    case 'geo':
      return checkGeo(value);
  }
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** What only a local business has: kept only while the identity is one, so nothing hidden comes back with a later switch. */
export const BUSINESS_FIELDS = ['openingHours', 'priceRange', 'geo'] as const satisfies ReadonlyArray<keyof SiteIdentity>;

/**
 * The identity once `patch` is applied to `current` (whatever was stored, even something edited into another shape
 * by hand), or why it can't be: each field given a value is checked, and one given null, "" or an empty list is
 * cleared. A patch of null clears the whole identity. Undefined when nothing is left. Opening hours, price range and
 * map position belong to a local business: another kind clears them, and refuses them in the same patch.
 */
export function patchIdentity(current: unknown, patch: IdentityPatch | null, isImage: (id: string) => boolean): Checked<SiteIdentity | undefined> {
  if (patch === null) return ok(undefined);
  const next: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const key of IDENTITY_FIELDS) {
    if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue;
    const value = patch[key];
    if (isEmpty(value)) {
      delete next[key];
      continue;
    }
    const c = checkField(key, value, isImage);
    if (!c.ok) return c;
    if (isEmpty(c.value)) delete next[key];
    else next[key] = c.value;
  }
  if (next.kind !== 'LocalBusiness') {
    const given = BUSINESS_FIELDS.filter((key) => Object.hasOwn(patch, key) && patch[key] !== undefined && !isEmpty(next[key]));
    if (given.length) return no('Opening hours, a price range and a map position are said of a local business: choose Local business as who publishes the site first.');
    // Choosing another kind clears them; an edit of another field leaves whatever is stored alone.
    if (Object.hasOwn(patch, 'kind') && patch.kind !== undefined) for (const key of BUSINESS_FIELDS) delete next[key];
  }
  return ok(Object.keys(next).length ? (next as SiteIdentity) : undefined);
}

/** The site's X (Twitter) handle, when its identity has a usable one. */
export function siteTwitterHandle(site: SiteDoc): string | undefined {
  const raw: unknown = site.identity;
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).twitterSite : undefined;
  const c = typeof v === 'string' ? checkTwitterHandle(v) : undefined;
  return c?.ok && c.value ? c.value : undefined;
}

/** The publisher as the website describes it: every value checked as the editor saves it, and anything else left out. */
export interface Publisher {
  kind: EntityKind;
  /** Whether the author chose the kind; the website describes an organization until then. */
  chosen: boolean;
  /** Its own name, when the identity gives one: the site's name otherwise. */
  name: string;
  url?: string;
  /** The logo's asset ID, when it is a picture in the library. */
  logo?: string;
  sameAs: string[];
  twitterSite?: string;
  address?: string;
  telephone?: string;
  email?: string;
  /** Said of a local business only. */
  openingHours: string[];
  priceRange?: string;
  geo?: { latitude: number; longitude: number };
}

/** The usable value of one field as stored, if it has one. */
function usable<T>(key: keyof SiteIdentity, stored: Record<string, unknown>, isImage: (id: string) => boolean): T | undefined {
  if (!Object.hasOwn(stored, key) || isEmpty(stored[key])) return undefined;
  const c = checkField(key, stored[key], isImage);
  return c.ok && !isEmpty(c.value) ? (c.value as T) : undefined;
}

/**
 * The usable members of a list as stored, each checked on its own: one value edited in by hand where a list belongs
 * counts as a list of one, and a member that is not usable text is left out without the rest.
 */
function usableList(value: unknown, check: (text: string) => Checked<string>): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(value) ? value : [value]) {
    const c = typeof v === 'string' ? check(v) : undefined;
    if (c?.ok && c.value && !out.includes(c.value)) out.push(c.value);
  }
  return out;
}

/**
 * Who publishes the site, as its pages describe it: the identity's values that are usable (a value edited by hand
 * that Site details would refuse is left out on its own), and the site's name when the identity names no one.
 * `isImage` says whether an asset ID is a picture in the library.
 */
export function sitePublisher(site: SiteDoc, isImage: (id: string) => boolean): Publisher {
  const raw: unknown = site.identity;
  const stored = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const kind = usable<EntityKind>('kind', stored, isImage);
  const siteName = typeof site.name === 'string' ? oneLine(site.name) : '';
  const local = kind === 'LocalBusiness';
  const opt = <K extends keyof Publisher>(k: K, v: Publisher[K] | undefined): Partial<Publisher> => (v === undefined ? {} : ({ [k]: v } as Partial<Publisher>));
  return {
    kind: kind ?? 'Organization',
    chosen: !!kind,
    name: usable<string>('name', stored, isImage) || siteName,
    ...opt('url', usable<string>('url', stored, isImage)),
    ...opt('logo', usable<string>('logo', stored, isImage)),
    sameAs: usableList(stored.sameAs, (v) => checkProfileUrl(v)).slice(0, IDENTITY_LIMITS.profiles),
    ...opt('twitterSite', usable<string>('twitterSite', stored, isImage)),
    ...opt('address', usable<string>('address', stored, isImage)),
    ...opt('telephone', usable<string>('telephone', stored, isImage)),
    ...opt('email', usable<string>('email', stored, isImage)),
    openingHours: local ? usableList(stored.openingHours, checkOpeningHours).slice(0, IDENTITY_LIMITS.hours) : [],
    ...opt('priceRange', local ? usable<string>('priceRange', stored, isImage) : undefined),
    ...opt('geo', local ? usable<{ latitude: number; longitude: number }>('geo', stored, isImage) : undefined)
  };
}
