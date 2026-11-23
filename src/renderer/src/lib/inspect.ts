import { api, getState } from '../store';
import { acceptMessage, newSessionId, postToFrame } from './bridge';
import { failedImages, missingImages, missingSections, staleImages } from './inspect-check';

/** How long the preview server gets to pick up files the AI just wrote before a fresh page load. */
const SETTLE_MS = 400;

/**
 * Measure a page for the AI at a given viewport width using an off-screen preview frame.
 * Only structural and geometric evidence is collected; no pixels leave the app.
 */
export async function runInspection(req: { requestId: string; pageId: string; width: number }) {
  const state = () => getState().snapshot?.state;
  let report = await measure(req);
  // A page the dev server has not caught up with (a route created moments ago, sections just added, an image
  // just changed) is missing some of its sections or images, or shows an image it no longer uses, and a file the
  // server has not picked up yet fails to load; give it one more chance before reporting.
  const behind = (r: unknown) => missingSections(state(), req.pageId, r).length || missingImages(state(), req.pageId, r).length || staleImages(state(), req.pageId, r).length;
  if (behind(report) || failedImages(report)) {
    await new Promise((r) => setTimeout(r, 1500));
    report = await measure(req);
  }
  const missing = missingSections(state(), req.pageId, report);
  const page = state()?.pages[req.pageId];
  // A load still showing the page from before an image change measured that old page, layout included: it is a
  // check that could not run, not a result.
  if ((page && missing.length && missing.length === page.rootIds.length) || missingImages(state(), req.pageId, report).length || staleImages(state(), req.pageId, report).length)
    report = { error: 'The preview has not caught up with the latest changes to this page.' };
  if (report && typeof report === 'object') {
    // The section and image address lists are only for these checks; they are not evidence for the AI.
    delete (report as { sections?: unknown }).sections;
    delete (report as { images?: { sources?: unknown } }).images?.sources;
  }
  api.inspectResult(req.requestId, report);
}

async function measure(req: { requestId: string; pageId: string; width: number }): Promise<unknown> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const s = getState();
  const runtime = s.runtime;
  const page = s.snapshot?.state.pages[req.pageId];
  if (runtime.state !== 'ready' || !page) return { error: 'The preview is not running.' };
  const origin = new URL(runtime.url).origin;
  const sessionId = newSessionId();
  const frame = document.createElement('iframe');
  frame.name = sessionId;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: `${req.width}px`, height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
  return new Promise((resolve) => {
    const done = (report: unknown) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      frame.remove();
      resolve(report);
    };
    const onMsg = (e: MessageEvent) => {
      const m = acceptMessage(e, frame, origin, sessionId);
      if (!m) return;
      if (m.type === 'ready') {
        postToFrame(frame, origin, sessionId, 'mode', { mode: 'preview' });
        // The frame waits (up to 4s) for fonts and images itself, and up to 2.5s more to request again
        // images that showed nothing, before measuring; loading and measuring get separate deadlines.
        clearTimeout(timer);
        timer = setTimeout(() => done({ error: 'Timed out measuring the page.' }), 8000);
        postToFrame(frame, origin, sessionId, 'inspect', { requestId: req.requestId });
      } else if (m.type === 'inspectResult') done((m.payload as { report: unknown }).report);
    };
    let timer = setTimeout(() => done({ error: 'Timed out loading the page.' }), 12000);
    window.addEventListener('message', onMsg);
    frame.src = runtime.url + page.route;
    document.body.appendChild(frame);
  });
}
