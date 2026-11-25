// The right panel opens on the AI (#696): its tab comes first, a window with no saved view opens on it, and its
// icon alone keeps the accent colour.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' } });

let store: typeof import('../../src/renderer/src/store');
beforeAll(async () => {
  store = await import('../../src/renderer/src/store');
});

describe('right panel views', () => {
  it('run AI, Inspector, Site styles, Project', () => {
    expect(store.RIGHT_TABS).toEqual(['chat', 'inspect', 'styles', 'project']);
  });

  it('build the dock tabs in that order, so the arrow keys follow it', () => {
    const editor = readFileSync('src/renderer/src/Editor.tsx', 'utf8');
    expect(editor).toContain('options={RIGHT_TABS.map((value) => ({ value, ...dockViews[value] }))}');
  });

  it('open on the AI before a project says otherwise', () => {
    expect(store.getState().rightTab).toBe('chat');
  });

  it('open on the AI with no saved view, or one this version does not have', () => {
    expect(store.restoreRightTab(undefined)).toBe('chat');
    expect(store.restoreRightTab(null)).toBe('chat');
    expect(store.restoreRightTab('outline')).toBe('chat');
    expect(store.restoreRightTab(3)).toBe('chat');
  });

  it('keep a saved view', () => {
    for (const tab of store.RIGHT_TABS) expect(store.restoreRightTab(tab)).toBe(tab);
  });
});

describe('the AI tab icon', () => {
  const layout = readFileSync('src/renderer/src/styles/layout.css', 'utf8');
  const tokens = readFileSync('src/renderer/src/styles/tokens.css', 'utf8');

  it('takes the accent whichever view is open', () => {
    expect(layout).toMatch(/#dock-tab-chat svg \{ color: var\(--accent-text\); \}/);
  });

  it('leaves the other tabs plain until selected', () => {
    for (const tab of ['inspect', 'styles', 'project']) expect(layout).not.toContain(`#dock-tab-${tab}`);
    expect(layout).toMatch(/\.dock-tab \{[^}]*color: var\(--text-2\)/);
  });

  it('has an accent in both themes', () => {
    const light = tokens.slice(tokens.indexOf(':root {'));
    const dark = tokens.slice(tokens.indexOf("[data-appearance='dark']"));
    expect(light).toMatch(/--accent-text: #[0-9a-f]{6};/);
    expect(dark).toMatch(/--accent-text: #[0-9a-f]{6};/);
  });
});
