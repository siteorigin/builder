/**
 * Export helpers: copying a clean snapshot of a project, checking it, and making the exported source ready
 * to hand over. Nothing here depends on Electron, so it is unit tested directly.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, promises as fs } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { AssetRecord, ProjectState } from '@shared/types';
import { STARTER_ASSETS } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { displayName } from '@engine/tree';
import { unlinkedButtons } from '@generator/checks';
import { atomicWrite, readIfExists, sha } from './project/fsutil';
import { pageTitle, readBuildFailure, type BuildFailureContext, type BuildReport, type ExplainedBuild } from './build-failure';
import { addCredits, cleanPhoto, hasCredits, photoMetadata, sniffImageType, type PhotoCredits } from './project/photo-metadata';
import { findMissingAssetFiles, missingParts } from './project/asset-files';
import type { MissingAssetFiles } from '@shared/api';

const EXCLUDE_TOP = new Set(['node_modules', '.siteorigin', '.svelte-kit', 'build', '.git', '.DS_Store']);

/** Private files that never leave the project folder. */
const PRIVATE_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/i;

export async function copyProjectSource(src: string, dest: string, opts: { keepAsset?: (rel: string) => boolean } = {}) {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      if (!inProjectSource(src, p)) return false;
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

/** Is `p` part of the project source in `root`: not tools, caches, builds, private files or links? */
export function inProjectSource(root: string, p: string): boolean {
  const rel = relative(root, p);
  if (!rel) return true;
  const top = rel.split(sep)[0];
  if (EXCLUDE_TOP.has(top) || /\.tmp$/.test(p)) return false;
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
/** A staged project's files, and which of them are library files: those the website ships only when it names them. */
async function websiteFiles(project: string, state: ProjectState): Promise<{ files: string[]; candidate: (rel: string) => boolean }> {
  const library = libraryAssetFiles(state);
  const files = (await listFiles(project)).map((f) => f.split(sep).join('/'));
  return { files, candidate: (rel: string) => rel.startsWith('static/assets/') && (library.has(rel) || IMPORTED_ASSET.test(rel.slice('static/assets/'.length))) };
}

/** Everything the website build reads as text, apart from library files, to search for the file names it uses. */
async function websiteText(project: string, { files, candidate }: { files: string[]; candidate: (rel: string) => boolean }): Promise<string> {
  const texts: string[] = [];
  for (const rel of files) {
    if (!/^(src|static)\//.test(rel) || candidate(rel) || !TEXT_FILE.test(rel)) continue;
    texts.push(await fs.readFile(join(project, rel), 'utf8'));
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
    if (namesFile(text, basename(rel))) shipped.add(rel);
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
  return missing.filter((m) => !m.used).map(({ asset, missing: m }) => `${asset.name.trim() || 'An image'} is missing ${missingParts(m)} in the project folder. No page or code names ${them(m)}, so the website was exported without ${them(m)}.`);
}

/** "it" for one missing file, "them" for more. */
const them = (m: MissingAssetFiles) => ((m.original ? 1 : 0) + m.variants.length > 1 ? 'them' : 'it');

/** Why a website export stopped for images whose files are missing, and the files themselves for the details. */
export function missingAssetsStop(used: MissingInExport[]): { message: string; warnings: string[] } {
  const nameOf = (a: AssetRecord) => a.name.trim() || 'An image';
  const warnings = used.map(({ asset, missing }) => `${nameOf(asset)}: ${[...(missing.original ? [asset.file] : []), ...missing.variants].join(', ')} not found.`);
  if (used.length === 1) {
    const { asset, missing } = used[0];
    const fix = missing.original ? 'Locate the file in Assets' : 'Make the copies again in Assets';
    return { message: `${nameOf(asset)} is missing ${missingParts(missing)} in the project folder, and the website uses ${them(missing)}. ${fix}, then export again.`, warnings };
  }
  const names = used.map((u) => nameOf(u.asset));
  return { message: `${used.length} images the website uses are missing files in the project folder: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. Fix them in Assets, then export again.`, warnings };
}

/** The export notes for an editable project that leaves out image files missing from the project folder. */
export function missingSourceWarnings(state: ProjectState, missing: MissingAssetFiles[]): string[] {
  return missing.map((m) => {
    const a = state.assets.assets[m.assetId];
    return `${a?.name.trim() || 'An image'} is missing ${missingParts(m)} in the project folder, so the exported project does not have ${them(m)} either. Fix it in Assets and export again.`;
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

/** Put `tmp` where the empty folder `dest` is. Something else there now is reported as an existing location. */
async function replaceEmptyFolder(tmp: string, dest: string) {
  const taken = () => Object.assign(new Error(`${dest} already exists.`), { code: 'EEXIST' });
  const occupied = (e: unknown, codes: string[]) => {
    if (codes.includes((e as NodeJS.ErrnoException).code ?? '')) throw taken();
    throw e;
  };
  if (process.platform !== 'win32') {
    // An empty folder is replaced in one step; a folder with files in it, or a file, is not.
    await fs.rename(tmp, dest).catch((e) => occupied(e, ['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR']));
    return;
  }
  // Windows cannot rename over a folder: remove the empty one first (it may already be gone).
  await fs.rmdir(dest).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') occupied(e, ['ENOTEMPTY', 'ENOTDIR', 'EEXIST']);
  });
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
    const disk = await readIfExists(join(dir, path));
    if (disk === null || sha(disk) !== hash) return path;
  }
  return null;
}

/** Content hash of everything an export reads: source, public files and the canonical documents. */
export async function projectFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const top of ['src', 'static', 'siteorigin']) {
    for (const f of (await listFiles(join(dir, top))).filter((n) => !n.endsWith('.tmp')).sort()) parts.push(`${top}/${f}:${sha(await fs.readFile(join(dir, top, f)))}`);
  }
  return sha(parts.join('\n'));
}

/** Old exported projects pinned Node more tightly than the toolchain needs, which broke hosted builds. */
const LEGACY_ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';
export const NODE_ENGINES = '>=22.17.0';

/** Make an exported source project ready to hand over: current README, notices and a portable engines field. */
export async function finishExportedSource(dest: string, state: ProjectState, noticePath: string) {
  const readmePath = join(dest, 'README.md');
  const readme = await readIfExists(readmePath);
  if (readme === null || isGeneratedReadme(readme)) await fs.writeFile(readmePath, projectReadme(state.site.name));
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
  return normalized === projectReadme(title) || normalized === legacyReadme(title);
}

export function projectReadme(name: string): string {
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

## Notices

The Foundation theme is licensed under GPL-3.0-or-later. Icons come from Lucide (ISC licence). Fonts are licensed under the SIL Open Font License 1.1 and are installed from npm (@fontsource-variable). Sample images from the Business starter, where still used, are described in NOTICE.md.
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

/** Warnings for a source export whose links would stop the exported project from building. */
export function sectionLinkWarnings(state: ProjectState): string[] {
  const broken = brokenSectionLinks(state);
  if (!broken.length) return [];
  const lead = broken.length === 1 ? 'Project health found a link to a section its page does not have. Fix it before building the exported project:' : `Project health found ${broken.length} links to sections their pages do not have. Fix them before building the exported project:`;
  return [lead, ...broken];
}

/** How many unlinked buttons an export warning names before it sums up the rest. */
const UNLINKED_LISTED = 6;

/**
 * Warnings for buttons the site leaves out because they have no destination: the pages (and the shared header and
 * footer, when a page shows them) in site order, each button named by where it is and its label.
 */
export function unlinkedButtonWarnings(state: ProjectState): string[] {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const shell = pages.some((p) => p.shell !== 'none')
    ? [
        { tree: state.site.shell.header, label: 'Header' },
        { tree: state.site.shell.footer, label: 'Footer' }
      ]
    : [];
  const found: string[] = [];
  for (const { tree, label } of [...pages.map((p) => ({ tree: p, label: p.title })), ...shell]) {
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

