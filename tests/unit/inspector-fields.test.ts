import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { groupFields, listItemImage, listRowTitle } from '@shared/fields';
import { locateField } from '@engine/locate';
import { applyOperations } from '@engine/apply';
import { P } from '@catalogue/dsl';

/** Issue #203: answers name the Inspector's own labels, worked out the way the Inspector draws them. */

function business() {
  const state = createStarterState('business', 'Test Studio', false);
  const pageNamed = (title: string) => Object.values(state.pages).find((p) => p.title === title) as PageDoc;
  const instanceOf = (page: PageDoc, componentId: string) => {
    const id = page.rootIds.find((r) => state.components[(page.nodes[r] as InstanceNode).definitionId]?.componentId === componentId)!;
    return page.nodes[id] as InstanceNode;
  };
  const contact = pageNamed('Contact');
  const details = instanceOf(contact, 'contact.details');
  const hours = (details.props.items as ListItem[]).find((i) => i.label === 'Hours')!;
  return { state, pageNamed, instanceOf, contact, details, hours };
}

describe('locateField', () => {
  it('names the path to the studio hours exactly as the Inspector shows it', () => {
    const { state, contact, details, hours } = business();
    const r = locateField(state, { owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'items', itemId: hours.id, field: 'value' });
    expect(r).toEqual({ ok: true, pageId: contact.id, owner: { kind: 'page', id: contact.id }, path: ['Contact', 'Contact details', 'Content', 'Contact methods', 'Hours', 'Value'], value: 'Monday to Friday, 9am – 5pm' });
  });

  it('names a single field, and a field shown inside a group under its short label', () => {
    const { state, pageNamed, instanceOf } = business();
    const about = pageNamed('About');
    const cta = instanceOf(about, 'cta.banner');
    const owner = { kind: 'page' as const, id: about.id };
    expect(locateField(state, { owner, nodeId: cta.id, prop: 'heading' })).toMatchObject({ ok: true, path: ['About', 'Call to action', 'Content', 'Text', 'Heading'] });
    // "Button label" and "Button link" are one button: a group with Label and Link, inside the component's own
    // "Actions" group (issue #96).
    expect(locateField(state, { owner, nodeId: cta.id, prop: 'primaryLabel' })).toMatchObject({ ok: true, path: ['About', 'Call to action', 'Content', 'Actions', 'Button', 'Label'], value: 'Contact the studio' });
  });

  it('uses the name the author gave the component, and the row title the list shows', () => {
    const { state, contact, details, hours } = business();
    details.name = 'Studio contact';
    // A row whose title field is empty is shown by its position instead.
    hours.label = '';
    const r = locateField(state, { owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'items', itemId: hours.id, field: 'value' });
    expect(r).toMatchObject({ ok: true, path: ['Contact', 'Studio contact', 'Content', 'Contact methods', 'Contact method 4', 'Value'] });
  });

  it('names a gallery row without a caption by the image it shows (issue #60)', () => {
    const { state, pageNamed, instanceOf } = business();
    const home = pageNamed('Home');
    const gallery = instanceOf(home, 'media.gallery');
    const rows = gallery.props.images as ListItem[];
    state.assets.assets.img_swatch = { id: 'img_swatch', name: 'swatch-07.png', file: 'static/assets/swatch-07.png', mime: 'image/png', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    rows[1].caption = '';
    rows[1].image = { assetId: 'img_swatch', alt: '' };
    const at = (itemId: string) => locateField(state, { owner: { kind: 'page', id: home.id }, nodeId: gallery.id, prop: 'images', itemId, field: 'caption' });
    expect(at(rows[1].id)).toMatchObject({ ok: true, path: ['Home', 'Gallery', 'Content', 'Images', 'swatch-07.png', 'Caption'] });
    // A caption of its own wins over the image's name; without an image either, the row goes by its position.
    rows[0].image = { assetId: 'img_swatch', alt: '' };
    expect(at(rows[0].id)).toMatchObject({ ok: true, path: ['Home', 'Gallery', 'Content', 'Images', 'Kitchen, Millbrook', 'Caption'] });
    rows[2].caption = '';
    rows[2].image = { assetId: null, alt: '' };
    expect(at(rows[2].id)).toMatchObject({ ok: true, path: ['Home', 'Gallery', 'Content', 'Images', 'Image 3', 'Caption'] });
  });

  it('offers the header logo size only while the header shows a logo (#576)', () => {
    const { state, pageNamed } = business();
    const header = state.site.shell.header;
    const nodeId = header.rootIds[0];
    const node = header.nodes[nodeId] as InstanceNode;
    const about = pageNamed('About');
    const at = () => locateField(state, { owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'logoSize' }, about.id);
    node.props.logo = { assetId: null, alt: '' };
    expect(at()).toMatchObject({ ok: false, message: 'Header has no such field in its Content.' });
    // A logo whose file is gone shows nothing, so neither does its size.
    node.props.logo = { assetId: 'img_mark', alt: 'Test Studio' };
    expect(at().ok).toBe(false);
    state.assets.assets.img_mark = { id: 'img_mark', name: 'mark.svg', file: 'static/assets/mark.svg', mime: 'image/svg+xml', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    for (const showSiteName of [true, false]) {
      node.props.showSiteName = showSiteName;
      expect(at()).toMatchObject({ ok: true, path: ['Header', 'Header', 'Content', 'Logo size'], shown: 'Medium' });
    }
    // Clearing the logo hides the size again and keeps the one chosen.
    node.props.logoSize = 'large';
    expect(at()).toMatchObject({ ok: true, shown: 'Large' });
    node.props.logo = { assetId: null, alt: '' };
    expect(at().ok).toBe(false);
    expect(node.props.logoSize).toBe('large');
    // A document chosen where the logo goes is no logo either.
    state.assets.assets.doc_menu = { id: 'doc_menu', name: 'menu.pdf', file: 'static/assets/menu.pdf', mime: 'application/pdf', bytes: 1, hash: 'h', kind: 'document', createdAt: '2026-01-01T00:00:00Z' };
    node.props.logo = { assetId: 'doc_menu', alt: '' };
    expect(at().ok).toBe(false);
    // A copy of the header made unique keeps the rule: its provenance still names the shared header.
    const def = state.components[node.definitionId];
    const copy = { ...structuredClone(def), id: 'project.my-header', componentId: 'project.my-header' } as typeof def;
    state.components[copy.id] = copy;
    node.definitionId = copy.id;
    expect(copy.provenance?.componentId).toBe('shell.header');
    expect(at().ok).toBe(false);
    node.props.logo = { assetId: 'img_mark', alt: 'Test Studio' };
    expect(at()).toMatchObject({ ok: true, shown: 'Large' });
  });

  it('finds a field in the shared header from a page that shows it', () => {
    const { state, pageNamed } = business();
    const header = state.site.shell.header;
    const nodeId = header.rootIds[0];
    const about = pageNamed('About');
    const r = locateField(state, { owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'ctaStyle' }, about.id);
    expect(r).toMatchObject({ ok: true, pageId: about.id, path: ['Header', 'Header', 'Content', 'Action', 'Style'] });
    // A choice is reported with the label the Inspector shows for it.
    const schema = state.components[(header.nodes[nodeId] as InstanceNode).definitionId].properties.ctaStyle as { options: Array<{ value: string; label: string }>; default: string };
    const option = schema.options.find((o) => o.value === ((header.nodes[nodeId] as InstanceNode).props.ctaStyle ?? schema.default))!;
    expect(r.ok && (r.shown ?? r.value)).toBe(option.label);
    // From a page without the header, it opens on the first page that has one.
    // A page without the footer still shows the header, so it opens there.
    about.showFooter = false;
    expect(locateField(state, { owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'ctaStyle' }, about.id)).toMatchObject({ ok: true, pageId: about.id });
    about.showHeader = false;
    expect(locateField(state, { owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'ctaStyle' }, about.id)).toMatchObject({ ok: true, pageId: state.site.pageOrder.find((id) => state.pages[id].showHeader) });
    for (const p of Object.values(state.pages)) p.showHeader = false;
    expect(locateField(state, { owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'ctaStyle' }, about.id)).toEqual({ ok: false, message: 'No page shows the shared header.' });
    // The footer goes by its own setting: About hides it, the pages without the header still show it.
    const footerNode = state.site.shell.footer.rootIds[0];
    const footerAt = (pageId: string) => locateField(state, { owner: { kind: 'shell', id: 'footer' }, nodeId: footerNode, prop: 'tagline' }, pageId);
    expect(footerAt(about.id)).toMatchObject({ ok: true, pageId: state.site.pageOrder.find((id) => state.pages[id].showFooter) });
    const other = state.site.pageOrder.find((id) => id !== about.id)!;
    expect(footerAt(other)).toMatchObject({ ok: true, pageId: other });
  });

  it('still finds the field after its row and its section move, and says when it has gone', () => {
    const { state, contact, details, hours } = business();
    const owner = { kind: 'page' as const, id: contact.id };
    const target = { owner, nodeId: details.id, prop: 'items', itemId: hours.id, field: 'value' };
    let s: ProjectState = applyOperations(state, [
      { type: 'instance.listMove', owner, nodeId: details.id, prop: 'items', itemId: hours.id, index: 0 },
      { type: 'node.move', owner, nodeId: details.id, parentId: null, index: 0 }
    ]).state;
    expect(s.pages[contact.id].rootIds[0]).toBe(details.id);
    expect(((s.pages[contact.id].nodes[details.id] as InstanceNode).props.items as ListItem[])[0].id).toBe(hours.id);
    expect(locateField(s, target)).toMatchObject({ ok: true, path: ['Contact', 'Contact details', 'Content', 'Contact methods', 'Hours', 'Value'] });
    // Another row with the same title is not the one that was found.
    s = applyOperations(s, [
      { type: 'instance.listRemove', owner, nodeId: details.id, prop: 'items', itemId: hours.id },
      { type: 'instance.listInsert', owner, nodeId: details.id, prop: 'items', item: { icon: 'clock', label: 'Hours', value: 'Weekends only', link: { type: 'none', target: '' } } }
    ]).state;
    expect(locateField(s, target)).toMatchObject({ ok: false, message: 'Contact methods in Contact details no longer has that contact method.' });
    s = applyOperations(s, [{ type: 'node.remove', owner, nodeId: details.id }]).state;
    expect(locateField(s, target)).toMatchObject({ ok: false, message: 'That component is no longer on Contact.' });
  });

  it('names a page list card and its field as the card shows them, from the page it follows', () => {
    const r = applyOperations(createStarterState('business', 'Test Studio', false), [
      { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/projects/kitchens/' },
      { type: 'page.update', pageId: 'pg_kitchens', description: 'Three kitchens built around how families cook.' },
      { type: 'page.create', pageId: 'pg_projects', title: 'Projects', route: '/projects/' }
    ]);
    const added = applyOperations(r.state, [
      { type: 'node.insert', owner: { kind: 'page', id: 'pg_projects' }, componentId: 'content.pages', props: { heading: 'Our projects', items: [{ pageLink: { type: 'page', target: 'pg_kitchens' } }] } }
    ]);
    const state = added.state;
    const nodeId = added.results[0].nodeId as string;
    const card = ((state.pages.pg_projects.nodes[nodeId] as InstanceNode).props.items as ListItem[])[0];
    const found = locateField(state, { owner: { kind: 'page', id: 'pg_projects' }, nodeId, prop: 'items', itemId: card.id, field: 'description' });
    expect(found).toMatchObject({ ok: true, value: 'Three kitchens built around how families cook.' });
    expect(found.ok && found.path.slice(4, 5)).toEqual(['Kitchens']);
  });

  it('never opens a component on another page that happens to share the ID', () => {
    const { state, pageNamed, contact, details } = business();
    const about = pageNamed('About');
    // Copied documents can share node IDs: the one on About is not the one found on Contact.
    about.nodes[details.id] = structuredClone(details);
    about.rootIds.push(details.id);
    contact.rootIds = contact.rootIds.filter((id) => id !== details.id);
    delete contact.nodes[details.id];
    expect(locateField(state, { owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'heading' })).toEqual({ ok: false, message: 'That component is no longer on Contact.' });
  });

  it('refuses what the Inspector has no Content field for, with what could be named instead', () => {
    const { state, contact, details, hours } = business();
    const owner = { kind: 'page' as const, id: contact.id };
    expect(locateField(state, { owner, nodeId: details.id, prop: 'items' })).toMatchObject({ ok: false, hint: expect.stringContaining(`${hours.id} (Hours)`) });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'colour' })).toMatchObject({ ok: false, hint: expect.stringContaining('eyebrow, heading, headingLevel, lead, items') });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'heading', itemId: hours.id, field: 'value' })).toMatchObject({ ok: false });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'items', itemId: hours.id, field: 'colour' })).toMatchObject({ ok: false });
    expect(locateField(state, { owner: { kind: 'component', id: details.definitionId }, nodeId: 'root', prop: 'heading' })).toMatchObject({ ok: false });
    expect(locateField(state, { owner: { kind: 'page', id: 'pg_gone' }, nodeId: details.id, prop: 'heading' })).toEqual({ ok: false, message: 'That page is no longer in the site.' });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'items', itemId: hours.id })).toMatchObject({ ok: false });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'items', field: 'value' })).toMatchObject({ ok: false });
    expect(locateField(state, { owner, nodeId: details.id, prop: 'heading', field: 'value' })).toMatchObject({ ok: false });
  });
});

