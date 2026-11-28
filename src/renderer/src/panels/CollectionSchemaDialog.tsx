/**
 * A collection's settings (#675): what it is called and holds, the pages the website has for it, and the custom fields
 * and groupings its entries fill in. Everything changed is saved together, as one step to undo, when the dialog's Save
 * is pressed; the engine's refusal (an address taken, a field a layout shows) is said inside the dialog, which stays
 * open with what was typed.
 *
 * Every control in a field's card has a visible label; fields move up and down with buttons (their order is the order
 * an entry's form shows them in), and a refusal stays said in the footer until the settings are reloaded.
 */
import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { CollectionFieldSchema, CollectionKind } from '@shared/types';
import { COLLECTION_FIELD_TYPES } from '@shared/types';
import { claimRefusals, commitOps, confirmDialog, getState, useStore } from '../store';
import { ChoiceField, Field, Modal, SwitchRow, useMenu } from '../components/ui';
import { FIELD_TYPE_LABELS, draftFeedChoice, draftInFeed, draftKindFeeds, entryNoun, newFieldSchema, retypeField, schemaDraftOf, schemaLosses, schemaUpdateOp, settleDraft, type CollectionFieldType, type FieldRow, type SchemaDraft } from '../lib/content';
import { isImeComposing } from '../lib/ime';
import './CollectionSchemaDialog.css';

const KIND_HINTS: Record<CollectionKind, string> = {
  editorial: 'Dated pieces written in a distraction-free editor, such as blog posts.',
  structured: 'Entries made of fields, such as team members or projects.'
};

