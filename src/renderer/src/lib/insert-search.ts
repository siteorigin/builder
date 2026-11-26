/**
 * The Insert panel's basic elements, and how its search finds and orders what it offers.
 */
import type { ComponentDefinition, DividerShape, ProjectState } from '@shared/types';

/** A basic element Insert adds. */
export type Primitive = 'container' | 'stack' | 'row' | 'grid' | 'heading' | 'paragraph' | 'richtext' | 'image' | 'button' | 'icon' | 'divider' | 'badge' | 'figure' | 'slot';

/**
 * What Insert adds. An element can start with its own text: a list's first items, in the rich text form. A Grid can
 * start with `columns` empty columns (Stacks), each ready to take content on the canvas, or with the cells of one of
 * the layout starters (`starter`). A divider can start as one of the decorative shapes. A slot's placeholder, in the
 * design of the component being edited, names the declared slot it shows (`bind`).
 */
export type InsertSpec = { componentId?: string; definitionId?: string; primitive?: Primitive; bind?: string; text?: string; columns?: number; starter?: LayoutStarter; shape?: DividerShape; variants?: Record<string, string>; /** A collection list: a Stack holding a loop over this collection's entries, each showing its title. */ loop?: string };

/**
 * A Grid that starts with uneven cells: a bento of a wide featured tile and a tall one, a main column beside a sidebar
 * pinned below the site header, or a wide column beside a narrow one. See insert-at's LAYOUT_STARTERS.
 */
export type LayoutStarter = 'bento' | 'sidebar' | 'split';

export interface Basic {
  id: string;
  primitive: Primitive;
  /** The element's first text: a list's starting items, in the rich text form. */
  text?: string;
  /** A Grid's empty columns, made with it. */
  columns?: number;
  /** A Grid's uneven empty cells, made with it. */
  starter?: LayoutStarter;
  /** A divider's shape, when it is one of the decorative bands. */
  shape?: DividerShape;
  /** Offered with the column layouts, near the top of Insert, rather than with the other basic elements. */
  layout?: boolean;
  name: string;
  icon: string;
  tags: string;
}

/**
 * Basic elements. A list is rich text that starts as a list, so its items are edited like any prose. The column
 * layouts lead: a Grid that starts with two or three empty columns, the uneven starters (a bento grid, a main column
 * beside a pinned sidebar, a wide-and-narrow split), then the Row and Grid to arrange content by hand.
 */
