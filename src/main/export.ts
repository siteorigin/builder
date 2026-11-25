/**
 * Export helpers: copying a clean snapshot of a project, checking it, and making the exported source ready
 * to hand over. Nothing here depends on Electron, so it is unit tested directly.
 */
import { markdownMirrorRoute } from '@shared/llms';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, promises as fs, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { AssetRecord, NodeTree, PageDoc, ProjectState } from '@shared/types';
import { documentFormat } from '@shared/document-files';
import { declaredDirection, declaredLanguage, pageDirection, pageLanguage, sameLanguage } from '@shared/languages';
import { checkPublicUrl } from '@shared/public-url';
import { STARTER_ASSETS } from '@catalogue/starters';
import { getTheme, listThemes } from '@catalogue/index';
import { formNameClashMessage, runtimeFontDiagnostics, validateState } from '@engine/validate';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { displayName } from '@engine/tree';
import { describeDraftLink, draftTarget, netlifyFormClashes, publicationIds, publicationPlan, unlinkedButtons, unlinkedMenuLinks } from '@generator/checks';
import { archivePages } from '@shared/archives';
import { declaresFormTool } from '@generator/webmcp';
import { webMcpOn } from '@shared/webmcp';
import { RUNTIME_DIR, SERVER_HOOK_FILE, defFile, webMcpFormFile, draftOnlyComponents, generateProject, generateServerHook, liveRedirects, publishedState, routeLanguages, siteEntries, isDraftEntry } from '@generator/index';
import { SEARCH_INDEX_FILE } from '@generator/search';
import { hasFeedEntries } from '@generator/rss';
import { redirectHost, VERCEL_CONFIG_FILE } from '@generator/host-redirects';
import { atomicWrite, readIfExists, removeEmptyDirs, safeJoin, sha, toJson } from './project/fsutil';
import { withoutPartMarkers } from './codecheck';
import { pageTitle, readBuildFailure, type BuildFailureContext, type BuildReport, type ExplainedBuild } from './build-failure';
import { addCredits, cleanPhoto, hasCredits, photoMetadata, sniffImageType, type PhotoCredits } from './project/photo-metadata';
import { findMissingAssetFiles, missingParts } from './project/asset-files';
import { ownServerHook } from './project/server-hook';
import type { ExportNote, MissingAssetFiles } from '@shared/api';
import { SHELL_PARTS, showsPart } from '@shared/page-shell';
import { NOT_FOUND_FILE, notFoundPath } from '@shared/not-found';

const EXCLUDE_TOP = new Set(['node_modules', '.siteorigin', '.svelte-kit', 'build', '.git', '.DS_Store']);

/** Private files that never leave the project folder. */
const PRIVATE_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/i;

/**
 * Copy the project's source from `src` to `dest`. The project brief (#518) is private to the project and is left out
 * unless `keepBrief` says the copy is the project itself (Duplicate project), so no export ever carries it.
 */
export async function copyProjectSource(src: string, dest: string, opts: { keepAsset?: (rel: string) => boolean; keepBrief?: boolean } = {}) {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      if (!inProjectSource(src, p)) return false;
      if (!opts.keepBrief && isProjectBrief(src, p)) return false;
      const rel = relative(src, p);
      if (!rel || !opts.keepAsset) return true;
      try {
        return !lstatSync(p).isFile() || opts.keepAsset(rel.split(sep).join('/'));
      } catch {
        return false;
      }
    }
  });
}

/**
 * A file in `siteorigin/` named after the brief: the brief itself, or a copy an editor left beside it (`brief.json~`,
 * `.brief.json.swp`, `#brief.json#`, `brief.json.bak`), which can hold notes the author has since taken out.
 * Without case: on a case-insensitive disk, another spelling is the same file.
 */
