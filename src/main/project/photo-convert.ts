/**
 * Decoding phone photos the image library cannot read. HEIC pictures are compressed with HEVC, which the bundled
 * decoder leaves out, so they are decoded by the operating system's own converter where there is one (sips on
 * macOS) into a lossless intermediate. The media worker then makes the web copy from that file. The author's own
 * file is only ever read.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs a converter command; rejects when it fails or takes longer than `timeoutMs`. */
export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<void>;

/** Converters still running, ended when the app quits, and the private folders their photos are in. */
const running = new Set<ChildProcess>();
const folders = new Set<string>();

const run: RunCommand = (file, args, timeoutMs) =>
  new Promise((done, fail) => {
    const child = execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 }, (err) => {
      running.delete(child);
      if (err) fail(err);
      else done();
    });
    running.add(child);
  });

/**
 * End every converter still running and remove the private copies of the photos being converted (the app is quitting,
 * so the conversions' own clean-up may never run).
 */
export function stopPhotoDecoders(): void {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  folders.clear();
}

/** Decodes a photo the image library cannot, through the platform's own converter. */
export interface PhotoDecoder {
  /**
   * Decode `data` (a HEIC file's bytes) into a TIFF holding its pixels, orientation and colour profile, and hand that
   * file to `use`. The TIFF exists only until `use` settles. Rejects when the converter fails.
   */
  decode<T>(data: Buffer, use: (tiffPath: string) => Promise<T>): Promise<T>;
}

/** Long enough for a 48-megapixel photo on a slow disk; a converter that hangs is ended. */
const DECODE_TIMEOUT_MS = 30_000;

const SIPS = '/usr/bin/sips';

/**
 * The platform's HEIC decoder, or null when it has none. macOS ships sips, which decodes HEIC through ImageIO: its
 * TIFF keeps the stored pixels with their EXIF orientation and the colour profile, so nothing is lost before the web
 * copy is made. sips reads a private copy of the bytes that were checked, so a file replaced meanwhile is never
 * what gets converted.
 */
export function heicDecoder(platform: NodeJS.Platform = process.platform, exec: RunCommand = run): PhotoDecoder | null {
  if (platform !== 'darwin') return null;
  return {
    async decode(data, use) {
      const dir = await fs.mkdtemp(join(tmpdir(), 'siteorigin-photo-'));
      folders.add(dir);
      try {
        const source = join(dir, 'photo.heic');
        const out = join(dir, 'photo.tiff');
        await fs.writeFile(source, data);
        await exec(SIPS, ['-s', 'format', 'tiff', source, '--out', out], DECODE_TIMEOUT_MS);
        return await use(out);
      } finally {
        // Kept on the list until it is gone, so quitting meanwhile still removes it.
        await fs.rm(dir, { recursive: true, force: true }).then(() => folders.delete(dir), () => undefined);
      }
    }
  };
}
