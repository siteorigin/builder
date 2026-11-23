import type { LinkValue, OwnerRef, PropSchema, ProjectState } from '@shared/types';
import { labelKeyFor } from '@generator/checks';
import { allTrees } from './tree';
import { effectiveItem } from '@shared/page-teasers';

/** A stored link to a page: what it is called and where it lives, for reviewing what a change to that page moves. */
export interface PageLinkUse {
  /** The stored value itself: changing it changes the link. */
  link: LinkValue;
  /** The header, footer, page or component that holds it. */
  owner: OwnerRef;
  /** That holder by name: Header, Footer, a page's title or a component's name. */
  where: string;
  /** The link's text, its paired label, its list item's title, or else the name of the field that holds it. */
  label: string;
  /**
   * For a card in a page list (a list item that stands for this page): the list that holds it. Deleting the page
   * takes the card out of that list rather than pointing it at another page.
   */
  card?: { items: unknown[]; item: object };
}

const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Every stored link to `pageId` from the rest of the site: shared header and footer, other pages, component trees and
 * component defaults, links inside rich text included. Links on the page itself go with it, so they are not listed.
 * One row per stored value, so an edit to the rows changes exactly the links the site holds.
 */
export function pageLinkUses(state: ProjectState, pageId: string): PageLinkUse[] {
  const out: PageLinkUse[] = [];
  const seen = new Set<object>();
  const isTarget = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && (v as LinkValue).type === 'page' && (v as LinkValue).target === pageId;
  const add = (link: LinkValue, owner: OwnerRef, where: string, label: string, card?: PageLinkUse['card']) => {
    if (seen.has(link)) return;
    seen.add(link);
    out.push(card ? { link, owner, where, label, card } : { link, owner, where, label });
  };
  /** Leave out every link to the page inside a value (a card that goes with the page). */
  const skip = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(skip);
    if (!x || typeof x !== 'object') return;
    if (isTarget(x)) seen.add(x);
    Object.values(x).forEach(skip);
  };
  /** Every link in a value; one inside rich text is named by its own text. */
  const collect = (v: unknown, owner: OwnerRef, where: string, label: string) => {
    const walk = (x: unknown, parent?: Record<string, unknown>) => {
      if (Array.isArray(x)) return x.forEach((y) => walk(y));
      if (!x || typeof x !== 'object') return;
      if (isTarget(x)) add(x, owner, where, (parent?.link === x && text(parent.text)) || label);
      for (const y of Object.values(x)) walk(y, x as Record<string, unknown>);
    };
    walk(v);
  };
  /** Property values named the way the generated components show them: by a paired label, or by a list item's title. */
  const props = (values: Record<string, unknown>, schemas: Record<string, PropSchema>, owner: OwnerRef, where: string) => {
    for (const [key, value] of Object.entries(values)) {
      const schema = Object.hasOwn(schemas, key) ? schemas[key] : undefined;
      const labelKey = labelKeyFor(key);
      const paired = Object.hasOwn(values, labelKey) ? values[labelKey] : Object.hasOwn(schemas, labelKey) ? schemas[labelKey].default : undefined;
      const name = text(paired) || schema?.label || key;
      if (schema?.type !== 'list' || !Array.isArray(value)) {
        collect(value, owner, where, name);
        continue;
      }
      for (const item of value as Array<Record<string, unknown>>) {
        if (!item || typeof item !== 'object') continue;
        // A page list's card is named by the title it shows, its page's own when it has none.
        const shown = effectiveItem(state, schema, item);
        const title = text(shown[schema.titleField ?? 'label']) || schema.itemLabel || name;
        const teaser = schema.pageTeaser;
        if (teaser && isTarget(item[teaser.link])) {
          add(item[teaser.link] as LinkValue, owner, where, title, { items: value as unknown[], item });
          // Any other link to the page inside that card goes with the card: it needs nowhere else to point.
          skip(item);
          continue;
        }
        // A field's own label ("Book a visit" for a card's link) names it before the item's title does.
        for (const f of Object.keys(schema.fields)) {
          const fieldLabel = labelKeyFor(f);
          collect(item[f], owner, where, (Object.hasOwn(schema.fields, fieldLabel) && text(item[fieldLabel])) || title);
        }
        collect(item, owner, where, title);
      }
    }
  };
  for (const { owner, tree, label: where } of allTrees(state)) {
    if (owner.kind === 'page' && owner.id === pageId) continue;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind === 'link' && isTarget(n.link)) add(n.link, owner, where, text(n.label) || n.name || 'Button');
      if (n.kind === 'instance') {
        const def = state.components[n.definitionId];
        props(n.props, def?.properties ?? {}, owner, where);
      }
      collect(n, owner, where, n.name ?? 'Link');
    }
  }
  for (const def of Object.values(state.components)) {
    const owner: OwnerRef = { kind: 'component', id: def.id };
    const where = `${def.name} (default)`;
    props(Object.fromEntries(Object.entries(def.properties).map(([k, s]) => [k, s.default])), def.properties, owner, where);
    collect(def.properties, owner, where, def.name);
  }
  for (const p of Object.values(state.pages)) if (p.id !== pageId) collect(p.seo, { kind: 'page', id: p.id }, p.title, 'Page settings');
  return out;
}
