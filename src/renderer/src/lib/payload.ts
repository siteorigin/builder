/**
 * Shape checks for what the preview frame sends. The previewed site runs project code (custom components
 * included), so its messages are read as untrusted input: anything malformed is dropped, never thrown on.
 */
import type { BridgeDesc } from './model';

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_RECTS = 500;
const MAX_CHAIN = 1000;
const MAX_FIELD = 2000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = MAX_FIELD): v is string => typeof v === 'string' && v.length <= max;

export function isRect(v: unknown): v is FrameRect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width >= 0 && r.height >= 0;
}

/** A list of element boxes; anything that is not one is left out. */
export function rectList(v: unknown): FrameRect[] {
  if (!Array.isArray(v)) return [];
  return Array.from(v.slice(0, MAX_RECTS)).filter(isRect).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

/** Measured boxes in request order, where a missing (hidden) element is null; null for a malformed list. Each
 *  box has its element's CSS order (0 unless an Order style moves it among its siblings). */
export function measuredRects(v: unknown, expected: number): Array<(FrameRect & { order: number }) | null> | null {
  if (!Array.isArray(v) || v.length !== expected) return null;
  // Array.from visits holes too (map would skip them and leave them empty).
  return Array.from(v, (r) => (isRect(r) ? { x: r.x, y: r.y, width: r.width, height: r.height, order: orderOf((r as { order?: unknown }).order) } : null));
}
const orderOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);

function isDesc(v: unknown): v is BridgeDesc {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return str(d.ctx) && str(d.node) && str(d.items) && (d.tag === undefined || str(d.tag, 200)) && (d.text === undefined || str(d.text, 400)) && (d.code === undefined || typeof d.code === 'boolean');
}

/** The element chain under the pointer, innermost first. A chain with any malformed entry is empty. */
export function chainOf(v: unknown): BridgeDesc[] {
  if (!Array.isArray(v) || v.length > MAX_CHAIN || !Array.from(v).every(isDesc)) return [];
  return v.map((d: BridgeDesc) => ({ ctx: d.ctx, node: d.node, items: d.items, tag: d.tag, text: d.text, code: d.code }));
}

/** An element descriptor the editor sent back (an edit's target), or null. */
export function descOrNull(v: unknown): BridgeDesc | null {
  return isDesc(v) ? v : null;
}
