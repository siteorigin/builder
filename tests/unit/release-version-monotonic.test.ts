import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVersionMonotonic,
  extractVersion,
  fetchLiveVersion,
  resolvePlatforms,
  runGate,
  shouldSkipUpload,
  validatePrefix,
  writeSkipUploadOutput
} from '../../scripts/release/check-version-monotonic';
import { CHANNELS, PLATFORMS } from '../../scripts/release/feed';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'so-release-monotonic-'));
  tempDirs.push(dir);
  return dir;
}

/** What the feed serves for one URL: a version (HTTP 200 with that metadata), a bare status, a raw body, or a network error. */
type Served = { version: string } | { status: number } | { body: string } | Error;

/** A fetch that serves `feed` by URL and fails the test on any other URL. */
function fakeFetch(feed: Record<string, Served>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    // The checks add a cache-busting query (feed.ts `uncached`); the feed is looked up without it.
    const url = String(input).replace(/\?t=\d+$/, '');
    const served = feed[url];
    if (served instanceof Error) throw served;
    if (!served) throw new Error(`unexpected url ${url}`);
    if ('version' in served) return new Response(`version: ${served.version}\nfiles: []\n`, { status: 200 });
    if ('body' in served) return new Response(served.body, { status: 200 });
    return new Response(null, { status: served.status });
  });
}

/** Errors when this branch of a result union is the other one, so the test fails instead of reading `undefined`. */
function errorOf(result: { ok: boolean; error?: string }): string {
  if (result.ok || result.error === undefined) throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  return result.error;
}

describe('checkVersionMonotonic', () => {
  it('passes when the new version is strictly greater', () => {
    expect(checkVersionMonotonic('1.0.0', '1.0.1')).toEqual({ ok: true });
    expect(checkVersionMonotonic('1.9.0', '1.10.0')).toEqual({ ok: true });
  });

  it('skips when the versions are the same string, a re-tag of a version already live', () => {
    expect(checkVersionMonotonic('1.0.0', '1.0.0')).toEqual({ ok: true, skip: true });
  });

  it('skips an identical prerelease, a re-tag of a published rc', () => {
    expect(checkVersionMonotonic('1.0.0-rc.1', '1.0.0-rc.1')).toEqual({ ok: true, skip: true });
  });

  it('fails a difference only in build metadata, which was never itself published', () => {
    // semver.eq treats these as equal (build metadata is ignored for precedence), but 1.0.0+b was never the live
    // artifact: exact identity means it falls through to the strict-greater check and fails.
    const result = checkVersionMonotonic('1.0.0+a', '1.0.0+b');
    expect(result).not.toHaveProperty('skip');
    expect(errorOf(result)).toContain('not strictly greater');
  });

  it('fails when the new version is older', () => {
    const result = checkVersionMonotonic('1.0.0', '0.9.9');
    expect(result).not.toHaveProperty('skip');
    expect(errorOf(result)).toBe('new version 0.9.9 is not strictly greater than live 1.0.0');
  });

  it('passes from a prerelease to the release of the same version', () => {
    expect(checkVersionMonotonic('1.0.0-rc.1', '1.0.0')).toEqual({ ok: true });
  });

  it('passes from a release to the next prerelease', () => {
    expect(checkVersionMonotonic('1.0.0', '1.0.1-rc.1')).toEqual({ ok: true });
  });

  it('fails from a release to a prerelease of the same version, a downgrade and not a skip', () => {
    const result = checkVersionMonotonic('1.0.0', '1.0.0-rc.1');
    expect(result).not.toHaveProperty('skip');
    expect(errorOf(result)).toContain('not strictly greater');
  });

  it('fails on an invalid live version', () => {
    expect(errorOf(checkVersionMonotonic('not-a-version', '1.0.0'))).toBe("live version 'not-a-version' is not valid semver");
  });

  it('fails on an invalid new version', () => {
    expect(errorOf(checkVersionMonotonic('1.0.0', 'garbage'))).toBe("new version 'garbage' is not valid semver");
  });
});

describe('shouldSkipUpload', () => {
  it('skips only when every checked platform is already live and nothing failed', () => {
    expect(shouldSkipUpload(['mac'], ['mac'], [])).toBe(true);
    expect(shouldSkipUpload(['mac', 'linux'], ['mac', 'linux'], [])).toBe(true);
  });

  it('does not skip when only some platforms are already live', () => {
    expect(shouldSkipUpload(['mac', 'linux'], ['mac'], [])).toBe(false);
  });

  it('does not skip when no platform is already live', () => {
    expect(shouldSkipUpload(['mac', 'linux'], [], [])).toBe(false);
  });

  it('does not skip when any platform failed, even alongside a skip', () => {
    expect(shouldSkipUpload(['mac'], [], ['mac: downgrade'])).toBe(false);
    expect(shouldSkipUpload(['mac', 'linux'], ['linux'], ['mac: downgrade'])).toBe(false);
  });

  it('lets a failure veto the skip even when every platform counts as skipped', () => {
    // skipped.length === platforms.length here, so only the zero-failures clause can force false.
    expect(shouldSkipUpload(['mac'], ['mac'], ['mac: downgrade'])).toBe(false);
  });

  it('does not skip an empty platform set', () => {
    expect(shouldSkipUpload([], [], [])).toBe(false);
  });
});

