/** Leaving the SEO view (#803) puts the sidebar back on the panel the view replaced, and never closes it. */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' }, addEventListener: () => undefined, removeEventListener: () => undefined });

type Store = { setState: (p: Record<string, unknown>) => void; getState: () => { leftTab: string | null }; leaveSeoView: () => void };
const load = (path: string) => import(/* @vite-ignore */ path);
let m: { store: Store };
beforeAll(async () => {
  m = { store: (await load('../../src/renderer/src/store')) as Store };
});

describe('leaveSeoView', () => {
  it('returns to the panel that was showing when the view opened', () => {
    m.store.setState({ leftTab: 'assets' });
    m.store.setState({ leftTab: 'seo' });
    m.store.leaveSeoView();
    expect(m.store.getState().leftTab).toBe('assets');
  });
  it('falls back to Pages when the sidebar was hidden, and does nothing outside the view', () => {
    m.store.setState({ leftTab: 'pages' });
    m.store.setState({ leftTab: null });
    m.store.setState({ leftTab: 'seo' });
    m.store.leaveSeoView();
    expect(m.store.getState().leftTab).toBe('pages');
    m.store.setState({ leftTab: 'assets' });
    m.store.leaveSeoView();
    expect(m.store.getState().leftTab).toBe('assets');
  });
});
