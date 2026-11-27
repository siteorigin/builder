import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Ban, CircleMinus, HardDrive, Info, ShieldCheck, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import type { ReclaimPlan, StorageInfo } from '@shared/api';
import { api, getState, toast, useStore } from '../store';
import { DisclosureMark, Modal, Spinner } from '../components/ui';
import { describeTrim, formatBytes, plural, type TrimmedSide } from '../lib/storage';
import '../components/ConfirmDialog.css';

/**
 * What the open project's media and undo history take on disk, while the Assets panel is showing. It is read again
 * after every change, undo and history trim, and dropped when another project (or opening) takes over.
 */
export function useProjectStorage(): { info: StorageInfo | null; refresh: () => void } {
  const visible = useStore((s) => s.leftTab === 'assets');
  const opening = useStore((s) => s.snapshot?.workspaceKey ?? '');
  const revision = useStore((s) => s.snapshot?.revision ?? 0);
  // Undo, redo and a trim move history without always changing the documents.
  const history = useStore((s) => {
    const e = s.snapshot?.history.entries ?? [];
    return `${e.length}:${e[0]?.id ?? ''}:${e.at(-1)?.id ?? ''}:${e.filter((x) => x.applied).length}`;
  });
  // Saving or deleting a version changes what versions take without touching the documents.
  const versions = useStore((s) => `${s.snapshot?.versions?.list.length ?? 0}:${s.snapshot?.versions?.bytes ?? 0}`);
  // What else can change the figures or whether space can be freed: the AI, conflicts, the lock, files found missing.
  const busy = useStore((s) => `${!!s.snapshot?.aiBusy}:${s.snapshot?.conflicts.length ?? 0}:${!!s.snapshot?.readOnly}:${JSON.stringify(s.snapshot?.missingAssets ?? [])}`);
  const [got, setGot] = useState<{ opening: string; info: StorageInfo } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!opening || !visible) return;
    let live = true;
    // Typing commits many changes in a row: the folder is read once they settle.
    const t = setTimeout(() => {
      api.project.storage(opening).then(
        (info) => live && setGot(info ? { opening, info } : null),
        () => undefined
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [opening, visible, revision, history, versions, busy, tick]);
  return { info: got?.opening === opening ? got.info : null, refresh: () => setTick((n) => n + 1) };
}

const files = (n: number) => plural(n, 'file', 'files');
/** A figure the plan takes only part of reads "69 of 120 files". */
const partOf = (part: number, whole: number, say: (n: number) => string) => (part !== whole ? `${part} of ${say(whole)}` : say(whole));

/** A short window: the footer starts folded to its one-line summary there. */
const SHORT = '(max-height: 640px)';
const onShortChange = (fn: () => void) => {
  const q = window.matchMedia(SHORT);
  q.addEventListener('change', fn);
  return () => q.removeEventListener('change', fn);
};
const useShortWindow = () => useSyncExternalStore(onShortChange, () => window.matchMedia(SHORT).matches);

/** Where focus goes when the button that opened Free up space is gone: the footer's toggle, or Add when the footer went too. */
const focusStorageFooter = () => (document.querySelector<HTMLElement>('[data-testid="asset-storage"] .asset-storage-toggle') ?? document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) .asset-add'))?.focus();

/**
 * The footer of the Assets panel, under every tab: its heading is the total, and a disclosure for the breakdown: what
 * the files in Assets take (each image with its smaller copies), what removed files kept for Undo take, and saved
 * versions. Every figure says what it is in its own words. In a short window it starts folded to the one line.
 */
export function StorageSummary({ info, onFree }: { info: StorageInfo; onFree: () => void }) {
  const short = useShortWindow();
  const [open, setOpen] = useState<boolean | null>(null);
  if (!info.media.files && !info.kept.files && !info.versions.count && !info.versions.historyBytes) return null;
  const shown = open ?? !short;
  const total = info.media.bytes + info.kept.bytes + info.versions.bytes;
  return (
    <section className="asset-storage" aria-labelledby="asset-storage-title" data-testid="asset-storage">
      <div className="asset-storage-head">
        <h4 id="asset-storage-title">
          <button type="button" className="asset-storage-toggle" aria-expanded={shown} aria-controls="asset-storage-details" onClick={() => setOpen(!shown)}>
            <DisclosureMark />
            Storage <span className="asset-storage-total">{formatBytes(total)}</span>
          </button>
        </h4>
        {info.reclaim && (
          <button className="btn btn-sm" onClick={onFree}>
            Free {formatBytes(info.reclaim.files.bytes + info.reclaim.historyBytes)}…
          </button>
        )}
      </div>
      <div id="asset-storage-details" className="asset-storage-details" hidden={!shown}>
        <dl>
          <div>
            <dt>In Assets</dt>
            <dd>
              {files(info.media.files)} · {formatBytes(info.media.bytes)}
            </dd>
          </div>
          {info.kept.files > 0 && (
            <div>
              <dt>Kept for Undo</dt>
              <dd>
                {files(info.kept.files)} · {formatBytes(info.kept.bytes)}
              </dd>
            </div>
          )}
          {(info.versions.count > 0 || !!info.versions.historyBytes) && (
            <div>
              <dt>Saved versions</dt>
              <dd>
                {info.versions.count > 0 ? plural(info.versions.count, 'version', 'versions') : 'Version history'} · {formatBytes(info.versions.bytes)}
              </dd>
            </div>
          )}
        </dl>
        <p className="asset-storage-note">File counts include smaller copies.</p>
      </div>
    </section>
  );
}

/**
 * The steps that go, as one list: the first few, then the rest (`rest`, the ones the summary counts as "and 4 earlier
 * steps") added to the same list on request. `last`: none are left after them, which closes this same loss line.
 */
function Trimmed({ side, rest, last }: { side: TrimmedSide; rest: string[]; last?: boolean }) {
  const [all, setAll] = useState(false);
  const steps = all ? [...side.steps, ...rest] : side.steps;
  return (
    <>
      <span>{side.lead}</span>
      <ul className="storage-steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {side.more && !rest.length && <li className="more">{side.more}</li>}
      </ul>
      {side.more && rest.length > 0 && (
        <button type="button" className="storage-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          <DisclosureMark />
          {/* "and 4 earlier steps" → "Show all 4 earlier steps"; "and 1 earlier step" → "Show the earlier step". */}
          {all ? 'Show fewer steps' : `Show ${side.more.replace(/^and 1 /, 'the ').replace(/^and /, 'all ')}`}
        </button>
      )}
      {last && <span>{side.after}</span>}
    </>
  );
}

/**
 * What freeing does, first: what it frees and deletes, then the steps that go. Freeing cuts history at the last step
 * that names a deleted file, so every step past that point goes too, whatever it did: they are named as a stretch of
 * history (the oldest Undo steps, the furthest Redo steps, or all of them), not as steps that needed the files.
 */
function consequence(plan: ReclaimPlan, total: number): string {
  const undo = plan.undo.length;
  const redo = plan.redo.length;
  const lost = [
    !undo ? '' : plan.keptUndo ? (undo === 1 ? 'your oldest Undo step' : `your ${undo} oldest Undo steps`) : undo === 1 ? 'your only Undo step' : `all ${undo} Undo steps`,
    !redo ? '' : plan.keptRedo ? (redo === 1 ? 'the furthest Redo step' : `the ${redo} furthest Redo steps`) : redo === 1 ? 'your only Redo step' : `all ${redo} Redo steps`
  ].filter(Boolean);
  const what = plan.files.files ? `permanently deletes ${files(plan.files.files)} already removed from Assets` : 'permanently trims Undo history';
  return `Freeing ${formatBytes(total)} ${what}.${lost.length ? ` You’ll also lose ${lost.join(' and ')}.` : ''}`;
}

/**
 * Shows exactly what freeing up space deletes and which Undo and Redo steps go with it, before anything happens, in
 * the same words and marks as the app's other confirmations (ConfirmDialog): what is lost and what stays safe, and
 * that it can't be taken back in the footer beside the buttons, where scrolling never takes it out of view. Free
 * carries out the plan on screen and no other: when the project changes the plan, the new one is shown only once the
 * author asks for it, and Free waits until then.
 */
export function FreeSpaceDialog({ info, onClose, refresh }: { info: StorageInfo; onClose: () => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  // A refusal from the main process (nothing was deleted), or a request whose outcome never came back.
  const [error, setError] = useState<{ text: string; refused: boolean } | null>(null);
  const [shown, setShown] = useState(info);
  const [said, setSaid] = useState('');
  // After a request whose outcome never came back, Free waits for figures read since, so it is never pressed blind.
  const [checking, setChecking] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  const notes = useRef<HTMLDivElement>(null);
  const changed = (info.reclaim?.key ?? null) !== (shown.reclaim?.key ?? null);
  // New figures for the same plan (the history's size, say) are shown as they come.
  useEffect(() => {
    if (!changed) setShown(info);
  }, [info, changed]);
  // Announced once, from a region that is always there, so it is heard when the notice appears.
  useEffect(() => {
    if (changed) setSaid('The project changed. Review the new figures before freeing space.');
  }, [changed]);
  useEffect(() => setChecking(false), [info]);
  const plan = shown.reclaim;
  const trim = plan ? describeTrim(plan) : null;
  const total = plan ? plan.files.bytes + plan.historyBytes : 0;
  // Focus goes back to the button that opened this, unless it has gone (nothing left to free) or is about to (after
  // freeing): then to the footer's own toggle, beside where it was, rather than the top of the panel.
  const close = (freed = false, footerGoes = false) => {
    onClose();
    requestAnimationFrame(() => {
      if (footerGoes) document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) .asset-add')?.focus();
      else if (freed || !document.querySelector('[data-testid="asset-storage"] .asset-storage-head .btn')) focusStorageFooter();
    });
  };
  // What stops freeing now comes first; a refusal from the last attempt says nothing was deleted.
  const blocked = info.blocked ?? (error ? (error.refused ? `Nothing was deleted. ${error.text}` : error.text) : null);
  // A notice that appears while the body is scrolled down to the steps is brought into view; focus stays where it is.
  useEffect(() => {
    if (changed || blocked) notes.current?.scrollIntoView({ block: 'nearest' });
  }, [changed, blocked]);
  const free = async () => {
    const opening = getState().snapshot?.workspaceKey;
    if (!plan || !opening || busy || changed) return;
    setBusy(true);
    setError(null);
    const r = await api.project.reclaimStorage(plan.key, opening).catch(() => null);
    setBusy(false);
    // A reply for a project that has since closed says nothing about the one open now.
    if (getState().snapshot?.workspaceKey !== opening) return;
    if (r?.ok) {
      toast([`Freed ${formatBytes(r.freed ?? 0)}.`, r.message ?? ''].filter(Boolean).join(' '), 'info');
      refresh();
      // When freeing empties the footer too (nothing else in Assets or saved), focus goes straight to Add.
      close(true, !shown.media.files && !shown.versions.count && plan.files.files === shown.kept.files);
    } else {
      setError(r ? { text: r.message ?? 'The space could not be freed.', refused: true } : { text: 'Whether the space was freed couldn’t be confirmed. Check the new figures before trying again.', refused: false });
      if (!r) setChecking(true);
      refresh();
      // Free was focused and went disabled while it worked: focus goes back to the safe choice.
      requestAnimationFrame(() => safe.current?.focus());
    }
  };
  // The button that showed the new figures goes with the notice, so focus moves to the safe choice.
  const showNew = () => {
    setShown(info);
    setError(null);
    setSaid(info.reclaim ? `The new figures are shown. Freeing now frees ${formatBytes(info.reclaim.files.bytes + info.reclaim.historyBytes)}.` : 'The new figures are shown. There are no removed files to delete now.');
    requestAnimationFrame(() => safe.current?.focus());
  };
  const keptFiles = plan ? partOf(plan.files.files, shown.kept.files, files) : '';
  const keptBytes = plan ? (plan.files.bytes !== shown.kept.bytes ? `${formatBytes(plan.files.bytes)} of ${formatBytes(shown.kept.bytes)}` : formatBytes(shown.kept.bytes)) : '';
  const steps = plan ? plan.undo.length + plan.redo.length : 0;
  return (
    <Modal
      title="Free up space"
      icon={
        plan ? (
          <span className="confirm-icon" data-tone="danger" aria-hidden="true">
            <Trash2 />
          </span>
        ) : (
          <HardDrive aria-hidden="true" />
        )
      }
      onClose={close}
      busy={busy}
      describedBy={plan ? 'free-space-lead free-space-final' : 'free-space-lead'}
      footer={
        plan || changed ? (
          <>
            {/* Beside the button it answers for, so it stays in view however far the body scrolls. */}
            {plan && (
              <p id="free-space-final" className="storage-final">
                <Ban aria-hidden="true" /> This can’t be undone.
              </p>
            )}
            <button ref={safe} className="btn" data-autofocus onClick={() => close()} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-danger-fill" onClick={() => void free()} disabled={busy || checking || !plan || changed || !!info.blocked}>
              {busy ? <Spinner decorative /> : <Trash2 aria-hidden="true" />} {busy ? 'Freeing…' : plan ? `Free ${formatBytes(total)}` : 'Free up space'}
            </button>
          </>
        ) : (
          <button ref={safe} className="btn" data-autofocus onClick={() => close()}>
            Close
          </button>
        )
      }
    >
      <div className="storage-dialog" data-testid="free-space-dialog">
        <span className="sr-only" role="status">
          {said}
        </span>
        <div ref={notes} className="storage-notes" hidden={!changed && !blocked}>
          {changed && (
            <div className="scope-note info">
              <Info aria-hidden="true" />
              <span className="grow">The project changed since these figures were worked out. Review the new ones before freeing space.</span>
              <button className="link" onClick={showNew} disabled={busy}>
                Show the new figures
              </button>
            </div>
          )}
          {blocked && (
            <div className="scope-note danger" role="alert">
              <TriangleAlert aria-hidden="true" />
              <span className="grow">{blocked}</span>
            </div>
          )}
        </div>
        {plan && trim ? (
          <>
            <p id="free-space-lead" className="confirm-lead">
              {consequence(plan, total)}
            </p>
            <table className="storage-table">
              <caption className="sr-only">What freeing space deletes, and what stays</caption>
              <tbody className="storage-goes">
                <tr className="storage-group">
                  <th scope="rowgroup" colSpan={3}>
                    <span className="storage-group-label">
                      <Trash2 aria-hidden="true" /> Deleted when you free space
                    </span>
                  </th>
                </tr>
                {plan.files.files > 0 && (
                  <tr>
                    <th scope="row">Removed files kept for Undo</th>
                    <td>{keptFiles}</td>
                    <td>{keptBytes}</td>
                  </tr>
                )}
                {plan.historyBytes > 0 && (
                  <tr>
                    <th scope="row">Undo history</th>
                    <td>{partOf(steps, shown.history.steps, (n) => plural(n, 'step', 'steps'))}</td>
                    <td>{plan.historyBytes !== shown.history.bytes ? `${formatBytes(plan.historyBytes)} of ${formatBytes(shown.history.bytes)}` : formatBytes(shown.history.bytes)}</td>
                  </tr>
                )}
                <tr className="storage-total">
                  <th scope="row" colSpan={2}>
                    Space freed
                  </th>
                  <td>{formatBytes(total)}</td>
                </tr>
              </tbody>
              <tbody className="storage-stays">
                <tr className="storage-group">
                  <th scope="rowgroup" colSpan={3}>
                    <span className="storage-group-label">
                      <ShieldCheck aria-hidden="true" /> Stays as it is
                    </span>
                  </th>
                </tr>
                <tr>
                  <th scope="row">In Assets</th>
                  <td>{files(shown.media.files)}</td>
                  <td>{formatBytes(shown.media.bytes)}</td>
                </tr>
                {(shown.versions.count > 0 || !!shown.versions.historyBytes) && (
                  <tr>
                    <th scope="row">Saved versions</th>
                    <td>{shown.versions.count > 0 ? plural(shown.versions.count, 'version', 'versions') : 'Version history'}</td>
                    <td>{formatBytes(shown.versions.bytes)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <ul className="confirm-details storage-details">
              {trim.undo && (
                <li data-kind="lose">
                  <CircleMinus aria-hidden="true" />
                  <div>
                    <Trimmed side={trim.undo} rest={[...plan.undo].reverse().slice(trim.undo.steps.length)} last={!plan.keptUndo} />
                  </div>
                </li>
              )}
              {trim.redo && (
                <li data-kind="lose">
                  <CircleMinus aria-hidden="true" />
                  <div>
                    <Trimmed side={trim.redo} rest={plan.redo.slice(trim.redo.steps.length)} last={!plan.keptRedo} />
                  </div>
                </li>
              )}
              {/* Steps that can still be taken after: a line of their own (a loss with none left closes its loss line). */}
              {[
                { side: trim.undo, kept: plan.keptUndo },
                { side: trim.redo, kept: plan.keptRedo }
              ].map(
                ({ side, kept }, i) =>
                  side &&
                  kept > 0 && (
                    <li key={i} data-kind="undo">
                      <Undo2 aria-hidden="true" />
                      <span>{side.after}</span>
                    </li>
                  )
              )}
              <li data-kind="keep">
                <ShieldCheck aria-hidden="true" />
                <span>Your site doesn’t change.</span>
              </li>
            </ul>
          </>
        ) : (
          <div id="free-space-lead" className="storage-nothing">
            <p className="confirm-lead">There are no removed files to delete right now.</p>
            <p className="muted">
              When you remove an image, font or document from Assets, its files are kept so Undo can bring it back. Once there are some, you can delete them here to free space.
              {shown.versions.count > 0 &&
                (shown.versions.bytes - (shown.versions.historyBytes ?? 0) > 0
                  ? ` Saved versions take ${formatBytes(shown.versions.bytes)}; delete the ones you no longer need in History.`
                  : ` Saved versions take ${formatBytes(shown.versions.bytes)}, kept in the project’s version history.`)}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
