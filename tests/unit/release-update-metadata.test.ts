import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { load } from 'js-yaml';
import { embeddedBlockMapSize, generateUpdateMetadata, selectArtifacts, type MetadataPlatform } from '../../scripts/release/generate-update-metadata';
import { metadataProblems } from '../../scripts/release/validate-update-metadata';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'so-release-metadata-'));
  tempDirs.push(dir);
  return dir;
}

/** A release folder holding `artifacts` (name to contents), and a package.json at `version` beside it. */
async function releaseFolder(artifacts: Record<string, string | Buffer>, version = '1.2.3'): Promise<{ releaseDir: string; packagePath: string }> {
  const dir = await tempDir();
  const releaseDir = join(dir, 'release');
  await mkdir(releaseDir);
  const packagePath = join(dir, 'package.json');
  await writeFile(packagePath, JSON.stringify({ version }), 'utf8');
  for (const [name, contents] of Object.entries(artifacts)) await writeFile(join(releaseDir, name), contents);
  return { releaseDir, packagePath };
}

const METADATA_NAME: Record<MetadataPlatform, string> = { mac: 'latest-mac.yml', linux: 'latest-linux.yml', windows: 'latest.yml' };

function generate(platform: MetadataPlatform, folder: { releaseDir: string; packagePath: string }, releaseDate = '2026-01-02T03:04:05.000Z') {
  return generateUpdateMetadata({ platform, releaseDir: folder.releaseDir, metadataPath: join(folder.releaseDir, METADATA_NAME[platform]), packagePath: folder.packagePath, releaseDate });
}

