/**
 * The designs a placed component can change to (Change section design…, #374): what Insert offers where it is, the
 * theme's sections (or, for a block, its blocks) or the project's own components, less the design it already shows.
 * Designs of the same kind (one hero for another) come first, since their content matches best.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { swapTarget } from '@engine/swap';
import { definitionRole } from './insert-at';
import { quickItems } from './inline-insert';

export interface SwapChoice {
  key: string;
  name: string;
  /** "Similar sections", "Other sections", "Similar blocks", "Other blocks" or "Your components". */
  group: string;
  spec: { componentId: string } | { definitionId: string };
  /** The definition it would show: installed, or the theme's as it would be installed. */
  def: ComponentDefinition;
  /** What it is pictured as: a theme section by its sketch, a theme block by its icon, the project's own by its thumbnail. */
  kind: 'section' | 'block' | 'component';
  /** A theme design's Lucide icon name. */
  icon?: string;
}

export function swapChoices(state: ProjectState, node: InstanceNode, dev = false): SwapChoice[] {
  const source = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!source || source.category === 'shell') return [];
  const out: SwapChoice[] = [];
  for (const it of quickItems(state, definitionRole(state, source.id), dev)) {
    if (it.spec.primitive) continue;
    const spec = it.spec.componentId !== undefined ? { componentId: it.spec.componentId } : it.spec.definitionId !== undefined ? { definitionId: it.spec.definitionId } : null;
    const def = spec ? swapTarget(state, spec) : undefined;
    if (!spec || !def || def.id === source.id || def.category === 'shell') continue;
    const similar = def.category === source.category && def.category !== 'custom';
    const kind = it.kind === 'block' ? 'blocks' : 'sections';
    out.push({ key: it.key, name: it.name, group: it.kind === 'component' ? 'Your components' : similar ? `Similar ${kind}` : `Other ${kind}`, spec, def, kind: it.kind === 'component' ? 'component' : it.kind === 'block' ? 'block' : 'section', icon: it.icon });
  }
  const rank = (c: SwapChoice) => (c.group.startsWith('Similar ') ? 0 : c.group === 'Your components' ? 1 : 2);
  return out.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c);
}