const BRIEF_COPY_RE = /^siteorigin\/(?:[.#]?brief\.json(?:[~#]|\.[^/]+)?)$/i;

/** Is `p` the project brief of the project in `root`, or a copy of it an editor left beside it? */
export function isProjectBrief(root: string, p: string): boolean {
  return BRIEF_COPY_RE.test(relative(root, p).split(sep).join('/'));
}

/** Is `p` part of the project source in `root`: not tools, caches, builds, private files or links? */
export function inProjectSource(root: string, p: string): boolean {
  const rel = relative(root, p);
  if (!rel) return true;
  const top = rel.split(sep)[0];
  // The editor's own data (history, which holds every version of the brief) by any spelling: on a case-insensitive
  // disk, `.SiteOrigin` is the same folder.
  if (EXCLUDE_TOP.has(top) || top.toLowerCase() === '.siteorigin' || /\.tmp$/.test(p)) return false;
  if (PRIVATE_FILE.test(basename(p))) return false;
  try {
    return !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Project files (static/assets/…) of every asset record in the library and its responsive variants, used or not. */
export function libraryAssetFiles(state: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(state.assets.assets)) {
    out.add(a.file);
    for (const v of a.variants ?? []) out.add(v.file);
  }
  return out;
}

/** The name the asset importer gives a file: a slug, eight hash characters and an optional width. */
const IMPORTED_ASSET = /^[^/]+-[0-9a-f]{8}(-\d+w)?\.[a-z0-9]+$/i;

/**
 * Which project files an export carries. Every library file stays, used or not, because the editable project
 * keeps them for later; imported images that no asset record or code component uses any more (deleted images
 * kept for undo) stay behind. Anything else in static/ was put there on purpose. The website build narrows
 * this further with pruneWebsiteAssets.
 */
export function exportedAssetFilter(state: ProjectState): (rel: string) => boolean {
  const library = libraryAssetFiles(state);
  const code = Object.values(state.components).map((d) => d.source ?? '').join('\n');
  return (rel) => {
    if (!rel.startsWith('static/assets/') || library.has(rel)) return true;
    const name = rel.slice('static/assets/'.length);
    return !IMPORTED_ASSET.test(name) || code.includes(name);
  };
}

/** Files the website build reads as text, searched for the asset file names they use. */
const TEXT_FILE = /\.(svelte|svx|[cm]?[jt]sx?|css|html?|json|webmanifest|xml|txt|svg|mdx?|csv|tsv|ya?ml|toml)$/i;

/** Does `text` name `file` as a whole file name, so that `a-1234abcd.svg` is not found inside `ba-1234abcd.svg`? */
function namesFile(text: string, file: string): boolean {
  for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) if (i === 0 || !/[\w.-]/.test(text[i - 1])) return true;
  return false;
}

/**
 * Remove the library files the public website does not use from a staged copy of the project, before it is
 * built. A file in static/assets/ that belongs to an asset record, or is named like an imported file, ships
 * only when something the build reads (src/ and static/) names it: generated pages (images and their srcset
 * variants, the favicon, social images), the @font-face rules, code components, hand-written source and other
 * public files. The authoring documents list the whole library, and the README is not part of the site, so
 * neither counts. Returns the asset records none of whose files ship, so the export can say what it left out.
 */
/**
 * A staged project's files, which of them are library files (those the website ships only when it names them), and
 * the files of components only drafts place: the published pages never import those, so a picture only they name
 * stays out of the website with the drafts.
 */
async function websiteFiles(project: string, state: ProjectState): Promise<{ files: string[]; candidate: (rel: string) => boolean; draftOnly: Set<string> }> {
  const library = libraryAssetFiles(state);
  const files = (await listFiles(project)).map((f) => f.split(sep).join('/'));
  return { files, draftOnly: new Set(draftOnlyComponents(state).map(defFile)), candidate: (rel: string) => rel.startsWith('static/assets/') && (library.has(rel) || IMPORTED_ASSET.test(rel.slice('static/assets/'.length))) };
}

/** The generated index of the pages Site search finds: the words pages show, which never load a file. */
const SEARCH_INDEX = `${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`;

/**
 * Everything the website build reads as text, apart from library files, to search for the file names it uses. A
 * draft-only component counts once anything else the website reads names its file (a code component importing it),
 * and so on through what that one names. The search index is left out: a page that mentions a file's name in its
 * text does not use that file.
 */
async function websiteText(project: string, { files, candidate, draftOnly }: { files: string[]; candidate: (rel: string) => boolean; draftOnly: Set<string> }): Promise<string> {
  const texts: string[] = [];
  const held = new Map<string, string>();
  for (const rel of files) {
    if (!/^(src|static)\//.test(rel) || candidate(rel) || !TEXT_FILE.test(rel) || rel === SEARCH_INDEX) continue;
    const text = await fs.readFile(join(project, rel), 'utf8');
    if (draftOnly.has(rel)) held.set(rel, text);
    else texts.push(text);
  }
  for (let found = true; found && held.size; ) {
    found = false;
    const read = texts.join('\n');
    for (const [rel, text] of held)
      if (namesFile(read, basename(rel))) {
        texts.push(text);
        held.delete(rel);
        found = true;
      }
  }
  return texts.join('\n');
}

export async function pruneWebsiteAssets(project: string, state: ProjectState): Promise<AssetRecord[]> {
  const site = await websiteFiles(project, state);
  const candidates = site.files.filter(site.candidate);
  if (!candidates.length) return [];
  const text = await websiteText(project, site);
  const shipped = new Set<string>();
  const removed = new Set<string>();
  for (const rel of candidates) {
    // A document by its whole name: `offer-1a2b3c4d.doc` is not named by `offer-1a2b3c4d.docx`.
    if ((documentFormat(rel) ? namesWholeFile : namesFile)(text, basename(rel))) shipped.add(rel);
    else {
      await fs.rm(join(project, rel));
      removed.add(rel);
    }
  }
  return Object.values(state.assets.assets).filter((a) => {
    const own = [a.file, ...(a.variants ?? []).map((v) => v.file)];
    return own.some((f) => removed.has(f)) && !own.some((f) => shipped.has(f));
  });
}

export interface MissingInExport {
  asset: AssetRecord;
  missing: MissingAssetFiles;
  /** Something the build reads names a missing file, so the build would fail on it. */
  used: boolean;
}

/**
 * Library images with files missing from a staged copy of the project, and whether the website uses those files:
 * generated pages, code components or other public files name one. The build would fail on a used one without
 * saying which picture it was, so the export stops first and names it.
 */
export async function missingWebsiteAssets(project: string, state: ProjectState): Promise<MissingInExport[]> {
  const missing = await findMissingAssetFiles(project, state.assets.assets);
  if (!missing.length) return [];
  const text = await websiteText(project, await websiteFiles(project, state));
  // A missing file the site names would fail the build. A missing original matters too when the site names only a
  // copy of it, since the copy's credits come from the original; a missing copy the site does not name does not.
  return missing.map((m) => {
    const asset = state.assets.assets[m.assetId];
    const named = (f: string) => namesWholeFile(text, basename(f));
    const used = [...(m.original ? [asset.file] : []), ...m.variants].some(named) || (m.original && (asset.variants ?? []).some((v) => named(v.file)));
    return { asset, missing: m, used };
  });
}

/** Like namesFile, and the name also ends there: `a-1234abcd.jpg` is not found inside `a-1234abcd.jpg.webp`. */
function namesWholeFile(text: string, file: string): boolean {
  for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) {
    const end = i + file.length;
    if ((i === 0 || !/[\w.-]/.test(text[i - 1])) && (end === text.length || !/[\w-]/.test(text[end]) && !(text[end] === '.' && /[\w]/.test(text[end + 1] ?? '')))) return true;
  }
  return false;
}

/** The export notes for library images with missing files that nothing on the site names, so the export went ahead. */
export function missingUnusedWarnings(missing: MissingInExport[]): string[] {
  return missing.filter((m) => !m.used).map(({ asset, missing: m }) => `${unnamed(asset)} is missing ${missingParts(m)} in the project folder. No page or code names ${them(m)}, so the website was exported without ${them(m)}.`);
}

/** A library file's name, or what it is when it has none. */
const unnamed = (a: AssetRecord | undefined) => (typeof a?.name === 'string' && a.name.trim()) || (a?.kind === 'document' ? 'A document' : 'An image');

/** "it" for one missing file, "them" for more. */
const them = (m: MissingAssetFiles) => ((m.original ? 1 : 0) + m.variants.length > 1 ? 'them' : 'it');

/** Why a website export stopped for images whose files are missing, and the files themselves for the details. */
export function missingAssetsStop(used: MissingInExport[]): { message: string; warnings: string[] } {
  const nameOf = unnamed;
  const warnings = used.map(({ asset, missing }) => `${nameOf(asset)}: ${[...(missing.original ? [asset.file] : []), ...missing.variants].join(', ')} not found.`);
  if (used.length === 1) {
    const { asset, missing } = used[0];
    const fix = missing.original ? 'Locate the file in Assets' : 'Make the copies again in Assets';
    return { message: `${nameOf(asset)} is missing ${missingParts(missing)} in the project folder, and the website uses ${them(missing)}. ${fix}, then export again.`, warnings };
  }
  const names = used.map((u) => nameOf(u.asset));
  const what = used.every((u) => u.asset.kind === 'document') ? 'documents' : used.some((u) => u.asset.kind === 'document') ? 'images and documents' : 'images';
  return { message: `${used.length} ${what} the website uses are missing files in the project folder: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. Fix them in Assets, then export again.`, warnings };
}

/** The export notes for an editable project that leaves out image files missing from the project folder. */
export function missingSourceWarnings(state: ProjectState, missing: MissingAssetFiles[]): string[] {
  return missing.map((m) => {
    const a = state.assets.assets[m.assetId];
    return `${unnamed(a)} is missing ${missingParts(m)} in the project folder, so the exported project does not have ${them(m)} either. Fix it in Assets and export again.`;
  });
}

/**
 * The export note listing every library asset a website export left out, if any. It says what was checked
 * rather than claiming the asset is unused: code that builds an address at runtime cannot be followed.
 */
export function omittedAssetsWarning(omitted: AssetRecord[]): string | undefined {
  const names = omitted.map((a) => a.name).sort();
  if (!names.length) return undefined;
  return names.length === 1
    ? `Left out of the website because no page or code refers to it: ${names[0]}. It stays in the project's assets.`
    : `Left out of the website because no page or code refers to them: ${names.join(', ')}. They stay in the project's assets.`;
}

// ---------------------------------------------------------------------------
// Private photo metadata
// ---------------------------------------------------------------------------

/** File names that promise a raster image, whatever their bytes turn out to be. */
const RASTER_NAME = /\.(jpe?g|jfif|png|apng|webp|gif|avif|heic|heif|tiff?)$/i;

/** Raster images under `dirs` of `root`, found by name or by their first bytes, as root-relative paths. */
async function rasterFiles(root: string, dirs: string[]): Promise<Array<{ rel: string; named: boolean }>> {
  const out: Array<{ rel: string; named: boolean }> = [];
  for (const dir of dirs) {
    for (const f of await listFiles(join(root, dir))) {
      const rel = (dir ? `${dir}/` : '') + f.split(sep).join('/');
      if (RASTER_NAME.test(rel)) {
        out.push({ rel, named: true });
        continue;
      }
      // A file that cannot even be opened is listed, so that reading it fails by name rather than here.
      const handle = await fs.open(join(root, rel), 'r').catch(() => null);
      if (!handle) {
        out.push({ rel, named: false });
        continue;
      }
      try {
        const head = Buffer.alloc(64);
        const { bytesRead } = await handle.read(head, 0, 64, 0);
        if (sniffImageType(head.subarray(0, bytesRead))) out.push({ rel, named: false });
      } catch {
        out.push({ rel, named: false });
      } finally {
        await handle.close();
      }
    }
  }
  return out;
}

/** Library assets by every project file they own: the original and each responsive copy. */
function assetsByFile(state: ProjectState): Map<string, AssetRecord> {
  const out = new Map<string, AssetRecord>();
  for (const a of Object.values(state.assets.assets)) {
    out.set(a.file, a);
    for (const v of a.variants ?? []) out.set(v.file, a);
  }
  return out;
}

/** The largest library file read for its metadata: well past the importer's 25 MB limit. */
const MAX_LIBRARY_FILE = 64 * 1024 * 1024;
const LIBRARY_FILE = /^static\/assets\/[^/\\]+$/;

/**
 * A library image's bytes, or null. The path comes from the project's documents, which can be edited by hand, so
 * only a regular file directly in static/assets/ is read: no other folder, no link, nothing implausibly large.
 */
export async function readLibraryImage(root: string, a: AssetRecord): Promise<Buffer | null> {
  if (a.kind !== 'image' || !LIBRARY_FILE.test(a.file) || a.file.includes('..')) return null;
  const path = join(root, a.file);
  try {
    const st = await fs.lstat(path);
    if (!st.isFile() || st.size > MAX_LIBRARY_FILE) return null;
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

/**
 * The credits of each library photo, keyed by the project path of each of its responsive copies. Read from the
 * staged originals before pruneWebsiteAssets runs, because a page can use a copy without its original.
 */
export async function variantCredits(project: string, state: ProjectState): Promise<Map<string, PhotoCredits>> {
  const out = new Map<string, PhotoCredits>();
  for (const a of Object.values(state.assets.assets)) {
    if (a.kind !== 'image' || !a.variants?.length) continue;
    const buf = await readLibraryImage(project, a);
    const r = buf && cleanPhoto(buf);
    if (r && hasCredits(r.credits)) for (const v of a.variants) out.set(v.file, r.credits);
  }
  return out;
}

export interface PhotoCleanup {
  /** Names of the photos whose recorded location was left out, one per asset. */
  located: string[];
  /** Files that could not be cleaned: asset names, or project paths for files outside the library. */
  failed: string[];
}

/**
 * Rewrite every raster image a visitor could download from a staged website copy without its location, device
 * and other private metadata: static/ files are published as they are, and images under src/ are emitted or
 * inlined by the build. Responsive copies get their original's credits. The project's own files are never
 * touched; this runs on the staging copy only.
 */
export async function cleanWebsitePhotos(project: string, state: ProjectState, credits: Map<string, PhotoCredits>): Promise<PhotoCleanup> {
  const owners = assetsByFile(state);
  const located = new Set<string>();
  const failed = new Set<string>();
  for (const { rel } of await rasterFiles(project, ['static', 'src'])) {
    const path = join(project, rel);
    const buf = await fs.readFile(path).catch(() => null);
    const owner = owners.get(rel);
    const r = buf && cleanPhoto(buf);
    if (!r) {
      failed.add(owner?.name ?? rel);
      continue;
    }
    if (r.location) located.add(owner?.name ?? rel);
    const inherited = credits.get(rel);
    const data = inherited ? addCredits(r.data, inherited) : r.data;
    // A new file renamed into place: a hard link back into the project is replaced, never written through.
    if (data !== buf) await atomicWrite(path, data);
  }
  return { located: [...located].sort(), failed: [...failed].sort() };
}

/** Built files that can carry an image inline, as a data: URL. */
const INLINE_HOST = /\.(html?|css|[cm]?js|json|svg|xml|webmanifest)$/i;
/**
 * A raster data: URL, with its colon and slash also accepted as HTML character references. It ends at the first
 * character a URL cannot hold, so base64 broken over lines reads as a damaged image and stops the export.
 */
const INLINE_IMAGE = /data(?::|&#0*58;|&#x0*3a;|&colon;)image(?:\/|&#0*47;|&#x0*2f;|&sol;)(jpeg|jpg|png|webp|gif|avif|heic|heif|tiff?)([^,"'()\s]*),([A-Za-z0-9+/=%._~!$&*:;@-]+)/gi;

/** Rewrite a built file, and any precompressed copy beside it, so no copy keeps the old bytes. */
async function rewriteBuilt(path: string, bytes: Buffer) {
  await atomicWrite(path, bytes);
  for (const [ext, zip] of [['.br', brotliCompressSync], ['.gz', gzipSync]] as const) if (existsSync(path + ext)) await atomicWrite(path + ext, zip(bytes));
}

/** The bytes of a data: URL's payload: percent-decoded, then base64-decoded when it says so. */
function inlineBytes(params: string, payload: string): Buffer {
  const raw = Buffer.from(payload.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return /;base64$/i.test(params) ? Buffer.from(raw.toString('latin1'), 'base64') : raw;
}

/**
 * The last pass over a finished build, before anything is published. Every raster file is cleaned again in
 * place: those that came from the cleaned sources are left exactly as they are, and any the build brought in
 * from elsewhere (a package, generated code) is cleaned now. Images inlined as data: URLs in HTML, CSS and
 * scripts are cleaned the same way and written back as base64. Returns the paths holding an image that could
 * not be read or cleaned; the export must stop if there are any.
 */
export async function cleanBuiltSite(dir: string): Promise<string[]> {
  const failed: string[] = [];
  for (const { rel } of await rasterFiles(dir, [''])) {
    const buf = await fs.readFile(join(dir, rel)).catch(() => null);
    const r = buf && cleanPhoto(buf);
    if (!r) failed.push(rel);
    // Renamed into place, so a file the build linked from elsewhere is replaced rather than written through.
    else if (r.changed) await rewriteBuilt(join(dir, rel), r.data);
  }
  for (const rel of (await listFiles(dir)).map((f) => f.split(sep).join('/'))) {
    if (!INLINE_HOST.test(rel)) continue;
    const text = await fs.readFile(join(dir, rel), 'latin1').catch(() => null);
    if (text === null) {
      failed.push(rel);
      continue;
    }
    if (!/data(?::|&#0*58;|&#x0*3a;|&colon;)image/i.test(text)) continue;
    let bad = false;
    const cleaned = text.replace(INLINE_IMAGE, (match, type: string, params: string, payload: string) => {
      const r = cleanPhoto(inlineBytes(params, payload));
      if (!r) {
        bad = true;
        return match;
      }
      return r.changed ? `data:image/${type.toLowerCase()};base64,${r.data.toString('base64')}` : match;
    });
    if (bad) failed.push(rel);
    else if (cleaned !== text) await rewriteBuilt(join(dir, rel), Buffer.from(cleaned, 'latin1'));
  }
  return failed;
}

/** Names of the library photos in a project copy that record where they were taken. */
export async function locatedPhotos(project: string, state: ProjectState): Promise<string[]> {
  const out: string[] = [];
  for (const a of Object.values(state.assets.assets)) {
    if (a.kind !== 'image') continue;
    const buf = await readLibraryImage(project, a);
    if (buf && photoMetadata(buf)?.location) out.push(a.name);
  }
  return out.sort();
}

const listNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

/** Why a website export stopped: built files with photo metadata that could not be taken out. */
export function builtPhotosMessage(failed: string[]): string {
  return `${listNames(failed)} in the built website couldn’t be checked for photo location and camera details, so the website was not exported.`;
}

/** Why a website export stopped: images whose metadata could not be taken out. */
export function uncleanablePhotosMessage(failed: string[]): string {
  return `Photo location and camera details couldn’t be removed from ${listNames(failed)}, so the website was not exported. Replace ${failed.length === 1 ? 'it' : 'them'} with a JPEG, PNG or WebP copy and export again.`;
}

/** The export note naming photos whose location was left out of the website, if any. */
export function locationRemovedNote(located: string[]): string | undefined {
  if (!located.length) return undefined;
  return located.length === 1
    ? `The website leaves out where ${located[0]} was taken. The original in your project keeps its location.`
    : `The website leaves out where these photos were taken: ${listNames(located)}. The originals in your project keep their locations.`;
}

/** The source-export note naming photos that still record a location, if any. */
export function locationKeptNote(located: string[]): string | undefined {
  if (!located.length) return undefined;
  return `${listNames(located)} still ${located.length === 1 ? 'records' : 'record'} where ${located.length === 1 ? 'it was' : 'they were'} taken. The editable project keeps photos exactly as imported; export Website files to leave locations out.`;
}

/**
 * Copy a finished export to `dest`, which must not exist yet. The name is claimed first, so the export never merges
 * into a folder that appears meanwhile; the files go to a private folder beside it, which replaces the empty claimed
 * folder only once `beforeCommit` allows. Anything someone else puts in `dest` is never removed.
 */
export async function publishFolder(from: string, dest: string, beforeCommit?: () => Promise<void>) {
  await fs.mkdir(dest);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await fs.cp(from, tmp, { recursive: true });
    // The last chance to call the export off.
    await beforeCommit?.();
    await replaceEmptyFolder(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    // Removed only while it is still the empty folder claimed above.
    await fs.rmdir(dest).catch(() => undefined);
    throw e;
  }
}

/**
 * Put `tmp` where the empty folder `dest` is. Something else there now is reported as an existing location.
 * `beforeMove` runs just before the move, after Windows has let go of the empty folder, and may still call it off.
 */
export async function replaceEmptyFolder(tmp: string, dest: string, beforeMove?: () => void) {
  const taken = () => Object.assign(new Error(`${dest} already exists.`), { code: 'EEXIST' });
  const occupied = (e: unknown, codes: string[]) => {
    if (codes.includes((e as NodeJS.ErrnoException).code ?? '')) throw taken();
    throw e;
  };
  if (process.platform !== 'win32') {
    beforeMove?.();
    // An empty folder is replaced in one step; a folder with files in it, or a file, is not.
    await fs.rename(tmp, dest).catch((e) => occupied(e, ['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR']));
    return;
  }
  // Windows cannot rename over a folder: remove the empty one first (it may already be gone).
  await fs.rmdir(dest).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') occupied(e, ['ENOTEMPTY', 'ENOTDIR', 'EEXIST']);
  });
  beforeMove?.();
  await fs.rename(tmp, dest).catch((e) => occupied(e, ['EEXIST', 'EPERM', 'ENOTEMPTY']));
}

const MANIFEST_PATH = 'siteorigin/generated-manifest.json';

/** The first generated file whose content no longer matches generated-manifest.json, or null. */
export async function editedGeneratedFile(dir: string): Promise<string | null> {
  let manifest: { files?: Record<string, string> };
  try {
    manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_PATH))) ?? '');
  } catch {
    return MANIFEST_PATH;
  }
  for (const [path, hash] of Object.entries(manifest.files ?? {}).sort()) {
    // Read as bytes: a theme's font files are generated output too.
    const disk = await fs.readFile(join(dir, path)).catch(() => null);
    if (disk === null || sha(disk) !== hash) return path;
  }
  return null;
}

/**
 * Leave the drafts out of a staged copy of the project. The generated files become the published site's: a draft has
 * no page file and no old address leading to it, links to drafts are left unlinked, and the layout, styles and sitemap
 * carry no trace of them. generated-manifest.json then lists what the copy has, so it reopens without conflicts and
 * SiteOrigin Builder writes the drafts' files back. The canonical documents keep every page, so the drafts are still
 * there to edit. Only files the manifest says SiteOrigin Builder generated are touched.
 */
export async function leaveOutDrafts(dir: string, state: ProjectState): Promise<void> {
  const live = publishedState(state);
  if (live === state) return;
  const full = generateProject(state, { instrument: false });
  const published = generateProject(live, { instrument: false });
  const manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string>; pending?: Record<string, string> };
  const files = manifest.files ?? {};
  for (const [path, content] of full) {
    if (!Object.hasOwn(files, path) && !Object.hasOwn(manifest.pending ?? {}, path)) continue;
    const next = published.get(path);
    if (next === content) continue;
    const abs = safeJoin(dir, path);
    if (next === undefined) {
      await fs.rm(abs, { force: true });
      await removeEmptyDirs(dirname(abs), join(dir, 'src'));
      delete files[path];
      if (manifest.pending) delete manifest.pending[path];
    } else {
      await fs.writeFile(abs, next);
      files[path] = sha(next);
      if (manifest.pending) delete manifest.pending[path];
    }
  }
  await fs.writeFile(join(dir, MANIFEST_PATH), toJson({ ...manifest, files: Object.fromEntries(Object.entries(files).sort()) }));
}

/**
 * Take the editor's part markers (data-so-part) out of a staged copy's code components before the website is built from
 * it: the preview finds each marked part of a code component by its marker, and the published site carries none. The
 * editable project, and its export, keep them, so the parts are still found wherever the project is opened again.
 */
export async function stripPartMarkers(project: string, state: ProjectState): Promise<void> {
  for (const def of Object.values(state.components)) {
    if (def.kind !== 'code' || def.owner !== 'project' || !def.sourcePath) continue;
    // And the copy of a contact form's code that declares its WebMCP tool, made from the same code with its markers,
    // which the website has only while it declares its tools.
    for (const path of [def.sourcePath, ...(webMcpOn(state.site) && declaresFormTool(def) ? [webMcpFormFile(def)] : [])]) {
      const abs = safeJoin(project, path);
      const source = await readIfExists(abs);
      if (source === null) continue;
      const clean = await withoutPartMarkers(source);
      if (clean !== source) await fs.writeFile(abs, clean);
    }
  }
}

/** Why a website export stopped: published pages link to drafts, which the website leaves out. Null when none do. */
export function draftLinksStop(state: ProjectState): { message: string; warnings: string[] } | null {
  const { draftLinks } = publicationPlan(state);
  if (!draftLinks.length) return null;
  const warnings = draftLinks.map((l) => describeDraftLink(state, l));
  const drafts = [...new Set(draftLinks.map((l) => draftTarget(state, l)?.title ?? 'a draft page'))];
  // A draft collection entry is named as one; pages as they always were.
  const entries = draftLinks.some((l) => l.entryId !== undefined);
  const one = entries && draftLinks.every((l) => l.entryId !== undefined) ? 'the entry' : 'the page';
  const message =
    draftLinks.length === 1
      ? `${draftLinks[0].owner.kind === 'entry' ? 'A published entry' : draftLinks[0].owner.kind === 'template' ? 'A collection layout' : 'A published page'} links to ${drafts[0]}, which is a draft and is left out of the website. Change the link or publish ${one}, then export again.`
      : `${draftLinks.length} links on published pages go to ${drafts.length === 1 ? `${drafts[0]}, a draft` : 'drafts'} the website leaves out. Change the links or publish ${drafts.length === 1 ? one : entries ? 'those drafts' : 'those pages'}, then export again.`;
  return { message, warnings };
}

/**
 * Why a website export stopped: the pages and collection entries it would publish are not the ones the author was
 * shown (a draft was published, or a page or entry kept as a draft, while the export started). Null when they are, or
 * when nothing was shown.
 */
export function publishedChanged(state: ProjectState, shown: string[] | undefined): { message: string; warnings: string[] } | null {
  if (!shown) return null;
  const now = publicationIds(publicationPlan(state));
  const was = new Set(shown);
  if (now.length === was.size && now.every((id) => was.has(id))) return null;
  return { message: 'The pages and entries the website publishes changed while the export was starting. Check the list of pages and drafts, then export again.', warnings: [] };
}

/**
 * Files of the project's own in static/ that a static host serves at a draft's address, or at an old address that
 * leads to one: a build of an exported project would publish them there. Each with the address and the draft.
 */
/** Whether a file (not a folder) is at a path. */
export function isPlainFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function withheldStaticFiles(dir: string, state: ProjectState): Array<{ file: string; route: string; draft: string; markdown?: true }> {
  const live = publishedState(state);
  if (live === state) return [];
  const out: Array<{ file: string; route: string; draft: string; markdown?: true }> = [];
  for (const { route, draft } of withheldRoutes(state, live)) {
    for (const file of [`static${route}index.html`, `static${route.replace(/\/$/, '')}.html`]) if (existsSync(join(dir, file))) out.push({ file, route, draft });
    // A Markdown copy of the page there (left from before it was a draft, say) publishes its words for AI agents.
    const copy = `static${markdownMirrorRoute(route)}`;
    if (isPlainFile(join(dir, copy))) out.push({ file: copy, route: markdownMirrorRoute(route), draft, markdown: true });
  }
  return out;
}

/**
 * The addresses the website keeps back, each with the draft it would show: every draft page's and draft entry's own,
 * and each old address that leads to one. `live` is the published state of `state`.
 */
export function withheldRoutes(state: ProjectState, live: ProjectState): Array<{ route: string; draft: string; archived?: true }> {
  if (live === state) return [];
  const kept = new Set(liveRedirects(live).map((r) => r.from.toLowerCase()));
  const shown = new Set(siteEntries(live).map((e) => e.route.toLowerCase()));
  // A collection's archive page shows at a draft's address made before archive pages: its own page there is the
  // archive's, so only another file at that address (a copy of the draft as route.html) would publish the draft.
  const archived = new Set(archivePages(live).map((p) => p.route.toLowerCase()));
  const routes: Array<{ route: string; draft: string }> = [
    ...Object.values(state.pages).filter((p) => !Object.hasOwn(live.pages, p.id)).map((p) => ({ route: p.route, draft: p.title })),
    ...siteEntries(state).filter((e) => !shown.has(e.route.toLowerCase())).map((e) => ({ route: e.route, draft: e.entry.title })),
    ...liveRedirects(state).filter((r) => !kept.has(r.from.toLowerCase())).map((r) => ({ route: r.from, draft: r.title }))
  ];
  return routes.map((r) => (archived.has(r.route.toLowerCase()) ? { ...r, archived: true as const } : r));
}

/** Notes for an editable project with drafts: they are kept to edit, and its own build leaves them out. */
export function draftSourceNotes(state: ProjectState): string[] {
  const { drafts, draftLinks } = publicationPlan(state);
  // Draft collection entries are kept the same way.
  const names = [...drafts.map((p) => p.title), ...siteEntries(state).filter((e) => isDraftEntry(e.entry)).map((e) => e.entry.title)];
  if (!names.length) return [];
  const notes = [
    `${names.length === 1 ? `The draft ${names[0]} is` : `The drafts ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are`} kept in the project to edit in SiteOrigin Builder, and left out of its website build.`
  ];
  if (draftLinks.length) notes.push(`These links on published pages go to drafts, which the exported project's own build leaves out. Change them or publish the drafts before building it:`, ...draftLinks.map((l) => describeDraftLink(state, l)));
  return notes;
}

/** Content hash of everything an export reads: source, public files, the canonical documents and Vercel's rules. */
export async function projectFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const top of ['src', 'static', 'siteorigin']) {
    for (const f of (await listFiles(join(dir, top))).filter((n) => !n.endsWith('.tmp')).sort()) parts.push(`${top}/${f}:${sha(await fs.readFile(join(dir, top, f)))}`);
  }
  // Read only as a plain file: anything else there (a pipe, say) is no file of the website's.
  const vercel = isPlainFile(join(dir, VERCEL_CONFIG_FILE)) ? await fs.readFile(join(dir, VERCEL_CONFIG_FILE)).catch(() => null) : null;
  if (vercel) parts.push(`${VERCEL_CONFIG_FILE}:${sha(vercel)}`);
  return sha(parts.join('\n'));
}

