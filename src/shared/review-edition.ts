/**
 * A review edition (#1133): an immutable, dated record of what a client was shown. Selected pages of a review build
 * (#1132) are photographed at each requested viewport width, and the pictures are kept in the project's private
 * folder beside a manifest naming the edition, when it was made, the pages and widths, and a digest of everything
 * it holds, so a review round or a sign-off can point at exactly the pages it saw. A page that could not be pictured
 * faithfully (a font that never settled, an image or stylesheet that failed to load) is recorded as unavailable at
 * that width, never kept as a blank or half-drawn picture.
 */
import type { ProjectState } from './types';
import { archivePages, archiveWords } from './archives';
import { siteEntries } from './collections';

/** Where a project keeps its review editions, relative to its folder: private, never exported or built. */
export const REVIEWS_DIR = '.siteorigin/reviews';
/** Each edition's manifest, inside its folder. */
export const REVIEW_MANIFEST = 'manifest.json';

/** A page of the review build that can be captured: its address and the title it had in the build. */
export interface ReviewPage {
  route: string;
  title: string;
}

/** A viewport width to capture at, in CSS pixels, with the name it is shown by ("Desktop", "Phone"). */
export interface ReviewWidth {
  label: string;
  width: number;
}

/** A title as text: a damaged document's title that is not text names nothing (the page is shown by its address). */
const titleText = (t: unknown): string => (typeof t === 'string' ? t : '');

/**
 * Every page the published site `live` has, with the title the edition names it by: its pages in the site's order,
 * then each collection's entries, then the archive pages listing them. Drafts, old addresses kept working and the
 * not-found page are not pages of the site, and are not offered.
 */
export function reviewPages(live: ProjectState): ReviewPage[] {
  return [
    ...live.site.pageOrder.filter((id) => Object.hasOwn(live.pages, id)).map((id) => ({ route: live.pages[id].route, title: titleText(live.pages[id].title) })),
    ...siteEntries(live).map((e) => ({ route: e.route, title: titleText(e.entry.title) })),
    ...archivePages(live).map((a) => ({ route: a.route, title: archiveWords(live, a).name }))
  ];
}

/** Why one page could not be captured at one width. */
export type ReviewCaptureReason = 'navigation' | 'fonts' | 'assets' | 'too-tall' | 'timeout' | 'failed';

/** One page at one width: its picture in the edition's folder, or why there is none. */
export type ReviewCapture =
  | { route: string; width: number; status: 'captured'; file: string; height: number; sha256: string }
  | { route: string; width: number; status: 'unavailable'; reason: ReviewCaptureReason; detail: string };

/** What an edition's manifest.json says. */
export interface ReviewEditionManifest {
  editionId: string;
  /** When the edition was made (ISO 8601, UTC). */
  createdAt: string;
  /** The site's name when the edition was made: what its offline sheet is titled, whatever the site is called since. */
  siteName: string;
  /** The project revision the review build was made from. */
  revision: number;
  /** The site's base path the build was served under ('' at the root). */
  basePath: string;
  /** The pages captured, in the order asked for, with their titles in the build. */
  routes: ReviewPage[];
  /** The widths captured, in the order asked for. */
  widths: ReviewWidth[];
  /** Every page at every width, page by page. */
  captures: ReviewCapture[];
  /** SHA-256 of the built website the pictures were taken of (reviewSiteDigest). */
  siteDigest: string;
  /** SHA-256 of what the edition holds: the site's name and digest, the pages, the widths and every capture (reviewDigestInput). */
  contentDigest: string;
}

/** What capturing an edition came to: the edition kept and where, or why there is none. */
export type ReviewEditionResult = { ok: true; edition: ReviewEditionManifest; path: string; message: string } | { ok: false; message: string; details?: string };

/** What saving an edition's offline sheet (#1134) came to: the file written, or why there is none (no message: the chooser was closed). */
export type ReviewSheetResult = { ok: true; path: string; message: string } | { ok: false; message?: string };

