import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CHANNELS, METADATA_SUFFIXES, PLATFORMS, PUBLISH_URL, channelOf, isMain, metadataFilename, publishedUrl, uncached } from '../../scripts/release/feed';

describe('the release feed', () => {
  it('is served from the downloads domain under releases/', () => {
    expect(PUBLISH_URL).toBe('https://downloads.siteorigin.com/releases/');
  });

  it('has a feed for macOS, Linux and Windows only, in that order', () => {
    expect([...PLATFORMS]).toEqual(['mac', 'linux', 'win']);
  });

  it('knows the latest, rc and beta channels', () => {
    expect([...CHANNELS]).toEqual(['latest', 'rc', 'beta']);
  });
});

describe('uncached', () => {
  it('adds a query the CDN caches under a key of its own', () => {
    expect(uncached('https://x.example/r/latest.yml', 42)).toBe('https://x.example/r/latest.yml?t=42');
    expect(uncached('https://x.example/r/latest.yml?a=1', 42)).toBe('https://x.example/r/latest.yml?a=1&t=42');
  });
});

describe('channelOf', () => {
  it('reads an rc tag as the rc channel', () => {
    expect(channelOf('v1.2.0-rc.1')).toBe('rc');
    expect(channelOf('1.2.0-rc.1')).toBe('rc');
  });

  it('reads a beta version as the beta channel', () => {
    expect(channelOf('1.2.0-beta.2')).toBe('beta');
    expect(channelOf('v1.2.0-beta.2')).toBe('beta');
  });

  it('reads a plain release as the latest channel, with or without the v', () => {
    expect(channelOf('1.2.0')).toBe('latest');
    expect(channelOf('v1.2.0')).toBe('latest');
  });

  it('ignores build metadata', () => {
    expect(channelOf('1.2.0+build.5')).toBe('latest');
    expect(channelOf('1.2.0-rc.1+build.5')).toBe('rc');
  });

  // A client polls the feed its prerelease's first identifier names, so these would publish where nobody looks.
  it.each(['1.2.0-alpha.1', 'v1.2.0-rc1', '1.2.0-next.1'])('refuses %s, a prerelease on a channel that is not published', (version) => {
    expect(() => channelOf(version)).toThrow(/only rc and beta prereleases/);
  });
});

// The release workflows resolve the channel in bash (.github/actions/resolve-update-metadata-prefix); it must agree
// with channelOf, which the scripts and tests use.
describe('the resolve-update-metadata-prefix action', () => {
  const action = load(readFileSync('.github/actions/resolve-update-metadata-prefix/action.yml', 'utf8')) as { runs: { steps: { run: string }[] } };
  const script = action.runs.steps[0].run;

  function resolve(refType: string, refName: string): { status: number; prefix: string | null } {
    const dir = mkdtempSync(join(tmpdir(), 'so-prefix-'));
    try {
      const env = { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName, GITHUB_ENV: join(dir, 'env'), GITHUB_OUTPUT: join(dir, 'out') };
      const result = spawnSync('bash', ['-e', '-c', script], { env, encoding: 'utf8' });
      const out = result.status === 0 ? readFileSync(join(dir, 'out'), 'utf8') : '';
      return { status: result.status ?? -1, prefix: /^prefix=(.*)$/m.exec(out)?.[1] ?? null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(['v1.2.0', 'v1.2.0-rc.1', 'v1.2.0-beta.3', 'v1.2.0-rc.1+build.5'])('resolves the tag %s to the channel channelOf names', (tag) => {
    expect(resolve('tag', tag)).toEqual({ status: 0, prefix: channelOf(tag) });
  });

  it.each(['v1.2.0-alpha.1', 'v1.2.0-rc1'])('fails the run for the tag %s, which channelOf refuses too', (tag) => {
    expect(resolve('tag', tag).status).not.toBe(0);
    expect(() => channelOf(tag)).toThrow();
  });

  it('resolves a branch to latest, whatever its name looks like', () => {
    expect(resolve('branch', 'feature/release-pipeline')).toEqual({ status: 0, prefix: 'latest' });
    expect(resolve('branch', 'release/v0.2.0-rc.1')).toEqual({ status: 0, prefix: 'latest' });
  });
});

describe('metadataFilename', () => {
  it('suffixes the macOS and Linux files with their platform', () => {
    expect(metadataFilename('latest', 'mac')).toBe('latest-mac.yml');
    expect(metadataFilename('rc', 'linux')).toBe('rc-linux.yml');
  });

  it('gives the Windows file no suffix, because electron-updater polls <channel>.yml there', () => {
    expect(metadataFilename('beta', 'win')).toBe('beta.yml');
    expect(metadataFilename('latest', 'win')).toBe('latest.yml');
  });

  it('agrees with METADATA_SUFFIXES for every platform', () => {
    for (const platform of PLATFORMS) expect(metadataFilename('rc', platform)).toBe(`rc${METADATA_SUFFIXES[platform]}.yml`);
    expect(METADATA_SUFFIXES).toEqual({ mac: '-mac', linux: '-linux', win: '' });
  });
});

describe('publishedUrl', () => {
  it('joins a file name onto a base with a trailing slash', () => {
    expect(publishedUrl('https://x.example/r/', 'foo.zip')).toBe('https://x.example/r/foo.zip');
  });

  it('adds the slash when the base has none', () => {
    expect(publishedUrl('https://x.example/r', 'foo.zip')).toBe('https://x.example/r/foo.zip');
  });

  it('passes an absolute URL through unchanged', () => {
    expect(publishedUrl('https://x.example/r/', 'https://other.example/foo.zip')).toBe('https://other.example/foo.zip');
    expect(publishedUrl('https://x.example/r/', 'HTTP://other.example/foo.zip')).toBe('HTTP://other.example/foo.zip');
  });

  it('throws when the base is missing', () => {
    expect(() => publishedUrl('', 'foo.zip')).toThrow(/base/);
  });

  it('throws when the file name is missing', () => {
    expect(() => publishedUrl('https://x/', '')).toThrow(/url/);
  });
});

describe('isMain', () => {
  it('is true only for the script node was started with', () => {
    const argv = process.argv;
    try {
      process.argv = [argv[0], '/somewhere/scripts/release/feed.ts'];
      expect(isMain(pathToFileURL('/somewhere/scripts/release/feed.ts').href)).toBe(true);
      expect(isMain(pathToFileURL('/somewhere/scripts/release/other.ts').href)).toBe(false);
      process.argv = [argv[0]];
      expect(isMain(pathToFileURL('/somewhere/scripts/release/feed.ts').href)).toBe(false);
    } finally {
      process.argv = argv;
    }
  });
});
