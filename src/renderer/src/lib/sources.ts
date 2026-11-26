/**
 * External sources in the Content workspace (#678): the settings a Connect dialog edits, made into the source's
 * `source.upsert` as the main process tests and saves it; what a sync changed, in words; and detaching a collection
 * from its source, which turns its entries into local ones.
 */
import type { CollectionDoc, ProjectState, SourceAdapterId, SourceDoc, SourceMapping, SourcePagination, SourceRemoval } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { SourceSettingsDraft, SourceSyncResult } from '@shared/api';
import { SOURCE_ADAPTERS, sourceSecretNames } from '@shared/sources';

export const ADAPTER_IDS = Object.keys(SOURCE_ADAPTERS) as SourceAdapterId[];

/** A header or query parameter as the dialog lists it. */
export interface PairRow {
  name: string;
  value: string;
}

/** Where a detail of an entry is read from, as the dialog lists them: entry details, then the collection's own fields. */
export const MAPPED_DETAILS: ReadonlyArray<{ key: Exclude<keyof SourceMapping, 'values' | 'bodyFormat'>; label: string }> = [
  { key: 'externalId', label: 'ID' },
  { key: 'title', label: 'Title' },
  { key: 'slug', label: 'Address (slug)' },
  { key: 'publishedAt', label: 'Published' },
  { key: 'updatedAt', label: 'Updated' },
  { key: 'draft', label: 'Draft' },
  { key: 'author', label: 'Author' },
  { key: 'excerpt', label: 'Excerpt' },
  { key: 'featuredImageUrl', label: 'Featured image address' },
  { key: 'featuredImageAlt', label: 'Featured image description' },
  { key: 'body', label: 'Text' }
];

/** Everything the Connect dialog edits, as text the author types. */
export interface SourceForm {
  sourceId: string;
  name: string;
  adapter: SourceAdapterId;
  url: string;
  method: 'GET' | 'POST';
  headers: PairRow[];
  query: PairRow[];
  body: string;
  itemsPath: string;
  paging: SourcePagination['type'];
  pageParam: string;
  pageSizeParam: string;
  pageSize: string;
  /** The first page's number, for pages by number: absent, 1. */
  pageStart: string;
  cursorPath: string;
  nextPath: string;
  graphql: string;
  variables: string;
  spaceId: string;
  environment: string;
  contentType: string;
  projectId: string;
  dataset: string;
  groq: string;
  resource: string;
  /** The secret a CMS's own token is, by name. */
  token: string;
  shape: 'mapping' | 'converter';
  /** Paths by detail, and by `values.<field>` for a custom field. */
  mapping: Record<string, string>;
  bodyFormat: '' | NonNullable<SourceMapping['bodyFormat']>;
  converter: string;
  removal: SourceRemoval;
}

/** A converter to start from: each record's details read from where the source keeps them. */
export const CONVERTER_TEMPLATE = `// convert gets every record the source sent, and gives back one entry for each.
// helpers: get(value, "a.b[0]"), image(url, { alt }), date(value), and
// richText.fromText / fromHtml / fromMarkdown / fromContentful.
export function convert(items, helpers) {
  return items.map((item) => ({
    externalId: String(item.id),
    title: item.title,
    // slug: item.slug,
    // publishedAt: helpers.date(item.createdAt),
    // featuredImage: helpers.image(item.image?.url, { alt: item.image?.alt }),
    // values: { role: item.role },
    // body: helpers.richText.fromHtml(item.content),
  }));
}
`;

/** The source a collection is synced from, or is set up to be synced from on its first sync. */
export function sourceOfCollection(state: ProjectState, collectionId: string): SourceDoc | undefined {
  const c = Object.hasOwn(state.collections, collectionId) ? state.collections[collectionId] : undefined;
  const sources = Object.values(state.sources ?? {});
  return (c?.settings.sourceId ? sources.find((s) => s.id === c.settings.sourceId) : undefined) ?? sources.find((s) => s.collectionId === collectionId);
}

/** A source ID for a new source of collection `collectionId`: the collection's own, numbered past any other source's. */
export function freeSourceId(state: ProjectState, collectionId: string): string {
  const taken = new Set(Object.keys(state.sources ?? {}));
  if (!taken.has(collectionId)) return collectionId;
  for (let n = 2; ; n++) if (!taken.has(`${collectionId.slice(0, 55)}-${n}`)) return `${collectionId.slice(0, 55)}-${n}`;
}

