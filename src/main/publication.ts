/**
 * The website as it is published (#1154): a standalone SvelteKit project of the published site alone, committed onto
 * a history of its own (`refs/heads/siteorigin-publish`) in the project's versions repository, which a later push
 * (#1157) sends to a host. Nothing kept back from visitors ever reaches it: not a draft page or entry, not a library
 * file the published pages do not use, not the brief, not an external source's settings or converter, not a credential.
 *
 * The publication is made from the same isolated copy the website export builds (the published site's generated
 * files, no editor markers, the library narrowed to what the pages use, photos without their location), whose
 * canonical documents are then replaced by the published state's own: drafts left out, every collection detached
 * from its source (its entries are the site's own, as synced), no brief and no sources, the library as it ships. The
 * tree is the snapshot allowlist's (snapshotPlace) over that copy, so what a saved version never holds a publication
 * never holds either, less the developer's own setup files and tests (developerOnly), which build no part of the website. Every text file of it is searched for the user's secrets and for addresses that carry a
 * password or token before anything is written.
 *
 * Its history is its own: the first publication is a root commit and each one after it follows the last, never a
 * saved version, so nothing a saved version holds is reachable from it. A tree the same as the last publication's makes
 * no commit. Whether the site differs from what was last published is told by the tree itself, hashed as Git would
 * without writing anything, so an edit to the brief, or an edit undone, changes nothing, and a picture replaced on
 * disk does.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { ComponentDefinition, NodeTree, ProjectState } from '@shared/types';
import { holdsSecretValue, isSensitiveName, MIN_SECRET_LENGTH } from '@shared/sources';
import { keptPublishedAddresses } from '@shared/collections';
import { getTheme } from '@catalogue/index';
import { defFile, publishedState, webMcpFormFile } from '@generator/index';
import { redirectHost } from '@generator/host-redirects';
import { runsOnNode } from '@shared/deploy-target';
import { holdsSecret } from './sources/sync';
import { withoutCodeMarkers } from './codecheck';
import { GIT_LIMITS, GitError, PUBLISH_BRANCH, PUBLISH_EMAIL, type GitRepository, type Identity, type Oid } from './git/protocol';
import { developerOnly, snapshotPlace } from './project/snapshot-inventory';
import { CUSTOM_SOURCE_RE, isCanonicalPath, MANIFEST_FILE, stateToDocs } from './project/documents';
import { readIfExists, sha } from './project/fsutil';
import { sameContent } from './project/session';
import {
  answeredAddressFile,
  carriesCodeMarker,
  cleanWebsitePhotos,
  draftLinksStop,
  importSpecifiers,
  isGeneratedReadme,
  leaveOutDrafts,
  missingAssetsStop,
  missingWebsiteAssets,
  ownNotFoundFileStop,
  projectReadme,
  pruneWebsiteAssets,
  settleServerHook,
  SYNC_COMMAND,
  SYNC_SCRIPT,
  themeNotice,
  uncleanablePhotosMessage,
  unusedComponents,
  variantCredits,
  withheldRoutes,
  withheldStaticFiles
} from './export';

/** The publication's history in the versions repository: a branch of its own, never one with a saved version in it. */
export { PUBLISH_BRANCH };

/** Whether a publication carries the project file at `rel`: what a snapshot holds, but the developer's own setup files and tests. */
const carried = (rel: string) => snapshotPlace(rel).kind === 'tree' && !developerOnly(rel);

/** Who a publication's commit is by: the app, at the time it was made, in UTC, so it carries nothing of the computer. */
export const publicationIdentity = (now = Date.now()): Identity => ({ name: 'SiteOrigin Builder', email: PUBLISH_EMAIL, timestamp: Math.floor(now / 1000), timezoneOffset: 0 });

// ---------------------------------------------------------------------------
// Git's names, worked out without writing anything
// ---------------------------------------------------------------------------

