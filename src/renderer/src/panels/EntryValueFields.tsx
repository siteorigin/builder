/**
 * An entry's custom fields (#675), each with the control its kind takes: the Inspector's own editors for text, rich
 * text, numbers, yes or no, choices, images and links, a date picker, and the entries of another collection to name.
 * Each change is one entry.update of that field's value, so it is one undo step. Every field keeps the house Field
 * anatomy (label, control, hint or error), so a reference reads like its neighbours, and what a reference names is
 * said by name, with drafts, entries of one title and entries that have gone told apart.
 */
import './PostTerms.css';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Collection, CollectionFieldSchema, DateFieldSchema, EntryDoc, GalleryFieldSchema, ListItem, ProjectState, ReferenceFieldSchema, ScalarPropSchema } from '@shared/types';
import { isDraftEntry, orderedEntries } from '@shared/collections';
import { formatArticleDate, isArticleDate } from '@shared/articles';
import { MAX_REFERENCES } from '@engine/collections';
import { DraftInput, Field } from '../components/ui';
import { PropField, ScalarField, type ListOp } from './PropEditors';
import { galleryListProp, galleryRows } from '@shared/gallery-field';
import { editGallery, type GalleryEdit } from '../lib/gallery-value';
import type { PendingEdit } from '../store';

/** The value an entry shows for a field: its own, else the field's default. */
export function entryValue(entry: EntryDoc, name: string, schema: CollectionFieldSchema): unknown {
  return entry.values && Object.hasOwn(entry.values, name) ? entry.values[name] : schema.default;
}

/**
 * Every custom field of the entry's collection. `set` sends one field's new value (null: back to its default) and says
 * whether it was saved; `refuse` counts a value the form itself would not send (a date that is not one).
 */
export function EntryValueFields({
  state,
  collection,
  entry,
  readOnly,
  set,
  refuse
}: {
  state: ProjectState;
  collection: Collection;
  entry: EntryDoc;
  readOnly?: boolean;
  set: (name: string, value: unknown, label: string, edit?: PendingEdit) => unknown;
  refuse: () => boolean;
}) {
  const fields = Object.entries(collection.settings.fields ?? {});
  if (!fields.length) return null;
  return (
    <fieldset className="entry-values" disabled={readOnly} data-testid="entry-values">
      {fields.map(([name, schema]) => (
        <div key={name} data-entry-value={name} className="entry-value">
          <EntryValueField state={state} name={name} schema={schema} value={entryValue(entry, name, schema)} self={entry.id} readOnly={readOnly} set={set} refuse={refuse} />
        </div>
      ))}
    </fieldset>
  );
}

function EntryValueField({
  state,
  name,
  schema,
  value,
  self,
  readOnly,
  set,
  refuse
}: {
  state: ProjectState;
  name: string;
  schema: CollectionFieldSchema;
  value: unknown;
  self: string;
  readOnly?: boolean;
  set: (name: string, value: unknown, label: string, edit?: PendingEdit) => unknown;
  refuse: () => boolean;
}) {
  const label = `Change ${schema.label.toLowerCase()}`;
  if (schema.type === 'date') return <DateValue schema={schema} value={value} onSet={(v) => set(name, v, label)} refuse={refuse} />;
  if (schema.type === 'reference') return <ReferenceValue key={schema.collection} state={state} schema={schema} value={value} self={self} disabled={readOnly} onSet={(v) => set(name, v, label)} />;
  if (schema.type === 'gallery') return <GalleryValue state={state} name={name} schema={schema} value={value} set={set} />;
  // A link to a section can come with the change that gives the section its anchor (`edit`): sent together.
  return <ScalarField schema={schema as ScalarPropSchema} value={value} state={state} onChange={(v, edit) => (JSON.stringify(v) === JSON.stringify(value) && !edit?.operations.length ? undefined : set(name, v, label, edit))} />;
}

/**
 * A gallery's photos (#1320), in the list editor a Gallery's images have in the Inspector: Choose images… adds several
 * from Assets at once, in the order chosen, and each photo can be moved, removed, given a caption, or described. Each
 * of those is the gallery's whole new value, one undo step. A photo is only ever added with its picture.
 */
