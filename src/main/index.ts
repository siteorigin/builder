import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, net, session as electronSession, shell, Menu } from 'electron';
import type { BaseWindow, KeyboardEvent, MenuItem } from 'electron';
import { join, dirname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Appearance, ConflictChoice, ImportChoices, InspectLayoutOptions, LocalWorkspaceState, ProviderId, SettingsPatch } from '@shared/api';
import type { ComponentPreviewMeasure, ComponentPreviewResult, ComponentPreviewStep } from '@shared/component-preview';
import { editorBackground, editorScheme } from '@shared/appearance';
import { externalLink } from '@shared/links';
import { Controller, defaultProjectsFolder, resourcesDir } from './controller';
import { installedCatalogue, loadInstalledPacks, packPreview, packRoots } from './packs/installed';
import { createLeaveGate, type LeaveAnswer } from './leave-gate';
import { forwardsKey, menuKeyCopy } from './history-keys';
import { createMenuCommands, type MenuCommand } from './menu-commands';
import { appMenuTemplate, noticesFile, offersDeveloperItems } from './app-menu';
import { writingMenuTemplate } from './writing-menu';
import { currentShortcuts, loadSettings, localCheckEpoch, localCheckRecorder, localEndpoint, pinRecent, providerStatuses, recents, removeRecent, setKey, updateSettings, getKey } from './settings';
import { Orchestrator } from '@agent/orchestrator';
import { INSPECT_COMPONENT_BUDGET_MS } from '@agent/component-inspection';
import { OpenAIAdapter, testOpenAI } from '@agent/openai';
import { AnthropicAdapter, testAnthropic } from '@agent/anthropic';
import { discoverLocalContext, listedProblem, listLocalModels, openLocalAdapter, testLocal } from '@agent/local';
import { compileProject } from './compile';
import { checkSvelteSource, codeContractNames, componentSources } from './codecheck';
import { renderSiteIconsInWorker, stopMediaWorker } from './project/assets';
import { setSiteIconRenderer } from './project/site-icons';
import { readInsertPlace } from './saved-components';
import { stopPostReads } from './posts-import/process';
import { stopSourceSyncs } from './sources/process';
import { playerFrameAllowed, sameOrigin } from './player-frames';
import { stopPhotoDecoders } from './project/photo-convert';
import { createThumbCapturer } from './thumb-capture';
import { desktopForLaunch, launchMode } from './headless-desktop';
import { installAiJournal } from './ai-journal';
import { fixComponentSource } from '@agent/fixer';
import type { Diagnostic } from '@engine/validate';
import { declareCodeNames } from '@engine/definitions';
import type { ComponentDefinition } from '@shared/types';

const here = dirname(fileURLToPath(import.meta.url));
// Tests and side-by-side development can isolate settings, credentials and caches.
if (process.env.SITEORIGIN_USER_DATA) app.setPath('userData', process.env.SITEORIGIN_USER_DATA);
// A test session's own Documents folder: new projects default to Documents/SiteOrigin and exports start in Documents,
// so a driven run never writes into the person's own.
if (process.env.SITEORIGIN_DOCUMENTS) app.setPath('documents', process.env.SITEORIGIN_DOCUMENTS);
let win: BrowserWindow | null = null;
/** The editor's Appearance, as last saved. It styles the editor only: Electron's theme stays on System. */
let appearance: Appearance = 'system';
const windowBackground = () => editorBackground(editorScheme(appearance, nativeTheme.shouldUseDarkColors));
const controller = new Controller(() => win);
/** Photographs component previews for Insert's thumbnails, in a hidden window of its own, while the editor is open. */
const thumbCapturer = createThumbCapturer();
controller.thumbCapture = (server, path) =>
  win && !win.isDestroyed() ? thumbCapturer.capture(server, path) : Promise.resolve({ ok: false as const, message: 'The editor is closed.', transient: true });
// The hidden window belongs to the project's previews: it closes with the project, not only with the editor.
controller.onSessionClosed = () => thumbCapturer.dispose();

// Never touch the macOS keychain (Chromium would otherwise use it for its own encrypted storage).
app.commandLine.appendSwitch('use-mock-keychain');
// The packaged macOS app declares no Bluetooth use (electron-builder.yml), and macOS ends a process that reaches for
// Bluetooth without declaring it. Web Bluetooth gets to the hardware without a permission request, so it is off.
if (process.platform === 'darwin') app.commandLine.appendSwitch('disable-blink-features', 'WebBluetooth');

