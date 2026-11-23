/** Whether a measured preview load showed the page as it is now. Pure, so the checks are testable. */
import type { ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';

interface Report {
  error?: unknown;
  sections?: unknown;
  images?: { failed?: unknown; sources?: unknown };
}

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
 * change, so its image results are about the old image.
 */
export function missingImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const page = state?.pages[pageId];
  const shown = r?.images?.sources;
  if (!r || r.error || !Array.isArray(shown) || !page || !state) return [];
  const out: string[] = [];
  for (const node of Object.values(page.nodes)) {
    if (node.kind !== 'image' || isBinding(node.image) || !node.image.assetId) continue;
    const asset = state.assets.assets[node.image.assetId];
    if (!asset) continue;
    const path = '/' + asset.file.replace(/^static\//, '');
    if (!shown.some((s) => typeof s === 'string' && (s === path || s.endsWith(path))) && !out.includes(path)) out.push(path);
  }
  return out;
}

/** A report whose image results cannot speak for `paths`: each counts as an image that could not be checked. */
export function withUnconfirmedImages(report: unknown, paths: string[]): unknown {
  const r = report as { images?: { total: number; unverified: number }; issues?: unknown[] } | null;
  if (!paths.length || !r || typeof r !== 'object' || !r.images) return report;
  return {
    ...r,
    images: { ...r.images, total: r.images.total + paths.length, unverified: r.images.unverified + paths.length },
    issues: [...paths.map((p) => ({ kind: 'image-unverified', message: `The preview had not caught up with the change to image ${p}, so it could not be checked. This is not a problem with the site.` })), ...(r.issues ?? [])]
  };
}
