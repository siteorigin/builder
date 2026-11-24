/**
 * The arrival cue for an element just inserted (issue #509): it starts once, for the selection the insert made, when
 * the page reports that selection's own element in view, and never for a report from before the page had it, for
 * another selection, or after its wait ran out.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElementRef } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ARRIVAL_WAIT_MS, arrivalShown, endArrival, markArrival, takeArrival } from '../../src/renderer/src/lib/arrival';

const ref = (nodeId: string): ElementRef => ({ owner: { kind: 'page', id: 'home' }, instancePath: [], nodeId });
const desc = (node: string) => ({ ctx: 'page:home', node, items: '' });
const VIEW = { width: 900, height: 600, scrollY: 0 };

describe('arrival cue', () => {
  it('starts once, when the page shows the selection the insert made', () => {
    const added = ref('n1');
    markArrival(added, 0);
    // The page has not mounted it yet: still waiting.
    expect(takeArrival(added, false, 100)).toBe(false);
    expect(takeArrival(added, true, 200)).toBe(true);
    // Once only.
    expect(takeArrival(added, true, 300)).toBe(false);
  });

  it('ends for any other selection, even one naming the same element', () => {
    const added = ref('n1');
    markArrival(added, 0);
    expect(takeArrival(ref('n1'), true, 10)).toBe(false);
    // The author's next pick of the inserted element is no arrival either.
    expect(takeArrival(added, true, 20)).toBe(false);

    markArrival(added, 0);
    expect(takeArrival(null, false, 10)).toBe(false);
    expect(takeArrival(added, true, 20)).toBe(false);
  });

  it('ends when the page takes longer than its wait to show it', () => {
    const added = ref('n1');
    markArrival(added, 0);
    expect(takeArrival(added, true, ARRIVAL_WAIT_MS + 1)).toBe(false);
    expect(takeArrival(added, true, ARRIVAL_WAIT_MS + 2)).toBe(false);
  });

  it('ends when Preview starts, so Edit restoring the same selection after it shows no cue', () => {
    const added = ref('n1');
    markArrival(added, 0);
    endArrival();
    expect(takeArrival(added, true, 10)).toBe(false);
  });

  it('a second insert replaces the first', () => {
    const first = ref('n1');
    const second = ref('n2');
    markArrival(first, 0);
    markArrival(second, 10);
    expect(takeArrival(second, true, 20)).toBe(true);
    markArrival(first, 30);
    markArrival(second, 40);
    expect(takeArrival(first, true, 50)).toBe(false);
  });

  it('counts a report as showing the selection only for its own element, partly in the frame’s view', () => {
    const box = { x: 0, y: 500, width: 900, height: 400 };
    expect(arrivalShown(desc('n1'), desc('n1'), box, VIEW)).toBe(true);
    // A report measured for the previous selection, sent before the page was told of the new one, or for the same
    // node in another context (a component's part).
    expect(arrivalShown(desc('old'), desc('n1'), box, VIEW)).toBe(false);
    expect(arrivalShown({ ...desc('n1'), ctx: 'page:home|c1' }, desc('n1'), box, VIEW)).toBe(false);
    expect(arrivalShown(null, desc('n1'), box, VIEW)).toBe(false);
    // Measured, but not on the page yet, or not scrolled to yet.
    expect(arrivalShown(desc('n1'), desc('n1'), undefined, VIEW)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, y: 1800 }, VIEW)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, y: -400 }, VIEW)).toBe(false);
    // Beside the frame's view (a slide scrolled sideways out of it).
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, x: 900, width: 300 }, VIEW)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, x: -300, width: 300 }, VIEW)).toBe(false);
    // Items count, and a missing one is no items.
    expect(arrivalShown({ ctx: 'page:home', node: 'n1' }, desc('n1'), box, VIEW)).toBe(true);
    expect(arrivalShown({ ...desc('n1'), items: 'a' }, desc('n1'), box, VIEW)).toBe(false);
    // A frame that reports no usable size shows nothing.
    expect(arrivalShown(desc('n1'), desc('n1'), box, null)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), box, { width: '900', height: 600 })).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { x: 0, y: -10, width: 900, height: 20 }, { width: 900, height: 0 })).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), box, { width: -1, height: 600 })).toBe(false);
  });
});

describe('arrival cue and Preview', () => {
  it('Preview ends a waiting cue, so Edit restoring the very same selection after it shows none', async () => {
    // The editor's store and actions are DOM code, outside this test project's types: loaded by path, with a stand-in
    // for the preload bridge and just the shapes used here.
    vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => ({ ok: true }) } } });
    try {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { setMode } = (await load('../../src/renderer/src/lib/actions')) as { setMode: (m: 'edit' | 'preview') => void };
      const { getState, setState } = (await load('../../src/renderer/src/store')) as {
        getState: () => { selection: ElementRef | null; mode: string };
        setState: (s: Record<string, unknown>) => void;
      };
      const state = createStarterState('business', 'Studio', false);
      const page = state.pages[state.site.homePageId];
      const added: ElementRef = { owner: { kind: 'page', id: page.id }, instancePath: [], nodeId: page.rootIds[0] };
      const snapshot = { state, revision: 1, workspaceKey: 'w' } as unknown as ProjectSnapshot;
      setState({ snapshot, pageId: page.id, mode: 'edit', selection: added, definitionMode: null });
      markArrival(added);
      setMode('preview');
      setMode('edit');
      // Edit brings back the selection Preview was entered with: the same object the cue was waiting for.
      expect(getState().selection).toBe(added);
      expect(takeArrival(getState().selection, true)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
