/**
 * The local model is chosen per server (issue #83): switching servers never sends one server's model to another,
 * and what the app last learned about a server is shown only while that server and model are the ones in use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => env.userData, getVersion: () => '1.0.0' } }));

const A = 'http://127.0.0.1:8080/v1';
const B = 'http://127.0.0.1:1234/v1';

/** A fresh main process: settings are cached in memory once read. */
const settingsModule = async () => {
  vi.resetModules();
  return import('../../src/main/settings');
};
const localStatus = async (m: Awaited<ReturnType<typeof settingsModule>>) => (await m.providerStatuses()).find((p) => p.id === 'local')!;

beforeEach(() => {
  env.userData = mkdtempSync(join(tmpdir(), 'so-settings-'));
});
afterEach(() => rmSync(env.userData, { recursive: true, force: true }));

describe('the local model, per server', () => {
  it('follows the server: a new server uses its own choice or its first model, and the old one keeps its choice', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: A } } });
    await m.updateSettings({ ai: { local: { modelsByServer: { [A]: 'studio-a' } } } });
    expect((await m.localEndpoint()).model).toBe('studio-a');

    const onB = await m.updateSettings({ ai: { local: { baseURL: B } } });
    expect(onB.ai.models.local).toBe('');
    expect((await m.localEndpoint()).model).toBe('');
    await m.updateSettings({ ai: { local: { modelsByServer: { [B]: 'studio-b' } } } });
    expect((await m.localEndpoint()).model).toBe('studio-b');

    // The same server written another way is the same server.
    const back = await m.updateSettings({ ai: { local: { baseURL: `${A}/` } } });
    expect(back.ai.models.local).toBe('studio-a');
    expect(back.ai.local.modelsByServer).toEqual({ [A]: 'studio-a', [B]: 'studio-b' });
  });

  it('chooses a model given on its own for the server the change leaves saved, and leaves it alone otherwise', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { local: { baseURL: B }, models: { local: 'studio-b' } } });
    expect((await m.loadSettings()).settings.ai.local.modelsByServer).toEqual({ [B]: 'studio-b' });
    // Choosing a cloud model sends only that model, so a stale local one on screen cannot land on this server.
    const after = await m.updateSettings({ ai: { models: { openai: 'gpt-6.2-astra' } } });
    expect(after.ai.models).toMatchObject({ openai: 'gpt-6.2-astra', local: 'studio-b' });
    // An empty choice goes back to the server's first model.
    expect((await m.updateSettings({ ai: { local: { modelsByServer: { [B]: '' } } } })).ai.local.modelsByServer).toEqual({});
    // A server's own choice, named in the same change as a stale model from an older screen, wins.
    const both = await m.updateSettings({ ai: { models: { local: 'studio-a' }, local: { modelsByServer: { [B]: 'studio-b' } } } });
    expect(both.ai.local.modelsByServer).toEqual({ [B]: 'studio-b' });
    expect(both.ai.models.local).toBe('studio-b');
  });

  it('keeps the model saved before choices were per server, for the server saved with it', async () => {
    writeFileSync(join(env.userData, 'settings.json'), JSON.stringify({ settings: { ai: { provider: 'local', models: { local: 'studio-a' }, local: { baseURL: `${A}/`, allowRemote: false, toolMode: 'auto' } } } }));
    const m = await settingsModule();
    const { ai } = (await m.loadSettings()).settings;
    expect(ai.local.modelsByServer).toEqual({ [A]: 'studio-a' });
    expect(ai.models.local).toBe('studio-a');
    await m.updateSettings({ ai: { local: { baseURL: B } } });
    expect((await m.localEndpoint()).model).toBe('');
    expect(JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')).settings.ai.local.modelsByServer).toEqual({ [A]: 'studio-a' });
  });

  it('reads per-server choices from disk under their normalized address, and drops ones that are not text', async () => {
    writeFileSync(join(env.userData, 'settings.json'), JSON.stringify({ settings: { ai: { models: { local: 'old' }, local: { baseURL: A, modelsByServer: { [`${A}/`]: 'studio-a', [B]: 7 } } } } }));
    const m = await settingsModule();
    expect((await m.loadSettings()).settings.ai.local.modelsByServer).toEqual({ [A]: 'studio-a' });
    expect((await m.localEndpoint()).model).toBe('studio-a');
  });
});

