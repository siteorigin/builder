import type { ComponentPreviewMeasure, ComponentPreviewResult, ComponentPreviewSpec, ComponentPreviewStep, PreparedComponentPreview } from '@shared/component-preview';
import { api, getState } from '../store';
import { acceptMessage, newSessionId, postToFrame, type BridgeMessage } from './bridge';
import type { ElementRef } from '@shared/types';
import { attributeFindings, failedImages, missingImages, missingSections, staleImages } from './inspect-check';
import { descOf } from './model';

/** How long the preview server gets to pick up files the AI just wrote before a fresh page load. */
const SETTLE_MS = 400;

type InspectRequest = { requestId: string; pageId: string; width: number; targets?: ElementRef[] };

/**
 * Measure a page for the AI at a given viewport width using an off-screen preview frame.
 * Only structural and geometric evidence is collected; no pixels leave the app. With `targets`, only those elements
 * and what is inside them are measured (the report's `targets` lists each one's boxes, in order), beside what
 * belongs to the page as a whole: its width, its runtime errors.
 */
export async function runInspection(req: InspectRequest) {
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
    // Each finding names the element to change as operations address it, against the project measured.
    attributeFindings(state(), report);
  }
  api.inspectResult(req.requestId, report);
}

async function measure(req: InspectRequest): Promise<unknown> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const s = getState();
  const runtime = s.runtime;
  const page = s.snapshot?.state.pages[req.pageId];
  if (runtime.state !== 'ready' || !page) return { error: 'The preview is not running.' };
  const origin = new URL(runtime.url).origin;
  const sessionId = newSessionId();
  const frame = hiddenFrame(sessionId, req.width);
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
        // The page's sections as this load was asked for, so the frame can say how they follow one another.
        // Elements asked for are found as the canvas finds a selection, against the project as it is now.
        const state = getState().snapshot?.state;
        const targets = Array.isArray(req.targets) && state ? req.targets.map((t) => descOf(state, t)) : undefined;
        postToFrame(frame, origin, sessionId, 'inspect', { requestId: req.requestId, pageId: req.pageId, rootIds: [...page.rootIds], ...(targets ? { targets } : {}) });
      } else if (m.type === 'inspectResult' && (m.payload as { requestId?: unknown }).requestId === req.requestId) done((m.payload as { report: unknown }).report);
    };
    let timer = setTimeout(() => done({ error: 'Timed out loading the page.' }), 12000);
    window.addEventListener('message', onMsg);
    frame.src = runtime.url + page.route;
    document.body.appendChild(frame);
  });
}

// ---------------------------------------------------------------------------
// Isolated component previews
// ---------------------------------------------------------------------------

/** How long a component preview gets to load, and then to settle and be measured (as a page's measurement does). */
const PREVIEW_LOAD_MS = 12000;
const PREVIEW_MEASURE_MS = 8000;
/** How long the editor gets to prepare a preview's files. */
const PREVIEW_PREPARE_MS = 15000;

/** A hidden frame for measuring, `width` CSS pixels wide, kept out of sight, reach and the accessibility tree. */
function hiddenFrame(sessionId: string, width: number): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.name = sessionId;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: `${width}px`, height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
  return frame;
}

interface PreviewState {
  key?: string;
  mounted?: boolean;
  error?: string;
  bounds?: ComponentPreviewResult['bounds'];
  text?: string;
}

/** A frame that shows one component on its own (see @shared/component-preview), shown and measured on request. */
export interface ComponentFrame {
  /**
   * Show `spec` at `width` CSS pixels wide and measure it. Only what changed is redone: a new width is measured in
   * place, while new variants, sample values or project changes load a newly prepared preview. Calls run in turn.
   * `measure` asks for the checks the AI's component inspection adds.
   */
  update(spec: ComponentPreviewSpec, width: number, measure?: ComponentPreviewMeasure): Promise<ComponentPreviewResult>;
  /** Remove the frame and the preview it shows; a call still running ends with an error. */
  dispose(): void;
}

