/**
 * Contact form submission keys stay where they are while the form is edited.
 *
 * A field's key comes from its name, else its label, else its position (`formFieldKey`), so translating a label
 * or moving a field would quietly send that answer under another key, and whoever reads the submissions would
 * file it in the wrong place. So every edit to a form's fields settles the keys:
 * - a field whose own name decides its key keeps that name exactly as typed;
 * - any other field that was already there gets the key it was sent under written into its name, before the
 *   edit could move it;
 * - a new field, and one whose name was just cleared, gets a key of its own made from its label (or `field`),
 *   numbered past the keys the form's other fields use.
 * Fields that still share a key are reported by `validateState`, not refused, so names can be swapped one at a
 * time and older forms that already clash still open.
 */
import type { ListItem } from '@shared/types';
import { formFieldKey, formKeyFrom, formNameDecides, type FormField } from '@catalogue/foundation/form';

/**
 * The fields after an edit, with keys settled. `before` is the list as it was, `after` the list the edit made,
 * and `cleared` the fields whose name the edit itself emptied, which get a fresh key from their label.
 */
export function settleFormKeys(before: readonly FormField[], after: ListItem[], cleared: ReadonlySet<string> = new Set()): ListItem[] {
  const was = new Map<string, string>();
  before.forEach((f, i) => {
    if (f && typeof f.id === 'string') was.set(f.id, formFieldKey(f, i));
  });
  const out = after.map((f) => ({ ...f }));
  const fresh: number[] = [];
  out.forEach((f, i) => {
    if (formNameDecides(f)) return;
    const kept = was.get(f.id);
    if (kept !== undefined && !cleared.has(f.id)) f.name = kept;
    else fresh.push(i);
  });
  for (const i of fresh) {
    const taken = new Set(out.flatMap((f, j) => (j === i || (fresh.includes(j) && !formNameDecides(f)) ? [] : [formFieldKey(f, j)])));
    const base = formKeyFrom(String(out[i].label ?? '')) || 'field';
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    out[i].name = key;
  }
  return out;
}