export function CollectionSchemaDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const collection = snap && Object.hasOwn(snap.state.collections, collectionId) ? snap.state.collections[collectionId] : undefined;
  /** The project this dialog was opened in: a draft is never saved into another. */
  const [opening] = useState(() => snap?.workspaceKey);
  /**
   * The collection as the draft was made from it, and the project's revision then: what Save compares the draft with,
   * and the only revision it is saved at, so nothing changed meanwhile (a term added, a field) is ever written over.
   */
  const [base, setBase] = useState(() => (collection && snap ? { collection, revision: snap.revision } : null));
  const [draft, setDraft] = useState<SchemaDraft | null>(() => (collection ? schemaDraftOf(collection) : null));
  const [error, setError] = useState<string | null>(null);
  /** The collection changed since the draft was made: Save waits for the author to look at it again. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  /** How many rows were added, for each one's key while its name is not settled. */
  const added = useRef(0);
  const uid = useId();
  const addMenu = useMenu();
  if (!snap || !collection || !draft || !base || snap.workspaceKey !== opening) return null;
  const state = snap.state;
  // A refusal stays said while it still holds: one made stale by a change elsewhere goes only when the settings reload.
  const set = (patch: Partial<SchemaDraft>) => (setDraft({ ...draft, ...patch }), !stale && setError(null));
  /** Move field `i` by `step`, keeping focus on the button that moved it. */
  const move = (i: number, step: -1 | 1) => {
    const j = i + step;
    if (j < 0 || j >= draft.fields.length) return;
    const fields = [...draft.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    set({ fields });
    const rowKey = fields[j].key ?? fields[j].name;
    // At the end it moved to, its button there is disabled: the other one takes focus.
    const dir = (j === 0 && step === -1) || (j === fields.length - 1 && step === 1) ? (step === -1 ? 'down' : 'up') : step === -1 ? 'up' : 'down';
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-move="${CSS.escape(`${rowKey}:${dir}`)}"]`)?.focus());
  };
  const setField = (i: number, row: FieldRow) => set({ fields: draft.fields.map((f, j) => (j === i ? row : f)) });
  const collections = Object.values(state.collections)
    .map((c) => c.settings)
    .sort((a, b) => a.name.localeCompare(b.name));

  /** Start again from the collection as it is now: what was typed here goes. */
  const reload = () => {
    const now = getState().snapshot;
    const c = now && Object.hasOwn(now.state.collections, collectionId) ? now.state.collections[collectionId] : undefined;
    if (!now || !c) return onClose();
    setBase({ collection: c, revision: now.revision });
    setDraft(schemaDraftOf(c));
    setStale(false);
    setError(null);
    // The Reload button goes with the refusal: editing resumes at the name.
    requestAnimationFrame(() => document.getElementById(`${uid}-name`)?.focus());
  };
  const changedMeanwhile = () => {
    setStale(true);
    setError(`The project changed while these settings were open, so they can’t be saved over it. Reload them and make your changes again; what you changed here is discarded.`);
    // Save is disabled under the focus that pressed it: Reload, the way on, takes it.
    requestAnimationFrame(() => document.getElementById(`${uid}-reload`)?.focus());
  };

  const save = async () => {
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== opening || !Object.hasOwn(now.state.collections, collectionId)) return onClose();
    if (now.revision !== base.revision) return changedMeanwhile();
    const c = base.collection;
    const settled = settleDraft(c, draft);
    if (typeof settled === 'string') return setError(settled);
    const op = schemaUpdateOp(c, settled);
    if (!op) return onClose();
    const losses = schemaLosses(c, settled);
    if (losses.length) {
      const ok = await confirmDialog({
        title: 'Remove what the entries hold?',
        body: `Saving removes ${losses.join('; ')}.`,
        confirmLabel: 'Save and remove',
        danger: true,
        icon: 'delete',
        subject: c.settings.name,
        details: [{ kind: 'undo', text: 'You can undo it.' }]
      });
      if (!ok) return;
      // Another project opened while the question was open: nothing of this draft is its.
      const after = getState().snapshot;
      if (!after || after.workspaceKey !== opening) return onClose();
      // Changed while the question was open: what it said may no longer be all that goes.
      if (after.revision !== base.revision) return changedMeanwhile();
    }
    setBusy(true);
    let refused: string | null = null;
    // Only at the revision the draft was made at: a change made meanwhile is never written over.
    const r = await claimRefusals(
      (e) => ((refused = e.message), true),
      () => commitOps([op], `Change ${c.settings.name} settings`, undefined, base.revision)
    );
    setBusy(false);
    if (r?.ok) return onClose();
    if (refused) setError(refused);
    else if (getState().snapshot?.revision !== base.revision) changedMeanwhile();
    else setError('The settings could not be saved.');
  };

  const addField = (type: CollectionFieldType) => {
    const label = FIELD_TYPE_LABELS[type];
    const key = `new-${++added.current}`;
    // The new field's label takes focus, so the next keystrokes name it.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-row="${key}"] input`)?.select());
    set({
      fields: [
        ...draft.fields,
        {
          name: '',
          schema: newFieldSchema(type, label, collectionId),
          added: true,
          key
        }
      ]
    });
  };
  const addGrouping = () =>
    set({
      taxonomies: [
        ...draft.taxonomies,
        {
          id: '',
          label: 'Grouping',
          added: true,
          key: `new-${++added.current}`
        }
      ]
    });

  return (
    <Modal
      title={`${collection.settings.name} settings`}
      onClose={onClose}
      busy={busy}
      wide
      // A draft can hold many fields' edits: only Cancel, Close and Escape end it.
      dismissOnBackdrop={false}
      footer={
        <>
          {error && (
            <p className="field-error cs-error" role="alert">
              {error}
            </p>
          )}
          {stale && (
            <button id={`${uid}-reload`} className="btn" onClick={reload} disabled={busy}>
              Reload settings
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy || stale} data-testid="schema-save">
            Save
          </button>
        </>
      }
    >
      <div className="cs">
        <section className="cs-part" aria-labelledby={`${uid}-what`}>
          <h3 id={`${uid}-what`}>What it holds</h3>
          <div className="cs-row">
            <Field label="Name" controlId={`${uid}-name`}>
              <input id={`${uid}-name`} className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="One entry is called" controlId={`${uid}-singular`} hint={`Shown as “New ${entryNoun({ settings: { ...collection.settings, singularName: draft.singularName } }).toLowerCase()}”.`}>
              <input id={`${uid}-singular`} className="input" maxLength={80} placeholder={entryNoun({ settings: { ...collection.settings, singularName: '' } })} value={draft.singularName} onChange={(e) => set({ singularName: e.target.value })} />
            </Field>
          </div>
          <ChoiceField<CollectionKind>
            label="Kind"
            hint={KIND_HINTS[draft.kind]}
            value={draft.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { value: 'editorial', label: 'Articles' },
              { value: 'structured', label: 'Records' }
            ]}
          />
          <SwitchRow checked={draft.hasBody} onChange={(hasBody) => set({ hasBody })} label="Entries have text of their own" hint="Turning it off needs every entry’s text cleared first." />
        </section>
        <section className="cs-part" aria-labelledby={`${uid}-pages`}>
          <h3 id={`${uid}-pages`}>Pages</h3>
          <SwitchRow checked={draft.detail} onChange={(detail) => set({ detail, archive: detail && draft.archive })} label="A page for each entry" hint="Off, the entries are records other pages show, with no address of their own." />
          {draft.detail && (
            <>
              <SwitchRow checked={draft.archive} onChange={(archive) => set({ archive })} label="A page listing them all" hint="At the address below, with a page for each category and tag." />
              <Field label="Address" controlId={`${uid}-route`} hint={`Each entry’s address starts with it, such as ${draft.route.replace(/\/?$/, '/')}an-entry/.`}>
                <input id={`${uid}-route`} className="input" maxLength={200} spellCheck={false} value={draft.route} onChange={(e) => set({ route: e.target.value })} />
              </Field>
              {/* Records such as staff or listings stay out of the blog's feed unless the author puts them in. */}
              <SwitchRow
                checked={draftInFeed(draft)}
                onChange={(on) => set(draftFeedChoice(on))}
                label="Listed in the RSS feed"
                hint={draft.rss === undefined ? (draft.kind === 'structured' ? 'Records are left out unless this is turned on.' : 'Each published entry is listed in the site’s rss.xml.') : `Chosen for this collection, whatever its kind. Left to its kind, ${draft.kind === 'structured' ? 'records' : 'articles'} are ${draftKindFeeds(draft) ? 'listed' : 'left out'}.`}
              />
              {draft.rss !== undefined && (
                <button type="button" className="btn btn-sm cs-add" onClick={() => set({ rss: undefined })}>
                  Leave it to the kind
                </button>
              )}
            </>
          )}
        </section>
        <section className="cs-part" aria-labelledby={`${uid}-fields`}>
          <h3 id={`${uid}-fields`}>Fields</h3>
          <p className="cs-note">{draft.fields.length ? 'Each entry fills these in, in this order, and a hint is shown under its field. A saved field keeps its kind: to change it, remove the field and add another.' : 'No custom fields yet. Add one for each thing every entry states, such as a role or a price.'}</p>
          {draft.fields.length > 0 && (
            <ol className="cs-fields">
              {draft.fields.map((f, i) => {
                const rowKey = f.key ?? f.name;
                const name = f.schema.label || f.name || 'this field';
                return (
                  <li key={rowKey} className="cs-field" data-field={f.name || undefined} data-row={rowKey}>
                    <div className="cs-field-head">
                      <span className="cs-field-title">{f.schema.label || 'Untitled field'}</span>
                      {!f.added && <span className="badge">{FIELD_TYPE_LABELS[f.schema.type]}</span>}
                      {f.added ? (
                        <span className="badge accent">New</span>
                      ) : (
                        <span className="cs-field-key">
                          Name in layouts: <code>{f.name}</code>
                        </span>
                      )}
                      <span className="grow" />
                      <button className="icon-btn sm" aria-label={`Move ${name} up`} title="Move up" disabled={i === 0} data-move={`${rowKey}:up`} onClick={() => move(i, -1)}>
                        <ArrowUp />
                      </button>
                      <button className="icon-btn sm" aria-label={`Move ${name} down`} title="Move down" disabled={i === draft.fields.length - 1} data-move={`${rowKey}:down`} onClick={() => move(i, 1)}>
                        <ArrowDown />
                      </button>
                      <button className="icon-btn sm" aria-label={`Remove ${name}`} title="Remove field" onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}>
                        <Trash2 />
                      </button>
                    </div>
                    <FieldSettings row={f} collectionId={collectionId} collections={collections} onChange={(row) => setField(i, row)} />
                  </li>
                );
              })}
            </ol>
          )}
          <button
            className="btn btn-sm cs-add"
            {...addMenu.triggerProps()}
            onClick={(e) =>
              addMenu.openAt(
                e.currentTarget,
                COLLECTION_FIELD_TYPES.map((t) => ({ label: FIELD_TYPE_LABELS[t], onSelect: () => addField(t) })),
                'Add a field'
              )
            }
          >
            <Plus aria-hidden="true" /> Add a field
          </button>
          {addMenu.node}
        </section>
        <section className="cs-part" aria-labelledby={`${uid}-groups`}>
          <h3 id={`${uid}-groups`}>Groupings</h3>
          <p className="cs-note">Ways of filing entries, such as categories or departments. Their terms are added in the list of entries.</p>
          {draft.taxonomies.length > 0 && (
            <ul className="cs-groups" aria-label="Groupings">
              {draft.taxonomies.map((t, i) => (
                <li key={t.key ?? t.id} className="cs-group">
                  <Field label="Grouping name" controlId={`${uid}-group-${i}`}>
                    <input
                      id={`${uid}-group-${i}`}
                      className="input"
                      maxLength={60}
                      value={t.label}
                      onChange={(e) =>
                        set({
                          taxonomies: draft.taxonomies.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                        })
                      }
                    />
                  </Field>
                  <button
                    className="icon-btn sm"
                    aria-label={`Remove ${t.label || t.id}`}
                    title="Remove grouping"
                    onClick={() =>
                      set({
                        taxonomies: draft.taxonomies.filter((_, j) => j !== i)
                      })
                    }
                  >
                    <Trash2 />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-sm cs-add" onClick={addGrouping}>
            <Plus aria-hidden="true" /> Add a grouping
          </button>
        </section>
      </div>
    </Modal>
  );
}

/** One field's settings: its label (its name follows it until saved), kind, and what that kind takes, each labelled. */
function FieldSettings({ row, collectionId, collections, onChange }: { row: FieldRow; collectionId: string; collections: Array<{ id: string; name: string }>; onChange: (row: FieldRow) => void }) {
  const uid = useId();
  const s = row.schema;
  const put = (schema: CollectionFieldSchema) => onChange({ ...row, schema });
  return (
    <div className="cs-field-body">
      <div className="cs-field-grid">
        <Field label="Label" controlId={`${uid}-label`}>
          <input
            id={`${uid}-label`}
            className="input"
            maxLength={80}
            value={s.label}
            onChange={(e) =>
              onChange({
                ...row,
                schema: { ...s, label: e.target.value } as CollectionFieldSchema
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposing(e)) e.preventDefault();
            }}
          />
        </Field>
        {row.added && (
          <Field label="Kind" controlId={`${uid}-kind`}>
            <select id={`${uid}-kind`} className="select" value={s.type} onChange={(e) => put(retypeField(s, e.target.value as CollectionFieldType, collectionId))}>
              {COLLECTION_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {s.type === 'number' &&
          (['min', 'max'] as const).map((k) => (
            <Field key={k} label={k === 'min' ? 'Smallest' : 'Largest'} controlId={`${uid}-${k}`}>
              <input
                id={`${uid}-${k}`}
                className="input"
                type="number"
                placeholder="Any"
                value={s[k] ?? ''}
                onChange={(e) => {
                  const v = e.target.value === '' ? undefined : Number(e.target.value);
                  put({ ...s, [k]: Number.isFinite(v) ? v : undefined });
                }}
              />
            </Field>
          ))}
        {s.type === 'reference' && (
          <div className="cs-wide">
            <Field label="Names entries of" controlId={`${uid}-ref`}>
            <select id={`${uid}-ref`} className="select" value={s.collection} onChange={(e) => put({ ...s, collection: e.target.value })}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            </Field>
          </div>
        )}
        <div className="cs-hint">
          <Field label="Hint (optional)" controlId={`${uid}-hint`}>
            <input
              id={`${uid}-hint`}
              className="input"
              maxLength={300}
              value={s.description ?? ''}
              onChange={(e) =>
                put({
                  ...s,
                  description: e.target.value || undefined
                } as CollectionFieldSchema)
              }
            />
          </Field>
        </div>
      </div>
      {s.type === 'string' && (
        <label className="cs-check">
          <input type="checkbox" checked={!!s.multiline} onChange={(e) => put({ ...s, multiline: e.target.checked || undefined })} /> Several lines
        </label>
      )}
      {s.type === 'reference' &&
        (row.added ? (
          <label className="cs-check">
            <input
              type="checkbox"
              checked={!!s.multiple}
              onChange={(e) =>
                put({
                  ...s,
                  multiple: e.target.checked || undefined,
                  default: e.target.checked ? [] : ''
                })
              }
            />{' '}
            Can name several entries
          </label>
        ) : (
          <p className="cs-fact">{s.multiple ? 'Names several entries.' : 'Names one entry.'} Kept as it is once saved.</p>
        ))}
      {s.type === 'enum' && (
        <div className="cs-options" role="group" aria-labelledby={`${uid}-opts`}>
          <div className="cs-option cs-option-cols">
            <span id={`${uid}-opts`}>Options</span>
            <span id={`${uid}-default`}>Default</span>
            <span />
          </div>
          {s.options.map((o, i) => (
            <div key={o.value} className="cs-option">
              <input
                className="input"
                aria-label={`Option ${i + 1}`}
                maxLength={80}
                value={o.label}
                onChange={(e) =>
                  put({
                    ...s,
                    options: s.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                  })
                }
              />
              <span className="cs-option-default">
                <input type="radio" name={`${uid}-default`} aria-label={o.label || `Option ${i + 1}`} aria-describedby={`${uid}-default`} checked={s.default === o.value} onChange={() => put({ ...s, default: o.value })} />
              </span>
              <button
                className="icon-btn sm"
                aria-label={`Remove option ${o.label}`}
                title="Remove option"
                disabled={s.options.length <= 1}
                onClick={() => {
                  const options = s.options.filter((_, j) => j !== i);
                  put({
                    ...s,
                    options,
                    default: s.default === o.value ? options[0].value : s.default
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
          <button
            className="btn btn-sm btn-ghost cs-add-inline"
            onClick={() => {
              const taken = new Set(s.options.map((o) => o.value));
              let n = s.options.length + 1;
              while (taken.has(`option-${n}`)) n++;
              put({
                ...s,
                options: [...s.options, { value: `option-${n}`, label: `Option ${n}` }]
              });
            }}
          >
            <Plus aria-hidden="true" /> Add an option
          </button>
        </div>
      )}
    </div>
  );
}
