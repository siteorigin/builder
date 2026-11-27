/** The Git snapshots setting (#1153): off unless turned on, kept across a restart, and only ever on or off. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'so-git-setting-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const settingsFile = join(userData, 'settings.json');
async function freshSettings(file: object | null) {
  vi.resetModules();
  if (file) writeFileSync(settingsFile, JSON.stringify(file));
  else rmSync(settingsFile, { force: true });
  return import('../../src/main/settings');
}

describe('the Git snapshots setting', () => {
  beforeEach(() => rmSync(settingsFile, { force: true }));

  it('is off by default, and off for settings saved before it existed', async () => {
    expect((await (await freshSettings(null)).loadSettings()).settings.gitSnapshots).toBe(false);
    expect((await (await freshSettings({ settings: { appearance: 'dark' } })).loadSettings()).settings.gitSnapshots).toBe(false);
  });

  it('is kept on across a restart, and off again once turned off', async () => {
    const { updateSettings } = await freshSettings(null);
    expect((await updateSettings({ gitSnapshots: true })).gitSnapshots).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).settings.gitSnapshots).toBe(true);
    const again = await freshSettings(JSON.parse(readFileSync(settingsFile, 'utf8')));
    expect((await again.loadSettings()).settings.gitSnapshots).toBe(true);
    expect((await again.updateSettings({ gitSnapshots: false })).gitSnapshots).toBe(false);
  });

  it('reads anything but true as off, and refuses a value that is not on or off, keeping the one in use', async () => {
    for (const odd of ['yes', 1, null, {}]) expect((await (await freshSettings({ settings: { gitSnapshots: odd } })).loadSettings()).settings.gitSnapshots).toBe(false);
    const { updateSettings } = await freshSettings({ settings: { gitSnapshots: true } });
    const s = await updateSettings({ gitSnapshots: 'no' as unknown as boolean, appearance: 'light' });
    expect(s).toMatchObject({ gitSnapshots: true, appearance: 'light' });
  });
});
