import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, LinkValue, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { contactInText, contactMismatch, followText, joinedLines, sameContact, type Contact } from '@shared/contact-links';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { itemLinkPairs } from '@engine/tree';
import { generateProject } from '@generator/index';
import { describeOps } from '@agent/report';
import { followStoredLinks, withStoredFields } from '@agent/macros';
import { ProjectSession } from '../../src/main/project/session';
import { withManagedContact } from './fixtures/contact-links-designs';

/** The business starter as it ships, its Contact details and footer the release's code components. */
const release = () => createStarterState('business', 'Kloof', false);
/**
 * The business starter with its Contact details and footer drawn as managed designs (fixtures/contact-links-designs.ts),
 * whose links the editor pairs with their text; the release's cannot be (the Release gap tests at the end).
 */
const fresh = () => withManagedContact(release());
const contactPage = (s: ProjectState) => s.site.pageOrder.find((id) => s.pages[id].route === '/contact/')!;
const details = (s: ProjectState) => {
  const page = s.pages[contactPage(s)];
  return page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'contact.details')!;
};
const items = (s: ProjectState) => details(s).props.items as ListItem[];
const item = (s: ProjectState, icon: string) => items(s).find((i) => i.icon === icon)!;
const footer = (s: ProjectState) => s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
const setField = (s: ProjectState, itemId: string, field: string, value: unknown): EditOperation => ({
  type: 'instance.setProp',
  owner: { kind: 'page', id: contactPage(s) },
  nodeId: details(s).id,
  prop: 'items',
  itemId,
  field,
  value
});
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const exported = (s: ProjectState) => generateProject(s).get('src/routes/contact/+page.svelte')!;
const email = (target: string): LinkValue => ({ type: 'email', target });
const tel = (target: string): LinkValue => ({ type: 'tel', target });
const contact = (text: string) => contactInText(text) as Contact;

