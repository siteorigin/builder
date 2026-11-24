/**
 * An image tile dragged out of Assets onto the canvas (#505). The panel notices the drag; the canvas, which can ask
 * the page what is under the pointer, shows which image would take it and puts it there on release.
 */

/** What is being dragged: the library image, and its name. */
export interface AssetDrag {
  assetId: string;
  name: string;
}

/** Where the drag is in the window, and the pointer that is dragging it. */
type At = { x: number; y: number; pointerId: number };
type Begin = (drag: AssetDrag, at: At) => boolean;
let begin: Begin | null = null;

/** The canvas takes drags from Assets while it is on screen. */
export function setAssetDropTarget(fn: Begin | null) {
  begin = fn;
}

/** Hand a drag to the canvas, from the pointer's place in the window. False when the canvas cannot take one now (no
 *  page showing, or another drag running): the press stays a click. */
export function beginAssetDrag(drag: AssetDrag, at: At): boolean {
  return begin ? begin(drag, at) : false;
}
