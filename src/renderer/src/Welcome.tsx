import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Folder, FolderOpen, LayoutTemplate, MousePointerClick, Plus, Settings, ShieldAlert, Upload, X } from 'lucide-react';
import type { ProgressEvent, RecentProject } from '@shared/api';
import { api, errorText, setState, toast, useStore } from './store';
import { Field, Modal, openDialogs, Spinner, SwitchRow } from './components/ui';
import { SettingsModal } from './panels/SettingsModal';
import { AppMark } from './components/AppMark';

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <AppMark size={44} />
    </div>
  );
}

function timeAgo(iso: string): string {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function Welcome() {
  // null until the first load, so returning users never see a flash of the first-run screen.
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [trust, setTrust] = useState<{ dir: string; name: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [trusting, setTrusting] = useState(false);
  const openingRef = useRef(false);
  const modal = useStore((s) => s.modal);
  const refresh = () => void api.projects.recents().then(setRecents);
  useEffect(() => {
    refresh();
    const intent = useStore.getState().welcomeIntent;
    if (intent) {
      setState({ welcomeIntent: null });
      if (intent.kind === 'new') setCreating(true);
      else setTrust({ dir: intent.dir, name: intent.name });
    }
    const onCmd = (e: Event) => {
      if (openDialogs.length) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'new-project') setCreating(true);
      if (cmd === 'open-project') void open();
    };
    window.addEventListener('builder-command', onCmd);
    return () => window.removeEventListener('builder-command', onCmd);
  }, []);

  const open = async (dir?: string) => {
    // One open at a time: a second request must not clear the busy state of the first, or race it in the main process.
    // The disabled buttons show it; this also stops the Open project menu command, which no button state reaches.
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(dir ?? 'dialog');
    try {
      const r = await api.projects.open(dir);
      if (r.needsTrust) setTrust(r.needsTrust);
      else if (!r.ok && r.message) toast(r.message, 'error');
    } catch (e) {
      // Whatever went wrong, the author sees it and can choose another project straight away.
      toast(`Could not open the project: ${errorText(e)}`, 'error');
    } finally {
      openingRef.current = false;
      setOpening(null);
      refresh();
    }
  };

  return (
    <div className="welcome">
      <aside className="welcome-side drag">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>
              SiteOrigin <span>Builder</span>
            </h1>
            <p>Websites you own, built visually</p>
          </div>
        </div>
        <div className="welcome-actions no-drag">
          <button className="welcome-action" onClick={() => setCreating(true)}>
            <span className="ico">
              <Plus size={18} />
            </span>
            <span className="grow">
              <strong>New project</strong>
              <span>Start from a ready-made site</span>
            </span>
            <ChevronRight className="chev" />
          </button>
          {/* One project opens at a time: a second open while one is on its way would not close the first. */}
          <button className="welcome-action secondary" disabled={!!opening} onClick={() => void open()}>
            <span className="ico">{opening === 'dialog' ? <Spinner decorative /> : <FolderOpen size={18} />}</span>
            <span className="grow">
              <strong>Open project…</strong>
              <span>Choose a project folder</span>
            </span>
            <ChevronRight className="chev" />
          </button>
        </div>
        <div className="spacer" />
        <div className="col no-drag" style={{ gap: 4 }}>
          <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setState({ modal: { kind: 'settings' } })}>
            <Settings /> Settings
          </button>
          <p className="faint" style={{ margin: '6px 12px 0', fontSize: 12 }}>
            Free and open source, from the makers of Page Builder by SiteOrigin. Every website you make is a folder on your computer that you can host anywhere.
          </p>
        </div>
      </aside>
      <main className="welcome-main">
        {recents === null ? null : recents.length === 0 ? (
          <>
            <h2>Welcome to SiteOrigin Builder</h2>
            <p className="muted" style={{ margin: 0 }}>
              Build a website for your business, visually. No code, no hosting account needed.
            </p>
            <div className="empty-state">
              <span className="empty-icon">
                <AppMark size={64} />
              </span>
              <strong>Make your first website</strong>
              <span>Start from a ready-made site and make it yours. It takes about a minute to set up.</span>
              <ol className="first-steps">
                <li>
                  <b>
                    <LayoutTemplate /> Pick a starter
                  </b>
                  Pages, sections and sample images, ready to change.
                </li>
                <li>
                  <b>
                    <MousePointerClick /> Click to edit
                  </b>
                  Change text, images and colors right on the page.
                </li>
                <li>
                  <b>
                    <Upload /> Export anywhere
                  </b>
                  Your site is a folder you own. Host it anywhere.
                </li>
              </ol>
              <button className="btn btn-primary btn-lg" onClick={() => setCreating(true)}>
                <Plus /> New project
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Recent projects</h2>
            <p className="muted" style={{ margin: 0 }}>
              Pick up where you left off.
            </p>
          <div className="recent-grid">
            {recents.map((r) => (
              <div key={r.dir} className={`recent-item${r.missing ? ' missing' : ''}`}>
                <button className="recent-card" style={{ width: '100%' }} disabled={!!opening} title={`${r.name}\n${r.dir}`} onClick={() => (r.missing ? toast('That project folder could not be found. It may have been moved or deleted.', 'error', { label: 'Remove from list', run: () => void api.projects.removeRecent(r.dir).then(refresh) }) : void open(r.dir))}>
                  <div className="recent-thumb" aria-hidden="true">{opening === r.dir ? <Spinner large decorative /> : initials(r.name)}</div>
                  <div className="recent-meta">
                    <strong>{r.name}</strong>
                    <span className="where">
                      <Folder />
                      <span className="ellipsis" style={{ direction: 'rtl', textAlign: 'left' }}>
                        <bdi>{r.missing ? 'Folder not found' : shortPath(r.dir.replace(/[\\/][^\\/]+$/, ''))}</bdi>
                      </span>
                    </span>
                    <span>{opening === r.dir ? 'Opening…' : `Opened ${timeAgo(r.openedAt)}`}</span>
                  </div>
                </button>
                <button
                  className="icon-btn sm remove"
                  aria-label={`Remove ${r.name} from recent projects`}
                  title="Remove from this list (the folder is not deleted)"
                  disabled={!!opening}
                  onClick={async () => {
                    await api.projects.removeRecent(r.dir);
                    refresh();
                    toast(`${r.name} was removed from this list. Its folder is untouched.`);
                  }}
                >
                  <X />
                </button>
              </div>
            ))}
          </div>
          </>
        )}
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {trust && (
        <Modal
          title="Trust this project?"
          describedBy="trust-body"
          icon={<ShieldAlert style={{ color: 'var(--amber)' }} />}
          onClose={() => setTrust(null)}
          busy={trusting}
          footer={
            <>
              <button className="btn" data-autofocus disabled={trusting} onClick={() => setTrust(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={trusting}
                onClick={async () => {
                  const t = trust;
                  setTrusting(true);
                  try {
                    const r = await api.projects.trustAndOpen(t.dir);
                    if (!r.ok && r.message) toast(r.message, 'error');
                  } catch (e) {
                    toast(`Could not open the project: ${errorText(e)}`, 'error');
                  } finally {
                    setTrusting(false);
                    setTrust(null);
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
            <strong>{trust.name}</strong> was made on another computer, or its setup files changed since you last opened it.
          </p>
          <p className="muted">
            To show a preview, SiteOrigin Builder runs the project's own website tools, which can run code on your computer. Only continue if you trust where this project came from.
          </p>
          <p className="trust-path">
            <FolderOpen size={14} />
            <span>{shortPath(trust.dir)}</span>
          </p>
        </Modal>
      )}
      {modal?.kind === 'settings' && <SettingsModal />}
    </div>
  );
}

function shortPath(dir: string) {
  return dir.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

const STEPS: Array<{ id: ProgressEvent['step']; label: string }> = [
  { id: 'files', label: 'Preparing files' },
  { id: 'dependencies', label: 'Setting up website tools' },
  { id: 'preview', label: 'Starting preview' }
];

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [starter, setStarter] = useState<'business' | 'blank'>('business');
  const [images, setImages] = useState(true);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.dialogs.defaultProjectsFolder().then(setParent);
    return api.on('create:progress', setProgress);
  }, []);
  const running = !!progress && progress.step !== 'error' && progress.step !== 'done';
  const slug = name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website';

  const create = async () => {
    setError(null);
    setProgress({ step: 'files', message: 'Preparing files…' });
    const r = await api.projects.create({ name: name.trim(), parentDir: parent, starter, sampleImages: images });
    if (!r.ok) {
      setError(r.message ?? 'The project could not be created.');
      setProgress(null);
    }
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
          <button className="btn" onClick={() => void api.projects.cancelCreate()} disabled={!running}>
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
          <input className="input" autoFocus placeholder="For example, Harbour Lane Studio" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
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
