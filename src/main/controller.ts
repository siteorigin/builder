import { app, BrowserWindow, dialog, shell } from 'electron';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, lstatSync, mkdtempSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CreateProjectOptions, ExportFormat, ExportResult, LocalWorkspaceState, ProjectSnapshot, ProgressEvent, RuntimeState } from '@shared/api';
import type { ApplyResult, EditBatch } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState, STARTER_ASSETS } from '@catalogue/starters';
import { slugify } from '@shared/routes';
import { assetUsages, sourceHash } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { basePath, generateManagedComponent, generatePage, defFile } from '@generator/index';
import { placeholderImageCount } from '@generator/checks';
import { zipDirectory } from './zip';
import { copyProjectSource, editedGeneratedFile, exportedAssetFilter, finishExportedSource, listFiles, omittedAssetsWarning, projectFingerprint, projectReadme, publishFolder, pruneWebsiteAssets, uniqueChild } from './export';
import { ProjectLockedError, ProjectSession } from './project/session';
import { MANIFEST_FILE, ProjectFormatError } from './project/documents';
import { FONT_EXTENSIONS, IMAGE_EXTENSIONS, importAsset, isAssetOfKind } from './project/assets';
import { atomicWrite, readIfExists, sha } from './project/fsutil';
import { DevServer, buildProject, dependenciesReady, prepareDependencies } from './runtime/manager';
import { canonicalDir } from '../runtime/policy';
import { addRecent, isTrusted, loadSettings, trust } from './settings';
import { newId } from '@shared/ids';

