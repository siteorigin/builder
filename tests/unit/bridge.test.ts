/**
 * The editor's check of what the preview frame sends (acceptance item I05): only the frame it made, from the preview's
 * origin, in its session, within the size limit, and, for reports about the page, from the navigation and revision the
 * frame last said it shows. An inline edit's commit keeps its own checks, whatever page or revision it comes from.
 */
import { describe, expect, it, vi } from 'vitest';
import { acceptMessage, postToFrame, staleFor, viewAfter, type BridgeMessage, type FrameView } from '../../src/renderer/src/lib/bridge';

const ORIGIN = 'http://127.0.0.1:5173';
const SESSION = 'so-1-2-3';
const frameWindow = { postMessage: vi.fn() };
const frame = { contentWindow: frameWindow };
const view: FrameView = { navigationId: 'dabc.1', revision: 7 };

function message(over: Partial<BridgeMessage> = {}): BridgeMessage {
  return { protocolVersion: 1, sessionId: SESSION, navigationId: 'dabc.1', revision: 7, type: 'rects', payload: { selected: [], hovered: [] }, ...over };
}
function event(data: unknown, from: { source?: unknown; origin?: string } = {}) {
  return { data, source: 'source' in from ? from.source : frameWindow, origin: from.origin ?? ORIGIN };
}
const VIEW_TYPES = ['select', 'dblclick', 'contextmenu', 'hover', 'key', 'rects', 'inspectResult'];
const EDIT_TYPES = ['textCommit', 'textCancel', 'linkDropped', 'checkLink'];
const accept = (data: unknown, from: { source?: unknown; origin?: string } = {}, v: FrameView | null | undefined = view) => acceptMessage(event(data, from), frame, ORIGIN, SESSION, v);

describe('acceptMessage', () => {
  it('accepts a report from the page the frame shows', () => {
    expect(accept(message())).toEqual(message());
    for (const type of VIEW_TYPES) {
      expect(accept(message({ type }))).not.toBeNull();
      // A page that has taken an update it has not yet said it shows reports from that revision.
      expect(accept(message({ type, revision: 8 }))).not.toBeNull();
    }
  });

  it('rejects a message from another origin', () => {
    expect(accept(message(), { origin: 'http://127.0.0.1:9999' })).toBeNull();
  });

  it('rejects a message from another window', () => {
    expect(accept(message(), { source: { postMessage: vi.fn() } })).toBeNull();
    expect(accept(message(), { source: null })).toBeNull();
  });

  it('rejects a message from another session', () => {
    expect(accept(message({ sessionId: 'so-9-9-9' }))).toBeNull();
  });

  it('rejects an oversized message', () => {
    expect(accept(message({ payload: { selected: 'x'.repeat(200_001) } }))).toBeNull();
  });

  it('rejects an envelope without a navigation or revision', () => {
    // A commit is held to no view, so only the envelope check can refuse these.
    const commit = (over: Record<string, unknown>) => ({ ...message({ type: 'textCommit', payload: { editId: 'e1' } }), ...over });
    expect(accept(commit({}))).not.toBeNull();
    expect(accept(commit({ navigationId: undefined }))).toBeNull();
    expect(accept(commit({ navigationId: '' }))).toBeNull();
    expect(accept(commit({ navigationId: 'd'.repeat(101) }))).toBeNull();
    expect(accept(commit({ revision: undefined }))).toBeNull();
    expect(accept(commit({ revision: '7' }))).toBeNull();
    expect(accept(commit({ revision: -1 }))).toBeNull();
    expect(accept(commit({ revision: 7.5 }))).toBeNull();
  });

  it('rejects a report about the page from a navigation the editor has moved past', () => {
    // Another load of the same page (its own document), an earlier page of this document, and one the frame has not
    // yet said it moved to.
    for (const navigationId of ['dxyz.1', 'dabc.0', 'dabc.2']) {
      for (const type of VIEW_TYPES) expect(accept(message({ navigationId, type }))).toBeNull();
    }
  });

  it('rejects a report about the page from a revision older than the page says it shows', () => {
    for (const type of VIEW_TYPES) expect(accept(message({ revision: 6, type }))).toBeNull();
  });

  it('rejects a report about the page before the frame reported any', () => {
    expect(accept(message({ type: 'select' }), {}, null)).toBeNull();
  });

  it('keeps an inline edit’s commit from an older page or revision for its own checks and recovery', () => {
    for (const type of EDIT_TYPES) {
      expect(accept(message({ type, navigationId: 'dxyz.0', payload: { editId: 'e1' } }))).not.toBeNull();
      expect(accept(message({ type, navigationId: 'dabc.0', payload: { editId: 'e1' } }))).not.toBeNull();
      expect(accept(message({ type, revision: 2, payload: { editId: 'e1' } }))).not.toBeNull();
      expect(accept(message({ type, payload: { editId: 'e1' } }), {}, null)).not.toBeNull();
    }
  });

  it('takes every load’s ready, and moves on only within the document the frame shows', () => {
    expect(accept(message({ type: 'ready', navigationId: 'dxyz.0', revision: 0, payload: { path: '/' } }))).not.toBeNull();
    expect(accept(message({ type: 'navigated', navigationId: 'dabc.2', payload: { path: '/about/' } }))).not.toBeNull();
    // The answer to the editor's request repeats the arrival the site reported.
    expect(accept(message({ type: 'navigated', navigationId: 'dabc.1', payload: { path: '/about/', navId: 3 } }))).not.toBeNull();
    // An earlier arrival of this document, or any of another's, never takes the view back.
    expect(accept(message({ type: 'navigated', navigationId: 'dabc.0', payload: { path: '/' } }))).toBeNull();
    expect(accept(message({ type: 'navigated', navigationId: 'dxyz.2', payload: { path: '/about/' } }))).toBeNull();
    expect(accept(message({ type: 'revisionApplied', revision: 9, payload: { revision: 9 } }))).not.toBeNull();
    expect(accept(message({ type: 'revisionApplied', navigationId: 'dxyz.1', revision: 9, payload: { revision: 9 } }))).toBeNull();
    expect(accept(message({ type: 'revisionApplied', navigationId: 'dxyz.1', revision: 9, payload: { revision: 9 } }), {}, null)).toBeNull();
  });

  it('leaves navigation and revision to a caller that holds no view', () => {
    expect(acceptMessage(event(message({ navigationId: 'dxyz.4', revision: 0 })), frame, ORIGIN, SESSION)).not.toBeNull();
  });
});