function GalleryValue({ state, name, schema, value, set }: { state: ProjectState; name: string; schema: GalleryFieldSchema; value: unknown; set: (name: string, value: unknown, label: string) => unknown }) {
  const list = galleryListProp(schema);
  const rows = galleryRows(value);
  const field = schema.label.toLowerCase();
  const onList = (op: ListOp) => {
    const edit: GalleryEdit | null =
      op.kind === 'pick' ? { kind: 'pick', assetIds: op.assetIds } : op.kind === 'remove' ? { kind: 'remove', itemId: op.itemId } : op.kind === 'move' ? { kind: 'move', itemId: op.itemId, index: op.index } : op.kind === 'field' ? { kind: 'field', itemId: op.itemId, field: op.field, value: op.value } : null;
    const next = edit && editGallery(rows, edit, state.assets.assets);
    if (!next) return op.kind === 'pick' ? Promise.resolve(null) : undefined;
    const label = op.kind === 'pick' ? `Add ${next.added.length === 1 ? 'a photo' : `${next.added.length} photos`} to ${field}` : op.kind === 'remove' ? `Remove a photo from ${field}` : op.kind === 'move' ? `Move a photo in ${field}` : `Change a photo in ${field}`;
    const saved = Promise.resolve(set(name, next.rows, label));
    // Choose images… opens the photos it added once they show.
    return op.kind === 'pick' ? saved.then((ok) => (ok ? { added: next.added, replaced: 0 } : null)) : saved;
  };
  return (
    <div className="entry-gallery" data-testid={`entry-gallery-${name}`}>
      <PropField name={name} schema={list} value={rows as unknown as ListItem[]} label={schema.label} hint={schema.description} onChange={() => undefined} onList={onList} onTable={() => Promise.resolve(false)} state={state} pickImages="image" pickOnly />
    </div>
  );
}

/**
 * A calendar day, or none. The browser's date field gives '' for a day typed only in part, which would read as
 * clearing it: that is refused and said at the field, and the saved day stays, until the date is finished or cleared.
 */
function DateValue({ schema, value, onSet, refuse }: { schema: DateFieldSchema; value: unknown; onSet: (v: string) => unknown; refuse: () => boolean }) {
  const shown = typeof value === 'string' ? value : '';
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [partial, setPartial] = useState(false);
  const unfinished = () => !!(input.current as HTMLInputElement | null)?.validity?.badInput;
  // Left part-typed where nothing was saved, the field's text is still its saved '' and nothing is committed: said
  // here. Said from the field itself, so it goes as soon as the date is finished, cleared or put back.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const left = () => {
      setPartial(unfinished());
      // The field may put the saved date back once it is left (or on Escape) without an input event: checked again then.
      requestAnimationFrame(() => setPartial(unfinished()));
    };
    const typed = () => !unfinished() && setPartial(false);
    const key = (e: Event) => (e as KeyboardEvent).key === 'Escape' && requestAnimationFrame(() => !unfinished() && setPartial(false));
    el.addEventListener('blur', left);
    el.addEventListener('input', typed);
    el.addEventListener('keydown', key);
    return () => (el.removeEventListener('blur', left), el.removeEventListener('input', typed), el.removeEventListener('keydown', key));
  }, []);
  // The field putting its saved date back (after a refusal, or Escape) says so here: the error goes with it. Stable,
  // and returning nothing, since the field calls it from an effect.
  const redrawn = useCallback(() => void requestAnimationFrame(() => setPartial((p) => p && unfinished())), []); // eslint-disable-line react-hooks/exhaustive-deps
  const error = partial ? (shown ? `Finish the date or clear it. ${formatArticleDate(shown, undefined)} is still saved.` : 'Finish the date or clear it.') : undefined;
  return (
    <Field label={schema.label} hint={schema.description} error={error}>
      <DraftInput
        type="date"
        className={`input entry-date${shown ? '' : ' empty'}`}
        inputRef={input}
        onDirty={redrawn}
        value={shown}
        ariaLabel={schema.label}
        onCommit={(v) => {
          if (unfinished()) return (setPartial(true), refuse());
          setPartial(false);
          return v === shown ? undefined : v === '' || isArticleDate(v) ? onSet(v) : refuse();
        }}
      />
    </Field>
  );
}

