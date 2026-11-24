import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalWorkspaceState, ProjectSnapshot } from '@shared/api';

// The editor's viewing choices and its Save, through the editor's own store behind a stand-in for the preload
// bridge (#202): every way of choosing a width or zoom is remembered for the project, and Save only says the
// changes are saved once the project's queued writes have finished.
const saved: Array<{ state: LocalWorkspaceState; key: string }> = [];
let flushes: Array<() => void> = [];
const bridge = {
  project: {
    saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }),
    flush: () => new Promise<void>((resolve) => flushes.push(resolve))
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
  toasts: Array<{ text: string; kind: string }>;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  setViewport: (w: number) => void;
  setZoom: (z: number | 'fit') => void;
};
const { saveNow } = (await load('../../src/renderer/src/lib/leave')) as { saveNow: () => Promise<void> };

const open = (workspaceKey: string) => store.setState({ snapshot: { workspaceKey } as unknown as ProjectSnapshot, toasts: [] });
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
const SAVED = 'All changes are saved on this computer.';

afterEach(() => {
  saved.length = 0;
  flushes = [];
});

describe('viewing choices', () => {
  it('remembers a width and a zoom for the project they were chosen in', () => {
    open('opening#a');
    store.setViewport(2400);
    store.setZoom(0.75);
    store.setZoom('fit');
    expect(store.getState()).toMatchObject({ viewport: 2400, zoom: 'fit' });
    expect(saved).toEqual([
      { state: { viewport: 2400 }, key: 'opening#a' },
      { state: { zoom: 0.75 }, key: 'opening#a' },
      { state: { zoom: 'fit' }, key: 'opening#a' }
    ]);
  });
});

describe('Save', () => {
  it('says the changes are saved only once the project’s queued writes have finished', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    expect(flushes).toHaveLength(1);
    expect(store.getState().toasts).toEqual([]);
    flushes[0]();
    await done;
    expect(store.getState().toasts.map((t) => t.text)).toEqual([SAVED]);
  });

  it('says nothing about a project that was replaced while it waited', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    open('opening#b');
    flushes[0]();
    await done;
    expect(store.getState().toasts).toEqual([]);
  });

  it('says nothing when the queued writes could not be confirmed', async () => {
    open('opening#a');
    bridge.project.flush = () => Promise.reject(new Error('The project was closed.'));
    try {
      await saveNow();
    } finally {
      bridge.project.flush = () => new Promise<void>((resolve) => flushes.push(resolve));
    }
    expect(store.getState().toasts).toEqual([]);
  });
});
