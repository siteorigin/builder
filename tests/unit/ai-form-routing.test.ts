/**
 * The assistant never changes where a contact form sends visitors' messages without the user's say (#1128): its
 * batches are checked at commit, in the main process, against the project as they would leave it, however the
 * change is made, while every other edit to a form commits as before.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState } from '@shared/types';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData, isPackaged: false } }));

const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { makeInstance } = await import('@engine/install');
const { formRoutingChanges, formRoutingPrompt, formRoutingQuestion, formRoutingReview } = await import('@engine/form-routing');
const { ProjectSession } = await import('../../src/main/project/session');
const { registerSecondTheme, SECOND_THEME_ID } = await import('./second-theme');
registerSecondTheme();

const FORM = 'foundation.contact.form';
const SALES = 'https://forms.example.com/sales';
const SUPPORT = 'https://forms.example.com/support';
const EVIL = 'https://evil.example/f';
const LAYOUT: OwnerRef = { kind: 'template', id: 'posts' };

const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-ai-form-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A blank site with a contact form on its home page that sends to Sales. */
function project() {
  let state = createStarterState('blank', 'Forms', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const r = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
  state = r.state;
  return { state, owner, form: r.results[0].nodeId as string };
}

/**
 * The same site with "Contact band" placed on it too: a design around a form that passes its own `recipient` on as
 * the form's endpoint, placed for Support.
 */
function banded() {
  const { state: start, owner, form } = project();
  let state = start;
  const step = (ops: EditOperation[]) => {
    const r = applyOperations(state, ops);
    state = r.state;
    return r.results;
  };
  const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  step([{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SUPPORT } }]);
  const band = step([{ type: 'component.createFromNode', owner, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
  const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
  step([
    { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } },
    { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
  ]);
  const support = step([{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: SUPPORT } }])[0].nodeId as string;
  return { state, owner, form, band, inner, support };
}

/**
 * The blank site with "Office forms" too: a design with two lists of inboxes, Sales and Support, and a form repeated
 * per Sales office that sends to each office's inbox.
 */
function offices(): ProjectState {
  const state = structuredClone(project().state);
  const form = makeInstance(state.components[FORM], { provider: 'endpoint', endpoint: { $item: 'inbox' } });
  const sales = { id: 'n_offsal1', kind: 'repeat', list: { $prop: 'sales' }, children: [form.id] };
  const support = { id: 'n_offsup1', kind: 'repeat', list: { $prop: 'support' }, children: [] as string[] };
  const root = { id: 'n_offroot', kind: 'element', tag: 'div', children: [sales.id, support.id] };
  const list = { type: 'list', label: 'Offices', itemLabel: 'Office', fields: { inbox: { type: 'string', label: 'Inbox', default: '' } }, default: [] };
  state.components['project.offices'] = {
    schemaVersion: 1,
    id: 'project.offices',
    componentId: 'project.offices',
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: 'Office forms',
    description: '',
    category: 'custom',
    tags: [],
    properties: { sales: list, support: list },
    parts: { root: { nodeId: root.id, label: 'Root' } },
    tree: { rootIds: [root.id], nodes: { [root.id]: root, [sales.id]: sales, [support.id]: support, [form.id]: form } }
  } as unknown as ComponentDefinition;
  return state;
}

/** What an AI batch, applied to `state`, changes about where a form sends: each change's kind, setting and value. */
function changes(state: ProjectState, ops: EditOperation[]) {
  return formRoutingChanges(state, applyOperations(state, ops).state).map((c) => [c.kind, c.prop ?? null, c.value ?? null]);
}

describe('where a form sends, as an AI batch would leave it', () => {
  it('is a form’s service and its settings, and nothing else about the form', () => {
    const { state, owner, form } = project();
    const set = (prop: string, value: unknown): EditOperation => ({ type: 'instance.setProp', owner, nodeId: form, prop, value });
    expect(changes(state, [set('endpoint', EVIL)])).toEqual([['setting', 'endpoint', EVIL]]);
    expect(changes(state, [set('endpoint', '')])).toEqual([['setting', 'endpoint', '']]);
    expect(changes(state, [set('provider', 'web3forms')])).toEqual([['setting', 'provider', 'web3forms']]);
    expect(changes(state, [set('accessKey', 'key-1')])).toEqual([['setting', 'accessKey', 'key-1']]);
    expect(changes(state, [set('formName', 'enquiries')])).toEqual([['setting', 'formName', 'enquiries']]);
    // Its heading, copy, fields and looks are ordinary edits.
    const fields = (state.pages[owner.id].nodes[form] as InstanceNode).props.fields as Array<Record<string, unknown>>;
    expect(changes(state, [set('heading', 'Write to us'), set('lead', 'We reply within a day.'), set('submitLabel', 'Send')])).toEqual([]);
    expect(changes(state, [set('fields', [...fields.slice(0, 2), { ...fields[2], label: 'Mobile' }])])).toEqual([]);
    expect(changes(state, [{ type: 'node.setStyle', owner, nodeId: form, scope: 'base', property: 'paddingBlock', value: '2rem' } as EditOperation])).toEqual([]);
    // Removing a form sends nothing anywhere.
    expect(changes(state, [{ type: 'node.remove', owner, nodeId: form }])).toEqual([]);
  });

  it('lets in a fresh form from the library, and copies of one already placed', () => {
    const blank = createStarterState('blank', 'Forms', false);
    const home: OwnerRef = { kind: 'page', id: blank.site.homePageId };
    // The theme's form is installed with its first placement, with the defaults the app ships.
    expect(changes(blank, [{ type: 'node.insert', owner: home, parentId: null, componentId: 'contact.form', props: { heading: 'Say hello' } }])).toEqual([]);
    expect(changes(blank, [{ type: 'node.insert', owner: home, parentId: null, componentId: 'contact.form', props: { endpoint: EVIL } }])).toEqual([['setting', 'endpoint', EVIL]]);
    const { state, owner, form } = project();
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form' }])).toEqual([]);
    expect(changes(state, [{ type: 'node.duplicate', owner, nodeId: form }])).toEqual([]);
    expect(changes(state, [{ type: 'page.duplicate', pageId: owner.id }])).toEqual([]);
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }])).toEqual([]);
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: EVIL } }])).toEqual([['setting', 'endpoint', EVIL]]);
  });

  it('never puts together a new form from settings of different forms', () => {
    const { state: start, owner, form } = project();
    // Sales keeps an old Web3Forms key it no longer uses; another form uses Web3Forms with a key of its own.
    let state = applyOperations(start, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'accessKey', value: 'old-key' }]).state;
    state = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'web3forms', accessKey: 'new-key' } }]).state;
    // Each setting was the host's somewhere, but not together: this form would send with the key Sales left unused.
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'web3forms', accessKey: 'old-key' } }])).toEqual([
      ['setting', 'accessKey', 'old-key'],
      ['setting', 'provider', 'web3forms']
    ]);
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'web3forms', accessKey: 'new-key' } }])).toEqual([]);
  });

  it('follows a setting through a design that passes it on: its placements, its defaults and what it passes', () => {
    const { state, owner, band, inner, support } = banded();
    expect(changes(state, [{ type: 'instance.setProp', owner, nodeId: support, prop: 'recipient', value: EVIL }])).toEqual([['setting', 'recipient', EVIL]]);
    // A design's default, which new placements start with: the band the design was made from has no recipient of its
    // own, so it would send there too.
    const evil: EditOperation = { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: EVIL } };
    expect(changes(state, [evil])).toEqual([
      ['setting', 'recipient', EVIL],
      ['default', 'recipient', EVIL]
    ]);
    // Even once every placement has its own.
    const own = applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: state.pages[owner.id].rootIds.find((id) => id !== support && (state.pages[owner.id].nodes[id] as InstanceNode).definitionId === band)!, prop: 'recipient', value: SUPPORT }]).state;
    expect(changes(own, [evil])).toEqual([['default', 'recipient', EVIL]]);
    // What the design passes on to its form, inside the design itself.
    const design: OwnerRef = { kind: 'component', id: band };
    const unbind: EditOperation = { type: 'node.setBinding', owner: design, nodeId: inner, field: 'prop', prop: 'endpoint', binding: null };
    expect(changes(state, [unbind, { type: 'instance.setProp', owner: design, nodeId: inner, prop: 'endpoint', value: EVIL }])).toEqual([['setting', 'endpoint', EVIL]]);
    expect(changes(state, [{ type: 'instance.setProp', owner: design, nodeId: inner, prop: 'heading', value: 'Talk to support' }])).toEqual([]);
    // A new placement of the design sends where one already does, or nowhere.
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: SUPPORT } }])).toEqual([]);
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band }])).toEqual([]);
    expect(changes(state, [{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: EVIL } }])).toEqual([['setting', 'recipient', EVIL]]);
  });

  it('checks a new design as it is built, and lets one built around a form keep where it sends', () => {
    const { state, owner } = project();
    const built = (endpoint: string) => [
      { type: 'node.insert', owner, parentId: null, componentId: 'layout.section', newNodeId: 'n_aisect1' },
      { type: 'node.insert', owner, parentId: 'n_aisect1', slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint } },
      { type: 'component.createFromNode', owner, nodeId: 'n_aisect1', name: 'Enquiry band' }
    ] as EditOperation[];
    expect(changes(state, built(SALES))).toEqual([]);
    expect(changes(state, built(EVIL))).toEqual([['setting', 'endpoint', EVIL]]);
  });

  it('keeps a form’s settings across a change of theme, and checks what the new theme’s form starts with', () => {
    const { state: start, owner } = project();
    const state = applyOperations(start, [{ type: 'theme.apply', themeId: 'foundation' } as EditOperation]).state;
    // Each theme ships its own form: switching swaps the placement for it, with its settings as they were.
    expect(changes(state, [{ type: 'theme.apply', themeId: SECOND_THEME_ID } as EditOperation])).toEqual([]);
    const second = applyOperations(state, [{ type: 'theme.apply', themeId: SECOND_THEME_ID } as EditOperation]).state;
    expect(changes(second, [{ type: 'theme.apply', themeId: 'foundation' } as EditOperation])).toEqual([]);
    // Swapped by hand into a design of the project's own, or out of one into the theme's, nothing says the two send
    // what carries over to the same place.
    const placed = Object.keys(state.pages[owner.id].nodes).find((id) => (state.pages[owner.id].nodes[id] as InstanceNode).definitionId === FORM)!;
    const copy = structuredClone(state);
    copy.components.cmp_myform = { ...structuredClone(copy.components[FORM]), id: 'cmp_myform', owner: 'project', name: 'My form' };
    expect(formRoutingChanges(copy, applyOperations(copy, [{ type: 'instance.swapComponent', owner, nodeId: placed, definitionId: 'cmp_myform', allowDrops: true } as EditOperation]).state).map((c) => c.kind)).toEqual(['design']);
    const mine = applyOperations(copy, [{ type: 'node.insert', owner, parentId: null, definitionId: 'cmp_myform', props: { provider: 'endpoint', endpoint: SUPPORT } } as EditOperation]);
    const back = applyOperations(mine.state, [{ type: 'instance.swapComponent', owner, nodeId: mine.results[0].nodeId as string, definitionId: FORM, allowDrops: true } as EditOperation]).state;
    expect(formRoutingChanges(mine.state, back).map((c) => c.kind)).toEqual(['design']);
  });

  it('checks a collection’s layout', () => {
    let state = applyOperations(createStarterState('business', 'Studio', false), [{ type: 'collection.create', collectionId: 'posts' } as EditOperation]).state;
    const r = applyOperations(state, [{ type: 'node.insert', owner: LAYOUT, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
    state = r.state;
    const form = r.results[0].nodeId as string;
    expect(changes(state, [{ type: 'instance.setProp', owner: LAYOUT, nodeId: form, prop: 'endpoint', value: EVIL }])).toEqual([['setting', 'endpoint', EVIL]]);
    expect(changes(state, [{ type: 'instance.setProp', owner: LAYOUT, nodeId: form, prop: 'heading', value: 'Ask about this post' }])).toEqual([]);
  });

  it('reads an item’s field from the list the form repeats in', () => {
    // "Office forms": one design, two lists of inboxes, a form repeated per Sales office reading each office's inbox.
    const state = offices();
    const form = Object.values(state.components['project.offices'].tree!.nodes).find((n) => n.kind === 'instance')!;
    const sales = { id: 'n_offsal1' };
    const support = { id: 'n_offsup1' };
    // Moved to the other repeat, the same form with the same binding reads Support's inboxes.
    const moved = structuredClone(state);
    const nodes = moved.components['project.offices'].tree!.nodes as Record<string, { children?: string[] }>;
    nodes[sales.id].children = [];
    nodes[support.id].children = [form.id];
    expect(formRoutingChanges(state, moved).map((c) => [c.kind, c.prop])).toEqual([['setting', 'endpoint']]);
    expect(formRoutingChanges(state, structuredClone(state))).toEqual([]);
    // A copy of a placement has new IDs for its offices, and sends to the same inboxes; another inbox is a change.
    const home: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const r = applyOperations(state, [{ type: 'node.insert', owner: home, parentId: null, definitionId: 'project.offices', props: { sales: [{ inbox: SALES }], support: [{ inbox: SUPPORT }] } } as EditOperation]);
    const desk = r.results[0].nodeId as string;
    expect(changes(r.state, [{ type: 'node.duplicate', owner: home, nodeId: desk }])).toEqual([]);
    expect(changes(r.state, [{ type: 'instance.setProp', owner: home, nodeId: desk, prop: 'sales', value: [{ inbox: EVIL }] }]).map((c) => c.slice(0, 2))).toEqual([['setting', 'sales']]);
    // A placement that stays keeps its offices' IDs too: code may pick an office by its ID.
    const two = applyOperations(r.state, [{ type: 'instance.setProp', owner: home, nodeId: desk, prop: 'sales', value: [{ id: 'i_a', inbox: SALES }, { id: 'i_b', inbox: SUPPORT }] }]).state;
    const swappedIds = [{ id: 'i_b', inbox: SALES }, { id: 'i_a', inbox: SUPPORT }];
    expect(changes(two, [{ type: 'instance.setProp', owner: home, nodeId: desk, prop: 'sales', value: swappedIds }]).map((c) => c.slice(0, 2))).toEqual([['setting', 'sales']]);
  });

  it('never swaps a placement for another design that places a form, settings of its own or not', () => {
    // "Sales band" and "Support band" each hold a form set inside them, and pass nothing on.
    const { state: start, owner } = project();
    let state = start;
    const band = (name: string, endpoint: string) => {
      const section = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
      state = section.state;
      const id = section.results[0].nodeId as string;
      state = applyOperations(state, [{ type: 'node.insert', owner, parentId: id, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint } }]).state;
      const made = applyOperations(state, [{ type: 'component.createFromNode', owner, nodeId: id, name }]);
      state = made.state;
      return { definitionId: made.results[0].definitionId as string, nodeId: made.results[0].nodeId as string };
    };
    const sales = band('Sales band', SALES);
    const support = band('Support band', SUPPORT);
    const placed = Object.keys(state.pages[owner.id].nodes).find((id) => (state.pages[owner.id].nodes[id] as InstanceNode).definitionId === sales.definitionId)!;
    expect(changes(state, [{ type: 'instance.swapComponent', owner, nodeId: placed, definitionId: support.definitionId, allowDrops: true } as EditOperation]).map((c) => c[0])).toEqual(['design']);
    // Out of one into a design with no form: the form it sent with is gone, which is the user's to say too.
    const section = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
    const plain = applyOperations(section.state, [{ type: 'component.createFromNode', owner, nodeId: section.results[0].nodeId as string, name: 'Plain band' }]);
    expect(changes(plain.state, [{ type: 'instance.swapComponent', owner, nodeId: placed, definitionId: plain.results[0].definitionId as string, allowDrops: true } as EditOperation]).map((c) => c[0])).toEqual(['design']);
  });

  it('names what a placement made unique sends with, when the batch changes it too', () => {
    const { state, owner, support } = banded();
    const found = changes(state, [
      { type: 'component.makeUnique', owner, nodeId: support, name: 'Support band' },
      { type: 'instance.setProp', owner, nodeId: support, prop: 'recipient', value: EVIL }
    ]);
    expect(found).toContainEqual(['setting', 'recipient', EVIL]);
    expect(found.map((c) => c[0])).toContain('design');
  });

  it('never takes a form’s settings for a copy of one bound in another design', () => {
    // "Note band": a design with a Recipient property that is ordinary text, set on its placement to an address.
    const { state: start, owner, band } = banded();
    let state = start;
    const section = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
    state = section.state;
    const made = applyOperations(state, [{ type: 'component.createFromNode', owner, nodeId: section.results[0].nodeId as string, name: 'Note band' }]);
    state = made.state;
    const note = made.results[0].definitionId as string;
    state = applyOperations(state, [{ type: 'component.setPropSchema', definitionId: note, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } }]).state;
    const placed = Object.keys(state.pages[owner.id].nodes).find((id) => (state.pages[owner.id].nodes[id] as InstanceNode).definitionId === note)!;
    state = applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'recipient', value: EVIL }]).state;
    // A form put in it reading Recipient the way Contact band's form does: its settings read the same, from another design.
    const design: OwnerRef = { kind: 'component', id: note };
    const root = state.components[note].tree!.rootIds[0];
    const wired = [
      { type: 'node.insert', owner: design, parentId: root, slot: 'content', componentId: 'contact.form', newNodeId: 'n_aiform1', props: { provider: 'endpoint' } },
      { type: 'node.setBinding', owner: design, nodeId: 'n_aiform1', field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
    ] as EditOperation[];
    expect(changes(state, wired).map((c) => c.slice(0, 2))).toEqual([['setting', 'endpoint']]);
    // The same form copied inside Contact band itself reads Contact band's own Recipient, as its form already does.
    const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
    expect(changes(state, [{ type: 'node.duplicate', owner: { kind: 'component', id: band }, nodeId: inner }])).toEqual([]);
  });

  it('keeps comparing a setting a design stops having', () => {
    // "My form": the project's own copy of the form, placed to send to Sales.
    const { state: start, owner } = project();
    const state = structuredClone(start);
    state.components.cmp_myform = { ...structuredClone(state.components[FORM]), id: 'cmp_myform', owner: 'project', name: 'My form' };
    const r = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, definitionId: 'cmp_myform', props: { provider: 'endpoint', endpoint: SALES } } as EditOperation]);
    const placed = r.results[0].nodeId as string;
    // Its endpoint setting taken away, the code is left with whatever it falls back on.
    const after = structuredClone(r.state);
    delete after.components.cmp_myform.properties.endpoint;
    delete (after.pages[owner.id].nodes[placed] as InstanceNode).props.endpoint;
    // An empty setting and none at all are not the same: the code may fall back on its own when it is given none.
    expect(formRoutingChanges(r.state, after).map((c) => [c.kind, c.prop])).toEqual([
      ['setting', 'endpoint'],
      ['default', 'endpoint']
    ]);
  });

  it('lets a form put in another’s place send only where one there already did', () => {
    // Home's form sends to Sales; a draft page's sends to Support.
    const { state: start, owner, form } = project();
    const draft = applyOperations(start, [{ type: 'page.create', title: 'Draft' } as EditOperation]);
    let state = draft.state;
    const other: OwnerRef = { kind: 'page', id: draft.results[0].pageId as string };
    state = applyOperations(state, [{ type: 'node.insert', owner: other, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SUPPORT } }]).state;
    const replaced = (endpoint: string): EditOperation[] => [
      { type: 'node.remove', owner, nodeId: form },
      { type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint } }
    ];
    expect(changes(state, replaced(SUPPORT))).toEqual([['setting', 'endpoint', SUPPORT]]);
    expect(changes(state, replaced(SALES))).toEqual([]);
    // A page the batch makes takes its forms from the page it copies.
    expect(changes(state, [{ type: 'page.duplicate', pageId: other.id }])).toEqual([]);
  });

  it('takes text that only looks like a binding as the text it is', () => {
    const { state, owner, form } = project();
    const odd = applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'formName', value: '{"$prop":"recipient"}' }]).state;
    expect(changes(odd, [{ type: 'page.duplicate', pageId: owner.id }])).toEqual([]);
  });

  it('holds code that places a form to every setting it has and the variant it is given, through code of its own too', () => {
    // "Office code": code with a Recipient setting and two variants, placing the form through "Inner code", code of its
    // own with no settings at all.
    const { state: start, owner } = project();
    const state = structuredClone(start);
    const code = (id: string, name: string, dependencies: string[], properties: Record<string, unknown>, variantAxes?: unknown) =>
      ({ id, name, kind: 'code', owner: 'project', source: `<script>/* ${name} */</script>`, dependencies, properties, ...(variantAxes ? { variantAxes } : {}) }) as unknown as ComponentDefinition;
    state.components.cmp_inner = code('cmp_inner', 'Inner code', [FORM], {});
    state.components.cmp_office = code('cmp_office', 'Office code', ['cmp_inner'], { recipient: { type: 'string', label: 'Recipient', default: '' } }, {
      office: { label: 'Office', prop: 'office', default: 'sales', options: { sales: { label: 'Sales' }, support: { label: 'Support' } } }
    });
    const placed = makeInstance(state.components.cmp_office, { recipient: SALES });
    placed.variants = { office: 'sales' };
    state.pages[owner.id].nodes[placed.id] = placed;
    state.pages[owner.id].rootIds.push(placed.id);
    const edit = (change: (n: InstanceNode) => void) => {
      const next = structuredClone(state);
      change(next.pages[owner.id].nodes[placed.id] as InstanceNode);
      return formRoutingChanges(state, next).map((c) => [c.kind, c.prop]);
    };
    expect(edit((n) => (n.props.recipient = EVIL))).toEqual([['setting', 'recipient']]);
    expect(edit((n) => (n.variants = { office: 'support' }))).toEqual([['setting', '\u0001variants']]);
    expect(formRoutingChanges(state, structuredClone(state))).toEqual([]);
    // A placement that takes the design's default variant is given another when the default changes.
    delete placed.variants;
    const defaulted = structuredClone(state);
    (defaulted.components.cmp_office.variantAxes as Record<string, { default: string }>).office.default = 'support';
    expect(formRoutingChanges(state, defaulted).map((c) => [c.kind, c.prop])).toEqual([
      ['setting', '\u0001variants'],
      ['default', '\u0001variants']
    ]);
    // A new placement given the design's defaults sends as a fresh one does.
    const fresh = structuredClone(state);
    const another = makeInstance(fresh.components.cmp_office);
    fresh.pages[owner.id].nodes[another.id] = another;
    fresh.pages[owner.id].rootIds.push(another.id);
    expect(formRoutingChanges(state, fresh)).toEqual([]);
  });

  it('never lets code that places a form be written, nor a form’s own code', () => {
    const { state } = project();
    const code = (id: string, source: string, dependencies: string[]) =>
      ({ id, name: 'Code band', kind: 'code', owner: 'project', source, dependencies, properties: {} }) as unknown as ComponentDefinition;
    // Code with no properties of its own, placing a form with whatever it likes in its source.
    const placing = structuredClone(state);
    placing.components.cmp_codeband = code('cmp_codeband', '<script>/* a form */</script>', [FORM]);
    expect(formRoutingChanges(state, placing).map((c) => [c.kind, c.definitionId])).toEqual([['code', 'cmp_codeband']]);
    const rewritten = structuredClone(placing);
    rewritten.components.cmp_codeband.source = '<script>/* another form */</script>';
    expect(formRoutingChanges(placing, rewritten).map((c) => c.kind)).toEqual(['code']);
    // Code that has nothing to do with a form is not this check's.
    const plain = structuredClone(state);
    plain.components.cmp_clock = code('cmp_clock', '<script>/* a clock */</script>', []);
    expect(formRoutingChanges(state, plain)).toEqual([]);
  });

  it('is asked about in the app’s own words, naming each change whole', () => {
    const { state, owner, form } = project();
    const found = formRoutingChanges(state, applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }]).state);
    const q = formRoutingQuestion(found);
    expect(q.text).toContain(EVIL);
    expect(q.text).toContain('“Home”');
    expect(q.choices).toEqual(['Keep it as it is', 'Allow this change']);
    expect(q.allow).toBe(q.choices[1]);
    // Six forms, each sent somewhere else, one of them to an address too long to read at a glance: every one is named, whole.
    const long = `https://forms.example.com/${'x'.repeat(200)}/inbox-at-the-end`;
    let many = state;
    const forms = [form];
    for (let i = 0; i < 5; i++) {
      const r = applyOperations(many, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
      many = r.state;
      forms.push(r.results[0].nodeId as string);
    }
    const ops: EditOperation[] = forms.map((nodeId, i) => ({ type: 'instance.setProp', owner, nodeId, prop: 'endpoint', value: i === 5 ? long : `${EVIL}${i}` }));
    const five = formRoutingQuestion(formRoutingChanges(many, applyOperations(many, ops).state));
    for (let i = 0; i < 5; i++) expect(five.text).toContain(`${EVIL}${i}`);
    expect(five.text).toContain(long);
    expect(five.allow).toBe('Allow these changes');
  });
});

