/** The local server's key as stored by the main process: a cloud provider's key is refused before anything is written. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => env.userData, getVersion: () => '1.0.0' } }));

import { getKey, localEndpoint, setKey } from '../../src/main/settings';

beforeEach(() => {
  env.userData = mkdtempSync(join(tmpdir(), 'so-keys-'));
});
afterEach(() => rmSync(env.userData, { recursive: true, force: true }));

const file = () => join(env.userData, 'api-keys.json');

describe('the local server key', () => {
  it('refuses a cloud key and keeps the saved key exactly as it was', async () => {
    await setKey('local', 'local-secret');
    const before = readFileSync(file(), 'utf8');
    await expect(setKey('local', 'sk-proj-Abc123_def-456')).rejects.toThrow(/OpenAI API key/);
    await expect(setKey('local', ' sk-ant-api03-secret ')).rejects.toThrow(/Anthropic API key/);
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect((await localEndpoint()).apiKey).toBe('local-secret');
  });

  it('still stores local keys, removes them, and keeps cloud keys for their own providers', async () => {
    await setKey('local', 'sk-no-key-required');
    await setKey('openai', 'sk-proj-Abc123_def-456');
    expect((await getKey('local'))?.key).toBe('sk-no-key-required');
    expect((await getKey('openai'))?.key).toBe('sk-proj-Abc123_def-456');
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
    await setKey('local', null);
    expect(await getKey('local')).toBeNull();
    expect((await getKey('openai'))?.key).toBe('sk-proj-Abc123_def-456');
  });
});
