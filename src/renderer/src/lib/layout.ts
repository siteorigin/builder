// How the editor's width is shared between the rail, the left panel, the canvas and the right dock, and how
// much of the toolbar shows. Pure and DOM-free, so the unit tests compile it with the main process code.

import { VIEWPORT_PRESETS } from '@shared/styles';

export type PanelSide = 'left' | 'right';

/** The icon rail at the window's left edge. */
export const RAIL_WIDTH = 48;
/** The panels leave the canvas at least this much. At the 1100px minimum window both panels still fit at
 *  their default widths, and the desktop preview at Fit is 384px wide (30%). */
export const CANVAS_MIN = 440;
export const PANEL_LIMITS: Record<PanelSide, { min: number; max: number }> = {
  left: { min: 200, max: 420 },
  right: { min: 300, max: 560 }
};
export const PANEL_DEFAULTS: Record<PanelSide, number> = { left: 260, right: 340 };

/** The Insert panel's own width (its scrollbar included) at or under which it lays out narrow: one column of tiles, icons for its actions. */
export const INSERT_NARROW_MAX = 232;
/**
 * Whether the Insert panel lays out narrow at `width`. A panel with no width at all is hidden (another sidebar tab
 * shows): it keeps the layout it had (`was`), since it has none of its own until it shows again.
 */
export const narrowLayout = (width: number, was: boolean) => (width > 0 ? width <= INSERT_NARROW_MAX : was);

/** Each panel's preferred width, or null while it is closed. */
export type PanelPrefs = Record<PanelSide, number | null>;
/** The width each panel is drawn at; 0 while it is closed. */
export type PanelWidths = Record<PanelSide, number>;

export const clampPanel = (side: PanelSide, w: number) => Math.round(Math.max(PANEL_LIMITS[side].min, Math.min(PANEL_LIMITS[side].max, w)));

/** A saved panel width, kept within the panel's limits; the default when it is missing or not a number. */
export const restorePanelWidth = (side: PanelSide, saved: unknown) => (typeof saved === 'number' && Number.isFinite(saved) ? clampPanel(side, saved) : PANEL_DEFAULTS[side]);

/**
 * The widths the open panels are drawn at in a window `windowWidth` wide. Each keeps its preferred width
 * while the canvas still gets CANVAS_MIN. Past that the left panel gives way first, down to its minimum,
 * then the right dock: the Inspector, AI and Site styles are where editing happens, and the Pages and
 * Layers lists already work at 200px. Preferences are not changed, so a wider window gives the room back.
 * Below the panels' combined minimums the canvas takes what is left.
 */
export function fitPanels(windowWidth: number, prefs: PanelPrefs): PanelWidths {
  const budget = Math.floor(windowWidth) - RAIL_WIDTH - CANVAS_MIN;
  const leftFloor = prefs.left === null ? 0 : PANEL_LIMITS.left.min;
  const right = prefs.right === null ? 0 : Math.min(clampPanel('right', prefs.right), Math.max(PANEL_LIMITS.right.min, budget - leftFloor));
  const left = prefs.left === null ? 0 : Math.min(clampPanel('left', prefs.left), Math.max(PANEL_LIMITS.left.min, budget - right));
  return { left, right };
}

/**
 * The widest a splitter can make `side`, by the same priority as fitPanels: the right dock may take the
 * sidebar down to its minimum (the sidebar then gives way as it would in a smaller window, and gets its room
 * back when the dock narrows); the sidebar only gets the room the dock leaves.
 */
export function panelMax(side: PanelSide, windowWidth: number, prefs: PanelPrefs): number {
  const other = side === 'right' ? (prefs.left === null ? 0 : PANEL_LIMITS.left.min) : fitPanels(windowWidth, prefs).right;
  const room = Math.floor(windowWidth) - RAIL_WIDTH - CANVAS_MIN - other;
  return Math.max(PANEL_LIMITS[side].min, Math.min(PANEL_LIMITS[side].max, room));
}

/** A splitter's new width for `side`: the requested width, kept within the panel's limits and its room. */
export function resizePanel(side: PanelSide, requested: number, windowWidth: number, prefs: PanelPrefs): number {
  return Math.round(Math.max(PANEL_LIMITS[side].min, Math.min(panelMax(side, windowWidth, prefs), requested)));
}

/**
 * How much of the toolbar shows, by window width. 'full' has everything. 'compact' drops the Edit and
 * Preview labels (the icons keep their names) and lets the project and page names shorten. 'overflow' also
 * moves Zoom and Settings into a More menu. The thresholds are for macOS, whose traffic lights take 70px of
 * the toolbar; elsewhere that room is free, so each step comes 70px later. The full toolbar needs about
 * 1180px on macOS; at the 1100px minimum the compact one leaves the names and a "File conflict" notice
 * about 470px.
 */
export type ToolbarTier = 'full' | 'compact' | 'overflow';
export const TOOLBAR_FULL_MIN = 1232;
export const TOOLBAR_COMPACT_MIN = 1080;
export const MAC_TRAFFIC_LIGHTS = 70;
export function toolbarTier(windowWidth: number, mac: boolean): ToolbarTier {
  const w = windowWidth + (mac ? 0 : MAC_TRAFFIC_LIGHTS);
  return w >= TOOLBAR_FULL_MIN ? 'full' : w >= TOOLBAR_COMPACT_MIN ? 'compact' : 'overflow';
}

/** The widths the preview can be set to, by the width field and the frame's resize handles alike. */
export const VIEWPORT_LIMITS = { min: 240, max: 2560 };
export const DEFAULT_VIEWPORT: number = VIEWPORT_PRESETS.desktop;
/** The zoom levels the Zoom menu offers besides Fit. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25] as const;
export type Zoom = number | 'fit';

export const clampViewport = (w: number) => Math.round(Math.max(VIEWPORT_LIMITS.min, Math.min(VIEWPORT_LIMITS.max, w)));

/** A saved preview width: a whole number within the limits, or the default when it is anything else. */
export const restoreViewport = (saved: unknown) =>
  typeof saved === 'number' && Number.isInteger(saved) && saved >= VIEWPORT_LIMITS.min && saved <= VIEWPORT_LIMITS.max ? saved : DEFAULT_VIEWPORT;

/** A saved zoom: Fit or one of the menu's levels; Fit when it is anything else (the canvas divides by it). */
export const restoreZoom = (saved: unknown): Zoom => (typeof saved === 'number' && (ZOOM_LEVELS as readonly number[]).includes(saved) ? saved : 'fit');

/** An arrow key on a frame handle changes the preview width this much, the step of the panel splitters. */
export const FRAME_KEY_STEP = 16;

/**
 * The preview width after an arrow key on one of the frame's resize handles: moving the right handle right
 * widens the frame and moving the left handle right narrows it, as dragging them does. Null for any other key,
 * and when the width is already at the limit the key pushes against.
 */
export function frameKeyResize(side: PanelSide, key: string, width: number): number | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const outward = (key === 'ArrowRight') === (side === 'right') ? 1 : -1;
  const next = clampViewport(width + FRAME_KEY_STEP * outward);
  return next === width ? null : next;
}