describe('the app’s dialog for an AI change to where forms send (#1130)', () => {
  const ENDPOINT = 'Form endpoint (Formspree, Basin, Getform…)';
  /** The dialog's review of what an AI batch, applied to `state`, changes about where its forms send. */
  const review = (state: ProjectState, ops: EditOperation[]) => formRoutingPrompt(formRoutingChanges(state, applyOperations(state, ops).state)).forms;

  it('shows a form’s service and where it sends, before and after, when only the address changes', () => {
    const { state, owner, form } = project();
    expect(review(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }])).toEqual([
      {
        title: '“Contact form” on “Home”',
        rows: [
          { label: 'Form service', before: ENDPOINT, after: ENDPOINT },
          { label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: `${EVIL} (Form endpoint URL)` }
        ]
      }
    ]);
  });

  it('shows the address a new service reads when only the service changes', () => {
    const { state, owner, form } = project();
    const [f] = review(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'provider', value: 'netlify' }]);
    const netlify = (state.pages[owner.id].nodes[form] as InstanceNode).props.formName ?? state.components[FORM].properties.formName.default;
    expect(f.rows).toEqual([
      { label: 'Form service', before: ENDPOINT, after: 'Netlify Forms' },
      { label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: `${netlify} (Netlify form name)` }
    ]);
  });

  it('names a setting the form’s service does not read, and a cleared address', () => {
    const { state, owner, form } = project();
    const [unused] = review(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'accessKey', value: 'key-1' }]);
    expect(unused.rows).toEqual([
      { label: 'Form service', before: ENDPOINT, after: ENDPOINT },
      { label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: `${SALES} (Form endpoint URL)` },
      { label: 'Web3Forms access key, a setting this service doesn’t use', before: 'Not set', after: 'key-1' }
    ]);
    const [cleared] = review(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: '' }]);
    expect(cleared.rows[1]).toEqual({ label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: 'Not set (Form endpoint URL)' });
  });

  it('shows a new form as new, and tells two forms of the same name in the same place apart', () => {
    const { state, owner, form } = project();
    const [added] = review(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: EVIL } }]);
    expect(added.rows).toEqual([
      { label: 'Form service', before: 'New form', after: ENDPOINT },
      { label: 'Sends to', before: 'New form', after: `${EVIL} (Form endpoint URL)` }
    ]);
    const second = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
    const other = second.results[0].nodeId as string;
    const both = review(second.state, [
      { type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: `${EVIL}1` },
      { type: 'instance.setProp', owner, nodeId: other, prop: 'endpoint', value: `${EVIL}2` }
    ]);
    expect(both.map((f) => f.title)).toEqual(['“Contact form” on “Home” (1 of 2)', '“Contact form” on “Home” (2 of 2)']);
    expect(both.map((f) => f.rows[1].after).sort()).toEqual([`${EVIL}1 (Form endpoint URL)`, `${EVIL}2 (Form endpoint URL)`]);
  });

  it('shows a design’s setting that passes an address on, and its default, before and after', () => {
    const { state, owner, band, support } = banded();
    const [placed] = review(state, [{ type: 'instance.setProp', owner, nodeId: support, prop: 'recipient', value: EVIL }]);
    // The form inside it sends where the placement's setting passes on.
    expect(placed).toEqual({
      title: '“Contact band” on “Home”',
      rows: [
        { label: 'Form service', before: ENDPOINT, after: ENDPOINT },
        { label: 'Sends to', before: `${SUPPORT} (Form endpoint URL)`, after: `${EVIL} (Form endpoint URL)` },
        { label: 'Recipient', before: SUPPORT, after: EVIL }
      ]
    });
    const defaults = review(state, [{ type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: EVIL } }]);
    expect(defaults).toContainEqual({
      title: 'The “Contact band” design: what new placements start with',
      rows: [
        { label: 'Form service', before: ENDPOINT, after: ENDPOINT },
        { label: 'Sends to', before: 'Not set (Form endpoint URL)', after: `${EVIL} (Form endpoint URL)` },
        { label: 'Recipient', before: 'Not set', after: EVIL }
      ]
    });
  });

  it('never hides a setting changed alongside the service, even one the old service read', () => {
    const { state, owner, form } = project();
    const [f] = review(state, [
      { type: 'instance.setProp', owner, nodeId: form, prop: 'provider', value: 'netlify' },
      { type: 'instance.setProp', owner, nodeId: form, prop: 'formName', value: 'enquiries' },
      { type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }
    ]);
    expect(f.rows).toEqual([
      { label: 'Form service', before: ENDPOINT, after: 'Netlify Forms' },
      { label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: 'enquiries (Netlify form name)' },
      { label: 'Form endpoint URL, a setting this service doesn’t use', before: SALES, after: EVIL }
    ]);
  });

  it('names the list a repeated form reads its address from, so a move to another list never reads as staying', () => {
    const state = offices();
    const form = Object.values(state.components['project.offices'].tree!.nodes).find((n) => n.kind === 'instance')!;
    const moved = structuredClone(state);
    const nodes = moved.components['project.offices'].tree!.nodes as Record<string, { children?: string[] }>;
    nodes.n_offsal1.children = [];
    nodes.n_offsup1.children = [form.id];
    const [f] = formRoutingPrompt(formRoutingChanges(state, moved)).forms;
    const sends = f.rows.find((r) => r.label === 'Sends to')!;
    expect(sends).toEqual({ label: 'Sends to', before: 'Each item’s “inbox” in the “sales” list (Form endpoint URL)', after: 'Each item’s “inbox” in the “support” list (Form endpoint URL)' });
  });

  it('shows what each design sends to when a placement is swapped for another', () => {
    const { state: start, owner } = project();
    let state = start;
    const band = (name: string, endpoint: string) => {
      const section = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
      state = section.state;
      const id = section.results[0].nodeId as string;
      state = applyOperations(state, [{ type: 'node.insert', owner, parentId: id, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint } }]).state;
      const made = applyOperations(state, [{ type: 'component.createFromNode', owner, nodeId: id, name }]);
      state = made.state;
      return made.results[0].definitionId as string;
    };
    const sales = band('Sales band', SALES);
    const support = band('Support band', SUPPORT);
    const placed = Object.keys(state.pages[owner.id].nodes).find((id) => (state.pages[owner.id].nodes[id] as InstanceNode).definitionId === sales)!;
    const [f] = review(state, [{ type: 'instance.swapComponent', owner, nodeId: placed, definitionId: support, allowDrops: true } as EditOperation]);
    expect(f).toEqual({
      title: '“Support band” on “Home”',
      rows: [
        { label: 'Design', before: 'Sales band', after: 'Support band' },
        { label: 'Form service', before: ENDPOINT, after: ENDPOINT },
        { label: 'Sends to', before: `${SALES} (Form endpoint URL)`, after: `${SUPPORT} (Form endpoint URL)` }
      ]
    });
  });

  it('shows where a fresh placement of a form design sends when the design’s default service changes', () => {
    const { state, owner, form } = project();
    // A form design of the project's own (a copy made unique), with an endpoint and a Netlify name by default.
    const made = applyOperations(state, [{ type: 'component.makeUnique', owner, nodeId: form, name: 'Enquiry form' } as EditOperation]);
    const id = (made.state.pages[owner.id].nodes[form] as InstanceNode).definitionId;
    expect(id).not.toBe(FORM);
    const base = applyOperations(made.state, [
      { type: 'component.setPropSchema', definitionId: id, prop: 'endpoint', schema: { ...made.state.components[id].properties.endpoint, default: SUPPORT } },
      { type: 'component.setPropSchema', definitionId: id, prop: 'formName', schema: { ...made.state.components[id].properties.formName, default: 'enquiries' } }
    ] as EditOperation[]).state;
    const defaults = review(base, [{ type: 'component.setPropSchema', definitionId: id, prop: 'provider', schema: { ...base.components[id].properties.provider, default: 'netlify' } } as EditOperation]);
    expect(defaults).toContainEqual({
      title: 'The “Enquiry form” design: what new placements start with',
      rows: [
        { label: 'Form service', before: ENDPOINT, after: 'Netlify Forms' },
        { label: 'Sends to', before: `${SUPPORT} (Form endpoint URL)`, after: 'enquiries (Netlify form name)' }
      ]
    });
  });

  it('says that code decides where it sends, as no address can be shown', () => {
    const { state } = banded();
    const form = structuredClone(state.components[FORM]);
    const next = structuredClone(state);
    next.components[FORM] = { ...form, source: `${form.source}\n<!-- sends elsewhere -->` };
    const [code] = formRoutingPrompt(formRoutingChanges(state, next)).forms.filter((f) => f.title.startsWith('The code'));
    expect(code).toMatchObject({ title: `The code of “${form.name}”`, rows: [] });
    expect(code.note).toMatch(/its code decides where the form sends/);
  });

  it('keeps every change’s key as before, so the grant matches what the review lists', () => {
    const { state, owner, form } = project();
    const found = formRoutingChanges(state, applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }]).state);
    expect(found).toHaveLength(1);
    expect(JSON.parse(found[0].key)).toEqual(['setting', FORM, `page:${owner.id}:${form}`, 'endpoint', JSON.stringify(EVIL)]);
    expect(found[0]).toMatchObject({ was: SALES, value: EVIL, placement: `page:${owner.id}:${form}` });
  });
});

