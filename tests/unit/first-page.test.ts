/**
 * The canvas outlines a project's first page while the preview starts and the page loads, continuing the outline the
 * window showed from the click on the project's card, and hands over to a card for any wait with something to say.
 */
import { describe, expect, it } from 'vitest';
import { outlinesFirstPage, type FirstPageWait } from '../../src/renderer/src/lib/first-page';

const wait = (over: Partial<FirstPageWait>): FirstPageWait => ({ pending: true, runtime: 'starting', slow: false, frameShown: false, frameReady: false, onPage: true, ...over });

describe('the outline over a project’s first page', () => {
  it('holds from the preview not started yet, through a fast start, to the page ready', () => {
    expect(outlinesFirstPage(wait({ runtime: 'idle' }))).toBe(true);
    expect(outlinesFirstPage(wait({ runtime: 'starting' }))).toBe(true);
    expect(outlinesFirstPage(wait({ runtime: 'ready', frameShown: true }))).toBe(true);
    expect(outlinesFirstPage(wait({ runtime: 'ready', frameShown: true, frameReady: true }))).toBe(false);
  });

  it('gives way to the card for a start that runs long, setting up the tools, a stop and a preview that cannot run', () => {
    expect(outlinesFirstPage(wait({ runtime: 'starting', slow: true }))).toBe(false);
    expect(outlinesFirstPage(wait({ runtime: 'preparing' }))).toBe(false);
    expect(outlinesFirstPage(wait({ runtime: 'error' }))).toBe(false);
    expect(outlinesFirstPage(wait({ runtime: 'unavailable' }))).toBe(false);
  });

  it('is not drawn over a ready server with no page to load', () => {
    expect(outlinesFirstPage(wait({ runtime: 'ready', frameShown: false }))).toBe(false);
  });

  it('ends once the first page has shown, has failed or is being retried, and when the author moves to Preview, a layout or Studio', () => {
    for (const runtime of ['idle', 'starting', 'ready'] as const) {
      expect(outlinesFirstPage(wait({ runtime, frameShown: true, pending: false }))).toBe(false);
      expect(outlinesFirstPage(wait({ runtime, frameShown: true, onPage: false }))).toBe(false);
    }
  });
});
