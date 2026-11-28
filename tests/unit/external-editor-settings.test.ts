/**
 * The code editor as Settings stores it (#1483): an application is set only by the main process's chooser, never by a
 * settings change the editor window sends, and a hand-edited setting that is no usable choice reads as the default.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'so-editor-settings-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const settingsFile = join(userData, 'settings.json');
const restart = async () => {
  vi.resetModules();
  return import('../../src/main/settings');
};

describe('the code editor in Settings', () => {
  beforeEach(() => rmSync(settingsFile, { force: true }));

  it('starts at the system’s default, takes a chosen application, and goes back to the default', async () => {
    let m = await restart();
    expect((await m.loadSettings()).settings.externalEditor).toEqual({ kind: 'system' });
    await m.setExternalEditor({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' });
    m = await restart();
    expect((await m.loadSettings()).settings.externalEditor).toEqual({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' });
    expect((await m.updateSettings({ externalEditor: { kind: 'system' } })).externalEditor).toEqual({ kind: 'system' });
  });

  it('never takes an application from a settings change, which the editor window sends', async () => {
    let m = await restart();
    await m.setExternalEditor({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' });
    const s = await m.updateSettings({ externalEditor: { kind: 'app', path: '/bin/sh', name: 'sh' }, appearance: 'dark' });
    // The editor chosen stays chosen, and the rest of the change is kept, across a restart too.
    expect(s.externalEditor).toEqual({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' });
    expect(s.appearance).toBe('dark');
    m = await restart();
    const again = await m.loadSettings();
    expect(again.settings.externalEditor).toEqual({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' });
    expect(again.settings.appearance).toBe('dark');
    await m.updateSettings({ externalEditor: { kind: 'system' } });
    m = await restart();
    expect((await m.loadSettings()).settings.externalEditor).toEqual({ kind: 'system' });
  });

  it('reads a hand-edited editor that is no usable choice as the default', async () => {
    writeFileSync(settingsFile, JSON.stringify({ settings: { externalEditor: { kind: 'app', path: 'code', name: 'Code' } } }));
    const m = await restart();
    expect((await m.loadSettings()).settings.externalEditor).toEqual({ kind: 'system' });
  });
});
