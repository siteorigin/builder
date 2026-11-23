import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphNode, InstanceNode, LinkValue, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, pageLinkReferences } from '@engine/apply';
import { pageLinkUses } from '@engine/page-links';
import { validateState } from '@engine/validate';
import { installComponent, makeInstance } from '@engine/install';
import { normalizeRichText } from '@engine/values';
import { pageSections } from '@generator/checks';
import { planPageRemoval, reviewPageRemoval } from '../../src/renderer/src/lib/page-removal';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);
const pageAt = (s: ProjectState, route: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === route)!;
const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
const footerOf = (s: ProjectState) => s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
const instanceOf = (s: ProjectState, componentId: string, pageId: string) =>
  Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;
const missing = (s: ProjectState) => validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING');
const cta = (s: ProjectState) => headerOf(s).props.ctaLink as LinkValue;
const header = { kind: 'shell' as const, id: 'header' };

/** The issue's setup: Contact details carries #studio-hours, and the header's action jumps to it. */
function linkedToSection(link: Partial<LinkValue> = {}) {
  let s = fresh();
  const contact = pageAt(s, '/contact/');
  const about = pageAt(s, '/about/');
  const details = instanceOf(s, 'contact.details', contact.id);
  s = applyOperations(s, [
    { type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: details.id, field: 'anchor', value: 'studio-hours' },
    { type: 'instance.setProp', owner: header, nodeId: headerOf(s).id, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: 'studio-hours', ...link } }
  ]).state;
  expect(missing(s)).toEqual([]);
  return { s, contact, about };
}

/** About's sections that have no ID yet, which a choice in the dialog gives one. */
const unanchored = (s: ProjectState, pageId: string) => pageSections(s, pageId).filter((x) => !x.anchor && !x.nested);

/** Two sections on a page that read the same ("Hours"), neither with an ID: each needs one of its own. */
function twoHours(s: ProjectState, pageId: string) {
  const page = s.pages[pageId];
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const heading: GraphNode = { id: `n_hours_h${n}`, kind: 'text', tag: 'h2', text: 'Hours' };
    const section: GraphNode = { id: `n_hours_${n}`, kind: 'element', tag: 'section', children: [heading.id] };
    page.nodes[heading.id] = heading;
    page.nodes[section.id] = section;
    page.rootIds.push(section.id);
    ids.push(section.id);
  }
  expect(pageSections(s, pageId).filter((x) => ids.includes(x.nodeId)).map((x) => [x.label, x.anchor])).toEqual([
    ['Hours', undefined],
    ['Hours', undefined]
  ]);
  return ids;
}

/** Points the footer's Contact link at a section of Contact. */
function footerToSection(s: ProjectState, contactId: string, anchor: string) {
  const item = (footerOf(s).props.links as Array<{ id: string; link: LinkValue }>).find((i) => i.link.target === contactId)!;
  const next = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: footerOf(s).id, prop: 'links', itemId: item.id, field: 'link', value: { type: 'page', target: contactId, anchor } }]).state;
  return { s: next, itemId: item.id };
}
const footerLink = (s: ProjectState, itemId: string) => (footerOf(s).props.links as Array<{ id: string; link: LinkValue }>).find((i) => i.id === itemId)!.link;

