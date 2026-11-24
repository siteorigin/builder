import { useEffect, useState, type ReactNode } from 'react';
import type { ComponentThumb as Thumb } from '@shared/component-thumbs';
import { api, useStore } from '../store';

/**
 * Thumbnails of the project's own components in Insert, photographed by main from each one's isolated preview and
 * kept in the project's editor cache. Each is asked for while its tile is shown in the open panel, and again after
 * a change to the project (the component, what it places, the site's brand): main answers at once when nothing that
 * shows changed. A tile keeps its last picture while a new one is drawn, and shows a sketch until there is one, or
 * when the component cannot be pictured (code that throws).
 */
const shown = new Map<string, { key: string; url: string }>();
const failed = new Set<string>();
/** The opening the pictures above are of: another one starts afresh. */
let shownOpening: string | null = null;

/** How long a change rests before its thumbnails are asked for, so typing or dragging a colour asks once. */
const SETTLE_MS = 500;
/** When a thumbnail that could not be drawn just now is asked for again, while nothing changes. */
const RETRY_MS = [3000, 10000];

function thumbState(opening: string | undefined, definitionId: string) {
  if (opening && opening !== shownOpening) {
    shownOpening = opening;
    shown.clear();
    failed.clear();
  }
  const id = `${opening ?? ''}\n${definitionId}`;
  return { id, picture: shown.get(id) ?? null, failed: failed.has(id) };
}

/** A project component's thumbnail (a data URL), whether it cannot be pictured, asked for while `active`. */
function useComponentThumb(definitionId: string, active: boolean): { url: string | null; failed: boolean } {
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const revision = useStore((s) => s.snapshot?.revision);
  const ready = useStore((s) => s.runtime.state === 'ready');
  const [, redraw] = useState(0);
  const { id, picture, failed: broken } = thumbState(opening, definitionId);
  useEffect(() => {
    if (!active || !ready || !opening) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const ask = () => {
      const have = shown.get(id);
      api.project.componentThumb(definitionId, opening, have?.key).then(
        (r: Thumb) => {
          if (!live || shownOpening !== opening) return;
          if (r.state === 'ready') {
            const url = r.url ?? (have?.key === r.key ? have.url : undefined);
            if (!url) return;
            shown.set(id, { key: r.key, url });
            failed.delete(id);
          } else if (r.state === 'failed') {
            // The sketch, rather than a picture of an earlier version that no longer shows what it does.
            shown.delete(id);
            failed.add(id);
          } else {
            // Not now (the picture failed by chance, or the preview was busy): asked again a little later, a few times.
            if (retries < RETRY_MS.length) timer = setTimeout(ask, RETRY_MS[retries++]);
            return;
          }
          redraw((n) => n + 1);
        },
        () => undefined
      );
    };
    // A tile with no picture yet asks at once.
    timer = setTimeout(ask, picture ? SETTLE_MS : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, ready, opening, revision, definitionId, id]);
  return { url: picture?.url ?? null, failed: broken };
}

/** A project component's thumbnail in Insert. Its design sketch stands in while it draws. */
export function ComponentThumb({ definitionId, active, fallback }: { definitionId: string; active: boolean; fallback: ReactNode }) {
  const { url, failed } = useComponentThumb(definitionId, active);
  const [broken, setBroken] = useState<string | null>(null);
  const shot = url && url !== broken ? url : null;
  return (
    <span className="insert-lib-thumb component-thumb" aria-hidden="true" data-thumb={shot ? 'ready' : failed ? 'failed' : 'pending'}>
      {shot ? <img className="insert-shot" src={shot} alt="" draggable={false} onError={() => setBroken(shot)} /> : fallback}
    </span>
  );
}