describe('writeSkipUploadOutput', () => {
  const originalOutput = process.env.GITHUB_OUTPUT;

  afterEach(() => {
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
  });

  it('appends skip_upload, keeping the lines an earlier step already wrote', () => {
    // GITHUB_OUTPUT accumulates across a job: the write must append, not clobber another step's output.
    const file = join(tempDir(), 'github_output');
    process.env.GITHUB_OUTPUT = file;
    writeFileSync(file, 'prior-step=1\n');
    writeSkipUploadOutput(true);
    writeSkipUploadOutput(false);
    expect(readFileSync(file, 'utf8')).toBe('prior-step=1\nskip_upload=true\nskip_upload=false\n');
  });

  it('does nothing when GITHUB_OUTPUT is unset', () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => writeSkipUploadOutput(true)).not.toThrow();
  });

  it('throws when GITHUB_OUTPUT points at a path it cannot write, rather than losing the decision', () => {
    process.env.GITHUB_OUTPUT = join(tempDir(), 'missing', 'out');
    expect(() => writeSkipUploadOutput(true)).toThrow();
  });
});

describe('extractVersion', () => {
  it('returns the version string from a mapping', () => {
    expect(extractVersion({ version: '1.2.3' }, 'test.yml')).toBe('1.2.3');
  });

  it('throws when the input is null', () => {
    expect(() => extractVersion(null, 'test.yml')).toThrow(/expected a YAML mapping/);
  });

  it('throws when the input is a string instead of a mapping', () => {
    expect(() => extractVersion('hello', 'test.yml')).toThrow(/expected a YAML mapping/);
  });

  it('throws when the version field is missing', () => {
    expect(() => extractVersion({ files: [] }, 'test.yml')).toThrow(/missing 'version' field/);
  });

  it('throws when the version is a number, as YAML reads a bare `version: 1`', () => {
    expect(() => extractVersion({ version: 1 }, 'test.yml')).toThrow(/must be a string/);
  });

  it('throws when the version is not semver', () => {
    expect(() => extractVersion({ version: 'v1' }, 'test.yml')).toThrow(/not a valid semver/);
  });

  it('names the file in the error', () => {
    expect(() => extractVersion({}, 'live latest-mac.yml')).toThrow(/live latest-mac\.yml/);
  });
});

describe('validatePrefix', () => {
  it('accepts every channel', () => {
    for (const prefix of CHANNELS) expect(validatePrefix(prefix)).toEqual({ ok: true });
  });

  it('rejects a missing channel with the not-set guidance', () => {
    for (const prefix of ['', undefined]) {
      const error = errorOf(validatePrefix(prefix));
      expect(error).toContain('not set');
      expect(error).toContain('latest, rc, beta');
    }
  });

  it("rejects a typo, so the gate doesn't 404 every feed and pass it as a first release", () => {
    const error = errorOf(validatePrefix('latset'));
    expect(error).toContain("'latset'");
    expect(error).toContain('not a known channel');
  });
});

describe('resolvePlatforms', () => {
  it('checks every platform when unset, empty or whitespace', () => {
    for (const raw of [undefined, '', '   ']) expect(resolvePlatforms(raw)).toEqual({ ok: true, platforms: [...PLATFORMS] });
  });

  it('scopes to a single platform', () => {
    expect(resolvePlatforms('mac')).toEqual({ ok: true, platforms: ['mac'] });
    expect(resolvePlatforms('win')).toEqual({ ok: true, platforms: ['win'] });
  });

  it('normalizes case and whitespace, drops duplicates, and keeps the PLATFORMS order', () => {
    expect(resolvePlatforms(' WIN , mac , mac ')).toEqual({ ok: true, platforms: ['mac', 'win'] });
    expect(resolvePlatforms('win,linux,mac')).toEqual({ ok: true, platforms: ['mac', 'linux', 'win'] });
  });

  it("rejects an unknown platform so a typo can't skip the gate", () => {
    for (const raw of ['macos', 'linux-arm64']) {
      const error = errorOf(resolvePlatforms(raw));
      expect(error).toContain(raw);
      expect(error).toContain('mac, linux, win');
    }
  });
});

