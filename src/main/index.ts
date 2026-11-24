import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, net, session as electronSession, shell, Menu } from 'electron';
import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';
import { join, dirname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { ImportChoices, LocalWorkspaceState, ProviderId, SettingsPatch } from '@shared/api';
import { externalLink } from '@shared/links';
import { visitorStepKey } from '@shared/preview-keys';
import { checkLocalBaseURL } from '@shared/local';
import { Controller, defaultProjectsFolder, resourcesDir } from './controller';
import { installedCatalogue, loadInstalledPacks, packPreview, packRoots } from './packs/installed';
import { createLeaveGate, type LeaveAnswer } from './leave-gate';
import { menuKeyCopy } from './history-keys';
import { createMenuCommands, type MenuCommand } from './menu-commands';
import { writingMenuTemplate } from './writing-menu';
import { loadSettings, localEndpoint, providerStatuses, recents, removeRecent, setKey, updateSettings, getKey } from './settings';
import { Orchestrator } from '@agent/orchestrator';
import { OpenAIAdapter, testOpenAI } from '@agent/openai';
import { AnthropicAdapter, testAnthropic } from '@agent/anthropic';
import { LocalAdapter, listLocalModels, testLocal } from '@agent/local';
import { compileProject } from './compile';
import { checkSvelteSource, componentSources } from './codecheck';
import { stopMediaWorker } from './project/assets';
import { playerFrameAllowed, sameOrigin } from './player-frames';
import { stopPhotoDecoders } from './project/photo-convert';
import { fixComponentSource } from '@agent/fixer';
import type { Diagnostic } from '@engine/validate';

const here = dirname(fileURLToPath(import.meta.url));
// Tests and side-by-side development can isolate settings, credentials and caches.
if (process.env.SITEORIGIN_USER_DATA) app.setPath('userData', process.env.SITEORIGIN_USER_DATA);
let win: BrowserWindow | null = null;
const controller = new Controller(() => win);

// Never touch the macOS keychain (Chromium would otherwise use it for its own encrypted storage).
app.commandLine.appendSwitch('use-mock-keychain');

// Automated runs never put a window on screen or take focus. Playwright's Electron loader defines
// __playwright_run before this module loads; SITEORIGIN_HEADLESS=1 forces it for other drivers, and
// SITEORIGIN_HEADED=1 shows the window when debugging a test.
const headless =
  process.env.SITEORIGIN_HEADED !== '1' &&
  (process.env.SITEORIGIN_HEADLESS === '1' || typeof (globalThis as { __playwright_run?: unknown }).__playwright_run === 'function');
if (headless) {
  // A hidden window must keep painting, running timers and animation frames at full speed.
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  // No Dock icon, no menu bar takeover, no focus stealing.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
}

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

const pendingInspections = new Map<string, (report: unknown) => void>();

// Leaving a project (Close Project, switching, closing the window, quitting) first lets the editor save what
// is still being typed, and ask the author about a change that cannot be saved.
const leaveGate = createLeaveGate({
  request: (requestId) => {
    if (!win || win.isDestroyed() || win.webContents.isCrashed()) return false;
    controller.send('lifecycle:request', { requestId });
    return true;
  },
  // Tests never see a native dialog: a page that stops answering there is left.
  onTimeout: async (signal) => {
    if (headless || !win || win.isDestroyed()) return 'leave';
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Wait', 'Leave Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'SiteOrigin Builder is not responding',
      detail: 'A change you were typing may not be saved yet. Wait for it, or leave without it.',
      signal
    });
    return r.response === 1 ? 'leave' : 'wait';
  }
});
controller.beforeLeave = () => leaveGate.ask();
// File menu commands reach the editor once it is ready for them, bringing up a window when there is none (macOS).
const menuCommands = createMenuCommands<BrowserWindow>({
  window: () => (win && !win.isDestroyed() ? win : null),
  openWindow: () =>
    void createWindow().catch((e: unknown) => {
      console.error('The window could not be opened:', e);
      menuCommands.windowFailed();
    }),
  opening: () => controller.openingKey,
  send: (w, command) => w.webContents.send('menu:command', command)
});
controller.onOpeningChange = () => updateProjectMenu();
let fixAbort: AbortController | null = null;

