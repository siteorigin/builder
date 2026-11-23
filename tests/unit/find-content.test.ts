import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphNode, InstanceNode, LinkValue, ListItem, ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { renderedContent } from '@generator/checks';
import { contentFields, contentTarget, findContent, placedSections, planReplace, sectionMatches, type ContentMatch } from '../../src/renderer/src/lib/find-content';
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

    // A page without the shared header and footer does not count.
    s.pages[pageAt(s, '/about/').id].shell = 'none';
    expect(findContent(s, 'hello@example.com').find((m) => m.field.where === 'Footer')?.field.sharedPages).toBe(2);
  });

  it('finds the starter’s contact details shown from a component’s defaults, and keeps settings out', () => {
    const s = fresh();
    // The footer shows its component's own contact links when the placement has none of its own.
    delete footerOf(s).props.contact;
    const def = s.components[footerOf(s).definitionId];
    const defaults = (def.properties.contact as { default: ListItem[] }).default;
    const ms = findContent(s, defaults[0].label as string).filter((m) => m.field.where === 'Footer');
    expect(ms.map((m) => m.kind)).toEqual(['text', 'link']);
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

  it('matches the words in order across spacing, case-insensitively unless asked, and never as a pattern', () => {
    const { s } = withParagraph([{ type: 'p', spans: [{ text: 'Reading group: the reading group meets at (7pm).' }] }]);
    expect(findContent(s, 'reading group').map((m) => m.start)).toEqual([0, 19]);
    expect(findContent(s, 'reading group', { matchCase: true }).map((m) => m.start)).toEqual([19]);
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
    const start = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: details.id, prop: 'actionLink', value: { type: 'email', target: 'hello@example.com?subject=Reading%20group', newTab: true } }]).state;
    const { plan, after } = apply(start, only(findContent(start, 'hello@example.com'), 'Action link'), 'books@example.org');
    const placed = instanceOf(after, 'contact.details', contact.id);
    expect(placed.props.actionLabel).toBe('Email us');
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
      ['Action label', 'text', 'Email us', '', false],
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

describe('opening a match', () => {
  it('opens a shared footer item on a page that shows the footer, at the item’s part', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    s.pages[about.id].shell = 'none';
    const m = findContent(s, 'hello@example.com').find((x) => x.field.where === 'Footer' && x.kind === 'text')!;
    const footer = footerOf(s);
    const target = contentTarget(s, m.field, about.id)!;
    expect(target.pageId).toBe(s.site.homePageId);
    expect(target.selection).toMatchObject({ owner: { kind: 'shell', id: 'footer' }, instancePath: [footer.id], nodeId: m.field.defNodeId, itemPath: [m.field.source!.kind === 'prop' ? m.field.source.itemId : ''] });
    expect(contentTarget(s, m.field, pageAt(s, '/contact/').id)!.pageId).toBe(pageAt(s, '/contact/').id);
  });

  it('opens a code component’s field by selecting the placement and naming the field to open', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const added = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'contact.form' }]);
    const m = findContent(added.state, 'Send message')[0];
    expect(contentTarget(added.state, m.field, null)).toEqual({ pageId: contact.id, selection: { owner: { kind: 'page', id: contact.id }, instancePath: [], nodeId: added.results[0].nodeId }, reveal: { prop: 'submitLabel' } });
  });

  it('keeps each field’s key across an edit, so a review compares like with like', () => {
    const s = fresh();
    const keys = contentFields(s).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const { after } = apply(s, findContent(s, 'Test Studio'), 'Bookshop');
    expect(contentFields(after).map((f) => f.key)).toEqual(keys);
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
