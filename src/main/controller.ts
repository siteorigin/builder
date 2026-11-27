import { app, BrowserWindow, dialog, shell, type OpenDialogOptions, type WebContents } from 'electron';
import { markdownMirrorRoute } from '@shared/llms';
import { firstStepsStart } from '@shared/first-steps';
import { constants as fsConstants, existsSync, mkdtempSync, promises as fs, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AiTurnReview, ComponentExportResult, ConflictChoice, ComponentImportResult, SavedComponent, SavedInsertPlace, SavedInsertResult, SaveToLibraryResult, PostImportKind, PostImportResult, PostImportReviewResult, CreateProjectOptions, DuplicateProjectOptions, DuplicateProjectResult, ExportFormat, ExportNote, ExportResult, FileText, FontFileData, ImportChoices, ImportReview, ImportReviewRow, LocalWorkspaceState, ProjectSnapshot, ProgressEvent, RecentExport, RestoreVersionResult, RuntimeState, StorageInfo, VersionReview, WebCopyPlan, WebsiteTools } from '@shared/api';
import { validateOperation, type ApplyResult, type EditBatch, type EditOperation } from '@shared/ops';
import type { AssetRecord, ProjectState, PublishedDoc, SourceDoc } from '@shared/types';
import type { SavedCopy, SourceSettingsDraft, TrustRequest, Unpacking } from '@shared/api';
import { ProjectFeed, type ProjectChange } from '@shared/project-feed';
import { createStarterState, starterProblem } from '@catalogue/starters';
import { findTheme } from '@catalogue/index';
import { slugify } from '@shared/routes';
import { applyOperations, sourceHash } from '@engine/apply';
import { websiteFormNotes, type Diagnostic } from '@engine/validate';
import { exportedCounts } from '../renderer/src/lib/export-summary';
import { basePath, generateManagedComponent, generatePage, defFile, liveRedirects, publishedState, siteEntries } from '@generator/index';
import { archivePages } from '@shared/archives';
import { NOT_FOUND_FILE } from '@shared/not-found';
import { placeholderImageCount } from '@generator/checks';
import { redirectHost } from '@generator/host-redirects';
import type { BuildFailureContext } from './build-failure';
import { zipDirectory } from './zip';
import { expectedFolder, filesToWrite, NOT_A_PROJECT_ZIP, readProjectZip, unpackProject, WEBSITE_ZIP, ZipError } from './unzip';
import { StaticPreviews } from './static-preview';
import { isPlainFile, builtPhotosMessage, deliverVercelConfig, pageLanguageWarning, publicUrlNote, rivalHookStop, cleanBuiltSite, cleanWebsitePhotos, copyProjectSource, draftLinksStop, draftSourceNotes, publishedChanged, withheldRoutes, withheldStaticFiles, editedGeneratedFile, explainBuildFailure, exportedAssetFilter, finishExportedSource, leaveOutDrafts, listFiles, locatedPhotos, locationKeptNote, locationRemovedNote, missingAssetsStop, missingSourceWarnings, missingUnusedWarnings, missingWebsiteAssets, notFoundAddressWarning, notFoundHostNote, notFoundPageProblem, omittedAssetsWarning, ownNotFoundFileNote, ownNotFoundFileStop, readNotFoundPage, settleServerHook, stripCodeMarkers, carriesCodeMarker, projectInventory, inventoryChanged, readExportFile, type ExportHashes, projectReadme, publishFolder, pruneWebsiteAssets, replaceEmptyFolder, readLibraryImage, sectionLinkWarnings, uncleanablePhotosMessage, uniqueChild, unlinkedButtonWarnings, unlinkedMenuLinkWarnings, emptySectionWarnings, formNameWarnings, runtimeFontWarnings, variantCredits, writeExportedSources, exportedSourcesProblem } from './export';
import { LOCAL_DIR, LOCK_HEARTBEAT_MS, NO_LOCK, ProjectLockedError, ProjectSession, ThemeUnavailableError } from './project/session';
import { DOC_DIR, MANIFEST_FILE, ProjectFormatError } from './project/documents';
import { DOCUMENT_EXTENSIONS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, IMPORT_IMAGE_EXTENSIONS, importAsset, importAssetBatch, importPackageImage, MEDIA_PARALLEL, isAssetOfKind, isOpaquePicture, libraryWebCopyPlan, locateAssetFile, originalNameOf, pictureMime, releaseMediaWorkers, restoreAssetFiles, reviewImportFile, storeLibraryWebCopy } from './project/assets';
import { postReader, stopPostReads } from './posts-import/process';
import { sourceApprovals, sourceSecrets, sourceSyncRunner, stopSourceSyncs } from './sources/process';
import { sampleSource, sourceDraftState, syncSource, type SourceSampleResult, type SourceSyncResult } from './sources/sync';
import { createAgentSources } from './sources/agent';
import { sourceFingerprint } from '@shared/sources';
import type { SourceToolHost } from '@agent/source-tools';
import { planOperations, planPostImport, type PostImportPlan } from './posts-import/plan';
import { postImportPreview } from './posts-import/preview';
import { readContained } from './posts-import/files';
import { isImageBlock } from '@shared/richtext';
import { MAX_PICTURE_BYTES, type ParsedSource } from './posts-import/source';
import { heicDecoder, type PhotoDecoder } from './project/photo-convert';
import { findMissingAssetFiles, missingFileDiagnostics, missingParts } from './project/asset-files';
import { atomicWrite, readIfExists, sha, toJson } from './project/fsutil';
import { PUBLISHED_FILE, publishedDocProblem, withPublished } from '@shared/published';
import { collectionRouteOwner } from '@shared/collections';
import { fontCoverage } from './project/media';
import { isValidFontAsset } from '@shared/fonts';
import { photoMetadata } from './project/photo-metadata';
import { watchTree, type FolderWatch } from './folder-watch';
import { importSamples, type SampleCache } from './project/starter-samples';
import { DevServer, buildProject, dependenciesReady, prepareDependencies, starterTools, type RuntimeStatus } from './runtime/manager';
import { NETWORK_CODES, ToolsDownloadError } from './runtime/availability';
import { type BuildTools, createPreviewStage, KeptTools, removePreviewStage, sweepPreviewStages, syncPreviewStage } from './runtime/stage';
import { clearComponentPreviews, previewSpec, removeComponentPreview, writeComponentPreview } from './runtime/component-preview';
import { ComponentThumbs, writeThumb, type CaptureResult } from './runtime/component-thumbs';
import type { ComponentThumb } from '@shared/component-thumbs';
import { generateComponentPreview } from '@generator/preview';
import { canonicalDir } from '../runtime/policy';
import { addRecent, isTrusted, wasTrusted, loadSettings, rememberGetStartedHidden, rememberProjectParent, usableProjectParent, renameRecent, trust, untrust } from './settings';
import { MAX_COPY_NAME, projectDisplayName, projectFolder, projectFolderName } from '@shared/project-name';
import { RELAY_URL_ENV, resolveRelayUrl } from '@shared/live/relay-url';
import { LIVE_BATCH_LABEL_MAX, type LiveEditBatch } from '@shared/live/capabilities';
import { MAX_MESSAGE_LENGTH } from '@shared/live/limits';
import { normalizeDisplayName, RPC_ERROR_CODES, type RpcError } from '@shared/live/messages';
import { liveSnapshot, scrubHostPaths, type LiveApplyResult, type LiveProjectSnapshot, type LiveSnapshotSource } from '@shared/live/snapshot';
import { guestEditProblem } from '@engine/guest-edits';
import { LiveHostManager, type LiveGuestEdit } from './live/host';
import { LiveGuestManager } from './live/guest';
import { loopbackPreview } from './live/preview-proxy';
import { newId } from '@shared/ids';
import { packageFileName, type ComponentPackage } from '@shared/component-package';
import { codeBrought, importedCode, migratePackage, packagedDefinitions, planComponentPackage, type ImportPlacement } from '@engine/component-package';
import { definitionRole } from '@engine/insert-role';
import { findSaved, listSaved, removeSaved, saveToLibrary, savedPackagePath } from './saved-components';
import { buildComponentPackage, preparePackageImport, readComponentPackage, type PreparedImport } from './project/component-package';
import { perf, perfNow, serializedSize, timed } from './perf';

/** Said with every editable project export: a statement, never a note to review, since nothing needs doing about it. */
const PRIVATE_FILES_LEFT_OUT = 'Private files such as .env, keys and credentials were left out.';

const INSTANCE_ID = randomUUID();

const READ_ONLY = 'This project is read-only.';

/** Remove an export's staging folder as far as can be done now; what cannot be removed yet is swept later. */
const removeStaging = (dir: string) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
const STALE_INSERT = 'The page changed while the component was being inserted. Insert it again.';
const TRUST_CHANGED = "This project's build settings changed outside SiteOrigin Builder. Close and reopen the project to review and trust them.";
const PREVIEW_UNAVAILABLE = 'This project was made with a newer version of SiteOrigin Builder, which is needed to show its preview. Update the app to see and edit the site.';

/** A project only a newer version can generate has no preview here (spec 16.6): its kind of read-only cannot be unlocked. */
function previewUnavailable(s: ProjectSession): boolean {
  return !!s.readOnly && !s.readOnly.canUnlock;
}

/** An export called off part way through: the project was taken over or closed. */
class ExportStopped extends Error {}

/** Where new projects go by default: Documents/SiteOrigin. */
export function defaultProjectsFolder(): string {
  return join(app.getPath('documents'), 'SiteOrigin');
}

/** Where New project starts: the folder the last project was created in, or Documents/SiteOrigin when that is gone. */
export async function suggestedProjectsFolder(): Promise<string> {
  return (await usableProjectParent().catch(() => undefined)) ?? defaultProjectsFolder();
}

/** The image a recovery was made for changed (relinked, removed) before its files could be written. */
class AssetChanged extends Error {}

/** Project health's missing-file entries; a project from a newer version may not follow this version's shapes. */
function safeMissingDiagnostics(s: ProjectSession) {
  try {
    // The uses the snapshot shows, worked out once per state.
    return missingFileDiagnostics(s.state, s.missingAssets, () => s.assetUsages());
  } catch {
    return [];
  }
}

export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

/**
 * Where this build keeps the sample photos its first project imported, for the projects after it
 * (project/starter-samples.ts); none for a build that cannot be told from the next (run unbundled, or from the dev
 * server, whose code changes under one build stamp).
 */
function sampleCache(): SampleCache | null {
  if (typeof __BUILD_DATE__ !== 'string' || (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)) return null;
  const commit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';
  return { dir: join(app.getPath('userData'), 'starter-samples'), build: `${app.getVersion()} ${commit} ${__BUILD_DATE__}` };
}

/** Licence notice for the Business starter's sample images. */
/**
 * The script an exported project with external sources syncs them with (#680), built beside the main process (see
 * scripts/sync-cli.ts); null when this build has none, and the export then goes without it.
 */
async function syncCliText(state: ProjectState): Promise<string | null> {
  if (!Object.keys(state.sources ?? {}).length) return null;
  return fs.readFile(join(dirname(fileURLToPath(import.meta.url)), 'sync-sources.mjs'), 'utf8').catch(() => null);
}

function starterNotice(): string {
  return join(resourcesDir(), 'resources', 'starter-assets', 'NOTICE.md');
}

/** The files every new project starts from. */
function templateFiles(): string {
  return join(resourcesDir(), 'templates', 'sveltekit-brochure', 'files');
}

/** What a new project's session writes at the top of its folder: the manifest, the documents, and the generated site. */
const SESSION_ENTRIES = [MANIFEST_FILE, DOC_DIR, 'src', 'static'];

/**
 * Undo a creation that stopped part way, so the same name and folder can be used again. Only the top-level entries the
 * attempt began to write are removed: anything else that turned up in the folder stays, and so does the folder itself
 * unless the attempt made it. The local folder goes last: it is the attempt's claim on the folder, and while it stands
 * no other creation can start writing there. Says whether everything the attempt wrote is gone.
 */
async function removeCreatedProject(dir: string, session: ProjectSession | null, wrote: Set<string>, madeFolder: boolean): Promise<boolean> {
  let removed = true;
  const remove = (name: string) => fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => void (removed = false));
  for (const name of wrote) if (name !== LOCAL_DIR) await remove(name);
  // Closing the editor's project does not close a session that never reached it: its lock and heartbeat go here.
  // Closing one that was attached (and so already closed) again does nothing.
  await session?.close().catch(() => undefined);
  if (wrote.has(LOCAL_DIR)) await remove(LOCAL_DIR);
  // Never recursive: a folder that still holds something the attempt did not write is left as it is.
  if (madeFolder) await fs.rmdir(dir).catch(() => undefined);
  return removed;
}

async function configHash(dir: string): Promise<string> {
  const parts = await Promise.all(['package.json', 'package-lock.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js'].map((f) => readIfExists(join(dir, f))));
  return sha(parts.map((p) => p ?? '').join('\n--\n'));
}

type OpenResult = { ok: boolean; message?: string; needsTrust?: TrustRequest };

/**
 * A preview server started while its project was still opening (prepareRuntime), until its start takes it over:
 * `dev` once its checks passed and it was forked, `started` settling as its start did, and whether the opening's
 * publication was seen (`held`), how many project files it and any save before the takeover changed (`landed`), how
 * many of those are under way (`holding`), and who waits for none to be (`idle`).
 */
interface EarlyRuntime {
  session: ProjectSession;
  dev: DevServer | null;
  started: Promise<void>;
  held: boolean;
  landed: number;
  holding: number;
  idle: Array<() => void>;
}

/**
 * Open project's picker. On macOS one picker takes a project folder, its siteorigin.project.json or a project ZIP file.
 * Windows and Linux cannot mix files and folders in one picker, so theirs takes the file or a ZIP file, and a folder
 * when one is asked for (Welcome's Open project folder).
 */
function openProjectDialog(folder: boolean): OpenDialogOptions {
  const defaultPath = existsSync(defaultProjectsFolder()) ? defaultProjectsFolder() : undefined;
  if (folder && process.platform !== 'darwin') return { title: 'Open a SiteOrigin Builder project folder', defaultPath, properties: ['openDirectory'] };
  return {
    title: 'Open a SiteOrigin Builder project',
    defaultPath,
    properties: process.platform === 'darwin' ? ['openDirectory', 'openFile'] : ['openFile'],
    filters: [{ name: 'SiteOrigin project or ZIP file', extensions: ['json', 'zip'] }]
  };
}

/**
 * Find folder… on a missing recent project (#217): a folder, on every platform. A ZIP file would unpack a new copy, never
 * the folder the project was moved to.
 */
function findFolderDialog(name: string | undefined): OpenDialogOptions {
  const defaultPath = existsSync(defaultProjectsFolder()) ? defaultProjectsFolder() : undefined;
  const message = name ? `Choose the folder ${name} is in now.` : 'Choose the folder the project is in now.';
  return { title: name ? `Find ${name}` : 'Find a project folder', message, defaultPath, properties: ['openDirectory'] };
}

/** Is `path` a ZIP file (a folder that happens to end in .zip is still a folder)? */
async function isZipFile(path: string): Promise<boolean> {
  if (!/\.zip$/i.test(path)) return false;
  return (await fs.stat(path).catch(() => null))?.isFile() ?? false;
}

/** A failure message that says which project folder it is about. */
const inFolder = (message: string, dir: string) => `${message} Project folder: "${dir}".`;

/** A file system failure a person can act on, by its cause; null for any other, which is reported as it is. */
function actionable(e: unknown): 'full' | 'denied' | null {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC') return 'full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'denied';
  return null;
}

/** Why a project could not be opened, in plain words and with what to do, when the cause is one a person can fix. */
function openFailure(e: unknown, dir?: string): string | null {
  const cause = actionable(e);
  if (cause === 'full') return 'Your disk is full. Free up some space, then open the project again.';
  if (cause === 'denied') return `SiteOrigin Builder does not have permission to open the files in ${dir || 'that folder'}. Move the project folder somewhere you own, such as your Documents folder, then open it again.`;
  return null;
}

/**
 * One operation's result as a live-session guest is given it: the IDs of what it made (`nodeId`, `pageId`,
 * `definitionIds`…), which the guest's next edit can name, and nothing else the engine reports.
 */
function sharedIds(result: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(result ?? {})) {
    if (!/^[a-z][A-Za-z]*Ids?$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value as string[];
  }
  return out;
}

/**
 * A project asked for by its folder (a Recent projects card, Duplicate's Open copy) that is no longer there (#809). The
 * author chose no folder, so nothing says it is the wrong kind: the folder, or the project in it, was moved, renamed or
 * deleted. Welcome's list then reads the entry again, and its card offers Find folder….
 */
export function projectNotFound(dir: string): string {
  // A file where the folder was is no folder at all: the folder was not found.
  const isDirectory = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  return isDirectory(dir)
    ? `The project in ${dir} was not found: its ${MANIFEST_FILE} is no longer there. It may have been moved, renamed or deleted.`
    : `The project folder ${dir} was not found. It may have been moved, renamed or deleted.`;
}

/**
 * Read just enough of a project's manifest to name it. A missing, empty, truncated or otherwise unreadable
 * manifest comes back as a message naming the file and folder; nothing is thrown and nothing is changed.
 */
export async function readManifestSummary(dir: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const where = `${MANIFEST_FILE} in "${dir}"`;
  let text: string | null;
  try {
    text = await readIfExists(join(dir, MANIFEST_FILE));
  } catch (e) {
    return { ok: false, message: `Could not read ${where}: ${(e as Error).message}` };
  }
  if (text === null) return { ok: false, message: `That folder is not a SiteOrigin Builder project. Choose a folder that contains ${MANIFEST_FILE}.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: `${where} is incomplete or damaged, so the project was not opened. If it was copied or downloaded, replace it with a complete copy and try again, or choose another project. The folder was not changed.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, message: `${where} is not a valid project file, so the project was not opened. The folder was not changed.` };
  const name = (parsed as { name?: unknown }).name;
  return { ok: true, name: typeof name === 'string' && name.trim() ? name : basename(dir) };
}

/** How long the preview server gets to notice files just written before a component is photographed. */
const THUMB_SETTLE_MS = 400;

/** Real web fonts are far smaller; a font file is read whole for the editor's samples. */
const MAX_FONT_FILE = 32 * 1024 * 1024;


/**
 * The editor's identity attributes on an element, or its bridge: never in a built page. A page's own words can say
 * the same names, in its text or in an attribute's value, so only an attribute of a start tag counts (a value's own
 * quotes are written &quot;, so `="` never occurs inside one).
 */
