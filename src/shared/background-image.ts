/**
 * A library image behind an element's content: the `backgroundImage` style value. It names the picture by its asset ID,
 * never by address, so the library counts it as a use, a replacement or removal finds it, and only the generator
 * turns it into CSS, from the library's own record of the file (see generator/background.ts). No style string can
 * hold url() itself.
 */
import { formatFocus, parseFocus } from './focus';
import type { AssetRecord, BackgroundImageValue, StyleValue } from './types';

export const BACKGROUND_SIZES = ['cover', 'contain'] as const;
const KEYS = new Set(['assetId', 'size', 'position', 'scrim']);
const MAX_ASSET_ID = 200;
const MAX_SCRIM = 400;

/** Whether a stored style value is shaped as a background image (an object naming an asset, not a token). */
export function isBackgroundImageValue(v: unknown): v is BackgroundImageValue {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { assetId?: unknown }).assetId === 'string' && !('token' in v);
}

/**
 * Why a value is not a background image this property takes, or null when it is: exactly an `assetId`, with an
 * optional `size` (cover or contain), `position` (a focus keyword or "X% Y%") and `scrim` (checked by `scrimOk`:
 * a colour or one gradient). Whether the asset is a library image is checked against the project elsewhere.
 */
export function backgroundImageError(v: unknown, scrimOk: (s: string) => boolean): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Background image must be { "assetId": "..." } naming a library image, with optional size, position and scrim.';
  const extra = Object.keys(v).find((k) => !KEYS.has(k));
  if (extra !== undefined) return `Background image holds assetId, size, position and scrim only, not "${extra.slice(0, 40)}".`;
  const b = v as Record<string, unknown>;
  if (typeof b.assetId !== 'string' || !b.assetId.trim() || b.assetId.length > MAX_ASSET_ID) return 'Background image needs the assetId of a library image.';
  if (b.size !== undefined && !(BACKGROUND_SIZES as readonly unknown[]).includes(b.size)) return 'Background image size must be "cover" (fill the box, cropping) or "contain" (show the whole picture).';
  if (b.position !== undefined && parseFocus(b.position) === null) return 'Background image position must be center, top, bottom, left, right, or two percentages across and down such as "50% 20%".';
  if (b.scrim !== undefined && (typeof b.scrim !== 'string' || b.scrim.trim().length > MAX_SCRIM || (b.scrim.trim() !== '' && !scrimOk(b.scrim.trim()))))
    return 'Background image scrim must be a color such as rgba(0, 0, 0, 0.55) or #0008, or one linear-, radial- or conic-gradient().';
  return null;
}

/**
 * A background image as stored: its keys in one order, and nothing that says what is assumed anyway (cover, the
 * centre, no scrim), so equal choices compare equal. Assumes the value passed `backgroundImageError`.
 */
export function canonicalBackgroundImage(v: BackgroundImageValue): BackgroundImageValue {
  const out: BackgroundImageValue = { assetId: v.assetId };
  if (v.size === 'contain') out.size = 'contain';
  const focus = v.position === undefined ? null : parseFocus(v.position);
  const position = focus ? formatFocus(focus) : undefined;
  if (position && position !== '50% 50%') out.position = position;
  const scrim = typeof v.scrim === 'string' ? v.scrim.trim() : '';
  if (scrim) out.scrim = scrim;
  return out;
}

/** The focus a background image keeps in view, as "X% Y%". */
export function backgroundPosition(v: Pick<BackgroundImageValue, 'position'>): string {
  const focus = v.position === undefined ? null : parseFocus(v.position);
  return focus ? formatFocus(focus) : '50% 50%';
}

/** Whether a library record is a picture a background can show: an image, with an image file. */
export function isPictureAsset(a: Pick<AssetRecord, 'kind' | 'mime'> | null | undefined): boolean {
  return !!a && a.kind === 'image' && typeof a.mime === 'string' && a.mime.startsWith('image/');
}

/** Whether any rule in a set of styles holds a background image. */
export function hasBackgroundImage(styles: Partial<Record<string, Record<string, StyleValue> | undefined>> | undefined): boolean {
  if (!styles || typeof styles !== 'object') return false;
  return Object.values(styles).some((props) => !!props && typeof props === 'object' && props.backgroundImage !== undefined);
}
