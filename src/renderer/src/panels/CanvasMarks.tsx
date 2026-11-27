import { useMemo, type CSSProperties } from 'react';
import { MapPin } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import { getState, useStore, type Rect, type State } from '../store';
import { selectPage } from '../lib/actions';
import { presenceOf } from '../lib/live-host';
import { canvasMarks, livePeers, peerColor, type CanvasMark, type SpotlightAway } from '../lib/live-marks';
import { descOf, type BridgeDesc } from '../lib/model';

/**
 * The others in a live session, on the canvas (#768): each collaborator's selection outlined in their color with
 * their name, an edit one just made, and the ring a guest's spotlight flashes where it pointed. Drawn under the
 * editor's own outlines and never in the way of them: nothing here takes a click but the prompt to go to the page a
 * guest pointed at on another page. None of it is part of the page, or of the site it exports.
 */

const NONE: { marks: CanvasMark[]; away: SpotlightAway[] } = { marks: [], away: [] };

/** What the canvas shows of the others now, from the editor's state. */
export function marksNow(s: State): { marks: CanvasMark[]; away: SpotlightAway[] } {
  const state = s.snapshot?.state;
  if (!state) return NONE;
  const peers = livePeers(s);
  if (!peers.length) return NONE;
  const at = presenceOf(s);
  return canvasMarks(state, { pageId: at.pageId, previewPath: at.previewPath }, peers);
}

/** What the canvas shows of the others, kept while it is the same: the canvas redraws only when it changes. */
export function useCanvasMarks(): { marks: CanvasMark[]; away: SpotlightAway[] } {
  const key = useStore((s) => {
    const now = marksNow(s);
    return now === NONE ? '' : JSON.stringify(now);
  });
  return useMemo(() => (key ? (JSON.parse(key) as typeof NONE) : NONE), [key]);
}

/** The marks for the page to measure (see `track`): each element as the page names it, and each spotlight's point. */
export function trackedMarks(state: ProjectState, marks: CanvasMark[]): Array<{ key: string; desc: BridgeDesc | null; point: { x: number; y: number } | null }> {
  return marks.map((m) => {
    let desc: BridgeDesc | null = null;
    try {
      desc = m.ref ? descOf(state, m.ref) : null;
    } catch {
      desc = null;
    }
    return { key: m.key, desc, point: m.point };
  });
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * The outlines, in the overlay over the page. `boxes` are what the page last measured for each mark, by key, and
 * `toBox` places one on the canvas; `height` is how much of the page shows, on the canvas, so a spotlight off it is
 * named at the edge it is past.
 */
export function PeerMarks({ marks, boxes, toBox, height }: { marks: CanvasMark[]; boxes: Record<string, Rect>; toBox: (r: Rect) => Box; height: number }) {
  // Names on the same element share one row of tags, so two people on one heading are both read.
  const shown = marks.flatMap((m) => (Object.hasOwn(boxes, m.key) ? [{ m, b: toBox(boxes[m.key]) }] : []));
  const rows = new Map<string, Array<{ m: CanvasMark; b: Box }>>();
  for (const one of shown) {
    const at = one.m.kind === 'spotlight' && !one.b.width && !one.b.height ? `p:${one.m.key}` : `${one.b.left},${one.b.top},${one.b.width},${one.b.height}`;
    rows.set(at, [...(rows.get(at) ?? []), one]);
  }
  return (
    <div className="ov-peers" aria-hidden="true">
      {shown.map(({ m, b }) => {
        const point = !b.width && !b.height;
        const style = { ...b, '--peer': peerColor(m.color) } as CSSProperties;
        if (m.kind === 'spotlight' && point) return <div key={m.key} className="ov-spot-dot" style={{ left: b.left, top: b.top, '--peer': peerColor(m.color) } as CSSProperties} title={m.label} data-peer={m.peer} />;
        return <div key={m.key} className={`ov-peer ${m.kind}${m.editing ? ' editing' : ''}`} style={style} title={m.label} data-peer={m.peer} />;
      })}
      {[...rows.values()].map((row) => {
        const { b } = row[0];
        const point = !b.width && !b.height;
        // Past the top or bottom of what shows, the names wait at that edge with an arrow.
        const above = b.top + b.height < 0;
        const below = b.top > height;
        const edge = above ? 'top' : below ? 'bottom' : null;
        const top = edge === 'top' ? 4 : edge === 'bottom' ? height - 24 : point ? b.top + 16 : b.top >= 24 ? b.top - 23 : b.top + b.height + 3;
        return (
          <span key={row[0].m.key} className={`ov-peer-tags${edge ? ` edge ${edge}` : ''}`} style={{ left: Math.max(0, point ? b.left - 8 : b.left), top }}>
            {row.map(({ m }) => (
              <span key={m.key} className={`ov-peer-tag ${m.kind}`} style={{ '--peer': peerColor(m.color) } as CSSProperties} data-peer={m.peer}>
                {edge === 'top' ? '↑ ' : edge === 'bottom' ? '↓ ' : ''}
                {m.kind === 'edit' ? `${m.who} edited` : m.editing ? `${m.who} · editing` : m.who}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A guest pointed at a place other than the one the canvas shows: who, where, and a way there when it is a page of
 * the project. Once there, the spotlight shows on the canvas while it lasts.
 */
export function SpotlightPrompts({ away }: { away: SpotlightAway[] }) {
  if (!away.length) return null;
  return (
    <div className="peer-away" data-testid="spotlight-away">
      {away.map((a) => (
        <div key={a.key} className="peer-away-row" style={{ '--peer': peerColor(a.color) } as CSSProperties}>
          <MapPin aria-hidden="true" />
          <span className="ellipsis">
            <strong>{a.who}</strong> pointed at {a.place}
          </span>
          {a.pageId && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={(e) => {
                // Still the place pointed at, on a page the project still has, when the button is pressed.
                const now = marksNow(getState()).away.find((x) => x.key === a.key);
                if (!now?.pageId || !Object.hasOwn(getState().snapshot?.state.pages ?? {}, now.pageId)) return;
                // There, the prompt gives way to the ring: focus goes to the canvas rather than with the button.
                const canvasEl = e.currentTarget.closest<HTMLElement>('.canvas');
                selectPage(now.pageId);
                canvasEl?.focus({ preventScroll: true });
              }}
            >
              Go to page
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** What a screen reader hears of the others: the newest spotlight, said once. */
export function marksAnnouncement(marks: CanvasMark[], away: SpotlightAway[]): string {
  const spot = marks.filter((m) => m.kind === 'spotlight').at(-1);
  if (spot) return spot.label;
  const elsewhere = away.at(-1);
  return elsewhere ? `${elsewhere.who} pointed at ${elsewhere.place}` : '';
}
