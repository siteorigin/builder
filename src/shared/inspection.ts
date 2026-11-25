/**
 * What a layout inspection reports (see the preview bridge's `inspect` and the editor's `runInspection`): computed
 * styles and geometry only, never a pixel. The bridge names each element by where it rendered (`desc`); the editor
 * turns that into `ref`, the reference the assistant's operations take (owner, nodeId, partId, itemId).
 */
import type { OwnerRef } from './types';

/** Where an element rendered, as the editor's markup records it (`data-so-ctx`, `data-so-node`, `data-so-items`). */
export interface InspectionDesc {
  ctx: string;
  node: string;
  items: string;
  /** The finding is about something inside this element that the editor does not know by itself (a code component's markup). */
  inside?: boolean;
}

/**
 * The element to change for a finding, as operations address it: a node of the owner's own tree and, on a component
 * placement, the part and the one list item. `match` says when it is broader than the element measured: the
 * declared part around it, the placement as a whole, or (`container`) the node holding markup the editor does not
 * address on its own, such as a link in rich text.
 */
export interface InspectionRef {
  owner: OwnerRef;
  nodeId: string;
  partId?: string;
  itemId?: string;
  match?: 'nearest-part' | 'placement' | 'container';
  /**
   * For an element of a component placed inside a project component's design: the same element in that design,
   * which changes every placement of the design (the placement's own part, above, changes only this one).
   */
  definition?: InspectionRef;
}

/** The defect classes the readability checks report, one finding per element (see `InspectionChecks`). */
export type ReadabilityKind = 'low-contrast' | 'overlap' | 'clipped-text' | 'small-tap-target' | 'contrast-unverified';

/** How many candidates one check measured, how many failed, and how many could not be measured without pixels. */
export interface CheckCount {
  checked: number;
  failed: number;
  unverified: number;
  /** Set when the check does not apply to this measurement (tap targets above phone width). */
  skipped?: string;
  /** Set when the page had more candidates than one inspection measures. */
  incomplete?: boolean;
}

/** The readability checks' totals, never capped: a clean page reports every count with nothing failed. */
export interface InspectionChecks {
  contrast: CheckCount;
  overlaps: CheckCount;
  clippedText: CheckCount;
  tapTargets: CheckCount;
}

export interface InspectionIssue {
  kind: string;
  message?: string;
  /** Text the element shows, cut short, so the finding can be recognised. */
  text?: string;
  /** Raw, from the bridge; replaced by `ref` before the report leaves the editor. */
  desc?: InspectionDesc;
  ref?: InspectionRef;
  /** How many elements (repeated items) the finding stands for, when more than one. */
  count?: number;
  /** For an overlap: the box it overlaps. */
  with?: { desc?: InspectionDesc; ref?: InspectionRef; text?: string };
  [measurement: string]: unknown;
}

/** The notes on a page's rhythm: advice on composition, never a defect (see `InspectionRhythmNote`). */
export type RhythmKind = 'repeated-layout' | 'crowded-actions' | 'heading-scale';

/**
 * A note on how a page's sections follow one another, which the layout inspection lists apart from its findings
 * (`report.rhythm`, on a page of two or more sections): three or more sections in a row with one layout on one
 * background, or each with a filled button (from the first, `ref`, to the last, `with.ref`, numbered as the page lists
 * its sections); an inner heading (`ref`) as large as the page's h1 (`with.ref`). At most one of each kind.
 */
export interface InspectionRhythmNote {
  kind: RhythmKind;
  message: string;
  /** Where a run of sections starts and ends, numbered from 1 as the page lists them. */
  sections?: { first: number; last: number };
  text?: string;
  desc?: InspectionDesc;
  ref?: InspectionRef;
  with?: { desc?: InspectionDesc; ref?: InspectionRef; text?: string };
  [measurement: string]: unknown;
}

/** Each kind of finding the checks report: the elements failing, and those it could not measure. */
export const CHECK_KINDS: Record<keyof InspectionChecks, { failed: ReadabilityKind; unverified?: ReadabilityKind }> = {
  contrast: { failed: 'low-contrast', unverified: 'contrast-unverified' },
  overlaps: { failed: 'overlap' },
  clippedText: { failed: 'clipped-text' },
  tapTargets: { failed: 'small-tap-target' }
};
