/**
 * The website's drawn icons, the PNG ones (issue 584) and favicon.ico (issue 819), made from what the generator says they are made from (generator/site-icons.ts):
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
import { constants, promises as fs, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AssetRecord, ProjectState } from '@shared/types';
import { DRAWN_ICON_FILES } from '@shared/site-icons';
import { siteIconSet } from '@generator/site-icons';
import type { IconSpec, IconsResult } from './media-client';

/**
 * Draws square PNG icons of a picture, one for each spec, in order. `untrusted` says the picture is a file of the
 * project's, to be cleaned first when it is SVG (the renderer does that, away from the editor). Never rejects.
 */
export type SiteIconRenderer = (data: Buffer, mime: string, icons: IconSpec[], opts?: { untrusted?: boolean }) => Promise<IconsResult>;

let renderer: SiteIconRenderer | null = null;
let remembering: { id: string; records: string } | null = null;

/**
 * Who draws the icons from now on; null leaves them undrawn. With `remember`, the icons it drew for a project are
 * noted in a folder of the app's own (`records`, never inside a project, which anyone could have written), under
 * `id`, which names this build of it on this system: the same input draws the same bytes under one id, so the icons a
 * project holds can stand for a drawing when it is opened again (see ProjectSession's recallSiteIcons). Without it,
 * every set is drawn.
 */
export function setSiteIconRenderer(next: SiteIconRenderer | null, remember: { id: string; records: string } | null = null): void {
  renderer = next;
  remembering = next ? remember : null;
}

/**
 * Where the record of a project's icons is kept, and the renderer id it must name; null when nothing is remembered.
 * The id also names the system's fonts as this process found them: text in an SVG (the monogram's letter) is drawn in
 * whichever installed font it resolves to.
 */
export function siteIconRecord(projectDir: string): { file: string; renderer: string } | null {
  if (!remembering) return null;
  return { file: join(remembering.records, `${createHash('sha256').update(projectDir).digest('hex')}.json`), renderer: `${remembering.id} fonts ${fontsStamp()}` };
}

/** The folders the system's fonts are installed in. */
function fontFolders(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
  if (process.platform === 'win32') return [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local', 'share', 'fonts'), join(home, '.fonts')];
}

let fonts: string | null = null;
/** When each font folder last had a font added or removed, as this process first looked. */
function fontsStamp(): string {
  return (fonts ??= fontFolders()
    .map((d) => {
      try {
        return String(statSync(d).mtimeMs);
      } catch {
        return '-';
      }
    })
    .join(','));
}

/** Project paths of the icons, as the session claims them. */
export const SITE_ICON_PATHS: readonly string[] = DRAWN_ICON_FILES.map((f) => `static/${f}`);

/** How long a set that could not be made waits before it is tried again, so a stuck worker does not slow every save. */
const RETRY_MS = 60_000;
/** How many sets each project keeps: enough that an undo, or a draw finishing after a newer one, draws nothing again. */
const KEEP_SETS = 4;

/**
 * The longest a save waits for its icons while it holds the project's lock (`budgetMs`): far inside the time another
 * app's Unlock waits on a claim that stopped changing. A set still being drawn then is published once it is ready.
 * Tests lengthen it, so a busy machine never makes them depend on that later publication, or shorten it.
 */
export const siteIconTiming = { budgetMs: 2_000 };

/** The largest favicon file read: well past the importer's limit, as for any library file read for its contents. */
const MAX_SOURCE = 64 * 1024 * 1024;
const LIBRARY_FILE = /^static\/assets\/[^/\\]+$/;

/** Which of the pictures a library image can be, apart from SVG, bytes begin as: PNG, JPEG, GIF, WebP or AVIF; else null. */
function rasterType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // The brands of the file-type box, read from its first bytes only, whatever size the box claims.
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return null;
  for (let p = 8; p + 4 <= Math.min(b.readUInt32BE(0), b.length, 64); p += p === 8 ? 8 : 4) if (/^avi[fs]$/.test(b.toString('latin1', p, p + 4))) return 'image/avif';
  return null;
}

/**
 * A favicon picture's bytes and what they are, or null. The path comes from the documents, which can be edited by hand,
 * so only a regular file directly in the project's own static/assets/ is read: not through a linked folder (checked
 * again once the file is open), not a link itself, and not a pipe or device, whose opening could hold up a save
 * indefinitely. The file may have been replaced outside the app since it was imported, whatever its record says, so
 * the decoder is told what its bytes are: SVG markup is drawn only once the renderer has cleaned it as an import
 * cleans one, and anything that is neither SVG nor a picture the library takes is not used.
 */