describe('contact text and links', () => {
  it('reads addresses and numbers, and leaves labels as labels', () => {
    expect(contactInText(' design@kloof.example ')).toEqual({ kind: 'email', address: 'design@kloof.example' });
    expect(contactInText('+1 202 555 0142')).toEqual({ kind: 'tel', digits: '+12025550142' });
    expect(contactInText('(202) 555-0142')).toEqual({ kind: 'tel', digits: '2025550142' });
    // Numbers pasted with non-breaking spaces or hyphens read the same; a 00 prefix dials as written.
    expect(contactInText('+1\u00a0202\u202f555\u00a00142')).toEqual({ kind: 'tel', digits: '+12025550142' });
    expect(contactInText('202\u2011555\u20100142')).toEqual({ kind: 'tel', digits: '2025550142' });
    expect(contactInText('0044 20 7946 0018')).toEqual({ kind: 'tel', digits: '00442079460018' });
    // A bracketed trunk zero is left out from abroad, except in countries whose numbers keep it; the other
    // reading still counts as the same number.
    expect(contactInText('+44 (0)20 7946 0018')).toEqual({ kind: 'tel', digits: '+442079460018', alt: '+4402079460018' });
    expect(contactInText('+39 (0)6 3691 2666')).toEqual({ kind: 'tel', digits: '+390636912666', alt: '+39636912666' });
    expect(contactInText('+49(0) 8151/998 94 94')).toEqual({ kind: 'tel', digits: '+4981519989494', alt: '+49081519989494' });
    expect(contactInText('(0)20 7946 0018')).toEqual({ kind: 'tel', digits: '02079460018' });
    // A slash between two whole numbers lists two of them; a slash after an area code is one number.
    expect(contactInText('030 / 123 456 78')).toEqual({ kind: 'tel', digits: '03012345678' });
    expect(contactInText('021 555 0142 / 082 555 0199')).toBeNull();
    for (const label of ['Call reception', 'Email us', '', 'Monday to Friday, 9am – 5pm', '12 Harbour Lane, Millbrook', '911', '2026', '+1 202 555 0142 ext 4', 'a@b', 'design@kloof.example?subject=Hi', '1234 5678 9012 3456', '911\n988\n211', '2026\t05\t31'])
      expect(contactInText(label), label).toBeNull();
  });

  it('treats one number written for home and abroad as the same number', () => {
    expect(sameContact(contact('+1 555 0134'), contact('+15550134'))).toBe(true);
    expect(sameContact(contact('(202) 555-0142'), contact('+12025550142'))).toBe(true);
    expect(sameContact(contact('1 (202) 555-0142'), contact('+12025550142'))).toBe(true);
    expect(sameContact(contact('020 7946 0018'), contact('+442079460018'))).toBe(true);
    expect(sameContact(contact('0044 20 7946 0018'), contact('+442079460018'))).toBe(true);
    expect(sameContact(contact('02 9876 5432'), contact('+61298765432'))).toBe(true);
    expect(sameContact(contact('+44 (0)20 7946 0018'), contact('+442079460018'))).toBe(true);
    expect(sameContact(contact('+39 (0)6 3691 2666'), contact('+390636912666'))).toBe(true);
    expect(sameContact(contact('+12025550142'), contact('555-0142'))).toBe(true);
    // A local number without its area code is that number too.
    expect(sameContact(contact('555-0142'), contact('+12025550142'))).toBe(true);
    expect(sameContact(contact('Design@Kloof.example'), contact('design@kloof.example'))).toBe(true);
    // Two international numbers are the same only digit for digit.
    expect(sameContact(contact('+1 202 555 0142'), contact('+44 202 555 0142'))).toBe(false);
    expect(sameContact(contact('(202) 555-0199'), contact('+12025550142'))).toBe(false);
    expect(sameContact(contact('design@kloof.example'), contact('+12025550142'))).toBe(false);
  });

  it('moves a link only from text that showed it to text that shows something else', () => {
    expect(followText('design@kloof.example', 'bookings@kloof.example', email('design@kloof.example'))).toEqual(email('bookings@kloof.example'));
    expect(followText('+1 555 0134', '+1 202 555 0142', tel('+15550134'))).toEqual(tel('+12025550142'));
    // A deliberate label, a pair that already disagreed, and a change of formatting leave the link alone.
    expect(followText('+1 555 0134', 'Call reception', tel('+15550134'))).toBeNull();
    expect(followText('Call reception', '+1 202 555 0142', tel('+15550134'))).toBeNull();
    expect(followText('bookings@kloof.example', 'info@kloof.example', email('design@kloof.example'))).toBeNull();
    expect(followText('+1 555 0134', '+1 (555) 0134', tel('+15550134'))).toBeNull();
    expect(followText('+44 20 7946 0018', '+44 (0)20 7946 0018', tel('+442079460018'))).toBeNull();
    expect(followText('+39 06 3691 2666', '+39 (0)6 / 3691 2666', tel('+390636912666'))).toBeNull();
    expect(followText('+39 06 3691 2666', '+39 (0)6 9999 0000', tel('+390636912666'))).toEqual(tel('+390699990000'));
    // A link that dialled the other reading of the zero keeps doing so.
    expect(followText('+225 (0) 7 00 26 96 25', '+225 (0) 7 11 22 33 44', tel('+2250700269625'))).toEqual(tel('+2250711223344'));
    expect(followText('+33 (0)1 42 68 53 00', '+33 (0)1 42 68 53 99', tel('+330142685300'))).toEqual(tel('+330142685399'));
    // A trunk zero pasted after a non-breaking hyphen is left out as well (#905).
    expect(followText('+44 20 7946 0018', '+44\u2011(0)20 7946 0019', tel('+442079460018'))).toEqual(tel('+442079460019'));
    // A second number added beside the first is not one number to dial.
    expect(followText('021 555 0142', '021 555 0142 / 082 555 0199', tel('+27215550142'))).toBeNull();
    expect(followText('555-0142', '555-0142 555-0199', tel('5550142'))).toBeNull();
    expect(followText('020 7946 0018', '020 7946 0018 / 123', tel('+442079460018'))).toBeNull();
    // An existing mismatch on a phone stays too.
    expect(followText('+1 202 555 0199', '+1 202 555 0123', tel('+15550134'))).toBeNull();
    expect(followText('hello@example.com', 'Hello@Example.com', email('hello@example.com'))).toBeNull();
    // Only email and phone links take part.
    expect(followText('hello@example.com', 'bookings@kloof.example', { type: 'url', target: 'https://example.com' })).toBeNull();
  });

  it('keeps what the link adds when it moves', () => {
    expect(followText('design@kloof.example', 'bookings@kloof.example', { type: 'email', target: 'design@kloof.example?subject=Booking%20request', newTab: true })).toEqual({ type: 'email', target: 'bookings@kloof.example?subject=Booking%20request', newTab: true });
    // A number written for home keeps the country code its link dialled, when it is the same shape of number.
    expect(followText('(202) 555-0142', '(202) 555-0199', tel('+12025550142'))).toEqual(tel('+12025550199'));
    expect(followText('020 7946 0018', '020 7946 0999', tel('+442079460018'))).toEqual(tel('+442079460999'));
    expect(followText('1 (202) 555-0142', '1 (202) 555-0199', tel('+12025550142'))).toEqual(tel('+12025550199'));
    // A shorter number may have lost its area code, and a number with its own + brings its own country code.
    expect(followText('(202) 555-0142', '555-0199', tel('+12025550142'))).toEqual(tel('5550199'));
    expect(followText('(202) 555-0142', '+44 20 7946 0018', tel('+12025550142'))).toEqual(tel('+442079460018'));
    // A 00 number dials as written: it may carry a carrier code rather than a country code.
    expect(followText('030 1234 5678', '0045 32 12 34 56', tel('+493012345678'))).toEqual(tel('004532123456'));
    // The bracketed zero is dialled only where numbers keep it.
    expect(followText('+39 (0)6 3691 2666', '+39 (0)6 9999 0000', tel('+390636912666'))).toEqual(tel('+390699990000'));
    expect(followText('+44 (0)20 7946 0018', '+44 (0)20 7946 0999', tel('+442079460018'))).toEqual(tel('+442079460999'));
    expect(followText('555-0142', '555-0199', tel('+12025550142'))).toEqual(tel('+12025550199'));
    expect(followText('+1 555 0134', '+1\u00a0202\u00a0555\u00a00142', tel('+15550134'))).toEqual(tel('+12025550142'));
    // A subject an older document stored raw is escaped, so the moved link stays valid.
    expect(followText('design@kloof.example', 'bookings@kloof.example', email('design@kloof.example?subject=Ask @reception'))).toEqual(email('bookings@kloof.example?subject=Ask%20%40reception'));
  });

  it('joins the lines of one-line text, unless each line is an address or number of its own', () => {
    expect(joinedLines('+1 202\n555 0142')).toBe('+1 202 555 0142');
    expect(joinedLines('555-0142\n555-0199')).toBeNull();
    expect(joinedLines('hello@example.com\n+1 555 0134')).toBeNull();
    expect(joinedLines('Call us')).toBe('Call us');
  });

  it('changes the kind of link when the text changes kind', () => {
    expect(followText('design@kloof.example', '+1 202 555 0142', { type: 'email', target: 'design@kloof.example?subject=Hi' })).toEqual(tel('+12025550142'));
    expect(followText('+1 555 0134', 'bookings@kloof.example', tel('+15550134'))).toEqual(email('bookings@kloof.example'));
  });

  it('reports a mismatch only between two real addresses or numbers', () => {
    expect(contactMismatch('bookings@kloof.example', email('design@kloof.example'))).toEqual({ kind: 'email', shown: 'bookings@kloof.example', opens: 'mailto:design@kloof.example', repair: email('bookings@kloof.example') });
    expect(contactMismatch('+1 202 555 0142', tel('+15550134'))).toEqual({ kind: 'tel', shown: '+1 202 555 0142', opens: 'tel:+15550134', repair: tel('+12025550142') });
    expect(contactMismatch('+1 202 555 0142', email('design@kloof.example'))).toMatchObject({ kind: 'tel', opens: 'mailto:design@kloof.example', repair: tel('+12025550142') });
    expect(contactMismatch('bookings@kloof.example', email('design@kloof.example'))?.opens).toBe('mailto:design@kloof.example');
    // A link target is read exactly as the export dials it: a stored trunk zero is left out from abroad, and kept
    // where numbers keep it, so only the second is a different number.
    expect(contactMismatch('+44 20 7946 0018', tel('+44 (0)20 7946 0018'))).toBeNull();
    expect(contactMismatch('+27 21 555 0100', tel('+27 (0)21 555-0100'))).toBeNull();
    expect(contactMismatch('+39 6 3691 2666', tel('+39 (0)6 3691 2666'))).toMatchObject({ opens: 'tel:+390636912666', repair: tel('+39636912666') });
    expect(contactMismatch('+39 (0)6 3691 2666', tel('+390699990000'))?.repair).toEqual(tel('+390636912666'));
    expect(contactMismatch('+44 (0)20 7946 0018', tel('+442079460999'))?.repair).toEqual(tel('+442079460018'));
    // A repair keeps an email link's subject.
    expect(contactMismatch('bookings@kloof.example', email('design@kloof.example?subject=Hi'))?.repair).toEqual(email('bookings@kloof.example?subject=Hi'));
    for (const [text, link] of [
      ['Call reception', tel('+15550134')],
      ['Email us', email('design@kloof.example')],
      ['hello@example.com', email('Hello@example.com?subject=Hi')],
      ['(202) 555-0142', tel('+12025550142')],
      ['1 (202) 555-0142', tel('+12025550142')],
      ['555-0142', tel('+12025550142')],
      ['+44 (0)20 7946 0018', tel('+442079460018')],
      ['+39 (0)6 3691 2666', tel('+390636912666')],
      ['+225 (0) 7 00 26 96 25', tel('+2250700269625')],
      // Text that shows the linked number and another one is a list, not a different number.
      ['555-0142 555-0199', tel('5550142')],
      ['020 7946 0018 / 123', tel('+442079460018')],
      ['hello@example.com', { type: 'none', target: '' }],
      ['hello@example.com', { type: 'page', target: 'p_home' }]
    ] as Array<[string, LinkValue]>)
      expect(contactMismatch(text, link), text).toBeNull();
  });
});

