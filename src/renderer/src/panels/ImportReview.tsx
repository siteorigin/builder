import { useState } from 'react';
import { ArrowRight, ImagePlus, TriangleAlert } from 'lucide-react';
import type { ImportReviewRow } from '@shared/api';
import { getState, setState } from '../store';
import { Modal } from '../components/ui';
import { settleImportReview } from '../lib/import-review';

const size = (w?: number, h?: number) => (w && h ? `${w.toLocaleString()} × ${h.toLocaleString()}` : '');
const megabytes = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** "HEIC · 3,024 × 4,032 · 2.1 MB" */
const describe = (r: ImportReviewRow) => [r.format, size(r.width, r.height), megabytes(r.bytes)].filter(Boolean).join(' · ');
/** "JPEG · 1,920 × 2,560", or the most it can be when the photo's size could not be read. */
const describeCopy = (c: NonNullable<ImportReviewRow['copy']>) => `${c.format} · ${c.width ? size(c.width, c.height) : 'up to 2,560 px'}`;

/**
 * What an import will add, shown before anything is converted or written: each HEIC photo becomes a JPEG copy, each
 * large photo can be added as a web-sized copy instead, and a file that can't be added says what to do. The
 * author's own files stay where they are. Confirming adds them; any other way out adds nothing.
 */
export function ImportReviewModal({ id, rows }: { id: number; rows: ImportReviewRow[] }) {
  const [copies, setCopies] = useState(() => new Set(rows.filter((r) => r.action === 'offer').map((r) => r.path)));
  // Gone without an answer (another dialog, the project closed), it is dismissed by reviewImport's watch on the store.
  const [own] = useState(() => getState().modal);
  const close = (answer: Set<string> | null) => {
    settleImportReview(id, answer);
    if (getState().modal === own) setState({ modal: null });
  };
  const shown = rows.filter((r) => r.action !== 'import');
  const plain = rows.length - shown.length;
  const adding = rows.filter((r) => r.action !== 'refuse').length;
  const toggle = (path: string, on: boolean) =>
    setCopies((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <Modal
      title={!adding ? (rows.length === 1 ? 'This photo can’t be added' : 'These files can’t be added') : adding === 1 ? (rows.length === 1 ? 'Add this photo' : 'Add 1 file') : `Add ${adding} files`}
      icon={<ImagePlus />}
      onClose={() => close(null)}
      wide
      footer={
        adding ? (
          <>
            <button className="btn" onClick={() => close(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" data-testid="import-review-add" onClick={() => close(copies)}>
              {adding === 1 ? 'Add to Assets' : `Add ${adding} files to Assets`}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => close(null)}>
            Close
          </button>
        )
      }
    >
      <p className="muted import-review-lead">
        {shown.some((r) => r.action !== 'refuse') ? 'Browsers need web images, so Builder adds a copy made for the web.' : 'Browsers can’t show these, and Builder can’t convert them on this computer.'} Your originals stay on this computer, unchanged.
      </p>
      <ul className="import-review" aria-label="Files to add">
        {shown.map((r) => (
          <li key={r.path} className={`import-review-row ${r.action}`} data-testid="import-review-row">
            <div className="import-review-name">
              <b>{r.name}</b>
              <span className="muted">{describe(r)}</span>
            </div>
            {r.action === 'convert' && r.copy && (
              <p className="import-review-what">
                <ArrowRight aria-hidden="true" /> Added as a {describeCopy(r.copy)}, turned the right way up.
              </p>
            )}
            {r.action === 'offer' && r.copy && (
              <label className="import-review-what">
                <input type="checkbox" checked={r.copyOnly || copies.has(r.path)} disabled={r.copyOnly} onChange={(e) => toggle(r.path, e.target.checked)} />
                <span>
                  Add a web-sized copy instead: {describeCopy(r.copy)}.{' '}
                  {r.copyOnly ? <span className="muted">The original is over 25 MB, too large to add as it is.</span> : <span className="muted">Unticked, the original is added as it is.</span>}
                </span>
              </label>
            )}
            {r.action === 'refuse' && (
              <p className="import-review-what import-review-refused">
                <TriangleAlert aria-hidden="true" /> <span>Can’t be added: {r.reason}</span>
              </p>
            )}
          </li>
        ))}
      </ul>
      {plain > 0 && <p className="muted import-review-rest">{plain === 1 ? 'One other file is added as it is.' : `${plain} other files are added as they are.`}</p>}
    </Modal>
  );
}
