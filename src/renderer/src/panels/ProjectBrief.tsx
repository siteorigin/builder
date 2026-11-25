/**
 * The Project tab (#518): the project's private brief, a description and working notes that say what the site is
 * for. They belong to the project, are kept in its folder and edited like everything else (undo, History), and
 * never reach visitors: the website and every export leave them out. Site details' description is the visitor-facing
 * one, and stays where it is.
 */
import { useRef } from 'react';
import { EyeOff, Lock } from 'lucide-react';
import { briefText } from '@shared/brief';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOps, useStore } from '../store';
import { DraftInput, Field } from '../components/ui';

const HINTS = {
  description: 'What this site is and who it is for, in a line or two. Recent projects shows it under the project’s name.',
  notes: 'The client, the audience, what the site should achieve: anything worth keeping while you build it.'
};

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
  const description = briefText(brief, 'description');
  const notes = briefText(brief, 'notes');
  return (
    <div className="panel-body brief">
      <div className="brief-head">
        <h2>Project brief</h2>
        <p className="brief-private">
          <EyeOff aria-hidden="true" />
          <span>Private to this project. Visitors never see it: the website and every export leave it out.</span>
        </p>
        {/* Said before anything is typed, so nothing typed here is lost to a save that cannot happen. */}
        {readOnly && (
          <p className="brief-private">
            <Lock aria-hidden="true" />
            <span>{readOnly.reason}</span>
          </p>
        )}
      </div>
      <div className="brief-fields">
        {locked ? (
          // Read-only fields stay focusable, so the brief can still be read, selected and copied.
          <>
            <Field label="Description" hint={HINTS.description}>
              <textarea className="textarea" readOnly rows={3} value={description} />
            </Field>
            <Field label="Working notes" hint={HINTS.notes}>
              <textarea className="textarea brief-notes" readOnly value={notes} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Description" hint={HINTS.description}>
              <DraftInput multiline rows={3} limit={TEXT_LIMITS.projectDescription} keep="brief:description" value={description} placeholder="A brochure site for a family-run pottery studio in Leeds." onCommit={(v) => void applyOps([{ type: 'brief.update', description: v }], 'Edit project description')} />
            </Field>
            <Field label="Working notes" hint={HINTS.notes}>
              <DraftInput multiline className="textarea brief-notes" limit={TEXT_LIMITS.projectNotes} keep="brief:notes" value={notes} onCommit={(v) => void applyOps([{ type: 'brief.update', notes: v }], 'Edit project notes')} />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
