import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, LayoutTemplate, ShieldAlert } from 'lucide-react';
import type { ProgressEvent } from '@shared/api';
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

/** Ask before running a project's own website tools; Trust and open records the trust, then opens it. */
export function TrustProjectModal({ project, onClose }: { project: { dir: string; name: string }; onClose: () => void }) {
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
          <button className="btn" data-autofocus disabled={trusting} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={trusting}
            onClick={async () => {
              setTrusting(true);
              try {
                const r = await api.projects.trustAndOpen(project.dir);
                if (!r.ok) {
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
            {trusting ? <Spinner decorative /> : null}
            {trusting ? 'Opening…' : 'Trust and open'}
          </button>
        </>
      }
    >
      <p id="trust-body" style={{ marginTop: 0 }}>
        <strong>{project.name}</strong> was made on another computer, or its setup files changed since you last opened it.
      </p>
      <p className="muted">
        To show a preview, SiteOrigin Builder runs the project's own website tools, which can run code on your computer. Only continue if you trust where this project came from.
      </p>
      <p className="trust-path">
        <FolderOpen size={14} />
        <span>{shortPath(project.dir)}</span>
      </p>
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
  // Progress belongs to this dialog's own attempt, named in its create call: another attempt still running (from a
  // window closed meanwhile, or one that replaced the open project and is starting its preview) reports nothing
  // here. Once this dialog has gone, its attempt's answer is only told as a notice.
  const attempt = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void api.dialogs.defaultProjectsFolder().then(setParent);
    const off = api.on('create:progress', (p) => !!attempt.current && p.attempt === attempt.current && setProgress(p));
    return () => {
      live.current = false;
      off();
    };
  }, []);
  const running = !!progress && progress.step !== 'error' && progress.step !== 'done';
  const slug = name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website';

  const create = async () => {
    if (attempt.current) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    attempt.current = id;
    setError(null);
    setProgress({ step: 'files', message: 'Preparing files…' });
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
    const idx = STEPS.findIndex((s) => s.id === progress.step);
    return (
      <Modal
        title={`Creating ${name.trim()}`}
        icon={<LayoutTemplate />}
        onClose={() => undefined}
        busy
        footer={
          // Once the new project is starting its preview it has replaced the open one: nothing is left to cancel.
          <button className="btn" onClick={() => void api.projects.cancelCreate()} disabled={!running || progress.step === 'preview'}>
            Cancel
          </button>
        }
      >
        <div className="progress-steps">
          {STEPS.map((s, i) => (
            <div key={s.id} className={`progress-step${i < idx || progress.step === 'done' ? ' done' : i === idx ? ' active' : ''}`}>
              <span className="dot">{i < idx || progress.step === 'done' ? <Check /> : i === idx ? <Spinner /> : null}</span>
              {s.label}
            </div>
          ))}
        </div>
        {progress.detail && <div className="progress-detail">{progress.detail}</div>}
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
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !parent} onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <Field label="Project name">
          <input className="input" autoFocus placeholder="For example, Harbour Lane Studio" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && name.trim() && void create()} />
        </Field>
        <Field label="Location" hint={parent ? `Saved in ${shortPath(parent)}/${slug}` : undefined}>
          <div className="row">
            <input className="input grow" value={shortPath(parent)} readOnly aria-label="Location" title={parent} />
            <button
              className="btn"
              onClick={async () => {
                const d = await api.dialogs.chooseFolder('Choose where to create the project', parent);
                if (d) setParent(d);
              }}
            >
              Choose…
            </button>
          </div>
        </Field>
        <Field label="Start from">
          <div
            className="starter-grid"
            role="radiogroup"
            aria-label="Start from"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const group = e.currentTarget;
              setStarter(starter === 'business' ? 'blank' : 'business');
              requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
            }}
          >
            <button className="starter-card" role="radio" aria-checked={starter === 'business'} tabIndex={starter === 'business' ? 0 : -1} onClick={() => setStarter('business')}>
              {starter === 'business' && (
                <span className="picked" aria-hidden="true">
                  <Check />
                </span>
              )}
              <div className="art">
                <i style={{ height: 8, width: '100%', opacity: 0.6 }} />
                <div className="row" style={{ gap: 5, flex: 1 }}>
                  <div className="col" style={{ gap: 4, flex: 1 }}>
                    <i className="hi" style={{ height: 10, width: '80%' }} />
                    <i style={{ height: 5, width: '90%' }} />
                    <i style={{ height: 5, width: '70%' }} />
                  </div>
                  <i style={{ width: 48, height: 46 }} />
                </div>
                <div className="row" style={{ gap: 5 }}>
                  <i style={{ height: 16, flex: 1 }} />
                  <i style={{ height: 16, flex: 1 }} />
                  <i style={{ height: 16, flex: 1 }} />
                </div>
              </div>
              <div className="copy">
                <strong>Business</strong>
                <p>Home, About and Contact pages, ready to make your own.</p>
              </div>
            </button>
            <button className="starter-card" role="radio" aria-checked={starter === 'blank'} tabIndex={starter === 'blank' ? 0 : -1} onClick={() => setStarter('blank')}>
              {starter === 'blank' && (
                <span className="picked" aria-hidden="true">
                  <Check />
                </span>
              )}
              <div className="art">
                <i style={{ height: 8, width: '100%', opacity: 0.6 }} />
                <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
                  <i style={{ height: 8, width: '50%' }} />
                </div>
                <i style={{ height: 10, width: '100%', opacity: 0.6 }} />
              </div>
              <div className="copy">
                <strong>Blank site</strong>
                <p>One page with a header and footer.</p>
              </div>
            </button>
          </div>
        </Field>
        {starter === 'business' && (
          <SwitchRow checked={images} onChange={setImages} label="Include sample images" hint="Placeholder photos you can replace any time." />
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Everything needed is included, and nothing is downloaded. Your website is saved as a normal folder that you own.
        </p>
        {error && (
          <div className="scope-note danger" role="alert" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
            <ShieldAlert />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
