/**
 * The page outline: the headings a page renders, in the order a screen reader's heading list reads them, with what
 * each one asks its author to review (a second page title, a skipped level) and the edit that settles it.
 */
import type { ElementRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { pageHeadings, type HeadingReview, type OutlineHeading } from '@generator/checks';
import { partIdFor } from './model';

/** One row of the outline. */
export interface OutlineRow {
  heading: OutlineHeading;
  /** Names this row across revisions: where its heading is shown, and which of the headings shown there it is. */
  key: string;
  /** The page's one Heading 1. */
  title?: boolean;
  /** A Heading 1 after the page's first: a second title, unless it is meant to be one. */
  extraTitle?: boolean;
  /** Skips a level: the level before it, and the one that would follow on. */
  skip?: { after: number; suggest: number };
  /** The level that settles what this row is flagged for, when its level can be changed from here. */
  fix?: number;
  /** Its level is chosen once for several headings, or the field choosing it decides more: changing it changes more than this row. */
  sharedLevel?: boolean;
}

export interface PageOutline {
  rows: OutlineRow[];
  review: HeadingReview;
  /** Code on the page shows headings that cannot be read here. */
  uninspected: boolean;
  /** For a page with no Heading 1: its first heading, when it can be made one from here. */
  titleFix?: OutlineRow;
}

/** Whether a heading's level can be set to this one from the outline. */
export const canSetLevel = (h: OutlineHeading, level: number) => !!h.levelSource && !!h.levels?.includes(level) && h.level !== level;

/** Names where a heading's level is chosen: headings sharing one change together. */
const sourceKey = (h: OutlineHeading) => {
  const s = h.levelSource;
  return s ? JSON.stringify([h.owner.kind, h.owner.id, h.nodeId, s.kind === 'node' ? null : [s.prop, s.itemId ?? null, s.field ?? null]]) : null;
};

/** The current page's outline, each row marked with what it asks for. */
export function pageOutline(state: ProjectState, pageId: string): PageOutline {
  const { outline, review, uninspected } = pageHeadings(state, pageId);
  // Headings a list shows through one placement share a place: their order among them tells them apart.
  const seen = new Map<string, number>();
  const rows: OutlineRow[] = outline.map((heading) => {
    const place = headingKey(heading);
    const n = seen.get(place) ?? 0;
    seen.set(place, n + 1);
    return { heading, key: `${place}#${n}` };
  });
  // A level chosen once for several headings (a design's choice its headings share, or one heading repeated) is
  // changed for all of them, which the row's fix does not say: those are changed in the Inspector instead.
  const sharing = new Map<string, number>();
  for (const h of outline) {
    const k = sourceKey(h);
    if (k) sharing.set(k, (sharing.get(k) ?? 0) + (h.repeated ? 2 : 1));
  }
  const fixable = (h: OutlineHeading, level: number) => canSetLevel(h, level) && !h.levelConditions && sharing.get(sourceKey(h)!) === 1;
  rows.forEach((r) => {
    const k = sourceKey(r.heading);
    if (k && (r.heading.levelConditions || sharing.get(k)! > 1)) r.sharedLevel = true;
  });
  // The first Heading 1 is taken as the page's title, and each later one as a second title. A title shown more than
  // once is its own second title, which no other level settles while it stays the page's only one.
  review.titles.forEach((i, k) => {
    if (k === 0 && !outline[i].repeated) rows[i].title = true;
    else rows[i].extraTitle = true;
    if (k > 0 && fixable(outline[i], 2)) rows[i].fix = 2;
  });
  for (const s of review.skips) {
    rows[s.index].skip = { after: s.after, suggest: s.suggest };
    if (fixable(outline[s.index], s.suggest)) rows[s.index].fix = s.suggest;
  }
  const firstOwn = rows.find((r) => r.heading.owner.kind === 'page');
  const titleFix = review.missingTitle && firstOwn && fixable(firstOwn.heading, 1) ? firstOwn : undefined;
  return { rows, review, uninspected, ...(titleFix ? { titleFix } : {}) };
}

/** What selecting a heading selects: its own element, or the part of the section placed on the page that shows it. */
export function headingTarget(state: ProjectState, h: OutlineHeading): ElementRef {
  const page: ElementRef = { owner: h.owner, instancePath: [], nodeId: h.nodeId };
  // A heading in a component inside the placed one: through the placements between, as the canvas selects it.
  if (h.instancePath?.length && h.defNodeId) return { owner: h.owner, instancePath: h.instancePath, nodeId: h.defNodeId, ...(h.partId ? { partId: h.partId } : {}) };
  if (!h.direct || !h.defNodeId) return page;
  const tree = h.owner.kind === 'page' ? state.pages[h.owner.id] : h.owner.kind === 'shell' ? state.site.shell[h.owner.id as 'header' | 'footer'] : undefined;
  const node = tree && Object.hasOwn(tree.nodes, h.nodeId) ? tree.nodes[h.nodeId] : undefined;
  const def = node?.kind === 'instance' && Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!def?.tree || !Object.hasOwn(def.tree.nodes, h.defNodeId)) return page;
  const part: ElementRef = { owner: h.owner, instancePath: [h.nodeId], nodeId: h.defNodeId };
  const partId = partIdFor(def, h.defNodeId);
  if (partId) part.partId = partId;
  if (h.itemPath?.length) part.itemPath = h.itemPath;
  return part;
}

/** The edit that gives a heading another level, keeping its look: its own tag, or its placement's choice. */
export function headingLevelOps(h: OutlineHeading, level: number): EditOperation[] | null {
  if (!canSetLevel(h, level)) return null;
  const s = h.levelSource!;
  const value = `h${level}`;
  if (s.kind === 'node') return [{ type: 'node.setContent', owner: h.owner, nodeId: h.nodeId, field: 'tag', value }];
  return [{ type: 'instance.setProp', owner: h.owner, nodeId: h.nodeId, prop: s.prop, ...(s.itemId ? { itemId: s.itemId, field: s.field } : s.field !== undefined ? { field: s.field } : {}), value }];
}

/** Names one heading across revisions: where it is shown, not its level or words. */
export const headingKey = (h: OutlineHeading) => JSON.stringify([h.owner.kind, h.owner.id, h.nodeId, h.instancePath ?? null, h.defNodeId ?? null, h.itemPath ?? null, h.rich ? h.text : null]);

/** A heading's words for a row or a label; an empty heading says so. */
export const headingWords = (h: OutlineHeading) => h.text || 'Empty heading';