describe('generateUpdateMetadata on Linux', () => {
  it('lists the one AppImage and writes the same metadata it returns', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-2.0.0-linux-x86_64.AppImage': 'appimage' }, '2.0.0');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metadata = await generate('linux', folder);

    const fromFile = load(await readFile(join(folder.releaseDir, 'latest-linux.yml'), 'utf8'));
    expect(fromFile).toEqual(metadata);
    expect(metadata).toMatchObject({ version: '2.0.0', path: 'siteorigin-builder-2.0.0-linux-x86_64.AppImage', releaseDate: '2026-01-02T03:04:05.000Z' });
    expect(metadata.files).toEqual([
      { url: 'siteorigin-builder-2.0.0-linux-x86_64.AppImage', size: 8, sha512: createHash('sha512').update('appimage').digest('base64') }
    ]);
    expect(metadata.sha512).toBe(metadata.files[0].sha512);
  });

  it('leaves a .deb in the release folder out of the feed', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-2.0.0-linux-x86_64.AppImage': 'appimage', 'siteorigin-builder_2.0.0_amd64.deb': 'deb' }, '2.0.0');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metadata = await generate('linux', folder);

    expect(metadata.files.map((file) => file.url)).toEqual(['siteorigin-builder-2.0.0-linux-x86_64.AppImage']);
  });

  it('fails when the release folder has no AppImage', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder_1.2.3_amd64.deb': 'deb' });
    await expect(generate('linux', folder)).rejects.toThrow('Expected exactly 1 Linux AppImage, found 0');
  });

  it('fails when the release folder has more than one AppImage', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-linux-x86_64.AppImage': 'a', 'siteorigin-builder-1.2.2-linux-x86_64.AppImage': 'b' });
    await expect(generate('linux', folder)).rejects.toThrow('Expected exactly 1 Linux AppImage, found 2');
  });

  // electron-updater's AppImageUpdater downloads differentially only when the feed lists `blockMapSize`: it reads the
  // new image's blockmap from `size - (blockMapSize + 4)`. electron-builder embeds that blockmap in the AppImage rather
  // than writing a sidecar, so it has to be read from the image.
  it('lists the blockmap electron-builder embeds in the AppImage', async () => {
    const folder = await releaseFolder({}, '2.0.0');
    const image = join(folder.releaseDir, 'siteorigin-builder-2.0.0-linux-x86_64.AppImage');
    await writeFile(image, randomBytes(256 * 1024));
    const { buildBlockMap } = await import('app-builder-lib/out/targets/blockmap/blockmap.js');
    const built = await buildBlockMap(image, 'deflate');

    const metadata = await generate('linux', folder);

    const entry = metadata.files[0];
    // What electron-builder itself would have written to latest-linux.yml.
    expect(entry).toMatchObject({ size: built.size, sha512: built.sha512 });
    expect(entry.blockMapSize).toBe(built.blockMapSize);
    const bytes = await readFile(image);
    const start = entry.size - (entry.blockMapSize! + 4);
    const blockMap = JSON.parse(inflateRawSync(bytes.subarray(start, entry.size - 4)).toString()) as { files: { sizes: number[] }[] };
    expect(blockMap.files[0].sizes.reduce((sum, n) => sum + n, 0)).toBe(256 * 1024);
  });

  it('lists no blockMapSize, and warns, for an AppImage without an embedded blockmap', async () => {
    // Trailing bytes that read as a plausible length but aren't a blockmap.
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(16, 0);
    const folder = await releaseFolder({ 'siteorigin-builder-2.0.0-linux-x86_64.AppImage': Buffer.concat([randomBytes(64), tail]) }, '2.0.0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metadata = await generate('linux', folder);

    expect(metadata.files[0].blockMapSize).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no embedded blockmap'));
  });

  it('lists no blockMapSize when the trailing stream inflates past the cap', async () => {
    // A well-formed blockmap padded to 80 MB deflates to ~80 KB: small on disk, and only the inflate cap keeps it
    // from being accepted.
    const padded = JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: [], sizes: [] }], pad: 'a'.repeat(80 * 1024 * 1024) });
    const bomb = deflateRawSync(Buffer.from(padded));
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(bomb.length, 0);
    const folder = await releaseFolder({ 'siteorigin-builder-2.0.0-linux-x86_64.AppImage': Buffer.concat([randomBytes(64), bomb, tail]) }, '2.0.0');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metadata = await generate('linux', folder);

    expect(metadata.files[0].blockMapSize).toBeUndefined();
  });

  it('prefers a sidecar .blockmap over reading the AppImage', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-2.0.0-linux-x86_64.AppImage': 'appimage', 'siteorigin-builder-2.0.0-linux-x86_64.AppImage.blockmap': 'sidecar' }, '2.0.0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metadata = await generate('linux', folder);

    expect(metadata.files).toHaveLength(1);
    expect(metadata.files[0].blockMapSize).toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('embeddedBlockMapSize', () => {
  it('is null for a file too short to hold a length, and for a zero length', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'short'), 'abc');
    await writeFile(join(dir, 'zero'), Buffer.concat([randomBytes(32), Buffer.alloc(4)]));
    expect(await embeddedBlockMapSize(join(dir, 'short'))).toBeNull();
    expect(await embeddedBlockMapSize(join(dir, 'zero'))).toBeNull();
  });

  it('is null for a length longer than the file', async () => {
    const dir = await tempDir();
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(1000, 0);
    await writeFile(join(dir, 'image'), Buffer.concat([randomBytes(32), tail]));
    expect(await embeddedBlockMapSize(join(dir, 'image'))).toBeNull();
  });

  it('is the compressed length of a blockmap with sizes and checksums', async () => {
    const dir = await tempDir();
    const compressed = deflateRawSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: ['a'], sizes: [32] }] })));
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(compressed.length, 0);
    await writeFile(join(dir, 'image'), Buffer.concat([randomBytes(32), compressed, tail]));
    expect(await embeddedBlockMapSize(join(dir, 'image'))).toBe(compressed.length);
  });

  it('is null for valid JSON that is not a blockmap', async () => {
    const dir = await tempDir();
    const compressed = deflateRawSync(Buffer.from(JSON.stringify({ files: [{ name: 'file' }] })));
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(compressed.length, 0);
    await writeFile(join(dir, 'image'), Buffer.concat([randomBytes(32), compressed, tail]));
    expect(await embeddedBlockMapSize(join(dir, 'image'))).toBeNull();
  });
});

