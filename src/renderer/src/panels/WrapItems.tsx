import type { ReactNode } from 'react';
import { Columns3, LayoutGrid, Rows3, Ungroup } from 'lucide-react';
import type { MenuItem } from '../components/ui';
import { WRAP_NAMES, wrapOffers, type LayersPlan, type WrapKind } from '../lib/actions';

/** The icons Layers shows for each kind of container. */
const ICONS: Record<WrapKind, ReactNode> = { stack: <Rows3 />, row: <Columns3 />, grid: <LayoutGrid /> };

/**
 * Wrap in Stack, Row or Grid, and Ungroup, for the layers a menu names (`plan`; see wrapOffers), the same in Canvas,
 * Layers and the Inspector. `count` names layers selected together ("Wrap 2 layers in Row"), so the menu says what it
 * acts on, as Duplicate and Delete do there.
 */
export function wrapItems(plan: LayersPlan | null, act: { wrap: (kind: WrapKind) => void; ungroup: () => void }, count?: string): MenuItem[] {
  const offers = wrapOffers(plan);
  const what = count ? ` ${count}` : '';
  return [
    ...(offers.wrap
      ? (['stack', 'row', 'grid'] as const).map((k): MenuItem => ({ label: `Wrap${what} in ${WRAP_NAMES[k]}`, icon: ICONS[k], ...(k === 'stack' ? { shortcut: '⌘G' } : {}), onSelect: () => act.wrap(k) }))
      : []),
    ...(offers.ungroup ? [{ label: count ? `Ungroup${what}` : 'Ungroup', icon: <Ungroup />, shortcut: '⇧⌘G', onSelect: act.ungroup }] : [])
  ];
}

/** Menu items after a separator, or nothing when there are none. */
export const withSeparator = (items: MenuItem[]): MenuItem[] => (items.length ? [{ separator: true }, ...items] : []);
