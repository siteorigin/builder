import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphNode, InstanceNode, LinkValue, ListItem, ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { missingSectionLinks, renderedContent } from '@generator/checks';
import { contentFields, contentTarget, findContent, placedSections, planReplace, sampleContactMatches, sectionMatches, type ContentMatch } from '../../src/renderer/src/lib/find-content';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);
const pageAt = (s: ProjectState, route: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === route)!;
const footerOf = (s: ProjectState) => s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
const instanceOf = (s: ProjectState, componentId: string, pageId: string) =>
  Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;
const item = (inst: InstanceNode, prop: string, label: string) => (inst.props[prop] as ListItem[]).find((x) => Object.values(x).includes(label))!;
const only = (ms: ContentMatch[], label: string) => ms.filter((m) => m.field.label === label);
const apply = (s: ProjectState, ms: ContentMatch[], replacement: string) => {
  const plan = planReplace(s, ms, replacement);
  expect(plan.error).toBeUndefined();
  return { plan, after: applyOperations(s, plan.operations).state };
};

/** A page holding one rich paragraph, for the rich text cases. */
function withParagraph(blocks: RichText) {
  const s = fresh();
  const page = pageAt(s, '/about/');
  const node: GraphNode = { id: 'n_rich_para', kind: 'text', tag: 'p', rich: true, text: blocks };
  page.nodes[node.id] = node;
  page.rootIds.push(node.id);
  return { s, page };
}

describe('finding content', () => {
  it('finds an address in the shared footer and on a page, each labelled by page, section and field', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const ms = findContent(s, 'hello@example.com');
    const rows = ms.map((m) => [m.field.where, m.field.section, m.field.label, m.kind]);
    expect(rows).toEqual([
      ['Contact', 'Contact details', 'Action link', 'link'],
      ['Contact', 'Contact details', 'Contact methods › Email › Value', 'text'],
      ['Contact', 'Contact details', 'Contact methods › Email › Link', 'link'],
      ['Footer', 'Footer', 'Contact links › hello@example.com › Label', 'text'],
      ['Footer', 'Footer', 'Contact links › hello@example.com › Destination', 'link']
    ]);
    // The footer is one shared field shown on every page that uses it; the page's copy is its own.
    expect(ms.filter((m) => m.field.where === 'Footer').every((m) => m.field.sharedPages === 3)).toBe(true);
    expect(ms.filter((m) => m.field.where === 'Contact').every((m) => m.field.sharedPages === undefined && m.field.owner.id === contact.id)).toBe(true);
    expect(ms[1]).toMatchObject({ before: '', match: 'hello@example.com', after: '' });

    // A page without the shared header does not count for it, and still counts for the footer it keeps.
    const about = pageAt(s, '/about/').id;
    s.pages[about].showHeader = false;
    expect(findContent(s, 'hello@example.com').find((m) => m.field.where === 'Footer')?.field.sharedPages).toBe(3);
    expect(findContent(s, 'Test Studio').find((m) => m.field.where === 'Header')?.field.sharedPages).toBe(2);
    s.pages[about].showFooter = false;
    expect(findContent(s, 'hello@example.com').find((m) => m.field.where === 'Footer')?.field.sharedPages).toBe(2);
    // A part no page shows is not searched at all.
    for (const id of s.site.pageOrder) s.pages[id].showHeader = false;
    expect(findContent(s, 'Test Studio').some((m) => m.field.where === 'Header')).toBe(false);
    expect(findContent(s, 'Test Studio').find((m) => m.field.where === 'Footer')?.field.sharedPages).toBe(2);
  });

  it('finds the starter’s contact details shown from a component’s defaults, and keeps settings out', () => {
    const s = fresh();
    // The footer shows its component's own contact links when the placement has none of its own.
    delete footerOf(s).props.contact;
    const def = s.components[footerOf(s).definitionId];
    const defaults = (def.properties.contact as { default: ListItem[] }).default;
    const ms = findContent(s, defaults[0].label as string).filter((m) => m.field.where === 'Footer');
    expect(ms.map((m) => m.kind)).toEqual(['text', 'link']);
    expect(ms[0].field.label).toBe(`Contact links › ${defaults[0].label} › Label`);
    const { after } = apply(s, ms, 'books@example.org');
    const own = footerOf(after).props.contact as ListItem[];
    expect(own.map((x) => x.id)).toEqual(defaults.map((x) => x.id));
    expect(own[0]).toMatchObject({ label: 'books@example.org', link: { type: 'email', target: 'books@example.org' } });
    // The component's default and the other placements are untouched.
    expect((after.components[def.id].properties.contact as { default: ListItem[] }).default).toEqual(defaults);

    // A contact form's service settings are not words on the page.
    const form = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: pageAt(s, '/contact/').id }, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://formspree.io/f/abc123' } }]).state;
    expect(findContent(form, 'formspree')).toEqual([]);
    expect(findContent(form, 'Send message').map((m) => m.field.label)).toEqual(['Button label']);
  });

  it('lists only the words and destinations visitors see from the shipped code components', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form', props: { provider: 'web3forms', accessKey: 'abc-123', formName: 'enquiries' } }]);
    const st = added.state;
    const named = (owner: string, nodeId: string) =>
      [...new Set(contentFields(st).filter((f) => f.owner.id === owner && f.nodeId === nodeId).map((f) => (f.source?.kind === 'prop' ? [f.source.prop, f.source.field].filter(Boolean).join('.') : '?')))].sort();
    expect(named(contact.id, added.results[0].nodeId as string)).toEqual(['errorMessage', 'eyebrow', 'fields.label', 'fields.placeholder', 'heading', 'lead', 'submitLabel', 'successMessage']);
    const header = st.site.shell.header.rootIds[0];
    expect(st.components[(st.site.shell.header.nodes[header] as InstanceNode).definitionId].kind).toBe('code');
    expect(named('header', header).every((k) => ['siteName', 'links.label', 'links.link', 'ctaLabel', 'ctaLink'].includes(k))).toBe(true);
    expect(named('header', header)).toContain('links.link');
    // The data table's words around it are site content, never a custom code component's settings (issue #179).
    const table = applyOperations(st, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'data.table' }]);
    const tableId = table.results[0].nodeId as string;
    const tableFields = contentFields(table.state).filter((f) => f.owner.id === contact.id && f.nodeId === tableId);
    expect([...new Set(tableFields.map((f) => (f.source?.kind === 'prop' ? f.source.prop : '?')))].sort()).toEqual(['caption', 'eyebrow', 'heading', 'lead']);
    expect(tableFields.some((f) => f.custom)).toBe(false);
  });

  it('matches the words in order across spacing, case-insensitively unless asked, and never as a pattern', () => {
    const { s } = withParagraph([{ type: 'p', spans: [{ text: 'Reading group: the reading \u00a0group meets at (7pm).' }] }]);
    expect(findContent(s, 'reading group').map((m) => m.start)).toEqual([0, 19]);
    expect(findContent(s, 'reading group', { limit: 1 })).toHaveLength(1);
    expect(findContent(s, 'reading group', { matchCase: true }).map((m) => [m.start, m.end])).toEqual([[19, 33]]);
    expect(findContent(s, '(7pm)').map((m) => m.match)).toEqual(['(7pm)']);
    expect(findContent(s, '   ')).toEqual([]);
  });

  it('finds a link to a page by its address but leaves changing it to the inspector', () => {
    const s = fresh();
    const ms = findContent(s, '/about/');
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((m) => m.kind === 'link' && m.blocked)).toBe(true);
    const plan = planReplace(s, ms, '/team/');
    expect(plan).toMatchObject({ operations: [], skipped: ms.length });

    // With its section, as it reads in an address.
    const footer = footerOf(s);
    const about = (footer.props.links as ListItem[]).find((x) => x.label === 'About')!;
    (about.link as LinkValue).anchor = 'team';
    expect(findContent(s, '/about/#team').map((m) => [m.field.label, !!m.blocked])).toEqual([['Links › About › Destination', true]]);

    // A link to a page that is gone goes nowhere: its words are found, its old target is not.
    const page = pageAt(s, '/about/');
    page.nodes.n_gone = { id: 'n_gone', kind: 'link', label: 'Old offer', link: { type: 'page', target: 'pg_gone' }, appearance: 'link' } as GraphNode;
    page.rootIds.push('n_gone');
    expect(findContent(s, 'pg_gone')).toEqual([]);
    expect(findContent(s, 'Old offer').map((m) => m.field.label)).toEqual(['Button label']);
  });

  it('lists the sections already placed, so a search reaches the existing one', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const found = placedSections(s).filter((x) => sectionMatches(x, 'contact details'));
    expect(found.map((x) => [x.label, x.pageId])).toEqual([['Contact details · Contact', contact.id]]);
    expect(found[0].ref).toEqual({ owner: { kind: 'page', id: contact.id }, instancePath: [], nodeId: instanceOf(s, 'contact.details', contact.id).id });
    expect(placedSections(s).find((x) => sectionMatches(x, 'footer'))?.pageId).toBeNull();
  });

  it('does not list a styled button the site leaves out for having no destination', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const details = instanceOf(s, 'contact.details', contact.id);
    const next = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLink', value: { type: 'none', target: '' } }]).state;
    const shown = renderedContent(next, next.pages[contact.id]).filter((c) => c.source?.kind === 'prop' && ['actionLabel', 'actionLink'].includes(c.source.prop));
    expect(shown).toEqual([]);
  });
});