/**
 * Puts the staged project's vercel.json (its redirect rules for Vercel, already without the drafts) at the root of the
 * built website, where Vercel reads it when that folder is deployed: while the site is published on Vercel, and only
 * the one SiteOrigin Builder generated (a vercel.json of the author's own beside package.json configures their
 * project, not the website). A file of the author's own already in the website (from static/) is never replaced:
 * the reason the export stops is returned.
 */
export async function deliverVercelConfig(project: string, out: string, live: ProjectState): Promise<string | null> {
  if (redirectHost(live.site) !== 'vercel') return null;
  // leaveOutDrafts lists in the manifest exactly the generated files the staged copy has.
  let manifest: { files?: Record<string, string> } = {};
  try {
    manifest = JSON.parse((await readIfExists(join(project, MANIFEST_PATH))) ?? '{}');
  } catch {
    return null;
  }
  if (!Object.hasOwn(manifest.files ?? {}, VERCEL_CONFIG_FILE) || !isPlainFile(join(project, VERCEL_CONFIG_FILE))) return null;
  const config = await fs.readFile(join(project, VERCEL_CONFIG_FILE));
  const there = join(out, VERCEL_CONFIG_FILE);
  if (existsSync(there)) return `static/${VERCEL_CONFIG_FILE} takes the place of the redirect rules SiteOrigin Builder writes for Vercel. Delete or rename it, or choose another host in Site settings under Redirects, then export again.`;
  await fs.writeFile(there, config);
  return null;
}

