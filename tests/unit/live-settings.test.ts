/** The advanced live session relay setting: what is saved, what is refused, and what is read back from disk. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRelayUrl } from '@shared/live/relay-url';

const userData = mkdtempSync(join(tmpdir(), 'so-live-settings-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const settingsFile = join(userData, 'settings.json');
async function freshSettings(file: object | null) {
  vi.resetModules();
  if (file) writeFileSync(settingsFile, JSON.stringify(file));
  else rmSync(settingsFile, { force: true });
  return import('../../src/main/settings');
}

describe('the live relay setting', () => {
  beforeEach(() => rmSync(settingsFile, { force: true }));

  it('defaults to none: the production relay', async () => {
    const { loadSettings } = await freshSettings(null);
    const s = (await loadSettings()).settings;
    expect(s.liveRelayUrl).toBeNull();
    expect(resolveRelayUrl({ setting: s.liveRelayUrl })).toMatchObject({ ok: true, source: 'default', url: 'https://live.siteorigin.com' });
  });

  it('saves a relay in its normal form and reads it back from disk', async () => {
    const { updateSettings } = await freshSettings({ settings: { appearance: 'dark', developerMode: true } });
    const s = await updateSettings({ liveRelayUrl: '  https://Collaborate.SiteOrigin.com/  ' });
    expect(s.liveRelayUrl).toBe('https://collaborate.siteorigin.com');
    // Nothing else changed with it.
    expect(s).toMatchObject({ appearance: 'dark', developerMode: true });
    // The update itself saved it.
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).settings).toMatchObject({ liveRelayUrl: 'https://collaborate.siteorigin.com', appearance: 'dark' });

    const { loadSettings } = await freshSettings(JSON.parse(readFileSync(settingsFile, 'utf8')));
    expect((await loadSettings()).settings.liveRelayUrl).toBe('https://collaborate.siteorigin.com');
  });

  it('refuses an unusable address without touching the one in use or the rest of the change', async () => {
    const { updateSettings, loadSettings } = await freshSettings(null);
    await updateSettings({ liveRelayUrl: 'http://127.0.0.1:8787' });
    for (const bad of ['ftp://relay.example.com', 'javascript:alert(1)', 'https://relay.example.com/s/abcdefghijkmnpqrstuvwxyz', 'not a url', 42 as unknown as string]) {
      const s = await updateSettings({ liveRelayUrl: bad, appearance: 'light' });
      expect(s.liveRelayUrl).toBe('http://127.0.0.1:8787');
      expect(s.appearance).toBe('light');
      // The cache itself was never given the bad value.
      expect((await loadSettings()).settings.liveRelayUrl).toBe('http://127.0.0.1:8787');
    }
  });

  it('goes back to the production relay when cleared', async () => {
    const { updateSettings } = await freshSettings({ settings: { liveRelayUrl: 'https://relay.example.com' } });
    expect((await updateSettings({ liveRelayUrl: null })).liveRelayUrl).toBeNull();
    await updateSettings({ liveRelayUrl: 'https://relay.example.com' });
    expect((await updateSettings({ liveRelayUrl: '   ' })).liveRelayUrl).toBeNull();
  });

  it('leaves the relay alone when a change does not name it', async () => {
    const { updateSettings } = await freshSettings({ settings: { liveRelayUrl: 'https://relay.example.com' } });
    expect((await updateSettings({ developerMode: true })).liveRelayUrl).toBe('https://relay.example.com');
  });

  it('keeps a hand-edited address it cannot use, so starting a session reports it instead of using production', async () => {
    const { loadSettings } = await freshSettings({ settings: { liveRelayUrl: 'wss://relay.example.com' } });
    const s = (await loadSettings()).settings;
    expect(s.liveRelayUrl).toBe('wss://relay.example.com');
    expect(resolveRelayUrl({ setting: s.liveRelayUrl })).toMatchObject({ ok: false, source: 'setting' });
    // Anything that is not text is no setting at all.
    for (const odd of [42, { url: 'x' }, '  ']) {
      const { loadSettings: load } = await freshSettings({ settings: { liveRelayUrl: odd } });
      expect((await load()).settings.liveRelayUrl).toBeNull();
    }
  });
});