describe('replacing content', () => {
  it('changes a contact method’s text without moving its link, unless the link’s own match is chosen', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const ms = findContent(s, 'hello@example.com');
    const text = only(ms, 'Contact methods › Email › Value');
    const link = only(ms, 'Contact methods › Email › Link');

    const textOnly = apply(s, text, 'books@example.org');
    const email = item(instanceOf(textOnly.after, 'contact.details', contact.id), 'items', 'Email');
    expect(email).toMatchObject({ value: 'books@example.org', link: { type: 'email', target: 'hello@example.com' } });
    expect(textOnly.plan.changes.map((c) => [c.kind, c.before, c.after, !!c.knockOn])).toEqual([['text', 'hello@example.com', 'books@example.org', false]]);

    const both = apply(s, [...text, ...link], 'books@example.org');
    expect(item(instanceOf(both.after, 'contact.details', contact.id), 'items', 'Email')).toMatchObject({ value: 'books@example.org', link: { type: 'email', target: 'books@example.org' } });
    expect(both.plan.operations).toHaveLength(1);
    expect(both.plan.changes.map((c) => [c.kind, c.before, c.after])).toEqual([
      ['text', 'hello@example.com', 'books@example.org'],
      ['link', 'Email hello@example.com', 'Email books@example.org']
    ]);
  });

  it('keeps a custom label when only the destination changes, and keeps the link’s other settings', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const details = instanceOf(s, 'contact.details', contact.id);
    const start = applyOperations(s, [
      { type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLabel', value: 'Ask the studio' },
      { type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLink', value: { type: 'email', target: 'hello@example.com?subject=Reading%20group', newTab: true } }
    ]).state;
    const { plan, after } = apply(start, only(findContent(start, 'hello@example.com'), 'Action link'), 'books@example.org');
    const placed = instanceOf(after, 'contact.details', contact.id);
    expect(placed.props.actionLabel).toBe('Ask the studio');
    expect(placed.props.actionLink).toEqual({ type: 'email', target: 'books@example.org?subject=Reading%20group', newTab: true });
    expect(plan.changes.map((c) => [c.field.label, c.kind, c.before, c.after])).toEqual([['Action link', 'link', 'Email hello@example.com?subject=Reading%20group', 'Email books@example.org?subject=Reading%20group']]);
  });

  it('replaces only the chosen occurrence of two in one field, literally', () => {
    const { s, page } = withParagraph([{ type: 'p', spans: [{ text: 'Reading group: the reading group meets.' }] }]);
    const ms = findContent(s, 'reading group');
    const { after } = apply(s, [ms[1]], '$& club');
    expect(after.pages[page.id].nodes.n_rich_para).toMatchObject({ text: [{ type: 'p', spans: [{ text: 'Reading group: the $& club meets.' }] }] });
  });

  it('replaces rich text across bold and italic, refuses across a link’s edge, and changes an inline link’s destination without its words', () => {
    const link: LinkValue = { type: 'email', target: 'books@example.org' };
    const { s, page } = withParagraph([
      { type: 'p', spans: [{ text: 'Join the ' }, { text: 'Reading', strong: true }, { text: ' ' }, { text: 'group', link }, { text: ' or ' }, { text: 'write to us', link: { type: 'url', target: 'https://example.org/books' } }, { text: '.' }] },
      { type: 'ul', items: [[{ text: 'Reading ' }, { text: 'nights', em: true }, { text: ' on Tuesday' }]] }
    ]);
    // "Reading group" is partly a link: found, but not replaceable here.
    const across = findContent(s, 'Reading group');
    expect(across).toHaveLength(1);
    expect(across[0].blocked).toMatch(/link/);
    expect(planReplace(s, across, 'Book club')).toMatchObject({ operations: [], skipped: 1 });

    // Across formatting is fine: the new words take the formatting where the match starts.
    const nights = findContent(s, 'Reading nights');
    expect(nights.map((m) => m.part)).toEqual(['b1.0']);
    const changed = apply(s, nights, 'Book evenings').after.pages[page.id].nodes.n_rich_para as { text: RichText };
    expect(changed.text[1]).toEqual({ type: 'ul', items: [[{ text: 'Book evenings on Tuesday' }]] });
    expect(changed.text[0]).toEqual((s.pages[page.id].nodes.n_rich_para as { text: RichText }).text[0]);

    // A destination inside the text changes alone: the linked words stay.
    const dest = findContent(s, 'books@example.org');
    expect(dest.map((m) => [m.kind, m.blocked])).toEqual([['link', undefined]]);
    const moved = apply(s, dest, 'events@example.org');
    const spans = ((moved.after.pages[page.id].nodes.n_rich_para as { text: RichText }).text[0] as { spans: Array<{ text: string; link?: LinkValue }> }).spans;
    expect(spans.find((x) => x.text === 'group')?.link).toEqual({ type: 'email', target: 'events@example.org' });
    expect(spans.find((x) => x.text === 'write to us')?.link).toEqual({ type: 'url', target: 'https://example.org/books' });
    expect(moved.plan.changes.map((c) => [c.kind, c.before, c.after])).toEqual([['link', 'Email books@example.org', 'Email events@example.org']]);

    // Words and a destination in the same text change together in one edit.
    const words = findContent(s, 'Join the');
    const together = apply(s, [...words, ...dest], 'events@example.org');
    expect(together.plan.operations).toHaveLength(1);
    expect(together.plan.changes.map((c) => c.kind).sort()).toEqual(['link', 'text']);

    // Emptying a link's words would remove the link: refused, with the reason.
    expect(planReplace(s, findContent(s, 'write to us'), '').error).toMatch(/would remove a link/);
  });

  it('reports what the project would refuse before anything is changed', () => {
    const s = fresh();
    const plan = planReplace(s, only(findContent(s, 'hello@example.com'), 'Action link'), 'not an address');
    expect(plan.operations).toEqual([]);
    expect(plan.error).toMatch(/not a valid email address/);
  });

  it('lists a change the edit makes along with the chosen matches', () => {
    const s = fresh();
    // Emptying the action's label leaves out its button, and the destination with it.
    const ms = findContent(s, 'Email us').filter((m) => m.field.label === 'Action label');
    const plan = planReplace(s, ms, '');
    expect(plan.error).toBeUndefined();
    expect(plan.changes.map((c) => [c.field.label, c.kind, c.before, c.after, !!c.knockOn])).toEqual([
      ['Action label', 'text', 'Email us', 'Not shown', false],
      ['Action link', 'link', 'Email hello@example.com', 'No link', true]
    ]);
  });

  it('renames a contact form field without moving its submission key, and reviews only the label', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form' }]);
    const form = added.state;
    const formId = added.results[0].nodeId as string;
    const before = (form.pages[contact.id].nodes[formId] as InstanceNode).props.fields as ListItem[];
    const ms = findContent(form, 'Phone').filter((m) => m.field.where === 'Contact' && m.field.label.startsWith('Fields'));
    expect(ms.map((m) => m.field.label)).toEqual(['Fields › Phone › Label']);
    const { plan, after } = apply(form, ms, 'Telephone');
    expect(plan.changes.map((c) => [c.kind, c.before, c.after, !!c.knockOn])).toEqual([['text', 'Phone', 'Telephone', false]]);
    const fields = (after.pages[contact.id].nodes[formId] as InstanceNode).props.fields as ListItem[];
    expect(fields.map((f) => f.name)).toEqual(before.map((f) => f.name));
    expect(fields.map((f) => f.label)).toContain('Telephone');
  });
});

