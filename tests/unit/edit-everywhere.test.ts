import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, ElementRef, ImageNode, InstanceNode, LinkNode, ProjectState, TextNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';
import { readField } from '../../src/renderer/src/lib/held';
import { ProjectSession } from '../../src/main/project/session';
import { defaultReach, designContent, designContentOp, forwardedProp, propDefaultOp, reachText } from '../../src/renderer/src/lib/design-content';
import { definitionView, descOf, placementsOn, throughPlacement } from '../../src/renderer/src/lib/model';
import { placeSplitHero, servicesGrid, testimonials } from './fixtures/definition-tools-designs';

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/**
 * A fresh business site with its theme's `componentId` made a project component (what Edit everywhere does first).
 * Foundation's sections are code, with no design to edit, so the theme's design here is the managed one it used to
 * ship, the hero placed first on Home.
 */
function forked(componentId: 'hero.split' | 'features.grid' | 'testimonials.grid') {
  let s = createStarterState('business', 'Test Studio', false);
  let theme: ComponentDefinition;
  if (componentId === 'hero.split') theme = placeSplitHero(s).def;
  else {
    theme = componentId === 'features.grid' ? servicesGrid() : testimonials();
    s.components[theme.id] = theme;
  }
  const r = applyOperations(s, [{ type: 'component.fork', definitionId: theme.id }]);
  s = r.state;
  const defId = r.results[0].definitionId as string;
  return { s, defId, def: (st: ProjectState): ComponentDefinition => st.components[defId] };
}

/** The placements of a component on the home page, in page order. */
const placed = (s: ProjectState, defId: string) =>
  home(s)
    .rootIds.map((id) => home(s).nodes[id])
    .filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === defId);

