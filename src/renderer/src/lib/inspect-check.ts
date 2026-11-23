/** Whether a measured preview load showed the page as it is now. Pure, so the checks are testable. */
import type { ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';

type Outcome = 'loaded' | 'failed' | 'unverified';
interface Source {
  path: string;
  outcome: Outcome;
}
interface Images {
  total: number;
  loaded: number;
  failed: number;
  unverified: number;
  failedFiles?: string[];
  sources?: unknown;
}
interface Report {
  error?: unknown;
  sections?: unknown;
  images?: Images;
  issues?: Array<{ kind?: string; source?: string }>;
}

const sourcesOf = (r: Report | null): Source[] | null => (Array.isArray(r?.images?.sources) ? (r.images.sources as unknown[]).filter((s): s is Source => !!s && typeof (s as Source).path === 'string') : null);
const fileOf = (state: ProjectState, assetId: string) => {
  const asset = Object.hasOwn(state.assets.assets, assetId) ? state.assets.assets[assetId] : undefined;
  return asset ? '/' + asset.file.replace(/^static\//, '') : null;
};
const shows = (sources: Source[], path: string) => sources.some((s) => s.path === path || s.path.endsWith(path));

/** Top-level sections of the page that the measured load did not render. */
export function missingSections(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const page = state?.pages[pageId];
  if (!r || r.error || !Array.isArray(r.sections) || !page) return [];
  const rendered = new Set(r.sections);
  return page.rootIds.filter((id) => !rendered.has(`page:${pageId}|${id}`));
}

/** How many images the measured load could not load (see the bridge's image check). */
export function failedImages(report: unknown): number {
  const r = report as Report | null;
  return !r || r.error || typeof r.images?.failed !== 'number' ? 0 : r.images.failed;
}

/**
 * Image files placed on the page itself (not inside components, whose images can be hidden by a design
 * option) that the measured load did not show: the preview served the page before it caught up with an image
 * change.
 */
export function missingImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const page = state?.pages[pageId];
  const sources = sourcesOf(r);
  if (!r || r.error || !sources || !page || !state) return [];
  const out: string[] = [];
  for (const node of Object.values(page.nodes)) {
    if (node.kind !== 'image' || isBinding(node.image) || !node.image.assetId) continue;
    const path = fileOf(state, node.image.assetId);
    if (path && !shows(sources, path) && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Every library image the page can show: its own content, the shared header and footer, and components. */
function usedImageFiles(state: ProjectState, pageId: string): Set<string> {
  const used = new Set<string>();
  const walk = (v: unknown, depth = 0): void => {
    if (!v || typeof v !== 'object' || depth > 40) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.assetId === 'string') {
      const path = fileOf(state, o.assetId);
      if (path) used.add(path);
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(state.pages[pageId]);
  walk(state.site.shell);
  walk(state.components);
  // Code components can name a library file in their source.
  const code = Object.values(state.components).map((d) => d.source ?? '').join('\n');
  for (const a of Object.values(state.assets.assets)) if (code.includes(a.file.replace(/^static\//, ''))) used.add('/' + a.file.replace(/^static\//, ''));
  return used;
}

/**
 * Library images the measured load showed that the page no longer uses: the preview served the page before it
 * caught up with an image change, so their results describe an image that is not there any more. Files that
 * are not in the library (the site's own static files) are left alone.
 */
export function staleImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const sources = sourcesOf(r);
  if (!r || r.error || !sources || !state?.pages[pageId]) return [];
  const library = new Set(Object.values(state.assets.assets).map((a) => '/' + a.file.replace(/^static\//, '')));
  const used = usedImageFiles(state, pageId);
  const out: string[] = [];
  for (const s of sources) {
    const path = [...library].find((p) => s.path === p || s.path.endsWith(p));
    if (path && !used.has(path) && !out.includes(s.path)) out.push(s.path);
  }
  return out;
}

/**
 * The report with the image results that cannot speak for the page set right: results for `stale` images (the
 * page no longer shows them) are dropped, and each `missing` image (the load never showed it) counts as one that
 * could not be checked.
 */
export function withUnconfirmedImages(report: unknown, missing: string[], stale: string[] = []): unknown {
  const r = report as Report | null;
  if ((!missing.length && !stale.length) || !r || typeof r !== 'object' || !r.images) return report;
  const images = { ...r.images };
  const gone = new Set(stale);
  for (const s of sourcesOf(r) ?? []) {
    if (!gone.has(s.path)) continue;
    images.total--;
    images[s.outcome]--;
  }
  const staleFiles = new Set(stale.map((p) => p.slice(p.lastIndexOf('/') + 1)));
  if (images.failedFiles) images.failedFiles = images.failedFiles.filter((f) => !staleFiles.has(f));
  images.total += missing.length;
  images.unverified += missing.length;
  return {
    ...r,
    images,
    issues: [
      ...(r.issues ?? []).filter((i) => !(i.source && gone.has(i.source))),
      ...missing.map((p) => ({ kind: 'image-unverified', message: `The preview had not caught up with the change to image ${p}, so it could not be checked. This is not a problem with the site.` }))
    ]
  };
}
