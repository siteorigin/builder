import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FETCH_TIMEOUT_MS, findMetadataFiles, verifyAllFiles, verifyFileUrl, verifyWithRetries } from '../../scripts/release/verify-r2-uploads';
import {
  compareMetadata,
  fetchRemoteMetadata,
  loadLocalMetadata,
  validateMetadataSuffix,
  verifyMetadataOnce,
  verifyMetadataWithRetries
} from '../../scripts/release/verify-r2-metadata';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'so-release-verify-'));
  tempDirs.push(dir);
  return dir;
}

const MAC_METADATA =
  'version: 1.0.0\nfiles:\n  - url: siteorigin-builder-1.0.0-mac-x64.zip\n    sha512: aaa\n    size: 100\npath: siteorigin-builder-1.0.0-mac-x64.zip\nsha512: aaa\nreleaseDate: 2026-01-01\n';

/** A HEAD response: a status and, unless null, a Content-Length. */
function headResponse({ status = 200, contentLength = 100 as number | string | null }) {
  return { status, headers: { get: (name: string) => (name.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) } };
}

/** A GET response for a metadata file. */
function bodyResponse({ status = 200, body = 'version: 1.0.0\n' }) {
  return { status, text: () => Promise.resolve(body) };
}

describe('verifyFileUrl', () => {
  const publishUrl = 'https://x.example/r/';
  const entry = { url: 'siteorigin-builder-1.0.0-mac-x64.zip', size: 100 };

  it('passes a 200 with the listed size, from a HEAD request to the published URL', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({}));
    expect(await verifyFileUrl(entry, { fetch, publishUrl })).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://x.example/r/siteorigin-builder-1.0.0-mac-x64.zip', expect.objectContaining({ method: 'HEAD', redirect: 'follow' }));
  });

  it('checks an absolute url as it is', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({}));
    expect(await verifyFileUrl({ url: 'https://other.example/a.zip', size: 100 }, { fetch, publishUrl })).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://other.example/a.zip', expect.anything());
  });

  it('fails a 404, naming the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ status: 404 }));
    expect(await verifyFileUrl(entry, { fetch, publishUrl })).toBe('expected HTTP 200 for https://x.example/r/siteorigin-builder-1.0.0-mac-x64.zip, got 404');
  });

  it('fails a size that differs from the listed one', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ contentLength: 200 }));
    const result = await verifyFileUrl(entry, { fetch, publishUrl });
    expect(result).toContain('Content-Length mismatch');
    expect(result).toContain('expected 100, got 200');
  });

  it('fails a missing Content-Length', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ contentLength: null }));
    expect(await verifyFileUrl(entry, { fetch, publishUrl })).toContain('missing Content-Length');
  });

  it('fails a Content-Length of 0 for a file that has bytes', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ contentLength: 0 }));
    const result = await verifyFileUrl(entry, { fetch, publishUrl });
    expect(result).toContain('Content-Length mismatch');
    expect(result).toContain('got 0');
  });

  it('fails a Content-Length that is not a number', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ contentLength: 'abc' }));
    expect(await verifyFileUrl(entry, { fetch, publishUrl })).toContain('invalid Content-Length "abc"');
  });

  it('reports a network failure as a network error, not a timeout', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('DNS lookup failed'));
    const result = await verifyFileUrl(entry, { fetch, publishUrl });
    expect(result).toContain('network error');
    expect(result).toContain('DNS lookup failed');
    expect(result).not.toContain('timed out');
  });
});

