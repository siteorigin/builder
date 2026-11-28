/**
 * Export helpers: copying a clean snapshot of a project, checking it, and making the exported source ready
 * to hand over. Nothing here depends on Electron, so it is unit tested directly.
 */
import { markdownMirrorRoute } from '@shared/llms';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync, lstatSync, promises as fs, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { AssetRecord, NodeTree, PageDoc, ProjectState, RedirectHost, SourceDoc } from '@shared/types';
import { documentFormat } from '@shared/document-files';
import { declaredDirection, declaredLanguage, pageDirection, pageLanguage, sameLanguage } from '@shared/languages';
import { checkPublicUrl } from '@shared/public-url';
import { STARTER_ASSETS } from '@catalogue/starters';
import { getTheme, listThemes } from '@catalogue/index';
import { definitionsRenderedBy, formNameClashMessage, runtimeFontDiagnostics, validateState, pixelLimitMessage } from '@engine/validate';
import { overPixelLimit } from '@shared/picture-formats';
import { assetUsages } from '@engine/apply';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { displayName, templateTrees } from '@engine/tree';
import { describeDraftLink, draftTarget, emptySections, netlifyFormClashes, publicationIds, publicationPlan, shownArchiveLayouts, unlinkedButtons, unlinkedMenuLinks, blankPages } from '@generator/checks';
import { archivePages } from '@shared/archives';
import { declaresFormTool } from '@generator/webmcp';
import { webMcpOn } from '@shared/webmcp';
import { RUNTIME_DIR, SERVER_HOOK_FILE, defFile, webMcpFormFile, draftOnlyComponents, generateProject, generateServerHook, liveRedirects, pageAlternates, publishedState, redirectFile, routeLanguages, siteEntries, isDraftEntry } from '@generator/index';
import { SEARCH_INDEX_FILE } from '@generator/search';
import { hasFeedEntries } from '@generator/rss';
import { redirectHost, VERCEL_CONFIG_FILE } from '@generator/host-redirects';
import { atomicWrite, readIfExists, removeEmptyDirs, safeJoin, sha, toJson } from './project/fsutil';
import { isPrivateFileName } from './project/private-files';
import { converterDocPath, sourceDocPath, storedSourceDoc } from './project/documents';
import { CONVERTER_FILE, holdsSecretValue, isSourceId } from '@shared/sources';
import { countMediaRead, perf } from './perf';
import { handleStamp, hashFileAt, lookAt, stampOf, statTrusted } from './project/stable-read';

const UNREADABLE = Symbol('unreadable');

/** A file an export reads, counted for the benchmark (export.filesRead and export.bytesRead, scripts/perf/README.md). */
export async function readExportFile(path: string): Promise<Buffer>;
export async function readExportFile(path: string, encoding: BufferEncoding): Promise<string>;
export async function readExportFile(path: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  const bytes = await fs.readFile(path);
  countExportRead(bytes.length);
  return encoding ? bytes.toString(encoding) : bytes;
}

/** Count one read of `bytes` bytes an export made. */
export function countExportRead(bytes: number) {
  perf.count('export.filesRead');
  perf.count('export.bytesRead', bytes);
}

/** readIfExists, counted as an export's read. */
async function readExportText(path: string): Promise<string | null> {
  const text = await readIfExists(path);
  if (text !== null && perf.on) countExportRead(Buffer.byteLength(text));
  return text;
}

/**
 * A settings file's text, null when there is none, or UNREADABLE for anything but a plain file (a pipe, which would
 * hold the read up forever, a folder, a device) or one that cannot be read. Opened without waiting, so nothing at the
 * path can hold it up.
 */
