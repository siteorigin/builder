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
import { detailPlaces, placeNote, publisherDetailNotes, renameDetailKeeps } from '@engine/business-details';
import { visibleReach } from '@agent/preview-check';
import { checkEmail, checkTelephone, openingHoursText } from '@shared/site-identity';
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
    // The same number written another way is shown as Site details writes it; the number its links dial stays.
    s = apply(s, identity({ telephone: '+27 (21) 555-0199' }));
    expect(details(s)[1]).toEqual(['+27 (21) 555-0199', { type: 'tel', target: '+27215550199' }]);
    expect(footerRows(s)[1][0]).toBe('+27 (21) 555-0199');
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
      { type: 'instance.setProp', owner: page, nodeId: section.id, prop: 'actionLink', value: { type: 'email', target: 'hello@example.com?subject=Flowers', newTab: true } },
      { type: 'instance.setProp', owner: page, nodeId: section.id, prop: 'items', itemId: phone.id, field: 'value', value: '+1 (555) 0134' }
    );
    s = apply(s, identity({ email: 'orders@fernfield.co.za', telephone: '021 555 0199' }));
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za?subject=Flowers', newTab: true });
    expect(details(s)[1]).toEqual(['021 555 0199', { type: 'tel', target: '0215550199' }]);
    // A new number follows from the old one, in the text and the number its links dial.
    s = apply(s, identity({ telephone: '+27 82 555 0111' }));
    expect(details(s)[1]).toEqual(['+27 82 555 0111', { type: 'tel', target: '+27825550111' }]);
    expect(footerRows(s)[1]).toEqual(['+27 82 555 0111', { type: 'tel', target: '+27825550111' }]);
    // A correction of case alone reaches the text too.
    s = apply(s, identity({ address: '4 BREE STREET' }));
    s = apply(s, identity({ address: '4 Bree Street' }));
    expect(details(s)[2][0]).toBe('4 Bree Street');
    s = apply(s, identity({ email: 'Orders@FernField.co.za' }));
    expect(details(s)[0]).toEqual(['Orders@FernField.co.za', { type: 'email', target: 'Orders@FernField.co.za' }]);
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'Orders@FernField.co.za?subject=Flowers', newTab: true });
  });

  it('leaves the places as they are when a detail is cleared', () => {
    const s0 = apply(business(), identity(FLORIST));
    let s = apply(s0, identity({ email: null, telephone: null, address: null }));
    expect(s.site.identity?.email).toBeUndefined();
    expect(details(s)).toEqual(details(s0));
    expect(footerRows(s)).toEqual(footerRows(s0));
    expect(contactSection(s).props.actionLink).toEqual(contactSection(s0).props.actionLink);
    // A new email follows nothing that shows the old one: those are the author's own now.
    s = apply(s, identity({ email: 'new@fernfield.co.za' }));
    expect(details(s)[0]).toEqual(details(s0)[0]);
    // Choosing another kind of publisher clears the hours, which changes nothing on the page either.
    s = apply(s, identity({ kind: 'Organization' }));
    expect(s.site.identity?.openingHours).toBeUndefined();
    expect(details(s)[3][0]).toBe(FLORIST_HOURS);
  });

  it('keeps a value of the author’s own that the site’s detail comes to match, until the author edits it', () => {
    let s = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'actionLink', value: { type: 'email', target: 'press@fernfield.co.za' } });
    // The site takes the press address: nothing changes on the page, and the action stays the author's.
    s = apply(s, identity({ email: 'press@fernfield.co.za' }));
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'press@fernfield.co.za' });
    expect(detailPlaces(s, { owner: page, node: contactSection(s) }).find((p) => p.prop === 'actionLink')).toMatchObject({ shows: 'site', kept: true });
    s = apply(s, identity({ email: 'bookings@fernfield.co.za' }));
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'press@fernfield.co.za' });
    expect(details(s)[0][0]).toBe('bookings@fernfield.co.za');
    expect(contactSection(s).keepsText).toBeUndefined();
    // Choosing the site's address again, by editing the action, makes it follow.
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'actionLink', value: { type: 'email', target: 'bookings@fernfield.co.za' } });
    s = apply(s, identity({ email: 'press@fernfield.co.za' }));
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'actionLink', value: { type: 'email', target: 'press@fernfield.co.za' } });
    s = apply(s, identity({ email: 'hello@fernfield.co.za' }));
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'hello@fernfield.co.za' });
    // A text of the author's own is kept the same way; editing another row of its list leaves it kept, and so does a
    // copy of the section.
    let k = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    const kPage = { kind: 'page' as const, id: contactPage(k).id };
    const [emailRow, phoneRow] = rows(contactSection(k), 'items');
    k = apply(k, { type: 'instance.setProp', owner: kPage, nodeId: contactSection(k).id, prop: 'items', itemId: emailRow.id, value: { value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } } });
    k = apply(k, identity({ email: 'press@fernfield.co.za' }));
    k = apply(k, { type: 'instance.setProp', owner: kPage, nodeId: contactSection(k).id, prop: 'items', itemId: phoneRow.id, field: 'value', value: '+27 21 555 0100' });
    k = apply(k, { type: 'node.duplicate', owner: kPage, nodeId: contactSection(k).id } as EditOperation);
    k = apply(k, identity({ email: 'bookings@fernfield.co.za' }));
    const sections = Object.values(k.pages[kPage.id].nodes).filter((n): n is InstanceNode => n.kind === 'instance' && k.components[n.definitionId]?.componentId === 'contact.details');
    expect(sections).toHaveLength(2);
    for (const section of sections) expect(rows(section, 'items')[0]).toMatchObject({ value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } });
    expect(footerRows(k)[0][0]).toBe('bookings@fernfield.co.za');
    // Editing a row's label alone leaves its kept link kept; editing its address away and back releases the link that
    // moved with it, so the row follows again as a whole.
    let p = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    const pPage = { kind: 'page' as const, id: contactPage(p).id };
    const pRow = rows(contactSection(p), 'items')[0];
    p = apply(p, { type: 'instance.setProp', owner: pPage, nodeId: contactSection(p).id, prop: 'items', itemId: pRow.id, value: { value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } } });
    p = apply(p, identity({ email: 'press@fernfield.co.za' }));
    p = apply(p, { type: 'instance.setProp', owner: pPage, nodeId: contactSection(p).id, prop: 'items', itemId: pRow.id, value: { label: 'Press desk' } });
    const pressed = apply(p, identity({ email: 'bookings@fernfield.co.za' }));
    expect(rows(contactSection(pressed), 'items')[0]).toMatchObject({ label: 'Press desk', value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } });
    p = apply(p, { type: 'instance.setProp', owner: pPage, nodeId: contactSection(p).id, prop: 'items', itemId: pRow.id, field: 'value', value: 'other@fernfield.co.za' });
    p = apply(p, { type: 'instance.setProp', owner: pPage, nodeId: contactSection(p).id, prop: 'items', itemId: pRow.id, field: 'value', value: 'press@fernfield.co.za' });
    p = apply(p, identity({ email: 'bookings@fernfield.co.za' }));
    expect(rows(contactSection(p), 'items')[0]).toMatchObject({ value: 'bookings@fernfield.co.za', link: { type: 'email', target: 'bookings@fernfield.co.za' } });
    // A row whose ID has brackets in it keeps its kept value through a copy too.
    let q = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    const qPage = { kind: 'page' as const, id: contactPage(q).id };
    const qSection = contactSection(q);
    qSection.props.items = [{ ...rows(qSection, 'items')[0], id: 'sales]west.1', value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } }];
    q = apply(q, identity({ email: 'press@fernfield.co.za' }));
    q = apply(q, { type: 'node.duplicate', owner: qPage, nodeId: qSection.id } as EditOperation);
    q = apply(q, identity({ email: 'bookings@fernfield.co.za' }));
    const copies = Object.values(q.pages[qPage.id].nodes).filter((n): n is InstanceNode => n.kind === 'instance' && q.components[n.definitionId]?.componentId === 'contact.details');
    expect(copies.map((c) => rows(c, 'items')[0].value)).toEqual(['press@fernfield.co.za', 'press@fernfield.co.za']);
    // A property renamed in its design keeps its kept values under the new name; one kept under that name before goes.
    const renamedNode = { ...structuredClone(contactSection(p)), keepsText: ['siteName', 'detail:email:actionLink', 'detail:email:items[a%5Db].value', 'detail:email:primary'] } as InstanceNode;
    renameDetailKeeps(renamedNode, new Map([['actionLink', 'primary'], ['items', 'ways']]));
    expect(renamedNode.keepsText).toEqual(['siteName', 'detail:email:primary', 'detail:email:ways[a%5Db].value']);
    // A detail the site fills in for the first time is taken up by the places that already show it.
    let t = business();
    const tPage = { kind: 'page' as const, id: contactPage(t).id };
    t = apply(t, { type: 'instance.setProp', owner: tPage, nodeId: contactSection(t).id, prop: 'items', itemId: rows(contactSection(t), 'items')[0].id, field: 'value', value: 'orders@fernfield.co.za' });
    t = apply(t, identity({ email: 'orders@fernfield.co.za' }), identity({ email: 'shop@fernfield.co.za' }));
    expect(details(t)[0]).toEqual(['shop@fernfield.co.za', { type: 'email', target: 'shop@fernfield.co.za' }]);
  });

  it('never touches a contact form’s settings, fields or placeholders', () => {
    let s = business();
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'node.insert', owner: page, componentId: 'contact.form', newNodeId: 'n_form', props: { provider: 'netlify', formName: '4 Bree Street' } } as EditOperation);
    const fields = (s.pages[page.id].nodes.n_form as InstanceNode).props.fields as ListItem[];
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: 'n_form', prop: 'fields', itemId: fields[0].id, field: 'placeholder', value: SAMPLE_CONTACT.email } as EditOperation);
    const before = structuredClone((s.pages[page.id].nodes.n_form as InstanceNode).props);
    // A copy of the theme's form, under a name of its own, is a form too, and so is any design whose code sends one.
    const coded = { ...structuredClone(s.components[(s.pages[page.id].nodes.n_form as InstanceNode).definitionId]), id: 'project.coded-form', componentId: 'coded.form', owner: 'project' as const };
    delete (coded as { provenance?: unknown }).provenance;
    s.components[coded.id] = coded as never;
    s.pages[page.id].nodes.n_coded = { ...structuredClone(s.pages[page.id].nodes.n_form as InstanceNode), id: 'n_coded', definitionId: coded.id };
    s.pages[page.id].rootIds.push('n_coded');
    const form = s.pages[page.id].nodes.n_form as InstanceNode;
    const copy = { ...structuredClone(s.components[form.definitionId]), id: 'project.my-form', componentId: 'my.form', owner: 'project' as const, provenance: { pack: 'foundation', packVersion: '0', componentId: 'contact.form' } };
    s.components[copy.id] = copy as never;
    s.pages[page.id].nodes.n_copy = { ...structuredClone(form), id: 'n_copy', definitionId: copy.id };
    s.pages[page.id].rootIds.push('n_copy');
    s = apply(s, identity({ address: '4 Bree Street', email: 'orders@fernfield.co.za' }), identity({ address: '9 Long Street' }));
    expect((s.pages[page.id].nodes.n_form as InstanceNode).props).toEqual(before);
    expect((s.pages[page.id].nodes.n_copy as InstanceNode).props).toEqual(before);
    expect((s.pages[page.id].nodes.n_coded as InstanceNode).props).toEqual(before);
  });

  it('fills the details into a Contact section placed afterwards, and into a new Contact page', () => {
    let s = apply(business(), identity(FLORIST));
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    s = apply(s, { type: 'node.insert', owner: { kind: 'page', id: about.id }, componentId: 'contact.details' } as EditOperation);
    const added = placed(s, about.id, 'contact.details');
    const filled = [
      ['orders@fernfield.co.za', { type: 'email', target: 'orders@fernfield.co.za' }],
      ['+27 21 555 0199', { type: 'tel', target: '+27215550199' }],
      ['4 Bree Street, Cape Town', { type: 'none', target: '' }],
      [FLORIST_HOURS, { type: 'none', target: '' }]
    ];
    expect(rows(added, 'items').map((i) => [i.value, i.link])).toEqual(filled);
    expect(added.props.actionLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
    s = apply(s, { type: 'page.create', title: 'Visit', route: '/visit/', starter: 'contact' } as EditOperation);
    const visit = Object.values(s.pages).find((p) => p.route === '/visit/')!;
    const started = placed(s, visit.id, 'contact.details');
    expect(rows(started, 'items').map((i) => [i.value, i.link])).toEqual(filled);
    expect(started.props.actionLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
  });

  it('keeps the values an insert gives, and the samples of a detail a field has no room for', () => {
    let s = apply(business(), identity(FLORIST));
    const about = { kind: 'page' as const, id: Object.values(s.pages).find((p) => p.route === '/about/')!.id };
    s = apply(s, { type: 'node.insert', owner: about, componentId: 'cta.banner', newNodeId: 'n_sample', props: { primaryLink: { type: 'email', target: SAMPLE_CONTACT.email } } } as EditOperation);
    expect((s.pages[about.id].nodes.n_sample as InstanceNode).props.primaryLink).toEqual({ type: 'email', target: SAMPLE_CONTACT.email });
    const def = s.components[contactSection(s).definitionId];
    const items = def.properties.items;
    if (items.type !== 'list' || items.fields.value.type !== 'string') throw new Error('unexpected section');
    items.fields.value.maxLength = 20;
    s = apply(s, { type: 'node.insert', owner: about, componentId: 'contact.details', newNodeId: 'n_short' } as EditOperation);
    const short = s.pages[about.id].nodes.n_short as InstanceNode;
    // The email, address and hours do not fit in 20 characters: each keeps its sample, its links too. The number fits.
    expect(rows(short, 'items').map((i) => [i.value, i.link])).toEqual([
      [SAMPLE_CONTACT.email, { type: 'email', target: SAMPLE_CONTACT.email }],
      ['+27 21 555 0199', { type: 'tel', target: '+27215550199' }],
      [SAMPLE_CONTACT.address, { type: 'none', target: '' }],
      [SAMPLE_CONTACT.hours, { type: 'none', target: '' }]
    ]);
    expect(short.props.actionLink).toEqual({ type: 'email', target: SAMPLE_CONTACT.email });
  });

  it('fills an object’s fields an insert leaves to the design', () => {
    let s = apply(business(), identity({ email: 'orders@fernfield.co.za' }));
    const def = s.components[contactSection(s).definitionId];
    def.properties.card = { type: 'object', label: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Write' }, link: { type: 'link', label: 'Link', default: { type: 'email', target: SAMPLE_CONTACT.email } } }, default: { title: 'Write', link: { type: 'email', target: SAMPLE_CONTACT.email } } } as never;
    const about = { kind: 'page' as const, id: Object.values(s.pages).find((p) => p.route === '/about/')!.id };
    s = apply(s, { type: 'node.insert', owner: about, definitionId: def.id, newNodeId: 'n_card', props: { card: { title: 'Say hello' } } } as EditOperation);
    expect((s.pages[about.id].nodes.n_card as InstanceNode).props.card).toEqual({ title: 'Say hello', link: { type: 'email', target: 'orders@fernfield.co.za' } });
  });

  it('follows the footer’s design defaults when it keeps none of its own, keeping the rows’ IDs and styles', () => {
    const s0 = business();
    delete footer(s0).props.contact;
    const defaults = s0.components[footer(s0).definitionId].properties.contact.default as ListItem[];
    const was = structuredClone(defaults);
    footer(s0).itemOverrides = { link: { list: 'contact', items: { [defaults[0].id]: { base: { color: 'red' } } } } } as never;
    const s = apply(s0, identity({ address: '4 Bree Street, Cape Town' }));
    const list = rows(footer(s), 'contact');
    expect(list.map((i) => [i.id, i.label])).toEqual([
      [defaults[0].id, SAMPLE_CONTACT.email],
      [defaults[1].id, SAMPLE_CONTACT.phone],
      [defaults[2].id, '4 Bree Street, Cape Town']
    ]);
    expect(footer(s).itemOverrides).toEqual({ link: { list: 'contact', items: { [defaults[0].id]: { base: { color: 'red' } } } } });
    expect(s.components[footer(s).definitionId].properties.contact.default).toEqual(was);
  });

  it('keeps a link a placement leaves to its design kept through an edit of the field beside it', () => {
    let s = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    const page = { kind: 'page' as const, id: contactPage(s).id };
    const def = s.components[contactSection(s).definitionId];
    def.properties.card = { type: 'object', label: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Write' }, link: { type: 'link', label: 'Link', default: { type: 'none', target: '' } } }, default: { title: 'Press', link: { type: 'email', target: 'press@fernfield.co.za' } } } as never;
    contactSection(s).props.card = { title: 'Press desk' };
    s = apply(s, identity({ email: 'press@fernfield.co.za' }));
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'card', field: 'title', value: 'Press office' });
    s = apply(s, identity({ email: 'bookings@fernfield.co.za' }));
    expect(contactSection(s).props.card).toMatchObject({ title: 'Press office', link: { type: 'email', target: 'press@fernfield.co.za' } });
  });

  it('leaves a link to a mailbox written in another case, which a mail host may tell apart', () => {
    let s = apply(business(), identity({ email: 'press@fernfield.co.za' }));
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'actionLink', value: { type: 'email', target: 'PRESS@FernField.co.za' } });
    s = apply(s, identity({ email: 'Press@fernfield.co.za' }));
    expect(contactSection(s).props.actionLink).toEqual({ type: 'email', target: 'PRESS@FernField.co.za' });
    expect(details(s)[0]).toEqual(['Press@fernfield.co.za', { type: 'email', target: 'Press@fernfield.co.za' }]);
    // A row ID of any characters is a name, never a failure.
    const t = apply(business(), identity({ email: 'info@fernfield.co.za' }));
    contactSection(t).props.items = [{ ...rows(contactSection(t), 'items')[0], id: '\ud800%5d]', value: 'press@fernfield.co.za', link: { type: 'email', target: 'press@fernfield.co.za' } }];
    const u = apply(apply(t, identity({ email: 'press@fernfield.co.za' })), identity({ email: 'bookings@fernfield.co.za' }));
    expect(rows(contactSection(u), 'items')[0].value).toBe('press@fernfield.co.za');
  });

  it('follows the fields of an object as the site build shows them', () => {
    const s0 = business();
    const def = s0.components[contactSection(s0).definitionId];
    def.properties.card = { type: 'object', label: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Write' }, link: { type: 'link', label: 'Link', default: { type: 'email', target: SAMPLE_CONTACT.email } } }, default: { title: 'Press', link: { type: 'email', target: 'press@fernfield.co.za' } } } as never;
    contactSection(s0).props.card = { title: 'Press desk' };
    const s = apply(s0, identity({ email: 'orders@fernfield.co.za' }));
    // The object's default opens the press desk, which the placement shows: that is not the sample.
    expect(contactSection(s).props.card).toEqual({ title: 'Press desk' });
    // A field the placement shows the sample in follows.
    const t = structuredClone(s0);
    contactSection(t).props.card = { title: 'Write', link: { type: 'email', target: SAMPLE_CONTACT.email } };
    expect(contactSection(apply(t, identity({ email: 'orders@fernfield.co.za' }))).props.card).toEqual({ title: 'Write', link: { type: 'email', target: 'orders@fernfield.co.za' } });
  });

  it('follows in the project’s own designs, and leaves a plain button the author filled in', () => {
    let s = business();
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'component.createFromNode', owner: page, nodeId: contactSection(s).id, name: 'Our contact card' } as EditOperation);
    s = apply(s, { type: 'node.insert', owner: page, primitive: 'button', newNodeId: 'n_write' } as EditOperation);
    const button = s.pages[page.id].nodes.n_write as unknown as { kind: string; label: unknown; link: unknown };
    expect(button.kind).toBe('link');
    Object.assign(button, { label: SAMPLE_CONTACT.email, link: { type: 'email', target: SAMPLE_CONTACT.email } });
    s = apply(s, identity({ email: 'orders@fernfield.co.za' }));
    const card = Object.values(s.components).find((d) => d.name === 'Our contact card')!;
    expect(JSON.stringify(card.tree)).toContain('orders@fernfield.co.za');
    expect(JSON.stringify(card.tree)).not.toContain(SAMPLE_CONTACT.email);
    // A primitive holds only what the author typed into it.
    const link = s.pages[page.id].nodes.n_write as unknown as { label: string; link: unknown };
    expect([link.label, link.link]).toEqual([SAMPLE_CONTACT.email, { type: 'email', target: SAMPLE_CONTACT.email }]);
  });

  it('never touches a design’s property that it hands on to a form inside it', () => {
    let s = business();
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'node.insert', owner: page, componentId: 'contact.form', newNodeId: 'n_form', props: { provider: 'netlify' } } as EditOperation);
    s = apply(s, { type: 'component.createFromNode', owner: page, nodeId: 'n_form', name: 'Booking form' } as EditOperation);
    const design = Object.values(s.components).find((d) => d.name === 'Booking form')!;
    const inner = Object.values(design.tree!.nodes).find((n): n is InstanceNode => n.kind === 'instance')!;
    design.properties.bookingName = { type: 'string', label: 'Booking name', default: '' } as never;
    inner.props.formName = { $prop: 'bookingName' };
    const placedDesign = Object.values(s.pages[page.id].nodes).find((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === design.id)!;
    placedDesign.props.bookingName = '4 Bree Street';
    s = apply(s, identity({ address: '4 Bree Street' }), identity({ address: '9 Long Street' }));
    expect((s.pages[page.id].nodes[placedDesign.id] as InstanceNode).props.bookingName).toBe('4 Bree Street');
  });

  it('refuses a detail too long for a place that shows it, changing nothing', () => {
    const s0 = business();
    const def = s0.components[footer(s0).definitionId];
    const contact = def.properties.contact;
    if (contact.type !== 'list' || contact.fields.label.type !== 'string') throw new Error('unexpected footer');
    contact.fields.label.maxLength = 20;
    const snapshot = structuredClone(s0);
    expect(() => apply(s0, identity({ email: 'a@fernfield.co.za', address: '4 Bree Street, Gardens, Cape Town' }))).toThrow(
      "The footer shows the site's address in Contact details → Label, which holds at most 20 characters. Use a shorter address, or give it its own text first."
    );
    expect(s0).toEqual(snapshot);
  });

  it('writes the hours out again when the site’s language changes', () => {
    let s = apply(business(), identity(FLORIST));
    s = apply(s, { type: 'site.update', language: 'fr' });
    expect(details(s)[3][0]).toBe('Lundi – vendredi, 8:30 – 17:30; Samedi, 9:00 – 13:00');
    s = apply(s, { type: 'site.update', language: 'de' });
    expect(details(s)[3][0]).toBe('Montag – Freitag, 8:30 – 17:30; Samstag, 9:00 – 13:00');
  });

  it('says where each detail shows, and where only its sample is left', () => {
    const s0 = business();
    const sample = (s: ProjectState, detail: string) => detailPlaces(s).filter((p) => p.detail === detail).map((p) => [p.where, p.prop, p.kind, p.shows]);
    expect(sample(s0, 'telephone')).toEqual([
      ['Footer', 'contact', 'text', 'sample'],
      ['Footer', 'contact', 'link', 'sample'],
      ['Contact', 'items', 'text', 'sample'],
      ['Contact', 'items', 'link', 'sample']
    ]);
    const s = apply(s0, identity({ email: 'orders@fernfield.co.za' }));
    expect(sample(s, 'email')).toEqual([
      ['Footer', 'contact', 'text', 'site'],
      ['Footer', 'contact', 'link', 'site'],
      ['Contact', 'items', 'text', 'site'],
      ['Contact', 'items', 'link', 'site'],
      ['Contact', 'actionLink', 'link', 'site']
    ]);
    expect(sample(s, 'telephone')).toEqual(sample(s0, 'telephone'));
    expect(sample(s, 'address')).toEqual([
      ['Footer', 'contact', 'text', 'sample'],
      ['Contact', 'items', 'text', 'sample']
    ]);
    expect(sample(s, 'openingHours')).toEqual([['Contact', 'items', 'text', 'sample']]);
  });

  it('lets one detail change a place another detail already shows as it is', () => {
    let s = apply(business(), identity({ telephone: '1 234', address: '1234' }));
    expect(details(s)[2][0]).toBe('1234');
    s = apply(s, identity({ telephone: '1234', address: '5 Long Street' }));
    expect(details(s)[2][0]).toBe('5 Long Street');
  });

  it('replaces samples left behind only for the details an edit names', () => {
    let s = apply(business(), identity({ email: 'orders@fernfield.co.za', address: '4 Bree Street' }));
    const about = { kind: 'page' as const, id: Object.values(s.pages).find((p) => p.route === '/about/')!.id };
    s = apply(s, { type: 'node.insert', owner: about, componentId: 'contact.details', newNodeId: 'n_left' } as EditOperation);
    const left = s.pages[about.id].nodes.n_left as InstanceNode;
    left.props = { ...left.props, items: rows(left, 'items').map((i, n) => (n === 0 ? { ...i, value: SAMPLE_CONTACT.email } : n === 2 ? { ...i, value: SAMPLE_CONTACT.address } : i)) };
    s = apply(s, identity({ twitterSite: '@fernfield' }));
    expect(rows(s.pages[about.id].nodes.n_left as InstanceNode, 'items').map((i) => i.value).slice(0, 3)).toEqual([SAMPLE_CONTACT.email, '+1 555 0134', SAMPLE_CONTACT.address]);
    s = apply(s, identity({ email: 'orders@fernfield.co.za' }));
    expect(rows(s.pages[about.id].nodes.n_left as InstanceNode, 'items').map((i) => i.value).slice(0, 3)).toEqual(['orders@fernfield.co.za', '+1 555 0134', SAMPLE_CONTACT.address]);
  });
});

