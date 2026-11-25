/**
 * What a page is for search engines and AI answer engines, beyond a web page (`PageSeo.structuredData`): an About or a
 * Contact page, or the page of one of the publisher's own services, products, events or guides, with the facts that
 * describe it (a product's price, an event's date and venue, a guide's steps). The page's structured data names that
 * entity (generator/structured-data.ts) only once the facts it needs are there; until then the editor and the SEO
 * audit say which are missing, and the rest of the page's structured data is written as before.
 *
 * Every fact is checked here, the same way when the Inspector saves it, when the engine applies `page.update`, and when
 * the website is built from a file edited by hand, which uses only what passes.
 */
import type { PageStructuredData, PageStructuredType, ProductAvailability } from './types';
import { isArticleDate } from './articles';
import { checkProfileUrl, type Checked } from './site-identity';

export const PAGE_STRUCTURED_TYPES = ['WebPage', 'AboutPage', 'ContactPage', 'Service', 'Product', 'Event', 'HowTo'] as const satisfies readonly PageStructuredType[];
export const PAGE_STRUCTURED_TYPE_LABELS: Record<PageStructuredType, string> = { WebPage: 'Web page', AboutPage: 'About page', ContactPage: 'Contact page', Service: 'Service', Product: 'Product', Event: 'Event', HowTo: 'How-to guide' };
export const isPageStructuredType = (v: unknown): v is PageStructuredType => typeof v === 'string' && (PAGE_STRUCTURED_TYPES as readonly string[]).includes(v);

export const PRODUCT_AVAILABILITY = ['InStock', 'OutOfStock', 'PreOrder', 'BackOrder', 'LimitedAvailability', 'MadeToOrder', 'SoldOut', 'Discontinued'] as const satisfies readonly ProductAvailability[];
export const PRODUCT_AVAILABILITY_LABELS: Record<ProductAvailability, string> = {
  InStock: 'In stock',
  OutOfStock: 'Out of stock',
  PreOrder: 'Pre-order',
  BackOrder: 'Back order',
  LimitedAvailability: 'Limited availability',
  MadeToOrder: 'Made to order',
  SoldOut: 'Sold out',
  Discontinued: 'Discontinued'
};

/** The most each fact holds. */
export const STRUCTURED_LIMITS = { text: 160, address: 300, price: 32, url: 300, step: 500, steps: 50 } as const;

export type StructuredFact = 'serviceType' | 'areaServed' | 'price' | 'currency' | 'availability' | 'offerUrl' | 'startDate' | 'endDate' | 'venue' | 'address' | 'steps';

/** The facts each type states, in the order the Inspector shows them. */
export const STRUCTURED_FACTS: Record<PageStructuredData['type'], readonly StructuredFact[]> = {
  AboutPage: [],
  ContactPage: [],
  Service: ['serviceType', 'areaServed'],
  Product: ['price', 'currency', 'availability', 'offerUrl'],
  Event: ['startDate', 'endDate', 'venue', 'address'],
  HowTo: ['steps']
};
export const STRUCTURED_FACT_NAMES: readonly StructuredFact[] = Object.values(STRUCTURED_FACTS).flat();

/** How a fact is named in messages. */
export const STRUCTURED_FACT_LABELS: Record<StructuredFact, string> = {
  serviceType: 'Service type',
  areaServed: 'Area served',
  price: 'Price',
  currency: 'Currency',
  availability: 'Availability',
  offerUrl: 'Offer address',
  startDate: 'Starts',
  endDate: 'Ends',
  venue: 'Venue',
  address: 'Address',
  steps: 'Steps'
};

/**
 * A change to a page's structured data. `type` chooses what the page is: "WebPage" removes the record, another type
 * starts a fresh one (dropping the facts of the type before it), and the type it already is keeps its facts. Each fact
 * given takes its value, or is cleared by "" (or [] for the steps); facts not given stay.
 */
export type StructuredDataPatch = { type?: PageStructuredType } & { [K in StructuredFact]?: K extends 'steps' ? string[] : string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const no = <T>(message: string): Checked<T> => ({ ok: false, message });

/** Text on one line, with runs of spaces closed up. */
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();

function checkText(input: string, limit: number, what: string): Checked<string> {
  const text = oneLine(input);
  if ([...text].length > limit) return no(`${what} can be at most ${limit} characters.`);
  return ok(text);
}

/** A price as a number with an optional decimal part ("129", "0", "129.50"), without its currency or separators. */
export function checkPrice(input: string): Checked<string> {
  const text = input.trim();
  if (!text) return ok('');
  if (text.length > STRUCTURED_LIMITS.price || !/^\d+(?:\.\d+)?$/.test(text)) return no(`“${text}” is not a price: write it as a number, such as 129 or 129.50, without the currency or spaces.`);
  return ok(text);
}

/**
 * The ISO 4217 codes of the currencies things are priced in (funds and metals left out), with a few withdrawn lately
 * that a price may still be written in.
 */
const CURRENCIES = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK ' +
    'DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF ' +
    'KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK ' +
    'PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH ' +
    'UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL'
  ).split(' ')
);

