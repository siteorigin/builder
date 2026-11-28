import { api, getState, useStore, type State } from '../store';

/**
 * The editor's steps in the app's trace on this computer (src/main/trace.ts): which screen shows, how far an opening has
 * got, the preview's state as the editor sees it, and anything that went wrong on the page. Short text only: never
 * what the project's pages or a chat say.
 */
export function traceEditor(area: string, message: string | (() => string)): void {
  try {
    api.trace(area, typeof message === 'function' ? message() : message);
  } catch {
    // Tracing never gets in the way, whatever it was given to say.
  }
}

/** What went wrong, for a trace line (inside traceEditor's guard: a value that cannot be shown is never thrown). */
export const reasonOf = (e: unknown): string => (e instanceof Error ? String(e.message) : String(e));

/** What the trace follows of the editor's state: what an opening, and its first page, wait on. */
function followed(s: State): Record<string, string | number | boolean | null> {
  const runtime = s.runtime;
  return {
    screen: s.screen,
    opening: s.openingProject?.name ?? null,
    openingTimed: s.openingSince !== null,
    openingPage: s.openingPage,
    project: s.snapshot?.workspaceKey ?? null,
    runtime: `${runtime.state}${'message' in runtime && runtime.message ? `: ${runtime.message.slice(0, 160)}` : ''}`,
    frameReady: s.frameReady,
    previewIssue: s.previewIssue,
    themes: s.packs.ready ? 'ready' : `waiting${s.packs.refused.length ? ` (${s.packs.refused.length} refused)` : ''}`,
    mode: s.mode,
    modal: s.modal?.kind ?? null,
    leaving: s.leaving
  };
}

/** Trace the editor's state as it moves, and the page's errors, from now until the returned call. */
export function followForTrace(): () => void {
  let last = followed(getState());
  traceEditor('state', Object.entries(last).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' '));
  const off = useStore.subscribe((s) => {
    const now = followed(s);
    const moved = Object.keys(now).filter((k) => now[k] !== last[k]);
    last = now;
    if (moved.length) traceEditor('state', moved.map((k) => `${k}=${JSON.stringify(now[k])}`).join(' '));
  });
  const onError = (e: ErrorEvent) => traceEditor('error', () => `${reasonOf(e.message)} at ${e.filename}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) => traceEditor('error', () => `unhandled rejection: ${reasonOf(e.reason)}`);
  const onVisibility = () => traceEditor('page', `${document.visibilityState}`);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    off();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
