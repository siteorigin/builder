/**
 * A tile dragged out of the Insert panel onto the canvas. The panel notices the drag; the canvas, which can measure
 * the page, shows where it would land and inserts it there on release.
 */
import type { InsertSpec } from './insert-search';

/** What is being dragged: what it inserts, and its name ("Gallery", "Centered hero (Dark)"). */
export interface InsertDrag {
  spec: InsertSpec;
  name: string;
}

type Begin = (drag: InsertDrag, at: { x: number; y: number }) => boolean;
let begin: Begin | null = null;

/** The canvas takes drags from Insert while it is on screen. */
export function setInsertDropTarget(fn: Begin | null) {
  begin = fn;
}

/** Hand a drag to the canvas, from the pointer's place in the window. False when the canvas cannot take one now
 *  (Preview, a component edited everywhere, no page showing): the press stays a click. */
export function beginInsertDrag(drag: InsertDrag, at: { x: number; y: number }): boolean {
  return begin ? begin(drag, at) : false;
}