async function readSettingsFile(path: string): Promise<string | null | typeof UNREADABLE> {
  let fh: Awaited<ReturnType<typeof fs.open>>;
  try {
    fh = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : UNREADABLE;
  }
  try {
    const st = await fh.stat();
    return st.isFile() ? await fh.readFile('utf8') : UNREADABLE;
  } catch {
    return UNREADABLE;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** JSON with every object's keys sorted, so two documents that say the same compare equal. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
import { withoutCodeMarkers } from './codecheck';
import { isCodeMarker, mentionsCodeMarker } from '@shared/code-markers';
import { pageTitle, readBuildFailure, type BuildFailureContext, type BuildReport, type ExplainedBuild } from './build-failure';
import { addCredits, cleanPhoto, hasCredits, photoMetadata, sniffImageType, type PhotoCredits } from './project/photo-metadata';
import { fileTrouble, findMissingAssetFiles, IMPORTED_DOCUMENT_FILE, IMPORTED_MEDIA_FILE, libraryName } from './project/asset-files';
import { DRAFT_ASSETS_DIR } from './project/draft-assets';
import { ownServerHook } from './project/server-hook';
import { BUILD_FAILED_UNPLACED, type ExportNote, type MissingAssetFiles } from '@shared/api';
import { SHELL_PARTS, showsPart } from '@shared/page-shell';
import { NOT_FOUND_FILE, notFoundPath } from '@shared/not-found';
import type { ReviewPage } from '@shared/review-edition';
import type { PageCheck } from './page-check';

const EXCLUDE_TOP = new Set(['node_modules', '.siteorigin', '.svelte-kit', 'build', '.git', '.DS_Store']);


/**
 * Copy the project's source from `src` to `dest`. The project brief (#518) is private to the project and is left out
 * unless `keepBrief` says the copy is the project itself (Duplicate project), so no export ever carries it. External
 * sources' settings (#676) are never copied: a copy that keeps them writes the project's own (writeExportedSources).
 */
export async function copyProjectSource(src: string, dest: string, opts: { keepBrief?: boolean } = {}) {
  // An entry's own type says whether it is a link, which is never copied, so nothing is looked at twice.
  await copyTree(src, dest, (p, e) => {
    if (e.isSymbolicLink() || !sourcePathKept(src, p)) return false;
    if (!opts.keepBrief && isProjectBrief(src, p)) return false;
    // Sources' settings are written from the project's own (writeExportedSources), never copied as the folder has them.
    return !isSourcesFolder(src, p);
  });
}

/**
 * Copy the folder `src` to `dest` (made, or merged into when it is there, as fs.cp does), taking the entries `kept`
 * allows (a folder it refuses is left out whole). Files are cloned where the disk can (a copy that shares blocks until
 * either is written) and copied otherwise, a few at a time: a fresh file with the original's mode either way, as fs.cp
 * makes. Folders get their originals' modes once their files are in. Anything else (a link) is copied as fs.cp copies
 * it with verbatimSymlinks, and fails as it does on what it cannot copy (a pipe).
 */
export async function copyTree(src: string, dest: string, kept: (p: string, e: EntryType) => boolean): Promise<void> {
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(join(src, rel), { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (!kept(join(src, r), e)) continue;
      if (e.isDirectory()) {
        dirs.push(r);
        await walk(r);
      } else files.push(r);
    }
  };
  await walk('');
  // Into a folder already there (a preview's copy), as fs.cp merges into one: only the folders made here take their
  // originals' modes.
  const made = new Set<string>();
  if ((await fs.mkdir(dest, { recursive: true })) !== undefined) made.add('');
  else await existingFolder(dest);
  for (const r of dirs) {
    const to = join(dest, r);
    if (await fs.mkdir(to).then(() => true, (e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? false : Promise.reject(e)))) made.add(r);
    else await existingFolder(to);
  }
  await inBatches(files, async (r) => {
    const [from, to] = [join(src, r), join(dest, r)];
    const st = await fs.lstat(from).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    // Gone since it was listed: as fs.cp's filter, which looks again, leaves it out.
    if (!st) return;
    // Each file or link copied is counted for the benchmark (export.filesCopied, scripts/perf/README.md).
    if (st.isFile()) return copyFresh(from, to).then(() => perf.count('export.filesCopied'));
    // Not the file it was listed as (or never one): judged again as it is now, and a folder copied entry by entry.
    if (!kept(from, st)) return;
    if (st.isDirectory()) return copyTree(from, to, kept);
    await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
    perf.count('export.filesCopied');
  });
  for (const r of [...dirs].reverse()) if (made.has(r)) await fs.chmod(join(dest, r), (await fs.stat(join(src, r))).mode);
  if (made.has('')) await fs.chmod(dest, (await fs.stat(src)).mode);
}

/** What copyTree's `kept` is told of an entry: its type, as listed or as it is when it is copied. */
export type EntryType = Pick<Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>;

/** A folder already at `path` that a copy merges into: a real folder, never a link that would lead the copy elsewhere. */
async function existingFolder(path: string) {
  if (!(await fs.lstat(path)).isDirectory()) throw Object.assign(new Error(`${path} is not a folder.`), { code: 'EEXIST' });
}

/** A copy of a file as a new file at `to` (cloned where the disk can), replacing one there rather than writing through it, as fs.cp does. */
export async function copyFresh(from: string, to: string) {
  await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
    await fs.unlink(to);
    await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
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

/** Is `p` the external sources' folder of the project in `root`, or inside it? Without case, as the disk may be. */
export function isSourcesFolder(root: string, p: string): boolean {
  return /^siteorigin\/sources(\/|$)/i.test(relative(root, p).split(sep).join('/'));
}

/**
 * The external sources' settings a copy of the project carries: exactly the ones the project holds, as it holds them.
 * A website build carries none: the site shows its entries, and never reads where they came from.
 */
export async function writeExportedSources(dest: string, state: ProjectState, opts: { keep: boolean }) {
  await fs.rm(join(dest, 'siteorigin', 'sources'), { recursive: true, force: true });
  if (!opts.keep) return;
  for (const id of Object.keys(state.sources ?? {}).sort()) {
    const doc = state.sources![id];
    const file = join(dest, sourceDocPath(id));
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, toJson(storedSourceDoc(doc)));
    if (typeof doc.converter?.code === 'string') await fs.writeFile(join(dest, converterDocPath(id)), doc.converter.code);
  }
}

/**
 * Why the external sources' settings in the project folder `dir` cannot go out as the project holds them, or null: one
 * on disk that the project does not hold as it is (an edit the app refused, or has not loaded yet), or the project's
 * own holding one of the user's secret `values` (a token pasted into a source's name). Copies an editor left beside
 * them never go out, so they are no reason.
 */
export async function exportedSourcesProblem(dir: string, state: ProjectState, values: readonly string[]): Promise<string | null> {
  const held = state.sources ?? {};
  const folders = await fs.readdir(join(dir, 'siteorigin', 'sources')).catch(() => [] as string[]);
  // The same document however it is laid out: an edit that only spaces it differently is the same settings.
  const same = (disk: string | null, mine: SourceDoc | undefined): boolean => {
    if (disk === null || mine === undefined) return disk === null && mine === undefined;
    try {
      return canonicalJson(JSON.parse(disk)) === canonicalJson(mine);
    } catch {
      return false;
    }
  };
  for (const d of new Set([...folders, ...Object.keys(held)])) {
    const mine = Object.hasOwn(held, d) ? held[d] : undefined;
    const disk = await readSettingsFile(join(dir, 'siteorigin', 'sources', d, 'source.json'));
    // Its converter too, exactly as the project holds it. A module beside settings that name none is no part of it,
    // and never goes out (the copy is written from the project's own).
    const code = mine?.converter ? await readSettingsFile(join(dir, 'siteorigin', 'sources', d, CONVERTER_FILE)) : null;
    const sameCode = code !== UNREADABLE && code === (mine?.converter?.code ?? null);
    if (disk !== UNREADABLE && same(disk, mine && storedSourceDoc(mine)) && !sameCode && isSourceId(d)) return `${converterDocPath(d)} was changed outside SiteOrigin Builder. Open the project again to load it, or put it back, then export again.`;
    if (disk !== UNREADABLE && same(disk, mine && storedSourceDoc(mine)) && sameCode) continue;
    // Named only when it is a source's own name: a folder may be called anything, a credential included.
    return `${isSourceId(d) ? sourceDocPath(d) : 'An external source’s settings'} ${isSourceId(d) ? 'was' : 'were'} changed outside SiteOrigin Builder. Open the project again to load ${isSourceId(d) ? 'it' : 'them'}, or put ${isSourceId(d) ? 'it' : 'them'} back, then export again.`;
  }
  if (holdsSecretValue(JSON.stringify(held), values)) return 'An external source’s settings hold one of your secrets. Take it out of the source’s settings, then export again.';
  return null;
}

/** Is `p` part of the project source in `root`: not tools, caches, builds, private files or links? */
export function inProjectSource(root: string, p: string): boolean {
  if (!relative(root, p)) return true;
  if (!sourcePathKept(root, p)) return false;
  try {
    return !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether a path in `root` is part of its source by its name alone (inProjectSource, without looking at what it is). */
function sourcePathKept(root: string, p: string): boolean {
  const rel = relative(root, p);
  if (!rel) return true;
  const top = rel.split(sep)[0];
  // The editor's own data (history, which holds every version of the brief) by any spelling: on a case-insensitive
  // disk, `.SiteOrigin` is the same folder.
  if (EXCLUDE_TOP.has(top) || top.toLowerCase() === '.siteorigin' || /\.tmp$/.test(p)) return false;
  // Wrangler's local state (#1126), beside any Worker or Pages Function in the project: its local databases and
  // bundles hold what `.dev.vars` gave them.
  if (rel.split(sep).some((part) => part.toLowerCase() === '.wrangler')) return false;
  return !isPrivateFileName(basename(p));
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

/** The eight hash characters the importer names a file by, which an original shares with all its responsive copies. */
const importedToken = (name: string) => name.match(/-([a-f0-9]{8})(?:-\d+w)?\.[a-z0-9]+$/)?.[1] ?? name;

/**
 * Remove from a staged copy of the project (Duplicate project, #1378) the files the importer made that are there only
 * for the original's undo and saved versions, which the copy does not take: a document replaced with a new edition, a
 * deleted image. Built as a plain SvelteKit project, the copy would otherwise publish them at addresses the project has
 * retired. Every file an asset record lists stays, used or not: as the copied asset document lists it, and as the
 * project holds it. Any other file the importer made stays when something in the copy names it, hand-written or
 * generated, public or an authoring document, drafts included; the brief (the author's notes) and the asset document
 * (whose original names are files on the author's computer) never keep one. A picture or font is named by its eight
 * hash characters, as the session finds it (an address built from its parts holds them), and stays too while a library
 * file shares them; a document by its whole name. A document counts as the importer's only while its bytes still have
 * the hash its name gives, so an owner's dated file (`rates-20240131.pdf`) is never taken for one. Anything that can't
 * be read for what it names leaves every file in place. Read from the copy, so it decides by exactly what was copied.
 * Returns the files it removed; one that can't be removed fails the copy, which would otherwise publish it.
 *
 * An export (#1391) passes `authoring: false`, once its drafts are left out of the generated files: there only what the
 * published site is built from names a file (the source, public files, project files and the sources' settings), never
 * the authoring documents, which carry the drafts, so a file only a draft names stays behind as it did before.
 */
export async function leaveOutRetiredAssets(copy: string, state: ProjectState, opts: { authoring?: boolean } = {}): Promise<string[]> {
  const library = libraryAssetFiles(state);
  try {
    const text = await fs.readFile(join(copy, 'siteorigin', 'assets.json'), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    const doc = text === null ? null : (JSON.parse(text) as { assets?: Record<string, { file?: unknown; variants?: Array<{ file?: unknown }> } | null> } | null);
    for (const a of Object.values(doc?.assets ?? {})) for (const f of [a?.file, ...(Array.isArray(a?.variants) ? a.variants.map((v) => v?.file) : [])]) if (typeof f === 'string') library.add(f);
  } catch {
    return [];
  }
  // Without case, as the disk may read paths: a record of `static/Assets/…` keeps its file wherever the folder is.
  const listed = new Set([...library].map((f) => f.toLowerCase()));
  const shared = new Set([...listed].filter((f) => /^static\/assets\/[^/]+$/.test(f) && IMPORTED_MEDIA_FILE.test(basename(f))).map((f) => importedToken(basename(f))));
  const dir = join(copy, 'static', 'assets');
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return [];
  // The copy's folders have their originals' modes: one this app, the copy's owner, could not read, write in or look
  // into is opened while it is weighed, and closed again. Windows reports no such bits for a folder, nor needs them.
  const mode = st.mode & 0o7777;
  const closed = process.platform !== 'win32' && (mode & 0o700) !== 0o700;
  if (closed && !(await fs.chmod(dir, mode | 0o700).then(() => true, () => false))) return [];
  try {
    return await leaveOutRetired(copy, dir, listed, shared, opts.authoring ?? true);
  } finally {
    // Left open only to its owner, if at all: what the pass found, or why it failed, is what matters.
    if (closed) await fs.chmod(dir, mode).catch(() => undefined);
  }
}

/**
 * leaveOutRetiredAssets, once the copy's static/assets/ can be read: `listed` and `shared` are its library's files and
 * their hash characters, and `authoring` whether the authoring documents count.
 */
async function leaveOutRetired(copy: string, dir: string, listed: Set<string>, shared: Set<string>, authoring: boolean): Promise<string[]> {
  const media = new Map<string, string>();
  const documents = new Set<string>();
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = `static/assets/${e.name}`;
    if (!e.isFile() || listed.has(rel.toLowerCase())) continue;
    if (IMPORTED_MEDIA_FILE.test(e.name)) {
      if (!shared.has(importedToken(e.name))) media.set(rel, importedToken(e.name));
    } else if (IMPORTED_DOCUMENT_FILE.test(e.name)) {
      const read = await hashFileAt(join(copy, rel), () => undefined);
      if (typeof read === 'object' && read.hash.startsWith(importedToken(e.name))) documents.add(rel);
    }
  }
  if (!media.size && !documents.size) return [];
  const tokens = new Set(media.values());
  const found = new Set<string>();
  const named = new NameMatcher([...documents].map((rel) => basename(rel)));
  const candidates = [...media.keys(), ...documents];
  const kept = (rel: string) => (media.has(rel) ? found.has(media.get(rel)!) : named.whole(basename(rel)));
  // What the copy carries, read as text: the files the website build reads, stylesheets and transforms it may be built
  // from, and files with no extension (`_redirects`).
  const searched = (name: string) => TEXT_FILE.test(name) || /\.(s[ac]ss|less|styl|xslt?)$/i.test(name) || !/.\.[^.]+$/.test(name);
  let unreadable = false;
  let done = false;
  const look = async (rel: string) => {
    const text = await fs.readFile(join(copy, rel), 'utf8').catch(() => null);
    if (text === null) return void (unreadable = true);
    for (const t of tokens) if (!found.has(t) && text.includes(t)) found.add(t);
    named.scan(text);
    done = candidates.every(kept);
  };
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(join(copy, rel), { withFileTypes: true })) {
      if (unreadable || done) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      // Without the authoring documents, by any spelling of their folder, the sources' settings still count: the
      // website's build runs their converters.
      if (!authoring && rel.toLowerCase() === 'siteorigin' && e.name.toLowerCase() !== 'sources') continue;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() && searched(e.name) && !media.has(child) && !documents.has(child) && child !== 'siteorigin/assets.json' && !isProjectBrief(copy, join(copy, child))) await look(child);
    }
  };
  await walk('').catch(() => (unreadable = true));
  // A file that stays is read in turn for the files it names (a catalogue a page fetches, listing downloads), and so
  // on through what those name, until no more stay.
  const read = new Set<string>();
  for (let more = true; more && !unreadable && !done; ) {
    more = false;
    for (const rel of candidates)
      if (!read.has(rel) && kept(rel) && searched(basename(rel))) {
        read.add(rel);
        await look(rel);
        more = true;
      }
  }
  if (unreadable) return [];
  const gone = candidates.filter((rel) => !kept(rel));
  for (const rel of gone) {
    // A read-only file can't be removed on Windows, nor one a virus scanner holds for a moment. One that won't go
    // fails the copy, which would otherwise publish it.
    if (process.platform === 'win32') await fs.chmod(join(copy, rel), 0o666).catch(() => undefined);
    await fs.rm(join(copy, rel), { maxRetries: 5, retryDelay: 100 });
  }
  return gone;
}

/** Files the website build reads as text, searched for the asset file names they use. */
const TEXT_FILE =/\.(svelte|svx|[cm]?[jt]sx?|css|html?|json|webmanifest|xml|txt|svg|mdx?|csv|tsv|ya?ml|toml)$/i;

/** Does `text` name `file` as a whole file name, so that `a-1234abcd.svg` is not found inside `ba-1234abcd.svg`? */
export function namesFile(text: string, file: string): boolean {
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
 * Which of `names` everything the website build reads as text names, apart from library files: `file` as namesFile
 * finds a name, `whole` as namesWholeFile does. A draft-only component counts once anything else the website reads
 * names its file (a code component importing it), and so on through what that one names. The search index is left
 * out: a page that mentions a file's name in its text does not use that file. Each file is read and searched on its
 * own, as it comes, so only one file's text is held at a time beside those of the draft-only components (#1044). A
 * name is found within one file: one with a line break in it is no longer found from the end of one file and the
 * start of the next, as a search of them all joined by line breaks would; any other is found exactly as that would.
 * With `unreached`, the texts of the draft-only components' files nothing the website reads names are put there.
 */
async function websiteNames(project: string, { files, candidate, draftOnly }: { files: string[]; candidate: (rel: string) => boolean; draftOnly: Set<string> }, names: Iterable<string>, unreached?: string[]): Promise<NameMatcher> {
  const matcher = new NameMatcher([...names, ...[...draftOnly].map((rel) => basename(rel))]);
  const held = new Map<string, string>();
  for (const rel of files) {
    if (!/^(src|static)\//.test(rel) || candidate(rel) || !TEXT_FILE.test(rel) || rel === SEARCH_INDEX) continue;
    const text = await readExportFile(join(project, rel), 'utf8');
    if (draftOnly.has(rel)) held.set(rel, text);
    else matcher.scan(text);
  }
  for (let found = true; found && held.size; ) {
    found = false;
    for (const [rel, text] of held)
      if (matcher.file(basename(rel))) {
        matcher.scan(text);
        held.delete(rel);
        found = true;
      }
  }
  unreached?.push(...held.values());
  return matcher;
}

/** An import of a module, static or dynamic, and the path it names: `from './x.svelte'`, `import('./x.svelte')`, `import './x.css'`. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g;
/** What a module's source says without running: an HTML comment, a block comment, a line that is a comment. */
const COMMENT = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm;

/**
 * The paths a module's source imports, static or dynamic, each without the query or hash Vite reads (`./x.svelte?raw`
 * is `./x.svelte`). An import in a comment is none.
 */
export function importSpecifiers(text: string, opts: { runtime?: boolean } = {}): string[] {
  const code = text.replace(COMMENT, '');
  // With `runtime`, a type-only import (erased once compiled) loads nothing.
  const loaded = opts.runtime ? code.replace(/\b(?:import|export)\s+type\b[^;'"]*?\bfrom\s*(['"])[^'"\n]+\1/g, '') : code;
  return [...loaded.matchAll(IMPORT_SPECIFIER)].map((m) => m[2].replace(/[?#].*$/, ''));
}

/**
 * The components (by ID) the published website never imports (#1154): installed but placed on no published page,
 * layout or component in use, nor imported by code, such as one made from a draft since deleted. Followed through the
 * imports the website's source makes: from every file under src/ that is no component's file (the pages, the layout,
 * the hooks, hand-written source), each component file one of them imports is taken in, with its declared dependencies
 * and the design converted code was made from, and what it imports in turn, until nothing new is imported. Only an
 * import counts, so a comment or a word that mentions a component's file keeps nothing. A component with no file in
 * the copy is imported by nothing.
 */
export async function unusedComponents(project: string, state: ProjectState): Promise<string[]> {
  const forms = webMcpOn(state.site);
  const owner = new Map<string, string>();
  for (const def of Object.values(state.components)) {
    owner.set(defFile(def), def.id);
    if (forms && def.kind === 'code' && declaresFormTool(def)) owner.set(webMcpFormFile(def), def.id);
  }
  const byName = new Map<string, string[]>();
  for (const rel of owner.keys()) byName.set(basename(rel), [...(byName.get(basename(rel)) ?? []), rel]);
  const used = new Set<string>();
  const texts = new Map<string, string>();
  const pending: string[] = [];
  const take = (id: string) => {
    if (used.has(id) || !Object.hasOwn(state.components, id)) return;
    used.add(id);
    const def = state.components[id];
    for (const [rel, who] of owner) if (who === id && texts.has(rel)) pending.push(texts.get(rel)!);
    for (const dep of def.kind === 'code' ? [...(def.dependencies ?? []), ...(def.generatedFrom ? [def.generatedFrom] : [])] : []) take(dep);
  };
  const seeds: string[] = [];
  for (const rel of (await listFiles(join(project, 'src'))).map((f) => `src/${f.split(sep).join('/')}`)) {
    if (!TEXT_FILE.test(rel) || rel === SEARCH_INDEX) continue;
    const text = await readExportFile(join(project, rel), 'utf8');
    if (owner.has(rel)) texts.set(rel, text);
    else seeds.push(text);
  }
  pending.push(...seeds);
  while (pending.length) {
    const text = pending.pop()!;
    for (const spec of importSpecifiers(text)) for (const rel of byName.get(basename(spec)) ?? []) take(owner.get(rel)!);
  }
  return Object.keys(state.components)
    .filter((id) => !used.has(id))
    .sort();
}

/** Whether `named` found the project file `rel`: a document by its whole name, so `offer-1a2b3c4d.doc` is not named by `offer-1a2b3c4d.docx`. */
const namesAsset = (named: NameMatcher, rel: string) => (documentFormat(rel) ? named.whole : named.file)(basename(rel));

export async function pruneWebsiteAssets(project: string, state: ProjectState): Promise<AssetRecord[]> {
  const site = await websiteFiles(project, state);
  const candidates = site.files.filter(site.candidate);
  if (!candidates.length) return [];
  const named = await websiteNames(project, site, candidates.map((rel) => basename(rel)));
  const shipped = new Set<string>();
  const removed = new Set<string>();
  for (const rel of candidates) {
    if (namesAsset(named, rel)) shipped.add(rel);
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

/**
 * The files in static/assets/ of a staged editable project that only its drafts use (#1450), for holdDraftAssets to
 * keep out of the handoff's own build, which serves static/ as it is. The copy's generated files are the published
 * site's (leaveOutDrafts), and `drafts` is the text the drafts add to them, as leaveOutDrafts gave it. A file the
 * website names (as pruneWebsiteAssets finds one) is never held. Of the rest, an asset record any of whose files the
 * drafts name, in that text or in a file of a component only drafts place that the website never reaches, is held
 * whole: its original and every copy, so a draft's photo goes with whichever copies its page shows; so is one the
 * drafts use by its ID where the published pages and entries do not, whether or not they show it. Only records' own
 * files are held, as only those does an opening put back (restoreDraftAssets). Files nothing names stay, as the
 * editable project keeps its whole library.
 */
export async function draftOnlyAssetFiles(project: string, state: ProjectState, drafts: ReadonlyMap<string, string>): Promise<string[]> {
  const live = publishedState(state);
  if (live === state) return [];
  const site = await websiteFiles(project, state);
  const candidates = site.files.filter(site.candidate);
  if (!candidates.length) return [];
  const unreached: string[] = [];
  const shipped = await websiteNames(project, site, candidates.map((rel) => basename(rel)), unreached);
  const unshipped = new Set(candidates.filter((rel) => !namesAsset(shipped, rel)));
  if (!unshipped.size) return [];
  const used = new NameMatcher([...unshipped].map((rel) => basename(rel)));
  for (const [path, text] of drafts) if (/^(src|static)\//.test(path) && TEXT_FILE.test(path) && path !== SEARCH_INDEX) used.scan(text);
  for (const text of unreached) used.scan(text);
  const held = new Set([...unshipped].filter((rel) => namesAsset(used, rel)));
  // And a record the drafts use by its ID where the published site does not, whether or not they show it (a document
  // in an entry's field its layout leaves out).
  const published = assetUsages(live);
  const drafted = new Set(Object.entries(assetUsages(state)).flatMap(([id, n]) => (n > 0 && !(published[id] > 0) ? [id] : [])));
  // A record's files as the copy has them: by their very paths, or else as a disk that ignores case reads them
  // (`Photo-…` for the record's `photo-…`). Only these are held, since only these does an opening put back.
  const spelled = new Map<string, string[]>();
  for (const rel of unshipped) spelled.set(rel.toLowerCase(), [...(spelled.get(rel.toLowerCase()) ?? []), rel]);
  const exact = new Set(candidates);
  const library = new Set<string>();
  for (const a of Object.values(state.assets.assets)) {
    const own = [a.file, ...(a.variants ?? []).map((v) => v.file)].flatMap((f) => (typeof f !== 'string' ? [] : exact.has(f) ? (unshipped.has(f) ? [f] : []) : (spelled.get(f.toLowerCase()) ?? [])));
    for (const f of own) library.add(f);
    if (drafted.has(a.id) || own.some((f) => held.has(f))) for (const f of own) held.add(f);
  }
  return candidates.filter((rel) => held.has(rel) && library.has(rel));
}

/** The export's note for an editable project whose drafts' own files it kept out of its build (draftOnlyAssetFiles), or null. */
export function heldDraftAssetsNote(state: ProjectState, files: readonly string[]): string | null {
  if (!files.length) return null;
  const byFile = assetsByFile(state);
  const names = [...new Set(files.map((f) => byFile.get(f)?.name ?? basename(f)))].sort((a, b) => a.localeCompare(b));
  return `Files only drafts use are kept in ${DRAFT_ASSETS_DIR}/ rather than static/assets/, so a build of the exported project leaves them out: ${listNames(names)}. Opening the project in SiteOrigin Builder puts them back.`;
}

export interface MissingInExport {
  asset: AssetRecord;
  missing: MissingAssetFiles;
  /** Something the build reads names a missing file, so the build would fail on it. */
  used: boolean;
}

/**
 * Library images, documents and fonts with files missing from a staged copy of the project, and whether the website
 * uses those files: generated pages, styles (a font's @font-face rule), code components or other public files name
 * one. The build would fail on a used one without saying which file it was, or (a font) pass and leave visitors a
 * fallback typeface, so the export stops first and names it.
 */
export async function missingWebsiteAssets(project: string, state: ProjectState): Promise<MissingInExport[]> {
  const missing = await findMissingAssetFiles(project, state.assets.assets);
  if (!missing.length) return [];
  // A missing file the site names would fail the build. A missing original matters too when the site names only a
  // JPEG or PNG copy of it, since that copy's credits come from the original (a WebP or AVIF copy carries its own); a
  // missing copy the site does not name does not.
  const credited = (f: unknown): f is string => typeof f === 'string' && /\.(jpg|png)$/.test(f);
  const asked = (m: MissingAssetFiles) => {
    const asset = state.assets.assets[m.assetId];
    return { direct: [...(m.original ? [asset.file] : []), ...m.variants], copies: m.original ? (asset.variants ?? []).map((v) => v.file as unknown).filter(credited) : [] };
  };
  // Searched for exactly the names the answers below ask about, so a damaged record elsewhere in the library is no name.
  const found = await websiteNames(project, await websiteFiles(project, state), missing.flatMap((m) => Object.values(asked(m)).flat().map((f) => basename(f))));
  return missing.map((m) => {
    const { direct, copies } = asked(m);
    const named = (f: string) => found.whole(basename(f));
    return { asset: state.assets.assets[m.assetId], missing: m, used: direct.some(named) || copies.some(named) };
  });
}

/** Characters namesFile reads as part of a file name, around one. */
const NAME_RUN = /[\w.-]+/g;
const NAME_CHARS = /^[\w.-]+$/;

/**
 * namesFile and namesWholeFile for many names over one text or several, each read once. A name made only of the
 * characters that namesFile reads as part of a name is named exactly when some run of those characters in a text starts
 * with it (its start then has none before it), and named whole when, within that run, nothing that namesWholeFile reads
 * as going on follows it. Any other name is searched for on its own, in each text.
 */
export class NameMatcher {
  /** The names by length, each kept as it was given: a name found is recorded as that string, never as a piece cut
   *  from a text, which V8 can keep as a view of the whole text. */
  private readonly lengths = new Map<number, Map<string, string>>();
  private readonly others = new Set<string>();
  private readonly named = new Set<string>();
  private readonly namedWhole = new Set<string>();

  constructor(names: Iterable<string>) {
    for (const name of names)
      if (NAME_CHARS.test(name)) (this.lengths.get(name.length) ?? this.lengths.set(name.length, new Map()).get(name.length)!).set(name, name);
      else this.others.add(name);
  }

  /** Search one more text. */
  scan(text: string): void {
    if (this.lengths.size)
      for (const [run] of text.matchAll(NAME_RUN))
        for (const [length, given] of this.lengths) {
          if (length > run.length) continue;
          const name = given.get(length === run.length ? run : run.slice(0, length));
          if (name === undefined) continue;
          this.named.add(name);
          const next = run[length];
          if (next === undefined || (next === '.' && !/\w/.test(run[length + 1] ?? ''))) this.namedWhole.add(name);
        }
    for (const name of this.others) {
      if (!this.named.has(name) && namesFile(text, name)) this.named.add(name);
      if (!this.namedWhole.has(name) && namesWholeFile(text, name)) this.namedWhole.add(name);
    }
  }

  /** Whether a text searched so far names `name` (namesFile), of the names the matcher was made for. */
  readonly file = (name: string): boolean => this.named.has(name);

  /** Whether a text searched so far names `name` whole (namesWholeFile), of the names the matcher was made for. */
  readonly whole = (name: string): boolean => this.namedWhole.has(name);
}

/** NameMatcher over one text; a name it was not made for is searched for in the text when asked. */
export function namesIn(text: string, names: string[]): { file: (name: string) => boolean; whole: (name: string) => boolean } {
  const matcher = new NameMatcher(names.filter((name) => NAME_CHARS.test(name)));
  matcher.scan(text);
  const listed = (name: string) => NAME_CHARS.test(name);
  return { file: (name) => (listed(name) ? matcher.file(name) : namesFile(text, name)), whole: (name) => (listed(name) ? matcher.whole(name) : namesWholeFile(text, name)) };
}

/** Like namesFile, and the name also ends there: `a-1234abcd.jpg` is not found inside `a-1234abcd.jpg.webp`. */
export function namesWholeFile(text: string, file: string): boolean {
  for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) {
    const end = i + file.length;
    if ((i === 0 || !/[\w.-]/.test(text[i - 1])) && (end === text.length || !/[\w-]/.test(text[end]) && !(text[end] === '.' && /[\w]/.test(text[end + 1] ?? '')))) return true;
  }
  return false;
}

/** The export notes for library files with missing files that nothing on the site names, so the export went ahead. */
export function missingUnusedWarnings(missing: MissingInExport[]): string[] {
  return missing.filter((m) => !m.used).map(({ asset, missing: m }) => `${libraryName(asset)} ${fileTrouble(asset, m)} in the project folder. No page or code names ${them(m)}, so the website was exported without ${them(m)}.`);
}

/** "it" for one missing file, "them" for more. */
const them = (m: MissingAssetFiles) => ((m.original ? 1 : 0) + m.variants.length > 1 ? 'them' : 'it');

/** What several library files are, together: "images", "fonts", "images and documents", "images, documents and fonts". */
function kindsOf(assets: AssetRecord[]): string {
  const kinds = (['image', 'document', 'font'] as const).filter((k) => assets.some((a) => (a.kind === 'document' || a.kind === 'font' ? a.kind : 'image') === k)).map((k) => `${k}s`);
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}` : kinds[0];
}

/** Why a website export stopped for library files that are missing or damaged, and the files themselves for the details. */
export function missingAssetsStop(used: MissingInExport[]): { message: string; warnings: string[] } {
  const nameOf = libraryName;
  const warnings = used.map(({ asset, missing }) => {
    const absent = [...(missing.original ? [asset.file] : []), ...missing.variants.filter((v) => !missing.damaged.includes(v))];
    const said = [...(absent.length ? [`${absent.join(', ')} not found`] : []), ...(missing.damaged.length ? [`${missing.damaged.join(', ')} damaged`] : [])];
    return `${nameOf(asset)}: ${said.join('; ')}.`;
  });
  if (used.length === 1) {
    const { asset, missing } = used[0];
    const fix = missing.original ? 'Locate the file in Assets' : 'Make the copies again in Assets';
    return { message: `${nameOf(asset)} ${fileTrouble(asset, missing)} in the project folder, and the website uses ${them(missing)}. ${fix}, then export again.`, warnings };
  }
  const names = used.map((u) => nameOf(u.asset));
  const what = kindsOf(used.map((u) => u.asset));
  const damaged = used.some((u) => u.missing.damaged.length);
  return { message: `${used.length} ${what} the website uses are missing ${damaged ? 'or have damaged ' : ''}files in the project folder: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. Fix them in Assets, then export again.`, warnings };
}

/**
 * The export notes for an editable project that leaves out library files missing from the project folder, or carries
 * a damaged copy as it is (a build of the project would publish it).
 */
export function missingSourceWarnings(state: ProjectState, missing: MissingAssetFiles[]): string[] {
  return missing.map((m) => {
    const a = state.assets.assets[m.assetId];
    if (!m.damaged.length) return `${libraryName(a)} ${fileTrouble(a, m)} in the project folder, so the exported project does not have ${them(m)} either. Fix it in Assets and export again.`;
    const one = m.damaged.length === 1;
    const absent = m.original || m.variants.length > m.damaged.length;
    return `${libraryName(a)} ${fileTrouble(a, m)} in the project folder, so the exported project ${absent ? 'is missing the same files and ' : ''}has the damaged ${one ? 'copy as it is' : 'copies as they are'}. ${m.original ? 'Fix it' : 'Make the copies again'} in Assets and export again.`;
  });
}

/**
 * The notes on library images the website ships that are heavy for its pages: one too large to make copies of (which
 * goes out whole, however small its file, #1444), or else a large file. `omitted` were left out of the website and
 * `absent` (asset ids) have no original in the project, so neither ships.
 */
export function assetSizeWarnings(state: ProjectState, omitted: readonly AssetRecord[], absent: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const a of Object.values(state.assets.assets)) {
    if (omitted.includes(a) || absent.has(a.id)) continue;
    if (a.kind === 'image' && overPixelLimit(a.mime, a.width, a.height)) out.push(pixelLimitMessage(a));
    else if (a.bytes > 1_500_000) out.push(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
  }
  return out;
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
        countExportRead(bytesRead);
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
    const buf = await readExportFile(path);
    countMediaRead(buf.length);
    return buf;
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
    const buf = await readExportFile(path).catch(() => null);
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
 * not be read or cleaned (those that could not be read as images first); the export must stop if there are any.
 *
 * Each file is read once. `inspect` is given every file read whole (every HTML file and script among them), as the
 * build wrote it, before it is cleaned.
 */
export async function cleanBuiltSite(dir: string, inspect?: (rel: string, bytes: Buffer) => void): Promise<string[]> {
  const failed: string[] = [];
  const inlineFailed: string[] = [];
  for (const rel of (await listFiles(dir)).map((f) => f.split(sep).join('/'))) {
    const path = join(dir, rel);
    const host = INLINE_HOST.test(rel);
    // A file read whole anyway shows its first bytes; any other is looked at by them alone (rasterFiles).
    let bytes: Buffer | null = null;
    let raster = RASTER_NAME.test(rel);
    if (host) {
      bytes = await readExportFile(path).catch(() => null);
      // One that cannot be read fails by name, as an image and as a file that can hold one.
      if (bytes === null) {
        failed.push(rel);
        inlineFailed.push(rel);
        continue;
      }
      inspect?.(rel, bytes);
      raster = !!sniffImageType(bytes.subarray(0, 64));
    } else if (!raster) raster = await sniffedRaster(path);
    if (raster) {
      bytes ??= await readExportFile(path).catch(() => null);
      if (bytes && !host) inspect?.(rel, bytes);
      const r = bytes && cleanPhoto(bytes);
      if (!r) failed.push(rel);
      // Renamed into place, so a file the build linked from elsewhere is replaced rather than written through.
      else if (r.changed) {
        await rewriteBuilt(path, r.data);
        bytes = r.data;
      }
    }
    if (!host || !bytes) continue;
    const text = bytes.toString('latin1');
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
    if (bad) inlineFailed.push(rel);
    else if (cleaned !== text) await rewriteBuilt(path, Buffer.from(cleaned, 'latin1'));
  }
  return [...failed, ...inlineFailed];
}

/** Whether a file's first bytes are a raster image's; true when it cannot be opened or read, so reading it fails by name. */
async function sniffedRaster(path: string): Promise<boolean> {
  const handle = await fs.open(path, 'r').catch(() => null);
  if (!handle) return true;
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, 64, 0);
    countExportRead(bytesRead);
    return !!sniffImageType(head.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    await handle.close();
  }
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

export const listNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

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
 * folder only once `beforeCommit` allows. Anything someone else puts in `dest` is never removed. With `move`, `from`
 * is the caller's to give up (a staging folder): it is moved there when it is on the same disk, and copied otherwise.
 */
export async function publishFolder(from: string, dest: string, beforeCommit?: () => Promise<void>, opts: { move?: boolean } = {}) {
  await fs.mkdir(dest);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    // Only a folder that holds nothing but folders and files no other name shares is moved: then the result is the copy's.
    const moved = !!opts.move && (await plainTree(from).catch(() => false)) && (await fs.rename(from, tmp).then(() => true, () => false));
    if (!moved) await fs.cp(from, tmp, { recursive: true });
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
 * Whether `dir` holds only folders and regular files with one name each: no link, pipe or file shared with another
 * name (a build can link a file from elsewhere), which a copy would treat differently from a move.
 */
async function plainTree(dir: string): Promise<boolean> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!(await plainTree(p))) return false;
    } else if (!e.isFile() || (await fs.lstat(p)).nlink !== 1) return false;
  }
  return true;
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

/**
 * The first generated file whose content no longer matches generated-manifest.json, or null. `known` holds hashes
 * already taken of the project's files (projectInventory), by project path: a file it names is not read again.
 */
export async function editedGeneratedFile(dir: string, known?: ReadonlyMap<string, string>): Promise<string | null> {
  let manifest: { files?: Record<string, string> };
  try {
    manifest = JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '');
  } catch {
    return MANIFEST_PATH;
  }
  for (const [path, hash] of Object.entries(manifest.files ?? {}).sort()) {
    const seen = known?.get(path);
    if (seen !== undefined) {
      if (seen !== hash) return path;
      continue;
    }
    // Read as bytes: a theme's font files are generated output too.
    const disk = await readExportFile(join(dir, path)).catch(() => null);
    if (disk === null || sha(disk) !== hash) return path;
  }
  return null;
}

/**
 * Leave the drafts out of a staged copy of the project. The generated files become the published site's: a draft has
 * no page file and no old address leading to it, links to drafts are left unlinked, and the layout, styles and sitemap
 * carry no trace of them. generated-manifest.json then lists what the copy has, so it reopens without conflicts and
 * SiteOrigin Builder writes the drafts' files back. The canonical documents keep every page, so the drafts are still
 * there to edit. Only files the manifest says SiteOrigin Builder generated are touched. With `live`, the generated files
 * of `state` become those of `live` instead (a publication's state, which leaves out more, #1154). With `drafts`, each
 * generated file the drafts make or add to is put there with the text it has with them (by path), for
 * draftOnlyAssetFiles.
 */
export async function leaveOutDrafts(dir: string, state: ProjectState, live: ProjectState = publishedState(state), drafts?: Map<string, string>): Promise<void> {
  if (live === state) return;
  const full = generateProject(state, { instrument: false });
  const published = generateProject(live, { instrument: false });
  const manifest = JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string>; pending?: Record<string, string> };
  const files = manifest.files ?? {};
  // A file only the result has (a form's tool once markers no longer hide it) is written, unless one of the author's own is there.
  for (const [path, content] of published) {
    if (full.has(path) || (!Object.hasOwn(files, path) && existsSync(safeJoin(dir, path)))) continue;
    const abs = safeJoin(dir, path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    files[path] = sha(content);
    if (manifest.pending) delete manifest.pending[path];
  }
  for (const [path, content] of full) {
    if (drafts && published.get(path) !== content) drafts.set(path, content);
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
 * Take the editor's markers (see shared/code-markers.ts) out of a staged copy's code components, for both exports:
 * the preview finds what it edits in a code component by its markers, and the published site carries none, whoever
 * owns the component. That is every file a code component's code reaches the website through: a project component's
 * own source, the generated file a theme's code is written to, and the copy of a contact form's code that declares
 * its WebMCP tool. Each is cleaned as the copy holds it, after leaveOutDrafts, so what the generator added (link
 * relationships, the form's tool) stays. A generated file is then listed in generated-manifest.json as it is cleaned,
 * so the copy reopens without conflicts and SiteOrigin Builder writes the markers back from the canonical documents;
 * a project component's own source is its canonical code, so the copy keeps no markers there. The editable project
 * keeps all of them.
 */
export async function stripCodeMarkers(dir: string, state: ProjectState): Promise<void> {
  let manifest: { files?: Record<string, string>; pending?: Record<string, string> } | null = null;
  const forms = webMcpOn(state.site);
  for (const def of Object.values(state.components)) {
    if (def.kind !== 'code') continue;
    for (const path of new Set([defFile(def), ...(forms && declaresFormTool(def) ? [webMcpFormFile(def)] : [])])) {
      const abs = safeJoin(dir, path);
      const source = await readExportText(abs);
      if (source === null) continue;
      const clean = await withoutCodeMarkers(source);
      if (clean === source) continue;
      await fs.writeFile(abs, clean);
      manifest ??= JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string>; pending?: Record<string, string> };
      if (Object.hasOwn(manifest.files ?? {}, path) || Object.hasOwn(manifest.pending ?? {}, path)) {
        manifest.files = { ...manifest.files, [path]: sha(clean) };
        if (manifest.pending) delete manifest.pending[path];
      }
    }
  }
  if (manifest) await fs.writeFile(join(dir, MANIFEST_PATH), toJson({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files ?? {}).sort()) }));
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
      ? `${draftLinks[0].owner.kind === 'entry' ? 'A published entry' : draftLinks[0].owner.kind === 'template' || draftLinks[0].owner.kind === 'archive' ? 'A collection layout' : 'A published page'} links to ${drafts[0]}, which is a draft and is left out of the website. Change the link or publish ${one}, then export again.`
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
 * and each old address that leads to one. `live` is the published state of `state`. `answered` marks one the website's
 * own page answers at instead (route/index.html): a collection's archive page, or an old address kept working there.
 */
export function withheldRoutes(state: ProjectState, live: ProjectState): Array<{ route: string; draft: string; answered?: true }> {
  if (live === state) return [];
  const kept = new Set(liveRedirects(live).map((r) => r.from.toLowerCase()));
  const shown = new Set(siteEntries(live).map((e) => e.route.toLowerCase()));
  // A collection's archive page shows at a draft's address made before archive pages: its own page there is the
  // archive's, so only another file at that address (a copy of the draft as route.html) would publish the draft.
  // So does the page of an old address kept at a draft page's address, sending visitors on until it is published (#1363).
  const answered = new Set([...archivePages(live).map((p) => p.route.toLowerCase()), ...kept]);
  const routes: Array<{ route: string; draft: string }> = [
    ...Object.values(state.pages).filter((p) => !Object.hasOwn(live.pages, p.id)).map((p) => ({ route: p.route, draft: p.title })),
    ...siteEntries(state).filter((e) => !shown.has(e.route.toLowerCase())).map((e) => ({ route: e.route, draft: e.entry.title })),
    ...liveRedirects(state).filter((r) => !kept.has(r.from.toLowerCase())).map((r) => ({ route: r.from, draft: r.title }))
  ];
  return routes.map((r) => (answered.has(r.route.toLowerCase()) ? { ...r, answered: true as const } : r));
}

/** A route module SvelteKit builds a page with: a page, a layout or a load, or an endpoint (never a backup's name). */
const ROUTE_MODULE = /^\+(?:page|layout|server)(?:@[^.]*)?(?:\.server)?\.(?:svelte|[cm]?[jt]s)$/;

/**
 * A file of the author's own at an address the website keeps back from a draft but answers at with a page of its own
 * (withheldRoutes' `answered`: an old address kept working there, say), in the staged copy `dir`: a copy of the page in
 * static/, or a route module beside or around the generated page there (a layout, a load, an endpoint) that
 * generated-manifest.json does not list as SiteOrigin Builder's. Built with the website's page, it would publish what
 * the author kept back. Null when there is none.
 */
export async function answeredAddressFile(dir: string, state: ProjectState, live: ProjectState): Promise<{ file: string; route: string; draft: string } | null> {
  const answered = withheldRoutes(state, live).filter((r) => r.answered);
  if (!answered.length) return null;
  const owned = new Set(Object.keys((JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string> }).files ?? {}));
  for (const { route, draft } of answered) {
    const copy = `static${route}index.html`;
    if (isPlainFile(join(dir, copy))) return { file: copy, route, draft };
    const folder = dirname(redirectFile(route));
    const names = await fs.readdir(join(dir, folder)).catch(() => [] as string[]);
    // An error page there shows only for a page that fails, never in place of the old address's.
    const file = names.map((n) => `${folder}/${n}`).find((f) => ROUTE_MODULE.test(basename(f)) && !owned.has(f));
    if (file) return { file, route, draft };
  }
  return null;
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
  return (await projectInventory(dir)).fingerprint;
}

/**
 * `fn` over every item, a few at a time: enough to overlap the disk's waits, never so many open files that one fails
 * to open. Results in the items' order.
 */
export async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>, size = 16): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    // Every one of a batch is done before a failure among them is thrown: nothing is still running once it is.
    const settled = await Promise.allSettled(items.slice(i, i + size).map(fn));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    for (const r of settled) out.push((r as PromiseFulfilledResult<R>).value);
  }
  return out;
}

/** Hashes of a project's files an export has taken, by absolute path, each with the stamp it stands for. */
export type ExportHashes = Map<string, { stamp: string; hash: string }>;

/**
 * The SHA-256 of the file at `abs`, from `known` when it holds one under the stamp the path has now. A hash is kept (in
 * `kept`) only when its file was read whole without changing, and had been left alone for `settleMs` before it was
 * looked at (statTrusted, the rule the session's own hashes follow): any later write to it changes its stamp, and the
 * file is read again. Anything else is read as it always was.
 */
async function stableHash(abs: string, known: ExportHashes, kept: ExportHashes, settleMs: number): Promise<{ hash: string; stamp: string | null; trusted: boolean }> {
  const started = Date.now();
  const before = await lookAt(abs);
  if (typeof before !== 'string') {
    const stamp = stampOf(before);
    // Trusted now, as when it was kept: a later rule (a longer settleMs) or a clock set back says otherwise.
    const trusted = statTrusted(before, started, settleMs);
    const held = known.get(abs);
    if (held?.stamp === stamp && trusted) {
      kept.set(abs, held);
      return { hash: held.hash, stamp, trusted };
    }
    const read = await hashFileAt(abs, countExportRead);
    if (typeof read !== 'string') {
      // The path still reaches the file read, unchanged; where a path's stat and a handle's are taken the same way
      // (everywhere but Windows), they must name the same file too.
      const after = await lookAt(abs);
      const same = typeof after !== 'string' && stampOf(after) === stamp && (await handleStamp(abs)) === read.stamp && (process.platform === 'win32' || read.stamp === stamp);
      if (same && trusted) kept.set(abs, { stamp, hash: read.hash });
      return { hash: read.hash, stamp, trusted: same && trusted };
    }
  }
  return { hash: sha(await readExportFile(abs)), stamp: null, trusted: false };
}

/**
 * What a fingerprint pass saw of each file, by project path: the stamp it was looked at with, and whether that stamp
 * stands for the file's bytes (statTrusted when it was looked at, read without changing).
 */
export type InventoryStamps = Map<string, { stamp: string | null; trusted: boolean }>;

/**
 * Whether the project changed between two fingerprint passes: its fingerprint, or the stamp of any file the first
 * pass could trust. A write to such a file always changes its stamp (its change time moves on), so this also sees a
 * file changed and put back as it was while the project was being copied, which the fingerprint alone cannot.
 */
export function inventoryChanged(before: { fingerprint: string; stamps: InventoryStamps }, after: { fingerprint: string; stamps: InventoryStamps }): boolean {
  if (before.fingerprint !== after.fingerprint) return true;
  for (const [rel, seen] of before.stamps) if (seen.trusted && after.stamps.get(rel)?.stamp !== seen.stamp) return true;
  return false;
}

/**
 * The project's fingerprint (projectFingerprint), with the SHA-256 of each file it read by project path (forward
 * slashes, as the disk spells it): the regular files under src/, static/ and siteorigin/, and vercel.json. With
 * `cache`, a file whose stamp shows it unchanged since an earlier pass is not read again (stableHash), and the cache
 * then holds this pass's files only.
 */
export async function projectInventory(dir: string, opts: { cache?: ExportHashes; settleMs?: number; roots?: readonly string[] } = {}): Promise<{ fingerprint: string; hashes: Map<string, string>; stamps: InventoryStamps }> {
  const parts: string[] = [];
  const hashes = new Map<string, string>();
  const stamps: InventoryStamps = new Map();
  const known = opts.cache ?? new Map();
  const kept: ExportHashes = new Map();
  const hashOf = async (abs: string) => (opts.cache ? stableHash(abs, known, kept, opts.settleMs ?? 3000) : { hash: sha(await readExportFile(abs)), stamp: null, trusted: false });
  const files: Array<{ top: string; f: string }> = [];
  for (const top of ['src', 'static', 'siteorigin']) for (const f of (await listFiles(join(dir, top))).filter((n) => !n.endsWith('.tmp')).sort()) files.push({ top, f });
  // A few files at a time, so the disk's waits overlap (one at a time when each is read whole); the fingerprint is put
  // together in the same order as ever.
  const found = await inBatches(files, ({ top, f }) => hashOf(join(dir, top, f)), opts.cache ? 16 : 1);
  files.forEach(({ top, f }, i) => {
    const rel = `${top}/${f.split(sep).join('/')}`;
    hashes.set(rel, found[i].hash);
    stamps.set(rel, { stamp: found[i].stamp, trusted: found[i].trusted });
    parts.push(`${top}/${f}:${found[i].hash}`);
  });
  // Read only as a plain file: anything else there (a pipe, say) is no file of the website's.
  const vercel = isPlainFile(join(dir, VERCEL_CONFIG_FILE)) ? await readExportFile(join(dir, VERCEL_CONFIG_FILE)).catch(() => null) : null;
  if (vercel) {
    const hash = sha(vercel);
    hashes.set(VERCEL_CONFIG_FILE, hash);
    parts.push(`${VERCEL_CONFIG_FILE}:${hash}`);
  }
  // With `roots`, those files at the project's top too (a publication's package.json and lockfile, #1154), so two of
  // them changed one after the other while the copy was made are never published as a pair that never was.
  for (const rel of [...(opts.roots ?? [])].filter((r) => r !== VERCEL_CONFIG_FILE).sort()) {
    // Read only as a plain file, and known by its stamp as the files above are, so one written and put back between
    // two passes is seen too.
    const found = isPlainFile(join(dir, rel)) ? await hashOf(join(dir, rel)).catch(() => null) : null;
    hashes.set(rel, found?.hash ?? '-');
    if (found) stamps.set(rel, { stamp: found.stamp, trusted: found.trusted });
    parts.push(`${rel}:${found?.hash ?? '-'}`);
  }
  if (opts.cache) {
    opts.cache.clear();
    for (const [abs, held] of kept) opts.cache.set(abs, held);
  }
  return { fingerprint: sha(parts.join('\n')), hashes, stamps };
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
    manifest = JSON.parse((await readExportText(join(project, MANIFEST_PATH))) ?? '{}');
  } catch {
    return null;
  }
  if (!Object.hasOwn(manifest.files ?? {}, VERCEL_CONFIG_FILE) || !isPlainFile(join(project, VERCEL_CONFIG_FILE))) return null;
  const config = await readExportFile(join(project, VERCEL_CONFIG_FILE));
  const there = join(out, VERCEL_CONFIG_FILE);
  if (existsSync(there)) return `static/${VERCEL_CONFIG_FILE} takes the place of the redirect rules SiteOrigin Builder writes for Vercel. Delete or rename it, or choose another host in Site settings under Redirects, then export again.`;
  await fs.writeFile(there, config);
  return null;
}

/** Where an exported project's sync script is (#680), and the package script that runs it. */
export const SYNC_SCRIPT = 'scripts/sync-sources.mjs';
export const SYNC_COMMAND = 'node scripts/sync-sources.mjs';
/** How the sync script's first line says it is this app's (see scripts/sync-cli.ts). */
const OWNED_SYNC_SCRIPT = /^\/\/ Generated by SiteOrigin Builder\./;

/**
 * Give an exported project with external sources the script that syncs them without the app (#680), `cli` its text,
 * and `npm run sync` to run it; take away the ones this app wrote from a project that has none any more. A script or
 * a `sync` command of the author's own is left as it is. Whether the project can be synced with npm run sync.
 */
export async function writeSyncScript(dest: string, state: ProjectState, cli: string | null): Promise<boolean> {
  const sources = Object.keys(state.sources ?? {}).length > 0;
  const file = join(dest, SYNC_SCRIPT);
  const there = await readIfExists(file);
  const owned = there !== null && OWNED_SYNC_SCRIPT.test(there);
  const pkgPath = join(dest, 'package.json');
  const text = await readIfExists(pkgPath);
  let pkg: { scripts?: Record<string, string> } | null = null;
  try {
    const parsed = text === null ? null : (JSON.parse(text) as unknown);
    pkg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { scripts?: Record<string, string> }) : null;
  } catch {
    pkg = null;
  }
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : null;
  const command = scripts && Object.hasOwn(scripts, 'sync') ? scripts.sync : undefined;
  const write = (next: { scripts?: Record<string, string> }) =>
    // Written as it was: its own indentation (the template's tabs), its line ends, and a line end after.
    fs.writeFile(pkgPath, `${JSON.stringify(next, null, text?.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? '\t')}\n`.replace(/\n/g, text?.includes('\r\n') ? '\r\n' : '\n'));
  // A source export whose script this build cannot give (it was built without one) leaves what the copy has as it is.
  if (sources && cli === null) return owned && command === SYNC_COMMAND;
  if (sources) {
    if (!pkg || (there !== null && !owned)) return false;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, cli!);
    if (command === undefined) await write({ ...pkg, scripts: { ...(scripts ?? {}), sync: SYNC_COMMAND } });
    return (command ?? SYNC_COMMAND) === SYNC_COMMAND;
  }
  // No sources: the script this app wrote goes, and the command that ran it with it. The author's own stay.
  if (!owned) return false;
  await fs.rm(file, { force: true });
  await fs.rmdir(dirname(file)).catch(() => undefined);
  if (pkg && scripts && command === SYNC_COMMAND) {
    const { sync: _sync, ...rest } = scripts;
    void _sync;
    await write({ ...pkg, scripts: rest });
  }
  return false;
}

/** Make an exported source project ready to hand over: the current README and notices, and the sync script its sources need. */
export async function finishExportedSource(dest: string, state: ProjectState, noticePath: string, syncCli: string | null = null) {
  const syncs = await writeSyncScript(dest, state, syncCli);
  const readmePath = join(dest, 'README.md');
  const readme = await readIfExists(readmePath);
  if (readme === null || isGeneratedReadme(readme)) await fs.writeFile(readmePath, projectReadme(state.site.name, publicationPlan(state).drafts.length > 0, themeNotice(getTheme(state.site.themeId)), siteEntries(state).some((e) => isDraftEntry(e.entry)), redirectHost(state.site), syncs));
  const usesSamples = STARTER_ASSETS.some((a) => state.assets.assets[a.id]);
  if (usesSamples && !existsSync(join(dest, 'NOTICE.md')) && existsSync(noticePath)) await fs.copyFile(noticePath, join(dest, 'NOTICE.md'));
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

/** Whether a README is one this app wrote rather than the owner's own. */
export function isGeneratedReadme(text: string): boolean {
  // A checkout may have converted the line endings of an otherwise untouched file.
  const normalized = text.replace(/\r\n/g, '\n');
  const title = normalized.match(/^# (.*)\n/)?.[1];
  if (title === undefined) return false;
  // The notices name the site's theme: one written for any installed theme, word for word, is still the app's. An
  // owner's change to them (another licence, say) makes the README theirs.
  const notices = [...new Set([NOTICE, ...listThemes().map(themeNotice)])];
  return notices
    .flatMap((n) => (Object.keys(README_HOSTS) as RedirectHost[]).flatMap((h) => [false, true].flatMap((drafts) => [false, true].flatMap((entries) => [false, true].map((sources) => projectReadme(title, drafts, n, entries, h, sources))))))
    .includes(normalized);
}

/** Why a README's build leaves pages out, and what opening the project in SiteOrigin Builder changes about that. */
const DRAFTS_SECTION = `## Draft pages

This project has draft pages. Their documents are in \`siteorigin/pages/\`, but this export has no page files for them, so \`npm run build\` leaves them out. Pictures and documents from the asset library that only drafts use are kept in \`siteorigin/draft-assets/\` rather than \`static/assets/\`, so the build leaves those out too. Opening the project in SiteOrigin Builder writes their files back for editing and previewing, with those pictures and documents back in \`static/assets/\`, and from then on a build of that folder includes them: export the website from SiteOrigin Builder to publish without drafts.

`;

/** The same for draft collection entries, whose documents live with their collections. */
const DRAFT_ENTRIES_SECTION = `## Draft entries

This project has draft collection entries. Their documents are in \`siteorigin/collections/\`, but this export has no page files for them, so \`npm run build\` leaves them out. Pictures and documents from the asset library that only drafts use are kept in \`siteorigin/draft-assets/\` rather than \`static/assets/\`, so the build leaves those out too. Opening the project in SiteOrigin Builder writes their files back for editing and previewing, with those pictures and documents back in \`static/assets/\`, and from then on a build of that folder includes them: export the website from SiteOrigin Builder to publish without drafts.

`;

/** What an exported project with external sources says about syncing them without the app (#680). */
const SOURCES_SECTION = `## External sources

This project's collections are synced from external sources (their settings are in \`siteorigin/sources/\`). \`npm run sync\` syncs them without SiteOrigin Builder, as Sync now does in it, into the entries in \`siteorigin/collections/\` and the images in \`static/assets/\`: run it in CI, or when a source tells you it has changed. It reads each secret a source's settings name from an environment variable of the same name in capitals, with hyphens as underscores (\`\${secret:contentful-token}\` is \`CONTENTFUL_TOKEN\`), and writes no secret anywhere. A sync writes every file or none. Run one sync at a time in a folder.

The website's pages are made from those documents by SiteOrigin Builder, so \`npm run build\` builds the pages in this export as they are. To publish the synced entries, open the project in SiteOrigin Builder, which writes their pages again, and export the website.

`;

/** The notices of a site with this theme: its name and licence, the icons' and the fonts' (whose own notice travels with them). */
export function themeNotice(theme: { name: string; license: string }): string {
  return `The ${theme.name} theme is licensed under ${theme.license}. Icons come from Lucide (ISC license). The fonts come with the theme, in \`src/lib/siteorigin/fonts/\`, whose NOTICE.txt gives their licenses. Sample images from the starters, where still used, are described in NOTICE.md.`;
}
/** The notices of a site on Foundation, the theme every new project starts with. */
const NOTICE = themeNotice({ name: 'Foundation', license: 'MIT-0' });
/** What the README says about each host a site's redirect rules can be written for (see redirectHost). */
const README_HOSTS: Record<RedirectHost, { notFound: string; redirects: string }> = {
  cloudflare: {
    notFound: 'Cloudflare Pages, Netlify and Vercel use it automatically',
    redirects:
      'The rules are in `static/_redirects`, written for Cloudflare Pages. The build copies the file to `build/_redirects`. Cloudflare Pages reads it only at the root of the folder you publish: if the contents of `build/` go into a sub-folder of that, move the file up to the root (its addresses already include the sub-folder). On another host, set up the redirects in its own settings. For rules written for Netlify or Vercel, choose that host in SiteOrigin Builder (Site settings, under Redirects) and export again.'
  },
  netlify: {
    notFound: 'Netlify uses it automatically',
    redirects:
      'The rules are in `static/_redirects`, written for Netlify, each forced (`301!`) so that it applies ahead of the old address’s own page. The build copies the file to `build/_redirects`. Netlify reads it only at the root of the folder you publish: if the contents of `build/` go into a sub-folder of that, move the file up to the root (its addresses already include the sub-folder). On another host, set up the redirects in its own settings. For rules written for Cloudflare Pages or Vercel, choose that host in SiteOrigin Builder (Site settings, under Redirects) and export again.'
  },
  vercel: {
    notFound: 'Vercel uses it automatically',
    redirects:
      'The rules for Vercel are in `vercel.json`, beside `package.json`. Vercel reads that file from the root of what you deploy. When Vercel builds this project, it is already there; set the Vercel project’s Output Directory to `build`. When you deploy `build/` by itself, copy `vercel.json` into `build/` after each build: `npm run build` does not. If the contents of `build/` go into a sub-folder of what you deploy, put `vercel.json` at the root instead (its addresses already include the sub-folder). `static/_redirects` holds the same redirects for Cloudflare Pages.'
  }
};

/**
 * The README an exported project gets, for the host its redirect rules are written for. One exported with drafts
 * says how its build treats them.
 */
export function projectReadme(name: string, drafts = false, notice = NOTICE, draftEntries = false, host: RedirectHost = 'cloudflare', sources = false): string {
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

## Deploying

The static website is written to \`build/\`. Upload the contents of that folder to any static host. If the site lives in a sub-folder (for example on GitHub Pages), publish them there: the build takes that path from \`src/lib/siteorigin/paths.json\`.

### Not-found page

Addresses the site does not have should show its not-found page, \`build/404.html\`. ${README_HOSTS[host].notFound} when the contents of \`build/\` are the root of what you publish. Otherwise, if the host has a 404 error document setting, set it to \`/404.html\`, with the sub-folder in front when the site is in one (\`/my-site/404.html\`). On Apache, that is \`ErrorDocument 404 /404.html\`.

### Redirects

When the site keeps old addresses (of pages that have moved, say), each gets a page of its own that sends visitors on. Those pages work on any static host, but answer as pages that are there (HTTP 200). Rules for the host give a permanent redirect (HTTP 301) instead. A site with no old addresses has no rules file, so there is nothing more to set up.

${README_HOSTS[host].redirects}

## Project layout

- \`src/\`: the website's source. \`src/routes/\` and \`src/lib/siteorigin/\` hold the generated SvelteKit pages, components and styles.
- \`src/lib/siteorigin/custom/\`: code components you wrote. These are yours to edit.
- \`static/\`: files the build copies into the website as they are, such as images (in \`static/assets/\`), icons, the web app manifest and \`robots.txt\`. Depending on the site and its settings, it also holds \`sitemap.xml\`, \`rss.xml\`, \`llms.txt\`, \`llms-full.txt\`, Markdown copies of pages and \`_redirects\`.
- \`siteorigin/\` and \`siteorigin.project.json\`: SiteOrigin Builder's editable documents. Keep them if you want to keep editing visually.

Files generated by SiteOrigin Builder start with a comment. If you edit them by hand, SiteOrigin Builder keeps your version and asks before regenerating them.

${drafts ? DRAFTS_SECTION : ''}${draftEntries ? DRAFT_ENTRIES_SECTION : ''}${sources ? SOURCES_SECTION : ''}## Notices

${notice}
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
  const manifest = JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string>; pending?: Record<string, string> };
  const claimed = Object.hasOwn(manifest.files ?? {}, SERVER_HOOK_FILE) || Object.hasOwn(manifest.pending ?? {}, SERVER_HOOK_FILE);
  const own = ownServerHook(dir, claimed);
  return own ? `Pages written in another language need SiteOrigin Builder's ${SERVER_HOOK_FILE}, and this project has a server hook of its own (${own}): SvelteKit runs only one of them. Rename or remove yours, then export again.` : null;
}

/**
 * Why the exported site has no canonical links, social image URLs or sitemap (nor the links that tell search engines
 * about each page's translations, when pages are linked as translations, nor an RSS feed, when it publishes posts): no
 * public URL is set, or the one saved can't be used (saved by hand or by an earlier version). Null when the site has a
 * public URL it was built from.
 */
export function publicUrlWarning(state: ProjectState): string | null {
  // A value of another kind (a number written by hand) is a URL that can't be used, not a missing one.
  const raw: unknown = state.site.baseUrl;
  const saved = typeof raw === 'string' ? raw.trim() : raw == null ? '' : JSON.stringify(raw);
  const check = checkPublicUrl(saved);
  if (check.ok && check.url) return null;
  // Search engines read a page's translations only at full addresses, and a feed reader needs each post's, so a site
  // with translated pages loses those links and a site that publishes posts loses its feed.
  const live = publishedState(state);
  const translated = live.site.pageOrder.some((id) => live.pages[id] && pageAlternates(live, live.pages[id]).length > 0);
  const parts = ['canonical links', 'social image URLs', ...(translated ? ['search-engine links between translations'] : []), 'the sitemap', ...(hasFeedEntries(state) ? ['the RSS feed'] : [])];
  const omitted = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
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
 * Warnings for sections the site shows with nothing under their heading (see emptySections): where each is, its heading
 * and what it has none of. Project health lists each one and leads to it.
 */
export function emptySectionWarnings(state: ProjectState): string[] {
  const found = siteTrees(state).flatMap(({ tree, label }) => emptySections(state, tree).map((e) => `${label} · ${e.name}: ${e.heading ? `“${e.heading}” has` : 'has'} no ${e.what}`));
  if (!found.length) return [];
  const lead =
    found.length === 1
      ? 'A section has nothing to show visitors. Give it content, or remove it (Project health leads to it):'
      : `${found.length} sections have nothing to show visitors. Give each one content, or remove it (Project health leads to each):`;
  const more = found.length - UNLINKED_LISTED;
  return [lead, ...(more > 1 ? [...found.slice(0, UNLINKED_LISTED), `…and ${more} more.`] : found)];
}

/** Warnings for published pages with nothing on them (see blankPages): each by its title and address. */
export function blankPageWarnings(state: ProjectState): string[] {
  const found = blankPages(state).map((p) => `${p.title} (${p.route})`);
  if (!found.length) return [];
  const lead = found.length === 1 ? 'A page has nothing on it, so visitors find it blank. Add content to it, or keep it off the website:' : `${found.length} pages have nothing on them, so visitors find them blank. Add content to each one, or keep it off the website:`;
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
  const message = page ? `The production build failed while building the ${pageTitle(page)} page (${route}).` : route ? `The production build failed while building ${route}.` : at ? `The production build failed in ${at}.` : BUILD_FAILED_UNPLACED;
  const warnings = [...read.causes];
  if (at && (page || route)) warnings.push(`The build was working in ${at}.`);
  if (!warnings.length) warnings.push('The build did not say what went wrong. The technical details list everything it printed.');
  return { message, warnings: warnings.slice(0, 8), details: read.report(message) };
}


/**
 * The trees the website shows at `route`, of a published state (publishedState): a page and the shared header and
 * footer it shows, or an entry or archive page with its collection's layout, when it has one, and both of them.
 */
export function routeTrees(live: ProjectState, route: string): NodeTree[] {
  const page = live.site.pageOrder.map((id) => (Object.hasOwn(live.pages, id) ? live.pages[id] : undefined)).find((p) => p?.route === route);
  if (page) return [page, ...SHELL_PARTS.filter((part) => showsPart(page, part)).map((part) => live.site.shell[part])];
  const shell = SHELL_PARTS.map((part) => live.site.shell[part]);
  const entry = siteEntries(live).find((e) => e.route === route);
  if (entry) return [...templateTrees(live).filter((t) => t.owner.kind === 'template' && t.owner.id === entry.collection.settings.id).map((t) => t.tree), ...shell];
  const archive = archivePages(live).find((a) => a.route === route);
  if (archive) return [...shownArchiveLayouts(live, [archive]).map((a) => a.tree), ...shell];
  return [];
}

/** The project's code components the website shows at `route`, by name, each as the author knows it and with its file. */
export function routeCodeComponents(live: ProjectState, route: string): Array<{ name: string; file: string }> {
  return [...definitionsRenderedBy(live, routeTrees(live, route))]
    .map((id) => live.components[id])
    .filter((d) => d?.kind === 'code' && d.owner === 'project')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ name: d.name, file: defFile(d) }));
}

/** A page of the website as a message names it: its title and address, or its address alone. */
const namedPage = (p: ReviewPage) => {
  const title = p.title.replace(/\s+/g, ' ').trim();
  return title ? `“${title.length > 80 ? `${title.slice(0, 80)}…` : title}” (${p.route})` : p.route;
};

/** How many code components a stop names before it sums up the rest. */
const COMPONENTS_LISTED = 6;

/**
 * Why a website export stopped for pages that show the site's error page once they start in a browser (#1534), in
 * route order: the first page, what the browser said went wrong there, the code components it shows (where to look:
 * the browser cannot say which one failed), and the other pages found doing the same.
 */
export function brokenPagesStop(live: ProjectState, broken: Array<{ page: ReviewPage; check: Extract<PageCheck, { status: 'error-page' }> }>): { message: string; warnings: string[]; details: string } {
  const [{ page, check }] = broken;
  const message = `${namedPage(page)} shows “${check.heading}” in place of its content once it opens in a browser, so visitors would see an error page. Fix it, then export again.`;
  const cause = check.cause?.split('\n').find((l) => l.trim())?.trim();
  const warnings = [cause ? `The browser reported: ${cause.length > 300 ? `${cause.slice(0, 300)}…` : cause}` : 'The browser was not told what went wrong.'];
  const code = routeCodeComponents(live, page.route);
  const named = code.slice(0, COMPONENTS_LISTED).map((c) => `the “${c.name}” component (${c.file})`);
  const more = code.length - named.length;
  if (code.length === 1) warnings.push(`It shows one code component, ${named[0]}. Look there first: code that runs only in the browser, such as an $effect, does not run while the site is built.`);
  else if (code.length) warnings.push(`It shows ${code.length} code components. Look at these first, since code that runs only in the browser does not run while the site is built: ${named.join(', ')}${more ? `, and ${more} more` : ''}.`);
  else warnings.push('It shows no code component of the project’s, so a file of the project’s own may be the cause.');
  const others = broken.slice(1).map((b) => namedPage(b.page));
  if (others.length === 1) warnings.push(`${others[0]} shows it too.`);
  else if (others.length) warnings.push(`${others.length} other pages show it too: ${others.slice(0, COMPONENTS_LISTED).join(', ')}${others.length > COMPONENTS_LISTED ? ', and more' : ''}.`);
  // The report names every candidate of every page, however many the warnings sum up.
  const report = (b: (typeof broken)[number]) => {
    const shown = routeCodeComponents(live, b.page.route);
    return [
      `Page: ${namedPage(b.page)}`,
      `Shown: ${b.check.heading}`,
      shown.length ? `Code components: ${shown.map((c) => `${c.name} (${c.file})`).join(', ')}` : 'Code components: none',
      ...(b.check.logged.length ? ['Browser errors:', ...b.check.logged] : ['Browser errors: none']),
      ''
    ];
  };
  const details = [message, '', ...broken.flatMap(report)].join('\n').trimEnd();
  return { message, warnings, details };
}

/** A warning for the pages the export could not open in a browser to check (brokenPagesStop), or null when it checked them all. */
export function uncheckedPagesWarning(unchecked: Array<{ page: ReviewPage; detail: string }>): string | null {
  if (!unchecked.length) return null;
  const [first] = unchecked;
  const why = first.detail.trim().replace(/\.$/, '');
  const reason = why.charAt(0).toLowerCase() + why.slice(1);
  if (unchecked.length === 1) return `${namedPage(first.page)} could not be opened in a browser to check that it still shows its content once it starts: ${reason}.`;
  return `${unchecked.length} pages could not be opened in a browser to check that they still show their content once they start, such as ${namedPage(first.page)}: ${reason}.`;
}

/** Markup and code only the editor's preview may carry. */
const EDITOR_MARKUP = /data-so-(ctx|node)|siteorigin-bridge/;

/** A start tag as Svelte writes one, in a page or in a script's template, with its attributes. */
const START_TAG = /<[a-zA-Z][^\s/>]*((?:\s+[^\s"'=<>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const TAG_ATTRIBUTE = /\s([^\s"'=<>/]+)(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Whether built HTML, or a built script's templates, give an element one of a code component's editor markers (see
 * shared/code-markers.ts), which both exports take out of the code (see stripCodeMarkers). Read as attributes of start
 * tags, so words that only mention a marker (a title, a page's text) are the site's own.
 */
export function carriesCodeMarker(text: string): boolean {
  if (!mentionsCodeMarker(text)) return false;
  for (const tag of text.matchAll(START_TAG)) for (const a of tag[1].matchAll(TAG_ATTRIBUTE)) if (isCodeMarker(a[1])) return true;
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
  if (EDITOR_MARKUP.test(html) || carriesCodeMarker(html)) return `Editor-only markup was found in ${NOT_FOUND_FILE}. Export aborted.`;
  return null;
}

/** The built not-found page in `out`, or null when the build did not write it as a plain file. */
export async function readNotFoundPage(out: string): Promise<string | null> {
  const file = join(out, NOT_FOUND_FILE);
  const stat = await fs.lstat(file).catch(() => null);
  return stat?.isFile() ? readExportFile(file, 'utf8') : null;
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

/**
 * What an author needs to know to have their host show the not-found page, for a site published under `base` on the
 * host its redirect rules are written for. Information, not a warning: nothing in the project needs fixing. The hosts
 * named are the ones the Redirects setting offers; the default is Cloudflare Pages or another host.
 */
export function notFoundHostNote(base: string, host: RedirectHost): string {
  const path = notFoundPath(base);
  const page = `Addresses your site does not have show its not-found page, ${NOT_FOUND_FILE}.`;
  const errorDocument = `set the 404 error document to ${path} (on Apache: ErrorDocument 404 ${path})`;
  const named = host === 'netlify' ? 'Netlify' : host === 'vercel' ? 'Vercel' : null;
  // The hosts find 404.html on their own only at the root they publish: under a sub-path, the author has to point them at it.
  if (base) {
    const served = `The website is built to be served under ${base}/`;
    return named ? `${page} ${served}, where ${named} does not find it on its own: have it show ${path} for missing addresses under ${base}/.` : `${page} ${served}, so ${errorDocument}.`;
  }
  if (named) return `${page} ${named} uses it automatically when it publishes the exported website as it is.`;
  return `${page} Cloudflare Pages, Netlify and Vercel use it automatically when they publish the exported website as it is. On another host, ${errorDocument}.`;
}

/**
 * SvelteKit runs one server hook. The project's files can be a step behind a hook of its own (src/hooks.server.ts, or
 * a file or folder named src/hooks.server) added or removed since SiteOrigin Builder last wrote them: a staged copy
 * settles it as the next regeneration would, leaving the generated src/hooks.server.js out beside the project's own,
 * and writing it when there is no hook at all. generated-manifest.json then lists what the copy has.
 */
export async function settleServerHook(dir: string, state: ProjectState): Promise<void> {
  const manifest = JSON.parse((await readExportText(join(dir, MANIFEST_PATH))) ?? '{}') as { files?: Record<string, string> };
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
