import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ListItem } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { defFile, generateProject } from '@generator/index';
import { MAX_DRAFT_CHARS, revealTarget, sameTarget, type RevealedItem } from '../../src/renderer/src/lib/reveal';
import { descOf } from '../../src/renderer/src/lib/model';

const s = createStarterState('business', 'Test Studio', false);
const contact = Object.values(s.pages).find((p) => p.route === '/contact/')!;
const faq = contact.rootIds.map((id) => contact.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'faq.list')!;
const def = s.components[faq.definitionId];
const ref: ElementRef = { owner: { kind: 'page', id: contact.id }, instancePath: [], nodeId: faq.id };
const items = (faq.props.items ?? (def.properties.items as { default: ListItem[] }).default) as ListItem[];
const ctx = descOf(s, ref).ctx;
const open = (itemId: string, draft: RevealedItem['draft'] = null, list = 'items'): RevealedItem => ({ owner: 'list-1', ref, list, itemId, draft });

describe('revealing the list item open in the inspector', () => {
  it('finds the item by its placement and id, through what its repeat renders', () => {
    expect(ctx).toBe(`page:${contact.id}|${faq.id}`);
    expect(revealTarget(s, open(items[1].id), ctx)).toEqual({
      ctx,
      list: 'items',
      items: items[1].id,
      nodes: ['item', 'item-divider'],
      within: { item: 0, summary: 0, question: 0, 'toggle-icon': 0, answer: 0, 'item-divider': 0 }
    });
  });

  it('names nodes the page really renders for each item, with the item id on them', () => {
    const markup = generateProject(s, { instrument: true }).get(defFile(def))!;
    expect(markup).toMatch(/<details[^>]*data-so-node="item" data-so-items=\{\[item\.id\]\.join\(','\)\}/);
    expect(markup).toMatch(/<hr[^>]*data-so-node="item-divider" data-so-items=/);
    expect(markup).toMatch(/<p[^>]*data-so-node="answer" data-so-items=[^>]*>\{item\.answer\}<\/p>/);
  });

  it('says how deep the list is repeated, for a design that lists it inside the rows of another list', () => {
    const nested = structuredClone(s);
    const tree = nested.components[faq.definitionId].tree!;
    const parentId = Object.values(tree.nodes).find((n) => n.kind === 'element' && n.children.includes('questions'))!.id;
    const parent = tree.nodes[parentId] as { children: string[] };
    parent.children = parent.children.map((c) => (c === 'questions' ? 'groups' : c));
    tree.nodes.groups = { id: 'groups', kind: 'repeat', name: 'Groups', list: { $prop: 'groups' }, children: ['questions'] } as (typeof tree.nodes)[string];
    expect(Object.values(revealTarget(nested, open(items[0].id), ctx)!.within)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('gives a node inside two repeats of the list the depth of the nearer one, whatever order the design lists them in', () => {
    const twice = structuredClone(s);
    const tree = twice.components[faq.definitionId].tree!;
    // The inner repeat comes first in the design's nodes; the outer one, added later, wraps it.
    const parent = Object.values(tree.nodes).find((n) => n.kind === 'element' && n.children.includes('questions')) as { children: string[] };
    parent.children = parent.children.map((c) => (c === 'questions' ? 'outer' : c));
    tree.nodes.outer = { id: 'outer', kind: 'repeat', name: 'Outer', list: { $prop: 'items' }, children: ['questions'] } as (typeof tree.nodes)[string];
    const within = revealTarget(twice, open(items[0].id), ctx)!.within;
    expect(within.questions).toBe(0);
    expect(within.answer).toBe(1);
  });

  it('keeps a node called __proto__ as one of the nodes of the item', () => {
    const odd = structuredClone(s);
    const tree = odd.components[faq.definitionId].tree!;
    const answer = tree.nodes.answer;
    delete tree.nodes.answer;
    tree.nodes.__proto__ = { ...answer, id: '__proto__' } as (typeof tree.nodes)[string];
    const item = tree.nodes.item as { children: string[] };
    item.children = item.children.map((c) => (c === 'answer' ? '__proto__' : c));
    expect(Object.hasOwn(revealTarget(odd, open(items[0].id), ctx)!.within, '__proto__')).toBe(true);
  });

  it('shows typed text in the plain text bound to the field being typed in', () => {
    expect(revealTarget(s, open(items[0].id, { field: 'answer', text: 'A new answer' }), ctx)?.text).toEqual({ nodes: ['answer'], value: 'A new answer' });
    expect(revealTarget(s, open(items[0].id, { field: 'question', text: '' }), ctx)?.text).toEqual({ nodes: ['question'], value: '' });
  });

  it('leaves out typed text it cannot show', () => {
    expect(revealTarget(s, open(items[0].id, { field: 'answer', text: 'x'.repeat(MAX_DRAFT_CHARS + 1) }), ctx)?.text).toBeUndefined();
    expect(revealTarget(s, open(items[0].id, { field: 'nope', text: 'A' }), ctx)?.text).toBeUndefined();
  });

  it('reveals nothing for a list the design does not repeat, or for something that is not a placement', () => {
    expect(revealTarget(s, open(items[0].id, null, 'heading'), ctx)).toBeNull();
    expect(revealTarget(s, { ...open(items[0].id), ref: { ...ref, nodeId: 'missing' } }, ctx)).toBeNull();
    expect(revealTarget(s, open(''), ctx)).toBeNull();
  });

  it('compares targets by value', () => {
    const a = revealTarget(s, open(items[0].id, { field: 'answer', text: 'A' }), ctx);
    expect(sameTarget(a, revealTarget(s, open(items[0].id, { field: 'answer', text: 'A' }), ctx))).toBe(true);
    expect(sameTarget(a, revealTarget(s, open(items[0].id, { field: 'answer', text: 'AB' }), ctx))).toBe(false);
    expect(sameTarget(a, revealTarget(s, open(items[1].id, { field: 'answer', text: 'A' }), ctx))).toBe(false);
    expect(sameTarget(null, revealTarget(s, open(items[0].id), ctx))).toBe(false);
    const b = revealTarget(s, open(items[0].id), ctx)!;
    expect(sameTarget(b, { ...b, within: { ...b.within, extra: 0 } })).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
  });

  it('asks the page for its own text back at once only where typing was cancelled', () => {
    expect(revealTarget(s, { ...open(items[0].id), cancelled: 'answer' }, ctx)?.restore).toEqual(['answer']);
    expect(revealTarget(s, { ...open(items[0].id), cancelled: 'question' }, ctx)?.restore).toEqual(['question']);
    expect(revealTarget(s, open(items[0].id), ctx)?.restore).toBeUndefined();
    expect(revealTarget(s, { ...open(items[0].id), cancelled: 'nope' }, ctx)?.restore).toBeUndefined();
    expect(revealTarget(s, { ...open(items[0].id, { field: 'answer', text: 'A' }), cancelled: 'answer' }, ctx)?.restore).toBeUndefined();
    expect(sameTarget(revealTarget(s, { ...open(items[0].id), cancelled: 'answer' }, ctx), revealTarget(s, open(items[0].id), ctx))).toBe(false);
  });
});
