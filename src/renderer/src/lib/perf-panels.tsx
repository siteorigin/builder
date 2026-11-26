/**
 * Panels as the performance harness sees them (scripts/perf/README.md): with timing marks on, `timedPanel` puts a
 * panel between two probes and marks its subtree, so the editor's counters say, per panel, how many of its components
 * each commit rendered (`panel.<id>.renders`, counted in lib/perf.ts) and how long React spent rendering it
 * (`panel.<id>.renderMs`). With marks off it returns the panel itself: nothing is added to the tree.
 *
 * The time is read from render order. React renders a parent's children one after the other, each child's subtree
 * whole before the next sibling, so the time between the probe before the panel and the probe after it is the time
 * spent in the panel. Both probes read the whole store, so they render in every update the store makes, and in every
 * render of what holds them; an update the store did not make that renders only inside the panel (its own state) is
 * not timed, though its components are counted.
 */
import type { ReactNode } from 'react';
import { useStore } from '../store';
import { perfOn, perfPanel, setPerfPanelTypes } from './perf';

const now = () => performance.now();
/** When each panel's probe before it rendered, in the render under way. */
const started = new Map<string, number>();

function PanelStart({ id }: { id: string }) {
  useStore((s) => s);
  started.set(id, now());
  return null;
}

function PanelEnd({ id }: { id: string }) {
  useStore((s) => s);
  const from = started.get(id);
  if (from !== undefined) {
    perfPanel(id).renderMs += now() - from;
    started.delete(id);
  }
  return null;
}

/** The subtree a panel's renders are counted in. */
function PerfPanel({ children }: { id: string; children: ReactNode }) {
  return children;
}

if (perfOn) setPerfPanelTypes(PerfPanel, [PanelStart, PanelEnd]);

/** `panel`, timed and counted as `id` while marks are on; `panel` itself otherwise. */
export function timedPanel(id: string, panel: ReactNode): ReactNode {
  if (!perfOn) return panel;
  perfPanel(id);
  return (
    <>
      <PanelStart id={id} />
      <PerfPanel id={id}>{panel}</PerfPanel>
      <PanelEnd id={id} />
    </>
  );
}
