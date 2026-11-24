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
/** "a.jpg, b.png and 3 more" */
function names(rows: ImportReviewRow[]): string {
  const shown = rows.slice(0, rows.length > 4 ? 3 : 4).map((r) => r.name);
  const rest = rows.length - shown.length;
  if (rest) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
}

function Row({ r, copy, onCopy }: { r: ImportReviewRow; copy: boolean; onCopy: (on: boolean) => void }) {
  return (
    <li className={`import-review-row ${r.action}`} data-testid="import-review-row">
      <div className="import-review-name">
        <b>{r.name}</b>
        <span className="muted">{describe(r)}</span>
      </div>
      {r.action === 'convert' && r.copy && (
        <p className="import-review-what">
          <ArrowRight aria-hidden="true" /> Becomes a {describeCopy(r.copy)}, turned the right way up.
        </p>
      )}
      {r.action === 'offer' && r.copy && (
        <label className="import-review-what">
          <input type="checkbox" checked={r.copyOnly || copy} disabled={r.copyOnly} onChange={(e) => onCopy(e.target.checked)} />
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
  );
}

/**
 * What an import will add, shown before anything is converted or written: each HEIC photo becomes a JPEG copy, each
 * large photo can be added as a web-sized copy instead, and a file that can't be added says what to do. Every file
 * chosen is named, in one of three groups: changed on the way in, added as it is, and can't be added. The author's
 * own files stay where they are. Confirming adds them; any other way out adds nothing.
 */
export function ImportReviewModal({ id, rows }: { id: number; rows: ImportReviewRow[] }) {
  const [copies, setCopies] = useState(() => new Set(rows.filter((r) => r.action === 'offer').map((r) => r.path)));
  // Gone without an answer (another dialog, the project closed), it is dismissed by reviewImport's watch on the store.
  const [own] = useState(() => getState().modal);
  const close = (answer: Set<string> | null) => {
    settleImportReview(id, answer);
    if (getState().modal === own) setState({ modal: null });
  };
  const changed = rows.filter((r) => r.action === 'convert' || r.action === 'offer');
  const plain = rows.filter((r) => r.action === 'import');
  const refused = rows.filter((r) => r.action === 'refuse');
  const adding = rows.length - refused.length;
  const toggle = (path: string, on: boolean) =>
    setCopies((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const title = !adding ? (rows.length === 1 ? 'This file can’t be added' : 'These files can’t be added') : rows.length === 1 ? 'Add this photo' : `Review ${rows.length} files`;
  const lead = [
    changed.some((r) => r.action === 'convert') ? 'HEIC photos are added as JPEG copies, so they show in every browser.' : '',
    changed.some((r) => r.action === 'offer') ? 'Large photos can come in as lighter web-sized copies.' : '',
    adding ? 'Your originals stay on this computer, unchanged, and nothing is added until you confirm.' : 'Nothing has been added.'
  ].filter(Boolean);
  return (
    <Modal
      title={title}
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
              {adding === 1 ? 'Add 1 file to Assets' : `Add ${adding} files to Assets`}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => close(null)}>
            Close
          </button>
        )
      }
    >
      <p className="muted import-review-lead">{lead.join(' ')}</p>
      {changed.length > 0 && (
        <section className="import-review-group" aria-labelledby="import-review-changed">
          <h3 id="import-review-changed">{changed.length === 1 ? 'Check this photo' : `Check these ${changed.length} photos`}</h3>
          <ul className="import-review">
            {changed.map((r) => (
              <Row key={r.path} r={r} copy={copies.has(r.path)} onCopy={(on) => toggle(r.path, on)} />
            ))}
          </ul>
        </section>
      )}
      {plain.length > 0 && (
        <p className="muted import-review-rest">
          {/* "Other" only follows photos listed above it. */}
          {plain.length === 1 ? `${changed.length ? 'One other file' : 'One file'} is added as it is: ${plain[0].name}.` : `${plain.length} ${changed.length ? 'other files' : 'files'} are added as they are: ${names(plain)}.`}
        </p>
      )}
      {plain.length > 4 && (
        // Every name is there to check, for a batch too long to list in a sentence.
        <details className="import-review-all">
          <summary>Show all {plain.length}</summary>
          <ul>
            {plain.map((r) => (
              <li key={r.path}>{r.name}</li>
            ))}
          </ul>
        </details>
      )}
      {refused.length > 0 && (
        <section className="import-review-group" aria-labelledby="import-review-refused">
          <h3 id="import-review-refused">{refused.length === 1 ? 'Left out' : `${refused.length} left out`}</h3>
          <ul className="import-review">
            {refused.map((r) => (
              <Row key={r.path} r={r} copy={false} onCopy={() => undefined} />
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
