import { useRef, useState } from 'react';
import { checkCanonicalUrl } from '@shared/seo';
import { isArticleDate } from '@shared/articles';
import { DraftInput, Field, type DraftProblem } from './ui';

/** Why typed text can't be a canonical URL, or null when it can (empty text clears it). */
function canonicalProblem(text: string): DraftProblem | null {
  const c = checkCanonicalUrl(text);
  return c.ok ? null : { message: c.message };
}

/**
 * A page's or a post's canonical URL: the address search engines are told is the original, for something first
 * published elsewhere. Text that is no full http(s) address stays in the field as an unsaved draft, with the reason,
 * until it is corrected or discarded (Escape). A saved value that can't be used (written by hand) is pointed out in
 * the hint, not as the field's error: nothing typed here is waiting to be saved, so it never holds up a Publish.
 */
export function CanonicalUrlField({ id, value: saved, ownUrl, what, onCommit }: { id?: string; value: unknown; ownUrl: string | null; what: 'page' | 'post'; onCommit: (url: string) => unknown }) {
  const value = typeof saved === 'string' ? saved : '';
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const hint = `Only when this ${what} was first published at another address: search engines are pointed there instead. Leave empty to use its own address.`;
  // What is wrong with the saved value describes the field only while it shows that value.
  const stored = !problem && value && !dirty ? canonicalProblem(value) : null;
  const error = problem && (
    <span role="alert">
      {problem.message}{' '}
      <span className="field-saved">Not saved. {value ? <>The saved value is still <bdi>{value}</bdi>.</> : 'Nothing is saved here yet.'}</span>
    </span>
  );
  return (
    <Field label="Canonical URL" hint={stored ? `${stored.message} The ${what}’s own address is used until it is corrected.` : hint} error={error}>
      <DraftInput id={id} value={value} placeholder={ownUrl ?? 'https://example.com/original/'} check={canonicalProblem} onProblem={setProblem} onDirty={setDirty} onCommit={(v) => (v.trim() !== value ? onCommit(v.trim()) : undefined)} />
    </Field>
  );
}

/**
 * A revision date (YYYY-MM-DD) that can be cleared. A date control left half typed reads as empty too, so only an
 * empty control holding no partial date clears it; a partial or impossible date is refused and the saved one stays.
 */
export function RevisionDateInput({ id, value, onSet, onClear, refuse = () => false }: { id?: string; value: string | undefined; onSet: (date: string) => unknown; onClear: () => unknown; refuse?: () => unknown }) {
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  return (
    <DraftInput
      id={id}
      type="date"
      value={value ?? ''}
      inputRef={input}
      onCommit={(v) => {
        if (!v) return (input.current as HTMLInputElement | null)?.validity?.badInput ? refuse() : value ? onClear() : undefined;
        if (!isArticleDate(v)) return refuse();
        return v !== value ? onSet(v) : undefined;
      }}
    />
  );
}