export function componentFrame(): ComponentFrame {
  const sessionId = newSessionId();
  let frame: HTMLIFrameElement | null = null;
  let origin: string | null = null;
  /** The preview the frame shows, what it was made from (request, project revision, preview server) and its definition. */
  let shownKey: string | null = null;
  let shownFrom: string | null = null;
  let shownDefinition: string | undefined;
  /** Settles a preparation still under way when the frame is removed. */
  let abandon: (() => void) | null = null;
  /** The address of the preview loading or shown, which the bridge's messages must come from. */
  let address: string | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** The one message being waited for: settled by it, by its deadline, or by dispose. */
  let waiting: { accept: (m: BridgeMessage) => boolean; done: (m: BridgeMessage | null) => void } | null = null;

  const onMsg = (e: MessageEvent) => {
    const m = acceptMessage(e, frame, origin, sessionId);
    if (!m || !waiting || m.navigationId !== address) return;
    if (waiting.accept(m)) waiting.done(m);
  };
  window.addEventListener('message', onMsg);

  /** The next message `accept` takes, or null once `ms` pass (or the frame is removed). */
  const next = (accept: (m: BridgeMessage) => boolean, ms: number, start: () => void) =>
    new Promise<BridgeMessage | null>((resolve) => {
      const timer = setTimeout(() => finish(null), ms);
      const finish = (m: BridgeMessage | null) => {
        clearTimeout(timer);
        if (waiting === entry) waiting = null;
        resolve(m);
      };
      const entry = { accept, done: finish };
      waiting?.done(null);
      waiting = entry;
      start();
    });

  const release = (key: string | null) => {
    if (key) void api.project.releaseComponentPreview(key).catch(() => undefined);
  };

  /** Prepare `spec`'s files, or null when that takes too long or the frame is removed meanwhile (a late key is released). */
  const prepare = (spec: ComponentPreviewSpec) =>
    new Promise<PreparedComponentPreview | null>((resolve) => {
      let settled = false;
      const finish = (v: PreparedComponentPreview | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abandon = null;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), PREVIEW_PREPARE_MS);
      abandon = () => finish(null);
      api.project.prepareComponentPreview(spec).then(
        (prepared) => {
          if (settled) {
            if (prepared.ok) release(prepared.key);
          } else finish(prepared);
        },
        (e: unknown) => finish({ ok: false, message: `The component preview could not be prepared: ${e instanceof Error ? e.message : String(e)}` })
      );
    });

  async function show(spec: ComponentPreviewSpec, width: number, measure?: ComponentPreviewMeasure): Promise<ComponentPreviewResult> {
    // A request names its own component: one that cannot be prepared is never reported as the one shown before.
    let definitionId: string | undefined;
    const fail = (error: string): ComponentPreviewResult => ({ state: 'error', error, width, ...(definitionId ? { definitionId } : {}) });
    if (disposed) return fail('The component preview was closed.');
    const s = getState();
    const runtime = s.runtime;
    if (runtime.state !== 'ready' || !s.snapshot) return fail('The preview is not running.');
    if (!frame) {
      frame = hiddenFrame(sessionId, width);
      document.body.appendChild(frame);
    }
    frame.style.width = `${width}px`;
    const from = JSON.stringify([spec, s.snapshot.revision, runtime.url]);
    if (from === shownFrom) definitionId = shownDefinition;
    else {
      const prepared = await prepare(spec);
      if (disposed) {
        if (prepared?.ok) release(prepared.key);
        return fail('The component preview was closed.');
      }
      if (!prepared) return fail('Timed out preparing the component preview.');
      if (!prepared.ok) return fail(prepared.message);
      const previous = shownKey;
      shownKey = prepared.key;
      shownFrom = null;
      definitionId = shownDefinition = prepared.definitionId;
      origin = new URL(runtime.url).origin;
      address = prepared.path;
      const target = frame;
      const ready = await next(
        (m) => m.type === 'ready',
        PREVIEW_LOAD_MS,
        () => (target.src = runtime.url + prepared.path)
      );
      // The frame no longer shows the one it showed before.
      release(previous);
      if (disposed) return fail('The component preview was closed.');
      if (!ready) return fail('Timed out loading the component preview.');
      const state = (ready.payload as { preview?: PreviewState }).preview;
      if (!state?.mounted) return fail(state?.error ? `The component could not be shown: ${state.error}` : 'The component could not be shown.');
      shownFrom = from;
      // Shown as visitors see it: what only the author sees in Edit (a button with nowhere to go) stays hidden.
      postToFrame(frame, origin, sessionId, 'mode', { mode: 'preview' });
    }
    const requestId = newSessionId();
    const target = frame;
    const measured = await next(
      (m) => m.type === 'inspectResult' && (m.payload as { requestId?: unknown }).requestId === requestId,
      PREVIEW_MEASURE_MS,
      () => postToFrame(target, origin, sessionId, 'inspect', { requestId, ...(measure?.readability ? { readability: true } : {}), ...(measure?.gaps ? { gaps: true } : {}) })
    );
    if (disposed) return fail('The component preview was closed.');
    if (!measured) return fail('Timed out measuring the component preview.');
    const report = (measured.payload as { report?: { preview?: PreviewState } }).report;
    const state = report?.preview;
    if (!state?.mounted) return fail('The component could not be shown.');
    return { state: 'ready', width, definitionId, bounds: state.bounds ?? null, text: typeof state.text === 'string' ? state.text : '', report };
  }

  return {
    update(spec, width, measure) {
      const run = queue.then(() => show(spec, width, measure));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', onMsg);
      waiting?.done(null);
      abandon?.();
      frame?.remove();
      frame = null;
      release(shownKey);
      shownKey = null;
    }
  };
}

