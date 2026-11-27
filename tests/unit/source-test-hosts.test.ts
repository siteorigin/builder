// Picture hosts a test serves on this computer (src/main/sources/test-hosts.ts): installed only in automated runs,
// handed to the sync worker in its environment, and used for the connection alone: every check a picture's address gets
// is still made on the address as written.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFetchImage, createHostCheck, type Lookup } from '../../src/main/sources/fetch-image';
import { imageAddressProblem } from '../../src/main/sources/protocol';
import { installSourceTestHosts, readTestHosts, SOURCE_TEST_HOSTS, TEST_HOST_ADDRESS, TEST_HOSTS_ENV, testHostFetch, testHostLookup, testHostsEnv } from '../../src/main/sources/test-hosts';

const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
let port = 0;
const asked: Array<{ url: string; authorization?: string }> = [];
const server = createServer((req, res) => {
  asked.push({ url: req.url ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
  if (req.url === '/photos/a.jpg?v=2') return void res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': PICTURE.length }).end(PICTURE);
  res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The system's lookup as a test sees it: every name this computer's, so only a test host gets past it. */
const loopbackLookup: Lookup = vi.fn(async () => [{ address: '127.0.0.1' }]);

describe('source test hosts', () => {
  it('give the worker nothing unless an automated run installed some and a test set one', () => {
    expect(testHostsEnv({})).toEqual({});
    const global = {};
    const hosts = installSourceTestHosts(global);
    expect((global as Record<symbol, unknown>)[SOURCE_TEST_HOSTS]).toBe(hosts);
    expect(testHostsEnv(global)).toEqual({});
    hosts.set('pictures.benchmark.example', 4321);
    expect(testHostsEnv(global)).toEqual({ [TEST_HOSTS_ENV]: JSON.stringify({ 'pictures.benchmark.example': 4321 }) });
    hosts.set('pictures.benchmark.example', null);
    expect(testHostsEnv(global)).toEqual({});
  });

  it('take only a web name and a port', () => {
    const hosts = installSourceTestHosts({});
    for (const host of ['localhost', 'Pictures.example', 'pictures', '127.0.0.1', '', 'a..example']) expect(() => hosts.set(host, 80)).toThrow('lowercase web name');
    for (const p of [0, 65536, 1.5, NaN]) expect(() => hosts.set('pictures.example', p)).toThrow('whole number');
    expect(hosts.hosts.size).toBe(0);
  });

  it('are read back by the worker as they were set, and a damaged value or entry names no host', () => {
    expect(readTestHosts({})).toBeNull();
    expect(readTestHosts({ [TEST_HOSTS_ENV]: '{' })).toBeNull();
    expect(readTestHosts({ [TEST_HOSTS_ENV]: '[1]' })).toBeNull();
    expect(readTestHosts({ [TEST_HOSTS_ENV]: JSON.stringify({ localhost: 80, 'a.example': 'x' }) })).toBeNull();
    expect([...readTestHosts({ [TEST_HOSTS_ENV]: JSON.stringify({ 'a.example': 80, localhost: 81, 'b.example': 70000 }) })!]).toEqual([['a.example', 80]]);
  });

  it('answer a test host with a documentation address and ask the system for every other name', async () => {
    const system: Lookup = vi.fn(async () => [{ address: '93.184.215.14' }]);
    const lookup = testHostLookup(new Map([['pictures.example', 80]]), system);
    expect(await lookup('pictures.example')).toEqual([{ address: TEST_HOST_ADDRESS }]);
    expect(await lookup('PICTURES.example')).toEqual([{ address: TEST_HOST_ADDRESS }]);
    expect(await lookup('other.example')).toEqual([{ address: '93.184.215.14' }]);
    expect(system).toHaveBeenCalledTimes(1);
  });

  it('connect to a test host on loopback over plain HTTP, however its address is written, and to every other address as asked', async () => {
    const platform = vi.fn(async () => new Response('x')) as unknown as typeof fetch;
    const f = testHostFetch(new Map([['pictures.example', 4321]]), platform);
    await f('http://pictures.example/a/b.jpg?v=1', { redirect: 'manual' });
    // Any address the lookup answers for is one the fetch takes to loopback: never asked of the real host.
    await f('https://pictures.example/a.jpg');
    await f('http://PICTURES.example./c.jpg');
    await f('http://other.example/a.jpg');
    await f('ftp://pictures.example/a.jpg');
    expect(vi.mocked(platform).mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:4321/a/b.jpg?v=1',
      'http://127.0.0.1:4321/a.jpg',
      'http://127.0.0.1:4321/c.jpg',
      'http://other.example/a.jpg',
      'ftp://pictures.example/a.jpg'
    ]);
    expect(vi.mocked(platform).mock.calls[0][1]).toEqual({ redirect: 'manual' });
    const system: Lookup = vi.fn(async () => [{ address: '127.0.0.1' }]);
    expect(await testHostLookup(new Map([['pictures.example', 4321]]), system)('pictures.example.')).toEqual([{ address: TEST_HOST_ADDRESS }]);
    expect(system).not.toHaveBeenCalled();
  });

  it('let a sync fetch a test host’s picture from this computer, checked on its address as written, and nothing else from here', async () => {
    const hosts = new Map([['pictures.benchmark.example', port]]);
    const fetchImage = createFetchImage(testHostLookup(hosts, loopbackLookup), testHostFetch(hosts));
    const check = (url: string) => imageAddressProblem(url);
    const signal = new AbortController().signal;
    asked.length = 0;
    const got = await fetchImage('http://pictures.benchmark.example/photos/a.jpg?v=2', 1000, signal, check);
    expect([Buffer.from(got.bytes).equals(PICTURE), got.mime]).toEqual([true, 'image/jpeg']);
    expect(asked).toEqual([{ url: '/photos/a.jpg?v=2' }]);
    // The address as written is still checked, and its limits still hold.
    await expect(fetchImage('http://pictures.benchmark.example/photos/a.jpg?v=2', 4, signal, check)).rejects.toMatchObject({ code: 'too-large' });
    await expect(fetchImage(`http://127.0.0.1:${port}/photos/a.jpg?v=2`, 1000, signal, check)).rejects.toMatchObject({ code: 'image' });
    // Another name that resolves to this computer is still refused, by what it resolves to.
    await expect(fetchImage(`http://other.example:${port}/photos/a.jpg?v=2`, 1000, signal, check)).rejects.toMatchObject({ code: 'image' });
    expect(asked).toHaveLength(2);
    // And a sample's check of a picture's host passes a test host, and no other name that resolves here.
    const checkHost = createHostCheck(testHostLookup(hosts, loopbackLookup));
    expect(await checkHost('http://pictures.benchmark.example/photos/a.jpg')).toBeNull();
    expect(await checkHost('http://other.example/photos/a.jpg')).toMatch('this computer');
  });
});
