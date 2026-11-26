/**
 * The source sync worker (#676): each sync runs in a process of its own, ended when it answers, fails, stalls or is
 * stopped, so a source can never hold the editor up; and what it says reaches the author in the app's own words,
 * never with a secret in them.
 */
import { describe, expect, it } from 'vitest';
import { createSyncRunner, SyncError, type SyncHandle } from '../../src/main/sources/client';
import { runSync, type ImageFetcher } from '../../src/main/sources/run';
import { AdapterError, type SourceAdapter } from '../../src/main/sources/registry';
import { recordHash } from '../../src/main/sources/hash';
import type { NormalizedRecord, SyncReply, SyncRequest } from '../../src/main/sources/protocol';

const SECRET = 'tok-9f8e7d6c5b4a';
const request: Omit<SyncRequest, 'id'> = { adapter: 'fixture', config: { credentials: { token: { $secret: 'team' } } }, secrets: { team: SECRET }, known: {} };

function fakeWorker(answer: (m: SyncRequest, w: { reply: (r: SyncReply) => void; exit: () => void }) => void) {
  const spawned: Array<{ killed: boolean; sent: SyncRequest[] }> = [];
  const spawn = (): SyncHandle => {
    const listeners: Record<string, Array<(x: unknown) => void>> = {};
    const state = { killed: false, sent: [] as SyncRequest[] };
    spawned.push(state);
    const emit = (e: string, x?: unknown) => (listeners[e] ?? []).forEach((l) => l(x));
    return {
      postMessage: (m: SyncRequest) => {
        state.sent.push(m);
        setTimeout(() => answer(m, { reply: (r) => emit('message', r), exit: () => emit('exit', 1) }));
      },
      on: (e: string, l: (x: never) => void) => ((listeners[e] ??= []).push(l as (x: unknown) => void), undefined),
      kill: () => ((state.killed = true), true)
    } as SyncHandle;
  };
  return { spawn, spawned };
}

const record = (id: string, extra: Partial<NormalizedRecord> = {}): NormalizedRecord => ({ externalId: id, title: `Record ${id}`, ...extra });

