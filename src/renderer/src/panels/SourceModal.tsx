import { useEffect, useState } from 'react';
import { Code, Lock } from 'lucide-react';
import { applyOps, api, setState, toast, useStore, confirmDialog } from '../store';
import { Field, Modal, TabPanel, Tabs } from '../components/ui';
import { insert } from '../lib/actions';
import { prepareCodeForSave } from '../lib/code';
import { CodeEditor } from '../components/CodeEditor';

export function SourceModal({ definitionId }: { definitionId: string }) {
  const def = useStore((s) => s.snapshot?.state.components[definitionId]);
  const [src, setSrc] = useState<{ source: string; hash: string; path: string; editable: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    void api.project.readSource(definitionId).then((r) => {
      setSrc(r);
      setDraft(r.source);
    });
  }, [definitionId, def]);
  if (!def) return null;
  const dirty = !!src && draft !== src.source;
  // Unsaved code is never lost to Escape, the backdrop or ×: ask first.
  const close = () =>
    dirty && src?.editable
      ? void confirmDialog({ title: 'Discard your code changes?', body: 'Your edits to this component have not been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true }).then((ok) => ok === true && setState({ modal: null }))
      : setState({ modal: null });
  const save = async () => {
    setErrors([]);
    const r = await prepareCodeForSave(draft, setStatus);
    if (!r.ok) return setErrors(r.problems);
    if (r.source !== draft) setDraft(r.source);
    if (await applyOps([{ type: 'component.updateSource', definitionId, source: r.source, expectedHash: src!.hash }], `Edit ${def.name} source`))
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
            <button className="btn" disabled={!dirty || !!status} onClick={() => setDraft(src.source)}>
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
        <Tabs value={tab} onChange={setTab} label="Source views" idBase="source" options={[{ value: 'source', label: 'Svelte source' }, { value: 'manifest', label: 'Properties' }]} />
        <TabPanel idBase="source" value={tab}>
          {tab === 'manifest' ? (
            <pre className="code-view" tabIndex={0}>{JSON.stringify({ properties: def.properties, parts: def.parts, variants: Object.keys(def.variants ?? {}) }, null, 2)}</pre>
          ) : src?.editable ? (
            <CodeEditor value={draft} onChange={setDraft} />
          ) : src ? (
            <CodeEditor value={src.source} readOnly />
          ) : (
            <pre className="code-view">Loading…</pre>
          )}
        </TabPanel>
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

export function NewCodeComponentModal() {
  const [name, setName] = useState('');
  const [source, setSource] = useState(STARTER);
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  // Every way out (×, Escape, backdrop, Cancel) goes through here, so unsaved code is never dropped silently.
  const close = () =>
    source !== STARTER || name.trim()
      ? void confirmDialog({ title: 'Discard this new component?', body: 'Your code has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }).then((ok) => ok === true && setState({ modal: null }))
      : setState({ modal: null });
  const create = async () => {
    setErrors([]);
    const checked = await prepareCodeForSave(source, setStatus);
    if (!checked.ok) return setErrors(checked.problems);
    if (checked.fixed) toast(`Fixed before saving: ${checked.fixed}`);
    const r = await applyOps(
      [{ type: 'component.createCode', name: name.trim(), source: checked.source, properties: { heading: { type: 'string', label: 'Heading', default: 'Hello' }, text: { type: 'string', label: 'Text', default: 'A custom component.' } } }],
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
        <CodeEditor value={source} onChange={setSource} height="46vh" />
        {errors.map((e, i) => (
          <div key={i} className="scope-note danger mono">
            {e}
          </div>
        ))}
      </div>
    </Modal>
  );
}