async function orchestratorAdapter() {
  return orchestratorDeps.adapter();
}

const orchestratorDeps = {
  adapter: async () => {
    const s = (await loadSettings()).settings.ai;
    const provider = s.provider;
    if (!provider) return { error: 'Choose an AI provider in Settings to use the assistant.' };
    if (provider === 'local') {
      const endpoint = await localEndpoint();
      // A server that runs a single model needs no choice in Settings.
      if (!endpoint.model) {
        const found = await listLocalModels(endpoint);
        if (!found.ok) return { error: found.message ?? 'Could not reach the local server.' };
        if (!found.models.length) return { error: 'The local server has no models loaded.' };
        endpoint.model = found.models[0];
      }
      return { adapter: new LocalAdapter(endpoint), model: endpoint.model, provider };
    }
    const key = await getKey(provider);
    if (!key) return { error: `Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings to use the assistant.` };
    const model = s.models[provider];
    return { adapter: provider === 'openai' ? new OpenAIAdapter(key.key, model) : new AnthropicAdapter(key.key, model), model, provider };
  }
} as { adapter: () => Promise<{ adapter: import('@agent/types').AgentModelAdapter; model: string; provider: ProviderId } | { error: string }> };

const orchestrator = new Orchestrator({
  session: () => controller.session,
  adapter: orchestratorDeps.adapter,
  emit: (e) => controller.send('ai:event', e),
  compileAll: async (): Promise<Diagnostic[]> => (controller.session ? compileProject(controller.session.state) : []),
  inspectLayout: (pageId, width) =>
    new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pendingInspections.delete(requestId);
        reject(new Error('The preview did not respond in time.'));
      }, 50000); // The renderer may load the page twice (two 20s attempts plus a pause) before answering.
      pendingInspections.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      controller.send('inspect:request', { requestId, pageId, width });
    }),
  onBusyChange: () => controller.broadcast(),
  codeEnabled: async () => (await loadSettings()).settings.developerMode
});
// Only a request that may change the site holds it: a read-only question leaves the author editing, exporting
// and resolving conflicts as usual.
controller.aiBusy = () => orchestrator.editing;
controller.aiRunId = () => (orchestrator.editing ? orchestrator.runId : null);
controller.onSessionOpened = async (s) => {
  orchestrator.reset();
  // Another app took the project over: stop the assistant (the session already refuses its writes).
  s.on('lock-lost', () => orchestrator.stop());
};
/** A read-only project (newer format, or another app is editing it) refuses anything that writes to it. */
const readOnlyReason = () => controller.session?.readOnly?.reason ?? null;

/** An import review's confirmed choices from the renderer, kept only as far as they are well formed. */
function importChoices(v: unknown): ImportChoices | undefined {
  const c = v as { opening?: unknown; files?: unknown } | null | undefined;
  if (!c || typeof c.opening !== 'string' || !Array.isArray(c.files)) return undefined;
  const files = c.files.flatMap((f: { path?: unknown; fingerprint?: unknown; webCopy?: unknown }) =>
    f && typeof f.path === 'string' && typeof f.fingerprint === 'string' ? [{ path: f.path, fingerprint: f.fingerprint, webCopy: f.webCopy === true }] : []
  );
  return { opening: c.opening, files };
}
controller.onSessionClosing = async () => {
  orchestrator.stop();
  // Let a running request finish reverting before the project lock is released.
  for (let i = 0; i < 100 && orchestrator.busy; i++) await new Promise((r) => setTimeout(r, 50));
  orchestrator.reset();
};

// ---------------------------------------------------------------------------
// IPC: every handler checks that the sender is our editor window.
// ---------------------------------------------------------------------------

/** The editor's own origin: the dev server only in unpackaged builds, otherwise app://editor. */
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
function isEditorUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'app:' && u.host === 'editor') return true;
    return !!DEV_URL && u.origin === new URL(DEV_URL).origin;
  } catch {
    return false;
  }
}

