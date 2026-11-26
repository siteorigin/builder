/**
 * The editor's timing marks (src/shared/perf.ts), sent to the main process, which writes them beside its own. They
 * exist only while marks are on, when the preload offers `window.builderPerf`; otherwise every hook here returns at once.
 *
 * React commits are counted through the hook React DOM looks for as it loads (the one React DevTools installs), so this
 * module is imported before React DOM (main.tsx). The count travels on every mark, as `c['react.commits']`.
 */
import type { PerfAttrs, PerfSent } from '@shared/perf';

const bridge = typeof window === 'undefined' ? undefined : window.builderPerf;
/** Whether marks are on in this editor. */
export const perfOn = !!bridge;

let commits = 0;
const once = new Set<string>();
const now = () => performance.timeOrigin + performance.now();

/** A point in time, with the editor's counters as they stand. */
export function perfMark(name: string, attrs?: PerfAttrs): void {
  if (!bridge) return;
  const record: PerfSent = { kind: 'mark', t: now(), name, ...(attrs ? { attrs } : {}), c: { 'react.commits': commits } };
  try {
    bridge.send(record);
  } catch {
    // A trace never breaks the editor.
  }
}

/** A mark made only the first time it is reached in this page (the first render, the first interactive screen). */
export function perfMarkOnce(name: string, attrs?: PerfAttrs): void {
  if (!bridge || once.has(name)) return;
  once.add(name);
  perfMark(name, attrs);
}

interface DevtoolsHook {
  supportsFiber: boolean;
  isDisabled?: boolean;
  inject(renderer: unknown): number;
  onCommitFiberRoot(...args: unknown[]): void;
  onCommitFiberUnmount(): void;
  onPostCommitFiberRoot(): void;
  setStrictMode(): void;
  checkDCE(): void;
}

const host = (typeof window === 'undefined' ? {} : window) as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook; __siteoriginPerf?: { mark: typeof perfMark } };
if (bridge && !host.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  let renderers = 0;
  host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => ++renderers,
    // Called by React DOM in the middle of every commit: only counted here, never sent, so the trace adds no IPC to it.
    onCommitFiberRoot: () => {
      commits++;
      if (commits === 1) queueMicrotask(() => perfMarkOnce('launch.firstRender'));
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    setStrictMode: () => {},
    checkDCE: () => {}
  };
}
// A driver marks the edges of what it measures with the editor's counters (scripts/perf/README.md).
if (bridge) host.__siteoriginPerf = { mark: perfMark };