describe('fetchLiveVersion', () => {
  const base = 'https://x.example/r/';

  it("reads the version from the platform's metadata on the feed, asking the CDN not to serve a cached copy", async () => {
    const fetch = fakeFetch({ 'https://x.example/r/rc.yml': { version: '1.2.0-rc.1' } });
    expect(await fetchLiveVersion('rc', 'win', { baseUrl: base, fetch })).toEqual({ url: 'https://x.example/r/rc.yml', version: '1.2.0-rc.1' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/x\.example\/r\/rc\.yml\?t=\d+$/),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: { 'cache-control': 'no-cache' } })
    );
  });

  it('reads from the downloads domain by default', async () => {
    const fetch = fakeFetch({ 'https://downloads.siteorigin.com/releases/latest-mac.yml': { version: '1.0.0' } });
    expect(await fetchLiveVersion('latest', 'mac', { fetch })).toEqual({ url: 'https://downloads.siteorigin.com/releases/latest-mac.yml', version: '1.0.0' });
  });

  it('returns no version for a 404, a channel with no release yet', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/beta-linux.yml': { status: 404 } });
    expect(await fetchLiveVersion('beta', 'linux', { baseUrl: base, fetch })).toEqual({ url: 'https://x.example/r/beta-linux.yml', version: null });
  });

  it('throws on any other HTTP error', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/latest-mac.yml': { status: 503 } });
    await expect(fetchLiveVersion('latest', 'mac', { baseUrl: base, fetch })).rejects.toThrow('unexpected HTTP 503 from https://x.example/r/latest-mac.yml');
  });

  it('throws on a network error, naming the URL', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/latest-mac.yml': new Error('ECONNRESET') });
    await expect(fetchLiveVersion('latest', 'mac', { baseUrl: base, fetch })).rejects.toThrow('failed to fetch https://x.example/r/latest-mac.yml: ECONNRESET');
  });

  it('throws on a body that is not YAML', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/latest-mac.yml': { body: '\tbad: tab indentation is illegal' } });
    await expect(fetchLiveVersion('latest', 'mac', { baseUrl: base, fetch })).rejects.toThrow('failed to parse YAML from https://x.example/r/latest-mac.yml');
  });

  it('throws on metadata with no version', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/latest-mac.yml': { body: 'files: []\n' } });
    await expect(fetchLiveVersion('latest', 'mac', { baseUrl: base, fetch })).rejects.toThrow("live latest-mac.yml: missing 'version' field");
  });

  it('aborts a request that outlasts the timeout', async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    await expect(fetchLiveVersion('latest', 'mac', { baseUrl: base, fetch, timeoutMs: 5 })).rejects.toThrow('failed to fetch https://x.example/r/latest-mac.yml: aborted');
  });
});

