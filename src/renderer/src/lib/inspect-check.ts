/** Whether a measured preview load showed the page as it is now. Pure, so the checks are testable. */
import type { ProjectState } from '@shared/types';
import { isBinding, slotChildren } from '@shared/types';
import { partsShown } from '@shared/page-shell';
import type { InspectionDesc, InspectionIssue, InspectionRef } from '@shared/inspection';
import { inspectionRef } from './model';

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
 * The image nodes a page renders for certain: those under its sections' plain elements, and those placed in a
 * slot that a component built in the editor really shows. (A code component, or a slot with no place in its
 * component, may not show what is put in it.)
 */
function renderedImageNodes(state: ProjectState, pageId: string) {
  const page = state.pages[pageId];
  const out: Array<{ assetId: string }> = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const node = Object.hasOwn(page.nodes, id) ? page.nodes[id] : undefined;
    if (!node || seen.has(id)) return;
    seen.add(id);
    if (node.kind === 'image') {
      if (!isBinding(node.image) && node.image.assetId) out.push({ assetId: node.image.assetId });
    } else if (node.kind === 'element' || node.kind === 'repeat') node.children.forEach(visit);
    else if (node.kind === 'instance') {
      const def = state.components[node.definitionId];
      if (def?.kind !== 'managed' || !def.tree) return;
      const outlets = new Set(Object.values(def.tree.nodes).flatMap((n) => (n.kind === 'slot' ? [n.slot] : [])));
      for (const slot of Object.keys(node.slots ?? {})) if (outlets.has(slot)) slotChildren(node, slot).forEach(visit);
    }
  };
  page.rootIds.forEach(visit);
  return out;
}

/**
 * Library images the page renders for certain that the measured load did not show: the preview served the page
 * before it caught up with an image change. Images inside components are left out: a design option can hide them.
 */
export function missingImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const sources = sourcesOf(r);
  if (!sources || !state?.pages[pageId]) return [];
  const out: string[] = [];
  for (const { assetId } of renderedImageNodes(state, pageId)) {
    const path = fileOf(state, assetId);
    if (path && !sources.includes(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Library images anywhere in the project: chosen for an image ({ assetId }), or named in any text, property or
 * code (a code component can show a library file by its address).
 */
function usedImageFiles(state: ProjectState): Set<string> {
  const used = new Set<string>();
  const text: string[] = [];
  const walk = (v: unknown, depth = 0): void => {
    if (typeof v === 'string') return void text.push(v);
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.assetId === 'string') {
      const path = fileOf(state, o.assetId);
      if (path) used.add(path);
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(state.pages);
  walk(state.site);
  walk(state.components);
  const all = text.join('\n');
  for (const a of Object.values(state.assets.assets)) {
    const path = '/' + a.file.replace(/^static\//, '');
    if (all.includes(path.slice(1))) used.add(path);
  }
  return used;
}

/**
 * Whether code written for this project renders on the page (in its sections or the shared header and footer).
 * Theme code components show library images only through their properties, which are read above.
 */
function showsCode(state: ProjectState, pageId: string): boolean {
  const trees = [state.pages[pageId], ...partsShown(state.pages[pageId]).map((part) => state.site.shell[part])];
  return trees.some((t) =>
    Object.values(t.nodes).some((n) => {
      const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
      return def?.kind === 'code' && def.owner === 'project';
    })
  );
}

/**
 * Library images the measured load showed that nothing in the project uses any more: the preview served the
 * page before it caught up with an image change. Files outside the library (the site's own static files) are
 * left alone, and so is a page showing a project's own code component, which can build an image address in ways
 * this cannot follow.
 */
export function staleImages(state: ProjectState | undefined, pageId: string, report: unknown): string[] {
  const r = report as Report | null;
  const sources = sourcesOf(r);
  if (!sources || !state?.pages[pageId] || showsCode(state, pageId)) return [];
  const library = new Set(Object.values(state.assets.assets).map((a) => '/' + a.file.replace(/^static\//, '')));
  const used = usedImageFiles(state);
  const out: string[] = [];
  for (const s of sources) if (library.has(s) && !used.has(s) && !out.includes(s)) out.push(s);
  return out;
}

/**
 * Name every finding by the element to change (`ref`, see inspectionRef) in place of the preview's raw address
 * (`desc`), which the assistant cannot act on. A finding whose address names nothing in the project keeps no
 * reference rather than a made-up one.
 */
export function attributeFindings(state: ProjectState | undefined, report: unknown): void {
  const r = report as { issues?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.issues)) return;
  const resolve = (holder: { desc?: InspectionDesc; ref?: InspectionRef }) => {
    if (!holder.desc) return;
    const ref = state ? inspectionRef(state, holder.desc) : null;
    delete holder.desc;
    if (ref) holder.ref = ref;
  };
  for (const issue of r.issues as InspectionIssue[]) {
    if (!issue || typeof issue !== 'object') continue;
    resolve(issue);
    if (issue.with && typeof issue.with === 'object') resolve(issue.with);
  }
}
