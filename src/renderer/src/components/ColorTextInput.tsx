import { useEffect, useId, useRef, useState } from 'react';
import { normalizeColorText } from '@shared/color-names';
import { DraftInput } from './ui';
import { colorFieldProblem } from '@shared/color';

/**
 * A colour typed as text. It is checked before it is sent: text it refuses stays in the field, with the reason beside
 * it, until it is corrected or discarded (Escape), so nothing is left over the canvas. A hex typed without its # is
 * saved with one. The reason belongs to the field: one opened again starts with none, and so does one whose colour
 * changes while it is not being typed in (picked with the swatch, set elsewhere): the refused text goes, and the
 * field shows the colour now saved.
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
  id,
  problemOf,
  onClear
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
  /** Why typed text can't be saved, for a field that takes something other than a style colour (a scrim). */
  problemOf?: (text: string) => { message: string } | null;
  /** For a field that can be emptied: what emptying it saves. Without it, empty text puts the saved colour back. */
  onClear?: () => unknown;
}) {
  const refuse = (t: string) => (!t.trim() ? null : problemOf ? problemOf(t) : colorFieldProblem(t, propId));
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // A new field each round, so refused text a newer colour replaced is gone with it.
  const [round, setRound] = useState(0);
  const seen = useRef(value);
  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    if (!problem || document.activeElement === input.current) return;
    setProblem(null);
    setRound((r) => r + 1);
  }, [value, problem]);
  return (
    <>
      <DraftInput
        key={round}
        inputRef={input}
        id={id}
        className={className}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        check={refuse}
        onProblem={(p) => setProblem(p?.message ?? null)}
        // Text the check refuses never reaches the project, even from a field that goes away while focused, so a saved
        // colour is never cleared by it.
        onCommit={(t) => (!t.trim() ? (onClear ? onClear() : false) : refuse(t) ? false : onSave(normalizeColorText(t)))}
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
