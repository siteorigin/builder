import { useMemo } from 'react';
import type { ElementNode, OwnerRef, ProjectState, TextNode } from '@shared/types';
import { tagOptions } from '@engine/semantic-tags';
import { Field } from '../components/ui';
import { tagSelectOptions } from '../lib/tag-options';

/**
 * The HTML tag of a container or plain text, as a select. Tags that don't fit where it sits (a list item outside a
 * list) are shown but can't be chosen, and say why.
 */
export function TagField({ state, owner, node, onChange, label = 'Tag', hint }: { state: ProjectState; owner: OwnerRef; node: ElementNode | TextNode; onChange: (tag: string) => void; label?: string; hint?: string }) {
  const fits = useMemo(() => {
    try {
      return new Map(tagOptions(state, owner, node.id).map((o) => [o.tag, o.problem]));
    } catch {
      return new Map<string, string | null>();
    }
  }, [state, owner.kind, owner.id, node.id]);
  const { value, unknown, groups } = tagSelectOptions(node.kind, node.tag, fits);
  const blocked = groups.some((g) => g.options.some((o) => o.problem));
  return (
    <Field label={label} hint={[hint, blocked ? 'Tags marked “not here” don’t fit where this sits: a list item needs a list around it, a paragraph holds only inline content.' : ''].filter(Boolean).join(' ') || undefined}>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {unknown !== null && (
          <option value={unknown} disabled>
            Unsupported tag ({unknown || 'none'})
          </option>
        )}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.tag} value={o.tag} disabled={!!o.problem} title={o.problem ?? undefined}>
                {o.name} ({o.tag}){o.problem ? ' · not here' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