describe('deleting a page with a replacement', () => {
  it('never leaves a link at a section the replacement page does not have', () => {
    const { s, contact, about } = linkedToSection();
    const next = applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }]).state;
    expect(cta(next)).toEqual({ type: 'page', target: about.id });
    expect(next.pages[contact.id]).toBeUndefined();
    expect(next.site.pageOrder).not.toContain(contact.id);
    expect(missing(next)).toEqual([]);
  });

  it('keeps a section the replacement page also has, whatever was chosen for it', () => {
    const { s, contact, about } = linkedToSection();
    const section = unanchored(s, about.id)[0];
    const give = { type: 'node.setContent' as const, owner: { kind: 'page' as const, id: about.id }, nodeId: section.nodeId, field: 'anchor' as const, value: 'studio-hours' };
    const kept = applyOperations(s, [give, { type: 'page.remove', pageId: contact.id, replacementPageId: about.id }]).state;
    expect(cta(kept)).toEqual({ type: 'page', target: about.id, anchor: 'studio-hours' });
    expect(missing(kept)).toEqual([]);
    for (const to of ['', 'main']) {
      const chosen = applyOperations(s, [give, { type: 'page.remove', pageId: contact.id, replacementPageId: about.id, sectionReplacements: [{ from: 'studio-hours', to }] }]).state;
      expect(cta(chosen)).toEqual({ type: 'page', target: about.id, anchor: 'studio-hours' });
    }
  });

  it('sends links to each missing section where it was chosen, or to the top of the page', () => {
    const linked = linkedToSection();
    const { contact, about } = linked;
    const { s, itemId } = footerToSection(linked.s, contact.id, 'visit');
    const section = unanchored(s, about.id)[0];
    const next = applyOperations(s, [
      { type: 'node.setContent', owner: { kind: 'page', id: about.id }, nodeId: section.nodeId, field: 'anchor', value: 'our-hours' },
      {
        type: 'page.remove',
        pageId: contact.id,
        replacementPageId: about.id,
        sectionReplacements: [
          { from: '#studio-hours', to: '#our-hours' },
          { from: 'visit', to: 'main' }
        ]
      }
    ]).state;
    expect(cta(next)).toEqual({ type: 'page', target: about.id, anchor: 'our-hours' });
    expect(footerLink(next, itemId)).toEqual({ type: 'page', target: about.id, anchor: 'main' });
    // Without a choice, the missing section goes to the top.
    const top = applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id, sectionReplacements: [{ from: 'visit', to: 'main' }] }]).state;
    expect(cta(top)).toEqual({ type: 'page', target: about.id });
    expect(missing(next)).toEqual([]);
  });

  it('refuses a choice the replacement page cannot honour, changing nothing', () => {
    const { s, contact, about } = linkedToSection();
    const remove = (sectionReplacements: Array<{ from: string; to: string }>) => () => applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id, sectionReplacements }]);
    expect(remove([{ from: 'studio-hours', to: 'nowhere' }])).toThrow(/has no section with the ID "nowhere"/);
    expect(
      remove([
        { from: 'studio-hours', to: '' },
        { from: '#studio-hours', to: 'main' }
      ])
    ).toThrow(/more than one section/);
    // A mistyped section would otherwise leave its links at the top of the page without a word.
    expect(remove([{ from: 'studio-hour', to: 'main' }])).toThrow(/No link to "Contact" goes to #studio-hour/);
    expect(cta(s).target).toBe(contact.id);
    // Choices need a page to be made on, even where nothing links to the page.
    const unlinked = fresh();
    const extra = applyOperations(unlinked, [{ type: 'page.create', title: 'Extra' }]);
    const extraId = extra.results[0].pageId as string;
    expect(() => applyOperations(extra.state, [{ type: 'page.remove', pageId: extraId, sectionReplacements: [{ from: 'x', to: '' }] }])).toThrow(/only be chosen on a replacement page/);
  });

  it('keeps every other part of the link, and leaves links to other pages alone', () => {
    const { s, contact, about } = linkedToSection({ newTab: true });
    const nav = (st: ProjectState) => (headerOf(st).props.links as Array<{ label: string; link: LinkValue }>).map((i) => [i.label, i.link]);
    const before = nav(s);
    const next = applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }]).state;
    expect(cta(next)).toEqual({ type: 'page', target: about.id, newTab: true });
    expect(nav(next)).toEqual([before[0], before[1], ['Contact', { type: 'page', target: about.id }]]);
    expect(before[0][1]).toEqual({ type: 'page', target: s.site.homePageId });
    expect(headerOf(next).props.ctaLabel).toBe('Book a call');
  });

  it('judges a section the shared footer provides by whether the replacement shows it', () => {
    let s = fresh();
    const contact = pageAt(s, '/contact/');
    const about = pageAt(s, '/about/');
    s = applyOperations(s, [
      { type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footerOf(s).id, field: 'anchor', value: 'studio-hours' },
      { type: 'instance.setProp', owner: header, nodeId: headerOf(s).id, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: 'studio-hours' } }
    ]).state;
    expect(missing(s)).toEqual([]);
    const shown = applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }]).state;
    expect(cta(shown)).toEqual({ type: 'page', target: about.id, anchor: 'studio-hours' });
    const bare = applyOperations(s, [
      { type: 'page.update', pageId: about.id, shell: 'none' },
      { type: 'page.remove', pageId: contact.id, replacementPageId: about.id }
    ]).state;
    expect(cta(bare)).toEqual({ type: 'page', target: about.id });
  });

  it('moves links in rich text and in component defaults, and needs no replacement for links on the page itself', () => {
    let s = fresh();
    const contact = pageAt(s, '/contact/');
    const home = s.pages[s.site.homePageId];
    const text: GraphNode = { id: 'n_note', kind: 'text', tag: 'div', rich: true, text: normalizeRichText(`Ask about [our hours](${contact.route}#hours).`, s, 'Text') };
    home.nodes[text.id] = text;
    home.rootIds.push(text.id);
    const def = Object.values(s.components).find((d) => d.properties.primaryLink?.type === 'link')!;
    def.properties.primaryLink.default = { type: 'page', target: contact.id };
    const uses = pageLinkUses(s, contact.id);
    expect(uses.find((u) => u.label === 'our hours')).toMatchObject({ where: home.title, link: { anchor: 'hours' } });
    expect(uses.find((u) => u.owner.kind === 'component' && u.owner.id === def.id)?.where).toBe(`${def.name} (default)`);
    const next = applyOperations(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: home.id }]).state;
    const span = (next.pages[home.id].nodes[text.id] as GraphNode & { text: Array<{ spans: Array<{ link?: LinkValue }> }> }).text[0].spans.find((sp) => sp.link)!;
    expect(span.link).toEqual({ type: 'page', target: home.id });
    expect(next.components[def.id].properties.primaryLink.default).toEqual({ type: 'page', target: home.id });
    expect(JSON.stringify(next)).not.toContain(contact.id);
    expect(missing(next)).toEqual([]);

    // A page linked only from itself goes without asking where its links go.
    s = fresh();
    const about = pageAt(s, '/about/');
    for (const u of pageLinkUses(s, about.id)) u.link.target = s.site.homePageId;
    expect(pageLinkReferences(s, about.id)).toBe(0);
    const self: GraphNode = { id: 'n_self', kind: 'link', label: 'Back to top', link: { type: 'page', target: about.id }, appearance: 'text' };
    about.nodes[self.id] = self;
    about.rootIds.push(self.id);
    expect(pageLinkReferences(s, about.id)).toBe(0);
    expect(applyOperations(s, [{ type: 'page.remove', pageId: about.id }]).state.pages[about.id]).toBeUndefined();
  });
});