// Automated runs never put a window on screen or take focus. Playwright's Electron loader defines
// __playwright_run before this module loads; SITEORIGIN_HEADLESS=1 forces it for other drivers, and
// SITEORIGIN_HEADED=1 shows the window when debugging a test.
const { headless, automated } = launchMode(process.env, globalThis);
// Nor do they show a native dialog, open a link or open Finder: the test answers every chooser and sees every hand-off
// to the desktop (headless-desktop.ts), headed or not. A normal launch keeps Electron's own.
const desktop = desktopForLaunch(process.env, globalThis, { dialog, shell });
// And they keep every assistant event in order, for a test to follow each run by its own IDs (ai-journal.ts).
const aiJournal = automated ? installAiJournal(globalThis) : null;
const AI_TURNS_SPENT = 'This test session allows no more AI requests (its limit or its time is used up), so nothing was sent.';
/** In a test with a deadline, a provider call that would start after it is refused, wherever in a request it comes. */
const deadlineFetch: typeof fetch | undefined = aiJournal ? (input, init) => (aiJournal.turns().spent ? Promise.reject(new Error(AI_TURNS_SPENT)) : fetch(input, init)) : undefined;
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
const pendingComponentPreviews = new Map<string, (results: unknown) => void>();

/**
 * Measure a page in the editor's hidden preview frame at `width` CSS px (see the renderer's runInspection). A report
 * says which project revision the preview served when the page was loaded for it (`previewRevision`). `targets`: measure
 * only these elements; `focus`: only findings on these elements are listed.
 */
function inspectLayout(pageId: string, width: number, opts: InspectLayoutOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      pendingInspections.delete(requestId);
      reject(new Error('The preview did not respond in time.'));
    }, 50000); // The renderer may load the page twice (two 20s attempts plus a pause) before answering.
    // The deadline covers waiting for a private copy of the project to catch up too.
    controller
      .previewRevision()
      .then((previewRevision) => {
        if (done) return;
        pendingInspections.set(requestId, (r) => {
          clearTimeout(timer);
          resolve(r && typeof r === 'object' && !(r as { error?: unknown }).error && previewRevision !== null ? { ...r, previewRevision } : r);
        });
        controller.send('inspect:request', { requestId, pageId, width, ...(opts.targets ? { targets: opts.targets } : {}), ...(opts.focus ? { focus: opts.focus } : {}) });
      })
      .catch((e: unknown) => {
        // A request that could not be made is answered now, not at the deadline.
        clearTimeout(timer);
        pendingInspections.delete(requestId);
        if (!done) reject(e instanceof Error ? e : new Error(String(e)));
        done = true;
      });
  });
}

/**
 * Show components in isolated preview frames in the editor window, step by step (see ComponentPreviewStep), and give
 * back what each frame reported. `measure` adds checks and a time budget; `signal` stops waiting for the answer
 * (with no results) and tells the editor to stop the batch, as running out of time does.
 */
function previewComponents(steps: ComponentPreviewStep[], measure?: ComponentPreviewMeasure, signal?: AbortSignal): Promise<ComponentPreviewResult[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve([]);
    const requestId = Math.random().toString(36).slice(2);
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingComponentPreviews.delete(requestId);
    };
    // The editor is told, so it starts no more of the batch's steps.
    const cancel = () => {
      try {
        controller.send('component-preview:cancel', { requestId });
      } catch {
        // A window that has gone has no batch left to stop.
      }
    };
    const onAbort = () => {
      settle();
      cancel();
      resolve([]);
    };
    const timer = setTimeout(
      () => {
        settle();
        cancel();
        reject(new Error('The preview did not respond in time.'));
      },
      // A step may wait for its files (15s), its page (12s) and its measurement (8s); a budgeted batch starts none
      // after its budget, so it ends at most one step later.
      measure?.budgetMs !== undefined ? measure.budgetMs + 40000 : 40000 * Math.max(1, steps.length)
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingComponentPreviews.set(requestId, (r) => {
      settle();
      resolve(Array.isArray(r) ? (r as ComponentPreviewResult[]) : []);
    });
    controller.send('component-preview:request', { requestId, steps, ...(measure ? { measure } : {}) });
  });
}

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
/** Connection tests in flight, stopped with everything else when a remote server is no longer allowed. */
const testAborts = new Set<AbortController>();

async function orchestratorAdapter(signal?: AbortSignal) {
  return orchestratorDeps.adapter(signal);
}

