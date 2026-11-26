/**
 * The kinds of source the app reads itself (#678): a REST or GraphQL API of any make, Contentful's Delivery API,
 * Sanity's Query API, Strapi (4 and 5) and WordPress's REST API. Each asks only its own server, through the transport,
 * with the secrets its settings name filled in where they say, and reads every record before the sync goes on.
 */
import type { SourceConfig, SourcePagination } from '@shared/types';
import { fillSecrets, readPath } from '@shared/source-paths';
import { AdapterError, type AdapterEnv, type ReadContext, type SourceAdapter } from './registry';
import { MAX_RECORDS } from './protocol';

/** Text with each `${secret:NAME}` filled in; a secret the store does not have stops the read. */
function filled(text: string, secrets: Readonly<Record<string, string>>): string {
  const r = fillSecrets(text, secrets);
  if (r.missing !== null) throw new AdapterError('auth', `no secret called ${r.missing} is saved on this computer`);
  return r.text;
}

function filledMap(m: Record<string, string> | undefined, secrets: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, filled(v, secrets)]));
}

/** Every string inside `v`, filled in. */
function filledDeep(v: unknown, secrets: Readonly<Record<string, string>>): unknown {
  if (typeof v === 'string') return filled(v, secrets);
  if (Array.isArray(v)) return v.map((x) => filledDeep(x, secrets));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, filledDeep(x, secrets)]));
  return v;
}

/** A credential slot's secret, by the name the settings give it. */
function slotSecret(config: SourceConfig, slot: string, secrets: Readonly<Record<string, string>>): string | undefined {
  const name = config.credentials?.[slot]?.$secret;
  if (name === undefined) return undefined;
  if (!Object.hasOwn(secrets, name)) throw new AdapterError('auth', `no secret called ${name} is saved on this computer`);
  return secrets[name];
}

const bearer = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** The address `base` with `path` under it, keeping any path the base has ("https://site.example/blog"). */
function under(base: string, path: string): URL {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return u;
}

const originOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? '').origin;
  } catch {
    throw new AdapterError('invalid', 'its address cannot be read');
  }
};

/** Records gathered page by page, never more than a sync takes. */
function gather(into: unknown[], page: unknown[]) {
  into.push(...page);
  if (into.length > MAX_RECORDS) throw new AdapterError('too-large', `it has more than ${MAX_RECORDS} records`);
}

/** The list of records in a reply: at `path`, or the reply itself. Anything else stops the read, so nothing is read as gone. */
function listAt(body: unknown, path: string | undefined, what = path ?? 'the reply'): unknown[] {
  const v = path ? readPath(body, path) : body;
  if (!Array.isArray(v)) throw new AdapterError('invalid', `there is no list of records at ${what}`);
  return v;
}

/**
 * The next page's address from a `Link` header (`<…>; rel="next"`), or null: read link by link, an address or a
 * quoted parameter holding commas included.
 */
function linkNext(header: string | null): string | null {
  const h = header ?? '';
  for (let i = h.indexOf('<'); i >= 0 && i < h.length; ) {
    const close = h.indexOf('>', i);
    if (close < 0) return null;
    const target = h.slice(i + 1, close);
    // Its parameters, up to the comma that ends the link (none inside quotes).
    let j = close + 1;
    let quoted = false;
    for (; j < h.length; j++) {
      if (h[j] === '"' && h[j - 1] !== '\\') quoted = !quoted;
      else if (h[j] === ',' && !quoted) break;
    }
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(h.slice(close + 1, j));
    if (rel && (rel[1] ?? rel[2]).toLowerCase().split(/\s+/).includes('next')) return target;
    const next = h.indexOf('<', j);
    if (next < 0) return null;
    i = next;
  }
  return null;
}

/** Whether a page brought exactly the records the last did: a server asked past its last page that sends it again. */
const samePage = (a: unknown[] | null, b: unknown[]) => !!a && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

