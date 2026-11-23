import type { AssetRecord } from '@shared/types';

/**
 * The file to show an image at a given size in the editor's own chrome (asset grid, pickers, previews): the
 * smallest generated copy that still has a pixel for every device pixel, else the original. Originals are never
 * touched; an asset with no copies (SVG, GIF, an animated PNG, an image small enough to need none) or an
 * unmeasured size gets the original. Used for browsing only, never for the canvas or the exported site.
 * `failed` lists copies that did not load (one missing from the folder); the next larger one is tried, then the original.
 */
export function previewFile(a: Pick<AssetRecord, 'file' | 'width' | 'variants'>, cssWidth: number, dpr: number, failed?: ReadonlySet<string>): string {
  const variants = (a.variants ?? []).filter((v) => !failed?.has(v.file));
  if (!variants.length || !(cssWidth > 0)) return a.file;
  const need = Math.ceil(cssWidth * (dpr > 0 ? dpr : 1));
  const best = [...variants].sort((x, y) => x.width - y.width).find((v) => v.width >= need);
  if (!best) return a.file;
  // The original is the better pick when it is already large enough and smaller than the copy chosen.
  return a.width && a.width >= need && a.width < best.width ? a.file : best.file;
}

/**
 * The width a picture must have to cover its box: a cropped (object-fit: cover) picture fills the box in both
 * directions, so a wide panorama in a small box needs the width its height implies, not the box's width.
 */
export function coverWidth(box: { width: number; height: number }, asset: Pick<AssetRecord, 'width' | 'height'>): number {
  if (!asset.width || !asset.height) return box.width;
  return Math.max(box.width, (box.height * asset.width) / asset.height);
}
