/**
 * Panels as the performance harness sees them (scripts/perf/README.md): with timing marks on, `timedPanel` puts a
 * panel between two probes and marks its subtree, so the editor's counters say, per panel, how many of its components
 * each commit rendered (`panel.<id>.renders`, counted in lib/perf.ts) and how long React spent rendering it
 * (`panel.<id>.renderMs`). With marks off it returns the panel itself: nothing is added to the tree.
 *
 * The time is read from render order. React renders a parent's children one after the other, each child's subtree
 * whole before the next sibling, so the time between the probe before the panel and the probe after it is the time
 * spent in the panel. Both probes read the whole store (and the canvas overlay's state), so they render in every update
 * either makes, and in every render of what holds them; an update neither made that renders only inside the panel (its
 * own state) is not timed, though its components are counted.
 */
import { useContext, type ReactNode } from 'react';
import { useStore as useStoreOf } from 'zustand';
import { countTreeWalks } from '@engine/tree';
import { countSeoOverviews } from './seo-overview';
import { countChatStarters } from './chatSuggestions';
import { overlayView, StoreViewContext, useStore, type OverlayState, type State } from '../store';
import { perfCount, perfOn, perfPanel, setPerfPanelTypes } from './perf';

const now = () => performance.now();
/** When each panel's probe before it rendered, in the render under way. */
const started = new Map<string, number>();

const whole = (s: State) => s;
const wholeOverlay = (s: OverlayState) => s;
/** The whole store and the canvas overlay's state, as the panel's view of them has them, so the probes render in every
 *  update of either that can render the panel. Their selectors are not counted with the editor's
 *  (`store.selectorRuns`): the probes are the measurement's, as the count of renders leaves them out too. */
const useWholeStore = () => {
  const view = useContext(StoreViewContext);
  useStoreOf(view ?? useStore, whole);
  useStoreOf(view?.overlay ?? overlayView, wholeOverlay);
};

function PanelStart({ id }: { id: string }) {
  useWholeStore();
  started.set(id, now());
  return null;
}

function PanelEnd({ id }: { id: string }) {
  useWholeStore();
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

if (perfOn) {
  setPerfPanelTypes(PerfPanel, [PanelStart, PanelEnd]);
  // The editor's scans of a tree (src/engine/tree.ts), counted from zero so a build without them is told apart.
  perfCount('tree.findParent', 0);
  perfCount('tree.subtreeIds', 0);
  // The work panels do over the whole site while they render: the SEO overview, the website read for an entry's
  // address (SeoPreview's useDocumentPreview) and the AI panel's starters.
  perfCount('seo.overviews', 0);
  perfCount('seo.routes', 0);
  perfCount('chat.starters', 0);
  countTreeWalks((walk) => perfCount(`tree.${walk}`));
  countSeoOverviews(() => perfCount('seo.overviews'));
  countChatStarters(() => perfCount('chat.starters'));
}

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