const EDITOR_MARKUP = /<[a-zA-Z][^<>]*\sdata-so-(?:ctx|node)="|siteorigin-bridge/;
/** Editor-only markup in a built page: the editor's own attributes and bridge, or a code component's editor marker. */
const editorMarkup = (html: string) => EDITOR_MARKUP.test(html) || carriesCodeMarker(html);
/** The same in a built script: the bridge, the editor's attributes, or a template that writes a code marker. */
const editorScript = (js: string) => /siteorigin-bridge|data-so-ctx/.test(js) || carriesCodeMarker(js);
export class Controller {
  session: ProjectSession | null = null;
  dev: DevServer | null = null;
  /** The preview server started early for a project still opening, for its start to take over (see prepareRuntime). */
  private early: EarlyRuntime | null = null;
  /** Early preview servers stopped and not yet exited, by folder: no other server starts there, and no lock goes, first. */
  private earlyExits = new Map<string, Promise<void>>();
  private createAbort: AbortController | null = null;
  /** Set from a switch's close until its replacement is attached. */
  private handingOver = false;
  /** Set once the app is quitting: no project replaces the one being closed for it. */
  quitting = false;
  /** New projects being made (or unpacked from a ZIP file), each until it is shown or has gone again. */
  private creations = new Map<Promise<unknown>, AbortController>();
  /** Copies of the open project under way (see duplicate). */
  private duplicates = new Set<Promise<unknown>>();
  /** Every open under way, so its window going can call off a project ZIP file being opened. */
  private openAborts = new Set<AbortController>();
  /** The open whose ZIP file is being unpacked now: the one the unpacking dialog's Cancel means. */
  private unpacking: AbortController | null = null;
  /** Project ZIP files are opened one at a time, each after the last has finished or cleaned up. */
  private zipOpens: Promise<unknown> = Promise.resolve();
  /** Previews of the open project's exported websites, one per export. */
  private previews = new StaticPreviews();
  /** What the open project exported since it was opened, newest first. */
  private recentExports: RecentExport[] = [];
  private localState: LocalWorkspaceState = {};
  /** Names this opening of the project in workspace saves; null while none is open or the open one is closing. */
  private workspaceKey: string | null = null;
  private openings = 0;
  /** Counts projects closed, so a replacement prepared meanwhile can tell that the project it replaces has gone. */
  private closings = 0;
  private localDirty = false;
  private localTimer: NodeJS.Timeout | null = null;
  private localWrites: Promise<void> = Promise.resolve();
  private exportPaths = new Set<string>();
  private watchers: FolderWatch[] = [];
  /** The folders the last watchExternalChanges could not watch because they were not there, project-relative. */
  private unwatched = new Set<string>();
  private watchTimer: NodeJS.Timeout | null = null;
  /** Which installation of the document watches is current: a look one that has gone set off never runs. */
  private watchGeneration = 0;
  private assetTimer: NodeJS.Timeout | null = null;
  private folderTimer: NodeJS.Timeout | null = null;
  private folderPoll: NodeJS.Timeout | null = null;
  /** The private copy the preview runs from while the project may not be written to (spec 16.6, 18.1). */
  private stage: string | null = null;
  private stageSync: Promise<unknown> = Promise.resolve();
  private stageTicket = 0;
  /** The project revision the private copy was last brought up to, and the preview told of (-1 before the first). */
  private stagedRevision = -1;
  /** Watches over the files the copy is made from, as the project's own dev server would watch them. */
  private stageWatchers: FolderWatch[] = [];
  private stageTimer: NodeJS.Timeout | null = null;
  /** The project whose copy was already replaced once after a mirror failed, so a lasting failure cannot loop. */
  private restaged: ProjectSession | null = null;
  /** The last preview status sent while no preview process runs (setting up, copying, or why it cannot start). */
  private pendingStatus: RuntimeState | null = null;
  /** Isolated component previews prepared for the preview server running now, by key, with the folder each is in. */
  private componentPreviews = new Map<string, string>();
  /** When the files the preview server shows last changed: the project's own, or its private copy's. */
  private filesChangedAt = 0;
  /** Photographs a prepared component preview for Insert's thumbnails; set by the app (main/thumb-capture). */
  thumbCapture: ((server: string, path: string) => Promise<CaptureResult>) | null = null;
  /** Thumbnails of the project's components for Insert, kept in the project's editor cache. */
  readonly thumbs = new ComponentThumbs({
    current: () => {
      const s = this.session;
      // A project this app may not write to is read from, never written to: its new thumbnails stay in memory.
      return s && this.workspaceKey ? { opening: this.workspaceKey, state: s.state, cacheRoot: s.readOnly ? null : s.dir, readRoot: s.dir } : null;
    },
    previewServer: () => (this.dev?.status.state === 'ready' ? (this.dev.status as { url: string }).url : null),
    settle: async () => {
      // Every write already queued (the generated tokens and styles the preview loads among them), then the private
      // copy a read-only project is previewed from, then a moment for the preview server to notice the files changed
      // (as the AI's page measurements allow).
      await this.session?.exclusive(async () => undefined);
      await this.stageSync;
      const wait = this.filesChangedAt + THUMB_SETTLE_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
    prepare: (definitionId) => this.prepareComponentPreview({ definitionId }),
    release: (key) => void this.releaseComponentPreview(key),
    capture: (server, path) => (this.thumbCapture ? this.thumbCapture(server, path) : Promise.resolve({ ok: false, message: 'Thumbnails cannot be drawn here.', transient: true })),
    persist: async (root, key, png) => {
      const s = this.session;
      if (!s || s.readOnly || s.dir !== root) return;
      await s.whileOwner(() => writeThumb(root, key, png));
    }
  });
  /**
   * The live session the open project is hosting, if any (#762). It belongs to the opening it was started in and ends
   * with it; its guests see the preview this project's own server shows.
   */
  readonly live = new LiveHostManager({
    opening: () => (this.session && this.workspaceKey ? { workspaceKey: this.workspaceKey, projectName: projectDisplayName(this.session.state) } : null),
    preview: () => (this.session && this.workspaceKey ? loopbackPreview(this.dev?.url) : null),
    publishing: () => !!this.dev?.holding,
    publishedRevision: () => (this.dev ? this.publishedRevision : null),
    relay: async () => resolveRelayUrl({ env: process.env[RELAY_URL_ENV], setting: (await loadSettings()).settings.liveRelayUrl }),
    guestSnapshot: (opening) => this.guestSnapshot(opening),
    applyGuest: (opening, guest, batch) => this.applyGuest(opening, guest, batch),
    emit: (channel, payload) => this.send(channel, payload)
  });
  /**
   * This app as a guest in another computer's live session (#766): the remote shell's connection. It holds no project
   * of this computer's, so it runs only while none is open here: opening one leaves it (attach).
   */
  readonly remote = new LiveGuestManager({
    emit: (channel: string, payload: unknown) => {
      this.send(channel, payload);
      if (channel === 'remote:state') this.onRemoteState?.();
    }
  });
  /** This app's place in another computer's live session changed (the menu offers Join only while it has none). */
  onRemoteState: (() => void) | null = null;
  /** The latest revision the running preview has published (a page loaded from it now shows it), or null before one. */
  private publishedRevision: number | null = null;
  /** Waits for the preview to publish a revision (previewPublished), each looking again when the preview moves on. */
  private publishWaits = new Set<() => void>();
  /**
   * The running preview server's notifications of a revision, numbered: the last one given, and the last one it has
   * published. A revision number alone does not say a change has been published: a file put back can be published at
   * the revision the project already had, and a server that starts during a save serves the revision before its files.
   */
  private noticeTicket = 0;
  private publishedTicket = 0;
  /** The snapshot guests were last given, and what it was made from (guestSnapshot). */
  private shared: (LiveSnapshotSource & { snapshot: LiveProjectSnapshot }) | null = null;
  /**
   * The open project's documents as of its last change that finished, with that change's revision. A save installs
   * its documents before its files have all landed and its revision moves on, so guests are given these instead:
   * never the documents of one revision under the number of the one before (#766).
   */
  private settled: { session: ProjectSession; state: ProjectState; revision: number } | null = null;
  /** Cancels a dependency install into the project when another app takes it over. */
  private prepareAbort: AbortController | null = null;
  private closing: Promise<void> | null = null;
  onSessionOpened: ((s: ProjectSession) => Promise<void>) | null = null;
  onSessionClosing: (() => Promise<void>) | null = null;
  /** The project has gone (a close that can no longer fail): the app ends the helpers it keeps for a project. */
  onSessionClosed: (() => void) | null = null;
  /** Asks the editor to save what is still being typed before the project is unloaded; false keeps it open. */
  beforeLeave: (() => Promise<boolean>) | null = null;
  /** A project opening began or ended (openingKey changed): a close that was allowed ends it as it starts. */
  onOpeningChange: (() => void) | null = null;
  aiBusy = () => false;
  aiRunId = (): string | null => null;
  /** The editor is sent each change against the copy it was sent before (#967), while it is the same page's. */
  private feed = new ProjectFeed();
  private feedTo: WebContents | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  send(channel: string, payload?: unknown) {
    const w = this.getWindow();
    if (!w || w.isDestroyed()) return;
    w.webContents.send(channel, payload);
    // What the editor is sent on every change (src/shared/perf.ts), only while marks are on: marked as sent now, then
    // sized as IPC serializes it, after the send so the editor gets it no later than it would. Sizing never throws.
    if (perf.on && channel === 'project:changed') {
      const at = perfNow();
      const bytes = serializedSize(payload);
      perf.count('ipc.projectChanged.sends');
      if (bytes !== null) perf.count('ipc.projectChanged.bytes', bytes);
      perf.mark('controller.snapshotSent', { revision: (payload as ProjectChange).revision, bytes }, at);
    } else if (perf.on && channel === 'ai:event') {
      // The assistant's events, counted and sized the same way (scripts/perf: the chat scenario).
      const bytes = serializedSize(payload);
      perf.count('ipc.aiEvent.sends');
      if (bytes !== null) perf.count('ipc.aiEvent.bytes', bytes);
      else perf.count('ipc.aiEvent.unsized');
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(): ProjectSnapshot | null {
    const s = this.session;
    if (!s) return null;
    const timing = perf.span('controller.snapshot', { revision: s.revision });
    const snap: ProjectSnapshot = {
      dir: s.dir,
      state: s.state,
      revision: s.revision,
      history: s.historyInfo(),
      versions: s.versionsInfo(),
      // Missing image files are for the author, not the AI: it cannot bring them back, and its checks compare messages.
      diagnostics: [...s.diagnostics(), ...safeMissingDiagnostics(s)],
      runtime: this.runtimeStatus(),
      recoveryNotes: s.recoveryNotes,
      aiBusy: this.aiBusy(),
      aiRunId: this.aiRunId(),
      assetUsage: safeUsages(s),
      missingAssets: s.missingAssets,
      conflicts: s.shownConflicts,
      savedCopies: s.savedCopies,
      readOnly: s.readOnly,
      themeUpdates: s.readOnly ? undefined : s.themeUpdates(),
      localState: this.localState,
      workspaceKey: this.workspaceKey ?? '',
      recentExports: this.recentExports,
      saveFailure: s.saveFailure
    };
    timing();
    return snap;
  }

  broadcast() {
    this.sendSnapshot();
    this.live.editorChanged();
  }

  /**
   * Send the editor the project as it is now, as a change from the copy it was sent before (shared/project-feed.ts):
   * whole to another window than the one last sent to, and after `forgetEditorCopy`.
   */
  private sendSnapshot(): boolean {
    const snap = this.snapshot();
    if (!snap) return false;
    const w = this.getWindow();
    const to = w && !w.isDestroyed() ? w.webContents : null;
    if (this.feedTo !== to) {
      this.feed.reset();
      this.feedTo = to;
    }
    const change = this.feed.next(snap);
    try {
      this.send('project:changed', change);
    } catch (e) {
      // Never sent: the next one is whole, not a change from a copy the editor never had.
      this.feed.reset();
      throw e;
    }
    return true;
  }

  /** The editor's copy of the project is gone (its window closed, the project closed): the next one sent is whole. */
  forgetEditorCopy() {
    this.feed.reset();
  }

  /**
   * The editor holds a copy a change does not fit (it missed one): send it the whole project on project:changed. False
   * when there is none to send (no project is open).
   */
  resyncEditor(): boolean {
    this.feed.reset();
    return this.sendSnapshot();
  }

  /**
   * The project as it is now, whole, for an editor page that has just loaded: the changes sent from here on are made
   * against it. Null when no project is open.
   */
  editorFeed(): ProjectChange | null {
    const snap = this.snapshot();
    const w = this.getWindow();
    this.feed.reset();
    this.feedTo = w && !w.isDestroyed() ? w.webContents : null;
    return snap ? this.feed.next(snap) : null;
  }

  /**
   * The project as a live session's guests are given it, in the opening `opening` (shared/live/snapshot.ts): its
   * documents, with nothing of this computer in them, and whether it can be edited now. The same object while none of
   * that has changed, so guests are sent each change once.
   */
  guestSnapshot(opening: string): LiveProjectSnapshot | null {
    const s = this.session;
    if (!s || !this.workspaceKey || opening !== this.workspaceKey) return null;
    const settled = this.settled?.session === s ? this.settled : { state: s.state, revision: s.revision };
    const source: LiveSnapshotSource = { state: settled.state, revision: settled.revision, readOnly: !!s.readOnly, aiBusy: this.aiBusy(), runtime: this.runtimeStatus().state };
    const last = this.shared;
    if (last && last.state === source.state && last.revision === source.revision && last.readOnly === source.readOnly && last.aiBusy === source.aiBusy && last.runtime === source.runtime) return last.snapshot;
    const snapshot = liveSnapshot(source, [s.dir, homedir()]);
    this.shared = { ...source, snapshot };
    return snapshot;
  }

  /**
   * Make a live-session collaborator's edit (#765), already checked against what collaborators may do
   * (shared/live/capabilities.ts), in the opening `opening`: through the same pipeline as the editor's own edits, in
   * turn with them, as a History step of its own that names the guest. Never code, whatever Settings allow. Refused, as
   * local edits are, while the AI is making changes or the project is read-only; and refused whole if, by the time it
   * would be saved, the guest's access has changed or it would change where a contact form sends its messages.
   */
  async applyGuest(opening: string, guest: LiveGuestEdit, batch: LiveEditBatch): Promise<LiveApplyResult> {
    const session = this.session;
    const refuse = (code: RpcError['code'], message: string, recoverable: boolean): LiveApplyResult => ({ ok: false, error: { code, message, recoverable } });
    const gone = () => this.session !== session || this.workspaceKey !== opening || !!this.closing;
    if (!session || gone()) return refuse('UNAVAILABLE', 'The host’s project is not open.', true);
    if (session.readOnly) return refuse('READ_ONLY', 'The host’s project is open read-only, so it can’t be changed now.', false);
    if (this.aiBusy()) return refuse('BUSY', 'The host’s AI is making changes. Try again once it has finished.', true);
    // Whatever a guest is told, in the engine's words or the host's, names nothing of this computer.
    const shared = (error: RpcError): LiveApplyResult => ({ ok: false, error: { ...error, message: scrubHostPaths(error.message, [session.dir, homedir()]).slice(0, MAX_MESSAGE_LENGTH) } });
    let refusal: RpcError | null = null;
    // The project as the batch would leave it is the same however often the guard asks: checked once.
    let checked: { next: ProjectState; problem: string | null } | null = null;
    const guard = (next: ProjectState | null) => {
      refusal =
        guest.check() ??
        (gone() ? { code: 'UNAVAILABLE', message: 'The host’s project is not open.', recoverable: true } : null) ??
        (this.aiBusy() ? { code: 'BUSY', message: 'The host’s AI is making changes. Try again once it has finished.', recoverable: true } : null);
      if (!refusal && next) {
        if (checked?.next !== next) checked = { next, problem: guestEditProblem(session.state, next) };
        if (checked.problem) refusal = { code: 'PERMISSION_DENIED', message: checked.problem, recoverable: false };
      }
      return refusal ? { code: 'CANCELLED' as const, message: refusal.message, recoverable: refusal.recoverable } : null;
    };
    const label = `${normalizeDisplayName(batch.label, LIVE_BATCH_LABEL_MAX) ?? 'Edit'} (${guest.displayName})`;
    const r = await session.apply(
      { operations: batch.operations, ...(batch.expectedRevision !== undefined ? { expectedRevision: batch.expectedRevision } : {}) },
      { label, source: 'user', guestName: guest.displayName, codeAllowed: false, guard }
    );
    if (refusal) return shared(refusal);
    if (r.ok) return { ok: true, revision: r.revision, results: (r.results ?? []).map(sharedIds) };
    if (session.readOnly) return refuse('READ_ONLY', 'The host’s project is open read-only, so it can’t be changed now.', false);
    const error = r.error ?? { code: 'INTERNAL', message: 'The host could not make that edit.', recoverable: false };
    const code = (RPC_ERROR_CODES as readonly string[]).includes(error.code) ? (error.code as RpcError['code']) : 'INTERNAL';
    // The engine's words, never its details.
    return shared({ code, message: error.message, recoverable: error.recoverable });
  }

  /** What the preview is doing; a project only a newer version can generate never has one. */
  private runtimeStatus(): RuntimeState {
    const s = this.session;
    if (s && previewUnavailable(s)) return { state: 'unavailable', message: s.readOnly?.preview ?? PREVIEW_UNAVAILABLE };
    return (this.dev?.status ?? this.pendingStatus ?? { state: 'idle' }) as RuntimeState;
  }

  /** Report the preview's state while no preview process speaks for it. */
  private status(s: RuntimeState) {
    this.pendingStatus = s;
    this.send('runtime:status', s);
    this.live.editorChanged();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private progress(p: ProgressEvent) {
    this.send('create:progress', p);
  }

  async create(opts: CreateProjectOptions): Promise<{ ok: boolean; message?: string }> {
    // Cancel is offered from the moment Create is pressed, so it works from then on, up to the switch. A later creation
    // (the window was closed and opened again meanwhile) has its own, which this one never clears.
    const abort = new AbortController();
    this.createAbort = abort;
    const run = timed('controller.create', () => this.createProject(opts, abort), (r) => ({ ok: r?.ok ?? false }))();
    this.creations.set(run, abort);
    try {
      return await run;
    } finally {
      this.creations.delete(run);
      if (this.createAbort === abort) this.createAbort = null;
    }
  }

  get isCreating(): boolean {
    return this.creations.size > 0;
  }

  /** Call off every new project being made and wait until each has gone (quitting): nothing half made is left. */
  async stopCreating(): Promise<void> {
    for (const abort of this.creations.values()) abort.abort();
    await Promise.all([...this.creations.keys()].map((run) => run.catch(() => undefined)));
  }

  private async createProject(opts: CreateProjectOptions, abort: AbortController): Promise<{ ok: boolean; message?: string }> {
    const signal = abort.signal;
    const progress = (p: ProgressEvent) => this.progress({ ...p, attempt: opts.attempt });
    const name = opts.name.trim();
    if (!name) return { ok: false, message: 'Enter a project name.' };
    // A theme chosen in the dialog must be one this app offers, with every section the starter places, before anything is
    // written: the project would otherwise open on another theme, or stop half made.
    if (opts.themeId !== undefined && findTheme(opts.themeId)?.devOnly) return { ok: false, message: `The theme "${opts.themeId}" is a development fixture, which cannot start a project. Choose another theme.` };
    const themeProblem = starterProblem(opts.starter, opts.themeId);
    if (themeProblem) return { ok: false, message: themeProblem };
    const { folder, fallback } = projectFolder(name);
    let dir = join(opts.parentDir, folder);
    // Told the same way whenever the folder turns out to be taken. A name with nothing a folder can keep ("🌸🌸") always
    // leads to the same folder, so then the name is what to change, and the message says how.
    const taken = () =>
      new FolderTakenError(
        fallback
          ? `“${name}” has no letters or numbers to name its folder, so it would go in ${dir}, which already exists and is not empty. Add a letter or number to the name, or choose another folder.`
          : `${dir} already exists and is not empty. Choose another name or folder.`
      );
    if (await occupied(dir)) return { ok: false, message: taken().message };
    // Asked before the new project is made, so keeping editing costs no setup, and again at the switch, for anything
    // typed meanwhile (on macOS a window reopened during setup shows the open project without this dialog).
    if (!(await this.mayLeave())) return { ok: false };
    // Cancelled before anything happened: the open project stays open.
    if (signal.aborted) return { ok: false, message: 'Canceled.' };
    // Set only once this attempt has created the folder itself: only then may it remove the folder on failure.
    let createdDir = false;
    // The top-level entries this attempt created, each named just before it is written and only if nothing else had put
    // it there: only these are its own to remove if it stops. Nothing is written before the attempt has claimed the
    // empty folder.
    const wrote = new Set<string>();
    const own = (...names: string[]) => {
      for (const n of names) if (!wrote.has(n) && !existsSync(join(dir, n))) wrote.add(n);
    };
    // The new project is built beside the one open now, which closes only once the new one is ready to show: a
    // creation that is cancelled or fails leaves the author in the project they were working on.
    let session: ProjectSession | null = null;
    // Set once this attempt starts writing the project's own documents, and once it holds the new project's lock.
    let sessionStarted = false;
    let locked = false;
    const since = this.closings;
    // Why the switch did not happen, when the new project was ready but the open one stayed (Keep editing, quitting).
    let refused: { message?: string } | null = null;
    // Set when another app took the new project over while it was set up.
    let takenOver = false;
    // Set once the open project closed for this one, and once this one was handed to the editor.
    let committed = false;
    let attached = false;
    try {
      if (signal.aborted) throw new Error('Canceled');
      progress({ step: 'files', message: 'Preparing project files…' });
      const filing = perf.span('create.files');
      await fs.mkdir(dirname(dir), { recursive: true });
      try {
        await fs.mkdir(dir);
        createdDir = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another app may have made it meanwhile: never write into a folder that is no longer empty.
        if (await occupied(dir)) throw taken();
      }
      // Claim the folder before writing to it. Only one creation, in this app or another, can make its local folder,
      // so two creating into the same empty folder never write over, or clean up, each other's files.
      try {
        await fs.mkdir(join(dir, LOCAL_DIR));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw taken();
        throw e;
      }
      wrote.add(LOCAL_DIR);
      // Anything that arrived before the claim makes the folder no longer empty after all: give the claim up and leave
      // the rest untouched.
      if ((await fs.readdir(dir)).some((n) => n !== LOCAL_DIR)) throw taken();
      // One name for the folder from here on: the build tools resolve links and must agree with the session.
      dir = canonicalDir(dir);
      own(...(await fs.readdir(templateFiles())));
      await fs.cp(templateFiles(), dir, { recursive: true });
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      pkg.name = slugify(name) || 'website';
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
      const lockPath = join(dir, 'package-lock.json');
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.name = pkg.name;
      if (lock.packages?.['']) lock.packages[''].name = pkg.name;
      await fs.writeFile(lockPath, JSON.stringify(lock, null, '\t') + '\n');
      own('README.md');
      await fs.writeFile(join(dir, 'README.md'), projectReadme(name));
      filing();
      const notice = starterNotice();
      const assetsDir = join(resourcesDir(), 'resources', 'starter-assets');
      const withImages = opts.starter === 'business' && opts.sampleImages && existsSync(assetsDir);
      const state = createStarterState(opts.starter, name, withImages, opts.themeId);
      // Its website's icons are drawn while the rest of it is made.
      const draft = ProjectSession.starting(dir, state);
      if (withImages) {
        const importing = perf.span('create.images');
        own('static');
        for (const { asset: a, record } of await importSamples(dir, assetsDir, sampleCache())) {
          record.id = a.id;
          record.name = a.name;
          // A bundled sample is no file of the author's.
          delete record.originalName;
          record.altSuggestion = a.alt;
          record.description = 'Sample image bundled with the Business starter. Replace it with your own.';
          state.assets.assets[a.id] = record;
        }
        if (existsSync(notice)) {
          own('NOTICE.md');
          await fs.copyFile(notice, join(dir, 'NOTICE.md'));
        }
        importing({ images: Object.keys(state.assets.assets).length });
      }
      if (signal.aborted) throw new Error('Canceled');
      own(...SESSION_ENTRIES);
      sessionStarted = true;
      session = await draft.writeNew();
      const locking = perf.span('create.lock');
      const lockErr = await session.acquireLock(INSTANCE_ID);
      locking();
      if (lockErr) {
        // Another app opened the new project first: it is that app's now, so nothing here may remove it.
        wrote.clear();
        createdDir = false;
        throw lockErr;
      }
      locked = true;
      const staged = session;
      // Taken over by another app while it is set up: the install into its folder stops at once.
      const stop = () => {
        takenOver = true;
        abort.abort();
      };
      staged.on('lock-lost', stop);
      await timed('create.trust', async () => trust(dir, await configHash(dir)))();
      progress({ step: 'dependencies', message: 'Setting up website tools…', detail: 'Installing the tools that build and preview your site.' });
      own('node_modules');
      let toolsMissing: RuntimeState | null = null;
      try {
        await timed('create.dependencies', () => prepareDependencies(dir, (line) => progress({ step: 'dependencies', message: 'Setting up website tools…', detail: line.slice(0, 160) }), signal, () => staged.stillOwner()))();
      } catch (e) {
        // The tools needed a download and the registry could not be reached (offline, say). The project itself is
        // complete and this app's, so it opens for editing, its preview saying what is missing, with Try again. A
        // cancel, a takeover or any other failure removes it as before.
        if (!(e instanceof ToolsDownloadError) || signal.aborted || takenOver || !(await staged.stillOwner()) || signal.aborted) throw e;
        toolsMissing = { state: 'error', message: friendlyError(e.message), detail: e.message };
      }
      if (signal.aborted) throw new Error('Canceled');
      // From the moment the open project starts closing, the new one is replacing it: there is nothing left to cancel.
      const way = await timed('create.makeWay', () =>
        this.makeWay(since, signal, () =>
          progress(toolsMissing ? { step: 'preview', message: 'Opening the project…', detail: 'The website tools could not be downloaded, so the preview waits until you are back online.' } : { step: 'preview', message: 'Starting preview…' })
        )
      )();
      if (!way.ok) {
        refused = way;
        throw new Error(way.message ?? 'The open project was kept.');
      }
      // Before the switch and its ownership check, so a New project opened at once already proposes this folder and the
      // write cannot outlast the lock check.
      await Promise.resolve().then(() => rememberProjectParent(opts.parentDir)).catch(() => undefined);
      committed = true;
      staged.off('lock-lost', stop);
      // Opened without its preview, nothing reads its lock again before the editor has it: read it now, since another
      // app may have taken it while the open project was closing, before the heartbeat noticed.
      if (toolsMissing && !takenOver && !(await staged.stillOwner())) takenOver = true;
      // Its lock lost while the open project was closing for it: it is not shown, but rolled back. A Cancel or a quit
      // arriving now is too late to undo the switch, which finishes.
      if (takenOver) throw new Error('Canceled');
      // The preview writes its own output into the folder.
      if (!toolsMissing) own('.svelte-kit');
      attached = true;
      // A new Business site opens with its Get started list, measured against the site as the starter made it. Once the
      // author has hidden the list it starts hidden, and Show Get started (the command menu) brings it back.
      const seed = opts.starter === 'business';
      const hidden = seed && !!(await loadSettings().catch(() => null))?.getStartedHidden;
      const colorIds = (findTheme(staged.state.site.themeId)?.tokens ?? []).filter((t) => t.group === 'color').map((t) => t.id);
      const firstSteps = seed ? { firstSteps: { start: firstStepsStart(staged.state, colorIds), ...(hidden ? { hidden: true } : {}) } } : {};
      await this.attach(staged, firstSteps, toolsMissing);
      if (seed) {
        this.localDirty = true;
        void this.flushLocalState();
      }
      // The project is open and working: a recent-projects list that cannot be saved must not undo it.
      // Under the name it has by now: the editor shows it from the moment it is attached, and may have renamed it.
      await addRecent(dir, projectDisplayName(staged.state), staged.state.manifest.projectId).catch(() => undefined);
      progress({ step: 'done', message: 'Ready' });
      return { ok: true };
    } catch (e) {
      // Keeping editing (or quitting) at the switch is no failure to explain: the dialog just makes way.
      // A handover that never reached the editor ends here, so later switches are not held up by it.
      if (committed && !attached) this.handingOver = false;
      let msg = refused ? (refused.message ?? '') : takenOver ? 'The new project’s lock was taken or removed while it was being set up, so it was not opened.' : e instanceof FolderTakenError ? e.message : friendlyError((e as Error).message);
      const note = (more: string) => (msg = msg ? `${msg} ${more}` : more);
      // Once the project's own documents are being written it may be another app's: it opened the project before this
      // attempt had the lock (a lock file this attempt never made), or took it over since (Unlock in another window).
      // Then nothing here may remove it. Otherwise the manifest goes first, so no other app can open what is left as a
      // project: under the lock when this attempt holds it, so no takeover can land between the check and the removal.
      const manifestPath = join(dir, MANIFEST_FILE);
      const dropped: { manifest: Buffer | null } = { manifest: null };
      const dropManifest = async () => {
        if (!wrote.has(MANIFEST_FILE)) return;
        dropped.manifest = await fs.readFile(manifestPath).catch(() => null);
        await fs.rm(manifestPath, { force: true });
      };
      let ours = true;
      if (sessionStarted && locked) ours = await session!.whileOwner(dropManifest).catch(() => false);
      else if (sessionStarted && (ours = !existsSync(join(dir, LOCAL_DIR, 'lock.json')))) await dropManifest().catch(() => undefined);
      // The new project closes, if it was shown; one still open from before stays open, and a new one that was never
      // shown is closed with its files below. A project that could not be closed is still open in the editor: it gets
      // its manifest back, and none of it goes.
      const closed =
        !session || this.session !== session
          ? true
          : await this.close().then(
              () => true,
              () => false
            );
      const kept = dropped.manifest;
      if (!closed && kept) await session!.whileOwner(() => atomicWrite(manifestPath, kept)).catch(() => false);
      if (!ours || !closed) {
        if (wrote.size) note(`The new project’s files were left in ${dir}.`);
        wrote.clear();
        createdDir = false;
      }
      if (!(await removeCreatedProject(dir, closed ? session : null, wrote, createdDir))) note(`Some of the new project’s files could not be removed from ${dir}.`);
      progress({ step: 'error', message: msg === 'Canceled' ? 'Project creation was canceled.' : 'The project could not be created.', detail: msg });
      return msg ? { ok: false, message: msg } : { ok: false };
    }
  }

  cancelCreate() {
    this.createAbort?.abort();
  }

  /** Whether creating a project downloads website tools, decided by the same check setup makes. */
  websiteTools(): Promise<WebsiteTools> {
    return timed('controller.websiteTools', () => starterTools(templateFiles()), (t) => ({ tools: t ?? null }))();
  }

  /**
   * Open a project folder, or a project ZIP file (#263). With no path, the author chooses one (`folder`: a folder).
   * `replaces` is the missing recent entry the author is finding this project for (#217): see addRecent.
   */
  open(dirArg?: string, opts: { folder?: boolean; replaces?: string } = {}): Promise<OpenResult> {
    return timed('controller.open', () => this.openNow(dirArg, opts), (r) => ({ ok: r?.ok ?? false }))();
  }

  private async openNow(dirArg: string | undefined, opts: { folder?: boolean; replaces?: string }): Promise<OpenResult> {
    // Called off from the start, so a window that goes while its picker is up never gets a ZIP file unpacked for it.
    const abort = new AbortController();
    this.openAborts.add(abort);
    // Every exit is a structured result: a thrown error would reject the IPC call and leave the Welcome screen busy.
    try {
      return await this.openChosen(dirArg, opts.folder === true, abort, opts.replaces);
    } catch (e) {
      return { ok: false, message: openFailure(e, dirArg) ?? `Could not open the project: ${(e as Error).message}` };
    } finally {
      this.openAborts.delete(abort);
    }
  }

  private async openChosen(dirArg: string | undefined, folder: boolean, abort: AbortController, replaces?: string): Promise<OpenResult> {
    let dir = dirArg;
    if (!dir) {
      const win = this.getWindow();
      const finding = replaces === undefined ? undefined : (await loadSettings()).recents.find((r) => r.dir === replaces)?.name;
      const r = await dialog.showOpenDialog(win!, replaces === undefined ? openProjectDialog(folder) : findFolderDialog(finding));
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
      if (basename(dir) === MANIFEST_FILE) dir = join(dir, '..');
    }
    if (await isZipFile(dir)) {
      if (replaces !== undefined) return { ok: false, message: 'Choose the folder the project is in now. A ZIP file would make a new copy of it.' };
      return this.openZip(dir, abort);
    }
    if (!existsSync(join(dir, MANIFEST_FILE))) return { ok: false, message: dirArg === undefined ? 'That folder is not a SiteOrigin Builder project. Choose a folder that contains siteorigin.project.json.' : projectNotFound(dir) };
    // A project reached through a link (macOS: /var is /private/var) is opened by its real path. Trust is never
    // carried over from the linked name: that link could since have been pointed at a different folder.
    dir = canonicalDir(dir);
    if (!(await isTrusted(dir, await configHash(dir)))) {
      // The trust prompt names the project, so a manifest that cannot be read (a truncated copy, say) stops here.
      const manifest = await readManifestSummary(dir);
      if (!manifest.ok) return { ok: false, message: manifest.message };
      return { ok: false, needsTrust: { dir, name: manifest.name, reason: (await wasTrusted(dir)) ? 'changed' : 'new' } };
    }
    return this.openTrusted(dir, { replaces });
  }

  /**
   * Open a project ZIP file (#263). A website export, or any other ZIP file, is explained instead. For an editable
   * project the author chooses where the working copy goes; it is unpacked into a new folder there (never into one that
   * exists) and then asks for trust like any project from another computer. The ZIP file is only read, and calling
   * off the folder picker or the unpacking leaves nothing behind. One is opened at a time: another waits until it is
   * done, so the unpacking dialog only ever describes one.
   */
  private openZip(file: string, abort: AbortController): Promise<OpenResult> {
    const run = this.zipOpens.then(() => this.openZipNow(file, abort));
    this.zipOpens = run.catch(() => undefined);
    return run;
  }

  private async openZipNow(file: string, abort: AbortController): Promise<OpenResult> {
    if (abort.signal.aborted) return { ok: false };
    let project: Awaited<ReturnType<typeof readProjectZip>>;
    try {
      project = await readProjectZip(file);
    } catch (e) {
      if (e instanceof ZipError) return { ok: false, message: e.message };
      if (actionable(e) === 'denied') return { ok: false, message: `SiteOrigin Builder does not have permission to read ${basename(file)}. Copy it into your Documents folder, then open the copy.` };
      return { ok: false, message: `Could not read the ZIP file: ${(e as Error).message}` };
    }
    // Its window went while the ZIP file was read: no picker is shown over whatever replaced it.
    if (abort.signal.aborted) return { ok: false };
    if (project.kind === 'website') return { ok: false, message: WEBSITE_ZIP };
    if (project.kind !== 'project') return { ok: false, message: NOT_A_PROJECT_ZIP };
    const name = project.name || basename(file).replace(/\.zip$/i, '');
    const r = await dialog.showOpenDialog(this.getWindow()!, {
      title: `Choose where to save ${name}`,
      message: `A new folder for ${name} is made in the folder you choose. The ZIP file is not changed.`,
      defaultPath: existsSync(defaultProjectsFolder()) ? defaultProjectsFolder() : app.getPath('documents'),
      buttonLabel: 'Save here',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0] || this.quitting || abort.signal.aborted) return { ok: false };
    // Resolved first: a link or shortcut chosen as the folder must not lead into the open project (whose preview runs).
    const parent = canonicalDir(r.filePaths[0]);
    if (this.session && isInside(this.session.dir, parent)) return { ok: false, message: 'Choose a location outside the open project’s folder.' };
    // A trust given to an earlier folder of the same name (since deleted) never carries over to this one.
    const slug = slugify(name) || 'website';
    // The dialog names the folder it will be in, a number added already when a folder by its name is there.
    const folder = expectedFolder(parent, slug);
    // The dialog counts the files as they are written, a few times a second at most.
    let sent = 0;
    const progress = (done: number, total: number) => {
      const now = Date.now();
      if (done !== 0 && done !== total && now - sent < 150) return;
      sent = now;
      this.send('projects:unpacking', { name, dir: parent, folder, done, total } satisfies Unpacking);
    };
    const run = unpackProject(file, project, parent, slug, { signal: abort.signal, beforePublish: (dir) => untrust(canonicalDir(dir)), onProgress: progress });
    // Quitting calls it off and waits for it, as for a new project being made.
    this.creations.set(run, abort);
    this.unpacking = abort;
    progress(0, filesToWrite(project.entries, project.root));
    let dir: string;
    try {
      dir = await run;
    } catch (e) {
      // A damaged file, or files a cancelled unpacking could not remove, are explained; a cancel alone is not.
      if (e instanceof ZipError) return { ok: false, message: e.message };
      if (abort.signal.aborted) return { ok: false };
      const cause = actionable(e);
      if (cause === 'full') return { ok: false, message: `There is not enough space to unpack ${name} in ${parent}. Free up some space, or open the ZIP file again and choose a folder on another drive.` };
      if (cause === 'denied') return { ok: false, message: `SiteOrigin Builder does not have permission to write to ${parent}. Open the ZIP file again and choose another folder, such as your Documents folder.` };
      return { ok: false, message: `Could not unpack ${name} into ${parent}: ${(e as Error).message}` };
    } finally {
      this.creations.delete(run);
      if (this.unpacking === abort) this.unpacking = null;
      this.send('projects:unpacking', null);
    }
    return { ok: false, needsTrust: { dir: canonicalDir(dir), name, reason: 'unpacked' } };
  }

  /** The unpacking dialog's Cancel: call off the ZIP file being unpacked (any other open waiting goes on). */
  cancelUnpacking() {
    this.unpacking?.abort();
  }

  /** Its window went: call off every project ZIP file being opened. Before a copy is in place, what it wrote is removed. */
  cancelOpen() {
    for (const abort of this.openAborts) abort.abort();
  }

  async trustAndOpen(opened: string, opts: { replaces?: string } = {}): Promise<{ ok: boolean; message?: string }> {
    try {
      const dir = canonicalDir(opened);
      await trust(dir, await configHash(dir));
      return await this.openTrusted(dir, { replaces: opts.replaces });
    } catch (e) {
      return { ok: false, message: openFailure(e, opened) ?? `Could not open the project: ${(e as Error).message}` };
    }
  }

  private async openTrusted(dir: string, opts: { force?: boolean | string; replaces?: string } = {}): Promise<{ ok: boolean; message?: string }> {
    // Opening the folder that is open now (an unlock, say) reopens it: this app holds a folder's lock only once, so it
    // is left (what is being typed in it saved first) and closed before it opens again.
    if (this.session?.dir === dir) {
      // Its manifest is read first, so a damaged one is explained with the project still open.
      const manifest = await readManifestSummary(dir);
      if (!manifest.ok) return { ok: false, message: manifest.message };
      if (!(await this.mayLeave())) return { ok: false };
      await this.close();
    }
    // Any other project opens beside the one open now, which stays open, locked and previewing until the replacement
    // has opened: one that cannot be read leaves the author where they were.
    const since = this.closings;
    // Opened from Welcome, the editor is given the project as soon as its documents are read and sound (attach, `shown`),
    // and its publication waits for that: generating and checking the website's files holds the main process for a
    // while. A project replacing another one (or another computer's shown as a guest) opens whole first, as before: its
    // handover (what is being typed saved, Keep editing, the close) comes after, and the new preview's start before it.
    let shown: () => void = () => {};
    const gate = new Promise<void>((r) => (shown = r));
    let ready!: (s: ProjectSession) => void;
    const readied = new Promise<{ session: ProjectSession; shownEarly: boolean }>((r) => (ready = (session) => r({ session, shownEarly: true })));
    const early = !this.session && !this.remote.active;
    const opening = ProjectSession.open(dir, INSTANCE_ID, { force: opts.force, preview: { start: (s) => this.prepareRuntime(s), stop: (s) => this.dropEarly(s) }, sweepLater: true, ...(early ? { shown: (s: ProjectSession) => (ready(s), gate) } : {}) });
    let session: ProjectSession;
    try {
      const first = await Promise.race([readied, opening.then((s) => ({ session: s, shownEarly: false }))]);
      session = first.session;
      // Shown before its publication: the preview waits for it (startRuntimeWork), the editor is told what it found.
      if (first.shownEarly) {
        this.publications.set(session, opening.then(() => undefined, () => undefined));
        void this.afterPublication(session, opening).catch(() => undefined);
      }
    } catch (e) {
      // A newer format, or a project another app is editing, opens for inspection instead (spec 16.6, 18.1).
      const locked = e instanceof ProjectLockedError;
      if (locked || (e instanceof ProjectFormatError && e.readOnly)) {
        try {
          session = await ProjectSession.openReadOnly(dir, {
            reason: locked
              ? `${e.message} It is open read-only here. If that app is no longer running, unlock the project to edit it.`
              : `${e.message} It is open read-only.`,
            canUnlock: locked,
            lockToken: locked ? e.owner.token : undefined,
            ...(e instanceof ThemeUnavailableError ? { preview: `${e.message} The preview needs it too.` } : {})
          });
        } catch {
          return { ok: false, message: inFolder(e.message, dir) };
        }
      } else if (e instanceof ProjectFormatError) return { ok: false, message: inFolder(e.message, dir) };
      else return { ok: false, message: openFailure(e, dir) ?? inFolder(`Could not open the project: ${(e as Error).message}`, dir) };
    }
    // Until attach takes it over, anything that ends this opening lets its publication go on (it waits under the lock).
    let handed = false;
    try {
      // Workspace layout and recents are conveniences: a broken file or a failed save never blocks opening.
      let workspace: LocalWorkspaceState = {};
      try {
        workspace = JSON.parse((await readIfExists(session.local('workspace.json'))) ?? '{}');
      } catch {
        workspace = {};
      }
      const way = await this.makeWay(since).catch((e: Error) => ({ ok: false, message: `The open project could not be closed: ${e.message}` }));
      if (!way.ok) {
        shown();
        await this.dropEarly(session);
        await session.close().catch(() => undefined);
        return way;
      }
      handed = true;
      this.attachOpened(session, workspace, shown);
    } finally {
      if (!handed) shown();
    }
    // Only an opening that is listed takes over a missing entry: one open read-only leaves the list as it was.
    if (!session.readOnly) await addRecent(dir, projectDisplayName(session.state), session.state.manifest.projectId, opts.replaces).catch(() => undefined);
    return { ok: true };
  }

  /** Attach a session opened by openTrusted, closing it again, and saying so, should that fail. */
  private attachOpened(session: ProjectSession, workspace: LocalWorkspaceState, shown: () => void) {
    // Attached in the same turn as the switch (attach makes it the open project before it waits on anything), so no
    // other switch can come between the two.
    void this.attach(session, workspace, null, shown).catch(async (e) => {
      await this.dropEarly(session);
      if (this.session === session) await this.close();
      else await session.close();
      this.send('runtime:status', { state: 'error', message: `The project could not be opened: ${(e as Error).message}` });
    });
  }

  /** Take over a project another app holds (the user confirmed it is not running) and reopen it for editing. */
  async unlock(): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s?.readOnly?.canUnlock) return { ok: false, message: 'This project is not locked.' };
    // Reopening closes this read-only session: a page being added in it is settled (or kept) first (see openTrusted).
    // Only the owner the user was shown is displaced: if another app took the project since, it is shown instead.
    return this.openTrusted(s.dir, { force: s.readOnly.lockToken ?? NO_LOCK });
  }

  /** Both versions of a file in conflict, for the author to compare before choosing. */
  async compareConflict(path: string): Promise<{ ok: boolean; builder?: FileText; disk?: FileText; attempted?: FileText; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    return s.compareConflict(path);
  }

  /** What a saved copy of a conflict version holds. */
  async readSavedCopy(id: string): Promise<{ ok: boolean; content?: FileText; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    return s.readSavedCopy(id);
  }

  /** Take a saved copy off the list; its file stays in the recovery folder. */
  async dismissSavedCopy(id: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    const r = await s.dismissSavedCopy(id);
    if (r.ok && this.session === s) this.broadcast();
    return r;
  }

  /** Put a saved copy taken off the list back on it (Undo). */
  async restoreSavedCopy(id: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    const r = await s.restoreSavedCopy(id);
    if (r.ok && this.session === s) this.broadcast();
    return r;
  }

  /** Read the project documents from disk now, as the file watcher does (an edit was refused because its file changed). */
  async reloadFromDisk(): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    // As the watcher does: the AI's changes are on their way, and its request reads the files when it ends.
    if (this.aiBusy()) return { ok: false, message: 'Busy' };
    return s.reloadFromDisk();
  }

  /**
   * Settle a file conflict: keep the version changed outside the app, restore SiteOrigin Builder's version, or (a
   * design's own file) convert the edited file into a code component, which needs Developer mode as all code does.
   */
  async resolveConflict(path: string, choice: ConflictChoice, opts?: { expect?: unknown; opening?: unknown }): Promise<{ ok: boolean; message?: string; definitionId?: string; saved?: SavedCopy['side'][] }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    // Which versions settling it kept under Saved copies, so the dialog says only what is there.
    const listed = new Set(s.savedCopies.map((c) => c.id));
    const r = await this.resolveConflictIn(s, path, choice, opts);
    return r.ok ? { ...r, saved: s.savedCopies.filter((c) => !listed.has(c.id) && c.path === path).map((c) => c.side) } : r;
  }

