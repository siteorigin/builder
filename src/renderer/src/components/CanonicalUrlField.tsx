import { useState } from 'react';
import { checkCanonicalUrl } from '@shared/seo';
import { DraftInput, Field, type DraftProblem } from './ui';

/** Why typed text can't be a canonical URL, or null when it can (empty text clears it). */
function canonicalProblem(text: string): DraftProblem | null {
  const c = checkCanonicalUrl(text);
  return c.ok ? null : { message: c.message };
}

/**
 * A page's or a post's canonical URL: the address search engines are told is the original, for something first
 * published elsewhere. Text that is no full http(s) address stays in the field as an unsaved draft, with the reason,
 * until it is corrected or discarded (Escape); a saved value that can't be used (written by hand) is pointed out too.
 */
export function CanonicalUrlField({ id, value: saved, ownUrl, what, onCommit }: { id?: string; value: unknown; ownUrl: string | null; what: 'page' | 'post'; onCommit: (url: string) => unknown }) {
  const value = typeof saved === 'string' ? saved : '';
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  // What is wrong with the saved value describes the field only while it shows that value.
  const shown = problem ?? (value && !dirty ? canonicalProblem(value) : null);
  const error = shown && (
    <span role={problem ? 'alert' : undefined}>
      {shown.message}{' '}
      {problem ? (
        <span className="field-saved">
          Not saved. {value ? <>The saved value is still <bdi>{value}</bdi>.</> : 'Nothing is saved here yet.'}
        </span>
      ) : (
        `The ${what}’s own address is used until it is corrected.`
      )}
    </span>
  );
  return (
    <Field label="Canonical URL" hint={`Only when this ${what} was first published at another address: search engines are pointed there instead. Leave empty to use its own address.`} error={error}>
      <DraftInput id={id} value={value} placeholder={ownUrl ?? 'https://example.com/original/'} check={canonicalProblem} onProblem={setProblem} onDirty={setDirty} onCommit={(v) => (v.trim() !== value ? onCommit(v.trim()) : undefined)} />
    </Field>
  );
}
