/**
 * External sources: where a synced collection's entries come from (a CMS, an API), each described by
 * `siteorigin/sources/<sourceId>/source.json`. A source's settings are part of the project and travel with it, so they
 * never hold a credential: a credential is named (`{ "$secret": "team-read" }`) and its value is kept in the user's
 * own `source-secrets.json`, outside the project (see main/sources/secrets.ts).
 */
import type { SourceDoc, SourceMapping, SourceRemoval } from './types';
import { isCollectionId } from './collections';
import { interpolatedSecretNames, isPath, secretTemplateProblem } from './source-paths';

/** A source's ID and folder name: a lowercase slug, like a collection's. */
export const isSourceId = (id: unknown): id is string => isCollectionId(id);

/** What happens to an entry whose record the source no longer has. Absent: `unpublish`. */
export const SOURCE_REMOVALS: readonly SourceRemoval[] = ['unpublish', 'remove', 'keep'];

/** The removal a source asks for: its own, or `unpublish`, which keeps every link to the entry working. */
export function sourceRemoval(doc: { removal?: unknown } | undefined): SourceRemoval {
  return SOURCE_REMOVALS.includes(doc?.removal as SourceRemoval) ? (doc!.removal as SourceRemoval) : 'unpublish';
}

/** A kind of source, as a source names it: a lowercase word ("rest", "contentful"). */
export const isAdapterId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id);

/** A secret's name, and a credential slot's: a letter, then letters, numbers, hyphens and underscores. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const isSecretName = (name: unknown): name is string => typeof name === 'string' && NAME_RE.test(name) && !(name in Object.prototype);

/** A setting that names a secret instead of holding its value: exactly `{ "$secret": "<name>" }`. */
export function isSecretRef(v: unknown): v is { $secret: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && isSecretName((v as { $secret?: unknown }).$secret);
}

/** Every string a source's settings send that may name a secret with `${secret:NAME}`: header, query, body and variable values. */
export function templatedValues(config: SourceDoc['config'] | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (typeof v === 'string') out.push(v);
    else if (depth < 8 && v && typeof v === 'object') for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  for (const k of ['headers', 'query', 'variables'] as const) walk(config?.[k], 0);
  if (typeof config?.body === 'string') out.push(config.body);
  return out;
}

/** Every secret a source's settings name, by credential slot or by `${secret:NAME}`, once each, sorted. */
export function sourceSecretNames(doc: Pick<SourceDoc, 'config'>): string[] {
  const creds = doc.config?.credentials ?? {};
  const slots = Object.values(creds).flatMap((r) => (isSecretRef(r) ? [r.$secret] : []));
  return [...new Set([...slots, ...templatedValues(doc.config).flatMap(interpolatedSecretNames)])].filter(isSecretName).sort();
}

/** The longest name a source shows. */
export const MAX_SOURCE_NAME = 120;
/** The most credentials a source names. */
const MAX_CREDENTIALS = 20;
const SOURCE_DOC_KEYS = new Set(['schemaVersion', 'id', 'name', 'adapter', 'collectionId', 'config', 'mapping', 'converter', 'removal']);

/** The longest converter a source keeps, as the longest code a component keeps. */
export const MAX_CONVERTER = 60_000;
/** The converter's file, beside its source's settings. */
export const CONVERTER_FILE = 'converter.mjs';

/** What each kind of source takes in its settings, which it needs, and the credential slots it signs in with. */
export interface AdapterSpec {
  label: string;
  keys: readonly string[];
  required: readonly string[];
  /** Credential slots it reads, and whether it needs them. */
  credentials: Readonly<Record<string, 'required' | 'optional'>>;
  /** Its own reading of a record's details, which a source's mapping changes detail by detail. */
  defaults: Readonly<SourceMapping>;
}

