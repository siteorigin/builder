import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ImageValue, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { findParent } from '@engine/tree';
import { P, item, prop } from '@catalogue/dsl';
import { projectDesign, type DesignSpec } from './fixtures/packs';
import { GALLERY, SPLIT_HERO, TEAM } from './fixtures/image-drop-designs';
import { SECTION } from './fixtures/insert-at-designs';
import { showsItemsWithSoImage, showsWithSoImage } from '@generator/checks';
import { pointedAt } from '../../src/renderer/src/lib/payload';
import { aimKey, assetAim, imageDropOps, imageDropTargets, resolveImageDrop, showsFile, type ImageTarget, type PointedAt } from '../../src/renderer/src/lib/image-drop';
import type { InsertAim } from '../../src/renderer/src/lib/insert-drop';
import { descOf, type BridgeDesc } from '../../src/renderer/src/lib/model';

/**
 * Dragging an Assets image onto the canvas (#505): the images on the page that can take it, and the one a drop where
 * the pointer is changes. The page's answer for the pointer is the element chain it would send, built here from the
 * design the element belongs to.
 */

const asset = (id: string, alt: string): AssetRecord => ({
  id,
  name: id,
  file: `static/assets/${id}.png`,
  mime: 'image/png',
  bytes: 1000,
  width: 1200,
  height: 800,
  hash: id,
  kind: 'image',
  altSuggestion: alt,
  createdAt: '2026-11-24T09:00:00.000Z'
});
const nook = asset('img_nook', 'A reading corner with an armchair');
const studio = asset('img_studio', 'The studio at sunrise');

/**
 * Home with an empty Split hero, a Team of three with no portraits yet, and a Gallery of two pictures of the nook:
 * managed designs of the project's own (Foundation's sections are code components), beside Foundation's header.
 */
function site() {
  let state: ProjectState = createStarterState('blank', 'Studio', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const heroId = projectDesign(state, SPLIT_HERO).id;
  const teamId = projectDesign(state, TEAM).id;
  const galleryId = projectDesign(state, GALLERY).id;
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results.map((r) => r.nodeId as string);
  };
  step([{ type: 'asset.add', asset: nook }, { type: 'asset.add', asset: studio }]);
  const [hero, team, gallery] = step([
    { type: 'node.insert', owner, parentId: null, definitionId: heroId },
    { type: 'node.insert', owner, parentId: null, definitionId: teamId },
    { type: 'node.insert', owner, parentId: null, definitionId: galleryId }
  ]);
  step([
    {
      type: 'instance.setProp',
      owner,
      nodeId: gallery,
      prop: 'images',
      value: [
        { id: 'g1', image: { assetId: nook.id, alt: 'The nook' }, caption: 'One' },
        { id: 'g2', image: { assetId: nook.id, alt: 'The nook again' }, caption: 'Two' }
      ]
    }
  ]);
  const node = (id: string) => state.pages[owner.id].nodes[id] as InstanceNode;
  const people = () => (node(team).props.people as Array<{ id: string; name: string; portrait: ImageValue }>).map((p) => p.id);
  const header = state.site.shell.header.rootIds[0];
  return { get state() { return state; }, set state(s) { state = s; }, owner, hero, heroId, team, gallery, node, people, header, step };
}

/** The chain the page sends for a point on a design's node: that node's element and every one of the design's around it. */
function chain(state: ProjectState, owner: OwnerRef, placement: string, nodeId: string, itemPath: string[] = [], tag = 'div'): BridgeDesc[] {
  const inst = state.pages[owner.id]?.nodes[placement] ?? state.site.shell.header.nodes[placement];
  const tree = state.components[(inst as InstanceNode).definitionId].tree!;
  const out: BridgeDesc[] = [];
  let items = itemPath;
  for (let id: string | null = nodeId; id; id = findParent(tree, id)?.parentId ?? null) {
    const n = tree.nodes[id];
    if (n.kind === 'repeat') {
      items = items.slice(0, -1);
      continue;
    }
    out.push({ ...descOf(state, { owner, instancePath: [placement], nodeId: id, ...(items.length ? { itemPath: items } : {}) }), tag: out.length ? 'div' : tag });
  }
  return out;
}

/** What a drop finds, typed as an image so a test can read it; one that blocks is asserted as `{ blocked: true }`. */
const pick = (state: ProjectState, targets: ImageTarget[], at: BridgeDesc[], picture: PointedAt['picture'] = null) => resolveImageDrop(state, targets, { chain: at, picture }) as { target: ImageTarget; direct: boolean } | null;
const headingOf = (state: ProjectState, placement: InstanceNode) => Object.values(state.components[placement.definitionId].tree!.nodes).find((n) => n.kind === 'text' && n.name === 'Heading')!;

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(state: ProjectState, spec: DesignSpec): ComponentDefinition {
  return projectDesign(state, { icon: 'sparkles', ...spec });
}

