import { useEffect, useRef, useState } from 'react';
import { Code, Lock } from 'lucide-react';
import { applyOps, api, setState, toast, useStore, confirmDialog } from '../store';
import { Field, Modal, Tabs } from '../components/ui';
import { insert } from '../lib/actions';
import { prepareCodeForSave } from '../lib/code';
import { CodeEditor } from '../components/CodeEditor';
import { PropSchemaEditor, propertiesFromRows, rowsFromProperties, schemaProblems, type SchemaRow } from './PropSchemaEditor';

/** False once the modal has closed; closing also cancels an automatic code fix still running. */
function useAlive(): () => boolean {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      void api.ai.cancelFix();
    };
  }, []);
  return () => open.current;
}

export function SourceModal({ definitionId }: { definitionId: string }) {
  const def = useStore((s) => s.snapshot?.state.components[definitionId]);
  const [src, setSrc] = useState<{ source: string; hash: string; path: string; editable: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  // Closing the editor cancels an automatic fix that is still running, and a save in progress.
  const alive = useAlive();
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(def?.properties ?? {}));
  const [savedProps, setSavedProps] = useState(() => JSON.stringify(def?.properties ?? {}));
  const loaded = useRef<string | null>(null);
  // Re-read when the stored source changes; a draft with unsaved edits is kept.
  useEffect(() => {
    void api.project.readSource(definitionId).then((r) => {
      setSrc(r);
      setDraft((d) => (loaded.current === null || d === loaded.current ? r.source : d));
      loaded.current = r.source;
    });
  }, [definitionId, def?.source]);
  // A saved (or undone) manifest replaces the rows, unless there are unsaved edits to them.
  const propsKey = JSON.stringify(def?.properties ?? {});
  const propsDirty = JSON.stringify(propertiesFromRows(rows)) !== savedProps;
  useEffect(() => {
    if (propsKey === savedProps) return;
    if (!propsDirty) setRows(rowsFromProperties(def?.properties ?? {}));
    setSavedProps(propsKey);
  }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!def) return null;
  const dirty = !!src && (draft !== src.source || propsDirty);
  // Unsaved code is never lost to Escape, the backdrop or ×: ask first.
  const close = () =>
    dirty && src?.editable
      ? void confirmDialog({ title: 'Discard your code changes?', body: 'Your edits to this component have not been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true }).then((ok) => ok === true && setState({ modal: null }))
      : setState({ modal: null });
  const save = async () => {
    setErrors([]);
    const problems = propsDirty ? schemaProblems(rows) : [];
    if (problems.length) return (setErrors(problems), setTab('manifest'));
    const r = await prepareCodeForSave(draft, setStatus, alive);
    if (!r.ok) return setErrors(r.problems);
    if (!alive()) return;
    if (r.source !== draft) setDraft(r.source);
    const properties = propsDirty ? propertiesFromRows(rows) : undefined;
    // A renamed property is a new property: placements lose what they set for the old name.
    const renamed = properties ? rows.filter((row) => row.orig && row.orig !== row.name && !rows.some((x) => x.name === row.orig)) : [];
    if (
      renamed.length &&
      (await confirmDialog({
        title: 'Rename properties?',
        body: `Placements lose the content they set for ${renamed.map((x) => `"${x.orig}"`).join(', ')}, and the source must use the new name${renamed.length === 1 ? '' : 's'}.`,
        confirmLabel: 'Rename',
        cancelLabel: 'Keep editing'
      })) !== true
    )
      return;
    if (!(await applyOps([{ type: 'component.updateSource', definitionId, source: r.source, expectedHash: src!.hash, ...(properties ? { properties } : {}) }], `Edit ${def.name} source`))) return;
    if (properties) {
      // Show the schema as the engine stored it (filled defaults, trimmed labels), even when nothing changed.
      const stored = (await api.project.snapshot())?.state.components[definitionId]?.properties ?? {};
      setRows(rowsFromProperties(stored));
      setSavedProps(JSON.stringify(stored));
    }
    toast(r.fixed ? `Fixed and saved: ${r.fixed}` : r.warnings?.length ? `Saved with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}. ${r.warnings[0]}` : 'Saved. Every page using this component is updated.');
  };
  return (
    <Modal
      wide
      title={`${def.name} source`}
      icon={<Code />}
      onClose={close}
      footer={
        src?.editable ? (
          <>
            <span className="faint grow" style={{ fontSize: 12 }}>{status ?? `Saved code is checked first, and fixed automatically when needed. ${src.path}`}</span>
            <button
              className="btn"
              disabled={!dirty || !!status}
              onClick={() => {
                setDraft(src.source);
                setRows(rowsFromProperties(def.properties));
              }}
            >
              Revert
            </button>
            <button className="btn btn-primary" disabled={!dirty || !!status} onClick={() => void save()}>
              {status ? 'Checking…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            <span className="faint grow row" style={{ fontSize: 12 }}>
              <Lock size={13} /> Generated from the managed definition. Use Convert to code to edit an independent copy.
            </span>
            <button className="btn" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <Tabs
          value={tab}
          onChange={setTab}
          label="Source views"
          idBase="source"
          options={[
            {
              value: 'source',
              label: 'Svelte source',
              panel: () => (src?.editable ? <CodeEditor value={draft} onChange={setDraft} /> : src ? <CodeEditor value={src.source} readOnly /> : <pre className="code-view">Loading…</pre>)
            },
            {
              value: 'manifest',
              label: 'Properties',
              panel: () =>
                src?.editable ? (
                  <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
                    <PropSchemaEditor rows={rows} onChange={setRows} readOnly={!!status} />
                  </div>
                ) : (
                  <pre className="code-view" tabIndex={0}>{JSON.stringify({ properties: def.properties, parts: def.parts, variants: Object.fromEntries(Object.entries(def.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)])) }, null, 2)}</pre>
                )
            }
          ]}
        />
        {errors.map((e, i) => (
          <div key={i} className="scope-note danger mono">
            {e}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function PageSourceModal({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.snapshot?.state.pages[pageId]);
  const [src, setSrc] = useState('');
  useEffect(() => void api.project.generatedSource('page', pageId).then(setSrc), [pageId, page]);
  return (
    <Modal
      wide
      title={`${page?.title ?? 'Page'} — generated source`}
      icon={<Lock />}
      onClose={() => setState({ modal: null })}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12 }}>
            Generated from the page; change it in the editor.
          </span>
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      }
    >
      <CodeEditor value={src} readOnly />
    </Modal>
  );
}

const STARTER = `<script>
	let { heading = 'Hello', text = 'A custom component.' } = $props();
	let count = $state(0);
</script>

<section class="custom">
	<h2>{heading}</h2>
	<p>{text}</p>
	<button type="button" onclick={() => count++}>Clicked {count} times</button>
</section>

<style>
	.custom {
		padding: var(--so-space-section) var(--so-container-gutter);
		max-width: var(--so-container-content);
		margin-inline: auto;
	}
	h2 {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
	}
	button {
		margin-top: var(--so-space-md);
	}
</style>
`;

/** The properties the starter source reads; the person edits them in the Properties tab before creating. */
const STARTER_PROPERTIES = {
  heading: { type: 'string', label: 'Heading', default: 'Hello' },
  text: { type: 'string', label: 'Text', default: 'A custom component.', multiline: true }
} as const;

export function NewCodeComponentModal() {
  const [name, setName] = useState('');
  const [source, setSource] = useState(STARTER);
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(structuredClone(STARTER_PROPERTIES) as never));
  const [initialProps] = useState(() => JSON.stringify(STARTER_PROPERTIES));
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const alive = useAlive();
  // Every way out (×, Escape, backdrop, Cancel) goes through here, so unsaved code is never dropped silently.
  const close = () =>
    source !== STARTER || name.trim() || JSON.stringify(propertiesFromRows(rows)) !== initialProps
      ? void confirmDialog({ title: 'Discard this new component?', body: 'Your code has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }).then((ok) => ok === true && setState({ modal: null }))
      : setState({ modal: null });
  const create = async () => {
    setErrors([]);
    const problems = schemaProblems(rows);
    if (problems.length) return (setErrors(problems), setTab('manifest'));
    const checked = await prepareCodeForSave(source, setStatus, alive);
    if (!checked.ok) return setErrors(checked.problems);
    if (!alive()) return;
    if (checked.fixed) toast(`Fixed before saving: ${checked.fixed}`);
    const r = await applyOps(
      [{ type: 'component.createCode', name: name.trim(), source: checked.source, properties: propertiesFromRows(rows) }],
      `Create ${name.trim()}`
    );
    const id = r?.[0]?.definitionId as string | undefined;
    if (id) {
      setState({ modal: null });
      await insert({ definitionId: id }, name.trim());
    }
  };
  return (
    <Modal
      wide
      title="New code component"
      icon={<Code />}
      onClose={close}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12 }}>{status ?? 'Code is checked before it is saved, and fixed automatically when needed.'}</span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !!status} onClick={() => void create()}>
            {status ? 'Checking…' : 'Create and insert'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Booking widget" />
        </Field>
        <Tabs
          value={tab}
          onChange={setTab}
          label="New component views"
          idBase="new-code"
          options={[
            { value: 'source', label: 'Svelte source', panel: () => <CodeEditor value={source} onChange={setSource} height="46vh" /> },
            {
              value: 'manifest',
              label: `Properties (${rows.length})`,
              panel: () => (
                <div style={{ height: '46vh', overflow: 'auto' }}>
                  <PropSchemaEditor rows={rows} onChange={setRows} readOnly={!!status} />
                </div>
              )
            }
          ]}
        />
        {errors.map((e, i) => (
          <div key={i} className="scope-note danger mono">
            {e}
          </div>
        ))}
      </div>
    </Modal>
  );
}
