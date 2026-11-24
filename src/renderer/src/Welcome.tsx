import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, Folder, FolderOpen, Moon, Pin, Plus, Search, Settings, Sun, X } from 'lucide-react';
import type { RecentProject } from '@shared/api';
import { api, errorText, setState, toast, useStore } from './store';
import { openDialogs, Spinner } from './components/ui';
import { NewProjectModal, TrustProjectModal } from './components/ProjectDialogs';
import { recentGroups, whereLabels } from './lib/recent-places';
import { SettingsModal } from './panels/SettingsModal';
import { AppMark, MARK_COLORS } from './components/AppMark';
import { switchScheme, useEditorScheme } from './lib/appearance';

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <AppMark size={48} />
    </div>
  );
}

/**
 * One click between the editor's light and dark Appearance, without opening Settings (#554). It shows the scheme the
 * editor is drawn in (System resolved to this computer's) and saves the other one as the Appearance; System stays a
 * choice in Settings. The editor redraws from the saved setting (lib/appearance.ts).
 */
export function AppearanceToggle() {
  const scheme = useEditorScheme();
  const dark = scheme === 'dark';
  const toggle = async () => {
    try {
      const saved = await switchScheme();
      if (saved) setState({ settings: saved });
    } catch (e) {
      toast(`Could not change the appearance: ${errorText(e)}`, 'error');
    }
  };
  return (
    <button type="button" className="icon-btn appearance-toggle no-drag" role="switch" aria-checked={dark} aria-label="Dark appearance" title={dark ? 'Switch to light appearance' : 'Switch to dark appearance'} onClick={() => void toggle()}>
      {dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
    </button>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  // Calendar days first, so a project opened late last night is "yesterday" this morning.
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86400000);
  if (days <= 0) {
    const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A path short enough to read on a card: its first folder or two, an ellipsis, and the folder itself, plus any
 * segment that tells it apart from a same-named project's path. CSS still clips from the left if it runs long.
 */
function compactPath(path: string, others: string[] = [], max = 34): string {
  if (path.length <= max) return path;
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const parts = path.split(sep);
  // Always: where it starts, the folder itself, and any segment that differs from a same-named project's path.
  const required = new Set([0, parts.length - 1]);
  for (const o of others) {
    const op = o.split(sep);
    const at = parts.findIndex((seg, i) => op[i] !== seg);
    if (at > 0) required.add(at);
  }
  // Then, room allowing, the first real folder and a drive's own name ("/Volumes/Archive").
  const preferred = new Set(required);
  if (parts[0] === '' && parts.length > 2) preferred.add(1);
  if (parts[0] === '' && parts[1] === 'Volumes' && parts.length > 3) preferred.add(2);
  const keep = joinKept(parts, preferred, sep).length <= max ? preferred : required;
  for (let i = 1; i < parts.length - 1; i++) {
    if (keep.has(i)) continue;
    const trial = new Set(keep).add(i);
    if (joinKept(parts, trial, sep).length > max) break;
    keep.add(i);
  }
  return joinKept(parts, keep, sep);
}
function joinKept(parts: string[], keep: Set<number>, sep: string) {
  const out: string[] = [];
  parts.forEach((seg, i) => {
    if (keep.has(i)) out.push(seg);
    else if (out[out.length - 1] !== '…') out.push('…');
  });
  return out.join(sep);
}

/** macOS's picker takes a folder or a file; Windows and Linux pickers take one or the other. */
const pickerTakesFolders = api.platform === 'darwin';
/** The File menu's accelerators for the two actions (src/main/index.ts), shown beside them. */
const mac = api.platform === 'darwin';
const keys = {
  newProject: { label: mac ? '⇧⌘N' : 'Ctrl+Shift+N', aria: mac ? 'Shift+Meta+N' : 'Control+Shift+N' },
  open: { label: mac ? '⌘O' : 'Ctrl+O', aria: mac ? 'Meta+O' : 'Control+O' }
};
/** Past three full rows at the widest window, a filter beats scanning. */
const FILTER_FROM = 8;

export function Welcome() {
  // null until the first load, so returning users never see a flash of the first-run screen.
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const refusedPacks = useStore((st) => st.packs.refused);
  const [creating, setCreating] = useState(false);
  // A project to trust before it opens, with the missing entry it was chosen for (Find folder…), if any.
  const [trust, setTrust] = useState<{ dir: string; name: string; replaces?: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterInput = useRef<HTMLInputElement>(null);
  const filterSeen = useRef(false);
  const results = useRef<HTMLDivElement>(null);
  // Set when a filter is cleared, so the status line can say the whole list is back.
  const [cleared, setCleared] = useState(false);
  const openingRef = useRef(false);
  // What started an open: it is disabled meanwhile, so focus comes back to it when nothing else has taken over.
  const returnFocus = useRef<HTMLElement | null>(null);
  // The card to move to once a removed one has gone ('' when none are left: the first-run button).
  const focusAfterRemove = useRef<string | null>(null);
  // The card whose Pin was just pressed: it moves to the other group, so its button is found again there.
  const focusAfterPin = useRef<string | null>(null);
  // Only the newest reading of the list is shown, whatever order the replies come back in.
  const reads = useRef(0);
  const modal = useStore((s) => s.modal);
  const openingRecent = recents?.find((r) => r.dir === opening);
  const openingNote = openingRecent ? `${openingRecent.missing ? 'Finding' : 'Opening'} ${openingRecent.name}…` : opening ? 'Opening a project…' : '';
  const refresh = () => {
    const read = ++reads.current;
    void api.projects.recents().then((list) => {
      if (read === reads.current) setRecents(list);
    });
  };
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
    // No card left to move to: the first-run button, or the filter when it has hidden the rest.
    (cardOf(next) ?? filterInput.current ?? document.querySelector<HTMLElement>('.empty-state .btn'))?.focus();
  }, [recents]);
  useEffect(() => {
    const moved = focusAfterPin.current;
    if (moved === null || recents === null) return;
    focusAfterPin.current = null;
    // Its card is drawn anew in the other group: focus follows it there, unless the author has moved on meanwhile.
    if (!document.activeElement || document.activeElement === document.body) cardOf(moved)?.parentElement?.querySelector<HTMLElement>('.pin')?.focus();
  }, [recents]);

  const open = async (dir?: string, opts?: { folder?: boolean; replaces?: string }) => {
    // One open at a time: a second request must not clear the busy state of the first, or race it in the main process.
    // The disabled buttons show it; this also stops the Open project menu command, which no button state reaches.
    if (openingRef.current) return;
    openingRef.current = true;
    returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setOpening(dir ?? opts?.replaces ?? (opts?.folder ? 'folder-dialog' : 'dialog'));
    try {
      // A missing entry's Find folder…: the main process drops the entry once the same project has opened (#217),
      // after the trust prompt when there is one, so a cancel or another project keeps it.
      const r = await api.projects.open(dir, opts);
      if (r.needsTrust) setTrust({ ...r.needsTrust, replaces: opts?.replaces });
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

  const filtering = filter.trim().toLowerCase();
  // Pinned projects above the rest (#259), each once; `shown` is every card in the order on screen.
  const groups = recents ? recentGroups(recents, filtering) : null;
  const shown = groups ? [...groups.pinned, ...groups.recent] : null;
  // The project to come back to: the newest, in the full, unfiltered list (a missing one too, with its Find folder).
  const latest = recents && !filtering ? recents[0]?.dir : null;
  // Once shown, the filter stays for this visit while there are projects, so removing one can never take away the
  // field that has focus or leave a list filtered with no way to clear it.
  if (recents && recents.length > FILTER_FROM) filterSeen.current = true;
  const showFilter = !!recents && recents.length > 0 && (filterSeen.current || filter !== '');
  const clearFilter = () => {
    setFilter('');
    setCleared(true);
    filterInput.current?.focus();
  };
  const filterNote = filtering ? (shown?.length === 0 ? 'No projects match' : shown?.length === 1 ? '1 project matches' : `${shown?.length} projects match`) : cleared && recents ? `Showing all ${countOf(recents.length)}` : '';
  const labels = recents ? whereLabels(recents) : new Map<string, string>();
  // A new query starts the results from the top, so the best matches (and, once cleared, the newest project) are in view.
  useEffect(() => {
    results.current?.scrollTo({ top: 0 });
  }, [filtering]);
  const removeProject = async (r: RecentProject) => {
    if (!recents || !shown) return;
    await api.projects.removeRecent(r.dir);
    setCleared(false);
    const rest = shown.filter((x) => x.dir !== r.dir);
    const at = shown.indexOf(r);
    focusAfterRemove.current = (rest[at] ?? rest[at - 1])?.dir ?? '';
    refresh();
    toast(r.missing ? `${r.name} was removed from this list.` : `${r.name} was removed from this list. Its folder is untouched.`);
  };
  const pinProject = async (r: RecentProject) => {
    const pinned = r.pinned !== true;
    focusAfterPin.current = r.dir;
    try {
      await api.projects.pinRecent(r.dir, pinned);
      toast(pinned ? `${r.name} is pinned. It stays on this list however many other projects you open.` : `${r.name} is no longer pinned.`);
    } catch (e) {
      toast(`Could not ${pinned ? 'pin' : 'unpin'} ${r.name}: ${errorText(e)}`, 'error');
    } finally {
      refresh();
    }
  };

  /** One project's card, with its Remove and Pin buttons, in whichever group it is shown. */
  const card = (r: RecentProject) => {
    const busy = opening === r.dir;
    const isLatest = r.dir === latest;
    const twins = (recents ?? []).filter((x) => x !== r && x.name === r.name).map((x) => labels.get(x.dir) ?? x.dir);
    const twin = twins.length > 0;
    const where = labels.get(r.dir) ?? r.dir;
    return (
      <li key={r.dir} className={`recent-item${r.missing ? ' missing' : ''}${isLatest ? ' latest' : ''}`}>
        {/* A missing project's card finds it: the picker opens, and the same project found elsewhere takes over this entry (#217). */}
        <button className="recent-card" disabled={!!opening} aria-busy={busy || undefined} title={`${r.name}\n${r.dir}`} onClick={() => void (r.missing ? open(undefined, { folder: true, replaces: r.dir }) : open(r.dir))}>
          <div className="recent-thumb" aria-hidden="true">
            {busy ? <Spinner decorative /> : initials(r.name)}
          </div>
          <div className="recent-meta">
            <strong>{r.name}</strong>
            <span className="where">
              <Folder aria-hidden="true" />
              {r.missing ? (
                // A missing project shows its own folder over up to two lines: that is the one to look for.
                <>
                  <span className="path-full" aria-hidden="true">
                    {pathBreaks(compactPath(where, twins, 64))}
                  </span>
                  <span className="sr-only">{where}</span>
                </>
              ) : (
                <>
                  <span className="ellipsis" style={{ direction: 'rtl', textAlign: 'left' }}>
                    <bdi aria-hidden="true">{compactPath(where, twins)}</bdi>
                  </span>
                  <span className="sr-only">{where}</span>
                </>
              )}
            </span>
            {r.missing ? (
              <span className="recent-status">
                {busy ? (
                  <span className="busy">Finding folder…</span>
                ) : (
                  <>
                    <span className="label">
                      <CircleAlert aria-hidden="true" /> Folder not found
                    </span>
                    <span className="find">Find folder…</span>
                  </>
                )}
              </span>
            ) : (
              <span className={`when${busy ? ' busy' : ''}`}>{busy ? 'Opening…' : `${isLatest ? 'Last opened' : 'Opened'} ${timeAgo(r.openedAt)}`}</span>
            )}
          </div>
          {isLatest && !busy && !r.missing && (
            <span className="recent-go">
              Open <ArrowRight aria-hidden="true" />
            </span>
          )}
        </button>
        <button
          className="icon-btn remove"
          aria-label={twin ? `Remove ${r.name} (${where}) from recent projects` : `Remove ${r.name} from recent projects`}
          title={r.missing ? 'Remove from this list' : 'Remove from this list (the folder is not deleted)'}
          disabled={!!opening}
          onClick={() => void removeProject(r)}
        >
          <X />
        </button>
        {/* Pinned, a project stays listed above the rest however many others are opened after it (#259). */}
        <button
          className="icon-btn pin"
          aria-label={twin ? `Pin ${r.name} (${where})` : `Pin ${r.name}`}
          aria-pressed={r.pinned === true}
          title={r.pinned ? 'Unpin' : 'Pin to the top of this list'}
          disabled={!!opening}
          onClick={() => void pinProject(r)}
        >
          <Pin />
        </button>
      </li>
    );
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
          {/* With recent projects this is the screen's one primary action; on first run the main pane's button is. */}
          <button className={`welcome-action${recents?.length ? ' primary' : ' secondary'}`} disabled={!!opening} aria-keyshortcuts={keys.newProject.aria} onClick={() => setCreating(true)}>
            <span className="ico">
              <Plus size={18} />
            </span>
            <span className="grow">
              <span className="title">
                <strong>New project</strong>
                <kbd className="kbd" aria-hidden="true">
                  {keys.newProject.label}
                </kbd>
              </span>
              <span>Start from a ready-made site</span>
            </span>
          </button>
          {/* One project opens at a time: a second open while one is on its way would not close the first. */}
          <button className="welcome-action secondary" disabled={!!opening} aria-busy={opening === 'dialog' || undefined} aria-keyshortcuts={keys.open.aria} onClick={() => void open()}>
            <span className="ico">{opening === 'dialog' ? <Spinner decorative /> : <FolderOpen size={18} />}</span>
            <span className="grow">
              <span className="title">
                <strong>Open project…</strong>
                <kbd className="kbd" aria-hidden="true">
                  {keys.open.label}
                </kbd>
              </span>
              <span>{opening === 'dialog' ? 'Opening…' : pickerTakesFolders ? 'A project folder or ZIP file' : 'A project file or ZIP file'}</span>
            </span>
          </button>
          {/* Windows and Linux pickers take files or folders, not both: a project folder has its own. */}
          {!pickerTakesFolders && (
            <button className="welcome-action secondary" disabled={!!opening} aria-busy={opening === 'folder-dialog' || undefined} onClick={() => void open(undefined, { folder: true })}>
              <span className="ico">{opening === 'folder-dialog' ? <Spinner decorative /> : <Folder size={18} />}</span>
              <span className="grow">
                <strong>Open project folder…</strong>
                <span>{opening === 'folder-dialog' ? 'Opening…' : 'The folder a project is in'}</span>
              </span>
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
        <footer className="welcome-foot no-drag">
          <button className="btn btn-ghost" disabled={!!opening} onClick={() => setState({ modal: { kind: 'settings' } })}>
            <Settings /> Settings
          </button>
          <p>Free and open source, from the makers of Page Builder by SiteOrigin.</p>
        </footer>
      </aside>
      <main className="welcome-main">
        <AppearanceToggle />
        <div className="sr-only" role="status">
          {openingNote}
        </div>
        {recents === null || groups === null || shown === null ? null : recents.length === 0 ? (
          <section className="empty-state welcome-hero" aria-labelledby="welcome-hero-title">
            <div className="hero-copy">
              <h2 id="welcome-hero-title">Make your first website</h2>
              <p className="hero-pitch">Start with a ready-made design and edit it right on the page, without code. Your site lives in a folder you own.</p>
              <button className="btn btn-primary btn-lg" disabled={!!opening} onClick={() => setCreating(true)}>
                <Plus /> New project
              </button>
            </div>
            <SiteSketch />
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
                Upload the finished folder to any web host.
              </li>
            </ol>
          </section>
        ) : (
          <>
            <header className="welcome-head">
              <div>
                <h2>Recent projects</h2>
                <p className="muted">{filtering ? `${shown.length} of ${countOf(recents.length)}` : 'Pick up where you left off.'}</p>
              </div>
              {showFilter && (
                <div className="recent-filter">
                  <Search aria-hidden="true" />
                  <input
                    ref={filterInput}
                    className="input"
                    type="search"
                    value={filter}
                    placeholder="Filter by name or folder"
                    aria-label="Filter recent projects"
                    spellCheck={false}
                    disabled={!!opening}
                    onChange={(e) => {
                      // Emptying the field by typing brings the whole list back too, and says so.
                      setCleared(filter.trim() !== '' && e.target.value.trim() === '');
                      setFilter(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && filter) {
                        e.preventDefault();
                        e.stopPropagation();
                        clearFilter();
                      }
                    }}
                  />
                  {filter && (
                    <button className="icon-btn sm clear" aria-label="Clear filter" title="Clear filter (Esc)" disabled={!!opening} onClick={clearFilter}>
                      <X />
                    </button>
                  )}
                </div>
              )}
            </header>
            {showFilter && (
              <p className="sr-only" role="status">
                {filterNote}
              </p>
            )}
            <div ref={results} className="recent-scroll scroll">
            {shown.length === 0 ? (
              <div className="recent-none">
                <p>
                  No recent projects match <q>{filter.trim()}</q>.
                </p>
                <button className="btn btn-sm" disabled={!!opening} onClick={clearFilter}>
                  Clear filter
                </button>
              </div>
            ) : (
              <>
                {groups.pinned.length > 0 && (
                  <section className="recent-group" aria-labelledby="recent-pinned">
                    <h3 id="recent-pinned" className="recent-group-title">
                      <Pin aria-hidden="true" /> Pinned
                    </h3>
                    <ul className="recent-grid" aria-label="Pinned projects">
                      {groups.pinned.map(card)}
                    </ul>
                  </section>
                )}
                {groups.recent.length > 0 &&
                  (groups.pinned.length > 0 ? (
                    <section className="recent-group" aria-labelledby="recent-others">
                      <h3 id="recent-others" className="recent-group-title">
                        Recent
                      </h3>
                      <ul className="recent-grid" aria-label="Recent projects">
                        {groups.recent.map(card)}
                      </ul>
                    </section>
                  ) : (
                    <ul className="recent-grid" aria-label="Recent projects">
                      {groups.recent.map(card)}
                    </ul>
                  ))}
              </>
            )}
            </div>
          </>
        )}
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {trust && (
        <TrustProjectModal project={trust} onClose={() => setTrust(null)} />
      )}
      {modal?.kind === 'settings' && <SettingsModal />}
    </div>
  );
}

/**
 * A website taking shape, drawn in the New project dialog's sketch vocabulary: a page in a window, its headline
 * selected the way the canvas selects things. Decorative; the copy beside it says the same in words.
 */
function SiteSketch() {
  const mark = MARK_COLORS;
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="sketch-window">
        <div className="sketch-bar">
          <i />
          <i />
          <i />
          <b />
        </div>
        <div className="sketch-page">
          <div className="sketch-nav">
            <span className="logo">Harbour Lane</span>
            <span>Shop</span>
            <span>Weddings</span>
            <span>Visit</span>
          </div>
          <div className="sketch-hero">
            <div className="sketch-copy">
              <div className="sketch-selected">
                <span className="sketch-h1">Flowers for every season</span>
                <span className="sketch-tag">Heading</span>
              </div>
              <span className="sketch-p">Bouquets made to order, delivered daily.</span>
              <span className="sketch-cta">Order flowers</span>
            </div>
            <svg className="sketch-pic" viewBox="0 0 72 72">
              <rect width="72" height="72" rx="6" fill="#fff" />
              <circle cx="36" cy="30" r="22" fill={mark.tileTop} />
              <path d="M36 66V34" stroke={mark.ink} strokeWidth="2" />
              <path d="M36 52c-8-1-13-6-14-12 7 0 12 4 14 12zM36 47c6-1 11-5 12-11-6 0-11 4-12 11z" fill={mark.ground} stroke={mark.ink} strokeWidth="1.2" />
              <g fill={mark.tileBottom} stroke={mark.ink} strokeWidth="1.2">
                <circle cx="36" cy="16" r="6" />
                <circle cx="45" cy="23" r="6" />
                <circle cx="42" cy="33" r="6" />
                <circle cx="30" cy="33" r="6" />
                <circle cx="27" cy="23" r="6" />
              </g>
              <circle cx="36" cy="25" r="4.5" fill={mark.ink} />
            </svg>
          </div>
          <div className="sketch-cards">
            <span>
              <svg viewBox="0 0 48 20">
                <circle cx="18" cy="9" r="5" fill={mark.tileBottom} />
                <circle cx="27" cy="7" r="5" fill={mark.ground} />
                <circle cx="31" cy="13" r="4" fill={mark.tileBottom} />
                <path d="M22 20l3-7 3 7" fill={mark.ink} />
              </svg>
              Bouquets
            </span>
            <span>
              <svg viewBox="0 0 48 20">
                <path d="M24 13c-5-1-8-5-8-10 5 1 8 5 8 10zM24 13c5-1 8-5 8-10-5 1-8 5-8 10z" fill={mark.ground} />
                <path d="M18 13h12l-2 7h-8z" fill={mark.ink} />
              </svg>
              Plants
            </span>
            <span>
              <svg viewBox="0 0 48 20">
                <rect x="16" y="7" width="16" height="13" rx="1.5" fill={mark.tileBottom} />
                <path d="M24 7v13M16 12h16" stroke={mark.ink} strokeWidth="2" />
                <path d="M24 7c-3-5-8-3-6 0zM24 7c3-5 8-3 6 0z" fill={mark.ink} />
              </svg>
              Gifts
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The card of the listed project in `dir`, wherever it is shown. */
function cardOf(dir: string) {
  return [...document.querySelectorAll<HTMLElement>('.recent-card')].find((b) => b.title.endsWith(`\n${dir}`));
}

/** A path that wraps only after a separator, never inside a folder name such as "old-brochure-site". */
function pathBreaks(path: string) {
  return path.split(/(?<=[\\/])/).map((seg, i) => (
    <span key={i} className="seg">
      {seg}
      <wbr />
    </span>
  ));
}

const countOf = (n: number) => (n === 1 ? '1 project' : `${n} projects`);

function initials(name: string) {
  // Words only, so "Tide & Timber" is TT rather than T&.
  return name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join('');
}
