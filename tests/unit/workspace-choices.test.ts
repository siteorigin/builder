import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult } from '@shared/ops';
import type { LocalWorkspaceState, ProjectSnapshot, RunStatus } from '@shared/api';

// The editor's viewing choices and its Save, through the editor's own store behind a stand-in for the preload
// bridge (#202): every way of choosing a width or zoom is remembered for the project, and Save only says the
// changes are saved once the project's queued writes have reached the disk.
const saved: Array<{ state: LocalWorkspaceState; key: string }> = [];
let flushes: Array<{ opening: string | undefined; resolve: (saved: boolean) => void }> = [];
let undos: Array<(r: ApplyResult) => void> = [];
const holdFlush = (opening: string | undefined) => new Promise<boolean>((resolve) => flushes.push({ opening, resolve }));
const bridge = {
  project: {
    saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }),
    flush: holdFlush as (opening: string | undefined) => Promise<boolean>,
    undo: () => new Promise<ApplyResult>((resolve) => undos.push(resolve))
  },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });
vi.stubGlobal('document', { activeElement: null });
vi.stubGlobal('HTMLElement', class {});

// The store and the save are DOM code, outside this test project's types: loaded by a path the type checker does
// not follow, with just the shapes this test uses.
interface EditorState {
  snapshot: ProjectSnapshot | null;
  viewport: number;
  zoom: number | 'fit';
  runStatus: RunStatus | null;
  runMode: 'edit' | 'ask' | null;
  toasts: Array<{ text: string; kind: string }>;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  setViewport: (w: number) => void;
  setZoom: (z: number | 'fit') => void;
  projectHistory: (action: 'undo' | 'redo') => void;
};
const { saveNow } = (await load('../../src/renderer/src/lib/leave')) as { saveNow: () => Promise<void> };
const pending = (await load('../../src/renderer/src/lib/pending')) as { trackApply: (p: Promise<{ ok: boolean }>) => void; isSettling: () => boolean; resetPendingForTests: () => void };

const open = (workspaceKey: string) => store.setState({ snapshot: { workspaceKey } as unknown as ProjectSnapshot, toasts: [], runStatus: null, runMode: null });
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
const SAVED = 'All changes are saved on this computer.';
const notices = () => store.getState().toasts.map((t) => t.text);

afterEach(() => {
  saved.length = 0;
  flushes = [];
  undos = [];
  bridge.project.flush = holdFlush;
  pending.resetPendingForTests();
});

describe('viewing choices', () => {
  it('remembers a width and a zoom for the project they were chosen in', () => {
    open('opening#a');
    store.setViewport(2400);
    expect(store.getState().viewport).toBe(2400);
    store.setZoom(0.75);
    expect(store.getState().zoom).toBe(0.75);
    open('opening#b');
    store.setZoom('fit');
    expect(store.getState().zoom).toBe('fit');
    expect(saved).toEqual([
      { state: { viewport: 2400 }, key: 'opening#a' },
      { state: { zoom: 0.75 }, key: 'opening#a' },
      { state: { zoom: 'fit' }, key: 'opening#b' }
    ]);
  });
});

describe('Save', () => {
  it('says the changes are saved only once the project’s queued writes have reached the disk', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    expect(flushes.map((f) => f.opening)).toEqual(['opening#a']);
    expect(notices()).toEqual([]);
    // The editor shows the project again (a change landing), in the same opening.
    store.setState({ snapshot: { workspaceKey: 'opening#a' } as unknown as ProjectSnapshot });
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([SAVED]);
    expect(pending.isSettling()).toBe(false);
  });

  it('waits for an Undo started before it, and says nothing when the Undo failed', async () => {
    open('opening#a');
    store.projectHistory('undo');
    const done = saveNow();
    await tick();
    expect(flushes).toEqual([]);
    undos[0]({ ok: false, revision: 3, error: { code: 'CONFLICT', message: 'The disk is full.', recoverable: false } });
    await tick();
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual(['The disk is full.']);
  });

  it('says nothing when a change started while it waited is still on its way', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    pending.trackApply(new Promise(() => undefined));
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([]);
  });

  it('says nothing about a project that was replaced while it waited', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    open('opening#b');
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([]);
  });

  it('says nothing while the AI is still making changes, which Stop would take back', async () => {
    open('opening#a');
    store.setState({ runStatus: 'awaiting-input', runMode: 'edit' });
    const done = saveNow();
    await tick();
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([]);
  });

  it('says nothing when the queued writes did not all reach the disk, or could not be asked about', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    flushes[0].resolve(false);
    await done;
    expect(notices()).toEqual([]);
    expect(pending.isSettling()).toBe(false);

    bridge.project.flush = () => Promise.reject(new Error('The project was closed.'));
    await saveNow();
    expect(notices()).toEqual([]);
    expect(pending.isSettling()).toBe(false);
  });
});
