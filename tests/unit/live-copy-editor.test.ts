/**
 * A live session's Copy Editor changes the words and pictures on the site's pages and nothing else (#1148): the host's
 * check against each operation and against the project as the batch would leave it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ImageValue, InstanceNode, OwnerRef, ProjectState, TextNode } from '@shared/types';
import { copyEditorOperationProblem } from '@shared/live/copy-editor';
import { catalogueComponent, listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { copyEditableLookup, copyEditorBatchProblem } from '@engine/copy-editor';
import { normalizePropSchema } from '@engine/schema';
import { toRichText } from '@shared/richtext';

const HERO = 'foundation.hero.split';
const FORM = 'foundation.contact.form';

const asset = (id: string, kind: AssetRecord['kind']): AssetRecord => ({ id, name: id, file: `${id}.bin`, mime: kind === 'image' ? 'image/png' : 'font/woff2', bytes: 1, hash: id, kind });

/**
 * A blank site whose home page has a split hero, a section holding a paragraph and rich text, and "Promo": a design
 * around a split hero that passes its own properties on to the hero's, placed once. The library has two pictures and
 * a font.
 */
function project() {
  let state = createStarterState('blank', 'Copy', false);
  state = { ...state, assets: { ...state.assets, assets: { ...state.assets.assets, pic1: asset('pic1', 'image'), pic2: asset('pic2', 'image'), font1: asset('font1', 'font') } } };
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const r = applyOperations(state, ops);
    state = r.state;
    return r.results;
  };
  const hero = step([{ type: 'node.insert', owner, parentId: null, componentId: 'hero.split', props: { image: { assetId: 'pic1', alt: 'The studio' } } }])[0].nodeId as string;
  const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  const paragraph = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Opening hours vary.' }])[0].nodeId as string;
  const rich = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'richtext' }])[0].nodeId as string;
  step([{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Call us or [read the FAQ](https://example.com/faq).' }]);

  // Promo: a section around a split hero, whose `title` (marked copy) becomes the hero's heading, `tagline` (marked
  // copy) its unmarked primary button label, and `note` (unmarked) its lead.
  const wrap = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  step([{ type: 'node.insert', owner, parentId: wrap, slot: 'content', componentId: 'hero.split' }]);
  const promo = step([{ type: 'component.createFromNode', owner, nodeId: wrap, name: 'Promo' }])[0].definitionId as string;
  const inner = Object.values(state.components[promo].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === HERO)!.id;
  const def: OwnerRef = { kind: 'component', id: promo };
  step([
    { type: 'component.setPropSchema', definitionId: promo, prop: 'title', schema: { type: 'string', label: 'Title', default: '', copyEditable: true } },
    { type: 'component.setPropSchema', definitionId: promo, prop: 'tagline', schema: { type: 'string', label: 'Tagline', default: '', copyEditable: true } },
    { type: 'component.setPropSchema', definitionId: promo, prop: 'note', schema: { type: 'string', label: 'Note', default: '', multiline: true } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'heading', binding: { $prop: 'title' } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'primaryLabel', binding: { $prop: 'tagline' } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'lead', binding: { $prop: 'note' } }
  ]);
  const placed = step([{ type: 'node.insert', owner, parentId: null, definitionId: promo, props: { title: 'Spring offer', tagline: 'Book now', note: 'While it lasts.' } }])[0].nodeId as string;
  // The page as the copy editor finds it: the empty section the design was made from is gone.
  step([{ type: 'node.remove', owner, nodeId: wrap }].filter(() => Object.hasOwn(state.pages[owner.id].nodes, wrap)) as EditOperation[]);
  return { state, owner, hero, paragraph, rich, promo, placed };
}

/** Why a copy editor's batch is refused, applied to the project as it is; null when it is allowed. */
function copyEdit(state: ProjectState, ops: EditOperation[]) {
  const r = applyOperations(state, ops);
  return { problem: copyEditorBatchProblem(state, r.state, ops), after: r.state };
}

const node = <T>(state: ProjectState, owner: OwnerRef, id: string) => state.pages[owner.id].nodes[id] as T;

describe('what a copy editor may change', () => {
  it('rewords a page’s text and rich text, and a hero’s marked copy, and replaces its picture from the library', () => {
    const { state, owner, hero, paragraph, rich } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Phone us, or [see the questions](https://example.com/faq).' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms that feel like home' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: 'pic2', alt: 'The workshop' } }
    ];
    const { problem, after } = copyEdit(state, ops);
    expect(problem).toBeNull();
    expect(node<TextNode>(after, owner, paragraph).text).toBe('Open every day.');
    expect(node<InstanceNode>(after, owner, hero).props.heading).toBe('Rooms that feel like home');
    expect((node<InstanceNode>(after, owner, hero).props.image as ImageValue).assetId).toBe('pic2');
  });

  it('follows a design that passes its marked copy on to a hero’s marked heading', () => {
    const { state, owner, promo, placed } = project();
    const editable = copyEditableLookup(state);
    expect(editable(promo, 'title')).toBe(true);
    // Marked, but passed on to a button label the hero does not mark.
    expect(editable(promo, 'tagline')).toBe(false);
    // Passed on to the hero's marked lead, but not marked itself.
    expect(editable(promo, 'note')).toBe(false);
    const { problem, after } = copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'title', value: 'Summer offer' }]);
    expect(problem).toBeNull();
    // The design, and so every other placement of it, is untouched.
    expect(after.components[promo]).toBe(state.components[promo]);
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'tagline', value: 'Book today' }]).problem).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/Only the host can change “Tagline”/) });
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'note', value: 'Soon over.' }]).problem).toMatchObject({ operationIndex: 0 });
  });

  it('does not count a marked property the design uses for anything but showing it', () => {
    const { state, promo } = project();
    const def: OwnerRef = { kind: 'component', id: promo };
    const inner = Object.values(state.components[promo].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === HERO)!;
    const root = state.components[promo].tree!.rootIds[0];
    const variant = (ops: EditOperation[]) => {
      const r = applyOperations(state, ops);
      return copyEditableLookup(r.state)(promo, 'title');
    };
    // Compared with a value: two different headings can show different layouts.
    expect(variant([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'when', binding: { $prop: 'title' }, ne: 'Hidden' }])).toBe(false);
    // Only tested for being set: a copy editor's edit never changes that.
    expect(variant([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'when', binding: { $prop: 'title' } }])).toBe(true);
    // Shown twice, as the hero's heading and as its eyebrow, both marked: still only copy.
    expect(variant([{ type: 'node.setBinding', owner: def, nodeId: inner.id, field: 'prop', prop: 'eyebrow', binding: { $prop: 'title' } }])).toBe(true);
    expect(variant([{ type: 'component.setPropSchema', definitionId: promo, prop: 'title', schema: { type: 'string', label: 'Title', default: '' } }])).toBe(false);
  });

  it('never counts a property that decides where a contact form sends', () => {
    let state = createStarterState('blank', 'Forms', false);
    const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const step = (ops: EditOperation[]) => {
      const r = applyOperations(state, ops);
      state = r.state;
      return r.results;
    };
    const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
    step([{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/a' } }]);
    const band = step([{ type: 'component.createFromNode', owner, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
    const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
    step([
      { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '', copyEditable: true } },
      { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
    ]);
    const placed = step([{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: 'https://forms.example.com/a' } }])[0].nodeId as string;
    expect(copyEditableLookup(state)(band, 'recipient')).toBe(false);
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'recipient', value: 'https://evil.example/b' }]).problem).toMatchObject({ operationIndex: 0 });
  });

  it('marks the split hero’s copy and picture in every theme', () => {
    for (const theme of listThemes()) {
      const def = catalogueComponent(theme.id, 'hero.split');
      if (!def) continue;
      const state = { ...createStarterState('blank', 'x', false), components: { [def.id]: def } };
      const editable = copyEditableLookup(state);
      for (const prop of ['eyebrow', 'heading', 'lead', 'image']) expect(editable(def.id, prop), `${theme.id} ${prop}`).toBe(true);
      for (const prop of ['headingLevel', 'primaryLabel', 'primaryLink']) expect(editable(def.id, prop), `${theme.id} ${prop}`).toBe(false);
    }
  });
});

