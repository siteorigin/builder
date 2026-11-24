import type { AppearPreset, ElementNode, InstanceNode, OwnerRef, RepeatNode } from '@shared/types';
import { APPEAR_PRESETS, isAppearPreset } from '@shared/types';
import { applyOps } from '../store';
import { Field, SwitchRow } from '../components/ui';

/** Each entrance as the Inspector names it. */
export const APPEAR_LABELS: Record<AppearPreset, string> = { fade: 'Fade in', lift: 'Lift in', 'scale-subtle': 'Subtle scale' };

/** The entrance a node shows, in words for a section's summary line ("Lift in"), or nothing. */
export function appearSummary(node: ElementNode | InstanceNode, design?: AppearPreset): string | undefined {
  if (node.appear === 'none') return undefined;
  // A value the editor does not know (a hand-edited file) is no entrance: the site ignores it too.
  const own = isAppearPreset(node.appear) ? node.appear : design;
  return own ? APPEAR_LABELS[own] : undefined;
}

const HINT = 'Plays the first time it scrolls into view. Without JavaScript, in print and for visitors who ask for reduced motion, it simply shows.';

/**
 * How a section or container enters when it first scrolls into view. A section (a placement) can follow its design's
 * own entrance (`design`), choose another, or turn it off; a container has one or none.
 */
export function EntranceField({ owner, node, design }: { owner: OwnerRef; node: ElementNode | InstanceNode; design?: AppearPreset }) {
  const set = (value: string) =>
    void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'appear', value: value || null }], value && value !== 'none' ? 'Set entrance' : value ? 'Turn entrance off' : 'Clear entrance');
  const placement = node.kind === 'instance';
  const value = node.appear === 'none' || isAppearPreset(node.appear) ? node.appear : '';
  return (
    <Field label="Entrance" hint={HINT}>
      <select className="select" value={value} onChange={(e) => set(e.target.value)}>
        {placement && (design || value === 'none') ? (
          <>
            <option value="">Design’s own ({design ? APPEAR_LABELS[design].toLowerCase() : 'none'})</option>
            <option value="none">None</option>
          </>
        ) : (
          <option value="">None</option>
        )}
        {APPEAR_PRESETS.map((p) => (
          <option key={p} value={p}>
            {APPEAR_LABELS[p]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** For a list in a component's design: whether items that come into view together enter one after another. */
export function StaggerSwitch({ owner, node }: { owner: OwnerRef; node: RepeatNode }) {
  return (
    <SwitchRow
      checked={node.appearStagger === true}
      label="Stagger item entrances"
      hint="Items that come into view together start their entrances one after another. Give the item an entrance for this to show."
      onChange={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'appearStagger', value: v }], v ? 'Stagger entrances' : 'Stop staggering entrances')}
    />
  );
}