export const SOURCE_ADAPTERS: Readonly<Record<string, AdapterSpec>> = Object.freeze({
  rest: { label: 'REST / JSON API', keys: ['url', 'method', 'headers', 'query', 'body', 'itemsPath', 'pagination'], required: ['url'], credentials: {}, defaults: { externalId: 'id', title: 'title', slug: 'slug' } },
  graphql: { label: 'GraphQL API', keys: ['url', 'headers', 'graphql', 'variables', 'itemsPath'], required: ['url', 'graphql'], credentials: {}, defaults: { externalId: 'id', title: 'title', slug: 'slug' } },
  contentful: {
    label: 'Contentful',
    keys: ['spaceId', 'environment', 'contentType'],
    required: ['spaceId', 'contentType'],
    credentials: { token: 'required' },
    defaults: { externalId: 'sys.id', title: 'fields.title', slug: 'fields.slug', publishedAt: 'sys.createdAt', updatedAt: 'sys.updatedAt', body: 'fields.body', bodyFormat: 'contentful' }
  },
  sanity: {
    label: 'Sanity',
    keys: ['projectId', 'dataset', 'groq'],
    required: ['projectId', 'dataset', 'groq'],
    credentials: { token: 'optional' },
    defaults: { externalId: '_id', title: 'title', slug: 'slug.current', publishedAt: '_createdAt', updatedAt: '_updatedAt' }
  },
  // Strapi 5's documentId is a record's own across its versions; Strapi 4 has only its number. Each is read as `$key`.
  strapi: { label: 'Strapi', keys: ['url', 'resource'], required: ['url', 'resource'], credentials: { token: 'optional' }, defaults: { externalId: '$key', title: 'title', slug: 'slug', publishedAt: 'publishedAt', updatedAt: 'updatedAt' } },
  wordpress: {
    label: 'WordPress',
    keys: ['url', 'resource'],
    required: ['url'],
    credentials: {},
    defaults: { externalId: 'id', title: 'title', slug: 'slug', publishedAt: 'date', updatedAt: 'modified', draft: 'draft', excerpt: 'excerpt', author: 'author', featuredImageUrl: 'featuredImage.url', featuredImageAlt: 'featuredImage.alt', body: 'content', bodyFormat: 'html' }
  }
});

/** The mapping a source of kind `adapter` reads its records by: its own over the kind's. */
export function effectiveMapping(adapter: string, mapping: SourceMapping | undefined): SourceMapping {
  const base = isBuiltInAdapter(adapter) ? SOURCE_ADAPTERS[adapter].defaults : {};
  return { ...base, ...(mapping ?? {}), values: { ...(base.values ?? {}), ...(mapping?.values ?? {}) } };
}

/** Whether `adapter` is a kind of source the app reads itself. */
export const isBuiltInAdapter = (adapter: unknown): boolean => typeof adapter === 'string' && Object.hasOwn(SOURCE_ADAPTERS, adapter);

/** The words in a header, query or JSON name that carry a credential, whose value must name a secret instead of holding one. */
const SENSITIVE_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pass', 'pwd', 'auth', 'authorization', 'session', 'cookie', 'signature', 'sig', 'credential', 'credentials', 'bearer', 'jwt']);

/** Whether a name carries a credential, by its words: `X-API-Key`, `access_token`, `apiKey`, but never `keyword`. */
export function isSensitiveName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => SENSITIVE_WORDS.has(w)) || SENSITIVE_WORDS.has(words.join(''));
}
const SENSITIVE_NAME = { test: isSensitiveName };

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAPPING_KEYS = new Set(['externalId', 'title', 'slug', 'publishedAt', 'updatedAt', 'draft', 'author', 'excerpt', 'featuredImageUrl', 'featuredImageAlt', 'body', 'bodyFormat', 'values']);
const BODY_FORMATS = new Set(['text', 'html', 'markdown', 'contentful']);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with a web address a source reads, or null. */
export function sourceUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return 'its address is missing or too long.';
  if (url.includes('${')) return 'its address names a secret: send a secret in a header or a query value instead.';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'its address cannot be read.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'its address is not a web address.';
  if (u.username || u.password) return 'its address signs in: name a secret in a header instead.';
  if (u.hash) return 'its address has a # part, which a server never reads.';
  for (const [k] of u.searchParams) if (SENSITIVE_NAME.test(k)) return `its address carries a credential (${k.slice(0, 40)}): name a secret in its query values instead.`;
  return null;
}

/**
 * What is wrong with a header or query value of a source, or null: a value under a name that carries a credential must
 * be `${secret:NAME}` (with, for a header, an optional scheme word before it: "Bearer ${secret:api}"), so no credential is
 * ever written into the settings, however it is spelled beside a secret's name.
 */
function sentValueProblem(name: string, value: unknown, header: boolean): string | null {
  if (typeof value !== 'string' || value.length > 4000 || /[\r\n\0]/.test(value)) return `the value of ${name.slice(0, 40)} is not one line of text.`;
  const template = secretTemplateProblem(value);
  if (template) return template;
  if (!SENSITIVE_NAME.test(name)) return null;
  const rest = value.replace(/\$\{secret:[^}]*\}/g, '');
  const named = rest !== value;
  if (!named || !(header ? /^\s*(?:[A-Za-z][A-Za-z-]{0,20}\s+)?$/ : /^$/).test(rest))
    return `${name.slice(0, 40)} carries a credential, so its value must name a secret: ${header ? '"Bearer ${secret:NAME}"' : '"${secret:NAME}"'}. Keep the value itself as a secret.`;
  return null;
}