/** Git's name for a blob of these bytes. */
export function blobOid(bytes: Uint8Array): Oid {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * Git's name for the tree of these files, each a plain file (mode 100644, or 100755 for one that runs, as the
 * repository's writeFiles writes them), its folders made from their paths: the name writeFiles gives the same files,
 * worked out without writing them.
 */
export function treeOid(files: ReadonlyArray<{ path: string; oid: Oid; executable?: boolean }>): Oid {
  type Leaf = { oid: Oid; mode: string };
  type Dir = Map<string, Dir | Leaf>;
  const top: Dir = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = top;
    for (const name of parts.slice(0, -1)) {
      let next = dir.get(name);
      if (next === undefined) dir.set(name, (next = new Map()));
      if (!(next instanceof Map)) throw new Error(`${f.path} is inside a file of the publication.`);
      dir = next;
    }
    dir.set(parts[parts.length - 1], { oid: f.oid, mode: f.executable ? '100755' : '100644' });
  }
  const hash = (dir: Dir): Oid => {
    // Git sorts a folder's entries by their names' bytes, each folder's as if it ended in a slash.
    const entries = [...dir].map(([name, v]) => (v instanceof Map ? { name, mode: '40000', oid: hash(v), key: Buffer.from(`${name}/`) } : { name, mode: v.mode, oid: v.oid, key: Buffer.from(name) }));
    entries.sort((a, b) => Buffer.compare(a.key, b.key));
    const body = Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]));
    return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
  };
  return hash(top);
}

// ---------------------------------------------------------------------------
// The published state's canonical documents
// ---------------------------------------------------------------------------

/**
 * The project as it is published: the published pages and entries alone (publishedState), every collection detached
 * from its external source as Detach does it (no `sourceId`, no entry's `source`), so its entries read as the site's
 * own and nothing names a connector the publication does not carry; no sources, no brief; and the library without the
 * records `omitted` names (asset IDs none of whose files the website uses).
 */
export function publicationState(state: ProjectState): ProjectState {
  // The author's own name for this copy, and the addresses earlier exports delivered, are the project's, not the site's.
  const { workingCopyName: _workingCopyName, ...manifest } = state.manifest;
  void _workingCopyName;
  const live = publishedState(state);
  // A reference field naming an entry kept back names none: the entry is not in the publication.
  const shown = new Set(Object.values(live.collections ?? {}).flatMap((c) => Object.keys(c.entries)));
  const withheld = new Set(Object.values(state.collections ?? {}).flatMap((c) => Object.keys(c.entries ?? {}).filter((id) => !shown.has(id))));
  const named = (v: unknown) => (typeof v === 'string' ? withheld.has(v) : Array.isArray(v) && v.some((x) => withheld.has(x)));
  const unnamed = <T>(v: T): T => (typeof v === 'string' ? ('' as T) : ((v as unknown[]).filter((x) => !withheld.has(x as string)) as T));
  const collections = Object.fromEntries(
    Object.entries(live.collections ?? {}).map(([id, c]) => {
      const { sourceId: _sourceId, ...settings } = c.settings;
      void _sourceId;
      const refs = Object.entries(settings.fields ?? {}).flatMap(([k, f]) => (f?.type === 'reference' ? [k] : []));
      if (refs.some((k) => named((settings.fields[k] as { default: unknown }).default)))
        settings.fields = Object.fromEntries(Object.entries(settings.fields).map(([k, f]) => [k, refs.includes(k) && named((f as { default: unknown }).default) ? { ...f, default: unnamed((f as { default: string | string[] }).default) } : f])) as typeof settings.fields;
      const entries = Object.fromEntries(
        Object.entries(c.entries).map(([eid, e]) => {
          const { source: _source, ...entry } = e;
          void _source;
          if (refs.some((k) => named(entry.values?.[k]))) entry.values = Object.fromEntries(Object.entries(entry.values).map(([k, v]) => [k, refs.includes(k) && named(v) ? unnamed(v) : v]));
          return [eid, entry];
        })
      );
      return [id, { settings, entries }];
    })
  );
  // An old address publishedState kept as it was is the very redirect the project has, so its document reads the same.
  const kept = new Map((state.site.redirects ?? []).map((r) => [r.from, r]));
  const same = (a: object, b: object) => JSON.stringify({ ...a, custom: undefined }) === JSON.stringify({ ...b, custom: undefined });
  // The addresses earlier exports delivered that the site keeps working only by its record (see shared/published) are
  // the publication's redirects, since it carries no record; which ones the author dropped is the project's.
  const { droppedAddresses: _dropped, ...shownSite } = live.site;
  void _dropped;
  const redirects = [...(live.site.redirects ?? []).map((r) => (kept.has(r.from) && same(kept.get(r.from)!, r) ? kept.get(r.from)! : r)), ...keptPublishedAddresses(live)];
  const site = redirects.length ? { ...shownSite, redirects } : shownSite;
  const { brief: _brief, sources: _sources, published: _published, ...rest } = live;
  void _brief;
  void _sources;
  void _published;
  return { ...rest, manifest, site, collections };
}

