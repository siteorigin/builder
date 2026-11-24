import { useEffect, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, Folder, FolderOpen, Plus, Settings, X } from 'lucide-react';
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
  const refusedPacks = useStore((st) => st.packs.refused);
  const [creating, setCreating] = useState(false);
  const [trust, setTrust] = useState<{ dir: string; name: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef(false);
  // The missing entry a found project takes over, once it has really opened (a trust prompt can still be cancelled).
  const replacing = useRef<string | undefined>(undefined);
  // What started an open: it is disabled meanwhile, so focus comes back to it when nothing else has taken over.
  const returnFocus = useRef<HTMLElement | null>(null);
  // The card to move to once a removed one has gone ('' when none are left: the first-run button).
  const focusAfterRemove = useRef<string | null>(null);
  const modal = useStore((s) => s.modal);
  const openingRecent = recents?.find((r) => r.dir === opening);
  const openingNote = openingRecent ? `${openingRecent.missing ? 'Finding' : 'Opening'} ${openingRecent.name}…` : opening ? 'Opening a project…' : '';
  const refresh = () => void api.projects.recents().then(setRecents);
  useEffect(() => {
    refresh();
    const onCmd = (e: Event) => {
      if (openDialogs.length) return;
      const cmd = (e as CustomEvent).detail;
      // A project on its way may still ask for trust: a New project form must not be underneath that.
      if (cmd === 'new-project' && !openingRef.current) setCreating(true);
      if (cmd === 'open-project') void open();
      if (cmd === 'open-project-folder') void open(undefined, { folder: true });
    };
    window.addEventListener('builder-command', onCmd);
    // A File menu command chosen while there was no window (macOS) is sent now that Welcome can act on it.
    api.menuReady();
    return () => window.removeEventListener('builder-command', onCmd);
  }, []);

  useEffect(() => {
    if (opening || trust) return;
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus();
  }, [opening, trust]);
  useEffect(() => {
    const next = focusAfterRemove.current;
    if (next === null || recents === null) return;
    focusAfterRemove.current = null;
    const card = [...document.querySelectorAll<HTMLElement>('.recent-card')].find((b) => b.title.endsWith(`\n${next}`));
    (card ?? document.querySelector<HTMLElement>('.empty-state .btn'))?.focus();
  }, [recents]);

  /**
   * A project found in a new place takes over its old entry, but only when it is recognisably the same project (its
   * name or folder name): choosing some other folder must not cost the shortcut. The newest recent is the one just opened.
   */
  const forgetMissing = async (dir: string) => {
    const list = await api.projects.recents();
    const old = list.find((x) => x.dir === dir && x.missing);
    const found = list[0];
    const folderName = (d: string) => d.split(/[\\/]/).filter(Boolean).pop();
    if (old && found && found !== old && !found.missing && (found.name === old.name || folderName(found.dir) === folderName(old.dir))) await api.projects.removeRecent(dir);
  };

  const open = async (dir?: string, opts?: { folder?: boolean; replaces?: string }) => {
    // One open at a time: a second request must not clear the busy state of the first, or race it in the main process.
    // The disabled buttons show it; this also stops the Open project menu command, which no button state reaches.
    if (openingRef.current) return;
    openingRef.current = true;
    returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setOpening(dir ?? opts?.replaces ?? (opts?.folder ? 'folder-dialog' : 'dialog'));
    try {
      const r = await api.projects.open(dir, opts?.folder ? { folder: true } : undefined);
      if (opts?.replaces && r.ok) await forgetMissing(opts.replaces).catch(() => undefined);
      replacing.current = r.needsTrust ? opts?.replaces : undefined;
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
          {/* On first run the main pane's button is the one primary action. */}
          <button className={`welcome-action${recents?.length === 0 ? ' secondary' : ''}`} disabled={!!opening} onClick={() => setCreating(true)}>
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
        {refusedPacks.length > 0 && (
          <details className="welcome-packs no-drag">
            <summary>{refusedPacks.length === 1 ? '1 theme pack' : `${refusedPacks.length} theme packs`} could not be loaded</summary>
            <ul>
              {refusedPacks.map((r) => (
                <li key={r.dir}>
                  <strong>{r.packId ?? r.dir.split(/[\\/]/).pop()}</strong>: {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="col no-drag" style={{ gap: 4 }}>
          <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} disabled={!!opening} onClick={() => setState({ modal: { kind: 'settings' } })}>
            <Settings /> Settings
          </button>
          <p className="faint" style={{ margin: '6px 12px 0', fontSize: 12 }}>
            Free and open source, from the makers of Page Builder by SiteOrigin. Every website you make is a folder on your computer that you can host anywhere.
          </p>
        </div>
      </aside>
      <main className="welcome-main">
        <div className="sr-only" role="status">
          {openingNote}
        </div>
        {recents === null ? null : recents.length === 0 ? (
          <>
            <h2>Make your first website</h2>
            <p className="muted" style={{ margin: 0 }}>
              Three steps, with no code and no hosting account. It takes about a minute to set up.
            </p>
            <div className="empty-state">
              <ol className="first-steps">
                <li>
                  <b>Pick a starter</b>
                  Pages, sections and sample images, ready to change.
                </li>
                <li>
                  <b>Click to edit</b>
                  Change text, images and colors right on the page.
                </li>
                <li>
                  <b>Export anywhere</b>
                  Your site is a folder you own. Host it anywhere.
                </li>
              </ol>
              <button className="btn btn-primary btn-lg" disabled={!!opening} onClick={() => setCreating(true)}>
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
                {/* A missing project's card finds it: the picker opens, and the same project found elsewhere takes over this entry. */}
                <button className="recent-card" style={{ width: '100%' }} disabled={!!opening} aria-busy={opening === r.dir || undefined} title={`${r.name}\n${r.dir}`} onClick={() => void (r.missing ? open(undefined, { folder: true, replaces: r.dir }) : open(r.dir))}>
                  <div className="recent-thumb" aria-hidden="true">{opening === r.dir ? <Spinner decorative /> : initials(r.name)}</div>
                  <div className="recent-meta">
                    <strong>{r.name}</strong>
                    <span className="where">
                      <Folder />
                      <span className="ellipsis" style={{ direction: 'rtl', textAlign: 'left' }}>
                        <bdi>{shortPath(whereLabel(r, recents))}</bdi>
                      </span>
                    </span>
                    {r.missing ? (
                      <span className="recent-status">
                        <span className="label">
                          <CircleAlert aria-hidden="true" /> Folder not found
                        </span>
                        <span className="find">{opening === r.dir ? 'Finding folder…' : 'Find folder…'}</span>
                      </span>
                    ) : (
                      <span>{opening === r.dir ? 'Opening…' : `Opened ${timeAgo(r.openedAt)}`}</span>
                    )}
                  </div>
                </button>
                <button
                  className="icon-btn sm remove"
                  aria-label={`Remove ${r.name} from recent projects`}
                  title={r.missing ? 'Remove from this list' : 'Remove from this list (the folder is not deleted)'}
                  disabled={!!opening}
                  onClick={async () => {
                    await api.projects.removeRecent(r.dir);
                    const rest = recents.filter((x) => x.dir !== r.dir);
                    const at = recents.indexOf(r);
                    focusAfterRemove.current = (rest[at] ?? rest[at - 1])?.dir ?? '';
                    refresh();
                    toast(r.missing ? `${r.name} was removed from this list.` : `${r.name} was removed from this list. Its folder is untouched.`);
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
        <TrustProjectModal
          project={trust}
          onClose={() => setTrust(null)}
          onOpened={() => {
            if (replacing.current) void forgetMissing(replacing.current).catch(() => undefined);
          }}
        />
      )}
      {modal?.kind === 'settings' && <SettingsModal />}
    </div>
  );
}

/** The folder a project is in, or its own folder when that is all that tells two same-named projects apart. */
function whereLabel(r: RecentProject, all: RecentProject[]) {
  const parent = (d: string) => d.replace(/[\\/][^\\/]+$/, '');
  return all.some((x) => x !== r && x.name === r.name && parent(x.dir) === parent(r.dir)) ? r.dir : parent(r.dir);
}

function initials(name: string) {
  // Words only, so "Tide & Timber" is TT rather than T&.
  return name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join('');
}
