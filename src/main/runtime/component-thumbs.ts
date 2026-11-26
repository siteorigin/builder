/**
 * Thumbnails of the project's own components for Insert → Your components: each one photographed from its isolated
 * preview (see @shared/component-preview) and kept in the editor's cache, `.siteorigin/cache/thumbs/`, under a key
 * made from everything that changes how it looks (the component and what it places or needs, the site's brand, its
 * language and how thumbnails are drawn), so an unchanged component is never drawn again. The cache is the editor's
 * alone: exports leave `.siteorigin` out. Nothing here depends on Electron, so it is unit tested directly; the
 * photograph itself is taken by main/thumb-capture.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import type { PreparedComponentPreview } from '@shared/component-preview';
import type { ComponentThumb } from '@shared/component-thumbs';
import { siteLanguage } from '@shared/languages';
import { articleRows } from '@shared/articles';
import { entryRow, listsEntries, publishedEntries } from '@shared/entry-feed';
import { getTheme } from '@catalogue/index';
import { codeNeeds, directDependencies } from '@engine/definitions';
import { generateTokensCss } from '@generator/index';
import { atomicWrite } from '../project/fsutil';

/** The folder in the editor's cache (.siteorigin/cache) holding the thumbnails. */
export const THUMBS_DIR = 'thumbs';
/** What a thumbnail shows: the top of the component at desktop width, in the 16:10 shape of the theme's own. */
export const THUMB_VIEW = { width: 1280, height: 800 };
/** The size of a thumbnail's picture, in pixels: twice the larger tile it is shown in. */
export const THUMB_SIZE = { width: 320, height: 200 };
/**
 * Part of every key, so a change to how thumbnails are drawn draws them all again. v4: buttons that change a
 * component's UI state show, as real buttons, with its tabs and disclosures.
 */
const RECIPE = `component-thumb-v4 ${THUMB_VIEW.width}x${THUMB_VIEW.height} ${THUMB_SIZE.width}x${THUMB_SIZE.height} png`;
/** A key: SHA-256, in hex. */
const THUMB_KEY = /^[0-9a-f]{64}$/;
/** The thumbnails a project's cache keeps: older ones beyond this are removed after each new one. */
export const THUMBS_KEPT = 150;
/** A thumbnail file larger than this is not one the editor wrote. */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

const own = <T>(r: Record<string, T>, id: string): T | undefined => (Object.hasOwn(r, id) ? r[id] : undefined);

/**
 * The definitions `definitionId`'s preview shows: itself, then every definition its design places and every
 * component its code needs, and so on down, each once, sorted by ID after the first.
 */
export function shownDefinitions(state: ProjectState, definitionId: string): ComponentDefinition[] {
  const seen = new Set<string>();
  const found: ComponentDefinition[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const def = own(state.components, id);
    if (!def) return;
    found.push(def);
    if (def.kind === 'managed') for (const d of directDependencies(def)) visit(d);
    else for (const other of Object.keys(state.components)) if (codeNeeds(state, def, other)) visit(other);
  };
  visit(definitionId);
  const [first, ...rest] = found;
  return first ? [first, ...rest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))] : [];
}

/**
 * The site's brand as a preview shows it: its theme (and the release of it), the token stylesheet the preview loads
 * from the project (colours, type, spacing and the fonts' faces), the theme's base styles, and what is in the files
 * of the project's own fonts (a font replaced under the same name is a new look).
 */
export function brandFingerprint(state: ProjectState): string {
  const theme = getTheme(state.site.themeId);
  const fonts = Object.values(state.assets.assets)
    .filter((a) => a.kind === 'font')
    .map((a) => [a.id, a.file, a.hash])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash('sha256')
    .update(JSON.stringify([theme.id, theme.digest ?? theme.version ?? '', generateTokensCss(state), theme.baseCss, fonts]))
    .digest('hex');
}

/** Whether a definition shows rows worked out from the site's pages (a list of articles), which its picture then shows too. */
const readsPages = (d: ComponentDefinition) => Object.values(d.properties).some((p) => p.type === 'list' && !!p.feed) || (d.kind === 'code' && /\bso_pages\b/.test(d.source ?? ''));

/**
 * The key of a project component's thumbnail as the project is now, or null when the project has no such
 * component. `brand` is brandFingerprint(state), when already known.
 */
