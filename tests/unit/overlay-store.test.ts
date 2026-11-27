/**
 * The canvas's per-frame state (#969): what the pointer is over and where the page's outlines are live apart from the
 * editor's store, so a report the page sends every frame while it scrolls, or the pointer reaching another element,
 * runs no selector of the editor's store and wakes none of its listeners.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ElementRef } from '../../src/shared/types';

type Box = { x: number; y: number; width: number; height: number };
type Rects = { selected: Box[]; hovered: Box[]; revealed: Box[]; headers: Box[] };
interface OverlayState {
  hover: ElementRef | null;
  rects: Rects;
}
/** What the test uses of the editor's store (src/renderer/src/store.ts), which is the renderer's, outside this project. */
interface Store {
  getState(): Record<string, unknown>;
  useStore: { subscribe(listener: () => void): () => void; setState(p: Record<string, unknown>): void };
  getOverlay(): OverlayState;
  setOverlay(p: Partial<OverlayState>): void;
  selectedRatio(s: OverlayState): number | null;
}
const STORE = '../../src/renderer/src/store';
let store: Store;
beforeAll(async () => {
  store = (await import(/* @vite-ignore */ STORE)) as Store;
});

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const rects = (selected: Box[]): Rects => ({ selected, hovered: [box(0, 0, 10, 10)], revealed: [], headers: [] });
const hero: ElementRef = { owner: { kind: 'page', id: 'home' }, instancePath: [], nodeId: 'hero' };

describe('the canvas overlay’s state', () => {
  it('changes without telling the editor’s store, whose state holds none of it', () => {
    const { getState, useStore, getOverlay, setOverlay } = store;
    let heard = 0;
    const off = useStore.subscribe(() => heard++);
    try {
      const before = getState();
      for (let y = 0; y < 30; y++) setOverlay({ rects: rects([box(0, -y * 60, 1200, 600)]) });
      setOverlay({ hover: hero });
      setOverlay({ hover: null });
      expect(heard).toBe(0);
      expect(getState()).toBe(before);
      expect('hover' in before || 'rects' in before).toBe(false);
      expect(getOverlay().rects.selected).toEqual([box(0, -29 * 60, 1200, 600)]);
      // And the other way: a change to the editor's state leaves the overlay's as it was.
      const drawn = getOverlay();
      useStore.setState({ zoom: 0.5 });
      expect(heard).toBe(1);
      expect(getOverlay()).toBe(drawn);
    } finally {
      off();
      setOverlay({ hover: null, rects: { selected: [], hovered: [], revealed: [], headers: [] } });
    }
  });

  it('gives the selection’s shape, which a scroll leaves as it is', () => {
    const { selectedRatio } = store;
    expect(selectedRatio({ hover: null, rects: rects([box(0, 0, 200, 100)]) })).toBe(2);
    expect(selectedRatio({ hover: null, rects: rects([box(0, -480, 200, 100), box(0, 0, 50, 50)]) })).toBe(2);
    // Nothing to measure: no box, or one with no size.
    expect(selectedRatio({ hover: null, rects: rects([]) })).toBeNull();
    expect(selectedRatio({ hover: null, rects: rects([box(0, 0, 200, 0)]) })).toBeNull();
  });
});