describe('the image a drop changes (#505)', () => {
  it('fills a placeholder: the empty image of a Split hero, pointed at or anywhere else in the hero', () => {
    const s = site();
    const targets = imageDropTargets(s.state, s.owner.id);
    const media = targets.find((t) => t.desc.node === 'media')!;
    expect(media).toMatchObject({ field: { nodeId: s.hero, prop: 'image' }, unfilled: true, hidden: false, label: 'Image in Split hero' });

    const onImage = pick(s.state, targets, chain(s.state, s.owner, s.hero, 'media', [], 'div'), { src: '', own: false });
    expect(onImage).toEqual({ target: media, direct: true });
    // On the hero's heading: the hero's one empty image, outlined as itself.
    const heading = headingOf(s.state, s.node(s.hero));
    const off = pick(s.state, targets, chain(s.state, s.owner, s.hero, heading.id, [], 'h1'));
    expect(off).toEqual({ target: media, direct: false });
    expect(off!.target.box).toEqual({ ctx: `page:${s.owner.id}|${s.hero}`, node: 'media', items: '' });
  });

  it('replaces a chosen image for that one use, with the new image’s suggested alt text', () => {
    const s = site();
    // A second Split hero shows the same picture.
    const [other] = s.step([{ type: 'node.insert', owner: s.owner, parentId: null, definitionId: s.heroId }]);
    s.step([
      { type: 'instance.setProp', owner: s.owner, nodeId: s.hero, prop: 'image', value: { assetId: nook.id, alt: 'My own words' } },
      { type: 'instance.setProp', owner: s.owner, nodeId: other, prop: 'image', value: { assetId: nook.id, alt: 'Other words' } }
    ]);
    const targets = imageDropTargets(s.state, s.owner.id);
    const hit = pick(s.state, targets, chain(s.state, s.owner, s.hero, 'media', [], 'img'), { src: `/${nook.file.replace('static/', '')}`, own: false })!;
    expect(hit).toMatchObject({ direct: true, target: { unfilled: false, field: { nodeId: s.hero, prop: 'image' } } });
    // Off the image, a hero whose image is chosen has no empty image to fill.
    const heading = headingOf(s.state, s.node(s.hero));
    expect(pick(s.state, targets, chain(s.state, s.owner, s.hero, heading.id, [], 'h1'))).toBeNull();

    s.step(imageDropOps(s.owner, hit.target.field!, studio.id));
    expect(s.node(s.hero).props.image).toEqual({ assetId: studio.id, alt: studio.altSuggestion });
    expect(s.node(other).props.image).toEqual({ assetId: nook.id, alt: 'Other words' });
    // The Gallery's uses of the old picture are left as they were.
    expect((s.node(s.gallery).props.images as Array<{ image: ImageValue }>).map((r) => r.image.assetId)).toEqual([nook.id, nook.id]);
  });

  it('changes one repeated item: the gallery picture pointed at, not the list or its first row', () => {
    const s = site();
    // An item ID the page escapes in its item path ("%" and ",").
    (s.node(s.gallery).props.images as Array<{ id: string }>)[1].id = 'g,2%';
    const targets = imageDropTargets(s.state, s.owner.id);
    // As the page names that item: escaped, independently of the code that names the targets.
    const at = [{ ctx: `page:${s.owner.id}|${s.gallery}`, node: 'image', items: 'g%2C2%25', tag: 'img' }];
    const hit = pick(s.state, targets, at, { src: '/assets/nook.png', own: false })!;
    expect(hit).toMatchObject({ direct: true, target: { field: { nodeId: s.gallery, prop: 'images', itemId: 'g,2%', field: 'image' }, unfilled: false } });
    s.step(imageDropOps(s.owner, hit.target.field!, studio.id));
    expect((s.node(s.gallery).props.images as Array<{ id: string; image: ImageValue; caption: string }>).map((r) => [r.id, r.image, r.caption])).toEqual([
      ['g1', { assetId: nook.id, alt: 'The nook' }, 'One'],
      ['g,2%', { assetId: studio.id, alt: studio.altSuggestion }, 'Two']
    ]);
  });

  it('fills a team member’s portrait from their card, though an empty portrait shows nothing of its own', () => {
    const s = site();
    const [, b] = s.people();
    const targets = imageDropTargets(s.state, s.owner.id);
    const portrait = targets.find((t) => t.desc.node === 'portrait' && t.desc.items === b)!;
    // Outlined by the card that will show it.
    expect(portrait).toMatchObject({ hidden: true, unfilled: true, box: { node: 'member', items: b }, field: { nodeId: s.team, prop: 'people', itemId: b, field: 'portrait' }, label: 'Portrait · Marcus Lee in Team' });
    expect(pick(s.state, targets, chain(s.state, s.owner, s.team, 'name', [b], 'h3'))).toEqual({ target: portrait, direct: false });
    s.step(imageDropOps(s.owner, portrait.field!, studio.id));
    const after = (s.node(s.team).props.people as Array<{ id: string; portrait: ImageValue }>).map((p) => p.portrait.assetId);
    expect(after).toEqual([null, studio.id, null]);
  });

  it('leaves out an empty image another condition would still hide once it has a picture', () => {
    const s = site();
    const [, b] = s.people();
    const portrait = s.state.components[s.node(s.team).definitionId].tree!.nodes.portrait;
    portrait.unless = item('role');
    const targets = imageDropTargets(s.state, s.owner.id);
    expect(targets.some((t) => t.desc.node === 'portrait')).toBe(false);
    expect(pick(s.state, targets, chain(s.state, s.owner, s.team, 'name', [b], 'h3'))).toBeNull();
  });

  it('takes nothing off the images of a component with two or more empty ones', () => {
    const s = site();
    const targets = imageDropTargets(s.state, s.owner.id);
    const heading = headingOf(s.state, s.node(s.team));
    // The Team's heading belongs to no one member: three portraits are empty.
    expect(pick(s.state, targets, chain(s.state, s.owner, s.team, heading.id, [], 'h2'))).toBeNull();
    // One filled: two are still empty.
    const [a, b, c] = s.people();
    s.step([{ type: 'instance.setProp', owner: s.owner, nodeId: s.team, prop: 'people', itemId: a, field: 'portrait', value: nook.id }]);
    expect(pick(s.state, imageDropTargets(s.state, s.owner.id), chain(s.state, s.owner, s.team, heading.id, [], 'h2'))).toBeNull();
    // Two still empty, but only one shows now (the other's card is in a tab not chosen, say): that one.
    const [, b2] = s.people();
    const shownNow = (t: ImageTarget) => t.desc.items !== b2;
    const c2 = s.people()[2];
    expect(resolveImageDrop(s.state, imageDropTargets(s.state, s.owner.id), { chain: chain(s.state, s.owner, s.team, heading.id, [], 'h2'), picture: null }, shownNow)).toMatchObject({ target: { field: { itemId: c2 } } });
    // Two filled: the one left is the Team's one empty image.
    s.step([{ type: 'instance.setProp', owner: s.owner, nodeId: s.team, prop: 'people', itemId: c, field: 'portrait', value: nook.id }]);
    const now = imageDropTargets(s.state, s.owner.id);
    expect(pick(s.state, now, chain(s.state, s.owner, s.team, heading.id, [], 'h2'))).toMatchObject({ direct: false, target: { field: { itemId: b } } });
  });

  it('fills the one empty Image placed in a Section from anywhere in the Section', () => {
    const s = site();
    // A Section designed in the editor: Foundation's is a code component (the Release gap test below).
    const [section] = s.step([{ type: 'node.insert', owner: s.owner, parentId: null, definitionId: projectDesign(s.state, SECTION).id }]);
    const [text, image] = s.step([
      { type: 'node.insert', owner: s.owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Our rooms' },
      { type: 'node.insert', owner: s.owner, parentId: section, slot: 'content', primitive: 'image' }
    ]);
    const targets = imageDropTargets(s.state, s.owner.id);
    const placed = targets.find((t) => t.field?.nodeId === image)!;
    // The page's own image, shown in the Section.
    expect(placed).toMatchObject({ desc: { ctx: `page:${s.owner.id}`, node: image }, scope: { ctx: `page:${s.owner.id}|${section}`, rows: [] }, unfilled: true });
    const sectionRoot = s.state.components[s.node(section).definitionId].tree!.rootIds[0];
    const at = [{ ctx: `page:${s.owner.id}`, node: text, items: '', tag: 'p' }, { ctx: `page:${s.owner.id}|${section}`, node: sectionRoot, items: '', tag: 'section' }];
    expect(pick(s.state, targets, at)).toEqual({ target: placed, direct: false });
    s.step(imageDropOps(s.owner, placed.field!, studio.id));
    expect(s.state.pages[s.owner.id].nodes[image]).toMatchObject({ image: { assetId: studio.id, alt: studio.altSuggestion } });
  });

  // Release gap: an Image in a code component's slot takes no Assets drop (walkRendered in src/generator/checks.ts).
  it.fails('offers the empty Image placed in the release’s Section as a drop target', () => {
    const s = site();
    const [section] = s.step([{ type: 'node.insert', owner: s.owner, parentId: null, componentId: 'layout.section' }]);
    const [image] = s.step([{ type: 'node.insert', owner: s.owner, parentId: section, slot: 'content', primitive: 'image' }]);
    expect(imageDropTargets(s.state, s.owner.id).find((t) => t.field?.nodeId === image)).toMatchObject({ desc: { ctx: `page:${s.owner.id}`, node: image }, unfilled: true });
  });

  it('takes nothing on a field every item of a list shows, which a drop on one item would change in all', () => {
    const s = site();
    const strip = addDef(s.state, {
      componentId: 'project.badges',
      name: 'Badges',
      properties: { badge: P.image('Badge'), rows: P.list('Rows', 'Row', { title: P.str('Title', 'Row') }, [], { titleField: 'title' }) },
      parts: { root: { nodeId: 'root', label: 'Badges' } },
      build: (b) => b.el('root', 'div', { name: 'Badges' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [b.image('badge', prop('badge'), { name: 'Badge' }), b.text('title', 'h3', item('title'), { name: 'Title' })])])])
    });
    const placed = makeInstance(strip, { badge: { assetId: nook.id, alt: 'Badge' }, rows: [{ id: 'r1', title: 'One' }, { id: 'r2', title: 'Two' }] });
    s.state.pages[s.owner.id].nodes[placed.id] = placed;
    s.state.pages[s.owner.id].rootIds.push(placed.id);
    const targets = imageDropTargets(s.state, s.owner.id).filter((t) => t.desc.ctx.endsWith(`|${placed.id}`));
    // One badge per item, each from the one property.
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((t) => t.desc.items)).size).toBe(2);
    expect(targets.map((t) => t.field)).toEqual([null, null]);
    expect(pick(s.state, targets, [{ ...targets[1].desc, tag: 'img' }], { src: '/assets/img_nook.png', own: false })).toBeNull();
  });

  it('fills an Image placed in a Section handed on into a Card’s slot from the Card, where it shows', () => {
    const s = site();
    const cardDef = addDef(s.state, {
      componentId: 'project.slot-card',
      name: 'Card',
      properties: { title: P.str('Title', 'Card') },
      slots: { body: { label: 'Body' } },
      parts: { root: { nodeId: 'root', label: 'Card' } },
      build: (b) => b.el('root', 'div', { name: 'Card' }, [b.text('title', 'h3', prop('title'), { name: 'Heading' }), b.slot('body', 'body')])
    });
    const frameDef = addDef(s.state, {
      componentId: 'project.frame',
      name: 'Frame',
      properties: {},
      slots: { content: { label: 'Content' } },
      parts: { root: { nodeId: 'root', label: 'Frame' } },
      build: (b) => b.el('root', 'section', { name: 'Frame' }, [b.slot('content', 'content')])
    });
    // The Frame's design puts a Card around its own slot: content placed in the Frame shows inside the Card.
    const card = makeInstance(cardDef, {});
    const tree = frameDef.tree!;
    tree.nodes[card.id] = { ...card, slots: { body: ['content'] } };
    tree.nodes.root = { ...(tree.nodes.root as { children: string[] }), children: [card.id] } as never;
    const placed = makeInstance(frameDef, {});
    s.state.pages[s.owner.id].nodes[placed.id] = placed;
    s.state.pages[s.owner.id].rootIds.push(placed.id);
    const [image] = s.step([{ type: 'node.insert', owner: s.owner, parentId: placed.id, slot: 'content', primitive: 'image' }]);
    const targets = imageDropTargets(s.state, s.owner.id);
    const target = targets.find((t) => t.field?.nodeId === image)!;
    expect(target.scope).toEqual({ ctx: `page:${s.owner.id}|${placed.id}|${card.id}`, rows: [] });
    const at = [
      { ctx: `page:${s.owner.id}|${placed.id}|${card.id}`, node: 'title', items: '', tag: 'h3' },
      { ctx: `page:${s.owner.id}|${placed.id}|${card.id}`, node: 'root', items: '', tag: 'div' }
    ];
    expect(pick(s.state, targets, at)).toEqual({ target, direct: false });
  });

  it('takes nothing in a component placed in each item of another’s list, whose copies the page can’t tell apart', () => {
    const s = site();
    const card = addDef(s.state, {
      componentId: 'project.card',
      name: 'Card',
      properties: { photo: P.image('Photo'), title: P.str('Title', 'Card') },
      parts: { root: { nodeId: 'root', label: 'Card' } },
      build: (b) => b.el('root', 'div', { name: 'Card' }, [b.image('photo', prop('photo'), { name: 'Photo' }), b.text('title', 'h3', prop('title'), { name: 'Heading' })])
    });
    const shelf = addDef(s.state, {
      componentId: 'project.shelf',
      name: 'Shelf',
      properties: { rows: P.list('Rows', 'Row', { photo: P.image('Photo'), title: P.str('Title', 'Row') }, [], { titleField: 'title' }) },
      parts: { root: { nodeId: 'root', label: 'Shelf' } },
      build: (b) => b.el('root', 'div', { name: 'Shelf' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [])])])
    });
    const inner = makeInstance(card, { photo: item('photo'), title: item('title') });
    shelf.tree!.nodes[inner.id] = inner;
    (shelf.tree!.nodes.row as { children: string[] }).children.push(inner.id);
    // One row only: its card's image is the only one with that element on the page, yet still names no row of its own.
    const placed = makeInstance(shelf, { rows: [{ id: 'r1', photo: { assetId: null, alt: '' }, title: 'One' }] });
    s.state.pages[s.owner.id].nodes[placed.id] = placed;
    s.state.pages[s.owner.id].rootIds.push(placed.id);
    const targets = imageDropTargets(s.state, s.owner.id);
    const photo = targets.find((t) => t.desc.ctx === `page:${s.owner.id}|${placed.id}|${inner.id}`)!;
    expect(photo).toMatchObject({ field: null, unfilled: true });
    const at = [
      { ctx: `page:${s.owner.id}|${placed.id}|${inner.id}`, node: 'title', items: '', tag: 'h3' },
      { ctx: `page:${s.owner.id}|${placed.id}|${inner.id}`, node: 'root', items: 'r1', tag: 'div' }
    ];
    expect(pick(s.state, targets, at)).toBeNull();
    expect(pick(s.state, targets, [{ ...photo.desc, tag: 'div' }])).toBeNull();

    // The Shelf also shows a badge of its own above the list, and hands the same badge to each item's card: the badge
    // above the list takes no drop either, since every card would change with it.
    shelf.properties.badge = P.image('Badge');
    const top = 'badge-top';
    shelf.tree!.nodes[top] = { id: top, kind: 'image', name: 'Badge', image: prop('badge') } as never;
    (shelf.tree!.nodes.root as { children: string[] }).children.unshift(top);
    (shelf.tree!.nodes[inner.id] as InstanceNode).props.photo = prop('badge');
    placed.props.badge = { assetId: nook.id, alt: 'Badge' };
    const shared = imageDropTargets(s.state, s.owner.id).filter((t) => t.reads?.nodeId === placed.id && t.reads.prop === 'badge');
    expect(shared.length).toBe(2);
    expect(shared.map((t) => t.field)).toEqual([null, null]);
  });

  it('counts an Image in a design’s slot shown in each item of a list once per item', () => {
    const s = site();
    const def = addDef(s.state, {
      componentId: 'project.repeat-slot',
      name: 'Repeat slot',
      properties: { rows: P.list('Rows', 'Row', { title: P.str('Title', 'Row') }, [], { titleField: 'title' }) },
      slots: { extra: { label: 'Extra' } },
      parts: { root: { nodeId: 'root', label: 'Repeat slot' } },
      build: (b) => b.el('root', 'div', { name: 'Repeat slot' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [b.text('title', 'h3', item('title'), { name: 'Title' }), b.slot('extra', 'extra')])])])
    });
    const placed = makeInstance(def, { rows: [{ id: 'r1', title: 'One' }] });
    s.state.pages[s.owner.id].nodes[placed.id] = placed;
    s.state.pages[s.owner.id].rootIds.push(placed.id);
    const [image] = s.step([{ type: 'node.insert', owner: s.owner, parentId: placed.id, slot: 'extra', primitive: 'image' }]);
    // One item: the Image shows once, and takes a drop.
    expect(imageDropTargets(s.state, s.owner.id).find((t) => t.reads?.nodeId === image)).toMatchObject({ field: { nodeId: image }, multiple: false });
    // Two: it shows in both, and a drop on one would change the other.
    (s.node(placed.id).props.rows as Array<{ id: string; title: string }>).push({ id: 'r2', title: 'Two' });
    expect(imageDropTargets(s.state, s.owner.id).find((t) => t.reads?.nodeId === image)).toMatchObject({ field: null, multiple: true });
  });

  it('counts an object’s image field it has no value for as the property’s default picture', () => {
    const s = site();
    const def = addDef(s.state, {
      componentId: 'project.feature',
      name: 'Feature',
      properties: { feature: { ...P.object('Feature', { photo: P.image('Photo'), caption: P.str('Caption', '') }), default: { photo: { assetId: nook.id, alt: 'Nook' }, caption: '' } } },
      parts: { root: { nodeId: 'root', label: 'Feature' } },
      build: (b) => b.el('root', 'figure', { name: 'Feature' }, [b.image('photo', { $prop: 'feature', field: 'photo' }, { name: 'Photo' }), b.text('caption', 'figcaption', { $prop: 'feature', field: 'caption' }, { name: 'Caption' })])
    });
    // Saved without the photo: the page shows the default's.
    const placed = makeInstance(def, { feature: { caption: 'A corner' } });
    s.state.pages[s.owner.id].nodes[placed.id] = placed;
    s.state.pages[s.owner.id].rootIds.push(placed.id);
    const targets = imageDropTargets(s.state, s.owner.id);
    expect(targets.find((t) => t.field?.nodeId === placed.id)).toMatchObject({ unfilled: false, field: { prop: 'feature', field: 'photo' } });
    const at = [{ ctx: `page:${s.owner.id}|${placed.id}`, node: 'caption', items: '', tag: 'figcaption' }, { ctx: `page:${s.owner.id}|${placed.id}`, node: 'root', items: '', tag: 'figure' }];
    expect(pick(s.state, targets, at)).toBeNull();
    // Shown only when it has a picture: the default's picture shows it all the same.
    def.tree!.nodes.photo.when = { $prop: 'feature', field: 'photo' };
    const now = imageDropTargets(s.state, s.owner.id);
    expect(now.find((t) => t.field?.nodeId === placed.id)).toMatchObject({ unfilled: false, hidden: false });
    expect(pick(s.state, now, at)).toBeNull();
    // And when the element around it is shown only when it has one.
    delete def.tree!.nodes.photo.when;
    def.tree!.nodes.root.when = { $prop: 'feature', field: 'photo' };
    expect(imageDropTargets(s.state, s.owner.id).find((t) => t.field?.nodeId === placed.id)).toMatchObject({ unfilled: false, hidden: false });
  });

  it('takes nothing on an image a design fixes, or off it in that component', () => {
    const s = site();
    const def = s.state.components[s.node(s.hero).definitionId];
    // The hero's design shows one picture of its own, the same everywhere it is placed.
    (def.tree!.nodes.media as { image: unknown }).image = { assetId: null, alt: '' };
    const targets = imageDropTargets(s.state, s.owner.id);
    expect(targets.find((t) => t.desc.node === 'media')).toMatchObject({ field: null, unfilled: true });
    expect(pick(s.state, targets, chain(s.state, s.owner, s.hero, 'media'))).toBeNull();
    const heading = Object.values(def.tree!.nodes).find((n) => n.kind === 'text' && n.name === 'Heading')!;
    expect(pick(s.state, targets, chain(s.state, s.owner, s.hero, heading.id, [], 'h1'))).toBeNull();
  });

  it('takes nothing on a list item whose ID another item of its list shares', () => {
    const s = site();
    const rows = s.node(s.gallery).props.images as Array<{ id: string }>;
    rows[1].id = 'g1';
    const targets = imageDropTargets(s.state, s.owner.id);
    expect(targets.filter((t) => t.field?.nodeId === s.gallery)).toEqual([]);
    expect(pick(s.state, targets, chain(s.state, s.owner, s.gallery, 'image', ['g1'], 'img'))).toBeNull();
  });

  it('takes nothing on a picture no field holds, even in a component with one empty image', () => {
    const s = site();
    const targets = imageDropTargets(s.state, s.owner.id);
    // A picture inside the hero's text (rich text's own image): the hero's empty image is not what the pointer is on.
    const heading = headingOf(s.state, s.node(s.hero));
    expect(pick(s.state, targets, chain(s.state, s.owner, s.hero, heading.id, [], 'p'), { src: '/assets/inline.png', own: false })).toBeNull();
    // A picture the header's code draws of its own, while its logo is empty.
    expect(pick(s.state, targets, [{ ctx: 'shell:header', node: s.header, items: '', tag: 'div', code: true }], { src: '/assets/badge.png', own: true })).toBeNull();
  });

  it('reaches the header’s logo, which the header’s code draws itself, while the page shows the header', () => {
    const s = site();
    // The generator marks the code placement's wrapper, a `display: contents` div.
    const at: BridgeDesc[] = [{ ctx: 'shell:header', node: s.header, items: '', tag: 'div', code: true }];
    let targets = imageDropTargets(s.state, s.owner.id);
    const logo = targets.find((t) => t.owner.kind === 'shell')!;
    expect(logo).toMatchObject({ owner: { kind: 'shell', id: 'header' }, field: { nodeId: s.header, prop: 'logo' }, unfilled: true, code: { drawn: true, files: [] }, label: 'Logo in Header' });
    // No logo yet: anywhere on the header fills it.
    expect(pick(s.state, targets, at)).toEqual({ target: logo, direct: false });
    s.step(imageDropOps(logo.owner, logo.field!, nook.id));
    expect(s.state.site.shell.header.nodes[s.header]).toMatchObject({ props: { logo: { assetId: nook.id, alt: nook.altSuggestion } } });
    // A chosen logo is replaced only from its own picture: the header's one picture, showing the logo's file.
    targets = imageDropTargets(s.state, s.owner.id);
    const logoFile = '/assets/img_nook.png';
    expect(pick(s.state, targets, at, { src: logoFile, own: true })).toMatchObject({ direct: true, target: { unfilled: false, field: { prop: 'logo' } } });
    expect(pick(s.state, targets, at, { src: '/assets/badge.png', own: true })).toBeNull();
    expect(pick(s.state, targets, at, { src: logoFile, own: false })).toBeNull();
    expect(pick(s.state, targets, at)).toBeNull();
    // A page that hides the header has none of its images.
    s.step([{ type: 'page.update', pageId: s.owner.id, showHeader: false }]);
    expect(imageDropTargets(s.state, s.owner.id).some((t) => t.owner.kind === 'shell')).toBe(false);
  });
});