export function thumbKey(state: ProjectState, definitionId: string, brand = brandFingerprint(state)): string | null {
  const defs = shownDefinitions(state, definitionId);
  if (!defs.length) return null;
  const json = JSON.stringify(defs);
  // The images they show, by what is in their files: a replaced file under the same ID is a new picture.
  const assets = Object.values(state.assets.assets)
    .filter((a) => json.includes(JSON.stringify(a.id)))
    .map((a) => [a.id, a.file, a.hash, a.variants ?? []])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // A list of articles shows the articles as they are now: their titles, dates and pictures.
  const rows = defs.some(readsPages) ? articleRows(state, 'articles', undefined) : null;
  // A list of posts shows each collection's published entries as they are now, whichever its placements choose: every
  // one's details, categories and tags, with its picture's file.
  const posts = defs.some(listsEntries)
    ? Object.keys(state.collections ?? {})
        .sort()
        .map((id) => [
          state.collections[id].settings?.taxonomies ?? null,
          publishedEntries(state, state.collections[id]).map((e) => [entryRow(state, state.collections[id], e), e.terms ?? null, e.featuredImage ? (state.assets.assets[e.featuredImage]?.hash ?? null) : null])
        ])
    : null;
  return createHash('sha256')
    .update(JSON.stringify([RECIPE, definitionId, siteLanguage(state.site), brand, json, assets, rows, ...(posts ? [posts] : [])]))
    .digest('hex');
}

/** A box on the preview's page, in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The narrowest frame photographed, in CSS pixels: a small component is shown at its own size, never blown up. */
export const MIN_FRAME_WIDTH = 320;
/** Room left around what a component paints. */
const FRAME_PAD = 16;

const finite = (b: Box | null | undefined): b is Box => !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 1 && b.height >= 1;

/**
 * What to photograph of a component: a 16:10 frame around what it paints (`ink`: its text, media and painted boxes;
 * its whole box, `bounds`, when that is not known), with a little room around it and never narrower than
 * MIN_FRAME_WIDTH. Something taller than the frame shows its top; something shorter is centred in it, with the page's
 * background around it. Inside the page's viewport; null when the component shows nothing there.
 */
export function thumbCrop(bounds: Box | null | undefined, ink?: Box | null, view = THUMB_VIEW): Box | null {
  const shown = finite(ink) ? ink : finite(bounds) ? bounds : null;
  if (!shown) return null;
  // What is on the page, with room around it.
  const x0 = Math.max(0, shown.x - FRAME_PAD);
  const y0 = Math.max(0, shown.y - FRAME_PAD);
  const x1 = Math.min(view.width, shown.x + shown.width + FRAME_PAD);
  const y1 = Math.min(view.height, shown.y + shown.height + FRAME_PAD);
  if (x1 - x0 < 1 || y1 - y0 < 1 || shown.x >= view.width || shown.y >= view.height || shown.x + shown.width <= 0 || shown.y + shown.height <= 0) return null;
  let width = Math.min(view.width, Math.max(MIN_FRAME_WIDTH, x1 - x0));
  let height = (width * 10) / 16;
  if (height > view.height) {
    height = view.height;
    width = (height * 16) / 10;
  }
  // Centred on what is shown across; down, its top, or its middle when it is shorter than the frame.
  const x = Math.min(Math.max(0, (x0 + x1) / 2 - width / 2), view.width - width);
  const y = Math.min(y1 - y0 > height ? y0 : Math.max(0, (y0 + y1) / 2 - height / 2), view.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * The thumbnail folder of the project at `root`, while every folder on the way to it (.siteorigin, cache, thumbs)
 * is a real folder or not there yet; null when one is a link or a file. Nothing is read or written through a link.
 */
async function thumbsFolder(root: string): Promise<string | null> {
  let at = await fs.realpath(root).catch(() => null);
  if (!at) return null;
  for (const segment of ['.siteorigin', 'cache', THUMBS_DIR]) {
    at = join(at, segment);
    const st = await fs.lstat(at).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return null;
  }
  return at;
}

/** A cached thumbnail's picture, or null when there is none (or what is there is not one the editor wrote). */
export async function readThumb(root: string, key: string): Promise<Buffer | null> {
  if (!THUMB_KEY.test(key)) return null;
  const dir = await thumbsFolder(root);
  if (!dir) return null;
  const file = join(dir, `${key}.png`);
  const st = await fs.lstat(file).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_THUMB_BYTES || st.size < 8) return null;
  const bytes = await fs.readFile(file).catch(() => null);
  return bytes && isPng(bytes) ? bytes : null;
}

/** Keep a thumbnail in the project's cache, then remove the oldest beyond THUMBS_KEPT. */
export async function writeThumb(root: string, key: string, png: Buffer, kept = THUMBS_KEPT): Promise<void> {
  if (!THUMB_KEY.test(key) || !isPng(png)) return;
  const dir = await thumbsFolder(root);
  if (!dir) return;
  await atomicWrite(join(dir, `${key}.png`), png, { durable: false });
  await pruneThumbs(dir, kept);
}

/** Remove the oldest thumbnails beyond `kept`. Only the editor's own files are touched. */
async function pruneThumbs(dir: string, kept: number): Promise<void> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^[0-9a-f]{64}\.png$/.test(n));
  if (names.length <= kept) return;
  const dated = await Promise.all(names.map(async (n) => ({ n, st: await fs.lstat(join(dir, n)).catch(() => null) })));
  const files = dated.filter((d) => d.st?.isFile()).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
  await Promise.all(files.slice(kept).map((d) => fs.rm(join(dir, d.n), { force: true }).catch(() => undefined)));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** What a photograph of a prepared preview came to. */