/** Old exported projects pinned Node more tightly than the toolchain needs, which broke hosted builds. */
const LEGACY_ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';
export const NODE_ENGINES = '>=22.17.0';

/** Make an exported source project ready to hand over: current README, notices and a portable engines field. */
export async function finishExportedSource(dest: string, state: ProjectState, noticePath: string) {
  const readmePath = join(dest, 'README.md');
  const readme = await readIfExists(readmePath);
  if (readme === null || isGeneratedReadme(readme)) await fs.writeFile(readmePath, projectReadme(state.site.name, publicationPlan(state).drafts.length > 0, themeNotice(getTheme(state.site.themeId)), siteEntries(state).some((e) => isDraftEntry(e.entry))));
  const usesSamples = STARTER_ASSETS.some((a) => state.assets.assets[a.id]);
  if (usesSamples && !existsSync(join(dest, 'NOTICE.md')) && existsSync(noticePath)) await fs.copyFile(noticePath, join(dest, 'NOTICE.md'));
  for (const [file, at] of [['package.json', (j: Record<string, any>) => j], ['package-lock.json', (j: Record<string, any>) => j.packages?.['']]] as const) {
    const text = await readIfExists(join(dest, file));
    if (!text) continue;
    const json = JSON.parse(text);
    const target = at(json);
    if (target?.engines?.node === LEGACY_ENGINES) {
      target.engines.node = NODE_ENGINES;
      await fs.writeFile(join(dest, file), JSON.stringify(json, null, '\t') + '\n');
    }
  }
}

