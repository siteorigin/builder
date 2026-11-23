/**
 * The changes the inspector makes to a set of choices (a single-choice form question's answers). Each one names its
 * choice by id and is applied to the set as the project last confirmed it, so one change never carries another's
 * stale copy of the set: a rename the project refused cannot ride along with a move made right after it.
 */
import type { ChoiceOption } from '@shared/types';

/** A rename says the label it was typed over (`from`): if the choice has had another since, the rename is stale. */
export type ChoiceAction = { kind: 'add'; label: string } | { kind: 'rename'; id: string; label: string; from?: string } | { kind: 'move'; id: string; by: -1 | 1 } | { kind: 'remove'; id: string };

/** A choice as the inspector sends it: a saved one whole, by id, or a new one by its label alone. */
export type ChoiceRow = ChoiceOption | { label: string };

/** Two labels a visitor would take for the same answer. */
export const sameChoice = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Spaces as a single-line label keeps them. */
export const choiceText = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The set after `action`, or null when it changes nothing on this set: its choice is gone, it is already where the
 * move would take it, the label is the one it has, a new label is already offered, or a rename was typed over a
 * label the choice no longer has (see `staleRename`).
 */
export function applyChoiceAction(saved: readonly ChoiceOption[], action: ChoiceAction): ChoiceRow[] | null {
  const at = 'id' in action ? saved.findIndex((c) => c.id === action.id) : -1;
  switch (action.kind) {
    case 'add': {
      const label = choiceText(action.label);
      return label && !saved.some((c) => sameChoice(c.label, label)) ? [...saved, { label }] : null;
    }
    case 'rename': {
      const label = choiceText(action.label);
      return at < 0 || !label || label === saved[at].label || staleRename(saved, action) ? null : saved.map((c, i) => (i === at ? { ...c, label } : c));
    }
    case 'move': {
      const to = at + action.by;
      if (at < 0 || to < 0 || to >= saved.length) return null;
      const next = [...saved];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    }
    case 'remove':
      return at < 0 ? null : saved.filter((_, i) => i !== at);
  }
}

/** The choice a rename was typed over, when someone (the AI, say) has given it another label since. */
export function staleRename(saved: readonly ChoiceOption[], action: ChoiceAction): ChoiceOption | undefined {
  if (action.kind !== 'rename' || action.from === undefined) return undefined;
  const c = saved.find((x) => x.id === action.id);
  return c && c.label !== action.from ? c : undefined;
}
