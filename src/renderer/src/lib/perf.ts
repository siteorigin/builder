/**
 * The editor's timing marks (src/shared/perf.ts), sent to the main process, which writes them beside its own. They
 * exist only while marks are on, when the preload offers `window.builderPerf`; otherwise every hook here returns at once.
 *
 * React commits are counted through the hook React DOM looks for as it loads (the one React DevTools installs), so this
 * module is imported before React DOM (main.tsx). A hook already there (DevTools in a development window) is kept and
 * still told of every commit. The count travels on every mark, as `c['react.commits']`.
 *
 * Each commit's components that rendered are counted too (`react.renders`), and those inside each panel marked with
 * `timedPanel` (lib/perf-panels.tsx) per panel (`panel.<id>.renders`), with the time React spent rendering the panel
 * (`panel.<id>.renderMs`). The count walks only what the commit rendered: a subtree React left alone is skipped whole.
 */
import type { PerfAttrs, PerfSent } from '@shared/perf';

const bridge = typeof window === 'undefined' ? undefined : window.builderPerf;
/** Whether marks are on in this editor. */
export const perfOn = !!bridge;

let commits = 0;
/** Components rendered, in all commits so far. */
let renders = 0;
/** Per panel: components rendered inside it, and the time React spent rendering it (ms). */
const panels = new Map<string, { renders: number; renderMs: number }>();
const once = new Set<string>();
const now = () => performance.timeOrigin + performance.now();
/** Marks made during a commit's layout effects, sent once React has counted that commit. */
let atCommit: Array<{ name: string; attrs?: PerfAttrs; t: number }> = [];

/** A point in time (now, or `at`), with the editor's counters as they stand. */
export function perfMark(name: string, attrs?: PerfAttrs, at?: number): void {
  if (!bridge) return;
  const c: Record<string, number> = { 'react.commits': commits, 'react.renders': renders };
  for (const [id, p] of panels) {
    c[`panel.${id}.renders`] = p.renders;
    c[`panel.${id}.renderMs`] = p.renderMs;
  }
  const record: PerfSent = { kind: 'mark', t: at ?? now(), name, ...(attrs ? { attrs } : {}), c };
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

/** A panel's counters, made the first time it renders (they then travel on every mark, from zero). */
export function perfPanel(id: string): { renders: number; renderMs: number } {
  let p = panels.get(id);
  if (!p) panels.set(id, (p = { renders: 0, renderMs: 0 }));
  return p;
}

/** The component that marks a panel's subtree, and the probes that time it (lib/perf-panels.tsx): the walk below
 *  counts none of them, since they are the measurement's and not the editor's. */
let panelType: unknown = null;
let probeTypes: unknown[] = [];
export function setPerfPanelTypes(panel: unknown, probes: unknown[]): void {
  panelType = panel;
  probeTypes = probes;
}

/** The parts of a React fiber the count reads: React DevTools reads the same, through the same hook. */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: { id?: unknown } | null;
}
/** Function, class, forwardRef, memo and simple memo components: the fibers whose render is a component's. */
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
/** React's PerformedWork flag: the component rendered in this commit (DevTools' didFiberRender). */
const PERFORMED_WORK = 1;

/**
 * The components a commit rendered, in all and per panel. A fiber whose children are the ones it had before was left
 * alone with everything under it (React bailed out of the subtree), so the walk goes no further.
 */
function countRenders(root: { current?: Fiber } | undefined) {
  const top = root?.current;
  if (!top || (top.alternate && top.child === top.alternate.child)) return;
  const stack: Array<{ f: Fiber; panel: { renders: number } | null }> = [];
  for (let c = top.child; c; c = c.sibling) stack.push({ f: c, panel: null });
  while (stack.length) {
    const { f, panel: outer } = stack.pop()!;
    const boundary = panelType !== null && f.type === panelType;
    const id = boundary ? f.memoizedProps?.id : undefined;
    const panel = typeof id === 'string' ? perfPanel(id) : outer;
    if (!boundary && COMPONENT_TAGS.has(f.tag) && (f.flags & PERFORMED_WORK) === PERFORMED_WORK && !probeTypes.includes(f.type)) {
      renders++;
      if (panel) panel.renders++;
    }
    if (f.alternate && f.child === f.alternate.child) continue;
    for (let c = f.child; c; c = c.sibling) stack.push({ f: c, panel });
  }
}

/** Called by React DOM in the middle of every commit: counted, and the commit's own marks sent; nothing else. */
function committed(_renderer?: unknown, root?: { current?: Fiber }) {
  const t = now();
  commits++;
  countRenders(root);
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
    // Someone else's hook (React DevTools): it keeps every call and answer, and the count rides along. One that cannot
    // be wrapped is left alone, and the trace says so: its commits go uncounted rather than the editor not loading.
    const theirs = existing.onCommitFiberRoot;
    try {
      existing.onCommitFiberRoot = function (this: DevtoolsHook, ...args: unknown[]) {
        committed(args[0], args[1] as { current?: Fiber } | undefined);
        return typeof theirs === 'function' ? theirs.apply(this, args) : undefined;
      };
    } catch {
      perfMark('perf.reactCommitsUncounted');
    }
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