// electron-updater's MacUpdater keeps the files whose name contains "arm64" on Apple silicon and drops them on Intel,
// then takes the first survivor. Native x64 must come first so Intel Macs select it instead of the larger universal
// zip; arm64 second for Apple silicon; universal last as a fallback.
describe('generateUpdateMetadata on macOS', () => {
  it('ranks the x64 zip first, then arm64, then universal, and leaves the DMG out', async () => {
    const folder = await releaseFolder({
      'siteorigin-builder-1.2.3-mac-arm64.zip': 'arm64',
      'siteorigin-builder-1.2.3-mac-universal.zip': 'universal',
      'siteorigin-builder-1.2.3-mac-x64.zip': 'x64',
      'siteorigin-builder-1.2.3-mac-arm64.dmg': 'dmg'
    });

    const metadata = await generate('mac', folder);

    expect(metadata.path).toBe('siteorigin-builder-1.2.3-mac-x64.zip');
    expect(metadata.files.map((file) => file.url)).toEqual([
      'siteorigin-builder-1.2.3-mac-x64.zip',
      'siteorigin-builder-1.2.3-mac-arm64.zip',
      'siteorigin-builder-1.2.3-mac-universal.zip'
    ]);
    expect(metadata.sha512).toBe(createHash('sha512').update('x64').digest('base64'));
  });

  it('ranks arm64 before universal when no x64 zip is present', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-mac-universal.zip': 'universal', 'siteorigin-builder-1.2.3-mac-arm64.zip': 'arm64' });

    const metadata = await generate('mac', folder);

    expect(metadata.path).toBe('siteorigin-builder-1.2.3-mac-arm64.zip');
    expect(metadata.files.map((file) => file.url)).toEqual(['siteorigin-builder-1.2.3-mac-arm64.zip', 'siteorigin-builder-1.2.3-mac-universal.zip']);
  });

  it('lists the sidecar blockmap size for each zip', async () => {
    const folder = await releaseFolder({
      'siteorigin-builder-1.2.3-mac-x64.zip': 'x64',
      'siteorigin-builder-1.2.3-mac-x64.zip.blockmap': 'x64-blockmap',
      'siteorigin-builder-1.2.3-mac-arm64.zip': 'arm64',
      'siteorigin-builder-1.2.3-mac-arm64.zip.blockmap': 'arm64-blockmap'
    });

    const metadata = await generate('mac', folder);

    expect(metadata.files).toEqual([
      expect.objectContaining({ url: 'siteorigin-builder-1.2.3-mac-x64.zip', blockMapSize: 12 }),
      expect.objectContaining({ url: 'siteorigin-builder-1.2.3-mac-arm64.zip', blockMapSize: 14 })
    ]);
  });

  it('writes metadata the validator accepts', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-mac-arm64.zip': 'arm64', 'siteorigin-builder-1.2.3-mac-x64.zip': 'x64' });

    await generate('mac', folder);

    const metadataPath = join(folder.releaseDir, 'latest-mac.yml');
    expect(metadataProblems(load(await readFile(metadataPath, 'utf8')), metadataPath, '1.2.3')).toEqual([]);
  });

  it('fails when the release folder has no zip, only a DMG', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-mac-arm64.dmg': 'dmg' });
    await expect(generate('mac', folder)).rejects.toThrow('Expected at least 1 macOS .zip installer, found 0');
  });

  it('fails on a zip whose name does not end in -mac-<arch>.zip', async () => {
    for (const name of ['siteorigin-builder-1.2.3-mac.zip', 'siteorigin-builder-1.2.3-arm64-mac.zip', 'siteorigin-builder-1.2.3-mac-ia32.zip']) {
      const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-mac-x64.zip': 'x64', [name]: 'stray' });
      await expect(generate('mac', folder)).rejects.toThrow(`macOS installer name must end in -mac-<x64|arm64|universal>.zip: ${name}`);
    }
  });

  it('fails when two zips are for the same architecture', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-mac-arm64.zip': 'new', 'siteorigin-builder-1.2.2-mac-arm64.zip': 'stale' });
    await expect(generate('mac', folder)).rejects.toThrow('More than one arm64 macOS installer in the release folder');
  });
});