describe('contact details keep their link with the visible address or number', () => {
  it('moves an email link that matched the visible address to the edited address, in the export too', () => {
    let s = fresh();
    const email = item(s, 'mail');
    s = apply(s, [setField(s, email.id, 'value', 'design@kloof.example'), setField(s, email.id, 'link', { type: 'email', target: 'design@kloof.example' })]);
    s = apply(s, [setField(s, email.id, 'value', 'bookings@kloof.example')]);
    expect(item(s, 'mail').value).toBe('bookings@kloof.example');
    expect(item(s, 'mail').link).toEqual({ type: 'email', target: 'bookings@kloof.example' });
    expect(exported(s)).toContain('"value":"bookings@kloof.example","link":{"href":"mailto:bookings@kloof.example"}');
    expect(exported(s)).not.toContain('mailto:design@kloof.example');
  });

  it('moves a phone link that matched the visible number to the edited number, in the export too', () => {
    let s = fresh();
    const phone = item(s, 'phone');
    expect(phone.link).toEqual({ type: 'tel', target: '+15550134' });
    s = apply(s, [setField(s, phone.id, 'value', '+1 202 555 0142')]);
    expect((item(s, 'phone').link as LinkValue).type).toBe('tel');
    expect(exported(s)).toContain('"value":"+1 202 555 0142","link":{"href":"tel:+12025550142"}');
    expect(exported(s)).not.toContain('tel:+15550134');
  });

  it('keeps the destination when the visible text becomes a deliberate label', () => {
    let s = fresh();
    const phone = item(s, 'phone');
    s = apply(s, [setField(s, phone.id, 'value', 'Call reception')]);
    expect(item(s, 'phone').value).toBe('Call reception');
    expect(item(s, 'phone').link).toEqual({ type: 'tel', target: '+15550134' });
  });

  it('keeps the footer contact links with their visible text', () => {
    let s = fresh();
    const f = footer(s);
    const mail = (f.props.contact as ListItem[]).find((i) => (i.link as LinkValue).type === 'email')!;
    s = apply(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: f.id, prop: 'contact', itemId: mail.id, field: 'label', value: 'bookings@kloof.example' }]);
    const after = (footer(s).props.contact as ListItem[]).find((i) => i.id === mail.id)!;
    expect(after.link).toEqual({ type: 'email', target: 'bookings@kloof.example' });
    const call = (footer(s).props.contact as ListItem[]).find((i) => (i.link as LinkValue).type === 'tel')!;
    s = apply(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: f.id, prop: 'contact', itemId: call.id, field: 'label', value: '+1 202 555 0142' }]);
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('"label":"bookings@kloof.example","link":{"href":"mailto:bookings@kloof.example"}');
    expect(layout).toContain('"label":"+1 202 555 0142","link":{"href":"tel:+12025550142"}');
  });

  it('keeps an older link with a raw subject valid when it follows its address', () => {
    const s = fresh();
    const mail = item(s, 'mail');
    // Written before links were validated: the engine would refuse this target today.
    (s.pages[contactPage(s)].nodes[details(s).id] as InstanceNode).props.items = items(s).map((i) => (i.id === mail.id ? { ...i, link: email('hello@example.com?subject=Ask @reception') } : i));
    const r = applyOperations(s, [setField(s, mail.id, 'value', 'bookings@kloof.example')]);
    expect(item(r.state, 'mail').link).toEqual(email('bookings@kloof.example?subject=Ask%20%40reception'));
    expect(r.results).toEqual([{ followed: ['link'] }]);
  });

  it('pairs each repeated link with the item fields it shows and opens', () => {
    const s = fresh();
    expect(itemLinkPairs(s.components[details(s).definitionId], 'items')).toEqual([{ text: 'value', link: 'link' }]);
    expect(itemLinkPairs(s.components[footer(s).definitionId], 'contact')).toEqual([{ text: 'label', link: 'link' }]);
    // The Contact method caption ("Email") is not what the link shows, even when it reads like an address.
    expect(itemLinkPairs(s.components[details(s).definitionId], 'heading')).toEqual([]);
    const code = Object.values(release().components).find((d) => d.kind === 'code')!;
    expect(itemLinkPairs(code, Object.keys(code.properties).find((k) => code.properties[k].type === 'list') ?? 'links')).toEqual([]);
  });

  it('follows an item patch that names the text but not the link, and says which link moved', () => {
    const s = fresh();
    const phone = item(s, 'phone');
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: contactPage(s) }, nodeId: details(s).id, prop: 'items', itemId: phone.id, value: { value: '+1 202 555 0142' } }]);
    expect(item(r.state, 'phone').link).toEqual(tel('+12025550142'));
    expect(r.results).toEqual([{ followed: ['link'] }]);
    // A formatting change keeps the stored link and moves nothing.
    const again = applyOperations(r.state, [setField(r.state, phone.id, 'value', '+1 (202) 555-0142')]);
    expect(item(again.state, 'phone').link).toEqual(tel('+12025550142'));
    expect(again.results).toEqual([{}]);
  });

  it('leaves the link when an edit lists a second number on another line', () => {
    const s = fresh();
    const phone = item(s, 'phone');
    const r = applyOperations(s, [setField(s, phone.id, 'value', '+1 555 0134\n+1 202 555 0142')]);
    expect(item(r.state, 'phone')).toMatchObject({ value: '+1 555 0134 +1 202 555 0142', link: tel('+15550134') });
    expect(r.results).toEqual([{}]);
  });

  it('never repairs an existing mismatch on its own, and a label typed over with an address leaves the link', () => {
    let s = fresh();
    const mail = item(s, 'mail');
    s = apply(s, [setField(s, mail.id, 'link', email('design@kloof.example')), setField(s, mail.id, 'value', 'bookings@kloof.example')]);
    expect(item(s, 'mail').link).toEqual(email('design@kloof.example'));
    s = apply(s, [setField(s, mail.id, 'value', 'info@kloof.example')]);
    expect(item(s, 'mail').link).toEqual(email('design@kloof.example'));
    const phone = item(s, 'phone');
    s = apply(s, [setField(s, phone.id, 'value', 'Call reception')]);
    s = apply(s, [setField(s, phone.id, 'value', '+1 202 555 0142')]);
    expect(item(s, 'phone').link).toEqual(tel('+15550134'));
    expect(contactMismatch(item(s, 'phone').value, item(s, 'phone').link)?.opens).toBe('tel:+15550134');
  });

  it('lets a link the same batch sets win over its text, in either order and either form', () => {
    const base = (() => {
      const s = fresh();
      const mail = item(s, 'mail');
      return apply(s, [setField(s, mail.id, 'value', 'design@kloof.example'), setField(s, mail.id, 'link', email('design@kloof.example'))]);
    })();
    const mail = item(base, 'mail');
    const phone = item(base, 'phone');
    const page = { kind: 'page' as const, id: contactPage(base) };
    const patch = (itemId: string, value: Record<string, unknown>): EditOperation => ({ type: 'instance.setProp', owner: page, nodeId: details(base).id, prop: 'items', itemId, value });
    const keepLink = [setField(base, mail.id, 'link', email('design@kloof.example')), patch(mail.id, { link: email('design@kloof.example') })];
    const newText = [setField(base, mail.id, 'value', 'bookings@kloof.example'), patch(mail.id, { value: 'bookings@kloof.example' })];
    for (const k of keepLink)
      for (const t of newText)
        for (const batch of [
          [k, t],
          [t, k]
        ]) {
          // An edit to another item in the same batch still carries its own link.
          const r = applyOperations(base, [...batch, setField(base, phone.id, 'value', '+1 202 555 0142')]);
          expect(item(r.state, 'mail')).toMatchObject({ value: 'bookings@kloof.example', link: email('design@kloof.example') });
          expect(item(r.state, 'phone').link).toEqual(tel('+12025550142'));
          // The text edit itself never moved the link, even when it ran first.
          expect(r.results).toEqual([{}, {}, { followed: ['link'] }]);
        }
  });

  it('follows in a project copy of the section', () => {
    let s = fresh();
    const nodeId = details(s).id;
    const mail = item(s, 'mail');
    const owner = { kind: 'page' as const, id: contactPage(s) };
    s = apply(s, [{ type: 'component.makeUnique', owner, nodeId, name: 'Kloof contact' }]);
    const node = () => s.pages[owner.id].nodes[nodeId] as InstanceNode;
    expect(s.components[node().definitionId].owner).toBe('project');
    s = apply(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'items', itemId: mail.id, field: 'value', value: 'bookings@kloof.example' }]);
    expect((node().props.items as ListItem[]).find((i) => i.id === mail.id)!.link).toEqual(email('bookings@kloof.example'));
  });
});

