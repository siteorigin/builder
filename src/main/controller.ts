import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdtempSync, promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CreateProjectOptions, ExportFormat, ExportResult, ImportChoices, ImportReview, ImportReviewRow, LocalWorkspaceState, ProjectSnapshot, ProgressEvent, RecentExport, RestoreVersionResult, RuntimeState, StorageInfo, VersionReview, WebsiteTools } from '@shared/api';
import type { ApplyResult, EditBatch } from '@shared/ops';
import type { AssetRecord, ProjectState } from '@shared/types';
import { createStarterState, STARTER_ASSETS } from '@catalogue/starters';
import { slugify } from '@shared/routes';
import { sourceHash } from '@engine/apply';
import { basePath, generateManagedComponent, generatePage, defFile, liveRedirects, publishedState } from '@generator/index';
import { placeholderImageCount } from '@generator/checks';
import type { BuildFailureContext } from './build-failure';
import { zipDirectory } from './zip';
import { NOT_A_PROJECT_ZIP, readProjectZip, unpackProject, WEBSITE_ZIP, ZipError } from './unzip';
import { StaticPreviews } from './static-preview';
import { builtPhotosMessage, pageLanguageWarning, rivalHookStop, cleanBuiltSite, cleanWebsitePhotos, copyProjectSource, draftLinksStop, draftSourceNotes, publishedChanged, withheldStaticFiles, editedGeneratedFile, explainBuildFailure, exportedAssetFilter, finishExportedSource, leaveOutDrafts, listFiles, locatedPhotos, locationKeptNote, locationRemovedNote, missingAssetsStop, missingSourceWarnings, missingUnusedWarnings, missingWebsiteAssets, notFoundAddressWarning, notFoundHostNote, notFoundPageProblem, omittedAssetsWarning, ownNotFoundFileNote, ownNotFoundFileStop, readNotFoundPage, settleServerHook, projectFingerprint, projectReadme, publishFolder, pruneWebsiteAssets, readLibraryImage, sectionLinkWarnings, uncleanablePhotosMessage, uniqueChild, unlinkedButtonWarnings, variantCredits } from './export';
import { LOCAL_DIR, NO_LOCK, ProjectLockedError, ProjectSession, ThemeUnavailableError } from './project/session';
import { DOC_DIR, MANIFEST_FILE, ProjectFormatError } from './project/documents';
import { DOCUMENT_EXTENSIONS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, IMPORT_IMAGE_EXTENSIONS, importAsset, isAssetOfKind, isOpaquePicture, libraryWebCopyPlan, locateAssetFile, restoreAssetFiles, reviewImportFile, storeLibraryWebCopy } from './project/assets';
import { heicDecoder, type PhotoDecoder } from './project/photo-convert';
import { findMissingAssetFiles, missingFileDiagnostics, missingParts } from './project/asset-files';
import { atomicWrite, readIfExists, sha } from './project/fsutil';
import { photoMetadata } from './project/photo-metadata';
import { DevServer, buildProject, dependenciesReady, prepareDependencies, starterTools } from './runtime/manager';
import { NETWORK_CODES, ToolsDownloadError } from './runtime/availability';
import { copyProjectTools, createPreviewStage, removePreviewStage, sweepPreviewStages, syncPreviewStage } from './runtime/stage';
import { clearComponentPreviews, previewSpec, removeComponentPreview, writeComponentPreview } from './runtime/component-preview';
import { generateComponentPreview } from '@generator/preview';
import { canonicalDir } from '../runtime/policy';
import { addRecent, isTrusted, loadSettings, trust, untrust } from './settings';
import { newId } from '@shared/ids';

const INSTANCE_ID = randomUUID();

const READ_ONLY = 'This project is read-only.';
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

/** The image a recovery was made for changed (relinked, removed) before its files could be written. */
class AssetChanged extends Error {}

/** Project health's missing-file entries; a project from a newer version may not follow this version's shapes. */
function safeMissingDiagnostics(s: ProjectSession) {
  try {
    return missingFileDiagnostics(s.state, s.missingAssets);
  } catch {
    return [];
  }
}

export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

/** Licence notice for the Business starter's sample images. */
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

type OpenResult = { ok: boolean; message?: string; needsTrust?: { dir: string; name: string } };

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

/** Is `path` a ZIP file (a folder that happens to end in .zip is still a folder)? */
async function isZipFile(path: string): Promise<boolean> {
  if (!/\.zip$/i.test(path)) return false;
  return (await fs.stat(path).catch(() => null))?.isFile() ?? false;
}

/** A failure message that says which project folder it is about. */
const inFolder = (message: string, dir: string) => `${message} Project folder: "${dir}".`;

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

