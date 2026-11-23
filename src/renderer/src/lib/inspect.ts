import { api, getState } from '../store';
import { acceptMessage, newSessionId, postToFrame } from './bridge';

/**
 * Measure a page for the AI at a given viewport width using an off-screen preview frame.
 * Only structural and geometric evidence is collected; no pixels leave the app.
 */
export async function runInspection(req: { requestId: string; pageId: string; width: number }) {
  const s = getState();
  const runtime = s.runtime;
  const page = s.snapshot?.state.pages[req.pageId];
  if (runtime.state !== 'ready' || !page) {
    api.inspectResult(req.requestId, { error: 'The preview is not running.' });
    return;
  }
  const origin = new URL(runtime.url).origin;
  const sessionId = newSessionId();
  const frame = document.createElement('iframe');
  frame.name = sessionId;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: `${req.width}px`, height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
  const done = (report: unknown) => {
    window.removeEventListener('message', onMsg);
    clearTimeout(timer);
    frame.remove();
    api.inspectResult(req.requestId, report);
  };
  const onMsg = (e: MessageEvent) => {
    const m = acceptMessage(e, frame, origin, sessionId);
    if (!m) return;
    if (m.type === 'ready') {
      postToFrame(frame, origin, sessionId, 'mode', { mode: 'preview' });
      // Give fonts and images a moment to settle before measuring.
      setTimeout(() => postToFrame(frame, origin, sessionId, 'inspect', { requestId: req.requestId }), 600);
    } else if (m.type === 'inspectResult') done((m.payload as { report: unknown }).report);
  };
  const timer = setTimeout(() => done({ error: 'Timed out loading the page.' }), 15000);
  window.addEventListener('message', onMsg);
  frame.src = runtime.url + page.route;
  document.body.appendChild(frame);
}
