/**
 * Shared fixtures for the container query tests (#667): a project Media Card that inserts as an element and stacks
 * in a narrow container, and a Home that places it in a wide and a narrow column twice, once in page columns and
 * once in the two slots of a project split layout.
 */
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { P } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';

/** A project component: the design given, owned by the project. */
function projectDef(def: ComponentDefinition, id: string, insertAs: 'section' | 'element'): ComponentDefinition {
  const { provenance: _theme, ...rest } = def;
  return { ...rest, id, owner: 'project', insertAs, provenance: { createdBy: 'user' } };
}

/**
 * A horizontal media card: a picture box beside its text on desktop, as a row for all sizes and again for desktop,
 * and stacked (picture above text) in a narrow container whatever the screen.
 */
export function mediaCard(): ComponentDefinition {
  return projectDef(
    FOUNDATION.managed({
      componentId: 'test.media-card',
      name: 'Media card',
      description: 'A picture beside its text.',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      properties: { title: P.str('Title', 'Night walks') },
      parts: { root: { nodeId: 'card', label: 'Card', styleControls: ['layout', 'gap', 'background'] } },
      build: (b) =>
        b.el('card', 'div', { name: 'Card', styles: { base: { layout: 'row', gap: '0px' }, desktop: { layout: 'row' }, 'cq-narrow': { layout: 'stack' } } }, [
          b.el('media', 'div', { name: 'Media', styles: { width: '160px', minHeight: '90px', flexShrink: 0 } }, []),
          b.text('title', 'h3', { $prop: 'title' }, { name: 'Title', styles: { flexGrow: 1, marginBlockStart: '0px', marginBlockEnd: '0px' } })
        ])
    }),
    'project.media-card',
    'element'
  );
}

/** A two-column layout whose wide and narrow columns are each a query container around a slot. */
export function splitLayout(): ComponentDefinition {
  return projectDef(
    FOUNDATION.managed({
      componentId: 'test.split',
      name: 'Split',
      description: 'A wide main column beside a narrow sidebar.',
      category: 'layout',
      tags: [],
      icon: 'columns-2',
      properties: {},
      slots: { main: { label: 'Main' }, side: { label: 'Sidebar' } },
      parts: { root: { nodeId: 'split', label: 'Split', styleControls: ['gridTemplate'] } },
      build: (b) =>
        b.el('split', 'section', { name: 'Split', styles: { layout: 'grid', gridTemplate: '2fr 1fr', gap: '0px', width: '1200px', paddingInline: '0px', paddingBlock: '0px' } }, [
          b.el('main', 'div', { name: 'Main', styles: { layout: 'stack', containerType: 'inline-size' } }, [b.slot('main-slot', 'main', { name: 'Main' })]),
          b.el('side', 'div', { name: 'Sidebar', styles: { layout: 'stack', containerType: 'inline-size' } }, [b.slot('side-slot', 'side', { name: 'Sidebar' })])
        ])
    }),
    'project.split',
    'section'
  );
}

export interface ContainerSite {
  s: ProjectState;
  card: ComponentDefinition;
  split: ComponentDefinition;
  /** The page's own columns and the cards in them. */
  columns: { grid: ElementNode; main: ElementNode; side: ElementNode; mainCard: InstanceNode; sideCard: InstanceNode };
  /** The split layout placement and the cards in its slots. */
  slotted: { split: InstanceNode; mainCard: InstanceNode; sideCard: InstanceNode };
}

/**
 * Home holds, in order: a page grid of a 2fr and a 1fr column (each a query container) with the same card in each,
 * and a placement of the split layout with the same card in each slot. Both are 1200px wide with no gap, so at a
 * 1280px screen the wide columns are 800px and the narrow ones 400px.
 */
export function containerSite(): ContainerSite {
  const s = createStarterState('blank', 'Container Studio', false);
  const card = mediaCard();
  const split = splitLayout();
  s.components[card.id] = card;
  s.components[split.id] = split;
  const home = s.pages[s.site.homePageId];
  const place = (node: ElementNode | InstanceNode, root = false) => {
    home.nodes[node.id] = node;
    if (root) home.rootIds.push(node.id);
    return node;
  };
  const mainCard = place(makeInstance(card, { title: 'Main column' })) as InstanceNode;
  const sideCard = place(makeInstance(card, { title: 'Sidebar column' })) as InstanceNode;
  const main = place({ id: 'n_main', kind: 'element', tag: 'div', children: [mainCard.id], styles: { base: { layout: 'stack', containerType: 'inline-size' } } }) as ElementNode;
  const side = place({ id: 'n_side', kind: 'element', tag: 'div', children: [sideCard.id], styles: { base: { layout: 'stack', containerType: 'inline-size' } } }) as ElementNode;
  const grid = place({ id: 'n_grid', kind: 'element', tag: 'div', children: [main.id, side.id], styles: { base: { layout: 'grid', gridTemplate: '2fr 1fr', gap: '0px', width: '1200px' } } }, true) as ElementNode;
  const slotMain = place(makeInstance(card, { title: 'Main slot' })) as InstanceNode;
  const slotSide = place(makeInstance(card, { title: 'Sidebar slot' })) as InstanceNode;
  const placed = makeInstance(split, {});
  placed.slots = { main: [slotMain.id], side: [slotSide.id] };
  place(placed, true);
  return { s, card, split, columns: { grid, main, side, mainCard, sideCard }, slotted: { split: placed, mainCard: slotMain, sideCard: slotSide } };
}