function handle(channel: string, fn: (...args: never[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Unauthorized sender');
    // Only the editor's main frame may use privileged IPC (never the preview iframe).
    if (event.senderFrame !== win.webContents.mainFrame || !isEditorUrl(event.senderFrame.url)) throw new Error('Unauthorized frame');
    return (fn as (...a: unknown[]) => unknown)(...args);
  });
}

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dev: !app.isPackaged }));
  handle('app:catalogue', () => installedCatalogue());
  handle('packs:preview', (packId: unknown, file: unknown) => packPreview(packId, file));
  handle('app:getSettings', async () => (await loadSettings()).settings);
  handle('app:setSettings', async (patch: SettingsPatch) => {
    const before = (await loadSettings()).settings.ai;
    const url = checkLocalBaseURL(before.local.baseURL, before.local.allowRemote);
    // Withdrawing permission ends work in progress at once, which would otherwise keep sending to that server.
    if (before.provider === 'local' && url.ok && url.remote && patch.ai?.local && 'allowRemote' in patch.ai.local && patch.ai.local.allowRemote !== true) {
      orchestrator.stop();
      fixAbort?.abort();
    }
    const s = await updateSettings(patch);
    nativeTheme.themeSource = s.appearance;
    return s;
  });
  handle('app:openExternal', async (url: string) => {
    if (headless) return;
    // Web pages, email addresses and phone numbers only, each checked: the link may come from the previewed site.
    const link = externalLink(url);
    if (link) await shell.openExternal(link.href);
  });
  handle('dialogs:chooseFolder', async (title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialogs:defaultProjectsFolder', () => defaultProjectsFolder());
  handle('projects:recents', () => recents());
  handle('projects:removeRecent', (dir: string) => removeRecent(dir));
  handle('projects:create', (opts) => controller.create(opts));
  handle('projects:cancelCreate', () => controller.cancelCreate());
  handle('projects:websiteTools', () => controller.websiteTools());
  handle('projects:open', (dir?: unknown, opts?: unknown) => {
    if (dir != null && typeof dir !== 'string') return { ok: false, message: 'Could not open the project: no folder or file was named.' };
    return controller.open(dir ?? undefined, { folder: (opts as { folder?: unknown } | null | undefined)?.folder === true });
  });
  handle('projects:cancelOpen', () => controller.cancelUnpacking());
  handle('projects:trustAndOpen', (dir: string) => controller.trustAndOpen(dir));
  handle('projects:close', () => controller.closeProject());
  handle('projects:duplicate', () => controller.duplicate());
  handle('projects:reveal', (p?: string) => controller.revealInFinder(p));
  handle('project:snapshot', () => controller.snapshot());
  handle('project:apply', (batch, opts) => controller.apply(batch, opts));
  // One node, or several siblings copied together (the session checks they are siblings on that page).
  const nodeIds = (v: unknown): v is string | string[] => typeof v === 'string' || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'));
  handle('project:copy', (pageId: unknown, nodeId: unknown, rev: unknown) =>
    typeof pageId === 'string' && nodeIds(nodeId) && typeof rev === 'number' && controller.session
      ? controller.session.copy(pageId, nodeId, rev)
      : { ok: false, message: 'Nothing to copy.' }
  );
  // The focused field's own Undo and Redo (in the editor, a dialog or the preview frame): the renderer sends
  // these only when a text field owns history; project history goes through project:undo and project:redo.
  handle('edit:undo', () => win?.webContents.undo());
  handle('edit:redo', () => win?.webContents.redo());
  handle('project:undo', () => controller.session?.undo());
  handle('project:undoEntry', (entryId: unknown, key: unknown) =>
    typeof entryId === 'string' && typeof key === 'string'
      ? controller.undoEntry(entryId, key)
      : { ok: false, revision: controller.session?.revision ?? 0, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: false } }
  );
  handle('project:redo', () => controller.session?.redo());
  const kindOf = (only: unknown) => (only === 'image' || only === 'font' || only === 'document' ? only : undefined);
  const pathList = (paths: unknown) => (Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : undefined);
  handle('project:reviewImport', (paths?: unknown, only?: unknown) => controller.reviewImport(pathList(paths), kindOf(only)));
  handle('project:importAssets', (paths?: unknown, only?: unknown, choices?: unknown) => controller.importAssets(pathList(paths), kindOf(only), importChoices(choices)));
  handle('project:webCopyPlan', (assetId: unknown) => (typeof assetId === 'string' ? controller.webCopyPlan(assetId) : null));
  handle('project:makeWebCopy', (assetId: unknown, opts: unknown) => {
    const o = (opts ?? {}) as { replace?: unknown; opening?: unknown };
    return typeof assetId === 'string' && typeof o.opening === 'string' ? controller.makeWebCopy(assetId, { replace: o.replace === true, opening: o.opening }) : { ok: false };
  });
  handle('project:photoMetadata', (assetId: unknown) => (typeof assetId === 'string' ? controller.photoMetadata(assetId) : null));
  handle('project:locateAsset', (assetId: string, path?: string) => controller.locateAsset(String(assetId), typeof path === 'string' && path ? path : undefined));
  handle('project:regenerateAssetCopies', (assetId: string) => controller.regenerateAssetCopies(String(assetId)));
  handle('project:storage', (key: unknown) => (typeof key === 'string' ? controller.storageInfo(key) : null));
  handle('project:reclaimStorage', (plan: unknown, key: unknown) =>
    typeof plan === 'string' && typeof key === 'string' ? controller.reclaimStorage(plan, key) : { ok: false, message: 'Nothing to free.' }
  );
  // Saved versions (issue 260).
  handle('project:saveVersion', (name: unknown, key: unknown) =>
    typeof name === 'string' && typeof key === 'string' ? controller.saveVersion(name, key) : { ok: false, message: 'Give the version a name.' }
  );
  handle('project:reviewVersion', (id: unknown, key: unknown) =>
    typeof id === 'string' && typeof key === 'string' ? controller.reviewVersion(id, key) : { ok: false, message: 'That saved version is no longer there.' }
  );
  const paths = (v: unknown): v is string[] => Array.isArray(v) && v.every((f) => typeof f === 'string');
  handle('project:restoreVersion', (id: unknown, revision: unknown, reviewed: unknown, key: unknown) => {
    const r = reviewed as { files?: unknown; replaced?: unknown } | null;
    return typeof id === 'string' && Number.isInteger(revision) && r && paths(r.files) && paths(r.replaced) && typeof key === 'string'
      ? controller.restoreVersion(id, revision as number, { files: r.files, replaced: r.replaced }, key)
      : { ok: false, message: 'That saved version is no longer there.' };
  });
  handle('project:deleteVersion', (id: unknown, key: unknown) =>
    typeof id === 'string' && typeof key === 'string' ? controller.deleteVersion(id, key) : { ok: false, message: 'That saved version is no longer there.' }
  );
  // Export builds from the project folder and needs the writer lock (spec 20).
  handle('project:exportSource', (format?: unknown) => (readOnlyReason() ? { ok: false, message: readOnlyReason(), warnings: [] } : controller.exportSource(format === 'zip' ? 'zip' : 'folder')));
  handle('project:exportStatic', (format?: unknown, published?: unknown) =>
    readOnlyReason()
      ? { ok: false, message: readOnlyReason(), warnings: [] }
      : controller.exportStatic(format === 'zip' ? 'zip' : 'folder', Array.isArray(published) ? published.filter((id): id is string => typeof id === 'string') : undefined)
  );
  handle('project:retryPreview', () => controller.startRuntime());
  handle('project:repairDependencies', () => controller.repairDependencies());
  handle('project:readSource', (id: string) => controller.readSource(id));
  handle('project:generatedSource', (kind: 'component' | 'page', id: string) => controller.generatedSource(kind, id));
  handle('project:restoreGenerated', (p: string) => controller.session?.restoreGeneratedFile(p));
  handle('project:resolveConflict', (p: string, choice: 'keep' | 'restore') => controller.resolveConflict(p, choice));
  handle('project:unlock', () => controller.unlock());
  handle('project:saveLocalState', (s: LocalWorkspaceState, key: string) => controller.saveLocalState(s, String(key ?? '')));
  handle('project:validateSource', async (source: string) => {
    const problems = await checkSvelteSource(String(source));
    const errors = problems.filter((p) => p.severity === 'error');
    return { ok: errors.length === 0, errors: errors.map((e) => (e.line ? `Line ${e.line}: ` : '') + e.message), diagnostics: problems };
  });
  handle('project:flush', async () => undefined);
  // Development-only hooks used by the end-to-end tests in place of native save dialogs.
  if (!app.isPackaged) {
    handle('test:exportStatic', (dest: string, format?: unknown) => controller.buildStaticTo(dest, format === 'zip' ? 'zip' : 'folder'));
    handle('test:exportSource', (dest: string, format?: unknown) => controller.exportSourceTo(dest, format === 'zip' ? 'zip' : 'folder'));
  }
  handle('ai:providers', () => providerStatuses());
  handle('ai:setKey', async (p: ProviderId, key: string | null) => {
    await setKey(p, key);
    return providerStatuses();
  });
  // Tests the key and model as typed in Settings when given, so an unsaved key can be checked before saving.
  handle('ai:test', async (p: ProviderId, typedKey?: unknown, typedModel?: unknown) => {
    if (p !== 'openai' && p !== 'anthropic' && p !== 'local') return { ok: false, message: 'Unknown provider.' };
    const typed = typeof typedKey === 'string' ? typedKey.trim() : '';
    const custom = typeof typedModel === 'string' ? typedModel.trim() : '';
    if (typed.length > 1000 || custom.length > 200) return { ok: false, message: 'That key or model ID is too long.' };
    if (p === 'local') {
      const endpoint = await localEndpoint();
      return testLocal({ ...endpoint, apiKey: typed || endpoint.apiKey, model: custom || endpoint.model });
    }
    const key = typed || (await getKey(p))?.key;
    if (!key) return { ok: false, message: 'No API key is set.' };
    const model = custom || (await loadSettings()).settings.ai.models[p];
    return p === 'openai' ? testOpenAI(key, model) : testAnthropic(key, model);
  });
  // Always the saved server, so a key is only ever sent to the address the user saved.
  handle('ai:localModels', async () => listLocalModels(await localEndpoint()));
  handle('ai:conversations', () => orchestrator.loadConversations());
  handle('ai:newConversation', () => orchestrator.newConversation());
  handle('ai:openConversation', (id: string) => orchestrator.openConversation(id));
  // Chat history belongs to the app editing the project; a read-only view never clears it.
  handle('ai:clearHistory', async (key?: string) => {
    // Cleared only in the opening of the project the confirmation was given in.
    if (key !== undefined && key !== controller.openingKey) throw new Error('The project changed, so its history was not cleared.');
    return readOnlyReason() ? (await orchestrator.loadConversations()).active : orchestrator.clearHistory();
  });
  // A question may be asked of a project another app is editing; the orchestrator decides (it writes nothing).
  handle('ai:send', (text: string, ctx, conversationId?: string) => (readOnlyReason() && !((ctx as { mode?: unknown } | null)?.mode === 'ask' && controller.session?.readOnly?.canUnlock) ? { ok: false, message: readOnlyReason() } : orchestrator.send(text, ctx, typeof conversationId === 'string' ? conversationId : undefined)));
  // With a request ID, stop exactly that request and answer once it has ended and its changes are rolled back.
  handle('ai:stop', (runId?: unknown) => (typeof runId === 'string' ? orchestrator.stopRun(runId) : orchestrator.stop()));
  handle('ai:answer', (runId: string, questionId: string, answer: string | { assetId: string }) => orchestrator.answer(runId, questionId, answer));
  handle('ai:undoTurn', (runId: string) => orchestrator.undoTurn(runId));
  handle('ai:fixCode', async (source: string) => {
    // One fix at a time; closing the code editor cancels it (ai:cancelFix). The controller is registered
    // before anything is awaited so a cancel can never miss it.
    fixAbort?.abort();
    const abort = (fixAbort = new AbortController());
    try {
      const ad = await orchestratorAdapter();
      if (abort.signal.aborted) return { ok: false, cancelled: true, message: 'Cancelled' };
      if ('error' in ad) return { ok: false, message: ad.error };
      // The repaired code is written by the assistant, so it must pass the assistant's stricter policy, and so
      // must the project components it imports.
      const check = (src: string) => checkSvelteSource(src, { strict: true, resolve: controller.session ? componentSources(controller.session.state.components) : undefined });
      return await fixComponentSource(ad.adapter, ad.model, String(source), check, abort.signal);
    } finally {
      if (fixAbort === abort) fixAbort = null;
    }
  });
  handle('ai:cancelFix', () => {
    fixAbort?.abort();
    fixAbort = null;
  });
  ipcMain.on('lifecycle:result', (event, requestId: string, answer: LeaveAnswer) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    leaveGate.reply(requestId, answer);
  });
  // The editor shows its screen and listens for File menu commands: one waiting for it is sent now.
  ipcMain.on('menu:ready', (event) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !isEditorUrl(event.senderFrame.url)) return;
    menuCommands.ready(win);
  });
  ipcMain.on('menu:received', (event, id: unknown) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    if (typeof id === 'number') menuCommands.received(id);
  });
  ipcMain.on('inspect:result', (event, requestId: string, report: unknown) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    pendingInspections.get(requestId)?.(report);
    pendingInspections.delete(requestId);
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function rendererRoot() {
  return join(here, '../renderer');
}

/** Set while a window is being created but does not exist yet, so activation, a second launch or a menu command
 *  arriving meanwhile joins it instead of opening another. */
let windowComing = false;

async function createWindow() {
  if ((win && !win.isDestroyed()) || windowComing) return;
  windowComing = true;
  let settings: Awaited<ReturnType<typeof loadSettings>>['settings'];
  try {
    settings = (await loadSettings()).settings;
  } finally {
    // Cleared in the same step the window is created in, so nothing can slip in between.
    windowComing = false;
  }
  nativeTheme.themeSource = settings.appearance;
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'SiteOrigin Builder',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 17 },
    // The app's --bg (styles.css), so the window never flashes a different color before the editor paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11151c' : '#f2f4f7',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      backgroundThrottling: !headless
    }
  });
  // Open maximized: the editor is used with as much room for the site preview as the screen allows.
  win.once('ready-to-show', () => {
    if (headless) return;
    win?.maximize();
    win?.show();
  });
  // Restrict navigation and new windows from the editor.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isEditorUrl(url)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const link = externalLink(url);
    if (!headless && link) void shell.openExternal(link.href);
    return { action: 'deny' };
  });
  // The preview iframe must not navigate away from the project origin or open popups.
  win.webContents.on('did-attach-webview', (e) => e.preventDefault());
  const editorContents = win.webContents;
  const previewUrl = () => (controller.dev?.status.state === 'ready' ? (controller.dev.status as { url: string }).url : null);
  const previewNavigationAllowed = (target: string) => {
    const devUrl = previewUrl();
    // Compare origins, not string prefixes: http://127.0.0.1:5173 must not admit http://127.0.0.1:51730.
    return (!!devUrl && sameOrigin(target, devUrl)) || target.startsWith('about:');
  };
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    // A video section's player, which a press of Play in Preview adds to the previewed page. Its redirects are not.
    if (playerFrameAllowed(e.url, e.frame, editorContents.mainFrame, previewUrl())) return;
    if (!previewNavigationAllowed(e.url)) e.preventDefault();
  });
  // A server-side redirect is a navigation too: the preview cannot bounce a frame to another origin.
  win.webContents.on('will-redirect', (e) => {
    if (e.isMainFrame ? !isEditorUrl(e.url) : !previewNavigationAllowed(e.url)) e.preventDefault();
  });
  // Editor shortcuts come from real keyboard input (including while the preview frame has focus),
  // so content inside the previewed site cannot fake them.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.meta || input.control;
    const k = input.key.toLowerCase();
    // With Shift held, macOS reports the backslash key as "|".
    const relevant =
      (mod && ['z', 'y', 'k', 'd', 'c', 'v', 'j', 's', 'e', 'f', '\\', '|', 'arrowup', 'arrowdown'].includes(k)) ||
      (!mod && ['delete', 'backspace', 'escape'].includes(k)) ||
      // Back and Forward through a visitor's journey in Preview.
      !!visitorStepKey({ key: input.key, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift }, process.platform === 'darwin');
    if (relevant) controller.send('input:key', { key: input.key, meta: input.meta, ctrl: input.control, shift: input.shift, alt: input.alt });
  });
  // Closing the window first saves what is being typed. On macOS the project stays open without a window,
  // as before; elsewhere the last window closing quits, which then closes the project.
  const self = win;
  let closeApproved = false;
  self.on('close', (e) => {
    if (closeApproved || quitState === 'closing' || quitState === 'done' || !controller.session || self.webContents.isCrashed()) return;
    e.preventDefault();
    void controller.mayLeave().then((ok) => {
      if (!ok || self.isDestroyed()) return;
      closeApproved = true;
      self.close();
    });
  });
  self.webContents.on('render-process-gone', () => {
    menuCommands.unready(self);
    leaveGate.editorGone();
    // A project ZIP file being unpacked for this editor is called off: no one is left to answer its trust prompt.
    controller.cancelOpen();
  });
  // A right-click in text that takes typing offers its spelling suggestions and the editing actions, natively:
  // a native menu leaves focus where it is, so a word being edited on the canvas stays in its edit. The canvas
  // leaves only that right-click to the page; elsewhere it shows its element actions instead.
  self.webContents.on('context-menu', (_e, params) => {
    const contents = self.webContents;
    const live = () => !self.isDestroyed() && !contents.isDestroyed();
    const template = writingMenuTemplate(params, {
      // The page replaces the misspelling in its focused frame: only while the frame clicked in is still there
      // and nothing else has focus.
      replaceMisspelling: (s) => {
        if (!live() || !params.frame || params.frame.detached) return;
        const focused = contents.focusedFrame;
        if (focused && focused !== params.frame) return;
        contents.replaceMisspelling(s);
      },
      cut: () => live() && contents.cut(),
      copy: () => live() && contents.copy(),
      paste: () => live() && contents.paste(),
      selectAll: () => live() && contents.selectAll()
    });
    if (!template) return;
    const menu = Menu.buildFromTemplate(template);
    // Nothing pops up during automated runs: the menu goes to the test, which chooses from it.
    if (headless) return void app.emit('test:writing-menu', menu, params);
    // From the keyboard (Shift+F10, the Menu key) it opens at the caret, not wherever the pointer was left.
    const at = params.menuSourceType === 'keyboard' ? { x: params.x, y: params.y, sourceType: 'keyboard' as const } : {};
    menu.popup({ window: self, frame: params.frame ?? undefined, ...at });
  });
  self.on('unresponsive', () => leaveGate.editorUnresponsive());
  self.on('responsive', () => leaveGate.editorResponsive());
  self.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) leaveGate.editorReplaced();
  });
  // A new page has replaced the editor (it committed): only it may say it is ready for menu commands from here on.
  // A navigation the editor refuses never commits, so it leaves the editor ready.
  // A project ZIP file being opened for the replaced editor is called off too: its trust prompt has no one to answer it.
  self.webContents.on('did-navigate', () => {
    menuCommands.unready(self);
    controller.cancelOpen();
  });
  self.on('closed', () => {
    if (win === self) win = null;
    menuCommands.closed(self);
    leaveGate.editorGone();
    controller.cancelOpen();
  });
  if (DEV_URL) await win.loadURL(DEV_URL);
  else await win.loadURL('app://editor/index.html');
}

