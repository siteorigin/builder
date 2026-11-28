/**
 * The site's business details where its sections show them (#1368): Site details' email, telephone, address and
 * opening hours show in the Contact details section, its action and the shared footer, and changing one there
 * changes every place that showed it (or the catalogue's sample). A place given a value of its own keeps it.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { detailPlaces } from '@engine/business-details';
import { openingHoursText } from '@shared/site-identity';
import { SAMPLE_CONTACT } from '@shared/sample-contact';

const apply = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const business = () => createStarterState('business', 'Fern & Field', false);
const footer = (s: ProjectState) => s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
const contactPage = (s: ProjectState) => Object.values(s.pages).find((p) => p.route === '/contact/')!;
const placed = (s: ProjectState, pageId: string, componentId: string) => Object.values(s.pages[pageId].nodes).find((n): n is InstanceNode => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId)!;
const contactSection = (s: ProjectState) => placed(s, contactPage(s).id, 'contact.details');
const rows = (node: InstanceNode, prop: string) => node.props[prop] as ListItem[];
const details = (s: ProjectState) => rows(contactSection(s), 'items').map((i) => [i.value, i.link]);
const footerRows = (s: ProjectState) => rows(footer(s), 'contact').map((i) => [i.label, i.link]);
const identity = (patch: Record<string, unknown>): EditOperation => ({ type: 'site.update', identity: patch }) as EditOperation;

const FLORIST = { kind: 'LocalBusiness', email: 'orders@fernfield.co.za', telephone: '+27 21 555 0199', address: '4 Bree Street, Cape Town', openingHours: ['Mo-Fr 08:30-17:30', 'Sa 09:00-13:00'] };
const FLORIST_HOURS = 'Monday to Friday, 8:30am – 5:30pm; Saturday, 9am – 1pm';

describe('the site’s business details on its pages', () => {
  it('shows what Site details says in the Business starter’s Contact section, its action and the footer', () => {
    const before = business();
    const s = apply(before, identity(FLORIST));
    expect(details(s)).toEqual([
      ['orders@fernfield.co.za', { type: 'email', target: 'orders@fernfield.co.za' }],
      ['+27 21 555 0199', { type: 'tel', target: '+27215550199' }],
      ['4 Bree Street, Cape Town', { type: 'none', target: '' }],
      [FLORIST_HOURS, { type: 'none', target: '' }]
    ]);
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
    expect(footerRows(s)).toEqual([
      ['orders@fernfield.co.za', { type: 'email', target: 'orders@fernfield.co.za' }],
      ['+27 21 555 0199', { type: 'tel', target: '+27215550199' }],
      ['4 Bree Street, Cape Town', { type: 'none', target: '' }]
    ]);
    // The rows keep their IDs and the fields nothing showed: the labels and icons.
    expect(rows(contactSection(s), 'items').map((i) => [i.id, i.label, i.icon])).toEqual(rows(contactSection(before), 'items').map((i) => [i.id, i.label, i.icon]));
    expect(rows(footer(s), 'contact').map((i) => i.id)).toEqual(rows(footer(before), 'contact').map((i) => i.id));
    // Nothing else on the site mentions the samples any more.
    expect(JSON.stringify(s.pages)).not.toContain(SAMPLE_CONTACT.email);
    expect(JSON.stringify(s.site.shell)).not.toContain(SAMPLE_CONTACT.address);
  });

  it('carries a later change from the old value to the new one, one detail at a time', () => {
    let s = apply(business(), identity(FLORIST));
    s = apply(s, identity({ email: 'hello@fernfield.co.za' }));
    expect(details(s)[0]).toEqual(['hello@fernfield.co.za', { type: 'email', target: 'hello@fernfield.co.za' }]);
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'hello@fernfield.co.za' });
    expect(footerRows(s)[0]).toEqual(['hello@fernfield.co.za', { type: 'email', target: 'hello@fernfield.co.za' }]);
    expect(details(s)[1][0]).toBe('+27 21 555 0199');
    s = apply(s, identity({ openingHours: ['Tu-Sa 10:00-16:00'] }));
    expect(details(s)[3][0]).toBe('Tuesday to Saturday, 10am – 4pm');
  });

  it('keeps a value a place was given of its own, and the words of a deliberate label', () => {
    let s = business();
    const owner = { kind: 'shell' as const, id: 'footer' };
    const [email, phone] = rows(footer(s), 'contact');
    s = apply(
      s,
      { type: 'instance.setProp', owner, nodeId: footer(s).id, prop: 'contact', itemId: email.id, value: { label: 'bookings@fernfield.co.za', link: { type: 'email', target: 'bookings@fernfield.co.za' } } },
      { type: 'instance.setProp', owner, nodeId: footer(s).id, prop: 'contact', itemId: phone.id, field: 'label', value: 'Call the shop' }
    );
    s = apply(s, identity(FLORIST));
    expect(footerRows(s)[0]).toEqual(['bookings@fernfield.co.za', { type: 'email', target: 'bookings@fernfield.co.za' }]);
    // The label says no number, so only the number it dials follows.
    expect(footerRows(s)[1]).toEqual(['Call the shop', { type: 'tel', target: '+27215550199' }]);
  });

  it('keeps what an email link adds after the address, and follows a number however it is written', () => {
    let s = business();
    const page = { kind: 'page' as const, id: contactPage(s).id };
    const section = contactSection(s);
    const phone = rows(section, 'items')[1];
    s = apply(
      s,
      { type: 'instance.setProp', owner: page, nodeId: section.id, prop: 'actionLink', value: { type: 'email', target: 'hello@example.com?subject=Flowers', newTab: false } },
      { type: 'instance.setProp', owner: page, nodeId: section.id, prop: 'items', itemId: phone.id, field: 'value', value: '+1 (555) 0134' }
    );
    s = apply(s, identity({ email: 'orders@fernfield.co.za', telephone: '021 555 0199' }));
    expect(contactSection(s).props.actionLink).toMatchObject({ type: 'email', target: 'orders@fernfield.co.za?subject=Flowers' });
    expect(details(s)[1]).toEqual(['021 555 0199', { type: 'tel', target: '0215550199' }]);
  });

  it('leaves the places as they are when a detail is cleared, and a section gives an own value back by showing it again', () => {
    let s = apply(business(), identity(FLORIST));
    s = apply(s, identity({ email: null }));
    expect(details(s)[0][0]).toBe('orders@fernfield.co.za');
    expect(footerRows(s)[0][0]).toBe('orders@fernfield.co.za');
    // A new email follows nothing that shows the old one: those are the author's own now.
    s = apply(s, identity({ email: 'new@fernfield.co.za' }));
    expect(details(s)[0][0]).toBe('orders@fernfield.co.za');
    // Choosing another kind of publisher clears the hours, which changes nothing on the page either.
    s = apply(s, identity({ kind: 'Organization' }));
    expect(details(s)[3][0]).toBe(FLORIST_HOURS);
  });

  it('fills the details into a Contact section placed afterwards, and into a new Contact page', () => {
    let s = apply(business(), identity(FLORIST));
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    s = apply(s, { type: 'node.insert', owner: { kind: 'page', id: about.id }, componentId: 'contact.details' } as EditOperation);
    const added = placed(s, about.id, 'contact.details');
    expect(rows(added, 'items').map((i) => i.value)).toEqual(['orders@fernfield.co.za', '+27 21 555 0199', '4 Bree Street, Cape Town', FLORIST_HOURS]);
    expect(added.props.actionLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
    s = apply(s, { type: 'page.create', title: 'Visit', route: '/visit/', starter: 'contact' } as EditOperation);
    const visit = Object.values(s.pages).find((p) => p.route === '/visit/')!;
    expect(rows(placed(s, visit.id, 'contact.details'), 'items')[0].value).toBe('orders@fernfield.co.za');
  });

  it('follows the footer’s design defaults when the footer keeps none of its own, giving it its own copy', () => {
    const s0 = business();
    delete footer(s0).props.contact;
    const s = apply(s0, identity({ address: '4 Bree Street, Cape Town' }));
    const list = rows(footer(s), 'contact');
    expect(list.map((i) => i.label)).toEqual([SAMPLE_CONTACT.email, SAMPLE_CONTACT.phone, '4 Bree Street, Cape Town']);
    // Each row's ID is the placement's own, as an edit of an inherited row makes it.
    const defaults = s.components[footer(s).definitionId].properties.contact.default as ListItem[];
    expect(list.map((i) => i.id)).not.toEqual(defaults.map((i) => i.id));
  });

  it('refuses a detail too long for a place that shows it, changing nothing', () => {
    const s0 = business();
    const def = s0.components[footer(s0).definitionId];
    const contact = def.properties.contact;
    if (contact.type !== 'list' || contact.fields.label.type !== 'string') throw new Error('unexpected footer');
    contact.fields.label.maxLength = 20;
    expect(() => apply(s0, identity({ address: '4 Bree Street, Gardens, Cape Town' }))).toThrow(/Footer in the footer shows the site's address in Label, which holds at most 20 characters/);
  });

  it('writes the hours out again when the site’s language changes', () => {
    let s = apply(business(), identity(FLORIST));
    s = apply(s, { type: 'site.update', language: 'fr' });
    expect(details(s)[3][0]).toBe(openingHoursText(FLORIST.openingHours, 'fr'));
    expect(details(s)[3][0]).not.toBe(FLORIST_HOURS);
  });

  it('says where each detail shows, and where only its sample is left', () => {
    const s0 = business();
    expect(detailPlaces(s0).every((p) => p.shows === 'sample')).toBe(true);
    const s = apply(s0, identity({ email: 'orders@fernfield.co.za' }));
    const email = detailPlaces(s).filter((p) => p.detail === 'email');
    expect(email.map((p) => [p.where, p.prop, p.kind, p.shows])).toEqual([
      ['Footer', 'contact', 'text', 'site'],
      ['Footer', 'contact', 'link', 'site'],
      ['Contact', 'items', 'text', 'site'],
      ['Contact', 'items', 'link', 'site'],
      ['Contact', 'actionLink', 'link', 'site']
    ]);
    expect(detailPlaces(s).filter((p) => p.detail === 'telephone').every((p) => p.shows === 'sample')).toBe(true);
  });
});

describe('opening hours as visitors read them', () => {
  it('writes Schema.org periods out in English', () => {
    expect(openingHoursText(['Mo-Fr 09:00-17:00'])).toBe(SAMPLE_CONTACT.hours);
    expect(openingHoursText(['Mo,We,Fr 09:30-12:00', 'Sa'])).toBe('Monday, Wednesday and Friday, 9:30am – 12pm; Saturday, all day');
    expect(openingHoursText(['Su 00:00-24:00'], 'en-GB')).toBe('Sunday, 12am – midnight');
    expect(openingHoursText(['Mo-We,Fr 13:15-18:45'])).toBe('Monday to Wednesday and Friday, 1:15pm – 6:45pm');
    // A period Site details would refuse is left out.
    expect(openingHoursText(['Mo-Fr 9-5', 'Sa 10:00-14:00'])).toBe('Saturday, 10am – 2pm');
  });

  it('names the days and hours in the site’s language', () => {
    const fr = openingHoursText(['Mo-Fr 09:00-17:00'], 'fr');
    expect(fr).toMatch(/^Lundi – vendredi, /);
    expect(fr).toContain('17:00');
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'de')).toMatch(/^Montag – Freitag, /);
  });
});

