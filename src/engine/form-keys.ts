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
import type { ComponentDefinition, ListItem } from '@shared/types';
import { formFieldKey, formKeyFrom, formNameDecides, type FormField } from '@catalogue/foundation/form';

/** The name and label a form field without its own gets on export. */
export function formDefaults(def: ComponentDefinition): { name?: unknown; label?: unknown } {
  const schema = def.properties.fields;
  return schema?.type === 'list' ? { name: schema.fields.name?.default, label: schema.fields.label?.default } : {};
}

/**
 * The fields after an edit, with keys settled. `before` is the list as it was, `after` the list the edit made,
 * and `cleared` the fields whose name the edit itself emptied, which get a fresh key from their label.
 */
export function settleFormKeys(before: readonly FormField[], after: ListItem[], cleared: ReadonlySet<string> = new Set(), defaults: FormDefaults = {}): ListItem[] {
  // Each field as the export sends it: a missing name or label is its default.
  const sent = (f: FormField): FormField => ({ name: f?.name ?? defaults.name, label: f?.label ?? defaults.label });
  const was = new Map<string, string>();
  before.forEach((f, i) => {
    if (f && typeof f.id === 'string') was.set(f.id, formFieldKey(sent(f), i));
  });
  const out = after.map((f) => ({ ...f }));
  const fresh: number[] = [];
  out.forEach((f, i) => {
    if (formNameDecides(sent(f))) return;
    const kept = was.get(f.id);
    if (kept !== undefined && !cleared.has(f.id)) f.name = kept;
    else fresh.push(i);
  });
  for (const i of fresh) {
    const taken = new Set(out.flatMap((f, j) => (j === i || (fresh.includes(j) && !formNameDecides(sent(f))) ? [] : [formFieldKey(sent(f), j)])));
    // A long label makes a key of its first words, short enough to stay a valid name once numbered.
    const base = formKeyFrom(String(sent(out[i]).label ?? '').slice(0, KEY_LENGTH)) || 'field';
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    out[i].name = key;
  }
  return out;
}

/** The longest label text a generated key is made from. */
const KEY_LENGTH = 60;

/** The name and label a field without its own has: the list schema's field defaults. */
export interface FormDefaults {
  name?: unknown;
  label?: unknown;
}
