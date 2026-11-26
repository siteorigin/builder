import type dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { isLocalhostName, resolveLocalhostNames, type Resolver } from './relay-harness';

type Answer = { err: unknown; address: unknown; family?: number };

/** A resolver that knows no name at all, as Windows' knows no name under `localhost` but `localhost` itself. */
function resolverKnowingNothing() {
  const asked: string[] = [];
  const notFound = (hostname: string) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  const target: Resolver = {
    lookup: ((hostname: string, options: unknown, callback?: unknown) => {
      asked.push(hostname);
      ((typeof options === 'function' ? options : callback) as (e: unknown) => void)(notFound(hostname));
    }) as unknown as typeof dns.lookup,
    promises: {
      lookup: (async (hostname: string) => {
        asked.push(hostname);
        throw notFound(hostname);
      }) as unknown as typeof dns.promises.lookup
    }
  };
  const ask = (hostname: string, options?: object | number) =>
    new Promise<Answer>((resolve) => {
      const done = (err: unknown, address: unknown, family?: number) => resolve({ err, address, family });
      if (options === undefined) (target.lookup as (h: string, cb: typeof done) => void)(hostname, done);
      else (target.lookup as (h: string, o: unknown, cb: typeof done) => void)(hostname, options, done);
    });
  const askPromise = (hostname: string, options?: object) => (target.promises.lookup as (h: string, o?: object) => Promise<unknown>)(hostname, options);
  return { target, asked, ask, askPromise };
}

const BOTH = [
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 }
];

describe('names under localhost in the relay tests', () => {
  it('knows which names are under localhost', () => {
    for (const name of ['localhost', 'relay.localhost', 'p-abc.relay.localhost', 'RELAY.LOCALHOST', 'relay.localhost.']) expect(isLocalhostName(name), name).toBe(true);
    for (const name of ['example.com', 'localhost.example.com', 'notlocalhost', 'relay.localhost.test']) expect(isLocalhostName(name), name).toBe(false);
  });

  it('gives a room’s preview origin the loopback addresses on Windows, in every form a lookup is asked', async () => {
    const r = resolverKnowingNothing();
    resolveLocalhostNames('win32', r.target);
    expect(await r.ask('p-abc.relay.localhost')).toEqual({ err: null, address: '127.0.0.1', family: 4 });
    expect(await r.ask('p-abc.relay.localhost', { all: true })).toEqual({ err: null, address: BOTH, family: undefined });
    expect(await r.ask('relay.localhost', { family: 6 })).toEqual({ err: null, address: '::1', family: 6 });
    expect(await r.ask('relay.localhost', 4)).toEqual({ err: null, address: '127.0.0.1', family: 4 });
    expect(await r.ask('relay.localhost', { family: 'IPv6', all: true })).toEqual({ err: null, address: [BOTH[1]], family: undefined });
    // The promise form is the one Playwright's route.fetch asks, once for each family.
    expect(await r.askPromise('p-abc.relay.localhost', { all: true, family: 4 })).toEqual([BOTH[0]]);
    expect(await r.askPromise('p-abc.relay.localhost', { all: true })).toEqual(BOTH);
    expect(await r.askPromise('p-abc.relay.localhost')).toEqual(BOTH[0]);
    expect(r.asked).toEqual([]);
  });

  it('leaves every other name to the resolver', async () => {
    const r = resolverKnowingNothing();
    resolveLocalhostNames('win32', r.target);
    expect((await r.ask('example.com')).err).toMatchObject({ code: 'ENOTFOUND' });
    await expect(r.askPromise('example.org')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect(r.asked).toEqual(['example.com', 'example.org']);
  });

  it('changes nothing where the system resolver already answers them', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const r = resolverKnowingNothing();
      resolveLocalhostNames(platform, r.target);
      expect((await r.ask('p-abc.relay.localhost')).err).toMatchObject({ code: 'ENOTFOUND' });
      await expect(r.askPromise('p-abc.relay.localhost')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    }
  });
});
