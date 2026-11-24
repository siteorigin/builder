import type { ListItem, ListProp, PropSchema, ScalarPropSchema } from './types';

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export interface PropGroup<T> {
  /** Heading for fields that belong together ("Primary button"), or none for a field that stands alone. */
  title?: string;
  items: Array<{ key: string; schema: PropSchema | ScalarPropSchema; label?: string; data: T }>;
}

/**
 * Group content fields the way they appear on the page. A schema's own `group` wins; otherwise a text field
 * named "X label" followed by a link named "X link" (or just "Link") is one thing on the page, a button or a
 * link, so it becomes a group "X" with fields "Label" and "Link". Everything else stays in schema order.
 */
export function groupFields<T>(entries: Array<{ key: string; schema: PropSchema | ScalarPropSchema; data: T }>): Array<PropGroup<T>> {
  const out: Array<PropGroup<T>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const g = e.schema.group;
    if (g) {
      const last = out[out.length - 1];
      if (last?.title === g) last.items.push({ ...e, label: shorten(e.schema.label, g) });
      else out.push({ title: g, items: [{ ...e, label: shorten(e.schema.label, g) }] });
      continue;
    }
    const next = entries[i + 1];
    const m = /^(.*) label$/i.exec(e.schema.label);
    if (m && e.schema.type === 'string' && next && next.schema.type === 'link' && !next.schema.group) {
      const prefix = m[1];
      const nl = next.schema.label.toLowerCase();
      if (nl === `${prefix} link`.toLowerCase() || nl === 'link') {
        out.push({ title: prefix, items: [{ ...e, label: 'Label' }, { ...next, label: prefix.toLowerCase() === 'link' ? 'Destination' : 'Link' }] });
        i++;
        continue;
      }
    }
    out.push({ items: [e] });
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
