import { LINK_RELS, type LinkRel } from '@shared/types';
import { canonicalRels } from '@shared/link-rel';

/** Each relationship by its own name, which is what search engines and SEO guides call it, and what it is for. */
const RELS: Record<LinkRel, { label: string; hint: string }> = {
  nofollow: { label: 'Nofollow', hint: 'don’t vouch for it' },
  sponsored: { label: 'Sponsored', hint: 'paid or affiliate' },
  ugc: { label: 'UGC', hint: 'written by visitors' }
};

/**
 * What a link to another site tells search engines about it (its rel): a tick for each relationship. Only web
 * addresses have these, so callers show it for them alone.
 */
export function LinkRelControls({ value, onChange }: { value: readonly string[] | undefined; onChange: (rel: LinkRel[]) => void }) {
  const on = canonicalRels(value);
  return (
    <fieldset className="link-rels">
      <legend>Tell search engines it is</legend>
      {LINK_RELS.map((t) => (
        <label key={t} className="link-rel">
          <input type="checkbox" checked={on.includes(t)} onChange={(e) => onChange(canonicalRels(e.target.checked ? [...on, t] : on.filter((x) => x !== t)))} />
          {RELS[t].label}
          <span>{RELS[t].hint}</span>
        </label>
      ))}
    </fieldset>
  );
}