/** A File menu command (chosen in the menu bar or by its shortcut), for the editor window. */
function chooseCommand(cmd: MenuCommand) {
  const w = win && !win.isDestroyed() ? win : null;
  // A crashed editor cannot act on it: it is loaded again, and the command waits until the new page is ready.
  if (w?.webContents.isCrashed()) w.webContents.reload();
  if (w && !headless) {
    if (w.isMinimized()) w.restore();
    if (w.isVisible()) w.focus();
  }
  menuCommands.run(cmd);
}

/** Export and Close Project act on the open project, so the menu offers them only while one is open. */
function updateProjectMenu() {
  const open = controller.openingKey !== null;
  for (const id of ['export', 'close-project']) {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (item) item.enabled = open;
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (cmd: MenuCommand) => () => chooseCommand(cmd);
  const projectOpen = controller.openingKey !== null;
  // Undo and Redo belong to whatever has focus, which only the editor knows: a text field (a visitor's in
  // Preview, too) keeps its own history and authoring surfaces undo the project. So these are not the
  // stock roles (text history only); the editor routes them. Their keys arrive here only when the page left
  // the key alone. They act on the editor window only while it has focus (never, say, while it is minimized);
  // a headless window never has focus.
  const history = (action: 'undo' | 'redo') => (_item: MenuItem, focused: BaseWindow | undefined, event: KeyboardEvent) => {
    if (!headless && (!win || focused !== win)) return;
    controller.send('menu:history', { action, fromKey: menuKeyCopy(event, process.platform === 'darwin') });
  };
  // Electron's own Edit menu, with Undo and Redo routed through the editor.
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { id: 'edit-undo', label: 'Undo', accelerator: 'CommandOrControl+Z', click: history('undo') },
      { id: 'edit-redo', label: 'Redo', accelerator: process.platform === 'win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z', click: history('redo') },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            { label: 'Substitutions', submenu: [{ role: 'showSubstitutions' }, { type: 'separator' }, { role: 'toggleSmartQuotes' }, { role: 'toggleSmartDashes' }, { role: 'toggleTextReplacement' }] },
            { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
          ] satisfies MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] satisfies MenuItemConstructorOptions[]))
    ]
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-project') },
          { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
          // Open Project's picker takes a file or ZIP file here; a project folder has its own.
          ...(isMac ? [] : [{ label: 'Open Project Folder…', click: send('open-project-folder') }]),
          { type: 'separator' },
          { id: 'export', label: 'Export…', accelerator: 'CmdOrCtrl+E', enabled: projectOpen, click: send('export') },
          { type: 'separator' },
          { id: 'close-project', label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', enabled: projectOpen, click: send('close-project') },
          isMac ? { role: 'close' as const } : { role: 'quit' as const }
        ]
      },
      editMenu,
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  );
}