/**
 * `state`'s library as the publication has it: the records its other canonical documents name (a page's picture, an
 * entry's image, the site's logo), and the fonts whose files the website in `dir` ships (styles name a font by its
 * family, never its record); a picture only a draft showed, or one deleted and kept for undo, leaves no name,
 * description or file name behind. A record whose original ships says what the website has of it: a photo cleaned of
 * its location is another file, of another size.
 */
export async function libraryAsShipped(dir: string, state: ProjectState): Promise<ProjectState> {
  const text = [...stateToDocs({ ...state, assets: { ...state.assets, assets: {} } })].map(([, t]) => t).join('\n');
  // Only a plain file of the publication's, of a size it can hold, is read: never a path that leads elsewhere.
  const files = new Set((await stagedFiles(dir)).filter((rel) => rel.startsWith('static/') && snapshotPlace(rel).kind === 'tree'));
  const readShipped = async (rel: unknown) => (typeof rel === 'string' && files.has(rel) && (await fs.stat(join(dir, rel))).size <= GIT_LIMITS.maxBlobBytes ? fs.readFile(join(dir, rel)) : null);
  const assets: ProjectState['assets']['assets'] = {};
  for (const [id, a] of Object.entries(state.assets.assets)) {
    const shipped = await readShipped(a.file);
    if (!text.includes(JSON.stringify(id)) && !(a.kind === 'font' && shipped)) continue;
    assets[id] = shipped && (shipped.length !== a.bytes || sha(shipped) !== a.hash) ? { ...a, bytes: shipped.length, hash: sha(shipped) } : a;
  }
  return { ...state, assets: { ...state.assets, assets } };
}

/**
 * The components the published state places: on its pages, in its header and footer, in every collection's layouts
 * (an entry's page and the archive's, whether or not they have pages now), inside those, and what code among them
 * declares it needs or was made from. Their documents name each other, so none of them can go.
 */
function placedComponents(state: ProjectState): Set<string> {
  const placed = new Set<string>();
  const take = (id: string) => {
    if (placed.has(id) || !Object.hasOwn(state.components, id)) return;
    placed.add(id);
    const def = state.components[id];
    if (def.kind === 'managed' && def.tree) walk(def.tree);
    if (def.kind === 'code') for (const dep of [...(def.dependencies ?? []), ...(def.generatedFrom ? [def.generatedFrom] : [])]) take(dep);
  };
  const walk = (tree: NodeTree | undefined) => {
    for (const n of Object.values(tree?.nodes ?? {})) if (n.kind === 'instance') take(n.definitionId);
  };
  for (const page of Object.values(state.pages)) walk(page);
  walk(state.site.shell.header);
  walk(state.site.shell.footer);
  for (const c of Object.values(state.collections ?? {})) {
    walk(c.settings.template);
    walk(c.settings.archiveTemplate);
  }
  return placed;
}

/** `state` without the components `ids` names, and the theme's record of them. */
function withoutComponents(state: ProjectState, ids: ReadonlySet<string>): ProjectState {
  if (!ids.size) return state;
  const keep = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !ids.has(id)));
  return { ...state, components: keep(state.components), themeLock: { ...state.themeLock, components: keep(state.themeLock.components) } };
}

/**
 * `state` with the editor's markers taken out of every code component's code (see stripCodeMarkers): a component's
 * canonical document holds a theme's code itself, and an authored component's source is written from it. The name of
 * one whose code could not be read to take them out (it does not parse), which would carry them, or null.
 */
async function withoutEditorMarkers(state: ProjectState): Promise<{ state: ProjectState; marked: ComponentDefinition | null }> {
  const components = { ...state.components };
  for (const [id, def] of Object.entries(components)) {
    if (def.kind !== 'code' || typeof def.source !== 'string') continue;
    const clean = await withoutCodeMarkers(def.source);
    if (carriesCodeMarker(clean)) return { state, marked: def };
    if (clean !== def.source) components[id] = { ...def, source: clean };
  }
  return { state: { ...state, components }, marked: null };
}

/**
 * Put the canonical documents of `projected` (publicationState) in place of the staged copy's in `dir`: each one it
 * has written as it has it (an authored code component's source among them, its markers taken out), and every other
 * canonical document there (a draft's page, a source's settings, the brief, a component left out) removed.
 */
