// Writes the electron-updater metadata for one platform (`latest-mac.yml`, `latest-linux.yml`, `latest.yml`, or the
// rc/beta equivalents) from the installers in a release folder. The release workflows run it after the build, because
// each Mac architecture builds on its own runner and only the assembled set can list both.
//
//   node scripts/release/generate-update-metadata.ts <mac|linux|windows> <metadata-path> [release-dir]
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { dump } from 'js-yaml';
import { isMain } from './feed.ts';

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

export interface FileEntry {
  url: string;
  sha512: string;
  size: number;
  blockMapSize?: number;
}

export interface UpdateMetadata {
  version: string;
  files: FileEntry[];
  path: string;
  sha512: string;
  releaseDate: string;
}

export type MetadataPlatform = 'mac' | 'linux' | 'windows';

async function sha512(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', fail);
    stream.on('end', () => done());
  });
  return hash.digest('base64');
}

// Larger than any real blockmap (a 400 MB AppImage's is well under 1 MB), so a file whose last bytes aren't a length
// can't make this allocate gigabytes.
const MAX_EMBEDDED_BLOCKMAP_BYTES = 64 * 1024 * 1024;

/**
 * electron-builder appends an AppImage's blockmap to the image itself (raw deflate JSON, then its length as a
 * big-endian uint32) instead of writing a .blockmap beside it. electron-updater finds it from the `blockMapSize` this
 * metadata lists; without one, every AppImage update downloads in full.
 */
export async function embeddedBlockMapSize(filePath: string): Promise<number | null> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 4) return null;
    const tail = Buffer.alloc(4);
    await handle.read(tail, 0, 4, size - 4);
    const length = tail.readUInt32BE(0);
    if (length === 0 || length > size - 4 || length > MAX_EMBEDDED_BLOCKMAP_BYTES) return null;
    const data = Buffer.alloc(length);
    const { bytesRead } = await handle.read(data, 0, length, size - 4 - length);
    if (bytesRead !== length) return null;
    // A stream that inflates past the cap isn't a blockmap, and mustn't exhaust the runner's memory finding out.
    const json = inflateRawSync(data, { maxOutputLength: MAX_EMBEDDED_BLOCKMAP_BYTES });
    const blockMap = JSON.parse(json.toString('utf8')) as { files?: { sizes?: unknown; checksums?: unknown }[] };
    const file = Array.isArray(blockMap?.files) ? blockMap.files[0] : undefined;
    return Array.isArray(file?.sizes) && Array.isArray(file?.checksums) ? length : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function artifactEntry(releaseDir: string, fileName: string): Promise<FileEntry> {
  const filePath = join(releaseDir, fileName);
  const entry: FileEntry = { url: fileName, sha512: await sha512(filePath), size: (await stat(filePath)).size };
  try {
    entry.blockMapSize = (await stat(`${filePath}.blockmap`)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (entry.blockMapSize === undefined && fileName.endsWith('.AppImage')) {
    const embedded = await embeddedBlockMapSize(filePath);
    if (embedded === null) console.warn(`::warning::${fileName} has no embedded blockmap, so its updates will download in full`);
    else entry.blockMapSize = embedded;
  }
  return entry;
}

/** The architecture an installer is for, from the `-<os>-<arch>.<ext>` end of its name. */
function archOf(fileName: string, os: string, ext: string): string | null {
  return new RegExp(`-${os}-(x64|arm64|universal)\\.${ext}$`).exec(fileName)?.[1] ?? null;
}

/**
 * One installer per architecture, x64 first. electron-updater's MacUpdater keeps only the files whose name contains
 * "arm64" on Apple silicon and drops them on Intel, then takes the first survivor; on Windows,
 * `Provider.findFile()` takes the file whose URL contains `process.arch`, falling back to the first. Either way x64
 * first is right, and a second file for one architecture is a broken release folder.
 */
function perArch(fileNames: string[], os: string, ext: string, label: string): string[] {
  const candidates = fileNames.filter((f) => f.endsWith(`.${ext}`));
  const order: Record<string, number> = { x64: 0, arm64: 1, universal: 2 };
  const seen = new Set<string>();
  for (const f of candidates) {
    const arch = archOf(f, os, ext);
    if (!arch) throw new Error(`${label} installer name must end in -${os}-<x64|arm64|universal>.${ext}: ${f}`);
    if (seen.has(arch)) throw new Error(`More than one ${arch} ${label} installer in the release folder`);
    seen.add(arch);
  }
  if (!candidates.length) throw new Error(`Expected at least 1 ${label} .${ext} installer, found 0`);
  return candidates.sort((a, b) => order[archOf(a, os, ext)!] - order[archOf(b, os, ext)!]);
}

/** The installers a platform's metadata lists, in the order clients pick from. */
export function selectArtifacts(platform: MetadataPlatform, fileNames: string[]): string[] {
  if (platform === 'linux') {
    const appImages = fileNames.filter((f) => f.endsWith('.AppImage')).sort();
    if (appImages.length !== 1) throw new Error(`Expected exactly 1 Linux AppImage, found ${appImages.length}`);
    return appImages;
  }
  // Squirrel.Mac installs updates from a zip, never the DMG.
  if (platform === 'mac') return perArch(fileNames, 'mac', 'zip', 'macOS');
  if (platform === 'windows') return perArch(fileNames, 'win', 'exe', 'Windows');
  throw new Error(`Unsupported platform "${platform as string}"`);
}

export async function generateUpdateMetadata(options: {
  platform: MetadataPlatform;
  metadataPath: string;
  releaseDir?: string;
  packagePath?: string;
  releaseDate?: string;
}): Promise<UpdateMetadata> {
  const { platform, metadataPath, releaseDir = 'release', packagePath = PACKAGE_JSON, releaseDate = new Date().toISOString() } = options;
  if (!metadataPath) throw new Error('metadataPath is required');
  const { version } = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  const files: FileEntry[] = [];
  for (const fileName of selectArtifacts(platform, await readdir(releaseDir))) files.push(await artifactEntry(releaseDir, fileName));
  const metadata: UpdateMetadata = { version, files, path: files[0].url, sha512: files[0].sha512, releaseDate };
  await writeFile(metadataPath, dump(metadata, { lineWidth: 120 }), 'utf8');
  return metadata;
}

if (isMain(import.meta.url)) {
  const [platform, metadataPath, releaseDir = 'release'] = process.argv.slice(2);
  if (!platform || !metadataPath) {
    console.error('::error::Usage: generate-update-metadata.ts <mac|linux|windows> <metadata-path> [release-dir]');
    process.exit(1);
  }
  try {
    const metadata = await generateUpdateMetadata({ platform: platform as MetadataPlatform, metadataPath, releaseDir });
    console.log(`[metadata] wrote ${metadataPath}: path=${metadata.path}, files=${metadata.files.length}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
