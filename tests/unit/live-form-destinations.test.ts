/**
 * A live session's guests never change where a contact form sends visitors' messages (#765), however a design passes
 * the form's destination on: the host's check against the project as a guest's batch would leave it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { formDestinationProps, GUEST_BATCH_MAX_NEW_ELEMENTS, guestDestinationChange, guestEditProblem } from '@engine/guest-edits';

const FORM = 'foundation.contact.form';
const SALES = 'https://forms.example.com/sales';
const SUPPORT = 'https://forms.example.com/support';

function run(state: ProjectState, ops: EditOperation[]) {
  return applyOperations(state, ops);
}

/**
 * A blank site with a contact form on its home page, and "Contact band": a design around a form that passes its own
 * `recipient` on as the form's endpoint, placed twice, for Sales and for Support.
 */
function project() {
  let state = createStarterState('blank', 'Forms', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const r = run(state, ops);
    state = r.state;
    return r.results;
  };
  const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  step([{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
  const band = step([{ type: 'component.createFromNode', owner, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
  const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
  step([
    { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } },
    { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
  ]);
  const sales = step([{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: SALES } }])[0].nodeId as string;
  const support = step([{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: SUPPORT } }])[0].nodeId as string;
  const form = step([{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SUPPORT } }])[0].nodeId as string;
  return { state, owner, band, sales, support, form };
}

/** Why a guest's batch is refused, applied to the project as it is; null when it is allowed. */
function guest(state: ProjectState, ops: EditOperation[]): string | null {
  return guestDestinationChange(state, run(state, ops).state);
}

describe('where a contact form sends its messages', () => {
  it('follows a destination through the design that passes it on', () => {
    const { state, band } = project();
    const props = formDestinationProps(state);
    expect([...(props.get(FORM) ?? [])].sort()).toEqual(['accessKey', 'endpoint', 'formName', 'provider']);
    expect([...(props.get(band) ?? [])]).toEqual(['recipient']);
  });

  it('keeps each placement’s destination, even one the host set on another placement', () => {
    const { state, owner, sales, form } = project();
    // Sales would now send to Support: both are the host's, but which goes where is the host's call.
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: sales, prop: 'recipient', value: SUPPORT }])).toMatch(/Only the host can change where “Contact band” sends/);
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: sales, prop: 'recipient', value: 'https://evil.example/f' }])).not.toBeNull();
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: sales, prop: 'recipient', value: '' }])).not.toBeNull();
    // A form's own endpoint, set or emptied, the same.
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: SALES }])).not.toBeNull();
    // Everything else about them is an ordinary edit.
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'heading', value: 'Write to us' }])).toBeNull();
    expect(guest(state, [{ type: 'node.setStyle', owner, nodeId: sales, scope: 'base', property: 'paddingBlock', value: '2rem' } as EditOperation])).toBeNull();
    // Which service a form uses decides where its messages go as much as the service's own setting.
    expect(guest(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'provider', value: 'web3forms' }])).not.toBeNull();
  });

  it('lets a new placement send only where the host already sends', () => {
    const { state, owner, band, sales } = project();
    expect(guest(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: 'https://evil.example/f' } }])).not.toBeNull();
    expect(guest(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band }])).toBeNull();
    expect(guest(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: SUPPORT } }])).toBeNull();
    // A copy of a placement sends where it did; moving and removing one change no destination.
    expect(guest(state, [{ type: 'node.duplicate', owner, nodeId: sales }])).toBeNull();
    expect(guest(state, [{ type: 'node.move', owner, nodeId: sales, parentId: null, index: 0 }])).toBeNull();
    expect(guest(state, [{ type: 'node.remove', owner, nodeId: sales }])).toBeNull();
  });

  it('follows a placement made in one operation and aimed in the next', () => {
    const { state, owner, band } = project();
    expect(guest(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, newNodeId: 'n_guest1' }, { type: 'instance.setProp', owner, nodeId: 'n_guest1', prop: 'recipient', value: 'https://evil.example/f' }])).not.toBeNull();
  });

  it('never makes a design’s ordinary text a destination by swapping it for one that passes it on', () => {
    const { state, owner, band } = project();
    let next = state;
    const step = (ops: EditOperation[]) => {
      const r = run(next, ops);
      next = r.state;
      return r.results;
    };
    const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
    const note = step([{ type: 'component.createFromNode', owner, nodeId: section, name: 'Note band' }])[0].definitionId as string;
    step([{ type: 'component.setPropSchema', definitionId: note, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } }]);
    const placed = step([{ type: 'node.insert', owner, parentId: null, definitionId: note, props: { recipient: 'https://evil.example/f' } }])[0].nodeId as string;
    const swapped = run(next, [{ type: 'instance.swapComponent', owner, nodeId: placed, definitionId: band, allowDrops: true }]).state;
    expect((swapped.pages[owner.id].nodes[placed] as InstanceNode).props.recipient).toBe('https://evil.example/f');
    expect(guestDestinationChange(next, swapped)).toMatch(/Only the host can change where/);
  });

  it('treats anything with a form destination’s name as a form, whatever its code', () => {
    const { state } = project();
    const copy = { id: 'cmp_myform', name: 'My form', kind: 'code', owner: 'project', source: '<form></form>', properties: { endpoint: { type: 'string', label: 'Endpoint', default: '' }, provider: { type: 'string', label: 'Service', default: '' }, heading: { type: 'string', label: 'Heading', default: '' } } } as never;
    state.components.cmp_myform = copy;
    expect([...(formDestinationProps(state).get('cmp_myform') ?? [])].sort()).toEqual(['endpoint', 'provider']);
  });

  it('holds code that places a form to all its properties, whatever their names', () => {
    const { state } = project();
    state.components.cmp_codeband = { id: 'cmp_codeband', name: 'Code band', kind: 'code', owner: 'project', source: '<script></script>', dependencies: [FORM], properties: { endpoint: { type: 'string', label: 'Endpoint', default: '' }, recipient: { type: 'string', label: 'Recipient', default: '' }, heading: { type: 'string', label: 'Heading', default: '' } } } as never;
    expect([...(formDestinationProps(state).get('cmp_codeband') ?? [])].sort()).toEqual(['endpoint', 'heading', 'recipient']);
  });

  it('lets a new placement use only what the host set for that same design', () => {
    const { state, owner, band } = project();
    // An address the host keeps under a property named like a destination, on a design that sends nothing.
    state.components.cmp_api = { id: 'cmp_api', name: 'API card', kind: 'code', owner: 'project', source: '<p></p>', properties: { endpoint: { type: 'string', label: 'Endpoint', default: 'https://api.example.com/v1' } } } as never;
    expect(guest(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: 'https://api.example.com/v1' } }])).not.toBeNull();
  });

  it('counts a list connected to a collection as the list’s value', () => {
    const { state, owner, sales } = project();
    const after = structuredClone(state);
    (after.pages[owner.id].nodes[sales] as InstanceNode).listSources = { recipient: { query: { collectionId: 'leads' } } } as never;
    expect(guestDestinationChange(state, after)).toMatch(/Only the host can change where/);
  });

  it('lets one edit add only so many elements', () => {
    const { state, owner } = project();
    const grown = (extra: number) => {
      const after = structuredClone(state);
      const nodes = after.pages[owner.id].nodes as Record<string, unknown>;
      const sample = Object.values(nodes)[0];
      for (let i = 0; i < extra; i++) nodes[`n_grow${i}`] = { ...(sample as object), id: `n_grow${i}` };
      return after;
    };
    expect(guestEditProblem(state, grown(GUEST_BATCH_MAX_NEW_ELEMENTS))).toBeNull();
    expect(guestEditProblem(state, grown(GUEST_BATCH_MAX_NEW_ELEMENTS + 1))).toMatch(/at most/);
  });

  it('keeps adding dated articles to the host, a copy of one included', () => {
    const { state } = project();
    const article = run(state, [{ type: 'page.create', title: 'Spring news', starter: 'article' }]);
    const withArticle = article.state;
    const articleId = article.results[0].pageId as string;
    expect(guestEditProblem(withArticle, run(withArticle, [{ type: 'page.duplicate', pageId: articleId }]).state)).toMatch(/Only the host can add an article/);
    expect(guestEditProblem(withArticle, run(withArticle, [{ type: 'page.duplicate', pageId: withArticle.site.homePageId }]).state)).toBeNull();
    expect(guestEditProblem(withArticle, run(withArticle, [{ type: 'page.create', title: 'Workshops' }]).state)).toBeNull();
  });

  it('leaves swapping a placement into or out of a design that routes a form to the host', () => {
    const { state, owner, sales } = project();
    const swapped = run(state, [{ type: 'instance.swapComponent', owner, nodeId: sales, componentId: 'contact.form', allowDrops: true }]);
    expect((swapped.state.pages[owner.id].nodes[sales] as InstanceNode).definitionId).toBe(FORM);
    expect(guestDestinationChange(state, swapped.state)).toMatch(/Only the host can change where/);
  });
});