export async function writePublicationDocs(dir: string, projected: ProjectState): Promise<void> {
  const docs = stateToDocs(projected);
  // A source no component names stays: it is a module of the site's (a dropped component's went with it).
  for (const rel of await stagedFiles(dir)) if (isCanonicalPath(rel) && !docs.has(rel) && !CUSTOM_SOURCE_RE.test(rel)) await fs.rm(join(dir, rel), { force: true });
  for (const [rel, text] of docs) {
    await fs.mkdir(dirname(join(dir, rel)), { recursive: true });
    await fs.writeFile(join(dir, rel), text);
  }
}

/** Every file in `dir`, by its path relative to it with forward slashes, sorted. Links and anything not a file are left out. */
export async function stagedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk('');
  return out.map((p) => p.split(sep).join('/')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What an editor or a file manager leaves beside a file it changed: a backup, a swap file, an autosave. */
const EDITOR_COPY = /(?:~|\.(?:bak|old|orig|rej|swp|swo|sav))$|^#.*#$|^\.#/i;

/** Take the sync script an exported project carries for its sources out of the copy in `dir`, and `npm run sync` with it. */
async function leaveOutSyncScript(dir: string): Promise<void> {
  await fs.rm(join(dir, SYNC_SCRIPT), { force: true });
  await fs.rmdir(dirname(join(dir, SYNC_SCRIPT))).catch(() => undefined);
  const path = join(dir, 'package.json');
  const text = await readIfExists(path);
  let pkg: { scripts?: Record<string, unknown> } | null = null;
  try {
    pkg = text === null ? null : (JSON.parse(text) as { scripts?: Record<string, unknown> });
  } catch {
    return;
  }
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object' || scripts.sync !== SYNC_COMMAND) return;
  const { sync: _sync, ...rest } = scripts;
  void _sync;
  // Written as it was: its own indentation, its line ends, and a line end after.
  const indent = text!.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? '\t';
  await fs.writeFile(path, `${JSON.stringify({ ...pkg, scripts: rest }, null, indent)}\n`.replace(/\n/g, text!.includes('\r\n') ? '\r\n' : '\n'));
}

export type Projection = { ok: true; state: ProjectState; files: PublicationFile[] } | { ok: false; message: string; warnings: string[]; assetId?: string };

/** The settings files at the project's top that a build runs, and the modules they load. */
const BUILD_CONFIGS = ['vite.config.js', 'vite.config.ts', 'svelte.config.js'];
const MODULE_ENDINGS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.json', '/index.js', '/index.ts'];

/**
 * Why a build of the publication could not run where it is published, or null: a build setting at the project's top
 * loads a file of the project's (`./build-options.js`) that a publication does not carry. `staged` is every file of the
 * copy, before what a publication does not carry is taken out.
 */
async function buildInputProblem(dir: string, staged: readonly string[]): Promise<string | null> {
  const have = new Set(staged);
  for (const config of BUILD_CONFIGS) {
    if (!have.has(config)) continue;
    for (const spec of importSpecifiers((await readIfExists(join(dir, config))) ?? '', { runtime: true })) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const base = spec.split('/').reduce<string[]>((parts, part) => (part === '..' ? parts.slice(0, -1) : part === '.' || !part ? parts : [...parts, part]), []).join('/');
      const found = MODULE_ENDINGS.map((end) => base + end).find((rel) => have.has(rel));
      if (found && !carried(found)) return `${config} loads ${found}, which a publication does not carry. Move it into src/, then prepare the publication again.`;
    }
  }
  return null;
}

/**
 * Why the canonical documents copied are not the ones the project holds (an edit made outside the app that it has not
 * read yet), or null. The session's own rule for a document on disk (sameContent); an authored component's source as
 * the copy has it, its markers taken out.
 */
async function documentsUnread(dir: string, state: ProjectState): Promise<boolean> {
  const docs = stateToDocs(state);
  const paths = new Set([...(await stagedFiles(dir)).filter(isCanonicalPath), ...[...docs.keys()].filter((p) => snapshotPlace(p).kind === 'tree')]);
  for (const p of paths) {
    let mine = docs.get(p) ?? null;
    // A source there that no component names (a helper beside the components) is no document the project reads.
    if (mine === null && CUSTOM_SOURCE_RE.test(p)) continue;
    if (mine !== null && CUSTOM_SOURCE_RE.test(p)) mine = await withoutCodeMarkers(mine);
    if (!sameContent(p, await readIfExists(join(dir, p)), mine)) return true;
  }
  return false;
}

