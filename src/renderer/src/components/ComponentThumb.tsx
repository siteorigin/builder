import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ComponentThumb as Thumb } from '@shared/component-thumbs';
import { api, useStore } from '../store';

/**
 * Thumbnails of the project's own components in Insert, photographed by main from each one's isolated preview and
 * kept in the project's editor cache. Each is asked for while its tile is in view in the open panel, and again after
 * a change to the project (the component, what it places, the site's brand) once it is in view: main answers at once
 * when nothing that shows changed. A tile out of view asks for nothing. A tile keeps its last picture while a new one
 * is drawn, and shows a sketch until there is one, or when the component cannot be pictured (code that throws).
 */
const shown = new Map<string, { key: string; url: string }>();
const failed = new Set<string>();
/**
 * The revision each tile's picture was last given for: main worked it out from the project at that revision, so a
 * tile shown again before the next change has nothing to ask. A failure is not kept here: main tries one that may not
 * have been the component's doing again on another preview server, so a tile that failed asks whenever it is shown.
 */
const checked = new Map<string, number>();
/** The opening the pictures above are of: another one starts afresh. */
let shownOpening: string | null = null;

/** How long a change rests before its thumbnails are asked for, so typing or dragging a colour asks once. */
const SETTLE_MS = 500;
/** When a thumbnail that could not be drawn just now is asked for again, while nothing changes. */
const RETRY_MS = [3000, 10000];

/** Forget the pictures of the project that closed: none is kept at Welcome. */
export function forgetComponentThumbs() {
  shownOpening = null;
  shown.clear();
  failed.clear();
  checked.clear();
}

function thumbState(opening: string | undefined, definitionId: string) {
  if (opening && opening !== shownOpening) {
    shownOpening = opening;
    shown.clear();
    failed.clear();
    checked.clear();
  }
  const id = `${opening ?? ''}\n${definitionId}`;
  return { id, picture: shown.get(id) ?? null, failed: failed.has(id) };
}

/** One observer for every tile: whether some of it is on screen (not scrolled away, not in a hidden panel). */
let observer: IntersectionObserver | null = null;
const watched = new Map<Element, (seen: boolean) => void>();

function watch(el: Element, seen: (on: boolean) => void): () => void {
  // Without an observer (an old engine), every tile counts as in view, as before there was one.
  if (typeof IntersectionObserver === 'undefined') {
    seen(true);
    return () => undefined;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) watched.get(e.target)?.(e.isIntersecting);
  });
  watched.set(el, seen);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}

/** Whether some of the element is in view: inside the scrolled part of its panel and the window, and not hidden. */
function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watch(el, setSeen);
  }, [ref]);
  return seen;
}

/**
 * A project component's thumbnail (a data URL), whether it cannot be pictured, asked for while `active` (the panel is
 * open and the tile in view) and not yet given for the project's revision.
 */
function useComponentThumb(definitionId: string, active: boolean): { url: string | null; failed: boolean } {
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const revision = useStore((s) => s.snapshot?.revision);
  const ready = useStore((s) => s.runtime.state === 'ready');
  const [, redraw] = useState(0);
  const { id, picture, failed: broken } = thumbState(opening, definitionId);
  useEffect(() => {
    if (!active || !ready || !opening || revision === undefined) return;
    // Given for the project as it is now already: scrolled back into view, or the panel shown again, it asks nothing.
    if (checked.get(id) === revision && picture) return;
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
            checked.set(id, revision);
          } else if (r.state === 'failed') {
            // The sketch, rather than a picture of an earlier version that no longer shows what it does.
            shown.delete(id);
            failed.add(id);
            checked.delete(id);
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
  const tile = useRef<HTMLSpanElement>(null);
  const seen = useInView(tile);
  const { url, failed } = useComponentThumb(definitionId, active && seen);
  const [broken, setBroken] = useState<string | null>(null);
  const shot = url && url !== broken ? url : null;
  return (
    <span ref={tile} className="insert-lib-thumb component-thumb" aria-hidden="true" data-definition-id={definitionId} data-thumb={shot ? 'ready' : failed ? 'failed' : 'pending'}>
      {shot ? <img className="insert-shot" src={shot} alt="" draggable={false} onError={() => setBroken(shot)} /> : fallback}
    </span>
  );
}
