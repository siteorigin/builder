/** The Ask AI shortcut as Settings stores it (#750): what is saved, what is refused, and what survives a restart. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'so-shortcuts-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const settingsFile = join(userData, 'settings.json');
/** A fresh copy of the settings module, as an app restart reads it. */
const restart = async () => {
  vi.resetModules();
  return import('../../src/main/settings');
};

describe('the Ask AI shortcut in Settings', () => {
  beforeEach(() => rmSync(settingsFile, { force: true }));

  it('starts at Cmd/Ctrl+J, and keeps a new binding across a restart', async () => {
    let m = await restart();
    expect((await m.loadSettings()).settings.shortcuts.askAi).toBe('Mod+J');
    expect(m.currentShortcuts().askAi).toBe('Mod+J');
    const s = await m.updateSettings({ shortcuts: { askAi: 'Mod+Shift+L' } });
    expect(s.shortcuts.askAi).toBe('Mod+Shift+L');
    expect(m.currentShortcuts().askAi).toBe('Mod+Shift+L');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).settings.shortcuts.askAi).toBe('Mod+Shift+L');

    m = await restart();
    expect((await m.loadSettings()).settings.shortcuts.askAi).toBe('Mod+Shift+L');
    // Reset to default is a binding like any other.
    expect((await m.updateSettings({ shortcuts: { askAi: 'Mod+J' } })).shortcuts.askAi).toBe('Mod+J');
  });

  it('refuses a binding that is taken or unusable, naming why, and changes nothing else in that request', async () => {
    const m = await restart();
    await m.updateSettings({ shortcuts: { askAi: 'Mod+L' } });
    await expect(m.updateSettings({ developerMode: true, shortcuts: { askAi: 'Mod+K' } })).rejects.toThrow(/command menu/);
    await expect(m.updateSettings({ shortcuts: { askAi: 'Mod+W' } })).rejects.toThrow(/Close Window/);
    await expect(m.updateSettings({ shortcuts: { askAi: 'Alt+J' } })).rejects.toThrow(/not a shortcut/);
    const s = (await m.loadSettings()).settings;
    expect(s.shortcuts.askAi).toBe('Mod+L');
    expect(s.developerMode).toBe(false);
  });

  it('leaves the shortcut alone when another setting changes', async () => {
    const m = await restart();
    await m.updateSettings({ shortcuts: { askAi: 'Mod+L' } });
    expect((await m.updateSettings({ developerMode: true })).shortcuts.askAi).toBe('Mod+L');
  });

  it('reads a hand-edited binding it cannot use, or one now taken, as the default', async () => {
    for (const askAi of ['Ctrl+Banana', 'Mod+K', 42]) {
      writeFileSync(settingsFile, JSON.stringify({ settings: { shortcuts: { askAi } } }));
      const m = await restart();
      expect((await m.loadSettings()).settings.shortcuts.askAi).toBe('Mod+J');
    }
  });
});
