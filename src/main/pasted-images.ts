/**
 * Images pasted into the AI Chat composer with no file of their own, such as a screenshot on the clipboard (#1410).
 * Each paste's pictures are written to a private folder of their own in the system's temporary folder, so the verified
 * importer reads them as it reads dropped files (review included). The folder goes once the import is done with it,
 * and every one left goes when the editor's page is replaced or gone (it can release none) and when the app quits.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** The pictures a paste can carry, by type, with the extension the importer knows each one by. */
export const PASTED_IMAGE_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
/** The most pictures one paste writes: a message carries at most four, so more is never asked for. */
export const MAX_PASTED_IMAGES = 4;
/** The largest picture written: the largest photo the importer reads (it stores a web-sized copy of a big one). */
export const MAX_PASTED_BYTES = 64 * 1024 * 1024;
/** The most pastes written and not yet released: more is a renderer that never releases them. */
export const MAX_PASTED_BATCHES = 8;

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

/** One paste's folder: none until it is made, and how many imports are reading it. */
interface Batch {
  dir: string | null;
  reading: number;
  /** Released while still being made or read: removed as soon as neither is going on. */
  released: boolean;
}

export class PastedImages {
  /** Each paste, by the batch ID the renderer releases it with: counted from the moment it is asked for. */
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly root: () => string = tmpdir) {}

  /** Write one paste's pictures, named as Assets will list them. */
  async stage(files: unknown): Promise<StageResult> {
    const read = readPasted(files);
    if (typeof read === 'string') return { ok: false, message: read };
    if (this.batches.size >= MAX_PASTED_BATCHES) return { ok: false, message: 'Too many pasted images are still being added. Paste again once they show under your message.' };
    // Held before anything is awaited, so the cap counts it and a release meanwhile removes what it goes on to make.
    const batch = randomUUID();
    const entry: Batch = { dir: null, reading: 1, released: false };
    this.batches.set(batch, entry);
    try {
      entry.dir = await mkdtemp(join(this.root(), 'siteorigin-paste-'));
      const dir = entry.dir;
      const paths = read.map((f, i) => join(dir, `Pasted image${read.length > 1 ? ` ${i + 1}` : ''}.${PASTED_IMAGE_TYPES[f.type]}`));
      await Promise.all(read.map((f, i) => writeFile(paths[i], f.bytes, { mode: 0o600 })));
      if (entry.released) return { ok: false, message: 'The pasted image could not be added: the editor was reloaded.' };
      return { ok: true, batch, paths };
    } catch (e) {
      entry.released = true;
      return { ok: false, message: `The pasted image could not be added: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      entry.reading--;
      await this.settle(batch, entry);
    }
  }

  /**
   * Run an import of `paths`, keeping any pasted folder they are in until it is done: a release meanwhile (the editor
   * reloaded, say) waits for the import to have read its pictures.
   */
  async reading<T>(paths: readonly string[] | undefined, run: () => Promise<T>): Promise<T> {
    const held = [...this.batches].filter(([, b]) => b.dir && (paths ?? []).some((p) => p.startsWith(b.dir + sep)));
    for (const [, b] of held) b.reading++;
    try {
      return await run();
    } finally {
      for (const [id, b] of held) {
        b.reading--;
        await this.settle(id, b);
      }
    }
  }

  /** Remove one paste's folder, once its import is done with it. An unknown batch is nothing to remove. */
  async release(batch: unknown): Promise<void> {
    if (typeof batch !== 'string') return;
    const entry = this.batches.get(batch);
    if (!entry) return;
    entry.released = true;
    await this.settle(batch, entry);
  }

  /** Release every paste: the editor that would release them is gone. A folder still being made or read goes once it
   *  is not. */
  releaseAll(): void {
    for (const [id, entry] of [...this.batches]) {
      entry.released = true;
      void this.settle(id, entry);
    }
  }

  /** Remove every paste's folder still here, at once, whatever is reading it: the app is quitting and waits for nothing. */
  removeAll(): void {
    for (const entry of this.batches.values()) {
      entry.released = true;
      if (!entry.dir) continue;
      try {
        rmSync(entry.dir, { recursive: true, force: true });
      } catch {
        // The system's temporary folder is cleared in time anyway.
      }
    }
    this.batches.clear();
  }

  /** A released paste no longer being made or read is removed. */
  private async settle(batch: string, entry: Batch): Promise<void> {
    if (!entry.released || entry.reading > 0 || this.batches.get(batch) !== entry) return;
    this.batches.delete(batch);
    if (entry.dir) await rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
