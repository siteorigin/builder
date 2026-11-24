/**
 * Screenshot points for the test driver's actions (issue #493). A screenshot an observation saves can be pointed at:
 * its `observation` token names it, and an action may aim at a pixel of its editor or preview image. A point stands
 * for what the screenshot showed only while nothing it depends on has changed, so the session keeps just the latest
 * screenshot's record and checks it before every use:
 *
 * - the scene: the same window, project opening and documents, the same editor viewport, the same place and zoom of
 *   the preview's frame, and the same scroll of both pages;
 * - a witness: when the pixels are taken, each document records every element's box; at action time the element under
 *   the pixel must have been there, at the same place, when the screenshot was taken. A panel scrolled or a row moved
 *   under the point fails, even where the scene still matches;
 * - its use: a newer screenshot replaces it, an action that sent input consumes it, and it expires.
 *
 * The record kept in each document lives only in the session's own app (never in project source or exports).
 */
import { randomBytes } from 'node:crypto';
import type { Frame, Page } from 'playwright';
import type { XY } from './protocol.ts';

type Dom = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** How long a screenshot point may be used after its screenshot. */
export const SHOT_TTL_MS = 60_000;

/** Where each document keeps the boxes its latest screenshot saw. */
const SHOT_KEY = 'siteorigin.driver.shot';

export interface FrameGeometry {
  /** The preview iframe's border box in the editor window. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its own size before the canvas scales it. */
  offsetWidth: number;
  offsetHeight: number;
  /** Where the page's (0, 0) is in the editor window, and how far it is scaled. */
  origin: XY;
  scale: XY;
}

export interface Scene {
  editor: { doc: string; opening: string; viewport: { width: number; height: number }; dpr: number; scroll: XY };
  frame: FrameGeometry | null;
  preview: { doc: string; viewport: { width: number; height: number }; scroll: XY } | null;
}

export type ObservationStale = 'unknown' | 'superseded' | 'acted' | 'expired' | 'window' | 'project' | 'document' | 'viewport' | 'zoom' | 'moved' | 'scrolled';

export interface ShotRecord {
  token: string;
  /** performance.now() when it was issued. */
  at: number;
  generation: number;
  scene: Scene;
  /** The images' sizes; the preview image is the part of the editor window at `clip`. */
  editor: { width: number; height: number };
  preview: { clip: { x: number; y: number; width: number; height: number } } | null;
}

export function looksLikeObservation(v: unknown): v is string {
  return typeof v === 'string' && /^o[0-9a-f]{6}-\d{1,9}$/.test(v);
}

/** The session's screenshot points: only the latest screenshot's, and only until it is used up. */
export class ShotRegistry {
  private readonly tag = randomBytes(3).toString('hex');
  private n = 0;
  private latest: ShotRecord | null = null;
  /** Why tokens this registry gave out stopped counting (the most recent few). */
  private readonly gone = new Map<string, ObservationStale>();

  /** A token for a screenshot about to be taken: it replaces whatever point was current. */
  next(): string {
    this.drop('superseded');
    return `o${this.tag}-${++this.n}`;
  }

  issue(record: ShotRecord) {
    this.drop('superseded');
    this.latest = record;
  }

  /** An action sent input: what the screenshot showed may have changed. */
  consume() {
    this.drop('acted');
  }

  /** The record a token names, or why it no longer counts. */
  get(token: string, now = performance.now()): ShotRecord | ObservationStale {
    if (this.latest?.token === token) {
      if (now - this.latest.at <= SHOT_TTL_MS) return this.latest;
      this.drop('expired');
    }
    return this.gone.get(token) ?? (token.startsWith(`o${this.tag}-`) && Number(token.split('-')[1]) <= this.n ? 'superseded' : 'unknown');
  }

