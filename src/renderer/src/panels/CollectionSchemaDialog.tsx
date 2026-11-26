/**
 * A collection's settings (#675): what it is called and holds, the pages the website has for it, and the custom fields
 * and groupings its entries fill in. Everything changed is saved together, as one step to undo, when the dialog's Save
 * is pressed; the engine's refusal (an address taken, a field a layout shows) is said inside the dialog, which stays
 * open with what was typed.
 */
import { useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CollectionFieldSchema, CollectionKind } from '@shared/types';
import { COLLECTION_FIELD_TYPES } from '@shared/types';
import { claimRefusals, commitOps, confirmDialog, getState, useStore } from '../store';
import { Field, Modal, Segmented, SwitchRow } from '../components/ui';
import { FIELD_TYPE_LABELS, entryNoun, newFieldSchema, retypeField, schemaDraftOf, schemaLosses, schemaUpdateOp, settleDraft, type CollectionFieldType, type FieldRow, type SchemaDraft } from '../lib/content';
import { isImeComposing } from '../lib/ime';

export function CollectionSchemaDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const collection = snap && Object.hasOwn(snap.state.collections, collectionId) ? snap.state.collections[collectionId] : undefined;
  /** The project this dialog was opened in: a draft is never saved into another. */
  const [opening] = useState(() => snap?.workspaceKey);
  const [draft, setDraft] = useState<SchemaDraft | null>(() => (collection ? schemaDraftOf(collection) : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** How many rows were added, for each one's key while its name is not settled. */
  const added = useRef(0);
  const uid = useId();
  if (!snap || !collection || !draft || snap.workspaceKey !== opening) return null;
  const state = snap.state;
  const set = (patch: Partial<SchemaDraft>) => (setDraft({ ...draft, ...patch }), setError(null));
  const setField = (i: number, row: FieldRow) => set({ fields: draft.fields.map((f, j) => (j === i ? row : f)) });
  const collections = Object.values(state.collections)
    .map((c) => c.settings)
    .sort((a, b) => a.name.localeCompare(b.name));

  const save = async () => {
    const now = getState().snapshot;
    const c = now && now.workspaceKey === opening && Object.hasOwn(now.state.collections, collectionId) ? now.state.collections[collectionId] : undefined;
    if (!now || !c) return onClose();
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
    }
    setBusy(true);
    let refused: string | null = null;
    // Saved against the project as it was read just now: a change made meanwhile (a term added) is never written over.
    const r = await claimRefusals(
      (e) => ((refused = e.message), true),
      () => commitOps([op], `Change ${c.settings.name} settings`, undefined, getState().snapshot?.revision)
    );
    setBusy(false);
    if (r?.ok) return onClose();
    setError(refused ?? 'The settings could not be saved. The project may have changed meanwhile: check them and save again.');
  };

  const addField = (type: CollectionFieldType) => {
    const label = FIELD_TYPE_LABELS[type];
    set({ fields: [...draft.fields, { name: '', schema: newFieldSchema(type, label, collectionId), added: true, key: `new-${++added.current}` }] });
  };
  const addGrouping = () => set({ taxonomies: [...draft.taxonomies, { id: '', label: 'Grouping', added: true, key: `new-${++added.current}` }] });

  return (
    <Modal
      title={`${collection.settings.name} settings`}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          {error && (
            <p className="field-error schema-error" role="alert">
              {error}
            </p>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy} data-testid="schema-save">
            Save
          </button>
        </>
      }
    >
      <div className="schema-dialog">
        <section aria-labelledby={`${uid}-what`}>
          <h4 id={`${uid}-what`}>What it holds</h4>
          <Field label="Name" controlId={`${uid}-name`}>
            <input id={`${uid}-name`} className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="One entry is called" controlId={`${uid}-singular`} hint={`Shown as “New ${entryNoun({ settings: { ...collection.settings, singularName: draft.singularName } }).toLowerCase()}”.`}>
            <input id={`${uid}-singular`} className="input" maxLength={80} placeholder="Entry" value={draft.singularName} onChange={(e) => set({ singularName: e.target.value })} />
          </Field>
          <Segmented<CollectionKind>
            radio
            label="Kind"
            value={draft.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { value: 'editorial', label: 'Articles', title: 'Dated pieces written in a distraction-free editor, such as blog posts' },
              { value: 'structured', label: 'Records', title: 'Entries made of fields, such as team members or projects' }
            ]}
          />
          <SwitchRow checked={draft.hasBody} onChange={(hasBody) => set({ hasBody })} label="Entries have text of their own" hint="Turning it off needs every entry’s text cleared first." />
        </section>
        <section aria-labelledby={`${uid}-pages`}>
          <h4 id={`${uid}-pages`}>Pages</h4>
          <SwitchRow checked={draft.detail} onChange={(detail) => set({ detail, archive: detail && draft.archive })} label="A page for each entry" hint="Off, the entries are records other pages show, with no address of their own." />
          {draft.detail && (
            <>
              <SwitchRow checked={draft.archive} onChange={(archive) => set({ archive })} label="A page listing them all" />
              <Field label="Address" controlId={`${uid}-route`} hint={`Each entry’s address starts with it, such as ${draft.route.replace(/\/?$/, '/')}an-entry/.`}>
                <input id={`${uid}-route`} className="input" maxLength={200} spellCheck={false} value={draft.route} onChange={(e) => set({ route: e.target.value })} />
              </Field>
            </>
          )}
        </section>
        <section aria-labelledby={`${uid}-fields`}>
          <h4 id={`${uid}-fields`}>Fields</h4>
          {!draft.fields.length && <p className="posts-note">No custom fields yet. Add one for each thing every entry states, such as a role or a price.</p>}
          <ul className="schema-fields">
            {draft.fields.map((f, i) => (
              <li key={f.key ?? f.name} className="schema-field" data-field={f.name || undefined}>
                <FieldSettings row={f} collectionId={collectionId} collections={collections} onChange={(row) => setField(i, row)} />
                <button className="icon-btn sm" aria-label={`Remove ${f.schema.label || f.name}`} title="Remove field" onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}>
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
          <label className="schema-add">
            <Plus aria-hidden="true" />
            <select
              className="select sm"
              aria-label="Add a field"
              value=""
              onChange={(e) => {
                if (e.target.value) addField(e.target.value as CollectionFieldType);
              }}
            >
              <option value="">Add a field…</option>
              {COLLECTION_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        </section>
        <section aria-labelledby={`${uid}-groups`}>
          <h4 id={`${uid}-groups`}>Groupings</h4>
          <p className="posts-note">Ways of filing entries, such as categories or departments. Their terms are added in the list of entries.</p>
          <ul className="schema-fields">
            {draft.taxonomies.map((t, i) => (
              <li key={t.key ?? t.id} className="schema-field">
                <input
                  className="input"
                  aria-label={`Grouping name (${t.id})`}
                  maxLength={60}
                  value={t.label}
                  onChange={(e) => set({ taxonomies: draft.taxonomies.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                />
                {!t.added && <code className="faint">{t.id}</code>}
                <button className="icon-btn sm" aria-label={`Remove ${t.label || t.id}`} title="Remove grouping" onClick={() => set({ taxonomies: draft.taxonomies.filter((_, j) => j !== i) })}>
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-sm btn-ghost" onClick={addGrouping}>
            <Plus aria-hidden="true" /> Add a grouping
          </button>
        </section>
      </div>
    </Modal>
  );
}

/** One field's settings: its label (its name follows it until saved), kind, and what that kind takes. */
function FieldSettings({ row, collectionId, collections, onChange }: { row: FieldRow; collectionId: string; collections: Array<{ id: string; name: string }>; onChange: (row: FieldRow) => void }) {
  const uid = useId();
  const s = row.schema;
  const put = (schema: CollectionFieldSchema) => onChange({ ...row, schema });
  return (
    <div className="schema-field-body">
      <div className="schema-field-head">
        <input
          className="input"
          aria-label="Field label"
          maxLength={80}
          value={s.label}
          onChange={(e) => onChange({ ...row, schema: { ...s, label: e.target.value } as CollectionFieldSchema })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isImeComposing(e)) e.preventDefault();
          }}
        />
        {row.added ? (
          <select className="select sm" aria-label={`Kind of ${s.label || 'field'}`} value={s.type} onChange={(e) => put(retypeField(s, e.target.value as CollectionFieldType, collectionId))}>
            {COLLECTION_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        ) : (
          <span className="badge" title="A saved field keeps its kind: remove it and add another to change it.">
            {FIELD_TYPE_LABELS[s.type]}
          </span>
        )}
        {!row.added && (
          <code className="faint" title="The name layouts and lists read it by">
            {row.name}
          </code>
        )}
      </div>
      {s.type === 'string' && (
        <label className="schema-check">
          <input type="checkbox" checked={!!s.multiline} onChange={(e) => put({ ...s, multiline: e.target.checked || undefined })} /> Several lines
        </label>
      )}
      {s.type === 'reference' && (
        <div className="schema-field-row">
          <select className="select sm" aria-label={`Collection ${s.label || 'it'} names entries of`} value={s.collection} onChange={(e) => put({ ...s, collection: e.target.value })}>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="schema-check">
            <input type="checkbox" checked={!!s.multiple} disabled={!row.added} onChange={(e) => put({ ...s, multiple: e.target.checked || undefined, default: e.target.checked ? [] : '' })} /> Several
          </label>
        </div>
      )}
      {s.type === 'enum' && (
        <div className="schema-options" role="group" aria-labelledby={`${uid}-opts`}>
          <span id={`${uid}-opts`} className="faint">
            Options
          </span>
          {s.options.map((o, i) => (
            <div key={o.value} className="schema-field-row">
              <input
                className="input sm"
                aria-label={`Option ${i + 1}`}
                maxLength={80}
                value={o.label}
                onChange={(e) => put({ ...s, options: s.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
              />
              <label className="schema-check">
                <input type="radio" name={`${uid}-default`} checked={s.default === o.value} onChange={() => put({ ...s, default: o.value })} /> Default
              </label>
              <button
                className="icon-btn sm"
                aria-label={`Remove option ${o.label}`}
                disabled={s.options.length <= 1}
                onClick={() => {
                  const options = s.options.filter((_, j) => j !== i);
                  put({ ...s, options, default: s.default === o.value ? options[0].value : s.default });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              const taken = new Set(s.options.map((o) => o.value));
              let n = s.options.length + 1;
              while (taken.has(`option-${n}`)) n++;
              put({ ...s, options: [...s.options, { value: `option-${n}`, label: `Option ${n}` }] });
            }}
          >
            <Plus aria-hidden="true" /> Add an option
          </button>
        </div>
      )}
      {s.type === 'number' && (
        <div className="schema-field-row">
          {(['min', 'max'] as const).map((k) => (
            <input
              key={k}
              className="input sm"
              type="number"
              aria-label={k === 'min' ? 'Smallest' : 'Largest'}
              placeholder={k === 'min' ? 'Smallest' : 'Largest'}
              value={s[k] ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value);
                put({ ...s, [k]: Number.isFinite(v) ? v : undefined });
              }}
            />
          ))}
        </div>
      )}
      <input className="input sm" aria-label={`Hint for ${s.label || 'the field'}`} placeholder="Hint shown under the field (optional)" maxLength={300} value={s.description ?? ''} onChange={(e) => put({ ...s, description: e.target.value || undefined } as CollectionFieldSchema)} />
    </div>
  );
}