describe('the view the frame reports', () => {
  it('starts with each load, follows in-place navigation and only moves forward in revision', () => {
    let v = viewAfter(message({ type: 'ready', navigationId: 'dabc.0', revision: 0 }), null);
    expect(v).toEqual({ navigationId: 'dabc.0', revision: 0 });
    v = viewAfter(message({ type: 'revisionApplied', navigationId: 'dabc.0', revision: 4 }), v);
    expect(v).toEqual({ navigationId: 'dabc.0', revision: 4 });
    v = viewAfter(message({ type: 'navigated', navigationId: 'dabc.1', revision: 6 }), v);
    expect(v).toEqual({ navigationId: 'dabc.1', revision: 6 });
    expect(viewAfter(message({ type: 'navigated', navigationId: 'dabc.2', revision: 3 }), v)).toEqual({ navigationId: 'dabc.2', revision: 6 });
    // An older acknowledgement never moves it back; another document's, or an earlier navigation's, never moves it.
    expect(viewAfter(message({ type: 'revisionApplied', navigationId: 'dabc.1', revision: 2 }), v)).toEqual(v);
    expect(viewAfter(message({ type: 'revisionApplied', navigationId: 'dabc.0', revision: 9 }), v)).toEqual(v);
    expect(viewAfter(message({ type: 'navigated', navigationId: 'dabc.0', revision: 9 }), v)).toEqual(v);
    expect(viewAfter(message({ type: 'navigated', navigationId: 'dxyz.3', revision: 9 }), v)).toEqual(v);
    // Ordinary reports leave it as it is.
    expect(viewAfter(message({ type: 'rects', navigationId: 'dabc.1', revision: 9 }), v)).toEqual(v);
    // A new load of the same page starts over.
    expect(viewAfter(message({ type: 'ready', navigationId: 'dnew.0', revision: 0 }), v)).toEqual({ navigationId: 'dnew.0', revision: 0 });
  });

  it('calls a measurement stale when it comes from another navigation or an older revision', () => {
    expect(staleFor(message({ type: 'measured' }), view)).toBe(false);
    expect(staleFor(message({ type: 'measured', navigationId: 'dabc.0' }), view)).toBe(true);
    expect(staleFor(message({ type: 'measured', revision: 6 }), view)).toBe(true);
    expect(staleFor(message({ type: 'measured' }), null)).toBe(true);
  });
});

describe('postToFrame', () => {
  it('stamps each command with the navigation and revision the editor last knew the frame to show', () => {
    frameWindow.postMessage.mockClear();
    postToFrame(frame, ORIGIN, SESSION, 'scrollTo', { desc: { ctx: 'page:p', node: 'n', items: '' } }, view);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      { protocolVersion: 1, sessionId: SESSION, navigationId: 'dabc.1', revision: 7, type: 'scrollTo', payload: { desc: { ctx: 'page:p', node: 'n', items: '' } } },
      ORIGIN
    );
    postToFrame(frame, ORIGIN, SESSION, 'mode', { mode: 'edit' });
    expect(frameWindow.postMessage).toHaveBeenLastCalledWith({ protocolVersion: 1, sessionId: SESSION, navigationId: '', revision: 0, type: 'mode', payload: { mode: 'edit' } }, ORIGIN);
  });
});
