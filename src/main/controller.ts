import { app, BrowserWindow, dialog, shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, lstatSync, mkdtempSync, promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CreateProjectOptions, ExportResult, LocalWorkspaceState, ProjectSnapshot, ProgressEvent, RuntimeState } from '@shared/api';
import type { ApplyResult, EditBatch } from '@shared/ops';
import { createStarterState, STARTER_ASSETS } from '@catalogue/starters';
import { slugify } from '@shared/routes';
import { assetUsages, sourceHash } from '@engine/apply';
import { generateManagedComponent, generatePage, defFile } from '@generator/index';
import { ProjectSession } from './project/session';
import { MANIFEST_FILE, ProjectFormatError } from './project/documents';
import { importAsset } from './project/assets';
import { atomicWrite, readIfExists, sha } from './project/fsutil';
import { DevServer, buildProject, dependenciesReady, freePort, prepareDependencies } from './runtime/manager';
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

async function configHash(dir: string): Promise<string> {
  const parts = await Promise.all(['package.json', 'package-lock.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js'].map((f) => readIfExists(join(dir, f))));
  return sha(parts.map((p) => p ?? '').join('\n--\n'));
}

export class Controller {
  session: ProjectSession | null = null;
  dev: DevServer | null = null;
  private createAbort: AbortController | null = null;
  private staticServer: Server | null = null;
  private localState: LocalWorkspaceState = {};
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
      assetUsage: assetUsages(s.state),
      conflicts: s.conflicts,
      localState: this.localState
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
    const dir = join(opts.parentDir, slugify(name) || 'website');
    if (existsSync(dir) && (await fs.readdir(dir)).length) return { ok: false, message: `${dir} already exists and is not empty. Choose another name or folder.` };
    const createdDir = !existsSync(dir);
    this.createAbort = new AbortController();
    const signal = this.createAbort.signal;
    await this.close();
    try {
      this.progress({ step: 'files', message: 'Preparing project files…' });
      await fs.mkdir(dir, { recursive: true });
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
      }
      if (signal.aborted) throw new Error('Cancelled');
      const session = await ProjectSession.create(dir, state);
      await session.acquireLock(INSTANCE_ID);
      await trust(dir, await configHash(dir));
      this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: 'Installing the tools that build and preview your site.' });
      await prepareDependencies(dir, (line) => this.progress({ step: 'dependencies', message: 'Setting up website tools…', detail: line.slice(0, 160) }), signal);
      if (signal.aborted) throw new Error('Cancelled');
      this.progress({ step: 'preview', message: 'Starting preview…' });
      await this.attach(session);
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
    let dir = dirArg;
    if (!dir) {
      const win = this.getWindow();
      const r = await dialog.showOpenDialog(win!, { title: 'Open a SiteOrigin Builder project', defaultPath: existsSync(defaultProjectsFolder()) ? defaultProjectsFolder() : undefined, properties: ['openDirectory', 'openFile'], filters: [{ name: 'SiteOrigin project', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
      if (basename(dir) === MANIFEST_FILE) dir = join(dir, '..');
    }
    if (!existsSync(join(dir, MANIFEST_FILE))) return { ok: false, message: 'That folder is not a SiteOrigin Builder project. Choose a folder that contains siteorigin.project.json.' };
    if (!(await isTrusted(dir, await configHash(dir)))) {
      const manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_FILE))) ?? '{}');
      return { ok: false, needsTrust: { dir, name: manifest.name ?? basename(dir) } };
    }
    return this.openTrusted(dir);
  }

  async trustAndOpen(dir: string) {
    await trust(dir, await configHash(dir));
    return this.openTrusted(dir);
  }

  private async openTrusted(dir: string): Promise<{ ok: boolean; message?: string }> {
    await this.close();
    let session: ProjectSession;
    try {
      session = await ProjectSession.open(dir, INSTANCE_ID);
    } catch (e) {
      if (e instanceof ProjectFormatError) return { ok: false, message: e.message };
      return { ok: false, message: `Could not open the project: ${(e as Error).message}` };
    }
    this.localState = JSON.parse((await readIfExists(session.local('workspace.json'))) ?? '{}');
    await addRecent(dir, session.state.site.name);
    void this.attach(session);
    return { ok: true };
  }

  private async attach(session: ProjectSession) {
    this.session = session;
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
    if (!s) return;
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
    await this.onSessionClosing?.();
    await this.dev?.stop();
    this.dev = null;
    await this.session.close();
    this.session = null;
    this.send('project:closed');
  }

  async duplicate(): Promise<{ ok: boolean; message?: string; dir?: string }> {
    const s = this.session;
    if (!s) return { ok: false };
    const r = await dialog.showSaveDialog(this.getWindow()!, { title: 'Duplicate project', defaultPath: `${s.dir}-copy`, buttonLabel: 'Duplicate' });
    if (r.canceled || !r.filePath) return { ok: false };
    const dest = r.filePath;
    if (existsSync(dest)) return { ok: false, message: 'Choose a new folder name; that location already exists.' };
    await copyProjectSource(s.dir, dest);
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

  saveLocalState(state: LocalWorkspaceState) {
    this.localState = { ...this.localState, ...state };
    if (this.session) void atomicWrite(this.session.local('workspace.json'), JSON.stringify(this.localState));
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

  async importAssets(paths?: string[]): Promise<{ ok: boolean; assetIds: string[]; message?: string }> {
    const s = this.session;
    if (!s) return { ok: false, assetIds: [] };
    let files = paths;
    if (!files?.length) {
      const r = await dialog.showOpenDialog(this.getWindow()!, { title: 'Import images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'] }] });
      if (r.canceled) return { ok: false, assetIds: [] };
      files = r.filePaths;
    }
    const ids: string[] = [];
    const errors: string[] = [];
    const ops = [];
    for (const f of files) {
      try {
        const { record, existing } = await importAsset(s.dir, f, Object.values(s.state.assets.assets));
        ids.push(record.id);
        if (!existing) ops.push({ type: 'asset.add' as const, asset: record });
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (ops.length) {
      const r = await s.apply({ operations: ops }, { label: ops.length === 1 ? 'Import image' : `Import ${ops.length} images`, source: 'user' });
      if (!r.ok) return { ok: false, assetIds: [], message: r.error?.message };
    }
    return { ok: errors.length === 0, assetIds: ids, message: errors.join(' ') || undefined };
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

  async exportSource(): Promise<ExportResult> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project open.', warnings: [] };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish before exporting.', warnings: [] };
    if (s.conflicts.length) return { ok: false, message: 'Resolve file conflicts before exporting.', warnings: [] };
    const r = await dialog.showSaveDialog(this.getWindow()!, { title: 'Export source project', defaultPath: join(app.getPath('documents'), `${slugify(s.state.site.name) || 'website'}-source`), buttonLabel: 'Export' });
    if (r.canceled || !r.filePath) return { ok: false, message: '', warnings: [] };
    if (existsSync(r.filePath)) return { ok: false, message: 'Choose a new folder; the export never overwrites an existing location.', warnings: [] };
    await copyProjectSource(s.dir, r.filePath);
    this.exportPaths.add(r.filePath);
    return { ok: true, path: r.filePath, message: 'Source project exported.', warnings: ['Private files such as .env, keys and credentials were left out.'], revision: s.revision };
  }

  async exportStatic(): Promise<ExportResult> {
    const s = this.session;
    if (!s) return { ok: false, message: 'No project open.', warnings: [] };
    if (this.aiBusy()) return { ok: false, message: 'Wait for the AI to finish before exporting.', warnings: [] };
    if (s.conflicts.length) return { ok: false, message: 'Resolve file conflicts before exporting.', warnings: [] };
    const r = await dialog.showSaveDialog(this.getWindow()!, { title: 'Export static website', defaultPath: join(app.getPath('documents'), `${slugify(s.state.site.name) || 'website'}-site`), buttonLabel: 'Export' });
    if (r.canceled || !r.filePath) return { ok: false, message: '', warnings: [] };
    return this.buildStaticTo(r.filePath);
  }

  /** Build the production site and copy it to `dest`. Used by export and tests. */
  async buildStaticTo(dest: string): Promise<ExportResult> {
    const s = this.session!;
    if (existsSync(dest)) return { ok: false, message: 'Choose a new folder; the export never overwrites an existing location.', warnings: [] };
    const revision = s.revision;
    const before = await this.sourceFingerprint();
    // Build an isolated snapshot so the running preview and later edits cannot mix into the output.
    if (!(await isTrusted(s.dir, await configHash(s.dir)))) return { ok: false, message: "This project's build settings changed outside SiteOrigin Builder. Reopen the project to review them.", warnings: [] };
    const stagingRoot = join(app.getPath('userData'), 'build-staging');
    await fs.mkdir(stagingRoot, { recursive: true });
    // A fresh folder per export: only the folder created here is ever removed.
    const staging = mkdtempSync(join(stagingRoot, 'export-'));
    try {
      return await this.buildFromStaging(s, staging, dest, revision, before);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private async buildFromStaging(s: ProjectSession, staging: string, dest: string, revision: number, before: string): Promise<ExportResult> {
    await copyProjectSource(s.dir, staging);
    await fs.symlink(join(s.dir, 'node_modules'), join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const build = await buildProject(staging);
    if (!build.ok) return { ok: false, message: 'The production build failed.', warnings: [stripAnsi(build.error ?? ''), ...build.logs.map(stripAnsi)].filter(Boolean).slice(0, 8) };
    if (s.revision !== revision || (await this.sourceFingerprint()) !== before)
      return { ok: false, message: 'The project changed during the build. Export again.', warnings: [] };
    const out = join(staging, 'build');
    const warnings: string[] = [];
    // Verify page inventory.
    for (const id of s.state.site.pageOrder) {
      const p = s.state.pages[id];
      const file = join(out, p.route === '/' ? 'index.html' : join(p.route, 'index.html'));
      if (!existsSync(file)) return { ok: false, message: `The build is missing ${p.route}.`, warnings };
      const html = await fs.readFile(file, 'utf8');
      if (/data-so-(ctx|node)|siteorigin-bridge/.test(html)) return { ok: false, message: `Editor-only markup was found in ${p.route}. Export aborted.`, warnings };
    }
    for (const f of await listFiles(out)) {
      if (/\.js$/.test(f) && /siteorigin-bridge|data-so-ctx/.test(await fs.readFile(join(out, f), 'utf8'))) return { ok: false, message: 'Editor-only code was found in the build. Export aborted.', warnings };
    }
    if (!s.state.site.baseUrl) warnings.push('No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. Add one in Site settings.');
    const placeholders = Object.values(s.state.pages).some((p) => JSON.stringify(p).includes('"assetId":null'));
    if (placeholders) warnings.push('Some images have not been chosen yet and show placeholders.');
    for (const a of Object.values(s.state.assets.assets)) if (a.bytes > 1_500_000) warnings.push(`${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB; consider a smaller image.`);
    await fs.cp(out, dest, { recursive: true });
    this.exportPaths.add(dest);
    const previewUrl = await this.serveStatic(dest);
    return { ok: true, path: dest, message: `Exported ${s.state.site.pageOrder.length} pages.`, warnings, revision, previewUrl };
  }

  private async sourceFingerprint(): Promise<string> {
    const s = this.session!;
    const files = (await listFiles(join(s.dir, 'src'))).sort();
    const parts: string[] = [];
    for (const f of files) parts.push(f + ':' + sha(await fs.readFile(join(s.dir, 'src', f))));
    return sha(parts.join('\n'));
  }

  /** Serve an exported folder over loopback HTTP so it can be previewed as a real static site. */
  private async serveStatic(root: string): Promise<string> {
    this.staticServer?.close();
    const port = await freePort();
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.gif': 'image/gif', '.avif': 'image/avif' };
    this.staticServer = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        const abs = normalize(join(root, p));
        const realRoot = await fs.realpath(root);
        const real = await fs.realpath(abs);
        const rel = relative(realRoot, real);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('denied');
        const data = await fs.readFile(real);
        res.writeHead(200, { 'content-type': types[extname(abs)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        const nfPath = join(root, '404.html');
        const nf = existsSync(nfPath) && !lstatSync(nfPath).isSymbolicLink() ? await fs.readFile(nfPath).catch(() => null) : null;
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(nf ?? 'Not found');
      }
    }).listen(port, '127.0.0.1');
    return `http://127.0.0.1:${port}/`;
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

const EXCLUDE_TOP = new Set(['node_modules', '.siteorigin', '.svelte-kit', 'build', '.git', '.DS_Store']);

/** Private files that never leave the project folder. */
const PRIVATE_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/i;

async function copyProjectSource(src: string, dest: string) {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      const rel = relative(src, p);
      if (!rel) return true;
      const top = rel.split(sep)[0];
      if (EXCLUDE_TOP.has(top) || /\.tmp$/.test(p)) return false;
      if (PRIVATE_FILE.test(basename(p))) return false;
      try {
        if (lstatSync(p).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      return true;
    }
  });
  // A clean, credential-free npm configuration.
  await fs.writeFile(join(dest, '.npmrc'), 'engine-strict=true\n');
}

async function listFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

function projectReadme(name: string): string {
  return `# ${name}

This website was created with [SiteOrigin Builder](https://siteorigin.com). It is a normal [SvelteKit](https://svelte.dev/docs/kit) project and does not need SiteOrigin Builder to run or build.

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