describe('the delete dialog’s review', () => {
  it('names every link that moves by its label and where it is', () => {
    const { s, contact, about } = linkedToSection();
    const home = s.pages[s.site.homePageId];
    const rows = reviewPageRemoval(s, contact.id, about.id).uses.map((u) => [u.where, u.label, u.link.anchor ?? '']);
    expect([...rows].sort()).toEqual(
      [
        ['Header', 'Contact', ''],
        ['Header', 'Book a call', 'studio-hours'],
        ['Footer', 'Contact', ''],
        [home.title, 'Start a project', ''],
        [home.title, 'Get in touch', ''],
        [about.title, 'Contact the studio', '']
      ].sort()
    );
  });

  it('names a card’s link by its own label before the card’s title', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const grid = instanceOf(s, 'features.grid', s.site.homePageId);
    const items = grid.props.items as Array<Record<string, unknown>>;
    items[0] = { ...items[0], linkLabel: 'Book a visit', link: { type: 'page', target: contact.id } };
    expect(pageLinkUses(s, contact.id).find((u) => u.link === items[0].link)?.label).toBe('Book a visit');
  });

  it('asks once for each section the replacement lacks, and deletes only once each has an answer', () => {
    const linked = linkedToSection();
    const { contact, about } = linked;
    const { s } = footerToSection(linked.s, contact.id, 'studio-hours');
    const review = reviewPageRemoval(s, contact.id, about.id);
    expect(review.missing.map((m) => [m.fragment, m.uses.map((u) => u.label).sort()])).toEqual([['studio-hours', ['Book a call', 'Contact']]]);
    expect(planPageRemoval(s, contact.id, about.id, new Map()).operations).toBeNull();
    expect(planPageRemoval(s, contact.id, about.id, new Map([['studio-hours', '']])).operations).toEqual([
      { type: 'page.remove', pageId: contact.id, replacementPageId: about.id, sectionReplacements: [{ from: 'studio-hours', to: '' }] }
    ]);
    // A section ID the page no longer has is never sent.
    expect(planPageRemoval(s, contact.id, about.id, new Map([['studio-hours', '#gone']])).operations).toBeNull();
    // A replacement that has the section asks nothing.
    const section = unanchored(s, about.id)[0];
    const withId = applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: about.id }, nodeId: section.nodeId, field: 'anchor', value: 'studio-hours' }]).state;
    expect(reviewPageRemoval(withId, contact.id, about.id).missing).toEqual([]);
    expect(reviewPageRemoval(withId, contact.id, withId.site.homePageId).missing).toHaveLength(1);
    expect(planPageRemoval(withId, contact.id, about.id, new Map()).operations).toEqual([{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }]);
  });

  it('gives each chosen section its own ID in the same batch, never one another missing section still means', () => {
    const linked = linkedToSection();
    const { contact, about } = linked;
    const { s, itemId } = footerToSection(linked.s, contact.id, 'hours');
    const [a, b] = twoHours(s, about.id);
    // "Book a call" goes to the first Hours section, the footer's #hours link to the second.
    const ops = planPageRemoval(
      s,
      contact.id,
      about.id,
      new Map([
        ['studio-hours', `node:${a}`],
        ['hours', `node:${b}`]
      ])
    ).operations!;
    expect(ops.map((o) => o.type)).toEqual(['node.setContent', 'node.setContent', 'page.remove']);
    const [idA, idB] = ops.slice(0, 2).map((o) => (o as { value: string }).value);
    // The first section cannot take "hours": the footer's link would then stay on it instead of going to the second.
    expect(idA).not.toBe('hours');
    expect(idB).toBe('hours');
    const next = applyOperations(s, ops).state;
    expect(next.pages[about.id].nodes[a].anchor).toBe(idA);
    expect(cta(next)).toEqual({ type: 'page', target: about.id, anchor: idA });
    expect(footerLink(next, itemId)).toEqual({ type: 'page', target: about.id, anchor: 'hours' });
    expect(next.pages[about.id].nodes[b].anchor).toBe('hours');
    expect(missing(next)).toEqual([]);
    // The same section chosen for both gets one ID, and both links go to it.
    const both = planPageRemoval(
      s,
      contact.id,
      about.id,
      new Map([
        ['studio-hours', `node:${a}`],
        ['hours', `node:${a}`]
      ])
    ).operations!;
    expect(both.map((o) => o.type)).toEqual(['node.setContent', 'page.remove']);
    // Two sections read alike and neither name is taken by a missing section: they still get different IDs.
    const linkedVisit = footerToSection(s, contact.id, 'visit').s;
    const pair = planPageRemoval(
      linkedVisit,
      contact.id,
      about.id,
      new Map([
        ['studio-hours', `node:${a}`],
        ['visit', `node:${b}`]
      ])
    ).operations!;
    const pairIds = pair.slice(0, 2).map((o) => (o as { value: string }).value);
    expect(pairIds[0]).toBe('hours');
    expect(pairIds[1]).toBe('hours-2');
    const shared = applyOperations(s, both).state;
    expect(cta(shared).anchor).toBe(shared.pages[about.id].nodes[a].anchor);
    expect(footerLink(shared, itemId).anchor).toBe(cta(shared).anchor);
  });

  it.each(['banner', 'top'])('refuses new IDs that would take #%s away from the page', (inherited) => {
    let { s, contact, about } = linkedToSection();
    // About's banner and a second placement inherit the ID from their component: neither owns it, so each is
    // offered for a new ID.
    const def = Object.values(s.components).find((d) => d.componentId === 'cta.banner')!;
    def.tree!.nodes[def.tree!.rootIds[0]].anchor = inherited;
    const page = s.pages[about.id];
    const second = makeInstance(s.components[installComponent(s, 'cta.banner')], {});
    page.nodes[second.id] = second;
    page.rootIds.push(second.id);
    const placed = [instanceOf(s, 'cta.banner', about.id).id, second.id];
    expect(Object.values(page.nodes).filter((n) => n.kind === 'instance' && n.definitionId === def.id)).toHaveLength(2);
    s = footerToSection(s, contact.id, 'visit').s;
    const plan = planPageRemoval(
      s,
      contact.id,
      about.id,
      new Map([
        ['studio-hours', `node:${placed[0]}`],
        ['visit', `node:${placed[1]}`]
      ])
    );
    expect(plan).toEqual({ operations: null, lost: [inherited] });
    // One of them keeps the ID while the other gets one of its own.
    expect(
      planPageRemoval(
        s,
        contact.id,
        about.id,
        new Map([
          ['studio-hours', `node:${placed[0]}`],
          ['visit', '']
        ])
      ).operations
    ).not.toBeNull();
  });
});