export class Controller {
  session: ProjectSession | null = null;
  dev: DevServer | null = null;
  private createAbort: AbortController | null = null;
  /** Set from a switch's close until its replacement is attached. */
  private handingOver = false;
  /** Set once the app is quitting: no project replaces the one being closed for it. */
  quitting = false;
  /** New projects being made (or unpacked from a ZIP file), each until it is shown or has gone again. */
  private creations = new Map<Promise<unknown>, AbortController>();
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
  private watchers: FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private assetTimer: NodeJS.Timeout | null = null;
  /** The private copy the preview runs from while the project may not be written to (spec 16.6, 18.1). */
  private stage: string | null = null;
  private stageSync: Promise<unknown> = Promise.resolve();
  private stageTicket = 0;
  /** Watches over the files the copy is made from, as the project's own dev server would watch them. */
  private stageWatchers: FSWatcher[] = [];
  private stageTimer: NodeJS.Timeout | null = null;
  /** The project whose copy was already replaced once after a mirror failed, so a lasting failure cannot loop. */
  private restaged: ProjectSession | null = null;
  /** The last preview status sent while no preview process runs (setting up, copying, or why it cannot start). */
  private pendingStatus: RuntimeState | null = null;
  /** Isolated component previews prepared for the preview server running now, by key, with the folder each is in. */
  private componentPreviews = new Map<string, string>();
  /** Cancels a dependency install into the project when another app takes it over. */
  private prepareAbort: AbortController | null = null;
  private closing: Promise<void> | null = null;
  onSessionOpened: ((s: ProjectSession) => Promise<void>) | null = null;
  onSessionClosing: (() => Promise<void>) | null = null;
  /** Asks the editor to save what is still being typed before the project is unloaded; false keeps it open. */
  beforeLeave: (() => Promise<boolean>) | null = null;
  /** A project opening began or ended (openingKey changed): a close that was allowed ends it as it starts. */
  onOpeningChange: (() => void) | null = null;
  aiBusy = () => false;
  aiRunId = (): string | null => null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  send(channel: string, payload?: unknown) {
    const w = this.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(): ProjectSnapshot | null {
    const s = this.session;
    if (!s) return null;
    return {
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
      conflicts: s.conflicts,
      readOnly: s.readOnly,
      themeUpdates: s.readOnly ? undefined : s.themeUpdates(),
      localState: this.localState,
      workspaceKey: this.workspaceKey ?? '',
      recentExports: this.recentExports
    };
  }

  broadcast() {
    const snap = this.snapshot();
    if (snap) this.send('project:changed', snap);
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
    const run = this.createProject(opts, abort);
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
    let dir = join(opts.parentDir, slugify(name) || 'website');
    if (existsSync(dir) && (await fs.readdir(dir)).length) return { ok: false, message: `${dir} already exists and is not empty. Choose another name or folder.` };
    // Asked before the new project is made, so keeping editing costs no setup, and again at the switch, for anything
    // typed meanwhile (on macOS a window reopened during setup shows the open project without this dialog).
    if (!(await this.mayLeave())) return { ok: false };
    // Cancelled before anything happened: the open project stays open.
    if (signal.aborted) return { ok: false, message: 'Cancelled.' };
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
      if (signal.aborted) throw new Error('Cancelled');
      progress({ step: 'files', message: 'Preparing project files…' });
      await fs.mkdir(dirname(dir), { recursive: true });
      try {
        await fs.mkdir(dir);
        createdDir = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another app may have made it meanwhile: never write into a folder that is no longer empty.
        if ((await fs.readdir(dir)).length) throw new Error(`${dir} already exists and is not empty. Choose another name or folder.`);
      }
      // Claim the folder before writing to it. Only one creation, in this app or another, can make its local folder,
      // so two creating into the same empty folder never write over, or clean up, each other's files.
      try {
        await fs.mkdir(join(dir, LOCAL_DIR));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${dir} already exists and is not empty. Choose another name or folder.`);
        throw e;
      }
      wrote.add(LOCAL_DIR);
      // Anything that arrived before the claim makes the folder no longer empty after all: give the claim up and leave
      // the rest untouched.
      if ((await fs.readdir(dir)).some((n) => n !== LOCAL_DIR)) throw new Error(`${dir} already exists and is not empty. Choose another name or folder.`);
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
      const notice = starterNotice();
      const assetsDir = join(resourcesDir(), 'resources', 'starter-assets');
      const withImages = opts.starter === 'business' && opts.sampleImages && existsSync(assetsDir);
      const state = createStarterState(opts.starter, name, withImages);
      if (withImages) {
        own('static');
        for (const a of STARTER_ASSETS) {
          const src = join(assetsDir, a.source);
          if (!existsSync(src)) continue;
          const { record } = await importAsset(dir, src, []);
          record.id = a.id;
          record.name = a.name;
          record.altSuggestion = a.alt;
          record.description = 'Sample image bundled with the Business starter. Replace it with your own.';
          state.assets.assets[a.id] = record;
        }
        if (existsSync(notice)) {
          own('NOTICE.md');
          await fs.copyFile(notice, join(dir, 'NOTICE.md'));
        }
      }
      if (signal.aborted) throw new Error('Cancelled');
      own(...SESSION_ENTRIES);
      sessionStarted = true;
      session = await ProjectSession.create(dir, state);
      const lockErr = await session.acquireLock(INSTANCE_ID);
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
      await trust(dir, await configHash(dir));
      progress({ step: 'dependencies', message: 'Setting up website tools…', detail: 'Installing the tools that build and preview your site.' });
      own('node_modules');
      let toolsMissing: RuntimeState | null = null;
      try {
        await prepareDependencies(dir, (line) => progress({ step: 'dependencies', message: 'Setting up website tools…', detail: line.slice(0, 160) }), signal, () => staged.stillOwner());
      } catch (e) {
        // The tools needed a download and the registry could not be reached (offline, say). The project itself is
        // complete and this app's, so it opens for editing, its preview saying what is missing, with Try again. A
        // cancel, a takeover or any other failure removes it as before.
        if (!(e instanceof ToolsDownloadError) || signal.aborted || takenOver || !(await staged.stillOwner()) || signal.aborted) throw e;
        toolsMissing = { state: 'error', message: friendlyError(e.message), detail: e.message };
      }
      if (signal.aborted) throw new Error('Cancelled');
      // From the moment the open project starts closing, the new one is replacing it: there is nothing left to cancel.
      const way = await this.makeWay(since, signal, () =>
        progress(toolsMissing ? { step: 'preview', message: 'Opening the project…', detail: 'The website tools could not be downloaded, so the preview waits until you are back online.' } : { step: 'preview', message: 'Starting preview…' })
      );
      if (!way.ok) {
        refused = way;
        throw new Error(way.message ?? 'The open project was kept.');
      }
      committed = true;
      staged.off('lock-lost', stop);
      // Opened without its preview, nothing reads its lock again before the editor has it: read it now, since another
      // app may have taken it while the open project was closing, before the heartbeat noticed.
      if (toolsMissing && !takenOver && !(await staged.stillOwner())) takenOver = true;
      // Its lock lost while the open project was closing for it: it is not shown, but rolled back. A Cancel or a quit
      // arriving now is too late to undo the switch, which finishes.
      if (takenOver) throw new Error('Cancelled');
      // The preview writes its own output into the folder.
      if (!toolsMissing) own('.svelte-kit');
      attached = true;
      await this.attach(staged, {}, toolsMissing);
      // The project is open and working: a recent-projects list that cannot be saved must not undo it.
      await addRecent(dir, name).catch(() => undefined);
      progress({ step: 'done', message: 'Ready' });
      return { ok: true };
    } catch (e) {
      // Keeping editing (or quitting) at the switch is no failure to explain: the dialog just makes way.
      // A handover that never reached the editor ends here, so later switches are not held up by it.
      if (committed && !attached) this.handingOver = false;
      let msg = refused ? (refused.message ?? '') : takenOver ? 'The new project’s lock was taken or removed while it was being set up, so it was not opened.' : friendlyError((e as Error).message);
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
      progress({ step: 'error', message: msg === 'Cancelled' ? 'Project creation was cancelled.' : 'The project could not be created.', detail: msg });
      return msg ? { ok: false, message: msg } : { ok: false };
    }
  }

  cancelCreate() {
    this.createAbort?.abort();
  }

  /** Whether creating a project downloads website tools, decided by the same check setup makes. */
  websiteTools(): Promise<WebsiteTools> {
    return starterTools(templateFiles());
  }

  /** Open a project folder, or a project ZIP file (#263). With no path, the author chooses one (`folder`: a folder). */
  async open(dirArg?: string, opts: { folder?: boolean } = {}): Promise<OpenResult> {
    // Called off from the start, so a window that goes while its picker is up never gets a ZIP file unpacked for it.
    const abort = new AbortController();
    this.openAborts.add(abort);
    // Every exit is a structured result: a thrown error would reject the IPC call and leave the Welcome screen busy.
    try {
      return await this.openChosen(dirArg, opts.folder === true, abort);
    } catch (e) {
      return { ok: false, message: `Could not open the project: ${(e as Error).message}` };
    } finally {
      this.openAborts.delete(abort);
    }
  }

  private async openChosen(dirArg: string | undefined, folder: boolean, abort: AbortController): Promise<OpenResult> {
    let dir = dirArg;
    if (!dir) {
      const win = this.getWindow();
      const r = await dialog.showOpenDialog(win!, openProjectDialog(folder));
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
      if (basename(dir) === MANIFEST_FILE) dir = join(dir, '..');
    }
    if (await isZipFile(dir)) return this.openZip(dir, abort);
    if (!existsSync(join(dir, MANIFEST_FILE))) return { ok: false, message: 'That folder is not a SiteOrigin Builder project. Choose a folder that contains siteorigin.project.json.' };
    // A project reached through a link (macOS: /var is /private/var) is opened by its real path. Trust is never
    // carried over from the linked name: that link could since have been pointed at a different folder.
    dir = canonicalDir(dir);
    if (!(await isTrusted(dir, await configHash(dir)))) {
      // The trust prompt names the project, so a manifest that cannot be read (a truncated copy, say) stops here.
      const manifest = await readManifestSummary(dir);
      if (!manifest.ok) return { ok: false, message: manifest.message };
      return { ok: false, needsTrust: { dir, name: manifest.name } };
    }
    return this.openTrusted(dir);
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
    const run = unpackProject(file, project, parent, slugify(name) || 'website', { signal: abort.signal, beforePublish: (dir) => untrust(canonicalDir(dir)) });
    // Quitting calls it off and waits for it, as for a new project being made.
    this.creations.set(run, abort);
    this.unpacking = abort;
    this.send('projects:unpacking', { name, dir: parent });
    let dir: string;
    try {
      dir = await run;
    } catch (e) {
      // A damaged file, or files a cancelled unpacking could not remove, are explained; a cancel alone is not.
      if (e instanceof ZipError) return { ok: false, message: e.message };
      if (abort.signal.aborted) return { ok: false };
      return { ok: false, message: `Could not unpack ${name} into ${parent}: ${(e as Error).message}` };
    } finally {
      this.creations.delete(run);
      if (this.unpacking === abort) this.unpacking = null;
      this.send('projects:unpacking', null);
    }
    return { ok: false, needsTrust: { dir: canonicalDir(dir), name } };
  }

  /** The unpacking dialog's Cancel: call off the ZIP file being unpacked (any other open waiting goes on). */
  cancelUnpacking() {
    this.unpacking?.abort();
  }

  /** Its window went: call off every project ZIP file being opened. Before a copy is in place, what it wrote is removed. */
  cancelOpen() {
    for (const abort of this.openAborts) abort.abort();
  }

  async trustAndOpen(opened: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const dir = canonicalDir(opened);
      await trust(dir, await configHash(dir));
      return await this.openTrusted(dir);
    } catch (e) {
      return { ok: false, message: `Could not open the project: ${(e as Error).message}` };
    }
  }

  private async openTrusted(dir: string, opts: { force?: boolean | string } = {}): Promise<{ ok: boolean; message?: string }> {
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
    let session: ProjectSession;
    try {
      session = await ProjectSession.open(dir, INSTANCE_ID, opts);
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
      else return { ok: false, message: inFolder(`Could not open the project: ${(e as Error).message}`, dir) };
    }
    // Workspace layout and recents are conveniences: a broken file or a failed save never blocks opening.
    let workspace: LocalWorkspaceState = {};
    try {
      workspace = JSON.parse((await readIfExists(session.local('workspace.json'))) ?? '{}');
    } catch {
      workspace = {};
    }
    const way = await this.makeWay(since);
    if (!way.ok) {
      await session.close().catch(() => undefined);
      return way;
    }
    // Attached in the same turn as the switch (attach makes it the open project before it waits on anything), so no
    // other switch can come between the two.
    void this.attach(session, workspace).catch(async (e) => {
      if (this.session === session) await this.close();
      else await session.close();
      this.send('runtime:status', { state: 'error', message: `The project could not be opened: ${(e as Error).message}` });
    });
    if (!session.readOnly) await addRecent(dir, session.state.site.name).catch(() => undefined);
    return { ok: true };
  }

  /** Take over a project another app holds (the user confirmed it is not running) and reopen it for editing. */
  async unlock(): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s?.readOnly?.canUnlock) return { ok: false, message: 'This project is not locked.' };
    // Reopening closes this read-only session: a page being added in it is settled (or kept) first (see openTrusted).
    // Only the owner the user was shown is displaced: if another app took the project since, it is shown instead.
    return this.openTrusted(s.dir, { force: s.readOnly.lockToken ?? NO_LOCK });
  }

  /** Settle a file conflict: keep the version changed outside the app, or restore SiteOrigin Builder's version. */
  async resolveConflict(path: string, choice: 'keep' | 'restore'): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project is open.' };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish first.' };
    // Only an exact choice is acted on: a missing or mistyped one must never overwrite a file.
    if (typeof path !== 'string' || (choice !== 'keep' && choice !== 'restore')) return { ok: false, message: 'Choose which version to keep.' };
    return s.resolveConflict(path, choice);
  }

  /**
   * Make `session` the open project, with its own workspace state installed in the same step. With `runtimeError` the
   * preview is not started: the project opens showing that error, and Try again starts it.
   */
  private async attach(session: ProjectSession, workspace: LocalWorkspaceState, runtimeError: RuntimeState | null = null) {
    // The handover that closed the open project for this one ends here, as this one becomes the open project.
    this.handingOver = false;
    // A new opening lists only its own exports, even if an earlier one was never closed.
    this.endExports();
    this.session = session;
    // In place before the first snapshot, so the editor opens with it.
    if (runtimeError) this.pendingStatus = runtimeError;
    this.localState = workspace;
    this.localDirty = false;
    this.workspaceKey = `${session.dir}#${++this.openings}`;
    this.onOpeningChange?.();
    // Another app took the project over and edits its folder now: stop the preview running there at once (and any
    // install into it), then start it again from a private copy.
    session.on('lock-lost', () => {
      if (this.session !== session) return;
      this.prepareAbort?.abort();
      if (!this.stage) void this.dev?.stop();
      void this.startRuntime().catch(() => undefined);
    });
    session.on('changed', (ev) => {
      if (this.stage) this.syncStage(session);
      else this.dev?.notifyRevision(ev.revision);
      this.broadcast();
      // An import, a relink, an undo or an outside edit of the library may name files that are, or are not, there.
      if (ev.changedDocs.includes('siteorigin/assets.json')) void this.checkAssetFiles(session);
    });
    session.on('history', () => this.broadcast());
    await this.onSessionOpened?.(session);
    // Watching starts before the first look, so a file removed while it runs is seen too.
    this.watchExternalChanges(session);
    // Project health lists missing image files from the first moment the project shows.
    await session.refreshAssetFiles().catch(() => false);
    this.broadcast();
    if (runtimeError) this.send('runtime:status', runtimeError);
    else await this.startRuntime();
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

  private async startRuntimeNow() {
    const session = this.session;
    if (!session) return;
    await this.stopPreview();
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
    // Read the lock again right before running anything in the folder: a takeover the heartbeat has not seen yet would
    // otherwise get a live preview. A takeover found here has already queued a preview from a copy.
    if (!session.readOnly && !(await session.stillOwner())) return;
    if (this.session !== session) return;
    // A project this app may not write to runs from a private copy, so its tools write nothing into the folder.
    // Decided with no wait before the fork: a takeover after this point stops the worker and queues a staged restart.
    const stage = session.readOnly ? await this.stagePreview(session) : null;
    if (session.readOnly && !stage) return;
    // A preview that crashes is started again in the same folder only while that is still this app's to use; a copy is.
    // Previews an earlier run left behind (it crashed, or the app did not close) are never shown again. The project's
    // are cleared only while it is this app's to write; a copy is new.
    if (!stage) await clearComponentPreviews(session.dir).catch(() => undefined);
    const dev: DevServer = new DevServer(stage ?? session.dir, async (): Promise<boolean> => this.dev === dev && (!!stage || (await session.stillOwner())));
    this.dev = dev;
    this.stage = stage;
    this.pendingStatus = null;
    if (stage) this.watchStageSources(session);
    dev.onStatus((s) => {
      // A preview that was stopped or replaced no longer speaks for the project.
      if (this.dev !== dev) return;
      this.send('runtime:status', s);
      this.broadcast();
    });
    await dev.start();
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
        await syncPreviewStage(session.dir, stage);
        if (this.stage === stage) this.dev?.notifyRevision(revision);
      })
      .catch(() => {
        if (this.stage !== stage || this.session !== session || this.restaged === session) return;
        this.restaged = session;
        void this.startRuntime().catch(() => undefined);
      });
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
        const w = watch(dir, { recursive: true }, onChange);
        // A watch that fails (the folder went, too many files) just stops; accepted document changes still sync.
        w.on('error', () => w.close());
        this.stageWatchers.push(w);
      } catch {
        /* watching is best-effort: accepted document changes still bring the copy up to date */
      }
    }
  }

  /** Stop the preview, then remove the private copy it ran from (again once its process has really gone). */
  private async stopPreview() {
    const dev = this.dev;
    const stage = this.stage;
    // Prepared for this preview server alone: a frame showing one fails to load once the server is gone anyway.
    const previews = [...this.componentPreviews];
    this.componentPreviews.clear();
    await Promise.all(previews.map(([key, root]) => removeComponentPreview(root, key).catch(() => undefined)));
    for (const w of this.stageWatchers) w.close();
    this.stageWatchers = [];
    if (this.stageTimer) clearTimeout(this.stageTimer);
    this.stageTimer = null;
    this.pendingStatus = null;
    await dev?.stop();
    if (this.dev === dev) this.dev = null;
    if (this.stage === stage) this.stage = null;
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
    const spec = previewSpec(request);
    if (!spec) return { ok: false, message: 'That is not a component preview request.' };
    const made = generateComponentPreview(session.state, spec);
    if ('error' in made) return { ok: false, message: made.error };
    const root = this.stage ?? session.dir;
    let written: { key: string; path: string };
    try {
      written = await writeComponentPreview(root, made.files);
    } catch (e) {
      return { ok: false, message: `The component preview could not be prepared: ${(e as Error).message}` };
    }
    // The preview server it was made for stopped meanwhile: its files go with it.
    if (this.dev !== dev || this.session !== session || (this.stage ?? session.dir) !== root) {
      await removeComponentPreview(root, written.key).catch(() => undefined);
      return { ok: false, message: 'The preview is not running.' };
    }
    this.componentPreviews.set(written.key, root);
    return { ok: true, ...written, definitionId: made.definitionId };
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
    const changed = await session.refreshAssetFiles().catch(() => false);
    if (changed && this.session === session) this.broadcast();
  }

  /**
   * Accept valid external edits to canonical documents and authored code components, and notice image files being
   * moved out of (or back into) static/assets/.
   */
  private watchExternalChanges(session: ProjectSession) {
    for (const w of this.watchers) w.close();
    this.watchers = [];
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
        const w = watch(dir, { recursive: true }, (_e, f) => (!f || /^assets([\\/]|$)/.test(String(f))) && onAssetChange());
        // The folder going away can end the watch with an error (Windows); unhandled, it would be thrown.
        w.on('error', () => w.close());
        this.watchers.push(w);
      }
    } catch {
      /* watching is best-effort: the check still runs when the library changes and before every export */
    }
    const onChange = () => {
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(async () => {
        if (this.session !== session || this.aiBusy()) return;
        const r = await session.reloadFromDisk();
        if (!r.ok && r.message && r.message !== 'Busy') this.send('runtime:status', this.runtimeStatus());
      }, 400);
    };
    // Watch src/lib/siteorigin (not just custom/) so a custom folder created later is still seen.
    for (const [rel, accept] of [
      ['siteorigin', (f: string) => !f.includes('generated-manifest')],
      ['src/lib/siteorigin', (f: string) => f.startsWith('custom')]
    ] as const) {
      try {
        const dir = join(session.dir, rel);
        if (existsSync(dir)) this.watchers.push(watch(dir, { recursive: true }, (_e, f) => f && accept(String(f)) && !String(f).endsWith('.tmp') && onChange()));
      } catch {
        /* watching is best-effort */
      }
    }
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
    if (signal?.aborted) return { ok: false, message: friendlyError('Cancelled') };
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
    if (!this.session || this.closing || !this.beforeLeave) return true;
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
    this.closing ??= this.closeNow().catch((e) => { if (session && this.session === session && !this.workspaceKey) (this.workspaceKey = key), this.onOpeningChange?.(), this.broadcast(); throw e; }).finally(() => (this.closing = null));
    return this.closing;
  }

  get isClosing(): boolean {
    return !!this.closing;
  }

  private async closeNow() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.assetTimer) clearTimeout(this.assetTimer);
    this.assetTimer = null;
    const s = this.session;
    if (!s) return this.endExports();
    this.closings++;
    // Workspace state belongs to the project it was saved in: accept no more of it, and write it before the lock goes.
    this.workspaceKey = null;
    this.onOpeningChange?.();
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
      // The editor lets go of the preview before its server stops, so a page still loading there never finds it gone.
      this.send('runtime:status', { state: 'idle' });
      await this.stopPreview();
      await this.runtimeQueue;
      await this.stopPreview();
      await s.close();
    } finally {
      // The next project loads its own workspace state, or starts empty.
      this.localState = {};
      this.send('project:closed');
    }
  }

  async duplicate(): Promise<{ ok: boolean; message?: string; dir?: string }> {
    const s = this.session;
    if (!s) return { ok: false };
    const r = await dialog.showSaveDialog(this.getWindow()!, { title: 'Duplicate project', defaultPath: `${s.dir}-copy`, buttonLabel: 'Duplicate' });
    if (r.canceled || !r.filePath) return { ok: false };
    if (existsSync(r.filePath)) return { ok: false, message: 'Choose a new folder name; that location already exists.' };
    // The copy would land inside the folder it copies, and write into a project that may be read-only here.
    if (isInside(s.dir, r.filePath)) return { ok: false, message: 'Choose a location outside the project folder.' };
    await copyProjectSource(s.dir, r.filePath);
    const dest = canonicalDir(r.filePath);
    const manifestPath = join(dest, MANIFEST_FILE);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.projectId = newId('p', 12);
    manifest.name = `${manifest.name} copy`;
    manifest.createdAt = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await trust(dest, await configHash(dest));
    await addRecent(dest, manifest.name);
    return { ok: true, dir: dest };
  }

  /**
   * Remember workspace state (open page, tabs, unsent AI drafts) for the opening of the project the editor meant
   * (`key`, from its snapshot). A save for an opening that has started closing is dropped: it must never reach the
   * next project, or a later opening of the same one. The file is written shortly after the last change, and always
   * before the project closes.
   */
  saveLocalState(state: LocalWorkspaceState, key: string) {
    if (!this.session || !key || this.workspaceKey !== key) return;
    this.localState = { ...this.localState, ...state };
    this.localDirty = true;
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => void this.flushLocalState(), 300);
  }

  /** The opening of the project that is open now (see saveLocalState), or null. */
  get openingKey(): string | null {
    return this.workspaceKey;
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

  async apply(batch: EditBatch, opts: { label?: string; coalesceKey?: string; opening?: string } = {}): Promise<ApplyResult> {
    const session = this.session;
    if (!session) return { ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'No project is open.', recoverable: false } };
    // Made in an opening of a project that has since started closing, closed or been switched away from (even
    // one reopened at the same folder): never applied to this one.
    if (opts.opening !== undefined && opts.opening !== this.workspaceKey) return { ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } };
    // The AI owns the project from the moment it starts, before its run takes the session's write lock.
    if (this.aiBusy()) return { ok: false, revision: session.revision, error: { code: 'BUSY', message: 'The AI is making changes. Stop it before editing.', recoverable: true } };
    const codeOps = new Set(['component.createCode', 'component.updateSource', 'component.convertToCode']);
    const state = session.state;
    const copiesCode = (o: { type: string; definitionId?: string; owner?: { kind: string; id: string }; nodeId?: string }) => {
      if (o.type === 'component.duplicate') return state.components[o.definitionId ?? '']?.kind === 'code';
      if (o.type === 'component.makeUnique' && o.owner && o.nodeId) {
        const tree = o.owner.kind === 'page' ? state.pages[o.owner.id] : o.owner.kind === 'shell' ? state.site.shell[o.owner.id as 'header'] : state.components[o.owner.id]?.tree;
        const n = tree?.nodes[o.nodeId];
        return n?.kind === 'instance' && state.components[n.definitionId]?.kind === 'code';
      }
      return codeOps.has(o.type);
    };
    if (!(await loadSettings()).settings.developerMode && batch.operations.some((o) => copiesCode(o as never)))
      return { ok: false, revision: session.revision, error: { code: 'SCOPE_MISMATCH', message: 'Turn on Developer mode in Settings to work with code.', recoverable: true } };
    // An edit belongs to the project it was made in: one closing, closed or switched meanwhile never receives it.
    if (this.session !== session || this.closing) return { ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } };
    return session.apply(batch, { label: opts.label ?? batch.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' });
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
    return this.serialImport(() => s.withImport(async () => {
      const ids: string[] = [];
      const errors: string[] = refused ? [`${refused} file${refused === 1 ? ' was' : 's were'} skipped because ${refused === 1 ? 'it is' : 'they are'} not ${only === 'font' ? 'a font' : only === 'document' ? 'a document' : 'an image'}.`] : [];
      const notes: string[] = [];
      const ops: Array<{ type: 'asset.add'; asset: AssetRecord }> = [];
      const backfills = [];
      // Files imported earlier in this batch count as existing too: the same picture dropped twice is one asset.
      const known = Object.values(s.state.assets.assets);
      // One time for the whole import, so the images it adds are listed together and by name.
      const createdAt = new Date().toISOString();
      for (const [i, f] of picked.entries()) {
        // A project closed or taken over meanwhile gets nothing more: the rest of the batch is not converted for nothing.
        if (this.session !== s || this.closing) {
          errors.push(`${picked.length - i === 1 ? `${basename(f)} was` : `${picked.length - i} files were`} not added because the project was closed.`);
          break;
        }
        try {
          const r = reviewed.get(f);
          // Written only while the project is still open and this app's; the decoding and converting are done before.
          const { record, existing, font, note } = await importAsset(s.dir, f, known, this.writeFence(s), {
            decoder: this.photoDecoder,
            createdAt,
            ...(r ? { webCopy: r.webCopy, fingerprint: r.fingerprint } : {})
          });
          if (note) notes.push(note);
          if (!ids.includes(record.id)) ids.push(record.id);
          if (font) backfills.push({ type: 'asset.update' as const, assetId: record.id, font });
          if (!existing) {
            ops.push({ type: 'asset.add' as const, asset: record });
            known.push(record);
          }
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
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
    }));
  }

  /** What a web-sized copy of a large library image would be, or null when none can be made from it. */
  async webCopyPlan(assetId: string): Promise<{ format: 'JPEG' | 'PNG' | 'JPEG or PNG'; width: number; height: number } | null> {
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
          if ('smaller' in made) return { ok: false, message: `A web-sized copy of ${name} would be no smaller, so it was left as it is.` };
          const ops = [
            ...(made.existing ? [] : [{ type: 'asset.add' as const, asset: made.record }]),
            ...(opts.replace ? [{ type: 'asset.replace' as const, assetId, withAssetId: made.record.id }] : [])
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

  async exportStatic(format: ExportFormat = 'folder', published?: string[]): Promise<ExportResult> {
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
      else await publishFolder(from, dest, stillOwned);
      return null;
    } catch (e) {
      if (e instanceof ExportStopped) return e.message;
      if (format === 'folder' && (e as NodeJS.ErrnoException).code === 'EEXIST') return 'Choose a new folder; the export never overwrites an existing location.';
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
    const warnings = ['Private files such as .env, keys and credentials were left out.'];
    return this.withStaging(async (staging) => {
      const folder = join(staging, 'project');
      const snap = await this.snapshotSource(s, folder);
      if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
      await settleServerHook(folder, publishedState(snap.state));
      // The exported source is the published site; its drafts are kept to edit but not built.
      const live = publishedState(snap.state);
      warnings.push(...draftSourceNotes(snap.state), ...sectionLinkWarnings(live), ...unlinkedButtonWarnings(live));
      for (const { file, route, draft } of withheldStaticFiles(folder, snap.state))
        warnings.push(`${file} is served at ${route}, the address of the draft ${draft}, so a build of the exported project publishes it there. Remove or move the file before building.`);
      const kept = locationKeptNote(await locatedPhotos(folder, snap.state));
      if (kept) warnings.push(kept);
      warnings.push(...missingSourceWarnings(snap.state, await findMissingAssetFiles(folder, snap.state.assets.assets)));
      const ownNotFound = ownNotFoundFileNote(folder);
      if (ownNotFound) warnings.push(ownNotFound);
      const problem = await this.publish(s, folder, dest, format, `${slugify(snap.state.site.name) || 'website'}-source`);
      if (problem) return { ok: false, message: problem, warnings: [] };
      this.exportPaths.add(dest);
      this.recordExport(s, { kind: 'source', format, path: dest, revision: snap.revision, exportedAt: new Date().toISOString() });
      return { ok: true, path: dest, message: format === 'zip' ? 'Source project exported as a ZIP file.' : 'Source project exported.', warnings, revision: snap.revision };
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

  /** A fresh staging folder per export: only the folder created here is ever removed. */
  private async withStaging(fn: (staging: string) => Promise<ExportResult>): Promise<ExportResult> {
    const stagingRoot = join(app.getPath('userData'), 'build-staging');
    await fs.mkdir(stagingRoot, { recursive: true });
    const staging = mkdtempSync(join(stagingRoot, 'export-'));
    try {
      return await fn(staging);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Copy a consistent snapshot of the project while holding the writer lock: generated files must match their
   * manifest, and nothing may change on disk while the copy runs. A snapshot that will be built must carry the
   * build configuration the user trusted, because the build runs the copy. The state returned is the one the
   * files were copied from, so everything said about the export describes this snapshot.
   */
  private snapshotSource(s: ProjectSession, dest: string, opts: { forBuild?: boolean } = {}): Promise<{ ok: true; revision: number; state: ProjectState } | { ok: false; message: string }> {
    const stop = (message: string) => ({ ok: false as const, message });
    return s.exclusive(async () => {
      // The native dialog and the queue for the lock both give the project time to change.
      if (this.session !== s) return stop('The project was closed before the export started.');
      const blocked = this.exportBlocked();
      if (blocked) return stop(blocked.message);
      // Another app may have taken the project over meanwhile: only the lock's owner exports it (spec 20).
      if (!(await s.stillOwner())) return stop(s.readOnly?.reason ?? READ_ONLY);
      const before = await projectFingerprint(s.dir);
      const edited = await editedGeneratedFile(s.dir);
      if (edited) return stop(`${edited} was changed outside SiteOrigin Builder. Open Project health to restore it, then export again.`);
      // Both exports are the published site: its pages decide whether it needs the generated server hook.
      const rival = await rivalHookStop(s.dir, publishedState(s.state));
      if (rival) return stop(rival);
      await copyProjectSource(s.dir, dest, { keepAsset: exportedAssetFilter(s.state) });
      // Both exports carry the published site's generated files; the drafts stay in the canonical documents.
      await leaveOutDrafts(dest, s.state);
      if (opts.forBuild) {
        if (!(await isTrusted(s.dir, await configHash(dest)))) return stop("This project's build settings changed outside SiteOrigin Builder. Reopen the project to review them.");
      } else await finishExportedSource(dest, s.state, starterNotice());
      if ((await projectFingerprint(s.dir)) !== before) return stop('The project changed on disk while it was being exported. Export again.');
      if (!(await s.stillOwner())) return stop(s.readOnly?.reason ?? READ_ONLY);
      return { ok: true as const, revision: s.revision, state: structuredClone(s.state) };
    });
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

  private async buildFromStaging(s: ProjectSession, staging: string, dest: string, format: ExportFormat, shown?: string[]): Promise<ExportResult> {
    const project = join(staging, 'project');
    const snap = await this.snapshotSource(s, project, { forBuild: true });
    if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
    await settleServerHook(project, publishedState(snap.state));
    const { revision, state } = snap;
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
    const missingFiles = await missingWebsiteAssets(project, state);
    const missing = missingFiles.filter((m) => m.used);
    if (missing.length) {
      void this.checkAssetFiles(s);
      return { ok: false, ...missingAssetsStop(missing), assetId: missing[0].asset.id };
    }
    // The snapshot keeps the whole library, as the editable project does; visitors get only the files the site uses.
    // Credits are read first: a page can use a responsive copy whose original is pruned.
    const credits = await variantCredits(project, state);
    const omitted = await pruneWebsiteAssets(project, state);
    // What visitors download carries no location or device metadata; the project's own photos keep theirs.
    const photos = await cleanWebsitePhotos(project, state, credits);
    if (photos.failed.length) return { ok: false, message: uncleanablePhotosMessage(photos.failed), warnings: [] };
    // The build gets its own copy of the tools: what they write must not land in the project, which may have been
    // taken over by the time the build starts.
    try {
      await copyProjectTools(s.dir, project);
    } catch (e) {
      return { ok: false, message: 'The website tools are not set up. Open Project health and reinstall them, then export again.', warnings: [(e as Error).message] };
    }
    const build = await buildProject(project);
    if (!build.ok) return { ok: false, ...explainBuildFailure(live, build, this.buildFailureContext(staging, project, s.dir)) };
    const out = join(project, 'build');
    const warnings: string[] = [];
    // Verify page inventory.
    for (const id of live.site.pageOrder) {
      const p = live.pages[id];
      const file = join(out, p.route === '/' ? 'index.html' : join(p.route, 'index.html'));
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${p.route}.`, warnings };
      const html = await fs.readFile(file, 'utf8');
      if (/data-so-(ctx|node)|siteorigin-bridge/.test(html)) return { ok: false, message: `Editor-only markup was found in ${p.route}. Export aborted.`, warnings };
      const language = pageLanguageWarning(live, p, html);
      if (language) warnings.push(language);
    }
    // Old addresses kept working are pages of their own on a static host: each must be there to send visitors on.
    for (const { from } of liveRedirects(live)) {
      const file = join(out, from, 'index.html');
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${from}, an old address that should send visitors on.`, warnings };
      if (/data-so-(ctx|node)|siteorigin-bridge/.test(await fs.readFile(file, 'utf8'))) return { ok: false, message: `Editor-only markup was found in ${from}. Export aborted.`, warnings };
    }
    // Nothing may answer at a draft's address, or at an old address that leads to one: a file of the same name in
    // static/, say, would publish the address the author kept back.
    const kept = new Set(liveRedirects(live).map((r) => r.from.toLowerCase()));
    const withheld = [
      ...Object.values(state.pages).filter((p) => !Object.hasOwn(live.pages, p.id)).map((p) => ({ route: p.route, page: p })),
      ...liveRedirects(state).filter((r) => !kept.has(r.from.toLowerCase())).map((r) => ({ route: r.from, page: r.page }))
    ];
    for (const { route, page } of withheld)
      if (existsSync(join(out, route, 'index.html'))) return { ok: false, message: `The website has a page at ${route}, which leads to the draft ${page.title}. Remove the file that puts it there, then export again.`, warnings };
    // The not-found page, which hosts show at any address the site does not have.
    const notFound = await readNotFoundPage(out);
    const notFoundStop = notFoundPageProblem(notFound);
    if (notFoundStop || notFound === null) return { ok: false, message: notFoundStop ?? '', warnings };
    for (const f of await listFiles(out)) {
      if (/\.js$/.test(f) && /siteorigin-bridge|data-so-ctx/.test(await fs.readFile(join(out, f), 'utf8'))) return { ok: false, message: 'Editor-only code was found in the build. Export aborted.', warnings };
    }
    // Images the build brought in from somewhere other than the cleaned sources (a package, generated code).
    const unchecked = await cleanBuiltSite(out);
    if (unchecked.length) return { ok: false, message: builtPhotosMessage(unchecked), warnings };
    if (!state.site.baseUrl) warnings.push('No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. Add one in Site settings.');
    const placeholders = placeholderImageCount(live);
    if (placeholders) warnings.push(placeholders === 1 ? 'One image has not been chosen yet and shows a placeholder.' : `${placeholders} images have not been chosen yet and show placeholders.`);
    warnings.push(...unlinkedButtonWarnings(live));
    const absent = new Set(missingFiles.filter((m) => m.missing.original).map((m) => m.asset.id));
    for (const a of Object.values(state.assets.assets)) if (a.bytes > 1_500_000 && !omitted.includes(a) && !absent.has(a.id)) warnings.push(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
    warnings.push(...missingUnusedWarnings(missingFiles));
    const left = omittedAssetsWarning(omitted);
    if (left) warnings.push(left);
    const located = locationRemovedNote(photos.located);
    if (located) warnings.push(located);
    const relative = notFoundAddressWarning(notFound);
    if (relative) warnings.push(relative);
    const pages = live.site.pageOrder.length;
    const exported = `${pages} page${pages === 1 ? '' : 's'}`;
    const problem = await this.publish(s, out, dest, format);
    if (problem) return { ok: false, message: problem, warnings };
    warnings.push(notFoundHostNote(basePath(state)));
    const exportedAt = new Date().toISOString();
    this.exportPaths.add(dest);
    if (format === 'zip') {
      this.recordExport(s, { kind: 'site', format, path: dest, revision, exportedAt });
      return { ok: true, path: dest, message: `Exported ${exported} as a ZIP file.`, warnings, revision };
    }
    // The export is done either way; a preview that cannot start only loses the preview button.
    const previewUrl = await this.previewAndRecord(s, { kind: 'site', format, path: dest, revision, exportedAt }, basePath(state));
    return { ok: true, path: dest, message: `Exported ${exported}.`, warnings, revision, previewUrl };
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
export function friendlyError(msg: string): string {
  if (/Downloading the website tools failed|network|offline|ENOTCACHED/i.test(msg) || NETWORK_CODES.some((code) => msg.includes(code)))
    return 'The website tools could not be downloaded. Check your internet connection and try again. A connection is only needed once.';
  if (/ENOSPC/i.test(msg)) return 'Your disk is full. Free up some space and try again.';
  if (/EACCES|EPERM/i.test(msg)) return 'SiteOrigin Builder does not have permission to write to that folder. Choose a folder in your Documents and try again.';
  if (/Cancelled/i.test(msg)) return 'Cancelled.';
  return msg.length > 200 ? 'Setting up the website tools failed. Open Diagnostics for details, then choose Reinstall website tools.' : msg;
}