export async function listFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const README_INTRO = 'This website was created with [SiteOrigin Builder](https://siteorigin.com).';

/** Whether a README is one this app wrote (current or earlier wording) rather than the owner's own. */
export function isGeneratedReadme(text: string): boolean {
  // A checkout may have converted the line endings of an otherwise untouched file.
  const normalized = text.replace(/\r\n/g, '\n');
  const title = normalized.match(/^# (.*)\n/)?.[1];
  if (title === undefined) return false;
  // The notices name the site's theme: one written for any installed theme, word for word, is still the app's. An
  // owner's change to them (another licence, say) makes the README theirs.
  const notices = [...new Set([NOTICE, NPM_FONTS_NOTICE, ...listThemes().map(themeNotice)])];
  return [
    ...notices.flatMap((n) => [projectReadme(title, false, n), projectReadme(title, true, n), projectReadme(title, false, n, true), projectReadme(title, true, n, true)]),
    legacyReadme(title)
  ].includes(normalized);
}

/** Why a README's build leaves pages out, and what opening the project in SiteOrigin Builder changes about that. */
const DRAFTS_SECTION = `## Draft pages

This project has draft pages. Their documents are in \`siteorigin/pages/\`, but this export has no page files for them, so \`npm run build\` leaves them out. Opening the project in SiteOrigin Builder writes their files back for editing and previewing, and from then on a build of that folder includes them: export the website from SiteOrigin Builder to publish without drafts.

`;

/** The same for draft collection entries, whose documents live with their collections. */
const DRAFT_ENTRIES_SECTION = `## Draft entries

This project has draft collection entries. Their documents are in \`siteorigin/collections/\`, but this export has no page files for them, so \`npm run build\` leaves them out. Opening the project in SiteOrigin Builder writes their files back for editing and previewing, and from then on a build of that folder includes them: export the website from SiteOrigin Builder to publish without drafts.

`;

/** The notices of a site with this theme: its name and licence, the icons' and the fonts' (whose own notice travels with them). */
export function themeNotice(theme: { name: string; license: string }): string {
  return `The ${theme.name} theme is licensed under ${theme.license}. Icons come from Lucide (ISC licence). The fonts come with the theme, in \`src/lib/siteorigin/fonts/\`, whose NOTICE.txt gives their licences. Sample images from the Business starter, where still used, are described in NOTICE.md.`;
}
/** The notices of a site on Foundation, the theme every new project starts with. */
const NOTICE = themeNotice({ name: 'Foundation', license: 'MIT-0' });
/** The notices from before fonts came with the theme, recognised so that exports can bring them up to date. */
const NPM_FONTS_NOTICE =
  'The Foundation theme is licensed under GPL-3.0-or-later. Icons come from Lucide (ISC licence). Fonts are licensed under the SIL Open Font License 1.1 and are installed from npm (@fontsource-variable). Sample images from the Business starter, where still used, are described in NOTICE.md.';

/** The README an exported project gets. One exported with drafts says how its build treats them. */
export function projectReadme(name: string, drafts = false, notice = NOTICE, draftEntries = false): string {
  return `# ${name}

${README_INTRO} It is a normal [SvelteKit](https://svelte.dev/docs/kit) project and does not need SiteOrigin Builder to run or build.

## Requirements

- Node.js 22.17 or newer (24 LTS recommended)

## Commands

\`\`\`sh
npm ci          # install the locked dependencies
npm run dev     # start a local development server
npm run build   # build the static website into build/
npm run preview # preview the production build
\`\`\`

The static website is written to \`build/\`. Upload the contents of that folder to any static host. If the site lives in a sub-folder (for example on GitHub Pages), that path comes from \`src/lib/siteorigin/paths.json\`.

## Project layout

- \`src/routes/\` and \`src/lib/siteorigin/\`: generated SvelteKit pages, components and styles.
- \`src/lib/siteorigin/custom/\`: code components you wrote. These are yours to edit.
- \`siteorigin/\` and \`siteorigin.project.json\`: SiteOrigin Builder's editable documents. Keep them if you want to keep editing visually.

Files generated by SiteOrigin Builder start with a comment. If you edit them by hand, SiteOrigin Builder keeps your version and asks before regenerating them.

${drafts ? DRAFTS_SECTION : ''}${draftEntries ? DRAFT_ENTRIES_SECTION : ''}## Notices

${notice}
`;
}

/** The README written by earlier versions, recognised so that exports can bring it up to date. */
function legacyReadme(name: string): string {
  return `# ${name}

${README_INTRO} It is a normal [SvelteKit](https://svelte.dev/docs/kit) project and does not need SiteOrigin Builder to run or build.

## Requirements

- Node.js 22.22 or newer (24 LTS recommended)

## Commands

\`\`\`sh
npm ci          # install the locked dependencies
npm run dev     # start a local development server
npm run build   # build the static website into build/
npm run preview # preview the production build
\`\`\`

The static website is written to \`build/\`. Upload the contents of that folder to any static host.

## Project layout

- \`src/routes/\` and \`src/lib/siteorigin/\`: generated SvelteKit pages, components and styles.
- \`src/lib/siteorigin/custom/\`: code components you wrote. These are yours to edit.
- \`siteorigin/\` and \`siteorigin.project.json\`: SiteOrigin Builder's editable documents. Keep them if you want to keep editing visually.

Files generated by SiteOrigin Builder start with a comment. If you edit them by hand, SiteOrigin Builder keeps your version and asks before regenerating them.

## Notices

The Foundation theme is licensed under GPL-3.0-or-later. Icons come from Lucide (ISC licence). Inter and Fraunces fonts are licensed under the SIL Open Font License 1.1 and are installed from npm (@fontsource-variable).
`;
}

/** A path inside `parent` that does not exist yet: `base`, then `base-2`, `base-3`, … */
export function uniqueChild(parent: string, base: string): string {
  let p = join(parent, base);
  for (let i = 2; existsSync(p); i++) p = join(parent, `${base}-${i}`);
  return p;
}

/** Project health's messages for links to sections their pages do not have. */
export function brokenSectionLinks(state: ProjectState): string[] {
  return validateState(state)
    .filter((d) => d.code === 'LINK_SECTION_MISSING')
    .map((d) => d.message);
}

/**
 * Why the website cannot be exported when it needs the language part of the generated server hook (it has pages in
 * another language) and the project has a hook of its own: SvelteKit would run one of them and skip the other. Null
 * otherwise. A generated hook not written yet is no reason: the staged copy is settled (settleServerHook).
 */
export async function rivalHookStop(dir: string, state: ProjectState): Promise<string | null> {
  if (!routeLanguages(state).length) return null;
  const manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string>; pending?: Record<string, string> };
  const claimed = Object.hasOwn(manifest.files ?? {}, SERVER_HOOK_FILE) || Object.hasOwn(manifest.pending ?? {}, SERVER_HOOK_FILE);
  const own = ownServerHook(dir, claimed);
  return own ? `Pages written in another language need SiteOrigin Builder's ${SERVER_HOOK_FILE}, and this project has a server hook of its own (${own}): SvelteKit runs only one of them. Rename or remove yours, then export again.` : null;
}