describe('deleting a page in a session', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('undoes the deletion, the moved links and a section’s new ID in one step', async () => {
    const { s: start, contact, about } = linkedToSection();
    const dir = mkdtempSync(join(tmpdir(), 'so-remove-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, start);
    const keep = (st: ProjectState) => JSON.parse(JSON.stringify({ site: st.site, pages: st.pages, components: st.components }));
    const before = keep(session.state);
    const section = unanchored(session.state, about.id)[0];
    const toAbout = pageLinkUses(session.state, about.id).length;
    const ops = planPageRemoval(session.state, contact.id, about.id, new Map([['studio-hours', `node:${section.nodeId}`]])).operations!;
    expect((await session.apply({ operations: ops, expectedRevision: session.revision }, { label: 'Delete page Contact' })).ok).toBe(true);
    expect(session.state.pages[contact.id]).toBeUndefined();
    const given = session.state.pages[about.id].nodes[section.nodeId].anchor;
    expect(given).toBeTruthy();
    expect(cta(session.state)).toEqual({ type: 'page', target: about.id, anchor: given });
    // Five of Contact's six links move here; About's own "Contact the studio" now points at its own page.
    expect(pageLinkUses(session.state, about.id).length).toBe(toAbout + 5);
    expect(JSON.stringify(session.state)).not.toContain(contact.id);
    await session.undo();
    expect(keep(session.state)).toEqual(before);
  });
});
