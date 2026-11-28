import { useCallback, useId, useRef, useState } from 'react';
import { checkCanonicalUrl } from '@shared/seo';
import { isArticleDate } from '@shared/articles';
import { DraftInput, Field, useLockedFields, type DraftProblem } from './ui';

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
 * `onTyped` hears the address typed and not saved yet, as it would be saved ("" clears it), while it is one that can
 * be; undefined while the field shows the saved value or text that can't be used.
 */
export function CanonicalUrlField({
  id,
  value: saved,
  ownUrl,
  what,
  onCommit,
  onTyped,
  keep,
  keepWhile
}: {
  id?: string;
  /** Where its text belongs (a page's canonical URL), so text it refused is kept for it while it shows elsewhere. */
  keep?: string;
  keepWhile?: () => boolean;
  value: unknown;
  ownUrl: string | null;
  /** What the document is called in a sentence: "page", or an entry's own noun ("post", "case study"). */
  what: string;
  onCommit: (url: string) => unknown;
  onTyped?: (url: string | undefined) => void;
}) {
  const value = typeof saved === 'string' ? saved : '';
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const typedTo = useRef(onTyped);
  typedTo.current = onTyped;
  const dirtied = useCallback((d: boolean, draft: string) => {
    setDirty(d);
    const c = checkCanonicalUrl(draft);
    typedTo.current?.(d && c.ok ? c.url : undefined);
  }, []);
  const info = 'If this content is also at another address, enter the one search engines should list.';
  // What is wrong with the saved value describes the field only while it shows that value.
  const stored = !problem && value && !dirty ? canonicalProblem(value) : null;
  const error = problem && (
    <span role="alert">
      {problem.message}{' '}
      <span className="field-saved">Not saved. {value ? <>The saved value is still <bdi>{value}</bdi>.</> : 'Nothing is saved here yet.'}</span>
    </span>
  );
  return (
    <Field label="Canonical URL" hint={stored ? `${stored.message} The ${what}’s own address is used until it is corrected.` : undefined} info={info} error={error}>
      <DraftInput id={id} keep={keep} keepWhile={keepWhile} value={value} placeholder={ownUrl ?? `This ${what}’s own address`} check={canonicalProblem} onProblem={setProblem} onDirty={dirtied} onCommit={(v) => (v.trim() !== value ? onCommit(v.trim()) : undefined)} />
    </Field>
  );
}

/**
 * A revision date (YYYY-MM-DD), with its label, its hint and a Clear button. The date control only ever sets a date:
 * one left empty or half typed reads the same to it, so either is refused and the saved date stays. Clearing it is the
 * button's alone, so no text the control holds when it goes (a held edit replayed later) can remove the date.
 */
export function RevisionDateField({ id: explicitId, label, hint, info, value, onSet, onClear, refuse = () => false }: { id?: string; label: string; hint?: string; info?: string; value: string | undefined; onSet: (date: string) => unknown; onClear: () => unknown; refuse?: () => unknown }) {
  const generated = useId();
  const id = explicitId ?? generated;
  const locked = useLockedFields();
  return (
    <Field label={label} hint={hint} info={info} controlId={id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Empty, the browser draws its yyyy/mm/dd mask in the text's own ink: it takes a placeholder's, so it never reads as a date. */}
        <DraftInput id={id} type="date" className={value ? 'input' : 'input date-empty'} aria-describedby={[hint ? `${id}-note` : '', info ? `${id}-info` : ''].filter(Boolean).join(' ') || undefined} value={value ?? ''} onCommit={(v) => (isArticleDate(v) ? (v !== value ? onSet(v) : undefined) : v || value ? refuse() : undefined)} />
        {value && !locked && (
          <button type="button" className="link-btn" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => void onClear()}>
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}