/**
 * Why the exported site has no canonical links, social image URLs or sitemap (nor an RSS feed, when it publishes
 * posts): no public URL is set, or the one saved can't be used (saved by hand or by an earlier version). Null when the
 * site has a public URL it was built from.
 */
export function publicUrlWarning(state: ProjectState): string | null {
  // A value of another kind (a number written by hand) is a URL that can't be used, not a missing one.
  const raw: unknown = state.site.baseUrl;
  const saved = typeof raw === 'string' ? raw.trim() : raw == null ? '' : JSON.stringify(raw);
  const check = checkPublicUrl(saved);
  if (check.ok && check.url) return null;
  // A feed reader needs each post's full address, so a site that publishes posts loses its feed too.
  const omitted = hasFeedEntries(state) ? 'canonical links, social image URLs, the sitemap and the RSS feed' : 'canonical links, social image URLs and the sitemap';
  if (!check.ok) return `The public site URL “${saved}” can’t be used, so ${omitted} were omitted. ${check.message} Correct the Public URL in Site styles › Site details.`;
  // Optional: a site handed over without a domain of its own is still a whole website.
  return `No public site URL is set, so ${omitted} were omitted. If the site will have its own address, add it as the Public URL in Site styles › Site details.`;
}

/** The public URL warning as an export note, leading to the Public URL field. */
export function publicUrlNote(state: ProjectState): ExportNote | null {
  const message = publicUrlWarning(state);
  return message ? { message, destination: { kind: 'site', field: 'baseUrl' } } : null;
}


/**
 * A built page that does not declare the language it is written in: the project's own server hook or page template
 * took over from the generated ones. Null when it declares its own.
 */