/**
 * Turn the staged copy of the project in `dir` (the website build's: snapshotSource with forBuild, from `state`) into
 * the publication, and list its files. In order: a build setting that loads a file a publication cannot carry stops;
 * everything a snapshot never holds, and every copy an editor left beside a file, goes, so nothing of theirs decides
 * what the website uses; documents the project has not read yet stop; the stops a website export makes (links to
 * drafts, a file at a draft's address, a not-found page of the author's own); the published state's components, without
 * those it neither places nor imports (their files going with them), and its generated files; a route file still
 * answering at a draft's address stops, as does a used library file that is missing; the library narrowed to what the
 * website uses and its photos cleaned; then the published state's canonical documents, the sync script gone, and the
 * README for a site without drafts.
 */
export async function projectPublication(dir: string, state: ProjectState): Promise<Projection> {
  const stop = (message: string, warnings: string[] = []): Projection => ({ ok: false, message, warnings });
  const staged = await stagedFiles(dir);
  const input = await buildInputProblem(dir, staged);
  if (input) return stop(input);
  for (const rel of staged) if (!carried(rel) || EDITOR_COPY.test(rel.slice(rel.lastIndexOf('/') + 1))) await fs.rm(join(dir, rel), { force: true });
  if (await documentsUnread(dir, state)) return stop('The project changed on disk while the publication was being prepared. Prepare the publication again in a moment.');
  const draftStop = draftLinksStop(state);
  if (draftStop) return { ok: false, ...draftStop };
  const withheld = withheldStaticFiles(dir, state)[0];
  if (withheld)
    return stop(
      withheld.markdown
        ? `${withheld.file} is served at ${withheld.route} as the Markdown copy of the draft ${withheld.draft}, so publishing the website would publish it there. Remove or move the file, then prepare the publication again.`
        : `${withheld.file} is served at ${withheld.route}, the address of the draft ${withheld.draft}, so publishing the website would publish it there. Remove or move the file, then prepare the publication again.`
    );
  const ownNotFound = ownNotFoundFileStop(dir);
  if (ownNotFound) return stop(ownNotFound);
  // The copy's generated files are the published site's (leaveOutDrafts): what they import is what the website uses.
  const live = publishedState(state);
  let projected = publicationState(state);
  const placed = placedComponents(projected);
  const dropped = new Set((await unusedComponents(dir, live)).filter((id) => !placed.has(id)));
  // Their files go before anything reads the copy for what the website uses: a picture only their code named goes too.
  for (const id of dropped) for (const rel of new Set([defFile(live.components[id]), webMcpFormFile(live.components[id])])) await fs.rm(join(dir, rel), { force: true });
  const cleaned = await withoutEditorMarkers(withoutComponents(projected, dropped));
  if (cleaned.marked) return stop(`The code of ${cleaned.marked.name} could not be read, so the editor's markers could not be taken out of it. Fix its code, then prepare the publication again.`);
  projected = cleaned.state;
  await leaveOutDrafts(dir, live, projected);
  await settleServerHook(dir, projected);
  // A route file the generator does not own (one of the author's own beside a draft's page, or a page it no longer
  // lists as its own) would still answer at an address kept back.
  // A route group's folder (`(shop)`) is no part of the address. An archive's own page at such an address, or an old
  // address's kept working there, is the generator's; any other route file there is not.
  const owned = new Set(Object.keys((JSON.parse((await readIfExists(join(dir, 'siteorigin/generated-manifest.json'))) ?? '{}') as { files?: Record<string, string> }).files ?? {}));
  const answering = new Map<string, string[]>();
  for (const f of await stagedFiles(dir)) {
    const m = /^src\/routes\/(?:(.*)\/)?\+(?:page|server)\b[^/]*$/.exec(f);
    if (!m) continue;
    const url = `/${(m[1] ?? '').split('/').filter((seg) => seg && !/^\(.*\)$/.test(seg)).join('/')}/`.replace(/^\/\/$/, '/').toLowerCase();
    answering.set(url, [...(answering.get(url) ?? []), f]);
  }
  for (const { route, draft, answered } of withheldRoutes(state, live)) {
    const file = (answering.get(route.toLowerCase()) ?? []).find((f) => !answered || !owned.has(f));
    if (file) return stop(`${file} answers at ${route}, the address of the draft ${draft}, so publishing the website would publish it there. Remove or move the file, then prepare the publication again.`);
  }
  // Nor may a layout of the author's own show around the website's page at such an address.
  const around = await answeredAddressFile(dir, state, live);
  if (around) return stop(`${around.file} is at ${around.route}, the address of the draft ${around.draft}, so publishing the website would publish it there. Remove or move the file, then prepare the publication again.`);
  const missing = (await missingWebsiteAssets(dir, projected)).filter((m) => m.used);
  if (missing.length) return { ok: false, ...missingAssetsStop(missing), assetId: missing[0].asset.id };
  const credits = await variantCredits(dir, projected);
  await pruneWebsiteAssets(dir, projected);
  const photos = await cleanWebsitePhotos(dir, projected, credits);
  if (photos.failed.length) return stop(uncleanablePhotosMessage(photos.failed));
  projected = await libraryAsShipped(dir, projected);
  await writePublicationDocs(dir, projected);
  await leaveOutSyncScript(dir);
  const readme = await readIfExists(join(dir, 'README.md'));
  if (readme !== null && isGeneratedReadme(readme)) await fs.writeFile(join(dir, 'README.md'), projectReadme(projected.site.name, false, themeNotice(getTheme(projected.site.themeId)), false, redirectHost(projected.site), false, null, runsOnNode(projected.site)));
  const listed = await publicationFiles(dir);
  if (!listed.ok) return stop(listed.message);
  return { ok: true, state: projected, files: listed.files };
}

