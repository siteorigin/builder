/**
 * Connect external source (#678): where a collection's entries are synced from (a REST or GraphQL API, Contentful,
 * Sanity, Strapi or WordPress), the secrets it signs in with (kept on this computer, never in the project), and how
 * each record becomes an entry: by path, detail by detail, or by the author's own converter.mjs. Test & Fetch Sample
 * reads the source as a sync would and shows the first records as it sent them and as entries, writing nothing. Save
 * is offered once the settings as they are now have passed that Test, and the main process tests them again as it saves.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { KeyRound, Plug, Plus, Trash2 } from 'lucide-react';
import type { SourceSampleResult } from '@shared/api';
import { SOURCE_ADAPTERS, SOURCE_REMOVALS, effectiveMapping, isBuiltInAdapter, isSecretName, sourceFingerprint } from '@shared/sources';
import { api, toast, useStore } from '../store';
import { Field, Modal, Segmented } from '../components/ui';
import { ADAPTER_IDS, MAPPED_DETAILS, draftSecretNames, sourceDraft, sourceForm, sourceOfCollection, type PairRow, type SourceForm } from '../lib/sources';

const REMOVAL_LABELS = { unpublish: 'Make it a draft (links keep working)', remove: 'Delete it', keep: 'Keep it as it is' } as const;

function Pairs({ label, rows, onChange, namePlaceholder, valuePlaceholder }: { label: string; rows: PairRow[]; onChange: (rows: PairRow[]) => void; namePlaceholder: string; valuePlaceholder: string }) {
  return (
    <fieldset className="source-pairs">
      <legend>{label}</legend>
      {rows.map((r, i) => (
        <div className="source-pair" key={i}>
          <input className="input" aria-label={`${label} ${i + 1} name`} placeholder={namePlaceholder} value={r.name} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input" aria-label={`${label} ${i + 1} value`} placeholder={valuePlaceholder} value={r.value} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="icon-btn sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        <Plus aria-hidden="true" /> Add
      </button>
    </fieldset>
  );
}

/** A secret the source names: whether this computer keeps it, and a place to keep (or replace) its value. */
function SecretRow({ name, saved, opening, onSaved }: { name: string; saved: boolean; opening: string; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!value || busy) return;
    setBusy(true);
    const r = await api.project.setSourceSecret(name, value, opening);
    setBusy(false);
    if (!r.ok) return toast(r.message ?? 'The secret could not be saved.', 'error');
    setValue('');
    onSaved();
  };
  return (
    <div className="source-secret">
      <span className="source-secret-name">
        <KeyRound aria-hidden="true" /> {name} <span className={`badge${saved ? '' : ' warn'}`}>{saved ? 'Saved on this computer' : 'Not saved yet'}</span>
      </span>
      <input className="input" type="password" autoComplete="off" aria-label={`Value of the secret ${name}`} placeholder={saved ? 'Replace its value' : 'Its value'} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className="btn btn-sm" disabled={!value || busy} onClick={() => void save()}>
        Save secret
      </button>
    </div>
  );
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export function SourceDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const [opening] = useState(() => snap?.workspaceKey ?? '');
  const collection = snap && Object.hasOwn(snap.state.collections, collectionId) ? snap.state.collections[collectionId] : undefined;
  const existing = snap ? sourceOfCollection(snap.state, collectionId) : undefined;
  const [form, setForm] = useState<SourceForm | null>(() => (snap && collection ? sourceForm(snap.state, collection.settings, existing) : null));
  /** The settings as the dialog was opened on them: Save never writes over a later change. */
  const [base] = useState(() => (existing ? sourceFingerprint(existing) : null));
  const [saved, setSaved] = useState<string[]>([]);
  const [secretsRead, setSecretsRead] = useState(0);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [sample, setSample] = useState<{ key: string; shape: SourceForm['shape']; result: SourceSampleResult } | null>(null);
  const uid = useId();
  useEffect(() => {
    let live = true;
    void api.project.sourceSecretNames(opening).then((names) => live && setSaved(names));
    return () => {
      live = false;
    };
  }, [opening, secretsRead]);
  const draft = useMemo(() => (form && collection ? sourceDraft(form, collectionId) : null), [form, collection, collectionId]);
  if (!snap || !collection || !form || snap.workspaceKey !== opening) return null;
  const set = (patch: Partial<SourceForm>) => setForm({ ...form, ...patch });
  const spec = SOURCE_ADAPTERS[form.adapter];
  // A kind this version cannot read is never shown as another, nor saved as one.
  const unknownKind = !!existing && !isBuiltInAdapter(existing.adapter);
  // What a Test read also depends on: the secrets' values (each save of one counts) and the collection's fields.
  const key = typeof draft === 'string' || !draft || unknownKind ? null : JSON.stringify([draft, secretsRead, collection.settings.fields]);
  const tested = sample && sample.key === key && sample.result.ok;
  const secretNames = typeof draft === 'object' && draft ? draftSecretNames(draft) : [];
  const defaults = effectiveMapping(form.adapter, undefined);
  const fields = Object.entries(collection.settings.fields ?? {});
  const text = (k: keyof SourceForm, label: string, placeholder?: string, hint?: string) => (
    <Field label={label} controlId={`${uid}-${k}`} hint={hint}>
      <input id={`${uid}-${k}`} className="input" placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );
  const area = (k: keyof SourceForm, label: string, placeholder?: string, rows = 6) => (
    <Field label={label} controlId={`${uid}-${k}`}>
      <textarea id={`${uid}-${k}`} className="input source-code" spellCheck={false} rows={rows} placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );

  const test = async () => {
    if (typeof draft !== 'object' || !draft || busy) return;
    setBusy('test');
    const tested = key;
    const result = await api.project.testSource(draft, opening).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setBusy(null);
    setSample({ key: tested ?? '', shape: form.shape, result });
  };
  const save = async () => {
    if (typeof draft !== 'object' || !draft || !tested || busy) return;
    setBusy('save');
    const r = await api.project.saveSource(draft, opening, base).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setBusy(null);
    if (!r.ok) return setSample({ key: key ?? '', shape: form.shape, result: { ok: false, message: r.message } });
    toast(`Saved “${draft.name}”. Sync now to bring its entries in.`, 'info');
    onClose();
  };

  return (
    <Modal
      wide
      title={existing ? `${existing.name}: source settings` : `Connect ${collection.settings.name} to an external source`}
      icon={<Plug aria-hidden="true" />}
      onClose={onClose}
      busy={busy !== null}
      dismissOnBackdrop={false}
      footer={
        <>
          <button className="btn" disabled={typeof draft !== 'object' || !draft || busy !== null || unknownKind} onClick={() => void test()} data-testid="source-test">
            {busy === 'test' ? 'Testing…' : 'Test & Fetch Sample'}
          </button>
          <button className="btn btn-primary" disabled={!tested || busy !== null} title={tested ? undefined : 'Test these settings first'} onClick={() => void save()} data-testid="source-save">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {/* Nothing changes while it is tested or saved: what is saved is what was tested. */}
      <fieldset className="source-dialog" disabled={busy !== null}>
        <p className="muted">Its entries are read from the source and are read-only here. Nothing is ever sent back to it.</p>
        {unknownKind && <p className="field-error">This source is of a kind ({existing!.adapter}) this version of the app cannot read, so its settings cannot be changed here.</p>}
        {text('name', 'Name')}
        <Field label="Kind of source" controlId={`${uid}-adapter`}>
          <select id={`${uid}-adapter`} className="input" value={form.adapter} disabled={!!existing && collection.settings.sourceId !== undefined} onChange={(e) => set({ adapter: e.target.value as SourceForm['adapter'] })}>
            {ADAPTER_IDS.map((id) => (
              <option key={id} value={id}>
                {SOURCE_ADAPTERS[id].label}
              </option>
            ))}
          </select>
        </Field>

        {form.adapter === 'rest' && (
          <>
            {text('url', 'Address', 'https://api.example.com/team')}
            <Segmented<'GET' | 'POST'> radio label="Asked with" value={form.method} onChange={(method) => set({ method })} options={[
                { value: 'GET', label: 'GET' },
                { value: 'POST', label: 'POST' }
              ]} />
            {form.method === 'POST' && area('body', 'JSON sent', '{ "query": "…" }', 3)}
            <Pairs label="Headers" rows={form.headers} onChange={(headers) => set({ headers })} namePlaceholder="Authorization" valuePlaceholder="Bearer ${secret:api-token}" />
            <Pairs label="Query parameters" rows={form.query} onChange={(query) => set({ query })} namePlaceholder="status" valuePlaceholder="published" />
            {text('itemsPath', 'Where the records are in a reply', 'data.items', 'Leave empty when the reply is the list.')}
            <Field label="Pages" controlId={`${uid}-paging`}>
              <select id={`${uid}-paging`} className="input" value={form.paging} onChange={(e) => set({ paging: e.target.value as SourceForm['paging'] })}>
                <option value="none">All at once</option>
                <option value="page">By page number</option>
                <option value="offset">By offset</option>
                <option value="cursor">By cursor</option>
                <option value="nextLink">By the next page’s address</option>
              </select>
            </Field>
            {(form.paging === 'page' || form.paging === 'offset' || form.paging === 'cursor') && text('pageParam', form.paging === 'cursor' ? 'Cursor parameter' : form.paging === 'page' ? 'Page parameter' : 'Offset parameter', form.paging === 'cursor' ? 'cursor' : form.paging === 'page' ? 'page' : 'offset')}
            {(form.paging === 'page' || form.paging === 'offset') && (
              <>
                {text('pageSizeParam', 'Page size parameter (optional)', form.paging === 'page' ? 'per_page' : 'limit')}
                {text('pageSize', 'Records per page', '100')}
                {form.paging === 'page' && text('pageStart', 'First page’s number', '1')}
              </>
            )}
            {form.paging === 'cursor' && text('cursorPath', 'Where a reply gives the next cursor', 'meta.next_cursor')}
            {form.paging === 'nextLink' && text('nextPath', 'Where a reply gives the next page’s address', 'links.next', 'Leave empty to follow its Link header.')}
          </>
        )}
        {form.adapter === 'graphql' && (
          <>
            {text('url', 'Address', 'https://api.example.com/graphql')}
            <Pairs label="Headers" rows={form.headers} onChange={(headers) => set({ headers })} namePlaceholder="Authorization" valuePlaceholder="Bearer ${secret:api-token}" />
            {area('graphql', 'Query', 'query { people { id name } }')}
            {area('variables', 'Variables (JSON)', '{ "first": 100 }', 3)}
            {text('itemsPath', 'Where the records are in a reply', 'data.people', 'Leave empty to read the first list under data.')}
          </>
        )}
        {form.adapter === 'contentful' && (
          <>
            {text('spaceId', 'Space ID')}
            {text('environment', 'Environment', 'master')}
            {text('contentType', 'Content type ID', 'teamMember')}
          </>
        )}
        {form.adapter === 'sanity' && (
          <>
            {text('projectId', 'Project ID')}
            {text('dataset', 'Dataset', 'production')}
            {area('groq', 'GROQ query', '*[_type == "person"]{ _id, name, "photo": photo.asset->url }', 3)}
          </>
        )}
        {(form.adapter === 'strapi' || form.adapter === 'wordpress') && (
          <>
            {text('url', 'Site address', form.adapter === 'strapi' ? 'https://cms.example.com' : 'https://blog.example.com')}
            {text('resource', form.adapter === 'strapi' ? 'Collection API ID (plural)' : 'Type of post', form.adapter === 'strapi' ? 'articles' : 'posts')}
          </>
        )}
        {Object.hasOwn(spec.credentials, 'token') && (
          <Field label={`Token secret${spec.credentials.token === 'optional' ? ' (optional)' : ''}`} controlId={`${uid}-token`} hint="The name of a secret kept on this computer. Its value is never saved in the project.">
            <input id={`${uid}-token`} className="input" placeholder="cms-token" value={form.token} onChange={(e) => set({ token: e.target.value })} />
          </Field>
        )}
        {secretNames.length > 0 && (
          <div className="source-secrets" role="group" aria-label="Secrets">
            {secretNames.filter(isSecretName).map((name) => (
              <SecretRow key={name} name={name} saved={saved.includes(name)} opening={opening} onSaved={() => setSecretsRead((n) => n + 1)} />
            ))}
          </div>
        )}

        <Segmented<SourceForm['shape']>
          radio
          full
          label="How records become entries"
          value={form.shape}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'mapping', label: 'Map fields', title: 'Say where each detail is in a record' },
            { value: 'converter', label: 'Converter', title: 'Your own converter.mjs puts records in shape' }
          ]}
        />
        {form.shape === 'mapping' ? (
          <div className="source-mapping" role="group" aria-label="Where each detail is read from">
            {MAPPED_DETAILS.filter((d) => d.key !== 'body' || collection.settings.hasBody !== false).map((d) => (
              <Field key={d.key} label={d.label} controlId={`${uid}-map-${d.key}`}>
                <input id={`${uid}-map-${d.key}`} className="input" placeholder={defaults[d.key] ?? ''} value={form.mapping[d.key] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [d.key]: e.target.value } })} />
              </Field>
            ))}
            {collection.settings.hasBody !== false && (
              <Field label="Text is written in" controlId={`${uid}-format`}>
                <select id={`${uid}-format`} className="input" value={form.bodyFormat} onChange={(e) => set({ bodyFormat: e.target.value as SourceForm['bodyFormat'] })}>
                  <option value="">{defaults.bodyFormat ? `As the source writes it (${defaults.bodyFormat})` : 'Plain text'}</option>
                  <option value="text">Plain text</option>
                  <option value="html">HTML</option>
                  <option value="markdown">Markdown</option>
                  <option value="contentful">Contentful Rich Text</option>
                </select>
              </Field>
            )}
            {fields.map(([name, f]) => (
              <Field key={name} label={`${f.label} (field)`} controlId={`${uid}-map-values-${name}`}>
                <input id={`${uid}-map-values-${name}`} className="input" placeholder={`fields.${name}`} value={form.mapping[`values.${name}`] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [`values.${name}`]: e.target.value } })} />
              </Field>
            ))}
            {/* A field the collection no longer has, which its sync would refuse: shown so it can be cleared. */}
            {Object.keys(form.mapping)
              .filter((k) => k.startsWith('values.') && form.mapping[k].trim() && !Object.hasOwn(collection.settings.fields ?? {}, k.slice(7)))
              .map((k) => (
                <Field key={k} label={`${k.slice(7)} (a field the collection no longer has)`} controlId={`${uid}-map-${k}`} error="Clear it, or add the field again.">
                  <input id={`${uid}-map-${k}`} className="input" value={form.mapping[k]} onChange={(e) => set({ mapping: { ...form.mapping, [k]: e.target.value } })} />
                </Field>
              ))}
          </div>
        ) : (
          area('converter', 'converter.mjs', undefined, 16)
        )}

        <Field label="When the source no longer has a record" controlId={`${uid}-removal`}>
          <select id={`${uid}-removal`} className="input" value={form.removal} onChange={(e) => set({ removal: e.target.value as SourceForm['removal'] })}>
            {SOURCE_REMOVALS.map((r) => (
              <option key={r} value={r}>
                {REMOVAL_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>

        {typeof draft === 'string' && <p className="field-error">{draft}</p>}
        {sample && (
          <div className="source-sample" aria-live="polite" data-testid="source-sample">
            {sample.result.ok ? (
              <>
                <p>
                  {sample.result.total} {sample.result.total === 1 ? 'record' : 'records'} read. A sync would add {sample.result.created}, change {sample.result.updated}, leave {sample.result.unchanged} unchanged
                  {sample.result.unpublished ? `, make ${sample.result.unpublished} drafts` : ''}
                  {sample.result.removed ? `, delete ${sample.result.removed}` : ''}.{sample.key !== key && ' The settings have changed since: test them again before saving.'}
                </p>
                {sample.result.total === 0 && <p className="muted">The source has no records, so nothing shows these settings make entries it can hold.</p>}
                {sample.shape === 'mapping' ? (
                  sample.result.raw.map((raw, i) => (
                    <div className="source-sample-row" key={i}>
                      <details open={i === 0}>
                        <summary>Record {i + 1} as the source sent it</summary>
                        <pre>{json(raw)}</pre>
                      </details>
                      <details open={i === 0}>
                        <summary>As an entry</summary>
                        <pre>{json(sample.result.ok ? sample.result.records[i] : null)}</pre>
                      </details>
                    </div>
                  ))
                ) : (
                  // A converter may leave records out or reorder them: what it was given and what it gave, each in order.
                  <div className="source-sample-row">
                    <details open>
                      <summary>The first records as the source sent them</summary>
                      <pre>{json(sample.result.raw)}</pre>
                    </details>
                    <details open>
                      <summary>The first entries the converter gave</summary>
                      <pre>{json(sample.result.records)}</pre>
                    </details>
                  </div>
                )}
              </>
            ) : (
              <p className="field-error" role="alert">
                {sample.result.message}
              </p>
            )}
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
