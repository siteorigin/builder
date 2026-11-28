/**
 * The assistant's set_preview in the editor (#1405): the toolbar's width, colors and mode change as the toolbar changes
 * them, held to what the toolbar allows, and the answer says what the controls show afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from '@shared/api';
import type { PreviewControlRequest, PreviewControlResult } from '@shared/preview-control';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';

const sent: Array<[string, PreviewControlResult]> = [];
const saved: unknown[] = [];
vi.stubGlobal('window', {
  builder: { project: { saveLocalState: async (s: unknown) => void saved.push(s) }, previewControlResult: (id: string, r: PreviewControlResult) => void sent.push([id, r]), platform: 'darwin' },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
});
vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));

type Store = { getState: () => Record<string, any>; setState: (p: Record<string, unknown>) => void };
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as Store;
const { applyPreviewControl, runPreviewControl } = (await load('../../src/renderer/src/lib/preview-control')) as {
  applyPreviewControl: (req: Omit<PreviewControlRequest, 'requestId' | 'deadline'>) => PreviewControlResult;
  runPreviewControl: (req: PreviewControlRequest) => void;
};

function open(dark: boolean) {
  const state = structuredClone(createStarterState('business', 'Studio', false)) as ProjectState;
  if (dark) state.tokens.colorSchemeMode = 'system';
  else delete state.tokens.colorSchemeMode;
  store.setState({ screen: 'editor', leaving: false, snapshot: { state, revision: 1, workspaceKey: 'w1' } as unknown as ProjectSnapshot, pageId: state.site.homePageId, viewport: 1280, previewScheme: 'system', mode: 'edit', leftTab: 'pages', post: null, postView: 'write', selection: null, definitionMode: null });
}

beforeEach(() => {
  sent.length = 0;
  saved.length = 0;
});

describe('applyPreviewControl', () => {
  it('switches to the phone preset in dark colors and Preview, as the toolbar would', () => {
    open(true);
    const r = applyPreviewControl({ viewport: 'phone', scheme: 'dark', mode: 'preview' });
    expect(r).toEqual({ now: { width: 390, preset: 'phone', scheme: 'dark', mode: 'preview', darkPalette: true }, changed: ['viewport', 'scheme', 'mode'], refused: [] });
    expect(store.getState().viewport).toBe(390);
    // The width is remembered for the project, as the toolbar's choice is.
    expect(saved).toContainEqual({ viewport: 390 });
  });

  it('takes a width the width field would, and says a setting already as asked changed nothing', () => {
    open(false);
    expect(applyPreviewControl({ width: 600, mode: 'edit' })).toMatchObject({ now: { width: 600, preset: null, mode: 'edit' }, changed: ['width'], refused: [] });
    expect(applyPreviewControl({ width: 100 })).toMatchObject({ changed: [], refused: [{ setting: 'width' }] });
    expect(store.getState().viewport).toBe(600);
  });

  it('refuses dark colors on a site with one palette, and still changes the width asked with them', () => {
    open(false);
    const r = applyPreviewControl({ viewport: 'tablet', scheme: 'dark' });
    expect(r).toMatchObject({ now: { width: 834, scheme: 'system', darkPalette: false }, changed: ['viewport'], refused: [{ setting: 'scheme' }] });
    expect(store.getState().previewScheme).toBe('system');
    // The toolbar has no palette choice there at all.
    for (const scheme of ['light', 'system'] as const) expect(applyPreviewControl({ scheme })).toMatchObject({ changed: [], refused: [{ setting: 'scheme' }] });
  });

  it('says what the canvas shows: one palette, whatever was chosen while the site had two', () => {
    open(false);
    store.setState({ previewScheme: 'dark' });
    expect(applyPreviewControl({ viewport: 'phone' })).toMatchObject({ now: { scheme: 'system' } });
  });

  it('keeps the width and Preview for the post writer, which covers the canvas', () => {
    open(true);
    store.setState({ leftTab: 'posts', post: { collectionId: 'posts', entryId: 'en_1' }, postView: 'write' });
    const r = applyPreviewControl({ viewport: 'phone', mode: 'preview', scheme: 'dark' });
    expect(r).toMatchObject({ changed: ['scheme'], refused: [{ setting: 'viewport' }, { setting: 'mode' }] });
    expect(store.getState()).toMatchObject({ viewport: 1280, mode: 'edit' });
  });

  it('changes nothing the SEO view covers', () => {
    open(true);
    store.setState({ leftTab: 'seo' });
    const r = applyPreviewControl({ viewport: 'phone', scheme: 'dark', mode: 'preview' });
    expect(r).toMatchObject({ changed: [], refused: [{ setting: 'viewport' }, { setting: 'scheme' }, { setting: 'mode' }] });
    expect(store.getState()).toMatchObject({ viewport: 1280, previewScheme: 'system', mode: 'edit' });
  });

  it('answers with an error when no project is open, and always answers the request', () => {
    store.setState({ screen: 'welcome', snapshot: null });
    runPreviewControl({ requestId: 'r1', viewport: 'phone', deadline: Date.now() + 10_000 });
    expect(sent).toEqual([['r1', { error: 'No project is open in the editor.' }]]);
  });

  it('applies nothing the main process stopped waiting for', () => {
    open(true);
    runPreviewControl({ requestId: 'r2', viewport: 'phone', deadline: Date.now() - 1 });
    expect(sent).toEqual([['r2', { error: 'The editor answered too late.' }]]);
    expect(store.getState().viewport).toBe(1280);
  });
});