  private drop(reason: ObservationStale) {
    if (!this.latest) return;
    this.gone.set(this.latest.token, reason);
    this.latest = null;
    while (this.gone.size > 50) this.gone.delete(this.gone.keys().next().value as string);
  }
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const sameXY = (a: XY, b: XY, tol = 0.5) => near(a.x, b.x, tol) && near(a.y, b.y, tol);

/** What changed between a screenshot's scene and now, most fundamental first; null when nothing did. */
export function sceneChange(was: Scene, now: Scene): ObservationStale | null {
  if (was.editor.opening !== now.editor.opening) return 'project';
  if (was.editor.doc !== now.editor.doc || !!was.preview !== !!now.preview || (was.preview && now.preview && was.preview.doc !== now.preview.doc)) return 'document';
  if (was.editor.viewport.width !== now.editor.viewport.width || was.editor.viewport.height !== now.editor.viewport.height || was.editor.dpr !== now.editor.dpr) return 'viewport';
  if (!!was.frame !== !!now.frame) return 'document';
  if (was.frame && now.frame) {
    if (!near(was.frame.scale.x, now.frame.scale.x, 1e-4) || !near(was.frame.scale.y, now.frame.scale.y, 1e-4) || was.frame.offsetWidth !== now.frame.offsetWidth || was.frame.offsetHeight !== now.frame.offsetHeight) return 'zoom';
    if (!sameXY(was.frame.origin, now.frame.origin) || !near(was.frame.width, now.frame.width) || !near(was.frame.height, now.frame.height)) return 'moved';
  }
  if (!sameXY(was.editor.scroll, now.editor.scroll)) return 'moved';
  if (was.preview && now.preview && (!sameXY(was.preview.scroll, now.preview.scroll) || was.preview.viewport.width !== now.preview.viewport.width || was.preview.viewport.height !== now.preview.viewport.height)) return 'scrolled';
  return null;
}

/** Where a point on one of a screenshot's images is in the editor window, or null when it is not on the image. */
export function imagePoint(record: ShotRecord, surface: 'editor' | 'preview', x: number, y: number): XY | null {
  if (surface === 'editor') return x >= 0 && y >= 0 && x < record.editor.width && y < record.editor.height ? { x, y } : null;
  const clip = record.preview?.clip;
  if (!clip || x < 0 || y < 0 || x >= clip.width || y >= clip.height) return null;
  return { x: clip.x + x, y: clip.y + y };
}

/** A point in the editor window, in the preview page's own CSS pixels. */
export function intoFrame(frame: Pick<FrameGeometry, 'origin' | 'scale'>, p: XY): XY {
  return { x: (p.x - frame.origin.x) / frame.scale.x, y: (p.y - frame.origin.y) / frame.scale.y };
}

/** A point in the preview page's own CSS pixels, in the editor window. */
export function fromFrame(frame: Pick<FrameGeometry, 'origin' | 'scale'>, p: XY): XY {
  return { x: frame.origin.x + p.x * frame.scale.x, y: frame.origin.y + p.y * frame.scale.y };
}

// ---------------------------------------------------------------------------
// In the documents
// ---------------------------------------------------------------------------

/**
 * Runs in a document: its scene, and the preview frame's geometry when `selector` names it. With `token`, also records
 * every element's box as the witness for that screenshot.
 */
function sceneIn(a: { token: string | null; selector: string | null; key: string }) {
  const w = globalThis as Dom;
  const d = w.document;
  if (a.token) {
    const boxes = new WeakMap();
    for (const el of d.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      boxes.set(el, [r.x, r.y, r.width, r.height]);
    }
    Object.defineProperty(w, Symbol.for(a.key), { value: { token: a.token, boxes }, configurable: true, enumerable: false, writable: false });
  }
  const iframe = a.selector ? d.querySelector(a.selector) : null;
  let frame = null;
  if (iframe) {
    const r = iframe.getBoundingClientRect();
    const cs = w.getComputedStyle(iframe);
    const sx = iframe.offsetWidth ? r.width / iframe.offsetWidth : 0;
    const sy = iframe.offsetHeight ? r.height / iframe.offsetHeight : 0;
    frame = {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      offsetWidth: iframe.offsetWidth as number,
      offsetHeight: iframe.offsetHeight as number,
      origin: { x: r.x + (iframe.clientLeft + parseFloat(cs.paddingLeft || '0')) * sx, y: r.y + (iframe.clientTop + parseFloat(cs.paddingTop || '0')) * sy },
      scale: { x: sx, y: sy }
    };
  }
  const canvas = d.querySelector('main.canvas');
  return {
    doc: `${w.performance.timeOrigin}|${w.location.pathname}${w.location.search}` as string,
    opening: (canvas?.getAttribute('data-opening') ?? '') as string,
    viewport: { width: w.innerWidth as number, height: w.innerHeight as number },
    dpr: w.devicePixelRatio as number,
    scroll: { x: w.scrollX as number, y: w.scrollY as number },
    frame
  };
}

/**
 * The scene now. With `token`, each document also records its boxes as that screenshot's witness. A preview whose
 * document cannot be read counts as none.
 */
export async function readScene(page: Page, preview: Frame | null, selector: string, token: string | null = null): Promise<Scene> {
  const [editor, page2] = await Promise.all([page.evaluate(sceneIn, { token, selector, key: SHOT_KEY }), preview ? preview.evaluate(sceneIn, { token, selector: null, key: SHOT_KEY }).catch(() => null) : Promise.resolve(null)]);
  const { frame, ...e } = editor;
  return { editor: { doc: e.doc, opening: e.opening, viewport: e.viewport, dpr: e.dpr, scroll: e.scroll }, frame: frame as FrameGeometry | null, preview: page2 ? { doc: page2.doc, viewport: page2.viewport, scroll: page2.scroll } : null };
}

export type Witness = 'ok' | 'new' | 'moved' | 'superseded';

/**
 * Runs in a document: whether the element at `el`'s place had that box when the screenshot `token` was taken.
 * `el` is the element now under the point.
 */
export function witnessIn(el: Dom, a: { token: string; key: string }): Witness {
  const w = globalThis as Dom;
  const shot = w[Symbol.for(a.key)];
  if (!shot || shot.token !== a.token) return 'superseded';
  const box = shot.boxes.get(el);
  if (!box) return 'new';
  const r = el.getBoundingClientRect();
  return Math.abs(r.x - box[0]) <= 1 && Math.abs(r.y - box[1]) <= 1 && Math.abs(r.width - box[2]) <= 1 && Math.abs(r.height - box[3]) <= 1 ? 'ok' : 'moved';
}

export const SHOT_WITNESS_KEY = SHOT_KEY;
