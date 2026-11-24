/**
 * Where ⌘C and ⌘V belong to the editor's selection, from what has focus. Text fields never reach this (a control that
 * takes typing keeps its own copy and paste).
 *
 * Copy takes the canvas selection, so it is claimed only from the page, Layers, the Pages list, the selection's chip and
 * its Inspector heading, never from an unrelated control (an Assets tile, a setting). Paste goes onto the page being
 * edited, so it is claimed from any control: right after the page switcher or the command menu picks a page, focus is
 * left on a button outside all of those, and the paste must still land on that page.
 */
const COPY_FROM = '[role="tree"], .canvas, .ov-chip, .pages-list, .insp-head';

export function clipKeyIsEditors(chord: 'copy' | 'paste', target: { closest?: (selector: string) => unknown } | null, body: unknown): boolean {
  return chord === 'paste' || target === body || !!target?.closest?.(COPY_FROM);
}