describe('what replacing keeps safe', () => {
  it('refuses to empty one link even when another run of the same text keeps a different link', () => {
    const one: LinkValue = { type: 'url', target: 'https://example.org/one' };
    const { s } = withParagraph([{ type: 'p', spans: [{ text: 'A', link: one }, { text: 'X', strong: true, link: one }, { text: 'B', link: one }, { text: ' and ' }, { text: 'X', link: { type: 'url', target: 'https://example.org/two' } }] }]);
    const ms = findContent(s, 'X', { matchCase: true }).filter((m) => m.kind === 'text');
    expect(ms).toHaveLength(2);
    expect(planReplace(s, ms, '').error).toMatch(/would remove a link/);
    // Emptying only the X inside the first link leaves it its other words.
    expect(planReplace(s, [ms[0]], '').error).toBeUndefined();
  });

  it('keeps the formatting of words that already read as the replacement, and keeps a non-breaking space as a change', () => {
    const { s, page } = withParagraph([{ type: 'p', spans: [{ text: 'Bo', strong: true }, { text: 'ok club and book night, 10 kg' }] }]);
    const books = findContent(s, 'Book').filter((m) => m.field.nodeId === 'n_rich_para');
    expect(books.map((m) => m.match)).toEqual(['Book', 'book']);
    const { after, plan } = apply(s, books, 'Book');
    expect((after.pages[page.id].nodes.n_rich_para as { text: RichText }).text).toEqual([{ type: 'p', spans: [{ text: 'Bo', strong: true }, { text: 'ok club and Book night, 10 kg' }] }]);
    expect(plan.changes).toHaveLength(1);
    // A replacement that starts in bold stays bold.
    const bold = apply(s, findContent(s, 'Book club'), 'Reading circle').after.pages[page.id].nodes.n_rich_para as { text: RichText };
    expect((bold.text[0] as { spans: unknown[] }).spans[0]).toEqual({ text: 'Reading circle', strong: true });
    // Only a non-breaking space differs, and that is a change the page shows.
    const nbsp = planReplace(s, findContent(s, '10 kg'), '10\u00a0kg');
    expect(nbsp.operations).toHaveLength(1);
    expect(nbsp.changes.map((c) => c.after)).toEqual(['Book club and book night, 10\u00a0kg']);
  });

  it('shows a line break a match runs across, so replacing it is a change that shows', () => {
    const { s, page } = withParagraph([{ type: 'p', spans: [{ text: 'Harbour Lane\n12 Quay Street' }] }]);
    const found = findContent(s, 'Lane 12').filter((m) => m.field.nodeId === 'n_rich_para');
    expect(found.map((m) => m.match)).toEqual(['Lane ↵ 12']);
    expect(findContent(s, 'Lane').filter((m) => m.field.nodeId === 'n_rich_para').map((m) => m.after)).toEqual([' ↵ 12 Quay Street']);
    const { after, plan } = apply(s, found, 'Lane 12');
    expect((after.pages[page.id].nodes.n_rich_para as { text: RichText }).text).toEqual([{ type: 'p', spans: [{ text: 'Harbour Lane 12 Quay Street' }] }]);
    expect(plan.changes.map((c) => [c.before, c.after])).toEqual([['Harbour Lane ↵ 12 Quay Street', 'Harbour Lane 12 Quay Street']]);
  });

  it('refuses to remove a link whose destination the same edit makes equal to its neighbour’s', () => {
    const { s } = withParagraph([{ type: 'p', spans: [{ text: 'Offers', link: { type: 'url', target: 'https://example.org/salecopy' } }, { text: 'copy', link: { type: 'url', target: 'https://example.org/sale' } }] }]);
    const ms = findContent(s, 'copy').filter((m) => m.field.nodeId === 'n_rich_para');
    expect(ms.map((m) => m.kind).sort()).toEqual(['link', 'text']);
    expect(planReplace(s, ms, '').error).toMatch(/would remove a link/);
  });

  it('reviews words and destinations exactly as they will be stored', () => {
    const { s, page } = withParagraph([{ type: 'p', spans: [{ text: 'Jump', link: { type: 'anchor', target: 'foo' } }] }]);
    page.nodes.n_plain = { id: 'n_plain', kind: 'text', tag: 'p', text: 'Full price' } as GraphNode;
    page.rootIds.push('n_plain');
    // A leading non-breaking space is a change the page shows.
    const plain = planReplace(s, findContent(s, 'Full price'), '\u00a0Full price');
    expect(plain.changes.map((c) => [c.before, c.after])).toEqual([['Full price', '\u00a0Full price']]);
    // Spaces the page collapses are still stored: the review says the spacing changed.
    const spaced = planReplace(s, findContent(s, 'Full price'), 'Full price ');
    expect(spaced.operations).toHaveLength(1);
    expect(spaced.changes.map((c) => [c.before, c.after])).toEqual([['Full price', 'Full price (spacing changed)']]);
    // A section link's # is not part of what is stored.
    const anchor = planReplace(s, findContent(s, 'foo').filter((m) => m.kind === 'link'), '#bar');
    expect(anchor.changes.map((c) => [c.kind, c.before, c.after])).toEqual([['link', '#foo on the same page', '#bar on the same page']]);
  });

  it('reviews a destination whose button the edit removes as no link at all', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const details = instanceOf(s, 'contact.details', contact.id);
    const start = applyOperations(s, [
      { type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLabel', value: 'sale' },
      { type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLink', value: { type: 'url', target: 'https://example.org/sale' } }
    ]).state;
    const plan = planReplace(start, findContent(start, 'sale'), '');
    expect(plan.error).toBeUndefined();
    expect(plan.changes.map((c) => [c.kind, c.before, c.after])).toEqual([
      ['text', 'sale', 'Not shown'],
      ['link', 'https://example.org/sale', 'No link']
    ]);
  });

  it('leaves a copied contact form and a custom code component to the inspector', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const owner = { kind: 'page' as const, id: contact.id };
    const added = applyOperations(s, [{ type: 'node.insert', owner, componentId: 'contact.form', props: { provider: 'netlify', formName: 'enquiries' } }]);
    const formId = added.results[0].nodeId as string;
    const unique = applyOperations(added.state, [{ type: 'component.makeUnique', owner, nodeId: formId, name: 'Booking form' }]).state;
    expect(unique.components[(unique.pages[contact.id].nodes[formId] as InstanceNode).definitionId].owner).toBe('project');
    // The project keeps submission keys only for the theme's own form, so nothing in a copy changes from here.
    expect(findContent(added.state, 'enquiries')).toEqual([]);
    expect(findContent(unique, 'enquiries').map((m) => [m.field.label, !!m.blocked])).toEqual([['Netlify form name', true]]);
    const send = findContent(unique, 'Send message');
    expect(send.map((m) => [m.field.label, !!m.blocked])).toEqual([['Button label', true]]);
    expect(planReplace(unique, send, 'Book')).toMatchObject({ operations: [], skipped: 1 });

    const custom = applyOperations(unique, [{ type: 'component.createCode', name: 'Booking widget', source: '<script>let { apiUrl = "" } = $props();</script><p>Book</p>', properties: { apiUrl: { type: 'string', label: 'API address', default: 'https://booking.example.org/api' } } }]);
    const defId = custom.results[0].definitionId as string;
    const placed = applyOperations(custom.state, [{ type: 'node.insert', owner, definitionId: defId }]);
    const m = findContent(placed.state, 'booking.example.org');
    expect(m.map((x) => [x.field.label, x.blocked])).toEqual([['API address', expect.stringMatching(/custom code component/)]]);
    expect(planReplace(placed.state, m, 'other.example.org')).toMatchObject({ operations: [], skipped: 1 });
    expect(contentTarget(placed.state, m[0].field, contact.id)).toMatchObject({ section: 'content', focus: 'apiUrl' });
  });

  it('never changes a field a design hands to a contact form as a setting or as its fields', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form' }]);
    const st = added.state;
    const formDef = st.components[(st.pages[contact.id].nodes[added.results[0].nodeId as string] as InstanceNode).definitionId];
    // A section of the project's own that shows an address as text and hands the same address to its form as the
    // endpoint, and its own list to the form as the form's fields.
    st.components.proj_wrap = {
      schemaVersion: formDef.schemaVersion,
      id: 'proj_wrap',
      componentId: 'project.wrap',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Booking section',
      description: '',
      category: 'custom',
      tags: [],
      properties: { address: { type: 'string', label: 'Address', default: 'https://forms.example.org/f/abc' }, fields: structuredClone(formDef.properties.fields) },
      parts: {},
      tree: {
        rootIds: ['w_root'],
        nodes: {
          w_root: { id: 'w_root', kind: 'element', tag: 'section', children: ['w_text', 'w_form'] },
          w_text: { id: 'w_text', kind: 'text', tag: 'p', text: { $prop: 'address' } },
          w_form: { id: 'w_form', kind: 'instance', definitionId: formDef.id, props: { provider: 'endpoint', endpoint: { $prop: 'address' }, fields: { $prop: 'fields' } } }
        }
      }
    };
    st.pages[contact.id].nodes.n_wrap = { id: 'n_wrap', kind: 'instance', definitionId: 'proj_wrap', props: {} };
    st.pages[contact.id].rootIds.push('n_wrap');
    const address = findContent(st, 'forms.example.org');
    expect(address.map((m) => [m.field.nodeId, m.field.label, !!m.blocked])).toEqual([['n_wrap', 'Address', true]]);
    const phone = findContent(st, 'Phone').filter((m) => m.field.nodeId === 'n_wrap');
    expect(phone.map((m) => [m.field.label, !!m.blocked])).toEqual([['Fields › Phone › Label', true]]);
  });

  it('keeps the header’s rules for a header made unique twice', () => {
    const s = fresh();
    const header = { kind: 'shell' as const, id: 'header' };
    const nodeId = s.site.shell.header.rootIds[0];
    const once = applyOperations(s, [{ type: 'component.makeUnique', owner: header, nodeId, name: 'Shop header' }]).state;
    const twice = applyOperations(once, [{ type: 'component.makeUnique', owner: header, nodeId, name: 'Sale header' }]).state;
    expect(twice.components[(twice.site.shell.header.nodes[nodeId] as InstanceNode).definitionId].provenance?.forkedFrom).toMatch(/^proj/);
    expect(findContent(twice, 'Test Studio').filter((m) => m.field.where === 'Header').map((m) => [m.field.label, !!m.blocked])).toEqual([['Site name', false]]);
  });

  it('lists the header’s name and action only while visitors see them', () => {
    const s = fresh();
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
    s.assets.assets.logo1 = { id: 'logo1', name: 'Logo', file: 'static/assets/logo1.png', mime: 'image/png', bytes: 10, hash: 'x', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    Object.assign(header.props, { logo: { assetId: 'logo1', alt: 'Test Studio' }, showSiteName: false, ctaLabel: 'Book now', ctaLink: { type: 'none', target: '' } });
    expect(findContent(s, 'Book now')).toEqual([]);
    expect(findContent(s, 'Test Studio').filter((m) => m.field.where === 'Header')).toEqual([]);
    header.props.ctaLink = { type: 'email', target: 'books@example.org' };
    header.props.showSiteName = true;
    expect(findContent(s, 'Book now').map((m) => m.field.label)).toEqual(['Action label']);
    expect(findContent(s, 'books@example.org').map((m) => m.field.label)).toEqual(['Action link']);
    expect(findContent(s, 'Test Studio').filter((m) => m.field.where === 'Header').map((m) => m.field.label)).toEqual(['Site name']);
    // The header shows its action for any label at all, even a space: its destination is still there to find.
    header.props.ctaLabel = ' ';
    expect(findContent(s, 'books@example.org').map((m) => m.field.label)).toEqual(['Action link']);
  });

  it('lists the header’s notice and its link only while visitors see them, and rewords it once for every page', () => {
    const s = fresh();
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
    const contact = pageAt(s, '/contact/');
    // A link label without the notice's words shows nothing: clearing the words removed the notice.
    const map = 'https://maps.example.com/harbour-lane';
    Object.assign(header.props, { notice: '   ', noticeLabel: 'Directions', noticeLink: { type: 'url', target: map } });
    expect(findContent(s, 'Directions')).toEqual([]);
    expect(findContent(s, map)).toEqual([]);
    header.props.notice = 'Studio closed on Friday for repairs';
    expect(findContent(s, 'repairs').map((m) => [m.field.label, m.field.where])).toEqual([['Notice text', 'Header']]);
    expect(only(findContent(s, 'Directions'), 'Notice link label')).toHaveLength(1);
    expect(findContent(s, map).map((m) => m.field.label)).toEqual(['Notice link']);
    // A label of spaces shows no link, so neither its words nor its destination are listed.
    header.props.noticeLabel = '  ';
    expect(findContent(s, map)).toEqual([]);
    header.props.noticeLabel = 'Directions';
    // A link that goes nowhere is not shown, so its label is not either.
    header.props.noticeLink = { type: 'none', target: '' };
    expect(findContent(s, 'Directions')).toEqual([]);
    header.props.noticeLink = { type: 'page', target: contact.id };
    // One replacement in the shared header rewords the notice everywhere it shows.
    const { after } = apply(s, findContent(s, 'repairs'), 'a private event');
    expect((after.site.shell.header.nodes[header.id] as InstanceNode).props.notice).toBe('Studio closed on Friday for a private event');
  });

  it('checks the notice’s link only while the notice shows it', () => {
    const s = fresh();
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
    const contact = pageAt(s, '/contact/');
    Object.assign(header.props, { notice: 'Studio closed on Friday', noticeLabel: 'Directions', noticeLink: { type: 'page', target: contact.id, anchor: 'no-such-section' } });
    expect(missingSectionLinks(s).map((i) => [i.owner.id, i.label])).toEqual([['header', 'Directions']]);
    // A header made unique keeps the header's code, so the same rules hold for its copy.
    const owner = { kind: 'shell' as const, id: 'header' };
    const forked = applyOperations(s, [{ type: 'component.makeUnique', owner, nodeId: header.id, name: 'Sale header' }]).state;
    expect(forked.components[(forked.site.shell.header.nodes[header.id] as InstanceNode).definitionId].owner).not.toBe('theme');
    expect(missingSectionLinks(forked).map((i) => [i.owner.id, i.label])).toEqual([['header', 'Directions']]);
    for (const base of [s, forked])
      for (const props of [{ notice: '' }, { notice: '  ' }, { noticeLabel: ' ' }]) {
        const hidden = structuredClone(base);
        Object.assign((hidden.site.shell.header.nodes[header.id] as InstanceNode).props, props);
        expect(missingSectionLinks(hidden), JSON.stringify(props)).toEqual([]);
      }
  });

  it('keeps a form field’s submission key when its label changes and it has no name of its own', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form' }]);
    const formId = added.results[0].nodeId as string;
    const form = added.state.pages[contact.id].nodes[formId] as InstanceNode;
    const phone = (form.props.fields as ListItem[]).find((f) => f.label === 'Phone')!;
    phone.name = '';
    const { after } = apply(added.state, findContent(added.state, 'Phone').filter((m) => m.field.label === 'Fields › Phone › Label'), 'Telephone');
    const fields = (after.pages[contact.id].nodes[formId] as InstanceNode).props.fields as ListItem[];
    expect(fields.find((f) => f.id === phone.id)).toMatchObject({ label: 'Telephone', name: 'phone' });
  });
});

