/**
 * The website's PNG icons (issue 584), made from what the generator says they are made from (generator/site-icons.ts):
 * the favicon picture, or the monogram while none is chosen or its file cannot be used. The session publishes them
 * beside the generated text, under the same ownership rules as a theme's font files.
 *
 * Drawing them takes the image library, which the editor's main process never loads: the app registers a renderer
 * that sends the work to a media worker (see assets.ts), and tests and command-line tools register one of their own.
 * Like a picture's responsive copies, icons are an extra: with no renderer, or one that fails, a save still goes
 * ahead, and the icons already in the project stay as they are until they can be made again.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

/** The largest favicon file read: well past the importer's limit, as for any library file read for its contents. */
const MAX_SOURCE = 64 * 1024 * 1024;
const LIBRARY_FILE = /^static\/assets\/[^/\\]+$/;

/**
 * A favicon picture's bytes, or null. The path comes from the documents, which can be edited by hand, so only a
 * regular file directly in static/assets/ is read (as export.ts reads library images). An SVG is cleaned as an
 * import cleans one, since the file may have been replaced outside the app since; one that cannot be is not used.
 */
async function readFavicon(dir: string, a: AssetRecord): Promise<Buffer | null> {
  if (a.kind !== 'image' || !LIBRARY_FILE.test(a.file) || a.file.includes('..')) return null;
  const path = join(dir, a.file);
  try {
    const st = await fs.lstat(path);
    if (!st.isFile() || st.size > MAX_SOURCE) return null;
    const bytes = await fs.readFile(path);
    return a.mime === 'image/svg+xml' ? Buffer.from(sanitizeSvg(bytes)) : bytes;
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

/**
 * Makes and keeps one project's icons. Each set is named by everything it is made from: the bytes of the picture as
 * they are now (never the asset's id or recorded hash, which say nothing of a file replaced in place), the monogram it
 * falls back to, and each icon's size and background. A save that changes none of it draws nothing.
 */
export class SiteIconMaker {
  private made: { key: string; files: Map<string, Buffer> } | null = null;
  private failed: { key: string; at: number } | null = null;

  /** What the icons for `state` are made from, read from the project in `dir` (or a copy of it). */
  async input(dir: string, state: ProjectState): Promise<IconInput> {
    const set = siteIconSet(state);
    const monogram = Buffer.from(set.monogram);
    const favicon = set.source.kind === 'file' && state.site.favicon ? state.assets.assets[state.site.favicon] : undefined;
    // A favicon whose file is missing, or cannot be used, still gives the website its icons: the monogram's.
    const picture = favicon ? await readFavicon(dir, favicon) : null;
    const data = picture ?? monogram;
    const mime = picture ? favicon!.mime : 'image/svg+xml';
    const key = sha(JSON.stringify({ mime, data: sha(data), monogram: sha(monogram), icons: set.icons }));
    return { key, data, mime, monogram: picture ? monogram : null, icons: set.icons };
  }

  /** The key of the set made last, or null before one is. */
  get key(): string | null {
    return this.made?.key ?? null;
  }

  /**
   * The icons for `state`, by project path: the set made last while nothing they are made from changed, or a new one.
   * A picture the decoder refuses (an ICO, a damaged file) gives the monogram's icons. Null when no set can be made
   * now (no renderer, or the worker failing); the same set is then tried again after a while.
   */
  async make(dir: string, state: ProjectState): Promise<{ key: string; files: Map<string, Buffer> | null }> {
    const input = await this.input(dir, state);
    if (this.made?.key === input.key) return this.made;
    if (this.failed?.key === input.key && Date.now() - this.failed.at < RETRY_MS) return { key: input.key, files: null };
    const draw = renderer;
    if (!draw) return { key: input.key, files: null };
    const specs = input.icons.map(({ size, background }) => (background ? { size, background } : { size }));
    let r = await draw(input.data, input.mime, specs).catch((): IconsResult => ({ ok: false, unreadable: false }));
    if (!r.ok && r.unreadable && input.monogram) r = await draw(input.monogram, 'image/svg+xml', specs).catch((): IconsResult => ({ ok: false, unreadable: false }));
    if (!r.ok || r.icons.length !== input.icons.length) {
      this.failed = { key: input.key, at: Date.now() };
      return { key: input.key, files: null };
    }
    const done = r;
    this.failed = null;
    this.made = { key: input.key, files: new Map(input.icons.map((i, n) => [i.path, done.icons[n]])) };
    return this.made;
  }

  /** Forget every set (the project is closing). */
  clear(): void {
    this.made = null;
    this.failed = null;
  }
}