/** A currency as its three-letter ISO 4217 code ("zar" is "ZAR"). */
export function checkCurrency(input: string): Checked<string> {
  const trimmed = input.trim();
  if (!trimmed) return ok('');
  // Letters A to Z only, before any case is changed: "ß" upper-cased would spell another code.
  const text = /^[a-z]{3}$/i.test(trimmed) ? trimmed.toUpperCase() : '';
  if (!CURRENCIES.has(text)) return no(`“${input.trim()}” is not a currency code: use its three letters, such as USD, EUR or ZAR.`);
  return ok(text);
}

export function checkAvailability(input: string): Checked<ProductAvailability | ''> {
  const text = input.trim();
  if (!text) return ok('');
  const found = PRODUCT_AVAILABILITY.find((a) => a.toLowerCase() === text.toLowerCase());
  return found ? ok(found) : no(`“${text}” is not an availability: choose one of ${PRODUCT_AVAILABILITY.map((a) => PRODUCT_AVAILABILITY_LABELS[a]).join(', ')}.`);
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-](\d{2}):(\d{2}))?)?$/i;

/** A date or time as its parts, when it is one: its day, its time of day, and its offset from UTC in minutes. */
function dateParts(text: string): { day: string; time?: string; seconds?: number; offset?: number } | null {
  const m = DATE_TIME.exec(text);
  if (!m || !isArticleDate(m[1])) return null;
  const [, day, h, min, s, zone, zh, zm] = m;
  if (h === undefined) return { day };
  if (+h > 23 || +min > 59 || (s !== undefined && +s > 59)) return null;
  // An offset is at most 14 hours either way (+14:00), and its minutes are minutes.
  if (zone && zone.toUpperCase() !== 'Z' && (+zm > 59 || +zh * 60 + +zm > 14 * 60)) return null;
  const offset = zone === undefined ? undefined : zone.toUpperCase() === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (+zh * 60 + +zm);
  return { day, time: `${h}:${min}${s === undefined ? '' : `:${s}`}`, seconds: +h * 3600 + +min * 60 + +(s ?? 0), offset };
}

/**
 * An event's start or end: a day ("2027-05-14"), or a day and a time ("2027-05-14T19:30"), with its offset from UTC
 * when given ("+02:00", or "Z"); a time without one is the venue's local time. Written as ISO 8601, with a "T".
 */
export function checkEventDate(input: string, what = 'The date'): Checked<string> {
  const text = input.trim();
  if (!text) return ok('');
  const parts = dateParts(text);
  if (!parts) return no(`${what} “${text}” is not a date: write it as 2027-05-14, or with a time as 2027-05-14T19:30 (add +02:00 for its time zone).`);
  const zone = parts.offset === undefined ? '' : /z$/i.test(text) ? 'Z' : text.slice(-6);
  return ok(parts.time ? `${parts.day}T${parts.time}${zone}` : parts.day);
}

/** The most a local time can be from UTC, in seconds: 14 hours. */
const MAX_OFFSET = 14 * 3600;

/**
 * The earliest and latest moments (seconds since the epoch) a date or time stands for: a time with its offset is one
 * moment; a time without one is a reading of the venue's clock, taken here as if it were UTC; a day is all of that day.
 */
function moments(p: NonNullable<ReturnType<typeof dateParts>>): [number, number] {
  const midnight = Date.parse(`${p.day}T00:00:00Z`) / 1000;
  if (p.seconds === undefined) return [midnight, midnight + 86399];
  const at = midnight + p.seconds - (p.offset ?? 0) * 60;
  return [at, at];
}

/**
 * Whether an event's end surely comes before its start. A day, or a time without an offset, is the venue's own: two of
 * them are read on one clock, and two times with offsets as moments. Beside a time with an offset, the venue's reading
 * could be up to 14 hours either way of UTC, so the end is before the start only when it is however far that goes.
 */