const INSTANCE_ID = randomUUID();

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
  private staticServer: Server | null = null;
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
  onSessionOpened: ((s: ProjectSession) => Promise<void>) | null = null;
  onSessionClosing: (() => Promise<void>) | null = null;
  aiBusy = () => false;

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
      runtime: (this.dev?.status ?? { state: 'idle' }) as RuntimeState,
      recoveryNotes: s.recoveryNotes,
      aiBusy: this.aiBusy(),
      assetUsage: safeUsages(s),
      conflicts: s.conflicts,
      readOnly: s.readOnly,
      themeUpdates: s.readOnly ? undefined : themeUpdates(s.state),
      localState: this.localState,
      workspaceKey: this.workspaceKey ?? ''
    };
  }

  broadcast() {
    const snap = this.snapshot();
    if (snap) this.send('project:changed', snap);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private progress(p: ProgressEvent) {
    this.send('create:progress', p);
  }

  async create(opts: CreateProjectOptions): Promise<{ ok: boolean; message?: string }> {
    const name = opts.name.trim();
    if (!name) return { ok: false, message: 'Enter a project name.' };
    let dir = join(opts.parentDir, slugify(name) || 'website');
    if (existsSync(dir) && (await fs.readdir(dir)).length) return { ok: false, message: `${dir} already exists and is not empty. Choose another name or folder.` };
    const createdDir = !existsSync(dir);
    this.createAbort = new AbortController();
    const signal = this.createAbort.signal;
    await this.close();
    try {
      this.progress({ step: 'files', message: 'Preparing project files…' });
      await fs.mkdir(dir, { recursive: true });
      // One name for the folder from here on: the build tools resolve links and must agree with the session.
      dir = canonicalDir(dir);
      await fs.cp(join(resourcesDir(), 'templates', 'sveltekit-brochure', 'files'), dir, { recursive: true });
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      pkg.name = slugify(name) || 'website';
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
      const lockPath = join(dir, 'package-lock.json');
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.name = pkg.name;
      if (lock.packages?.['']) lock.packages[''].name = pkg.name;
      await fs.writeFile(lockPath, JSON.stringify(lock, null, '\t') + '\n');
      await fs.writeFile(join(dir, 'README.md'), projectReadme(name));
      const notice = starterNotice();
      const assetsDir = join(resourcesDir(), 'resources', 'starter-assets');
      const withImages = opts.starter === 'business' && opts.sampleImages && existsSync(assetsDir);
      const state = createStarterState(opts.starter, name, withImages);
      if (withImages) {
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
        if (existsSync(notice)) await fs.copyFile(notice, join(dir, 'NOTICE.md'));
      }
      if (signal.aborted) throw new Error('Cancelled');
      const session = await ProjectSession.create(dir, state);
      await session.acquireLock(INSTANCE_ID);
      await trust(dir, await configHash(dir));
      this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: 'Installing the tools that build and preview your site.' });
      await prepareDependencies(dir, (line) => this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: line.slice(0, 160) }), signal);
      if (signal.aborted) throw new Error('Cancelled');
      this.progress({ step: 'preview', message: 'Starting preview…' });
      await this.attach(session, {});
      await addRecent(dir, name);
      this.progress({ step: 'done', message: 'Ready' });
      return { ok: true };
    } catch (e) {
      const msg = friendlyError((e as Error).message);
      await this.close();
      // Remove only the folder this attempt created.
      if (createdDir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.progress({ step: 'error', message: msg === 'Cancelled' ? 'Project creation was cancelled.' : 'The project could not be created.', detail: msg });
      return { ok: false, message: msg };
    } finally {
      this.createAbort = null;
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
    return this.openTrusted(dir);
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

  private async openTrusted(dir: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; message?: string }> {
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
            canUnlock: locked
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
    return this.openTrusted(s.dir, { force: true });
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
    this.session = session;
    this.localState = workspace;
    this.localDirty = false;
    this.workspaceKey = `${session.dir}#${++this.openings}`;
    session.on('changed', (ev) => {
      this.dev?.notifyRevision(ev.revision);
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
    const run = this.runtimeQueue.then(() => this.startRuntimeNow());
    this.runtimeQueue = run.catch(() => undefined);
    return run;
  }

  private async startRuntimeNow() {
    const session = this.session;
    if (!session) return;
    await this.dev?.stop();
    // Executable configuration must still be what the user trusted.
    if (!(await isTrusted(session.dir, await configHash(session.dir)))) {
      this.send('runtime:status', { state: 'error', message: "This project's build settings changed outside SiteOrigin Builder. Close and reopen the project to review and trust them." });
      return;
    }
    if (!(await dependenciesReady(session.dir))) {
      if (session.readOnly) {
        this.send('runtime:status', { state: 'error', message: 'The preview is not available while this project is read-only, because its website tools are not set up.' });
        return;
      }
      const status: RuntimeState = { state: 'preparing', message: 'Setting up website tools…' };
      this.send('runtime:status', status);
      try {
        await prepareDependencies(session.dir, (line) => this.send('runtime:status', { state: 'preparing', message: line.slice(0, 120) }));
      } catch (e) {
        this.send('runtime:status', { state: 'error', message: friendlyError((e as Error).message), detail: (e as Error).message });
        this.broadcast();
        return;
      }
    }
    if (this.session !== session) return;
    const dev = new DevServer(session.dir);
    this.dev = dev;
    dev.onStatus((s) => {
      this.send('runtime:status', s);
      this.broadcast();
    });
    await dev.start();
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
        if (!r.ok && r.message && r.message !== 'Busy') this.send('runtime:status', this.dev?.status ?? { state: 'idle' });
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

  /** Reinstall the website's tools from scratch (the dependency manager's repair action). */
  async repairDependencies() {
    const s = this.session;
    if (!s || s.readOnly) return;
    await this.dev?.stop();
    this.dev = null;
    this.send('runtime:status', { state: 'preparing', message: 'Reinstalling website tools…' });
    await fs.rm(join(s.dir, 'node_modules'), { recursive: true, force: true });
    await fs.rm(join(s.dir, '.siteorigin', 'cache', 'deps.json'), { force: true });
    await this.startRuntime();
  }

  async close() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    // The exported-site preview belongs to the project that exported it.
    this.staticServer?.close();
    this.staticServer = null;
    if (!this.session) return;
    // Workspace state belongs to the project it was saved in: accept no more of it, and write it before the lock goes.
    this.workspaceKey = null;
    await this.onSessionClosing?.();
    await this.dev?.stop();
    this.dev = null;
    await this.flushLocalState();
    // One more try if that write failed: this is the last chance before the lock goes.
    if (this.localDirty) await this.flushLocalState();
    await this.session.close();
    this.session = null;
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
      // A failed write (a full disk) is tried again with the next change, or when the project closes.
      this.localWrites = this.localWrites
        .then(() => atomicWrite(file, bytes))
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

  async apply(batch: EditBatch, opts: { label?: string; coalesceKey?: string } = {}): Promise<ApplyResult> {
    if (!this.session) return { ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'No project is open.', recoverable: false } };
    const codeOps = new Set(['component.createCode', 'component.updateSource', 'component.convertToCode']);
    const state = this.session.state;
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
      return { ok: false, revision: this.session.revision, error: { code: 'SCOPE_MISMATCH', message: 'Turn on Developer mode in Settings to work with code.', recoverable: true } };
    return this.session.apply(batch, { label: opts.label ?? batch.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' });
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
    const dest = await this.chooseExportTarget('source', format);
    if (!dest) return { ok: false, message: '', warnings: [] };
    return this.exportSourceTo(dest, format);
  }

  async exportStatic(format: ExportFormat = 'folder'): Promise<ExportResult> {
    const blocked = this.exportBlocked();
    if (blocked) return blocked;
    const dest = await this.chooseExportTarget('site', format);
    if (!dest) return { ok: false, message: '', warnings: [] };
    return this.buildStaticTo(dest, format);
  }

  private exportBlocked(): ExportResult | null {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project open.', warnings: [] };
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
    // Compared by real path: a linked parent folder can lead back into the project. The destination may not exist yet.
    const rel = relative(s.dir, join(canonicalDir(dirname(dest)), basename(dest)));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return 'Choose a location outside the project folder.';
    return null;
  }

  /** Put a finished folder in place, reporting a location that appeared in the meantime instead of merging into it. */
  private async publish(from: string, dest: string): Promise<string | null> {
    try {
      await publishFolder(from, dest);
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'Choose a new folder; the export never overwrites an existing location.';
      throw e;
    }
  }

  /** Export the editable project to `dest` (a new folder, or a ZIP file). Used by export and tests. */
  async exportSourceTo(dest: string, format: ExportFormat = 'folder'): Promise<ExportResult> {
    const s = this.session!;
    const bad = this.badExportTarget(s, dest, format);
    if (bad) return { ok: false, message: bad, warnings: [] };
    const warnings = ['Private files such as .env, keys and credentials were left out.'];
    return this.withStaging(async (staging) => {
      const folder = join(staging, 'project');
      const snap = await this.snapshotSource(s, folder);
      if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
      if (format === 'zip') await zipDirectory(folder, dest, `${slugify(snap.state.site.name) || 'website'}-source`);
      else {
        const problem = await this.publish(folder, dest);
        if (problem) return { ok: false, message: problem, warnings: [] };
      }
      this.exportPaths.add(dest);
      return { ok: true, path: dest, message: format === 'zip' ? 'Source project exported as a ZIP file.' : 'Source project exported.', warnings, revision: snap.revision };
    });
  }

  /** Build the production site and copy it to `dest` (a new folder, or a ZIP file). Used by export and tests. */
  async buildStaticTo(dest: string, format: ExportFormat = 'folder'): Promise<ExportResult> {
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
      const before = await projectFingerprint(s.dir);
      const edited = await editedGeneratedFile(s.dir);
      if (edited) return stop(`${edited} was changed outside SiteOrigin Builder. Open Project health to restore it, then export again.`);
      await copyProjectSource(s.dir, dest, { keepAsset: exportedAssetFilter(s.state) });
      if (opts.forBuild) {
        if (!(await isTrusted(s.dir, await configHash(dest)))) return stop("This project's build settings changed outside SiteOrigin Builder. Reopen the project to review them.");
      } else await finishExportedSource(dest, s.state, starterNotice());
      if ((await projectFingerprint(s.dir)) !== before) return stop('The project changed on disk while it was being exported. Export again.');
      return { ok: true as const, revision: s.revision, state: structuredClone(s.state) };
    });
  }

  private async buildFromStaging(s: ProjectSession, staging: string, dest: string, format: ExportFormat): Promise<ExportResult> {
    const project = join(staging, 'project');
    const snap = await this.snapshotSource(s, project, { forBuild: true });
    if (!snap.ok) return { ok: false, message: snap.message, warnings: [] };
    const { revision, state } = snap;
    // The snapshot keeps the whole library, as the editable project does; visitors get only the files the site uses.
    const omitted = await pruneWebsiteAssets(project, state);
    await fs.symlink(join(s.dir, 'node_modules'), join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const build = await buildProject(project);
    if (!build.ok) return { ok: false, message: 'The production build failed.', warnings: [stripAnsi(build.error ?? ''), ...build.logs.map(stripAnsi)].filter(Boolean).slice(0, 8) };
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
    for (const f of await listFiles(out)) {
      if (/\.js$/.test(f) && /siteorigin-bridge|data-so-ctx/.test(await fs.readFile(join(out, f), 'utf8'))) return { ok: false, message: 'Editor-only code was found in the build. Export aborted.', warnings };
    }
    if (!state.site.baseUrl) warnings.push('No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. Add one in Site settings.');
    const placeholders = placeholderImageCount(state);
    if (placeholders) warnings.push(placeholders === 1 ? 'One image has not been chosen yet and shows a placeholder.' : `${placeholders} images have not been chosen yet and show placeholders.`);
    for (const a of Object.values(state.assets.assets)) if (a.bytes > 1_500_000 && !omitted.includes(a)) warnings.push(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
    const left = omittedAssetsWarning(omitted);
    if (left) warnings.push(left);
    const pages = state.site.pageOrder.length;
    if (format === 'zip') {
      await zipDirectory(out, dest);
      this.exportPaths.add(dest);
      return { ok: true, path: dest, message: `Exported ${pages} pages as a ZIP file.`, warnings, revision };
    }
    const problem = await this.publish(out, dest);
    if (problem) return { ok: false, message: problem, warnings };
    this.exportPaths.add(dest);
    // The export is done either way; a preview that cannot start only loses the preview button.
    const previewUrl = await this.serveStatic(dest, basePath(state)).catch(() => undefined);
    return { ok: true, path: dest, message: `Exported ${pages} pages.`, warnings, revision, previewUrl };
  }

  /**
   * Serve an exported folder over loopback HTTP so it can be previewed as a real static site, under the
   * site's base path when it is published in a sub-folder.
   */
  private async serveStatic(root: string, base = ''): Promise<string> {
    this.staticServer?.close();
    this.staticServer = null;
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.gif': 'image/gif', '.avif': 'image/avif' };
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const pathname = decodeURIComponent(url.pathname);
        if (base && (pathname === '/' || pathname === base)) {
          res.writeHead(301, { location: `${base}/${url.search}` });
          return res.end();
        }
        if (base && !pathname.startsWith(`${base}/`)) throw new Error('outside base');
        let p = base ? pathname.slice(base.length) : pathname;
        const realRoot = await fs.realpath(root);
        const contained = async (path: string) => {
          const real = await fs.realpath(normalize(join(root, path)));
          const rel = relative(realRoot, real);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('denied');
          return real;
        };
        let real = await contained(p);
        if ((await fs.stat(real)).isDirectory()) {
          // Pages are folders with an index.html: "/about" redirects to "/about/" as static hosts do.
          if (!p.endsWith('/')) {
            res.writeHead(301, { location: `${url.pathname}/${url.search}` });
            return res.end();
          }
          p += 'index.html';
          real = await contained(p);
        }
        const data = await fs.readFile(real);
        res.writeHead(200, { 'content-type': types[extname(real)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        const nfPath = join(root, '404.html');
        const nf = existsSync(nfPath) && !lstatSync(nfPath).isSymbolicLink() ? await fs.readFile(nfPath).catch(() => null) : null;
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(nf ?? 'Not found');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.staticServer = server;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}/`;
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
