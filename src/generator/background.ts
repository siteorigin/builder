/**
 * A background image as CSS: the only place a url() is written into a stylesheet, and only for a library image whose
 * record names a project file. Everything here is plain CSS in the exported site.
 *
 * The picture paints through custom properties on the element (BG_VARS), read by the background longhands. A
 * `background` colour set in another rule (another size, a stronger layer, a state) is the shorthand, which resets
 * those longhands, so on an element that can carry a picture each `background` declaration paints them again from the
 * variables (`paintDecls`). Variables inherit, so each such element also starts them unset at zero specificity
 * (`resetDecls`): a box inside a hero never takes the hero's photograph.
 */
import { backgroundImageError, backgroundPosition } from '@shared/background-image';
import { isScrim } from '@shared/styles';
import type { AssetRecord, BackgroundImageValue, StyleValue } from '@shared/types';

export const BG_VARS = { image: '--so-bg-image', size: '--so-bg-size', position: '--so-bg-position', repeat: '--so-bg-repeat' } as const;

/** The widest a phone and a tablet screen can be, in CSS pixels (see MEDIA_QUERIES): the most a background spans there. */
export const RANGE_WIDTHS = { phone: 768, tablet: 1024 } as const;

/** A project file a library image names, as the site's address for it: under static/, in plain characters only. */
const FILE_RE = /^static\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z0-9]+)$/;

/** The address of a library file, or null for a path that is not a plain file under static/. */
function fileUrl(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const m = FILE_RE.exec(file);
  return m && !m[1].split('/').some((s) => s === '.' || s === '..') ? `url("/${m[1]}")` : null;
}

/** The longhands that paint the element's background image from its variables, or `own` (what its `background` paints) without one. */
export function paintDecls(own = 'none'): string[] {
  return [`background-image: var(${BG_VARS.image}, ${own})`, `background-size: var(${BG_VARS.size}, auto)`, `background-position: var(${BG_VARS.position}, 0% 0%)`, `background-repeat: var(${BG_VARS.repeat}, repeat)`];
}

/** The variables unset, so the element paints only a picture its own rules give it. */
export const resetDecls = (): string[] => Object.values(BG_VARS).map((v) => `${v}: initial`);

/** One image the picture can be drawn from, at its width in pixels. */
interface Candidate {
  url: string;
  width: number;
}

/** A library image's files as candidates, narrowest first, each width once; none when the original's file or width is unknown. */
function candidates(asset: AssetRecord): Candidate[] {
  const original = fileUrl(asset.file);
  const width = asset.width;
  if (!original || typeof width !== 'number' || !Number.isInteger(width) || width <= 0) return [];
  const out = new Map<number, string>([[width, original]]);
  for (const v of Array.isArray(asset.variants) ? asset.variants : []) {
    const url = fileUrl(v?.file);
    // A damaged copy is left out; the original still shows.
    if (url && typeof v.width === 'number' && Number.isInteger(v.width) && v.width > 0 && v.width < width && !out.has(v.width)) out.set(v.width, url);
  }
  return [...out].sort(([a], [b]) => a - b).map(([w, url]) => ({ url, width: w }));
}

/**
 * The picture for a screen at most `span` CSS pixels wide: each copy at least as wide as the screen at one device
 * pixel per CSS pixel, by its density there (a 960px copy on a 768px-wide phone is 1.25x), so the browser picks the
 * one its screen needs. Over-delivers for a box narrower than the screen, never draws a copy too small for it.
 */
function imageFor(asset: AssetRecord, original: string, span?: number): string {
  const all = candidates(asset);
  if (span === undefined || all.length < 2) return original;
  const first = all.findIndex((c) => c.width >= span);
  if (first < 0) return original;
  const used = all.slice(first);
  if (used.length === 1) return used[0].url;
  return `image-set(${used.map((c) => `${c.url} ${Math.round((c.width / span) * 1000) / 1000}x`).join(', ')})`;
}

/** What a background image paints with, from the library: the record and the original's address, or null when nothing can be painted. */
function resolve(raw: StyleValue, assets: Record<string, AssetRecord>): { value: BackgroundImageValue; asset: AssetRecord; original: string } | null {
  // Read again here: a hand-edited document never reached validation.
  if (backgroundImageError(raw, isScrim)) return null;
  const value = raw as BackgroundImageValue;
  const asset = Object.hasOwn(assets, value.assetId) ? assets[value.assetId] : undefined;
  if (!asset || asset.kind !== 'image' || typeof asset.mime !== 'string' || !asset.mime.startsWith('image/')) return null;
  const original = fileUrl(asset.file);
  return original ? { value, asset, original } : null;
}

/** The scrim as a layer: a colour is a gradient of one colour, since a plain colour cannot be a background image. */
const scrimLayer = (scrim: string) => (/^[a-z-]*gradient\(/i.test(scrim) ? scrim : `linear-gradient(${scrim}, ${scrim})`);

/**
 * The declarations a background image writes in one rule: its variables and the longhands that paint them. `span`
 * is the widest the screen can be where the rule applies (a phone's or tablet's rule picks a copy for it; without one,
 * the original). Nothing for a value that does not name a library image's file, a scrim outside its grammar, or a
 * hand-edited shape.
 */
export function backgroundImageDecls(raw: StyleValue, assets: Record<string, AssetRecord>, span?: number): string[] {
  const r = resolve(raw, assets);
  if (!r) return [];
  const scrim = typeof r.value.scrim === 'string' ? r.value.scrim.trim() : '';
  const image = imageFor(r.asset, r.original, span);
  const fit = r.value.size === 'contain' ? 'contain' : 'cover';
  const at = backgroundPosition(r.value);
  // The scrim covers the whole box, over the picture, whether the picture fills it or not.
  const layers = scrim
    ? { image: `${scrimLayer(scrim)}, ${image}`, size: `100% 100%, ${fit}`, position: `center, ${at}`, repeat: 'no-repeat, no-repeat' }
    : { image, size: fit, position: at, repeat: 'no-repeat' };
  return [`${BG_VARS.image}: ${layers.image}`, `${BG_VARS.size}: ${layers.size}`, `${BG_VARS.position}: ${layers.position}`, `${BG_VARS.repeat}: ${layers.repeat}`, ...paintDecls()];
}

/**
 * The picture alone for a phone's or tablet's screen, when a rule for every size names a library image with smaller
 * copies: what that size's own rule sets, so the original is fetched only where a screen needs it. Null when that
 * size picks the original anyway.
 */
export function backgroundImageAt(raw: StyleValue, assets: Record<string, AssetRecord>, span: number): string | null {
  const r = resolve(raw, assets);
  if (!r) return null;
  const image = imageFor(r.asset, r.original, span);
  if (image === r.original) return null;
  const scrim = typeof r.value.scrim === 'string' ? r.value.scrim.trim() : '';
  return `${BG_VARS.image}: ${scrim ? `${scrimLayer(scrim)}, ${image}` : image}`;
}

/** Whether a declaration is one a background image writes that names a file (the only ones holding url()). */
export const namesFile = (decl: string): boolean => decl.startsWith(`${BG_VARS.image}:`) && decl.includes('url(');