describe('the per-request deadline', () => {
  const publishUrl = 'https://x.example/r/';
  const entry = { url: 'siteorigin-builder-1.0.0-mac-x64.zip', size: 100 };

  /** A fetch that never settles, recording the signal each call was given. */
  function stalledFetch() {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    return { fetch, signals };
  }

  it('aborts a fetch that never settles and names the URL in the timeout error', async () => {
    vi.useFakeTimers();
    const { fetch, signals } = stalledFetch();
    const pending = verifyFileUrl(entry, { fetch, publishUrl });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(signals[0].aborted).toBe(true);
    expect(result).toBe(`request timed out after ${FETCH_TIMEOUT_MS}ms fetching https://x.example/r/siteorigin-builder-1.0.0-mac-x64.zip`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer after a fast response', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(headResponse({}));
    expect(await verifyFileUrl(entry, { fetch, publishUrl })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses every attempt on a stalled fetch without waiting out real deadlines', async () => {
    vi.useFakeTimers();
    const { fetch, signals } = stalledFetch();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const pending = verifyWithRetries(entry, { fetch, publishUrl, sleep, timeoutMs: 50 });
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result).toContain('timed out');
    expect(result).toContain('https://x.example/r/siteorigin-builder-1.0.0-mac-x64.zip');
  });

  it('surfaces a timed-out installer as a failure from verifyAllFiles', async () => {
    const dir = await tempDir();
    const yml = join(dir, 'latest-mac.yml');
    await writeFile(yml, 'version: 1.0.0\nfiles:\n  - url: stalled.zip\n    sha512: aaa\n    size: 100\npath: stalled.zip\nsha512: aaa\nreleaseDate: 2026-01-01\n');
    vi.useFakeTimers();
    const { fetch } = stalledFetch();
    const pending = verifyAllFiles({ metadataFiles: [yml], publishUrl, fetch, sleep: vi.fn().mockResolvedValue(undefined), timeoutMs: 50, log: vi.fn() });
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(50);
    const failures = await pending;
    expect(failures).toHaveLength(1);
    expect(failures[0].filePath).toBe(yml);
    expect(failures[0].message).toContain('timed out');
    expect(failures[0].message).toContain('https://x.example/r/stalled.zip');
  });
});

describe('verifyWithRetries', () => {
  const publishUrl = 'https://x.example/r/';
  const entry = { url: 'foo.zip', size: 100 };

  it('returns null on a first-attempt success without sleeping', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyWithRetries(entry, { fetch, publishUrl, sleep })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a failure, backing off 5 s then 10 s, and succeeds on the third attempt', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(headResponse({ status: 404 }))
      .mockResolvedValueOnce(headResponse({ status: 404 }))
      .mockResolvedValueOnce(headResponse({}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyWithRetries(entry, { fetch, publishUrl, sleep })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5000], [10000]]);
  });

  it('returns the last error once every attempt has failed', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ status: 404 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyWithRetries(entry, { fetch, publishUrl, sleep })).toContain('404');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries a network error as well as an HTTP error', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(headResponse({}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyWithRetries(entry, { fetch, publishUrl, sleep })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('respects a custom maxAttempts and baseDelayMs', async () => {
    const fetch = vi.fn().mockResolvedValue(headResponse({ status: 404 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await verifyWithRetries(entry, { fetch, publishUrl, sleep, maxAttempts: 4, baseDelayMs: 100 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[100], [200], [400]]);
  });
});

describe('findMetadataFiles', () => {
  it('finds the macOS, Linux and Windows (no suffix) files, ignoring installers', async () => {
    const dir = await tempDir();
    for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml', 'siteorigin-builder-1.0.0-mac-x64.zip']) await writeFile(join(dir, name), 'x: 1');
    expect(await findMetadataFiles(dir, 'latest')).toEqual([join(dir, 'latest-mac.yml'), join(dir, 'latest-linux.yml'), join(dir, 'latest.yml')]);
  });

  it('matches the channel exactly', async () => {
    const dir = await tempDir();
    for (const name of ['rc-mac.yml', 'rc-linux.yml', 'rc.yml', 'latest-mac.yml', 'beta.yml']) await writeFile(join(dir, name), 'x: 1');
    expect((await findMetadataFiles(dir, 'rc')).map((p) => basename(p))).toEqual(['rc-mac.yml', 'rc-linux.yml', 'rc.yml']);
  });

  it('finds a folder holding only one platform', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'rc-linux.yml'), 'x: 1');
    await writeFile(join(dir, 'siteorigin-builder-1.0.0-linux-x86_64.AppImage'), 'binary');
    expect((await findMetadataFiles(dir, 'rc')).map((p) => basename(p))).toEqual(['rc-linux.yml']);
  });

  it('ignores a linux-arm64 file, which has no feed', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-linux-arm64.yml'), 'x: 1');
    expect(await findMetadataFiles(dir, 'latest')).toEqual([]);
  });
});