/** Past this many entries to choose from, a reference's list is filtered by what is typed and scrolls (as Categories and tags do). */
const MANY_ENTRIES = 12;

/** An entry as a reference shows it: its title, then what tells it apart (a draft; the date or address of one that shares its title). */
interface Named {
  id: string;
  title: string;
  /** What tells it from another of its title (a date, or an address), or ''. */
  which: string;
  /** Quiet words after the title, or ''. */
  more: string;
  draft: boolean;
  gone: boolean;
}

/** How each of `entries` is named, telling apart those that share a title by their date (or, sharing that too, their address). */
function namesFor(entries: EntryDoc[], language: string | undefined): Map<string, Named> {
  const key = (e: EntryDoc) => e.title.trim().toLowerCase();
  const byTitle = new Map<string, EntryDoc[]>();
  for (const e of entries) byTitle.set(key(e), [...(byTitle.get(key(e)) ?? []), e]);
  const out = new Map<string, Named>();
  for (const e of entries) {
    const twins = byTitle.get(key(e))!;
    const sameDay = twins.filter((t) => t.publishedAt === e.publishedAt).length > 1;
    const which = twins.length > 1 ? (sameDay ? e.slug : formatArticleDate(e.publishedAt, language)) : '';
    const draft = isDraftEntry(e);
    out.set(e.id, { id: e.id, title: e.title, which, more: [which, draft ? 'Draft' : ''].filter(Boolean).join(' · '), draft, gone: false });
  }
  return out;
}

const goneEntry = (id: string): Named => ({ id, title: 'Deleted entry', which: '', more: '', draft: false, gone: true });
/** The one line a select's option or a screen reader gets. */
const plain = (n: Named) => {
  const more = [n.which, n.draft ? 'draft' : ''].filter(Boolean).join(', ');
  return more ? `${n.title} (${more})` : n.title;
};

/**
 * The entries a reference names: one chosen from a list, or with `multiple` any number of them, in the order they were
 * chosen. Several are shown, in that order, as removable chips above their checkboxes; past MANY_ENTRIES the
 * checkboxes are found by typing and scroll in a box. An entry that has gone is named as deleted, never by its ID.
 */