describe('generateUpdateMetadata on Windows', () => {
  it('lists a single installer with its sidecar blockmap and ignores other artifacts', async () => {
    const folder = await releaseFolder({
      'siteorigin-builder-1.2.3-win-x64.exe': 'nsis-installer',
      'siteorigin-builder-1.2.3-win-x64.exe.blockmap': 'blockmap',
      'siteorigin-builder-1.2.3.appx': 'appx'
    });

    // electron-updater on Windows polls `<channel>.yml` (no platform suffix).
    const metadata = await generate('windows', folder);

    const fromFile = load(await readFile(join(folder.releaseDir, 'latest.yml'), 'utf8'));
    expect(fromFile).toEqual(metadata);
    expect(metadata.version).toBe('1.2.3');
    expect(metadata.path).toBe('siteorigin-builder-1.2.3-win-x64.exe');
    expect(metadata.files).toHaveLength(1);
    expect(metadata.files[0]).toMatchObject({ url: 'siteorigin-builder-1.2.3-win-x64.exe', size: 14, blockMapSize: 8 });
  });

  it('lists the x64 installer before the arm64 one', async () => {
    const folder = await releaseFolder({
      'siteorigin-builder-1.2.3-win-arm64.exe': 'arm64',
      'siteorigin-builder-1.2.3-win-arm64.exe.blockmap': 'arm64-blockmap',
      'siteorigin-builder-1.2.3-win-x64.exe': 'x64',
      'siteorigin-builder-1.2.3-win-x64.exe.blockmap': 'x64-blockmap'
    });

    const metadata = await generate('windows', folder);

    // x64 must be first for electron-updater's fallback when no URL contains process.arch.
    expect(metadata.path).toBe('siteorigin-builder-1.2.3-win-x64.exe');
    expect(metadata.files).toEqual([
      expect.objectContaining({ url: 'siteorigin-builder-1.2.3-win-x64.exe', blockMapSize: 12 }),
      expect.objectContaining({ url: 'siteorigin-builder-1.2.3-win-arm64.exe', blockMapSize: 14 })
    ]);
  });

  it('fails when the release folder has no installer', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3.appx': 'appx' });
    await expect(generate('windows', folder)).rejects.toThrow('Expected at least 1 Windows .exe installer, found 0');
  });

  it('fails on an installer whose name does not end in -win-<arch>.exe', async () => {
    for (const name of ['siteorigin-builder-1.2.3-setup.exe', 'siteorigin-builder-1.2.3-x64-setup.exe']) {
      const folder = await releaseFolder({ [name]: 'no-arch' });
      await expect(generate('windows', folder)).rejects.toThrow(`Windows installer name must end in -win-<x64|arm64|universal>.exe: ${name}`);
    }
  });

  it('fails when two installers are for the same architecture', async () => {
    const folder = await releaseFolder({ 'siteorigin-builder-1.2.3-win-x64.exe': 'x64-a', 'siteorigin-builder-0.0.0-win-x64.exe': 'x64-b' });
    await expect(generate('windows', folder)).rejects.toThrow('More than one x64 Windows installer in the release folder');
  });
});

describe('selectArtifacts', () => {
  it('keeps each platform to its own installers', () => {
    const names = [
      'siteorigin-builder-1.2.3-mac-arm64.zip',
      'siteorigin-builder-1.2.3-mac-x64.zip',
      'siteorigin-builder-1.2.3-mac-x64.dmg',
      'siteorigin-builder-1.2.3-win-arm64.exe',
      'siteorigin-builder-1.2.3-win-x64.exe',
      'siteorigin-builder-1.2.3-linux-x86_64.AppImage'
    ];
    expect(selectArtifacts('mac', names)).toEqual(['siteorigin-builder-1.2.3-mac-x64.zip', 'siteorigin-builder-1.2.3-mac-arm64.zip']);
    expect(selectArtifacts('windows', names)).toEqual(['siteorigin-builder-1.2.3-win-x64.exe', 'siteorigin-builder-1.2.3-win-arm64.exe']);
    expect(selectArtifacts('linux', names)).toEqual(['siteorigin-builder-1.2.3-linux-x86_64.AppImage']);
  });

  it('rejects an unknown platform', () => {
    expect(() => selectArtifacts('freebsd' as MetadataPlatform, [])).toThrow('Unsupported platform "freebsd"');
  });
});

