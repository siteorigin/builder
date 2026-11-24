import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CircleAlert, CircleCheck, Code, Lock } from 'lucide-react';
import { applyOps, api, markDraft, setState, toast, useStore, confirmDialog } from '../store';
import { CODE_DRAFT } from '../lib/pending';
import { Field, Modal, Spinner, Tabs } from '../components/ui';
import { insert } from '../lib/actions';
import { prepareCodeForSave } from '../lib/code';
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor';
import { PropSchemaEditor, hiddenEdits, propertiesFromRows, renamesFromRows, rowsFromProperties, schemaProblems, type SchemaRow } from './PropSchemaEditor';

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

/** Problems that say what to do next rather than what is wrong in the code. */
const isAdvice = (p: string) => /^(Connect an AI provider|The automatic fix did not work|Your code could not be checked|The save did not finish)/.test(p);
const CHECK_FAILED = 'Your code could not be checked, so it was not saved. Try again.';
const WRITE_FAILED = 'The save did not finish. Your edits are still here, so you can try again.';
/** Said when the project changed under unsaved edits to the properties: saving those would undo that change. */
const STALE_PROPERTIES = 'The project changed while you were editing these properties (an undo or the AI). Saving them would undo that: Revert to start again from the saved ones.';

/** Properties fields commit on blur: commit one still being typed in, and return it so it can have focus back. */
const commitField = () => {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !a.closest('.code-props') || !a.matches('input, textarea')) return null;
  a.blur();
  return a;
};
const firstLine = (problems: string[]) => {
  for (const p of problems) {
    const at = /^Line (\d+):/.exec(p);
    if (at) return Number(at[1]);
  }
  return null;
};

/** Runs the real check and shows what it finds. It never writes, whatever the live check last said. */
async function reviewCode(code: string, alive: () => boolean, ui: { setBusy: (b: boolean) => void; setStatus: (s: string | null) => void; setErrors: (p: string[]) => void; clearLive: () => void; goToLine: (line: number) => void; blocked: () => boolean }) {
  ui.setBusy(true);
  try {
    const r = await prepareCodeForSave(code, ui.setStatus, alive);
    if (!alive()) return;
    if (r.ok) return ui.clearLive();
    ui.setErrors(r.problems);
    const line = firstLine(r.problems);
    if (line && !ui.blocked()) ui.goToLine(line);
  } catch {
    ui.setErrors([CHECK_FAILED]);
  } finally {
    ui.setStatus(null);
    ui.setBusy(false);
  }
}

/** Marks a tab with unsaved work. The space is always reserved, so the tabs never shift. */
function TabDot({ on }: { on: boolean }) {
  return on ? <span className="code-dot" role="img" aria-label="unsaved" /> : <span className="code-dot off" aria-hidden="true" />;
}

function SourceLoading({ failed, what, onRetry }: { failed: boolean; what: string; onRetry: () => void }) {
  return failed ? (
    <div className="code-loading" role="alert">
      <span>{what} could not be loaded.</span>
      <button className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  ) : (
    <div className="code-loading" role="status">
      <Spinner decorative /> Loading source…
    </div>
  );
}

/** The dialog's heading: what this is, whether it can be changed, and which file it is. */
function CodeTitle({ name, file, state }: { name: string; file?: string; state?: 'unsaved' | 'readonly' | null }) {
  return (
    <span className="code-title">
      <span className="code-title-row">
        <span className="code-title-name">{name}</span>
        {state === 'unsaved' && (
          <span className="code-chip">
            <span className="code-dot" aria-hidden="true" /> Unsaved changes
          </span>
        )}
        {state === 'readonly' && (
          <span className="code-chip">
            <Lock aria-hidden="true" /> Read only
          </span>
        )}
      </span>
      {file && (
        <span className="code-title-file" title={file}>
          {file}
        </span>
      )}
    </span>
  );
}