describe('what the editor says about where a detail shows', () => {
  it('names the places beside each Site details field, and the samples still to replace', () => {
    const s0 = business();
    expect(publisherDetailNotes(s0).email).toBe('Replaces the sample email address in the footer and “Contact”.');
    expect(publisherDetailNotes(s0).openingHours).toBe('Replaces the sample opening hours in “Contact”.');
    let s = apply(s0, identity(FLORIST));
    expect(publisherDetailNotes(s).email).toBe('Shown in the footer and “Contact”, which change with it.');
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    // A section placed with the sample shows the site's detail instead; one that still shows it (written in by hand)
    // is named apart.
    s = apply(s, { type: 'node.insert', owner: { kind: 'page', id: about.id }, componentId: 'cta.banner', newNodeId: 'n_write' } as EditOperation);
    expect(publisherDetailNotes(s).email).toBe('Shown in the footer, “About” and “Contact”, which change with it.');
    const banner = s.pages[about.id].nodes.n_write as InstanceNode;
    expect(banner.props.primaryLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
    s.pages[about.id].nodes[banner.id] = { ...banner, props: { ...banner.props, primaryLink: { type: 'email', target: SAMPLE_CONTACT.email } } };
    expect(publisherDetailNotes(s).email).toBe('Shown in the footer and “Contact”, which change with it. The sample is still in “About”.');
    // Sending the site's email again replaces the sample left behind.
    s = apply(s, identity({ email: 'orders@fernfield.co.za' }));
    expect((s.pages[about.id].nodes.n_write as InstanceNode).props.primaryLink).toEqual({ type: 'email', target: 'orders@fernfield.co.za' });
    // A detail nothing shows has no note.
    const bare = business();
    const none = apply(bare, { type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: footer(bare).id, prop: 'contact', value: [] } as EditOperation, { type: 'node.remove', owner: { kind: 'page', id: contactPage(bare).id }, nodeId: contactSection(bare).id } as EditOperation);
    expect(publisherDetailNotes(none).address).toBeUndefined();
  });

  it('says beside a field whether it shows the site’s detail, a sample, or its own', () => {
    let s = apply(business(), identity({ email: 'orders@fernfield.co.za' }));
    const owner = { kind: 'shell' as const, id: 'footer' };
    const [text, link] = detailPlaces(s, { owner, node: footer(s) });
    expect(placeNote(text)).toBe("Shows the site's email address from Site details, and changes with it.");
    expect(placeNote(link)).toBe("Opens the site's email address from Site details, and changes with it.");
    const phone = detailPlaces(s, { owner, node: footer(s) }).find((p) => p.detail === 'telephone')!;
    expect(placeNote(phone)).toBe("Shows a sample telephone number. The site's telephone number in Site details replaces it.");
    const page = { kind: 'page' as const, id: contactPage(s).id };
    s = apply(s, { type: 'instance.setProp', owner: page, nodeId: contactSection(s).id, prop: 'actionLink', value: { type: 'email', target: 'press@fernfield.co.za' } }, identity({ email: 'press@fernfield.co.za' }));
    const kept = detailPlaces(s, { owner: page, node: contactSection(s) }).find((p) => p.prop === 'actionLink')!;
    expect(placeNote(kept)).toBe("Opens an email address of its own, the same as the site's for now. Changing the site's in Site details leaves it.");
    expect(publisherDetailNotes(s).email).toBe('Shown in the footer and “Contact”, which change with it. “Contact” keeps its own, which stays when it changes.');
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

  it('names the days and hours in the site’s language, and the end of the day as 24:00', () => {
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'fr')).toBe('Lundi – vendredi, 9:00 – 17:00');
    expect(openingHoursText(['Mo-Fr 09:00-17:30'], 'de')).toBe('Montag – Freitag, 9:00 – 17:30');
    expect(openingHoursText(['Su 00:00-24:00', 'Sa'], 'fr')).toBe('Dimanche, 0:00 – 24:00; Samedi, 0:00 – 24:00');
  });

  it('writes a language the platform does not know in English, or in its language alone', () => {
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'fr-12')).toBe('Lundi – vendredi, 9:00 – 17:00');
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'zh-cmn-Hans')).toMatch(/^星期一 – 星期五/);
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'xx-invalid-tag-!')).toBe(SAMPLE_CONTACT.hours);
    // An old name for a language is that language.
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'iw')).toBe(openingHoursText(['Mo-Fr 09:00-17:00'], 'he'));
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'he')).not.toBe(SAMPLE_CONTACT.hours);
    // A language the platform has no names for at all is written in English, not the computer's own language.
    expect(openingHoursText(['Mo-Fr 09:00-17:00'], 'qaa')).toBe(SAMPLE_CONTACT.hours);
  });
});

