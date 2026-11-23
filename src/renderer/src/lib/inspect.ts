import { api, getState } from '../store';
import { acceptMessage, newSessionId, postToFrame } from './bridge';

/** How long the preview server gets to pick up files the AI just wrote before a fresh page load. */
const SETTLE_MS = 400;

/**
 * Measure a page for the AI at a given viewport width using an off-screen preview frame.
 * Only structural and geometric evidence is collected; no pixels leave the app.
 */
export async function runInspection(req: { requestId: string; pageId: string; width: number }) {
  let report = await measure(req);
  // A page the dev server has not caught up with (a route created moments ago, sections just added)
  // is missing some of its sections; give it one more chance before reporting.
  if (missingSections(req.pageId, report).length) {
    await new Promise((r) => setTimeout(r, 1500));
    report = await measure(req);
  }
  const missing = missingSections(req.pageId, report);
  const page = getState().snapshot?.state.pages[req.pageId];
  if (page && missing.length && missing.length === page.rootIds.length) report = { error: 'The preview has not caught up with the latest changes to this page.' };
  // The section list is only for this check; it is not evidence for the AI.
  if (report && typeof report === 'object') delete (report as { sections?: unknown }).sections;
  api.inspectResult(req.requestId, report);
}

/** Top-level sections of the page that the measured load did not render. */
function missingSections(pageId: string, report: unknown): string[] {
  const r = report as { error?: unknown; sections?: string[] } | null;
  const page = getState().snapshot?.state.pages[pageId];
  if (!r || r.error || !Array.isArray(r.sections) || !page) return [];
  const rendered = new Set(r.sections);
  return page.rootIds.filter((id) => !rendered.has(`page:${pageId}|${id}`));
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
        // The frame waits (up to 4s) for fonts and images itself before measuring; loading and
        // measuring get separate deadlines.
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
