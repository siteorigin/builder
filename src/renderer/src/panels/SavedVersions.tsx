import './SavedVersions.css';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, ArrowLeft, Bookmark, BookmarkPlus, Check, CircleAlert, Pencil, Trash2 } from 'lucide-react';
import type { RestoreVersionResult, SavedVersionInfo, VersionReview } from '@shared/api';
import { api, confirmDialog, getState, setState, toast, undoAction, useStore } from '../store';
import { Spinner } from '../components/ui';
import { BlockedNote, BlockedStatus, projectBlock, type Blocked } from '../components/BlockedNote';
import { settleEdits } from '../lib/leave';
import { formatBytes, plural } from '../lib/storage';
import { describeReview, fileName, restoredNotice, savedAt } from '../lib/versions';
import { fullWhen, lowerDay } from '../lib/when';

/** The longest version name the project accepts (src/main/project/versions.ts). */
const NAME_MAX = 80;


/** Whatever is still being typed lands first, so a version holds, and a review compares with, what is on screen. */
async function settled(): Promise<string | null> {
  const { problems, finish } = await settleEdits();
  finish();
  return problems[0] ?? null;
}

/**
 * Why a History tab can't change the project right now, said as a state rather than an error, in what it holds up on
 * that tab: the AI is at work (Changes can't step; versions can't be saved or restored, though they can be reviewed,
 * renamed and deleted), or the project is open read-only. Null when nothing is held.
 */
export function historyLock(snap: { readOnly?: { reason: string } | null; aiBusy?: boolean } | null | undefined, tab: 'changes' | 'versions', runStatus?: string | null): Blocked | null {
  return projectBlock(snap, tab === 'changes' ? 'undo and redo' : 'save or restore a version', runStatus);
}

