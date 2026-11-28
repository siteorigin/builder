/**
 * The layout a collection's entries start with (#1319): records (structured collections) start with a page of their
 * own fields and no blog byline, while articles keep the theme's article layout; a records layout nobody has edited
 * keeps up with the collection's fields, text, kind and theme, and an edited one is the author's.
 */
import { describe, expect, it } from 'vitest';
import type { ElementNode, GraphNode, LinkNode, NodeTree, ProjectState, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { isDefaultLayout, themeArticleTemplate } from '@engine/collection-layouts';
import { generateProject, publishedState } from '@generator/index';
import { entryNeighbours, materializeTemplate } from '@generator/entry-template';
import { entryFieldValue } from '@shared/entry-fields';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const site = (theme?: string) => createStarterState('business', 'Riverside Studio', false, theme);
const nodes = (t: NodeTree) => Object.values(t.nodes);
/** The entry fields a layout reads anywhere. */
const reads = (t: NodeTree) => new Set([...JSON.stringify(t.nodes).matchAll(/"\$entry":"([^"]+)"/g)].map((m) => m[1]));
const named = (t: NodeTree, name: string) => nodes(t).find((n) => n.name === name);
/** A layout as it shows, without its node IDs: names and kinds in reading order. */
function outline(t: NodeTree): string[] {
  const out: string[] = [];
  const visit = (id: string, depth: number) => {
    const n = t.nodes[id];
    out.push(`${'  '.repeat(depth)}${n.name ?? n.kind}`);
    for (const c of (n as { children?: string[] }).children ?? []) visit(c, depth + 1);
  };
  t.rootIds.forEach((id) => visit(id, 0));
  return out;
}

const FIELDS = {
  price: { type: 'string', label: 'Guide price', default: '' },
  bedrooms: { type: 'number', label: 'Bedrooms', default: 0 },
  status: { type: 'enum', label: 'Availability', default: 'for-sale', options: [{ value: 'for-sale', label: 'For sale' }, { value: 'under-offer', label: 'Under offer' }] },
  pool: { type: 'boolean', label: 'Swimming pool', default: false },
  brochure: { type: 'link', label: 'Brochure', default: { type: 'none', target: '' } },
  highlights: { type: 'richtext', label: 'Highlights', default: [] },
  plan: { type: 'image', label: 'Floor plan', default: { assetId: null, alt: '' } }
} as const;

/** A Properties collection made as the Content tab makes records: the collection, then its fields, then a property. */
function properties(s = site(), ops: { hasBody?: boolean } = {}) {
  return run(
    s,
    { type: 'collection.create', collectionId: 'properties', name: 'Properties', kind: 'structured', hasBody: ops.hasBody ?? true, pages: { detail: true, archive: true }, route: '/properties/' },
    { type: 'collection.update', collectionId: 'properties', fields: structuredClone(FIELDS) as never },
    {
      type: 'entry.create',
      collectionId: 'properties',
      entryId: 'en_bastide',
      title: 'Bastide de Lourmarin',
      draft: false,
      publishedAt: '2026-10-20',
      excerpt: 'A bastide in the Luberon.',
      ...(ops.hasBody === false ? {} : { body: ['Approached along an avenue of cypresses.'] }),
      values: { price: '€4,200,000', bedrooms: 12500, status: 'under-offer', pool: true, brochure: { type: 'url', target: 'https://example.com/b.pdf' } }
    }
  );
}

describe('a records layout', () => {
  it('starts without the blog byline and with every field of the collection, each a block named after it', () => {
    const s = properties();
    const t = s.collections.properties.settings.template;
    const fields = reads(t);
    for (const byline of ['publishedAt', 'updatedAt', 'author', 'readingTime']) expect(fields.has(byline)).toBe(false);
    for (const f of Object.keys(FIELDS)) expect(fields.has(`field.${f}`)).toBe(true);
    expect([...fields]).toEqual(expect.arrayContaining(['title', 'excerpt', 'featuredImage', 'body', 'prevEntry', 'nextEntry']));
    // The facts are one description list in the byline's place, under the name and summary: a div per fact holding
    // its term and its description, shown only when the record has a value.
    const details = named(t, 'Details') as ElementNode;
    expect(details).toMatchObject({ kind: 'element', tag: 'dl', collapseEmpty: true });
    const column = nodes(t).find((n) => (n as ElementNode).children?.includes(details.id)) as ElementNode;
    expect(column.children.map((id) => t.nodes[id].name)).toEqual(['Category', 'Title', 'Excerpt', 'Details', 'Features', 'Links']);
    expect(details.children.map((id) => t.nodes[id].name)).toEqual(['Guide price', 'Bedrooms', 'Availability']);
    const row = t.nodes[details.children[0]] as ElementNode;
    expect(row).toMatchObject({ tag: 'div', when: { $entry: 'field.price' } });
    expect(row.children.map((id) => (t.nodes[id] as TextNode).tag)).toEqual(['dt', 'dd']);
    expect(t.nodes[row.children[0]]).toMatchObject({ text: 'Guide price' });
    expect(t.nodes[row.children[1]]).toMatchObject({ text: { $entry: 'field.price' } });
    // A yes/no field shows its name while it holds; a link field is a button named after it.
    expect(named(t, 'Swimming pool')).toMatchObject({ tag: 'li', when: { $entry: 'field.pool' } });
    expect(named(t, 'Brochure') as LinkNode).toMatchObject({ kind: 'link', label: 'Brochure', link: { $entry: 'field.brochure' }, when: { $entry: 'field.brochure' } });
    // Its pictures go with the featured one, its rich text after the text, under its own heading.
    const reading = nodes(t).find((n) => (n as ElementNode).children?.includes(named(t, 'Floor plan')!.id)) as ElementNode;
    expect(reading.children.map((id) => t.nodes[id].name)).toEqual(['Featured image', 'Floor plan', 'Text', 'Highlights']);
    expect(validateState(s).filter((d) => d.owner?.kind === 'template' && d.severity !== 'info')).toEqual([]);
    expect(isDefaultLayout(s, s.collections.properties.settings)).toBe(true);
  });

  it('publishes a record with its facts as the author wrote them, and no date or reading time', () => {
    const s = properties();
    const c = s.collections.properties;
    const page = materializeTemplate(s, c, c.entries.en_bastide, entryNeighbours(s, 'properties', 'en_bastide'));
    const shown = JSON.stringify(page.nodes);
    // A choice shows its option's label, a number is written as the site's language writes it.
    expect(shown).toContain('"text":"Under offer"');
    expect(shown).toContain('"text":"12,500"');
    expect(shown).not.toContain('min read');
    expect(shown).not.toContain('October 20, 2026');
    // A condition and a placed section's choice still read the value the field stores.
    const read = { state: s, collection: c, entry: c.entries.en_bastide, neighbours: {} };
    expect(entryFieldValue(read, 'field.status', 'raw')).toBe('under-offer');
    expect(entryFieldValue(read, 'field.bedrooms', 'raw')).toBe(12500);
    // A year stays a year.
    expect(entryFieldValue({ ...read, entry: { ...c.entries.en_bastide, values: { bedrooms: 1785 } } }, 'field.bedrooms')).toBe('1785');
    const html = generateProject(publishedState(s)).get('src/routes/properties/bastide-de-lourmarin/+page.svelte')!;
    expect(html).toContain('<dl');
    expect(html).toContain('Under offer');
    expect(html).not.toContain('under-offer');
  });

  it('leaves out the text for records without any, and its containers collapse when a record has nothing in them', () => {
    const s = properties(site(), { hasBody: false });
    const t = s.collections.properties.settings.template;
    expect(reads(t).has('body')).toBe(false);
    expect(nodes(t).filter((n): n is ElementNode => n.kind === 'element' && n.children.length > 0).every((n) => n.collapseEmpty)).toBe(true);
    // A data-only collection of records starts with one too, for when it has pages.
    const team = run(site(), { type: 'collection.create', collectionId: 'team', kind: 'structured', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' } } });
    expect(outline(team.collections.team.settings.template).join('\n')).toContain('Role');
  });

  it('keeps up with the collection while nobody has edited it', () => {
    let s = properties();
    // A field added later is shown; one removed goes with its block, with no "unbind it first".
    const { bedrooms: _bedrooms, ...kept } = structuredClone(FIELDS);
    s = run(s, { type: 'collection.update', collectionId: 'properties', fields: { ...kept, era: { type: 'string', label: 'Era', default: '' } } as never });
    let t = s.collections.properties.settings.template;
    expect(reads(t).has('field.era')).toBe(true);
    expect(reads(t).has('field.bedrooms')).toBe(false);
    expect(isDefaultLayout(s, s.collections.properties.settings)).toBe(true);
    // A renamed field is shown under its new name.
    s = run(s, { type: 'collection.update', collectionId: 'properties', fields: { ...structuredClone(s.collections.properties.settings.fields), era: { type: 'string', label: 'Period', default: '' } } as never });
    t = s.collections.properties.settings.template;
    expect(named(t, 'Period')).toBeDefined();
    expect(named(t, 'Era')).toBeUndefined();
    // Text turned off leaves the layout without it, instead of being refused.
    s = run(s, { type: 'entry.update', collectionId: 'properties', entryId: 'en_bastide', body: [] }, { type: 'collection.update', collectionId: 'properties', hasBody: false });
    expect(reads(s.collections.properties.settings.template).has('body')).toBe(false);
    // Made an article collection, it takes the theme's article layout; made records again, a records layout.
    s = run(s, { type: 'collection.update', collectionId: 'properties', kind: 'editorial', hasBody: true });
    expect(outline(s.collections.properties.settings.template)).toEqual(outline(themeArticleTemplate(s)));
    s = run(s, { type: 'collection.update', collectionId: 'properties', kind: 'structured' });
    expect(reads(s.collections.properties.settings.template).has('readingTime')).toBe(false);
  });

  it('is the author’s once edited: later fields are left for them to place, and a shown field is still refused', () => {
    let s = properties();
    const owner = { kind: 'template' as const, id: 'properties' };
    const pool = named(s.collections.properties.settings.template, 'Swimming pool')!;
    s = run(s, { type: 'node.remove', owner, nodeId: pool.id });
    expect(isDefaultLayout(s, s.collections.properties.settings)).toBe(false);
    s = run(s, { type: 'collection.update', collectionId: 'properties', fields: { ...structuredClone(FIELDS), era: { type: 'string', label: 'Era', default: '' } } as never });
    expect(reads(s.collections.properties.settings.template).has('field.era')).toBe(false);
    expect(named(s.collections.properties.settings.template, 'Swimming pool')).toBeUndefined();
    const { price: _price, ...withoutPrice } = structuredClone(FIELDS);
    expect(() => run(s, { type: 'collection.update', collectionId: 'properties', fields: withoutPrice as never })).toThrow(/Unbind it in the layout before removing it/);
  });

  it('follows a change of theme while nobody has edited it', () => {
    let s = properties();
    s = run(s, { type: 'theme.apply', themeId: 'foundation-alt' });
    expect(s.site.themeId).toBe('foundation-alt');
    expect(isDefaultLayout(s, s.collections.properties.settings)).toBe(true);
    // ...and still keeps up with its fields there.
    s = run(s, { type: 'collection.update', collectionId: 'properties', fields: { ...structuredClone(FIELDS), era: { type: 'string', label: 'Era', default: '' } } as never });
    expect(reads(s.collections.properties.settings.template).has('field.era')).toBe(true);
  });
});

describe('an articles layout', () => {
  it('is the theme’s article layout, with its date, author and reading time, whatever fields it has', () => {
    let s = run(site(), { type: 'collection.create', collectionId: 'posts' });
    const before = s.collections.posts.settings.template;
    expect(outline(before)).toEqual(outline(themeArticleTemplate(s)));
    expect([...reads(before)]).toEqual(expect.arrayContaining(['publishedAt', 'author', 'readingTime']));
    s = run(s, { type: 'collection.update', collectionId: 'posts', fields: { price: { type: 'string', label: 'Price', default: '' } } as never });
    expect(s.collections.posts.settings.template).toEqual(before);
  });
});

describe('a button in a layout going where an entry field says', () => {
  it('is not reported as having no link: the layout has no destination of its own', () => {
    const s = properties();
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    // One with a fixed destination still is.
    const owner = { kind: 'template' as const, id: 'properties' };
    const brochure = named(s.collections.properties.settings.template, 'Brochure') as GraphNode;
    const fixed = run(s, { type: 'node.setBinding', owner, nodeId: brochure.id, field: 'link', binding: null });
    expect(validateState(fixed).filter((d) => d.code === 'BUTTON_UNLINKED')).toHaveLength(1);
  });
});