describe('the site’s email address and number', () => {
  it('takes none with a ?, which would end the address in its email links', () => {
    expect(checkEmail('sales?west@example.org').ok).toBe(false);
    expect(checkEmail('sales@west?.example.org').ok).toBe(false);
    // A # is sent encoded, so it is the mailbox's own.
    expect(checkEmail('sales#west@example.org')).toEqual({ ok: true, value: 'sales#west@example.org' });
    expect(checkEmail('sales+west@example.org')).toEqual({ ok: true, value: 'sales+west@example.org' });
  });

  it('takes a telephone number only when its links can dial it', () => {
    expect(checkTelephone('+358 (0)').ok).toBe(false);
    expect(checkTelephone('+358 (0) 9 123')).toEqual({ ok: true, value: '+358 (0) 9 123' });
    expect(checkTelephone('112')).toEqual({ ok: true, value: '112' });
  });
});

describe('what the AI’s checks count as changed', () => {
  it('names the pages and shared parts a detail change rewrites, and nothing for one nothing shows', () => {
    const s = business();
    const contact = contactPage(s).id;
    const email = visibleReach([identity({ email: 'orders@fernfield.co.za' })], s);
    expect([email.shared, [...email.pages]]).toEqual([true, [contact]]);
    // The site keeps no other record of its X handle on the pages, and an English site stays English.
    const handle = visibleReach([identity({ twitterSite: '@fernfield' })], s);
    expect([handle.shared, handle.pages.size]).toEqual([false, 0]);
    expect(visibleReach([{ type: 'site.update', language: 'en-AU' } as EditOperation], s).shared).toBe(false);
    // Hours show on Contact only, and in another language they are a change there.
    const open = apply(s, identity(FLORIST));
    const snapshot = structuredClone(open);
    const hours = visibleReach([identity({ openingHours: ['Sa 09:00-12:00'] })], open);
    expect([hours.shared, [...hours.pages]]).toEqual([false, [contact]]);
    expect([...visibleReach([{ type: 'site.update', language: 'fr' } as EditOperation], open).pages]).toEqual([contact]);
    // A patch the engine refuses changes nothing.
    const refused = visibleReach([{ type: 'site.update', language: 'fr', identity: { email: 'not an address' } } as EditOperation], open);
    expect([refused.shared, refused.pages.size]).toEqual([false, 0]);
    // Working it out changes nothing.
    expect(open).toEqual(snapshot);
    // A design shows wherever it is placed.
    const designed = apply(s, { type: 'component.createFromNode', owner: { kind: 'page', id: contact }, nodeId: contactSection(s).id, name: 'Our contact card' } as EditOperation);
    const card = visibleReach([identity({ openingHours: ['Sa 09:00-12:00'], kind: 'LocalBusiness' })], designed);
    expect(card.shared).toBe(true);
    expect(card.components.size).toBe(1);
  });
});
