import { LINK_RELS, type LinkRel } from '@shared/types';
import { canonicalRels } from '@shared/link-rel';

/** Each relationship by what it means first, then by the name search engines and SEO guides give it. */
export const LINK_REL_LABELS: Record<LinkRel, { label: string; term: string }> = {
  nofollow: { label: 'Not vouched for', term: 'nofollow' },
  sponsored: { label: 'Paid or affiliate', term: 'sponsored' },
  ugc: { label: 'Added by visitors', term: 'UGC' }
};

/**
 * What a link to another site tells search engines about it (its rel): a tick for each relationship, each row a
 * 24px target. Only web addresses have these, so callers show it for them alone.
 */
export function LinkRelControls({ value, onChange }: { value: readonly string[] | undefined; onChange: (rel: LinkRel[]) => void }) {
  const on = canonicalRels(value);
  return (
    <fieldset className="link-rels">
      <legend>Tell search engines this link is</legend>
      {LINK_RELS.map((t) => (
        <label key={t} className="link-rel">
          <input type="checkbox" checked={on.includes(t)} onChange={(e) => onChange(canonicalRels(e.target.checked ? [...on, t] : on.filter((x) => x !== t)))} />
          <span>
            {LINK_REL_LABELS[t].label} <span className="link-rel-term">({LINK_REL_LABELS[t].term})</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