describe('the last check of a local server', () => {
  it('is shown only while its server and model are the ones in use', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: A } } });
    expect((await localStatus(m)).check).toBeUndefined();
    m.localCheckRecorder({ baseURL: A, model: '' })({ ok: false, stage: 'server', message: 'Could not connect.' });
    expect((await localStatus(m)).check).toEqual({ ok: false, stage: 'server', message: 'Could not connect.' });

    await m.updateSettings({ ai: { local: { baseURL: B } } });
    expect((await localStatus(m)).check).toBeUndefined();
    await m.updateSettings({ ai: { local: { baseURL: A, modelsByServer: { [A]: 'studio-a' } } } });
    expect((await localStatus(m)).check).toBeUndefined();
    await m.updateSettings({ ai: { local: { modelsByServer: { [A]: '' } } } });
    expect((await localStatus(m)).check).toMatchObject({ ok: false, message: 'Could not connect.' });
  });

  it('keeps each server apart, so a late answer about one never replaces what is known about another', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: B } } });
    const onA = m.localCheckRecorder({ baseURL: A, model: '' });
    m.localCheckRecorder({ baseURL: B, model: '' })({ ok: false, stage: 'server', message: 'B is down.' });
    onA({ ok: true });
    expect((await localStatus(m)).check).toEqual({ ok: false, stage: 'server', message: 'B is down.' });
    await m.updateSettings({ ai: { local: { baseURL: A } } });
    expect((await localStatus(m)).check).toEqual({ ok: true });
  });

  it('is cleared by a list only when reaching the server was what failed, and by any reply that worked', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: A, modelsByServer: { [A]: 'studio-a' } } } });
    const record = m.localCheckRecorder({ baseURL: A, model: 'studio-a' });
    record({ ok: false, stage: 'server', message: 'Could not connect.' });
    record({ listed: ['studio-a'] });
    expect((await localStatus(m)).check).toBeUndefined();

    // A model that is listed but cannot chat is still not ready after another list.
    record({ ok: false, stage: 'chat', message: 'model cannot chat' });
    record({ listed: ['other', 'studio-a'] });
    expect((await localStatus(m)).check).toMatchObject({ ok: false, stage: 'chat' });
    record({ ok: true });
    expect((await localStatus(m)).check).toEqual({ ok: true });
  });

  it("for the server's first model, is cleared once a different model is first", async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: A } } });
    const record = m.localCheckRecorder({ baseURL: A, model: '' });
    record({ ok: false, stage: 'chat', message: 'embed-model cannot chat' }, 'embed-model');
    record({ listed: ['embed-model', 'chat-model'] });
    expect((await localStatus(m)).check).toMatchObject({ ok: false, stage: 'chat' });
    record({ listed: ['chat-model', 'embed-model'] });
    expect((await localStatus(m)).check).toBeUndefined();
    // Reaching the server is what failed: a list clears it even when the same model is still first.
    record({ ok: false, stage: 'server', message: 'The local server rejected the API key.' }, 'chat-model');
    record({ listed: ['chat-model'] });
    expect((await localStatus(m)).check).toBeUndefined();
  });

  it('is forgotten when the server key changes, and a request made with the old key records nothing', async () => {
    const m = await settingsModule();
    await m.updateSettings({ ai: { provider: 'local', local: { baseURL: A } } });
    const withOldKey = m.localCheckRecorder({ baseURL: A, model: '' });
    withOldKey({ ok: false, stage: 'chat', message: 'The local server rejected the API key.' });
    await m.setKey('local', 'new-key');
    expect((await localStatus(m)).check).toBeUndefined();
    withOldKey({ ok: false, stage: 'chat', message: 'The local server rejected the API key.' });
    expect((await localStatus(m)).check).toBeUndefined();
    // A request that read the old key before it was replaced records nothing, though it finishes afterwards.
    const readWithOldKey = m.localCheckEpoch();
    await m.setKey('local', 'newer-key');
    m.localCheckRecorder({ baseURL: A, model: '' }, readWithOldKey)({ ok: false, stage: 'chat', message: 'The local server rejected the API key.' });
    expect((await localStatus(m)).check).toBeUndefined();
    m.localCheckRecorder({ baseURL: A, model: '' })({ ok: true });
    expect((await localStatus(m)).check).toEqual({ ok: true });
  });
});
