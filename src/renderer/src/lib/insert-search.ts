/**
 * The Insert panel's basic elements, and how its search finds and orders what it offers.
 */
/** A basic element Insert adds. */
export type Primitive = 'container' | 'stack' | 'row' | 'grid' | 'heading' | 'paragraph' | 'richtext' | 'image' | 'button' | 'icon' | 'divider';

/** What Insert adds. An element can start with its own text: a list's first items, in the rich text form. */
export type InsertSpec = { componentId?: string; definitionId?: string; primitive?: Primitive; text?: string; variants?: Record<string, string> };

export interface Basic {
  id: string;
  primitive: Primitive;
  /** The element's first text: a list's starting items, in the rich text form. */
  text?: string;
  name: string;
  icon: string;
  tags: string;
}

/** Basic elements. A list is rich text that starts as a list, so its items are edited like any prose. */
export const BASICS: Basic[] = [
  { id: 'heading', primitive: 'heading', name: 'Heading', icon: 'heading-1', tags: 'title text h1 h2' },
  { id: 'paragraph', primitive: 'paragraph', name: 'Paragraph', icon: 'pilcrow', tags: 'text copy body' },
  { id: 'bulleted-list', primitive: 'richtext', text: '- First item\n- Second item\n- Third item', name: 'Bulleted list', icon: 'list', tags: 'list bullets bullet points unordered ul items text' },
  { id: 'numbered-list', primitive: 'richtext', text: '1. First step\n2. Second step\n3. Third step', name: 'Numbered list', icon: 'list-ordered', tags: 'list numbers numbered ordered ol steps items text' },
  { id: 'button', primitive: 'button', name: 'Button', icon: 'rectangle-horizontal', tags: 'link action cta' },
  { id: 'image', primitive: 'image', name: 'Image', icon: 'image', tags: 'photo picture' },
  { id: 'stack', primitive: 'stack', name: 'Stack', icon: 'rows-3', tags: 'vertical container group' },
  { id: 'row', primitive: 'row', name: 'Row', icon: 'columns-3', tags: 'horizontal container group' },
  { id: 'grid', primitive: 'grid', name: 'Grid', icon: 'layout-grid', tags: 'columns container' },
  { id: 'container', primitive: 'container', name: 'Container', icon: 'square-dashed', tags: 'box group' },
  { id: 'icon', primitive: 'icon', name: 'Icon', icon: 'star', tags: 'symbol' },
  { id: 'divider', primitive: 'divider', name: 'Divider', icon: 'separator-horizontal', tags: 'line rule separator' }
];

/** What Insert adds for a basic element. */
export const basicSpec = (b: Basic): InsertSpec => ({ primitive: b.primitive, ...(b.text ? { text: b.text } : {}) });

/** How search reads a basic element: its name, its tags, and what it is. */
export const basicHay = (b: Basic) => `${b.name} ${b.tags} element`.toLowerCase();

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
