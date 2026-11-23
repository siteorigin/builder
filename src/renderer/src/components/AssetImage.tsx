import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import type { AssetRecord } from '@shared/types';
import { assetUrl } from '../lib/model';
import { previewFile } from '../lib/thumbs';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'> & {
  asset: Pick<AssetRecord, 'file' | 'width' | 'height' | 'variants'>;
  devUrl: string;
  /** Used until the image's box has been measured, and when it measures as nothing. */
  fallbackWidth: number;
  /** The tallest the image may render (CSS px). With the asset's shape this caps the width it can reach. */
  maxHeight?: number;
};

/**
 * An editor-side picture sized for where it is shown: it measures the box it lives in, multiplies by the device
 * pixel ratio and loads the smallest generated copy that covers that (the original when there is none, or when
 * the copy fails to load). It loads nothing before it has measured, so a lazy tile never fetches the big file.
 */
export function AssetImage({ asset, devUrl, fallbackWidth, maxHeight, onError, ...rest }: Props) {
  const ref = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setBox(parent.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  let width = box || fallbackWidth;
  if (maxHeight && asset.width && asset.height) width = Math.min(width, (maxHeight * asset.width) / asset.height);
  const chosen = previewFile(asset, width, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  // A copy that fails to load (missing from the folder) is replaced by the original, which is always kept.
  const file = chosen === failed ? asset.file : chosen;
  return (
    <img
      ref={ref}
      {...rest}
      src={box === null ? undefined : assetUrl(devUrl, file) ?? undefined}
      onError={(e) => {
        if (file !== asset.file) setFailed(file);
        else onError?.(e);
      }}
    />
  );
}