describe('verifyAllFiles', () => {
  const publishUrl = 'https://x.example/r/';

  it('collects the failures across every metadata file and logs what passed', async () => {
    const dir = await tempDir();
    const macYml = join(dir, 'latest-mac.yml');
    const linuxYml = join(dir, 'latest-linux.yml');
    await writeFile(
      macYml,
      'version: 1.0.0\nfiles:\n  - url: mac-x64.zip\n    sha512: aaa\n    size: 100\n  - url: mac-arm64.zip\n    sha512: bbb\n    size: 200\npath: mac-x64.zip\nsha512: aaa\nreleaseDate: 2026-01-01\n'
    );
    await writeFile(linuxYml, 'version: 1.0.0\nfiles:\n  - url: linux.AppImage\n    sha512: ccc\n    size: 300\npath: linux.AppImage\nsha512: ccc\nreleaseDate: 2026-01-01\n');
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('mac-x64.zip')) return headResponse({});
      if (url.endsWith('mac-arm64.zip')) return headResponse({ status: 404 });
      if (url.endsWith('linux.AppImage')) return headResponse({ contentLength: 999 });
      throw new Error(`unexpected url ${url}`);
    });
    const log = vi.fn();

    const failures = await verifyAllFiles({ metadataFiles: [macYml, linuxYml], publishUrl, fetch, sleep: vi.fn().mockResolvedValue(undefined), log });

    expect(failures).toHaveLength(2);
    expect(failures[0]).toEqual({ filePath: macYml, message: expect.stringContaining('404') });
    expect(failures[1]).toEqual({ filePath: linuxYml, message: expect.stringContaining('Content-Length mismatch') });
    expect(log).toHaveBeenCalledWith('[verify] ok https://x.example/r/mac-x64.zip (100 bytes)');
  });

  it('reports malformed YAML as a failure rather than throwing', async () => {
    const dir = await tempDir();
    const yml = join(dir, 'latest-mac.yml');
    await writeFile(yml, 'files:\n  - url: foo\n    size: [unclosed\n');
    const fetch = vi.fn();
    const failures = await verifyAllFiles({ metadataFiles: [yml], publishUrl, fetch, sleep: vi.fn(), log: () => {} });
    expect(failures).toEqual([{ filePath: yml, message: expect.stringContaining('failed to read or parse metadata') }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an entry with no url or a size that is not finite as invalid', async () => {
    const dir = await tempDir();
    const yml = join(dir, 'latest-mac.yml');
    await writeFile(yml, 'version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: .nan\n  - sha512: bbb\n    size: 10\npath: mac.zip\nsha512: aaa\n');
    const fetch = vi.fn();
    const failures = await verifyAllFiles({ metadataFiles: [yml], publishUrl, fetch, sleep: vi.fn(), log: () => {} });
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.message.startsWith('invalid file entry'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports metadata with an empty files list', async () => {
    const dir = await tempDir();
    const yml = join(dir, 'latest-mac.yml');
    await writeFile(yml, 'version: 1.0.0\nfiles: []\n');
    const fetch = vi.fn();
    const failures = await verifyAllFiles({ metadataFiles: [yml], publishUrl, fetch, sleep: vi.fn(), log: () => {} });
    expect(failures).toEqual([{ filePath: yml, message: 'files[] missing or empty' }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('validateMetadataSuffix', () => {
  it('accepts the macOS, Linux and Windows (empty) suffixes', () => {
    for (const suffix of ['-mac', '-linux', '']) expect(validateMetadataSuffix(suffix)).toEqual({ ok: true });
  });

  it('rejects a suffix no feed uses, listing the valid ones', () => {
    for (const suffix of ['-win', '-linux-arm64', 'mac']) {
      const result = validateMetadataSuffix(suffix);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(`"${suffix}"`);
        expect(result.error).toContain('"-mac", "-linux", ""');
      }
    }
  });
});

describe('loadLocalMetadata', () => {
  it('reads and parses a metadata file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    const result = loadLocalMetadata(dir, 'latest-mac.yml');
    expect(result).toMatchObject({ version: '1.0.0', path: 'siteorigin-builder-1.0.0-mac-x64.zip', sha512: 'aaa' });
    expect(result.files).toEqual([{ url: 'siteorigin-builder-1.0.0-mac-x64.zip', sha512: 'aaa', size: 100 }]);
  });

  it('throws when the file does not exist', async () => {
    const dir = await tempDir();
    expect(() => loadLocalMetadata(dir, 'latest-mac.yml')).toThrow(/failed to read local metadata/);
  });

  it('throws on malformed YAML', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), 'version: 1.0.0\nfiles:\n  - url: foo\n    size: [unclosed\n');
    expect(() => loadLocalMetadata(dir, 'latest-mac.yml')).toThrow(/failed to parse/);
  });

  it('throws when the version, path or sha512 is missing', async () => {
    const dir = await tempDir();
    for (const [field, body] of [
      ['version', 'files: [{url: a}]\npath: x\nsha512: aaa\n'],
      ['path', 'version: 1.0.0\nfiles: [{url: a}]\nsha512: aaa\n'],
      ['sha512', 'version: 1.0.0\nfiles: [{url: a}]\npath: x\n']
    ]) {
      await writeFile(join(dir, 'latest-mac.yml'), body);
      expect(() => loadLocalMetadata(dir, 'latest-mac.yml')).toThrow(`missing or non-string '${field}' field`);
    }
  });

  it('throws when files is empty', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), 'version: 1.0.0\nfiles: []\npath: x\nsha512: aaa\n');
    expect(() => loadLocalMetadata(dir, 'latest-mac.yml')).toThrow(/files.*empty/);
  });
});

