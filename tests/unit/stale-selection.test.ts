// A selection is kept to what the project still has after it changes (issue #196): an Undo of the section, element or
// list item just inserted (and selected), or of the copy Edit everywhere made, lets the selection go in the same update
// as the snapshot, so the Inspector never says the element no longer exists and the AI is never limited to it.
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { keepViewValid, listPropFor, refExists } from '../../src/renderer/src/lib/model';
import { chatContextFor, composerScope, retryView } from '../../src/renderer/src/lib/chatTarget';
import { continueContext } from '../../src/renderer/src/lib/result';
import type { ChatContext } from '@shared/api';

const page = (id: string): OwnerRef => ({ kind: 'page', id });
const at = (owner: OwnerRef, nodeId: string, more: Partial<ElementRef> = {}): ElementRef => ({ owner, instancePath: [], nodeId, ...more });
const enabled = { page: true, selection: true };

/** The Business starter: Home holds a hero, logos, features (a list of cards), media, stats, gallery, testimonials, cta. */
function business() {
  const s: ProjectState = createStarterState('business', 'Studio', false);
  const home = s.site.homePageId;
  const about = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
  const placed = (componentId: string, st: ProjectState = s) => st.pages[home].rootIds.find((id) => st.components[(st.pages[home].nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
  const apply = (st: ProjectState, ops: EditOperation[]) => applyOperations(st, ops);
  return { s, home, about, owner: page(home), placed, apply };
}

/** What `project:changed` keeps of the editor's view for a snapshot. */
const view = (selection: ElementRef | null, pageId: string, definitionMode: { definitionId: string; returnPageId: string } | null = null) => ({ pageId, selection, definitionMode });

describe('a selection the project no longer has is let go when the project changes (#196)', () => {
  it('Undo of a section just inserted (and selected) clears it: the Inspector shows the page, the AI is not limited to it', () => {
    const t = business();
    const inserted = t.apply(t.s, [{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, componentId: 'layout.section' }]);
    const sel = at(t.owner, inserted.results[0].nodeId as string);
    // Still there: nothing changes, and the selection is left as it is (so Layers keeps any layers picked with it).
    expect(keepViewValid(inserted.state, view(sel, t.home))).toStrictEqual({ pageId: t.home, definitionMode: null });
    // Undone: the snapshot before the insert. The selection goes in the same update.
    expect(refExists(t.s, sel)).toBe(false);
    expect(keepViewValid(t.s, view(sel, t.home))).toStrictEqual({ pageId: t.home, definitionMode: null, selection: null });
    // Redo brings the section back; nothing selects it again.
    expect(keepViewValid(inserted.state, view(null, t.home))).toStrictEqual({ pageId: t.home, definitionMode: null });
    // The AI composer never offers (or sends) the element that has gone, even before the editor lets it go.
    const scope = composerScope(t.s, view(sel, t.home));
    expect(scope).toMatchObject({ selection: null, selectionLabel: null });
    expect(chatContextFor(t.s, scope, { enabled, viewport: 1280 })).toMatchObject({ pageId: t.home, selection: null, selectionLabel: null });
    expect(composerScope(inserted.state, view(sel, t.home))).toMatchObject({ selection: sel, selectionLabel: 'Section' });
    // A placement whose component has gone (a hand-edited document) is no target either.
    const broken = structuredClone(inserted.state);
    delete broken.components[(broken.pages[t.home].nodes[sel.nodeId] as InstanceNode).definitionId];
    expect(refExists(broken, sel)).toBe(false);
    expect(keepViewValid(broken, view(sel, t.home))).toHaveProperty('selection', null);
  });

  it('Undo of an element just inserted into a section clears it, and the section around it stays selectable', () => {
    const t = business();
    const holder = t.apply(t.s, [{ type: 'node.insert', newNodeId: 'n_holder', owner: t.owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const withHeading = t.apply(holder, [{ type: 'node.insert', owner: t.owner, parentId: 'n_holder', slot: 'content', primitive: 'heading', text: 'Opening hours' }]);
    const heading = at(t.owner, withHeading.results[0].nodeId as string);
    expect(keepViewValid(withHeading.state, view(heading, t.home))).not.toHaveProperty('selection');
    expect(keepViewValid(holder, view(heading, t.home))).toMatchObject({ selection: null });
    expect(keepViewValid(holder, view(at(t.owner, 'n_holder'), t.home))).not.toHaveProperty('selection');
  });

  it('Undo of a list item just inserted clears a selection of it, though the part it is in is still there', () => {
    const t = business();
    const features = t.placed('features.grid');
    const def = t.s.components[(t.s.pages[t.home].nodes[features] as InstanceNode).definitionId];
    const added = t.apply(t.s, [{ type: 'instance.listInsert', owner: t.owner, nodeId: features, prop: 'items', item: { title: 'Late openings' } }]);
    const itemId = added.results[0].itemId as string;
    const card = (items: string[]): ElementRef => ({ owner: t.owner, instancePath: [features], nodeId: def.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: items });
    expect(keepViewValid(added.state, view(card([itemId]), t.home))).not.toHaveProperty('selection');
    // Undone: the card's title still resolves (the part is the design's), but its item has gone.
    expect(refExists(t.s, { ...card([itemId]), itemPath: undefined })).toBe(true);
    expect(refExists(t.s, card([itemId]))).toBe(false);
    expect(keepViewValid(t.s, view(card([itemId]), t.home))).toMatchObject({ selection: null });
    expect(composerScope(t.s, view(card([itemId]), t.home)).selection).toBeNull();
    // A card that was there before is kept, and so is the title of every card at once.
    const first = (t.s.pages[t.home].nodes[features] as InstanceNode).props.items as Array<{ id: string }>;
    expect(keepViewValid(t.s, view(card([first[0].id]), t.home))).not.toHaveProperty('selection');
    expect(keepViewValid(t.s, view(card([]), t.home))).not.toHaveProperty('selection');
    // Removed by the AI (or another Undo) after it was there: the same.
    const removed = t.apply(added.state, [{ type: 'instance.listRemove', owner: t.owner, nodeId: features, prop: 'items', itemId: first[1].id }]).state;
    expect(refExists(removed, card([first[1].id]))).toBe(false);
    expect(refExists(removed, card([itemId]))).toBe(true);
  });

  it('a list that takes its items from the design keeps them until the placement has its own', () => {
    const t = business();
    const features = t.placed('features.grid');
    const st = structuredClone(t.s);
    const inst = st.pages[t.home].nodes[features] as InstanceNode;
    const def = st.components[inst.definitionId];
    delete inst.props.items;
    const defaults = (def.properties.items as { default: Array<{ id: string }> }).default;
    const card = (id: string): ElementRef => ({ owner: t.owner, instancePath: [features], nodeId: def.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: [id] });
    expect(defaults.length).toBeGreaterThan(0);
    expect(refExists(st, card(defaults[0].id))).toBe(true);
    expect(refExists(st, card('i_not_a_default'))).toBe(false);
    // A list of its own that is empty shows none of the defaults.
    inst.props.items = [];
    expect(refExists(st, card(defaults[0].id))).toBe(false);
    // A value that is not a list at all (a damaged document) says nothing about the items: the selection stays.
    inst.props.items = null;
    expect(refExists(st, card('i_not_a_default'))).toBe(true);
  });

  it('Undo of a list item inserted while editing everywhere clears a selection of it; a placement’s own items stay', () => {
    const t = business();
    const theme = (t.s.pages[t.home].nodes[t.placed('features.grid')] as InstanceNode).definitionId;
    const forked = t.apply(t.s, [{ type: 'component.fork', definitionId: theme }]);
    const defId = forked.results[0].definitionId as string;
    const features = t.placed('features.grid', forked.state);
    const def = forked.state.components[defId];
    const added = t.apply(forked.state, [{ type: 'instance.listInsert', owner: t.owner, nodeId: features, prop: 'items', item: { title: 'Late openings' } }]);
    const itemId = added.results[0].itemId as string;
    // Picked on the canvas through the placement, the design's own title is named by the placement's item.
    const title = (items: string[]): ElementRef => ({ owner: { kind: 'component', id: defId }, instancePath: [], nodeId: def.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: items });
    const dm = { definitionId: defId, returnPageId: t.home };
    expect(keepViewValid(added.state, view(title([itemId]), t.home, dm))).toStrictEqual({ pageId: t.home, definitionMode: dm });
    expect(keepViewValid(forked.state, view(title([itemId]), t.home, dm))).toStrictEqual({ pageId: t.home, definitionMode: dm, selection: null });
    // The placement's items that were there all along, and the design's own defaults, stay.
    const placed = (forked.state.pages[t.home].nodes[features] as InstanceNode).props.items as Array<{ id: string }>;
    const defaults = (def.properties.items as { default: Array<{ id: string }> }).default;
    expect(refExists(forked.state, title([placed[0].id]))).toBe(true);
    expect(refExists(forked.state, title([defaults[0].id]))).toBe(true);
    expect(refExists(forked.state, title(['i_nowhere']))).toBe(false);
  });

  it('a News card goes when its article leaves the list, and stays while it is listed', () => {
    let s = createStarterState('business', 'Riverside Market', false);
    s = applyOperations(s, [
      { type: 'page.create', pageId: 'pg_spring', title: 'Spring makers announced', starter: 'article', articleDate: '2027-03-02' },
      { type: 'page.create', pageId: 'pg_winter', title: 'Winter opening hours', starter: 'article', articleDate: '2026-11-14' }
    ]).state;
    const home = s.site.homePageId;
    const r = applyOperations(s, [{ type: 'node.insert', owner: page(home), componentId: 'content.news' }]);
    const news = r.results[0].nodeId as string;
    const def = r.state.components[(r.state.pages[home].nodes[news] as InstanceNode).definitionId];
    // Each card's title, inside the list's repeat.
    expect(listPropFor(def, def.parts.cardTitle.nodeId)).toBe('items');
    const card: ElementRef = { owner: page(home), instancePath: [news], nodeId: def.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: ['pg_spring'] };
    expect(refExists(r.state, card)).toBe(true);
    expect(refExists(r.state, { ...card, itemPath: ['pg_winter'] })).toBe(true);
    const hidden = applyOperations(r.state, [{ type: 'page.update', pageId: 'pg_spring', newsHidden: true }]).state;
    expect(refExists(hidden, card)).toBe(false);
    expect(refExists(hidden, { ...card, itemPath: ['pg_winter'] })).toBe(true);
    // A list that shows one article shows the newest: the older one's card is not there to select.
    const one = structuredClone(r.state);
    (one.components[def.id].properties.items as { max?: number }).max = 1;
    expect(refExists(one, card)).toBe(true);
    expect(refExists(one, { ...card, itemPath: ['pg_winter'] })).toBe(false);
    // In the shared footer, the list shows the same articles on every page.
    const footer: OwnerRef = { kind: 'shell', id: 'footer' };
    const inFooter = applyOperations(r.state, [{ type: 'node.insert', owner: footer, parentId: null, componentId: 'content.news' }]);
    const footerCard: ElementRef = { ...card, owner: footer, instancePath: [inFooter.results[0].nodeId as string] };
    expect(refExists(inFooter.state, footerCard)).toBe(true);
    const hiddenThere = applyOperations(inFooter.state, [{ type: 'page.update', pageId: 'pg_spring', newsHidden: true }]).state;
    expect(refExists(hiddenThere, footerCard)).toBe(false);
    expect(refExists(hiddenThere, { ...footerCard, itemPath: ['pg_winter'] })).toBe(true);
  });

  it('a part the component no longer declares goes; a code component’s declared parts stay', () => {
    const t = business();
    const forked = t.apply(t.s, [{ type: 'component.fork', definitionId: (t.s.pages[t.home].nodes[t.placed('features.grid')] as InstanceNode).definitionId }]);
    const defId = forked.results[0].definitionId as string;
    const features = t.placed('features.grid', forked.state);
    const node = forked.state.components[defId].parts.heading.nodeId;
    const heading: ElementRef = { owner: t.owner, instancePath: [features], nodeId: node, partId: 'heading' };
    expect(refExists(forked.state, heading)).toBe(true);
    const unpart = t.apply(forked.state, [{ type: 'component.removePart', definitionId: defId, partId: 'heading' }]).state;
    expect(refExists(unpart, heading)).toBe(false);
    // Edited everywhere: the design's own part, the same.
    const own: ElementRef = { owner: { kind: 'component', id: defId }, instancePath: [], nodeId: node, partId: 'heading' };
    expect(refExists(forked.state, own)).toBe(true);
    expect(refExists(unpart, own)).toBe(false);
    // The part moved to another node (an Undo of that change, or its Redo): it no longer names this one.
    const lead = Object.keys(forked.state.components[defId].tree!.nodes).find((id) => id !== node && forked.state.components[defId].tree!.nodes[id].kind === 'text')!;
    const moved = t.apply(forked.state, [{ type: 'component.setPart', definitionId: defId, partId: 'heading', nodeId: lead, label: 'Heading' }]).state;
    expect(refExists(moved, heading)).toBe(false);
    expect(refExists(moved, own)).toBe(false);
    expect(refExists(moved, { ...heading, nodeId: lead })).toBe(true);
    expect(refExists(moved, { ...own, nodeId: lead })).toBe(true);

    // Converted to code: the parts its contract keeps are still selectable, never one item of a list.
    const features2 = t.placed('features.grid');
    const coded = t.apply(t.s, [{ type: 'component.convertToCode', owner: t.owner, nodeId: features2, name: 'Features code' }]).state;
    const codeDef = coded.components[(coded.pages[t.home].nodes[features2] as InstanceNode).definitionId];
    expect(codeDef.kind).toBe('code');
    const themeDef = t.s.components[(t.s.pages[t.home].nodes[features2] as InstanceNode).definitionId];
    const codeHeading: ElementRef = { owner: t.owner, instancePath: [features2], nodeId: themeDef.parts.heading.nodeId, partId: 'heading' };
    expect(codeDef.parts.heading?.nodeId).toBe(codeHeading.nodeId);
    expect(refExists(coded, codeHeading)).toBe(true);
    expect(refExists(coded, { ...codeHeading, nodeId: 'gone' })).toBe(false);
    expect(refExists(coded, { ...codeHeading, partId: undefined })).toBe(false);
    const cardOf = (st: ProjectState): ElementRef => ({ owner: t.owner, instancePath: [features2], nodeId: themeDef.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: [((st.pages[t.home].nodes[features2] as InstanceNode).props.items as Array<{ id: string }>)[0].id] });
    expect(refExists(t.s, cardOf(t.s))).toBe(true);
    // One card picked before the conversion, then the conversion redone: a code component has no card of its own.
    expect(refExists(coded, cardOf(t.s))).toBe(false);

    // A code component has no tree to find its parts in: they are what it declares.
    const source = `<script>\n\tlet { title = 'Hello', so_o, class: className = '' } = $props();\n</script>\n\n<p class="sample {className}">{title}</p>\n`;
    const made = t.apply(t.s, [{ type: 'component.createCode', name: 'Sample note', source, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }]);
    const codeId = made.results[0].definitionId as string;
    const placedCode = t.apply(made.state, [{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, definitionId: codeId } as EditOperation]);
    const st = structuredClone(placedCode.state);
    st.components[codeId].parts.title = { nodeId: 'title', label: 'Title' };
    const codeNode = placedCode.results[0].nodeId as string;
    expect(refExists(st, { owner: t.owner, instancePath: [codeNode], nodeId: 'title', partId: 'title' })).toBe(true);
    expect(refExists(st, { owner: t.owner, instancePath: [codeNode], nodeId: 'gone', partId: 'gone' })).toBe(false);
    expect(refExists(st, at(t.owner, codeNode))).toBe(true);
  });

  it('Undo of the copy Edit everywhere made ends that mode, back on the page it was entered from, with nothing selected', () => {
    const t = business();
    const hero = t.placed('hero.split');
    const theme = (t.s.pages[t.home].nodes[hero] as InstanceNode).definitionId;
    const forked = t.apply(t.s, [{ type: 'component.fork', definitionId: theme }]);
    const defId = forked.results[0].definitionId as string;
    const root = forked.state.components[defId].tree!.rootIds[0];
    const dm = { definitionId: defId, returnPageId: t.about };
    const own = at({ kind: 'component', id: defId }, root);
    expect(keepViewValid(forked.state, view(own, t.home, dm))).toStrictEqual({ pageId: t.home, definitionMode: dm });
    // While the copy is there, a page it returns to that has gone becomes Home and the mode stays.
    expect(keepViewValid(forked.state, view(own, t.home, { ...dm, returnPageId: 'pg_gone' }))).toStrictEqual({ pageId: t.home, definitionMode: { ...dm, returnPageId: t.home } });
    // Undone: the copy has gone. The mode ends in the same update, on the page it returns to.
    expect(keepViewValid(t.s, view(own, t.home, dm))).toStrictEqual({ pageId: t.about, definitionMode: null, selection: null });
    // The selection Edit everywhere starts with (through the placement, before the canvas makes it the design's own)
    // still resolves once the placement is the theme's again: it goes with the mode all the same.
    const through: ElementRef = { owner: t.owner, instancePath: [hero], nodeId: root };
    expect(refExists(t.s, through)).toBe(true);
    expect(keepViewValid(t.s, view(through, t.home, dm))).toStrictEqual({ pageId: t.about, definitionMode: null, selection: null });
    // Entered from Home itself (as the dialog does), it stays on Home.
    expect(keepViewValid(t.s, view(through, t.home, { ...dm, returnPageId: t.home }))).toStrictEqual({ pageId: t.home, definitionMode: null, selection: null });
    // Nothing selected: nothing to let go.
    expect(keepViewValid(t.s, view(null, t.home, dm))).toStrictEqual({ pageId: t.about, definitionMode: null });
    // The page it returns to has gone too: Home.
    expect(keepViewValid(t.s, view(own, t.about, { ...dm, returnPageId: 'pg_gone' }))).toStrictEqual({ pageId: t.home, definitionMode: null, selection: null });
    // Redo brings the copy back; the mode stays closed.
    expect(keepViewValid(forked.state, view(null, t.about, null))).toStrictEqual({ pageId: t.about, definitionMode: null });
  });

  it('a node of the design edited everywhere that an Undo took away goes, and the mode stays', () => {
    const t = business();
    const forked = t.apply(t.s, [{ type: 'component.fork', definitionId: (t.s.pages[t.home].nodes[t.placed('hero.split')] as InstanceNode).definitionId }]);
    const defId = forked.results[0].definitionId as string;
    const owner: OwnerRef = { kind: 'component', id: defId };
    const parent = forked.state.components[defId].tree!.rootIds[0];
    const added = t.apply(forked.state, [{ type: 'node.insert', owner, parentId: parent, primitive: 'heading', text: 'New' }]);
    const sel = at(owner, added.results[0].nodeId as string);
    const dm = { definitionId: defId, returnPageId: t.home };
    expect(keepViewValid(added.state, view(sel, t.home, dm))).toEqual({ pageId: t.home, definitionMode: dm });
    expect(keepViewValid(forked.state, view(sel, t.home, dm))).toEqual({ pageId: t.home, definitionMode: dm, selection: null });
  });

  it('a selection on a page an Undo took away goes with it, and one in the shared header stays', () => {
    const t = business();
    const dup = t.apply(t.s, [{ type: 'page.duplicate', pageId: t.home }]);
    const copyId = dup.results[0].pageId as string;
    const sel = at(page(copyId), dup.state.pages[copyId].rootIds[0]);
    expect(keepViewValid(dup.state, view(sel, copyId))).toEqual({ pageId: copyId, definitionMode: null });
    expect(keepViewValid(t.s, view(sel, copyId))).toEqual({ pageId: t.home, definitionMode: null, selection: null });
    const header = t.s.site.shell.header;
    const inHeader = at({ kind: 'shell', id: 'header' }, header.rootIds[0]);
    expect(keepViewValid(t.s, view(inHeader, t.home))).not.toHaveProperty('selection');
    expect(refExists(t.s, at({ kind: 'shell', id: 'header' }, 'n_gone'))).toBe(false);
  });

  it('a request read back from disk is never retried or continued for an item or element that has gone', () => {
    const t = business();
    const features = t.placed('features.grid');
    const def = t.s.components[(t.s.pages[t.home].nodes[features] as InstanceNode).definitionId];
    const added = t.apply(t.s, [{ type: 'instance.listInsert', owner: t.owner, nodeId: features, prop: 'items', item: { title: 'Late openings' } }]);
    const card: ElementRef = { owner: t.owner, instancePath: [features], nodeId: def.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: [added.results[0].itemId as string] };
    const ctx: ChatContext = { pageId: t.home, pageTitle: 'Home', selection: card, selectionLabel: 'Card title', viewport: 1280 };
    const user = { id: 'u', role: 'user' as const, text: 'Continue', time: '', context: ctx };
    expect(continueContext(user, added.state, 1280)).toEqual({ ctx });
    expect(continueContext(user, t.s, 1280)).toEqual({ error: 'Card title is no longer in the site. Choose what to change, then send "Continue".' });
    expect(retryView(t.s, ctx, { pageId: t.home, definitionMode: null })).toMatchObject({ pageId: t.home, selection: null, missing: 'Card title' });
    // A selection saved damaged (no instance path) is no target: named as missing, never thrown on.
    const damaged = { ...ctx, selection: { owner: t.owner, nodeId: 'n_x' } as unknown as ElementRef, selectionLabel: 'Section' };
    expect(retryView(t.s, damaged, { pageId: t.home, definitionMode: null })).toMatchObject({ pageId: t.home, definitionMode: null, selection: null, missing: 'Section' });
  });
});

