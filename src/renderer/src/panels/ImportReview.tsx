import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowRight, ChevronRight, ImagePlus, TriangleAlert } from 'lucide-react';
import type { ImportReviewRow } from '@shared/api';
import { getState, setState } from '../store';
import { Modal } from '../components/ui';
import { settleImportReview } from '../lib/import-review';
import './ImportReview.css';

const size = (w?: number, h?: number) => (w && h ? `${w.toLocaleString()} × ${h.toLocaleString()}` : '');
/** "2.1 MB", "340 KB", "12 bytes"; an empty file is "0 bytes", never rounded up to look like it holds something. */
const fileSize = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} ${b === 1 ? 'byte' : 'bytes'}`);
/** "HEIC · 3,024 × 4,032 · 2.1 MB" */
const describe = (r: ImportReviewRow) => [r.format, size(r.width, r.height), r.format || r.bytes ? fileSize(r.bytes) : ''].filter(Boolean).join(' · ');
/** "JPEG · 1,920 × 2,560", or the most it can be when the photo's size could not be read. */
const describeCopy = (c: NonNullable<ImportReviewRow['copy']>) => `${c.format} · ${c.width ? size(c.width, c.height) : 'up to 2,560 px'}`;
const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Enter toggles a checkbox once per press, as Space does natively: both keys work on every choice in these reviews. */
export function enterToggles(e: KeyboardEvent<HTMLInputElement>, toggle: () => void) {
  if (e.key !== 'Enter' || e.repeat) return;
  e.preventDefault();
  toggle();
}

/** A group's heading: what happens to the items under it, with how many there are. */
export function ReviewHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 className="import-review-heading" id={id}>
      {children}
    </h3>
  );
}

/**
 * The review's facts, before any list: one row per question the author asks (how many, changed how, where to),
 * label beside value, falling to label above value in a narrow dialog.
 */
export function ReviewSummary({ rows, children, focusFirst }: { rows: Array<[string, ReactNode] | false | null | undefined>; children?: ReactNode; focusFirst?: boolean }) {
  return (
    // `focusFirst`: the dialog opens on its facts, not on a control further down that would scroll them away.
    <div className="import-summary" {...(focusFirst ? { tabIndex: -1, 'data-autofocus': true } : {})}>
      <dl>
        {rows.filter((r): r is [string, ReactNode] => !!r).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {children && <p className="import-summary-note">{children}</p>}
    </div>
  );
}

/** A list too long to show at once, behind a counted summary that says what it holds. */
export function ReviewDisclosure({ summary, icon, className, children, testId }: { summary: ReactNode; icon?: ReactNode; className?: string; children: ReactNode; testId?: string }) {
  return (
    <details className={`import-disclosure${className ? ` ${className}` : ''}`} data-testid={testId}>
      <summary>
        <ChevronRight className="chev" aria-hidden="true" />
        {icon}
        <span>{summary}</span>
      </summary>
      {children}
    </details>
  );
}

function Row({ r, copy, onCopy }: { r: ImportReviewRow; copy: boolean; onCopy: (on: boolean) => void }) {
  const id = useId();
  return (
    <li className={`import-review-row ${r.action}`} data-testid="import-review-row">
      <div className="import-review-name">
        <b id={`${id}-name`}>{r.name}</b>
        <span className="muted">{describe(r)}</span>
      </div>
      {r.action === 'convert' && r.copy && (
        <p className="import-review-what">
          <ArrowRight aria-hidden="true" /> <span>Becomes a {describeCopy(r.copy)}, turned the right way up.</span>
        </p>
      )}
      {r.action === 'offer' && r.copy && r.copyOnly && (
        // No choice to make: a ticked control that can't be unticked would only look like one.
        <p className="import-review-what">
          <ArrowRight aria-hidden="true" />
          <span>
            Added as a web-sized copy: {describeCopy(r.copy)}. <span className="muted">The original is over 25 MB, too large to add as it is.</span>
          </span>
        </p>
      )}
      {r.action === 'offer' && r.copy && !r.copyOnly && (
        <label className="import-review-what import-review-choice">
          <input type="checkbox" checked={copy} onChange={(e) => onCopy(e.target.checked)} aria-labelledby={`${id}-choice ${id}-name`}
            onKeyDown={(e) => enterToggles(e, () => onCopy(!copy))} aria-describedby={`${id}-else`} />
          <span>
            <span id={`${id}-choice`}>Add a web-sized copy instead: {describeCopy(r.copy)}.</span>{' '}
            <span className="muted" id={`${id}-else`}>
              Unticked, the original is added as it is.
            </span>
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
 * large photo can be added as a web-sized copy instead, and a file that can't be added says what to do. The facts
 * come first (how many are added, changed and left out); then every file chosen is named, in one of three groups:
 * changed on the way in, added as it is, and can't be added. The author's own files stay where they are.
 * Confirming adds them; any other way out adds nothing.
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
  // The one decision first: large photos the author can take as a web-sized copy or as they are.
  const choices = changed.filter((r) => r.action === 'offer' && !r.copyOnly);
  const fixed = changed.filter((r) => !choices.includes(r));
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
  const converted = changed.filter((r) => r.action === 'convert').length;
  const copied = changed.filter((r) => r.action === 'offer' && (r.copyOnly || copies.has(r.path))).length;
  const asIs = adding - converted - copied;
  const title = !adding ? (rows.length === 1 ? 'This file can’t be added' : 'These files can’t be added') : rows.length === 1 ? 'Add this photo' : `Review ${rows.length} files`;
  // "converted to JPEG" only when every converted photo's copy is known to be one (a see-through HEIC may be a PNG).
  const toJpeg = changed.every((r) => r.action !== 'convert' || r.copy?.format === 'JPEG');
  const changes = [converted ? `${converted.toLocaleString()} converted${toJpeg ? ' to JPEG' : ''}` : '', copied ? count(copied, 'web-sized copy', 'web-sized copies') : ''].filter(Boolean);
  return (
    <Modal
      title={title}
      icon={adding ? <ImagePlus /> : <TriangleAlert className="import-review-icon-blocked" />}
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
          <button className="btn" onClick={() => close(null)}>
            Close
          </button>
        )
      }
    >
      <ReviewSummary
        rows={[
          ['Added to Assets', adding ? count(adding, 'file', 'files') : 'Nothing'],
          // Kept while there are photos to change, so unticking the last copy is announced too.
          changed.length > 0 && ['Changed on the way in', <span aria-live="polite">{changes.length ? changes.join(' · ') : 'None'}</span>],
          refused.length > 0 && ['Left out', <span className="import-summary-loss">{count(refused.length, 'file', 'files')}</span>],
          // Kept while a copy can be unticked, so the rows below never move under the pointer.
          adding > 0 && (asIs > 0 || choices.length > 0) && ['Added as it is', asIs ? count(asIs, 'file', 'files') : 'None']
        ]}
      >
        {adding ? 'Your originals stay on this computer, unchanged, and nothing is added until you confirm.' : 'Nothing has been added.'}
      </ReviewSummary>
      {choices.length > 0 && (
        <section className="import-review-group" aria-labelledby="import-review-choices">
          <ReviewHeading id="import-review-choices">{choices.length === 1 ? 'Choose a size for this photo' : `Choose a size for these ${choices.length} photos`}</ReviewHeading>
          <ul className="import-review">
            {choices.map((r) => (
              <Row key={r.path} r={r} copy={copies.has(r.path)} onCopy={(on) => toggle(r.path, on)} />
            ))}
          </ul>
        </section>
      )}
      {fixed.length > 0 && (
        <section className="import-review-group" aria-labelledby="import-review-changed">
          <ReviewHeading id="import-review-changed">{fixed.length === 1 ? '1 file changes automatically' : `${fixed.length} files change automatically`}</ReviewHeading>
          <ul className="import-review">
            {fixed.map((r) => (
              <Row key={r.path} r={r} copy={copies.has(r.path)} onCopy={(on) => toggle(r.path, on)} />
            ))}
          </ul>
        </section>
      )}
      {refused.length > 0 && (
        <section className="import-review-group" aria-labelledby="import-review-refused">
          <ReviewHeading id="import-review-refused">{count(refused.length, 'file left out', 'files left out')}</ReviewHeading>
          <ul className="import-review">
            {refused.map((r) => (
              <Row key={r.path} r={r} copy={false} onCopy={() => undefined} />
            ))}
          </ul>
        </section>
      )}
      {plain.length > 0 && plain.length <= 4 && (
        <p className="import-review-rest">
          {/* "Other" only follows photos listed above it. */}
          {plain.length === 1 ? `${changed.length ? 'One other file' : 'One file'} is added as it is: ${plain[0].name}.` : `${plain.length} ${changed.length ? 'other files' : 'files'} are added as they are: ${plain.slice(0, -1).map((r) => r.name).join(', ')} and ${plain[plain.length - 1].name}.`}
        </p>
      )}
      {plain.length > 4 && (
        // Every name is there to check, for a batch too long to list in a sentence.
        <ReviewDisclosure className="import-review-rest import-review-all" testId="import-review-all" summary={`${plain.length} ${changed.length ? 'other files are' : 'files are'} added as they are`}>
          <ul className="import-names">
            {plain.map((r) => (
              <li key={r.path}>{r.name}</li>
            ))}
          </ul>
        </ReviewDisclosure>
      )}
    </Modal>
  );
}
