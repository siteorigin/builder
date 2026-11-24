import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import type { StorageInfo } from '@shared/api';
import { api, getState, toast, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';
import { describeTrim, formatBytes, plural, type TrimmedSide } from '../lib/storage';

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
  }, [opening, visible, revision, history, busy, tick]);
  return { info: got?.opening === opening ? got.info : null, refresh: () => setTick((n) => n + 1) };
}

const files = (n: number) => plural(n, 'file', 'files');

/** The footer of the Assets panel: what the project's media take, and what removed files kept for Undo take. */
export function StorageSummary({ info, onFree }: { info: StorageInfo; onFree: () => void }) {
  if (!info.media.files && !info.kept.files) return null;
  return (
    <section className="asset-storage" aria-labelledby="asset-storage-title" data-testid="asset-storage">
      <h4 id="asset-storage-title">Storage</h4>
      <dl>
        <div>
          <dt>In use</dt>
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
      </dl>
      {info.kept.files > 0 && <p>Removed images, fonts and documents stay in the project folder while Undo can still bring them back.</p>}
      {info.reclaim && (
        <button className="btn btn-sm" onClick={onFree}>
          <HardDrive /> Free up space…
        </button>
      )}
    </section>
  );
}

function Trimmed({ side }: { side: TrimmedSide }) {
  return (
    <>
      <p>{side.lead}</p>
      <ul className="storage-steps">
        {side.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {side.more && <li className="more">{side.more}</li>}
      </ul>
      <p className="muted">{side.after}</p>
    </>
  );
}

/**
 * Shows exactly what freeing up space deletes and which Undo and Redo steps go with it, before anything happens.
 * Free carries out the plan on screen and no other: when the project changes the plan, the new one is shown only once
 * the author asks for it, and Free waits until then.
 */
export function FreeSpaceDialog({ info, onClose, refresh }: { info: StorageInfo; onClose: () => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(info);
  const changed = (info.reclaim?.key ?? null) !== (shown.reclaim?.key ?? null);
  // New figures for the same plan (the history's size, say) are shown as they come.
  useEffect(() => {
    if (!changed) setShown(info);
  }, [info, changed]);
  const plan = shown.reclaim;
  const trim = plan ? describeTrim(plan) : null;
  const total = plan ? plan.files.bytes + plan.historyBytes : 0;
  const free = async () => {
    const opening = getState().snapshot?.workspaceKey;
    if (!plan || !opening || busy || changed) return;
    setBusy(true);
    setError(null);
    const r = await api.project.reclaimStorage(plan.key, opening).catch((e: Error) => ({ ok: false, message: e.message, freed: undefined }));
    setBusy(false);
    // A reply for a project that has since closed says nothing about the one open now.
    if (getState().snapshot?.workspaceKey !== opening) return;
    if (r.ok) {
      toast([`Freed ${formatBytes(r.freed ?? 0)}.`, r.message ?? ''].filter(Boolean).join(' '), 'info');
      refresh();
      onClose();
    } else {
      setError(r.message ?? 'The space could not be freed.');
      refresh();
    }
  };
  const showNew = () => {
    setShown(info);
    setError(null);
  };
  return (
    <Modal
      title="Free up space"
      icon={<HardDrive />}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" data-autofocus onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" onClick={() => void free()} disabled={busy || !plan || changed || !!info.blocked}>
            {busy && <Spinner decorative />} {plan ? `Free ${formatBytes(total)}` : 'Free up space'}
          </button>
        </>
      }
    >
      <div className="storage-dialog" data-testid="free-space-dialog">
        <table className="storage-table">
          <caption className="sr-only">What the project takes on disk</caption>
          <tbody>
            <tr>
              <th scope="row">Images and fonts in use</th>
              <td>{files(shown.media.files)}</td>
              <td>{formatBytes(shown.media.bytes)}</td>
            </tr>
            <tr>
              <th scope="row">Removed, kept for Undo</th>
              <td>{files(shown.kept.files)}</td>
              <td>{formatBytes(shown.kept.bytes)}</td>
            </tr>
            <tr>
              <th scope="row">Undo history</th>
              <td>{plural(shown.history.steps, 'step', 'steps')}</td>
              <td>{formatBytes(shown.history.bytes)}</td>
            </tr>
          </tbody>
        </table>
        {plan && trim ? (
          <>
            <p>
              Deletes {plural(plan.files.files, 'removed file', 'removed files')} ({formatBytes(plan.files.bytes)}) that nothing in the project names
              {plan.historyBytes ? `, and ${formatBytes(plan.historyBytes)} of saved history` : ''}. Your site doesn’t change: every page, image, font and document in use stays as it is.
            </p>
            {trim.undo && <Trimmed side={trim.undo} />}
            {trim.redo && <Trimmed side={trim.redo} />}
            <p>
              <b>This can’t be undone.</b> To keep every step, close this and leave the files where they are.
            </p>
          </>
        ) : (
          <p>There is nothing to free right now.</p>
        )}
        {changed && (
          <div className="scope-note" role="status">
            <span className="grow">The project changed since these figures were worked out.</span>
            <button className="link" onClick={showNew} disabled={busy}>
              Show the new figures
            </button>
          </div>
        )}
        {(error || info.blocked) && (
          <div className="scope-note danger" role="alert">
            {error ?? info.blocked}
          </div>
        )}
      </div>
    </Modal>
  );
}
