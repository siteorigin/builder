import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetsDoc, Collection, CollectionDoc, ComponentDefinition, EntryDoc, PageDoc, ProjectBriefDoc, ProjectManifest, ProjectState, SiteDoc, ThemeLock, TokensDoc } from '@shared/types';
import { BRIEF_FILE, BRIEF_FIELDS } from '@shared/brief';
import { isCollectionId, isEntryId } from '@shared/collections';
import { SCHEMA_VERSION } from '@shared/types';
import { migrateProject, newestDocumentVersion, type MigrationResult } from '@shared/migrations';
import { readIfExists, safeJoin, toJson } from './fsutil';

export const MANIFEST_FILE = 'siteorigin.project.json';
export const DOC_DIR = 'siteorigin';

/** Only these project-relative paths are canonical documents; recovery and history may write nothing else. */
export const CUSTOM_SOURCE_RE = /^src\/lib\/siteorigin\/custom\/[A-Za-z0-9_-]+\.svelte$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export function isCanonicalPath(p: string): boolean {
  return (
    p === MANIFEST_FILE ||
    /^siteorigin\/(site|tokens|assets|theme-lock|brief)\.json$/.test(p) ||
    /^siteorigin\/pages\/[A-Za-z0-9_-]+\.json$/.test(p) ||
    /^siteorigin\/components\/[A-Za-z0-9][A-Za-z0-9._-]*\/component\.json$/.test(p) ||
    collectionPathOf(p) !== null ||
    CUSTOM_SOURCE_RE.test(p)
  );
}

export function collectionDocPath(collectionId: string): string {
  return `${DOC_DIR}/collections/${collectionId}/collection.json`;
}

export function entryDocPath(collectionId: string, entryId: string): string {
  return `${DOC_DIR}/collections/${collectionId}/entries/${entryId}.json`;
}

/**
 * The collection (and, for an entry's file, the entry) a document path holds, or null for any other path. Only
 * well-formed IDs match, so a path from a journal or a saved version can never reach outside its folder.
 */
export function collectionPathOf(p: string): { collectionId: string; entryId?: string } | null {
  const m = /^siteorigin\/collections\/([^/]+)\/(?:collection\.json|entries\/([^/]+)\.json)$/.exec(p);
  if (!m || !isCollectionId(m[1])) return null;
  if (m[2] === undefined) return { collectionId: m[1] };
  return isEntryId(m[2]) ? { collectionId: m[1], entryId: m[2] } : null;
}

/**
 * Collections from their documents, by path. Settings come first and entries after, whatever order the paths are
 * in, so an entry always finds its collection. An entry whose collection has no settings document is returned in
 * `orphans` instead.
 */
export function collectionsFromDocs(docs: Iterable<[string, unknown]>): { collections: Record<string, Collection>; orphans: string[]; duplicates: string[] } {
  const settings: Array<[string, CollectionDoc]> = [];
  const entries: Array<[string, string, EntryDoc]> = [];
  for (const [path, doc] of docs) {
    const at = collectionPathOf(path);
    if (!at) continue;
    if (at.entryId === undefined) settings.push([at.collectionId, doc as CollectionDoc]);
    else entries.push([path, at.collectionId, doc as EntryDoc]);
  }
  const collections: Record<string, Collection> = {};
  for (const [id, doc] of settings.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) collections[id] = { settings: doc, entries: {} };
  const orphans: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const [path, cid, entry] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!Object.hasOwn(collections, cid)) orphans.push(path);
    else collections[cid].entries[entry.id] = entry;
    // Entry IDs are unique across the project: links name no collection.
    const id = collectionPathOf(path)!.entryId!;
    if (seen.has(id)) duplicates.push(path);
    seen.add(id);
  }
  return { collections, orphans, duplicates };
}
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_RE.test(id) && !id.includes('..');
}

export function componentDocPath(id: string): string {
  return `${DOC_DIR}/components/${id}/component.json`;
}

