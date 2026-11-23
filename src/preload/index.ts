import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BuilderApi } from '@shared/api';

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const ALLOWED_EVENTS = new Set(['project:changed', 'project:closed', 'create:progress', 'runtime:status', 'ai:event', 'appearance', 'inspect:request', 'menu:command', 'menu:history', 'input:key', 'lifecycle:request', 'projects:unpacking']);

const api: BuilderApi = {
  platform: process.platform,
  app: { info: invoke('app:info'), getSettings: invoke('app:getSettings'), setSettings: invoke('app:setSettings'), openExternal: invoke('app:openExternal') } as BuilderApi['app'],
  edit: { undo: invoke('edit:undo'), redo: invoke('edit:redo') } as BuilderApi['edit'],
  dialogs: { chooseFolder: invoke('dialogs:chooseFolder'), chooseImages: async () => [], defaultProjectsFolder: invoke('dialogs:defaultProjectsFolder') } as BuilderApi['dialogs'],
  projects: {
    recents: invoke('projects:recents'),
    removeRecent: invoke('projects:removeRecent'),
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
    apply: invoke('project:apply'),
    copy: invoke('project:copy'),
    undo: invoke('project:undo'),
    undoEntry: invoke('project:undoEntry'),
    redo: invoke('project:redo'),
    importAssets: invoke('project:importAssets'),
    photoMetadata: invoke('project:photoMetadata'),
    locateAsset: invoke('project:locateAsset'),
    regenerateAssetCopies: invoke('project:regenerateAssetCopies'),
    storage: invoke('project:storage'),
    reclaimStorage: invoke('project:reclaimStorage'),
    exportSource: invoke('project:exportSource'),
    exportStatic: invoke('project:exportStatic'),
    retryPreview: invoke('project:retryPreview'),
    repairDependencies: invoke('project:repairDependencies'),
    readSource: invoke('project:readSource'),
    generatedSource: invoke('project:generatedSource'),
    restoreGenerated: invoke('project:restoreGenerated'),
    resolveConflict: invoke('project:resolveConflict'),
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
    conversations: invoke('ai:conversations'),
    newConversation: invoke('ai:newConversation'),
    openConversation: invoke('ai:openConversation'),
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
  menuReady: () => ipcRenderer.send('menu:ready'),
  menuReceived: (id) => ipcRenderer.send('menu:received', id),
  leaveResult: (requestId, answer) => ipcRenderer.send('lifecycle:result', requestId, answer),
  pathForFile: (file: File) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('builder', api);
// Development-only hooks; the main process registers these handlers only in unpackaged builds.
contextBridge.exposeInMainWorld('builderTest', { exportStatic: invoke('test:exportStatic'), exportSource: invoke('test:exportSource') });
