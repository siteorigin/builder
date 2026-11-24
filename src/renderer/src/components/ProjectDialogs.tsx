import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, CloudDownload, FileArchive, FolderOpen, LayoutTemplate, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ProgressEvent, WebsiteTools } from '@shared/api';
import { isImeComposing } from '../lib/ime';
import { endEditingHold } from '../lib/leave';
import { api, errorText, toast } from '../store';
import { Field, Modal, Spinner, SwitchRow } from './ui';

/*
 * New project and Trust this project, shown over Welcome or over the open project. Either way the project behind
 * stays open (its page and selection as they were) until the new one has opened: cancelling, or a new project that
 * cannot be made or opened, leaves the author where they were (#80).
 */

export function shortPath(dir: string) {
  return dir.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
}

/** npm's own output is for the log. Lines written for people start with a capital and don't name it. */
const isPlainDetail = (d?: string) => !!d && /^[A-Z]/.test(d) && !/\bnpm\b/i.test(d);

/** A control about to disable itself hands focus to its dialog, so Tab and Escape still belong to the dialog. */
const keepFocusInDialog = (from: Element | null) => from?.closest<HTMLElement>('.modal')?.focus();

/** Ask before running a project's own website tools; Trust and open records the trust, then opens it. */
export function TrustProjectModal({ project, onClose, onOpened }: { project: { dir: string; name: string }; onClose: () => void; onOpened?: () => void }) {
  const [trusting, setTrusting] = useState(false);
  return (
    <Modal
      title="Trust this project?"
      describedBy="trust-body"
      icon={<ShieldAlert style={{ color: 'var(--amber)' }} />}
      onClose={onClose}
      busy={trusting}
      footer={
        <>
          {/* In the footer, so the dialog and its buttons hold still at the moment of commitment. */}
          <span className="foot-note" role="status">
            {trusting ? (
              <>
                <Spinner decorative />
                <span className="ellipsis">Opening {project.name}…</span>
              </>
            ) : null}
          </span>
          <button className="btn" data-autofocus disabled={trusting} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={trusting}
            onClick={async (e) => {
              keepFocusInDialog(e.currentTarget);
              setTrusting(true);
              try {
                const r = await api.projects.trustAndOpen(project.dir);
                if (r.ok) onOpened?.();
                else {
                  // The project behind the dialog, if any, is still open and takes input again.
                  endEditingHold();
                  if (r.message) toast(r.message, 'error');
                }
              } catch (e) {
                endEditingHold();
                toast(`Could not open the project: ${errorText(e)}`, 'error');
              } finally {
                setTrusting(false);
                onClose();
              }
            }}
          >
            Trust and open
          </button>
        </>
      }
    >
      <div id="trust-body" className="trust-body">
        <p>
          <strong>{project.name}</strong> was made on another computer, or its setup files changed since you last opened it.
        </p>
        <p className="trust-path">
          <FolderOpen size={14} aria-hidden="true" />
          {/* The exact path: shortened, folders in two people's home folders would look the same. */}
          <span>{project.dir}</span>
        </p>
        <div className="scope-note trust-risk">
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>Trust and open lets this project run code on your computer</strong> to show its preview. Continue only if you trust the project’s source and any changes to its setup. If you’re unsure, choose Cancel.
          </span>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A project ZIP file being unpacked into a new folder (#263), over Welcome or the open project, from the moment its
 * folder is chosen until the copy is ready (then Trust this project follows) or has gone. Cancel, or Esc, calls it
 * off: nothing it wrote is left, and the ZIP file was only read.
 */
export function UnpackingModal() {
  const [unpacking, setUnpacking] = useState<{ name: string; dir: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  useEffect(
    () =>
      api.on('projects:unpacking', (u) => {
        setUnpacking(u);
        setCancelling(false);
      }),
    []
  );
  if (!unpacking) return null;
  const cancel = () => {
    keepFocusInDialog(document.activeElement);
    setCancelling(true);
    void api.projects.cancelOpen().catch(() => setCancelling(false));
  };
  return (
    <Modal
      title={`Unpacking ${unpacking.name}`}
      describedBy="unpack-body"
      icon={<FileArchive />}
      onClose={cancel}
      busy={cancelling}
      dismissOnBackdrop={false}
      footer={
        <button className="btn busy-cancel" data-autofocus disabled={cancelling} onClick={cancel}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      }
    >
      <div className="trust-body">
        <p id="unpack-body" className="row" role="status" style={{ gap: 8 }}>
          <Spinner decorative />
          <span>{cancelling ? 'Cancelling. Anything unpacked so far is being removed.' : 'Making a working copy from the ZIP file. The ZIP file is not changed.'}</span>
        </p>
        <p className="trust-path" title={unpacking.dir}>
          <FolderOpen size={14} aria-hidden="true" />
          <span>{shortPath(unpacking.dir)}</span>
        </p>
      </div>
    </Modal>
  );
}

const STEPS: Array<{ id: ProgressEvent['step']; label: string }> = [
  { id: 'files', label: 'Preparing files' },
  { id: 'dependencies', label: 'Setting up website tools' },
  { id: 'preview', label: 'Starting preview' }
];

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [starter, setStarter] = useState<'business' | 'blank'>('business');
  const [images, setImages] = useState(true);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether setup will download anything, known before Create is pressed (null while it is being checked).
  const [tools, setTools] = useState<WebsiteTools | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Progress belongs to this dialog's own attempt, named in its create call: another attempt still running (from a
  // window closed meanwhile, or one that replaced the open project and is starting its preview) reports nothing
  // here. Once this dialog has gone, its attempt's answer is only told as a notice.
  const attempt = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void api.dialogs.defaultProjectsFolder().then(setParent, () => undefined);
    void api.projects.websiteTools().then(
      (t) => live.current && setTools(t),
      () => live.current && setTools('unknown')
    );
    const off = api.on('create:progress', (p) => {
      if (!attempt.current || p.attempt !== attempt.current) return;
      // The last line written for people stays up while the install runs.
      setProgress((prev) => ({ ...p, detail: isPlainDetail(p.detail) ? p.detail : prev?.step === p.step ? prev.detail : undefined }));
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);
  const running = !!progress && progress.step !== 'error' && progress.step !== 'done';
  const inProgress = !!progress && progress.step !== 'error';
  const lastStep = progress?.step === 'preview' || progress?.step === 'done';
  // The form's controls went with it: focus moves to Cancel, then to the dialog once nothing is left to cancel.
  useEffect(() => {
    if (inProgress) cancelRef.current?.focus();
  }, [inProgress]);
  useEffect(() => {
    if (lastStep) keepFocusInDialog(cancelRef.current);
  }, [lastStep]);
  // Back on the form with an error: the fields it talks about are in view, and focus is on the first of them.
  useEffect(() => {
    if (!error) return;
    nameRef.current?.closest('.modal-body')?.scrollTo({ top: 0 });
    nameRef.current?.focus();
  }, [error]);
  // The author learns whether anything is downloaded before committing to it, by the button or by Enter.
  const canCreate = !!name.trim() && !!parent && tools !== null;
  const slug = name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website';

  const separator = parent.includes('\\') ? '\\' : '/';
  const target = parent && name.trim() ? `${parent}${separator}${slug}` : parent;
  const idx = progress ? STEPS.findIndex((s) => s.id === progress.step) : -1;
  // One line per step for a screen reader, in a region that is already there when the form gives way to progress.
  const announce = !progress || !inProgress ? '' : cancelling && !lastStep ? 'Stopping setup…' : idx < 0 ? progress.message : `Step ${idx + 1} of ${STEPS.length}. ${STEPS[idx].label}.${progress.detail ? ` ${progress.detail}` : ''}`;
  const status = (
    <div className="sr-only" role="status">
      {announce}
    </div>
  );

  const create = async () => {
    if (attempt.current || !canCreate) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    attempt.current = id;
    setError(null);
    setCancelling(false);
    setProgress({ step: 'files', message: 'Preparing project files…' });
    let r: { ok: boolean; message?: string };
    try {
      r = await api.projects.create({ name: name.trim(), parentDir: parent, starter, sampleImages: images, attempt: id });
    } catch (e) {
      r = { ok: false, message: `The project could not be created: ${errorText(e)}` };
    } finally {
      attempt.current = null;
    }
    // The dialog went with the project it was over (the switch happened), so a failure after that is told here.
    if (!live.current) {
      if (!r.ok && r.message) toast(r.message, 'error');
      return;
    }
    // Shown: the dialog has done its job (over the editor it would otherwise stay over the new project).
    if (r.ok) return onClose();
    // The project behind the dialog, if any, is still open and takes input again.
    endEditingHold();
    // The author chose to keep editing it: the dialog makes way.
    if (!r.message) return onClose();
    // Anything else is explained here, with the form as it was, to fix and try again.
    setError(r.message);
    setProgress(null);
  };

  if (progress && progress.step !== 'error') {
    return (
      <Modal
        title={`Creating ${name.trim()}`}
        icon={<LayoutTemplate />}
        onClose={() => undefined}
        busy
        footer={
          <>
            {(lastStep || cancelling) && <span className="foot-note">{lastStep ? 'Opening your project now' : 'Stopping setup…'}</span>}
            {/* Once the new project is starting its preview it has replaced the open one: nothing is left to cancel. */}
            <button
              ref={cancelRef}
              className="btn busy-cancel"
              onClick={(e) => {
                keepFocusInDialog(e.currentTarget);
                setCancelling(true);
                void api.projects.cancelCreate().catch(() => setCancelling(false));
              }}
              disabled={!running || lastStep || cancelling}
            >
              {cancelling && !lastStep ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        }
      >
        {status}
        <ol className="progress-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={`progress-step${i < idx || progress.step === 'done' ? ' done' : i === idx ? ' active' : ''}`} aria-current={i === idx ? 'step' : undefined}>
              <span className="dot">{i < idx || progress.step === 'done' ? <Check aria-hidden="true" /> : i === idx ? <Spinner decorative /> : null}</span>
              <span>
                {i < idx || progress.step === 'done' ? <span className="sr-only">Done: </span> : null}
                {s.label}
              </span>
              {i === idx && progress.detail && <span className="progress-detail">{progress.detail}</span>}
            </li>
          ))}
        </ol>
      </Modal>
    );
  }

  return (
    <Modal
      title="New project"
      icon={<LayoutTemplate />}
      onClose={onClose}
      footer={
        <>
          {/* Read out as it settles, and describes Create, so nobody creates a project without hearing it. */}
          <span id="new-project-tools" className="foot-note tools-note" data-tools={tools ?? 'checking'} role="status">
            {tools === null ? (
              <>
                <Spinner decorative /> Checking website tools…
              </>
            ) : tools === 'local' ? (
              <>
                <Check aria-hidden="true" /> Website tools are on this computer
                <span className="sr-only">If a saved copy can’t be used, setup downloads it again.</span>
              </>
            ) : (
              <>
                <CloudDownload aria-hidden="true" /> {tools === 'download' ? 'Setup needs a download' : 'Setup may need a download'}
              </>
            )}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canCreate} aria-describedby="new-project-tools new-project-tools-note" onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      {status}
      <div className="new-project-form">
        <Field label="Project name" controlId="new-project-name">
          <input
            ref={nameRef}
            id="new-project-name"
            className="input"
            autoFocus
            placeholder="For example, Harbour Lane Studio"
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'new-project-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void create()}
          />
        </Field>
        <Field label="Location">
          <div className="row">
            <div id="new-project-path" className="path-field grow" title={target || undefined}>
              <FolderOpen size={14} aria-hidden="true" />
              <span>{target ? shortPath(target) : 'Choose a folder'}</span>
            </div>
            <button
              className="btn"
              aria-describedby={error ? 'new-project-path new-project-error' : 'new-project-path'}
              onClick={async () => {
                const d = await api.dialogs.chooseFolder('Choose where to create the project', parent);
                if (d) {
                  setParent(d);
                  setError(null);
                }
              }}
            >
              Choose…
            </button>
          </div>
        </Field>
        {error && (
          <div id="new-project-error" className="scope-note danger" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <div className="field">
          <div className="field-label" id="new-project-starter-label">
            Start from
          </div>
          <div
            className="starter-grid"
            role="radiogroup"
            aria-labelledby="new-project-starter-label"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const group = e.currentTarget;
              setStarter(starter === 'business' ? 'blank' : 'business');
              requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
            }}
          >
            <button className="starter-card" role="radio" aria-checked={starter === 'business'} tabIndex={starter === 'business' ? 0 : -1} onClick={() => setStarter('business')}>
              <div className="art">
                <i style={{ height: 6, width: '100%', opacity: 0.6 }} />
                <div className="row" style={{ gap: 5, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
                  <div className="col" style={{ gap: 4, flex: 1, justifyContent: 'center' }}>
                    <i className="hi" style={{ height: 9, width: '80%' }} />
                    <i style={{ height: 5, width: '90%' }} />
                    <i style={{ height: 5, width: '70%' }} />
                  </div>
                  <i style={{ width: 48 }} />
                </div>
                <div className="row" style={{ gap: 5 }}>
                  <i style={{ height: 12, flex: 1 }} />
                  <i style={{ height: 12, flex: 1 }} />
                  <i style={{ height: 12, flex: 1 }} />
                </div>
              </div>
              <div className="copy">
                {starter === 'business' && (
                  <span className="picked" aria-hidden="true">
                    <Check />
                  </span>
                )}
                <strong>Business</strong>
                <p>Home, About and Contact pages, ready to make your own.</p>
              </div>
            </button>
            <button className="starter-card" role="radio" aria-checked={starter === 'blank'} tabIndex={starter === 'blank' ? 0 : -1} onClick={() => setStarter('blank')}>
              <div className="art">
                <i style={{ height: 8, width: '100%', opacity: 0.6 }} />
                <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
                  <i style={{ height: 8, width: '50%' }} />
                </div>
                <i style={{ height: 10, width: '100%', opacity: 0.6 }} />
              </div>
              <div className="copy">
                {starter === 'blank' && (
                  <span className="picked" aria-hidden="true">
                    <Check />
                  </span>
                )}
                <strong>Blank site</strong>
                <p>One page with a header and footer.</p>
              </div>
            </button>
          </div>
        </div>
        {starter === 'business' && (
          <SwitchRow checked={images} onChange={setImages} label="Include sample images" hint="Placeholder photos you can replace any time." />
        )}
        {(tools === 'download' || tools === 'unknown') && (
          <div id="new-project-tools-note" className="scope-note info">
            <span>If the download can’t connect, your project still opens for editing. Choose Try again in its preview once you’re back online.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