/**
 * What is wrong with what a source sends as JSON (a POST body, GraphQL variables), or null: a value under any key that
 * carries a credential, at any depth, names a secret as a query value must.
 */
function sentJsonProblem(v: unknown, depth = 0, under: string | null = null): string | null {
  if (depth > 12) return 'what it sends is nested too deeply to be checked for credentials.';
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = sentJsonProblem(x, depth + 1, under);
      if (p) return p;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = sentJsonProblem(x, depth + 1, isSensitiveName(k) ? k : null);
      if (p) return p;
    }
    return null;
  }
  // A value under a name that carries a credential, at any depth and in a list too, names a secret: never a number
  // or text of its own.
  if (under === null || v === null || typeof v === 'boolean') return null;
  return typeof v === 'string' ? sentValueProblem(under, v, false) : `${under.slice(0, 40)} carries a credential, so its value must name a secret: "\${secret:NAME}". Keep the value itself as a secret.`;
}

function sentMapProblem(v: unknown, what: string, header: boolean): string | null {
  if (v === undefined) return null;
  if (!isPlain(v) || Object.keys(v).length > 30) return `its ${what} are damaged or too many.`;
  for (const [k, x] of Object.entries(v)) {
    if (header ? !HEADER_NAME.test(k) : !k || k.length > 100) return `one of its ${what} has a name a ${header ? 'header' : 'query parameter'} cannot have.`;
    if (header && /^(host|content-length|transfer-encoding|connection)$/i.test(k)) return `its ${what} set ${k}, which the app sets itself.`;
    const p = sentValueProblem(k, x, header);
    if (p) return p;
  }
  return null;
}