  private async resolveConflictIn(s: ProjectSession, path: string, choice: ConflictChoice, opts?: { expect?: unknown; opening?: unknown }): Promise<{ ok: boolean; message?: string; definitionId?: string }> {
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish first.' };
    // Only an exact choice is acted on: a missing or mistyped one must never overwrite a file.
    if (typeof path !== 'string' || (choice !== 'keep' && choice !== 'restore' && choice !== 'convert')) return { ok: false, message: 'Choose which version to keep.' };
    if (choice !== 'convert') return s.resolveConflict(path, choice);
    const expect = opts?.expect;
    if (expect !== undefined && (typeof expect !== 'string' || !/^[0-9a-f]{64}$/.test(expect))) return { ok: false, message: 'Choose which version to keep.' };
    // Made in the opening of the project it was asked in, never another one opened at the same folder since.
    const closed = { ok: false, message: 'The project was closed before this could be settled.' };
    if (opts?.opening !== undefined && opts.opening !== this.workspaceKey) return closed;
    const codeAllowed = (await loadSettings()).settings.developerMode === true;
    if (this.session !== s || this.closing || (opts?.opening !== undefined && opts.opening !== this.workspaceKey)) return closed;
    return s.resolveConflict(path, 'convert', { expect, codeAllowed });
  }

  /**
   * Make `session` the open project, with its own workspace state installed in the same step. With `runtimeError` the
   * preview is not started: the project opens showing that error, and Try again starts it.
   */
  private async attach(session: ProjectSession, workspace: LocalWorkspaceState, runtimeError: RuntimeState | null = null, shown?: () => void) {
    const attaching = perf.span('controller.attach');
    try {
      await this.attachShown(session, workspace, runtimeError);
    } finally {
      // The opening's publication goes on once the editor has the project, or once attaching has failed.
      shown?.();
    }
    attaching({ revision: session.revision });
    if (runtimeError) this.send('runtime:status', runtimeError);
    else await this.startRuntime();
  }

  /** attach, up to the editor's first snapshot of the project. */
  private async attachShown(session: ProjectSession, workspace: LocalWorkspaceState, runtimeError: RuntimeState | null) {
    // The handover that closed the open project for this one ends here, as this one becomes the open project.
    this.handingOver = false;
    // A new opening lists only its own exports, even if an earlier one was never closed.
    this.endExports();
    this.session = session;
    // In place before the first snapshot, so the editor opens with it.
    if (runtimeError) this.pendingStatus = runtimeError;
    this.localState = workspace;
    this.localDirty = false;
    // A live session belongs to the opening it was started in, never the next one (closing has already ended it).
    if (this.live.running) void this.live.end();
    // A project of this computer's is open now: the editor shows it, not another computer's (#766).
    this.remote.leave();
    this.workspaceKey = `${session.dir}#${++this.openings}`;
    // Another opening: the editor is sent it whole, never as a change from the project before.
    this.forgetEditorCopy();
    this.onOpeningChange?.();
    // Another app took the project over and edits its folder now: stop the preview running there at once (and any
    // install into it), then start it again from a private copy.
    session.on('lock-lost', () => {
      if (this.session !== session) return;
      this.prepareAbort?.abort();
      // A private copy's preview goes on only where there is still a project to copy.
      if (!this.stage || previewUnavailable(session)) void this.dev?.stop();
      void this.startRuntime().catch(() => undefined);
    });
    // A save's files reach the preview as one update (#735). A preview of a private copy holds while the copy is
    // brought up to date instead (syncStage). Until the server started while the project opened is taken over or
    // stopped, what lands counts against it, as the opening's own publication does (usableEarly).
    const opened = this.early?.session === session ? session.previewHold : null;
    session.previewHold = async () => {
      if (opened && this.early?.session === session) return opened();
      const dev = this.session === session && !this.stage ? this.dev : null;
      return dev ? dev.hold() : () => {};
    };
    // The Recent projects entry follows a rename as soon as it is made, and an undo of one, or one made outside. A
    // working copy keeps its own name through them (#176).
    let listedName = projectDisplayName(session.state);
    this.settled = { session, state: session.state, revision: session.revision };
    session.on('changed', (ev) => {
      this.settled = { session, state: session.state, revision: session.revision };
      if (!session.readOnly && projectDisplayName(session.state) !== listedName) {
        listedName = projectDisplayName(session.state);
        void renameRecent(session.dir, listedName).catch(() => undefined);
      }
      this.filesChangedAt = Date.now();
      if (this.stage) this.syncStage(session);
      else this.notifyPreview(ev.revision);
      this.broadcast();
      // An import, a relink, an undo or an outside edit of the library may name files that are, or are not, there.
      if (ev.changedDocs.includes('siteorigin/assets.json')) void this.checkAssetFiles(session);
    });
    session.on('history', () => this.broadcast());
    // A save that failed shows in the editor's save indicator at once, though the project's revision did not move.
    session.on('save-failed', () => {
      if (this.session === session) this.broadcast();
    });
    await this.onSessionOpened?.(session);
    // Watching starts before the first look, so a file removed while it runs is seen too.
    this.watchExternalChanges(session);
    // Icons a save stopped waiting for before this app held the project's lock (a new project's) are published now.
    void session.refreshSiteIcons().catch(() => null);
    this.broadcast();
    // Project health lists missing image files a moment after the project shows: the look at every original and copy
    // in the library is not waited for.
    void this.firstAssetCheck(session);
  }

  /** The opening's look for missing image files, shown once it finds any. */
  private async firstAssetCheck(session: ProjectSession): Promise<void> {
    const assetCheck = perf.span('controller.assetCheck');
    const changed = await session.refreshAssetFiles().catch(() => false);
    assetCheck();
    if (changed && this.session === session) this.broadcast();
  }

  /** The publications of openings shown before them (openTrusted), each settled once it is done, never rejected. */
  private publications = new WeakMap<ProjectSession, Promise<void>>();

  /**
   * Once the publication of an opening shown before it is done: what it found in the generated files (conflicts) shown,
   * or, should the opening itself fail after all, the project closed.
   */
  private async afterPublication(session: ProjectSession, opening: Promise<ProjectSession>): Promise<void> {
    const before = JSON.stringify(session.shownConflicts);
    try {
      await opening;
    } catch (e) {
      await this.dropEarly(session);
      if (this.session === session) await this.close().catch(() => undefined);
      else await session.close().catch(() => undefined);
      this.send('runtime:status', { state: 'error', message: `The project could not be opened: ${(e as Error).message}` });
      return;
    }
    if (this.session !== session || this.closing) return;
    if (JSON.stringify(session.shownConflicts) !== before) this.broadcast();
    // A folder the watch could not be put on when the project was attached (src/lib/siteorigin, static/), made since by
    // the publication: watched now, with a full look taken soon (what the watches being replaced were about to look at
    // goes with them), and the library's files looked at again.
    if ([...this.unwatched].some((rel) => existsSync(join(session.dir, rel)))) {
      this.watchExternalChanges(session, { owed: true, look: true });
      void this.checkAssetFiles(session);
    }
  }

  private runtimeQueue: Promise<unknown> = Promise.resolve();

  /** Start (or restart) the preview. Calls run one at a time, so overlapping retries never leave a second worker running. */
  startRuntime(): Promise<void> {
    return this.enqueue(() => this.startRuntimeNow());
  }

  /** Preview work runs one task at a time; closing waits for the task under way. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.runtimeQueue.then(fn);
    this.runtimeQueue = run.catch(() => undefined);
    return run;
  }

  private startRuntimeNow(): Promise<void> {
    const session = this.session;
    // A server started early for this opening that the start did not take over (a check failed, it was closed) goes.
    return timed('controller.startRuntime', () => this.startRuntimeWork(), () => ({ state: this.dev?.status.state ?? 'none' }))().finally(() => (session ? this.dropEarly(session) : undefined));
  }

  /**
   * Start the preview of a project that is still opening, once its lock is held and its documents are read and sound,
   * so its server comes up while the generated files are published (#960). It starts only after the checks a start
   * makes (the configuration is the one trusted, the website tools are set up, the lock is still this app's, old
   * component previews are gone), and startRuntime makes them all again before taking it over (takeEarly).
   */
  private prepareRuntime(session: ProjectSession) {
    void this.dropEarly();
    const dir = session.dir;
    const early: EarlyRuntime = { session, dev: null, started: Promise.resolve(), held: false, landed: 0, holding: 0, idle: [] };
    this.early = early;
    // What the opening's publication changes in the project: a server that read the files before then is not taken.
    session.previewHold = async () => {
      early.held = true;
      early.holding++;
      return (files) => {
        early.landed += files.length;
        if (--early.holding === 0) for (const wake of early.idle.splice(0)) wake();
      };
    };
    // Taken over by another app before it is attached (a switch waiting on Keep editing, say): its preview goes at once.
    session.once('lock-lost', () => void this.dropEarly(session));
    const mine = async () => this.early === early && (await session.stillOwner()) && this.early === early;
    early.started = (async () => {
      if (!(await isTrusted(dir, await configHash(dir)))) return;
      if (this.early !== early || !(await dependenciesReady(dir)) || !(await mine())) return;
      // One started for this folder by an earlier opening and stopped since has exited first.
      await this.earlyExits.get(dir);
      await clearComponentPreviews(dir).catch(() => undefined);
      if (!(await mine())) return;
      const dev: DevServer = new DevServer(dir, async (): Promise<boolean> => this.dev === dev && (await session.stillOwner()));
      early.dev = dev;
      await dev.start();
    })().catch(() => undefined);
  }

  /**
   * Stop the server started early for an opening (`session`'s, or any) that is not taking it. Settles once its process
   * has exited, so the lock it ran under, or a fresh server in its folder, comes only after it.
   */
  private async dropEarly(session?: ProjectSession): Promise<void> {
    const early = this.early;
    // Another opening's now, or none: one of this session's stopped earlier (by another opening) may still be exiting.
    if (!early || (session && early.session !== session)) return session ? this.earlyExits.get(session.dir) : undefined;
    this.early = null;
    const dir = early.session.dir;
    // Never forked (its checks were still running): an earlier one stopped in that folder may still be exiting.
    if (!early.dev) return this.earlyExits.get(dir);
    const exited = early.dev.stop();
    // Whoever starts a server in that folder next, or lets its lock go, waits for this one to have exited.
    this.earlyExits.set(dir, exited);
    void exited.then(() => {
      if (this.earlyExits.get(dir) === exited) this.earlyExits.delete(dir);
    });
    await exited;
  }

