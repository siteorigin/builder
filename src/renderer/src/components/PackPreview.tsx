import { useEffect, useState } from 'react';
import { api } from '../store';

/**
 * Thumbnails drawn when a theme pack was built, fetched from main once each. Packs only load at startup, so a
 * pack's files never change while the editor runs and every image can be kept; a request that failed is tried
 * again the next time a tile asks for it.
 */
const pending = new Map<string, Promise<string | null>>();
const ready = new Map<string, string>();

const keyOf = (packId: string, file: string) => `${packId}\n${file}`;

function load(packId: string, file: string): Promise<string | null> {
  const key = keyOf(packId, file);
  let p = pending.get(key);
  if (!p) {
    p = api.app
      .packPreview(packId, file)
      .catch(() => null)
      .then((url) => {
        if (url) ready.set(key, url);
        pending.delete(key);
        return url;
      });
    pending.set(key, p);
  }
  return p;
}

/**
 * Where a preview's content ends, as a share of its height. A thumbnail shows the top of the section in a fixed
 * 16:10 frame, so a short section (a row of figures, a strip of logos) is followed by its own empty background down to
 * the frame's edge. The rows that match the bottom row's colour are that background.
 */
const extents = new Map<string, number>();
function measure(url: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(1);
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (!g || !w || !h) return resolve(1);
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, w, h).data;
        const b = (h - 1) * w * 4;
        for (let y = h - 1; y >= 0; y--)
          for (let x = 0; x < w; x += 2) {
            const i = (y * w + x) * 4;
            // A clear difference from the background, not compression noise.
            if (Math.abs(px[i] - px[b]) + Math.abs(px[i + 1] - px[b + 1]) + Math.abs(px[i + 2] - px[b + 2]) > 36) return resolve((y + 1) / h);
          }
        // Background all the way up: an empty section.
        resolve(0);
      } catch {
        resolve(1);
      }
    };
    img.src = url;
  });
}

/** How far down a loaded preview its content reaches (0 to 1); 1 until it is known. */
export function usePreviewExtent(packId: string | undefined, file: string | undefined, url: string | null): number {
  const key = packId && file && url ? keyOf(packId, file) : null;
  const [got, setGot] = useState<{ key: string; extent: number } | null>(null);
  useEffect(() => {
    if (!key || !url || extents.has(key)) return;
    let live = true;
    void measure(url).then((extent) => {
      extents.set(key, extent);
      if (live) setGot({ key, extent });
    });
    return () => {
      live = false;
    };
  }, [key, url]);
  if (!key) return 1;
  return extents.get(key) ?? (got?.key === key ? got.extent : 1);
}

/** The data URL of a pack's preview image, or null while it loads or when there is none. */
export function usePackPreview(packId: string | undefined, file: string | undefined): string | null {
  const key = packId && file ? keyOf(packId, file) : null;
  // The answer is kept with the preview it is for, so a tile that now shows another preview never shows the last one's.
  const [got, setGot] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!packId || !file || !key || ready.has(key)) return;
    let live = true;
    void load(packId, file).then((url) => {
      if (live) setGot({ key, url });
    });
    return () => {
      live = false;
    };
  }, [packId, file, key]);
  if (!key) return null;
  return ready.get(key) ?? (got?.key === key ? got.url : null);
}
