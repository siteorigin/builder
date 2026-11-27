/**
 * Writing a review edition (#1133, see shared/review-edition): every selected page of a served review build pictured
 * at every requested width, one at a time, then the pictures and the manifest put in place in the project's private
 * reviews folder in one step, under a name no other edition has had. An edition is never written to again: the
 * folder is claimed new, and nothing in this app opens one for writing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectState } from '@shared/types';
import { archivePages, archiveWords } from '@shared/archives';
import { siteEntries } from '@shared/collections';
import { routeUrl } from '@shared/routes';
import { REVIEW_MANIFEST, REVIEWS_DIR, isReviewEditionId, reviewDigestInput, reviewEditionId, type ReviewCapture, type ReviewEditionManifest, type ReviewPage, type ReviewWidth } from '@shared/review-edition';
import { publishFolder } from './export';
import type { ReviewShot } from './review-shot';

/** Photographs one page of the served review build at one width. */
export type ShootReview = (url: string, width: number) => Promise<ReviewShot>;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Every page the published site `live` has, with the title the edition names it by: its pages in the site's order,
 * then each collection's entries, then the archive pages listing them. Drafts, old addresses kept working and the
 * not-found page are not pages of the site, and are not offered.
 */
export function reviewPages(live: ProjectState): ReviewPage[] {
  return [
    ...live.site.pageOrder.filter((id) => Object.hasOwn(live.pages, id)).map((id) => ({ route: live.pages[id].route, title: live.pages[id].title })),
    ...siteEntries(live).map((e) => ({ route: e.route, title: e.entry.title })),
    ...archivePages(live).map((a) => ({ route: a.route, title: archiveWords(live, a).name }))
  ];
}

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
  basePath: string;
  revision: number;
  pages: ReviewPage[];
  widths: ReviewWidth[];
  shoot: ShootReview;
  /** A private folder to put the edition together in before it is moved into place. */
  work: string;
  /** Calls the capture off: nothing is put in place. */
  signal?: AbortSignal;
  /** The last chance to call it off, just before the edition is put in place (the project must still be the one open). */
  beforeCommit?: () => Promise<void>;
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
  const manifest: ReviewEditionManifest = { editionId, createdAt: createdAt.toISOString(), revision: input.revision, ...body, contentDigest: sha256(reviewDigestInput(body)) };
  await fs.writeFile(join(assembled, REVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const reviews = await reviewsFolder(input.projectDir, true);
  const dir = join(reviews, editionId);
  await publishFolder(assembled, dir, async () => {
    signal?.throwIfAborted();
    await input.beforeCommit?.();
  }, { move: true });
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
    if (!isReviewEditionId(name)) continue;
    try {
      const m = JSON.parse(await fs.readFile(join(reviews, name, REVIEW_MANIFEST), 'utf8')) as ReviewEditionManifest;
      if (m?.editionId === name) out.push(m);
    } catch {
      // A folder without a readable manifest is not an edition.
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.editionId < b.editionId ? 1 : -1));
}
