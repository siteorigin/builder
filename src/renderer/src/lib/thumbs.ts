import type { AssetRecord } from '@shared/types';

/**
 * The file to show an image at a given size in the editor's own chrome (asset grid, pickers, previews): the
 * smallest generated copy that still has a pixel for every device pixel, else the original. Originals are never
 * touched; an asset with no copies (SVG, GIF, an animated PNG, an image small enough to need none) or an
 * unmeasured size gets the original. Used for browsing only, never for the canvas or the exported site.
 */
export function previewFile(a: Pick<AssetRecord, 'file' | 'width' | 'variants'>, cssWidth: number, dpr: number): string {
  const variants = a.variants;
  if (!variants?.length || !(cssWidth > 0)) return a.file;
  const need = Math.ceil(cssWidth * (dpr > 0 ? dpr : 1));
  // The original's own width counts as a candidate; unknown, it is only the last resort.
  const best = [...variants].sort((x, y) => x.width - y.width).find((v) => v.width >= need);
  if (!best) return a.file;
  return a.width && a.width >= need && a.width < best.width ? a.file : best.file;
}
