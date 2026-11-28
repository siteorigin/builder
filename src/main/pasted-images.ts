/**
 * Images pasted into the AI Chat composer with no file of their own, such as a screenshot on the clipboard (#1410).
 * Each paste's pictures are written to a private folder of their own in the system's temporary folder, so the verified
 * importer reads them as it reads dropped files (review included). The folder goes once the import is done with it,
 * and every one left goes when the app quits.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The pictures a paste can carry, by type, with the extension the importer knows each one by. */
export const PASTED_IMAGE_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
/** The most pictures one paste writes: a message carries at most four, so more is never asked for. */
export const MAX_PASTED_IMAGES = 4;
/** The largest picture written: the largest photo the importer reads (it stores a web-sized copy of a big one). */
export const MAX_PASTED_BYTES = 64 * 1024 * 1024;

export interface PastedImage {
  type: string;
  bytes: Uint8Array;
}

export type StageResult = { ok: true; batch: string; paths: string[] } | { ok: false; message: string };

/** One paste's pictures as sent over IPC: anything else is refused before a file is written. */
export function readPasted(files: unknown): PastedImage[] | string {
  if (!Array.isArray(files) || !files.length) return 'There was no image to paste.';
  if (files.length > MAX_PASTED_IMAGES) return `A message carries at most ${MAX_PASTED_IMAGES} images. Paste fewer at once.`;
  const out: PastedImage[] = [];
  for (const f of files as unknown[]) {
    const o = f as { type?: unknown; bytes?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.type !== 'string' || !(o.bytes instanceof Uint8Array)) return 'The pasted image could not be read.';
    if (!Object.hasOwn(PASTED_IMAGE_TYPES, o.type)) return 'Only PNG, JPEG, GIF, WebP and AVIF images can be pasted.';
    if (!o.bytes.byteLength) return 'The pasted image is empty.';
    if (o.bytes.byteLength > MAX_PASTED_BYTES) return `The pasted image is larger than ${MAX_PASTED_BYTES / 1024 / 1024} MB.`;
    out.push({ type: o.type, bytes: o.bytes });
  }
  return out;
}

export class PastedImages {
  /** Each paste's folder, by the batch ID the renderer releases it with. */
  private readonly batches = new Map<string, string>();

  constructor(private readonly root: () => string = tmpdir) {}

  /** Write one paste's pictures, named as Assets will list them. */
  async stage(files: unknown): Promise<StageResult> {
    const read = readPasted(files);
    if (typeof read === 'string') return { ok: false, message: read };
    const dir = await mkdtemp(join(this.root(), 'siteorigin-paste-'));
    const batch = randomUUID();
    this.batches.set(batch, dir);
    try {
      const paths = read.map((f, i) => join(dir, `Pasted image${read.length > 1 ? ` ${i + 1}` : ''}.${PASTED_IMAGE_TYPES[f.type]}`));
      await Promise.all(read.map((f, i) => writeFile(paths[i], f.bytes, { mode: 0o600 })));
      return { ok: true, batch, paths };
    } catch (e) {
      await this.release(batch);
      return { ok: false, message: `The pasted image could not be added: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Remove one paste's folder, once its import is done with it. An unknown batch is nothing to remove. */
  async release(batch: unknown): Promise<void> {
    if (typeof batch !== 'string') return;
    const dir = this.batches.get(batch);
    if (!dir) return;
    this.batches.delete(batch);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Remove every paste's folder still here, at once: the app is quitting, and waits for nothing. */
  releaseAll(): void {
    for (const dir of this.batches.values()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The system's temporary folder is cleared in time anyway.
      }
    }
    this.batches.clear();
  }
}