/**
 * What a photograph of a prepared preview came to. A failure is `transient` when it may not be the component's
 * doing (the page did not load, its renderer stopped, it timed out): such a version is tried once more.
 */
export type CaptureResult = { ok: true; png: Buffer } | { ok: false; message: string; transient?: boolean };

/** What the thumbnails need of the editor, given by the controller (and by tests). */
export interface ThumbHost {
  /** The project open now: its opening, its documents, and the folder its cache is in (null: keep nothing on disk). */
  current(): { opening: string; state: ProjectState; cacheRoot: string | null; readRoot: string } | null;
  /** The address of the preview server while it is running and ready to show previews, else null. */
  previewServer(): string | null;
  /** Resolves once the files the preview server shows are those of the project as it is now. */
  settle(): Promise<void>;
  prepare(definitionId: string): Promise<PreparedComponentPreview>;
  release(key: string): void;
  /** Photograph the prepared preview at `path` on the preview server at `server`. */
  capture(server: string, path: string): Promise<CaptureResult>;
  /** Keep a new thumbnail in the project's cache, while the project is still this app's to write. */
  persist(root: string, key: string, png: Buffer): Promise<void>;
}

/** Thumbnails kept in memory for the opening, so a tile shown again never waits on the disk. */
const MEMORY_KEPT = 200;
/** Versions remembered as failed (or as tried once already) for the opening. */
const FAILURES_KEPT = 500;

/** Keep `key` → `value` as the newest of `map`, dropping the oldest beyond `kept`. */
function keep<V>(map: Map<string, V>, key: string, value: V, kept: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > kept) map.delete(map.keys().next().value!);
}

/**
 * Thumbnails of one editor: answered from memory, then the project's cache, else photographed, one at a time, in
 * a queue. A request whose component changed while it waited (or while it was photographed) gets nothing: the editor
 * asks again for the component as it is now.
 */
export class ComponentThumbs {
  private opening: string | null = null;
  private memory = new Map<string, string>();
  /**
   * Versions that could not be pictured, with why. One that failed in a way that may not be its own (`server`: on
   * which preview server) is tried again on another server: a restart may have been what it needed.
   */
  private failed = new Map<string, { message: string; server?: string }>();
  private running = new Map<string, Promise<ComponentThumb>>();
  /** Versions whose photograph failed in a way that may not be theirs, tried once more, by the server it was on. */
  private retried = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  /** How many thumbnails were photographed, for tests. */
  captures = 0;

  constructor(private host: ThumbHost) {}

  /** Forget the thumbnails and failures of an earlier opening. */
  private forOpening(opening: string) {
    if (this.opening === opening) return;
    this.opening = opening;
    this.memory.clear();
    this.failed.clear();
    this.running.clear();
    this.retried.clear();
  }

  /** Forget every thumbnail and failure kept in memory (the project closed): nothing under way may keep one. */
  forget() {
    this.opening = null;
    this.memory.clear();
    this.failed.clear();
    this.running.clear();
    this.retried.clear();
  }