// One app instance at a time: a second one would race this one's settings, recents and project locks.
// Launching the app again focuses the existing window instead.
if (!app.requestSingleInstanceLock()) app.exit(0);
/** Settles once startup (theme packs, IPC, the menu) is done: no window may open before then. */
let markStarted!: () => void;
const started = new Promise<void>((resolve) => (markStarted = resolve));

app.on('second-instance', () => {
  // On macOS the app can be running with no window; launching it again opens one, once startup is done.
  if (!win) {
    void started.then(() => {
      if (!win) void createWindow();
    });
    return;
  }
  if (headless) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  // Packaged builds carry the icon in the bundle; in development the dock would otherwise show Electron's.
  if (!app.isPackaged && !headless && process.platform === 'darwin') app.dock?.setIcon(join(here, '../../build/icon.png'));
  // Serve the packaged editor from an app-controlled secure origin.
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    // Only the editor's own host is served; app://anything-else is not part of the app.
    if (url.host !== 'editor') return new Response('Not found', { status: 404 });
    const root = rendererRoot();
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // Deny unsolicited permission requests (camera, notifications, etc.).
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  electronSession.defaultSession.on('will-download', (e) => e.preventDefault());
  // Theme packs are loaded before anything can open a project or ask for the catalogue.
  await loadInstalledPacks(packRoots(resourcesDir(), app.getPath('userData')));
  registerIpc();
  buildMenu();
  markStarted();
  // Registered once, not per window: macOS brings up a new window after the last one closes.
  nativeTheme.on('updated', () => controller.send('appearance', nativeTheme.shouldUseDarkColors));
  await createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The media worker would be ended with the app anyway; stopping it first settles any import still waiting on it.
app.on('will-quit', () => {
  stopMediaWorker();
  stopPhotoDecoders();
});

// Quitting saves what is being typed, then closes the project (writing its unsaved workspace state), then
// quits. A quit asked again while that is under way waits for it; one the author turns down ("Keep editing")
// leaves the app running. A close already under way still has a preview to stop and its private copy to remove.
let quitState: 'idle' | 'asking' | 'closing' | 'done' = 'idle';
app.on('before-quit', (e) => {
  if (quitState === 'done' || (quitState === 'idle' && !controller.session && !controller.isClosing && !controller.isCreating)) return;
  e.preventDefault();
  // Quit again while the editor's question is open: re-ask, which brings back Wait or Leave Anyway if it hung.
  if (quitState === 'asking') void controller.mayLeave();
  if (quitState !== 'idle') return;
  quitState = 'asking';
  void controller.mayLeave().then(async (ok) => {
    if (!ok) {
      quitState = 'idle';
      return;
    }
    quitState = 'closing';
    try {
      // A new project still being made is called off and removed first, so quitting leaves no half-made folder, and
      // no project being opened replaces the one closed for it.
      controller.quitting = true;
      await controller.stopCreating();
      await controller.close();
    } finally {
      quitState = 'done';
      app.quit();
    }
  });
});

void readFileSync;