describe('a code component’s picture (#505)', () => {
  it('is its image property’s only when its one SoImage shows that property, whichever way its expression goes', () => {
    expect(showsWithSoImage('<SoImage image={nameShown ? { ...logo, decorative: true } : logo} class="x" />', 'logo')).toBe(true);
    expect(showsWithSoImage('<SoImage image={photo} />', 'photo')).toBe(true);
    expect(showsWithSoImage('<SoImage image={thumbnail(photo)} sizes="20rem" />', 'photo')).toBe(true);
    expect(showsWithSoImage('<SoImage image={(photo)} />', 'photo')).toBe(true);
    expect(showsWithSoImage('<SoImage image={on ? (big ? { ...photo, decorative: true } : photo) : thumbnail(photo)} />', 'photo')).toBe(true);
    // A copy that shows another picture, or takes settings that could.
    expect(showsWithSoImage('<SoImage image={{ ...photo, src: badgeSrc }} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage image={{ ...photo, ...extra }} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage image={{ ...photo, src }} />', 'photo')).toBe(false);
    expect(showsWithSoImage("<SoImage image={{ ...photo, 'srcset': set }} />", 'photo')).toBe(false);
    // Settings that only read its source are its own.
    expect(showsWithSoImage("<SoImage image={{ ...photo, alt: photo.src ? 'Portrait' : '' }} />", 'photo')).toBe(true);
    // A badge the code shows instead of the property, or as well as it.
    expect(showsWithSoImage('<SoImage image={showBadge ? badge : photo} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage image={photo?.src ? badge : null} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage image={photo} /><SoImage image={badge} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<div style:background-image={photo?.src}><SoImage image={badge} /></div>', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage /><Other image={photo} />', 'photo')).toBe(false);
    expect(showsWithSoImage('<SoImage image={photograph} />', 'photo')).toBe(false);
  });

  it('reads the shorthand `{image}` as `image={image}`, and nothing a spread could give (#1386)', () => {
    expect(showsWithSoImage("<SoImage {image} eager={so_eager} class={['hero__media', so_o?.media]} />", 'image')).toBe(true);
    expect(showsWithSoImage('<SoImage\n\t{image}\n\tsizes="(min-width: 1024px) 50vw, 100vw"\n/>', 'image')).toBe(true);
    expect(showsWithSoImage('<SoImage {image} />', 'photo')).toBe(false);
    // Given twice, or by a spread that could give it.
    expect(showsWithSoImage('<SoImage {image} image={badge} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage image={badge} {image} />', 'image')).toBe(false);
    // A spread past a template literal's brace, or a picture of its own given beside it.
    expect(showsWithSoImage('<SoImage {image} class={`}>`} {...overrides} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage {image} class={`a ${b ? `}` : c}`} />', 'image')).toBe(true);
    expect(showsWithSoImage('<SoImage {image} src={badgeSrc} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage {image} {srcset} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage {image} sources={formats} />', 'image')).toBe(false);
    // Comment markers given as text are no comment: the second SoImage counts.
    expect(showsWithSoImage('<SoImage {image} />{"<!--"}<SoImage image={badge} />{"-->"}', 'image')).toBe(false);
    // A tag in a comment is no tag; a shorthand is an attribute of its own, never another's value.
    expect(showsWithSoImage('<!-- <SoImage image={badge} /> --><SoImage {image} />', 'image')).toBe(true);
    expect(showsWithSoImage('<SoImage title= {image} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage {...rest} {image} />', 'image')).toBe(false);
    // Another attribute's expression, or text in a quoted value, is not the image.
    expect(showsWithSoImage('<SoImage class={image} />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage alt="image={image}" />', 'image')).toBe(false);
    expect(showsWithSoImage('<SoImage sizes="{image}" image={photo} />', 'photo')).toBe(true);
  });

  it('is one list item’s when its one SoImage, in one loop over the list, shows the item’s picture (#1386)', () => {
    const gallery = (inner: string) => `{#if has(images)}<ul>{#each images as item (item.id)}<li><SoAction image={item.image}>${inner}</SoAction></li>{/each}</ul>{/if}`;
    expect(showsItemsWithSoImage(gallery("<SoImage image={item.action === 'image' ? thumbnail(item.image) : item.image} sizes=\"100vw\" />"), 'images', 'image')).toBe(true);
    expect(showsItemsWithSoImage(gallery('<SoImage image={{ ...item.image, decorative: true }} />'), 'images', 'image')).toBe(true);
    expect(showsItemsWithSoImage('{#each people as person, i}<SoImage image={person.portrait} />{/each}', 'people', 'portrait')).toBe(true);
    // Another item's field, another list, or a picture the item does not give.
    expect(showsItemsWithSoImage(gallery('<SoImage image={item.cover} />'), 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('<SoImage image={item.image} />'), 'photos', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('<SoImage image={item.big ? badge : item.image} />'), 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('<SoImage image={image} />'), 'images', 'image')).toBe(false);
    // Outside the loop, or shown more than once per item: in a loop inside it, around it, or from a snippet.
    expect(showsItemsWithSoImage('{#each images as item}{/each}<SoImage image={item.image} />', 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('{#each [1, 2] as n}<SoImage image={item.image} />{/each}'), 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(`{#each rows as row}${gallery('<SoImage image={item.image} />')}{/each}`, 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(`{#snippet pic(item)}<SoImage image={item.image} />{/snippet}${gallery('{@render pic(item)}{@render pic(item)}')}`, 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('{#snippet pic()}<SoImage image={item.image} />{/snippet}{@render pic()}{@render pic()}'), 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('{#each [0, 1] as copy}<!-- {/each} --><SoImage image={item.image} />{/each}'), 'images', 'image')).toBe(false);
    // Another row's picture, or the item named again as another.
    expect(showsItemsWithSoImage(gallery('<SoImage image={images[0].image} />'), 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('{@const item = images[0]}<SoImage image={item.image} />'), 'images', 'image')).toBe(false);
    // A filtered copy of the list shows other items than its own rows' places.
    expect(showsItemsWithSoImage('{#each shown as item}<SoImage image={item.image} />{/each}', 'images', 'image')).toBe(false);
    expect(showsItemsWithSoImage(gallery('<SoImage image={item.image} /><SoImage image={item.image} />'), 'images', 'image')).toBe(false);
  });
});

/**
 * A Business project's Home (#1386): its sections are Foundation's code components, each picture filled from the
 * library, as the starter's sample images fill them.
 */
function business() {
  let state: ProjectState = createStarterState('business', 'Studio', true);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const page = () => state.pages[owner.id];
  const placed = (definitionId: string) => page().rootIds.find((id) => (page().nodes[id] as InstanceNode).definitionId === definitionId)!;
  const step = (ops: EditOperation[]) => (state = applyOperations(state, ops).state);
  // The starter names its sample pictures; the library gets their records when the project is created on disk.
  const ids = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.assetId === 'string') ids.add(r.assetId);
      Object.values(r).forEach(collect);
    }
  };
  collect(page().nodes);
  step([...[...ids].map((id) => ({ type: 'asset.add', asset: asset(id, `Sample ${id}`) }) as EditOperation), { type: 'asset.add', asset: studio }]);
  const file = (id: string) => `/assets/${id}.png`;
  return { get state() { return state; }, owner, page, placed, step, file, hero: placed('foundation.hero.split'), media: placed('foundation.content.media'), gallery: placed('foundation.media.gallery') };
}

describe('a Foundation section’s filled picture (#1386)', () => {
  const on = (owner: OwnerRef, node: string): BridgeDesc[] => [{ ctx: `page:${owner.id}`, node, items: '', tag: 'div', code: true }];

  it('is replaced from its picture in a Split hero and in a Content with image', () => {
    const s = business();
    for (const node of [s.hero, s.media]) {
      const shown = (s.page().nodes[node] as InstanceNode).props.image as ImageValue;
      expect(shown.assetId).toBeTruthy();
      const targets = imageDropTargets(s.state, s.owner.id);
      const hit = pick(s.state, targets, on(s.owner, node), { src: s.file(shown.assetId!), own: true });
      expect(hit).toMatchObject({ direct: true, target: { unfilled: false, field: { nodeId: node, prop: 'image' }, code: { drawn: true } } });
      s.step(imageDropOps(s.owner, hit!.target.field!, studio.id));
      expect((s.page().nodes[node] as InstanceNode).props.image).toEqual({ assetId: studio.id, alt: studio.altSuggestion });
    }
  });

  it('is one Gallery item’s, the one whose picture is under the pointer, and the drop changes that item only', () => {
    const s = business();
    const rows = () => (s.page().nodes[s.gallery] as InstanceNode).props.images as Array<{ id: string; image: ImageValue; caption: string }>;
    const before = structuredClone(rows());
    expect(before.length).toBeGreaterThan(1);
    expect(new Set(before.map((r) => r.image.assetId)).size).toBe(before.length);
    const second = before[1];
    const record = s.state.assets.assets[second.image.assetId!];
    record.variants = [{ width: 640, file: `static/assets/${record.id}-640.webp` }];
    const targets = imageDropTargets(s.state, s.owner.id);
    // One target per item, each its own field; none of them taken off its picture.
    expect(targets.filter((t) => t.field?.nodeId === s.gallery).map((t) => t.field!.itemId)).toEqual(before.map((r) => r.id));
    // Pointed at by the smaller copy the Gallery shows.
    const hit = pick(s.state, targets, on(s.owner, s.gallery), { src: `/assets/${second.image.assetId}-640.webp`, own: false, inside: true });
    expect(hit).toMatchObject({ direct: true, target: { unfilled: false, field: { nodeId: s.gallery, prop: 'images', itemId: second.id, field: 'image' } } });
    expect(hit!.target.label).toBe(`Image${second.caption ? ` · ${second.caption}` : ''} in Gallery`);
    // Not a picture the Gallery draws, or no picture at all: no item.
    expect(pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(second.image.assetId!), own: false })).toBeNull();
    expect(pick(s.state, targets, on(s.owner, s.gallery))).toBeNull();
    expect(pick(s.state, targets, on(s.owner, s.gallery), { src: s.file('elsewhere'), own: false, inside: true })).toBeNull();
    s.step(imageDropOps(s.owner, hit!.target.field!, studio.id));
    expect(rows().map((r) => [r.id, r.image, r.caption])).toEqual(before.map((r) => [r.id, r.id === second.id ? { assetId: studio.id, alt: studio.altSuggestion } : r.image, r.caption]));
    expect(rows().filter((r) => r.id !== second.id)).toEqual(before.filter((r) => r.id !== second.id));
  });

  it('tells two Gallery items apart by what a release would change', () => {
    const s = business();
    const rows = (s.page().nodes[s.gallery] as InstanceNode).props.images as Array<{ id: string; image: ImageValue }>;
    const targets = imageDropTargets(s.state, s.owner.id);
    const [a, b] = rows.map((r) => pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(r.image.assetId!), own: false, inside: true }) as { target: ImageTarget });
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(aimKey({ kind: 'image', target: a.target, outline: box })).not.toBe(aimKey({ kind: 'image', target: b.target, outline: box }));
  });

  it('reports a picture the code draws, and whether it is the only one', () => {
    expect(pointedAt({ chain: [], picture: { src: '/assets/a.png', own: false, inside: true }, scroll: [0, 0] })?.picture).toMatchObject({ own: false, inside: true });
    expect(pointedAt({ chain: [], picture: { src: '/assets/a.png', own: true }, scroll: [0, 0] })?.picture).toMatchObject({ own: true, inside: true });
    expect(pointedAt({ chain: [], picture: { src: '/assets/a.png' }, scroll: [0, 0] })?.picture).toMatchObject({ own: false, inside: false });
  });

  it('does nothing on a Gallery picture two items show, which can’t be told apart, rather than go between content', () => {
    const s = business();
    const rows = (s.page().nodes[s.gallery] as InstanceNode).props.images as Array<{ id: string; image: ImageValue }>;
    s.step([{ type: 'instance.setProp', owner: s.owner, nodeId: s.gallery, prop: 'images', itemId: rows[1].id, field: 'image', value: rows[0].image }]);
    const targets = imageDropTargets(s.state, s.owner.id);
    const hit = pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(rows[0].image.assetId!), own: false, inside: true });
    expect(hit).toEqual({ blocked: true });
    expect(assetAim(hit, null, true, () => ({ at: null }) as unknown as InsertAim)).toEqual({ kind: 'none' });
    // Another item's own picture still takes it.
    expect(pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(rows[2].image.assetId!), own: false, inside: true })).toMatchObject({ target: { field: { itemId: rows[2].id } } });
  });

  it('takes nothing on a Gallery item whose ID another item shares, which an edit could not name alone', () => {
    const s = business();
    const rows = structuredClone((s.page().nodes[s.gallery] as InstanceNode).props.images as Array<{ id: string; image: ImageValue }>);
    rows[1].id = rows[0].id;
    (s.page().nodes[s.gallery] as InstanceNode).props.images = rows;
    const targets = imageDropTargets(s.state, s.owner.id);
    for (const r of rows.slice(0, 2)) expect(pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(r.image.assetId!), own: false, inside: true })).toEqual({ blocked: true });
    expect(pick(s.state, targets, on(s.owner, s.gallery), { src: s.file(rows[2].image.assetId!), own: false, inside: true })).toMatchObject({ target: { field: { itemId: rows[2].id } } });
  });

  it('takes nothing on an item’s picture whose file the placement also shows elsewhere, as in an item’s text', () => {
    const s = business();
    // A code component of the project's own, made from the Gallery's: each item's photo, and a note that may show one.
    const strip = {
      ...s.state.components['foundation.media.gallery'],
      id: 'project.strip',
      name: 'Strip',
      owner: 'project',
      properties: {
        items: { type: 'list', label: 'Items', fields: { photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } }, note: { type: 'richtext', label: 'Note', default: [] } }, default: [] }
      },
      source: '<script>let { items = [] } = $props();</script>{#each items as item (item.id)}<SoImage image={item.photo} /><SoRichText blocks={item.note} />{/each}'
    } as unknown as ComponentDefinition;
    s.state.components[strip.id] = strip;
    const placed = makeInstance(strip, {
      items: [
        { id: 'a', photo: { assetId: studio.id, alt: '' }, note: [{ type: 'image', assetId: 'img_nook', alt: '' }] },
        { id: 'b', photo: { assetId: 'img_nook', alt: '' }, note: [] }
      ]
    });
    s.page().nodes[placed.id] = placed;
    s.page().rootIds.push(placed.id);
    s.step([{ type: 'asset.add', asset: nook }]);
    const targets = imageDropTargets(s.state, s.owner.id);
    const at = on(s.owner, placed.id);
    const first = (placed.props.items as Array<{ id: string }>)[0].id;
    expect(pick(s.state, targets, at, { src: s.file(studio.id), own: false, inside: true })).toMatchObject({ target: { field: { nodeId: placed.id, itemId: first, field: 'photo' } } });
    expect(pick(s.state, targets, at, { src: s.file(nook.id), own: false, inside: true })).toEqual({ blocked: true });
  });
});