// ---------------------------------------------------------------------------
// The tree and what is checked in it
// ---------------------------------------------------------------------------

/** One file of a publication: its path in the tree, its size and blob's name, and its bytes read again when wanted. */
export interface PublicationFile {
  path: string;
  size: number;
  oid: Oid;
  /** A file that runs (a script a build step calls), as the copy has it; never on Windows, which has no such bit. */
  executable: boolean;
  read(): Promise<Buffer>;
}

/**
 * The files of the staged publication in `dir` the snapshot allowlist takes, each with its blob's name, read one at a
 * time, so the publication is never held in memory whole; or why they cannot be one (too large, or too many), told
 * by their sizes before any is read.
 */
export async function publicationFiles(dir: string): Promise<{ ok: true; files: PublicationFile[] } | { ok: false; message: string }> {
  const listed: Array<{ path: string; abs: string; size: number; executable: boolean }> = [];
  for (const path of await stagedFiles(dir)) {
    if (!carried(path)) continue;
    const abs = join(dir, path);
    const st = await fs.stat(abs);
    listed.push({ path, abs, size: st.size, executable: process.platform !== 'win32' && (st.mode & 0o111) !== 0 });
  }
  const big = listed.find((f) => f.size > GIT_LIMITS.maxBlobBytes);
  if (big) return { ok: false, message: `${big.path} is larger than a publication can hold (${GIT_LIMITS.maxBlobBytes / 1024 / 1024} MB). Make it smaller or take it out of the website, then prepare the publication again.` };
  if (listed.reduce((n, f) => n + f.size, 0) > GIT_LIMITS.maxTotalBytes) return { ok: false, message: `The website is larger than a publication can hold (${GIT_LIMITS.maxTotalBytes / 1024 / 1024 / 1024} GB). Take some files out of it, then prepare the publication again.` };
  if (listed.length > GIT_LIMITS.maxEntries) return { ok: false, message: `The website has more files than a publication can hold (${GIT_LIMITS.maxEntries}).` };
  const files: PublicationFile[] = [];
  for (const f of listed) {
    const read = () => fs.readFile(f.abs);
    files.push({ path: f.path, size: f.size, oid: blobOid(await read()), executable: f.executable, read });
  }
  return { ok: true, files };
}

/** A file's text: UTF-8, or UTF-16 when it starts with UTF-16's byte order mark; null for a binary file (a NUL in its first 8 KB, as Git tells them). */
function textOf(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))).swap16().toString('utf16le');
  return b.subarray(0, 8000).includes(0) ? null : b.toString('utf8');
}