describe('Edit everywhere offers the content a design owns', () => {
  it('names each node’s defaults, fixed values and per-item values', () => {
    const hero = forked('hero.split');
    const def = hero.def(hero.s);
    const node = (id: string) => def.tree!.nodes[id];
    expect(designContent(def, node('heading'))).toMatchObject([{ field: 'text', source: 'default', prop: 'heading', value: def.properties.heading.default }]);
    expect(designContent(def, node('primary'))).toMatchObject([
      { field: 'label', source: 'default', prop: 'primaryLabel' },
      { field: 'link', source: 'default', prop: 'primaryLink' }
    ]);
    expect(designContent(def, node('media'))).toMatchObject([{ field: 'image', source: 'default', prop: 'image' }]);

    const grid = forked('features.grid');
    const g = grid.def(grid.s);
    expect(designContent(g, g.tree!.nodes['card-icon'])).toEqual([{ field: 'icon', source: 'item', list: 'items', itemField: 'icon' }]);
    expect(designContent(g, g.tree!.nodes['card-link'])).toMatchObject([
      { field: 'label', source: 'item', itemField: 'linkLabel' },
      { field: 'link', source: 'item', itemField: 'link' }
    ]);

    // A container that is one link (a card) offers its destination.
    const card = structuredClone(g.tree!.nodes.card);
    (card as { link?: unknown }).link = { $item: 'link' };
    expect(designContent(g, card)).toEqual([{ field: 'link', source: 'item', list: 'items', itemField: 'link' }]);
    expect(designContent(g, g.tree!.nodes.card)).toEqual([]);

    const quotes = forked('testimonials.grid');
    const q = quotes.def(quotes.s);
    const mark = q.tree!.nodes['quote-mark'];
    expect(designContent(q, mark)).toEqual([{ field: 'icon', source: 'design', value: (mark as { icon: string }).icon }]);
  });

  it('changes a bound default for the placements without their own value, keeps the binding, and undoes it', async () => {
    const hero = forked('hero.split');
    let s = hero.s;
    // A second placement, then one that has no heading of its own (as an older document or the AI can leave it).
    s = applyOperations(s, [{ type: 'node.duplicate', owner: owner(s), nodeId: placed(s, hero.defId)[0].id }]).state;
    const [own, bare] = placed(s, hero.defId);
    delete (home(s).nodes[bare.id] as InstanceNode).props.heading;
    const before = hero.def(s).properties.heading.default;

    const reach = defaultReach(s, hero.defId, 'heading');
    expect(reach.placements.map((p) => p.node.id)).toEqual([own.id, bare.id]);
    expect(reach.showing.map((p) => p.node.id)).toEqual([bare.id]);
    expect(reachText(reach)).toBe('Shown on Home (1 of 2 placements). New placements start with it.');

    const dir = mkdtempSync(join(tmpdir(), 'so-everywhere-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    try {
      const op = designContentOp(hero.def(s), 'heading', 'text', 'Made by hand, shipped worldwide');
      expect(op).toEqual({ type: 'node.setContent', owner: { kind: 'component', id: hero.defId }, nodeId: 'heading', field: 'text', value: 'Made by hand, shipped worldwide' });
      const res = await session.apply({ operations: [op] }, { label: 'Edit Heading default', source: 'user' });
      expect(res.ok).toBe(true);
      let def = session.state.components[hero.defId];
      expect(def.properties.heading.default).toBe('Made by hand, shipped worldwide');
      expect((def.tree!.nodes.heading as TextNode).text).toEqual({ $prop: 'heading' });
      // The placement without a heading of its own shows the new default; the other keeps its own.
      expect((session.state.pages[s.site.homePageId].nodes[own.id] as InstanceNode).props.heading).toBe(own.props.heading);
      const page = generateProject(session.state).get('src/routes/+page.svelte')!;
      expect(page.split('Made by hand, shipped worldwide').length - 1).toBe(1);
      // The default is the property's, not written into the placement that shows it.
      expect(Object.hasOwn((session.state.pages[s.site.homePageId].nodes[bare.id] as InstanceNode).props, 'heading')).toBe(false);
      expect(page).toContain(String(own.props.heading));

      await session.undo();
      def = session.state.components[hero.defId];
      expect(def.properties.heading.default).toEqual(before);
      expect(generateProject(session.state).get('src/routes/+page.svelte')).not.toContain('Made by hand, shipped worldwide');
    } finally {
      await session.close();
    }
  });

  it('changes a button’s default label and link, a default image, and an icon fixed in the design', () => {
    const hero = forked('hero.split');
    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    let s = applyOperations(hero.s, [{ type: 'asset.add', asset: pic }]).state;
    const link = { type: 'url' as const, target: 'https://example.com/tour' };
    s = applyOperations(s, [designContentOp(hero.def(s), 'primary', 'label', 'Book a tour'), designContentOp(hero.def(s), 'primary', 'link', link)]).state;
    expect(hero.def(s).properties.primaryLabel.default).toBe('Book a tour');
    expect(hero.def(s).properties.primaryLink.default).toMatchObject(link);
    expect((hero.def(s).tree!.nodes.primary as LinkNode).label).toEqual({ $prop: 'primaryLabel' });
    expect((hero.def(s).tree!.nodes.primary as LinkNode).link).toEqual({ $prop: 'primaryLink' });
    s = applyOperations(s, [designContentOp(hero.def(s), 'media', 'image', { assetId: pic.id, alt: 'Studio' })]).state;
    expect(hero.def(s).properties.image.default).toMatchObject({ assetId: pic.id, alt: 'Studio' });
    expect((hero.def(s).tree!.nodes.media as ImageNode).image).toEqual({ $prop: 'image' });

    const quotes = forked('testimonials.grid');
    const t = applyOperations(quotes.s, [designContentOp(quotes.def(quotes.s), 'quote-mark', 'icon', 'star')]).state;
    expect((quotes.def(t).tree!.nodes['quote-mark'] as { icon: string }).icon).toBe('star');
  });

  it('says when every placement has its own value', () => {
    const hero = forked('hero.split');
    const reach = defaultReach(hero.s, hero.defId, 'heading');
    expect(reach.showing).toEqual([]);
    expect(reachText(reach)).toBe('Every placement has its own, so none change. New placements start with it.');
  });

  it('counts a placement holding null as showing the default, as the site does', () => {
    const hero = forked('hero.split');
    const s = structuredClone(hero.s);
    const [placement] = placed(s, hero.defId);
    (home(s).nodes[placement.id] as InstanceNode).props.image = null;
    expect(defaultReach(s, hero.defId, 'image').showing.map((p) => p.node.id)).toEqual([placement.id]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Two "Outer" sections on the home page, each holding two "Card" components whose heading is a part. The second
 * card's heading is filled in from Outer's own "title" property.
 */
function nested() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const o = owner(s);
  s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
  const cardStack = home(s).rootIds[0];
  s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: cardStack, primitive: 'heading', text: 'Card title' }]).state;
  const card = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: cardStack, name: 'Card' }]);
  s = card.state;
  const cardId = card.results[0].definitionId as string;
  const firstCard = card.results[0].nodeId as string;
  s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
  const outerStack = home(s).rootIds[0];
  s = applyOperations(s, [{ type: 'node.move', owner: o, nodeId: firstCard, parentId: outerStack, index: 0 }]).state;
  s = applyOperations(s, [{ type: 'node.duplicate', owner: o, nodeId: firstCard }]).state;
  const outer = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: outerStack, name: 'Outer' }]);
  s = outer.state;
  const outerId = outer.results[0].definitionId as string;
  const outer1 = outer.results[0].nodeId as string;
  const outerDef = s.components[outerId];
  const [cardA, cardB] = (outerDef.tree!.nodes[outerDef.tree!.rootIds[0]] as { children: string[] }).children;
  const defOwner = { kind: 'component' as const, id: outerId };
  s = applyOperations(s, [
    { type: 'component.setPropSchema', definitionId: outerId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Welcome' } },
    { type: 'node.setBinding', owner: defOwner, nodeId: cardB, field: 'prop', prop: 'heading', binding: { $prop: 'title' } }
  ]).state;
  s = applyOperations(s, [{ type: 'node.duplicate', owner: o, nodeId: outer1 }]).state;
  const outer2 = home(s).rootIds.find((id) => id !== outer1 && (home(s).nodes[id] as InstanceNode).definitionId === outerId)!;
  const heading = s.components[cardId].parts.heading.nodeId;
  const part = (inst: string): ElementRef => ({ owner: defOwner, instancePath: [inst], nodeId: heading, partId: 'heading' });
  const at = (instancePath: string[], nodeId: string): ElementRef => ({ owner: owner(s), instancePath, nodeId });
  return { s, cardId, outerId, outer1, outer2, cardA, cardB, heading, part, at, defOwner };
}