function ReferenceValue({ state, schema, value, self, disabled, onSet }: { state: ProjectState; schema: ReferenceFieldSchema; value: unknown; self: string; disabled?: boolean; onSet: (v: string | string[]) => unknown }) {
  const uid = useId();
  const [find, setFind] = useState('');
  /** Said once when what was typed is cleared and every entry is back. */
  const [cleared, setCleared] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  /**
   * The list last sent and not yet back from the project: the next tick builds on it (read from the ref when it
   * happens, so quick ticks all count), and it is drawn at once (from state), so chips, boxes and the caret follow it.
   */
  const sent = useRef<string[] | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const key = JSON.stringify(chosen);
  useEffect(() => {
    if (sent.current && JSON.stringify(sent.current) === key) (sent.current = null), setPending(null);
  }, [key]);
  const target = Object.hasOwn(state.collections, schema.collection) ? state.collections[schema.collection] : undefined;
  if (!target)
    return (
      <Field label={schema.label} error={disabled ? 'The collection this field chooses from has been deleted.' : 'The collection this field chooses from has been deleted, so there is nothing to choose. Change the field in this collection’s settings.'}>
        <span />
      </Field>
    );
  const own = Object.hasOwn(target.entries, self);
  // Not itself, unless it already names itself (which it may), so that can be undone here.
  const options = orderedEntries(target).filter((e) => e.id !== self || chosen.includes(self) || value === self);
  const names = namesFor(options, state.site.language);
  const named = (id: string) => names.get(id) ?? goneEntry(id);
  const noun = target.settings.name;
  const none = own ? `${noun} has no other entries yet.` : `${noun} has no entries yet. Add one in the Content panel.`;

  const many = options.length > MANY_ENTRIES;
  const needle = find.trim().toLowerCase();
  // Found by the words each row shows (its title, and what tells it apart: a date, Draft), and by its address and author.
  const shown = many && needle ? options.filter((o) => `${o.title} ${named(o.id).more} ${o.publishedAt} ${formatArticleDate(o.publishedAt, state.site.language)} ${o.slug} ${o.author ?? ''}`.toLowerCase().includes(needle)) : options;
  const findBox = many && (
    <div className="post-terms-add entry-ref-find">
      <Search className="post-terms-find" aria-hidden="true" />
      <input
        className="input sm with-icon"
        value={find}
        placeholder={`Find in ${noun}`}
        aria-label={`Find in ${noun}`}
        onChange={(e) => (setCleared(!e.target.value.trim() && !!find.trim()), setFind(e.target.value))}
      />
    </div>
  );
  const findStatus = (
    <span className="sr-only" role="status">
      {many && needle ? `${shown.length} of ${options.length} match.` : cleared ? `All ${options.length} shown.` : ''}
    </span>
  );
  const noMatch = many && needle && !shown.length && (
    <li className="post-terms-none" aria-hidden="true">
      No {noun.toLowerCase()} match “{find.trim()}”.
    </li>
  );

  if (!schema.multiple) {
    const current = typeof value === 'string' ? value : '';
    const gone = !!current && !names.has(current);
    if (many && !disabled) {
      const n = current ? named(current) : undefined;
      return (
        <Field label={schema.label} hint={schema.description} error={gone ? 'The entry this named has been deleted. Choose another, or None.' : undefined}>
          <div ref={picker} className="entry-ref-picker" role="radiogroup" aria-label={schema.label}>
            {n && (
              <ol className="post-term-chips entry-ref-chips" aria-label={`${schema.label}, chosen`}>
                <li className={`post-term-chip${n.gone ? ' gone' : ''}`}>
                  <span className="ellipsis" title={plain(n)}>
                    {n.title}
                    {n.more && <span className="entry-ref-more"> · {n.more}</span>}
                  </span>
                  <button type="button" className="icon-btn sm" aria-label="Choose None" title="Choose None" onClick={() => onSet('')}>
                    <X />
                  </button>
                </li>
              </ol>
            )}
            {findBox}
            {findStatus}
            <ul className="entry-refs many" aria-label={`${noun} to choose from`}>
              {shown.map((o) => {
                const m = named(o.id);
                return (
                  <li key={o.id}>
                    <label>
                      <input type="radio" name={`${uid}-ref`} checked={current === o.id} onChange={() => onSet(o.id)} />
                      <span className="entry-ref-name">
                        {m.title}
                        {m.more && <span className="entry-ref-more"> {m.more}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
              {noMatch}
            </ul>
          </div>
        </Field>
      );
    }
    return (
      <Field
        label={schema.label}
        hint={options.length || disabled ? schema.description : none}
        error={gone ? (disabled ? 'The entry this named has been deleted.' : 'The entry this named has been deleted. Choose another, or None.') : undefined}
        controlId={`${uid}-ref`}
      >
        <select id={`${uid}-ref`} className="select" value={current} onChange={(e) => onSet(e.target.value)}>
          <option value="">None</option>
          {gone && <option value={current}>Deleted entry</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {plain(named(o.id))}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  const ticked = pending ?? chosen;
  const missing = ticked.filter((id) => !names.has(id));
  const send = (next: string[]) => {
    sent.current = next;
    setPending(next);
    // Refused: the next change starts from what the project holds.
    void Promise.resolve(onSet(next)).then((r) => {
      if (!r && sent.current === next) (sent.current = null), setPending(null);
    });
  };
  /** What a change starts from, read when it happens (not when the form last drew), so quick ticks all count. */
  const now = () => sent.current ?? chosen;
  // A list naming an entry that has gone cannot be saved as it is: any change leaves the deleted ones out, as the note says.
  const toggle = (id: string, on: boolean) => {
    const from = now().filter((x) => names.has(x));
    // Full: a quick second tick never asks for more than a field can name.
    if (on && !from.includes(id) && from.length >= MAX_REFERENCES) return;
    send(on ? [...from.filter((x) => x !== id), id] : from.filter((x) => x !== id));
  };
  /** The caret, once what it was on has gone: the chip now in that place, else the find field or the first box. */
  const refocus = (i: number) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const left = picker.current?.querySelectorAll<HTMLButtonElement>('.entry-ref-chips button');
      (left?.length ? left[Math.min(i, left.length - 1)] : picker.current?.querySelector<HTMLElement>('.entry-ref-find input, .entry-refs input'))?.focus();
    });
  const remove = (id: string, i: number) => (send(now().filter((x) => x !== id && names.has(x))), refocus(i));
  const clearGone = () => (send(now().filter((x) => names.has(x))), refocus(0));
  const kept = ticked.length - missing.length;
  const full = kept >= MAX_REFERENCES;
  const count = options.length ? (full && !disabled ? `${kept} of ${options.length} chosen, the most` : kept ? `${kept} of ${options.length} chosen` : 'None chosen') : undefined;
  const gone = missing.length === 1 ? 'An entry this named has been deleted.' : `${missing.length} entries this named have been deleted.`;
  const error = missing.length ? (
    disabled ? (
      gone
    ) : (
      <>
        {gone} Any change here removes {missing.length === 1 ? 'it' : 'them'} too.
        <button type="button" className="link-btn field-fix" onClick={clearGone}>
          Remove {missing.length === 1 ? 'the deleted entry' : `${missing.length} deleted entries`}
        </button>
      </>
    )
  ) : undefined;
  const hint = full && !disabled ? `${MAX_REFERENCES} chosen, the most a field can name. Remove one to choose another.` : options.length || disabled ? schema.description : none;
  const chips = ticked.length > 0 && (
    <ol className="post-term-chips entry-ref-chips" aria-label={`${schema.label}, in order`}>
      {ticked.map((id, i) => {
        const n = named(id);
        return (
          <li key={id} className={`post-term-chip${n.gone ? ' gone' : ''}`}>
            <span className="ellipsis" title={plain(n)}>
              {n.title}
              {n.more && <span className="entry-ref-more"> · {n.more}</span>}
            </span>
            {/* A deleted one goes with the error's Remove (any change takes every deleted one out). */}
            {!disabled && !n.gone && (
              <button type="button" className="icon-btn sm" aria-label={`Remove “${plain(n)}”`} title="Remove" onClick={() => remove(id, i)}>
                <X />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
  const rows = (
    <ul className={`entry-refs${many ? ' many' : ''}`} aria-label={many ? `${noun} to choose from` : undefined}>
      {shown.map((o) => {
        const n = named(o.id);
        const on = ticked.includes(o.id);
        return (
          <li key={o.id}>
            <label>
              <input type="checkbox" checked={on} disabled={full && !on} onChange={(e) => toggle(o.id, e.target.checked)} />
              <span className="entry-ref-name">
                {n.title}
                {n.more && <span className="entry-ref-more"> {n.more}</span>}
              </span>
            </label>
          </li>
        );
      })}
      {noMatch}
    </ul>
  );
  return (
    <Field label={schema.label} hint={hint} error={error} extra={count && <span className="post-terms-count">{count}</span>}>
      <div ref={picker} className="entry-ref-picker">
        {chips}
        {/* Read-only: what it names, not every entry it could. */}
        {!disabled && options.length > 0 && (
          <>
            {findBox}
            {findStatus}
            {/* Its own region, so it is said once when the field fills, not again with every letter typed. */}
            <span className="sr-only" role="status">
              {full ? `${MAX_REFERENCES} chosen, the most a field can name. Remove one to choose another.` : ''}
            </span>
            {rows}
          </>
        )}
        {disabled && !ticked.length && <span className="entry-ref-empty">None chosen</span>}
      </div>
    </Field>
  );
}
