/**
 * The website's PNG icons (issue 584), made from what the generator says they are made from (generator/site-icons.ts):
 * the favicon picture, or the monogram while none is chosen or its file cannot be used. The session publishes them
 * beside the generated text, under the same ownership rules as a theme's font files.
 *
 * Drawing them takes the image library, which the editor's main process never loads: the app registers a renderer
 * that sends the work to a media worker (see assets.ts), and tests and command-line tools register one of their own.
 * Like a picture's responsive copies, icons are an extra: with no renderer, or one that fails, a save still goes
 * ahead, and the icons already in the project stay as they are until they can be made again. Nor does a save wait
 * long for them while it holds the project's lock: a set that takes longer is published once it is ready.
 */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AssetRecord, ProjectState } from '@shared/types';
import { APP_ICONS } from '@shared/site-icons';
import { siteIconSet } from '@generator/site-icons';
import type { IconSpec, IconsResult } from './media-client';
import { sanitizeSvg } from './svg';

/** Draws square PNG icons of a picture, one for each spec, in order. Never rejects. */
export type SiteIconRenderer = (data: Buffer, mime: string, icons: IconSpec[]) => Promise<IconsResult>;

let renderer: SiteIconRenderer | null = null;

/** Who draws the icons from now on; null leaves them undrawn. */
export function setSiteIconRenderer(next: SiteIconRenderer | null): void {
  renderer = next;
}

/** Project paths of the icons, as the session claims them. */
export const SITE_ICON_PATHS: readonly string[] = APP_ICONS.map((i) => `static/${i.file}`);

/** How long a set that could not be made waits before it is tried again, so a stuck worker does not slow every save. */
const RETRY_MS = 60_000;

/**
 * The longest a save waits for its icons while it holds the project's lock: far inside the time another app's Unlock
 * waits on a claim that stopped changing. A set still being drawn then is published on its own once it is ready.
 */
export const SITE_ICON_BUDGET_MS = 2_000;

/** The largest favicon file read: well past the importer's limit, as for any library file read for its contents. */
const MAX_SOURCE = 64 * 1024 * 1024;
const LIBRARY_FILE = /^static\/assets\/[^/\\]+$/;

/** Which of the pictures a library image can be, apart from SVG, bytes begin as: PNG, JPEG, GIF, WebP or AVIF; else null. */
function rasterType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' ? 'image/avif' : null;
}

/**
 * A favicon picture's bytes and what they are, or null. The path comes from the documents, which can be edited by hand,
 * so only a regular file directly in the project's own static/assets/ is read (not through a linked folder, and not a
 * link itself). The file may have been replaced outside the app since it was imported, whatever its record says: SVG
 * content is cleaned as an import cleans it, and anything that is neither SVG nor a picture the library takes is not
 * used. The decoder looks at the bytes, never the record's type.
 */