describe('metadataProblems', () => {
  const good = {
    version: '1.2.3',
    files: [
      { url: 'siteorigin-builder-1.2.3-mac-x64.zip', sha512: 'aaa', size: 100 },
      { url: 'siteorigin-builder-1.2.3-mac-arm64.zip', sha512: 'bbb', size: 200 }
    ],
    path: 'siteorigin-builder-1.2.3-mac-x64.zip',
    sha512: 'aaa',
    releaseDate: '2026-01-02T03:04:05.000Z'
  };

  it('finds nothing wrong with a publishable file', () => {
    expect(metadataProblems(good, 'release/latest-mac.yml', '1.2.3')).toEqual([]);
  });

  it('rejects something that is not a mapping', () => {
    expect(metadataProblems(null, 'latest.yml', '1.2.3')).toEqual(['not a YAML mapping']);
    expect(metadataProblems('version: 1.2.3', 'latest.yml', '1.2.3')).toEqual(['not a YAML mapping']);
  });

  it("reports a version that isn't package.json's", () => {
    expect(metadataProblems(good, 'latest-mac.yml', '1.2.4')).toEqual(['version mismatch: yml=1.2.3 package.json=1.2.4']);
  });

  it('reports missing or empty files', () => {
    expect(metadataProblems({ ...good, files: [] }, 'latest-mac.yml', '1.2.3')).toEqual(['files[] is missing or empty, so the updater has nothing to download']);
    expect(metadataProblems({ ...good, files: undefined }, 'latest-mac.yml', '1.2.3')).toEqual(['files[] is missing or empty, so the updater has nothing to download']);
  });

  it('reports a file entry without a url, a sha512 or a positive size', () => {
    const files = [
      { sha512: 'aaa', size: 100 },
      { url: 'no-hash.zip', size: 100 },
      { url: 'zero.zip', sha512: 'ccc', size: 0 },
      { url: 'text.zip', sha512: 'ddd', size: '100' },
      { url: 'negative.zip', sha512: 'eee', size: -1 }
    ];
    expect(metadataProblems({ ...good, files }, 'latest-mac.yml', '1.2.3')).toEqual([
      'a file entry has no url',
      'no sha512 for no-hash.zip',
      'missing or invalid size for zero.zip',
      'missing or invalid size for text.zip',
      'missing or invalid size for negative.zip'
    ]);
  });

  it('reports a missing top-level path, sha512 and releaseDate', () => {
    expect(metadataProblems({ version: '1.2.3', files: good.files }, 'latest.yml', '1.2.3')).toEqual([
      'top-level path missing',
      'top-level sha512 missing',
      'releaseDate missing'
    ]);
  });

  // Squirrel.Mac installs only from a zip: a feed pointing at the DMG breaks Mac updates with no error on the client.
  it("rejects a macOS feed whose path isn't a zip", () => {
    const dmg = { ...good, path: 'siteorigin-builder-1.2.3-mac-x64.dmg' };
    expect(metadataProblems(dmg, 'release/latest-mac.yml', '1.2.3')).toEqual([
      "a macOS feed's path must be a zip (Squirrel.Mac requires one), got siteorigin-builder-1.2.3-mac-x64.dmg"
    ]);
    expect(metadataProblems(dmg, 'rc-mac.yml', '1.2.3')).toHaveLength(1);
  });

  it('judges whether a feed is for macOS by its file name, not its folder', () => {
    const linux = { ...good, path: 'siteorigin-builder-1.2.3-linux-x86_64.AppImage' };
    const windows = { ...good, path: 'siteorigin-builder-1.2.3-win-x64.exe' };
    expect(metadataProblems(linux, '/builds/mac-runner/release/latest-linux.yml', '1.2.3')).toEqual([]);
    expect(metadataProblems(windows, 'latest.yml', '1.2.3')).toEqual([]);
  });

  it('reports every problem at once', () => {
    expect(metadataProblems({ version: '0.0.1', files: [] }, 'latest-mac.yml', '1.2.3')).toHaveLength(5);
  });
});

describe('the validate-update-metadata command', () => {
  const script = fileURLToPath(new URL('../../scripts/release/validate-update-metadata.ts', import.meta.url));

  async function run(metadata: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const dir = await tempDir();
    const metadataPath = join(dir, 'latest-mac.yml');
    await writeFile(metadataPath, metadata, 'utf8');
    const result = spawnSync(process.execPath, [script, metadataPath], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("exits 0 for a file at package.json's version and 1 for a macOS feed pointing at a DMG", async () => {
    const { version } = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
    const body = (path: string) =>
      `version: ${version}\nfiles:\n  - url: ${path}\n    sha512: aaa\n    size: 100\npath: ${path}\nsha512: aaa\nreleaseDate: '2026-01-02T03:04:05.000Z'\n`;

    const ok = await run(body('siteorigin-builder-mac-x64.zip'));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('[validate]');

    const bad = await run(body('siteorigin-builder-mac-x64.dmg'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("::error file=");
    expect(bad.stderr).toContain("a macOS feed's path must be a zip");
  });
});
