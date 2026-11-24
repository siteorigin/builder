import type { ListItem, ListProp, PropSchema, ScalarPropSchema } from './types';

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

type FieldEntry<T> = { key: string; schema: PropSchema | ScalarPropSchema; data: T };

export interface PropGroup<T> {
  /** Heading for fields that belong together ("Primary button"), or none for a field that stands alone. */
  title?: string;
  /** Every field of the group, in order, each with the label it shows under (when shorter than its own). */
  items: Array<FieldEntry<T> & { label?: string }>;
  /**
   * A declared group's fields as they are drawn inside it, when some of them belong together again (the label and
   * link of one button in "Actions"). The same fields as `items`, in the same order.
   */
  groups?: Array<PropGroup<T>>;
}

/**
 * Group content fields the way they appear on the page. Consecutive fields that declare the same `group` are one
 * group under that heading. Otherwise a text field named "X label" followed by a link named "X link" (or just
 * "Link") is one thing on the page, a button or a link, so it becomes a group "X" with fields "Label" and "Link";
 * inside a declared group the same pair is a group of its own within it. Everything else stays in schema order.
 */
export function groupFields<T>(entries: Array<FieldEntry<T>>): Array<PropGroup<T>> {
  const out: Array<PropGroup<T>> = [];
  for (let i = 0; i < entries.length; ) {
    const g = entries[i].schema.group;
    if (!g) {
      const run: Array<FieldEntry<T>> = [];
      while (i < entries.length && !entries[i].schema.group) run.push(entries[i++]);
      out.push(...pairFields(run));
      continue;
    }
    const run: Array<FieldEntry<T>> = [];
    while (i < entries.length && entries[i].schema.group === g) run.push(entries[i++]);
    const inner = pairFields(run, g);
    const items = inner.flatMap((x) => x.items);
    out.push(inner.some((x) => x.title) ? { title: g, items, groups: inner } : { title: g, items });
  }
  return out;
}

/** Fields paired up as buttons and links; inside the declared group `within`, labels that repeat its name shorten. */
function pairFields<T>(entries: Array<FieldEntry<T>>, within?: string): Array<PropGroup<T>> {
  const out: Array<PropGroup<T>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const short = within ? shorten(e.schema.label, within) : undefined;
    const next = entries[i + 1];
    const m = /^(.*) label$/i.exec(e.schema.label);
    // A pair named after the group itself ("Action label" in "Action") is the group: its fields just shorten.
    if (m && e.schema.type === 'string' && next && next.schema.type === 'link' && !(within && m[1].toLowerCase() === within.toLowerCase())) {
      const prefix = m[1];
      const nl = next.schema.label.toLowerCase();
      if (nl === `${prefix} link`.toLowerCase() || nl === 'link') {
        out.push({ title: prefix, items: [{ ...e, label: 'Label' }, { ...next, label: prefix.toLowerCase() === 'link' ? 'Destination' : 'Link' }] });
        i++;
        continue;
      }
    }
    out.push({ items: [short ? { ...e, label: short } : e] });
  }
  return out;
}

function shorten(label: string, group: string): string | undefined {
  if (!label.toLowerCase().startsWith(group.toLowerCase() + ' ')) return undefined;
  return sentence(label.slice(group.length + 1));
}

/**
 * The title a list row shows in the Inspector: its title field, else its first text, else the name of the image it
 * shows (`imageName`, see listItemImage), else "Item 3". A page list's card is passed as it shows (`effectiveItem`),
 * so one with no title of its own is named by its page's.
 */
export function listRowTitle(schema: Pick<ListProp, 'titleField' | 'itemLabel'>, item: ListItem, index: number, imageName?: string): string {
  const t = schema.titleField ? item[schema.titleField] : Object.values(item).find((v) => typeof v === 'string' && v && v !== item.id);
  return (typeof t === 'string' && t.trim()) || imageName?.trim() || `${schema.itemLabel} ${index + 1}`;
}

/** The library image a list item shows: the first of its image fields that holds an image still in `assets`. */
export function listItemImage<A extends { kind: string }>(schema: Pick<ListProp, 'fields'>, item: ListItem, assets: Record<string, A>): A | undefined {
  for (const [k, f] of Object.entries(schema.fields)) {
    if (f.type !== 'image') continue;
    const id = (item[k] as { assetId?: unknown } | null | undefined)?.assetId;
    const asset = typeof id === 'string' && Object.hasOwn(assets, id) ? assets[id] : undefined;
    if (asset?.kind === 'image') return asset;
  }
  return undefined;
}
