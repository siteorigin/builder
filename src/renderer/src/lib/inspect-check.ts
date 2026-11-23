/** Whether a measured preview load showed the page as it is now. Pure, so the checks are testable. */
import type { ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';

interface Report {
  error?: unknown;
  sections?: unknown;
  images?: { failed?: unknown; sources?: unknown };
}

/** The bridge lists at most this many image addresses; a longer page cannot be compared image by image. */
const MAX_SOURCES = 200;

/** The address each image on the measured load was given, or null when the load cannot be compared. */
function sourcesOf(r: Report | null): string[] | null {
  const list = r && !r.error && Array.isArray(r.images?.sources) ? (r.images.sources as unknown[]).filter((s): s is string => typeof s === 'string') : null;
  return list && list.length < MAX_SOURCES ? list : null;
}
const fileOf = (state: ProjectState, assetId: string) => {
  const asset = Object.hasOwn(state.assets.assets, assetId) ? state.assets.assets[assetId] : undefined;
  return asset ? '/' + asset.file.replace(/^static\//, '') : null;
};
const shows = (sources: string[], path: string) => sources.some((s) => s === path || s.endsWith(path));

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
  if (!sources || !page || !state) return [];
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
 * caught up with an image change. Files that are not in the library (the site's own static files) are left alone.
 */
export function staleImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const sources = sourcesOf(r);
  if (!sources || !state?.pages[pageId]) return [];
  const library = new Set(Object.values(state.assets.assets).map((a) => '/' + a.file.replace(/^static\//, '')));
  const used = usedImageFiles(state, pageId);
  const out: string[] = [];
  for (const s of sources) {
    const path = [...library].find((p) => s === p || s.endsWith(p));
    if (path && !used.has(path) && !out.includes(s)) out.push(s);
  }
  return out;
}
