import { useEffect, useState } from 'react';
import { api } from '../store';

/**
 * Thumbnails drawn when a theme pack was built, fetched from main once each. Packs only load at startup, so a
 * pack's files never change while the editor runs and every answer can be kept.
 */
const pending = new Map<string, Promise<string | null>>();
const ready = new Map<string, string | null>();

const keyOf = (packId: string, file: string) => `${packId}\n${file}`;

function load(packId: string, file: string): Promise<string | null> {
  const key = keyOf(packId, file);
  let p = pending.get(key);
  if (!p) {
    p = api.app
      .packPreview(packId, file)
      .catch(() => null)
      .then((url) => {
        ready.set(key, url);
        return url;
      });
    pending.set(key, p);
  }
  return p;
}

/** The data URL of a pack's preview image, or null while it loads or when there is none. */
export function usePackPreview(packId: string | undefined, file: string | undefined): string | null {
  const known = packId && file ? ready.get(keyOf(packId, file)) : null;
  const [url, setUrl] = useState<string | null>(known ?? null);
  useEffect(() => {
    if (!packId || !file) return setUrl(null);
    const key = keyOf(packId, file);
    if (ready.has(key)) return setUrl(ready.get(key)!);
    setUrl(null);
    let live = true;
    void load(packId, file).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [packId, file]);
  return url;
}
