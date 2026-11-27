/**
 * Writing a review edition (#1133, see shared/review-edition): every selected page of a served review build pictured
 * at every requested width, one at a time, then the pictures and the manifest put in place in the project's private
 * reviews folder in one step, under a name no other edition has had. An edition is never written to again: the
 * folder is claimed new, and nothing in this app opens one for writing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { routeUrl } from '@shared/routes';
import { REVIEW_MANIFEST, REVIEWS_DIR, isReviewEditionId, reviewDigestInput, reviewEditionId, type ReviewCapture, type ReviewCaptureReason, type ReviewEditionManifest, type ReviewPage, type ReviewWidth } from '@shared/review-edition';
import { openRegularFile, readAtMost } from './regular-file';
import { replaceEmptyFolder } from './export';
import type { ReviewShot } from './review-shot';

/** Photographs one page of the served review build at one width. */
export type ShootReview = (url: string, width: number) => Promise<ReviewShot>;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * The digest of a built website: SHA-256 of the list of its files, in byte order of their paths (forward slashes),
 * each with the SHA-256 of its bytes. Only folders and regular files are expected; anything else is refused.
 */
export async function reviewSiteDigest(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) files.push(r);
      else throw new Error(`The review build holds ${r}, which is not a file.`);
    }
  };
  await walk('');
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const listed: Array<[string, string]> = [];
  for (const f of files) listed.push([f, sha256(await fs.readFile(join(dir, ...f.split('/'))))]);
  return sha256(JSON.stringify(listed));
}

export interface ReviewEditionInput {
  /** The project folder the edition belongs to. */
  projectDir: string;
  /** The built review website (Controller.stageReviewBuild), and the address it is served at, ending in its base path and "/". */
  site: string;
  server: string;
  /** The site's name when the edition was made, as its offline sheet is titled. */
  siteName: string;
  basePath: string;
  revision: number;
  pages: ReviewPage[];
  widths: ReviewWidth[];
  shoot: ShootReview;
  /** A private folder to put the edition together in before it is moved into place. */
  work: string;
  /** Calls the capture off: nothing is put in place. */
  signal?: AbortSignal;
  /** The last chance to call it off, by throwing, just before the edition is put in place (the project must still be open). */
  beforeCommit?: () => void;
  /** Runs the quick step that puts the edition in place (holding the project's ownership while it runs). */
  commit?: (publish: () => Promise<void>) => Promise<void>;
  now?: () => Date;
}