const endpointOf = (state: ProjectState, owner: OwnerRef, nodeId: string) => (state.pages[owner.id].nodes[nodeId] as InstanceNode).props.endpoint;

describe('an AI batch at commit', () => {
  it('is refused when it changes where a form sends, and nothing of it is saved', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const ops: EditOperation[] = [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }];
    const r = await s.apply({ operations: ops }, { label: 'AI', source: 'ai' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(r.error?.message).toMatch(/Only the user can allow a change to where a contact form sends/);
    expect(formRoutingReview(r.error)?.changes.map((c) => c.prop)).toEqual(['endpoint']);
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    expect(s.revision).toBe(0);
    await s.close();
  });

  it('commits a batch the user allowed, exactly as they allowed it, new IDs and all', async () => {
    const { state, owner } = project();
    const s = await ProjectSession.create(temp('session'), state);
    // A new form, with new node and field IDs each time the batch is made.
    const ops: EditOperation[] = [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: EVIL } }];
    const first = await s.apply({ operations: ops }, { label: 'AI', source: 'ai' });
    const review = formRoutingReview(first.error);
    expect(review?.changes.map((c) => [c.kind, c.prop, c.value])).toEqual([['setting', 'endpoint', EVIL]]);
    // A grant is for the batch it was given for: the same changes from another batch land nothing, and use it up.
    const other: EditOperation[] = [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: EVIL, heading: 'Hi' } }];
    const spent = s.grantFormRouting(review!.id)!;
    expect((await s.apply({ operations: other }, { label: 'AI', source: 'ai', formRouting: spent })).ok).toBe(false);
    expect((await s.apply({ operations: ops }, { label: 'AI', source: 'ai', formRouting: spent })).ok).toBe(false);
    expect(s.revision).toBe(0);
    const again = formRoutingReview((await s.apply({ operations: ops }, { label: 'AI', source: 'ai' })).error)!;
    const allowed = await s.apply({ operations: ops }, { label: 'AI', source: 'ai', formRouting: s.grantFormRouting(again.id)! });
    expect(allowed.error).toBeUndefined();
    expect(Object.values(s.state.pages[owner.id].nodes).filter((n) => n.kind === 'instance' && n.definitionId === FORM && n.props.endpoint === EVIL)).toHaveLength(1);
    await s.close();
  });

  it('is refused for a batch sent under an AI run, whatever it names as its source', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    expect(await s.beginRun('run_1')).toBeNull();
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }] }, { label: 'AI', source: 'user', runId: 'run_1' });
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.close();
  });

  it('lands a batch only when the grant covers every change it makes', async () => {
    const { state: start, owner, form } = project();
    const r0 = applyOperations(start, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
    const second = r0.results[0].nodeId as string;
    const s = await ProjectSession.create(temp('session'), r0.state);
    const ops: EditOperation[] = [
      { type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL },
      { type: 'instance.setProp', owner, nodeId: second, prop: 'endpoint', value: EVIL }
    ];
    const review = formRoutingReview((await s.apply({ operations: ops }, { label: 'AI', source: 'ai' })).error)!;
    // Each placement is its own change: the same value sent to both forms is two changes, and the question says so.
    expect(review.changes).toHaveLength(2);
    expect(new Set(review.changes.map((c) => c.key)).size).toBe(2);
    const asked = formRoutingQuestion(review.changes);
    expect(asked.text).toContain('on 2 forms');
    expect(asked.allow).toBe('Allow these changes');
    expect((await s.apply({ operations: ops }, { label: 'AI', source: 'ai', formRouting: s.grantFormRouting(review.id)! })).ok).toBe(true);
    expect([endpointOf(s.state, owner, form), endpointOf(s.state, owner, second)]).toEqual([EVIL, EVIL]);
    await s.close();
  });

  it('lands an allowed batch that makes a new design, made again with a new ID', async () => {
    const { state, owner, support } = banded();
    const s = await ProjectSession.create(temp('session'), state);
    // Making the Support band unique copies its design under a new ID, which decides where the copy sends.
    const ops: EditOperation[] = [{ type: 'component.makeUnique', owner, nodeId: support, name: 'Support band' }];
    const first = await s.apply({ operations: ops }, { label: 'AI', source: 'ai' });
    const review = formRoutingReview(first.error);
    expect(review?.changes.map((c) => c.kind)).toContain('design');
    const allowed = await s.apply({ operations: ops }, { label: 'AI', source: 'ai', formRouting: s.grantFormRouting(review!.id)! });
    expect(allowed.error).toBeUndefined();
    const copy = (s.state.pages[owner.id].nodes[support] as InstanceNode).definitionId;
    expect(copy).not.toBe(state.pages[owner.id].nodes[support] && (state.pages[owner.id].nodes[support] as InstanceNode).definitionId);
    expect(s.state.components[copy]?.name).toBe('Support band');
    await s.close();
  });

  it('lands an allowed batch that adds offices, each given a new ID when it is made again', async () => {
    const state = offices();
    const home: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const r = applyOperations(state, [{ type: 'node.insert', owner: home, parentId: null, definitionId: 'project.offices', props: { sales: [{ inbox: SALES }] } } as EditOperation]);
    const s = await ProjectSession.create(temp('session'), r.state);
    const ops: EditOperation[] = [{ type: 'instance.setProp', owner: home, nodeId: r.results[0].nodeId as string, prop: 'sales', value: [{ inbox: SALES }, { inbox: SUPPORT }] }];
    const review = formRoutingReview((await s.apply({ operations: ops }, { label: 'AI', source: 'ai' })).error);
    expect(review?.changes.map((c) => c.prop)).toEqual(['sales']);
    const allowed = await s.apply({ operations: ops }, { label: 'AI', source: 'ai', formRouting: s.grantFormRouting(review!.id)! });
    expect(allowed.error).toBeUndefined();
    // It lands as the user was shown it, item IDs and all, not made again with new ones (#1129).
    const landed = (s.state.pages[home.id].nodes[r.results[0].nodeId as string] as InstanceNode).props.sales as Array<{ id: string; inbox: string }>;
    expect(landed.map((o) => o.inbox)).toEqual([SALES, SUPPORT]);
    expect(landed).toEqual(review!.changes[0].value);
    await s.close();
  });

  it('commits an ordinary edit to the same form', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'heading', value: 'Write to us' }] }, { label: 'AI', source: 'ai' });
    expect(r.error).toBeUndefined();
    expect((s.state.pages[owner.id].nodes[form] as InstanceNode).props.heading).toBe('Write to us');
    await s.close();
  });

  it('leaves the user’s own edits alone', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }] }, { label: 'Edit', source: 'user' });
    expect(r.error).toBeUndefined();
    expect(endpointOf(s.state, owner, form)).toBe(EVIL);
    expect(FORM).toBe((s.state.pages[owner.id].nodes[form] as InstanceNode).definitionId);
    await s.close();
  });
});