  /**
   * The server started early for `session`'s opening, when its start may take it over: it has not failed or stopped,
   * and the opening's publication landed no file in the project. What a starting server reads at once (its
   * configuration, the routes there are) is then what was published; every other file it serves is read when a page
   * is first asked for, which is after this. It stays where a lost lock, a close or quitting stops it until the start
   * takes it. Any other is stopped, and its process has exited, before this returns.
   */
  private async usableEarly(session: ProjectSession): Promise<EarlyRuntime | null> {
    const early = this.early;
    if (!early || early.session !== session) return null;
    const state = early.dev?.status.state;
    if (early.dev && early.held && early.landed === 0 && !session.readOnly && (state === 'starting' || state === 'ready')) return early;
    await this.dropEarly(session);
    return null;
  }

  private async startRuntimeWork() {
    const session = this.session;
    if (!session) return;
    // The server started while it opened is judged only once the opening's publication is done (usableEarly).
    await this.publications.get(session);
    if (this.session !== session) return;
    await this.stopPreview();
    if (this.session !== session) return;
    // A server started while the project opened is looked at now, and stopped and waited for when it cannot be taken,
    // before the checks below: so they run, as always, with no wait between them and anything running in the folder.
    // One that can be is taken only after them (startRuntimeNow stops it if the start ends without it).
    const early = await this.usableEarly(session);
    if (!early) await this.earlyExits.get(session.dir);
    await this.startRuntimeChecked(session, early);
  }

  /** startRuntimeWork's checks and start, with the server started early for this opening to take over, if any. */
  private async startRuntimeChecked(session: ProjectSession, usable: EarlyRuntime | null) {
    if (this.session !== session) return;
    // Nothing to start and nothing to retry: no worker is ever forked for it.
    if (previewUnavailable(session)) {
      this.send('runtime:status', this.runtimeStatus());
      return;
    }
    // Executable configuration must still be what the user trusted.
    if (!(await isTrusted(session.dir, await configHash(session.dir)))) {
      this.status({ state: 'error', message: TRUST_CHANGED });
      return;
    }
    const ready = await dependenciesReady(session.dir);
    // Closed or taken over meanwhile: never start an install into a folder that may be someone else's.
    if (this.session !== session) return;
    if (!ready) {
      if (session.readOnly) {
        this.status({ state: 'error', message: 'The preview is not available while this project is read-only, because its website tools are not set up.' });
        return;
      }
      // The lock is read again first: a takeover the heartbeat has not seen yet must not get an install.
      if (!(await session.stillOwner()) || this.session !== session) return;
      this.status({ state: 'preparing', message: 'Setting up website tools…' });
      const abort = (this.prepareAbort = new AbortController());
      try {
        await prepareDependencies(session.dir, (line) => this.status({ state: 'preparing', message: line.slice(0, 120) }), abort.signal, async () => this.session === session && (await session.stillOwner()));
      } catch (e) {
        // Taken over by another app or closed: a restart already queued previews it from a copy instead.
        if (abort.signal.aborted) return;
        this.status({ state: 'error', message: friendlyError((e as Error).message), detail: (e as Error).message });
        this.broadcast();
        return;
      } finally {
        if (this.prepareAbort === abort) this.prepareAbort = null;
      }
    }
    // Previews an earlier run left behind (it crashed, or the app did not close) are never shown again: cleared while
    // the project is this app's to write, ahead of the last look at the lock below, so nothing waits after it.
    if (!session.readOnly && (await session.stillOwner())) await clearComponentPreviews(session.dir).catch(() => undefined);
    // Read the lock again right before running anything in the folder: a takeover the heartbeat has not seen yet would
    // otherwise get a live preview. A takeover found here has already queued a preview from a copy.
    if (!session.readOnly && !(await session.stillOwner())) return;
    if (this.session !== session) return;
    // A project this app may not write to runs from a private copy, so its tools write nothing into the folder.
    // Decided with no wait before the fork: a takeover after this point stops the worker and queues a staged restart.
    const stage = session.readOnly ? await this.stagePreview(session) : null;
    if (session.readOnly && !stage) return;
    // A save landing files since the server was judged usable (usableEarly) is waited for, so what it changed is known.
    if (usable && !stage) while (usable.holding > 0) await new Promise<void>((wake) => usable.idle.push(wake));
    if (this.session !== session) return;
    // The server started while the project opened, when it could be taken over; otherwise a new one. A preview that
    // crashes is started again in the same folder only while that is still this app's to use; a copy is.
    // Stopped during the checks (a lost lock, another opening): a start of its own replaces it, making every check
    // again; one the lock went with is already queued (lock-lost).
    if (usable && !stage && this.early !== usable) {
      if (!session.readOnly) void this.startRuntime().catch(() => undefined);
      return;
    }
    let early = stage ? null : usable;
    // Judged usable before these checks: one a save has landed files under since may have read them part way, so a
    // server of its own is started instead. Decided with no wait before the takeover.
    if (early && early.landed > 0) {
      await this.dropEarly(session);
      // Read the lock again before running anything in the folder (a takeover found here has queued its own start).
      if (this.session !== session || !(await session.stillOwner()) || this.session !== session) return;
      early = null;
    }
    if (early) this.early = null;
    const dev: DevServer = early?.dev ?? new DevServer(stage ?? session.dir, async (): Promise<boolean> => this.dev === dev && (!!stage || (await session.stillOwner())));
    this.dev = dev;
    // A new preview server has published nothing yet.
    this.publishedRevision = null;
    this.noticeTicket = 0;
    this.publishedTicket = 0;
    this.stage = stage;
    this.stagedRevision = -1;
    this.pendingStatus = null;
    if (stage) this.watchStageSources(session);
    const onStatus = (s: RuntimeStatus) => {
      // A preview that was stopped or replaced no longer speaks for the project.
      if (this.dev !== dev) return;
      // A server that has just come up serves the files as they are now: the project's own folder at the session's
      // revision, or the private copy at the revision it was brought to. Changes saved while none ran were published
      // to nothing, so this is the revision a page loaded from it shows (#766).
      if (s.state === 'ready' && this.session) {
        const serves = this.stage ? this.stagedRevision : this.session.revision;
        if (serves >= 0) this.publishedRevision = Math.max(this.publishedRevision ?? 0, serves);
        // Notified before it could publish anything: it serves the files as they are now.
        this.publishedTicket = this.noticeTicket;
      }
      this.publishMoved();
      this.send('runtime:status', s);
      this.live.previewChanged();
      this.broadcast();
    };
    dev.onStatus(onStatus);
    // A live session's guests reload once a change has reached the preview: its files are in Vite's hands, so what
    // they load is the new revision (the project's own folder, or the private copy once it has the change).
    dev.onPublished((revision, ticket) => {
      if (this.dev !== dev) return;
      this.publishedRevision = Math.max(this.publishedRevision ?? 0, revision);
      this.publishedTicket = Math.max(this.publishedTicket, ticket);
      this.publishMoved();
      this.live.projectChanged(revision);
    });
    // Guests' requests to a server stopping or gone are stopped at once, and the relay told why.
    dev.onGone(() => {
      if (this.dev === dev) this.live.previewChanged();
    });
    if (early) {
      // Taken over where it is now (starting, or already listening); what it does next is reported as it happens.
      onStatus(dev.status);
      await early.started;
    } else await dev.start();
    // Anything the other app wrote between the copy and the watches.
    if (stage) this.syncStage(session);
  }

  /** Copy a project this app may not write to into a private folder to preview it from, or say why it cannot be. */
  private async stagePreview(session: ProjectSession): Promise<string | null> {
    const fail = (message: string, detail?: string) => {
      if (this.session === session) this.status({ state: 'error', message, detail });
      return null;
    };
    const root = join(app.getPath('userData'), 'preview-staging');
    // The copies are made, cleared and swept inside this folder, so it must not be (or lead to) the project itself.
    if (isInside(session.dir, root) || isInside(session.dir, canonicalDir(root)))
      return fail('The preview is not available while this project is read-only, because SiteOrigin Builder keeps its own data inside the project folder.');
    // Clearing old copies there must never reach a project that lives inside that folder.
    if (isInside(canonicalDir(root), session.dir)) return fail('The preview is not available for a project kept inside SiteOrigin Builder’s own data folder.');
    this.status({ state: 'preparing', message: 'Copying the project to preview it without changing it…' });
    let stage: string;
    try {
      await sweepPreviewStages(root);
      stage = await createPreviewStage(session.dir, root);
    } catch (e) {
      return fail('The read-only preview could not be prepared.', (e as Error).message);
    }
    // The copy runs the project's build settings, which the app editing it may have changed since they were trusted.
    const trusted = await isTrusted(session.dir, await configHash(stage)).catch(() => false);
    if (this.session !== session || !trusted) {
      await removePreviewStage(stage).catch(() => undefined);
      return trusted ? null : fail(TRUST_CHANGED);
    }
    return stage;
  }

  /**
   * The project revision the running preview serves, once any copy under way has finished, or null without a preview.
   * The preview runs from the project's own folder, whose generated files are written before a change is announced,
   * or from a private copy brought up to a revision at a time.
   */
  async previewRevision(): Promise<number | null> {
    const session = this.session;
    if (!this.dev || !session) return null;
    if (!this.stage) return session.revision;
    await this.stageSync.catch(() => undefined);
    return this.stage && this.session === session ? this.stagedRevision : null;
  }

