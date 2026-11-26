/**
 * A live session's guests never change where a contact form sends visitors' messages (#765), however a design passes
 * the form's destination on: the host's check against the project as a guest's batch would leave it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { formDestinationProps, guestDestinationChange } from '@engine/form-destinations';

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
    expect([...(props.get(FORM) ?? [])].sort()).toEqual(['accessKey', 'endpoint']);
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
    expect(guest(state, [{ type: 'node.setStyle', owner, nodeId: sales, property: 'paddingBlock', value: '2rem' } as EditOperation])).toBeNull();
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

  it('keeps a destination when a design is swapped for another in its place', () => {
    const { state, owner, sales } = project();
    // Into a design without a destination, the placement sends nowhere any more: no destination was changed.
    const swapped = run(state, [{ type: 'instance.swapComponent', owner, nodeId: sales, componentId: 'contact.form', allowDrops: true }]);
    const node = swapped.state.pages[owner.id].nodes[sales] as InstanceNode;
    expect(node.definitionId).toBe(FORM);
    // The form it became keeps Sales's destination only if the swap carried it over; anything else is refused.
    expect(guestDestinationChange(state, swapped.state) === null).toBe((node.props.endpoint ?? '') === SALES);
  });
});