export function endsBeforeStart(start: string, end: string): boolean {
  const a = dateParts(start);
  const b = dateParts(end);
  if (!a || !b) return false;
  const local = (p: NonNullable<ReturnType<typeof dateParts>>) => p.offset === undefined;
  const widen = local(a) !== local(b) ? MAX_OFFSET : 0;
  return moments(b)[1] + (local(b) ? widen : 0) < moments(a)[0] - (local(a) ? widen : 0);
}

/** A guide's steps, one per line (or as a list): blank ones left out, each on one line. */
export function checkSteps(input: string | readonly unknown[]): Checked<string[]> {
  const lines = typeof input === 'string' ? input.split(/\r?\n/) : input;
  const steps: string[] = [];
  for (const line of lines) {
    if (typeof line !== 'string') return no('Each step is text.');
    const step = oneLine(line);
    if (!step) continue;
    if ([...step].length > STRUCTURED_LIMITS.step) return no(`Step ${steps.length + 1} is longer than ${STRUCTURED_LIMITS.step} characters: split it in two.`);
    steps.push(step);
  }
  if (steps.length > STRUCTURED_LIMITS.steps) return no(`A guide can list at most ${STRUCTURED_LIMITS.steps} steps.`);
  return ok(steps);
}

/** One fact checked, as it is stored: "" (or no steps) when it is left empty. */
export function checkFact(key: StructuredFact, value: unknown): Checked<string | string[]> {
  if (key === 'steps') return Array.isArray(value) || typeof value === 'string' ? checkSteps(value) : no('The steps are a list of text.');
  if (typeof value !== 'string') return no(`${STRUCTURED_FACT_LABELS[key]} is text.`);
  switch (key) {
    case 'price':
      return checkPrice(value);
    case 'currency':
      return checkCurrency(value);
    case 'availability':
      return checkAvailability(value);
    case 'offerUrl':
      return value.trim() ? checkProfileUrl(value, 'The offer address') : ok('');
    case 'startDate':
      return checkEventDate(value, 'The start');
    case 'endDate':
      return checkEventDate(value, 'The end');
    case 'address':
      return checkText(value, STRUCTURED_LIMITS.address, 'The address');
    default:
      return checkText(value, STRUCTURED_LIMITS.text, STRUCTURED_FACT_LABELS[key]);
  }
}

const isEmpty = (v: unknown) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
/** A stored fact left unsaid: no value, empty text, or (for the steps alone) an empty list. */
const unsaid = (key: StructuredFact, v: unknown) => v === undefined || v === '' || (key === 'steps' && Array.isArray(v) && v.length === 0);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A type's name in a sentence: "a Product", "an Event", "a How-to guide". */
export const typePhrase = (type: PageStructuredType) => `${/^[AEIOU]/.test(PAGE_STRUCTURED_TYPE_LABELS[type]) ? 'an' : 'a'} ${type === 'HowTo' ? 'how-to guide' : PAGE_STRUCTURED_TYPE_LABELS[type]}`;

/** A stored record's type and the facts that type states, leaving out anything else written into it by hand. */
function ownFacts(stored: Record<string, unknown> & { type: PageStructuredData['type'] }): Record<string, unknown> {
  return { type: stored.type, ...Object.fromEntries(STRUCTURED_FACTS[stored.type].filter((k) => Object.hasOwn(stored, k)).map((k) => [k, stored[k]])) };
}

/**
 * The record once `patch` is applied to `current` (whatever was stored, even something edited into another shape by
 * hand), or why it can't be. Undefined when the page is a plain web page again. Facts left empty are fine, since an
 * author fills them in one at a time; a fact the current type does not state, or one that doesn't pass its check,
 * refuses the whole patch.
 */
export function patchPageStructuredData(current: unknown, patch: StructuredDataPatch): Checked<PageStructuredData | undefined> {
  const given = STRUCTURED_FACT_NAMES.filter((k) => Object.hasOwn(patch, k) && patch[k] !== undefined);
  const stored = isRecord(current) && isPageStructuredType(current.type) && current.type !== 'WebPage' ? (current as Record<string, unknown> & { type: PageStructuredData['type'] }) : undefined;
  let next: Record<string, unknown>;
  if (patch.type !== undefined) {
    if (!isPageStructuredType(patch.type)) return no(`“${String(patch.type)}” is not a page type: choose one of ${PAGE_STRUCTURED_TYPES.join(', ')}.`);
    if (patch.type === 'WebPage') return given.length ? no('A web page states no facts: choose the type of page they describe.') : ok(undefined);
    // The same type again keeps its facts; another starts afresh, so nothing of the type before comes back unseen.
    next = stored?.type === patch.type ? ownFacts(stored) : { type: patch.type };
  } else if (!given.length) {
    return no('Choose a page type or give a fact to change.');
  } else if (!stored) {
    return no('Choose what the page is first: a service, a product, an event or a how-to guide.');
  } else next = ownFacts(stored);
  const type = next.type as PageStructuredData['type'];
  for (const key of given) {
    if (!STRUCTURED_FACTS[type].includes(key)) return no(`${STRUCTURED_FACT_LABELS[key]} is not said of ${typePhrase(type)}.`);
    const c = checkFact(key, patch[key]);
    if (!c.ok) return c;
    if (isEmpty(c.value)) delete next[key];
    else next[key] = c.value;
  }
  return ok(next as PageStructuredData);
}

