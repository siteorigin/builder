import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, LayoutTemplate, MousePointerClick, Plus, Settings, Upload, X } from 'lucide-react';
import type { RecentProject } from '@shared/api';
import { api, errorText, setState, toast, useStore } from './store';
import { openDialogs, Spinner } from './components/ui';
import { NewProjectModal, shortPath, TrustProjectModal } from './components/ProjectDialogs';
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

/** macOS's picker takes a folder or a file; Windows and Linux pickers take one or the other. */
const pickerTakesFolders = api.platform === 'darwin';

export function Welcome() {
  // null until the first load, so returning users never see a flash of the first-run screen.
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [trust, setTrust] = useState<{ dir: string; name: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef(false);
  const modal = useStore((s) => s.modal);
  const refresh = () => void api.projects.recents().then(setRecents);
  useEffect(() => {
    refresh();
    const onCmd = (e: Event) => {
      if (openDialogs.length) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'new-project') setCreating(true);
      if (cmd === 'open-project') void open();
      if (cmd === 'open-project-folder') void open(undefined, { folder: true });
    };
    window.addEventListener('builder-command', onCmd);
    // A File menu command chosen while there was no window (macOS) is sent now that Welcome can act on it.
    api.menuReady();
    return () => window.removeEventListener('builder-command', onCmd);
  }, []);

  const open = async (dir?: string, opts?: { folder?: boolean }) => {
    // One open at a time: a second request must not clear the busy state of the first, or race it in the main process.
    // The disabled buttons show it; this also stops the Open project menu command, which no button state reaches.
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(dir ?? (opts?.folder ? 'folder-dialog' : 'dialog'));
    try {
      const r = await api.projects.open(dir, opts);
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
              <span>{pickerTakesFolders ? 'Choose a project folder or ZIP file' : 'Choose a project file or ZIP file'}</span>
            </span>
            <ChevronRight className="chev" />
          </button>
          {/* Windows and Linux pickers take files or folders, not both: a project folder has its own. */}
          {!pickerTakesFolders && (
            <button className="welcome-action secondary" disabled={!!opening} onClick={() => void open(undefined, { folder: true })}>
              <span className="ico">{opening === 'folder-dialog' ? <Spinner decorative /> : <Folder size={18} />}</span>
              <span className="grow">
                <strong>Open project folder…</strong>
                <span>Choose the folder a project is in</span>
              </span>
              <ChevronRight className="chev" />
            </button>
          )}
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
      {trust && <TrustProjectModal project={trust} onClose={() => setTrust(null)} />}
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