/** The widths captured when none are asked for: a desktop browser and a phone. */
export const DEFAULT_REVIEW_WIDTHS: readonly ReviewWidth[] = [
  { label: 'Desktop', width: 1440 },
  { label: 'Phone', width: 390 }
];
export const MIN_REVIEW_WIDTH = 320;
export const MAX_REVIEW_WIDTH = 2560;
const MAX_LABEL = 64;
const MAX_WIDTHS = 8;

/** The widths asked for, checked and tidied (labels trimmed), or what is wrong with them. Absent means the defaults. */
export function reviewWidths(asked: unknown): ReviewWidth[] | { error: string } {
  if (asked === undefined) return DEFAULT_REVIEW_WIDTHS.map((w) => ({ ...w }));
  if (!Array.isArray(asked) || !asked.length) return { error: 'Choose at least one width to capture.' };
  if (asked.length > MAX_WIDTHS) return { error: `Choose at most ${MAX_WIDTHS} widths to capture.` };
  const out: ReviewWidth[] = [];
  for (const w of asked as Array<Partial<ReviewWidth> | null>) {
    const width = w?.width;
    if (typeof width !== 'number' || !Number.isInteger(width) || width < MIN_REVIEW_WIDTH || width > MAX_REVIEW_WIDTH) return { error: `Each width must be a whole number of pixels from ${MIN_REVIEW_WIDTH} to ${MAX_REVIEW_WIDTH}.` };
    const label = typeof w?.label === 'string' ? w.label.trim() : '';
    if (!label || label.length > MAX_LABEL) return { error: `Each width needs a name of up to ${MAX_LABEL} characters.` };
    if (out.some((o) => o.width === width)) return { error: `${width} px is asked for twice.` };
    out.push({ label, width });
  }
  return out;
}

/** The routes asked for, as a list of distinct addresses, or what is wrong with them. */
export function reviewRoutes(asked: unknown): string[] | { error: string } {
  if (!Array.isArray(asked) || !asked.length) return { error: 'Choose at least one page to capture.' };
  const out: string[] = [];
  for (const r of asked) {
    if (typeof r !== 'string' || !r.startsWith('/')) return { error: 'Each page must be given by its address, such as /about/.' };
    if (out.includes(r)) return { error: `${r} is asked for twice.` };
    out.push(r);
  }
  return out;
}

/**
 * The pages asked for, each with its title, from the pages the build has; or the first address the build has no
 * page at (a draft, an old address kept working, the not-found page, a file of the site's own).
 */
export function pickReviewPages(available: readonly ReviewPage[], routes: readonly string[]): ReviewPage[] | { error: string } {
  const out: ReviewPage[] = [];
  for (const route of routes) {
    const page = available.find((p) => p.route === route);
    if (!page) return { error: `The website has no page at ${route} to capture.` };
    out.push({ route: page.route, title: page.title });
  }
  return out;
}

/** What the content digest is taken of, in a fixed order with nothing that differs between two runs of the same capture. */
export function reviewDigestInput(m: Pick<ReviewEditionManifest, 'siteName' | 'siteDigest' | 'basePath' | 'routes' | 'widths' | 'captures'>): string {
  return JSON.stringify([
    'siteorigin-review-edition',
    m.siteName,
    m.siteDigest,
    m.basePath,
    m.routes.map((p) => [p.route, p.title]),
    m.widths.map((w) => [w.width, w.label]),
    m.captures.map((c) => (c.status === 'captured' ? [c.route, c.width, c.status, c.height, c.file, c.sha256] : [c.route, c.width, c.status, c.reason]))
  ]);
}

/** An edition's ID: when it was made (UTC, to the second, safe in a file name) and a random suffix. */
export function reviewEditionId(createdAt: Date, suffix: string): string {
  return `${createdAt.toISOString().slice(0, 19).replace(/:/g, '-')}Z-${suffix}`;
}

/** Whether `name` could be an edition's folder (reviewEditionId), so nothing else in the reviews folder is read as one. */
export const isReviewEditionId = (name: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}$/.test(name);