describe('opening a match', () => {
  it('opens a shared footer item on a page that shows the footer, at the item’s part', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    s.pages[about.id].showFooter = false;
    const m = findContent(s, 'hello@example.com').find((x) => x.field.where === 'Footer' && x.kind === 'text')!;
    const footer = footerOf(s);
    const target = contentTarget(s, m.field, about.id)!;
    expect(target.pageId).toBe(s.site.homePageId);
    expect(target.selection).toMatchObject({ owner: { kind: 'shell', id: 'footer' }, instancePath: [footer.id], nodeId: m.field.defNodeId, itemPath: [m.field.source?.kind === 'prop' ? m.field.source.itemId : ''] });
    expect(contentTarget(s, m.field, pageAt(s, '/contact/').id)!.pageId).toBe(pageAt(s, '/contact/').id);
    // A page that hides only the header still shows the footer, so its items open there.
    s.pages[about.id].showFooter = true;
    s.pages[about.id].showHeader = false;
    expect(contentTarget(s, m.field, about.id)!.pageId).toBe(about.id);
    // A part the component declares is selected as that part, with the field it shows focused.
    const name = findContent(s, 'Test Studio').find((x) => x.field.where === 'Footer' && x.field.label === 'Site name')!;
    const at = contentTarget(s, name.field, about.id)!;
    expect(at.selection.partId).toBeTruthy();
    expect(at).toMatchObject({ section: 'part-content', focus: 'siteName' });
  });

  it('opens a code component’s field by selecting the placement and naming the field to open', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form' }]);
    const m = findContent(added.state, 'Send message')[0];
    const formId = added.results[0].nodeId as string;
    expect(contentTarget(added.state, m.field, null)).toEqual({ pageId: contact.id, selection: { owner: { kind: 'page', id: contact.id }, instancePath: [], nodeId: formId }, section: 'content', focus: 'submitLabel' });
    // A list item's field is opened in its list: the property, the item and the field.
    const phone = findContent(added.state, 'Phone').find((x) => x.field.label === 'Fields › Phone › Label')!;
    const item = phone.field.source?.kind === 'prop' ? phone.field.source.itemId : undefined;
    expect(item).toBeTruthy();
    expect(contentTarget(added.state, phone.field, null)?.reveal).toEqual({ prop: 'fields', itemId: item, field: 'label' });
  });

  it('keeps each field’s key across an edit, so a review compares like with like', () => {
    const s = fresh();
    const keys = contentFields(s).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const { after } = apply(s, findContent(s, 'Test Studio'), 'Bookshop');
    expect(contentFields(after).map((f) => f.key)).toEqual(keys);
  });
});