/** Serialize the canonical documents. Keys are project-relative paths. */
export function stateToDocs(state: ProjectState): Map<string, string> {
  const docs = new Map<string, string>();
  docs.set(MANIFEST_FILE, toJson(state.manifest));
  docs.set(`${DOC_DIR}/site.json`, toJson(state.site));
  docs.set(`${DOC_DIR}/tokens.json`, toJson(state.tokens));
  docs.set(`${DOC_DIR}/assets.json`, toJson(state.assets));
  docs.set(`${DOC_DIR}/theme-lock.json`, toJson(state.themeLock));
  // Only while it holds something: an empty brief is no file.
  if (state.brief) docs.set(BRIEF_FILE, toJson(state.brief));
  for (const id of Object.keys(state.pages).sort()) docs.set(`${DOC_DIR}/pages/${id}.json`, toJson(state.pages[id]));
  for (const id of Object.keys(state.components).sort()) {
    const def = state.components[id];
    // Authored code components keep their source in the .svelte file; the manifest points to it.
    const stored = def.sourcePath ? { ...def, source: undefined } : def;
    docs.set(componentDocPath(id), toJson(stored));
    // Authored code is canonical too, so it is journaled and part of undo history.
    if (def.sourcePath && def.source !== undefined) docs.set(def.sourcePath, def.source);
  }
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const c = state.collections[id];
    docs.set(collectionDocPath(id), toJson(c.settings));
    for (const eid of Object.keys(c.entries).sort()) docs.set(entryDocPath(id, eid), toJson(c.entries[eid]));
  }
  return docs;
}

/** Source files authored by the user (project code components) also belong to the canonical state. */
export function stateToAuthoredSources(state: ProjectState): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of Object.values(state.components)) if (def.sourcePath && def.source !== undefined) out.set(def.sourcePath, def.source);
  return out;
}

export class ProjectFormatError extends Error {
  constructor(message: string, public readonly readOnly = false) {
    super(message);
  }
}

/**
 * The newest format any canonical document on disk declares, skipping documents that cannot be read. Reading the
 * project stops at its first broken document, so a newer one later in the folder needs this to be seen at all.
 */
