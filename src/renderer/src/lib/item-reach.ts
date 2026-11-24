import type { OwnerRef } from '@shared/types';

/**
 * The style reach (one card, or every card) last chosen for each card of each placement, so moving from a card's
 * title to its icon, from Parts or on the canvas, never quietly widens the edit. A card not chosen for yet follows
 * the shared style until "This card" is picked. Read by the canvas's spacing handles too.
 */
export const reachByItem = new Map<string, 'all' | 'item'>();

/** The key one card of one placement is remembered by. */
export const itemReachKey = (owner: OwnerRef, placementId: string, itemId: string) => JSON.stringify([owner.kind, owner.id, placementId, itemId]);
