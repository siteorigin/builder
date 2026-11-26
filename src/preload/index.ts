import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BuilderApi } from '@shared/api';
import { editorScheme } from '@shared/appearance';

// The editor's first paint is in its Appearance: its root element is marked as soon as it exists, before any style
// is computed, with the Appearance saved now (asked for on every page load, so a reload is not left with an older
// one). The renderer keeps it up to date from then on (lib/appearance.ts). The preload is compiled with the main
// process code, without the DOM's types: the little it uses of the page is typed here.
interface Page {
  document: { documentElement: { dataset: Record<string, string | undefined> } | null };
  matchMedia(query: string): { matches: boolean };
  MutationObserver: new (cb: () => void) => { observe(target: unknown, opts: { childList: boolean }): void; disconnect(): void };
}
const page = globalThis as unknown as Page;
const appearance: unknown = ipcRenderer.sendSync('app:appearance');
const markAppearance = () => {
  const root = page.document.documentElement;
  if (!root) return false;
  if (!root.dataset.appearance) root.dataset.appearance = editorScheme(appearance, page.matchMedia('(prefers-color-scheme: dark)').matches);
  return true;
};
if (!markAppearance()) {
  const watch = new page.MutationObserver(() => markAppearance() && watch.disconnect());
  watch.observe(page.document, { childList: true });
}

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const ALLOWED_EVENTS = new Set(['project:changed', 'project:closed', 'create:progress', 'runtime:status', 'ai:event', 'appearance', 'inspect:request', 'component-preview:request', 'component-preview:cancel', 'menu:command', 'menu:history', 'input:key', 'lifecycle:request', 'projects:unpacking']);