const orchestratorDeps = {
  adapter: async (signal?: AbortSignal) => {
    const s = (await loadSettings()).settings.ai;
    const provider = s.provider;
    if (!provider) return { error: 'Choose an AI provider in Settings to use the assistant.', repair: 'settings' };
    if (provider === 'local') {
      const epoch = localCheckEpoch();
      // The same reading of Settings as the provider: a model chosen meanwhile is the next request's. With none
      // chosen, the server's first model takes the request, and the turn says so.
      const endpoint = await localEndpoint(s);
      const auto = !endpoint.model;
      // What the request learns about this server and model is what Chat and Settings show until something newer.
      const record = localCheckRecorder(endpoint, epoch);
      let used = endpoint.model;
      const opened = await openLocalAdapter(endpoint, { signal, onCheck: (check) => record(check, used) });
      if ('error' in opened) return opened.setup ? { error: opened.error, repair: 'settings' } : { error: opened.error };
      used = opened.model;
      return { ...opened, provider, ...(auto ? { auto: true } : {}) };
    }
    const key = await getKey(provider);
    if (!key) return { error: `Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings to use the assistant.`, repair: 'key' };
    const model = s.models[provider];
    return { adapter: provider === 'openai' ? new OpenAIAdapter(key.key, model) : new AnthropicAdapter(key.key, model), model, provider };
  }
} as { adapter: (signal?: AbortSignal) => Promise<{ adapter: import('@agent/types').AgentModelAdapter; model: string; provider: ProviderId; auto?: boolean } | { error: string; repair?: 'settings' | 'key' }> };

