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
