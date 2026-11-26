/**
 * The editor's code loads once, on first use (src/renderer/src/lib/editor-module.ts): every later ask gets the same
 * module, and a load that failed (its file could not be fetched) is tried again by the next ask instead of failing
 * every opening after it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENTRY = '../../src/renderer/src/editor-entry';
// Loaded by its path, typed here: the loader's own types name the whole editor, which this project does not compile.
const LOADER = '../../src/renderer/src/lib/editor-module';
type Loader = { editorModule(): unknown; loadEditor(): Promise<unknown> };
const loader = () => import(/* @vite-ignore */ LOADER) as Promise<Loader>;

describe('loading the editor’s code', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loads it once, and has it at hand from then on', async () => {
    let loads = 0;
    vi.doMock(ENTRY, () => ({ Editor: () => null, load: ++loads }));
    const { editorModule, loadEditor } = await loader();
    expect(editorModule()).toBeNull();
    const first = loadEditor();
    expect(loadEditor()).toBe(first);
    const m = await first;
    expect(editorModule()).toBe(m);
    expect(await loadEditor()).toBe(m);
    expect(loads).toBe(1);
  });

  it('tries again after a load that failed', async () => {
    let loads = 0;
    vi.doMock(ENTRY, () => {
      if (++loads === 1) throw new Error('The editor could not be fetched');
      return { Editor: () => null, load: loads };
    });
    const { editorModule, loadEditor } = await loader();
    await expect(loadEditor()).rejects.toThrow();
    expect(editorModule()).toBeNull();
    const m = await loadEditor();
    expect(m).toMatchObject({ load: 2 });
    expect(editorModule()).toBe(m);
  });
});