/** Something about a page's structured data the author should put right, by the fact it is about. */
export interface StructuredIssue {
  field: StructuredFact | 'type';
  message: string;
  /** Whether it keeps the page's entity out of its structured data: a needed fact missing, or facts that contradict each other. */
  blocking: boolean;
}

/** A page's structured data as the website reads it. */
export interface StructuredInspection {
  /** What the page is: a web page when it has no record, or one whose type is unusable. */
  type: PageStructuredType;
  /** The facts that pass their checks, as stored. */
  facts: Partial<Record<Exclude<StructuredFact, 'steps'>, string>> & { steps?: string[] };
  issues: StructuredIssue[];
  /** Whether the page's structured data names its entity: nothing it needs is missing. */
  ready: boolean;
}

/** What each fact says when it is needed and missing. */
const MISSING: Partial<Record<StructuredFact, string>> = {
  serviceType: 'Say what kind of service it is.',
  price: 'Add the price.',
  currency: 'Add the currency.',
  startDate: 'Add when it starts.',
  venue: 'Add where it takes place: a venue or an address.',
  steps: 'Add at least one step.'
};

/**
 * A page's structured data as the website, the Inspector and the SEO audit all read it: its type, the facts that pass
 * their checks, and what keeps it from describing the page (a needed fact missing, a fact that can't be used). A
 * value edited in by hand that the Inspector would refuse is left out on its own and named as an issue.
 */
export function inspectPageStructuredData(raw: unknown): StructuredInspection {
  if (raw === undefined || raw === null) return { type: 'WebPage', facts: {}, issues: [], ready: true };
  if (!isRecord(raw) || !isPageStructuredType(raw.type) || raw.type === 'WebPage') {
    const what = isRecord(raw) && typeof raw.type === 'string' ? `“${raw.type}”` : 'saved';
    const issue: StructuredIssue = { field: 'type', message: `The ${what} page type is not one the editor knows: choose the page type again.`, blocking: true };
    return { type: 'WebPage', facts: {}, issues: [issue], ready: false };
  }
  const type = raw.type;
  const facts: StructuredInspection['facts'] = {};
  const issues: StructuredIssue[] = [];
  for (const key of STRUCTURED_FACTS[type]) {
    if (unsaid(key, raw[key])) continue;
    const c = checkFact(key, raw[key]);
    if (!c.ok) issues.push({ field: key, message: `The saved ${STRUCTURED_FACT_LABELS[key].toLowerCase()} can’t be used. ${c.message}`, blocking: false });
    else if (!isEmpty(c.value)) (facts as Record<string, unknown>)[key] = c.value;
  }
  const need = (key: StructuredFact, has: boolean) => {
    if (!has) issues.push({ field: key, message: MISSING[key]!, blocking: true });
  };
  if (type === 'Service') need('serviceType', !!facts.serviceType);
  if (type === 'Product') {
    need('price', !!facts.price);
    need('currency', !!facts.currency);
  }
  if (type === 'Event') {
    need('startDate', !!facts.startDate);
    need('venue', !!facts.venue || !!facts.address);
    if (facts.startDate && facts.endDate && endsBeforeStart(facts.startDate, facts.endDate)) issues.push({ field: 'endDate', message: 'It ends before it starts: correct the start or the end.', blocking: true });
  }
  if (type === 'HowTo') need('steps', !!facts.steps?.length);
  // In the order the Inspector shows the fields, so a hint reads top to bottom.
  const order = (i: StructuredIssue) => STRUCTURED_FACTS[type].indexOf(i.field as StructuredFact);
  issues.sort((a, b) => order(a) - order(b));
  return { type, facts, issues, ready: !issues.some((i) => i.blocking) };
}