/** Picture every page at every width and put the edition in place; returns its manifest and folder. */
export async function writeReviewEdition(input: ReviewEditionInput): Promise<{ manifest: ReviewEditionManifest; dir: string }> {
  const { signal } = input;
  const createdAt = (input.now ?? (() => new Date()))();
  const editionId = reviewEditionId(createdAt, randomBytes(4).toString('hex'));
  const assembled = join(input.work, editionId);
  await fs.mkdir(join(assembled, 'images'), { recursive: true });
  const siteDigest = await reviewSiteDigest(input.site);
  const captures: ReviewCapture[] = [];
  for (const [i, page] of input.pages.entries()) {
    for (const { width } of input.widths) {
      signal?.throwIfAborted();
      const url = new URL(routeUrl(page.route).slice(1), input.server).href;
      const shot: ReviewShot = await input.shoot(url, width).catch((e: unknown) => ({ ok: false as const, reason: 'failed' as const, detail: `The page could not be captured: ${e instanceof Error ? e.message : String(e)}` }));
      signal?.throwIfAborted();
      if (!shot.ok) {
        captures.push({ route: page.route, width, status: 'unavailable', reason: shot.reason, detail: shot.detail });
        continue;
      }
      // By the page's place in the edition and the width: a route can hold any character, a file name cannot.
      const file = `images/${String(i + 1).padStart(3, '0')}-${width}.png`;
      await fs.writeFile(join(assembled, file), shot.png, { flag: 'wx' });
      captures.push({ route: page.route, width, status: 'captured', file, height: shot.height, sha256: sha256(shot.png) });
    }
  }
  const body = { siteDigest, basePath: input.basePath, routes: input.pages.map((p) => ({ ...p })), widths: input.widths.map((w) => ({ ...w })), captures };
  const manifest: ReviewEditionManifest = { editionId, createdAt: createdAt.toISOString(), siteName: input.siteName, revision: input.revision, ...body, contentDigest: sha256(reviewDigestInput(body)) };
  await fs.writeFile(join(assembled, REVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const reviews = await reviewsFolder(input.projectDir, true);
  const dir = join(reviews, editionId);
  // Brought in beside its place first, under a name no edition has (a slow copy from another disk holds nothing up),
  // then put in place in one step: the name claimed new, so no edition is ever replaced.
  const near = join(reviews, `.${editionId}.${randomBytes(4).toString('hex')}.tmp`);
  const last = () => {
    signal?.throwIfAborted();
    input.beforeCommit?.();
  };
  try {
    await fs.rename(assembled, near).catch(() => fs.cp(assembled, near, { recursive: true, errorOnExist: true, force: false }));
    const publish = async () => {
      last();
      await fs.mkdir(dir);
      // Looked at again just before the move, after Windows has let go of the empty folder.
      await replaceEmptyFolder(near, dir, last).catch(async (e: unknown) => {
        await fs.rmdir(dir).catch(() => undefined);
        throw e;
      });
    };
    await (input.commit ? input.commit(publish) : publish());
  } finally {
    await fs.rm(near, { recursive: true, force: true }).catch(() => undefined);
  }
  return { manifest, dir };
}

/**
 * The project's reviews folder, made when `make` says so; a link in its place (to somewhere outside the project) is
 * refused, so an edition is only ever written into the project itself.
 */
async function reviewsFolder(projectDir: string, make: boolean): Promise<string> {
  let at = projectDir;
  for (const part of REVIEWS_DIR.split('/')) {
    at = join(at, part);
    if (make)
      await fs.mkdir(at).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    const st = await fs.lstat(at);
    if (!st.isDirectory()) throw new Error(`${REVIEWS_DIR} in the project is not a folder.`);
  }
  return at;
}

/** The largest manifest read: far more than an edition of the most pages and widths can need. */
const MAX_MANIFEST = 16 * 1024 * 1024;

/** The manifest of edition `id` in the reviews folder, read from its own folder and file (never through a link), if it is whole. */
async function readManifest(reviews: string, id: string): Promise<ReviewEditionManifest | null> {
  if (!isReviewEditionId(id)) return null;
  try {
    if (!(await fs.lstat(join(reviews, id))).isDirectory()) return null;
    const { handle, stat } = await openRegularFile(join(reviews, id, REVIEW_MANIFEST));
    try {
      const bytes = await readAtMost(handle, stat.size, MAX_MANIFEST);
      if (!bytes) return null;
      const m = JSON.parse(bytes.toString('utf8')) as unknown;
      return isManifest(m, id) ? m : null;
    } finally {
      await handle.close();
    }
  } catch {
    // A folder without a readable manifest is not an edition.
    return null;
  }
}

/** The project's review editions, newest first: each folder named as an edition is, with a manifest that names it. */
export async function listReviewEditions(projectDir: string): Promise<ReviewEditionManifest[]> {
  let reviews: string;
  try {
    reviews = await reviewsFolder(projectDir, false);
  } catch {
    return [];
  }
  const out: ReviewEditionManifest[] = [];
  for (const name of await fs.readdir(reviews).catch(() => [] as string[])) {
    const m = await readManifest(reviews, name);
    if (m) out.push(m);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.editionId < b.editionId ? 1 : -1));
}

const REASONS: readonly string[] = ['navigation', 'fonts', 'assets', 'too-tall', 'timeout', 'failed'] satisfies readonly ReviewCaptureReason[];

/** Whether `m` is a whole manifest of the edition `id`: every field there, each capture naming a picture in its folder. */
function isManifest(m: unknown, id: string): m is ReviewEditionManifest {
  const o = m as Partial<ReviewEditionManifest> | null;
  const text = (v: unknown) => typeof v === 'string';
  const hex = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  return (
    !!o &&
    typeof o === 'object' &&
    o.editionId === id &&
    text(o.createdAt) &&
    text(o.siteName) &&
    typeof o.revision === 'number' &&
    text(o.basePath) &&
    hex(o.siteDigest) &&
    hex(o.contentDigest) &&
    Array.isArray(o.routes) &&
    o.routes.every((p) => text(p?.route) && text(p?.title)) &&
    Array.isArray(o.widths) &&
    o.widths.every((w) => text(w?.label) && typeof w?.width === 'number') &&
    Array.isArray(o.captures) &&
    o.captures.length === o.routes.length * o.widths.length &&
    o.captures.every((c, i) => c?.route === o.routes![Math.floor(i / o.widths!.length)].route && c?.width === o.widths![i % o.widths!.length].width) &&
    o.captures.every((c) => text(c?.route) && typeof c?.width === 'number' && (c.status === 'captured' ? text(c.file) && /^images\/\d{3,}-\d+\.png$/.test(c.file) && hex(c.sha256) && typeof c.height === 'number' : c?.status === 'unavailable' && REASONS.includes(c.reason) && text(c.detail)))
  );
}

/** The most picture bytes one offline sheet holds (#1134): the sheet is written whole, and its text is a third larger. */
export const MAX_SHEET_IMAGES = 64 * 1024 * 1024;

/** Reading an edition for its sheet came to: the edition and its pictures, or why it cannot be put in one. */
export type ReadEdition = { ok: true; manifest: ReviewEditionManifest; images: Map<string, Buffer> } | { ok: false; message: string };

/** Whether the project has edition `id`, whole: read without its pictures, as the chooser is about to open. */
export async function hasReviewEdition(projectDir: string, id: string): Promise<boolean> {
  try {
    return !!(await readManifest(await reviewsFolder(projectDir, false), id));
  } catch {
    return false;
  }
}

/**
 * Edition `id` of the project with its pictures (#1134), read for its offline sheet: its manifest and the bytes of each
 * picture it captured, each read from a regular file in the edition's own images folder, never through a link. Every
 * picture must still match the digest the manifest records for it, and the manifest its own content digest: an
 * edition changed since it was made is never put in front of a client as the one they were shown.
 */
export async function readReviewEdition(projectDir: string, id: string, maxBytes = MAX_SHEET_IMAGES): Promise<ReadEdition> {
  const gone: ReadEdition = { ok: false, message: 'That review edition is no longer in this project.' };
  let reviews: string;
  try {
    reviews = await reviewsFolder(projectDir, false);
  } catch {
    return gone;
  }
  const manifest = await readManifest(reviews, id);
  if (!manifest) return gone;
  const changed: ReadEdition = { ok: false, message: 'That review edition has changed or lost pictures since it was captured. Capture the pages again.' };
  if (sha256(reviewDigestInput(manifest)) !== manifest.contentDigest) return changed;
  const images = new Map<string, Buffer>();
  let total = 0;
  try {
    if (!(await fs.lstat(join(reviews, id, 'images'))).isDirectory()) return changed;
    for (const c of manifest.captures) {
      if (c.status !== 'captured' || images.has(c.file)) continue;
      const { handle, stat } = await openRegularFile(join(reviews, id, ...c.file.split('/')));
      let png: Buffer | null;
      try {
        if (total + stat.size > maxBytes) return { ok: false, message: 'That review edition is too large to save as one file. Capture fewer pages, then save that edition.' };
        png = await readAtMost(handle, stat.size, maxBytes - total);
      } finally {
        await handle.close();
      }
      if (!png || sha256(png) !== c.sha256) return changed;
      total += png.length;
      images.set(c.file, png);
    }
  } catch {
    return changed;
  }
  return { ok: true, manifest, images };
}
