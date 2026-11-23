import { app, BrowserWindow, dialog, shell } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdtempSync, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CreateProjectOptions, ExportFormat, ExportResult, LocalWorkspaceState, ProjectSnapshot, ProgressEvent, RecentExport, RuntimeState } from '@shared/api';
import type { ApplyResult, EditBatch } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState, STARTER_ASSETS } from '@catalogue/starters';
import { slugify } from '@shared/routes';
import { assetUsages, sourceHash } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { basePath, generateManagedComponent, generatePage, defFile, liveRedirects } from '@generator/index';
import { placeholderImageCount } from '@generator/checks';
import { zipDirectory } from './zip';
import { StaticPreviews } from './static-preview';
import { builtPhotosMessage, cleanBuiltSite, cleanWebsitePhotos, copyProjectSource, editedGeneratedFile, explainBuildFailure, exportedAssetFilter, finishExportedSource, listFiles, locatedPhotos, locationKeptNote, locationRemovedNote, omittedAssetsWarning, projectFingerprint, projectReadme, publishFolder, pruneWebsiteAssets, readLibraryImage, sectionLinkWarnings, uncleanablePhotosMessage, uniqueChild, variantCredits } from './export';
import { LOCAL_DIR, NO_LOCK, ProjectLockedError, ProjectSession } from './project/session';
import { DOC_DIR, MANIFEST_FILE, ProjectFormatError } from './project/documents';
import { FONT_EXTENSIONS, IMAGE_EXTENSIONS, importAsset, isAssetOfKind } from './project/assets';
import { atomicWrite, readIfExists, sha } from './project/fsutil';
import { photoMetadata } from './project/photo-metadata';
import { DevServer, buildProject, dependenciesReady, prepareDependencies } from './runtime/manager';
import { copyProjectTools, createPreviewStage, removePreviewStage, sweepPreviewStages, syncPreviewStage } from './runtime/stage';
import { canonicalDir } from '../runtime/policy';
import { addRecent, isTrusted, loadSettings, trust } from './settings';
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
  /** Previews of the open project's exported websites, one per export. */
  private previews = new StaticPreviews();
  /** What the open project exported since it was opened, newest first. */
  private recentExports: RecentExport[] = [];
  private localState: LocalWorkspaceState = {};
  /** Names this opening of the project in workspace saves; null while none is open or the open one is closing. */
  private workspaceKey: string | null = null;
  private openings = 0;
  private localDirty = false;
  private localTimer: NodeJS.Timeout | null = null;
  private localWrites: Promise<void> = Promise.resolve();
  private exportPaths = new Set<string>();
  private watchers: FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
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
      diagnostics: s.diagnostics(),
      runtime: this.runtimeStatus(),
      recoveryNotes: s.recoveryNotes,
      aiBusy: this.aiBusy(),
      aiRunId: this.aiRunId(),
      assetUsage: safeUsages(s),
      conflicts: s.conflicts,
      readOnly: s.readOnly,
      themeUpdates: s.readOnly ? undefined : themeUpdates(s.state),
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
    if (s && previewUnavailable(s)) return { state: 'unavailable', message: PREVIEW_UNAVAILABLE };
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
    // Cancel is offered from the moment Create is pressed, so it works from then on. A later creation (the window was
    // closed and opened again meanwhile) has its own, which this one never clears.
    const abort = new AbortController();
    this.createAbort = abort;
    try {
      return await this.createProject(opts, abort.signal);
    } finally {
      if (this.createAbort === abort) this.createAbort = null;
    }
  }

  private async createProject(opts: CreateProjectOptions, signal: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    const name = opts.name.trim();
    if (!name) return { ok: false, message: 'Enter a project name.' };
    let dir = join(opts.parentDir, slugify(name) || 'website');
    if (existsSync(dir) && (await fs.readdir(dir)).length) return { ok: false, message: `${dir} already exists and is not empty. Choose another name or folder.` };
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
    let session: ProjectSession | null = null;
    // Set once this attempt starts writing the project's own documents, and once it holds the new project's lock.
    let sessionStarted = false;
    let locked = false;
    await this.close();
    try {
      if (signal.aborted) throw new Error('Cancelled');
      this.progress({ step: 'files', message: 'Preparing project files…' });
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
      await trust(dir, await configHash(dir));
      this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: 'Installing the tools that build and preview your site.' });
      own('node_modules');
      await prepareDependencies(dir, (line) => this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: line.slice(0, 160) }), signal);
      if (signal.aborted) throw new Error('Cancelled');
      this.progress({ step: 'preview', message: 'Starting preview…' });
      // The preview writes its own output into the folder.
      own('.svelte-kit');
      await this.attach(session, {});
      // The project is open and working: a recent-projects list that cannot be saved must not undo it.
      await addRecent(dir, name).catch(() => undefined);
      this.progress({ step: 'done', message: 'Ready' });
      return { ok: true };
    } catch (e) {
      let msg = friendlyError((e as Error).message);
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
      // A project that could not be closed is still open in the editor: it gets its manifest back, and none of it goes.
      const closed = await this.close().then(
        () => true,
        () => false
      );
      const kept = dropped.manifest;
      if (!closed && kept) await session!.whileOwner(() => atomicWrite(manifestPath, kept)).catch(() => false);
      if (!ours || !closed) {
        if (wrote.size) msg = `${msg} The new project’s files were left in ${dir}.`;
        wrote.clear();
        createdDir = false;
      }
      if (!(await removeCreatedProject(dir, closed ? session : null, wrote, createdDir))) msg = `${msg} Some of the new project’s files could not be removed from ${dir}.`;
      this.progress({ step: 'error', message: msg === 'Cancelled' ? 'Project creation was cancelled.' : 'The project could not be created.', detail: msg });
      return { ok: false, message: msg };
    }
  }

  cancelCreate() {
    this.createAbort?.abort();
  }

  async open(dirArg?: string): Promise<{ ok: boolean; message?: string; needsTrust?: { dir: string; name: string } }> {
    // Every exit is a structured result: a thrown error would reject the IPC call and leave the Welcome screen busy.
    try {
      return await this.openChosen(dirArg);
    } catch (e) {
      return { ok: false, message: `Could not open the project: ${(e as Error).message}` };
    }
  }

  private async openChosen(dirArg?: string): Promise<{ ok: boolean; message?: string; needsTrust?: { dir: string; name: string } }> {
    let dir = dirArg;
    if (!dir) {
      const win = this.getWindow();
      const r = await dialog.showOpenDialog(win!, { title: 'Open a SiteOrigin Builder project', defaultPath: existsSync(defaultProjectsFolder()) ? defaultProjectsFolder() : undefined, properties: ['openDirectory', 'openFile'], filters: [{ name: 'SiteOrigin project', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
      if (basename(dir) === MANIFEST_FILE) dir = join(dir, '..');
    }
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
    // Switching projects: the one open now is left only once what is being typed in it is saved.
    if (!(await this.mayLeave())) return { ok: false };
    return this.openTrusted(dir);
  }

  async trustAndOpen(opened: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const dir = canonicalDir(opened);
      if (!(await this.mayLeave())) return { ok: false };
      await trust(dir, await configHash(dir));
      return await this.openTrusted(dir);
    } catch (e) {
      return { ok: false, message: `Could not open the project: ${(e as Error).message}` };
    }
  }

  private async openTrusted(dir: string, opts: { force?: boolean | string } = {}): Promise<{ ok: boolean; message?: string }> {
    await this.close();
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
            lockToken: locked ? e.owner.token : undefined
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
    if (!session.readOnly) await addRecent(dir, session.state.site.name).catch(() => undefined);
    void this.attach(session, workspace).catch(async (e) => {
      if (this.session === session) await this.close();
      else await session.close();
      this.send('runtime:status', { state: 'error', message: `The project could not be opened: ${(e as Error).message}` });
    });
    return { ok: true };
  }

  /** Take over a project another app holds (the user confirmed it is not running) and reopen it for editing. */
  async unlock(): Promise<{ ok: boolean; message?: string }> {
    const s = this.session;
    if (!s?.readOnly?.canUnlock) return { ok: false, message: 'This project is not locked.' };
    // Reopening closes this read-only session: a page being added in it is settled (or kept) first.
    if (!(await this.mayLeave())) return { ok: false };
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

  /** Make `session` the open project, with its own workspace state installed in the same step. */
  private async attach(session: ProjectSession, workspace: LocalWorkspaceState) {
    // A new opening lists only its own exports, even if an earlier one was never closed.
    this.endExports();
    this.session = session;
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
    });
    session.on('history', () => this.broadcast());
    await this.onSessionOpened?.(session);
    this.broadcast();
    this.watchExternalChanges(session);
    await this.startRuntime();
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

  /** Accept valid external edits to canonical documents and authored code components. */
  private watchExternalChanges(session: ProjectSession) {
    for (const w of this.watchers) w.close();
    this.watchers = [];
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
    const s = this.session;
    if (!s) return this.endExports();
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
    // The exported websites' previews belong to the project that exported them. A close that failed before this
    // point leaves the project open, and its previews with it.
    this.endExports();
    this.prepareAbort?.abort();
    await this.stopPreview();
    await this.runtimeQueue;
    await this.stopPreview();
    await s.close();
    // The next project loads its own workspace state, or starts empty.
    this.localState = {};
    this.send('project:closed');
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

  /** What private metadata an image asset's original carries. Only a library file inside the project is read. */
  async photoMetadata(assetId: string): Promise<{ location: boolean; device: boolean } | null> {
    const s = this.session;
    const a = s?.state.assets.assets[assetId];
    const buf = s && a ? await readLibraryImage(s.dir, a) : null;
    return buf ? photoMetadata(buf) : null;
  }

  /** Import files. `only` limits a picker that can only use one kind, before anything is written to the project. */
  async importAssets(paths?: string[], only?: 'image' | 'font'): Promise<{ ok: boolean; assetIds: string[]; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, assetIds: [] };
    if (s.readOnly) return { ok: false, assetIds: [], message: s.readOnly.reason };
    let files = paths;
    if (!files?.length) {
      const r = await dialog.showOpenDialog(this.getWindow()!, {
        title: only === 'font' ? 'Import fonts' : only === 'image' ? 'Import images' : 'Import images or fonts',
        properties: ['openFile', 'multiSelections'],
        filters: only === 'font' ? [{ name: 'Fonts', extensions: FONT_EXTENSIONS }] : only === 'image' ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }] : [{ name: 'Images and fonts', extensions: [...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS] }, { name: 'Images', extensions: IMAGE_EXTENSIONS }, { name: 'Fonts', extensions: FONT_EXTENSIONS }]
      });
      if (r.canceled) return { ok: false, assetIds: [] };
      files = r.filePaths;
    }
    const picked = only ? files.filter((f) => isAssetOfKind(f, only)) : files;
    const refused = files.length - picked.length;
    // Files are written before their asset records exist, so the session holds off sweeping assets meanwhile.
    return s.withImport(async () => {
      const ids: string[] = [];
      const errors: string[] = refused ? [`${refused} file${refused === 1 ? ' was' : 's were'} skipped because ${refused === 1 ? 'it is' : 'they are'} not ${only === 'font' ? 'a font' : 'an image'}.`] : [];
      const ops = [];
      const backfills = [];
      // Files imported earlier in this batch count as existing too: the same picture dropped twice is one asset.
      const known = Object.values(s.state.assets.assets);
      for (const f of picked) {
        try {
          const { record, existing, font } = await importAsset(s.dir, f, known);
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
        const noun = ops.every((o) => o.asset.kind === 'font') ? ['font', 'fonts'] : ops.every((o) => o.asset.kind === 'image') ? ['image', 'images'] : ['file', 'files'];
        const r = await s.apply({ operations: ops }, { label: ops.length === 1 ? `Import ${noun[0]}` : `Import ${ops.length} ${noun[1]}`, source: 'user' });
        if (!r.ok) return { ok: false, assetIds: [], message: r.error?.message };
      }
      return { ok: errors.length === 0, assetIds: ids, message: errors.join(' ') || undefined };
    });
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

  async exportStatic(format: ExportFormat = 'folder'): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session;
    const dest = await this.chooseExportTarget('site', format);
    if (!dest) return { ok: false, message: '', warnings: [] };
    if (this.session !== s) return { ok: false, message: 'The project was closed before the export started.', warnings: [] };
    return this.buildStaticTo(dest, format);
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
      warnings.push(...sectionLinkWarnings(snap.state));
      const kept = locationKeptNote(await locatedPhotos(folder, snap.state));
      if (kept) warnings.push(kept);
      const problem = await this.publish(s, folder, dest, format, `${slugify(snap.state.site.name) || 'website'}-source`);
      if (problem) return { ok: false, message: problem, warnings: [] };
      this.exportPaths.add(dest);
      this.recordExport(s, { kind: 'source', format, path: dest, revision: snap.revision, exportedAt: new Date().toISOString() });
      return { ok: true, path: dest, message: format === 'zip' ? 'Source project exported as a ZIP file.' : 'Source project exported.', warnings, revision: snap.revision };
    });
  }

  /** Build the production site and copy it to `dest` (a new folder, or a ZIP file). Used by export and tests. */
  async buildStaticTo(dest: string, format: ExportFormat = 'folder'): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const s = this.session!;
    const bad = this.badExportTarget(s, dest, format);
    if (bad) return { ok: false, message: bad, warnings: [] };
    // Build an isolated snapshot so the running preview and later edits cannot mix into the output.
    return this.withStaging((staging) => this.buildFromStaging(s, staging, dest, format));
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
      await copyProjectSource(s.dir, dest, { keepAsset: exportedAssetFilter(s.state) });
      if (opts.forBuild) {
        if (!(await isTrusted(s.dir, await configHash(dest)))) return stop("This project's build settings changed outside SiteOrigin Builder. Reopen the project to review them.");
      } else await finishExportedSource(dest, s.state, starterNotice());
      if ((await projectFingerprint(s.dir)) !== before) return stop('The project changed on disk while it was being exported. Export again.');
      if (!(await s.stillOwner())) return stop(s.readOnly?.reason ?? READ_ONLY);
      return { ok: true as const, revision: s.revision, state: structuredClone(s.state) };
    });
  }

  private async buildFromStaging(s: ProjectSession, staging: string, dest: string, format: ExportFormat): Promise<ExportResult> {
    const project = join(staging, 'project');
    const snap = await this.snapshotSource(s, project, { forBuild: true });
    if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
    const { revision, state } = snap;
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
    if (!build.ok) return { ok: false, ...explainBuildFailure(state, [stripAnsi(build.error ?? ''), ...build.logs.map(stripAnsi)]) };
    const out = join(project, 'build');
    const warnings: string[] = [];
    // Verify page inventory.
    for (const id of state.site.pageOrder) {
      const p = state.pages[id];
      const file = join(out, p.route === '/' ? 'index.html' : join(p.route, 'index.html'));
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${p.route}.`, warnings };
      const html = await fs.readFile(file, 'utf8');
      if (/data-so-(ctx|node)|siteorigin-bridge/.test(html)) return { ok: false, message: `Editor-only markup was found in ${p.route}. Export aborted.`, warnings };
    }
    // Old addresses kept working are pages of their own on a static host: each must be there to send visitors on.
    for (const { from } of liveRedirects(state)) {
      const file = join(out, from, 'index.html');
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${from}, an old address that should send visitors on.`, warnings };
      if (/data-so-(ctx|node)|siteorigin-bridge/.test(await fs.readFile(file, 'utf8'))) return { ok: false, message: `Editor-only markup was found in ${from}. Export aborted.`, warnings };
    }
    for (const f of await listFiles(out)) {
      if (/\.js$/.test(f) && /siteorigin-bridge|data-so-ctx/.test(await fs.readFile(join(out, f), 'utf8'))) return { ok: false, message: 'Editor-only code was found in the build. Export aborted.', warnings };
    }
    // Images the build brought in from somewhere other than the cleaned sources (a package, generated code).
    const unchecked = await cleanBuiltSite(out);
    if (unchecked.length) return { ok: false, message: builtPhotosMessage(unchecked), warnings };
    if (!state.site.baseUrl) warnings.push('No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. Add one in Site settings.');
    const placeholders = placeholderImageCount(state);
    if (placeholders) warnings.push(placeholders === 1 ? 'One image has not been chosen yet and shows a placeholder.' : `${placeholders} images have not been chosen yet and show placeholders.`);
    for (const a of Object.values(state.assets.assets)) if (a.bytes > 1_500_000 && !omitted.includes(a)) warnings.push(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
    const left = omittedAssetsWarning(omitted);
    if (left) warnings.push(left);
    const located = locationRemovedNote(photos.located);
    if (located) warnings.push(located);
    const pages = state.site.pageOrder.length;
    const problem = await this.publish(s, out, dest, format);
    if (problem) return { ok: false, message: problem, warnings };
    const exportedAt = new Date().toISOString();
    this.exportPaths.add(dest);
    if (format === 'zip') {
      this.recordExport(s, { kind: 'site', format, path: dest, revision, exportedAt });
      return { ok: true, path: dest, message: `Exported ${pages} pages as a ZIP file.`, warnings, revision };
    }
    // The export is done either way; a preview that cannot start only loses the preview button.
    const previewUrl = await this.previewAndRecord(s, { kind: 'site', format, path: dest, revision, exportedAt }, basePath(state));
    return { ok: true, path: dest, message: `Exported ${pages} pages.`, warnings, revision, previewUrl };
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
    return assetUsages(s.state);
  } catch (e) {
    if (s.readOnly) return {};
    throw e;
  }
}

/** Plain-language explanations for setup failures; the technical detail stays available in diagnostics. */
export function friendlyError(msg: string): string {
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|offline|ENOTCACHED/i.test(msg))
    return 'The website tools could not be downloaded. Check your internet connection and try again. A connection is only needed once.';
  if (/ENOSPC/i.test(msg)) return 'Your disk is full. Free up some space and try again.';
  if (/EACCES|EPERM/i.test(msg)) return 'SiteOrigin Builder does not have permission to write to that folder. Choose a folder in your Documents and try again.';
  if (/Cancelled/i.test(msg)) return 'Cancelled.';
  return msg.length > 200 ? 'Setting up the website tools failed. Open Diagnostics for details, then choose Reinstall website tools.' : msg;
}

const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
