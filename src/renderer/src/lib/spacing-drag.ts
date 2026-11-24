/**
 * Padding and margin dragged on the canvas: which style each handle writes, how far a drag moves it at the canvas
 * zoom, and the site spacing style it snaps to. Pure, for the canvas overlay to drive.
 */
import type { StyleValue } from '@shared/types';

export type SpacingSide = 'top' | 'bottom' | 'left' | 'right';
export type SpacingBox = 'padding' | 'margin';

/** Frame-pixel sizes the page reports for the selected element's padding and margin. */
export interface SpacingSizes {
  padding: Record<SpacingSide, number>;
  margin: Record<SpacingSide, number>;
}

export interface SpacingHandle {
  box: SpacingBox;
  side: SpacingSide;
  /** The style this one side writes. */
  edge: string;
  /** The style that sets this side and the one opposite it together, when there is one. */
  pair: string | null;
  axis: 'x' | 'y';
  /** Which way along the axis the pointer moves to make it larger. */
  grow: 1 | -1;
}

export const SPACING_HANDLES: SpacingHandle[] = [
  { box: 'padding', side: 'top', edge: 'paddingBlockStart', pair: 'paddingBlock', axis: 'y', grow: 1 },
  { box: 'padding', side: 'bottom', edge: 'paddingBlockEnd', pair: 'paddingBlock', axis: 'y', grow: -1 },
  { box: 'padding', side: 'left', edge: 'paddingInlineStart', pair: 'paddingInline', axis: 'x', grow: 1 },
  { box: 'padding', side: 'right', edge: 'paddingInlineEnd', pair: 'paddingInline', axis: 'x', grow: -1 },
  { box: 'margin', side: 'top', edge: 'marginBlockStart', pair: null, axis: 'y', grow: -1 },
  { box: 'margin', side: 'bottom', edge: 'marginBlockEnd', pair: null, axis: 'y', grow: 1 }
];

/** One stop a drag snaps to: a spacing site style and its size on the page now, in frame pixels. */
export interface SpaceStop {
  token: string;
  label: string;
  px: number;
}

/** Where a drag has got to: the value it writes, its size in frame pixels, and the site style it snapped to. */
export interface DragValue {
  value: StyleValue;
  px: number;
  stop?: SpaceStop;
}

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);

/**
 * The size a drag reaches, in frame pixels: where it started plus the pointer's travel in screen pixels, taken back
 * through the canvas zoom, toward the side that makes it larger. Never below zero.
 */
export function draggedSize(start: number, travel: number, zoom: number, grow: 1 | -1): number {
  const z = finite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(0, (finite(start) ? start : 0) + ((finite(travel) ? travel : 0) * grow) / z);
}

/** A frame-pixel length as the canvas draws it at a zoom, in screen pixels. */
export const onScreen = (px: number, zoom: number) => px * (finite(zoom) && zoom > 0 ? zoom : 1);

/** The spacing stops in size order, without duplicates of a size an earlier (smaller-named) stop already has. */
export function spaceScale(stops: SpaceStop[]): SpaceStop[] {
  const sorted = stops.filter((s) => finite(s.px) && s.px > 0).sort((a, b) => a.px - b.px);
  return sorted.filter((s, i) => i === 0 || Math.abs(s.px - sorted[i - 1].px) >= 0.5);
}

/**
 * What a drag to `px` writes. Snapped, it is the nearest spacing site style, or none at all when zero is nearer
 * (an even split goes to the smaller); exact, it is a whole number of pixels.
 */
export function dragValue(px: number, stops: SpaceStop[], exact: boolean): DragValue {
  const at = Math.max(0, finite(px) ? px : 0);
  if (exact || !stops.length) {
    const whole = Math.round(at);
    return { value: whole === 0 ? '0' : `${whole}px`, px: whole };
  }
  let best: SpaceStop | null = null;
  let gap = at;
  for (const s of spaceScale(stops)) {
    const d = Math.abs(s.px - at);
    if (d < gap) {
      best = s;
      gap = d;
    }
  }
  return best ? { value: { token: best.token }, px: best.px, stop: best } : { value: '0', px: 0 };
}

/** The HUD's words for where a drag is: the site style's name and its size, or the size alone. */
export function dragLabel(v: DragValue): string {
  const px = `${Math.round(v.px * 10) / 10}px`;
  return v.stop ? `${v.stop.label} · ${px}` : px;
}