/** Why a save did not happen. Each located problem is a button that goes to its line. */
function SaveProblems({ problems, onGoTo }: { problems: string[]; onGoTo: (line: number) => void }) {
  if (!problems.length) return null;
  const faults = problems.filter((p) => !isAdvice(p));
  const advice = problems.filter(isAdvice);
  return (
    <div className="code-problems" role="alert">
      <div className="code-problems-head">
        <CircleAlert aria-hidden="true" /> Not saved{faults.length ? `. ${faults.length} problem${faults.length === 1 ? '' : 's'} to fix.` : '.'}
      </div>
      {faults.length > 0 && (
        <ul className="code-problems-list">
          {faults.map((p, i) => {
            const at = /^Line (\d+): (.*)$/s.exec(p);
            return (
              <li key={i}>
                {at ? (
                  <button type="button" className="code-problem" onClick={() => onGoTo(Number(at[1]))}>
                    <span className="code-problem-line">Line {at[1]}</span>
                    <span>{at[2]}</span>
                  </button>
                ) : (
                  <span className="code-problem">{p}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {advice.map((p, i) => (
        <p key={i} className="code-problems-advice">
          {p}
        </p>
      ))}
    </div>
  );
}

/** Escape in a Properties field cancels that field's text; it never also closes the dialog. */
const keepDialogOnFieldEscape = (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Escape' && (e.target as HTMLElement).matches('input, textarea')) e.stopPropagation();
};
const isSaveKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
const busyLabel = (status: string | null) => (status?.includes('Fixing') ? 'Fixing…' : status ? 'Checking…' : 'Saving…');

export function SourceModal({ definitionId }: { definitionId: string }) {
  const def = useStore((s) => s.snapshot?.state.components[definitionId]);
  const canFix = useStore((s) => !!s.providers.find((p) => p.id === s.settings?.ai.provider)?.configured);
  const [src, setSrc] = useState<{ source: string; hash: string; path: string; editable: boolean } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  // The person's edits, or null while there are none. The code shown is never a blank waiting to be saved.
  const [edit, setEdit] = useState<string | null>(null);
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  // One save at a time: its code and properties are held still from the check through the write.
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [liveErrors, setLiveErrors] = useState(0);
  const editor = useRef<CodeEditorHandle | null>(null);
  // A discard prompt still open: a save waits for its answer before it writes anything.
  const discarding = useRef<Promise<boolean | null> | null>(null);
  const latest = useRef({ close: () => {}, save: () => {} });
  // Closing the editor cancels an automatic fix that is still running, and a save in progress.
  const alive = useAlive();
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(def?.properties ?? {}));
  // The stored properties the rows were made from: what their edits are measured, and saved, against.
  const [savedProps, setSavedProps] = useState(() => JSON.stringify(def?.properties ?? {}));
  // A Properties field being typed in: its text commits when Save is pressed, so Save is ready already.
  const [typing, setTyping] = useState(false);
  // Re-read when the stored source changes; unsaved edits are kept.
  useEffect(() => {
    let current = true;
    setLoadFailed(false);
    api.project.readSource(definitionId).then(
      (r) => {
        if (!current) return;
        setSrc(r);
        setEdit((e) => (e === r.source ? null : e));
      },
      () => current && setLoadFailed(true)
    );
    return () => {
      current = false;
    };
  }, [definitionId, def?.source, reload]);
  // A saved (or undone) manifest replaces the rows, unless there are unsaved edits to them or one is being typed.
  const propsKey = JSON.stringify(def?.properties ?? {});
  // A rename is an edit even when the schemas read the same, and so are two rows with one name.
  const propsDirty = JSON.stringify(propertiesFromRows(rows)) !== savedProps || renamesFromRows(rows).length > 0 || hiddenEdits(rows);
  // The stored properties last taken into account: only a change since then refreshes the rows, so a snapshot that
  // arrives after a save never puts back the properties from before it.
  const seenKey = useRef(propsKey);
  // The project revision while the rows were last clean: a rename moves placement content by name, so it is saved
  // only onto the project its edits were made against.
  const revision = useStore((s) => s.snapshot?.revision);
  const cleanAt = useRef(revision);
  useEffect(() => {
    if (propsDirty || typing) return;
    // Only ever forward: a push the store has yet to receive must not undo what a save already recorded.
    cleanAt.current = Math.max(cleanAt.current ?? 0, revision ?? 0);
    if (propsKey === seenKey.current) return;
    seenKey.current = propsKey;
    if (propsKey === savedProps) return;
    setRows(rowsFromProperties(def?.properties ?? {}));
    setSavedProps(propsKey);
  }, [propsKey, propsDirty, typing, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const code = edit ?? src?.source ?? '';
  const codeDirty = !!src && edit !== null && edit !== src.source;
  const dirty = !!src && (codeDirty || propsDirty || typing);
  // Leaving the project (closing the window, quitting) asks about unsaved code, as closing this editor does.
  const unsavedCode = !!src?.editable && dirty;
  useEffect(() => {
    markDraft(CODE_DRAFT, unsavedCode);
    return () => markDraft(CODE_DRAFT, false);
  }, [unsavedCode]);
  if (!def) return null;
  const changed = codeDirty && propsDirty ? 'code and properties' : codeDirty ? 'code' : 'properties';
  // Unsaved code is never lost to Escape, the backdrop or ×: ask first. Nothing closes during the write itself.
  const close = () => {
    if (writing || discarding.current) return;
    if (!dirty || !src?.editable) return void setState({ modal: null });
    const asked = confirmDialog({ title: 'Discard your changes?', body: `Your changes to the ${changed} have not been saved.`, confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true });
    discarding.current = asked;
    void asked.then((ok) => {
      discarding.current = null;
      if (ok === true) setState({ modal: null });
    });
  };
  const requestClose = () => (commitField() ? void setTimeout(() => latest.current.close()) : close());
  const goToLine = (line: number) => {
    setTab('source');
    setTimeout(() => editor.current?.goTo(line));
  };
  const changeCode = (v: string) => {
    setEdit(v);
    setSaved(false);
    setErrors((e) => (e.length ? [] : e));
  };
  const changeRows = (next: SchemaRow[]) => {
    setRows(next);
    setSaved(false);
    setErrors((e) => (e.length ? [] : e));
  };
  const revert = async () => {
    const ok = await confirmDialog({ title: 'Revert your changes?', body: `This puts the ${changed} back to the last saved version.`, confirmLabel: 'Revert changes', cancelLabel: 'Keep editing', danger: true });
    if (ok !== true) return;
    setEdit(null);
    setRows(rowsFromProperties(def.properties));
    setSavedProps(propsKey);
    seenKey.current = propsKey;
    setErrors([]);
  };
  const save = async () => {
    if (!src?.editable || !dirty || saving) return;
    setErrors([]);
    setSaved(false);
    const problems = propsDirty ? schemaProblems(rows) : [];
    if (problems.length) return (setErrors(problems), setTab('manifest'));
    let wrote = false;
    setSaving(true);
    try {
      const r = await prepareCodeForSave(code, setStatus, alive);
      if (!r.ok) return setErrors(r.problems);
      while (discarding.current) if ((await discarding.current) === true) return;
      if (!alive()) return;
      const properties = propsDirty ? propertiesFromRows(rows) : undefined;
      // A renamed property takes every placement's content with it.
      const renames = properties ? renamesFromRows(rows) : [];
      // Edits to properties that changed since the rows were made would undo that change, whatever it was.
      const snap = useStore.getState().snapshot;
      const storedKey = JSON.stringify(snap?.state.components[definitionId]?.properties ?? {});
      if (properties && (storedKey !== savedProps || (renames.length && snap?.revision !== cleanAt.current))) return (setErrors([STALE_PROPERTIES]), setTab('manifest'));
      wrote = true;
      setWriting(true);
      if (
        !(await applyOps(
          [{ type: 'component.updateSource', definitionId, source: r.source, expectedHash: src.hash, ...(properties ? { properties } : {}), ...(renames.length ? { renames } : {}) }],
          `Edit ${def.name} source`,
          undefined,
          properties ? snap?.revision : undefined
        ))
      )
        return setErrors([WRITE_FAILED]);
      // A repaired save shows the code that was stored; undo in the editor still reaches what was typed.
      if (r.source !== code) setEdit(r.source);
      if (properties) {
        // Show the schema as the engine stored it (filled defaults, trimmed labels), even when nothing changed.
        // The write has landed. If this refresh fails, the next project update brings the stored schema.
        const fresh = await api.project.snapshot().catch(() => null);
        const stored = fresh?.state.components[definitionId]?.properties;
        if (stored) {
          cleanAt.current = Math.max(cleanAt.current ?? 0, fresh.revision);
          // The store still showing the properties from before the save is behind: its next push is this save, not
          // a change to show. Anything else it shows by now is newer, and refreshes the rows.
          const now = JSON.stringify(useStore.getState().snapshot?.state.components[definitionId]?.properties ?? {});
          seenKey.current = now === storedKey ? now : JSON.stringify(stored);
          setRows(rowsFromProperties(stored));
          setSavedProps(JSON.stringify(stored));
        }
      }
      setSaved(true);
      // Save disables itself once nothing is left to save, so keyboard focus goes back to the code.
      setTimeout(() => {
        const a = document.activeElement as HTMLButtonElement | null;
        if (alive() && tab === 'source' && (!a || a === document.body || a.disabled)) editor.current?.focus();
      });
      if (r.fixed) toast(`Fixed and saved: ${r.fixed}`);
      else if (r.warnings?.length) toast(`Saved with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}. ${r.warnings[0]}`);
    } catch {
      setErrors([wrote ? WRITE_FAILED : CHECK_FAILED]);
    } finally {
      setStatus(null);
      setWriting(false);
      setSaving(false);
    }
  };
  const reviewing = dirty && liveErrors > 0 && !canFix;
  const reviewErrors = () => {
    if (saving) return;
    const line = firstLine(errors);
    if (line) return goToLine(line);
    void reviewCode(code, alive, { setBusy: setSaving, setStatus, setErrors, clearLive: () => setLiveErrors(0), goToLine, blocked: () => !!discarding.current });
  };
  // Cmd/Ctrl+S from a Properties field saves what is typed in it.
  const requestSave = () => {
    if (reviewing) return reviewErrors();
    const field = commitField();
    if (!field) return void save();
    setTimeout(() => {
      latest.current.save();
      field.focus();
    });
  };
  latest.current = { close, save: () => void save() };
  const note =
    status ??
    (writing
      ? 'Saving…'
      : saved
        ? 'Saved. Every page using this component is updated.'
        : !dirty
          ? 'No unsaved changes'
          : liveErrors && !canFix
            ? 'Fix the errors to save.'
            : liveErrors
              ? 'Save repairs the errors, then updates every page using this component.'
              : 'Save checks your code, then updates every page using this component.');
  return (
    <Modal
      wide
      busy={writing}
      title={<CodeTitle name={def.name} file={src?.path} state={!src ? null : !src.editable ? 'readonly' : dirty ? 'unsaved' : null} />}
      icon={<Code />}
      onClose={requestClose}
      footer={
        src?.editable ? (
          <>
            <span className={`code-foot-note grow${saved && !status ? ' saved' : ''}`} role="status">
              {saved && !status && <CircleCheck aria-hidden="true" />}
              <span>{note}</span>
            </span>
            {dirty ? (
              <button className="btn" disabled={saving} onClick={() => void revert()}>
                Revert
              </button>
            ) : (
              <button className="btn" disabled={writing} onClick={requestClose}>
                Close
              </button>
            )}
            <button className="btn btn-primary code-save" disabled={!dirty || saving} onClick={requestSave}>
              {saving ? busyLabel(status) : reviewing ? 'Review errors' : dirty && liveErrors ? 'Fix and save' : 'Save'}
            </button>
          </>
        ) : (
          <>
            <span className="code-foot-note grow">
              <span>{src ? 'Generated from this component’s settings. To edit a copy, close this and choose Convert to code in the Inspector.' : ''}</span>
            </span>
            <button className="btn" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      <div
        className="code-dialog"
        onKeyDown={(e) => {
          if (!isSaveKey(e)) return;
          e.preventDefault();
          requestSave();
        }}
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Source views"
          idBase="source"
          keepMounted
          panelClassName="code-panel"
          options={[
            {
              value: 'source',
              label: 'Svelte source',
              extra: src?.editable ? <TabDot on={codeDirty} /> : undefined,
              panel: () =>
                src?.editable ? (
                  <CodeEditor value={code} onChange={changeCode} locked={saving} label={`${def.name} Svelte source`} height="100%" onSave={requestSave} onErrorCount={setLiveErrors} handle={editor} />
                ) : src ? (
                  <CodeEditor value={src.source} readOnly label={`${def.name} Svelte source, read only`} height="100%" />
                ) : (
                  <SourceLoading failed={loadFailed} what="This component’s source" onRetry={() => setReload((n) => n + 1)} />
                )
            },
            {
              value: 'manifest',
              label: `Properties (${src?.editable ? rows.length : Object.keys(def.properties).length})`,
              extra: src?.editable ? <TabDot on={propsDirty} /> : undefined,
              panel: () =>
                src?.editable ? (
                  <div className="code-props" onKeyDown={keepDialogOnFieldEscape}>
                    <PropSchemaEditor rows={rows} onChange={changeRows} readOnly={saving} onTyping={setTyping} />
                  </div>
                ) : (
                  <pre className="code-view" tabIndex={0}>{JSON.stringify({ properties: def.properties, parts: def.parts, variants: Object.fromEntries(Object.entries(def.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)])) }, null, 2)}</pre>
                )
            }
          ]}
        />
        <SaveProblems problems={errors} onGoTo={goToLine} />
      </div>
    </Modal>
  );
}

export function PageSourceModal({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.snapshot?.state.pages[pageId]);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    api.project.generatedSource('page', pageId).then(
      (r) => current && setSrc(r),
      () => current && setFailed(true)
    );
    return () => {
      current = false;
    };
  }, [pageId, page, reload]);
  return (
    <Modal
      wide
      title={<CodeTitle name={page?.title ?? 'Page'} file={page ? `Generated source for the page at ${page.route}` : undefined} state="readonly" />}
      icon={<Code />}
      onClose={() => setState({ modal: null })}
      footer={
        <>
          <span className="code-foot-note grow">
            <span>Generated from the page. Change the page in the editor.</span>
          </span>
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      }
    >
      <div className="code-dialog">
        {src !== null ? <CodeEditor value={src} readOnly label={`${page?.title ?? 'Page'} generated source, read only`} height="100%" /> : <SourceLoading failed={failed} what="This page’s source" onRetry={() => setReload((n) => n + 1)} />}
      </div>
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
  // Never saved, so a changed name is a new name, not a rename.
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(structuredClone(STARTER_PROPERTIES), false));
  const [initialProps] = useState(() => JSON.stringify(STARTER_PROPERTIES));
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const editor = useRef<CodeEditorHandle | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const discarding = useRef<Promise<boolean | null> | null>(null);
  const latest = useRef({ close: () => {}, create: () => {} });
  const canFix = useStore((s) => !!s.providers.find((p) => p.id === s.settings?.ai.provider)?.configured);
  const [liveErrors, setLiveErrors] = useState(0);
  const alive = useAlive();
  const unsaved = source !== STARTER || !!name.trim() || hiddenEdits(rows) || JSON.stringify(propertiesFromRows(rows)) !== initialProps;
  // Leaving the project (closing the window, quitting) asks about it too.
  useEffect(() => {
    markDraft(CODE_DRAFT, unsaved);
    return () => markDraft(CODE_DRAFT, false);
  }, [unsaved]);
  // Every way out (×, Escape, backdrop, Cancel) goes through here, so unsaved code is never dropped silently.
  const close = () => {
    if (writing || discarding.current) return;
    if (!unsaved) return void setState({ modal: null });
    const asked = confirmDialog({ title: 'Discard this new component?', body: 'Your new component has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true });
    discarding.current = asked;
    void asked.then((ok) => {
      discarding.current = null;
      if (ok === true) setState({ modal: null });
    });
  };
  const requestClose = () => (commitField() ? void setTimeout(() => latest.current.close()) : close());
  const goToLine = (line: number) => {
    setTab('source');
    setTimeout(() => editor.current?.goTo(line));
  };
  const create = async () => {
    if (saving) return;
    const title = name.trim();
    if (!title) return nameInput.current?.focus();
    setErrors([]);
    const problems = schemaProblems(rows);
    if (problems.length) return (setErrors(problems), setTab('manifest'));
    let wrote = false;
    setSaving(true);
    try {
      const checked = await prepareCodeForSave(source, setStatus, alive);
      if (!checked.ok) return setErrors(checked.problems);
      while (discarding.current) if ((await discarding.current) === true) return;
      if (!alive()) return;
      if (checked.fixed) toast(`Fixed before saving: ${checked.fixed}`);
      wrote = true;
      setWriting(true);
      const r = await applyOps([{ type: 'component.createCode', name: title, source: checked.source, properties: propertiesFromRows(rows) }], `Create ${title}`);
      const id = r?.[0]?.definitionId as string | undefined;
      if (!id) return setErrors([WRITE_FAILED]);
      setState({ modal: null });
      await insert({ definitionId: id }, title);
    } catch {
      setErrors([wrote ? WRITE_FAILED : CHECK_FAILED]);
    } finally {
      setStatus(null);
      setWriting(false);
      setSaving(false);
    }
  };
  const reviewing = liveErrors > 0 && !canFix;
  const reviewErrors = () => {
    if (saving) return;
    const line = firstLine(errors);
    if (line) return goToLine(line);
    void reviewCode(source, alive, { setBusy: setSaving, setStatus, setErrors, clearLive: () => setLiveErrors(0), goToLine, blocked: () => !!discarding.current });
  };
  const requestCreate = () => {
    if (reviewing && name.trim()) return reviewErrors();
    const field = commitField();
    if (!field) return void create();
    setTimeout(() => {
      latest.current.create();
      field.focus();
    });
  };
  latest.current = { close, create: () => void create() };
  const note = status ?? (writing ? 'Saving…' : !name.trim() ? 'Name this component to create it.' : reviewing ? 'Fix the errors to create it.' : liveErrors ? 'Errors are repaired automatically before this is added to the page.' : 'Your code is checked before it is added to the page.');
  return (
    <Modal
      wide
      busy={writing}
      title={<CodeTitle name="New code component" />}
      icon={<Code />}
      onClose={requestClose}
      footer={
        <>
          <span className="code-foot-note grow" role="status">
            <span>{note}</span>
          </span>
          <button className="btn" disabled={writing} onClick={requestClose}>
            Cancel
          </button>
          <button className="btn btn-primary code-save" disabled={!name.trim() || saving} onClick={requestCreate}>
            {saving ? busyLabel(status) : reviewing ? 'Review errors' : 'Create and insert'}
          </button>
        </>
      }
    >
      <div
        className="code-dialog"
        onKeyDown={(e) => {
          if (!isSaveKey(e)) return;
          e.preventDefault();
          requestCreate();
        }}
      >
        <Field label="Name">
          <input ref={nameInput} className="input" autoFocus value={name} readOnly={saving} onChange={(e) => setName(e.target.value)} placeholder="Booking widget" />
        </Field>
        <Tabs
          value={tab}
          onChange={setTab}
          label="New component views"
          idBase="new-code"
          keepMounted
          panelClassName="code-panel"
          options={[
            {
              value: 'source',
              label: 'Svelte source',
              panel: () => (
                <CodeEditor
                  value={source}
                  onChange={(v) => {
                    setSource(v);
                    setErrors((e) => (e.length ? [] : e));
                  }}
                  locked={saving}
                  label="New component Svelte source"
                  height="100%"
                  onSave={requestCreate}
                  onErrorCount={setLiveErrors}
                  handle={editor}
                />
              )
            },
            {
              value: 'manifest',
              label: `Properties (${rows.length})`,
              panel: () => (
                <div className="code-props" onKeyDown={keepDialogOnFieldEscape}>
                  <PropSchemaEditor
                    rows={rows}
                    onChange={(next) => {
                      setRows(next);
                      setErrors((e) => (e.length ? [] : e));
                    }}
                    readOnly={saving}
                  />
                </div>
              )
            }
          ]}
        />
        <SaveProblems problems={errors} onGoTo={goToLine} />
      </div>
    </Modal>
  );
}