describe('changing only a property’s default', () => {
  it('leaves every placement’s own value as it is, even one a schema change would rewrite', () => {
    const hero = forked('hero.split');
    let s = hero.s;
    const [placement] = placed(s, hero.defId);
    // A value stored before today's rules (a lead that reads as a list when normalized again).
    (home(s).nodes[placement.id] as InstanceNode).props.lead = '- Shipping';
    s = applyOperations(s, [propDefaultOp(hero.defId, 'lead', 'Small batches, made to order.')]).state;
    expect((home(s).nodes[placement.id] as InstanceNode).props.lead).toBe('- Shipping');
    expect(hero.def(s).properties.lead.default).toBeTruthy();
    expect(hero.def(s).properties.lead.default).not.toEqual(hero.def(hero.s).properties.lead.default);
  });

  it('refuses a theme’s own component', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const theme = Object.values(s.components).find((d) => d.componentId === 'hero.split')!;
    expect(() => applyOperations(s, [propDefaultOp(theme.id, 'heading', 'x')])).toThrow();
  });
});

describe('a component placed in the design being edited everywhere', () => {
  it('shows its part’s own inspector for its Layers row, not the overview', () => {
    const t = nested();
    const view = definitionView(t.s, t.outerId, t.part(t.cardB));
    expect(view.kind).toBe('nested-part');
    if (view.kind !== 'nested-part') return;
    expect(view.def.id).toBe(t.cardId);
    expect(view.instance.id).toBe(t.cardB);
    expect(view.node.id).toBe(t.heading);
    // The component's own nodes, and the nested placement itself, keep the design's node inspector.
    expect(definitionView(t.s, t.outerId, { owner: t.defOwner, instancePath: [], nodeId: t.cardB }).kind).toBe('node');
    // Nothing selected, or a pick outside the design: the overview.
    expect(definitionView(t.s, t.outerId, null).kind).toBe('overview');
    expect(definitionView(t.s, t.outerId, t.at([], t.outer1)).kind).toBe('overview');
  });

  it('outlines that part in the placement it was entered through, in the right nested component', () => {
    const t = nested();
    const placements = placementsOn(t.s, t.outerId, t.s.site.homePageId);
    expect(placements.map((p) => p.nodeId).sort()).toEqual([t.outer1, t.outer2].sort());
    const through = placements.find((p) => p.nodeId === t.outer2)!;
    const shown = descOf(t.s, throughPlacement(t.part(t.cardB), through));
    expect(shown).toEqual(descOf(t.s, { ...t.at([t.outer2, t.cardB], t.heading), partId: 'heading' }));
    // Not its sibling card, and not the same card in the other placement.
    expect(shown).not.toEqual(descOf(t.s, { ...t.at([t.outer2, t.cardA], t.heading), partId: 'heading' }));
    expect(shown).not.toEqual(descOf(t.s, { ...t.at([t.outer1, t.cardB], t.heading), partId: 'heading' }));
  });

  it('edits a value the design fills in from its own property as that property’s default', () => {
    const t = nested();
    const cardB = t.s.components[t.outerId].tree!.nodes[t.cardB] as InstanceNode;
    expect(forwardedProp(cardB.props.heading)).toBe('title');
    expect(forwardedProp(cardB.props.missing)).toBeNull();
    // One of the two Outer placements shows the default; the other has its own title.
    let s = applyOperations(t.s, [{ type: 'instance.setProp', owner: owner(t.s), nodeId: t.outer2, prop: 'title', value: 'Pricing' }]).state;
    delete (home(s).nodes[t.outer1] as InstanceNode).props.title;
    expect(defaultReach(s, t.outerId, 'title').showing.map((p) => p.node.id)).toEqual([t.outer1]);
    const op = propDefaultOp(t.outerId, 'title', 'Hello there');
    expect(op).toEqual({ type: 'component.setPropDefault', definitionId: t.outerId, prop: 'title', value: 'Hello there' });
    // A held edit can check the field it changes, as for every other content edit.
    expect(readField(s, op)).toMatchObject({ found: true, value: { value: 'Welcome' } });
    s = applyOperations(s, [op]).state;
    expect(s.components[t.outerId].properties.title).toEqual({ type: 'string', label: 'Title', default: 'Hello there' });
    // The forwarding binding and the placement with its own title are kept.
    expect((s.components[t.outerId].tree!.nodes[t.cardB] as InstanceNode).props.heading).toEqual({ $prop: 'title' });
    expect((home(s).nodes[t.outer2] as InstanceNode).props.title).toBe('Pricing');
    expect(Object.hasOwn((home(s).nodes[t.outer1] as InstanceNode).props, 'title')).toBe(false);
    expect(() => applyOperations(s, [propDefaultOp(t.outerId, 'nope', 'x')])).toThrow(/has no property "nope"/);
  });
});