export function pageLanguageWarning(state: ProjectState, page: PageDoc, html: string): string | null {
  const expected = pageLanguage(state.site, page);
  const found = declaredLanguage(html);
  if (!found || !sameLanguage(found, expected))
    return `“${page.title}” (${page.route}) was built ${found ? `as “${found}”` : 'without a language'}, not “${expected}”: the project’s own src/app.html or server hook may be setting it.`;
  // The way its text runs, which browsers otherwise take as left to right.
  const dir = pageDirection(state.site, page);
  const foundDir = declaredDirection(html)?.toLowerCase() ?? null;
  if (foundDir === dir) return null;
  const as = (d: string | null) => (d === 'rtl' ? 'right to left' : d === 'ltr' ? 'left to right' : d ? `“${d}”` : 'without a direction');
  return `“${page.title}” (${page.route}) was built ${foundDir ? `to run ${as(foundDir)}` : 'without a direction'}, not ${as(dir)}: the project’s own src/app.html or server hook may be setting it.`;
}

/** Warnings for a source export whose links would stop the exported project from building. */
export function sectionLinkWarnings(state: ProjectState): string[] {
  const broken = brokenSectionLinks(state);
  if (!broken.length) return [];
  const lead = broken.length === 1 ? 'Project health found a link to a section its page does not have. Fix it before building the exported project:' : `Project health found ${broken.length} links to sections their pages do not have. Fix them before building the exported project:`;
  return [lead, ...broken];
}

/** Warnings for contact forms that send to Netlify under one form name, one per name. */
export function formNameWarnings(state: ProjectState): string[] {
  return netlifyFormClashes(state).map((clash) => formNameClashMessage(state, clash));
}

/** Warnings for code components that may show a theme font the site leaves out. */
export function runtimeFontWarnings(state: ProjectState): string[] {
  return runtimeFontDiagnostics(state).map((d) => d.message);
}

/** How many unlinked buttons an export warning names before it sums up the rest. */
const UNLINKED_LISTED = 6;

/**
 * The trees the site renders, named for a warning: the pages in site order, then the shared header and footer when a
 * page shows them, or any published collection entry (an entry shows both).
 */
function siteTrees(state: ProjectState): Array<{ tree: NodeTree; label: string }> {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  // A collection's index (an archive page) shows both too.
  const entryShown = siteEntries(state).some((e) => !isDraftEntry(e.entry)) || archivePages(state).length > 0;
  const shell = SHELL_PARTS.filter((part) => entryShown || pages.some((p) => showsPart(p, part))).map((part) => ({ tree: state.site.shell[part], label: part === 'header' ? 'Header' : 'Footer' }));
  return [...pages.map((p) => ({ tree: p, label: p.title })), ...shell];
}

/**
 * Warnings for buttons the site leaves out because they have no destination: the pages (and the shared header or
 * footer, when a page shows it) in site order, each button named by where it is and its label.
 */
export function unlinkedButtonWarnings(state: ProjectState): string[] {
  const found: string[] = [];
  for (const { tree, label } of siteTrees(state)) {
    for (const b of unlinkedButtons(state, tree)) {
      const node = tree.nodes[b.nodeId];
      const where = node && node.kind === 'instance' ? `${label} · ${displayName(state, node)}` : label;
      found.push(`${where}: “${b.label}”`);
    }
  }
  if (!found.length) return [];
  const lead =
    found.length === 1
      ? 'A button has no link, so it was left out of the site. Choose where it goes in the editor, or hide it:'
      : `${found.length} buttons have no link, so they were left out of the site. Choose where each one goes in the editor, or hide it:`;
  const more = found.length - UNLINKED_LISTED;
  return [lead, ...(more > 1 ? [...found.slice(0, UNLINKED_LISTED), `…and ${more} more.`] : found)];
}

/** Warnings for header menu links with nowhere to go, which the site shows as words that lead nowhere: where each is, and its label. */
export function unlinkedMenuLinkWarnings(state: ProjectState): string[] {
  const found = siteTrees(state).flatMap(({ tree, label }) => unlinkedMenuLinks(state, tree).map((m) => `${label}: “${m.label}”`));
  if (!found.length) return [];
  const lead =
    found.length === 1
      ? 'A menu link has no destination, so it goes nowhere. Choose where it goes in the editor, or remove it from the menu:'
      : `${found.length} menu links have no destination, so they go nowhere. Choose where each one goes in the editor, or remove it from the menu:`;
  const more = found.length - UNLINKED_LISTED;
  return [lead, ...(more > 1 ? [...found.slice(0, UNLINKED_LISTED), `…and ${more} more.`] : found)];
}

/**
 * Why a production build failed, in words a person can act on: the page or file it was building, what went wrong,
 * and a report to copy into a support request. When the build refused a link to a missing section (SvelteKit's
 * prerender checks every #fragment), the links Project health found lead the details.
 */
const MISSING_ID = /no element with id|handleMissingId|prerender_missing_id/i;

export function explainBuildFailure(state: ProjectState, build: BuildReport, ctx: BuildFailureContext = {}): { message: string; warnings: string[]; details: string } {
  const read = readBuildFailure(state, build, ctx);
  const all = read.entries;
  if (!MISSING_ID.test(all.join('\n'))) return generalFailure(read);
  const done = (message: string, warnings: string[]) => ({ message, warnings, details: read.report(message) });
  // The lines that name the page and the missing ID come first, so a long build log cannot push them out.
  const named = all.flatMap((d) => d.split('\n')).filter((l) => MISSING_ID.test(l)).map((l) => l.trim());
  const details = [...new Set([...named, ...all])];
  const broken = brokenSectionLinks(state);
  // Project health cannot see IDs a code component computes or hides, so the build may know of a link it does not.
  if (!broken.length) return done('The production build failed because a link goes to a section its page does not have. The details below name the page and the missing ID.', details.slice(0, 8));
  // The build's own lines keep a place however many links Project health lists: they may name one it missed.
  const kept = named.slice(0, 3);
  return done(
    `The production build failed because ${broken.length === 1 ? 'a link goes to a section its page does not have' : 'links go to sections their pages do not have'}. Choose a section for ${broken.length === 1 ? 'the link' : 'each link'} in Project health, then export again.`,
    [...new Set([...broken.slice(0, 8 - kept.length), ...kept, ...details])].slice(0, 8)
  );
}

/** Any other failure: the headline names where the build was, and the first details say what went wrong. */
function generalFailure(read: ExplainedBuild): { message: string; warnings: string[]; details: string } {
  const { page, route, file, line, component } = read.where;
  const place = file ? `${file}${line ? `, line ${line}` : ''}` : '';
  // A project component is named as the author knows it; its file is how a developer finds it.
  const at = component ? `the “${component}” component (${place})` : place;
  const message = page ? `The production build failed while building the ${pageTitle(page)} page (${route}).` : route ? `The production build failed while building ${route}.` : at ? `The production build failed in ${at}.` : 'The production build failed.';
  const warnings = [...read.causes];
  if (at && (page || route)) warnings.push(`The build was working in ${at}.`);
  if (!warnings.length) warnings.push('The build did not say what went wrong. The technical details list everything it printed.');
  return { message, warnings: warnings.slice(0, 8), details: read.report(message) };
}


/** Markup and code only the editor's preview may carry. */
const EDITOR_MARKUP = /data-so-(ctx|node)|siteorigin-bridge/;