  /**
   * Resolves once the running preview has published `revision` and every change it was told of before now, so a page
   * loaded from it shows them (their files are in Vite's hands: see onPublished): true at once when it already has, or
   * when no preview is up and running (a page check then says so, as it would have); false when `capMs` pass first, and
   * a page loaded then could show the project from before. A page measured for the assistant waits for this, rather
   * than a fixed time, before it is loaded.
   */
  previewPublished(revision: number, capMs: number): Promise<boolean> {
    const ticket = this.noticeTicket;
    const done = () => !this.dev || this.dev.status.state !== 'ready' || (this.publishedRevision !== null && this.publishedRevision >= revision && this.publishedTicket >= ticket);
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const look = () => {
        if (done()) finish(true);
      };
      const finish = (published: boolean) => {
        clearTimeout(timer);
        this.publishWaits.delete(look);
        resolve(published);
      };
      const timer = setTimeout(() => finish(false), capMs);
      this.publishWaits.add(look);
    });
  }

  /** Tell the running preview server of a revision, numbered so its publication can be told apart (previewPublished). */
  private notifyPreview(revision: number) {
    if (this.dev) this.dev.notifyRevision(revision, ++this.noticeTicket);
  }

  /** The preview published a revision, or started or stopped: waits for one look again. */
  private publishMoved() {
    for (const look of [...this.publishWaits]) look();
  }

  /**
   * Project health's entries for library files missing from the project folder, from a look at the folder now. Nothing
   * is kept or published: Project health keeps its own look, which the folder watch refreshes.
   */
  async fileDiagnostics(): Promise<Diagnostic[]> {
    const session = this.session;
    if (!session) return [];
    const state = session.state;
    try {
      return missingFileDiagnostics(state, await findMissingAssetFiles(session.dir, state.assets.assets));
    } catch {
      return [];
    }
  }

  /**
   * Mirror the project into the private copy, then tell the preview which revision it shows. Requests made while one
   * runs collapse into the latest. A copy that cannot be brought up to date is replaced by a fresh one, which reports
   * any problem.
   */
  private syncStage(session: ProjectSession) {
    const stage = this.stage;
    const ticket = ++this.stageTicket;
    this.stageSync = this.stageSync
      .then(async () => {
        if (!stage || this.stage !== stage || this.session !== session || this.stageTicket !== ticket) return;
        const revision = session.revision;
        // The copy's files reach its preview as one update, as a save's do.
        const dev = this.dev;
        const release = dev ? await dev.hold() : null;
        let copied: string[] = [];
        try {
          copied = await syncPreviewStage(session.dir, stage);
        } finally {
          release?.(copied);
        }
        this.filesChangedAt = Date.now();
        if (this.stage === stage) {
          this.stagedRevision = revision;
          this.notifyPreview(revision);
        }
      })
      .catch(() => {
        if (this.stage !== stage || this.session !== session || this.restaged === session) return;
        this.restaged = session;
        void this.startRuntime().catch(() => undefined);
      });
  }

  /**
   * Watch a folder of the open project. A watch that fails (its folder went, too many files) just stops: unhandled, its
   * error would be thrown. Whatever a watch reports may be the project folder going, so that is looked at too.
   */
  private watchFolder(session: ProjectSession, dir: string, listener: (event: string, file: string | null) => void): FolderWatch {
    const w = watchTree(dir, (event, file) => {
      this.checkFolderSoon(session);
      listener(event, file);
    });
    w.on('error', () => {
      w.close();
      this.checkFolderSoon(session);
    });
    return w;
  }

  /** Once things settle, report the open project as gone if its folder was moved, renamed or deleted. */
  private checkFolderSoon(session: ProjectSession) {
    if (this.folderTimer) clearTimeout(this.folderTimer);
    this.folderTimer = setTimeout(() => {
      this.folderTimer = null;
      if (this.session === session) void session.checkFolder().catch(() => false);
    }, 300);
  }

  /** Follow the files the copy is made from (generated pages, public files, the editor's variants), read-only. */
  private watchStageSources(session: ProjectSession) {
    const onChange = () => {
      if (this.stageTimer) clearTimeout(this.stageTimer);
      this.stageTimer = setTimeout(() => this.syncStage(session), 300);
    };
    for (const rel of ['src', 'static', join(LOCAL_DIR, 'cache', 'dev')]) {
      try {
        const dir = join(session.dir, rel);
        if (!existsSync(dir)) continue;
        // If a watch stops, accepted document changes still sync.
        this.stageWatchers.push(this.watchFolder(session, dir, onChange));
      } catch {
        /* watching is best-effort: accepted document changes still bring the copy up to date */
      }
    }
  }

  /** Stop the preview, then remove the private copy it ran from (again once its process has really gone). */
  /** Remove the files of every component preview prepared for the preview server running now. */
  private async dropComponentPreviews() {
    const previews = [...this.componentPreviews];
    this.componentPreviews.clear();
    await Promise.all(previews.map(([key, root]) => removeComponentPreview(root, key).catch(() => undefined)));
  }

  private async stopPreview() {
    const dev = this.dev;
    const stage = this.stage;
    // Prepared for this preview server alone: a frame showing one fails to load once the server is gone anyway.
    await this.dropComponentPreviews();
    for (const w of this.stageWatchers) w.close();
    this.stageWatchers = [];
    if (this.stageTimer) clearTimeout(this.stageTimer);
    this.stageTimer = null;
    this.pendingStatus = null;
    await dev?.stop();
    if (this.dev === dev) this.dev = null;
    if (this.stage === stage) this.stage = null;
    this.publishMoved();
    this.live.previewChanged();
    // One prepared while the server stopped is gone with it too.
    await this.dropComponentPreviews();
    if (!stage) return;
    await this.stageSync;
    await removePreviewStage(stage).catch(() => undefined);
    if (dev) void dev.exited.then(() => removePreviewStage(stage)).catch(() => undefined);
  }

  /**
   * Prepare an isolated preview of one component (see @shared/component-preview) for the preview server running now:
   * its files are written under a new key, and the address the server shows it at is returned. Release it with
   * releaseComponentPreview once it is no longer shown.
   */
  async prepareComponentPreview(request: unknown): Promise<{ ok: true; key: string; path: string; definitionId: string } | { ok: false; message: string }> {
    const session = this.session;
    const dev = this.dev;
    if (!session || !dev || dev.status.state !== 'ready') return { ok: false, message: 'The preview is not running.' };
    // A project another app took over is previewed from a copy once its preview restarts: nothing is written into its
    // folder meanwhile.
    if (!this.stage && session.readOnly) return { ok: false, message: 'The preview is not running.' };
    const spec = previewSpec(request);
    if (!spec) return { ok: false, message: 'That is not a component preview request.' };
    const made = generateComponentPreview(session.state, spec);
    if ('error' in made) return { ok: false, message: made.error };
    const root = this.stage ?? session.dir;
    // The lock is read again before writing into the project: a takeover the heartbeat has not seen yet gets nothing.
    if (!this.stage && !(await session.stillOwner())) return { ok: false, message: 'The preview is not running.' };
    let written: { key: string; path: string };
    try {
      written = await writeComponentPreview(root, made.files);
    } catch (e) {
      return { ok: false, message: `The component preview could not be prepared: ${(e as Error).message}` };
    }
    // The preview server it was made for stopped (or started stopping) meanwhile: its files go with it.
    if (this.dev !== dev || dev.status.state !== 'ready' || this.session !== session || (this.stage ?? session.dir) !== root) {
      await removeComponentPreview(root, written.key).catch(() => undefined);
      return { ok: false, message: 'The preview is not running.' };
    }
    this.componentPreviews.set(written.key, root);
    return { ok: true, ...written, definitionId: made.definitionId };
  }

  /** The thumbnail of a project component for Insert, in the opening `opening` (see @shared/component-thumbs). */
  componentThumb(definitionId: unknown, opening: unknown, have?: unknown): Promise<ComponentThumb> {
    if (!perf.on) return this.thumbs.get(definitionId, opening, have);
    // Each request the editor makes, and its answer as IPC serializes it (scripts/perf: the thumbs scenario).
    perf.count('thumbs.requests');
    perf.mark('thumbs.asked', { definitionId: typeof definitionId === 'string' ? definitionId : null });
    const end = perf.span('thumbs.answered', { definitionId: typeof definitionId === 'string' ? definitionId : null });
    return this.thumbs.get(definitionId, opening, have).then(
      (r) => {
        const bytes = serializedSize(r);
        if (bytes !== null) perf.count('thumbs.bytes', bytes);
        end({ state: r.state, picture: r.state === 'ready' && !!r.url, bytes });
        return r;
      },
      (e: unknown) => {
        end({ state: 'error', bytes: null });
        throw e;
      }
    );
  }

  /** Remove a prepared component preview's files. */
  async releaseComponentPreview(key: unknown): Promise<void> {
    if (typeof key !== 'string') return;
    const root = this.componentPreviews.get(key);
    if (!root) return;
    this.componentPreviews.delete(key);
    await removeComponentPreview(root, key).catch(() => undefined);
  }

  /** Look for the library's image files again, and tell the window when what is missing changed. */
  private async checkAssetFiles(session: ProjectSession): Promise<void> {
    // A folder that is gone is reported as that, not as every picture missing, and nothing is made at its old address.
    if (await session.checkFolder()) return;
    const changed = await session.refreshAssetFiles().catch(() => false);
    if (changed && this.session === session) this.broadcast();
    // The website's icons follow a favicon file put back or replaced in the folder.
    await session.refreshSiteIcons().catch(() => null);
  }

  /**
   * Accept valid external edits to canonical documents and authored code components, and notice image files being
   * moved out of (or back into) static/assets/.
   */
  private watchExternalChanges(session: ProjectSession, opts: { owed?: boolean; look?: boolean } = {}) {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.unwatched.clear();
    // A folder moved with a parent of it may tell no watch, and a read-only project has no lock heartbeat to notice.
    if (this.folderPoll) clearInterval(this.folderPoll);
    this.folderPoll = setInterval(() => this.checkFolderSoon(session), LOCK_HEARTBEAT_MS);
    this.folderPoll.unref?.();
    if (this.assetTimer) clearTimeout(this.assetTimer);
    this.assetTimer = null;
    const onAssetChange = () => {
      if (this.assetTimer) clearTimeout(this.assetTimer);
      this.assetTimer = setTimeout(() => {
        this.assetTimer = null;
        if (this.session === session) void this.checkAssetFiles(session);
      }, 300);
    };
    // static/ rather than static/assets/, so the assets folder itself being removed or put back is seen too.
    try {
      const dir = join(session.dir, 'static');
      if (existsSync(dir)) {
        // An event without a file name may be about anything in static/, so it is looked at too.
        this.watchers.push(this.watchFolder(session, dir, (_e, f) => (!f || /^assets([\\/]|$)/.test(f)) && onAssetChange()));
      } else this.unwatched.add('static');
    } catch {
      /* watching is best-effort: the check still runs when the library changes and before every export */
    }
    // The files the watch has named since the last look. The look is owed in full (as every look was before the app
    // could tell its own saves) when the one before it was refused or failed, when a watch told of a change without
    // naming it, and for good once a watch has ended: the app's own saves name only files that hold what it wrote, and a
    // change named nowhere could be anywhere. Watches put back after a close that failed owe one too: what they had
    // been told went with the old ones, and so does a watch that could not be made. Looks run one after another, each
    // deciding once the one before has finished, and only while these watches are the ones in place.
    const generation = ++this.watchGeneration;
    const current = () => this.watchGeneration === generation && this.session === session;
    let named = new Set<string>();
    let owed = !!opts.owed;
    let blind = false;
    let looking: Promise<void> = Promise.resolve();
    const look = async () => {
      if (!current() || this.aiBusy()) return;
      const paths = named;
      const whole = owed || blind;
      named = new Set();
      owed = false;
      if (!paths.size && !whole) return;
      const r = await (whole ? session.reloadFromDisk() : session.reloadChanged(paths)).catch((e: Error) => ({ ok: false, message: e.message }));
      if (!r.ok) owed = true;
      if (!r.ok && r.message && r.message !== 'Busy') this.send('runtime:status', this.runtimeStatus());
    };
    const onChange = (path: string | null) => {
      if (path === null) owed = true;
      else named.add(path);
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(async () => {
        // The watch has seen the documents change and gone quiet: what follows is the look at them.
        perf.mark('controller.watchFired');
        // Not now: what was named waits for the next look.
        if (!current() || this.aiBusy()) return;
        if (await session.checkFolder()) return;
        looking = looking.then(look).catch(() => undefined);
        await looking;
      }, 400);
    };
    // Watch src/lib/siteorigin (not just custom/) so a custom folder created later is still seen.
    for (const [rel, accept] of [
      // Only the generated manifest itself is left out: a collection or entry may have any name.
      ['siteorigin', (f: string) => f !== 'generated-manifest.json'],
      ['src/lib/siteorigin', (f: string) => f.startsWith('custom')]
    ] as const) {
      const dir = join(session.dir, rel);
      try {
        if (!existsSync(dir)) {
          blind = true;
          this.unwatched.add(rel);
          continue;
        }
        const w = this.watchFolder(session, dir, (_e, f) => {
          // Told of a change without its name: the folder itself (which ends the watch, or comes under its own name),
          // or anything in it.
          if (!f || f === basename(dir)) {
            if (f === '') blind = true;
            return onChange(null);
          }
          if (accept(f) && !f.endsWith('.tmp')) onChange(`${rel}/${f.split(sep).join('/')}`);
        });
        // What it would have told of from now on is not known: looked at in full soon, and at every look after.
        w.on('error', () => {
          blind = true;
          onChange(null);
        });
        this.watchers.push(w);
      } catch {
        /* watching is best-effort, and a folder not watched could hold anything */
        blind = true;
      }
    }
    if (opts.look) onChange(null);
  }

  /**
   * Reinstall the website's tools from scratch (the dependency manager's repair action). It runs with the other preview
   * work, so closing waits for it, and stops at each step once the project is closed or taken over.
   */
  repairDependencies(): Promise<void> {
    return this.enqueue(async () => {
      const s = this.session;
      if (!s || s.readOnly) return;
      await this.stopPreview();
      // The tools belong to whoever holds the project now.
      const owned = async () => this.session === s && (await s.stillOwner());
      if (!(await owned())) return;
      this.status({ state: 'preparing', message: 'Reinstalling website tools…' });
      try {
        await fs.rm(join(s.dir, 'node_modules'), { recursive: true, force: true });
        if (!(await owned())) return;
        await fs.rm(join(s.dir, '.siteorigin', 'cache', 'deps.json'), { force: true });
      } catch (e) {
        this.status({ state: 'error', message: friendlyError((e as Error).message), detail: (e as Error).message });
        return;
      }
      await this.startRuntimeNow();
    });
  }

  /**
   * The switch to a project opened or created beside the open one: what is being typed in the open project is saved,
   * then it closes. Not ok, with the open project still open, when the author keeps editing, when its close fails, or
   * when it was closed meanwhile by something else (quitting, say), which the replacement must not undo.
   */
  private async makeWay(since: number, signal?: AbortSignal, committing?: () => void): Promise<{ ok: boolean; message?: string }> {
    if (!(await this.mayLeave())) return { ok: false };
    if (signal?.aborted) return { ok: false, message: friendlyError('Canceled') };
    // An ordinary close already under way when this switch began is joined below; one since then, or quitting, wins.
    if (this.quitting || this.closings !== since) return { ok: false };
    // One handover at a time: from the close until the replacement is attached, no other switch may close anything.
    if (this.handingOver) return { ok: false, message: 'Another project is opening. Try again once it is open.' };
    committing?.();
    this.handingOver = true;
    try {
      await this.close();
    } catch (e) {
      // A close that failed part way, with the project already gone, leaves nothing to go back to.
      if (this.session) {
        this.handingOver = false;
        return { ok: false, message: `The open project could not be closed: ${(e as Error).message}` };
      }
    }
    return { ok: true };
  }

  /** Whether the open project may be unloaded: the editor saves what is still being typed first, or the author
   *  chooses to keep editing a change that cannot be saved. */
  async mayLeave(): Promise<boolean> {
    // Already closing: leaving was settled when that close was allowed.
    // Another computer's project shown as a guest (#766) has typing to settle too: it is sent to the host first.
    if ((!this.session && !this.remote.active) || this.closing || !this.beforeLeave) return true;
    return this.beforeLeave();
  }

  /** Close the project when the author asks to (Close Project, a new project): pending edits are saved first. */
  async closeProject(): Promise<{ ok: boolean }> {
    if (!(await this.mayLeave())) return { ok: false };
    await this.close();
    return { ok: true };
  }

  /** Close the project. A close already under way is joined, so quitting waits for its preview copy to go too. */
  close(): Promise<void> {
    const [key, session] = [this.workspaceKey, this.session];
    // A close that fails leaves the project open and editable under the same opening, and tells the editor.
    this.closing ??= timed('controller.close', () => this.closeNow())().catch((e) => { if (session && this.session === session && !this.workspaceKey) (this.workspaceKey = key), this.watchExternalChanges(session, { owed: true }), this.onOpeningChange?.(), this.broadcast(); throw e; }).finally(() => (this.closing = null));
    return this.closing;
  }

  get isClosing(): boolean {
    return !!this.closing;
  }

  private async closeNow() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.unwatched.clear();
    this.watchGeneration++;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.assetTimer) clearTimeout(this.assetTimer);
    this.assetTimer = null;
    if (this.folderTimer) clearTimeout(this.folderTimer);
    this.folderTimer = null;
    if (this.folderPoll) clearInterval(this.folderPoll);
    this.folderPoll = null;
    // Quitting: a project still opening never gets to take over the preview started for it.
    if (this.quitting) await this.dropEarly();
    const s = this.session;
    if (!s) return this.endExports();
    this.closings++;
    // A posts import being read or reviewed belongs to this project.
    this.postImport = null;
    stopPostReads();
    // So does a source being synced: its worker is ended, and a reply already in nothing lands.
    for (const sync of this.sourceSyncs) sync.abort();
    this.sourceSyncs.clear();
    stopSourceSyncs();
    // Workspace state belongs to the project it was saved in: accept no more of it, and write it before the lock goes.
    this.workspaceKey = null;
    this.onOpeningChange?.();
    // A live session ends with its project: guests lose the preview now, and the relay is told (waited for below).
    const liveEnded = this.live.end();
    await this.onSessionClosing?.();
    // Written while this is still the open project, and only while it is still this app's: the lock is read again
    // first, so a takeover the heartbeat has not seen yet makes it read-only, which writes nothing.
    await s.stillOwner().catch(() => false);
    await this.flushLocalState();
    // One more try if that write failed: this is the last chance before the lock goes.
    if (this.localDirty) await this.flushLocalState();
    // From here preview work still under way finds the project gone and starts nothing; an install into the folder is
    // cancelled. Close waits for that work (a copy being made, a removal) before letting the lock go.
    if (this.session === s) this.session = null;
    // From here the project is gone, whatever fails while it is put away, so the editor is always told: a project
    // opened next must never be shown over what is left of this one.
    try {
      // The exported websites' previews belong to the project that exported them. A close that failed before this
      // point leaves the project open, and its previews with it.
      this.endExports();
      this.prepareAbort?.abort();
      // Nothing the project kept running waits out its idle time at Welcome: the media workers end once the work
      // already asked of them is done, the thumbnails' hidden window closes (before the preview server it shows
      // stops), and the thumbnails kept in memory go. Each starts again when the next project needs it.
      releaseMediaWorkers();
      this.thumbs.forget();
      this.onSessionClosed?.();
      // The editor lets go of the preview before its server stops, so a page still loading there never finds it gone.
      this.send('runtime:status', { state: 'idle' });
      await this.stopPreview();
      await this.runtimeQueue;
      await this.stopPreview();
      // Closed before its start took over the server started while it opened (Close Project during attach).
      await this.dropEarly(s);
      await liveEnded;
      await s.close();
      // Its entry in Recent projects leaves with the name it has now, whichever way it was left: back to Welcome or
      // for another project. A list that cannot be saved never stops the close.
      if (!s.readOnly) await renameRecent(s.dir, projectDisplayName(s.state)).catch(() => undefined);
    } finally {
      // The next project loads its own workspace state, or starts empty.
      this.localState = {};
      this.send('project:closed');
      this.forgetEditorCopy();
    }
  }

  /**
   * Copy the open project to a new folder named after `opts.name` in `opts.parentDir` (#176), as the opening it was
   * chosen in left it. The copy gets its own project ID and keeps the name it is given in Recent projects and the
   * toolbar (`workingCopyName`), whatever its site is called; the site's visitor-facing name and every page are copied
   * as they are. The new folder is claimed first, so a folder already there (empty or not, another copy's or an
   * export's) is never taken over, and the copy is built in a private folder beside it and moved into place in one
   * step, so a copy that fails leaves nothing behind. The open project stays open, and nothing in its folder is
   * written. Quitting waits for a copy under way.
   */
  async duplicate(opts: DuplicateProjectOptions): Promise<DuplicateProjectResult> {
    if (this.quitting) return { ok: false, field: 'form', message: 'SiteOrigin Builder is quitting, so the project was not copied.' };
    const run = this.duplicateProject(opts);
    this.duplicates.add(run);
    try {
      return await run;
    } finally {
      this.duplicates.delete(run);
    }
  }

  /** Wait for every copy under way (quitting): each finishes, or removes what it made. */
  async settleDuplicates(): Promise<void> {
    while (this.duplicates.size) await Promise.all([...this.duplicates].map((run) => run.catch(() => undefined)));
  }

  get isDuplicating(): boolean {
    return this.duplicates.size > 0;
  }

  private async duplicateProject(opts: DuplicateProjectOptions): Promise<DuplicateProjectResult> {
    const s = this.session;
    const stale = { ok: false as const, field: 'form' as const, message: 'The project was closed or opened again before it was copied. Choose Duplicate project again.' };
    const current = () => this.session === s && this.workspaceKey === opts.opening;
    if (!s || !opts || !current()) return stale;
    const name = typeof opts.name === 'string' ? opts.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) return { ok: false, field: 'name', message: 'Enter a name for the copy.' };
    if (name.length > MAX_COPY_NAME) return { ok: false, field: 'name', message: `Use a name of up to ${MAX_COPY_NAME} characters.` };
    if (typeof opts.parentDir !== 'string' || !isAbsolute(opts.parentDir)) return { ok: false, field: 'location', message: 'Choose a folder for the copy.' };
    const dest = join(opts.parentDir, projectFolderName(name));
    // The copy would land inside the folder it copies, and write into a project that may be read-only here. Named after
    // the project's own folder, beside it, it is that folder: a folder by that name is already there, which another
    // name answers, as for any other.
    const original = existsSync(dest) && canonicalDir(dest) === s.dir;
    if (!original && isInside(s.dir, dest)) return { ok: false, field: 'location', message: 'Choose a folder outside the project folder.' };
    // A folder by the copy's name: another name answers it as well as another folder does.
    const taken = { ok: false as const, field: 'name' as const, message: `A folder named “${basename(dest)}” is already there. Choose another name or folder.` };
    // Claimed in the folder the author chose, which must still be there: a folder renamed or removed meanwhile is not
    // made again under its old name.
    try {
      await fs.mkdir(dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return taken;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, field: 'location', message: `${opts.parentDir} is no longer there. Choose another folder.` };
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { ok: false, field: 'location', message: `SiteOrigin Builder does not have permission to write to ${opts.parentDir}. Choose another folder.` };
      if (code === 'ENOSPC') return { ok: false, field: 'form', message: 'Your disk is full. Free up some space and try again.' };
      return { ok: false, field: 'location', message: `The copy could not be made in ${opts.parentDir}: ${(e as Error).message}` };
    }
    const tmp = `${dest}.${randomUUID()}.tmp`;
    // The claim is this attempt's to remove until the move begins: Windows lets go of it then, and a folder made in
    // its place meanwhile is someone else's.
    let claimed = true;
    // The copy is its own project, under its own ID.
    const projectId = newId('p', 12);
    try {
      // Made beside the claim, never with folders above it: a parent moved meanwhile is not made again.
      await fs.mkdir(tmp);
      // Read in turn with the project's own writes, so a save never lands halfway through the copy, and only while the
      // opening it was asked in is still the open one.
      await s.exclusive(async () => {
        if (!current()) throw Object.assign(new Error('stale'), { code: 'STALE_OPENING' });
        // The copy is the project itself, brief and all, with its sources' settings as the project holds them, and as
        // the folder holds them too, so they match the collections copied beside them.
        const sources = await this.sourcesCopyProblem(s);
        if (sources) throw Object.assign(new Error(sources), { code: 'SOURCES' });
        await copyProjectSource(s.dir, tmp, { keepBrief: true });
        await writeExportedSources(tmp, s.state, { keep: true });
      });
      const manifestPath = join(tmp, MANIFEST_FILE);
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.projectId = projectId;
      manifest.name = name;
      manifest.workingCopyName = name;
      manifest.createdAt = new Date().toISOString();
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await replaceEmptyFolder(tmp, dest, () => {
        if (process.platform === 'win32') claimed = false;
      });
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      // Only while it is still the empty folder claimed above.
      if (claimed) await fs.rmdir(dest).catch(() => undefined);
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'STALE_OPENING') return stale;
      if (err.code === 'ENOENT' && !existsSync(opts.parentDir)) return { ok: false, field: 'location', message: `${opts.parentDir} is no longer there. Choose another folder.` };
      if (err.code === 'EEXIST') return taken;
      if (err.code === 'ENOSPC') return { ok: false, field: 'form', message: 'Your disk is full. Free up some space and try again.' };
      return { ok: false, field: 'form', message: `The project could not be copied: ${err.message}` };
    }
    const dir = canonicalDir(dest);
    // The copy is trusted only as the original is: setup files changed since it was trusted are asked about when the
    // copy is opened. Being trusted, and listed, are conveniences: the copy is made either way.
    await configHash(dir)
      .then(async (hash) => {
        if (await isTrusted(s.dir, hash)) await trust(dir, hash);
      })
      .catch(() => undefined);
    await addRecent(dir, name, projectId).catch(() => undefined);
    return { ok: true, dir, name };
  }

  /**
   * Remember workspace state (open page, tabs, unsent AI drafts) for the opening of the project the editor meant
   * (`key`, from its snapshot). A save for an opening that has started closing is dropped: it must never reach the
   * next project, or a later opening of the same one. The file is written shortly after the last change, and always
   * before the project closes.
   */
  saveLocalState(state: LocalWorkspaceState, key: string) {
    if (!this.session || !key || this.workspaceKey !== key) return;
    // Hiding Get started (or undoing that) is also the author's choice for the projects made after this one.
    const hidden = state.firstSteps?.hidden;
    if (hidden !== undefined && hidden !== !!this.localState.firstSteps?.hidden) void rememberGetStartedHidden(hidden).catch(() => undefined);
    this.localState = { ...this.localState, ...state };
    this.localDirty = true;
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => void this.flushLocalState(), 300);
  }

  /**
   * A conversation being deleted in the opening `key` takes its unsent message and images with it, and is no longer
   * the one to reopen. Dropped from the workspace state before the delete starts, while the opening is sure to be
   * current, so a close during the delete can't keep them. Answers a function that puts them back, for a delete that
   * fails.
   */
  forgetConversation(id: string, key: string): () => void {
    if (!this.session || !key || this.workspaceKey !== key) return () => undefined;
    const { chatDrafts, chatImages, chatConversation } = this.localState;
    const patch: LocalWorkspaceState = {};
    const back: LocalWorkspaceState = {};
    if (chatDrafts && Object.hasOwn(chatDrafts, id)) {
      patch.chatDrafts = Object.fromEntries(Object.entries(chatDrafts).filter(([k]) => k !== id));
      back.chatDrafts = { [id]: chatDrafts[id] };
    }
    if (chatImages && Object.hasOwn(chatImages, id)) {
      patch.chatImages = Object.fromEntries(Object.entries(chatImages).filter(([k]) => k !== id));
      back.chatImages = { [id]: chatImages[id] };
    }
    // Left out of the file when it is written: the project reopens on the conversation main shows first.
    if (chatConversation === id) (patch.chatConversation = undefined), (back.chatConversation = id);
    if (!Object.keys(patch).length) return () => undefined;
    this.saveLocalState(patch, key);
    return () => {
      if (this.workspaceKey !== key) return;
      const now = this.localState;
      this.saveLocalState(
        {
          ...(back.chatDrafts ? { chatDrafts: { ...now.chatDrafts, ...back.chatDrafts } } : {}),
          ...(back.chatImages ? { chatImages: { ...now.chatImages, ...back.chatImages } } : {}),
          // Only while no other conversation has been opened since.
          ...(back.chatConversation && now.chatConversation === undefined ? { chatConversation: back.chatConversation } : {})
        },
        key
      );
    };
  }

  /** The opening of the project that is open now (see saveLocalState), or null. */
  get openingKey(): string | null {
    return this.workspaceKey;
  }

  /**
   * Resolves once every write already queued for the open project has finished (Save waits on this), saying whether
   * they all reached the disk in the opening Save was pressed in (`opening`, from its snapshot; any, when not given):
   * false when that opening has started closing, a save did not finish, or the AI is still making changes (Stop takes
   * them back). It joins the end of the session's queue without taking the writer lock, so a later write never waits
   * on it.
   */
  async flush(opening?: string): Promise<boolean> {
    const s = this.session;
    const current = () => this.session === s && this.workspaceKey !== null && (opening === undefined || opening === this.workspaceKey);
    if (!s || !current()) return false;
    await s.exclusive(async () => undefined);
    return current() && !s.saveUnfinished && !this.aiBusy();
  }

  /** Write pending workspace state now. Writes run one at a time, in order, so an older state never lands last. */
  flushLocalState(): Promise<void> {
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = null;
    const s = this.session;
    if (this.localDirty && s && !s.readOnly) {
      const file = s.local('workspace.json');
      const bytes = JSON.stringify(this.localState);
      // A failed write (a full disk) is tried again with the next change, or when the project closes. Each write
      // checks the lock first, so a project another app has taken over never gets this app's layout.
      this.localWrites = this.localWrites
        .then(async () => {
          if (await s.stillOwner()) await atomicWrite(file, bytes, { durable: false });
          // Not confirmed but not taken over either: kept for the next try.
          else if (this.session === s && !s.readOnly) this.localDirty = true;
        })
        .catch(() => {
          if (this.session === s) this.localDirty = true;
        });
    }
    this.localDirty = false;
    return this.localWrites;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  apply(batch: EditBatch, opts: { label?: string; coalesceKey?: string; opening?: string } = {}): Promise<ApplyResult> {
    // An edit's whole time in the main process, from the editor's request to its answer (src/shared/perf.ts).
    return timed('controller.apply', () => this.applyNow(batch, opts), (r) => ({ operations: Array.isArray(batch?.operations) ? batch.operations.length : 0, ok: r?.ok ?? false, revision: r?.revision ?? null }))();
  }

  private async applyNow(batch: EditBatch, opts: { label?: string; coalesceKey?: string; opening?: string }): Promise<ApplyResult> {
    const session = this.session;
    if (!session) return { ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'No project is open.', recoverable: false } };
    // Made in an opening of a project that has since started closing, closed or been switched away from (even
    // one reopened at the same folder): never applied to this one.
    if (opts.opening !== undefined && opts.opening !== this.workspaceKey) return { ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } };
    // The AI owns the project from the moment it starts, before its run takes the session's write lock.
    if (this.aiBusy()) return { ok: false, revision: session.revision, error: { code: 'BUSY', message: 'The AI is making changes. Stop it before editing.', recoverable: true } };
    // Code, and copies that would make new code, need Developer mode: the session checks the batch as it applies it.
    const codeAllowed = (await loadSettings()).settings.developerMode;
    // A source's settings are saved only once they have been tested against what the source has (saveSource).
    if (batch.operations.some((o) => (o as { type?: unknown })?.type === 'source.upsert'))
      return { ok: false, revision: session.revision, error: { code: 'INVALID_ARGUMENT', message: 'A source’s settings are saved from Connect external source, which tests them first.', recoverable: true } };
    // An edit belongs to the project it was made in: one closing, closed or switched meanwhile never receives it.
    if (this.session !== session || this.closing) return { ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } };
    return session.apply(batch, { label: opts.label ?? batch.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user', codeAllowed });
  }

  /**
   * Undo one history entry for the notification that offered it. `key` is the opening of the project the change was
   * made in (from its snapshot): an Undo left over from a project that has since closed never reaches another one.
   */
  undoEntry(entryId: string, key: string): Promise<ApplyResult> {
    if (!this.session || !key || this.workspaceKey !== key)
      return Promise.resolve({ ok: false, revision: this.session?.revision ?? 0, error: { code: 'CONFLICT', message: 'That change was made in a project that is no longer open.', recoverable: false } });
    return this.session.undoEntry(entryId);
  }

  /** What an AI turn's History step changed and what came after it (see ProjectSession.reviewAiEntry), in the opening `key`. */
  async reviewAiTurn(entryId: string, key: string): Promise<{ ok: boolean; message?: string; review?: AiTurnReview }> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    return s.reviewAiEntry(entryId);
  }

  /** Take an AI turn back on its own as reviewed (see ProjectSession.revertAiEntry), in the opening `key` only. */
  revertAiTurn(entryId: string, expected: { revision: number; history: string }, key: string): Promise<ApplyResult> {
    if (!this.session || !key || this.workspaceKey !== key)
      return Promise.resolve({ ok: false, revision: this.session?.revision ?? 0, error: { code: 'CONFLICT', message: 'That change was made in a project that is no longer open.', recoverable: false } });
    // The AI owns the project from the moment it starts, before its run takes the session's write lock.
    if (this.aiBusy()) return Promise.resolve({ ok: false, revision: this.session.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } });
    return this.session.revertAiEntry(entryId, expected);
  }

  /**
   * Step History to the entry chosen in it (see ProjectSession.stepTo), as it was shown (`expected`). `key` is the
   * opening of the project History was shown for: a choice left over from a project that has since closed never
   * reaches another one.
   */
  stepHistory(entryId: string, direction: 'undo' | 'redo', expected: { revision?: number; count?: number }, key: string): Promise<ApplyResult> {
    if (!this.session || !key || this.workspaceKey !== key)
      return Promise.resolve({ ok: false, revision: this.session?.revision ?? 0, error: { code: 'CONFLICT', message: 'That change was made in a project that is no longer open.', recoverable: false } });
    // The AI owns the project from the moment it starts, before its run takes the session's write lock.
    if (this.aiBusy()) return Promise.resolve({ ok: false, revision: this.session.revision, error: { code: 'BUSY', message: `Stop the AI before ${direction === 'undo' ? 'undoing' : 'redoing'}.`, recoverable: true } });
    return this.session.stepTo(entryId, direction, expected);
  }

  /** What the open project's media and undo history take on disk, and what freeing up space would do. */
  async storageInfo(key: string): Promise<StorageInfo | null> {
    const s = this.session;
    if (!s || !key || this.workspaceKey !== key) return null;
    const info = await s.storageInfo();
    if (this.session !== s || this.workspaceKey !== key) return null;
    return !info.blocked && this.aiBusy() ? { ...info, blocked: 'Wait for the AI to finish, then try again.' } : info;
  }

  /**
   * Free the space `plan` (from storageInfo) offered in the opening `key` of the project. Undo steps the plan named
   * are dropped for good, so only a plan the author confirmed is carried out, and only in the project it was made for.
   */
  async reclaimStorage(plan: string, key: string): Promise<{ ok: boolean; message?: string; freed?: number }> {
    const s = this.session;
    if (!s || !key || this.workspaceKey !== key || this.closing) return { ok: false, message: 'That project is no longer open.' };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish, then try again.' };
    return s.reclaimStorage(plan);
  }

  /** The open project in the opening `key`, while it is not closing; otherwise why not. */
  private openedAs(key: string): ProjectSession | null {
    const s = this.session;
    return s && key && this.workspaceKey === key && !this.closing ? s : null;
  }

  /**
   * Copy page content for the editor's Paste, in the opening `key` only (#240): a Copy pressed in one project never
   * reads another that opened meanwhile, which may be a duplicate holding the same page and element IDs.
   */
  copy(pageId: string, nodeId: string | readonly string[], expectedRevision: number, key: string): Promise<{ ok: boolean; clipboardId?: string; message?: string }> {
    const s = this.openedAs(key);
    if (!s) return Promise.resolve({ ok: false, message: 'That project is no longer open.' });
    return s.copy(pageId, nodeId, expectedRevision);
  }

  /** Save the site as it is now as a named version (issue 260), in the opening `key` only. */
  async saveVersion(name: string, key: string): Promise<{ ok: boolean; message?: string; id?: string; missing?: string[] }> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish, then try again.' };
    return s.saveVersion(name);
  }

  /** What restoring saved version `id` would change in the opening `key`. */
  async reviewVersion(id: string, key: string): Promise<{ ok: boolean; message?: string; review?: VersionReview }> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    return s.reviewVersion(id);
  }

  /** Restore saved version `id` as reviewed at `revision` with the `reviewed` files to put back, in the opening `key` only. */
  async restoreVersion(id: string, revision: number, reviewed: { files: string[]; replaced: string[] }, key: string): Promise<RestoreVersionResult> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish, then try again.' };
    return s.restoreVersion(id, revision, reviewed);
  }

  /** Rename saved version `id` in the opening `key` only. */
  async renameVersion(id: string, name: string, key: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    return s.renameVersion(id, name);
  }

  /** Delete saved version `id` in the opening `key` only. */
  async deleteVersion(id: string, key: string): Promise<{ ok: boolean; message?: string; freed?: number }> {
    const s = this.openedAs(key);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    return s.deleteVersion(id);
  }

  /** What private metadata an image asset's original carries. Only a library file inside the project is read. */
  async photoMetadata(assetId: string): Promise<{ location: boolean; device: boolean } | null> {
    const s = this.session;
    const a = s?.state.assets.assets[assetId];
    const buf = s && a ? await readLibraryImage(s.dir, a) : null;
    return buf ? photoMetadata(buf) : null;
  }

  /** The file chooser for importing: images (HEIC photos included), fonts, documents, or all of them. Null when it was closed. */
  private async chooseImportFiles(only?: 'image' | 'font' | 'document'): Promise<string[] | null> {
    const groups = { image: { name: 'Images', extensions: IMPORT_IMAGE_EXTENSIONS }, font: { name: 'Fonts', extensions: FONT_EXTENSIONS }, document: { name: 'Documents', extensions: DOCUMENT_EXTENSIONS } };
    const r = await dialog.showOpenDialog(this.getWindow()!, {
      title: only === 'font' ? 'Import fonts' : only === 'image' ? 'Import images' : only === 'document' ? 'Import documents' : 'Import images, fonts or documents',
      properties: ['openFile', 'multiSelections'],
      filters: only ? [groups[only]] : [{ name: 'Images, fonts and documents', extensions: [...IMPORT_IMAGE_EXTENSIONS, ...FONT_EXTENSIONS, ...DOCUMENT_EXTENSIONS] }, groups.image, groups.font, groups.document]
    });
    return r.canceled ? null : r.filePaths;
  }

  /** The platform's HEIC decoder (sips on macOS), or null where there is none. */
  photoDecoder: PhotoDecoder | null = heicDecoder();

  /**
   * Imports into the project one at a time: each batch finds the pictures the one before it added, so the same
   * photo imported twice at once is still one asset. The slow work of a batch happens inside, so a second batch
   * waits for the first.
   */
  private importQueue: Promise<unknown> = Promise.resolve();
  private serialImport<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.importQueue.then(fn, fn);
    this.importQueue = p.catch(() => undefined);
    return p;
  }

  /**
   * Choose files to import (the chooser, unless `paths` are given) and say what each would become, writing nothing:
   * which HEIC photos are converted, which large photos could be added as web-sized copies, which can't be added.
   */
  async reviewImport(paths?: string[], only?: 'image' | 'font' | 'document'): Promise<ImportReview | null> {
    return timed('controller.reviewImport', () => this.reviewImportNow(paths, only), (r) => ({ rows: r?.rows.length ?? 0 }))();
  }

  private async reviewImportNow(paths?: string[], only?: 'image' | 'font' | 'document'): Promise<ImportReview | null> {
    const s = this.session;
    if (!s) return null;
    // A read-only project imports nothing: the import that follows says why.
    if (s.readOnly) return { paths: paths ?? [], rows: [] };
    const files = paths ?? (await this.chooseImportFiles(only));
    if (!files || this.session !== s) return null;
    const rows: ImportReviewRow[] = [];
    for (const f of files) {
      const name = basename(f);
      if ((!only || only === 'image') && isAssetOfKind(f, 'image')) rows.push(await reviewImportFile(f, { converter: !!this.photoDecoder, opaque: isOpaquePicture }));
      else if (only ? isAssetOfKind(f, only) : isAssetOfKind(f, 'font') || isAssetOfKind(f, 'document')) rows.push({ path: f, name, bytes: 0, action: 'import' });
      // What the import would skip or refuse, the review names, so it is never counted among the files added.
      else rows.push({ path: f, name, bytes: 0, action: 'refuse', reason: only ? `it is not ${only === 'font' ? 'a font' : only === 'document' ? 'a document' : 'an image'}.` : 'only JPEG, PNG, WebP, GIF, AVIF, SVG and HEIC images, WOFF2 or WOFF fonts, and PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP documents can be added.' });
    }
    return { paths: files, rows };
  }

  /**
   * Import files. `only` limits a picker that can only use one kind, before anything is written to the project.
   * `choices` is what the author confirmed in a review (see reviewImport): it holds for the opening it was made in.
   */
  async importAssets(paths?: string[], only?: 'image' | 'font' | 'document', choices?: ImportChoices): Promise<{ ok: boolean; assetIds: string[]; message?: string; note?: string }> {
    const s = this.session;
    if (!s) return { ok: false, assetIds: [] };
    if (s.readOnly) return { ok: false, assetIds: [], message: s.readOnly.reason };
    if (choices && choices.opening !== this.workspaceKey) return { ok: false, assetIds: [], message: 'The project was closed before the files could be added.' };
    // Only no paths at all opens the chooser: an empty list (a review that left nothing to add) adds nothing.
    const files = paths ?? (await this.chooseImportFiles(only));
    if (!files) return { ok: false, assetIds: [] };
    if (this.session !== s) return { ok: false, assetIds: [], message: 'The project was closed before the files could be added.' };
    const picked = only ? files.filter((f) => isAssetOfKind(f, only)) : files;
    const refused = files.length - picked.length;
    const reviewed = new Map((choices?.files ?? []).map((f) => [f.path, f]));
    // Files are written before their asset records exist, so the session holds off sweeping assets meanwhile.
    return this.serialImport(timed('controller.importAssets', () => s.withImport(async () => {
      const ids: string[] = [];
      const errors: string[] = refused ? [`${refused} file${refused === 1 ? ' was' : 's were'} skipped because ${refused === 1 ? 'it is' : 'they are'} not ${only === 'font' ? 'a font' : only === 'document' ? 'a document' : 'an image'}.`] : [];
      const notes: string[] = [];
      const ops: Array<{ type: 'asset.add'; asset: AssetRecord }> = [];
      const backfills = [];
      // Files imported earlier in this batch count as existing too: the same picture dropped twice is one asset.
      const known = Object.values(s.state.assets.assets);
      // One time for the whole import, so the images it adds are listed together and by name.
      const createdAt = new Date().toISOString();
      // A few at a time, as many as the media worker makes at once; what each did is told in the files' order.
      // Written only while the project is still open and this app's; the decoding and converting are done before.
      const outcomes = await importAssetBatch(
        s.dir,
        picked.map((f) => {
          const r = reviewed.get(f);
          return { path: f, opts: { decoder: this.photoDecoder, createdAt, ...(r ? { webCopy: r.webCopy, fingerprint: r.fingerprint } : {}) } };
        }),
        known,
        this.writeFence(s),
        // A project closed or taken over meanwhile gets nothing more: the rest of the batch is not converted for nothing.
        { parallel: MEDIA_PARALLEL, go: () => this.session === s && !this.closing }
      );
      const started = outcomes.findIndex((o) => !o);
      for (const o of started < 0 ? outcomes : outcomes.slice(0, started)) {
        if (!o) continue;
        if ('error' in o) {
          errors.push(o.error.message);
          continue;
        }
        const { record, existing, font, note } = o;
        if (note) notes.push(note);
        if (!ids.includes(record.id)) ids.push(record.id);
        if (font) backfills.push({ type: 'asset.update' as const, assetId: record.id, font });
        if (!existing) ops.push({ type: 'asset.add' as const, asset: record });
      }
      if (started >= 0) errors.push(`${picked.length - started === 1 ? `${basename(picked[started])} was` : `${picked.length - started} files were`} not added because the project was closed.`);
      if (backfills.length) {
        const r = await s.apply({ operations: backfills }, { label: 'Update font details', source: 'user' });
        if (!r.ok) errors.push(r.error?.message ?? 'The font details could not be updated.');
      }
      if (ops.length) {
        const kinds = ['font', 'image', 'document'] as const;
        const one = kinds.find((k) => ops.every((o) => o.asset.kind === k));
        const noun = one ? [one, `${one}s`] : ['file', 'files'];
        const r = await s.apply({ operations: ops }, { label: ops.length === 1 ? `Import ${noun[0]}` : `Import ${ops.length} ${noun[1]}`, source: 'user' });
        if (!r.ok) return { ok: false, assetIds: [], message: r.error?.message };
      }
      return { ok: errors.length === 0, assetIds: ids, message: errors.join(' ') || undefined, ...(notes.length ? { note: notes.join(' ') } : {}) };
    }), (r) => ({ files: picked.length, added: r?.assetIds.length ?? 0 })));
  }

  /**
   * Save a project component as a package file another project can import (#371): the chooser offers a place unless
   * `dest` is given. `notes` says what the package leaves out (links to this site's pages, say).
   */
  async exportComponent(definitionId: string, dest?: string): Promise<ComponentExportResult> {
    const s = this.session;
    if (!s) return { ok: false };
    const state = s.state;
    const def = Object.hasOwn(state.components, definitionId) ? state.components[definitionId] : undefined;
    if (!def) return { ok: false, message: 'That component is no longer in this project.' };
    // One that can't travel says so before a chooser opens.
    try {
      planComponentPackage(state, definitionId);
    } catch (e) {
      return { ok: false, message: `“${def.name}” can’t be exported: ${(e as Error).message}` };
    }
    let file = dest;
    if (!file) {
      const r = await dialog.showSaveDialog(this.getWindow()!, {
        title: `Export ${def.name}`,
        defaultPath: join(app.getPath('documents'), packageFileName(def.name)),
        filters: [{ name: 'SiteOrigin component', extensions: ['json'] }],
        buttonLabel: 'Export',
        properties: ['showOverwriteConfirmation', 'createDirectory']
      });
      if (r.canceled || !r.filePath) return { ok: false };
      file = r.filePath;
    }
    // A package written into the project would replace one of its own files, outside its history.
    if (isInside(s.dir, file)) return { ok: false, message: 'Choose a location outside the project folder.' };
    try {
      const { text, notes } = await buildComponentPackage(s.dir, state, definitionId, `SiteOrigin Builder ${app.getVersion()}`);
      await atomicWrite(file, text);
      return { ok: true, path: file, notes };
    } catch (e) {
      return { ok: false, message: `“${def.name}” was not exported: ${(e as Error).message}` };
    }
  }

  /**
   * Import a component package (#371): the chooser offers one unless `path` is given. Its images are stored and its
   * components, site styles and image records land together as one change, or nothing lands. Returns the imported
   * component and the history entry to undo it with.
   */
  async importComponent(path?: string): Promise<ComponentImportResult> {
    const s = this.session;
    if (!s) return { ok: false };
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    const closed = { ok: false, message: 'The project was closed before the component could be imported.' };
    let file = path;
    if (!file) {
      const r = await dialog.showOpenDialog(this.getWindow()!, { title: 'Import a component', properties: ['openFile'], filters: [{ name: 'SiteOrigin component', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      file = r.filePaths[0];
    }
    if (this.session !== s || this.closing) return closed;
    if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before importing a component.' };
    let pkg: ComponentPackage;
    try {
      pkg = await readComponentPackage(file);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    // A path given directly is a test's, which has no one to ask about code (see landPackage).
    return this.landPackage(s, pkg, { ask: !path, closed });
  }

  /**
   * Land a package read and checked in this process in the open project `s`, as one change: its images are stored, and
   * its components, site styles and image records (and, with `place`, its placement, at `revision`) land together, or
   * nothing does. Code from a package runs on this computer whenever the site is previewed or built: whoever brings it
   * in decides, knowing that, before anything is written (`ask`; only a test's own path goes without).
   */
  private async landPackage(
    s: ProjectSession,
    pkg: ComponentPackage,
    opts: { ask: boolean; closed: ComponentImportResult; opening?: string; place?: Omit<ImportPlacement, 'nodeId'>; revision?: number; label?: string }
  ): Promise<ComponentImportResult & { nodeId?: string }> {
    const { closed } = opts;
    const current = () => this.session === s && !this.closing && (opts.opening === undefined || this.workspaceKey === opts.opening);
    const name = pkg.definitions.find((d) => d.id === pkg.rootId)?.name ?? 'the component';
    const verb = opts.place ? 'inserted' : 'imported';
    const stale = { ok: false, message: opts.place ? STALE_INSERT : `The project changed while “${name}” was being imported. Import it again.` };
    // The code it brings, worked out for the project as the place to put it was: the revision named must be this one.
    if (opts.revision !== undefined && s.revision !== opts.revision) return stale;
    const code = importedCode(s.state, { id: '', pkg, images: {} });
    if (code.length && opts.ask) {
      if (!(await loadSettings()).settings.developerMode) return { ok: false, message: `“${name}” includes code components, which need Developer mode. Turn on Developer mode in Settings to import it.` };
      const names = code.map((d) => `“${d.name}”`).join(', ');
      const r = await dialog.showMessageBox(this.getWindow()!, {
        type: 'warning',
        buttons: ['Cancel', 'Import code'],
        defaultId: 0,
        cancelId: 0,
        message: `“${name}” includes code`,
        detail: `This package brings code components (${names}). Their code runs on this computer whenever the site is previewed or built, and the checks it passes can't make code from someone else safe. Import it only from someone you trust.`
      });
      if (r.response !== 1) return { ok: false };
      if (!current()) return closed;
    }
    // Its images are written before their records exist, so the session holds off sweeping meanwhile.
    return this.serialImport(() =>
      s.withImport(async () => {
        if (!current()) return closed;
        if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before importing a component.' };
        if (s.readOnly) return { ok: false, message: s.readOnly.reason };
        // Waiting its turn behind another import, the project may have moved on from the place it was to go.
        if (opts.revision !== undefined && s.revision !== opts.revision) return stale;
        let prepared: PreparedImport;
        try {
          prepared = await preparePackageImport(s.dir, s.state, pkg, { codeAllowed: (await loadSettings()).settings.developerMode, fence: this.writeFence(s) });
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
        // Asked again now the images are in: Developer mode or the assistant may have changed meanwhile.
        if (!current()) return closed;
        if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before importing a component.' };
        const nodeId = opts.place ? newId('n') : undefined;
        if (opts.place) prepared.input.place = { ...opts.place, nodeId: nodeId! };
        const codeAllowed = (await loadSettings()).settings.developerMode;
        // The code asked about is the code that lands: the project may have changed (another theme, say) while this
        // waited, so code the author wasn't asked about stops it, and the change lands on the project as checked here.
        const asked = new Set(code.map((d) => d.id));
        if (opts.ask && importedCode(s.state, prepared.input).some((d) => !asked.has(d.id))) return stale;
        const r = await s.apply(
          // A placement lands only on the revision its place was worked out on; a file, on the project as just checked.
          { operations: [...prepared.assets, { type: 'component.import', importId: prepared.input.id }], expectedRevision: opts.revision ?? s.revision },
          { label: opts.label ?? `Import ${name}`, source: 'user', codeAllowed, componentImport: prepared.input }
        );
        if (!r.ok) {
          if (r.error?.code === 'STALE_REVISION') return stale;
          return { ok: false, message: `“${name}” was not ${verb}: ${(r.error?.message ?? 'it could not be added.').replace(/^Operation \d+ \([\w.]+\): /, '')}` };
        }
        const last = r.results?.at(-1);
        const definitionId = last?.definitionId;
        return { ok: true, definitionId: typeof definitionId === 'string' ? definitionId : undefined, name, entryId: r.entryId, revision: r.revision, ...(nodeId && last?.nodeId === nodeId ? { nodeId } : {}) };
      })
    );
  }

  /** The personal component library's folder (#372): on this computer, for every project. */
  private libraryRoot(): string {
    return join(app.getPath('userData'), 'saved-components');
  }

  /**
   * The personal component library, for the project open as `opening`: each saved component says whether it would bring
   * code into this project, so Insert lists it only in Developer mode.
   */
  async savedComponents(opening: string): Promise<SavedComponent[]> {
    const s = this.openedAs(opening);
    if (!s) return [];
    const state = s.state;
    return (await listSaved(this.libraryRoot())).map((c) => ({
      id: c.id,
      digest: c.digest,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      role: c.role,
      code: codeBrought(state, c.definitions).length > 0,
      savedAt: c.savedAt,
      ...(c.from ? { from: c.from } : {})
    }));
  }

  /**
   * Save a project component to the personal library (#372), as the package Export writes, so any project can insert
   * it. Saving it again replaces the earlier copy. `notes` says what the saved copy leaves out.
   */
  async saveComponentToLibrary(definitionId: string, opening: string): Promise<SaveToLibraryResult> {
    const s = this.openedAs(opening);
    if (!s) return { ok: false, message: 'That project is no longer open.' };
    const state = s.state;
    const def = Object.hasOwn(state.components, definitionId) ? state.components[definitionId] : undefined;
    if (!def || def.owner !== 'project' || def.category === 'shell') return { ok: false, message: 'That component is no longer in this project.' };
    try {
      const { text, notes, pkg } = await buildComponentPackage(s.dir, state, definitionId, `SiteOrigin Builder ${app.getVersion()}`);
      // Only a package this app can bring up to date and import is kept (a project from a newer app, opened read-only,
      // could make one it can't), so a saved copy never replaces a working one with one that won't insert.
      migratePackage(pkg);
      const { card, replaced } = await saveToLibrary(this.libraryRoot(), {
        text,
        name: def.name,
        ...(def.description ? { description: def.description } : {}),
        role: definitionRole(state, definitionId),
        definitions: packagedDefinitions(pkg.definitions),
        from: projectDisplayName(state),
        origin: { projectId: state.manifest.projectId, definitionId }
      });
      return { ok: true, id: card.id, name: card.name, replaced, notes };
    } catch (e) {
      return { ok: false, message: `“${def.name}” was not saved to your library: ${(e as Error).message}` };
    }
  }

  /** Take generation `digest` of a component out of the personal library; a newer save of it stays (`changed`). */
  async removeSavedComponent(id: string, digest: string): Promise<'removed' | 'changed' | 'gone'> {
    return removeSaved(this.libraryRoot(), id, digest);
  }

  /**
   * Insert a saved component (#372) into the project open as `opening`, still at `revision`: its package is read from
   * the library and imported, with the component placed at `place` as its role says, as one change, so one Undo takes
   * both back. A saved file may have been changed by anything on this computer since it was saved, so code it would
   * bring always needs Developer mode and the author's say-so, as a file chosen to import does.
   */
  async insertSavedComponent(id: string, digest: string, place: SavedInsertPlace, opening: string, revision: number): Promise<SavedInsertResult> {
    const s = this.openedAs(opening);
    const closed = { ok: false, message: 'The project was closed before the component could be inserted.' };
    if (!s) return closed;
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before inserting a component.' };
    const root = this.libraryRoot();
    const gone = { ok: false, gone: true, message: 'That component is no longer in your library.' };
    const card = await findSaved(root, id);
    if (!card) return gone;
    // Saved again since the list was shown: the author picked the copy they saw, so the list is shown afresh first.
    if (card.digest !== digest) return { ok: false, gone: true, message: `“${card.name}” was saved again since Insert listed it. Choose it again to insert the newer copy.` };
    let pkg: ComponentPackage;
    try {
      pkg = await readComponentPackage(savedPackagePath(root, card));
    } catch (e) {
      // Removed or saved again while it was being read.
      if ((await findSaved(root, id))?.digest !== digest) return gone;
      return { ok: false, message: `“${card.name}” could not be read from your library. ${(e as Error).message}` };
    }
    if (!this.openedAs(opening)) return closed;
    const name = pkg.definitions.find((d) => d.id === pkg.rootId)?.name ?? card.name;
    return this.landPackage(s, pkg, { ask: true, closed, opening, revision, place: { ...place, role: card.role }, label: `Insert ${name}` });
  }

  /**
   * The posts import under review (#399): the plan shown to the author, bound to the project and the revision it was
   * made against. Importing takes it, once; anything else that changes the project makes it stale.
   */
  private postImport: { id: string; session: ProjectSession; opening: string; revision: number; plan: PostImportPlan; realRoot: string } | null = null;

  /**
   * Choose a WordPress export or a folder of Markdown posts (the chooser, unless `path` is given), read it in the
   * import reader, and plan the import, writing nothing. The review replaces any earlier one.
   */
  async reviewPostImport(kind: PostImportKind, opening: string, path?: string): Promise<PostImportReviewResult> {
    const s = this.session;
    const closed = { ok: false as const, message: 'The project was closed before the posts could be read.' };
    if (!s || opening !== this.workspaceKey || this.closing) return closed;
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    this.postImport = null;
    let file = path;
    if (!file) {
      const r =
        kind === 'wordpress'
          ? await dialog.showOpenDialog(this.getWindow()!, { title: 'Import posts from WordPress', buttonLabel: 'Read', properties: ['openFile'], filters: [{ name: 'WordPress export', extensions: ['xml'] }] })
          : await dialog.showOpenDialog(this.getWindow()!, { title: 'Import a folder of Markdown posts', buttonLabel: 'Read', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      file = r.filePaths[0];
    }
    if (this.session !== s || opening !== this.workspaceKey || this.closing) return closed;
    // The pages the reader links to and the project the plan is made against are the same revision of it.
    const revision = s.revision;
    const pages = Object.fromEntries(Object.values(s.state.pages).map((p) => [p.id, { id: p.id, route: p.route }]));
    let source: ParsedSource;
    try {
      source = await postReader.read(kind, file, pages);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (this.session !== s || opening !== this.workspaceKey || this.closing) return closed;
    if (s.revision !== revision) return { ok: false, message: 'The project changed while the posts were being read. Choose Import posts again.' };
    const plan = planPostImport(s.state, source);
    const id = randomUUID();
    // Pictures are read later from the very folder the reader checked them in, never one moved into its place.
    this.postImport = { id, session: s, opening, revision, plan, realRoot: source.realRoot };
    return { ok: true, preview: postImportPreview(id, plan) };
  }

  /** Forget review `id`. */
  cancelPostImport(id: string): void {
    if (this.postImport?.id === id) this.postImport = null;
  }

  /**
   * Import the posts of review `id`: their pictures become library images (checked, with their responsive copies),
   * then the collection, its categories and tags, the entries and their old addresses land as one change, or nothing
   * does. Refused once the project has changed since the review.
   */
  async commitPostImport(id: string, opening: string): Promise<PostImportResult> {
    const pending = this.postImport;
    if (!pending || pending.id !== id) return { ok: false, message: 'This import was already finished or canceled. Choose Import posts again.' };
    this.postImport = null;
    const s = this.session;
    const closed = { ok: false, message: 'The project was closed before the posts could be imported.' };
    const stale = { ok: false, message: 'The project changed while the import was being reviewed, so nothing was imported. Choose Import posts again to see what it would do now.' };
    const busy = { ok: false, message: 'The AI is making changes. Stop it before importing posts.' };
    const open = () => !!s && this.session === s && s === pending.session && opening === pending.opening && opening === this.workspaceKey && !this.closing;
    if (!s || !open()) return closed;
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    const { plan } = pending;
    if (plan.problems.length) return { ok: false, message: plan.problems[0] };
    if (this.aiBusy()) return busy;
    if (s.revision !== pending.revision) return stale;
    // The pictures are written before their records exist, so the session holds off sweeping meanwhile.
    return this.serialImport(() =>
      s.withImport(async (): Promise<PostImportResult> => {
        if (!open()) return closed;
        if (s.revision !== pending.revision) return stale;
        const known = Object.values(s.state.assets.assets);
        const createdAt = new Date().toISOString();
        const assetIds = new Map<string, string>();
        const byFile = new Map<string, string>();
        const added: AssetRecord[] = [];
        const notes: NonNullable<PostImportResult['notes']> = [];
        // The posts each picture is shown in, so a picture that can't be added says where it is missing.
        const shownIn = (key: string) => plan.posts.filter((p) => p.featured === key || p.body.some((b) => isImageBlock(b) && b.assetId === key)).map((p) => p.title);
        for (const m of plan.media) {
          if (!open()) return closed;
          if (!m.path) continue;
          const already = byFile.get(m.path);
          if (already) {
            assetIds.set(m.key, already);
            continue;
          }
          const ext = extname(m.path).toLowerCase();
          const shown = basename(m.path);
          try {
            const mime = pictureMime(ext);
            if (!mime) throw new Error(`${shown} was not imported: it is not a picture the library takes.`);
            // Read from the very file checked to be inside the chosen folder.
            const bytes = await readContained(pending.realRoot, m.path, MAX_PICTURE_BYTES).catch((e: Error) => {
              throw new Error(`${shown} was not imported: ${e.message}`);
            });
            const name = shown.slice(0, -ext.length).replace(/[-_]+/g, ' ').trim() || 'Image';
            const { record, existing } = await importPackageImage(s.dir, { name, mime, ext, bytes }, known, this.writeFence(s), createdAt);
            if (!existing) {
              // As the disk spells it: a post can name loaf.jpg and find Loaf.JPG where names ignore case.
              record.originalName = originalNameOf(await fs.realpath(m.path).catch(() => m.path!));
              added.push(record);
              known.push(record);
            }
            assetIds.set(m.key, record.id);
            byFile.set(m.path, record.id);
          } catch (e) {
            // Its reason alone: the result names the file and its posts beside it.
            const file = basename(m.path);
            const message = (e as Error).message;
            // The library's messages begin "{its name} was not imported because …" (or ": …"), the name as it spelled it.
            const said = /^.*? was not imported(?::| because)\s*/.exec(message);
            const reason = said ? message.slice(said[0].length) : message;
            notes.push({ file, posts: shownIn(m.key), reason });
          }
        }
        if (!open()) return closed;
        if (this.aiBusy()) return busy;
        const n = plan.posts.length;
        const r = await s.apply({ operations: planOperations(plan, assetIds, added), expectedRevision: pending.revision }, { label: n === 1 ? 'Import a post' : `Import ${n} posts`, source: 'user' });
        if (!r.ok) {
          if (r.error?.code === 'STALE_REVISION') return stale;
          return { ok: false, message: `The posts were not imported: ${(r.error?.message ?? 'they could not be added.').replace(/^Operation \d+ \([\w.]+\): /, '')}` };
        }
        return { ok: true, imported: n, entryId: r.entryId, revision: r.revision, firstEntryId: plan.posts[0]?.entryId, ...(notes.length ? { notes } : {}) };
      })
    );
  }

  /** The source syncs in progress: each is ended when its project closes. */
  private sourceSyncs = new Set<AbortController>();

  /**
   * Sync external source `sourceId` of the open project into its collection (#676): its records are read in the sync
   * worker, signed in with the secrets the source names, and land as one change against the revision the sync began
   * from, or nothing does.
   */
  async syncSource(sourceId: string, opening: string): Promise<SourceSyncResult> {
    const s = this.session;
    const closed = { ok: false as const, message: 'The project was closed before the source was synced.' };
    if (!s || opening !== this.workspaceKey || this.closing) return closed;
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before syncing a source.' };
    const abort = new AbortController();
    this.sourceSyncs.add(abort);
    const current = () => !abort.signal.aborted && this.session === s && opening === this.workspaceKey && !this.closing;
    try {
      return await this.serialImport(async () => {
        if (!current()) return closed;
        return syncSource(
          {
            session: s,
            runner: sourceSyncRunner,
            secrets: sourceSecrets,
            approvals: sourceApprovals,
            current,
            signal: abort.signal,
            importImage: (img, known, createdAt) => importPackageImage(s.dir, { name: img.name, mime: img.mime, ext: img.ext, bytes: Buffer.from(img.bytes) }, known, this.writeFence(s), createdAt)
          },
          sourceId
        );
      });
    } finally {
      this.sourceSyncs.delete(abort);
    }
  }

  /**
   * Why the project's external sources' settings cannot go into a copy of it, or null: the folder holds them otherwise
   * than the project does, or they hold one of the user's saved secrets. Secrets that cannot be read stop a copy of a
   * project that has sources, since nothing then says they are not there.
   */
  private async sourcesCopyProblem(s: ProjectSession): Promise<string | null> {
    const has = Object.keys(s.state.sources ?? {}).length > 0;
    let values: string[] = [];
    try {
      values = await sourceSecrets.values(s.state.manifest.projectId);
    } catch (e) {
      if (has) return `${(e as Error).message} The project's external sources cannot be checked for them.`;
    }
    return exportedSourcesProblem(s.dir, s.state, values);
  }

  /**
   * The open project with source settings `draft` saved in it, as `source.upsert` saves them, or why they cannot be:
   * the engine's own reasons, a converter that may not run (each problem by its line), or one of the user's saved
   * secrets written into them.
   */
  private sourceDraft(s: ProjectSession, draft: SourceSettingsDraft): Promise<{ state: ProjectState; source: SourceDoc } | { message: string }> {
    return sourceDraftState(s.state, draft, sourceSecrets);
  }

  /**
   * Test source settings `draft` against what the source has now (#678): every record read and put in shape in the
   * sync worker, and checked as a sync would write it, with nothing written. The first few come back, as the source
   * sent them and as entries.
   */
  async testSource(draft: SourceSettingsDraft, opening: string): Promise<SourceSampleResult> {
    const s = this.session;
    const closed = { ok: false as const, message: 'The project was closed before the source was tested.' };
    if (!s || opening !== this.workspaceKey || this.closing) return closed;
    // Ended with the project from the start, so no source is asked anything once it has closed.
    const abort = new AbortController();
    this.sourceSyncs.add(abort);
    try {
      const made = await this.sourceDraft(s, draft);
      if ('message' in made) return { ok: false, message: made.message };
      if (abort.signal.aborted || this.session !== s || opening !== this.workspaceKey || this.closing) return closed;
      const r = await sampleSource({ runner: sourceSyncRunner, secrets: sourceSecrets, signal: abort.signal }, made.state, made.source);
      if (this.session !== s || opening !== this.workspaceKey) return { ok: false, message: 'The project was closed before the source was tested.' };
      return r;
    } finally {
      this.sourceSyncs.delete(abort);
    }
  }

  /**
   * Save source settings `draft`, once a Test of them now passes: a source is never saved that its next sync would
   * refuse, so a bad converter or mapping never claims its collection. Saved against the project as it was tested.
   */
  async saveSource(draft: SourceSettingsDraft, opening: string, base: string | null = null): Promise<{ ok: true; revision: number } | { ok: false; message: string }> {
    const s = this.session;
    if (!s || opening !== this.workspaceKey || this.closing) return { ok: false, message: 'The project was closed before the source was saved.' };
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before changing a source.' };
    // Saved over the source's settings as the dialog was opened on them, never over a later change (its converter.mjs
    // edited outside the app, say).
    const now = Object.hasOwn(s.state.sources ?? {}, draft.sourceId) ? s.state.sources![draft.sourceId] : null;
    if (sourceFingerprint(now) !== (base ?? sourceFingerprint(null))) return { ok: false, message: 'The source’s settings changed since they were opened here. Close this and open them again.' };
    const revision = s.revision;
    const tested = await this.testSource(draft, opening);
    if (!tested.ok) return tested;
    if (this.session !== s || opening !== this.workspaceKey || this.closing) return { ok: false, message: 'The project was closed before the source was saved.' };
    if (this.aiBusy()) return { ok: false, message: 'The AI is making changes. Stop it before changing a source.' };
    const r = await s.apply({ operations: [{ ...draft, type: 'source.upsert' } as EditOperation], expectedRevision: revision }, { label: `Save “${draft.name.trim()}”`, source: 'user' });
    if (!r.ok) return { ok: false, message: r.error?.code === 'STALE_REVISION' ? 'The project changed while the source was being tested. Save it again.' : (r.error?.message ?? 'The source could not be saved.') };
    // Tested and saved here: these settings may sign in with the user's secrets.
    const saved = s.state.sources?.[draft.sourceId];
    if (saved) await sourceApprovals.approve(s.state.manifest.projectId, saved).catch(() => undefined);
    return { ok: true, revision: r.revision };
  }

  /** The assistant's side of the open project's external sources (#680), each run's ended with its signal and the project. */
  private agentSourceHost = createAgentSources({
    project: () => (this.session && !this.closing ? this.session : null),
    runner: sourceSyncRunner,
    secrets: sourceSecrets,
    approvals: sourceApprovals,
    track: (abort) => {
      this.sourceSyncs.add(abort);
      return () => this.sourceSyncs.delete(abort);
    }
  });

  /** The source tools' host for one run (#680), ended with `signal`. */
  agentSources(signal: AbortSignal): SourceToolHost {
    return this.agentSourceHost(signal);
  }

  /** The names of the secrets the open project's sources can sign in with, never their values. */
  async sourceSecretNames(opening: string): Promise<string[]> {
    const s = this.session;
    return s && opening === this.workspaceKey ? sourceSecrets.names(s.state.manifest.projectId) : [];
  }

  /** Keep `value` as the open project's source secret `name`, in the user's own source-secrets.json, or forget it (null). */
  async setSourceSecret(name: string, value: string | null, opening: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s || opening !== this.workspaceKey || this.closing) return { ok: false, message: 'No project is open.' };
    try {
      await sourceSecrets.set(s.state.manifest.projectId, name, value);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * An imported font file's bytes, for the editor to draw its samples in the file itself, and the alphabets it covers.
   * Null when the project has moved on (`opening`), the record is not a sound font, or the file can't be read.
   */
  async fontFile(assetId: string, opening: string): Promise<FontFileData | null> {
    const s = this.session;
    if (!s || opening !== this.workspaceKey) return null;
    const a = s.state.assets.assets[assetId];
    if (!a || a.id !== assetId || !isValidFontAsset(a)) return null;
    try {
      // Only a file really inside the project, wherever a link in its path leads, and no larger than it was checked.
      const [root, path] = await Promise.all([fs.realpath(s.dir), fs.realpath(join(s.dir, a.file))]);
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
      // Opened without waiting, so a pipe at the path can never hold the read up; it is no file and is refused.
      const fh = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_FONT_FILE) return null;
        const bytes = await fh.readFile();
        return { bytes, coverage: await fontCoverage(bytes) };
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  /** What a web-sized copy of a large library image would be (see libraryWebCopyPlan). */
  async webCopyPlan(assetId: string): Promise<WebCopyPlan> {
    const s = this.session;
    const a = s?.state.assets.assets[assetId];
    const buf = s && a ? await readLibraryImage(s.dir, a) : null;
    return a && buf && sha(buf) === a.hash ? libraryWebCopyPlan(a, buf) : null;
  }

  /**
   * Add a web-sized copy of a large library image to Assets, and with `replace` show it wherever the image is
   * used, in one change that can be undone. The original stays in Assets, so nothing is lost.
   */
  async makeWebCopy(assetId: string, opts: { replace: boolean; opening: string }): Promise<{ ok: boolean; assetId?: string; entryId?: string; revision?: number; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false };
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    if (opts.opening !== this.workspaceKey) return { ok: false, message: 'The project was closed before the copy could be made.' };
    const record = s.state.assets.assets[assetId];
    if (record?.kind !== 'image') return { ok: false, message: 'That image is no longer in the library.' };
    const name = record.name.trim() || 'The image';
    const buf = await readLibraryImage(s.dir, record);
    if (!buf) return { ok: false, message: `The original file of ${name} is missing. Locate it first.` };
    return this.serialImport(() =>
      s.withImport(async () => {
        try {
          const at = { revision: -1 };
          const made = await storeLibraryWebCopy(s.dir, record, buf, Object.values(s.state.assets.assets), this.assetFence(s, record, at));
          if ('lighter' in made) return { ok: false, message: `A web-sized copy of ${name} would be less than a third lighter, so it was left as it is.` };
          const ops = [
            ...(made.existing ? [] : [{ type: 'asset.add' as const, asset: made.record }]),
            // The copy is the same picture: every use keeps its alt text, whatever the copy's own suggestion says.
            ...(opts.replace ? [{ type: 'asset.replace' as const, assetId, withAssetId: made.record.id, keepAlt: true }] : [])
          ];
          const label = opts.replace ? `Use a web-sized copy of ${name}` : `Make a web-sized copy of ${name}`;
          // The image, and a library copy reused for it, must still be the pictures they were: a relink meanwhile would
          // otherwise show some other picture in every place the image is used.
          const fresh = () => {
            const now = s.state.assets.assets[assetId];
            const copy = s.state.assets.assets[made.record.id];
            return now?.file === record.file && now.hash === record.hash && (!made.existing || (copy?.file === made.record.file && copy.hash === made.record.hash));
          };
          const changed = { ok: false, message: `${name} changed while its copy was being made, so nothing was changed. Try again.` };
          if (!fresh()) return changed;
          if (!ops.length) return { ok: true, assetId: made.record.id, message: `${made.record.name} is already in Assets.` };
          // Only on top of the project as it was when the copy was written (or now, when nothing was written); an
          // unrelated change meanwhile is no reason to fail, as long as both pictures are as they were.
          const apply = (expectedRevision: number) => s.apply({ operations: ops, expectedRevision }, { label, source: 'user' });
          let r = await apply(at.revision >= 0 ? at.revision : s.revision);
          if (r.error?.code === 'STALE_REVISION' && fresh()) r = await apply(s.revision);
          if (r.error?.code === 'STALE_REVISION') return changed;
          if (!r.ok) return { ok: false, message: r.error?.message ?? `The web-sized copy of ${name} could not be added.` };
          return { ok: true, assetId: made.record.id, entryId: r.entryId, revision: r.revision };
        } catch (e) {
          if (e instanceof AssetChanged) return { ok: false, message: `${name} changed while its copy was being made. Look at it again in Assets.` };
          return { ok: false, message: (e as Error).message };
        }
      })
    );
  }

  /**
   * Find the file of a library image whose original is missing. The same picture is put back where the library
   * expects it, with its smaller copies, and the project itself does not change. A different picture becomes the
   * image's file (one step that can be undone), so every use, with its alt text, shows it. `path` skips the dialog.
   */
  async locateAsset(assetId: string, path?: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false };
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    const before = s.state.assets.assets[assetId];
    // A document's file can be swapped for a new version whenever the author likes: its links follow.
    const document = before?.kind === 'document';
    const what = document ? 'document' : 'image';
    const gone = { ok: false, message: `That ${what} is no longer in the library.` };
    if (before?.kind !== 'image' && !document) return gone;
    let file = path;
    if (!file) {
      const r = await dialog.showOpenDialog(this.getWindow()!, {
        title: document ? `Choose a file for ${before.name || 'the document'}` : `Locate ${before.name || 'the image'}`,
        buttonLabel: 'Use this file',
        properties: ['openFile'],
        filters: [document ? { name: 'Documents', extensions: DOCUMENT_EXTENSIONS } : { name: 'Images', extensions: IMAGE_EXTENSIONS }]
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      file = r.filePaths[0];
    }
    const closed = { ok: false, message: `The project was closed, or another app took it over, before the ${what} could be ${document ? 'given its file' : 'located'}.` };
    if (this.session !== s) return closed;
    // A new file is written before the record names it, so the session holds off sweeping assets meanwhile. It waits
    // for imports in progress too, so a batch's duplicate check never meets a record whose file changed under it.
    return this.serialImport(() => s.withImport(async () => {
      // The dialog gave the library time to change: a file chosen for what the image was then is not used for what it is now.
      const record = s.state.assets.assets[assetId];
      if (record?.kind !== before.kind) return gone;
      const name = record.name.trim() || (document ? 'The document' : 'The image');
      if (record.file !== before.file || record.hash !== before.hash) return { ok: false, message: `${name} changed while the file was being chosen. Look at it again in Assets.` };
      try {
        const at = { revision: -1 };
        const found = await locateAssetFile(s.dir, record, file, this.assetFence(s, record, at), Object.values(s.state.assets.assets));
        if (found.same) {
          await this.checkAssetFiles(s);
          if (document) return { ok: true, message: found.written.length ? `${name} is back in the project folder.` : `${name} already has that file.` };
          if (found.failed.length) return { ok: false, message: `${name} is back, but ${missingParts({ original: false, variants: found.failed })} could not be made again. Make the copies again in Assets.` };
          return { ok: true, message: `${name} is back in the project folder.` };
        }
        // Only on top of the project as it was when the files were written: a relink that landed meanwhile wins.
        const relink = (expectedRevision: number) => s.apply({ operations: [{ type: 'asset.relink', assetId, ...found.stored }], expectedRevision }, { label: document ? `Replace the file of ${name}` : `Relink ${name}`, source: 'user' });
        let r = await relink(at.revision);
        // An unrelated change that landed meanwhile is no reason to fail, as long as the image itself is as it was.
        const still = s.state.assets.assets[assetId];
        if (r.error?.code === 'STALE_REVISION' && still?.file === record.file && still.hash === record.hash) r = await relink(s.revision);
        if (r.error?.code === 'STALE_REVISION') return { ok: false, message: `The project changed while ${basename(file)} was being stored, so ${name} was left as it is. Locate the file again.` };
        if (!r.ok) return { ok: false, message: r.error?.message ?? `${name} could not be given the new file.` };
        return { ok: true, message: document ? `Every link to ${name} now downloads ${basename(file)}.` : `${basename(file)} now shows wherever ${name} is used.` };
      } catch (e) {
        if (e instanceof AssetChanged) return { ok: false, message: `${name} changed while the file was being chosen. Look at it again in Assets.` };
        return { ok: false, message: (e as Error).message };
      }
    }));
  }

  /**
   * Writes for one library image happen only while the project is still this one, open and owned by this app, and
   * the image still has the file they were made for; the slow part (decoding, resizing) is done before.
   */
  private assetFence(s: ProjectSession, record: AssetRecord, at?: { revision: number }) {
    return this.writeFence(s, () => {
      const now = s.state.assets.assets[record.id];
      if (now?.file !== record.file || now.hash !== record.hash) throw new AssetChanged();
      // What the record change that follows the writes expects to build on: anything landing between is a conflict.
      if (at) at.revision = s.revision;
    });
  }

  /**
   * Writes into the project run in its queue, only while it is still the open project, not closing, and owned by this
   * app, all checked when the writes are about to happen. `check` may refuse by throwing.
   */
  private writeFence(s: ProjectSession, check?: () => void) {
    return async (write: () => Promise<void>): Promise<boolean> => {
      let wrote = false;
      const open = () => this.session === s && !this.closing;
      if (!open()) return false;
      await s.whileOwner(async () => {
        if (!open()) return;
        check?.();
        await write();
        wrote = true;
      });
      return wrote;
    };
  }

  /** Make again the smaller copies a library image lists that are missing from the project folder. */
  async regenerateAssetCopies(assetId: string): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false };
    if (s.readOnly) return { ok: false, message: s.readOnly.reason };
    const record = s.state.assets.assets[assetId];
    if (record?.kind !== 'image') return { ok: false, message: 'That image is no longer in the library.' };
    const name = record.name.trim() || 'The image';
    try {
      const r = await restoreAssetFiles(s.dir, record, undefined, this.assetFence(s, record));
      await this.checkAssetFiles(s);
      if (r.failed.length) return { ok: false, message: `${name} is still missing ${missingParts({ original: false, variants: r.failed })}, which could not be made again. Import the picture again, or choose another image.` };
      return { ok: true, message: r.written.length ? `Made ${missingParts({ original: false, variants: r.written })} of ${name} again.` : `${name} has all its copies.` };
    } catch (e) {
      if (e instanceof AssetChanged) return { ok: false, message: `${name} changed while its copies were being made. Look at it again in Assets.` };
      return { ok: false, message: (e as Error).message };
    }
  }

  readSource(definitionId: string) {
    const s = this.session!;
    const def = s.state.components[definitionId];
    if (!def) throw new Error('Unknown component.');
    if (def.kind === 'code') return { source: def.source ?? '', hash: sourceHash(def.source ?? ''), path: defFile(def), editable: def.owner === 'project' };
    const src = generateManagedComponent(s.state, def, {});
    return { source: src, hash: sourceHash(src), path: defFile(def), editable: false };
  }

  generatedSource(kind: 'component' | 'page', id: string): string {
    const s = this.session!;
    if (kind === 'page') return generatePage(s.state, s.state.pages[id], {});
    return this.readSource(id).source;
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async exportSource(format: ExportFormat = 'folder'): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session;
    const dest = await this.chooseExportTarget('source', format);
    if (!dest) return { ok: false, message: '', warnings: [] };
    if (this.session !== s) return { ok: false, message: 'The project was closed before the export started.', warnings: [] };
    return this.exportSourceTo(dest, format);
  }

  exportStatic(format: ExportFormat = 'folder', published?: string[]): Promise<ExportResult> {
    return timed('controller.exportStatic', () => this.exportStaticNow(format, published), (r) => ({ ok: r?.ok ?? false, format }))();
  }

  private async exportStaticNow(format: ExportFormat, published?: string[]): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session;
    // Published pages that link to a draft would send visitors to a page the website leaves out.
    const drafts = draftLinksStop(s!.state) ?? publishedChanged(s!.state, published);
    if (drafts) return { ok: false, ...drafts };
    const dest = await this.chooseExportTarget('site', format);
    if (!dest) return { ok: false, message: '', warnings: [] };
    if (this.session !== s) return { ok: false, message: 'The project was closed before the export started.', warnings: [] };
    return this.buildStaticTo(dest, format, published);
  }

  private exportBlocked(): ExportResult | null {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project open.', warnings: [] };
    // Export builds from the project folder and needs the writer lock (spec 20).
    if (s.readOnly) return { ok: false, message: s.readOnly.reason, warnings: [] };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish before exporting.', warnings: [] };
    if (s.conflicts.length) return { ok: false, message: 'Resolve file conflicts before exporting.', warnings: [] };
    // The generated files may still say what the project said before (a page since made a draft, in llms-full.txt).
    if (s.saveUnfinished) return { ok: false, message: 'A save did not finish, so the project’s files may be out of date. Close and reopen the project, then export again.', warnings: [] };
    // A change that failed to save (#753), perhaps just as the Export button was pressed, would be left out without a word.
    if (s.saveFailure) return { ok: false, message: 'A change could not be saved, so the export would leave it out. Make the change again (Project health says what went wrong), then export.', warnings: [] };
    return null;
  }

  /**
   * Folders: pick a parent folder and export into a new folder inside it (my-site-site, my-site-site-2, …), so
   * there is no "Replace?" prompt that the export would then refuse. ZIP files: a normal save dialog, which asks
   * before replacing; a name typed without ".zip" never lands on an existing file unasked.
   */
  private async chooseExportTarget(kind: 'site' | 'source', format: ExportFormat): Promise<string | null> {
    const s = this.session!;
    const base = `${slugify(s.state.site.name) || 'website'}-${kind}`;
    const docs = app.getPath('documents');
    const what = kind === 'site' ? 'website' : 'source project';
    if (format === 'zip') {
      const r = await dialog.showSaveDialog(this.getWindow()!, { title: `Export ${what} as a ZIP file`, defaultPath: join(docs, `${base}.zip`), filters: [{ name: 'ZIP archive', extensions: ['zip'] }], buttonLabel: 'Export', properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (r.canceled || !r.filePath) return null;
      if (/\.zip$/i.test(r.filePath)) return r.filePath;
      let zip = `${r.filePath}.zip`;
      for (let i = 2; existsSync(zip); i++) zip = `${r.filePath}-${i}.zip`;
      return zip;
    }
    const r = await dialog.showOpenDialog(this.getWindow()!, { title: `Choose where to save the ${what} folder`, defaultPath: docs, buttonLabel: 'Export here', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return uniqueChild(r.filePaths[0], base);
  }

  /** Why `dest` cannot receive an export, or null. */
  private badExportTarget(s: ProjectSession, dest: string, format: ExportFormat): string | null {
    if (format === 'folder' && existsSync(dest)) return 'Choose a new folder; the export never overwrites an existing location.';
    if (isInside(s.dir, dest)) return 'Choose a location outside the project folder.';
    return null;
  }

  /**
   * Put a finished folder or ZIP file in place, unless the project was taken over or closed meanwhile (only the lock's
   * owner exports, spec 20). A folder that appeared in the meantime is reported instead of merged into.
   */
  private async publish(s: ProjectSession, from: string, dest: string, format: ExportFormat, zipFolder = ''): Promise<string | null> {
    const stillOwned = async () => {
      const closed = () => new ExportStopped('The project was closed before the export finished.');
      if (this.session !== s) throw closed();
      if (!(await s.stillOwner())) throw new ExportStopped(s.readOnly?.reason ?? READ_ONLY);
      if (this.session !== s) throw closed();
    };
    try {
      if (format === 'zip') await zipDirectory(from, dest, zipFolder, stillOwned);
      // The staged export is thrown away once it is in place: it is moved there rather than copied when it can be.
      else await publishFolder(from, dest, stillOwned, { move: true });
      return null;
    } catch (e) {
      if (e instanceof ExportStopped) return e.message;
      const code = (e as NodeJS.ErrnoException).code;
      if (format === 'folder' && code === 'EEXIST') return 'Choose a new folder; the export never overwrites an existing location.';
      // Asking again cannot help: the chosen location is the problem.
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `SiteOrigin Builder cannot write to ${dirname(dest)}. Choose another location for the export.`;
      throw e;
    }
  }

  /** Export the editable project to `dest` (a new folder, or a ZIP file). Used by export and tests. */
  async exportSourceTo(dest: string, format: ExportFormat = 'folder'): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session!;
    const bad = this.badExportTarget(s, dest, format);
    if (bad) return { ok: false, message: bad, warnings: [] };
    // What the export says about what it delivered, in order, with where to fix what the editor can fix.
    const notes: ExportNote[] = [];
    const warn = (...messages: string[]) => void notes.push(...messages.map((message) => ({ message })));
    return this.withStaging(async (staging) => {
      const folder = join(staging, 'project');
      const snap = await this.snapshotSource(s, folder);
      if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
      await settleServerHook(folder, publishedState(snap.state));
      // The exported source is the published site; its drafts are kept to edit but not built.
      const live = publishedState(snap.state);
      // The project handed over knows the addresses this export publishes, as this one does once it records them: added
      // to the record the copied folder holds, which is the project's as it is on disk.
      const record = withPublished(await copiedRecord(folder, snap.state.published), live);
      if (record) await fs.writeFile(join(folder, PUBLISHED_FILE), toJson(record));
      // The forms the published site shows that visitors cannot send, each leading to its settings.
      notes.push(...websiteFormNotes(snap.state));
      warn(...draftSourceNotes(snap.state), ...sectionLinkWarnings(live), ...unlinkedButtonWarnings(live), ...unlinkedMenuLinkWarnings(live), ...emptySectionWarnings(live), ...formNameWarnings(live), ...runtimeFontWarnings(live));
      for (const { file, route, draft, markdown } of withheldStaticFiles(folder, snap.state))
        warn(
          markdown
            ? `${file} is served at ${route} as the Markdown copy of the draft ${draft}, so a build of the exported project publishes it there. Remove or move the file before building.`
            : `${file} is served at ${route}, the address of the draft ${draft}, so a build of the exported project publishes it there. Remove or move the file before building.`
        );
      const kept = locationKeptNote(await locatedPhotos(folder, snap.state));
      if (kept) warn(kept);
      warn(...missingSourceWarnings(snap.state, await findMissingAssetFiles(folder, snap.state.assets.assets)));
      const ownNotFound = ownNotFoundFileNote(folder);
      if (ownNotFound) warn(ownNotFound);
      const problem = await this.publish(s, folder, dest, format, `${slugify(snap.state.site.name) || 'website'}-source`);
      if (problem) return { ok: false, message: problem, warnings: [] };
      this.exportPaths.add(dest);
      await this.notePublished(s, live, warn);
      this.recordExport(s, { kind: 'source', format, path: dest, revision: snap.revision, exportedAt: new Date().toISOString(), notes });
      return { ok: true, path: dest, message: `${format === 'zip' ? 'Source project exported as a ZIP file.' : 'Source project exported.'} ${PRIVATE_FILES_LEFT_OUT}`, warnings: notes.map((n) => n.message), notes, revision: snap.revision };
    });
  }

  /**
   * Build the production site and copy it to `dest` (a new folder, or a ZIP file). Used by export and tests. With
   * `published`, the pages the author was shown as published, a snapshot that would publish others stops.
   */
  async buildStaticTo(dest: string, format: ExportFormat = 'folder', published?: string[]): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session!;
    const bad = this.badExportTarget(s, dest, format);
    if (bad) return { ok: false, message: bad, warnings: [] };
    // Build an isolated snapshot so the running preview and later edits cannot mix into the output.
    return this.withStaging((staging) => this.buildFromStaging(s, staging, dest, format, published));
  }

  /**
   * Build the website a client review is captured from (#1132) into the new folder `dest`: the same isolated snapshot,
   * asset preparation and checks as the website export, with none of what an export records. A review delivers no
   * address to visitors, so the project's record of published addresses, its redirects, revision, saved versions and
   * History stay exactly as they were, and the folder is neither listed among the exports nor previewed.
   */
  async stageReviewBuild(dest: string): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session!;
    const bad = this.badExportTarget(s, dest, 'folder');
    if (bad) return { ok: false, message: bad, warnings: [] };
    return this.withStaging((staging) => this.buildFromStaging(s, staging, dest, 'folder', undefined, { review: true }));
  }

  /** Each open project's file hashes from its last export's fingerprints, by the stamps they stand for (projectInventory). */
  private exportHashes = new WeakMap<ProjectSession, ExportHashes>();

  /** The build's copy of the website tools, kept between exports (made on the first). */
  private keptTools: KeptTools | null = null;

  /** Staging folders of exports still running: the sweep before another export leaves them alone. */
  private stagingInUse = new Set<string>();

  /**
   * A fresh staging folder per export, removed when it ends. Removing it never takes the place of what the export
   * says: on Windows a file the build had open (a native module it loaded) can refuse removal for a while after the
   * build has gone. Removal is tried again a few times, and what is still left is swept before the next export.
   */
  /** Where exports stage their builds, and where the build's copy of the website tools waits between exports. */
  private stagingRoot(): string {
    return join(app.getPath('userData'), 'build-staging');
  }

  private async withStaging(fn: (staging: string) => Promise<ExportResult>): Promise<ExportResult> {
    const stagingRoot = this.stagingRoot();
    const sweeping = perf.span('export.sweep');
    await fs.mkdir(stagingRoot, { recursive: true });
    await Promise.all(
      (await fs.readdir(stagingRoot).catch(() => [] as string[]))
        .filter((name) => name.startsWith('export-') && !this.stagingInUse.has(join(stagingRoot, name)))
        .map((name) => removeStaging(join(stagingRoot, name)))
    );
    const staging = mkdtempSync(join(stagingRoot, 'export-'));
    sweeping();
    this.stagingInUse.add(staging);
    try {
      return await fn(staging);
    } finally {
      this.stagingInUse.delete(staging);
      await timed('export.cleanup', () => removeStaging(staging))();
    }
  }

  /**
   * Copy a consistent snapshot of the project while holding the writer lock: generated files must match their
   * manifest, and nothing may change on disk while the copy runs. A snapshot that will be built must carry the
   * build configuration the user trusted, because the build runs the copy. The state returned is the one the
   * files were copied from, so everything said about the export describes this snapshot.
   */
  private snapshotSource(s: ProjectSession, dest: string, opts: { forBuild?: boolean } = {}): Promise<{ ok: true; revision: number; state: ProjectState } | { ok: false; message: string }> {
    return timed('export.stage', () => this.snapshotSourceNow(s, dest, opts), (r) => ({ ok: r?.ok ?? false, forBuild: !!opts.forBuild }))();
  }

  private async snapshotSourceNow(s: ProjectSession, dest: string, opts: { forBuild?: boolean }): Promise<{ ok: true; revision: number; state: ProjectState } | { ok: false; message: string }> {
    const stop = (message: string) => ({ ok: false as const, message });
    // The website's icons follow a favicon file changed with no document changing (put back by Locate, replaced in the
    // folder), so the export never carries icons of another picture than its favicon. They are drawn without holding
    // the project's lock, then published under it.
    // A set a save stopped waiting for, or one for a change made meanwhile, is waited for again, a few times at most.
    let icons: Awaited<ReturnType<ProjectSession['refreshSiteIcons']>> = null;
    const preparing = perf.span('export.icons');
    for (let tries = 0; tries < 3; tries++) {
      await s.prepareSiteIcons();
      icons = await s.refreshSiteIcons();
      if (!icons?.drawing) break;
    }
    preparing();
    // Everything in here holds the writer lock: no edit lands until it returns (the benchmark's export.lockHeld).
    return s.exclusive(timed('export.lockHeld', async () => {
      // The native dialog and the queue for the lock both give the project time to change.
      if (this.session !== s) return stop('The project was closed before the export started.');
      const blocked = this.exportBlocked();
      if (blocked) return stop(blocked.message);
      // Another app may have taken the project over meanwhile: only the lock's owner exports it (spec 20).
      if (!(await s.stillOwner())) return stop(s.readOnly?.reason ?? READ_ONLY);
      // Files left alone since an earlier pass (this export's, or the last one's) are known by their stamps.
      const cache = this.exportHashes.get(s) ?? new Map();
      this.exportHashes.set(s, cache);
      const before = await timed('export.fingerprint', () => projectInventory(s.dir, { cache, settleMs: s.settleMs }), () => ({ pass: 'before' }))();
      // The generated files were just hashed for the fingerprint: those whose stamps stand for their bytes are checked
      // against the manifest by those hashes (inventoryChanged below sees any write to them since), the rest are read.
      const trusted = new Map([...before.hashes].filter(([rel]) => before.stamps.get(rel)?.trusted));
      const edited = await timed('export.generatedCheck', () => editedGeneratedFile(s.dir, trusted))();
      if (edited) return stop(`${edited} was changed outside SiteOrigin Builder. Open Project health to restore it, then export again.`);
      // Both exports are the published site: its pages decide whether it needs the generated server hook.
      const rival = await rivalHookStop(s.dir, publishedState(s.state));
      if (rival) return stop(rival);
      // A source's settings go out as the project holds them, and only when the folder holds them so too.
      const sources = opts.forBuild ? null : await this.sourcesCopyProblem(s);
      if (sources) return stop(sources);
      await timed('export.copySource', () => copyProjectSource(s.dir, dest, { keepAsset: exportedAssetFilter(s.state) }))();
      await writeExportedSources(dest, s.state, { keep: !opts.forBuild });
      // The icons go out with the favicon they were made from: one replaced since would go out beside icons of the
      // picture it replaced. Only while icons cannot be made at all do those the project has go out as they are.
      const iconSource = await s.siteIconSource(dest);
      if (iconSource !== s.siteIconsPublished) {
        // Being drawn again by now (a save meanwhile tried once more): the icons are ready to export in a moment.
        if (s.siteIconsDrawing(iconSource)) return stop('The site’s icons are still being made. Export again in a moment.');
        const unmade = iconSource === icons?.key && s.siteIconsUnmakeable(iconSource);
        if (!unmade) return stop('The project changed on disk while it was being exported. Export again.');
      }
      // Both exports carry the published site's generated files; the drafts stay in the canonical documents.
      await timed('export.leaveOutDrafts', () => leaveOutDrafts(dest, s.state))();
      // What the editor finds in code components by their markers: neither export carries a marker, whoever owns the code.
      await timed('export.markers', () => stripCodeMarkers(dest, s.state))();
      if (opts.forBuild) {
        if (!(await isTrusted(s.dir, await configHash(dest)))) return stop("This project's build settings changed outside SiteOrigin Builder. Reopen the project to review them.");
      } else await finishExportedSource(dest, s.state, starterNotice(), await syncCliText(s.state));
      if (inventoryChanged(before, await timed('export.fingerprint', () => projectInventory(s.dir, { cache, settleMs: s.settleMs }), () => ({ pass: 'after' }))())) return stop('The project changed on disk while it was being exported. Export again.');
      if (!(await s.stillOwner())) return stop(s.readOnly?.reason ?? READ_ONLY);
      return { ok: true as const, revision: s.revision, state: structuredClone(s.state) };
    }));
  }

  /**
   * What a failed build's report needs to say who and where: the app, the system, and the folders its output may name
   * (the temporary copy that was built, the project it came from, the author's home) so none shows as an absolute path.
   */
  private buildFailureContext(staging: string, project: string, source: string): BuildFailureContext {
    const real = (p: string) => (existsSync(p) ? canonicalDir(p) : p);
    return {
      appVersion: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      roots: [
        { path: project, label: '<project>' },
        { path: real(project), label: '<project>' },
        { path: source, label: '<project>' },
        { path: real(source), label: '<project>' },
        { path: staging, label: '<temp>' },
        { path: real(staging), label: '<temp>' },
        { path: tmpdir(), label: '<temp>' },
        { path: real(tmpdir()), label: '<temp>' },
        { path: homedir(), label: '~' }
      ]
    };
  }

  private async buildFromStaging(s: ProjectSession, staging: string, dest: string, format: ExportFormat, shown?: string[], opts: { review?: boolean } = {}): Promise<ExportResult> {
    const project = join(staging, 'project');
    const snap = await this.snapshotSource(s, project, { forBuild: true });
    if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
    await settleServerHook(project, publishedState(snap.state));
    const { revision, state } = snap;
    // The library's size, beside the bytes the export reads (scripts/perf/README.md).
    if (perf.on) perf.mark('export.library', { files: Object.values(state.assets.assets).length, bytes: Object.values(state.assets.assets).reduce((n, a) => n + (a.bytes || 0), 0) });
    // The snapshot may differ from what the export was started on (the folder picker gives the project time to
    // change): check its links to drafts again, and that it publishes the pages the author was shown.
    const draftStop = draftLinksStop(state) ?? publishedChanged(state, shown);
    if (draftStop) return { ok: false, ...draftStop };
    // What visitors get: the published pages and the old addresses that lead to them.
    const live = publishedState(state);
    // A 404.html of the author's own would stop the build from writing the generated one.
    const ownNotFound = ownNotFoundFileStop(project);
    if (ownNotFound) return { ok: false, message: ownNotFound, warnings: [] };
    // An image file the site uses but the folder does not have fails the build without naming the picture: stop first,
    // naming it. The staged copy is checked, not what Project health last saw, so the answer is right for this export.
    const missingFiles = await timed('export.assets.missing', () => missingWebsiteAssets(project, state))();
    const missing = missingFiles.filter((m) => m.used);
    if (missing.length) {
      void this.checkAssetFiles(s);
      return { ok: false, ...missingAssetsStop(missing), assetId: missing[0].asset.id };
    }
    // The snapshot keeps the whole library, as the editable project does; visitors get only the files the site uses.
    // Credits are read first: a page can use a responsive copy whose original is pruned.
    const credits = await timed('export.assets.credits', () => variantCredits(project, state))();
    const omitted = await timed('export.assets.prune', () => pruneWebsiteAssets(project, state))();
    // What visitors download carries no location or device metadata; the project's own photos keep theirs.
    const photos = await timed('export.assets.photos', () => cleanWebsitePhotos(project, state, credits))();
    if (photos.failed.length) return { ok: false, message: uncleanablePhotosMessage(photos.failed), warnings: [] };
    // The build gets its own copy of the tools: what they write must not land in the project, which may have been
    // taken over by the time the build starts. The copy is kept between exports, checked against the project's tools.
    let tools: BuildTools;
    try {
      tools = await timed('export.copyTools', () => (this.keptTools ??= new KeptTools(join(this.stagingRoot(), 'tools'))).take(s.dir, project, s.settleMs))();
    } catch (e) {
      return { ok: false, message: 'The website tools are not set up. Open Project health and reinstall them, then export again.', warnings: [(e as Error).message] };
    }
    const build = await timed('export.build', () => buildProject(project), (b) => ({ ok: b?.ok ?? false }))();
    // Kept for the next export only once the build's worker is gone, so nothing it ran is still writing in the copy.
    if (build.exited) await timed('export.keepTools', () => tools.keep())();
    if (!build.ok) return { ok: false, ...explainBuildFailure(live, build, this.buildFailureContext(staging, project, s.dir)) };
    const out = join(project, 'build');
    // Vercel's redirect rules go beside the website's files, where it reads them.
    const vercelStop = await deliverVercelConfig(project, out, live);
    if (vercelStop) return { ok: false, message: vercelStop, warnings: [] };
    // What the export says about what it delivered, in order, with where to fix what the editor can fix.
    const notes: ExportNote[] = [];
    const warn = (...messages: string[]) => void notes.push(...messages.map((message) => ({ message })));
    const warnings = () => notes.map((n) => n.message);
    // Every built file is read once, as it is cleaned (the images the build brought in from somewhere other than the
    // cleaned sources: a package, generated code). What the checks below need of each is noted then, from the file as
    // the build wrote it; they still decide in their own order, and read what the pass did not see.
    const builtRel = (file: string) => (file.startsWith(out + sep) ? file.slice(out.length + 1).split(sep).join('/') : '');
    const pageFile = (route: string) => join(out, route === '/' ? 'index.html' : join(route, 'index.html'));
    const pageAt = new Map(live.site.pageOrder.map((id) => [builtRel(pageFile(live.pages[id].route)), live.pages[id]]));
    const builtPages = new Map<string, { markup: boolean; language: string | null }>();
    const scripts = new Map<string, boolean>();
    let notFoundSeen: string | undefined;
    // A failure to write a cleaned file is said where the cleaning used to be, after the checks that came before it.
    let cleaningFailed: { error: unknown } | null = null;
    const unchecked = await timed('export.verify.cleanBuilt', () =>
      cleanBuiltSite(out, (rel, bytes) => {
        if (rel.endsWith('.html')) {
          const html = bytes.toString('utf8');
          const page = pageAt.get(rel);
          builtPages.set(rel, { markup: editorMarkup(html), language: page ? pageLanguageWarning(live, page, html) : null });
          if (rel === NOT_FOUND_FILE) notFoundSeen = html;
        } else if (rel.endsWith('.js')) scripts.set(rel, editorScript(bytes.toString('utf8')));
      }).catch((error: unknown) => {
        cleaningFailed = { error };
        return [] as string[];
      })
    )();
    /** What the pass noted of a built page, or what it says when read now. */
    const pageAtFile = async (file: string) => {
      const seen = builtPages.get(builtRel(file));
      if (seen) return seen;
      const html = await readExportFile(file, 'utf8');
      const page = pageAt.get(builtRel(file));
      return { markup: editorMarkup(html), language: page ? pageLanguageWarning(live, page, html) : null };
    };
    // Verify page inventory.
    for (const id of live.site.pageOrder) {
      const p = live.pages[id];
      const file = pageFile(p.route);
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${p.route}.`, warnings: warnings() };
      const built = await pageAtFile(file);
      if (built.markup) return { ok: false, message: `Editor-only markup was found in ${p.route}. Export aborted.`, warnings: warnings() };
      if (built.language) warn(built.language);
    }
    // Every published collection entry is a page of its own.
    for (const { route } of siteEntries(live)) {
      const file = join(out, route, 'index.html');
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${route}.`, warnings: warnings() };
      if ((await pageAtFile(file)).markup) return { ok: false, message: `Editor-only markup was found in ${route}. Export aborted.`, warnings: warnings() };
    }
    // So is each page of every collection's index and category archives.
    for (const { route } of archivePages(live)) {
      const file = join(out, route, 'index.html');
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${route}.`, warnings: warnings() };
      if ((await pageAtFile(file)).markup) return { ok: false, message: `Editor-only markup was found in ${route}. Export aborted.`, warnings: warnings() };
    }
    // Old addresses kept working are pages of their own on a static host: each must be there to send visitors on.
    for (const { from } of liveRedirects(live)) {
      const file = join(out, from, 'index.html');
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${from}, an old address that should send visitors on.`, warnings: warnings() };
      if ((await pageAtFile(file)).markup) return { ok: false, message: `Editor-only markup was found in ${from}. Export aborted.`, warnings: warnings() };
    }
    // Nothing may answer at a draft's address, or at an old address that leads to one: a file of the same name in
    // static/, say, would publish the address the author kept back.
    // An archive page the website has at such an address is its own (route/index.html); any other file there is not.
    for (const { route, draft, archived } of withheldRoutes(state, live)) {
      if ((!archived && existsSync(join(out, route, 'index.html'))) || existsSync(join(out, `${route.replace(/\/$/, '')}.html`)))
        return { ok: false, message: `The website has a page at ${route}, which leads to the draft ${draft}. Remove the file that puts it there, then export again.`, warnings: warnings() };
      // The website never writes a Markdown copy at such an address (an archive page has none): one there is a file of the draft's.
      if (isPlainFile(join(out, markdownMirrorRoute(route))))
        return { ok: false, message: `The website has a Markdown copy of the draft ${draft} at ${markdownMirrorRoute(route)}. Remove the file that puts it there, then export again.`, warnings: warnings() };
    }
    // The not-found page, which hosts show at any address the site does not have (null when it is no plain file).
    const notFound = notFoundSeen ?? (await readNotFoundPage(out));
    const notFoundStop = notFoundPageProblem(notFound);
    if (notFoundStop || notFound === null) return { ok: false, message: notFoundStop ?? '', warnings: warnings() };
    perf.mark('export.verify.pagesChecked');
    for (const f of await listFiles(out)) {
      if (/\.js$/.test(f) && (scripts.get(builtRel(join(out, f))) ?? editorScript(await readExportFile(join(out, f), 'utf8')))) return { ok: false, message: 'Editor-only code was found in the build. Export aborted.', warnings: warnings() };
    }
    perf.mark('export.verify.scriptsChecked');
    if (cleaningFailed) throw (cleaningFailed as { error: unknown }).error;
    if (unchecked.length) return { ok: false, message: builtPhotosMessage(unchecked), warnings: warnings() };
    // A form visitors cannot send leads the notes: enquiries that fail are what the author most needs to know about.
    notes.unshift(...websiteFormNotes(state));
    const noPublicUrl = publicUrlNote(state);
    if (noPublicUrl) notes.push(noPublicUrl);
    const placeholders = placeholderImageCount(live);
    if (placeholders) warn(placeholders === 1 ? 'One image has not been chosen yet and shows a placeholder.' : `${placeholders} images have not been chosen yet and show placeholders.`);
    warn(...unlinkedButtonWarnings(live), ...unlinkedMenuLinkWarnings(live), ...emptySectionWarnings(live), ...formNameWarnings(live), ...runtimeFontWarnings(live));
    const absent = new Set(missingFiles.filter((m) => m.missing.original).map((m) => m.asset.id));
    for (const a of Object.values(state.assets.assets)) if (a.bytes > 1_500_000 && !omitted.includes(a) && !absent.has(a.id)) warn(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
    warn(...missingUnusedWarnings(missingFiles));
    const left = omittedAssetsWarning(omitted);
    if (left) warn(left);
    const located = locationRemovedNote(photos.located);
    if (located) warn(located);
    const relative = notFoundAddressWarning(notFound);
    if (relative) warn(relative);
    const pages = live.site.pageOrder.length;
    // In the Export dialog's words: "3 pages and 3 entries from Posts".
    const exported = exportedCounts(pages, siteEntries(live));
    const problem = await timed('export.publish', () => this.publish(s, out, dest, format))();
    if (problem) return { ok: false, message: problem, warnings: warnings() };
    // A review build is put in place and nothing more: no address it holds was delivered to visitors.
    if (opts.review) return { ok: true, path: dest, message: `Built ${exported} for review.`, warnings: warnings(), notes, revision, basePath: basePath(state) };
    // How the host shows the not-found page is guidance, not a warning: it goes beside the notes, never among them.
    const hosting = notFoundHostNote(basePath(state), redirectHost(live.site));
    const exportedAt = new Date().toISOString();
    this.exportPaths.add(dest);
    await this.notePublished(s, live, warn);
    if (format === 'zip') {
      this.recordExport(s, { kind: 'site', format, path: dest, revision, exportedAt, notes });
      return { ok: true, path: dest, message: `Exported ${exported} as a ZIP file.`, warnings: warnings(), notes, revision, hosting };
    }
    // The export is done either way; a preview that cannot start only loses the preview button.
    const previewUrl = await this.previewAndRecord(s, { kind: 'site', format, path: dest, revision, exportedAt, notes }, basePath(state));
    return { ok: true, path: dest, message: `Exported ${exported}.`, warnings: warnings(), notes, revision, previewUrl, hosting };
  }

  /**
   * Start a website folder's own preview, so one still open in a browser keeps serving its files while later exports
   * finish, and list the export. A project that closed while the export was put in place gets neither; one that
   * closes while the preview binds stops it.
   */
  private async previewAndRecord(s: ProjectSession, record: RecentExport, base: string): Promise<string | undefined> {
    const previewUrl = this.session === s ? await this.previews.serve(record.path, base).catch(() => undefined) : undefined;
    return this.recordExport(s, { ...record, previewUrl }) ? previewUrl : undefined;
  }

  /**
   * Record the page addresses an export delivered, so pages that move from them keep them working. The export is done
   * either way: a record that cannot be written is a note, since a page moved later then leaves no old address.
   */
  private async notePublished(s: ProjectSession, live: ProjectState, warn: (...messages: string[]) => void) {
    const problem = this.session !== s ? 'the project was closed before the export finished' : await s.recordPublished(live).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (problem) return warn(`The exported page addresses couldn’t be recorded in the project (${problem.replace(/\.$/, '')}), so a page moved before the next export won’t keep its old address working. Export again once the project can be saved.`);
    // A page moved while the export ran left an address the export has just published, with nothing kept there.
    for (const p of Object.values(live.pages)) {
      const now = Object.hasOwn(s.state.pages, p.id) ? s.state.pages[p.id] : undefined;
      const at = (route: string) => route.toLowerCase() === p.route.toLowerCase();
      if (now && now.route !== p.route && !Object.values(s.state.pages).some((q) => at(q.route)) && !liveRedirects(s.state).some((r) => at(r.from)) && !collectionRouteOwner(s.state, p.route))
        warn(`“${now.title}” moved from ${p.route} to ${now.route} while the website was being exported, so ${p.route} isn’t kept working. Add it in Site settings, under Redirects, to send visitors on.`);
    }
  }

  /**
   * Remember an export of the open project so the export dialog can list it, newest first. A new export where an
   * earlier one was (its folder deleted since, or a ZIP file replaced) supersedes it, and stops its preview, which
   * would otherwise serve the new files under the old proof's address.
   */
  private recordExport(s: ProjectSession, record: RecentExport): boolean {
    if (this.session !== s) {
      if (record.previewUrl) this.previews.stop(record.previewUrl);
      return false;
    }
    for (const old of this.recentExports) if (old.path === record.path && old.previewUrl) this.previews.stop(old.previewUrl);
    this.recentExports = [record, ...this.recentExports.filter((old) => old.path !== record.path)];
    this.broadcast();
    return true;
  }

  /** Stop every exported-website preview and forget the exports: they belonged to the project that made them. */
  private endExports() {
    this.previews.stopAll();
    this.recentExports = [];
  }

  /** Only the open project, files inside it, or folders this app exported can be revealed. */
  revealInFinder(path?: string) {
    const dir = this.session?.dir;
    const p = path ?? dir;
    if (!p) return;
    const inside = (root: string) => {
      const r = relative(root, p);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    };
    if (!((dir && inside(dir)) || this.exportPaths.has(p))) return;
    // Resolve links: a path inside the project must not point elsewhere.
    void fs.realpath(p).then((real) => {
      if (this.exportPaths.has(p) || (dir && inside(dir) && (() => { const r = relative(dir, real); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); })())) shell.showItemInFolder(real);
    }, () => undefined);
  }
}

/**
 * Would writing `path` write into the folder `dir`? Compared by real path, since a linked parent folder can lead
 * back into the project. The entry itself is never resolved (a link there is what gets replaced), and parents that
 * do not exist yet are resolved through the nearest one that does.
 */
export function isInside(dir: string, path: string): boolean {
  let probe = dirname(path);
  let rest = basename(path);
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest = join(basename(probe), rest);
    probe = dirname(probe);
  }
  const rel = relative(canonicalDir(dir), join(canonicalDir(probe), rest));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Asset usage counts; a project from a newer version (read-only) may not have shapes this version can count. */
function safeUsages(s: ProjectSession): Record<string, number> {
  try {
    return s.assetUsages();
  } catch (e) {
    if (s.readOnly) return {};
    throw e;
  }
}

/** Plain-language explanations for setup failures; the technical detail stays available in diagnostics. */
/** Whether a new project cannot be made at `dir`: a file is there, or a folder that holds anything. */
async function occupied(dir: string): Promise<boolean> {
  const st = await fs.stat(dir).catch(() => null);
  return !!st && (!st.isDirectory() || (await fs.readdir(dir)).length > 0);
}

/** The new project's folder was found taken: told as written, never mistaken for another failure by its wording. */
class FolderTakenError extends Error {}

export function friendlyError(msg: string): string {
  if (/Downloading the website tools failed|network|offline|ENOTCACHED/i.test(msg) || NETWORK_CODES.some((code) => msg.includes(code)))
    return 'The website tools could not be downloaded. Check your internet connection and try again. A connection is only needed once.';
  if (/ENOSPC/i.test(msg)) return 'Your disk is full. Free up some space and try again.';
  if (/EACCES|EPERM/i.test(msg)) return 'SiteOrigin Builder does not have permission to write to that folder. Choose a folder in your Documents and try again.';
  if (/^Canceled$/.test(msg)) return 'Canceled.';
  return msg.length > 200 || /^Installing dependencies failed/.test(msg) ? 'Setting up the website tools failed. Open Project health for the details, then choose Reinstall website tools.' : msg;
}

/** The record of exported addresses a copied project folder holds, or `fallback` when it holds none it can read. */
async function copiedRecord(folder: string, fallback: PublishedDoc | undefined): Promise<PublishedDoc | undefined> {
  const text = await readIfExists(join(folder, PUBLISHED_FILE)).catch(() => null);
  if (text === null) return fallback;
  try {
    const doc: unknown = JSON.parse(text);
    return publishedDocProblem(doc) ? fallback : (doc as PublishedDoc);
  } catch {
    return fallback;
  }
}
