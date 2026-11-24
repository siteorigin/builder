import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ImageValue, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { findParent } from '@engine/tree';
import { P, item, prop, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { showsWithSoImage } from '@generator/checks';
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

/** Home with an empty Split hero, a Team of three with no portraits yet, and a Gallery of two pictures of the nook. */
function site() {
  let state: ProjectState = createStarterState('blank', 'Studio', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results.map((r) => r.nodeId as string);
  };
  step([{ type: 'asset.add', asset: nook }, { type: 'asset.add', asset: studio }]);
  const [hero, team, gallery] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'hero.split' },
    { type: 'node.insert', owner, parentId: null, componentId: 'team.grid' },
    { type: 'node.insert', owner, parentId: null, componentId: 'media.gallery' }
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
  return { get state() { return state; }, set state(s) { state = s; }, owner, hero, team, gallery, node, people, header, step };
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

const pick = (state: ProjectState, targets: ImageTarget[], at: BridgeDesc[], picture: PointedAt['picture'] = null) => resolveImageDrop(state, targets, { chain: at, picture });
const headingOf = (state: ProjectState, placement: InstanceNode) => Object.values(state.components[placement.definitionId].tree!.nodes).find((n) => n.kind === 'text' && n.name === 'Heading')!;

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(state: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...FOUNDATION.managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  state.components[def.id] = def;
  return def;
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
    const [other] = s.step([{ type: 'node.insert', owner: s.owner, parentId: null, componentId: 'hero.split' }]);
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
    const [section] = s.step([{ type: 'node.insert', owner: s.owner, parentId: null, componentId: 'layout.section' }]);
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
    expect(asked).toBe(0);
  });

  it('goes between content only once no image is targeted, and waits while what finds one is being measured', () => {
    const s = site();
    const insert = () => between(s);
    // Nothing measured yet: an empty image off the pointer can't be counted, so nothing is known.
    expect(assetAim(null, null, false, insert)).toEqual({ kind: 'pending' });
    expect(assetAim(null, null, true, insert)).toEqual({ kind: 'insert', aim: between(s) });
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
    expect(new Set([aimKey(onImage), aimKey(gap), aimKey({ kind: 'insert', aim: { ...between(s), at: { owner: s.owner, parentId: null, index: 2 } } }), aimKey({ kind: 'none' })]).size).toBe(4);
  });
});