describe('fetchRemoteMetadata', () => {
  const url = 'https://downloads.siteorigin.com/releases/latest-mac.yml';

  it('returns the parsed YAML on a 200, passing an abort signal', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: MAC_METADATA }));
    const result = await fetchRemoteMetadata(url, fetch);
    expect(result.version).toBe('1.0.0');
    expect(result.files).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('throws on a 404', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ status: 404 }));
    await expect(fetchRemoteMetadata(url, fetch)).rejects.toThrow(/HTTP 200.*got 404/);
  });

  it('throws on a malformed YAML body', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: '\tbad: tab indentation is illegal' }));
    await expect(fetchRemoteMetadata(url, fetch)).rejects.toThrow(/failed to parse YAML/);
  });

  it('throws on a body that is not a mapping', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: 'just a string' }));
    await expect(fetchRemoteMetadata(url, fetch)).rejects.toThrow(`${url}: expected a YAML mapping`);
  });

  it('throws on a network error', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('DNS lookup failed'));
    await expect(fetchRemoteMetadata(url, fetch)).rejects.toThrow(/network error/);
  });

  it('throws when the body cannot be read', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, text: () => Promise.reject(new Error('stream closed')) });
    await expect(fetchRemoteMetadata(url, fetch)).rejects.toThrow(/failed to read body/);
  });
});

describe('compareMetadata', () => {
  const local = {
    version: '1.0.0',
    path: 'mac-x64.zip',
    sha512: 'aaa',
    files: [
      { url: 'mac-x64.zip', sha512: 'aaa', size: 100 },
      { url: 'mac-arm64.zip', sha512: 'bbb', size: 200 }
    ],
    releaseDate: '2026-01-01T00:00:00.000Z'
  };

  it('finds no difference in a full match', () => {
    expect(compareMetadata(local, structuredClone(local))).toBeNull();
  });

  it('ignores a different releaseDate', () => {
    expect(compareMetadata(local, { ...structuredClone(local), releaseDate: '2027-01-01T00:00:00.000Z' })).toBeNull();
  });

  it('finds a version, path or sha512 mismatch', () => {
    expect(compareMetadata(local, { ...structuredClone(local), version: '2.0.0' })).toBe('version mismatch: local=1.0.0, remote=2.0.0');
    expect(compareMetadata(local, { ...structuredClone(local), path: 'other.zip' })).toBe('path mismatch: local=mac-x64.zip, remote=other.zip');
    expect(compareMetadata(local, { ...structuredClone(local), sha512: 'xxx' })).toBe('sha512 mismatch for primary artifact (path=mac-x64.zip)');
  });

  it('finds a files list of a different length, or one that is not a list', () => {
    expect(compareMetadata(local, { ...structuredClone(local), files: [local.files[0]] })).toBe('files[] length mismatch: local=2, remote=1');
    expect(compareMetadata(local, { ...structuredClone(local), files: 'not-an-array' })).toBe('remote files[] is not an array');
  });

  it('finds a file whose url or sha512 differs', () => {
    const wrongUrl = structuredClone(local);
    wrongUrl.files[1].url = 'wrong.zip';
    expect(compareMetadata(local, wrongUrl)).toBe('files[1].url mismatch: local=mac-arm64.zip, remote=wrong.zip');
    const wrongHash = structuredClone(local);
    wrongHash.files[0].sha512 = 'wrong-hash';
    expect(compareMetadata(local, wrongHash)).toBe('files[0].sha512 mismatch for mac-x64.zip');
  });

  it('finds a file entry that is null or not an object', () => {
    expect(compareMetadata(local, { ...structuredClone(local), files: [local.files[0], null] })).toBe('files[1]: remote entry is not an object');
    expect(compareMetadata(local, { ...structuredClone(local), files: ['not-an-object', local.files[1]] })).toBe('files[0]: remote entry is not an object');
  });
});