export const BASICS: Basic[] = [
  { id: 'columns-2', primitive: 'grid', columns: 2, name: '2 columns', icon: 'columns-2', tags: 'two columns 2-column two-column 2 col layout grid split side by side', layout: true },
  { id: 'columns-3', primitive: 'grid', columns: 3, name: '3 columns', icon: 'columns-3', tags: 'three columns 3-column three-column 3 col layout grid side by side', layout: true },
  { id: 'bento', primitive: 'grid', starter: 'bento', name: 'Bento grid', icon: 'layout-dashboard', tags: 'bento tiles featured tall feature grid asymmetric layout mosaic', layout: true },
  { id: 'sidebar', primitive: 'grid', starter: 'sidebar', name: 'Sidebar + main', icon: 'panel-right', tags: 'sidebar main content aside sticky pinned two columns 2-column layout asymmetric', layout: true },
  { id: 'split', primitive: 'grid', starter: 'split', name: 'Asymmetric split', icon: 'layout-panel-left', tags: 'asymmetric split uneven wide narrow 2:1 two columns 2-column layout side by side', layout: true },
  { id: 'row', primitive: 'row', name: 'Row', icon: 'align-horizontal-space-around', tags: 'horizontal container group side by side', layout: true },
  { id: 'grid', primitive: 'grid', name: 'Grid', icon: 'layout-grid', tags: 'columns container layout', layout: true },
  { id: 'heading', primitive: 'heading', name: 'Heading', icon: 'heading-1', tags: 'title text h1 h2' },
  { id: 'paragraph', primitive: 'paragraph', name: 'Paragraph', icon: 'pilcrow', tags: 'text copy body' },
  { id: 'bulleted-list', primitive: 'richtext', text: '- First item\n- Second item\n- Third item', name: 'Bulleted list', icon: 'list', tags: 'list bullets bullet points unordered ul items text' },
  { id: 'numbered-list', primitive: 'richtext', text: '1. First step\n2. Second step\n3. Third step', name: 'Numbered list', icon: 'list-ordered', tags: 'list numbers numbered ordered ol steps items text' },
  { id: 'button', primitive: 'button', name: 'Button', icon: 'rectangle-horizontal', tags: 'link action cta' },
  { id: 'image', primitive: 'image', name: 'Image', icon: 'image', tags: 'photo picture' },
  { id: 'stack', primitive: 'stack', name: 'Stack', icon: 'rows-3', tags: 'vertical container group' },
  { id: 'container', primitive: 'container', name: 'Container', icon: 'square-dashed', tags: 'box group' },
  { id: 'icon', primitive: 'icon', name: 'Icon', icon: 'star', tags: 'symbol' },
  { id: 'divider', primitive: 'divider', name: 'Divider', icon: 'separator-horizontal', tags: 'line rule separator' },
  { id: 'badge', primitive: 'badge', name: 'Badge', icon: 'tag', tags: 'pill label eyebrow tag chip kicker' },
  { id: 'figure', primitive: 'figure', name: 'Figure', icon: 'book-image', tags: 'image photo picture caption figcaption captioned' },
  { id: 'divider-angle', primitive: 'divider', shape: 'angle', name: 'Angled divider', icon: 'triangle-right', tags: 'divider shape band slant diagonal section edge separator decorative' },
  { id: 'divider-wave', primitive: 'divider', shape: 'wave', name: 'Wave divider', icon: 'waves-horizontal', tags: 'divider shape band curve curved section edge separator decorative' },
  { id: 'divider-icon', primitive: 'divider', shape: 'icon', name: 'Divider with icon', icon: 'diamond', tags: 'divider line rule separator ornament hairline decorative' }
];

/** What Insert adds for a basic element. */
export const basicSpec = (b: Basic): InsertSpec => ({ primitive: b.primitive, ...(b.text ? { text: b.text } : {}), ...(b.columns ? { columns: b.columns } : {}), ...(b.starter ? { starter: b.starter } : {}), ...(b.shape ? { shape: b.shape } : {}) });

/** How search reads a basic element: its name, its tags, and what it is. */
export const basicHay = (b: Basic) => `${b.name} ${b.tags} element`.toLowerCase();

/**
 * The project's own components that can be inserted, by name: the Insert panel, a + on the canvas and the command menu
 * all offer these. Not the shared header and footer, and code components only in Developer mode, as its setting says.
 */
export function projectInsertDefinitions(state: ProjectState, developerMode: boolean): ComponentDefinition[] {
  return Object.values(state.components)
    .filter((d) => d.owner === 'project' && d.category !== 'shell' && (developerMode || d.kind !== 'code'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Search: every word must match; exact names first, then names that start with the query, then names that contain
 * every word, then description and tag matches. Ties keep the panel's own order. Nothing for an empty query.
 * `shown` is the name an item shows (a section in Variants adds its option's name); its own name ranks it too.
 */
export function searchItems<T extends { name: string; hay: string }>(items: T[], q: string, shown: (it: T) => string = (it) => it.name): T[] {
  const query = q.toLowerCase().trim();
  if (!query) return [];
  const words = query.split(/\s+/).filter(Boolean);
  const rank = (it: T) => {
    const n = it.name.toLowerCase();
    const full = shown(it).toLowerCase();
    return n === query || full === query ? 0 : n.startsWith(query) || full.startsWith(query) ? 1 : words.every((w) => full.includes(w)) ? 2 : 3;
  };
  return items
    .filter((it) => words.every((w) => it.hay.includes(w)))
    .map((it, i) => ({ it, r: rank(it), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.it);
}