  private remember(key: string, url: string) {
    keep(this.memory, key, url, MEMORY_KEPT);
    this.retried.delete(key);
  }

  /**
   * The thumbnail of a project component in the opening `opening`. `have` is the key of the one the editor shows: when
   * it is still current, the answer leaves out the picture.
   */
  async get(definitionId: unknown, opening: unknown, have?: unknown): Promise<ComponentThumb> {
    const now = this.host.current();
    if (typeof definitionId !== 'string' || typeof opening !== 'string' || !now || now.opening !== opening) return { state: 'unavailable' };
    this.forOpening(opening);
    const def = own(now.state.components, definitionId);
    if (!def || def.owner !== 'project') return { state: 'unavailable' };
    const key = thumbKey(now.state, definitionId);
    if (!key) return { state: 'unavailable' };
    const answer = (url: string): ComponentThumb => (have === key ? { state: 'ready', key } : { state: 'ready', key, url });
    const known = this.memory.get(key);
    if (known) return answer(known);
    const failure = this.failed.get(key);
    if (failure && failure.server !== undefined && failure.server !== this.host.previewServer()) {
      this.failed.delete(key);
      this.retried.delete(key);
    } else if (failure) return { state: 'failed', key, message: failure.message };
    let run = this.running.get(key);
    if (!run) {
      run = this.make(definitionId, opening, key, now.readRoot).finally(() => {
        if (this.running.get(key) === run) this.running.delete(key);
      });
      this.running.set(key, run);
    }
    const got = await run;
    return got.state === 'ready' && got.url ? answer(got.url) : got;
  }

  /** The thumbnail from the project's cache, else a new photograph. */
  private async make(definitionId: string, opening: string, key: string, readRoot: string): Promise<ComponentThumb> {
    const cached = await readThumb(readRoot, key).catch(() => null);
    if (cached) {
      if (this.opening !== opening) return { state: 'unavailable' };
      const url = dataUrl(cached);
      this.remember(key, url);
      return { state: 'ready', key, url };
    }
    const job = this.queue.then(() => this.photograph(definitionId, opening, key));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Whether the project is still the opening, with the component as it was when `key` was made. */
  private still(definitionId: string, opening: string, key: string) {
    const now = this.host.current();
    return !!now && now.opening === opening && this.opening === opening && thumbKey(now.state, definitionId) === key;
  }

  private async photograph(definitionId: string, opening: string, key: string): Promise<ComponentThumb> {
    const gone: ComponentThumb = { state: 'unavailable' };
    const server = this.host.previewServer();
    if (!server || !this.still(definitionId, opening, key)) return gone;
    // The preview loads the site's tokens and base styles from the project's files: they must be the ones written
    // for the project as it is now.
    await this.host.settle();
    // Still the same project, component and preview server: a server that restarted meanwhile could show another.
    const same = () => this.still(definitionId, opening, key) && this.host.previewServer() === server;
    if (!same()) return gone;
    // A failure that may not be the component's own (the preview did not load, timed out, or its files could not be
    // written) is tried once more before it is remembered, and again on another preview server; the component's own
    // (code that throws) is remembered until the component changes.
    const fail = (message: string, transient = false): ComponentThumb => {
      if (transient && this.retried.get(key) !== server) {
        keep(this.retried, key, server, FAILURES_KEPT);
        return gone;
      }
      keep(this.failed, key, { message, ...(transient ? { server } : {}) }, FAILURES_KEPT);
      return { state: 'failed', key, message };
    };
    const prepared = await this.host.prepare(definitionId);
    if (!prepared.ok) return same() ? fail(prepared.message, true) : gone;
    let shot: CaptureResult;
    try {
      // Changed while it was prepared (the project closed, among others): nothing is photographed, and the hidden
      // window is not opened again for it.
      if (!same()) return gone;
      this.captures++;
      shot = await this.host.capture(server, prepared.path);
    } finally {
      this.host.release(prepared.key);
    }
    // Changed while it was photographed (an edit, the brand, another project, the server): the picture may show either.
    if (!same()) return gone;
    if (!shot.ok) return fail(shot.message, !!shot.transient);
    const url = dataUrl(shot.png);
    this.remember(key, url);
    const root = this.host.current()?.cacheRoot;
    if (root) await this.host.persist(root, key, shot.png).catch(() => undefined);
    return { state: 'ready', key, url };
  }
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