const rest: SourceAdapter = {
  origin: (config) => originOf(config.url),
  headers: (config, secrets) => filledMap(config.headers, secrets),
  async items({ config, secrets, transport }) {
    const pagination: SourcePagination = config.pagination ?? { type: 'none' };
    const headers = filledMap(config.headers, secrets);
    const query = filledMap(config.query, secrets);
    const method = config.method ?? 'GET';
    // Each secret in the JSON sent written as JSON writes it, so a quote in one never ends its string.
    const body = method === 'POST' && config.body !== undefined ? filled(config.body, Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)]))) : undefined;
    const address = (extra: Record<string, string>) => {
      const u = new URL(config.url!);
      for (const [k, v] of Object.entries({ ...query, ...extra })) u.searchParams.set(k, v);
      return u.href;
    };
    const out: unknown[] = [];
    const ask = (url: string) => transport.json(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    switch (pagination.type) {
      case 'none': {
        const r = await ask(address({}));
        gather(out, listAt(r.body, config.itemsPath));
        return out;
      }
      // Read until a page brings nothing: a server may send fewer than asked on every page, not only the last. One that
      // sends its last page again for any page past it has nothing more.
      case 'page': {
        let last: unknown[] | null = null;
        for (let n = pagination.start ?? 1; ; n++) {
          // A server with no page that far says so with 404 (as Django REST Framework does): there are no more.
          const r = await ask(address({ [pagination.param]: String(n), ...(pagination.sizeParam ? { [pagination.sizeParam]: String(pagination.size) } : {}) })).catch((e: unknown) => {
            if (last && (e as { status?: unknown }).status === 404) return null;
            throw e;
          });
          if (!r) return out;
          const page = listAt(r.body, config.itemsPath);
          if (!page.length || samePage(last, page)) return out;
          gather(out, page);
          last = page;
        }
      }
      case 'offset': {
        let last: unknown[] | null = null;
        for (let at = 0; ; ) {
          const r = await ask(address({ [pagination.param]: String(at), ...(pagination.limitParam ? { [pagination.limitParam]: String(pagination.limit) } : {}) }));
          const page = listAt(r.body, config.itemsPath);
          if (!page.length || samePage(last, page)) return out;
          gather(out, page);
          last = page;
          at += page.length;
        }
      }
      case 'cursor': {
        const seen = new Set<string>();
        let cursor: string | null = null;
        for (;;) {
          const r = await ask(address(cursor !== null ? { [pagination.param]: cursor } : {}));
          gather(out, listAt(r.body, config.itemsPath));
          const next = readPath(r.body, pagination.cursorPath);
          if (next === undefined || next === null || next === '' || next === false) return out;
          if (typeof next !== 'string' && typeof next !== 'number') throw new AdapterError('invalid', `the next cursor at ${pagination.cursorPath} is not text`);
          cursor = String(next);
          if (seen.has(cursor)) throw new AdapterError('invalid', 'its pages go round in a circle');
          seen.add(cursor);
        }
      }
      case 'nextLink': {
        const seen = new Set<string>();
        let url = address({});
        for (;;) {
          seen.add(url);
          const r = await ask(url);
          gather(out, listAt(r.body, config.itemsPath));
          const next = pagination.path ? readPath(r.body, pagination.path) : linkNext(r.headers.get('link'));
          if (next === undefined || next === null || next === '') return out;
          if (typeof next !== 'string') throw new AdapterError('invalid', `the next page’s address at ${pagination.path} is not text`);
          try {
            url = new URL(next, r.url).href;
          } catch {
            throw new AdapterError('invalid', 'the next page’s address cannot be read');
          }
          if (seen.has(url)) throw new AdapterError('invalid', 'its pages go round in a circle');
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

/** The first list a GraphQL reply's data holds, one field down: `{ data: { posts: [...] } }`. */
function firstList(body: unknown): unknown[] {
  const data = readPath(body, 'data');
  if (data && typeof data === 'object' && !Array.isArray(data)) for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  throw new AdapterError('invalid', 'the reply’s data holds no list of records; say where it is (itemsPath)');
}

const graphql: SourceAdapter = {
  origin: (config) => originOf(config.url),
  headers: (config, secrets) => filledMap(config.headers, secrets),
  async items({ config, secrets, transport }) {
    const variables = filledDeep(config.variables ?? {}, secrets);
    const r = await transport.json(config.url!, { method: 'POST', headers: filledMap(config.headers, secrets), body: JSON.stringify({ query: config.graphql, variables }) });
    // An answer with errors is no full read, whatever data came with it.
    const errors = readPath(r.body, 'errors');
    if (Array.isArray(errors) && errors.length) {
      const first = readPath(errors[0], 'message');
      // Cut only well past what is shown and the longest secret kept, so the secrets are taken out (see run.ts) before
      // the cut that is.
      throw new AdapterError('failed', `the GraphQL server answered with an error${typeof first === 'string' ? `: ${first.slice(0, 20_000)}` : ''}`);
    }
    const out: unknown[] = [];
    gather(out, config.itemsPath ? listAt(r.body, config.itemsPath) : firstList(r.body));
    // A connection that says it has more than one request read is not the whole of the source: at any level above its
    // list, the reply's data itself included.
    const steps = (config.itemsPath ?? 'data').split('.');
    for (let n = steps.length; n >= 1; n--)
      if (readPath(r.body, `${steps.slice(0, n).join('.')}.pageInfo.hasNextPage`) === true) throw new AdapterError('too-large', 'the GraphQL reply has more pages than one query reads: ask for every record at once');
    if (!config.itemsPath) {
      const data = readPath(r.body, 'data');
      for (const v of data && typeof data === 'object' ? Object.values(data) : [])
        if (readPath(v, 'pageInfo.hasNextPage') === true) throw new AdapterError('too-large', 'the GraphQL reply has more pages than one query reads: ask for every record at once');
    }
    return out;
  }
};

// ---------------------------------------------------------------------------
// Contentful
// ---------------------------------------------------------------------------

type Link = { sys: { type: 'Link'; linkType: string; id: string } };
const isLink = (v: unknown): v is Link => {
  const sys = (v as { sys?: { type?: unknown; linkType?: unknown; id?: unknown } } | null)?.sys;
  return !!sys && sys.type === 'Link' && typeof sys.linkType === 'string' && typeof sys.id === 'string';
};

/**
 * Every link in `v` to an entry or asset the reply includes, replaced by it, links within those too, to a few steps
 * deep and never round a circle. An asset's protocol-relative address is given its https.
 */
export function resolveContentfulLinks(v: unknown, index: Map<string, unknown>, depth = 0, path: ReadonlySet<string> = new Set()): unknown {
  if (depth > 6) return v;
  if (isLink(v)) {
    const key = `${v.sys.linkType}:${v.sys.id}`;
    const target = index.get(key);
    if (target === undefined || path.has(key)) return v;
    return resolveContentfulLinks(target, index, depth + 1, new Set([...path, key]));
  }
  if (Array.isArray(v)) return v.map((x) => resolveContentfulLinks(x, index, depth, path));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'url' && typeof x === 'string' && x.startsWith('//') ? `https:${x}` : resolveContentfulLinks(x, index, depth, path);
    return out;
  }
  return v;
}

const CONTENTFUL = 'https://cdn.contentful.com';

const contentful: SourceAdapter = {
  origin: (_config, env: AdapterEnv) => originOf(env.endpoints?.contentful ?? CONTENTFUL),
  headers: (config, secrets) => bearer(slotSecret(config, 'token', secrets)),
  async items({ config, secrets, transport, env }) {
    const headers = bearer(slotSecret(config, 'token', secrets));
    const items: unknown[] = [];
    const index = new Map<string, unknown>();
    const limit = 100;
    for (let skip = 0; ; ) {
      const u = under(env.endpoints?.contentful ?? CONTENTFUL, `spaces/${encodeURIComponent(config.spaceId!)}/environments/${encodeURIComponent(config.environment ?? 'master')}/entries`);
      for (const [k, v] of Object.entries({ content_type: config.contentType!, limit: String(limit), skip: String(skip), include: '2', order: 'sys.createdAt' })) u.searchParams.set(k, v);
      const r = await transport.json(u.href, { headers });
      const page = listAt(r.body, 'items', 'items');
      const total = readPath(r.body, 'total');
      const at = readPath(r.body, 'skip');
      // Only a reply that says how many there are, and where it starts, can say the read is whole.
      if (!Number.isInteger(total) || (total as number) < 0 || at !== skip) throw new AdapterError('invalid', 'Contentful did not say how many entries there are, or where its reply starts');
      if (page.length > (total as number) - skip) throw new AdapterError('invalid', 'Contentful sent more entries than it says it has');
      if (!page.length && skip < (total as number)) throw new AdapterError('failed', 'Contentful stopped before its last entry');
      gather(items, page);
      const included = (kind: string) => readPath(r.body, `includes.${kind}`);
      for (const kind of ['Entry', 'Asset'] as const) for (const x of Array.isArray(included(kind)) ? (included(kind) as unknown[]) : []) if (typeof readPath(x, 'sys.id') === 'string') index.set(`${kind}:${readPath(x, 'sys.id')}`, x);
      for (const x of page) if (typeof readPath(x, 'sys.id') === 'string') index.set(`Entry:${readPath(x, 'sys.id')}`, x);
      skip += page.length;
      if (skip >= (total as number)) break;
    }
    return items.map((x) => resolveContentfulLinks(x, index));
  }
};

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

const sanityBase = (config: SourceConfig, env: AdapterEnv, signed: boolean) => env.endpoints?.sanity ?? `https://${config.projectId}.${signed ? 'api' : 'apicdn'}.sanity.io`;

const sanity: SourceAdapter = {
  origin: (config, env) => originOf(sanityBase(config, env, !!config.credentials?.token)),
  headers: (config, secrets) => bearer(slotSecret(config, 'token', secrets)),
  async items({ config, secrets, transport, env }) {
    const token = slotSecret(config, 'token', secrets);
    const u = under(sanityBase(config, env, !!token), `v2021-10-21/data/query/${encodeURIComponent(config.dataset!)}`);
    u.searchParams.set('query', config.groq!);
    const r = await transport.json(u.href, { headers: bearer(token) });
    const out: unknown[] = [];
    // A draft (or a release's version) of a document is never one the site shows, whatever the token may read.
    gather(out, listAt(r.body, 'result', 'result (the query must give a list)').filter((x) => !/^(drafts|versions)\./.test(String(readPath(x, '_id') ?? ''))));
    return out;
  }
};

// ---------------------------------------------------------------------------
// Strapi
// ---------------------------------------------------------------------------

/**
 * A Strapi 4 reply as Strapi 5 writes it: `{ id, attributes: {...} }` is `{ id, ...attributes }`, and a relation's or
 * a picture's `{ data: ... }` is what it holds. A media file's address on the server itself is made whole.
 */
export function flattenStrapi(v: unknown, origin: string, depth = 0): unknown {
  if (depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => flattenStrapi(x, origin, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === 'data' && (o.data === null || typeof o.data === 'object')) return flattenStrapi(o.data, origin, depth + 1);
  if (o.attributes && typeof o.attributes === 'object' && !Array.isArray(o.attributes)) {
    const { attributes, ...rest } = o;
    return flattenStrapi({ ...rest, ...(attributes as Record<string, unknown>) }, origin, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = k === 'url' && typeof x === 'string' && x.startsWith('/') && !x.startsWith('//') ? `${origin}${x}` : flattenStrapi(x, origin, depth + 1);
  return out;
}

const strapi: SourceAdapter = {
  origin: (config) => originOf(config.url),
  headers: (config, secrets) => bearer(slotSecret(config, 'token', secrets)),
  // Strapi 5's documentId is the record's own across its versions; Strapi 4 has only its number.
  async items({ config, secrets, transport }) {
    const headers = bearer(slotSecret(config, 'token', secrets));
    const out: unknown[] = [];
    const origin = originOf(config.url);
    for (let page = 1; ; page++) {
      const u = under(config.url!, `api/${encodeURIComponent(config.resource!)}`);
      for (const [k, v] of Object.entries({ 'pagination[page]': String(page), 'pagination[pageSize]': '100', populate: '*' })) u.searchParams.set(k, v);
      const r = await transport.json(u.href, { headers });
      const items = listAt(r.body, 'data', 'data').map((x) => {
        const flat = flattenStrapi(x, origin) as Record<string, unknown>;
        const key = typeof flat.documentId === 'string' ? flat.documentId : flat.id;
        // Strapi names no field with a $, so none of a record's own can stand in for who it is.
        return { ...flat, $key: typeof key === 'number' ? String(key) : key };
      });
      const pages = readPath(r.body, 'meta.pagination.pageCount');
      // Only a count of pages says the read is whole: records with none, or with a count they do not fit, may not be all.
      if (items.length && (!Number.isInteger(pages) || (pages as number) < page)) throw new AdapterError('invalid', 'Strapi did not say how many pages there are');
      if (!items.length && Number.isInteger(pages) && page < (pages as number)) throw new AdapterError('failed', 'Strapi stopped before its last page');
      gather(out, items);
      if (!items.length || page >= (pages as number)) return out;
    }
  }
};

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------

/** A WordPress post as a mapping reads it: its words as text, its featured image and author by what they are. */
export function wordpressView(p: unknown): Record<string, unknown> {
  const o = (p ?? {}) as Record<string, unknown>;
  const rendered = (k: string) => {
    const v = readPath(o, `${k}.rendered`);
    return typeof v === 'string' ? v : typeof o[k] === 'string' ? (o[k] as string) : undefined;
  };
  const media = readPath(o, '_embedded.wp:featuredmedia.0');
  const author = readPath(o, '_embedded.author.0.name');
  const terms = (readPath(o, '_embedded.wp:term') as unknown[] | undefined)?.flat() ?? [];
  const named = (taxonomy: string) => terms.flatMap((t) => (readPath(t, 'taxonomy') === taxonomy && typeof readPath(t, 'name') === 'string' ? [readPath(t, 'name') as string] : []));
  return {
    id: typeof o.id === 'number' ? String(o.id) : o.id,
    slug: o.slug,
    link: o.link,
    date: o.date_gmt ?? o.date,
    modified: o.modified_gmt ?? o.modified,
    draft: o.status !== undefined && o.status !== 'publish',
    // As WordPress renders them: an entry's title and excerpt are read as text once, as any source's are (mapping.ts).
    title: rendered('title') ?? '',
    excerpt: rendered('excerpt') ?? '',
    content: rendered('content') ?? '',
    ...(typeof author === 'string' ? { author } : {}),
    ...(media && typeof readPath(media, 'source_url') === 'string' ? { featuredImage: { url: readPath(media, 'source_url'), alt: readPath(media, 'alt_text') ?? '' } } : {}),
    categories: named('category'),
    tags: named('post_tag'),
    ...(o.acf && typeof o.acf === 'object' ? { acf: o.acf } : {}),
    ...(o.meta && typeof o.meta === 'object' ? { meta: o.meta } : {})
  };
}

const wordpress: SourceAdapter = {
  origin: (config) => originOf(config.url),
  async items({ config, transport }) {
    const out: unknown[] = [];
    for (let page = 1; ; page++) {
      const u = under(config.url!, `wp-json/wp/v2/${encodeURIComponent(config.resource ?? 'posts')}`);
      for (const [k, v] of Object.entries({ per_page: '100', page: String(page), _embed: '1' })) u.searchParams.set(k, v);
      const r = await transport.json(u.href);
      const items = listAt(r.body, undefined, 'the reply').map(wordpressView);
      const header = r.headers.get('x-wp-totalpages');
      const pages = header === null || !/^\d+$/.test(header.trim()) ? NaN : Number(header);
      // Only a count of pages says the read is whole: posts with none, or with a count they do not fit, may not be all.
      if (items.length && (!Number.isFinite(pages) || pages < page)) throw new AdapterError('invalid', 'the site did not say how many pages of posts it has');
      if (!items.length && Number.isFinite(pages) && page < pages) throw new AdapterError('failed', 'the site stopped before its last page of posts');
      gather(out, items);
      if (!items.length || page >= pages) return out;
    }
  }
};

export const ADAPTERS: Readonly<Record<string, SourceAdapter>> = Object.freeze({ rest, graphql, contentful, sanity, strapi, wordpress });

export type { ReadContext };
