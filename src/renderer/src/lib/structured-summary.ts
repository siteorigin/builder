/**
 * A document's structured data in words (#706): one section of plain statements for each entity of the graph its
 * exported page writes (`documentGraph`), in the order a reader asks about them: the page, what it is about, its
 * sections, its place in the site, who publishes the site and the site itself. Everything said is read from the graph
 * alone, so nothing is claimed that the page doesn't carry; an entity or a value no section knows is still listed.
 */
import type { GraphNode, JsonValue, SeoGraph } from '@generator/seo-graph';
import { isArticleDate } from '@shared/articles';
import { PRODUCT_AVAILABILITY_LABELS } from '@shared/page-structured-data';

export interface SummaryRow {
  label: string;
  value: string;
}

/** Values that come as a list, in the order the graph gives them. */
export interface SummaryList {
  label: string;
  /** Whether their order means something (a trail, a guide's steps). */
  ordered: boolean;
  items: Array<{ text: string; detail?: string }>;
}

export interface GraphSection {
  /** The entity's `@id`. */
  id: string;
  /** What the section is about: "This page", "Blog post", "Publisher". */
  heading: string;
  /** What the entity says, as one sentence. */
  statement: string;
  /** What these facts are good for. */
  use?: string;
  rows: SummaryRow[];
  lists: SummaryList[];
}

type Obj = { [key: string]: JsonValue };

const isObject = (v: JsonValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const many = (v: JsonValue | undefined): JsonValue[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const typesOf = (n: Obj): string[] => many(n['@type']).filter((t): t is string => typeof t === 'string');

const DAY_TIME = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?)?$/;
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A date or time as the graph writes it, in words, with its time and offset kept as written (never moved to another zone). */
export function writtenDate(value: string): string {
  const m = DAY_TIME.exec(value);
  if (!m || !isArticleDate(m[1])) return value;
  const day = DAY.format(new Date(`${m[1]}T00:00:00Z`));
  if (!m[2]) return day;
  return `${day} at ${m[2]}${!m[3] ? '' : m[3] === 'Z' ? ' UTC' : ` (UTC${m[3]})`}`;
}

/** What each publisher type is called. */
const PUBLISHERS: Record<string, string> = { Organization: 'an organization', LocalBusiness: 'a local business', Person: 'a person' };
const PAGE_KINDS: Record<string, string> = { AboutPage: 'an About page', ContactPage: 'a Contact page', FAQPage: 'an FAQ page' };
const AVAILABILITY = PRODUCT_AVAILABILITY_LABELS as Record<string, string>;

/** "a, b and c". */
const joined = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] ?? ''));

