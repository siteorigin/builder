import { useEffect, useState, type ReactNode } from 'react';
import { ImageIcon } from 'lucide-react';
import type { AssetRecord } from '@shared/types';
import { AssetImage } from './AssetImage';

/** Logos, banners and extreme shapes are shown whole; ordinary photos fill the tile. Formats that can be
 *  transparent get a checker behind the picture itself, so it shows only through transparent pixels. */
export function fitFor(a: AssetRecord): { contain: boolean; alpha: boolean } {
  const ratio = a.width && a.height ? a.width / a.height : 1;
  return { contain: a.mime === 'image/svg+xml' || ratio > 1.8 || ratio < 0.56, alpha: /svg|png|webp|gif|avif/.test(a.mime) };
}

/**
 * The picture, once it has loaded, from the local preview server: it never leaves this computer. The transparency
 * checker waits for it, and a file that will not load (or a preview that is not running yet) shows a glyph, or
 * `fallback` where the frame is large enough to say why.
 */
export function Picture({ a, devUrl, lazy, maxHeight, original, fallback }: { a: AssetRecord; devUrl: string | null; lazy?: boolean; maxHeight?: number; original?: boolean; fallback?: ReactNode }) {
  const [load, setLoad] = useState<'wait' | 'ok' | 'error'>('wait');
  useEffect(() => setLoad('wait'), [a.file, devUrl]);
  if (!devUrl || load === 'error') return fallback ?? <ImageIcon className="asset-noimg" aria-hidden="true" />;
  // Browsed at the size it is shown: a tile loads a small copy, a framed preview (`maxHeight` is the tallest it
  // gets) a larger one. `original` is for looking closely. The original file is kept either way.
  return (
    <AssetImage
      asset={a}
      devUrl={devUrl}
      cover={lazy && !fitFor(a).contain}
      original={original}
      maxHeight={maxHeight}
      className={fitFor(a).alpha && load === 'ok' ? 'alpha' : undefined}
      alt=""
      loading={lazy ? 'lazy' : undefined}
      draggable={false}
      onLoad={() => setLoad('ok')}
      onError={() => setLoad('error')}
    />
  );
}

/** A square tile of the picture. An image no longer in the project shows the glyph. */
export function Thumb({ a, devUrl }: { a: AssetRecord | null | undefined; devUrl: string | null }) {
  if (!a)
    return (
      <span className="asset-thumb">
        <ImageIcon className="asset-noimg" aria-hidden="true" />
      </span>
    );
  return (
    <span className={`asset-thumb${fitFor(a).contain ? ' contain' : ''}`}>
      <Picture a={a} devUrl={devUrl} lazy />
    </span>
  );
}
