import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetsDoc, ComponentDefinition, PageDoc, ProjectManifest, ProjectState, SiteDoc, ThemeLock, TokensDoc } from '@shared/types';
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
    /^siteorigin\/(site|tokens|assets|theme-lock)\.json$/.test(p) ||
    /^siteorigin\/pages\/[A-Za-z0-9_-]+\.json$/.test(p) ||
    /^siteorigin\/components\/[A-Za-z0-9][A-Za-z0-9._-]*\/component\.json$/.test(p) ||
    CUSTOM_SOURCE_RE.test(p)
  );
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
  for (const id of Object.keys(state.pages).sort()) docs.set(`${DOC_DIR}/pages/${id}.json`, toJson(state.pages[id]));
  for (const id of Object.keys(state.components).sort()) {
    const def = state.components[id];
    // Authored code components keep their source in the .svelte file; the manifest points to it.
    const stored = def.sourcePath ? { ...def, source: undefined } : def;
    docs.set(componentDocPath(id), toJson(stored));
    // Authored code is canonical too, so it is journaled and part of undo history.
    if (def.sourcePath && def.source !== undefined) docs.set(def.sourcePath, def.source);
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
  const paths = [MANIFEST_FILE, ...['site', 'tokens', 'assets', 'theme-lock'].map((d) => `${DOC_DIR}/${d}.json`)];
  const names = async (rel: string) => (existsSync(join(dir, rel)) ? (await fs.readdir(join(dir, rel)).catch(() => [])).sort() : []);
  for (const f of await names(`${DOC_DIR}/pages`)) if (f.endsWith('.json')) paths.push(`${DOC_DIR}/pages/${f}`);
  for (const d of await names(`${DOC_DIR}/components`)) if (!d.startsWith('.')) paths.push(componentDocPath(d));
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
  const overlay = opts.overlay ?? new Map<string, string | null>();
  const text = async (rel: string): Promise<string | null> => {
    const t = overlay.has(rel) ? overlay.get(rel)! : await readIfExists(safeJoin(dir, rel));
    if (t !== null) raw.set(rel, t);
    return t;
  };
  const exists = (rel: string) => (overlay.has(rel) ? overlay.get(rel) !== null : existsSync(join(dir, rel)));
  /** Directory entries on disk, plus overlay documents in that folder, minus overlay deletions. */
  const list = async (rel: string, pick: (overlayPath: string) => string | null): Promise<string[]> => {
    const names = new Set(existsSync(join(dir, rel)) ? await fs.readdir(join(dir, rel)) : []);
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
  return { manifest, site, tokens, assets, themeLock, pages, components };
}