describe('runGate', () => {
  const baseUrl = 'https://x.example/r/';
  const FEEDS = { mac: 'https://x.example/r/latest-mac.yml', linux: 'https://x.example/r/latest-linux.yml', win: 'https://x.example/r/latest.yml' };

  /** A release folder with `latest` metadata at `version` for each platform named. */
  function releaseDir(versions: Partial<Record<'mac' | 'linux' | 'win', string>>): string {
    const dir = tempDir();
    const names = { mac: 'latest-mac.yml', linux: 'latest-linux.yml', win: 'latest.yml' };
    for (const [platform, version] of Object.entries(versions)) writeFileSync(join(dir, names[platform as keyof typeof names]), `version: ${version}\nfiles: []\n`);
    return dir;
  }

  function gate(options: { dir: string; fetch: ReturnType<typeof fakeFetch>; platforms?: string; prefix?: string }) {
    const log = vi.fn();
    const result = runGate({ prefix: options.prefix ?? 'latest', platforms: options.platforms, releaseDir: options.dir, baseUrl, fetch: options.fetch, log });
    return { result, log };
  }

  it('allows a first release on a channel whose feeds all 404', async () => {
    const fetch = fakeFetch({ [FEEDS.mac]: { status: 404 }, [FEEDS.linux]: { status: 404 }, [FEEDS.win]: { status: 404 } });
    const { result, log } = gate({ dir: releaseDir({ mac: '1.0.0', linux: '1.0.0', win: '1.0.0' }), fetch });
    expect(await result).toEqual({ failures: [], skipUpload: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[monotonic] mac: no live latest-mac.yml (HTTP 404)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[monotonic] win: no live latest.yml (HTTP 404)'));
  });

  it('uploads a version greater than the live one', async () => {
    const fetch = fakeFetch({ [FEEDS.mac]: { version: '1.0.0' } });
    const { result, log } = gate({ dir: releaseDir({ mac: '1.0.1' }), fetch, platforms: 'mac' });
    expect(await result).toEqual({ failures: [], skipUpload: false });
    expect(log).toHaveBeenCalledWith(`[monotonic] mac: 1.0.1 > 1.0.0 (live ${FEEDS.mac}).`);
  });

  it('skips the upload when every checked platform already serves this version', async () => {
    const fetch = fakeFetch({ [FEEDS.mac]: { version: '1.2.0' }, [FEEDS.win]: { version: '1.2.0' } });
    const { result, log } = gate({ dir: releaseDir({ mac: '1.2.0', win: '1.2.0' }), fetch, platforms: 'mac,win' });
    expect(await result).toEqual({ failures: [], skipUpload: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mac: 1.2.0 is already live'));
  });

  it('uploads when only some platforms already serve this version', async () => {
    const fetch = fakeFetch({ [FEEDS.mac]: { version: '1.2.0' }, [FEEDS.linux]: { status: 404 } });
    const { result } = gate({ dir: releaseDir({ mac: '1.2.0', linux: '1.2.0' }), fetch, platforms: 'mac,linux' });
    expect(await result).toEqual({ failures: [], skipUpload: false });
  });

  it('fails a version lower than the live one, naming the platform and the feed', async () => {
    const fetch = fakeFetch({ [FEEDS.linux]: { version: '1.3.0' } });
    const { result } = gate({ dir: releaseDir({ linux: '1.2.0' }), fetch, platforms: 'linux' });
    expect(await result).toEqual({ failures: [`linux: new version 1.2.0 is not strictly greater than live 1.3.0 (feed: ${FEEDS.linux})`], skipUpload: false });
  });

  it('fails on a network error rather than passing it as a first release', async () => {
    const fetch = fakeFetch({ [FEEDS.win]: new Error('getaddrinfo ENOTFOUND') });
    const { result } = gate({ dir: releaseDir({ win: '1.2.0' }), fetch, platforms: 'win' });
    expect(await result).toEqual({ failures: [`win: failed to fetch ${FEEDS.win}: getaddrinfo ENOTFOUND`], skipUpload: false });
  });

  it('reports every platform in one run: an outage on one and a regression on another', async () => {
    const fetch = fakeFetch({ [FEEDS.mac]: { status: 500 }, [FEEDS.linux]: { version: '2.0.0' }, [FEEDS.win]: { version: '1.2.0' } });
    const { result } = gate({ dir: releaseDir({ mac: '1.2.0', linux: '1.2.0', win: '1.2.0' }), fetch });
    const { failures, skipUpload } = await result;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(`mac: unexpected HTTP 500 from ${FEEDS.mac}`);
    expect(failures[1]).toContain('linux: new version 1.2.0 is not strictly greater than live 2.0.0');
    expect(skipUpload).toBe(false);
  });

  it('fails before fetching when the release folder\'s metadata files disagree on the version', async () => {
    const fetch = fakeFetch({});
    const dir = releaseDir({ mac: '1.2.0', linux: '1.2.1' });
    const { result } = gate({ dir, fetch, platforms: 'mac,linux' });
    const { failures, skipUpload } = await result;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("the release folder's metadata files disagree on the new version");
    expect(failures[0]).toContain(`mac=1.2.0 (${join(dir, 'latest-mac.yml')})`);
    expect(failures[0]).toContain(`linux=1.2.1 (${join(dir, 'latest-linux.yml')})`);
    expect(skipUpload).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails when a checked platform has no metadata in the release folder', async () => {
    const fetch = fakeFetch({});
    const { result } = gate({ dir: releaseDir({ mac: '1.2.0' }), fetch, platforms: 'mac,win' });
    const { failures } = await result;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('failed to read local metadata');
    expect(failures[0]).toContain('latest.yml');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails before reading anything on an unknown channel or platform', async () => {
    const fetch = fakeFetch({});
    const dir = releaseDir({ mac: '1.2.0' });
    expect((await gate({ dir, fetch, prefix: 'latset' }).result).failures[0]).toContain('not a known channel');
    expect((await gate({ dir, fetch, platforms: 'macos' }).result).failures[0]).toContain('unknown platform(s): macos');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks the channel it was given', async () => {
    const fetch = fakeFetch({ 'https://x.example/r/rc-mac.yml': { version: '1.2.0-rc.1' } });
    const dir = tempDir();
    writeFileSync(join(dir, 'rc-mac.yml'), 'version: 1.2.0-rc.2\n');
    const { result } = gate({ dir, fetch, platforms: 'mac', prefix: 'rc' });
    expect(await result).toEqual({ failures: [], skipUpload: false });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/x\.example\/r\/rc-mac\.yml\?t=\d+$/), expect.anything());
  });
});
