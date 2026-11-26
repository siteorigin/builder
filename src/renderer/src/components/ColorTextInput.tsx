import { useId, useState } from 'react';
import { normalizeColorText } from '@shared/color-names';
import { DraftInput } from './ui';
import { colorFieldProblem } from '../lib/color';

/**
 * A colour typed as text. It is checked before it is sent: text it refuses stays in the field, with the reason beside
 * it, until it is corrected or discarded (Escape), so nothing is left over the canvas. A hex typed without its # is
 * saved with one. The reason belongs to the field: one opened again starts with none.
 */
export function ColorTextInput({
  propId = 'color',
  value,
  onSave,
  className,
  errorClassName,
  placeholder,
  autoFocus,
  ariaLabel,
  describedBy,
  id
}: {
  /** The style property the colour is for ('background' also takes a gradient); a site colour is 'color'. */
  propId?: string;
  value: string;
  onSave: (color: string) => unknown;
  className: string;
  errorClassName?: string;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  describedBy?: string;
  id?: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  return (
    <>
      <DraftInput
        id={id}
        className={className}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        check={(t) => colorFieldProblem(t, propId)}
        onProblem={(p) => setProblem(p?.message ?? null)}
        // Empty text puts the saved colour back. Text the check refuses never reaches the project, even from a field
        // that goes away while focused, so a saved colour is never cleared by it.
        onCommit={(t) => (!t.trim() || colorFieldProblem(t, propId) ? false : onSave(normalizeColorText(t)))}
        ariaLabel={ariaLabel}
        aria-invalid={problem ? true : undefined}
        aria-describedby={[problem ? problemId : undefined, describedBy].filter(Boolean).join(' ') || undefined}
      />
      {problem && (
        <div className={`field-error${errorClassName ? ` ${errorClassName}` : ''}`} id={problemId} role="alert">
          {problem} <span className="field-saved">Not saved.</span>
        </div>
      )}
    </>
  );
}
