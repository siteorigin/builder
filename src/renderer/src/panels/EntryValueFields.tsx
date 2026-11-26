/**
 * An entry's custom fields (#675), each with the control its kind takes: the Inspector's own editors for text, rich
 * text, numbers, yes or no, choices, images and links, a date picker, and the entries of another collection to name.
 * Each change is one entry.update of that field's value, so it is one undo step.
 */
import { useId } from 'react';
import type { Collection, CollectionFieldSchema, DateFieldSchema, EntryDoc, ProjectState, ReferenceFieldSchema, ScalarPropSchema } from '@shared/types';
import { orderedEntries } from '@shared/collections';
import { isArticleDate } from '@shared/articles';
import { DraftInput, Field } from '../components/ui';
import { ScalarField } from './PropEditors';

/** The value an entry shows for a field: its own, else the field's default. */
export function entryValue(entry: EntryDoc, name: string, schema: CollectionFieldSchema): unknown {
  return entry.values && Object.hasOwn(entry.values, name) ? entry.values[name] : schema.default;
}

/**
 * Every custom field of the entry's collection. `set` sends one field's new value (null: back to its default) and says
 * whether it was saved; `refuse` counts a value the form itself would not send (a date that is not one).
 */
export function EntryValueFields({ state, collection, entry, readOnly, set, refuse }: { state: ProjectState; collection: Collection; entry: EntryDoc; readOnly?: boolean; set: (name: string, value: unknown, label: string) => unknown; refuse: () => boolean }) {
  const fields = Object.entries(collection.settings.fields ?? {});
  if (!fields.length) return null;
  return (
    <fieldset className="entry-values" disabled={readOnly} data-testid="entry-values">
      {fields.map(([name, schema]) => (
        <div key={name} data-entry-value={name} className="entry-value">
          <EntryValueField state={state} name={name} schema={schema} value={entryValue(entry, name, schema)} self={entry.id} set={set} refuse={refuse} />
        </div>
      ))}
    </fieldset>
  );
}

function EntryValueField({ state, name, schema, value, self, set, refuse }: { state: ProjectState; name: string; schema: CollectionFieldSchema; value: unknown; self: string; set: (name: string, value: unknown, label: string) => unknown; refuse: () => boolean }) {
  const label = `Change ${schema.label.toLowerCase()}`;
  if (schema.type === 'date') return <DateValue schema={schema} value={value} onSet={(v) => set(name, v, label)} refuse={refuse} />;
  if (schema.type === 'reference') return <ReferenceValue state={state} schema={schema} value={value} self={self} onSet={(v) => set(name, v, label)} />;
  return <ScalarField schema={schema as ScalarPropSchema} value={value} state={state} onChange={(v) => (JSON.stringify(v) === JSON.stringify(value) ? undefined : set(name, v, label))} />;
}

/** A calendar day, or none. */
function DateValue({ schema, value, onSet, refuse }: { schema: DateFieldSchema; value: unknown; onSet: (v: string) => unknown; refuse: () => boolean }) {
  const shown = typeof value === 'string' ? value : '';
  return (
    <Field label={schema.label} hint={schema.description}>
      <DraftInput type="date" value={shown} ariaLabel={schema.label} onCommit={(v) => (v === shown ? undefined : v === '' || isArticleDate(v) ? onSet(v) : refuse())} />
    </Field>
  );
}

/** The entries a reference names: one chosen from a list, or with `multiple` any number of them ticked, in order. */
function ReferenceValue({ state, schema, value, self, onSet }: { state: ProjectState; schema: ReferenceFieldSchema; value: unknown; self: string; onSet: (v: string | string[]) => unknown }) {
  const uid = useId();
  const target = Object.hasOwn(state.collections, schema.collection) ? state.collections[schema.collection] : undefined;
  const options = target ? orderedEntries(target).filter((e) => e.id !== self) : [];
  const title = (id: string) => (target && Object.hasOwn(target.entries, id) ? target.entries[id].title : id);
  if (!target) return <p className="posts-note">{schema.label}: the collection it names entries of is gone.</p>;
  if (!schema.multiple) {
    const current = typeof value === 'string' ? value : '';
    return (
      <Field label={schema.label} hint={schema.description} controlId={`${uid}-ref`}>
        <select id={`${uid}-ref`} className="select" value={current} onChange={(e) => onSet(e.target.value)}>
          <option value="">None</option>
          {current && !options.some((o) => o.id === current) && <option value={current}>{title(current)}</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const toggle = (id: string, on: boolean) => onSet(on ? [...chosen, id] : chosen.filter((x) => x !== id));
  return (
    <div className="field" role="group" aria-labelledby={`${uid}-l`}>
      <div className="field-label" id={`${uid}-l`}>
        {schema.label}
      </div>
      {options.length ? (
        <ul className="entry-refs">
          {options.map((o) => (
            <li key={o.id}>
              <label>
                <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => void toggle(o.id, e.target.checked)} /> {o.title}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="posts-note">{target.settings.name} has no other entries yet.</p>
      )}
      {schema.description && <div className="field-hint">{schema.description}</div>}
    </div>
  );
}
