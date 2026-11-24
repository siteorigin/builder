import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArchiveRestore, ArrowLeft, Bookmark, BookmarkPlus, History, Trash2 } from 'lucide-react';
import type { SavedVersionInfo, VersionReview } from '@shared/api';
import { api, confirmDialog, getState, setState, toast, undoAction, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';
import { settleEdits } from '../lib/leave';
import { formatBytes, plural } from '../lib/storage';
import { describeReview, fileName, restoredNotice, savedAt } from '../lib/versions';

/** The longest version name the project accepts (src/main/project/versions.ts). */
const NAME_MAX = 80;

/** Switches History between its two views: recent changes, and versions saved for good. */
export function HistoryTabs({ tab, busy }: { tab: 'changes' | 'versions'; busy?: boolean }) {
  // While a save, restore or delete is under way the view stays, so its answer is shown where it was asked.
  return (
    <div className="segmented history-tabs" role="group" aria-label="Show">
      <button aria-pressed={tab === 'changes'} disabled={busy} onClick={() => setState({ modal: { kind: 'history' } })}>
        <History aria-hidden="true" /> Changes
      </button>
      <button aria-pressed={tab === 'versions'} disabled={busy} onClick={() => setState({ modal: { kind: 'history', tab: 'versions' } })}>
        <Bookmark aria-hidden="true" /> Saved versions
      </button>
    </div>
  );
}

/** Whatever is still being typed lands first, so a version holds, and a review compares with, what is on screen. */
async function settled(): Promise<string | null> {
  const { problems, finish } = await settleEdits();
  finish();
  return problems[0] ?? null;
}

/**
 * History's saved versions (issue 260): save the site under a name, see when each was saved and what it takes, review
 * what restoring one would change, restore it, and delete the ones no longer needed.
 */
export function SavedVersionsModal() {
  const snap = useStore((s) => s.snapshot);
  const info = snap?.versions;
  const list = info?.list ?? [];
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ version: SavedVersionInfo; review: VersionReview | null } | null>(null);
  const readOnly = snap?.readOnly?.reason ?? null;
  const blocked = readOnly ?? (snap?.aiBusy ? 'Wait for the AI to finish to save or restore a version.' : (info?.problem ?? null));
  const close = () => setState({ modal: null });
  const nameField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // A review replaces the list, and the button that opened it: its heading takes focus, so it is read out.
  const reviewing = open?.version.id;
  useEffect(() => {
    if (reviewing) heading.current?.focus();
  }, [reviewing]);
  // Opened from a menu, the menu holds on to focus until it has gone: the name field takes it then.
  useEffect(() => {
    const t = setTimeout(() => {
      const field = nameField.current;
      if (field && !field.disabled && !field.closest('.modal')?.contains(document.activeElement)) field.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const key = getState().snapshot?.workspaceKey;
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!key || busy || !clean || blocked) return;
    setBusy(true);
    setError(null);
    const problem = await settled();
    if (getState().snapshot?.workspaceKey !== key) return setBusy(false);
    const r = problem ? { ok: false, message: problem } : await api.project.saveVersion(clean, key).catch((err: Error) => ({ ok: false, message: err.message, missing: undefined }));
    setBusy(false);
    if (getState().snapshot?.workspaceKey !== key) return;
    if (!r.ok) return setError(r.message ?? 'The version could not be saved.');
    setName('');
    const missing = 'missing' in r && r.missing?.length ? r.missing : [];
    if (missing.length) toast(`Saved “${clean}”. ${plural(missing.length, 'file was', 'files were')} missing from the project folder, so ${missing.length === 1 ? 'it isn’t' : 'they aren’t'} part of it: ${missing.map(fileName).join(', ')}.`, 'info');
    else toast(`Saved “${clean}”.`, 'success');
  };

  const review = async (version: SavedVersionInfo, note: string | null = null) => {
    const key = getState().snapshot?.workspaceKey;
    if (!key) return;
    setOpen({ version, review: null });
    setError(note);
    // A change that could not be saved would leave the review comparing with something other than the screen.
    const problem = await settled();
    if (getState().snapshot?.workspaceKey !== key) return;
    if (problem) {
      setOpen(null);
      return setError(problem);
    }
    const r = await api.project.reviewVersion(version.id, key).catch((err: Error) => ({ ok: false, message: err.message, review: undefined }));
    if (getState().snapshot?.workspaceKey !== key) return;
    if (!r.ok || !r.review) {
      setOpen(null);
      return setError(r.message ?? 'That saved version could not be read.');
    }
    const got = r.review;
    setOpen((o) => (o?.version.id === version.id ? { version, review: got } : o));
  };

  const restore = async () => {
    const key = getState().snapshot?.workspaceKey;
    if (!key || !open?.review || busy || blocked) return;
    const { version, review: seen } = open;
    setBusy(true);
    setError(null);
    const problem = await settled();
    if (getState().snapshot?.workspaceKey !== key) return setBusy(false);
    const r = problem ? { ok: false, message: problem } : await api.project.restoreVersion(version.id, seen.revision, { files: seen.files, replaced: seen.replaced }, key).catch((err: Error) => ({ ok: false, message: err.message }));
    setBusy(false);
    if (getState().snapshot?.workspaceKey !== key) return;
    // The project changed since the review (a field still being typed in landed, say): show what restoring does now.
    if ('stale' in r && r.stale) return void review(version, r.message ?? null);
    if (!r.ok) return setError(r.message ?? 'The version could not be restored.');
    // Only this view closes: the author may have moved on to another dialog meanwhile.
    const m = getState().modal;
    if (m?.kind === 'history' && m.tab === 'versions') close();
    if ('unchanged' in r && r.unchanged) return toast(`Your site already matches “${version.name}”.`, 'info');
    const done = r as { entryId?: string; revision?: number; backup?: { name: string }; replaced?: number; left?: string[] };
    toast(restoredNotice(version.name, !!done.backup, done.replaced ?? 0, done.left ?? []), 'success', done.entryId ? undoAction({ entryId: done.entryId, revision: done.revision ?? 0, workspaceKey: key }) : undefined);
  };

  const remove = async (version: SavedVersionInfo) => {
    const key = getState().snapshot?.workspaceKey;
    if (!key || busy) return;
    const yes = await confirmDialog({
      title: 'Delete saved version?',
      body: `“${version.name}” will be deleted for good${version.bytes ? `, freeing up to ${formatBytes(version.bytes)}` : ''}. Your site and its undo history stay as they are.`,
      confirmLabel: 'Delete version',
      danger: true
    });
    if (!yes || getState().snapshot?.workspaceKey !== key) return;
    setBusy(true);
    const r = await api.project.deleteVersion(version.id, key).catch((err: Error) => ({ ok: false, message: err.message, freed: undefined }));
    setBusy(false);
    if (getState().snapshot?.workspaceKey !== key) return;
    if (!r.ok) return setError(r.message ?? 'The version could not be deleted.');
    setOpen((o) => (o?.version.id === version.id ? null : o));
    toast(`Deleted “${version.name}”.${r.freed ? ` Freed up to ${formatBytes(r.freed)}.` : ''}`, 'info');
  };

  const r = open?.review;
  const canRestore = !!r && !r.problem && !r.unchanged && !blocked && !busy;
  return (
    <Modal
      title="History"
      icon={<History />}
      onClose={close}
      busy={busy}
      footer={
        open ? (
          <>
            <button className="btn" onClick={() => (setOpen(null), setError(null))} disabled={busy}>
              <ArrowLeft /> All saved versions
            </button>
            <span className="spacer" />
            <button className="btn btn-primary" data-testid="restore-version" onClick={() => void restore()} disabled={!canRestore}>
              {busy ? <Spinner decorative /> : <ArchiveRestore />} Restore this version
            </button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button className="btn" onClick={close} disabled={busy}>
              Close
            </button>
          </>
        )
      }
    >
      <HistoryTabs tab="versions" busy={busy} />
      {open ? (
        <div className="version-review" data-testid="version-review">
          <h3 className="ellipsis" ref={heading} tabIndex={-1}>
            {open.version.name}
          </h3>
          <p className="muted">
            Saved {savedAt(open.version.time)}
            {open.version.auto ? ' by SiteOrigin Builder, just before a restore' : ''}
          </p>
          {!r ? (
            <p className="version-loading">
              <Spinner decorative /> Checking what restoring it changes…
            </p>
          ) : r.problem ? (
            <div className="scope-note danger" role="alert">
              {r.problem}
            </div>
          ) : r.unchanged ? (
            <p>Your site already matches this version.</p>
          ) : (
            <>
              <p>Restoring it:</p>
              <ul className="storage-steps">
                {describeReview(r).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {r.missing.length > 0 && (
                <p className="muted">
                  {plural(r.missing.length, 'file was', 'files were')} missing when it was saved, so restoring can’t bring {r.missing.length === 1 ? 'it' : 'them'} back: {r.missing.map(fileName).join(', ')}.
                </p>
              )}
              {r.replaced.length > 0 ? (
                <p className="muted">
                  Your current work is saved first as a version of its own. Undo takes back the pages and settings in one step, but not the {plural(r.replaced.length, 'file', 'files')} it replaces: restore that saved work to get {r.replaced.length === 1 ? 'it' : 'them'} back.
                </p>
              ) : (
                <p className="muted">Your current work is saved first as a version of its own, and Undo takes the restore back in one step.</p>
              )}
            </>
          )}
          {(error || (r && blocked)) && (
            <div className="scope-note danger" role="alert">
              {error ?? blocked}
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Save a version before a redesign or a review. It keeps every page, style and component, with the images and fonts they use, until you delete it. Changes only reach back 100 steps.
          </p>
          <form className="version-save" onSubmit={(e) => void save(e)}>
            <input ref={nameField} className="input" aria-label="Version name" data-autofocus={blocked ? undefined : true} placeholder="Name, such as “Approved by client”" maxLength={NAME_MAX} value={name} disabled={!!blocked || busy} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={!!blocked || busy || !name.trim()}>
              {busy ? <Spinner decorative /> : <BookmarkPlus />} Save version
            </button>
          </form>
          {(error || blocked) && (
            <div className="scope-note danger" role="alert">
              {error ?? blocked}
            </div>
          )}
          {list.length === 0 ? (
            <div className="empty-insp" style={{ padding: '24px 12px' }}>
              <Bookmark />
              <span>No saved versions yet.</span>
            </div>
          ) : (
            <>
              <ol className="history-list versions-list" aria-label="Saved versions">
                {list.map((v) => (
                  <li key={v.id}>
                    {v.auto ? <ArchiveRestore aria-label="Saved before a restore" /> : <Bookmark aria-label="Saved by you" />}
                    <span className="grow version-text">
                      <span className="ellipsis">{v.name}</span>
                      <small>
                        {savedAt(v.time)} · {plural(v.pages, 'page', 'pages')} · {formatBytes(v.bytes)}
                        {v.missing.length ? ` · ${plural(v.missing.length, 'file', 'files')} missing` : ''}
                      </small>
                    </span>
                    <button className="btn btn-sm" onClick={() => void review(v)} disabled={busy}>
                      Review…
                    </button>
                    <button className="icon-btn" aria-label={`Delete “${v.name}”`} title="Delete" onClick={() => void remove(v)} disabled={busy || !!readOnly || !!info?.problem}>
                      <Trash2 />
                    </button>
                  </li>
                ))}
              </ol>
              <p className="muted version-total">
                {plural(list.length, 'saved version takes', 'saved versions take')} up to {formatBytes(info?.bytes ?? 0)}. The size beside each is the most deleting it frees: what it shares with another saved version stays.
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
