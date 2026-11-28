import './ProjectBrief.css';
/**
 * The Project tab (#518): the project's private brief, a description and working notes that say what the site is
 * for. They belong to the project, are kept in its folder and edited like everything else (undo, History), and
 * never reach visitors: the website and every export leave them out. The AI reads them as background on every request
 * (agent/brief.ts), the description whole and only the start of long notes. Site details' description is the
 * visitor-facing one, and stays where it is.
 */
import { useRef } from 'react';
import { NotebookPen } from 'lucide-react';
import { briefText } from '@shared/brief';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOps, useStore } from '../store';
import { BlockedNote, BlockedStatus, readOnlyBlock } from '../components/BlockedNote';
import { DraftInput, Field } from '../components/ui';

/** One line under each field: where the description shows, and the one rule for notes worth knowing before writing them. */
const HINTS = {
  description: 'Shown in Recent projects',
  notes: 'The AI reads only the start of long notes.'
};
/** What to write, as each empty field's placeholder. */
const PLACEHOLDERS = {
  description: 'What the site is and who it’s for',
  notes: 'Client, audience and goals'
};
const LOCKED_HINTS = HINTS;
const HELD_NOTE = 'brief-held';

export function ProjectBrief() {
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  if (opening === undefined) return null;
  // Keyed by the project's opening: text typed in one project never shows in the next.
  return <BriefFields key={opening} />;
}

function BriefFields() {
  const brief = useStore((s) => s.snapshot?.state.brief);
  const readOnly = useStore((s) => s.snapshot?.readOnly ?? null);
  // A project opened read-only shows its brief read-only. Fields that were editable stay so if the project becomes
  // read-only later (another app took it over), as every other field does: text being typed is never swapped out
  // from under the author, and the save it can't make says why.
  const editable = useRef(false);
  if (!readOnly) editable.current = true;
  const locked = !!readOnly && !editable.current;
  const block = readOnlyBlock({ readOnly });
  const description = briefText(brief, 'description');
  const notes = briefText(brief, 'notes');
  // While the project is read-only each field is described by the note that says why, as a held button is, and its
  // hint says only what the field is for: a field still being typed after a takeover is not coached on writing more.
  const held = block ? HELD_NOTE : undefined;
  const hints = block ? LOCKED_HINTS : HINTS;
  return (
    <div className="panel-body brief">
      <div className="brief-head">
        <div className="insp-id">
          <span className="insp-kind" aria-hidden="true">
            <NotebookPen />
          </span>
          <div className="insp-name">
            <h3>Project brief</h3>
            <span className="insp-kind-label">Guides every AI request · never exported</span>
          </div>
        </div>
        <BlockedStatus block={block} lifted="You can edit the brief again." />
        {/* Said before anything is typed, so nothing typed here is lost to a save that cannot happen. */}
        {block && <BlockedNote block={block} id={HELD_NOTE} live={false} />}
      </div>
      <div className="brief-fields">
        {locked ? (
          // Read-only fields stay focusable, so the brief can still be read, selected and copied.
          <>
            <Field label="Description" hint={LOCKED_HINTS.description}>
              <textarea className="textarea" readOnly rows={3} value={description} aria-describedby={held} />
            </Field>
            <Field label="Working notes" hint={LOCKED_HINTS.notes}>
              <textarea className="textarea brief-notes" readOnly value={notes} aria-describedby={held} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Description" hint={hints.description}>
              <DraftInput multiline rows={3} placeholder={PLACEHOLDERS.description} limit={TEXT_LIMITS.projectDescription} keep="brief:description" value={description} aria-describedby={held} onCommit={(v) => void applyOps([{ type: 'brief.update', description: v }], 'Edit project description')} />
            </Field>
            <Field label="Working notes" hint={hints.notes}>
              <DraftInput multiline quietCount placeholder={PLACEHOLDERS.notes} className="textarea brief-notes" limit={TEXT_LIMITS.projectNotes} keep="brief:notes" value={notes} aria-describedby={held} onCommit={(v) => void applyOps([{ type: 'brief.update', notes: v }], 'Edit project notes')} />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