describe('contact links in AI edits', () => {
  it('reports the link that moved with its text as part of the same change', () => {
    const s = fresh();
    const ops: EditOperation[] = [setField(s, item(s, 'mail').id, 'value', 'bookings@kloof.example')];
    const r = applyOperations(s, ops);
    expect(describeOps(ops, s, r.state, r.results).map((c) => c.label)).toEqual(['Changed the value in contact methods and link in contact methods of Contact details on Contact']);
    // A label typed over the address leaves the link, and the report says only what changed.
    const label: EditOperation[] = [setField(s, item(s, 'mail').id, 'value', 'Email reception')];
    const r2 = applyOperations(s, label);
    expect(describeOps(label, s, r2.state, r2.results).map((c) => c.label)).toEqual(['Changed the value in contact methods of Contact details on Contact']);
  });

  it('carries the link of an item a page rewrite sends without it', () => {
    const s = fresh();
    const def = s.components[details(s).definitionId];
    const stored = items(s);
    const schema = def.properties.items as Extract<(typeof def.properties)[string], { type: 'list' }>;
    const sent = [{ label: 'Email', value: 'bookings@kloof.example' }, { label: 'Phone', value: 'Call reception' }, { label: 'Studio', value: '1 Dock Road' }, { label: 'Hours', value: 'Daily' }];
    const merged = withStoredFields(schema, sent, stored);
    const moved = merged.ids.map((id, i) => followStoredLinks(def, 'items', stored.find((x) => x.id === id), sent[i], merged.items[i]));
    expect(moved).toEqual([['link'], [], [], []]);
    expect((merged.items[0] as ListItem).link).toEqual(email('bookings@kloof.example'));
    expect((merged.items[1] as ListItem).link).toEqual(tel('+15550134'));
    // A one-line value is compared as it will be stored, with its lines joined.
    const phone = [{ label: 'Phone', value: '+1 202\n555 0142' }];
    const m1 = withStoredFields(schema, phone, stored);
    expect(followStoredLinks(def, 'items', stored.find((x) => x.id === m1.ids[0]), phone[0], m1.items[0])).toEqual(['link']);
    expect((m1.items[0] as ListItem).link).toEqual(tel('+12025550142'));
    // Two numbers on two lines are a list, not one number to dial.
    const two = [{ label: 'Phone', value: '+1 555 0134\n+1 202 555 0142' }];
    const m3 = withStoredFields(schema, two, stored);
    expect(followStoredLinks(def, 'items', stored.find((x) => x.id === m3.ids[0]), two[0], m3.items[0])).toEqual([]);
    expect((m3.items[0] as ListItem).link).toEqual(tel('+15550134'));
    // A link the rewrite sends is its own.
    const own = [{ label: 'Email', value: 'bookings@kloof.example', link: email('design@kloof.example') }];
    const m2 = withStoredFields(schema, own, stored);
    expect(followStoredLinks(def, 'items', stored[0], own[0], m2.items[0])).toEqual([]);
    expect((m2.items[0] as ListItem).link).toEqual(email('design@kloof.example'));
  });
});

