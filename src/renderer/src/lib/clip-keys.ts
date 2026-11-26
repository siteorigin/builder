/**
 * Where Delete, ⌘C and ⌘V belong to the editor's selection, from what has focus. Text fields never reach this (a control
 * that takes typing keeps its own keys).
 *
 * Delete and Copy take the canvas selection, so they are claimed only from the page, Layers and the selection's chip
 * (Copy also from the Pages list and the Inspector's heading), never from an unrelated control (an Assets tile, a
 * setting). The one control elsewhere that has them is the Insert tile whose insert made the selection: focus stays on it
 * (see `claimForInsert`). Paste goes onto the page being edited, so it is claimed from any control: right after the page
 * switcher or the command menu picks a page, focus is left on a button outside all of those, and the paste must still
 * land on that page.
 */
const DELETE_FROM = '[role="tree"], .canvas, .ov-chip';
const COPY_FROM = `${DELETE_FROM}, .pages-list, .insp-head`;

type Target = { closest?: (selector: string) => unknown } | null;

/** The Insert tile that made the latest insert, and the selection that insert made. */
let inserted: { control: unknown; selection: unknown } | null = null;

/** `control` inserted what is now `selection`: while that stays selected, Delete and Copy pressed on it are about it. */
export function claimForInsert(control: unknown, selection: unknown): void {
  inserted = control ? { control, selection } : null;
}

/** The author has moved on (another selection or view), or the panel has moved focus by itself. */
export function forgetInsert(): void {
  inserted = null;
}

const fromInsert = (target: Target, selection: unknown) => !!target && inserted?.control === target && inserted.selection === selection;

export function deleteKeyIsEditors(target: Target, body: unknown, selection: unknown): boolean {
  return target === body || !!target?.closest?.(DELETE_FROM) || fromInsert(target, selection);
}

export function clipKeyIsEditors(chord: 'copy' | 'paste', target: Target, body: unknown, selection?: unknown): boolean {
  return chord === 'paste' || target === body || !!target?.closest?.(COPY_FROM) || fromInsert(target, selection);
}