/** A pinned note: a neutral state (role status) or a failure (role alert, in the danger face). */
export function HistoryNote({ id, tone, icon, children }: { id?: string; tone: 'info' | 'danger'; icon: ReactNode; children: ReactNode }) {
  return (
    <div id={id} className={`scope-note ${tone} history-note`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

/**
 * History's saved versions (issue 260): save the site under a name, see when each was saved and rename it, review
 * what restoring one would change, restore it, and delete the ones no longer needed. A panel of the History dialog:
 * its footer actions are put in the dialog's footer (`foot`) while it is the tab shown.
 */
export function SavedVersionsPanel({ active, foot, onBusy }: { active: boolean; foot: HTMLElement | null; onBusy: (busy: boolean) => void }) {
  const snap = useStore((s) => s.snapshot);
  const runStatus = useStore((s) => s.runStatus);
  const info = snap?.versions;
  const list = info?.list ?? [];
  const [name, setName] = useState('');
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => (setBusyState(b), onBusy(b));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ version: SavedVersionInfo; review: VersionReview | null } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renamingNow = useRef(renaming);
  renamingNow.current = renaming;
  // Enter or Escape has settled the rename: the blur that follows (the field is disabled, or goes) does nothing more.
  const renameSettled = useRef(false);
  // A name being saved: only its field waits, so a click on that row's Restore… or the next row still lands.
  const [savingName, setSavingName] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // The review asked for last: an answer to an earlier one (the author went back, and opened another) is dropped.
  const asked = useRef(0);
  const [reviewSaid, setReviewSaid] = useState('');
  const lock = historyLock(snap, 'versions', runStatus);
  const readOnly = snap?.readOnly?.reason ?? null;
  // Saving and restoring wait for the AI; renaming and deleting a version change only the versions, as deleting always has.
  const blocked = lock?.text ?? info?.problem ?? null;
  const listBlocked = readOnly ?? info?.problem ?? null;
  const close = () => setState({ modal: null });
  const nameField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // Where the list was scrolled when a review replaced it, so coming back finds the same place.
  const listTop = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A review replaces the list, and the button that opened it: its heading takes focus, so it is read out.
  const reviewing = open?.version.id;
  useEffect(() => {
    if (reviewing) heading.current?.focus();
  }, [reviewing]);
  // Opened on this tab from a menu, the menu holds on to focus until it has gone: the name field takes it then.
  const openedHere = useRef(active).current;
  useEffect(() => {
    if (!openedHere) return;
    const t = setTimeout(() => {
      const field = nameField.current;
      if (field && !field.disabled && !field.closest('.modal')?.contains(document.activeElement)) field.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [openedHere]);

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
    // The field was disabled while saving, which drops focus: it goes back, to correct the name or type the next one.
    requestAnimationFrame(() => (!document.activeElement || document.activeElement === document.body) && nameField.current?.focus());
    if (!r.ok) return setError(r.message ?? 'The version could not be saved.');
    setName('');
    const missing = 'missing' in r && r.missing?.length ? r.missing : [];
    if (missing.length) toast(`Saved “${clean}”. ${plural(missing.length, 'file was', 'files were')} missing from the project folder, so ${missing.length === 1 ? 'it isn’t' : 'they aren’t'} part of it: ${missing.map(fileName).join(', ')}.`, 'info');
    else toast(`Saved “${clean}”.`, 'success');
  };

  /** Work out what restoring `version` changes. `quiet`: the review shown is brought up to date in place, and said
   *  aloud only if what it says has changed. */
  const review = async (version: SavedVersionInfo, note: string | null = null, quiet = false) => {
    const key = getState().snapshot?.workspaceKey;
    if (!key) return;
    const ask = ++asked.current;
    const shown = open?.review;
    if (!quiet) {
      setRenaming(null);
      if (!open) listTop.current = scrollRef.current?.scrollTop ?? 0;
      setOpen({ version, review: null });
      setReviewSaid('Checking what restoring it changes.');
      setError(note);
    }
    // A change that could not be saved would leave the review comparing with something other than the screen.
    const problem = await settled();
    if (getState().snapshot?.workspaceKey !== key || ask !== asked.current) return;
    if (problem) {
      if (!quiet) back(version.id);
      return setError(problem);
    }
    const r = await api.project.reviewVersion(version.id, key).catch((err: Error) => ({ ok: false, message: err.message, review: undefined }));
    if (getState().snapshot?.workspaceKey !== key || ask !== asked.current) return;
    if (!r.ok || !r.review) {
      if (!quiet) back(version.id);
      return setError(r.message ?? 'That saved version could not be read.');
    }
    const got = r.review;
    const says = (v: VersionReview) => JSON.stringify([v.problem, v.unchanged, describeReview(v), v.missing, v.replaced.length]);
    if (!quiet) setReviewSaid('Review ready.');
    else if (shown && says(shown) !== says(got)) setReviewSaid('The site changed: review updated.');
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
    const done = r as RestoreVersionResult;
    // A restore done whose own saved version is not (or not yet) saved says so, with its Undo all the same.
    const said = [restoredNotice(version.name, !!done.backup, done.replaced ?? 0, done.left ?? []), ...(done.notice ? [done.notice] : [])].join(' ');
    toast(said, done.notice ? 'info' : 'success', done.entryId ? undoAction({ entryId: done.entryId, revision: done.revision ?? 0, workspaceKey: key }) : undefined);
  };

  /** Focus a row's control again once the list has settled (after a rename, or a cancelled one). */
  const focusRow = (id: string, which: 'rename' | 'restore') =>
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`li[data-version="${CSS.escape(id)}"] [data-row-action="${which}"]`)?.focus());

  /** Back from a review to the list, scrolled where it was, with focus on the Restore… that opened it. */
  const back = (id: string) => {
    asked.current++;
    setReviewSaid('');
    setOpen(null);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = listTop.current;
      focusRow(id, 'restore');
    });
  };

  /** Save a new name. `refocus`: Enter or the Save name button, so focus goes back to the row; a blur leaves it where it went. */
  const rename = async (version: SavedVersionInfo, next: string, refocus: boolean) => {
    const key = getState().snapshot?.workspaceKey;
    const clean = next.replace(/\s+/g, ' ').trim();
    if (!key || busy || savingName) return;
    if (!clean || clean === version.name) return setRenaming(null), refocus && focusRow(version.id, 'rename');
    // Read-only since the field opened: the name stays as it was, and the note says why.
    if (getState().snapshot?.readOnly || getState().snapshot?.versions?.problem) return setRenaming((e) => (e?.id === version.id ? null : e));
    setSavingName(true);
    setError(null);
    const r = await api.project.renameVersion(version.id, clean, key).catch((err: Error) => ({ ok: false, message: err.message }));
    setSavingName(false);
    if (getState().snapshot?.workspaceKey !== key) return;
    // The author may have gone on to rename another row meanwhile: only this row's field is closed or focused.
    const still = renamingNow.current?.id === version.id;
    if (!r.ok) {
      // The name stays in its field to be corrected.
      if (still) {
        renameSettled.current = false;
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('.version-rename')?.focus());
      }
      return setError(r.message ?? 'The version could not be renamed.');
    }
    setRenaming((e) => (e?.id === version.id ? null : e));
    if (refocus && still) focusRow(version.id, 'rename');
    toast(`Renamed “${version.name}” to “${clean}”.`, 'success');
  };

  const remove = async (version: SavedVersionInfo) => {
    const key = getState().snapshot?.workspaceKey;
    if (!key || busy) return;
    // A version saved with Git snapshots on leaves its snapshot in the project's version history when deleted (#1153).
    const inHistory = version.bytes === null;
    const yes = await confirmDialog({
      title: 'Delete saved version?',
      body: inHistory ? 'This saved version is removed from Saved versions.' : 'This saved version is deleted from the project.',
      subject: version.name,
      subjectKind: 'version',
      subjectNote: inHistory ? 'Its snapshot stays in the project’s version history' : version.bytes ? `Frees up to ${formatBytes(version.bytes)}` : undefined,
      details: [
        { kind: 'keep', text: 'Your site and its undo history stay as they are.' },
        { kind: 'final', text: 'A deleted version can’t be brought back.' }
      ],
      confirmLabel: 'Delete version',
      tone: 'danger',
      icon: 'delete'
    });
    // Read-only since the question was asked: nothing is deleted, and History's note, back in view, says why.
    if (!yes || getState().snapshot?.workspaceKey !== key || getState().snapshot?.readOnly) return;
    setBusy(true);
    const r = await api.project.deleteVersion(version.id, key).catch((err: Error) => ({ ok: false, message: err.message, freed: undefined }));
    setBusy(false);
    if (getState().snapshot?.workspaceKey !== key) return;
    if (!r.ok) return setError(r.message ?? 'The version could not be deleted.');
    setOpen((o) => (o?.version.id === version.id ? null : o));
    toast(`Deleted “${version.name}”.${r.freed ? ` Freed up to ${formatBytes(r.freed)}.` : ''}`, 'info');
  };

  const r = open?.review;
  // The project moved on since the review was worked out (the AI, a guest, an edit elsewhere): it is worked out again,
  // so what it says, and whether Restore is offered, are for the site as it is.
  // While the AI works Restore waits anyway: the review is brought up to date once it has finished, not at every step.
  const revision = snap?.revision;
  const aiBusy = !!snap?.aiBusy;
  useEffect(() => {
    if (open?.review && revision !== undefined && revision > open.review.revision && !busy && !aiBusy) void review(open.version, null, true);
    // review() is recreated each render; the revisions say when to run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, open?.review?.revision, busy, aiBusy]);
  const canRestore = !!r && !r.problem && !r.unchanged && !blocked && !busy;
  // A failure is said as one; a state that only holds things up (the AI working, read-only) is said as that.
  // Each keeps its own note: an earlier failure never takes the place of the reason the form is held now.
  const failure = error ?? info?.problem ?? null;
  const note = (
    <>
      {active && <BlockedStatus block={lock} lifted="You can save or restore a version now." />}
      {lock && (
        <BlockedNote block={lock} live={false} />
      )}
      {failure && (
        <HistoryNote tone="danger" icon={<CircleAlert aria-hidden="true" />}>
          {failure}
        </HistoryNote>
      )}
    </>
  );

  const footer = open ? (
    <>
      <button className="btn" onClick={() => (setError(null), back(open.version.id))} disabled={busy}>
        <ArrowLeft /> All saved versions
      </button>
      <span className="spacer" />
      <button className="btn btn-primary" data-testid="restore-version" onClick={() => void restore()} disabled={!canRestore}>
        {busy ? <Spinner decorative /> : <ArchiveRestore />} Restore this version
      </button>
    </>
  ) : (
    <>
      {list.length > 0 ? (
        <span
          className="history-foot-note"
          title={`Saved versions share the images and fonts they have in common, so each is stored once.${info?.historyBytes ? ' Snapshots stay in the project’s version history when a version is deleted.' : ''}`}
        >
          {plural(list.length, 'saved version uses', 'saved versions use')} {formatBytes(info?.bytes ?? 0)}
        </span>
      ) : (
        !!info?.historyBytes && (
          <span className="history-foot-note" title="Snapshots stay in the project’s version history when a version is deleted.">
            Version history uses {formatBytes(info.historyBytes)}
          </span>
        )
      )}
      <span className="spacer" />
      <button className="btn" onClick={close} disabled={busy}>
        Close
      </button>
    </>
  );

  return (
    <>
      {active && foot && createPortal(footer, foot)}
      {/* Says a review is being worked out, then that it is ready: always here, so the change is announced. */}
      <span className="sr-only" role="status">
        {active ? reviewSaid : ''}
      </span>
      {open ? (
        <div className="history-scroll version-review" data-testid="version-review">
          <h3 ref={heading} tabIndex={-1}>
            {open.version.auto ? <ArchiveRestore aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
            <span>{open.version.name}</span>
          </h3>
          <p className="muted version-review-when" title={fullWhen(open.version.time)}>
            {open.version.restored ? 'Saved automatically after a restore, ' : open.version.auto ? 'Saved automatically before a restore, ' : 'Saved '}
            {lowerDay(savedAt(open.version.time))}
          </p>
          {note}
          {!r ? (
            <p className="version-loading">
              <Spinner decorative /> Checking what restoring it changes…
            </p>
          ) : r.problem ? (
            <HistoryNote tone="danger" icon={<CircleAlert aria-hidden="true" />}>
              {r.problem}
            </HistoryNote>
          ) : r.unchanged ? (
            <p>Your site already matches this version.</p>
          ) : (
            <>
              <p className="version-review-lead">Restoring it:</p>
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
        </div>
      ) : (
        <>
          <div className={`history-pinned${scrolled ? ' scrolled' : ''}`}>
            {note}
            <p className="history-intro">Save the site as it is now under a name, to come back to after a redesign or a review. A saved version is kept until you delete it.</p>
            <form className="version-save" onSubmit={(e) => void save(e)}>
              <input ref={nameField} className="input" aria-label="Version name" data-autofocus={blocked || !openedHere ? undefined : true} placeholder="Name, such as “Approved by client”" maxLength={NAME_MAX} value={name} disabled={!!blocked || busy} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary" type="submit" disabled={!!blocked || busy || !name.trim()}>
                {busy && !renaming ? <Spinner decorative /> : <BookmarkPlus />} Save version
              </button>
            </form>
          </div>
          <div className="history-scroll" ref={scrollRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
            {list.length === 0 ? (
              // When the list could not be read, its note says so: an empty list here would read as "none saved".
              !info?.problem && <div className="empty-insp history-empty">
                <Bookmark />
                <span>No saved versions yet.</span>
              </div>
            ) : (
              <ol ref={listRef} className="history-list versions-list" aria-label="Saved versions">
                {list.map((v) => {
                  const editing = renaming?.id === v.id;
                  return (
                    <li key={v.id} data-version={v.id} className={editing ? 'renaming' : undefined}>
                      {v.auto ? <ArchiveRestore aria-label={v.restored ? 'Saved automatically after a restore' : 'Saved automatically before a restore'} /> : <Bookmark aria-label="Saved by you" />}
                      <span className="grow version-text">
                        {editing ? (
                          <input
                            className="input version-rename"
                            aria-label={`New name for “${v.name}”`}
                            autoFocus
                            maxLength={NAME_MAX}
                            value={renaming.name}
                            readOnly={savingName}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                renameSettled.current = true;
                                void rename(v, renaming.name, true);
                              } else if (e.key === 'Escape') {
                                // Escape leaves the name as it was; the dialog stays open.
                                e.preventDefault();
                                e.stopPropagation();
                                renameSettled.current = true;
                                setRenaming(null);
                                setError(null);
                                focusRow(v.id, 'rename');
                              }
                            }}
                            onBlur={() => !renameSettled.current && ((renameSettled.current = true), void rename(v, renaming.name, false))}
                          />
                        ) : (
                          <span className="ellipsis version-name" title={v.name}>
                            {v.name}
                          </span>
                        )}
                        <small title={fullWhen(v.time)}>
                          {v.auto ? 'Saved automatically · ' : ''}
                          {savedAt(v.time)} · {plural(v.pages, 'page', 'pages')}
                          {v.missing.length ? ` · ${plural(v.missing.length, 'file', 'files')} missing` : ''}
                        </small>
                      </span>
                      {/* While restoring is held, what the button opens is a review: it says so. */}
                      <button className="btn btn-sm" data-row-action="restore" aria-label={`${blocked ? 'Review' : 'Restore'} “${v.name}”…`} onClick={() => void review(v)} disabled={busy}>
                        {blocked ? 'Review…' : 'Restore…'}
                      </button>
                      <span className="version-tools">
                        {editing ? (
                          <button
                            className="icon-btn version-rename-save"
                            aria-label="Save name"
                            title="Save name (Enter)"
                            // Pressed, not clicked: the field keeps focus, so its blur doesn't save first.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => ((renameSettled.current = true), void rename(v, renaming.name, true))}
                            disabled={busy || savingName}
                          >
                            <Check />
                          </button>
                        ) : (
                          <button
                            className="icon-btn"
                            data-row-action="rename"
                            aria-label={`Rename “${v.name}”`}
                            title={listBlocked ? `Can’t rename: ${listBlocked}` : 'Rename'}
                            aria-disabled={!!listBlocked || undefined}
                            onClick={() => !listBlocked && !busy && ((renameSettled.current = false), setError(null), setRenaming({ id: v.id, name: v.name }))}
                            disabled={busy}
                          >
                            <Pencil />
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          aria-label={`Delete “${v.name}”`}
                          title={listBlocked ? `Can’t delete: ${listBlocked}` : 'Delete'}
                          aria-disabled={!!listBlocked || undefined}
                          onClick={() => !listBlocked && void remove(v)}
                          disabled={busy}
                        >
                          <Trash2 />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </>
      )}
    </>
  );
}