async function readFavicon(dir: string, a: AssetRecord): Promise<{ data: Buffer; mime: string } | null> {
  if (a.kind !== 'image' || !LIBRARY_FILE.test(a.file) || a.file.includes('..')) return null;
  let bytes: Buffer;
  try {
    const root = await fs.realpath(dir);
    if ((await fs.realpath(join(dir, 'static', 'assets'))) !== join(root, 'static', 'assets')) return null;
    const handle = await fs.open(join(dir, a.file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_SOURCE) return null;
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const raster = rasterType(bytes);
  if (raster) return { data: bytes, mime: raster };
  // Neither a picture nor (compressed or otherwise) anything but plain SVG markup is given to the decoder.
  if (a.mime !== 'image/svg+xml' && !/^\s*</.test(bytes.toString('utf8', 0, Math.min(bytes.length, 256)).replace(/^﻿/, ''))) return null;
  try {
    return { data: Buffer.from(sanitizeSvg(bytes)), mime: 'image/svg+xml' };
  } catch {
    return null;
  }
}

/** What a set of icons is made from now, and the key that names it. */
interface IconInput {
  key: string;
  data: Buffer;
  mime: string;
  /** The monogram's SVG, drawn instead when the favicon picture cannot be decoded; null when the input is the monogram. */
  monogram: Buffer | null;
  icons: Array<{ path: string } & IconSpec>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The icons of one set, by project path, or null when none could be made for it. */
export interface MadeIcons {
  key: string;
  files: Map<string, Buffer> | null;
}

/**
 * Makes and keeps one project's icons. Each set is named by everything it is made from: the bytes of the picture as
 * they are now (never the asset's id or recorded hash, which say nothing of a file replaced in place), the monogram it
 * falls back to, and each icon's size and background. A save that changes none of it draws nothing.
 */
export class SiteIconMaker {
  private made: { key: string; files: Map<string, Buffer> } | null = null;
  private failed: { key: string; at: number } | null = null;
  /** The set being drawn, and whether a save stopped waiting for it (it is then announced once it is ready). */
  private drawing: { key: string; done: Promise<void>; late: boolean } | null = null;

  /** `onLate` is told when a set a save stopped waiting for is ready, so it can be published. */
  constructor(private onLate: (() => void) | null = null) {}

  /** What the icons for `state` are made from, read from the project in `dir` (or a copy of it). */
  async input(dir: string, state: ProjectState): Promise<IconInput> {
    const set = siteIconSet(state);
    const monogram = Buffer.from(set.monogram);
    const favicon = set.source.kind === 'file' && state.site.favicon ? state.assets.assets[state.site.favicon] : undefined;
    // A favicon whose file is missing, or cannot be used, still gives the website its icons: the monogram's.
    const picture = favicon ? await readFavicon(dir, favicon) : null;
    const data = picture?.data ?? monogram;
    const mime = picture?.mime ?? 'image/svg+xml';
    const key = sha(JSON.stringify({ mime, data: sha(data), monogram: sha(monogram), icons: set.icons }));
    return { key, data, mime, monogram: picture ? monogram : null, icons: set.icons };
  }

  /** The key of the set made last, or null before one is. */
  get key(): string | null {
    return this.made?.key ?? null;
  }

  /**
   * The icons for `state`: the set made last while nothing they are made from changed, or a new one, waited for at most
   * `budgetMs`. A picture the decoder refuses (an ICO, a damaged file) gives the monogram's icons. Null files when no
   * set can be made now (no renderer, the worker failing, which is tried again after a while) or it is not ready yet.
   */
  async make(dir: string, state: ProjectState, budgetMs = SITE_ICON_BUDGET_MS): Promise<MadeIcons> {
    const input = await this.input(dir, state);
    if (this.made?.key === input.key) return this.made;
    if (this.failed?.key === input.key && Date.now() - this.failed.at < RETRY_MS) return { key: input.key, files: null };
    if (!renderer) return { key: input.key, files: null };
    if (this.drawing?.key !== input.key) this.drawing = { key: input.key, done: this.draw(input, renderer), late: false };
    const drawing = this.drawing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An endless budget waits for the drawing itself (a timer cannot wait that long: it would fire at once).
    const ready = Number.isFinite(budgetMs) ? await Promise.race([drawing.done.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), budgetMs)))]) : await drawing.done.then(() => true);
    clearTimeout(timer);
    if (!ready) drawing.late = true;
    return this.made?.key === input.key ? this.made : { key: input.key, files: null };
  }

  private async draw(input: IconInput, draw: SiteIconRenderer): Promise<void> {
    const specs = input.icons.map(({ size, background }) => (background ? { size, background } : { size }));
    let r = await draw(input.data, input.mime, specs).catch((): IconsResult => ({ ok: false, unreadable: false }));
    if (!r.ok && r.unreadable && input.monogram) r = await draw(input.monogram, 'image/svg+xml', specs).catch((): IconsResult => ({ ok: false, unreadable: false }));
    const current = this.drawing?.key === input.key ? this.drawing : null;
    // A set for something the icons are no longer made from is of no use.
    if (!current) return;
    this.drawing = null;
    if (!r.ok || r.icons.length !== input.icons.length) {
      this.failed = { key: input.key, at: Date.now() };
      return;
    }
    const done = r;
    this.failed = null;
    this.made = { key: input.key, files: new Map(input.icons.map((i, n) => [i.path, done.icons[n]])) };
    if (current.late) this.onLate?.();
  }

  /** Forget every set, and announce none still being drawn (the project is closing). */
  clear(): void {
    this.made = null;
    this.failed = null;
    this.drawing = null;
    this.onLate = null;
  }
}