describe('the host grant for an allowed AI form change (#1129)', () => {
  const setEndpoint = (owner: OwnerRef, nodeId: string, value: string): EditOperation[] => [{ type: 'instance.setProp', owner, nodeId, prop: 'endpoint', value }];
  async function refusedAt(ops: EditOperation[]) {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const batch = ops.length ? ops : setEndpoint(owner, form, EVIL);
    const review = formRoutingReview((await s.apply({ operations: batch }, { label: 'AI', source: 'ai' })).error)!;
    return { s, owner, form, batch, review };
  }

  it('is never what a model, a reply or a page can write: only the session’s own token lands the batch', async () => {
    const { s, owner, form, batch, review } = await refusedAt([]);
    const forged: unknown[] = [
      { operations: review.operations, changes: review.changes.map((c) => c.key) },
      { token: review.id },
      { token: review.operations },
      { token: 'allow' },
      { token: 'a'.repeat(64) },
      'Allow this change',
      true
    ];
    // Tried while the user's real grant waits, and again after it is given: none of them lands, and the real one still does.
    for (const formRouting of forged) {
      const r = await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: formRouting as never });
      expect(r.error?.code).toBe('SCOPE_MISMATCH');
    }
    const real = formRoutingReview((await s.apply({ operations: batch }, { label: 'AI', source: 'ai' })).error)!;
    const grant = s.grantFormRouting(real.id)!;
    for (const formRouting of forged) expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: formRouting as never })).error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    expect(s.revision).toBe(0);
    expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant })).ok).toBe(true);
    expect(endpointOf(s.state, owner, form)).toBe(EVIL);
    await s.close();
  });

  it('is given once per review, and lands one batch once', async () => {
    const { s, owner, form, batch, review } = await refusedAt([]);
    const grant = s.grantFormRouting(review.id)!;
    expect(grant).not.toBeNull();
    expect(s.grantFormRouting(review.id)).toBeNull();
    expect(s.grantFormRouting('not-a-review')).toBeNull();
    expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant })).ok).toBe(true);
    expect(endpointOf(s.state, owner, form)).toBe(EVIL);
    // Put back by the user, the same batch with the same grant is refused: it was used.
    await s.apply({ operations: setEndpoint(owner, form, SALES) }, { label: 'Edit', source: 'user' });
    const rev = s.revision;
    expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant })).error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    expect(s.revision).toBe(rev);
    await s.close();
  });

  it('is used up by a call it does not cover', async () => {
    const { s, owner, form, batch, review } = await refusedAt([]);
    const grant = s.grantFormRouting(review.id)!;
    expect((await s.apply({ operations: setEndpoint(owner, form, SUPPORT) }, { label: 'AI', source: 'ai', formRouting: grant })).ok).toBe(false);
    expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant })).ok).toBe(false);
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.close();
  });

  it('is used up by a call refused before its changes are looked at', async () => {
    const { s, owner, form, batch, review } = await refusedAt([]);
    const grant = s.grantFormRouting(review.id)!;
    expect((await s.apply({ operations: batch, expectedRevision: 5 }, { label: 'AI', source: 'ai', formRouting: grant })).error?.code).toBe('STALE_REVISION');
    expect(s.revision).toBe(0);
    expect((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant })).error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.close();
  });

  it('is not given, nor good, once the project has moved past the revision the user was asked at', async () => {
    const { s, owner, form, batch, review } = await refusedAt([]);
    // The project changes while the user is asked: their answer no longer covers what would land.
    await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'heading', value: 'Hello' }] }, { label: 'Edit', source: 'user' });
    expect(s.grantFormRouting(review.id)).toBeNull();
    // Given at one revision and sent at another: refused too.
    const fresh = formRoutingReview((await s.apply({ operations: batch }, { label: 'AI', source: 'ai' })).error)!;
    const grant = s.grantFormRouting(fresh.id)!;
    await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'heading', value: 'Hi again' }] }, { label: 'Edit', source: 'user' });
    const r = await s.apply({ operations: batch }, { label: 'AI', source: 'ai', formRouting: grant });
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.close();
  });

  it('names each placement and each value whole, so another form or another address is another change', () => {
    const { state: start, owner, form } = project();
    const r0 = applyOperations(start, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
    const second = r0.results[0].nodeId as string;
    const keyOf = (ops: EditOperation[]) => formRoutingChanges(r0.state, applyOperations(r0.state, ops).state).map((c) => c.key);
    const first = keyOf(setEndpoint(owner, form, EVIL));
    expect(first).toHaveLength(1);
    expect(keyOf(setEndpoint(owner, form, EVIL))).toEqual(first);
    expect(keyOf(setEndpoint(owner, second, EVIL))).not.toEqual(first);
    expect(keyOf(setEndpoint(owner, form, `${EVIL}x`))).not.toEqual(first);
    expect(keyOf([{ type: 'instance.setProp', owner, nodeId: form, prop: 'provider', value: 'web3forms' }])).not.toEqual(first);
    // Two new forms on one page, each sending somewhere new, are two changes, named the same each time the batch is made.
    const insert = { type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: EVIL } } as EditOperation;
    expect(new Set(keyOf([insert, insert])).size).toBe(2);
    expect(keyOf([insert, insert])).toEqual(keyOf([insert, insert]));
    // And the copies of a changed form on two pages the batch makes with the same title.
    const twice: EditOperation[] = [...setEndpoint(owner, form, EVIL), { type: 'page.duplicate', pageId: owner.id, title: 'Copy' }, { type: 'page.duplicate', pageId: owner.id, title: 'Copy' }];
    const copies = formRoutingChanges(r0.state, applyOperations(r0.state, twice).state);
    expect(new Set(copies.filter((c) => c.where === 'on “Copy”').map((c) => c.key)).size).toBe(2);
  });

  it('is good only under the run it was given in', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const batch = setEndpoint(owner, form, EVIL);
    expect(await s.beginRun('run_1')).toBeNull();
    const review = formRoutingReview((await s.apply({ operations: batch }, { label: 'AI', source: 'ai', runId: 'run_1' })).error)!;
    const grant = s.grantFormRouting(review.id)!;
    expect(grant).not.toBeNull();
    await s.completeRun('AI');
    // The run ended with nothing changed: the next run, at the same revision, cannot use what the last one was given.
    expect(await s.beginRun('run_2')).toBeNull();
    const r = await s.apply({ operations: batch }, { label: 'AI', source: 'ai', runId: 'run_2', formRouting: grant });
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.abortRun();
    await s.close();
  });
});
