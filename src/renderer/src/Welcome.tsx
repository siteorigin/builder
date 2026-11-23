import { useEffect, useState } from 'react';
import { Check, FolderOpen, Globe, LayoutTemplate, Plus, Settings, ShieldAlert, Trash2, X } from 'lucide-react';
import type { ProgressEvent, RecentProject } from '@shared/api';
import { api, setState, toast, useStore } from './store';
import { Field, Modal, Spinner, Switch } from './components/ui';
import { SettingsModal } from './panels/SettingsModal';

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" />
        <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
      </svg>
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
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [creating, setCreating] = useState(false);
  const [trust, setTrust] = useState<{ dir: string; name: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const modal = useStore((s) => s.modal);
  const refresh = () => void api.projects.recents().then(setRecents);
  useEffect(() => {
    refresh();
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'new-project') setCreating(true);
      if (cmd === 'open-project') void open();
    };
    window.addEventListener('builder-command', onCmd);
    return () => window.removeEventListener('builder-command', onCmd);
  }, []);

  const open = async (dir?: string) => {
    setOpening(dir ?? 'dialog');
    const r = await api.projects.open(dir);
    setOpening(null);
    if (r.needsTrust) setTrust(r.needsTrust);
    else if (!r.ok && r.message) toast(r.message, 'error');
    refresh();
  };

  return (
    <div className="welcome">
      <aside className="welcome-side drag">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>SiteOrigin Builder</h1>
            <p>Websites you own, built visually</p>
          </div>
        </div>
        <div className="welcome-actions no-drag">
          <button className="welcome-action" onClick={() => setCreating(true)}>
            <span className="ico">
              <Plus size={18} />
            </span>
            <span>
              <strong>New project</strong>
              <span>Start from a starter site</span>
            </span>
          </button>
          <button className="welcome-action secondary" onClick={() => void open()}>
            <span className="ico">
              <FolderOpen size={18} />
            </span>
            <span>
              <strong>Open project…</strong>
              <span>Choose a project folder</span>
            </span>
          </button>
        </div>
        <div className="spacer" />
        <div className="col no-drag" style={{ gap: 4 }}>
          <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setState({ modal: { kind: 'settings' } })}>
            <Settings /> Settings
          </button>
          <p className="faint" style={{ margin: '6px 12px 0', fontSize: 11.5 }}>
            Free and open source. Every website you make is yours: a complete project folder on your computer that you can host anywhere.
          </p>
        </div>
      </aside>
      <main className="welcome-main">
        <h2>Recent projects</h2>
        <p className="muted" style={{ margin: 0 }}>
          Pick up where you left off.
        </p>
        {recents.length === 0 ? (
          <div className="empty-state">
            <Globe />
            <strong style={{ color: 'var(--text)' }}>No projects yet</strong>
            <span>Create your first website from a starter. It takes about a minute.</span>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus /> New project
            </button>
          </div>
        ) : (
          <div className="recent-grid">
            {recents.map((r) => (
              <div key={r.dir} style={{ position: 'relative' }}>
                <button className="recent-card" style={{ width: '100%' }} disabled={!!opening} onClick={() => (r.missing ? toast('That project folder could not be found. It may have been moved or deleted.', 'error') : void open(r.dir))}>
                  <div className="recent-thumb">{opening === r.dir ? <Spinner large /> : initials(r.name)}</div>
                  <div className="recent-meta">
                    <strong className="ellipsis">{r.name}</strong>
                    <span className="ellipsis" title={r.dir}>
                      {r.missing ? 'Folder not found' : r.dir.replace(/^\/Users\/[^/]+/, '~')}
                    </span>
                    <span>Opened {timeAgo(r.openedAt)}</span>
                  </div>
                </button>
                <button
                  className="icon-btn sm remove"
                  style={{ position: 'absolute', top: 8, right: 8 }}
                  aria-label={`Remove ${r.name} from recents`}
                  title="Remove from recent projects"
                  onClick={async () => {
                    await api.projects.removeRecent(r.dir);
                    refresh();
                  }}
                >
                  <X />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {trust && (
        <Modal
          title="Trust this project?"
          icon={<ShieldAlert size={18} color="var(--amber)" />}
          onClose={() => setTrust(null)}
          footer={
            <>
              <button className="btn" onClick={() => setTrust(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const t = trust;
                  setTrust(null);
                  const r = await api.projects.trustAndOpen(t.dir);
                  if (!r.ok && r.message) toast(r.message, 'error');
                }}
              >
                Trust and open
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            <strong>{trust.name}</strong> was not created on this computer, or its build configuration changed since you last opened it.
          </p>
          <p className="muted">
            Opening it runs the project's own build tools (Vite and SvelteKit) to show a preview. Only continue if you trust where this project came from.
          </p>
          <p className="mono faint" style={{ wordBreak: 'break-all' }}>
            {trust.dir}
          </p>
        </Modal>
      )}
      {modal?.kind === 'settings' && <SettingsModal />}
    </div>
  );
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
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website';

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
        onClose={() => running && void api.projects.cancelCreate()}
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
      icon={<LayoutTemplate size={18} color="var(--accent)" />}
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
          <input className="input" autoFocus placeholder="Harbour Lane Studio" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
        </Field>
        <Field label="Location" hint={parent ? `The project will be created in ${parent.replace(/^\/Users\/[^/]+/, '~')}/${slug}` : undefined}>
          <div className="row">
            <input className="input grow" value={parent} readOnly />
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
          <div className="starter-grid">
            <button className="starter-card" aria-pressed={starter === 'business'} onClick={() => setStarter('business')}>
              <div className="art">
                <i style={{ height: 8, width: '100%', opacity: 0.6 }} />
                <div className="row" style={{ gap: 5, flex: 1 }}>
                  <div className="col" style={{ gap: 4, flex: 1 }}>
                    <i style={{ height: 10, width: '80%', background: 'var(--accent)', opacity: 0.55 }} />
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
                <strong>Business starter</strong>
                <p>Home, About and Contact pages, ready to make your own.</p>
              </div>
            </button>
            <button className="starter-card" aria-pressed={starter === 'blank'} onClick={() => setStarter('blank')}>
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
          <div className="row">
            <Switch checked={images} onChange={setImages} label="Include sample images" />
            <span>Include sample images</span>
            <span className="faint">(fictional, replace any time)</span>
          </div>
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Everything needed to build your site is included. Your website is saved as a normal folder you own. Theme: Foundation.
        </p>
        {error && <div className="scope-note site">{error}</div>}
      </div>
    </Modal>
  );
}
