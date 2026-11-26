/**
 * A tile dragged out of the Insert panel onto the canvas. The panel notices the drag; the canvas, which can measure
 * the page, shows where it would land and inserts it there on release.
 */
import type { InsertSpec } from './insert-search';

/** What is being dragged: what it inserts, and its name ("Gallery", "Centered hero (Dark)"). */
export interface InsertDrag {
  spec: InsertSpec;
  name: string;
  /** The tile pressed, which keeps focus through the drag (see claimForInsert). */
  tile?: unknown;
}

/** Where the drag is in the window, and the pointer that is dragging it. */
type At = { x: number; y: number; pointerId: number };
type Begin = (drag: InsertDrag, at: At) => boolean;
let begin: Begin | null = null;

/** The canvas takes drags from Insert while it is on screen. */
export function setInsertDropTarget(fn: Begin | null) {
  begin = fn;
}

/** Hand a drag to the canvas, from the pointer's place in the window. False when the canvas cannot take one now
 *  (Preview, a component edited everywhere, no page showing): the press stays a click. */
export function beginInsertDrag(drag: InsertDrag, at: At): boolean {
  return begin ? begin(drag, at) : false;
}
