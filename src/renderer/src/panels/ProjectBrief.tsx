import './ProjectBrief.css';
/**
 * The Project tab (#518): the project's private brief, a description and working notes that say what the site is
 * for. They belong to the project, are kept in its folder and edited like everything else (undo, History), and
 * never reach visitors: the website and every export leave them out. The AI reads them as background on every request
 * (agent/brief.ts), the description whole and only the start of long notes. Site details' description is the
 * visitor-facing one, and stays where it is.
 */
import { useRef } from 'react';
import { EyeOff, NotebookPen } from 'lucide-react';
import { briefText } from '@shared/brief';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOps, useStore } from '../store';
import { BlockedNote, BlockedStatus, readOnlyBlock } from '../components/BlockedNote';
import { DraftInput, Field } from '../components/ui';

const HINTS = {
  description: 'What the site is and who it’s for, in a line or two. For example: “A pottery studio in Leeds, with evening classes for beginners.” It shows under the project’s name in Recent projects.',
  notes: 'The client, the audience, what the site should achieve. The AI reads only the start of long notes, so put what matters most first.'
};
/** A locked brief is read, not written: only what each field is for. */
const LOCKED_HINTS = {
  description: 'It shows under the project’s name in Recent projects.',
  notes: 'The AI reads only the start of long notes.'
};
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
            <span className="insp-kind-label">Private to this project</span>
          </div>
        </div>
        <p className="brief-private">
          <EyeOff aria-hidden="true" />
          <span>The AI reads it on every request, to guide the tone, sections and copy it writes. Visitors never see it: the website and every export leave it out.</span>
        </p>
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
              <DraftInput multiline rows={3} limit={TEXT_LIMITS.projectDescription} keep="brief:description" value={description} aria-describedby={held} onCommit={(v) => void applyOps([{ type: 'brief.update', description: v }], 'Edit project description')} />
            </Field>
            <Field label="Working notes" hint={hints.notes}>
              <DraftInput multiline quietCount className="textarea brief-notes" limit={TEXT_LIMITS.projectNotes} keep="brief:notes" value={notes} aria-describedby={held} onCommit={(v) => void applyOps([{ type: 'brief.update', notes: v }], 'Edit project notes')} />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