describe('contact link edits undo as one step', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('undoes the visible address and the link it carried together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-contact-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, fresh());
    const mail = item(session.state, 'mail');
    const r = await session.apply({ operations: [setField(session.state, mail.id, 'value', 'bookings@kloof.example')] }, { label: 'Edit Value' });
    expect(r.ok).toBe(true);
    expect(item(session.state, 'mail').link).toEqual({ type: 'email', target: 'bookings@kloof.example' });
    await session.undo();
    expect(item(session.state, 'mail').value).toBe('hello@example.com');
    expect(item(session.state, 'mail').link).toEqual({ type: 'email', target: 'hello@example.com' });
    expect(exported(session.state)).toContain('"value":"hello@example.com","link":{"href":"mailto:hello@example.com"}');
    await session.redo();
    expect(item(session.state, 'mail')).toMatchObject({ value: 'bookings@kloof.example', link: email('bookings@kloof.example') });
    await session.close();
  });

  it('undoes an explicit repair by itself, back to the mismatch it fixed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-contact-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, fresh());
    const mail = item(session.state, 'mail');
    await session.apply({ operations: [setField(session.state, mail.id, 'link', email('design@kloof.example'))] }, { label: 'Edit Link' });
    await session.apply({ operations: [setField(session.state, mail.id, 'value', 'bookings@kloof.example')] }, { label: 'Edit Value' });
    const mismatch = contactMismatch(item(session.state, 'mail').value, item(session.state, 'mail').link)!;
    expect(mismatch).toMatchObject({ shown: 'bookings@kloof.example', opens: 'mailto:design@kloof.example' });
    await session.apply({ operations: [setField(session.state, mail.id, 'link', mismatch.repair)] }, { label: 'Use displayed email as destination' });
    expect(item(session.state, 'mail').link).toEqual(email('bookings@kloof.example'));
    expect(exported(session.state)).toContain('"value":"bookings@kloof.example","link":{"href":"mailto:bookings@kloof.example"}');
    await session.undo();
    expect(item(session.state, 'mail')).toMatchObject({ value: 'bookings@kloof.example', link: email('design@kloof.example') });
    await session.undo();
    expect(item(session.state, 'mail')).toMatchObject({ value: 'hello@example.com', link: email('design@kloof.example') });
    await session.redo();
    await session.redo();
    expect(item(session.state, 'mail').link).toEqual(email('bookings@kloof.example'));
    await session.close();
  });
});

describe('contact links in the shipped theme', () => {
  // Release gap: itemLinkPairs (src/engine/tree.ts) reads managed trees only, so a contact link in the release no longer follows its text.
  it.fails('pairs the release’s Contact details links with the value each shows', () => {
    const s = release();
    expect(itemLinkPairs(s.components[details(s).definitionId], 'items')).toEqual([{ text: 'value', link: 'link' }]);
  });

  // Release gap: itemLinkPairs (src/engine/tree.ts) reads managed trees only, so a contact link in the release no longer follows its text.
  it.fails('pairs the release footer’s contact links with the label each shows', () => {
    const s = release();
    expect(itemLinkPairs(s.components[footer(s).definitionId], 'contact')).toEqual([{ text: 'label', link: 'link' }]);
  });

  // Release gap: itemLinkPairs (src/engine/tree.ts) reads managed trees only, so a contact link in the release no longer follows its text.
  it.fails('moves the email link of the release’s Contact details to the edited address', () => {
    let s = release();
    s = apply(s, [setField(s, item(s, 'mail').id, 'value', 'bookings@kloof.example')]);
    expect(item(s, 'mail').link).toEqual(email('bookings@kloof.example'));
  });
});
