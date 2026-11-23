// What a repeatable list says about its limits and about an item that was just moved. Plain functions, so the
// wording and the focus rule are tested without a renderer.

/** The count shown beside a list's label: with a maximum it reads "3 / 8", otherwise just the count. */
export function countText(count: number, max?: number): string {
  return max === undefined ? String(count) : `${count} / ${max}`;
}

/** The count as a screen reader hears it. Without a maximum it keeps the earlier wording ("3 items", "1 card"). */
export function countLabel(count: number, itemLabel: string, max?: number): string {
  if (max !== undefined) return `${count} of ${max} ${max === 1 ? itemLabel.toLowerCase() : 'items'}`;
  return `${count} ${count === 1 ? itemLabel.toLowerCase() : 'items'}`;
}

const items = (n: number, itemLabel: string) => `${n} ${n === 1 ? itemLabel.toLowerCase() : 'items'}`;

const fixedSize = (count: number, itemLabel: string, min?: number, max?: number) => min !== undefined && max !== undefined && min === max && count === min;

/** Why Add does nothing, or null while the list has room (or no maximum). */
export function addLimitNote(count: number, itemLabel: string, max?: number, min?: number): string | null {
  if (fixedSize(count, itemLabel, min, max)) return `This list is fixed at ${items(count, itemLabel)}, so items can't be added or removed.`;
  return max !== undefined && count >= max ? `Limit reached: this list holds at most ${items(max, itemLabel)}. Remove one to add another.` : null;
}

/** Why Remove does nothing, or null while the list is above its minimum (or has none). */
export function removeLimitNote(count: number, itemLabel: string, min?: number, max?: number): string | null {
  if (fixedSize(count, itemLabel, min, max)) return addLimitNote(count, itemLabel, max, min);
  return min !== undefined && count <= min ? `This list needs at least ${items(min, itemLabel)}, so nothing can be removed. Add one first.` : null;
}

export type MoveDirection = 'up' | 'down';

/**
 * Where focus goes after an item moved. It stays on the button that was used while that button still works. When the
 * move put the item at the end it was heading for, the button is now disabled and would drop focus to the page, so
 * focus goes to the item's own disclosure instead.
 */
export function moveFocusTarget(direction: MoveDirection, newIndex: number, count: number): 'up' | 'down' | 'head' {
  if (direction === 'up') return newIndex > 0 ? 'up' : 'head';
  return newIndex < count - 1 ? 'down' : 'head';
}

/** What a screen reader hears after a move: the item and its new place in the list. */
export function moveAnnouncement(title: string, newIndex: number, count: number): string {
  return `${title} moved to position ${newIndex + 1} of ${count}`;
}