const pairs = (m: Record<string, string> | undefined): PairRow[] => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));

/** The dialog's form for source `source` of collection `collection`, or for a new one. */
export function sourceForm(state: ProjectState, collection: CollectionDoc, source: SourceDoc | undefined): SourceForm {
  const c = source?.config ?? {};
  const p = c.pagination;
  const mapping: Record<string, string> = {};
  for (const [k, v] of Object.entries(source?.mapping ?? {})) {
    if (k === 'values') for (const [f, path] of Object.entries(v as Record<string, string>)) mapping[`values.${f}`] = path;
    else if (k !== 'bodyFormat' && typeof v === 'string') mapping[k] = v;
  }
  return {
    sourceId: source?.id ?? freeSourceId(state, collection.id),
    name: source?.name ?? `${collection.name} source`,
    adapter: (source && Object.hasOwn(SOURCE_ADAPTERS, source.adapter) ? source.adapter : 'rest') as SourceAdapterId,
    url: c.url ?? '',
    method: c.method ?? 'GET',
    headers: pairs(c.headers),
    query: pairs(c.query),
    body: c.body ?? '',
    itemsPath: c.itemsPath ?? '',
    paging: p?.type ?? 'none',
    pageParam: p && 'param' in p ? p.param : '',
    pageSizeParam: p?.type === 'page' ? (p.sizeParam ?? '') : p?.type === 'offset' ? (p.limitParam ?? '') : '',
    pageSize: p?.type === 'page' ? String(p.size) : p?.type === 'offset' ? String(p.limit) : '',
    pageStart: p?.type === 'page' && p.start !== undefined ? String(p.start) : '',
    cursorPath: p?.type === 'cursor' ? p.cursorPath : '',
    nextPath: p?.type === 'nextLink' ? (p.path ?? '') : '',
    graphql: c.graphql ?? '',
    variables: c.variables ? JSON.stringify(c.variables, null, 2) : '',
    spaceId: c.spaceId ?? '',
    environment: c.environment ?? '',
    contentType: c.contentType ?? '',
    projectId: c.projectId ?? '',
    dataset: c.dataset ?? '',
    groq: c.groq ?? '',
    resource: c.resource ?? '',
    token: c.credentials?.token?.$secret ?? '',
    shape: source?.converter ? 'converter' : 'mapping',
    mapping,
    bodyFormat: source?.mapping?.bodyFormat ?? '',
    converter: source?.converter?.code ?? CONVERTER_TEMPLATE,
    removal: source?.removal ?? 'unpublish'
  };
}

const kept = (rows: PairRow[]) => Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));
const some = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);

/** The pagination the form says, or why it cannot be one. */
function pagination(f: SourceForm): SourcePagination | string {
  const size = Number(f.pageSize);
  const param = f.pageParam.trim();
  switch (f.paging) {
    case 'none':
      return { type: 'none' };
    case 'page':
    case 'offset':
      if (!param) return `Say which query parameter asks for a ${f.paging === 'page' ? 'page' : 'starting point'}.`;
      if (!Number.isInteger(size) || size < 1 || size > 1000) return 'Say how many records a page holds, from 1 to 1000.';
      if (f.paging === 'page' && f.pageStart.trim() && !/^\d{1,7}$/.test(f.pageStart.trim())) return 'The first page’s number is a whole number, such as 0 or 1.';
      return f.paging === 'page'
        ? { type: 'page', param, size, ...(f.pageSizeParam.trim() ? { sizeParam: f.pageSizeParam.trim() } : {}), ...(f.pageStart.trim() ? { start: Number(f.pageStart.trim()) } : {}) }
        : { type: 'offset', param, limit: size, ...(f.pageSizeParam.trim() ? { limitParam: f.pageSizeParam.trim() } : {}) };
    case 'cursor':
      if (!param || !f.cursorPath.trim()) return 'Say which query parameter takes the cursor, and where each reply gives the next one.';
      return { type: 'cursor', param, cursorPath: f.cursorPath.trim() };
    case 'nextLink':
      return { type: 'nextLink', ...(f.nextPath.trim() ? { path: f.nextPath.trim() } : {}) };
  }
}

