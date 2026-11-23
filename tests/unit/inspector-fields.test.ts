import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { groupFields, listRowTitle } from '@shared/fields';
import { locateField } from '@engine/locate';
import { applyOperations } from '@engine/apply';

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
    expect(locateField(state, { owner, nodeId: cta.id, prop: 'heading' })).toMatchObject({ ok: true, path: ['About', 'Call to action', 'Content', 'Heading'] });
    // "Primary button label" and "Primary button link" are one button: a group with Label and Link.
    expect(locateField(state, { owner, nodeId: cta.id, prop: 'primaryLabel' })).toMatchObject({ ok: true, path: ['About', 'Call to action', 'Content', 'Primary button', 'Label'], value: 'Contact the studio' });
  });

  it('uses the name the author gave the component, and the row title the list shows', () => {
    const { state, contact, details, hours } = business();
    details.name = 'Studio contact';
    // A row whose title field is empty is shown by its position instead.
    hours.label = '';
    const r = locateField(state, { owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'items', itemId: hours.id, field: 'value' });
    expect(r).toMatchObject({ ok: true, path: ['Contact', 'Studio contact', 'Content', 'Contact methods', 'Contact method 4', 'Value'] });
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
    expect(locateField(state, { owner, nodeId: details.id, prop: 'colour' })).toMatchObject({ ok: false, hint: expect.stringContaining('eyebrow, heading, lead, items') });
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

  it('keeps grouping a lone link labelled "Link" under Destination', () => {
    const groups = groupFields([
      { key: 'linkLabel', schema: { type: 'string', label: 'Link label', default: '' }, data: null },
      { key: 'link', schema: { type: 'link', label: 'Link', default: { type: 'none', target: '' } }, data: null }
    ]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([['Link', ['Label', 'Destination']]]);
  });
});