describe('shared field grouping', () => {
  it('lists rows by their title field, or without one their first text, else by position', () => {
    const schema = { titleField: 'label', itemLabel: 'Contact method' };
    expect(listRowTitle(schema, { id: 'a', label: 'Hours', value: 'x' }, 0)).toBe('Hours');
    expect(listRowTitle(schema, { id: 'a', label: '', value: 'x' }, 2)).toBe('Contact method 3');
    expect(listRowTitle({ itemLabel: 'Item' }, { id: 'a', value: 'x' }, 0)).toBe('x');
    expect(listRowTitle({ itemLabel: 'Item' }, { id: 'a' }, 1)).toBe('Item 2');
  });

  it('names a row without a title by the image it shows, then by position (issue #60)', () => {
    const schema = { titleField: 'caption', itemLabel: 'Image', fields: { image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } }, caption: { type: 'string', label: 'Caption', default: '' } } } as const;
    const assets = { img_a: { kind: 'image', name: 'swatch-01.png' }, font_a: { kind: 'font', name: 'Inter.woff2' } };
    const row = (assetId: string | null, caption: string) => ({ id: 'r', image: { assetId, alt: '' }, caption });
    expect(listItemImage(schema, row('img_a', ''), assets)?.name).toBe('swatch-01.png');
    expect(listItemImage(schema, row('img_gone', ''), assets)).toBeUndefined();
    expect(listItemImage(schema, row('font_a', ''), assets)).toBeUndefined();
    expect(listItemImage(schema, row(null, ''), assets)).toBeUndefined();
    expect(listRowTitle(schema, row('img_a', 'Kitchen'), 6, 'swatch-01.png')).toBe('Kitchen');
    expect(listRowTitle(schema, row('img_a', '  '), 6, 'swatch-01.png')).toBe('swatch-01.png');
    expect(listRowTitle(schema, row(null, ''), 6, undefined)).toBe('Image 7');
    expect(listRowTitle(schema, row(null, ''), 6, '  ')).toBe('Image 7');
  });

  describe('groups declared by the catalogue (issue #96)', () => {
    const str = (label: string, group?: string) => ({ type: 'string' as const, label, default: '', ...(group ? { group } : {}) });
    const link = (label: string, group?: string) => ({ type: 'link' as const, label, default: { type: 'none' as const, target: '' }, ...(group ? { group } : {}) });
    const shape = (groups: ReturnType<typeof groupFields>): unknown =>
      groups.map((g) => (g.title ? { title: g.title, items: g.items.map((i) => i.label ?? i.schema.label), ...(g.groups ? { groups: shape(g.groups) } : {}) } : g.items[0].label ?? g.items[0].schema.label));

    it('shows the split hero as Text, Actions and Media, with each button a group inside Actions', () => {
      const def = createStarterState('business', 'Test Studio', false).components;
      const split = Object.values(def).find((d) => d.componentId === 'hero.split')!;
      const groups = groupFields(Object.entries(split.properties).map(([key, schema]) => ({ key, schema, data: null })));
      expect(shape(groups)).toEqual([
        { title: 'Text', items: ['Eyebrow', 'Heading', 'Heading level', 'Supporting text'] },
        {
          title: 'Actions',
          items: ['Label', 'Link', 'Label', 'Link'],
          groups: [
            { title: 'Primary button', items: ['Label', 'Link'] },
            { title: 'Secondary button', items: ['Label', 'Link'] }
          ]
        },
        { title: 'Media', items: ['Image'] }
      ]);
    });

    it('does not run a declared group into a button of the same name just before it', () => {
      const groups = groupFields([
        { key: 'ctaLabel', schema: str('Action label'), data: null },
        { key: 'ctaLink', schema: link('Action link'), data: null },
        { key: 'style', schema: str('Action style', 'Action'), data: null }
      ]);
      expect(shape(groups)).toEqual([
        { title: 'Action', items: ['Label', 'Link'] },
        { title: 'Action', items: ['Style'] }
      ]);
    });

    it('shortens a button named after its own group instead of nesting it, as the header does', () => {
      const header = Object.values(createStarterState('business', 'Test Studio', false).components).find((d) => d.componentId === 'shell.header')!;
      const groups = groupFields(Object.entries(header.properties).map(([key, schema]) => ({ key, schema, data: null })));
      expect((shape(groups) as unknown[]).filter((g) => typeof g === 'object')).toEqual([
        { title: 'Action', items: ['Label', 'Link', 'Style'] },
        { title: 'Notice', items: ['Text', 'Link label', 'Link'] }
      ]);
    });

    it('splits a declared group that another field interrupts, and still pairs buttons outside every group', () => {
      const groups = groupFields([
        { key: 'a', schema: str('Heading', 'Text'), data: null },
        { key: 'b', schema: str('Note'), data: null },
        { key: 'c', schema: str('Lead', 'Text'), data: null },
        { key: 'd', schema: str('More label'), data: null },
        { key: 'e', schema: link('More link'), data: null }
      ]);
      expect(shape(groups)).toEqual([{ title: 'Text', items: ['Heading'] }, 'Note', { title: 'Text', items: ['Lead'] }, { title: 'More', items: ['Label', 'Link'] }]);
    });

    it('stamps a group on every property P.group declares, keeping their names and order', () => {
      const props = P.group('Actions', { primaryLabel: P.str('Primary button label', 'Go'), primaryLink: P.link('Primary button link') });
      expect(Object.keys(props)).toEqual(['primaryLabel', 'primaryLink']);
      expect(Object.values(props).map((p) => p.group)).toEqual(['Actions', 'Actions']);
      expect(props.primaryLabel).toMatchObject({ type: 'string', label: 'Primary button label', default: 'Go' });
    });
  });

  it('keeps grouping a lone link labelled "Link" under Destination', () => {
    const groups = groupFields([
      { key: 'linkLabel', schema: { type: 'string', label: 'Link label', default: '' }, data: null },
      { key: 'link', schema: { type: 'link', label: 'Link', default: { type: 'none', target: '' } }, data: null }
    ]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([['Link', ['Label', 'Destination']]]);
  });
});