describe('what a copy editor may not change', () => {
  it('refuses the whole batch for one operation, naming it', () => {
    const { state, owner, hero, paragraph } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'headingLevel', value: 'h2' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms that feel like home' }
    ];
    expect(copyEdit(state, ops).problem).toMatchObject({ operationIndex: 1 });
    // A structural edit among copy edits, refused by the operation alone.
    expect(copyEdit(state, [ops[0], { type: 'instance.setVariant', owner, nodeId: hero, axis: 'tone', variant: 'muted' }, ops[2]]).problem).toMatchObject({ operationIndex: 1, message: expect.stringMatching(/cannot make "instance.setVariant"/) });
  });

  it('refuses a change to a protected value even when a later operation puts it back', () => {
    const { state, owner, hero, paragraph } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: 'Elsewhere' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: (node<InstanceNode>(state, owner, hero).props.primaryLabel as string | undefined) ?? 'Start a project' }
    ];
    expect(copyEdit(state, ops).problem).toMatchObject({ operationIndex: 1 });
  });

  it('refuses a project that changed beyond what the operations were allowed, whatever they say', () => {
    const { state, owner, hero, paragraph } = project();
    const op: EditOperation = { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' };
    const { after } = copyEdit(state, [op]);
    const page = after.pages[owner.id];
    const heroNode = page.nodes[hero] as InstanceNode;
    const tampered: ProjectState[] = [
      // Another element's otherwise editable copy.
      { ...after, pages: { ...after.pages, [owner.id]: { ...page, nodes: { ...page.nodes, [hero]: { ...heroNode, props: { ...heroNode.props, heading: 'Not asked for' } } } } } },
      // The order of the page's sections.
      { ...after, pages: { ...after.pages, [owner.id]: { ...page, rootIds: [...page.rootIds].reverse() } } },
      // The page's own settings.
      { ...after, pages: { ...after.pages, [owner.id]: { ...page, title: 'Renamed' } } },
      // The paragraph's tag, beside its words.
      { ...after, pages: { ...after.pages, [owner.id]: { ...page, nodes: { ...page.nodes, [paragraph]: { ...(page.nodes[paragraph] as TextNode), tag: 'h2' } } } } },
      // The shared header and footer, the site's styles, a design, the library.
      { ...after, site: { ...after.site, name: 'Renamed' } },
      { ...after, tokens: { ...after.tokens } as never, components: { ...after.components, [HERO]: { ...after.components[HERO], name: 'Mine' } } },
      { ...after, assets: { ...after.assets, assets: {} } }
    ];
    expect(copyEditorBatchProblem(state, after, [op])).toBeNull();
    for (const t of tampered) expect(copyEditorBatchProblem(state, t, [op])).not.toBeNull();
  });

  it('keeps to the site’s pages, their written content, and what each element shows once', () => {
    const { state, owner, hero, paragraph } = project();
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    const shellNode = Object.keys(state.site.shell?.header?.nodes ?? {})[0] ?? 'x';
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner: header, nodeId: shellNode, field: 'text', value: 'Hi' })).toMatch(/pages/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner: { kind: 'component', id: HERO }, nodeId: 'heading', field: 'text', value: 'Hi' })).toMatch(/pages/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner, nodeId: paragraph, field: 'tag', value: 'h2' })).toMatch(/words/);
    expect(copyEditorOperationProblem({ type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: { $prop: 'x' } })).toMatch(/connection/);
    expect(copyEditorOperationProblem({ type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', itemId: 'a', field: 'b', value: 'x' })).toMatch(/list/);
    expect(copyEditorOperationProblem({ type: 'page.update', pageId: owner.id, title: 'New' })).toMatch(/cannot make "page.update"/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Fine' })).toBeNull();
  });

  it('replaces a picture only with a library picture, keeping it shown and as decorative as it was', () => {
    const { state, owner, hero } = project();
    const image = (value: unknown) => copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value }]).problem;
    expect(image({ assetId: 'pic2', alt: 'Workshop' })).toBeNull();
    // The engine refuses a font as a picture; the policy does too, whatever the engine lets through.
    const op: EditOperation = { type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: 'pic2', alt: 'Workshop' } };
    const after = copyEdit(state, [op]).after;
    const heroNode = after.pages[owner.id].nodes[hero] as InstanceNode;
    for (const assetId of ['font1', 'missing']) {
      const swapped = { ...heroNode, props: { ...heroNode.props, image: { assetId, alt: 'Workshop' } } };
      const tampered = { ...after, pages: { ...after.pages, [owner.id]: { ...after.pages[owner.id], nodes: { ...after.pages[owner.id].nodes, [hero]: swapped } } } };
      expect(copyEditorBatchProblem(state, tampered, [op])).not.toBeNull();
    }
    expect(image({ assetId: null, alt: '' })).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(image({ assetId: 'pic2', alt: 'Workshop', decorative: true })).toMatchObject({ message: expect.stringMatching(/decorative/) });
  });

  it('never adds or clears copy, which would show or hide an element', () => {
    const { state, owner, hero, paragraph } = project();
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'eyebrow', value: '   ' }]).problem).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(copyEdit(state, [{ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: '' }]).problem).not.toBeNull();
  });

  it('rewords a link in rich text but never adds, drops or retargets one', () => {
    const { state, owner, rich } = project();
    const set = (value: unknown) => copyEdit(state, [{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value }]).problem;
    expect(set('**Call** us or [read our FAQ](https://example.com/faq).')).toBeNull();
    expect(set('Call us or [read the FAQ](https://evil.example/faq).')).toMatchObject({ message: expect.stringMatching(/links/) });
    expect(set('Call us.')).toMatchObject({ message: expect.stringMatching(/links/) });
    expect(set(toRichText(['Call us, [FAQ](https://example.com/faq) or [mail](mailto:a@example.com).']))).toMatchObject({ message: expect.stringMatching(/links/) });
  });
});

describe('marking a property for the copy editor', () => {
  it('keeps the mark on a component’s own text, rich text and image properties, and refuses it anywhere else', () => {
    const state = createStarterState('blank', 'Marks', false);
    for (const type of ['string', 'richtext', 'image']) expect(normalizePropSchema({ type, label: 'X', copyEditable: true }, state, 'x')).toMatchObject({ copyEditable: true });
    expect(normalizePropSchema({ type: 'string', label: 'X', copyEditable: false }, state, 'x')).not.toHaveProperty('copyEditable');
    expect(() => normalizePropSchema({ type: 'enum', label: 'X', options: ['a'], copyEditable: true }, state, 'x')).toThrow(/only a component.s own text/);
    expect(() => normalizePropSchema({ type: 'string', label: 'X', copyEditable: 'yes' }, state, 'x')).toThrow(/true or false/);
    expect(() => normalizePropSchema({ type: 'list', label: 'X', itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', copyEditable: true } } }, state, 'x')).toThrow(/only a component.s own text/);
  });
});
