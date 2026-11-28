/**
 * The code workspace (#1483), in Developer mode: the project's code components and its own code files (helpers under
 * src/lib/, endpoints, loaders, hooks and pages of its own under src/routes/) in one dialog, each edited in place,
 * beside a preview of what was last saved, with the project's checks and tests below and a way to the developer's own
 * code editor.
 *
 * One file is open at a time. A code component opens in its own editor (ComponentSourceEditor: its source and its
 * properties, saved through the project as ever); a project file in a plain one, saved straight to its file as an
 * outside editor would (see @shared/code-workspace). Opening another file, or closing, asks about unsaved work first.
 */
import './CodeWorkspace.css';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, Code, ExternalLink, FolderOpen, PanelBottom, PanelLeft, PanelRight, RefreshCw } from 'lucide-react';
import type { CodeFileEntry, CodeFileList, CodeFileRead, EditorOpenResult, EditorTarget } from '@shared/code-workspace';
import { codeLanguage } from '@shared/code-workspace';
import { api, confirmDialog, markDraft, setState, toast, useStore } from '../store';
import { CODE_DRAFT } from '../lib/pending';
import { Modal, Spinner } from '../components/ui';
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor';
import { CodeBadge, CodeTitle, ComponentSourceEditor, SAVE_KEYS, SourceLoading, saveTitle, useFocusKeeper, useSaveKey, type EditorFrame, type LeaveGuard } from './SourceModal';
import { WorkspacePreview, type PreviewIssue } from './WorkspacePreview';
import { WorkspaceChecks } from './WorkspaceChecks';

/** What the workspace has open: a code component, one of the project's own files, or nothing yet. */
export type WorkspaceFile = { kind: 'component'; definitionId: string } | { kind: 'file'; path: string };

const sameFile = (a: WorkspaceFile | null, b: WorkspaceFile | null) => !!a && !!b && (a.kind === 'component' ? b.kind === 'component' && a.definitionId === b.definitionId : b.kind === 'file' && a.path === b.path);

/** Wide enough that the preview fits beside the editor when the workspace opens. */
const roomForPreview = () => typeof window === 'undefined' || window.innerWidth >= 1180;

/** A listing the main process gave, or null for anything else (a bridge with nothing to say). */
const listing = (r: unknown): CodeFileList | null => {
  const l = r as CodeFileList | null;
  return l && l.ok === true && Array.isArray(l.files) ? l : l && l.ok === false && typeof l.message === 'string' ? l : null;
};