async function readFavicon(dir: string, a: AssetRecord): Promise<{ data: Buffer; mime: string } | null> {
  if (a.kind !== 'image' || !LIBRARY_FILE.test(a.file) || a.file.includes('..')) return null;
  let bytes: Buffer;
  try {
    const root = await fs.realpath(dir);
    const assets = join(root, 'static', 'assets');
    const ownFolder = async () => (await fs.realpath(join(dir, 'static', 'assets'))) === assets;
    const path = join(assets, basename(a.file));
    if (!(await ownFolder()) || !(await fs.lstat(path)).isFile()) return null;
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_SOURCE) return null;
      const there = await fs.lstat(path);
      if (!(await ownFolder()) || there.dev !== st.dev || there.ino !== st.ino) return null;
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
  return { data: bytes, mime: 'image/svg+xml' };
}

/** What a set of icons is made from now, and the key that names it. */
export interface IconInput {
  key: string;
  data: Buffer;
  mime: string;
  /** A file of the project's rather than the generated monogram. */
  untrusted: boolean;
  /** The monogram's SVG, drawn instead when the favicon picture cannot be decoded; null when the input is the monogram. */
  monogram: Buffer | null;
  icons: Array<{ path: string } & IconSpec>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The icons of one set, by project path, with the number of the drawing that made them; null when there are none yet. */
export interface MadeIcons {
  key: string;
  files: Map<string, Buffer> | null;
  id: number | null;
  /** The monogram's icons, standing in for a picture that could not be decoded (tried again after a while). */
  standIn: boolean;
}

/** One set asked of the renderer, and everyone waiting for it. */
interface Draw {
  input: IconInput;
  done: Promise<void>;
  finish: () => void;
  /** A save stopped waiting for it: it is announced once it is ready. */
  late: boolean;
}

/**
 * Makes and keeps one project's icons. Each set is named by everything it is made from: the bytes of the picture as
 * they are now (never the asset's id or recorded hash, which say nothing of a file replaced in place), the monogram it
 * falls back to, and each icon's size and background. A save that changes none of it draws nothing. One set is drawn
 * at a time; of those asked for meanwhile only the newest waits its turn, so a run of quick changes never piles up
 * work, or pictures, behind a slow one.
 */
export class SiteIconMaker {
  /** The sets made lately, newest last; one made from the monogram instead of the picture is tried again after a while. */
  private made = new Map<string, { files: Map<string, Buffer>; id: number; retryAt?: number }>();
  private failed = new Map<string, number>();
  private active: Draw | null = null;
  private queued: Draw | null = null;
  private drawn = 0;
  private last: string | null = null;

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
    return { key, data, mime, untrusted: !!picture, monogram: picture ? monogram : null, icons: set.icons };
  }

  /** The key of the set made last, or null before one is. */
  get key(): string | null {
    return this.last;
  }

  /** The number of the drawing that made the set kept for `key`, or null when none is kept. */
  madeId(key: string): number | null {
    return this.made.get(key)?.id ?? null;
  }

  /** Whether the set named `key` cannot be made now: nothing to draw it, or a drawing of it failed lately. */
  unmakeable(key: string): boolean {
    return !renderer || this.failed.has(key);
  }

  /** Draw the set named `key` when next asked, even if a drawing of it failed lately. */
  retry(key: string): void {
    this.failed.delete(key);
  }

  /** Whether the set named `key` is being drawn, or waiting to be. */
  drawing(key: string): boolean {
    return this.active?.input.key === key || this.queued?.input.key === key;
  }

  /**
   * The icons for `state`: a set made lately from the same input, or a new one, waited for at most `budgetMs`. A
   * picture the decoder refuses (an ICO, a damaged file) gives the monogram's icons, and is tried again after a while.
   * Null files when no set can be made now (no renderer, or the worker failing, which is tried again after a while) or
   * it is not ready yet.
   */
  async make(dir: string, state: ProjectState, budgetMs = siteIconTiming.budgetMs): Promise<MadeIcons> {
    const input = await this.input(dir, state);
    const kept = (): MadeIcons => {
      const m = this.made.get(input.key);
      return { key: input.key, files: m?.files ?? null, id: m?.id ?? null, standIn: !!m?.retryAt };
    };
    const draw = this.start(input);
    if (!draw) return kept();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An endless budget waits for the drawing itself (a timer cannot wait that long: it would fire at once).
    const done = draw.done.then(() => true);
    const ready = Number.isFinite(budgetMs) ? await Promise.race([done, new Promise<false>((r) => (timer = setTimeout(() => r(false), budgetMs)))]) : await done;
    clearTimeout(timer);
    if (!ready) draw.late = true;
    return kept();
  }

