/** The local server's context size as Settings stores it: what is saved, what is refused, and what a run is given. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'so-settings-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('the context size in Settings', () => {
  it('reads a hand-edited value that is not a usable size as automatic, and keeps a good one', async () => {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ settings: { ai: { local: { baseURL: 'http://127.0.0.1:8080/v1', contextWindow: 'lots' } } } }));
    const { loadSettings, localEndpoint, updateSettings } = await import('../../src/main/settings');
    expect((await loadSettings()).settings.ai.local.contextWindow).toBeNull();

    await updateSettings({ ai: { local: { contextWindow: 8192 } } });
    expect((await localEndpoint()).contextWindow).toBe(8192);
    // A value that is not a usable size never erases the one in use.
    for (const bad of ['16384', 512, 4096.5, -1]) {
      const s = await updateSettings({ ai: { local: { contextWindow: bad as unknown as number } } });
      expect(s.ai.local.contextWindow).toBe(8192);
    }
    // The rest of the same change still applies.
    const s = await updateSettings({ ai: { local: { contextWindow: 'x' as unknown as number, toolMode: 'native' } } });
    expect(s.ai.local).toMatchObject({ contextWindow: 8192, toolMode: 'native' });
    // Null is how the author goes back to automatic.
    expect((await updateSettings({ ai: { local: { contextWindow: null } } })).ai.local.contextWindow).toBeNull();
    expect((await localEndpoint()).contextWindow).toBeNull();
  });
});
