/**
 * The arrival cue for an element just inserted (issue #509): it starts once, for the selection the insert made, when
 * the page reports that selection's own element in view, and never for a report from before the page had it, for
 * another selection, or after its wait ran out.
 */
import { describe, expect, it } from 'vitest';
import type { ElementRef } from '@shared/types';
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
    expect(takeArrival(first, true, 20)).toBe(false);
    markArrival(second, 30);
    expect(takeArrival(second, true, 40)).toBe(true);
  });

  it('counts a report as showing the selection only for its own element, partly in the frame’s view', () => {
    const box = { x: 0, y: 500, width: 900, height: 400 };
    expect(arrivalShown(desc('n1'), desc('n1'), box, VIEW)).toBe(true);
    // A report measured for the previous selection, sent before the page was told of the new one.
    expect(arrivalShown(desc('old'), desc('n1'), box, VIEW)).toBe(false);
    expect(arrivalShown(null, desc('n1'), box, VIEW)).toBe(false);
    // Measured, but not on the page yet, or not scrolled to yet.
    expect(arrivalShown(desc('n1'), desc('n1'), undefined, VIEW)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, y: 1800 }, VIEW)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), { ...box, y: -400 }, VIEW)).toBe(false);
    // Items count, and a missing one is no items.
    expect(arrivalShown({ ctx: 'page:home', node: 'n1' }, desc('n1'), box, VIEW)).toBe(true);
    expect(arrivalShown({ ...desc('n1'), items: 'a' }, desc('n1'), box, VIEW)).toBe(false);
    // A frame that reports no usable size shows nothing.
    expect(arrivalShown(desc('n1'), desc('n1'), box, null)).toBe(false);
    expect(arrivalShown(desc('n1'), desc('n1'), box, { width: '900', height: 600 })).toBe(false);
  });
});
