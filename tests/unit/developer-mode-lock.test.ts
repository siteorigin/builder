// Developer mode locked off for a run an external model drives (issue #498): the setting reads off and cannot be turned
// on, whatever the settings file holds or the editor asks; without the lock it behaves as before.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'so-devmode-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.SITEORIGIN_DEVELOPER_MODE;
  vi.resetModules();
});
const saved = (developerMode: boolean) => writeFileSync(join(userData, 'settings.json'), JSON.stringify({ settings: { developerMode } }));

describe('Developer mode locked off', () => {
  it('reads off and stays off when the run locks it, whatever is saved or asked', async () => {
    saved(true);
    process.env.SITEORIGIN_DEVELOPER_MODE = 'locked-off';
    const { developerModeLocked, loadSettings, updateSettings } = await import('../../src/main/settings');
    expect(developerModeLocked()).toBe(true);
    expect((await loadSettings()).settings.developerMode).toBe(false);
    expect((await updateSettings({ developerMode: true })).developerMode).toBe(false);
  });

  it('is as saved and as asked without the lock, or with any other value', async () => {
    saved(true);
    process.env.SITEORIGIN_DEVELOPER_MODE = 'off';
    const { developerModeLocked, loadSettings, updateSettings } = await import('../../src/main/settings');
    expect(developerModeLocked()).toBe(false);
    expect((await loadSettings()).settings.developerMode).toBe(true);
    expect((await updateSettings({ developerMode: false })).developerMode).toBe(false);
    expect((await updateSettings({ developerMode: true })).developerMode).toBe(true);
  });
});