const api: BuilderApi = {
  platform: process.platform,
  app: { info: invoke('app:info'), catalogue: invoke('app:catalogue'), packPreview: invoke('packs:preview'), getSettings: invoke('app:getSettings'), setSettings: invoke('app:setSettings'), openExternal: invoke('app:openExternal'), recordShortcut: invoke('app:recordShortcut') } as BuilderApi['app'],
  edit: { undo: invoke('edit:undo'), redo: invoke('edit:redo') } as BuilderApi['edit'],
  dialogs: { chooseFolder: invoke('dialogs:chooseFolder'), chooseImages: async () => [], defaultProjectsFolder: invoke('dialogs:defaultProjectsFolder') } as BuilderApi['dialogs'],
  projects: {
    recents: invoke('projects:recents'),
    removeRecent: invoke('projects:removeRecent'),
    pinRecent: invoke('projects:pinRecent'),
    create: invoke('projects:create'),
    cancelCreate: invoke('projects:cancelCreate'),
    websiteTools: invoke('projects:websiteTools'),
    open: invoke('projects:open'),
    cancelOpen: invoke('projects:cancelOpen'),
    trustAndOpen: invoke('projects:trustAndOpen'),
    close: invoke('projects:close'),
    duplicate: invoke('projects:duplicate'),
    reveal: invoke('projects:reveal')
  } as BuilderApi['projects'],
  project: {
    snapshot: invoke('project:snapshot'),
    reloadFromDisk: invoke('project:reloadFromDisk'),
    apply: invoke('project:apply'),
    copy: invoke('project:copy'),
    undo: invoke('project:undo'),
    undoEntry: invoke('project:undoEntry'),
    reviewAiTurn: invoke('project:reviewAiTurn'),
    revertAiTurn: invoke('project:revertAiTurn'),
    redo: invoke('project:redo'),
    stepHistory: invoke('project:stepHistory'),
    reviewImport: invoke('project:reviewImport'),
    importAssets: invoke('project:importAssets'),
    exportComponent: invoke('project:exportComponent'),
    importComponent: invoke('project:importComponent'),
    savedComponents: invoke('project:savedComponents'),
    saveComponentToLibrary: invoke('project:saveComponentToLibrary'),
    removeSavedComponent: invoke('project:removeSavedComponent'),
    insertSavedComponent: invoke('project:insertSavedComponent'),
    reviewPostImport: invoke('project:reviewPostImport'),
    commitPostImport: invoke('project:commitPostImport'),
    cancelPostImport: invoke('project:cancelPostImport'),
    fontFile: invoke('project:fontFile'),
    webCopyPlan: invoke('project:webCopyPlan'),
    makeWebCopy: invoke('project:makeWebCopy'),
    photoMetadata: invoke('project:photoMetadata'),
    locateAsset: invoke('project:locateAsset'),
    regenerateAssetCopies: invoke('project:regenerateAssetCopies'),
    storage: invoke('project:storage'),
    reclaimStorage: invoke('project:reclaimStorage'),
    saveVersion: invoke('project:saveVersion'),
    reviewVersion: invoke('project:reviewVersion'),
    restoreVersion: invoke('project:restoreVersion'),
    deleteVersion: invoke('project:deleteVersion'),
    exportSource: invoke('project:exportSource'),
    exportStatic: invoke('project:exportStatic'),
    retryPreview: invoke('project:retryPreview'),
    prepareComponentPreview: invoke('project:prepareComponentPreview'),
    releaseComponentPreview: invoke('project:releaseComponentPreview'),
    componentThumb: invoke('project:componentThumb'),
    repairDependencies: invoke('project:repairDependencies'),
    readSource: invoke('project:readSource'),
    generatedSource: invoke('project:generatedSource'),
    restoreGenerated: invoke('project:restoreGenerated'),
    resolveConflict: invoke('project:resolveConflict'),
    compareConflict: invoke('project:compareConflict'),
    readSavedCopy: invoke('project:readSavedCopy'),
    dismissSavedCopy: invoke('project:dismissSavedCopy'),
    unlock: invoke('project:unlock'),
    saveLocalState: invoke('project:saveLocalState'),
    validateSource: invoke('project:validateSource'),
    flush: invoke('project:flush')
  } as BuilderApi['project'],
  ai: {
    providers: invoke('ai:providers'),
    setKey: invoke('ai:setKey'),
    testProvider: invoke('ai:test'),
    localModels: invoke('ai:localModels'),
    localContext: invoke('ai:localContext'),
    conversations: invoke('ai:conversations'),
    newConversation: invoke('ai:newConversation'),
    openConversation: invoke('ai:openConversation'),
    renameConversation: invoke('ai:renameConversation'),
    deleteConversation: invoke('ai:deleteConversation'),
    clearHistory: invoke('ai:clearHistory'),
    send: invoke('ai:send'),
    stop: invoke('ai:stop'),
    answer: invoke('ai:answer'),
    undoTurn: invoke('ai:undoTurn'),
    fixCode: invoke('ai:fixCode'),
    cancelFix: invoke('ai:cancelFix')
  } as BuilderApi['ai'],
  on: ((channel: string, cb: (payload: unknown) => void) => {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }) as BuilderApi['on'],
  inspectResult: (requestId, report) => ipcRenderer.send('inspect:result', requestId, report),
  componentPreviewResult: (requestId, results) => ipcRenderer.send('component-preview:result', requestId, results),
  menuReady: () => ipcRenderer.send('menu:ready'),
  menuReceived: (id) => ipcRenderer.send('menu:received', id),
  leaveResult: (requestId, answer) => ipcRenderer.send('lifecycle:result', requestId, answer),
  pathForFile: (file: File) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('builder', api);
// Development-only hooks; the main process registers these handlers only in unpackaged builds.
contextBridge.exposeInMainWorld('builderTest', {
  exportStatic: invoke('test:exportStatic'),
  exportSource: invoke('test:exportSource'),
  previewComponent: invoke('test:previewComponent'),
  thumbCaptures: invoke('test:thumbCaptures'),
  inspectLayout: invoke('test:inspectLayout'),
  exportComponent: invoke('test:exportComponent'),
  importComponent: invoke('test:importComponent')
});