  /**
   * Start drawing the icons for `state` when `make` would, without waiting for them: a publication asks first, so the
   * media worker draws them while the publication generates and checks the website's files, and `make` then finds
   * the drawing under way (or done). `input` is what they are made from, when the caller has just read it. Resolves
   * once the drawing has been asked of the worker.
   */
  async prepare(dir: string, state: ProjectState, input?: IconInput): Promise<void> {
    if (!this.start(input ?? (await this.input(dir, state)))) return;
    // The request reaches the worker in a later turn of the event loop than this one: let it go before the caller's
    // synchronous generation holds the loop.
    await new Promise<void>((r) => setImmediate(r));
  }

  /**
   * Keep `files` as the set made from `key` unless one is kept already: icons the project holds that are known to be
   * that very drawing (see ProjectSession's recallSiteIcons), so nothing is drawn for them.
   */
  adopt(key: string, files: Map<string, Buffer>): void {
    if (this.made.has(key)) return;
    this.made.set(key, { files, id: ++this.drawn });
    for (const k of this.made.keys()) if (this.made.size > KEEP_SETS) this.made.delete(k);
    this.last = key;
  }

  /** The drawing `make` waits for: none when a set made from `input` is kept, or none can be made now. */
  private start(input: IconInput): Draw | null {
    const hit = this.made.get(input.key);
    if (hit && !(hit.retryAt && Date.now() >= hit.retryAt)) return null;
    const failedAt = this.failed.get(input.key);
    if (!renderer || (!hit && failedAt !== undefined && Date.now() - failedAt < RETRY_MS)) return null;
    return this.ask(input);
  }

  /** The drawing for `input`: the one under way or waiting for it, or a new one, which takes the waiting one's place. */
  private ask(input: IconInput): Draw {
    if (this.active?.input.key === input.key) return this.active;
    if (this.queued?.input.key === input.key) return this.queued;
    let finish!: () => void;
    const draw: Draw = { input, done: new Promise<void>((r) => (finish = r)), finish, late: false };
    // An older set still waiting is no longer wanted: those waiting for it are told it is not ready.
    this.queued?.finish();
    this.queued = draw;
    if (!this.active) this.next();
    return draw;
  }

  private next(): void {
    const draw = this.queued;
    this.queued = null;
    this.active = draw;
    if (!draw) return;
    const owner = renderer;
    void (owner ? this.draw(draw.input, owner).catch(() => false) : Promise.resolve(false)).then((made) => {
      this.active = null;
      draw.finish();
      if (made && draw.late) this.onLate?.();
      this.next();
    });
  }

  /** Draws one set, keeping it, or noting that it could not be made. Says whether it was made. */
  private async draw(input: IconInput, draw: SiteIconRenderer): Promise<boolean> {
    const specs = input.icons.map(({ path: _, ...spec }) => spec);
    let r = await draw(input.data, input.mime, specs, { untrusted: input.untrusted }).catch((): IconsResult => ({ ok: false, unreadable: false }));
    const standIn = !r.ok && r.unreadable && !!input.monogram;
    if (standIn) r = await draw(input.monogram!, 'image/svg+xml', specs).catch((): IconsResult => ({ ok: false, unreadable: false }));
    const now = Date.now();
    for (const [k, at] of this.failed) if (now - at >= RETRY_MS) this.failed.delete(k);
    if (!r.ok || r.icons.length !== input.icons.length) {
      this.failed.set(input.key, now);
      // A stand-in already kept waits another while before the picture is tried again.
      const kept = this.made.get(input.key);
      if (kept?.retryAt) kept.retryAt = now + RETRY_MS;
      return false;
    }
    const icons = r.icons;
    this.failed.delete(input.key);
    this.made.delete(input.key);
    this.made.set(input.key, { files: new Map(input.icons.map((i, n) => [i.path, icons[n]])), id: ++this.drawn, ...(standIn ? { retryAt: now + RETRY_MS } : {}) });
    for (const k of this.made.keys()) if (this.made.size > KEEP_SETS) this.made.delete(k);
    this.last = input.key;
    return true;
  }

  /** Forget every set, and announce none still being drawn (the project is closing). */
  clear(): void {
    this.made.clear();
    this.failed.clear();
    this.queued?.finish();
    this.queued = null;
    this.last = null;
    this.onLate = null;
  }
}