/**
 * An address carrying a password or a token: `scheme://user:password@host` in any scheme (a lockfile's `resolved`
 * from a private registry, a database's connection string), and `https://token@host`, as a Git host takes an access
 * token. A username alone in another scheme (`git+ssh://git@github.com`) is no credential.
 */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@"'`<>\\]*:[^\s/?#@"'`<>\\]+@[^\s/?#@"'`<>\\]|\b(?:git\+)?https?:\/\/[^\s/?#@:"'`<>\\]+@[^\s/?#@"'`<>\\]/i;
/**
 * npm's credential settings (`_authToken`, `_auth`, `_password`) given a value, as an `.npmrc` copied into a file holds
 * them; a setting left empty or filled from the environment (`${NPM_TOKEN}`) holds none.
 */
const NPM_CREDENTIAL = /(?:^|[\s"'{,;])(?:\/\/[^\s"']*:)?_(?:authToken|auth|password)\s*["']?\s*[=:]\s*["']?(?![\s"'$]|\{|process\.env\.\w|import\.meta\.env\.\w)[^\s"']{4,}/m;
/** A lockfile, whose addresses name where packages were installed from and never need a token in their query. */
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock)$/;
/** An address, and each `name=value` of its query. */
const ADDRESS = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s"'`<>\\]+/gi;
const QUERY_PART = /[?&]([A-Za-z0-9_.%-]+)=([^&#]*)/g;
/**
 * Whether a query's value is one set down as it is, not one filled in later or shown as an example: `${TOKEN}`,
 * `{token}`, `<token>`, `YOUR_PASSWORD`, or too short to be a credential.
 */
const literalValue = (v: string) => v.length >= 8 && !/^(?:\$|\{|<|%7B|%24|%3C)/i.test(v) && !/^[A-Z]+(?:_[A-Z]+)*$/.test(v) && !/^(?:x+|\*+|your[-_].*|example.*)$/i.test(v);
/**
 * Query names that only ever carry a credential, wherever an address is: a signed cloud storage link's, a client's
 * secret, a password. A page's own `key=` or `access_token=` is often a public one (a map's), so only a lockfile
 * is held to every name that may carry one.
 */
const CREDENTIAL_QUERY = new Set(['x-amz-credential', 'x-amz-signature', 'x-amz-security-token', 'x-goog-credential', 'x-goog-signature', 'client_secret', 'password', 'passwd', 'private_token']);
/** A lockfile query name that carries a credential (`access_token`, `apiKey`, `sig`), by its words: `cacheKey` is no key to anything. */
const LOCKFILE_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'auth', 'authorization', 'credential', 'credentials', 'bearer', 'jwt', 'signature', 'sig']);
const lockfileCredential = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return isSensitiveName(name) && (words.some((w) => LOCKFILE_WORDS.has(w)) || ['key', 'apikey', 'api key', 'access key', 'private key'].includes(words.join(' ')));
};
const decoded = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * Why the publication cannot be made: a file in it holds one of the user's secret `values`, or an address with a
 * password or token in it (a lockfile's with a token in its query too), or its name holds a secret. Says which file
 * without ever saying what was found (a file named with a secret is not named). Null when nothing was found.
 */
export async function credentialProblem(files: ReadonlyArray<{ path: string; oid?: Oid; read(): Promise<Uint8Array> }>, values: readonly string[]): Promise<string | null> {
  const secrets = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))];
  for (const f of files) {
    if (secrets.length && holdsSecret(f.path, secrets)) return 'A file of the website is named with one of your secrets. Rename it, then prepare the publication again.';
    const bytes = await f.read();
    // What is searched is what is committed: a file listed as other bytes is not passed as these.
    if (f.oid !== undefined && blobOid(bytes) !== f.oid) return `${f.path} changed while the publication was being prepared. Prepare the publication again.`;
    const text = textOf(bytes);
    if (text === null) continue;
    if (secrets.length && holdsSecretValue(text, secrets)) return `${f.path} holds one of your secrets. Take it out, then prepare the publication again.`;
    // An address in JSON may have its slashes escaped (`https:\/\/`), and one in HTML its ampersands (`&amp;`), which
    // hides it, or the parts of its query, from a pattern for one.
    const plain = (text.includes('\\/') ? text.replace(/\\\//g, '/') : text).replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
    const lockfile = LOCKFILE.test(f.path);
    // The query only: what follows `#` stays in the browser and is no part of the request.
    const queried = [...plain.matchAll(ADDRESS)].some(([address]) =>
      [...address.split('#')[0].matchAll(QUERY_PART)].some((m) => {
        const name = decoded(m[1]);
        return literalValue(decoded(m[2])) && (CREDENTIAL_QUERY.has(name.toLowerCase()) || (lockfile && lockfileCredential(name)));
      })
    );
    if (queried || CREDENTIAL_URL.test(plain) || NPM_CREDENTIAL.test(plain)) return `${f.path} holds a web address or setting with a password or access token in it. Take the credential out, then prepare the publication again.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The publication's history
// ---------------------------------------------------------------------------

/** The tree of the last publication, or null when there is none (or no repository yet). Writes nothing. */
export async function publishedTree(repo: GitRepository): Promise<{ commit: Oid; tree: Oid } | null> {
  if (!(await repo.exists())) return null;
  const commit = await repo.resolveRef(PUBLISH_BRANCH);
  if (!commit) return null;
  return { commit, tree: (await repo.readCommit(commit)).tree };
}

export interface CommittedPublication {
  commit: Oid;
  tree: Oid;
  /** False when the tree was the last publication's, so no commit was made. */
  changed: boolean;
}

type Failed = { ok: false; message: string; warnings: string[]; assetId?: string };
/** What preparing a publication did: its commit, or why it stopped (having moved nothing). */
export type PreparedPublication = ({ ok: true } & CommittedPublication) | Failed;
/**
 * Whether the website differs from its last publication: `prepared` is that publication's commit (null when none has
 * been prepared, which `changed` then always says), or why the website cannot be published as it is.
 */
export type PublicationStatus = { ok: true; prepared: Oid | null; changed: boolean } | Failed;

/**
 * Commit `files` (checked: credentialProblem) onto the publication's history after `last` (publishedTree, read before
 * the files were made), making the repository first if the project has none. Each file is written as a blob of its
 * own, so no request carries more than one file, then the tree from their names, then a commit that follows `last`
 * (none: the first is a root commit), and the branch is moved only from `last`, so a publication made meanwhile is a
 * conflict rather than one built on unseen. A tree the same as `last`'s writes and moves nothing, once the branch is
 * seen to be at `last` still. A move whose outcome the worker lost is read back: it happened if the branch is at the
 * new commit, and is said as unknown otherwise.
 */
export async function commitPublication(repo: GitRepository, files: readonly PublicationFile[], last: { commit: Oid; tree: Oid } | null, opts: { message?: string; now?: number; signal?: AbortSignal } = {}): Promise<CommittedPublication> {
  const call = opts.signal ? { signal: opts.signal } : {};
  const unchanged = async (tree: Oid): Promise<CommittedPublication> => {
    const at = await repo.resolveRef(PUBLISH_BRANCH, call);
    if (at !== last!.commit) throw new GitError('conflict', 'The publication branch moved while this one was being prepared.', at);
    return { commit: last!.commit, tree, changed: false };
  };
  if (last?.tree === treeOid(files)) return unchanged(last.tree);
  await repo.init(call);
  for (const f of files) {
    // Checked before it is written, so bytes other than those searched are never stored.
    const bytes = await f.read();
    if (blobOid(bytes) !== f.oid) throw new GitError('changed', `${f.path} changed while the publication was being prepared.`);
    if ((await repo.writeBlob({ bytes }, call)) !== f.oid) throw new GitError('corrupt', `The versions repository stored ${f.path} as something else.`);
  }
  const tree = await repo.writeFiles(
    files.map((f) => ({ path: f.path, oid: f.oid, ...(f.executable ? { mode: '100755' as const } : {}) })),
    call
  );
  // The tree as the repository named it: a name worked out here that differs (a name Git spells another way) only
  // costs a status that says the site changed.
  if (tree === last?.tree) return unchanged(tree);
  const who = publicationIdentity(opts.now);
  const commit = await repo.writeCommit({ tree, parents: last ? [last.commit] : [], author: who, committer: who, message: opts.message ?? 'Publish the website' }, call);
  try {
    await repo.advanceRef(PUBLISH_BRANCH, commit, last?.commit ?? null, call);
  } catch (e) {
    // The worker lost track of whether the branch moved: it did if it is at this commit now. If even that cannot be
    // read, the outcome is said as unknown.
    if (!(e instanceof GitError && e.code === 'outcome-unknown')) throw e;
    const at = await repo.resolveRef(PUBLISH_BRANCH, call).catch(() => undefined);
    if (at !== commit) throw e;
  }
  return { commit, tree, changed: true };
}