describe('the starter’s sample contact details (#15)', () => {
  const rows = (ms: ContentMatch[]) => ms.map((m) => [m.field.where, m.field.label, m.kind, m.match]);
  const group = (s: ProjectState, kind: string) => sampleContactMatches(s).find((g) => g.kind === kind)?.matches ?? [];

  it('finds the sample email, phone and street address the business starter publishes, as words and as destinations', () => {
    const s = fresh();
    expect(sampleContactMatches(s).map((g) => [g.kind, g.value, g.matches.length])).toEqual([
      ['email', 'hello@example.com', 5],
      ['phone', '+1 555 0134', 4],
      ['address', '12 Harbour Lane, Millbrook', 1]
    ]);
    // The visible address, the contact method's link, the section's call to action, and the shared footer.
    expect(rows(group(s, 'email'))).toEqual([
      ['Contact', 'Action link', 'link', 'hello@example.com'],
      ['Contact', 'Contact methods › Email › Value', 'text', 'hello@example.com'],
      ['Contact', 'Contact methods › Email › Link', 'link', 'hello@example.com'],
      ['Footer', 'Contact links › hello@example.com › Label', 'text', 'hello@example.com'],
      ['Footer', 'Contact links › hello@example.com › Destination', 'link', 'hello@example.com']
    ]);
    // The number as written and as its links dial it are the same sample.
    expect(rows(group(s, 'phone'))).toEqual([
      ['Contact', 'Contact methods › Phone › Value', 'text', '+1 555 0134'],
      ['Contact', 'Contact methods › Phone › Link', 'link', '+15550134'],
      ['Footer', 'Contact links › +1 555 0134 › Label', 'text', '+1 555 0134'],
      ['Footer', 'Contact links › +1 555 0134 › Destination', 'link', '+15550134']
    ]);
    // The header's call to action goes to the Contact page, not to a sample address.
    expect(sampleContactMatches(s).flatMap((g) => g.matches).some((m) => m.field.where === 'Header')).toBe(false);
  });

  it('leaves out a blank site, which starts with no sample details', () => {
    expect(sampleContactMatches(createStarterState('blank', 'Kloof', false))).toEqual([]);
  });

  it('finds the details in rich text and inline links written any way, and holds one that runs into another address or number', () => {
    const { s } = withParagraph([
      {
        type: 'p',
        spans: [
          // A link that starts the paragraph is found like any other, and keeps its subject when it is replaced.
          { text: 'Email us', link: { type: 'email', target: 'hello@example.com?subject=Hi' } },
          { text: ' or write to Hello@Example.com, call +1\u00a0555-0134 (24 hours) or + 1 555 0134, or visit 12 Harbour  Lane,Millbrook. ' },
          // Someone else's, never found: a longer mailbox or domain, a longer number.
          { text: 'Not myhello@example.com, hello@example.com.au or +1 555 01345. ' },
          // Perhaps someone else's: found, so none goes out unreviewed, but changed only in the inspector.
          { text: "Maybe o'hello@example.com, 'hello@example.com', ops@hello@example.com, +1 555 0134 24/7, +1 555 0134-5, +1 555\u20130134 -5, +44 (20) 1555 0134, +44 (20) / 1555\u20130134, +44 20/1555 0134, 12 Harbour Lane, Millbrook\u2011East or 12 Harbour Lane, Millbrook--East. " },
          { text: 'Also +1 555 0134 (567), Call+1 555 0134, 12 Harbour Lane, Millbrook\u2013 East and "hello@example.com"@company.org. ' },
          { text: 'Directions', link: { type: 'url', target: 'https://maps.example.org/?q=+15550134' } },
          { text: ' or ' },
          { text: 'the front desk', link: { type: 'email', target: 'HELLO@example.com' } }
        ]
      }
    ]);
    const on = (kind: string) => group(s, kind).filter((m) => m.field.where === 'About');
    const shown = (kind: string) => on(kind).map((m) => [m.kind, m.match, !!m.blocked]);
    // A paragraph's words come before its links, as search lists them.
    expect(shown('email')).toEqual([
      ['text', 'Hello@Example.com', false],
      ['text', 'hello@example.com', true],
      ['text', 'hello@example.com', true],
      ['text', 'hello@example.com', true],
      ['text', 'hello@example.com', true],
      ['link', 'hello@example.com', false],
      ['link', 'HELLO@example.com', false]
    ]);
    // Listed on one line, as the result list shows them.
    // Words or digits after it may carry the number on, "(24 hours)" as much as "(567)": held, to check by eye.
    expect(shown('phone')).toEqual([
      ['text', '+1 555-0134', true],
      ['text', '+ 1 555 0134', false],
      ['text', '+1 555 0134', true],
      ['text', '+1 555 0134', true],
      ['text', '+1 555\u20130134', true],
      ['text', '1555 0134', true],
      ['text', '1555\u20130134', true],
      ['text', '1555 0134', true],
      ['text', '+1 555 0134', true],
      ['text', '+1 555 0134', true]
    ]);
    expect(on('phone')[2].blocked).toMatch(/runs into other digits/);
    expect(shown('address')).toEqual([
      ['text', '12 Harbour Lane,Millbrook', false],
      ['text', '12 Harbour Lane, Millbrook', true],
      ['text', '12 Harbour Lane, Millbrook', true],
      ['text', '12 Harbour Lane, Millbrook', true]
    ]);

    const mid = apply(s, on('email'), 'studio@kloof.example').after;
    const after = apply(mid, group(mid, 'phone').filter((m) => m.field.where === 'About'), '+27 21 555 0199').after;
    const spans = (after.pages[pageAt(after, '/about/').id].nodes.n_rich_para as { text: RichText }).text[0] as { spans: Array<{ text: string; link?: LinkValue }> };
    expect(spans.spans[0]).toEqual({ text: 'Email us', link: { type: 'email', target: 'studio@kloof.example?subject=Hi' } });
    expect(spans.spans.at(-1)).toEqual({ text: 'the front desk', link: { type: 'email', target: 'studio@kloof.example' } });
    const words = spans.spans.map((x) => x.text).join('');
    expect(words).toContain('write to studio@kloof.example, call +1\u00a0555-0134 (24 hours) or +27 21 555 0199, or visit');
    expect(words).toContain('Not myhello@example.com, hello@example.com.au or +1 555 01345.');
    // What was held is as it was.
    expect(words).toContain("Maybe o'hello@example.com, 'hello@example.com', ops@hello@example.com, +1 555 0134 24/7, +1 555 0134-5, +1 555\u20130134 -5, +44 (20) 1555 0134, +44 (20) / 1555\u20130134, +44 20/1555 0134, 12 Harbour Lane, Millbrook\u2011East or 12 Harbour Lane, Millbrook--East.");
    expect(words).toContain('Also +1 555 0134 (567), Call+1 555 0134, 12 Harbour Lane, Millbrook\u2013 East and "hello@example.com"@company.org.');
  });

  it('finds the sample among the recipients of an email link, and leaves that link to the inspector', () => {
    const s = fresh();
    const details = instanceOf(s, 'contact.details', pageAt(s, '/contact/').id);
    // A list of recipients, as a pasted mailto: link can name them; an edit never stores one.
    details.props.actionLink = { type: 'email', target: 'owner@kloof.example,hello@example.com?subject=Hi' };
    const action = group(s, 'email').filter((m) => m.field.label === 'Action link');
    expect(action.map((m) => [m.match, m.start])).toEqual([['hello@example.com', 20]]);
    // It is changed in the inspector: a replacement elsewhere never waits on a link the project would refuse.
    expect(action[0].blocked).toMatch(/other recipients/);
    const plan = planReplace(s, group(s, 'email'), 'studio@kloof.example');
    expect(plan.error).toBeUndefined();
    expect(plan.skipped).toBe(1);
    // Copied in, it is still sent to.
    details.props.actionLink = { type: 'email', target: 'owner@kloof.example?cc=hello%40example.com' };
    const copied = group(s, 'email').filter((m) => m.field.label === 'Action link');
    expect(copied.map((m) => [m.match, m.start])).toEqual([['?cc=hello%40example.com', 19]]);
    expect(copied[0].blocked).toMatch(/copies the sample address in/);
  });

  it('takes a telephone link that dials the sample as a whole, however it is written, and no other number', () => {
    const s = fresh();
    const footer = footerOf(s);
    const tel = (target: string, i: number) => ({ id: `i_tel${i}`, label: 'Call', link: { type: 'tel', target } });
    footer.props.contact = ['+ 1 555 0134', '1-555-0134', '+1 555 0134-5', '+44 20 1555 0134'].map(tel);
    const links = group(s, 'phone').filter((m) => m.field.where === 'Footer');
    expect(links.map((m) => [m.field.label, m.match])).toEqual([
      ['Contact links › Call › Destination', '+ 1 555 0134'],
      ['Contact links › Call › Destination', '1-555-0134']
    ]);
    const after = apply(s, links, '+27 21 555 0199').after;
    expect((footerOf(after).props.contact as ListItem[]).map((i) => (i.link as LinkValue).target)).toEqual(['+27 21 555 0199', '+27 21 555 0199', '+1 555 0134-5', '+44 20 1555 0134']);
  });

  it('counts what the published website shows: not a draft, and the shared footer only while a published page shows it', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    contact.draft = true;
    // A draft that hides the footer is not one the footer reaches.
    const about = pageAt(s, '/about/');
    about.draft = true;
    about.showFooter = false;
    const footer = group(s, 'email');
    expect(footer.map((m) => m.field.where)).toEqual(['Footer', 'Footer']);
    // One edit to the shared footer changes the draft that shows it too, and says so, as Find does.
    expect(footer.every((m) => m.field.sharedPages === 2)).toBe(true);
    expect(footer.map((m) => m.field)).toEqual(findContent(s, 'hello@example.com').filter((m) => m.field.where === 'Footer').map((m) => m.field));
    for (const p of Object.values(s.pages)) if (p.id !== contact.id) p.showFooter = false;
    expect(sampleContactMatches(s)).toEqual([]);
  });

  it('reads what a page shows as the published website builds it: a button to a draft is left out there', () => {
    const s = fresh();
    const home = s.pages[s.site.homePageId];
    const about = pageAt(s, '/about/');
    home.nodes.n_mail_btn = { id: 'n_mail_btn', kind: 'link', label: 'hello@example.com', link: { type: 'page', target: about.id }, appearance: 'primary' };
    home.rootIds.push('n_mail_btn');
    const onHome = () => group(s, 'email').filter((m) => m.field.owner.id === home.id).map((m) => m.field.label);
    expect(onHome()).toEqual(['Button label']);
    about.draft = true;
    expect(onHome()).toEqual([]);
  });

  it('replaces each detail everywhere in one step, the number as written and as dialled, and finds none left', () => {
    let s = fresh();
    s = apply(s, group(s, 'email'), 'studio@kloof.example').after;
    s = apply(s, group(s, 'phone'), '+27 21 555 0199').after;
    expect(sampleContactMatches(s).map((g) => g.kind)).toEqual(['address']);
    const details = instanceOf(s, 'contact.details', pageAt(s, '/contact/').id);
    expect(details.props.actionLink).toEqual({ type: 'email', target: 'studio@kloof.example' });
    expect(item(details, 'items', 'Phone')).toMatchObject({ value: '+27 21 555 0199', link: { type: 'tel', target: '+27 21 555 0199' } });
    expect((footerOf(s).props.contact as ListItem[]).map((i) => [i.label, (i.link as LinkValue).target])).toEqual([
      ['studio@kloof.example', 'studio@kloof.example'],
      ['+27 21 555 0199', '+27 21 555 0199']
    ]);
  });
});

describe('replacing in a session', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('changes a page and the shared footer in one step that undoes and redoes as one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-find-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, fresh());
    const keep = (st: ProjectState) => JSON.parse(JSON.stringify({ site: st.site, pages: st.pages, components: st.components }));
    const before = keep(session.state);
    const plan = planReplace(session.state, findContent(session.state, 'hello@example.com'), 'books@example.org');
    expect(plan.error).toBeUndefined();
    expect(plan.operations.length).toBeGreaterThan(1);
    const r = await session.apply({ operations: plan.operations, expectedRevision: session.revision }, { label: 'Replace “hello@example.com”' });
    expect(r.ok).toBe(true);
    expect(findContent(session.state, 'hello@example.com')).toEqual([]);
    expect(findContent(session.state, 'books@example.org').map((m) => m.field.where)).toEqual(['Contact', 'Contact', 'Contact', 'Footer', 'Footer']);
    const done = keep(session.state);
    await session.undo();
    expect(keep(session.state)).toEqual(before);
    await session.redo();
    expect(keep(session.state)).toEqual(done);
  });
});