/** The source's settings the form says, as `source.upsert` takes them, or why they cannot be. */
export function sourceDraft(f: SourceForm, collectionId: string): SourceSettingsDraft | string {
  if (!f.name.trim()) return 'Give the source a name.';
  const config: Record<string, unknown> = {};
  const set = (k: string, v: string) => {
    if (v.trim()) config[k] = v.trim();
  };
  switch (f.adapter) {
    case 'rest': {
      set('url', f.url);
      if (f.method === 'POST') config.method = 'POST';
      if (f.method === 'POST' && f.body.trim()) config.body = f.body;
      const headers = some(kept(f.headers));
      if (headers) config.headers = headers;
      const query = some(kept(f.query));
      if (query) config.query = query;
      set('itemsPath', f.itemsPath);
      const p = pagination(f);
      if (typeof p === 'string') return p;
      if (p.type !== 'none') config.pagination = p;
      break;
    }
    case 'graphql': {
      set('url', f.url);
      const headers = some(kept(f.headers));
      if (headers) config.headers = headers;
      set('graphql', f.graphql);
      if (f.variables.trim()) {
        try {
          const v = JSON.parse(f.variables) as unknown;
          if (!v || typeof v !== 'object' || Array.isArray(v)) return 'The variables are a JSON object: { "first": 50 }.';
          config.variables = v;
        } catch {
          return 'The variables are not JSON: { "first": 50 }.';
        }
      }
      set('itemsPath', f.itemsPath);
      break;
    }
    case 'contentful':
      set('spaceId', f.spaceId);
      set('environment', f.environment);
      set('contentType', f.contentType);
      break;
    case 'sanity':
      set('projectId', f.projectId);
      set('dataset', f.dataset);
      set('groq', f.groq);
      break;
    case 'strapi':
      set('url', f.url);
      set('resource', f.resource);
      break;
    case 'wordpress':
      set('url', f.url);
      set('resource', f.resource);
      break;
  }
  if (Object.hasOwn(SOURCE_ADAPTERS[f.adapter].credentials, 'token') && f.token.trim()) config.credentials = { token: { $secret: f.token.trim() } };
  const draft: SourceSettingsDraft = { sourceId: f.sourceId, name: f.name.trim(), adapter: f.adapter, collectionId, config, ...(f.removal !== 'unpublish' ? { removal: f.removal } : {}) };
  if (f.shape === 'converter') return { ...draft, converter: f.converter };
  const mapping: Record<string, unknown> = {};
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.mapping)) {
    if (!v.trim()) continue;
    if (k.startsWith('values.')) values[k.slice(7)] = v.trim();
    else mapping[k] = v.trim();
  }
  if (Object.keys(values).length) mapping.values = values;
  if (f.bodyFormat) mapping.bodyFormat = f.bodyFormat;
  return Object.keys(mapping).length ? { ...draft, mapping } : draft;
}

/** The secrets a draft signs in with, by name. */
export const draftSecretNames = (d: SourceSettingsDraft): string[] => sourceSecretNames({ config: d.config as SourceDoc['config'] });

/** What a sync changed, in a sentence. */
export function syncSummary(name: string, r: Extract<SourceSyncResult, { ok: true }>): string {
  const parts = [
    r.created && `${r.created} added`,
    r.updated && `${r.updated} changed`,
    r.unpublished && `${r.unpublished} made drafts`,
    r.removed && `${r.removed} deleted`,
    r.kept && `${r.kept} kept that the source no longer has`,
    r.images && `${r.images} ${r.images === 1 ? 'picture' : 'pictures'} added to the library`
  ].filter(Boolean);
  if (!parts.length) return `“${name}” is up to date: ${r.unchanged} ${r.unchanged === 1 ? 'entry' : 'entries'} unchanged.`;
  return `Synced “${name}”: ${parts.join(', ')}${r.unchanged ? `; ${r.unchanged} unchanged` : ''}.`;
}

/**
 * Detaching collection `collectionId` from its source: its entries become local ones, edited here and left alone by
 * any sync, and the source's settings (and converter) go with it, so nothing claims the collection. One undoable step.
 */
export function detachOps(state: ProjectState, collectionId: string): EditOperation[] {
  const c = Object.hasOwn(state.collections, collectionId) ? state.collections[collectionId] : undefined;
  const source = sourceOfCollection(state, collectionId);
  const ops: EditOperation[] = [];
  if (c?.settings.sourceId !== undefined) ops.push({ type: 'collection.update', collectionId, sourceId: null } as EditOperation);
  if (source) ops.push({ type: 'source.remove', sourceId: source.id });
  return ops;
}
