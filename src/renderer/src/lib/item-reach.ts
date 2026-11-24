import type { OwnerRef } from '@shared/types';

/**
 * The style reach (one card, or every card) last chosen for each card of each placement, so moving from a card's
 * title to its icon, from Parts or on the canvas, never quietly widens the edit. A card not chosen for yet follows
 * the shared style until "This card" is picked. Read by the canvas's spacing handles too.
 */
export const reachByItem = new Map<string, 'all' | 'item'>();

/** The key one card of one placement is remembered by. */
export const itemReachKey = (owner: OwnerRef, placementId: string, itemId: string) => JSON.stringify([owner.kind, owner.id, placementId, itemId]);

/** The reach the inspector shows for the card it has open, which can differ from the one remembered (an Undo
 *  removing the card's own styles leaves it showing "This card"). */
let shown: { key: string; reach: 'all' | 'item' } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};

/** Say which reach the inspector shows for a card; the returned function takes it back. */
export function showReach(key: string, reach: 'all' | 'item'): () => void {
  const entry = { key, reach };
  shown = entry;
  changed();
  return () => {
    if (shown !== entry) return;
    shown = null;
    changed();
  };
}

/** For useSyncExternalStore: what changes when the shown reach does. */
export function subscribeReach(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export const reachVersion = () => version;

/** The reach chosen for a card: what the inspector shows for it, else what was last chosen there. */
export const chosenReach = (key: string) => (shown?.key === key ? shown.reach : reachByItem.get(key));
