import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { CHANNELS, METADATA_SUFFIXES, PLATFORMS, PUBLISH_URL, channelOf, isMain, metadataFilename, publishedUrl } from '../../scripts/release/feed';

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
