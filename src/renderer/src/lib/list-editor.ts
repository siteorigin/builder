import { listItemImage, listRowTitle } from '@shared/fields';
import { effectiveItem } from '@shared/page-teasers';
import { treeFor } from './model';
import type { ListItem, OwnerRef, ProjectState } from '@shared/types';

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

// ---------------------------------------------------------------------------
// History and Undo wording
// ---------------------------------------------------------------------------

/** The kinds of list edit that get their own wording (a pick and a repair carry their own label). */
export type ListEdit =
  | { kind: 'insert'; item?: Record<string, unknown> }
  | { kind: 'remove'; itemId: string }
  | { kind: 'move'; itemId: string; index: number }
  | { kind: 'field'; itemId: string; field: string };

const TITLE_MAX = 32;

/** A row's name for a History line: its title in quotes, cut at a word-ish length. */
function quoted(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t}”`;
}

/**
 * The History and Undo wording for one list edit, read from the project as it is before the edit lands (so a removed
 * row can still be named): what was done, to which row (by its title, else its place, "card 2"), in which list, and
 * where the list is, the section and the page it is on. `everywhere` is the edit made on a design for every
 * placement, which names the design, not a page. Falls back to `fallback` when the row or list can't be found.
 */
export function listEditLabel(state: ProjectState, owner: OwnerRef, nodeId: string, prop: string, op: ListEdit, fallback: string, everywhere = false): string {
  const node = treeFor(state, owner)?.nodes[nodeId];
  if (node?.kind !== 'instance') return fallback;
  const def = state.components[node.definitionId];
  const schema = def?.properties[prop];
  if (schema?.type !== 'list') return fallback;
  const items = (Array.isArray(node.props[prop]) ? node.props[prop] : schema.default) as ListItem[];
  const nameAt = (i: number) => {
    const eff = effectiveItem(state, schema, items[i]);
    return quoted(listRowTitle(schema, eff, i, listItemImage(schema, eff, state.assets.assets)?.name));
  };
  const noun = schema.itemLabel.toLowerCase();
  const at = op.kind === 'insert' ? -1 : items.findIndex((x) => x?.id === op.itemId);
  if (op.kind !== 'insert' && at < 0) return fallback;
  const list = schema.label;
  let what: string;
  switch (op.kind) {
    case 'insert': {
      // A card made for a page is named by it; a blank one by its place.
      const own = op.item ? effectiveItem(state, schema, { id: '', ...op.item }) : undefined;
      const t = schema.titleField && own ? own[schema.titleField] : undefined;
      what = `Add ${typeof t === 'string' && t.trim() ? quoted(t) : `${noun} ${items.length + 1}`} to ${list}`;
      break;
    }
    case 'remove':
      what = `Remove ${nameAt(at)} from ${list}`;
      break;
    case 'move': {
      const to = Math.min(op.index, items.length - 1);
      what = to === at ? `Move ${nameAt(at)} in ${list}` : `Move ${nameAt(at)} from ${at + 1} to ${to + 1} in ${list}`;
      break;
    }
    case 'field':
      what = `Edit ${schema.fields[op.field]?.label ?? op.field} of ${nameAt(at)} in ${list}`;
      break;
  }
  if (everywhere) return `${what} everywhere`;
  const section = def.name;
  const page = owner.kind === 'page' && Object.hasOwn(state.pages, owner.id) ? state.pages[owner.id].title : owner.kind === 'shell' ? `the ${owner.id}` : '';
  const where = [section, page && `on ${page}`].filter(Boolean).join(' ');
  return where && where !== list ? `${what} (${where})` : what;
}
