import './TagField.css';
import { useId, useMemo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ElementNode, OwnerRef, ProjectState, TextNode } from '@shared/types';
import { tagOptions } from '@engine/semantic-tags';
import { Field } from '../components/ui';
import { standingReason, tagSelectOptions, unavailableReasons } from '../lib/tag-options';

/** Where a heading's look is set, kept on one line. */
const LOOK = 'Change how it looks in Style\u00a0›\u00a0Text\u00a0style.';

/** What a heading's level does, said where it is chosen: the outline, not the look, which Text style sets. */
function headingNote(tag: string): string | null {
  if (tag === 'h1') return `The page’s title: use one per page. Sets the outline screen readers use, not the size. ${LOOK}`;
  if (/^h[2-6]$/.test(tag)) return `Sets the outline screen readers use, not the size: one level below the heading it sits under. ${LOOK}`;
  return null;
}

/**
 * The HTML tag of a container or plain text, as a select. Tags that don't fit where it sits (a list item outside a
 * list) are shown but can't be chosen; a fold under the select says why, since an open native menu shows no tooltips.
 */
export function TagField({ state, owner, node, onChange, label = 'Tag', hint }: { state: ProjectState; owner: OwnerRef; node: ElementNode | TextNode; onChange: (tag: string) => void; label?: string; hint?: string }) {
  const whyId = useId();
  const fits = useMemo(() => {
    try {
      return new Map(tagOptions(state, owner, node.id).map((o) => [o.tag, o.problem && standingReason(o.tag, o.problem, o.self, node.kind)]));
    } catch {
      return new Map<string, string | null>();
    }
  }, [state, owner.kind, owner.id, node.id, node.kind]);
  const { value, unknown, groups } = tagSelectOptions(node.kind, node.tag, fits);
  const reasons = unavailableReasons(groups);
  const blocked = groups.reduce((n, g) => n + g.options.filter((o) => o.problem).length, 0);
  // A tag from a hand-edited document is an error to put right; otherwise a heading says what its level does.
  const what = node.kind === 'text' ? 'this text' : 'this container';
  const error = unknown === null ? undefined : unknown ? `“${unknown}” isn’t a tag ${what} can use. Choose one from the list to replace it.` : 'This has no tag. Choose one from the list.';
  const heading = headingNote(value);
  const note: ReactNode = hint && heading ? `${hint} ${heading}` : (hint ?? heading ?? undefined);
  return (
    <div className="tag-field">
      <Field label={label} hint={note} error={error}>
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={reasons.length ? whyId : undefined}>
          {unknown !== null && (
            <option value={unknown} disabled>
              {unknown ? `Unsupported: ${unknown}` : 'No tag'}
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.tag} value={o.tag} disabled={!!o.problem} title={o.problem ?? undefined}>
                  {o.name} ({o.tag}){o.problem ? ' · can’t go here' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {reasons.length > 0 && (
        <details className="tag-why">
          <summary id={whyId}>
            <ChevronRight aria-hidden="true" />
            {blocked === 1 ? '1 tag can’t go here' : `${blocked} tags can’t go here`}
          </summary>
          <ul>
            {reasons.map((r) => (
              <li key={r.reason}>
                <span className="tag-why-names">{r.names.join(', ')}</span>
                <span className="tag-why-reason">{r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