describe('the sync worker client', () => {
  it('answers with the records the worker read, sends it only the secrets the source names, and ends it', async () => {
    const { spawn, spawned } = fakeWorker((m, w) => w.reply({ id: m.id, ok: true, records: [record('1')], images: [] }));
    await expect(createSyncRunner(spawn).run('Team', request)).resolves.toEqual({ records: [record('1')], images: [] });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].killed).toBe(true);
    expect(spawned[0].sent[0].secrets).toEqual({ team: SECRET });
  });

  it('ends a worker that stalls, crashes or fails, says why in its own words, and gives no secret away', async () => {
    const slow = fakeWorker(() => undefined);
    const timedOut = createSyncRunner(slow.spawn, { timeoutMs: 20 }).run('Team', request);
    await expect(timedOut).rejects.toThrow('“Team” was not synced: it took too long, so it was stopped.');
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    const crashing = fakeWorker((_m, w) => w.exit());
    await expect(createSyncRunner(crashing.spawn).run('Team', request)).rejects.toMatchObject({ code: 'crashed' });
    // A server that echoes the token back: the detail keeps none of it, however it was written.
    const echoing = fakeWorker((m, w) => w.reply({ id: m.id, ok: false, code: 'auth', detail: `401 for Bearer ${SECRET} (${encodeURIComponent(SECRET)})` }));
    const refused = await createSyncRunner(echoing.spawn)
      .run('Team', request)
      .catch((e: SyncError) => e);
    expect(refused).toBeInstanceOf(SyncError);
    expect((refused as SyncError).code).toBe('auth');
    expect((refused as SyncError).message).toBe('“Team” was not synced: the source refused its credentials. Check the secrets it names (401 for Bearer [secret] ([secret])).');
    // A reason the app does not know, or a reply that is no reply, is a failure in the app's words.
    const odd = fakeWorker((m, w) => w.reply({ id: m.id, ok: false, code: `nope ${SECRET}` } as unknown as SyncReply));
    await expect(createSyncRunner(odd.spawn).run('Team', request)).rejects.toThrow('“Team” was not synced: the source could not be read.');
    expect([...slow.spawned, ...crashing.spawned, ...echoing.spawned, ...odd.spawned].every((s) => s.killed)).toBe(true);
  });

  it('ignores a foreign reply, and stop() or the sync’s own signal ends a sync in progress', async () => {
    const foreign = fakeWorker((m, w) => w.reply({ id: m.id + 1, ok: true, records: [], images: [] }));
    const runner = createSyncRunner(foreign.spawn, { timeoutMs: 5000 });
    let settled = false;
    const sync = runner.run('Team', request).finally(() => (settled = true));
    const other = runner.run('Other', request);
    await new Promise((r) => setTimeout(r, 20));
    // The foreign reply has come and gone: both are still waiting, their workers alive.
    expect(settled).toBe(false);
    expect(foreign.spawned.map((w) => w.killed)).toEqual([false, false]);
    runner.stop();
    await expect(sync).rejects.toMatchObject({ code: 'stopped' });
    await expect(other).rejects.toMatchObject({ code: 'stopped' });
    expect(foreign.spawned.every((w) => w.killed)).toBe(true);
    const abort = new AbortController();
    const waiting = fakeWorker(() => undefined);
    const aborted = createSyncRunner(waiting.spawn, { timeoutMs: 5000 }).run('Team', request, { signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    await expect(aborted).rejects.toMatchObject({ code: 'stopped' });
    expect(waiting.spawned[0].killed).toBe(true);
    // Stopped before it starts, no worker is started at all.
    const never = fakeWorker(() => undefined);
    await expect(createSyncRunner(never.spawn).run('Team', request, { signal: abort.signal })).rejects.toMatchObject({ code: 'stopped' });
    expect(never.spawned).toHaveLength(0);
  });

  it('ends a worker that had not started yet as soon as it starts', async () => {
    const listeners: Record<string, Array<() => void>> = {};
    let kills = 0;
    const handle = {
      postMessage: () => undefined,
      on: (e: string, l: () => void) => ((listeners[e] ??= []).push(l), undefined),
      kill: () => (++kills, kills > 1)
    } as unknown as SyncHandle;
    const runner = createSyncRunner(() => handle, { timeoutMs: 10 });
    await expect(runner.run('Team', request)).rejects.toMatchObject({ code: 'timeout' });
    expect(kills).toBe(1);
    listeners.spawn?.forEach((l) => l());
    expect(kills).toBe(2);
  });

  it('says so when the worker cannot be started or sent its request, and ends one that started', async () => {
    await expect(
      createSyncRunner(() => {
        throw new Error('no fork');
      }).run('Team', request)
    ).rejects.toMatchObject({ code: 'not-started' });
    let kills = 0;
    const deaf = { postMessage: () => { throw new Error('closed'); }, on: () => undefined, kill: () => (++kills, true) } as unknown as SyncHandle;
    await expect(createSyncRunner(() => deaf).run('Team', request)).rejects.toMatchObject({ code: 'not-started' });
    expect(kills).toBe(1);
  });

  it('settles on an error with no exit, a reply it cannot put in words, and a reply that is no list of records', async () => {
    const erroring = fakeWorker(() => undefined);
    const spawnErr = (): SyncHandle => {
      const h = erroring.spawn();
      const on = h.on.bind(h) as (e: string, l: () => void) => unknown;
      on('spawn', () => undefined);
      setTimeout(() => (h as unknown as { emitError?: () => void }).emitError?.(), 5);
      return { ...h, on: (e: string, l: () => void) => (e === 'error' ? setTimeout(l, 5) : on(e, l)) } as unknown as SyncHandle;
    };
    await expect(createSyncRunner(spawnErr, { timeoutMs: 5000 }).run('Team', request)).rejects.toMatchObject({ code: 'crashed' });
    // A lone surrogate cannot be written as an address: the detail is left out, and the sync still settles.
    const garbled = fakeWorker((m, w) => w.reply({ id: m.id, ok: false, code: 'auth', detail: 'bad \ud800 token' }));
    await expect(createSyncRunner(garbled.spawn, { timeoutMs: 5000 }).run('Team', { ...request, secrets: { team: 'x\ud800yz' } })).rejects.toMatchObject({ code: 'auth' });
    const empty = fakeWorker((m, w) => w.reply({ id: m.id, ok: true, records: [null as unknown as NormalizedRecord], images: [] }));
    await expect(createSyncRunner(empty.spawn).run('Team', request)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('ends a worker whose first kill worked only once', async () => {
    const listeners: Record<string, Array<() => void>> = {};
    let kills = 0;
    const handle = {
      postMessage: () => undefined,
      on: (e: string, l: () => void) => ((listeners[e] ??= []).push(l), undefined),
      kill: () => (++kills, true)
    } as unknown as SyncHandle;
    await expect(createSyncRunner(() => handle, { timeoutMs: 10 }).run('Team', request)).rejects.toMatchObject({ code: 'timeout' });
    listeners.spawn?.forEach((l) => l());
    expect(kills).toBe(1);
  });
});

describe('a sync as the worker runs it', () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  function fetcher() {
    const asked: string[] = [];
    const fetchImage: ImageFetcher = async (url) => (asked.push(url), { bytes: png, mime: 'image/png; charset=binary' });
    return { asked, fetchImage };
  }
  const adapter = (read: SourceAdapter['read']): Record<string, SourceAdapter> => ({ fixture: { read } });

  it('reads every record, and fetches only the pictures of records that changed, each once', async () => {
    const pic = { $image: { url: 'https://cdn.example/a.png' } };
    const unchanged = record('1', { featuredImage: { $image: { url: 'https://cdn.example/old.png' } } });
    const records = [unchanged, record('2', { featuredImage: pic, values: { photo: pic } }), record('3', { featuredImage: { $image: { url: 'https://cdn.example/x.png?sig=1', id: 'asset-7' } } })];
    const { asked, fetchImage } = fetcher();
    const reply = await runSync({ ...request, id: 4, known: { '1': recordHash(unchanged) } }, { adapters: adapter(async () => records), fetchImage });
    expect(reply).toEqual({
      id: 4,
      ok: true,
      records,
      images: [
        { key: 'url:https://cdn.example/a.png', mime: 'image/png', ext: '.png', bytes: png },
        { key: 'id:asset-7', mime: 'image/png', ext: '.png', bytes: png }
      ]
    });
    expect(asked).toEqual(['https://cdn.example/a.png', 'https://cdn.example/x.png?sig=1']);
  });

  it('never asks an address that carries a secret or leads to this computer, redirects included', async () => {
    const { asked, fetchImage } = fetcher();
    const one = (url: string) => runSync({ ...request, id: 2 }, { adapters: adapter(async () => [record('1', { values: { photo: { $image: { url } } } })]), fetchImage });
    expect(await one(`https://cdn.example/a.png?token=${SECRET}`)).toMatchObject({ ok: false, code: 'image', detail: 'a picture’s address holds a secret' });
    expect(await one('http://192.168.1.1/a.png')).toMatchObject({ ok: false, code: 'image' });
    expect(await one('http://localhost:8080/a.png')).toMatchObject({ ok: false, code: 'image' });
    expect(await one('https://user:pw@cdn.example/a.png')).toMatchObject({ ok: false, code: 'image' });
    expect(asked).toEqual([]);
    // An image field's own picture is fetched.
    expect(await one('https://cdn.example/field.png')).toMatchObject({ ok: true, images: [{ key: 'url:https://cdn.example/field.png' }] });
    // The real fetcher checks where a redirect leads before following it.
    const { fetchImage: real } = await import('../../src/main/sources/fetch-image');
    const seen: string[] = [];
    const fetchStub = async (u: string | URL) => {
      seen.push(String(u));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin.png' } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub as typeof fetch;
    try {
      await expect(real('https://cdn.example/a.png', 1000, new AbortController().signal, (u) => (u.includes('127.0.0.1') ? 'local' : null))).rejects.toMatchObject({ code: 'image', detail: 'local' });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(['https://cdn.example/a.png']);
  });

  it('fails the whole sync, in fixed words, on a reader that fails part way, a bad record or a picture that will not load', async () => {
    const { fetchImage } = fetcher();
    const run = (read: SourceAdapter['read'], f: ImageFetcher = fetchImage) => runSync({ ...request, id: 1 }, { adapters: adapter(read), fetchImage: f });
    // A thrown error never goes back as it was: it may hold what the server echoed.
    expect(
      await run(async () => {
        throw new Error(`page 2 failed for ${SECRET}`);
      })
    ).toEqual({ id: 1, ok: false, code: 'failed' });
    expect(
      await run(async () => {
        throw new AdapterError('auth', `token ${SECRET} refused`);
      })
    ).toEqual({ id: 1, ok: false, code: 'auth', detail: 'token [secret] refused' });
    expect(await run(async () => [record('1'), record('1')])).toMatchObject({ ok: false, code: 'invalid', detail: 'two records have the same ID' });
    expect(await run(async () => [{ externalId: '1', title: '' } as NormalizedRecord])).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run(async () => [{ ...record('1'), password: SECRET } as NormalizedRecord])).toMatchObject({ ok: false, code: 'invalid', detail: 'a record has a detail no entry has' });
    const withPicture = async () => [record('1', { featuredImage: { $image: { url: 'https://cdn.example/a.png' } } })];
    expect(
      await run(withPicture, async () => {
        throw new Error('ECONNRESET');
      })
    ).toMatchObject({ ok: false, code: 'image' });
    expect(await run(withPicture, async () => ({ bytes: png, mime: 'image/svg+xml' }))).toMatchObject({ ok: false, code: 'image' });
    // The second of two pictures failing fails it all: no reply carries some of its pictures.
    const two = async () => [record('1', { featuredImage: { $image: { url: 'https://cdn.example/a.png' } } }), record('2', { featuredImage: { $image: { url: 'https://cdn.example/b.png' } } })];
    const second: ImageFetcher = async (url) => {
      if (url.endsWith('b.png')) throw new Error('gone');
      return { bytes: png, mime: 'image/png' };
    };
    expect(await run(two, second)).toEqual({ id: 1, ok: false, code: 'image' });
    expect(await runSync({ ...request, adapter: 'contentful', id: 1 }, { adapters: adapter(withPicture), fetchImage })).toEqual({ id: 1, ok: false, code: 'adapter-unavailable' });
    expect(await runSync({ ...request, adapter: 'constructor', id: 1 }, { adapters: adapter(withPicture), fetchImage })).toEqual({ id: 1, ok: false, code: 'adapter-unavailable' });
  });
});
