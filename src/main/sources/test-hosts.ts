/**
 * Picture hosts a test serves on this computer, in automated runs only. A sync never fetches a picture from this
 * computer or the local network (protocol.ts imageAddressProblem, fetch-image.ts), so a benchmark that serves a source's
 * pictures itself names a web host for them here, from the main process (a test's app.evaluate, through the debugger
 * Playwright starts the app with), and the sync worker it starts next connects to that host's port on loopback instead.
 * Every check a picture's address gets is still made on the address as written; only what the name resolves to (a
 * documentation address, which is on no local network) and the connection's end are the test's.
 *
 * Installed only in automated runs, under SOURCE_TEST_HOSTS on globalThis: no IPC channel, preload API, setting or port
 * is added, and a normal launch has nothing to reach. No electron import, so it is tested on its own.
 */
import type { Lookup } from './fetch-image';

/** Where the installed hosts are found on the main process's globalThis. */
export const SOURCE_TEST_HOSTS = Symbol.for('siteorigin.sourceTestHosts');

/** The worker's environment variable that carries them: host name to loopback port, as JSON. */
export const TEST_HOSTS_ENV = 'SITEORIGIN_SOURCE_TEST_HOSTS';

/** What a test host's name resolves to: TEST-NET-1 (RFC 5737), an address no network routes, local or not. */
export const TEST_HOST_ADDRESS = '192.0.2.1';

/** A host name a test may claim: a web name, lowercase, of at least two labels, the last no number (never an IP address). */
const NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const isHost = (host: unknown): host is string => typeof host === 'string' && NAME.test(host) && !/\.\d+$/.test(host);

export interface SourceTestHosts {
  /** Serve `host`'s pictures from `port` on loopback, for the syncs started from now on; null stops. */
  set(host: string, port: number | null): void;
  /** The hosts set, by name. */
  readonly hosts: ReadonlyMap<string, number>;
}

/** Publish the hosts on `global`: call it only in an automated run. */
export function installSourceTestHosts(global: object): SourceTestHosts {
  const hosts = new Map<string, number>();
  const fixture: SourceTestHosts = {
    hosts,
    set(host, port) {
      if (!isHost(host)) throw new Error('A test host is a lowercase web name, such as pictures.benchmark.example.');
      if (port === null) hosts.delete(host);
      else if (Number.isInteger(port) && port > 0 && port < 65536) hosts.set(host, port);
      else throw new Error('A test host’s port is a whole number from 1 to 65535.');
    }
  };
  (global as Record<symbol, unknown>)[SOURCE_TEST_HOSTS] = fixture;
  return fixture;
}

/** The worker's environment for the hosts installed on `global`: nothing when none are (every normal launch). */
export function testHostsEnv(global: object): Record<string, string> {
  const fixture = (global as Record<symbol, SourceTestHosts | undefined>)[SOURCE_TEST_HOSTS];
  if (!fixture?.hosts.size) return {};
  return { [TEST_HOSTS_ENV]: JSON.stringify(Object.fromEntries(fixture.hosts)) };
}

/** The hosts the worker was started with, or null: every entry checked, so a damaged entry names no host. */
export function readTestHosts(env: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, number> | null {
  const text = env[TEST_HOSTS_ENV];
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hosts = new Map<string, number>();
  for (const [host, port] of Object.entries(parsed)) if (isHost(host) && Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536) hosts.set(host, port as number);
  return hosts.size ? hosts : null;
}

/** A host name as the address checks read it: lowercase, without brackets or the root's dot ("pictures.example."). */
const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

/** A lookup that answers the test hosts with TEST_HOST_ADDRESS, and asks `system` for every other name. */
export const testHostLookup =
  (hosts: ReadonlyMap<string, number>, system: Lookup): Lookup =>
  (host) =>
    hosts.has(bare(host)) ? Promise.resolve([{ address: TEST_HOST_ADDRESS }]) : system(host);

/**
 * A fetch that connects to a test host's port on loopback, its path and query as asked, over plain HTTP whichever web
 * scheme the address was written with (so no address the lookup answered for is ever asked of the real host), and to
 * every other address as asked.
 */
export const testHostFetch =
  (hosts: ReadonlyMap<string, number>, platform: typeof fetch = (input, init) => fetch(input, init)): typeof fetch =>
  (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const port = url.protocol === 'http:' || url.protocol === 'https:' ? hosts.get(bare(url.hostname)) : undefined;
    if (port === undefined) return platform(input, init);
    return platform(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