/** Why a GraphQL document is not one a source may send, or null: it only reads, with no mutation or subscription. */
export function graphqlReadProblem(doc: unknown): string | null {
  if (typeof doc !== 'string' || !doc.trim() || doc.length > 20_000) return 'its GraphQL query is missing or too long.';
  // Comments and strings say nothing about what it does: read as GraphQL reads them, one after another.
  const bare = graphqlCode(doc);
  if (bare === null) return 'its GraphQL query has a string that never ends.';
  if (/\b(mutation|subscription)\b/.test(bare)) return 'its GraphQL query changes or watches data. A source only reads, so it may only ask a query.';
  if (!/^\s*(\{|query\b|fragment\b)/.test(bare)) return 'its GraphQL query does not start with a query.';
  return null;
}

/** A GraphQL document without its comments and strings (each string left as ""), or null when one never ends. */
function graphqlCode(doc: string): string | null {
  let out = '';
  for (let i = 0; i < doc.length; ) {
    const c = doc[i];
    if (c === '#') {
      while (i < doc.length && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (doc.startsWith('"""', i)) {
      const end = (() => {
        for (let j = i + 3; j < doc.length; j++) {
          if (doc[j] === '\\' && doc.startsWith('"""', j + 1)) j += 3;
          else if (doc.startsWith('"""', j)) return j;
        }
        return -1;
      })();
      if (end < 0) return null;
      out += '""';
      i = end + 3;
    } else if (c === '"') {
      let j = i + 1;
      while (j < doc.length && doc[j] !== '"' && doc[j] !== '\n' && doc[j] !== '\r') j += doc[j] === '\\' ? 2 : 1;
      if (doc[j] !== '"') return null;
      out += '""';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function paginationProblem(p: unknown): string | null {
  if (p === undefined) return null;
  if (!isPlain(p)) return 'its pages are damaged.';
  const param = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100;
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  const keys = (allowed: string[]) => Object.keys(p).every((k) => k === 'type' || allowed.includes(k));
  switch (p.type) {
    case 'none':
      return keys([]) ? null : 'its pages have a setting no kind of page takes.';
    case 'page':
      return keys(['param', 'sizeParam', 'size', 'start']) && param(p.param) && (p.sizeParam === undefined || param(p.sizeParam)) && int(p.size, 1, 1000) && (p.start === undefined || int(p.start, 0, 1_000_000))
        ? null
        : 'its pages by number need the parameter they are asked by and how many each holds (1 to 1000).';
    case 'offset':
      return keys(['param', 'limitParam', 'limit']) && param(p.param) && (p.limitParam === undefined || param(p.limitParam)) && int(p.limit, 1, 1000)
        ? null
        : 'its pages by offset need the parameter they are asked by and how many each holds (1 to 1000).';
    case 'cursor':
      return keys(['param', 'cursorPath']) && param(p.param) && isPath(p.cursorPath) ? null : 'its pages by cursor need the parameter they are asked by and where each reply gives the next cursor.';
    case 'nextLink':
      return keys(['path']) && (p.path === undefined || isPath(p.path)) ? null : 'its pages by link need where each reply gives the next page’s address.';
    default:
      return 'its pages are not none, page, offset, cursor or nextLink.';
  }
}

/** What is wrong with a kind of source's own settings, or null. */
function adapterConfigProblem(adapter: string, config: Record<string, unknown>): string | null {
  const spec = SOURCE_ADAPTERS[adapter];
  for (const k of Object.keys(config)) if (k !== 'credentials' && !spec.keys.includes(k)) return `its settings have one a ${spec.label} source does not take (${k.slice(0, 40)}).`;
  for (const k of spec.required) if (config[k] === undefined || config[k] === '') return `its settings need ${k}.`;
  const creds = (config.credentials ?? {}) as Record<string, unknown>;
  for (const slot of Object.keys(creds)) if (!Object.hasOwn(spec.credentials, slot)) return `it names a credential a ${spec.label} source does not sign in with.`;
  for (const [slot, need] of Object.entries(spec.credentials)) if (need === 'required' && !Object.hasOwn(creds, slot)) return `it needs a secret to sign in with (${slot}).`;
  if (config.url !== undefined) {
    const p = sourceUrlProblem(config.url);
    if (p) return p;
  }
  if (config.method !== undefined && config.method !== 'GET' && config.method !== 'POST') return 'it is asked with neither GET nor POST. A source only reads.';
  if (config.body !== undefined) {
    if (typeof config.body !== 'string' || config.body.length > 20_000 || config.method !== 'POST') return 'what it sends is not text sent with POST.';
    const t = secretTemplateProblem(config.body);
    if (t) return t;
    let sent: unknown = undefined;
    try {
      sent = JSON.parse(config.body);
    } catch {
      return 'what it sends with POST is not JSON.';
    }
    const p = sentJsonProblem(sent);
    if (p) return p;
  }
  const sent = sentMapProblem(config.headers, 'headers', true) ?? sentMapProblem(config.query, 'query parameters', false);
  if (sent) return sent;
  if (config.itemsPath !== undefined && !isPath(config.itemsPath)) return 'where its records are in a reply is not a path ("data.items").';
  const pages = paginationProblem(config.pagination);
  if (pages) return pages;
  if (config.graphql !== undefined) {
    const g = graphqlReadProblem(config.graphql);
    if (g) return g;
  }
  if (config.variables !== undefined) {
    if (!isPlain(config.variables) || JSON.stringify(config.variables).length > 20_000) return 'its GraphQL variables are damaged or too long.';
    for (const v of templatedValues({ variables: config.variables })) {
      const p = secretTemplateProblem(v);
      if (p) return p;
    }
    const p = sentJsonProblem(config.variables);
    if (p) return p;
  }
  for (const k of ['spaceId', 'environment', 'contentType', 'projectId', 'dataset', 'resource'] as const)
    if (config[k] !== undefined && (typeof config[k] !== 'string' || !ID_RE.test(config[k] as string))) return `its ${k} is not a name of letters, numbers, dots, hyphens and underscores.`;
  if (config.groq !== undefined && (typeof config.groq !== 'string' || !config.groq.trim() || config.groq.length > 20_000)) return 'its GROQ query is missing or too long.';
  return null;
}

/** What is wrong with where a source's records' details are read from, or null. */
export function mappingProblem(m: unknown): string | null {
  if (!isPlain(m)) return 'where its details are read from is damaged.';
  for (const [k, v] of Object.entries(m)) {
    if (!MAPPING_KEYS.has(k)) return `where its details are read from names one no entry has (${k.slice(0, 40)}).`;
    if (k === 'bodyFormat') {
      if (!BODY_FORMATS.has(v as string)) return 'its text is not read as text, html, markdown or contentful.';
    } else if (k === 'values') {
      if (!isPlain(v) || Object.keys(v).length > 100) return 'where its fields are read from is damaged.';
      for (const [f, path] of Object.entries(v)) {
        if (!FIELD_NAME.test(f) || f in Object.prototype) return 'one of its fields has a name no field can have.';
        if (!isPath(path)) return `where its ${f} field is read from is not a path ("fields.role").`;
      }
    } else if (!isPath(v)) return `where its ${k} is read from is not a path ("fields.title").`;
  }
  return null;
}

/** A mapping as a source keeps it: only the details it reads, each path trimmed. */
export function cleanMapping(m: SourceMapping): SourceMapping {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'values') {
      const values = Object.fromEntries(Object.entries((v as Record<string, string>) ?? {}).flatMap(([f, p]) => (typeof p === 'string' && p.trim() ? [[f, p.trim()]] : [])));
      if (Object.keys(values).length) out.values = values;
    } else if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out as SourceMapping;
}

/**
 * What is wrong with a source's settings document (null when nothing), worded to follow "it". Only settings the project
 * can keep and share pass: a credential is only ever named, slot by slot, so one written into the document by any name
 * stops it, and so does any setting no source takes yet. `folder` is the folder it was read from. The problem never
 * quotes what a setting holds, which may be the very credential.
 */
export function sourceDocProblem(doc: unknown, folder?: string): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'it is not a source’s settings.';
  const d = doc as Record<string, unknown>;
  if (!isSourceId(d.id) || (folder !== undefined && d.id !== folder)) return folder !== undefined ? `its id is not "${folder}", its folder’s name.` : 'its id is not a lowercase name.';
  for (const k of Object.keys(d)) if (!SOURCE_DOC_KEYS.has(k)) return 'it has a setting no source takes.';
  if (typeof d.schemaVersion !== 'number') return 'it has no schema version.';
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > MAX_SOURCE_NAME) return 'its name is missing or too long.';
  if (!isAdapterId(d.adapter)) return 'it names no kind of source.';
  if (!isCollectionId(d.collectionId)) return 'it names no collection to sync into.';
  if (d.removal !== undefined && !SOURCE_REMOVALS.includes(d.removal as SourceRemoval)) return `what happens to an entry the source no longer has is not ${SOURCE_REMOVALS.join(', ')}.`;
  const config = d.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'its settings are damaged.';
  // A kind the app does not read itself (one a later version adds) keeps only its credentials, and fails its sync.
  if (!isBuiltInAdapter(d.adapter)) for (const k of Object.keys(config)) if (k !== 'credentials') return 'its settings have one no source takes.';
  if (d.mapping !== undefined) {
    const p = mappingProblem(d.mapping);
    if (p) return p;
  }
  if (d.converter !== undefined) {
    const c = d.converter as Record<string, unknown>;
    if (!isPlain(c) || c.file !== CONVERTER_FILE || Object.keys(c).some((k) => k !== 'file' && k !== 'code')) return `its converter is not ${CONVERTER_FILE}.`;
    if (c.code !== undefined && (typeof c.code !== 'string' || c.code.length > MAX_CONVERTER)) return `its converter is longer than ${MAX_CONVERTER} characters.`;
    if (d.mapping !== undefined) return 'it has both a converter and a mapping: its records are put in shape by one of them.';
  }
  const creds = (config as { credentials?: unknown }).credentials;
  if (creds !== undefined) {
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return 'its credentials are damaged.';
    const slots = Object.entries(creds);
    if (slots.length > MAX_CREDENTIALS) return 'it names too many credentials.';
    for (const [slot, ref] of slots) {
      if (!isSecretName(slot)) return 'one of its credentials has a name a credential cannot have.';
      // The value itself, whatever its shape, is never kept here.
      // Nor is the slot's name quoted: a credential pasted in the wrong place may be the name.
      if (!isSecretRef(ref)) return 'one of its credentials holds a value instead of naming a secret. Keep the value as a secret, and name it here with { "$secret": "<name>" }.';
    }
  }
  return isBuiltInAdapter(d.adapter) ? adapterConfigProblem(d.adapter as string, config as Record<string, unknown>) : null;
}

/**
 * Whether `text` (a document as it will be written, or what a sync brings) holds any of the user's secret `values`:
 * as written, or escaped as JSON writes it.
 */
export function holdsSecretValue(text: string, values: readonly string[]): boolean {
  return values.some((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && secretForms(v).some((f) => text.includes(f)));
}

/** A secret as text may carry it: as written, escaped as JSON writes it, and encoded as an address or a form does. */
export function secretForms(v: string): string[] {
  const forms = new Set([v, JSON.stringify(v).slice(1, -1)]);
  try {
    const encoded = encodeURIComponent(v);
    forms.add(encoded);
    forms.add(encoded.replace(/%20/g, '+'));
  } catch {
    // Text no address can carry (a lone surrogate) is only ever written as it is.
  }
  return [...forms];
}

/** The shortest secret kept. Shorter is no credential, and looking for it in text would find ordinary words. */
export const MIN_SECRET_LENGTH = 4;

/** A source's settings as one text, whatever order their keys are in: what tells one version of them from another. */
export function sourceFingerprint(doc: SourceDoc | null | undefined): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);
  return canonical(doc ?? null);
}