describe('a picture’s file (#505)', () => {
  it('is the library file its address ends with, wherever the site is served from', () => {
    expect(showsFile('/myassets/logo.png', 'assets/logo.png')).toBe(false);
    expect(showsFile('/assets/logo.png', 'assets/logo.png')).toBe(true);
    expect(showsFile('/site/assets/logo.png?v=2', 'assets/logo.png')).toBe(true);
    expect(showsFile('/assets/Shop%20front.png', 'assets/Shop front.png')).toBe(true);
    expect(showsFile('/assets/old-logo.png', 'assets/logo.png')).toBe(false);
    expect(showsFile('', 'assets/logo.png')).toBe(false);
  });
});

describe('an image first, then between content (#506)', () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 };
  const line = { x: 0, y: 399, width: 1000, height: 2 };
  /** A place between content the pointer is also over. */
  const between = (s: ReturnType<typeof site>): InsertAim => ({ at: { owner: s.owner, parentId: null, index: 1 }, refused: null, line, outline: null, where: { lead: 'in a new section after', target: 'Split hero', node: true } });

  it('an image pointed at, or the one empty image of the component the pointer is in, takes it however a place between content would', () => {
    const s = site();
    const targets = imageDropTargets(s.state, s.owner.id);
    const media = targets.find((t) => t.desc.node === 'media')!;
    let asked = 0;
    const insert = () => (asked++, between(s));
    const onImage = pick(s.state, targets, chain(s.state, s.owner, s.hero, 'media', [], 'div'), { src: '', own: false });
    // On the image, even before anything is measured.
    expect(assetAim(onImage, rect, false, insert)).toEqual({ kind: 'image', target: media, outline: rect });
    expect(assetAim(onImage, rect, true, insert)).toEqual({ kind: 'image', target: media, outline: rect });
    // Off it, on the hero's heading: its empty image, once measured.
    const heading = headingOf(s.state, s.node(s.hero));
    const off = pick(s.state, targets, chain(s.state, s.owner, s.hero, heading.id, [], 'h1'));
    expect(assetAim(off, rect, true, insert)).toEqual({ kind: 'image', target: media, outline: rect });
    expect(asked).toBe(0);
    // Taken by an image that can't be outlined (shown more than once): not dropped between content either.
    expect(assetAim(off, null, true, insert)).toEqual({ kind: 'none' });
    expect(assetAim(onImage, null, true, insert)).toEqual({ kind: 'none' });
    expect(assetAim(onImage, null, false, insert)).toEqual({ kind: 'none' });
    expect(asked).toBe(0);
    // An empty image off the pointer, not yet measured where it shows, is not yet known to take it.
    expect(assetAim(off, rect, false, insert)).toEqual({ kind: 'pending' });
    expect(asked).toBe(0);
  });

  it('goes between content only once no image is targeted, and waits while what finds one is being measured', () => {
    const s = site();
    let asked = 0;
    const insert = () => (asked++, between(s));
    // Nothing measured yet: an empty image off the pointer can't be counted, so nothing is known.
    expect(assetAim(null, null, false, insert)).toEqual({ kind: 'pending' });
    expect(asked).toBe(0);
    expect(assetAim(null, null, true, insert)).toEqual({ kind: 'insert', aim: between(s) });
    expect(asked).toBe(1);
    // Where nothing can go, the place says why, with nowhere to drop.
    const refused: InsertAim = { at: null, refused: 'It has more than one place for content.', line: null, outline: rect, where: null };
    expect(assetAim(null, null, true, () => refused)).toEqual({ kind: 'insert', aim: refused });
    expect(assetAim(null, null, true, () => null)).toEqual({ kind: 'none' });
  });

  it('tells two aims apart by what a release would do', () => {
    const s = site();
    const targets = imageDropTargets(s.state, s.owner.id);
    const media = targets.find((t) => t.desc.node === 'media')!;
    const onImage = { kind: 'image' as const, target: media, outline: rect };
    const gap = { kind: 'insert' as const, aim: between(s) };
    expect(aimKey({ kind: 'pending' })).toBeNull();
    expect(aimKey(onImage)).toBe(aimKey({ ...onImage, outline: { ...rect, y: 50 } }));
    expect(aimKey(gap)).toBe(aimKey({ kind: 'insert', aim: { ...between(s), line: { ...line, y: 10 } } }));
    const at = (parentId: string | null, slot: string | undefined, index: number) => aimKey({ kind: 'insert', aim: { ...between(s), at: { owner: s.owner, parentId, ...(slot ? { slot } : {}), index } } });
    // Each part of the place counts: the index, the list, the slot, the page.
    const keys = [at(null, undefined, 1), at(null, undefined, 2), at(s.hero, 'content', 1), at(s.hero, 'other', 1), at(s.team, 'content', 1), aimKey({ kind: 'insert', aim: { ...between(s), at: { owner: { kind: 'page', id: 'about' }, parentId: null, index: 1 } } })];
    expect(new Set(keys).size).toBe(keys.length);
    // As does which image: the hero's own, or another.
    const other = targets.find((t) => t !== media && t.field)!;
    expect(aimKey({ kind: 'image', target: other, outline: rect })).not.toBe(aimKey(onImage));
    expect(new Set([aimKey(onImage), aimKey(gap), aimKey({ kind: 'insert', aim: { ...between(s), at: null, refused: 'No.' } }), aimKey({ kind: 'none' })]).size).toBe(4);
  });
});