export function CodeWorkspace({ start }: { start?: WorkspaceFile }) {
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const components = useStore((s) => s.snapshot?.state.components);
  const projectReadOnly = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  // Without Developer mode (a component's source opened from an error on the canvas), only that component's editor
  // shows: the project's own files, the preview, the checks and the hand-off to an editor are Developer mode's.
  const dev = useStore((s) => !!s.settings?.developerMode);
  const [open, setOpen] = useState<WorkspaceFile | null>(start ?? null);
  const [files, setFiles] = useState<CodeFileList | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [panes, setPanes] = useState(() => ({ files: true, preview: roomForPreview(), checks: false }));
  // Bumped after each save that landed: the preview shows it.
  const [saves, setSaves] = useState(0);
  const [issues, setIssues] = useState<PreviewIssue[]>([]);
  const leave: LeaveGuard = useRef(null);
  const code = useMemo(
    () =>
      Object.values(components ?? {})
        .filter((d) => d.kind === 'code' && d.owner === 'project')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [components]
  );

  const own = useMemo(() => new Set(files?.ok ? files.files.map((f) => f.path) : []), [files]);
  const refresh = useCallback(async () => {
    if (!opening) return;
    setLoadingFiles(true);
    try {
      setFiles(listing(await api.project.codeFiles(opening)));
    } catch {
      setFiles({ ok: false, message: 'The project’s files could not be listed.' });
    } finally {
      setLoadingFiles(false);
    }
  }, [opening]);
  useEffect(() => {
    if (!dev) return;
    void refresh();
    // Back from another app (the developer's own editor, a terminal): files may have come and gone.
    const again = () => void refresh();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [refresh, dev]);

  /** Open `next`, once the open editor has let go of its file (asking about unsaved work first). */
  const choose = (next: WorkspaceFile) => {
    if (sameFile(open, next)) return;
    const go = () => {
      setOpen(next);
      setIssues([]);
    };
    if (leave.current) leave.current(go);
    else go();
  };

  const hand = async (target: EditorTarget) => {
    if (!opening) return;
    let r: EditorOpenResult;
    try {
      r = await api.project.openInEditor(opening, target);
    } catch {
      r = { ok: false, message: 'The file could not be handed to your code editor.' };
    }
    if (r && r.ok === false) toast(r.message, 'error', r.chooseAgain ? { label: 'Settings', run: () => setState({ modal: { kind: 'settings' } }) } : undefined);
  };
  const editorName = useStore((s) => (s.settings?.externalEditor?.kind === 'app' ? s.settings.externalEditor.name : null));
  const openTarget: EditorTarget | null = !open ? null : open.kind === 'file' ? { kind: 'file', path: open.path } : components?.[open.definitionId]?.kind === 'code' && components[open.definitionId].owner === 'project' ? { kind: 'component', definitionId: open.definitionId } : null;

  const toggle = (pane: keyof typeof panes) => setPanes((p) => ({ ...p, [pane]: !p[pane] }));
  const actions = (
    <div className="cw-actions" role="toolbar" aria-label="Code workspace">
      <PaneToggle on={panes.files} onClick={() => toggle('files')} label="Files" icon={<PanelLeft />} />
      <PaneToggle on={panes.preview} onClick={() => toggle('preview')} label="Preview" icon={<PanelRight />} />
      <PaneToggle on={panes.checks} onClick={() => toggle('checks')} label="Checks" icon={<PanelBottom />} />
      <span className="cw-actions-sep" aria-hidden="true" />
      <button type="button" className="btn btn-sm btn-ghost" disabled={!openTarget || !!projectReadOnly} onClick={() => openTarget && void hand(openTarget)} title={editorName ? `Open this file in ${editorName}` : 'Open this file in your code editor'}>
        <ExternalLink aria-hidden="true" /> Open in editor
      </button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={!!projectReadOnly} onClick={() => void hand({ kind: 'project' })} title={editorName ? `Open the project’s folder in ${editorName}` : 'Open the project’s folder'}>
        <FolderOpen aria-hidden="true" /> {editorName ? 'Open project' : 'Open project folder'}
      </button>
    </div>
  );

  // The dialog stays put while files are opened in it: each editor puts its heading, badge and footer into these.
  const [slots, setSlots] = useState<Slots>({ title: null, icon: null, footer: null });
  const slot = (key: keyof Slots) => (el: HTMLElement | null) => setSlots((was) => (was[key] === el ? was : { ...was, [key]: el }));
  const titleRef = useMemo(() => slot('title'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const iconRef = useMemo(() => slot('icon'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const footerRef = useMemo(() => slot('footer'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  // How the open editor closes the dialog (asking about unsaved work first).
  const closing = useRef<() => void>(() => setState({ modal: null }));
  const frame = (f: EditorFrame): ReactElement => <EditorChrome f={f} slots={slots} onBusy={setBusy} closing={closing} />;

  const saved = () => {
    setSaves((n) => n + 1);
    // A save may make or end a file the app writes (a page's route): the list is read again.
    if (dev) void refresh();
  };
  let editor: ReactElement;
  if (open?.kind === 'component') editor = <ComponentSourceEditor key={open.definitionId} definitionId={open.definitionId} frame={frame} leave={leave} onSaved={saved} />;
  else if (open?.kind === 'file' && opening && dev) editor = <ProjectFileEditor key={open.path} opening={opening} path={open.path} frame={frame} leave={leave} onSaved={saved} />;
  else {
    leave.current = null;
    editor = frame({
      title: <CodeTitle name="Code workspace" />,
      icon: <CodeBadge kind="file" />,
      busy: false,
      onClose: () => setState({ modal: null }),
      footer: (
        <>
          <span className="code-foot-note grow">
            <span>{dev ? 'Choose a code component or one of your project’s files to edit it.' : 'The code workspace needs Developer mode. Turn it on in Settings.'}</span>
          </span>
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      ),
      body: (
        <div className="code-dialog">
          <div className="code-loading cw-empty">Nothing is open yet.</div>
        </div>
      )
    });
  }
  return (
    <Modal wide busy={busy} title={<span className="cw-slot" ref={titleRef} />} icon={<span className="cw-slot" ref={iconRef} />} onClose={() => closing.current()} footer={<div className="cw-slot" ref={footerRef} />} actions={dev ? actions : undefined}>
      <div className={`code-workspace${dev && panes.files ? ' with-files' : ''}${dev && panes.preview ? ' with-preview' : ''}`}>
        <div className="cw-main">
          {dev && panes.files && (
            <FileList code={code} files={files} loading={loadingFiles} open={open} onOpen={choose} onRefresh={() => void refresh()} onOpenProject={projectReadOnly ? null : () => void hand({ kind: 'project' })} />
          )}
          <div className="cw-editor">{editor}</div>
          {dev && panes.preview && <WorkspacePreview file={open} saves={saves} onIssues={setIssues} />}
        </div>
        {dev && panes.checks && <WorkspaceChecks opening={opening ?? null} issues={issues} onOpen={choose} own={own} />}
      </div>
    </Modal>
  );
}

/** Where an editor's heading, badge and footer go in the workspace's dialog. */
interface Slots {
  title: HTMLElement | null;
  icon: HTMLElement | null;
  footer: HTMLElement | null;
}

/**
 * An editor's part of the dialog: its body in place, its heading, badge and footer in the dialog's own places, and its
 * way of closing the dialog and whether it is writing told to the dialog. The dialog itself stays as editors come and go.
 */
function EditorChrome({ f, slots, onBusy, closing }: { f: EditorFrame; slots: Slots; onBusy: (busy: boolean) => void; closing: MutableRefObject<() => void> }) {
  closing.current = f.onClose;
  useEffect(() => onBusy(f.busy), [f.busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  return (
    <>
      {slots.title && createPortal(f.title, slots.title)}
      {slots.icon && createPortal(f.icon, slots.icon)}
      {slots.footer && createPortal(f.footer, slots.footer)}
      {f.body}
    </>
  );
}

function PaneToggle({ on, onClick, label, icon }: { on: boolean; onClick: () => void; label: string; icon: ReactElement }) {
  return (
    <button type="button" className="icon-btn cw-pane-toggle" aria-pressed={on} onClick={onClick} title={on ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-label={label}>
      {icon}
    </button>
  );
}

/** A file's folder as the list groups it: below src/, with a slash, or the top of src/ itself. */
const folderOf = (path: string) => {
  const rel = path.slice('src/'.length);
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : `${rel.slice(0, at)}/`;
};
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The files the workspace can open: the project's code components, then its own code files grouped by folder. Up and
 * Down move between them, Home and End go to the ends; each opens with Enter or a click.
 */
function FileList({ code, files, loading, open, onOpen, onRefresh, onOpenProject }: {
  code: Array<{ id: string; name: string }>;
  files: CodeFileList | null;
  loading: boolean;
  open: WorkspaceFile | null;
  onOpen: (f: WorkspaceFile) => void;
  onRefresh: () => void;
  onOpenProject: (() => void) | null;
}) {
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const by = new Map<string, CodeFileEntry[]>();
    if (files?.ok) for (const f of files.files) by.set(folderOf(f.path), [...(by.get(folderOf(f.path)) ?? []), f]);
    return [...by].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('.cw-file') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (next === null || !items.length) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, next))].focus();
  };
  const isOpen = (f: WorkspaceFile) => sameFile(open, f);
  return (
    <nav className="cw-files" aria-label="Project code">
      <div className="cw-files-head">
        <span className="grow">Files</span>
        <button type="button" className="icon-btn" onClick={onRefresh} disabled={loading} aria-label="Refresh the file list" title="Refresh the file list">
          {loading ? <Spinner decorative /> : <RefreshCw aria-hidden="true" />}
        </button>
      </div>
      <div className="cw-files-list" ref={list} onKeyDown={move}>
        <div className="cw-group" role="group" aria-label="Code components">
          <div className="cw-group-head">Code components</div>
          {code.length ? (
            code.map((d) => (
              <button key={d.id} type="button" className="cw-file component" aria-current={isOpen({ kind: 'component', definitionId: d.id }) ? 'true' : undefined} onClick={() => onOpen({ kind: 'component', definitionId: d.id })}>
                <Code aria-hidden="true" />
                <span className="cw-file-name">{d.name}</span>
              </button>
            ))
          ) : (
            <p className="cw-files-note">None yet. Create one from Insert.</p>
          )}
        </div>
        {files && !files.ok ? (
          <p className="cw-files-note" role="alert">
            <CircleAlert aria-hidden="true" /> {files.message}
          </p>
        ) : files?.ok && !files.files.length ? (
          <div className="cw-group">
            <div className="cw-group-head">Project files</div>
            <p className="cw-files-note">
              No code of the project’s own yet. Helpers go in <code>src/lib/</code>, endpoints and pages of your own in <code>src/routes/</code>.
            </p>
            {onOpenProject && (
              <button type="button" className="btn btn-sm" onClick={onOpenProject}>
                <FolderOpen aria-hidden="true" /> Add one in your editor
              </button>
            )}
          </div>
        ) : (
          groups.map(([folder, entries]) => (
            <div key={folder} className="cw-group" role="group" aria-label={`src/${folder}`}>
              <div className="cw-group-head mono">src/{folder}</div>
              {entries.map((f) => (
                <button key={f.path} type="button" className="cw-file" aria-current={isOpen({ kind: 'file', path: f.path }) ? 'true' : undefined} onClick={() => onOpen({ kind: 'file', path: f.path })} title={f.path}>
                  <span className={`cw-file-lang ${codeLanguage(f.path) ?? ''}`} aria-hidden="true" />
                  <span className="cw-file-name">{nameOf(f.path)}</span>
                </button>
              ))}
            </div>
          ))
        )}
        {files?.ok && files.truncated && <p className="cw-files-note">The project has more files than the list shows. Open the rest in your code editor.</p>}
      </div>
    </nav>
  );
}

const CHANGED_ON_DISK = 'This file changed on disk since you started editing it.';

/** A file as read from the project, or why it could not be. */
const readResult = (r: unknown): CodeFileRead => {
  const v = r as CodeFileRead | null;
  return v && (v.ok === true ? typeof v.text === 'string' && typeof v.hash === 'string' : typeof v.message === 'string') ? v : { ok: false, reason: 'refused', message: 'The file could not be read.' };
};

/**
 * One of the project's own code files, edited as an outside editor would edit it: read from its file, saved straight
 * back over it, and only over what was read. A file changed on disk meanwhile is a choice to make (its version, or the
 * edits); one changed while there are no edits is simply shown as it is now.
 */
function ProjectFileEditor({ opening, path, frame, leave, onSaved }: { opening: string; path: string; frame: (f: EditorFrame) => ReactElement; leave: LeaveGuard; onSaved: () => void }) {
  const [file, setFile] = useState<Extract<CodeFileRead, { ok: true }> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // The person's edits, or null while there are none.
  const [edit, setEdit] = useState<string | null>(null);
  // A newer version on disk while there are edits: the person chooses between them.
  const [newer, setNewer] = useState<Extract<CodeFileRead, { ok: true }> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const editor = useRef<CodeEditorHandle | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const none = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const text = edit ?? file?.text ?? '';
  const dirty = !!file && edit !== null && edit !== file.text;
  const readOnly = file?.readOnly ?? null;
  const current = useRef({ dirty, file });
  current.current = { dirty, file };

  /** Read the file again: shown as it is when there are no edits; with edits, a newer version is a choice to make. */
  const read = useCallback(
    async (first: boolean) => {
      let raw: unknown;
      try {
        raw = await api.project.readCodeFile(opening, path);
      } catch {
        if (alive.current && first) setFailed('The file could not be read.');
        return;
      }
      if (!alive.current) return;
      const r = readResult(raw);
      if (!r.ok) {
        // Gone or no longer the project's own: edits stay on screen to copy, and saving says why it can't.
        if (first || !current.current.file) setFailed(r.message);
        else setProblem(r.message);
        return;
      }
      setFailed(null);
      const { dirty: editing, file: shown } = current.current;
      if (!shown || !editing) {
        setFile(r);
        setNewer(null);
        if (!editing) setEdit(null);
        setProblem(null);
      } else if (r.hash !== shown.hash) setNewer(r);
    },
    [opening, path]
  );
  useEffect(() => void read(true), [read, reload]);
  useEffect(() => {
    // Back from the developer's own editor: what it saved is shown, or offered.
    const onFocus = () => void read(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [read]);

  useEffect(() => {
    markDraft(CODE_DRAFT, dirty && !readOnly);
    return () => markDraft(CODE_DRAFT, false);
  }, [dirty, readOnly]);

  const leaveNow = (then: () => void, closing: boolean) => {
    if (saving) return;
    if (!dirty || readOnly) return then();
    void confirmDialog({
      title: 'Discard your changes?',
      body: closing ? 'The editor closes without saving your changes to this file.' : 'Your changes to this file are not saved.',
      subject: path,
      details: [
        { kind: 'keep', text: 'The file keeps its last saved version.' },
        { kind: 'final', text: 'Unsaved changes can’t be brought back.' }
      ],
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      tone: 'caution',
      icon: 'discard'
    }).then((ok) => ok === true && then());
  };
  const close = () => leaveNow(() => setState({ modal: null }), true);
  leave.current = (then) => leaveNow(then, false);

  const save = async () => {
    if (!file || !dirty || saving || readOnly || newer) return;
    setSaving(true);
    setProblem(null);
    const wrote = text;
    try {
      const r = await api.project.saveCodeFile(opening, path, wrote, file.hash);
      if (!alive.current) return;
      if (r?.ok === true) {
        setFile({ ...file, text: wrote, hash: r.hash });
        setEdit((e) => (e === wrote ? null : e));
        setSaved(true);
        onSaved();
        return;
      }
      if (r?.ok === false && r.reason === 'changed') {
        setProblem(null);
        void read(false);
        return;
      }
      setProblem(r?.ok === false && typeof r.message === 'string' ? r.message : 'The save did not finish. Your edits are still here, so you can try again.');
    } catch {
      if (alive.current) setProblem('The save did not finish. Your edits are still here, so you can try again.');
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const latest = useRef(save);
  latest.current = save;
  useSaveKey(body, () => void latest.current());
  useFocusKeeper(body, () => alive.current, none, () => editor.current?.focus());

  const useNewer = () => {
    if (!newer) return;
    setFile(newer);
    setNewer(null);
    setEdit(null);
  };
  // The edits stay, now made over the newer version: Revert goes back to it, and a save replaces it.
  const keepMine = () => {
    if (!newer) return;
    setFile(newer);
    setNewer(null);
  };
  const revert = async () => {
    const ok = await confirmDialog({
      title: 'Revert your changes?',
      body: 'The file goes back to its last saved version. The editor stays open.',
      subject: path,
      details: [{ kind: 'undo', text: 'Undo in the code editor brings your changes back.' }],
      confirmLabel: 'Revert changes',
      cancelLabel: 'Keep editing',
      tone: 'neutral',
      icon: 'revert'
    });
    if (ok === true) setEdit(null);
  };

  const justSaved = saved && !dirty;
  const note = saving ? 'Saving…' : readOnly ? readOnly : newer ? 'Choose which version of the file to keep before saving.' : problem ? problem : justSaved ? 'Saved to the file. The preview shows it.' : dirty ? 'Saves straight to the file, as your own code editor would.' : 'No unsaved changes';
  const language = codeLanguage(path) ?? 'javascript';
  const name = nameOf(path);
  return frame({
    busy: saving,
    title: <CodeTitle name={name} file={path} state={!file ? null : readOnly ? 'readonly' : dirty ? 'unsaved' : null} />,
    icon: <CodeBadge kind="file" />,
    onClose: close,
    footer: (
      <>
        <span className={`code-foot-note grow${justSaved ? ' saved' : ''}`} role="status">
          {saving && <Spinner decorative />}
          <span>{note}</span>
        </span>
        {dirty && !readOnly && (
          <button className="btn" disabled={saving} onClick={() => void revert()}>
            Revert
          </button>
        )}
        <button className="btn" disabled={saving} onClick={close}>
          Close
        </button>
        {!readOnly && (
          <button className="btn btn-primary code-save" disabled={!dirty || !!newer} aria-disabled={saving || undefined} onClick={() => void save()} title={saveTitle('Save')} aria-keyshortcuts={SAVE_KEYS}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </>
    ),
    body: (
      <div className="code-dialog" ref={body}>
        {file ? (
          <CodeEditor
            value={text}
            onChange={(v) => {
              setEdit(v);
              setSaved(false);
              setProblem(null);
            }}
            readOnly={!!readOnly}
            locked={saving}
            label={`${path}${readOnly ? ', read only' : ''}`}
            height="100%"
            onSave={() => void latest.current()}
            saveHint={dirty && !newer ? 'saves' : null}
            language={language}
            checked={false}
            handle={editor}
          />
        ) : (
          <SourceLoading failed={!!failed} what={path} onRetry={() => setReload((n) => n + 1)} />
        )}
        {failed && !file && <p className="cw-read-failed">{failed}</p>}
        {newer && (
          <div className="scope-note danger source-stale" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="grow">
              <strong>{CHANGED_ON_DISK}</strong> Saving your edits would replace the newer version. If you use the newer version, Undo brings your edits back.
            </span>
            <button className="btn btn-sm" disabled={saving} onClick={useNewer}>
              Use the newer version
            </button>
            <button className="btn btn-sm" disabled={saving} onClick={keepMine}>
              Keep my edits
            </button>
          </div>
        )}
      </div>
    )
  });
}