/** A property's name in words: "openingHours" is "Opening hours". */
const labelOf = (key: string) => {
  const words = key.replace(/^@/, '').replace(/([a-z0-9])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`);
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Reads one graph's values in words: a reference is named by the entity it points to. */
function reader(graph: SeoGraph) {
  const nodes = new Map(graph['@graph'].map((n) => [n['@id'], n]));
  /** Any value in words: text as it is, an entity by its name, address or ID, and anything else by its properties. */
  const text = (v: JsonValue | undefined): string => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
    if (!isObject(v)) return String(v);
    const target = typeof v['@id'] === 'string' && Object.keys(v).length === 1 ? nodes.get(v['@id']) : undefined;
    const of: Obj = target ?? v;
    for (const key of ['name', 'url', 'address', 'urlTemplate']) if (typeof of[key] === 'string') return of[key] as string;
    if (typeof of['@id'] === 'string') return of['@id'];
    return Object.entries(of)
      .filter(([k]) => k !== '@type')
      .map(([k, x]) => `${labelOf(k)}: ${text(x)}`)
      .join('; ');
  };
  return text;
}

type Text = ReturnType<typeof reader>;

/**
 * One entity's rows as they are gathered. Each property read is marked, and whatever is left over at the end is listed
 * under its own name, so nothing the graph says goes unsaid.
 */
function gather(node: Obj, text: Text) {
  const rows: SummaryRow[] = [];
  const lists: SummaryList[] = [];
  const read = new Set(['@id', '@type']);
  const take = (key: string): JsonValue | undefined => {
    read.add(key);
    return node[key];
  };
  const row = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };
  const say = (label: string, key: string) => row(label, text(take(key)));
  const date = (label: string, key: string) => {
    const v = take(key);
    row(label, typeof v === 'string' ? writtenDate(v) : text(v));
  };
  const rest = () => {
    for (const key of Object.keys(node)) if (!read.has(key)) row(labelOf(key), text(node[key]));
    return { rows, lists };
  };
  return { rows, lists, take, row, say, date, rest };
}

/** The address of an image or entry point described in place. */
const addressOf = (v: JsonValue | undefined, text: Text) => (isObject(v) && typeof v.url === 'string' ? v.url : text(v));

type Section = Omit<GraphSection, 'id'>;

function publisherSection(node: GraphNode, text: Text): Section {
  const g = gather(node, text);
  const type = typesOf(node).find((t) => PUBLISHERS[t]) ?? 'Organization';
  const name = text(g.take('name'));
  g.row('Name', name);
  g.say('Home page', 'url');
  g.row(type === 'Person' ? 'Photo' : 'Logo', addressOf(g.take(type === 'Person' ? 'image' : 'logo'), text));
  const profiles = many(g.take('sameAs')).map(text);
  if (profiles.length) g.lists.push({ label: 'Profiles elsewhere', ordered: false, items: profiles.map((p) => ({ text: p })) });
  g.say('Address', 'address');
  g.say('Telephone', 'telephone');
  g.say('Email', 'email');
  g.say('Opening hours', 'openingHours');
  g.say('Price range', 'priceRange');
  const geo = g.take('geo');
  if (isObject(geo)) g.row('Map position', `${text(geo.latitude)}, ${text(geo.longitude)}`);
  return {
    heading: 'Publisher',
    statement: name ? `${name}, ${PUBLISHERS[type]}, publishes the site.` : `The site is published by ${PUBLISHERS[type]} with no name.`,
    use: 'Says who stands behind the site, and ties it to the same publisher elsewhere.',
    ...g.rest()
  };
}

function websiteSection(node: GraphNode, text: Text): Section {
  const g = gather(node, text);
  const name = text(g.take('name'));
  g.row('Name', name);
  g.say('Address', 'url');
  g.say('Description', 'description');
  g.say('Language', 'inLanguage');
  g.say('Published by', 'publisher');
  const search = g.take('potentialAction');
  if (isObject(search) && isObject(search.target)) {
    g.row('Search address', text(search.target.urlTemplate));
  } else g.row('Action', text(search));
  return {
    heading: 'Website',
    statement: name ? `This page is part of the website ${name}.` : 'This page is part of a website with no name.',
    use: 'Names the website its pages belong to.',
    ...g.rest()
  };
}

function pageSection(node: GraphNode, text: Text): Section {
  const g = gather(node, text);
  const kinds = typesOf(node).flatMap((t) => (t === 'WebPage' ? [] : [PAGE_KINDS[t] ?? t]));
  const name = text(g.take('name'));
  g.row('Title', name);
  g.say('Description', 'description');
  g.say('Address', 'url');
  g.say('Language', 'inLanguage');
  g.row('Image', addressOf(g.take('primaryImageOfPage'), text));
  g.date('Last updated', 'dateModified');
  g.say('About', 'about');
  // Both are said by their own sections.
  g.take('isPartOf');
  g.take('breadcrumb');
  const questions = many(g.take('mainEntity'));
  if (questions.length)
    g.lists.push({
      label: 'Questions and answers',
      ordered: true,
      items: questions.map((q) => {
        if (!isObject(q)) return { text: text(q) };
        const answer = isObject(q.acceptedAnswer) ? text(q.acceptedAnswer.text) : '';
        return { text: text(q.name), ...(answer ? { detail: answer } : {}) };
      })
    });
  return {
    heading: 'This page',
    statement: `This is ${kinds.length ? joined(kinds) : 'a web page'}.`,
    use: 'Search engines and AI answer engines read what this page is, what it is called and where it lives.',
    ...g.rest()
  };
}

function breadcrumbSection(node: GraphNode, text: Text): Section {
  const g = gather(node, text);
  const steps = many(g.take('itemListElement')).map((s) => (isObject(s) ? { text: text(s.name), detail: text(s.item) } : { text: text(s) }));
  if (steps.length) g.lists.push({ label: 'Trail', ordered: true, items: steps });
  return {
    heading: 'Breadcrumb trail',
    statement: steps.length ? steps.map((s) => s.text).join(' › ') : 'The trail is empty.',
    use: 'Shows where this page sits in the site.',
    ...g.rest()
  };
}

function articleSection(node: GraphNode, text: Text, type: 'BlogPosting' | 'Article'): Section {
  const g = gather(node, text);
  const headline = text(g.take('headline'));
  g.row('Headline', headline);
  g.say('Description', 'description');
  g.row('Author', text(g.take('author')));
  g.date('Published', 'datePublished');
  g.date('Last modified', 'dateModified');
  g.row('Image', addressOf(g.take('image'), text));
  g.say('Publisher', 'publisher');
  g.take('mainEntityOfPage');
  const what = type === 'BlogPosting' ? 'a blog post' : 'an article';
  return {
    heading: type === 'BlogPosting' ? 'Blog post' : 'Article',
    statement: headline ? `The page is about ${what}, “${headline}”.` : `The page is about ${what} with no headline.`,
    use: 'The headline, byline, dates and picture identify the piece of writing.',
    ...g.rest()
  };
}

/** A page's own service, product, event or guide: what each is called, and the sentence that says it. */
const ENTITIES: Record<string, { heading: string; what: string; use: string }> = {
  Service: { heading: 'Service', what: 'the service', use: 'The facts people compare services by.' },
  Product: { heading: 'Product', what: 'the product', use: 'The facts people compare products by: the price and who sells it.' },
  Event: { heading: 'Event', what: 'the event', use: 'When and where the event takes place, and who organizes it.' },
  HowTo: { heading: 'How-to guide', what: 'the how-to guide', use: 'The steps of the guide, in order.' }
};

function entitySection(node: GraphNode, text: Text, type: string): Section {
  const g = gather(node, text);
  const name = text(g.take('name'));
  g.row('Name', name);
  g.say('Description', 'description');
  g.take('mainEntityOfPage');
  if (type === 'Service') {
    g.say('Service type', 'serviceType');
    g.say('Area served', 'areaServed');
    g.say('Provided by', 'provider');
  }
  if (type === 'Product') {
    const offer = g.take('offers');
    if (isObject(offer)) {
      const o = gather(offer, text);
      o.row('Price', [text(o.take('price')), text(o.take('priceCurrency'))].filter(Boolean).join(' '));
      const availability = text(o.take('availability')).replace(/^https:\/\/schema\.org\//, '');
      o.row('Availability', AVAILABILITY[availability] ?? availability);
      o.say('Offer address', 'url');
      o.say('Sold by', 'seller');
      g.rows.push(...o.rest().rows);
    } else g.row('Offers', text(offer));
  }
  if (type === 'Event') {
    g.date('Starts', 'startDate');
    g.date('Ends', 'endDate');
    const place = g.take('location');
    if (isObject(place)) {
      const p = gather(place, text);
      p.say('Venue', 'name');
      p.say('Venue address', 'address');
      g.rows.push(...p.rest().rows);
    } else g.row('Location', text(place));
    g.say('Organized by', 'organizer');
  }
  if (type === 'HowTo') {
    const steps = many(g.take('step')).map((s) => ({ text: isObject(s) ? text(s.text) : text(s) }));
    if (steps.length) g.lists.push({ label: 'Steps', ordered: true, items: steps });
    g.say('Publisher', 'publisher');
  }
  const { heading, what, use } = ENTITIES[type];
  return { heading, statement: name ? `The page is about ${what} “${name}”.` : `The page is about ${what}, with no name.`, use, ...g.rest() };
}

/** A section of the page, such as a contact section: the details it shows, each group in its own rows. */
function elementSection(node: GraphNode, text: Text, heading: string): Section {
  const g = gather(node, text);
  g.take('isPartOf');
  const about = many(g.take('about'));
  const places = about.filter((a): a is Obj => isObject(a) && typesOf(a).includes('Place'));
  for (const a of about) {
    if (!isObject(a)) {
      g.row('About', text(a));
    } else if (typesOf(a).includes('ContactPoint')) {
      const c = gather(a, text);
      c.say('Email', 'email');
      c.say('Telephone', 'telephone');
      g.rows.push(...c.rest().rows);
    } else if (typesOf(a).includes('Place')) {
      const p = gather(a, text);
      const at = places.indexOf(a);
      p.say(places.length > 1 ? `Address ${at + 1}` : 'Address', 'address');
      g.rows.push(...p.rest().rows);
    } else g.row('About', text(a));
  }
  return { heading, statement: 'A section of this page that gives contact details.', use: 'Ties the contact details shown to the part of the page that shows them.', ...g.rest() };
}

function otherSection(node: GraphNode, text: Text): Section {
  const g = gather(node, text);
  const type = typesOf(node).join(', ');
  return { heading: type, statement: `The graph also describes an entity of the type ${type}.`, ...g.rest() };
}

/**
 * The graph as sections of plain statements, one for each of its entities. The page comes first, then what it is about
 * and its sections, its trail, the site's publisher and the website.
 */
export function summarizeGraph(graph: SeoGraph): GraphSection[] {
  const text = reader(graph);
  const website = graph['@graph'].find((n) => typesOf(n).includes('WebSite'));
  const publisherId = website && isObject(website.publisher) ? website.publisher['@id'] : undefined;
  const contacts = graph['@graph'].filter((n) => typesOf(n).includes('WebPageElement'));
  // Contact sections by the order the page shows them in: #contact, #contact-2, … #contact-10.
  const order = (n: GraphNode) => Number(/-(\d+)$/.exec(n['@id'])?.[1] ?? 1);
  contacts.sort((a, b) => order(a) - order(b));

  const described = graph['@graph'].map((node): { rank: number; at: number; section: Section } => {
    const types = typesOf(node);
    if (node['@id'] === publisherId) return { rank: 4, at: 0, section: publisherSection(node, text) };
    if (node === website) return { rank: 5, at: 0, section: websiteSection(node, text) };
    if (types.includes('WebPage')) return { rank: 0, at: 0, section: pageSection(node, text) };
    if (types.includes('BreadcrumbList')) return { rank: 3, at: 0, section: breadcrumbSection(node, text) };
    const article = types.includes('BlogPosting') ? 'BlogPosting' : types.includes('Article') ? 'Article' : null;
    if (article) return { rank: 1, at: 0, section: articleSection(node, text, article) };
    const entity = types.find((t) => Object.hasOwn(ENTITIES, t));
    if (entity) return { rank: 1, at: 0, section: entitySection(node, text, entity) };
    if (types.includes('WebPageElement')) {
      const at = contacts.indexOf(node);
      return { rank: 2, at, section: elementSection(node, text, contacts.length > 1 ? `Contact section ${at + 1}` : 'Contact section') };
    }
    return { rank: 2, at: contacts.length, section: otherSection(node, text) };
  });
  return described
    .map((d, i) => ({ ...d, id: graph['@graph'][i]['@id'] }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ id, section }) => ({ id, ...section }));
}
