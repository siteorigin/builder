import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import type { AssetRecord } from '@shared/types';
import { assetUrl } from '../lib/model';
import { coverWidth, previewFile } from '../lib/thumbs';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'> & {
  asset: Pick<AssetRecord, 'file' | 'width' | 'height' | 'variants'>;
  devUrl: string;
  /**
   * `cover`: the picture is cropped to fill its own box, so that box (both sides) is what it must cover.
   * Otherwise it is shown whole inside its container, and the container's width (capped by `maxHeight`) is.
   */
  cover?: boolean;
  /** Deliberate inspection: always the original file, whatever size it is shown at. */
  original?: boolean;
  /** The tallest the picture may render (CSS px). With its shape this caps the width it can reach. */
  maxHeight?: number;
};

/** The device pixel ratio, kept current when the window moves to a screen with another one. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    // It may have changed between rendering and subscribing.
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [dpr]);
  return dpr;
}

/**
 * An editor-side picture sized for where it is shown: it measures its box, multiplies by the device pixel ratio
 * and loads the smallest generated copy that covers that (the original when there is none). A copy that fails to
 * load is skipped for the next one, ending at the original. It loads nothing until it has been measured with a
 * size, so a lazy tile or a hidden panel never fetches the big file, and a hidden panel keeps its last size.
 */
export function AssetImage({ asset, devUrl, cover, original, maxHeight, onError, ...rest }: Props) {
  const ref = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const dpr = useDevicePixelRatio();
  // Copies that failed, only for the set of copies they were found in: a repaired folder starts again.
  const key = `${asset.file}\n${(asset.variants ?? []).map((v) => v.file).join('\n')}`;
  const [failed, setFailed] = useState<{ key: string; files: ReadonlySet<string> }>({ key, files: new Set() });
  useLayoutEffect(() => {
    const el = cover ? ref.current : ref.current?.parentElement;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight >= 0) setBox((b) => (b && b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cover]);
  let file = asset.file;
  if (box && !original) {
    let width = cover ? coverWidth(box, asset) : box.width;
    if (maxHeight && asset.width && asset.height) width = Math.min(width, (maxHeight * asset.width) / asset.height);
    file = previewFile(asset, width, dpr, failed.key === key ? failed.files : undefined);
  }
  return (
    <img
      ref={ref}
      {...rest}
      src={box || original ? (assetUrl(devUrl, file) ?? undefined) : undefined}
      onError={(e) => {
        if (file !== asset.file) setFailed((f) => ({ key, files: new Set([...(f.key === key ? f.files : []), file]) }));
        else onError?.(e);
      }}
    />
  );
}