describe('verifyMetadataOnce', () => {
  const publishUrl = 'https://downloads.siteorigin.com/releases/';

  it('passes when the served file matches the local one', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: MAC_METADATA }));
    expect(await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, fetch)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://downloads.siteorigin.com/releases/latest-mac.yml', expect.anything());
  });

  it('fails permanently when the local file is missing', async () => {
    const dir = await tempDir();
    const fetch = vi.fn();
    const result = await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, fetch);
    expect(result).toMatchObject({ ok: false, transient: false, error: expect.stringContaining('failed to read local metadata') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails permanently on a content mismatch', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: MAC_METADATA.replace('version: 1.0.0', 'version: 2.0.0') }));
    const result = await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, fetch);
    expect(result).toMatchObject({ ok: false, transient: false, error: expect.stringContaining('content mismatch for https://downloads.siteorigin.com/releases/latest-mac.yml: version mismatch') });
  });

  it('fails transiently on a non-200 or a network error', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    expect(await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, vi.fn().mockResolvedValue(bodyResponse({ status: 503 })))).toMatchObject({ ok: false, transient: true });
    expect(await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, vi.fn().mockRejectedValue(new Error('ECONNRESET')))).toMatchObject({ ok: false, transient: true });
  });

  it('fails permanently on a served file that is not YAML', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: '\tbad: tab' }));
    expect(await verifyMetadataOnce('latest-mac.yml', publishUrl, dir, fetch)).toMatchObject({ ok: false, transient: false });
  });
});

describe('verifyMetadataWithRetries', () => {
  const publishUrl = 'https://x.example/r/';

  async function releaseDir(): Promise<string> {
    const dir = await tempDir();
    await writeFile(join(dir, 'latest-mac.yml'), MAC_METADATA);
    return dir;
  }

  it('returns null on a first-attempt success without sleeping', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: MAC_METADATA }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    expect(await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, log })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[verify-metadata] https://x.example/r/latest-mac.yml verified (attempt 1)');
  });

  it('retries a 404, backing off 5 s then 10 s, and succeeds on the third attempt', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(bodyResponse({ status: 404 }))
      .mockResolvedValueOnce(bodyResponse({ status: 404 }))
      .mockResolvedValueOnce(bodyResponse({ body: MAC_METADATA }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, log: vi.fn() })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5000], [10000]]);
  });

  it('returns the last error once every attempt has failed', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ status: 404 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, log: vi.fn() })).toContain('404');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries a network error', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(bodyResponse({ body: MAC_METADATA }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, log: vi.fn() })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('respects a custom maxAttempts and baseDelayMs', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ status: 404 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, maxAttempts: 4, baseDelayMs: 100, log: vi.fn() });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[100], [200], [400]]);
  });

  it('refuses a maxAttempts below 1', async () => {
    const fetch = vi.fn();
    expect(await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep: vi.fn(), maxAttempts: 0, log: vi.fn() })).toBe(
      'maxAttempts must be >= 1, got 0'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry a missing local file', async () => {
    const fetch = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const error = await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await tempDir(), fetch, sleep, log });
    expect(error).toContain('failed to read local metadata');
    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('permanent error'));
  });

  it('does not retry a content mismatch', async () => {
    const fetch = vi.fn().mockResolvedValue(bodyResponse({ body: MAC_METADATA.replace('version: 1.0.0', 'version: 2.0.0') }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const error = await verifyMetadataWithRetries({ filename: 'latest-mac.yml', publishUrl, releaseDir: await releaseDir(), fetch, sleep, log });
    expect(error).toContain('version mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('permanent error'));
  });
});
