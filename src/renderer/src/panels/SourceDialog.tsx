/**
 * Connect external source (#678): where a collection's entries are synced from (a REST or GraphQL API, Contentful,
 * Sanity, Strapi or WordPress), the secrets it signs in with (kept on this computer, never in the project), and how
 * each record becomes an entry: by path, detail by detail, or by the author's own converter.mjs. Test & Fetch Sample
 * reads the source as a sync would and shows the first records as it sent them and as entries, writing nothing. Save
 * is offered once the settings as they are now have passed that Test, and the main process tests them again as it saves.
 *
 * The form is cut into headed sections in the order the task runs (the source, where its records are, signing in,
 * how records become entries, records that go away), and the footer always says where the Test stands, so its result
 * is seen wherever the form is scrolled to.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyRound, Plug, Plus, Trash2 } from 'lucide-react';
import type { SourceSampleResult } from '@shared/api';
import { SOURCE_ADAPTERS, SOURCE_REMOVALS, effectiveMapping, isBuiltInAdapter, isSecretName, sourceFingerprint } from '@shared/sources';
import { api, toast, useStore } from '../store';
import { ChoiceField, Field, Modal } from '../components/ui';
import { ADAPTER_IDS, MAPPED_DETAILS, draftSecretNames, sourceDraft, sourceForm, sourceOfCollection, type PairRow, type SourceForm } from '../lib/sources';
import './SourceDialog.css';

const REMOVAL_LABELS = { unpublish: 'Make it a draft (links keep working)', remove: 'Delete it', keep: 'Keep it as it is' } as const;

/** A list of name and value pairs (headers, query parameters): its heading and Add on one line, then labelled rows. */
function Pairs({ label, addLabel, hint, rows, onChange, namePlaceholder, valuePlaceholder }: { label: string; addLabel: string; hint?: ReactNode; rows: PairRow[]; onChange: (rows: PairRow[]) => void; namePlaceholder: string; valuePlaceholder: string }) {
  const id = useId();
  return (
    <div className="sd-pairs" role="group" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}>
      <div className="sd-pairs-head">
        <span className="field-label grow" id={`${id}-l`}>
          {label}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus aria-hidden="true" /> {addLabel}
        </button>
      </div>
      {rows.length > 0 && (
        <div className="sd-pair sd-pair-cols" aria-hidden="true">
          <span>Name</span>
          <span>Value</span>
        </div>
      )}
      {rows.map((r, i) => (
        <div className="sd-pair" key={i}>
          <input className="input" aria-label={`${label} ${i + 1} name`} placeholder={namePlaceholder} value={r.name} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input" aria-label={`${label} ${i + 1} value`} placeholder={valuePlaceholder} value={r.value} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="icon-btn sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </button>
        </div>
      ))}
      {hint && (
        <div className="field-hint" id={`${id}-h`}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A secret the source names: whether this computer keeps it, and a place to keep (or replace) its value. */
function SecretRow({ id, name, saved, opening, onSaved }: { id: string; name: string; saved: boolean; opening: string; onSaved: () => void }) {
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
    <div className="sd-secret">
      <label htmlFor={id} className="sd-secret-name">
        <KeyRound aria-hidden="true" />
        <span className="sd-secret-key">{name}</span>
        <span className={`badge ${saved ? 'green' : 'amber'}`}>{saved ? 'Saved on this computer' : 'Not saved yet'}</span>
      </label>
      <div className="sd-secret-entry">
        <input
          id={id}
          className="input"
          type="password"
          autoComplete="off"
          aria-label={`Value of the secret ${name}`}
          placeholder={saved ? 'A new value replaces the saved one' : 'Its value'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
        />
        <button type="button" className="btn" disabled={!value || busy} onClick={() => void save()}>
          Keep on this computer
        </button>
      </div>
    </div>
  );
}

/** A headed part of the form. */
function Part({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sd-part" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {hint && <p className="sd-part-hint">{hint}</p>}
      {children}
    </section>
  );
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
/** How a scroll the dialog makes moves: at once when the person asks for less motion. */
const scrollBehavior = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
/** Each required setting as the footer asks for it, by the words the form labels it with. */
const REQUIRED_WORDS: Record<string, (adapter: SourceForm['adapter']) => string> = {
  url: (a) => (a === 'strapi' || a === 'wordpress' ? 'the site address' : 'the address'),
  graphql: () => 'the query',
  groq: () => 'the query',
  spaceId: () => 'the space ID',
  contentType: () => 'the content type ID',
  projectId: () => 'the project ID',
  dataset: () => 'the dataset',
  resource: (a) => (a === 'strapi' ? 'the collection’s API name' : 'the type of post')
};
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

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
  const sampleRef = useRef<HTMLElement>(null);
  const sampleHead = useRef<HTMLHeadingElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  /** The secrets the settings named when they last made sense: a slip elsewhere in the form never takes away a secret's row (and what is typed in it). */
  const lastSecrets = useRef<string[]>([]);
  const uid = useId();
  useEffect(() => {
    let live = true;
    void api.project.sourceSecretNames(opening).then((names) => live && setSaved(names));
    return () => {
      live = false;
    };
  }, [opening, secretsRead]);
  const draft = useMemo(() => (form && collection ? sourceDraft(form, collectionId) : null), [form, collection, collectionId]);
  // A passing Test brings its sample into view, so what it read is seen without hunting for it.
  useEffect(() => {
    if (sample?.result.ok) sampleRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  }, [sample]);
  if (!snap || !collection || !form || snap.workspaceKey !== opening) return null;
  const set = (patch: Partial<SourceForm>) => setForm({ ...form, ...patch });
  const spec = SOURCE_ADAPTERS[form.adapter];
  // A kind this version cannot read is never shown as another, nor saved as one.
  const unknownKind = !!existing && !isBuiltInAdapter(existing.adapter);
  // What a Test read also depends on: the secrets' values (each save of one counts) and the collection's fields.
  const key = typeof draft === 'string' || !draft || unknownKind ? null : JSON.stringify([draft, secretsRead, collection.settings.fields]);
  const tested = sample && sample.key === key && sample.result.ok;
  /** The last Test was of the settings as they are now. */
  const current = !!sample && sample.key === key;
  const secretNames = typeof draft === 'object' && draft ? (lastSecrets.current = draftSecretNames(draft).filter(isSecretName)) : lastSecrets.current;
  const missingSecrets = secretNames.filter((n) => !saved.includes(n));
  /** The first required setting left empty, by its form key: a Test would only fail without it. */
  const missingSetting = spec.required.find((k) => Object.hasOwn(form, k) && !String(form[k as keyof SourceForm] ?? '').trim());
  /** Takes the person to the control a prerequisite names. */
  const goTo = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el?.focus({ preventScroll: true });
  };
  const missingToken = spec.credentials.token === 'required' && !form.token.trim();
  const ask = (target: string, words: ReactNode) => (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(target)}>
        {words}
      </button>{' '}
      to test the settings.
    </>
  );
  const prerequisite: ReactNode = !form.name.trim() ? (
    ask(`${uid}-name`, 'Give the source a name')
  ) : missingSetting ? (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(`${uid}-${missingSetting}`)}>
        Give {REQUIRED_WORDS[missingSetting]?.(form.adapter) ?? missingSetting}
      </button>{' '}
      to test the settings.
    </>
  ) : missingToken ? (
    ask(`${uid}-token`, 'Give the access token a name')
  ) : missingSecrets.length ? (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(`${uid}-secret-${missingSecrets[0]}`)}>
        Keep the secret {missingSecrets[0]} on this computer
      </button>{' '}
      to test the settings.
    </>
  ) : null;
  const defaults = effectiveMapping(form.adapter, undefined);
  const fields = Object.entries(collection.settings.fields ?? {});
  const text = (k: keyof SourceForm, label: string, placeholder?: string, hint?: ReactNode) => (
    <Field label={label} controlId={`${uid}-${k}`} hint={hint}>
      <input id={`${uid}-${k}`} className="input" placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );
  const area = (k: keyof SourceForm, label: string, placeholder?: string, rows = 4, hint?: ReactNode) => (
    <Field label={label} controlId={`${uid}-${k}`} hint={hint}>
      <textarea id={`${uid}-${k}`} className="textarea sd-code" spellCheck={false} rows={rows} style={{ minHeight: `${rows * 1.5 + 1}em` }} placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );

  const test = async () => {
    if (typeof draft !== 'object' || !draft || busy) return;
    setBusy('test');
    const tested = key;
    const result = await api.project.testSource(draft, opening).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setBusy(null);
    setSample({ key: tested ?? '', shape: form.shape, result });
    // The Test button was disabled while it ran, which dropped keyboard focus: it goes to the sample a pass shows, or
    // back to Test after a failure, so Tab carries on from where the person was.
    const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === testButton.current;
    if (lost) requestAnimationFrame(() => (result.ok ? sampleHead.current?.focus({ preventScroll: true }) : testButton.current?.focus()));
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

  /**
   * The collection's fields no entry the Test made has a value for, each with why: not read from the records at all
   * (and the key in them that looks like it, to read it from), or read from a path no record had.
   */
  const gaps =
    sample?.result.ok && current && sample.shape === 'mapping' && sample.result.records.length
      ? fields
          .filter(([name]) => sample.result.ok && sample.result.records.every((r) => isEmpty((r as { values?: Record<string, unknown> })?.values?.[name])))
          .map(([name, f]) => {
            const path = (form.mapping[`values.${name}`] ?? '').trim();
            const keys = sample.result.ok ? sample.result.raw.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])) : [];
            const like = [name, f.label].map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
            const suggestion = path ? undefined : keys.find((k) => like.includes(k.toLowerCase().replace(/[^a-z0-9]/g, '')));
            return { name, label: f.label, path, suggestion };
          })
      : [];

  // Where the Test stands, said in the footer beside its button: seen at any scroll position.
  const failed = !!sample && current && !sample.result.ok;
  const status: ReactNode =
    busy === 'test' ? (
      <span className="muted">Reading the source…</span>
    ) : busy === 'save' ? (
      <span className="muted">Testing again and saving…</span>
    ) : prerequisite ? (
      <span className="muted">{prerequisite}</span>
    ) : typeof draft === 'string' ? (
      <span className="field-error">{draft}</span>
    ) : sample && failed && !sample.result.ok ? (
      <span className="field-error">{sample.result.message}</span>
    ) : sample && current && sample.result.ok ? (
      <span className="sd-status-ok">
        <span className="badge green">Test passed</span>
        <span>
          {sample.result.total} {sample.result.total === 1 ? 'record' : 'records'} read.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              sampleRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
              sampleHead.current?.focus({ preventScroll: true });
            }}
          >
            Show the sample
          </button>
        </span>
      </span>
    ) : sample ? (
      <span className="muted">The settings changed since the last test. Test them again to save them.</span>
    ) : (
      <span className="muted">Test these settings to save them.</span>
    );

  const method = (
    <ChoiceField<'GET' | 'POST'>
      label="Asked with"
      hint={form.method === 'GET' ? 'GET reads an address, as most APIs expect.' : 'POST sends a JSON body with each request, as some search APIs expect.'}
      value={form.method}
      onChange={(method) => set({ method })}
      options={[
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' }
      ]}
    />
  );
  const headers = (
    <Pairs
      label="Headers"
      addLabel="Add a header"
      rows={form.headers}
      onChange={(headers) => set({ headers })}
      namePlaceholder="Authorization"
      valuePlaceholder="Bearer ${secret:api-token}"
      hint={
        <>
          Where a token goes, write <code>{'${secret:api-token}'}</code> and keep its value on this computer below.
        </>
      }
    />
  );

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
          {/* A failure is said at once; everything else waits its turn. */}
          <div className="sd-status grow" aria-live={failed ? 'assertive' : 'polite'} data-testid="source-status">
            {status}
          </div>
          <button className="btn" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button ref={testButton} className="btn" disabled={typeof draft !== 'object' || !draft || busy !== null || unknownKind || !!prerequisite} onClick={() => void test()} data-testid="source-test">
            {busy === 'test' ? 'Testing…' : 'Test and fetch a sample'}
          </button>
          <button className="btn btn-primary" disabled={!tested || busy !== null} onClick={() => void save()} data-testid="source-save">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {/* Nothing changes while it is tested or saved: what is saved is what was tested. */}
      <fieldset className="sd" disabled={busy !== null}>
        <p className="sd-intro">Its entries are read from the source and are read-only here. Nothing is ever sent back to it.</p>
        {unknownKind && <p className="field-error">This source is of a kind ({existing!.adapter}) this version of the app cannot read, so its settings cannot be changed here.</p>}

        <Part title="The source">
          <div className="sd-row">
            {text('name', 'Name')}
            <Field label="Kind of source" controlId={`${uid}-adapter`} hint={existing && collection.settings.sourceId !== undefined ? 'A connected source keeps its kind. Detach it to connect another.' : undefined}>
              <select id={`${uid}-adapter`} className="select" value={form.adapter} disabled={!!existing && collection.settings.sourceId !== undefined} onChange={(e) => set({ adapter: e.target.value as SourceForm['adapter'] })}>
                {ADAPTER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {SOURCE_ADAPTERS[id].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Part>

        <Part title="Where the records are">
          {form.adapter === 'rest' && (
            <>
              {text('url', 'Address', 'https://api.example.com/team')}
              {method}
              {form.method === 'POST' && area('body', 'JSON sent', '{ "query": "…" }', 3)}
              {headers}
              <Pairs label="Query parameters" addLabel="Add a parameter" rows={form.query} onChange={(query) => set({ query })} namePlaceholder="status" valuePlaceholder="published" hint={form.query.length ? 'Added to the address as ?name=value.' : undefined} />
              {text('itemsPath', 'Where the records are in a reply', 'data.items', 'The path to the list, such as data.items. Leave empty when the reply is the list.')}
              <Field label="How it sends long lists" controlId={`${uid}-paging`}>
                <select id={`${uid}-paging`} className="select" value={form.paging} onChange={(e) => set({ paging: e.target.value as SourceForm['paging'] })}>
                  <option value="none">All at once</option>
                  <option value="page">In pages, by page number</option>
                  <option value="offset">In pages, by offset</option>
                  <option value="cursor">In pages, by cursor</option>
                  <option value="nextLink">In pages, each giving the next page’s address</option>
                </select>
              </Field>
              {(form.paging === 'page' || form.paging === 'offset' || form.paging === 'cursor') && (
                <div className="sd-row">
                  {text('pageParam', form.paging === 'cursor' ? 'Cursor parameter' : form.paging === 'page' ? 'Page parameter' : 'Offset parameter', form.paging === 'cursor' ? 'cursor' : form.paging === 'page' ? 'page' : 'offset')}
                  {(form.paging === 'page' || form.paging === 'offset') && text('pageSizeParam', 'Page size parameter (optional)', form.paging === 'page' ? 'per_page' : 'limit')}
                </div>
              )}
              {(form.paging === 'page' || form.paging === 'offset') && (
                <div className="sd-row">
                  {text('pageSize', 'Records per page', '100')}
                  {form.paging === 'page' && text('pageStart', 'First page’s number', '1')}
                </div>
              )}
              {form.paging === 'cursor' && text('cursorPath', 'Where a reply gives the next cursor', 'meta.next_cursor')}
              {form.paging === 'nextLink' && text('nextPath', 'Where a reply gives the next page’s address', 'links.next', 'Leave empty to follow its Link header.')}
            </>
          )}
          {form.adapter === 'graphql' && (
            <>
              {text('url', 'Address', 'https://api.example.com/graphql')}
              {headers}
              {area('graphql', 'Query', 'query { people { id name } }', 6, 'The GraphQL query that asks for the records.')}
              {area('variables', 'Variables (JSON)', '{ "first": 100 }', 3)}
              {text('itemsPath', 'Where the records are in a reply', 'data.people', 'Leave empty to read the first list under data.')}
            </>
          )}
          {form.adapter === 'contentful' && (
            <div className="sd-row sd-row-3">
              {text('spaceId', 'Space ID', undefined, 'In Contentful under Settings → General settings.')}
              {text('environment', 'Environment', 'master')}
              {text('contentType', 'Content type ID', 'teamMember', 'Shown beside the content type’s name.')}
            </div>
          )}
          {form.adapter === 'sanity' && (
            <>
              <div className="sd-row">
                {text('projectId', 'Project ID', undefined, 'In sanity.io/manage, under the project’s name.')}
                {text('dataset', 'Dataset', undefined, 'Usually production.')}
              </div>
              {area('groq', 'Query (GROQ)', '*[_type == "person"]{ _id, name, "photo": photo.asset->url }', 4, 'Which documents to read, in Sanity’s query language. *[_type == "person"] reads every person.')}
            </>
          )}
          {(form.adapter === 'strapi' || form.adapter === 'wordpress') && (
            <div className="sd-row">
              {text('url', 'Site address', form.adapter === 'strapi' ? 'https://cms.example.com' : 'https://blog.example.com')}
              {form.adapter === 'strapi'
                ? text('resource', 'Collection’s API name', 'articles', 'The plural name in its address: /api/articles is articles.')
                : text('resource', 'Type of post', 'posts', 'posts, pages, or a custom post type’s REST name.')}
            </div>
          )}
        </Part>

        {(Object.hasOwn(spec.credentials, 'token') || secretNames.length > 0) && (
          <Part title="Signing in" hint="Tokens and passwords are kept on this computer, never in the project.">
            {Object.hasOwn(spec.credentials, 'token') && (
              <Field
                label={`Access token’s name${spec.credentials.token === 'optional' ? ' (optional)' : ''}`}
                controlId={`${uid}-token`}
                hint={spec.credentials.token === 'optional' ? 'Leave it empty for a public source. Otherwise give the token any name, such as cms-token; its value is asked for below.' : 'Any name, such as cms-token: its value is asked for below.'}
              >
                <input id={`${uid}-token`} className="input" placeholder="cms-token" value={form.token} onChange={(e) => set({ token: e.target.value })} />
              </Field>
            )}
            {secretNames.length > 0 && (
              <div className="sd-secrets" role="group" aria-label="Secrets">
                {secretNames.map((name) => (
                  <SecretRow key={name} id={`${uid}-secret-${name}`} name={name} saved={saved.includes(name)} opening={opening} onSaved={() => setSecretsRead((n) => n + 1)} />
                ))}
              </div>
            )}
          </Part>
        )}

        <Part title="How records become entries">
          <ChoiceField<SourceForm['shape']>
            label="Each record is read"
            value={form.shape}
            onChange={(shape) => set({ shape })}
            options={[
              { value: 'mapping', label: 'Detail by detail' },
              { value: 'converter', label: 'By a script you write' }
            ]}
          />
          {form.shape === 'mapping' ? (
            <>
              <p className="sd-part-hint">
                For each detail, the name it has in a record, such as <code>name</code> or <code>author.name</code>. Leave a box empty to use the default shown in it.
              </p>
              <div className="sd-map" role="group" aria-label="Where each detail is read from">
                {MAPPED_DETAILS.filter((d) => d.key !== 'body' || collection.settings.hasBody !== false).map((d) => (
                  <Field key={d.key} label={d.label} controlId={`${uid}-map-${d.key}`}>
                    <input id={`${uid}-map-${d.key}`} className="input" placeholder={defaults[d.key] ?? 'Not read'} value={form.mapping[d.key] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [d.key]: e.target.value } })} />
                  </Field>
                ))}
                {collection.settings.hasBody !== false && (
                  <Field label="Text is written in" controlId={`${uid}-format`}>
                    <select id={`${uid}-format`} className="select" value={form.bodyFormat} onChange={(e) => set({ bodyFormat: e.target.value as SourceForm['bodyFormat'] })}>
                      <option value="">{defaults.bodyFormat ? `As the source writes it (${defaults.bodyFormat})` : 'Plain text'}</option>
                      <option value="text">Plain text</option>
                      <option value="html">HTML</option>
                      <option value="markdown">Markdown</option>
                      <option value="contentful">Contentful Rich Text</option>
                    </select>
                  </Field>
                )}
              </div>
              {(fields.length > 0 || Object.keys(form.mapping).some((k) => k.startsWith('values.'))) && (
                <>
                  <h4 className="sd-subhead">{collection.settings.name}’s fields</h4>
                  <div className="sd-map" role="group" aria-label={`Where each of ${collection.settings.name}’s fields is read from`}>
                    {fields.map(([name, f]) => (
                      <Field key={name} label={f.label} controlId={`${uid}-map-values-${name}`}>
                        <input id={`${uid}-map-values-${name}`} className="input" placeholder="Not read" value={form.mapping[`values.${name}`] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [`values.${name}`]: e.target.value } })} />
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
                </>
              )}
            </>
          ) : (
            area('converter', 'Conversion script (JavaScript)', undefined, 14, <>Saved beside the project as converter.mjs. It receives the records the source sent and returns the entries to sync.</>)
          )}
        </Part>

        <Part title="When a record goes away">
          <Field label="When the source no longer has a record" controlId={`${uid}-removal`}>
            <select id={`${uid}-removal`} className="select" value={form.removal} onChange={(e) => set({ removal: e.target.value as SourceForm['removal'] })}>
              {SOURCE_REMOVALS.map((r) => (
                <option key={r} value={r}>
                  {REMOVAL_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </Part>

        {sample?.result.ok && (
          <section className="sd-part sd-sample" ref={sampleRef} aria-labelledby={`${uid}-sample`} data-testid="source-sample">
            <h3 id={`${uid}-sample`} ref={sampleHead} tabIndex={-1}>
              Sample <span className={`badge ${current ? 'green' : ''}`}>{current ? 'Test passed' : 'Before the latest changes'}</span>
            </h3>
            <p className="sd-sample-summary">
              {sample.result.total} {sample.result.total === 1 ? 'record' : 'records'} read. A sync would add {sample.result.created}, change {sample.result.updated}, leave {sample.result.unchanged} unchanged
              {sample.result.unpublished ? `, make ${sample.result.unpublished} drafts` : ''}
              {sample.result.removed ? `, delete ${sample.result.removed}` : ''}.
            </p>
            {!current && <p className="sd-part-hint">The settings have changed since: test them again before saving.</p>}
            {sample.result.total === 0 && <p className="sd-part-hint">The source has no records, so nothing shows these settings make entries it can hold.</p>}
            {gaps.map((g) => (
              <p className="sd-sample-warn" key={g.name}>
                <span className="badge amber">Empty</span>
                <span>
                  {g.path ? (
                    <>
                      No sampled record had a value for {g.label} at <code>{g.path}</code>.
                    </>
                  ) : g.suggestion ? (
                    <>
                      {g.label} isn’t read from the records, which have <code>{g.suggestion}</code>.{' '}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          set({ mapping: { ...form.mapping, [`values.${g.name}`]: g.suggestion! } });
                          // The warning goes with the change: Test takes focus, to check it.
                          requestAnimationFrame(() => testButton.current?.focus());
                        }}
                      >
                        Read it from {g.suggestion}
                      </button>
                    </>
                  ) : (
                    <>{g.label} isn’t read from the records, so a sync leaves it empty. Say where it is above.</>
                  )}
                </span>
              </p>
            ))}
            {sample.shape === 'mapping' ? (
              sample.result.raw.map((raw, i) => (
                <div className="sd-sample-row" key={i}>
                  <details open={i === 0}>
                    <summary>Record {i + 1} as the source sent it</summary>
                    <pre>{json(raw)}</pre>
                  </details>
                  <details open={i === 0}>
                    <summary aria-label={`Record ${i + 1} as an entry`}>As an entry</summary>
                    <pre>{json(sample.result.ok ? sample.result.records[i] : null)}</pre>
                  </details>
                </div>
              ))
            ) : (
              // A converter may leave records out or reorder them: what it was given and what it gave, each in order.
              <div className="sd-sample-row">
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
          </section>
        )}
      </fieldset>
    </Modal>
  );
}
