/**
 * The Project tab (#518): the project's private brief, a description and working notes that say what the site is
 * for. They belong to the project, are kept in its folder and edited like everything else (undo, History), and
 * never reach visitors: the website and every export leave them out. Site details' description is the visitor-facing
 * one, and stays where it is.
 */
import { EyeOff } from 'lucide-react';
import { briefText } from '@shared/brief';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOps, useStore } from '../store';
import { DraftInput, Field } from '../components/ui';

export function ProjectBrief() {
  const brief = useStore((s) => s.snapshot?.state.brief);
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  if (opening === undefined) return null;
  return (
    // Keyed by the project's opening: text typed in one project never shows in the next.
    <div className="panel-body brief" key={opening}>
      <div className="brief-head">
        <h2>Project brief</h2>
        <p className="brief-private">
          <EyeOff aria-hidden="true" />
          <span>Private to this project. Visitors never see it: the website and every export leave it out.</span>
        </p>
      </div>
      <div className="brief-fields">
        <Field label="Description" hint="What this site is and who it is for, in a line or two. Recent projects shows it under the project’s name.">
          <DraftInput multiline rows={3} limit={TEXT_LIMITS.projectDescription} keep="brief:description" value={briefText(brief, 'description')} placeholder="A brochure site for a family-run pottery studio in Leeds." onCommit={(v) => void applyOps([{ type: 'brief.update', description: v }], 'Edit project description')} />
        </Field>
        <Field label="Working notes" hint="The client, the audience, what the site should achieve: anything worth keeping while you build it.">
          <DraftInput multiline className="textarea brief-notes" limit={TEXT_LIMITS.projectNotes} keep="brief:notes" value={briefText(brief, 'notes')} onCommit={(v) => void applyOps([{ type: 'brief.update', notes: v }], 'Edit project notes')} />
        </Field>
      </div>
    </div>
  );
}
