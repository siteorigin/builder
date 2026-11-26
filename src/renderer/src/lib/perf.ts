/**
 * The editor's timing marks (src/shared/perf.ts), sent to the main process, which writes them beside its own. They
 * exist only while marks are on, when the preload offers `window.builderPerf`; otherwise every hook here returns at once.
 *
 * React commits are counted through the hook React DOM looks for as it loads (the one React DevTools installs), so this
 * module is imported before React DOM (main.tsx). A hook already there (DevTools in a development window) is kept and
 * still told of every commit. The count travels on every mark, as `c['react.commits']`.
 */
import type { PerfAttrs, PerfSent } from '@shared/perf';

const bridge = typeof window === 'undefined' ? undefined : window.builderPerf;
/** Whether marks are on in this editor. */
export const perfOn = !!bridge;

let commits = 0;
const once = new Set<string>();
const now = () => performance.timeOrigin + performance.now();
/** Marks made during a commit's layout effects, sent once React has counted that commit. */
let atCommit: Array<{ name: string; attrs?: PerfAttrs; t: number }> = [];

/** A point in time (now, or `at`), with the editor's counters as they stand. */
export function perfMark(name: string, attrs?: PerfAttrs, at?: number): void {
  if (!bridge) return;
  const record: PerfSent = { kind: 'mark', t: at ?? now(), name, ...(attrs ? { attrs } : {}), c: { 'react.commits': commits } };
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

/**
 * A mark for the commit React is making now, from a layout effect: timed now, and sent when React reports the commit,
 * so its count includes that commit. Sent at once when no commit report follows (the hook is not React's).
 */
export function perfMarkAtCommit(name: string, attrs?: PerfAttrs): void {
  if (!bridge) return;
  atCommit.push({ name, attrs, t: now() });
  queueMicrotask(flushCommitMarks);
}

function flushCommitMarks() {
  const marks = atCommit;
  atCommit = [];
  for (const m of marks) perfMark(m.name, m.attrs, m.t);
}

/** Called by React DOM in the middle of every commit: counted, and the commit's own marks sent; nothing else. */
function committed() {
  const t = now();
  commits++;
  if (commits === 1) {
    once.add('launch.firstRender');
    perfMark('launch.firstRender', undefined, t);
  }
  if (atCommit.length) flushCommitMarks();
}

interface DevtoolsHook {
  supportsFiber: boolean;
  isDisabled?: boolean;
  inject(renderer: unknown): number;
  onCommitFiberRoot(...args: unknown[]): unknown;
  onCommitFiberUnmount(...args: unknown[]): unknown;
  onPostCommitFiberRoot(...args: unknown[]): unknown;
  setStrictMode(...args: unknown[]): unknown;
  checkDCE(...args: unknown[]): unknown;
}

const host = (typeof window === 'undefined' ? {} : window) as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook; __siteoriginPerf?: { mark: typeof perfMark } };
if (bridge) {
  const existing = host.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    // Someone else's hook (React DevTools): it keeps every call and answer, and the count rides along.
    const theirs = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function (this: DevtoolsHook, ...args: unknown[]) {
      committed();
      return typeof theirs === 'function' ? theirs.apply(this, args) : undefined;
    };
  } else {
    let renderers = 0;
    host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => ++renderers,
      onCommitFiberRoot: committed,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      setStrictMode: () => {},
      checkDCE: () => {}
    };
  }
  // A driver marks the edges of what it measures with the editor's counters (scripts/perf/README.md).
  host.__siteoriginPerf = { mark: perfMark };
}