/** Batches still running, by request: each stops at once (its frames removed) when the main process cancels it. */
const runningBatches = new Map<string, () => void>();

/** The main process stopped waiting for a batch (the request was stopped, or timed out): start no more of its steps. */
export function cancelComponentPreviews(requestId: string) {
  runningBatches.get(requestId)?.();
}

/**
 * Show components in isolated preview frames step by step, as the main process asked, and answer with what each
 * frame reported. Every frame is removed afterwards. With `measure.budgetMs`, no step starts once that has passed:
 * the answer then ends with the last step started. A batch also stops when it is cancelled, or when the project it
 * was asked for is no longer the one open.
 */
export async function runComponentPreviews(req: { requestId: string; steps: ComponentPreviewStep[]; measure?: ComponentPreviewMeasure }) {
  const frames = new Map<number, ComponentFrame>();
  const results: ComponentPreviewResult[] = [];
  const measure = req.measure && typeof req.measure === 'object' ? req.measure : undefined;
  const until = Number.isFinite(measure?.budgetMs) ? Date.now() + Math.max(0, measure!.budgetMs!) : Infinity;
  const opening = getState().snapshot?.workspaceKey;
  let cancelled = false;
  runningBatches.set(req.requestId, () => {
    cancelled = true;
    // A step under way ends with an error rather than finishing for no one.
    for (const f of frames.values()) f.dispose();
  });
  try {
    for (const step of (Array.isArray(req.steps) ? req.steps : []).slice(0, 50)) {
      if (cancelled || Date.now() > until || getState().snapshot?.workspaceKey !== opening) break;
      const n = Number.isInteger(step?.frame) && step.frame! >= 0 && step.frame! < 4 ? step.frame! : 0;
      const width = Number.isFinite(step?.width) ? Math.min(4000, Math.max(200, Math.round(step.width))) : 1280;
      let f = frames.get(n);
      if (!f) frames.set(n, (f = componentFrame()));
      // A step that throws is answered as a failure, so the batch is always answered.
      results.push(await f.update(step.spec, width, measure).catch((e: unknown): ComponentPreviewResult => ({ state: 'error', error: `The component preview failed: ${e instanceof Error ? e.message : String(e)}`, width })));
    }
  } finally {
    runningBatches.delete(req.requestId);
    for (const f of frames.values()) f.dispose();
  }
  api.componentPreviewResult(req.requestId, results);
}
