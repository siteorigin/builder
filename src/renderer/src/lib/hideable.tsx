/**
 * A panel that stays mounted while it is hidden (its search, scroll position, open sections and drafts kept for when it
 * shows again) but does no work for what it cannot show. While hidden, its components read the store as it was when
 * the panel was hidden, so no change to the project, the selection or anything else in the store runs their selectors
 * or renders them, and the editor drawing around it leaves it as it is. Shown again, it renders the store as it is now
 * in that same commit, so it is up to date the moment it appears.
 *
 * What runs outside rendering is not held: effects stay mounted (listeners for the panel's own events keep listening),
 * and `getState()`, `setState()` and `useStore.subscribe()` are always the live store's. A panel whose effects must
 * follow the store while it is hidden (announcing, sending, acting on a request made of it) is not wrapped in this.
 */
import { createContext, memo, useContext, useMemo, useRef, type ReactNode } from 'react';
import { getOverlay, StoreViewContext, useStore, type OverlayState, type State, type StoreView } from '../store';
import { activeWorkspace } from './workspace';

/** Whether the panel a component is in is hidden (false outside any). */
const HiddenContext = createContext(false);
/** Whether the panel this component is in is hidden: what it registers with the rest of the editor waits until it shows. */
export const usePanelHidden = () => useContext(HiddenContext);

const unsubscribe = () => {};
const subscribe = () => unsubscribe;

/** A view of the store that holds `state` (and the overlay's `drawn`) and never changes. */
function heldView(state: State, drawn: OverlayState): StoreView {
  return { getState: () => state, getInitialState: () => state, subscribe, overlay: { getState: () => drawn, getInitialState: () => drawn, subscribe } };
}

/**
 * `children`, held while `hidden`. The render that hides the panel is drawn (it sees itself hidden), and so is the first
 * one of each new opening of a project and of each change of what covers the canvas (the SEO view, a post's writer), so
 * a hidden panel never holds a project that has gone, nor fields another view has taken over. The held state is
 * discarded when the panel shows again.
 */
export function Hideable({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const era = useStore((s) => `${activeWorkspace(s)}:${s.snapshot?.workspaceKey ?? ''}`);
  // Taken when the panel is hidden (or a project opens, or the workspace changes, while it is): the state that render draws.
  const view = useMemo(() => (hidden ? heldView(useStore.getState(), getOverlay()) : null), [hidden, era]);
  return (
    <HiddenContext.Provider value={hidden}>
      <StoreViewContext.Provider value={view}>
        <Held hidden={hidden} era={era}>
          {children}
        </Held>
      </StoreViewContext.Provider>
    </HiddenContext.Provider>
  );
}

/** What the editor drew last, left as it is while the panel stays hidden in the same opening and workspace. */
const Held = memo(
  function Held({ children }: { hidden: boolean; era: string; children: ReactNode }) {
    return children;
  },
  (prev, next) => prev.hidden && next.hidden && prev.era === next.era
);

/**
 * `value` as it was when it was last shown (or first drawn), while `hidden`; `value` itself otherwise. What a panel that
 * must stay live works out from it for display alone (an overview, a preview) is then worked out from what it last
 * showed while it is hidden, so it does nothing for changes it cannot show; shown again, it works it out from `value`
 * in that same render.
 */
export function useShownValue<T>(value: T, hidden: boolean): T {
  const last = useRef(value);
  if (!hidden) last.current = value;
  return last.current;
}