const orchestrator = new Orchestrator({
  session: () => controller.session,
  adapter: orchestratorDeps.adapter,
  emit: (e) => {
    aiJournal?.record(e);
    controller.send('ai:event', e);
  },
  compileAll: async (): Promise<Diagnostic[]> => (controller.session ? compileProject(controller.session.state) : []),
  inspectLayout,
  fileDiagnostics: () => controller.fileDiagnostics(),
  inspectComponent: (steps, signal) => previewComponents(steps, { readability: true, gaps: true, budgetMs: INSPECT_COMPONENT_BUDGET_MS }, signal),
  onBusyChange: () => controller.broadcast(),
  codeEnabled: async () => (await loadSettings()).settings.developerMode
});
// Only a request that may change the site holds it: a read-only question leaves the author editing, exporting
// and resolving conflicts as usual.
// A test's deadline for the assistant stops it from here, whatever the test or the window is doing then.
aiJournal?.onSpent(() => {
  orchestrator.stop();
  fixAbort?.abort();
  for (const test of testAborts) test.abort();
});
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
    // Withdrawing permission ends work in progress at once, which would otherwise keep sending to that server. The
    // work may have started on a remote server before the address in use changed, so the address is not checked.
    // Nor is the provider: another may have been chosen while that work runs.
    if (before.local.allowRemote === true && patch.ai?.local && 'allowRemote' in patch.ai.local && patch.ai.local.allowRemote !== true) {
      orchestrator.stop();
      fixAbort?.abort();
      for (const test of testAborts) test.abort();
    }
    const s = await updateSettings(patch);
    // Reload and the developer tools come and go with Developer mode.
    if (s.developerMode !== developerModeOn) {
      developerModeOn = s.developerMode;
      buildMenu();
    }
    // The editor redraws itself; Electron keeps following this computer, so the website preview never changes with it.
    if (s.appearance !== appearance) {
      appearance = s.appearance;
      if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
      controller.send('appearance', appearance);
    }
    return s;
  });
  // While Settings records a shortcut, the app's menus leave every key to it (Cmd/Ctrl+W, say, is refused there by
  // name rather than closing the window). The editor's page still sees every key press.
  handle('app:recordShortcut', (on: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(on === true);
  });
  handle('app:openExternal', async (url: string) => {
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
  handle('projects:pinRecent', (dir: unknown, pinned: unknown) => {
    if (typeof dir !== 'string' || typeof pinned !== 'boolean') throw new Error('A pin needs a project folder and whether to pin it.');
    return pinRecent(dir, pinned);
  });
  handle('projects:create', (opts) => controller.create(opts));
  handle('projects:cancelCreate', () => controller.cancelCreate());
  handle('projects:websiteTools', () => controller.websiteTools());
  // The missing recent entry a chosen project may take over (#217): a folder path, or nothing.
  const replacing = (opts: unknown) => {
    const r = (opts as { replaces?: unknown } | null | undefined)?.replaces;
    return typeof r === 'string' && r ? r : undefined;
  };
  handle('projects:open', (dir?: unknown, opts?: unknown) => {
    if (dir != null && typeof dir !== 'string') return { ok: false, message: 'Could not open the project: no folder or file was named.' };
    return controller.open(dir ?? undefined, { folder: (opts as { folder?: unknown } | null | undefined)?.folder === true, replaces: replacing(opts) });
  });
  handle('projects:cancelOpen', () => controller.cancelUnpacking());
  handle('projects:trustAndOpen', (dir: string, opts?: unknown) => controller.trustAndOpen(dir, { replaces: replacing(opts) }));
  handle('projects:close', () => controller.closeProject());
  handle('projects:duplicate', (opts?: unknown) => {
    const o = (opts ?? {}) as { name?: unknown; parentDir?: unknown; opening?: unknown };
    if (typeof o.name !== 'string' || typeof o.parentDir !== 'string' || typeof o.opening !== 'string')
      return { ok: false, field: 'form', message: 'The project could not be copied: no name or folder was given.' };
    return controller.duplicate({ name: o.name, parentDir: o.parentDir, opening: o.opening });
  });
  handle('projects:reveal', (p?: string) => controller.revealInFinder(p));
  // Hosting a live session of the open project (#762). Every argument is checked by the manager; each command names
  // the session it is for, so one meant for a session that has ended reaches no other.
  handle('live:start', (opts: unknown) => controller.live.start(opts));
  handle('live:stop', (run: unknown) => controller.live.stop(run));
  handle('live:admit', (run: unknown, guestId: unknown, role: unknown, guestExpiresAt?: unknown) => controller.live.admit(run, guestId, role, guestExpiresAt ?? null));
  handle('live:decline', (run: unknown, guestId: unknown) => controller.live.decline(run, guestId));
  handle('live:setRole', (run: unknown, guestId: unknown, role: unknown) => controller.live.setRole(run, guestId, role));
  handle('live:setGuestExpiry', (run: unknown, guestId: unknown, guestExpiresAt: unknown) => controller.live.setGuestExpiry(run, guestId, guestExpiresAt));
  handle('live:kick', (run: unknown, guestId: unknown) => controller.live.kick(run, guestId));
  handle('live:setLocked', (run: unknown, locked: unknown) => controller.live.setLocked(run, locked));
  handle('live:extend', (run: unknown, expiresAt: unknown) => controller.live.extend(run, expiresAt));
  handle('live:state', () => controller.live.state);
  handle('project:snapshot', () => controller.snapshot());
  handle('project:reloadFromDisk', () => controller.reloadFromDisk());
  handle('project:apply', (batch, opts) => controller.apply(batch, opts));
  // One node, or several siblings copied together (the session checks they are siblings on that page).
  const nodeIds = (v: unknown): v is string | string[] => typeof v === 'string' || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'));
  handle('project:copy', (pageId: unknown, nodeId: unknown, rev: unknown, key: unknown) =>
    typeof pageId === 'string' && nodeIds(nodeId) && typeof rev === 'number' && typeof key === 'string'
      ? controller.copy(pageId, nodeId, rev, key)
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
  handle('project:reviewAiTurn', (entryId: unknown, key: unknown) =>
    typeof entryId === 'string' && typeof key === 'string' ? controller.reviewAiTurn(entryId, key) : { ok: false, message: 'Nothing to review.' }
  );
  handle('project:revertAiTurn', (entryId: unknown, expected: unknown, key: unknown) => {
    const { revision, history } = (expected ?? {}) as { revision?: unknown; history?: unknown };
    return typeof entryId === 'string' && typeof key === 'string' && Number.isInteger(revision) && typeof history === 'string'
      ? controller.revertAiTurn(entryId, { revision: revision as number, history }, key)
      : { ok: false, revision: controller.session?.revision ?? 0, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: false } };
  });
  handle('project:redo', () => controller.session?.redo());
  // What History showed: the revision it stood at and how many changes the step takes.
  const shown = (v: unknown): v is { revision: number; count: number } => {
    const o = v as Record<string, unknown> | null;
    return !!o && typeof o === 'object' && Number.isInteger(o.revision) && Number.isInteger(o.count);
  };
  handle('project:stepHistory', (entryId: unknown, direction: unknown, expected: unknown, key: unknown) =>
    typeof entryId === 'string' && (direction === 'undo' || direction === 'redo') && shown(expected) && typeof key === 'string'
      ? controller.stepHistory(entryId, direction, expected, key)
      : { ok: false, revision: controller.session?.revision ?? 0, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to step to.', recoverable: false } }
  );
  const kindOf = (only: unknown) => (only === 'image' || only === 'font' || only === 'document' ? only : undefined);
  const pathList = (paths: unknown) => (Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : undefined);
  handle('project:reviewImport', (paths?: unknown, only?: unknown) => controller.reviewImport(pathList(paths), kindOf(only)));
  handle('project:importAssets', (paths?: unknown, only?: unknown, choices?: unknown) => controller.importAssets(pathList(paths), kindOf(only), importChoices(choices)));
  // The file is always one the author chose in the app's own chooser.
  handle('project:exportComponent', (id: unknown) => (typeof id === 'string' ? controller.exportComponent(id) : { ok: false, message: 'That component is no longer in this project.' }));
  handle('project:importComponent', () => controller.importComponent());
  // The personal component library (#372): files the main process names, in its own folder.
  handle('project:savedComponents', (opening: unknown) => (typeof opening === 'string' ? controller.savedComponents(opening) : []));
  handle('project:saveComponentToLibrary', (id: unknown, opening: unknown) =>
    typeof id === 'string' && typeof opening === 'string' ? controller.saveComponentToLibrary(id, opening) : { ok: false, message: 'That component is no longer in this project.' }
  );
  handle('project:removeSavedComponent', (id: unknown, digest: unknown) => controller.removeSavedComponent(String(id ?? ''), String(digest ?? '')));
  handle('project:insertSavedComponent', (id: unknown, digest: unknown, place: unknown, opening: unknown, revision: unknown) => {
    const at = readInsertPlace(place);
    if (typeof id !== 'string' || typeof digest !== 'string' || !at || typeof opening !== 'string' || !Number.isInteger(revision)) return { ok: false, message: 'That place can’t take a component.' };
    return controller.insertSavedComponent(id, digest, at, opening, revision as number);
  });
  handle('project:reviewPostImport', (kind: unknown, opening: unknown) => controller.reviewPostImport(kind === 'markdown' ? 'markdown' : 'wordpress', String(opening ?? '')));
  handle('project:commitPostImport', (id: unknown, opening: unknown) => controller.commitPostImport(String(id ?? ''), String(opening ?? '')));
  handle('project:cancelPostImport', (id: unknown) => controller.cancelPostImport(String(id ?? '')));
  handle('project:fontFile', (assetId: unknown, opening: unknown) => (typeof assetId === 'string' && typeof opening === 'string' ? controller.fontFile(assetId, opening) : null));
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
  handle('project:prepareComponentPreview', (spec: unknown) => controller.prepareComponentPreview(spec));
  handle('project:releaseComponentPreview', (key: unknown) => controller.releaseComponentPreview(key));
  handle('project:componentThumb', (definitionId: unknown, opening: unknown, have?: unknown) => controller.componentThumb(definitionId, opening, have));
  handle('project:repairDependencies', () => controller.repairDependencies());
  handle('project:readSource', (id: string) => controller.readSource(id));
  handle('project:generatedSource', (kind: 'component' | 'page', id: string) => controller.generatedSource(kind, id));
  handle('project:restoreGenerated', (p: string) => controller.session?.restoreGeneratedFile(p));
  handle('project:resolveConflict', (p: string, choice: ConflictChoice, opts?: { expect?: unknown; opening?: unknown }) => controller.resolveConflict(p, choice, opts && typeof opts === 'object' ? opts : undefined));
  handle('project:compareConflict', (p: unknown) => (typeof p === 'string' ? controller.compareConflict(p) : { ok: false, message: 'That file is no longer in conflict.' }));
  handle('project:readSavedCopy', (id: unknown) => (typeof id === 'string' ? controller.readSavedCopy(id) : { ok: false, message: 'That saved copy is no longer listed.' }));
  handle('project:dismissSavedCopy', (id: unknown) => (typeof id === 'string' ? controller.dismissSavedCopy(id) : { ok: false, message: 'That saved copy is no longer listed.' }));
  handle('project:unlock', () => controller.unlock());
  handle('project:saveLocalState', (s: LocalWorkspaceState, key: string) => controller.saveLocalState(s, String(key ?? '')));
  handle('project:validateSource', async (source: string) => {
    // The slots and parts the code declares by itself, as saving it declares them, so a slot it shows is checked.
    const contract: Pick<ComponentDefinition, 'kind' | 'parts' | 'slots'> = { kind: 'code', parts: { root: { nodeId: 'root', label: 'Root' } } };
    const names = await codeContractNames(String(source));
    if (names) declareCodeNames(contract, names);
    const problems = await checkSvelteSource(String(source), { contract });
    const errors = problems.filter((p) => p.severity === 'error');
    return { ok: errors.length === 0, errors: errors.map((e) => (e.line ? `Line ${e.line}: ` : '') + e.message), diagnostics: problems };
  });
  // Save's last step: resolves once the project's queued writes are on disk, saying whether they all got there.
  handle('project:flush', (opening?: unknown) => controller.flush(typeof opening === 'string' ? opening : undefined));
  // Development-only hooks used by the end-to-end tests in place of native save dialogs.
  if (!app.isPackaged) {
    handle('test:exportStatic', (dest: string, format?: unknown) => controller.buildStaticTo(dest, format === 'zip' ? 'zip' : 'folder'));
    handle('test:exportSource', (dest: string, format?: unknown) => controller.exportSourceTo(dest, format === 'zip' ? 'zip' : 'folder'));
    handle('test:previewComponent', (steps: unknown) => previewComponents(Array.isArray(steps) ? (steps as ComponentPreviewStep[]) : []));
    handle('test:thumbCaptures', () => controller.thumbs.captures);
    handle('test:exportComponent', (id: unknown, dest: unknown) => controller.exportComponent(String(id), String(dest)));
    handle('test:importComponent', (path: unknown) => controller.importComponent(String(path)));
    handle('test:inspectLayout', (pageId: unknown, width: unknown) => inspectLayout(String(pageId), Number.isFinite(width) ? Math.min(4000, Math.max(200, Math.round(width as number))) : 390));
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
    // A connection test asks the provider too: a test's cap counts it like any other request.
    if (aiJournal && !aiJournal.admit()) return { ok: false, message: AI_TURNS_SPENT };
    if (p === 'local') {
      // Registered before the saved setup is read, so remote access withdrawn meanwhile stops it too.
      const abort = new AbortController();
      testAborts.add(abort);
      try {
        const epoch = localCheckEpoch();
        const endpoint = await localEndpoint();
        const record = localCheckRecorder(endpoint, epoch);
        const r = await testLocal({ ...endpoint, apiKey: typed || endpoint.apiKey, model: custom || endpoint.model }, { signal: abort.signal });
        // A typed key is not saved yet, so what it showed is not the saved setup's; a stopped test showed nothing.
        if (!typed && !custom && !abort.signal.aborted) record(r.ok ? { ok: true } : { ok: false, stage: r.stage ?? 'server', message: r.message }, r.model);
        return r;
      } finally {
        testAborts.delete(abort);
      }
    }
    const key = typed || (await getKey(p))?.key;
    if (!key) return { ok: false, message: 'No API key is set.' };
    const model = custom || (await loadSettings()).settings.ai.models[p];
    const opts = deadlineFetch ? { fetch: deadlineFetch } : {};
    return p === 'openai' ? testOpenAI(key, model, opts) : testAnthropic(key, model, opts);
  });
  // Always the saved server, so a key is only ever sent to the address the user saved.
  handle('ai:localModels', async () => {
    const epoch = localCheckEpoch();
    const endpoint = await localEndpoint();
    const record = localCheckRecorder(endpoint, epoch);
    const found = await listLocalModels(endpoint);
    const problem = listedProblem(found, endpoint.model);
    record(problem ? { ok: false, stage: 'server', message: problem } : { listed: found.models });
    // Which server answered, so Settings shows the list for that server only.
    return { ...found, server: endpoint.baseURL };
  });
  // The saved server only, as above. A read for the composer: it records nothing about the server.
  handle('ai:localContext', async (model: unknown) => {
    // Registered before the saved setup is read, as a test is, so remote access withdrawn meanwhile stops it too.
    const abort = new AbortController();
    testAborts.add(abort);
    try {
      const endpoint = await localEndpoint();
      const found = typeof model === 'string' ? await discoverLocalContext({ ...endpoint, model }, { signal: abort.signal }) : {};
      return { server: endpoint.baseURL, reportedWindow: found.windowTokens ?? null };
    } finally {
      testAborts.delete(abort);
    }
  });
  handle('ai:conversations', () => orchestrator.loadConversations());
  handle('ai:newConversation', () => orchestrator.newConversation());
  handle('ai:openConversation', (id: string) => orchestrator.openConversation(id));
  // Renamed or deleted only in the opening of the project the author did it in; a read-only view changes neither.
  handle('ai:renameConversation', (id: string, title: unknown, key?: string) => {
    if (typeof key !== 'string' || key !== controller.openingKey) throw new Error('The project changed, so the conversation was not renamed.');
    const blocked = readOnlyReason();
    if (blocked) throw new Error(blocked);
    return orchestrator.renameConversation(id, title);
  });
  handle('ai:deleteConversation', async (id: string, key?: string) => {
    if (typeof key !== 'string' || key !== controller.openingKey) throw new Error('The project changed, so the conversation was not deleted.');
    const blocked = readOnlyReason();
    if (blocked) throw new Error(blocked);
    // Its unsent message goes first, while this opening is current: it never outlives the conversation, even if the
    // project closes during the delete. A delete that fails puts it back.
    const restore = controller.forgetConversation(id, key);
    try {
      return await orchestrator.deleteConversation(id);
    } catch (e) {
      restore();
      throw e;
    }
  });
  // Chat history belongs to the app editing the project; a read-only view never clears it.
  handle('ai:clearHistory', async (key?: string) => {
    // Cleared only in the opening of the project the confirmation was given in.
    if (key !== undefined && key !== controller.openingKey) throw new Error('The project changed, so its history was not cleared.');
    return readOnlyReason() ? (await orchestrator.loadConversations()).active : orchestrator.clearHistory();
  });
  // A question may be asked of a project another app is editing; the orchestrator decides (it writes nothing).
  handle('ai:send', async (text: string, ctx, conversationId?: string, recipient?: unknown) => {
    if (readOnlyReason() && !((ctx as { mode?: unknown } | null)?.mode === 'ask' && controller.session?.readOnly?.canUnlock)) return { ok: false, message: readOnlyReason() };
    // A test may cap the requests the assistant starts (ai-journal.ts): one past the cap never reaches a model.
    if (aiJournal && !aiJournal.admit()) return { ok: false, message: AI_TURNS_SPENT };
    const sent = await orchestrator.send(text, ctx, typeof conversationId === 'string' ? conversationId : undefined, recipient);
    if (!sent.ok) aiJournal?.giveBack();
    // Admitted just before the deadline, but started after it stopped everything: stopped now.
    else if (aiJournal?.turns().spent && sent.runId) void orchestrator.stopRun(sent.runId);
    return sent;
  });
  // With a request ID, stop exactly that request and answer once it has ended and its changes are rolled back.
  handle('ai:stop', (runId?: unknown) => (typeof runId === 'string' ? orchestrator.stopRun(runId) : orchestrator.stop()));
  handle('ai:answer', (runId: string, questionId: string, answer: string | { assetId: string }) => orchestrator.answer(runId, questionId, answer));
  handle('ai:undoTurn', (runId: string) => orchestrator.undoTurn(runId));
  handle('ai:fixCode', async (source: string) => {
    if (aiJournal && !aiJournal.admit()) return { ok: false, message: AI_TURNS_SPENT };
    // One fix at a time; closing the code editor cancels it (ai:cancelFix). The controller is registered
    // before anything is awaited so a cancel can never miss it.
    fixAbort?.abort();
    const abort = (fixAbort = new AbortController());
    try {
      const ad = await orchestratorAdapter(abort.signal);
      if (abort.signal.aborted) return { ok: false, cancelled: true, message: 'Canceled' };
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
  // The preload asks once per editor page, before its first paint: a page reloaded since the window opened gets the
  // Appearance saved since. Answered synchronously from memory, and always, since the page waits for it.
  ipcMain.on('app:appearance', (event) => {
    event.returnValue = event.sender === win?.webContents ? appearance : 'system';
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
  ipcMain.on('component-preview:result', (event, requestId: string, results: unknown) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    pendingComponentPreviews.get(requestId)?.(results);
    pendingComponentPreviews.delete(requestId);
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
  appearance = settings.appearance;
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
    backgroundColor: windowBackground(),
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
    // An automated run records the link instead of opening it (headless-desktop.ts).
    if (link) void shell.openExternal(link.href);
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
    const chord = { key: input.key, code: input.code, meta: input.meta, ctrl: input.control, shift: input.shift, alt: input.alt };
    if (forwardsKey(chord, currentShortcuts().askAi, process.platform === 'darwin')) controller.send('input:key', chord);
  });
  // Closing the window first saves what is being typed. On macOS the project stays open without a window,
  // as before; elsewhere the last window closing quits, which then closes the project.
  const self = win;
  const selfId = self.id;
  desktop?.windows.opened(selfId);
  // An automated run's chooser answers belong to the editor they were set for, and expire with it: when it closes, or
  // a page that has loaded is replaced or crashes. The page a crash brings back is a first load again.
  let committed = false;
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
  // A page that is replaced or crashes mid-recording leaves no one to hand the menus' keys back.
  self.webContents.on('did-navigate', () => self.webContents.setIgnoreMenuShortcuts(false));
  self.webContents.on('render-process-gone', () => {
    if (!self.webContents.isDestroyed()) self.webContents.setIgnoreMenuShortcuts(false);
    desktop?.windows.gone(selfId, { closed: false });
    committed = false;
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
    if (committed) desktop?.windows.gone(selfId, { closed: false });
    committed = true;
  });
  self.on('closed', () => {
    if (win === self) win = null;
    desktop?.windows.gone(selfId, { closed: true });
    // The thumbnails' hidden window goes with the editor: it must never keep the app running, or stand in for the
    // editor when macOS asks whether a window is left to show.
    thumbCapturer.dispose();
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

/** Developer mode as last read, for the menu, which is built synchronously. */
let developerModeOn = false;

/** Help > About on Windows and Linux, which have no About panel: the app's name and version, to quote in a report. */
function showAbout() {
  const options = { type: 'info' as const, title: `About ${app.name}`, message: app.name, detail: `Version ${app.getVersion()}`, buttons: ['OK'] };
  void (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
}

/** Help menu links open in the browser, checked like every other link the app hands to the desktop. */
function openMenuLink(url: string) {
  const link = externalLink(url);
  // An automated run records the link instead of opening it (headless-desktop.ts).
  if (link) void shell.openExternal(link.href);
}

function buildMenu() {
  // Undo and Redo belong to whatever has focus, which only the editor knows: a text field (a visitor's in
  // Preview, too) keeps its own history and authoring surfaces undo the project. So these are not the
  // stock roles (text history only); the editor routes them. Their keys arrive here only when the page left
  // the key alone. They act on the editor window only while it has focus (never, say, while it is minimized);
  // a headless window never has focus.
  const history = (action: 'undo' | 'redo') => (_item: MenuItem, focused: BaseWindow | undefined, event: KeyboardEvent) => {
    if (!headless && (!win || focused !== win)) return;
    controller.send('menu:history', { action, fromKey: menuKeyCopy(event, process.platform === 'darwin') });
  };
  const options = { projectOpen: controller.openingKey !== null, developer: offersDeveloperItems({ packaged: app.isPackaged, automated, developerMode: developerModeOn }) };
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, options, { command: chooseCommand, history, openLink: openMenuLink, about: showAbout, openNotices })));
}

/** Help > Third-Party Notices: the notices file, in the desktop's own viewer (recorded instead in an automated run). */
function openNotices() {
  const file = noticesFile(app.isPackaged, process.resourcesPath, app.getAppPath());
  void shell.openPath(file).then((problem) => {
    if (!problem) return;
    const detail = app.isPackaged ? `${file}\n\n${problem}` : `${file}\n\n${problem}\n\nnpm run build writes the notices for a development build.`;
    void dialog.showMessageBox({ type: 'warning', message: 'The third-party notices could not be opened.', detail });
  });
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
  // The website's icons are drawn in the media worker, from before any project opens.
  setSiteIconRenderer(renderSiteIconsInWorker);
  // Theme packs are loaded before anything can open a project or ask for the catalogue.
  await loadInstalledPacks(packRoots(resourcesDir(), app.getPath('userData')));
  registerIpc();
  developerModeOn = (await loadSettings()).settings.developerMode;
  // The About panel names this app and its version, not the Electron bundle a development build runs in.
  app.setAboutPanelOptions({ applicationName: app.name, applicationVersion: app.getVersion() });
  buildMenu();
  markStarted();
  // Registered once, not per window: macOS brings up a new window after the last one closes.
  // With Appearance on System, the window's backing color follows this computer's setting (the editor follows it itself).
  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  });
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
  stopPostReads();
  stopSourceSyncs();
});

// Quitting saves what is being typed, then closes the project (writing its unsaved workspace state), then
// quits. A quit asked again while that is under way waits for it; one the author turns down ("Keep editing")
// leaves the app running. A close already under way still has a preview to stop and its private copy to remove.
let quitState: 'idle' | 'asking' | 'closing' | 'done' = 'idle';
app.on('before-quit', (e) => {
  if (quitState === 'done' || (quitState === 'idle' && !controller.session && !controller.isClosing && !controller.isCreating && !controller.isDuplicating)) return;
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
      // A copy of the project under way finishes, or removes what it made, before the project closes.
      await controller.settleDuplicates();
      await controller.close();
    } finally {
      quitState = 'done';
      app.quit();
    }
  });
});