/** A start tag as Svelte writes one, in a page or in a script's template, with its attributes. */
const START_TAG = /<[a-zA-Z][^\s/>]*((?:\s+[^\s"'=<>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const TAG_ATTRIBUTE = /\s([^\s"'=<>/]+)(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Whether built HTML, or a built script's templates, give an element a code component's part marker (data-so-part),
 * which the website's build takes out of the code (see stripPartMarkers). Read as attributes of start tags, so words
 * that only mention the marker (a title, a page's text) are the site's own.
 */
export function carriesPartMarker(text: string): boolean {
  if (!text.includes('data-so-part')) return false;
  for (const tag of text.matchAll(START_TAG)) for (const a of tag[1].matchAll(TAG_ATTRIBUTE)) if (a[1].toLowerCase() === 'data-so-part') return true;
  return false;
}

/** Start tags as Svelte writes them, and whole scripts and styles; see NOT_FOUND_JS, which makes these addresses absolute. */
const BUILT_PARTS = /<script(?=[\s/>])[^>]*>[\s\S]*?<\/script\s*>|<style(?=[\s/>])[^>]*>[\s\S]*?<\/style\s*>|<[a-zA-Z][^\s/>]*(?:\s+[^\s"'=<>/]+(?:="[^"]*")?)*\s*\/?>/gi;
const BUILT_ATTRIBUTE = /\s([^\s"'=<>/]+)="([^"]*)"/g;
/**
 * Relative to the page: no scheme ("https:", "mailto:"), not from the root or another host, not a query or a fragment,
 * read as browsers read it, without the spaces around it.
 */
const PAGE_RELATIVE = (url: string) => {
  const u = url.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  return u !== '' && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(u);
};
/** url() in a style attribute, whose quotes Svelte writes as &quot;: quoted, it may hold anything. */
const STYLE_URL = /url\(\s*(?:(&quot;|&#39;|')(.*?)\1|([^\s)'"&][^\s)'"]*))\s*\)/gi;
/** HTML's whitespace, which separates srcset candidates (a no-break space does not). */
const SPACE = /[\t\n\f\r ]/;

/**
 * The address of each srcset candidate, read as browsers read it: it runs to the next space, commas at its end
 * separate it from the next candidate, and otherwise its descriptors run to the next comma outside brackets.
 */
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (SPACE.test(value[i]) || value[i] === ',')) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !SPACE.test(value[j])) j++;
    const word = value.slice(i, j);
    const url = word.replace(/,+$/, '');
    urls.push(url);
    i = j;
    if (word.length > url.length) continue;
    for (let depth = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth = Math.max(0, depth - 1);
      else if (value[i] === ',' && !depth) break;
    }
  }
  return urls;
}

/**
 * Addresses in a built page that are relative to wherever it is shown ("./_app/…", "about/", or SvelteKit working
 * out the site's root from the address), listed as found. The not-found page must have none: hosts show it at any
 * address.
 */
export function pageRelativeAddresses(html: string): string[] {
  const found: string[] = [];
  for (const [part] of html.matchAll(BUILT_PARTS)) {
    if (/^<style(?=[\s/>])/i.test(part)) continue;
    const script = /^<script(?=[\s/>])/i.test(part);
    const tag = script ? (/^<script[^>]*>/i.exec(part)?.[0] ?? '') : part;
    for (const [, name, value] of tag.matchAll(BUILT_ATTRIBUTE)) {
      const key = name.toLowerCase();
      if (['href', 'xlink:href', 'src', 'action', 'formaction', 'poster'].includes(key) && PAGE_RELATIVE(value)) found.push(value);
      if (key === 'srcset' || key === 'imagesrcset') found.push(...srcsetUrls(value).filter(PAGE_RELATIVE));
      if (key === 'style') for (const [, quote, quoted, bare] of value.matchAll(STYLE_URL)) if (PAGE_RELATIVE(quote ? quoted : bare)) found.push(quote ? quoted : bare);
    }
    if (script && part.includes('__sveltekit_')) {
      for (const [expr] of part.matchAll(/new URL\([^)]*,\s*location\)/g)) found.push(expr);
      for (const [, , url] of part.matchAll(/import\((["'`])([^"'`\s]*)\1\)/g)) if (PAGE_RELATIVE(url)) found.push(url);
    }
  }
  return found;
}

/** Why the built not-found page cannot be exported, or null. `html` is null when the build did not write it as a file. */
export function notFoundPageProblem(html: string | null): string | null {
  if (html === null) return `The build is missing ${NOT_FOUND_FILE}, the page shown at addresses the site does not have.`;
  if (EDITOR_MARKUP.test(html) || carriesPartMarker(html)) return `Editor-only markup was found in ${NOT_FOUND_FILE}. Export aborted.`;
  return null;
}

/** The built not-found page in `out`, or null when the build did not write it as a plain file. */
export async function readNotFoundPage(out: string): Promise<string | null> {
  const file = join(out, NOT_FOUND_FILE);
  const stat = await fs.lstat(file).catch(() => null);
  return stat?.isFile() ? fs.readFile(file, 'utf8') : null;
}

/** Is there a 404.html of the project's own in static/ that the website build would copy: a file, a link or a folder with files? */
function ownNotFoundFile(project: string): boolean {
  const path = join(project, 'static', NOT_FOUND_FILE);
  try {
    const stat = lstatSync(path);
    return !stat.isDirectory() || readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** Why a project cannot build its website because of a not-found page of its own in static/, or null. */
export function ownNotFoundFileStop(project: string): string | null {
  return ownNotFoundFile(project)
    ? `static/${NOT_FOUND_FILE} takes the place of the not-found page SiteOrigin Builder generates, and the website cannot have both. Delete or rename static/${NOT_FOUND_FILE} (the page's wording is set in Site styles, under Not-found page), then export again.`
    : null;
}

/** The note for an editable project whose build would fail on a not-found page of its own in static/, or null. */
export function ownNotFoundFileNote(project: string): string | null {
  return ownNotFoundFile(project)
    ? `static/${NOT_FOUND_FILE} takes the place of the not-found page SiteOrigin Builder generates, so a build of the exported project fails until it is deleted or renamed.`
    : null;
}

/** The export note for a not-found page that keeps addresses relative to where it was built, or null. */
export function notFoundAddressWarning(html: string): string | null {
  const left = pageRelativeAddresses(html);
  return left.length
    ? `${NOT_FOUND_FILE}, the not-found page, still uses addresses relative to where it was built (${left[0]}), so at deeper missing addresses it may show without the site's styles and links. This happens when the project has a server hook of its own (src/hooks.server) in place of the generated one.`
    : null;
}

/** What an author needs to know to have their host show the not-found page, for a site published under `base`. */
export function notFoundHostNote(base: string): string {
  const path = notFoundPath(base);
  return `Addresses your site does not have show its not-found page, ${NOT_FOUND_FILE}. Netlify, Cloudflare Pages and GitHub Pages use it automatically when they publish the exported website as it is. On other hosts, set the 404 error document to ${path} (on Apache: ErrorDocument 404 ${path}).`;
}

/**
 * SvelteKit runs one server hook. The project's files can be a step behind a hook of its own (src/hooks.server.ts, or
 * a file or folder named src/hooks.server) added or removed since SiteOrigin Builder last wrote them: a staged copy
 * settles it as the next regeneration would, leaving the generated src/hooks.server.js out beside the project's own,
 * and writing it when there is no hook at all. generated-manifest.json then lists what the copy has.
 */
export async function settleServerHook(dir: string, state: ProjectState): Promise<void> {
  const manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string> };
  const files = (manifest.files ??= {});
  const own = ownServerHook(dir, Object.hasOwn(files, SERVER_HOOK_FILE));
  if (own && Object.hasOwn(files, SERVER_HOOK_FILE)) {
    await fs.rm(join(dir, SERVER_HOOK_FILE), { force: true });
    delete files[SERVER_HOOK_FILE];
  } else if (!own && !existsSync(join(dir, SERVER_HOOK_FILE))) {
    const hook = generateServerHook(state);
    await fs.writeFile(join(dir, SERVER_HOOK_FILE), hook);
    files[SERVER_HOOK_FILE] = sha(hook);
  } else return;
  await fs.writeFile(join(dir, MANIFEST_PATH), toJson(manifest));
}