export async function newestStoredVersion(dir: string): Promise<number> {
  const paths = [MANIFEST_FILE, ...['site', 'tokens', 'assets', 'theme-lock', 'brief'].map((d) => `${DOC_DIR}/${d}.json`)];
  const names = async (rel: string) => (existsSync(join(dir, rel)) ? (await fs.readdir(join(dir, rel)).catch(() => [])).sort() : []);
  for (const f of await names(`${DOC_DIR}/pages`)) if (f.endsWith('.json')) paths.push(`${DOC_DIR}/pages/${f}`);
  for (const d of await names(`${DOC_DIR}/components`)) if (!d.startsWith('.')) paths.push(componentDocPath(d));
  for (const c of await names(`${DOC_DIR}/collections`)) {
    if (!isCollectionId(c)) continue;
    paths.push(collectionDocPath(c));
    for (const f of await names(`${DOC_DIR}/collections/${c}/entries`)) if (f.endsWith('.json') && isEntryId(f.slice(0, -5))) paths.push(entryDocPath(c, f.slice(0, -5)));
  }
  let newest = 0;
  for (const rel of paths) {
    try {
      const v = (JSON.parse((await readIfExists(safeJoin(dir, rel))) ?? 'null') as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (Number.isInteger(v) && (v as number) > newest) newest = v as number;
    } catch {
      // Unreadable or not a document: the normal read reports it.
    }
  }
  return newest;
}

export async function isBuilderProject(dir: string): Promise<boolean> {
  return existsSync(join(dir, MANIFEST_FILE));
}

export interface ReadOptions {
  /**
   * Documents to use instead of what is on disk (null = absent). A file in conflict is read as the
   * version SiteOrigin Builder holds, while the external version stays untouched on disk.
   */
  overlay?: Map<string, string | null>;
  /** Read a project written by a newer version (for read-only inspection only). */
  allowNewer?: boolean;
  /** Read these documents and nothing from the folder (a saved version): a document not here is absent. */
  only?: Map<string, string>;
}

/** The project in the current format. Reading never writes: a session publishes a migration itself. */
export async function readState(dir: string, opts: ReadOptions = {}): Promise<ProjectState> {
  return (await readProject(dir, opts)).state;
}

export interface ReadProject {
  state: ProjectState;
  /** The documents as stored, before any migration. */
  stored: ProjectState;
  /** The exact text each stored document was parsed from, by project-relative path. */
  raw: Map<string, string>;
  /** Set when the stored documents are in an older format than `state`. */
  migration: MigrationResult | null;
}

export async function readProject(dir: string, opts: ReadOptions = {}): Promise<ReadProject> {
  const raw = new Map<string, string>();
  const stored = await readStoredState(dir, opts, raw);
  const newest = newestDocumentVersion(stored);
  if (newest > SCHEMA_VERSION) {
    if (!opts.allowNewer) throw new ProjectFormatError(`This project was created by a newer version of SiteOrigin Builder (format ${newest}). Update the app to edit it.`, true);
    return { state: stored, stored, raw, migration: null };
  }
  let migration: MigrationResult | null;
  try {
    migration = migrateProject(stored);
  } catch (e) {
    throw new ProjectFormatError(`This project could not be updated to the current format, so it was not changed: ${(e as Error).message}`);
  }
  return { state: migration?.state ?? stored, stored, raw, migration };
}

async function readStoredState(dir: string, opts: ReadOptions, raw: Map<string, string>): Promise<ProjectState> {
  const only = opts.only;
  // Reading only given documents, every other document counts as absent, whatever the folder holds.
  const overlay: Map<string, string | null> = only ?? opts.overlay ?? new Map<string, string | null>();
  const text = async (rel: string): Promise<string | null> => {
    const t = overlay.has(rel) ? overlay.get(rel)! : only ? null : await readIfExists(safeJoin(dir, rel));
    if (t !== null) raw.set(rel, t);
    return t;
  };
  const exists = (rel: string) => (overlay.has(rel) ? overlay.get(rel) !== null : !only && existsSync(join(dir, rel)));
  /** Directory entries on disk, plus overlay documents in that folder, minus overlay deletions. */
  const list = async (rel: string, pick: (overlayPath: string) => string | null): Promise<string[]> => {
    const names = new Set(!only && existsSync(join(dir, rel)) ? await fs.readdir(join(dir, rel)) : []);
    for (const [p, c] of overlay) {
      const name = pick(p);
      if (name !== null && c !== null) names.add(name);
    }
    return [...names].sort();
  };
  const manifestText = await text(MANIFEST_FILE);
  if (!manifestText) throw new ProjectFormatError('This folder is not a SiteOrigin Builder project (siteorigin.project.json is missing).');
  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ProjectFormatError('siteorigin.project.json is not valid JSON, so the project was not opened. If it was copied or downloaded, it may be incomplete: replace it with a complete copy, or choose another project. The folder was not changed.');
  }
  if (typeof manifest.schemaVersion !== 'number') throw new ProjectFormatError('siteorigin.project.json has no schema version.');
  if (manifest.schemaVersion > SCHEMA_VERSION && !opts.allowNewer)
    throw new ProjectFormatError(`This project was created by a newer version of SiteOrigin Builder (format ${manifest.schemaVersion}). Update the app to edit it.`, true);
  if (!isSafeId(manifest.projectId)) throw new ProjectFormatError('siteorigin.project.json has an invalid project ID.');
  const load = async <T>(rel: string): Promise<T> => {
    try {
      const t = await text(rel);
      if (t === null) throw new Error('the file is missing');
      return JSON.parse(t) as T;
    } catch (e) {
      throw new ProjectFormatError(`Could not read ${rel}: ${(e as Error).message}`);
    }
  };
  const site = await load<SiteDoc>(`${DOC_DIR}/site.json`);
  const tokens = await load<TokensDoc>(`${DOC_DIR}/tokens.json`);
  const assets = await load<AssetsDoc>(`${DOC_DIR}/assets.json`);
  const themeLock = exists(`${DOC_DIR}/theme-lock.json`)
    ? await load<ThemeLock>(`${DOC_DIR}/theme-lock.json`)
    : { schemaVersion: SCHEMA_VERSION, theme: { id: site.themeId, version: '0.0.0' }, components: {} };
  const pages: Record<string, PageDoc> = {};
  for (const f of await list(`${DOC_DIR}/pages`, (p) => p.match(/^siteorigin\/pages\/([^/]+\.json)$/)?.[1] ?? null)) {
    if (!f.endsWith('.json') || !exists(`${DOC_DIR}/pages/${f}`)) continue;
    const p = await load<PageDoc>(`${DOC_DIR}/pages/${f}`);
    if (!/^[A-Za-z0-9_-]+$/.test(String(p.id)) || p.id !== f.slice(0, -5)) throw new ProjectFormatError(`${DOC_DIR}/pages/${f} has a mismatched id "${p.id}".`);
    pages[p.id] = p;
  }
  const components: Record<string, ComponentDefinition> = {};
  const sourcePaths = new Set<string>();
  for (const d of await list(`${DOC_DIR}/components`, (p) => p.match(/^siteorigin\/components\/([^/]+)\/component\.json$/)?.[1] ?? null)) {
    if (d.startsWith('.')) continue;
    // A folder left behind by an interrupted delete is not a component.
    if (!exists(`${DOC_DIR}/components/${d}/component.json`)) continue;
    const def = await load<ComponentDefinition>(`${DOC_DIR}/components/${d}/component.json`);
    if (!isSafeId(def.id) || def.id !== d) throw new ProjectFormatError(`${DOC_DIR}/components/${d} has a mismatched id "${def.id}".`);
    if (def.sourcePath !== undefined) {
      if (def.kind !== 'code' || def.owner !== 'project' || !CUSTOM_SOURCE_RE.test(def.sourcePath) || sourcePaths.has(def.sourcePath))
        throw new ProjectFormatError(`Component "${def.name}" points to a source file outside src/lib/siteorigin/custom/ or shared with another component.`);
      sourcePaths.add(def.sourcePath);
      def.source = (await text(def.sourcePath)) ?? '';
    }
    components[def.id] = def;
  }
  // Collections: every folder with settings or entries, so an entry whose collection has gone is noticed.
  const collectionDocs: Array<[string, unknown]> = [];
  const folders = await list(`${DOC_DIR}/collections`, (p) => collectionPathOf(p)?.collectionId ?? null);
  for (const c of folders) {
    if (c.startsWith('.')) continue;
    const dir = `${DOC_DIR}/collections/${c}`;
    if (!isCollectionId(c)) {
      // Anything else in the folder (a note, a stray file) is not the project's; settings under a name no collection
      // can have would be lost without a word, so they stop the read instead.
      if (exists(`${dir}/collection.json`)) throw new ProjectFormatError(`${dir} is not a valid collection folder name (use lowercase letters, numbers and single hyphens).`);
      continue;
    }
    const entryFiles = await list(`${dir}/entries`, (p) => {
      const at = collectionPathOf(p);
      return at?.collectionId === c && at.entryId !== undefined ? `${at.entryId}.json` : null;
    });
    // A folder left behind by an interrupted delete holds neither.
    if (exists(collectionDocPath(c))) {
      const settings = await load<CollectionDoc>(collectionDocPath(c));
      if (!settings || typeof settings !== 'object' || settings.id !== c) throw new ProjectFormatError(`${collectionDocPath(c)} has a mismatched id "${(settings as { id?: unknown })?.id}".`);
      collectionDocs.push([collectionDocPath(c), settings]);
    }
    for (const f of entryFiles) {
      if (f.startsWith('.') || !f.endsWith('.json')) continue;
      const eid = f.slice(0, -5);
      const path = `${dir}/entries/${f}`;
      if (!isEntryId(eid)) throw new ProjectFormatError(`${path} is not named like an entry (en_ followed by letters and numbers).`);
      if (!exists(path)) continue;
      const entry = await load<EntryDoc>(path);
      if (!entry || typeof entry !== 'object' || entry.id !== eid) throw new ProjectFormatError(`${path} has a mismatched id "${(entry as { id?: unknown })?.id}".`);
      collectionDocs.push([path, entry]);
    }
  }
  const { collections, orphans, duplicates } = collectionsFromDocs(collectionDocs);
  if (orphans.length) throw new ProjectFormatError(`${orphans[0]} belongs to a collection that has no collection.json. Restore that file, or move the entry out of the project.`);
  if (duplicates.length) throw new ProjectFormatError(`${duplicates[0]} has the same entry ID as an entry of another collection. Entry IDs must be unique across the project.`);
  const state: ProjectState = { manifest, site, tokens, assets, themeLock, pages, components, collections };
  if (exists(BRIEF_FILE)) state.brief = briefDoc(await load<unknown>(BRIEF_FILE));
  return state;
}

/** A stored brief, checked: each field is text when given (a field left out is empty), or the project is not read. */
function briefDoc(doc: unknown): ProjectBriefDoc {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ProjectFormatError(`${BRIEF_FILE} is not a project brief. Restore it from a copy, or remove it to start the brief afresh.`);
  const d = doc as Record<string, unknown>;
  for (const f of BRIEF_FIELDS) if (d[f] !== undefined && typeof d[f] !== 'string') throw new ProjectFormatError(`${BRIEF_FILE} has a ${f} that is not text. Restore it from a copy, or correct it.`);
  return { ...d, schemaVersion: d.schemaVersion as number, description: (d.description as string | undefined) ?? '', notes: (d.notes as string | undefined) ?? '' };
}
