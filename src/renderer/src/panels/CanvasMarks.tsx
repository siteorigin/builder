import { useMemo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { MapPin } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import { getState, useStore, type Rect, type State } from '../store';
import { selectPage } from '../lib/actions';
import { presenceOf } from '../lib/live-host';
import { canvasMarks, livePeers, peerColor, type CanvasMark, type SpotlightAway } from '../lib/live-marks';
import { descOf, type BridgeDesc } from '../lib/model';
import { activeWorkspace, canvasCovered } from '../lib/workspace';

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
 * `toBox` places one on the canvas; `width` and `height` are how much of the page shows, on the canvas, so a mark off
 * it is named at the edge it is past: every name past one edge in one row there, so none hides another.
 */
export function PeerMarks({ marks, boxes, toBox, width, height }: { marks: CanvasMark[]; boxes: Record<string, Rect>; toBox: (r: Rect) => Box; width: number; height: number }) {
  const shown = marks.flatMap((m) => (Object.hasOwn(boxes, m.key) ? [{ m, b: toBox(boxes[m.key]) }] : []));
  type Edge = 'top' | 'bottom' | 'left' | 'right';
  const edgeOf = (b: Box): Edge | null => (b.top + b.height < 0 ? 'top' : b.top > height ? 'bottom' : b.left + b.width < 0 ? 'left' : b.left > width ? 'right' : null);
  // Names on the same element share one row of tags, so two people on one heading are both read; names past an edge
  // share that edge's row.
  const rows = new Map<string, { edge: Edge | null; items: Array<{ m: CanvasMark; b: Box }> }>();
  for (const one of shown) {
    const edge = edgeOf(one.b);
    const at = edge ? `edge:${edge}` : one.m.kind === 'spotlight' && !one.b.width && !one.b.height ? `p:${one.m.key}` : `${one.b.left},${one.b.top},${one.b.width},${one.b.height}`;
    const row = rows.get(at) ?? { edge, items: [] };
    row.items.push(one);
    rows.set(at, row);
  }
  const ARROWS: Record<Edge, string> = { top: '↑ ', bottom: '↓ ', left: '← ', right: '→ ' };
  return (
    <div className="ov-peers" aria-hidden="true">
      {shown.map(({ m, b }) => {
        const point = !b.width && !b.height;
        // A new edit or spotlight is drawn afresh, so its pulse plays from the start.
        const key = `${m.key}#${m.seq}`;
        if (m.kind === 'spotlight' && point) return <div key={key} className="ov-spot-dot" style={{ left: b.left, top: b.top, '--peer': peerColor(m.color) } as CSSProperties} title={m.label} data-peer={m.peer} />;
        return <div key={key} className={`ov-peer ${m.kind}${m.editing ? ' editing' : ''}`} style={{ ...b, '--peer': peerColor(m.color) } as CSSProperties} title={m.label} data-peer={m.peer} />;
      })}
      {[...rows.entries()].map(([at, { edge, items }]) => {
        const { b } = items[0];
        const point = !b.width && !b.height;
        const top = edge === 'top' ? 4 : edge === 'bottom' ? height - 24 : edge ? Math.min(Math.max(4, b.top), height - 24) : point ? b.top + 16 : b.top >= 24 ? b.top - 23 : b.top + b.height + 3;
        const place = edge === 'left' ? { left: 4 } : edge === 'right' ? { right: 4 } : edge ? {} : { left: Math.min(Math.max(0, point ? b.left - 8 : b.left), Math.max(0, width - 120)) };
        return (
          <span key={at} className={`ov-peer-tags${edge ? ` edge ${edge}` : ''}`} style={{ ...place, top }}>
            {items.map(({ m }) => (
              <span key={m.key} className={`ov-peer-tag ${m.kind}`} style={{ '--peer': peerColor(m.color) } as CSSProperties} data-peer={m.peer}>
                {edge ? ARROWS[edge] : ''}
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
  // While the post writer or another workspace covers the canvas, the prompt shows over it, where it can be seen and used.
  const covered = useStore((s) => canvasCovered(activeWorkspace(s)));
  if (!away.length) return null;
  const prompts = (
    <div className={`peer-away${covered ? ' floating' : ''}`} data-testid="spotlight-away">
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
  return covered ? createPortal(prompts, document.body) : prompts;
}

/** What a screen reader hears of the others: the newest spotlight, here or elsewhere, said once. */
export function marksAnnouncement(marks: CanvasMark[], away: SpotlightAway[]): string {
  const said = [...marks.filter((m) => m.kind === 'spotlight').map((m) => ({ seq: m.seq, text: m.label })), ...away.map((a) => ({ seq: a.seq, text: `${a.who} pointed at ${a.place}` }))];
  return said.sort((a, b) => b.seq - a.seq)[0]?.text ?? '';
}
