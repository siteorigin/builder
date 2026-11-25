import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ElementRef, GraphNode, OwnerRef, ProjectState } from '@shared/types';
import { catalogueEntries } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { insertChoices, insertLanding, type InsertChoice } from '../../src/renderer/src/lib/command-inserts';
import { BASICS, projectInsertDefinitions } from '../../src/renderer/src/lib/insert-search';
import { commandText, matchesWords } from '../../src/renderer/src/lib/page-switch';

/**
 * The command menu inserts what the Insert panel does (#174): the project's own components, the basic elements and the
 * theme's sections, found by the same words, each saying where it would land.
 */

/** A page with an Intro section, a closing Section made into a project component called Heading (the basic element's
 *  name, so the two are told apart only by what they are and where they go), and an empty Outro section last. */
function site() {
  let state: ProjectState = createStarterState('blank', 'Expo', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [intro, closing, outro] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ]).map((r) => r.nodeId as string);
  step([
    { type: 'node.rename', owner, nodeId: intro, name: 'Intro' },
    { type: 'node.rename', owner, nodeId: outro, name: 'Outro' },
    { type: 'node.insert', owner, parentId: closing, slot: 'content', primitive: 'heading', text: 'See you there' }
  ]);
  const [made] = step([{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Heading' }]);
  const headingDef = made.definitionId as string;
  state.components[headingDef].description = 'Closing band';
  return { state, owner, intro, outro, headingDef, step: (ops: EditOperation[]) => (step(ops), state) };
}

/** What the menu finds for a search: every word in the row's label or its other words (see CommandMenu's `searched`). */
const found = (choices: InsertChoice[], q: string) => choices.filter((c) => matchesWords(q, `${commandText(`Insert ${c.name}`)} ${c.keywords}`));
const projectIds = (choices: InsertChoice[]) => choices.filter((c) => c.id.startsWith('ins:c:')).map((c) => c.id);

/** Another component of the project's own, copied from `from` with `patch` (a code component, a header of its own). */
function withCopy(state: ProjectState, from: string, patch: Partial<ComponentDefinition> & { id: string }): ProjectState {
  const copy = { ...structuredClone(state.components[from]), ...patch } as ComponentDefinition;
  return { ...state, components: { ...state.components, [copy.id]: copy } };
}

/** Every node a definition's design holds. */
const designNodes = (def: ComponentDefinition): GraphNode[] => Object.values(def.tree?.nodes ?? {});

describe('what the command menu inserts', () => {
  it('finds a project component and the basic element of the same name, told apart by what they are', () => {
    const { state, headingDef } = site();
    const choices = insertChoices(state, false);
    expect(found(choices, 'Insert Heading').map((c) => [c.id, c.kind, c.spec])).toEqual([
      [`ins:c:${headingDef}`, 'Component', { definitionId: headingDef }],
      ['ins:e:heading', 'Element', { primitive: 'heading' }]
    ]);
    // A component is found by its description, as in Insert.
    expect(found(choices, 'closing band').map((c) => c.id)).toEqual([`ins:c:${headingDef}`]);
  });

  it('finds the basic elements and column layouts by the words Insert finds them by', () => {
    const choices = insertChoices(site().state, false);
    // Even columns first, then the uneven two-column starters (#665).
    expect(found(choices, 'two columns').map((c) => [c.id, c.kind, c.spec])).toEqual([
      ['ins:e:columns-2', 'Layout', { primitive: 'grid', columns: 2 }],
      ['ins:e:sidebar', 'Layout', { primitive: 'grid', starter: 'sidebar' }],
      ['ins:e:split', 'Layout', { primitive: 'grid', starter: 'split' }]
    ]);
    expect(found(choices, 'bento').map((c) => [c.id, c.kind, c.spec])).toEqual([['ins:e:bento', 'Layout', { primitive: 'grid', starter: 'bento' }]]);
    expect(found(choices, 'bullet points').map((c) => c.spec)).toEqual([{ primitive: 'richtext', text: '- First item\n- Second item\n- Third item' }]);
    for (const name of ['Heading', 'Paragraph', 'Button', 'Image', 'Grid', 'Stack', 'Container']) expect(found(choices, name).some((c) => c.id.startsWith('ins:e:') && c.name === name)).toBe(true);
  });

  it('lists the project’s components by name first, then the basic elements, then the theme’s sections in catalogue order', () => {
    const { state, headingDef } = site();
    const more = withCopy(withCopy(state, headingDef, { id: 'proj.card10', name: 'Card 10' }), headingDef, { id: 'proj.card2', name: 'Card 2' });
    const sections = catalogueEntries(state.site.themeId).map((e) => `ins:${e.componentId}`);
    expect(sections.length).toBeGreaterThan(0);
    expect(insertChoices(more, false).map((c) => c.id)).toEqual(['ins:c:proj.card2', 'ins:c:proj.card10', `ins:c:${headingDef}`, ...BASICS.map((b) => `ins:e:${b.id}`), ...sections]);
  });

  it('offers code components only in Developer mode, and never a header or footer or a theme’s own components', () => {
    const { state, headingDef } = site();
    const mine = withCopy(withCopy(state, headingDef, { id: 'proj.ticker', name: 'Ticker', kind: 'code', description: 'Marquee of headlines' } as Partial<ComponentDefinition> & { id: string }), headingDef, {
      id: 'proj.footer',
      name: 'Footer copy',
      category: 'shell'
    });
    expect(mine.components['proj.footer']).toMatchObject({ owner: 'project', category: 'shell' });
    expect(Object.values(mine.components).some((d) => d.owner === 'theme')).toBe(true);
    expect(projectIds(insertChoices(mine, false))).toEqual([`ins:c:${headingDef}`]);
    expect(projectIds(insertChoices(mine, true))).toEqual([`ins:c:${headingDef}`, 'ins:c:proj.ticker']);
    expect(found(insertChoices(mine, true), 'marquee')).toEqual([expect.objectContaining({ id: 'ins:c:proj.ticker', kind: 'Code component', spec: { definitionId: 'proj.ticker' } })]);
    // The Insert panel, a + on the canvas and the menu share the one list.
    expect(projectInsertDefinitions(mine, true).map((d) => d.id)).toEqual([headingDef, 'proj.ticker']);
  });
});

describe('where an insert from the command menu lands', () => {
  it('says the place each one goes, which can differ between two of the same name', () => {
    const { state, owner, intro, headingDef } = site();
    const selected: ElementRef = { owner, instancePath: [], nodeId: intro };
    // The basic Heading goes inside the selected Section; the Heading component, made from a whole section, after it.
    expect(insertLanding(state, owner, selected, { primitive: 'heading' })).toEqual({ where: 'inside Intro' });
    expect(insertLanding(state, owner, selected, { definitionId: headingDef })).toEqual({ where: 'after Intro' });
    expect(insertLanding(state, owner, selected, { componentId: 'layout.section' })).toEqual({ where: 'after Intro' });
    // Nothing selected: an element goes into the last section that takes content, a section at the end of the page.
    expect(insertLanding(state, owner, null, { primitive: 'heading' })).toEqual({ where: 'inside Outro' });
    expect(insertLanding(state, owner, null, { componentId: 'layout.section' })).toEqual({ where: 'at the end of Home' });
  });

  it('refuses a component inside itself, or inside one that holds it however deep, while it is edited everywhere', () => {
    const { state, owner, headingDef, step } = site();
    const editing: OwnerRef = { kind: 'component', id: headingDef };
    expect(insertLanding(state, editing, null, { definitionId: headingDef })).toEqual({ refused: 'Would contain itself' });
    // A Wrapper holding a Heading, and an Outer holding only the Wrapper.
    const wrap = (inner: string, name: string) => {
      let now = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
      const node = now.pages[owner.id].rootIds.at(-1)!;
      step([{ type: 'node.insert', owner, parentId: node, slot: 'content', definitionId: inner }]);
      now = step([{ type: 'component.createFromNode', owner, nodeId: node, name }]);
      return Object.values(now.components).find((d) => d.name === name)!;
    };
    const wrapper = wrap(headingDef, 'Wrapper');
    const outer = wrap(wrapper.id, 'Outer');
    const now = step([]);
    expect(designNodes(wrapper).some((n) => n.kind === 'instance' && n.definitionId === headingDef)).toBe(true);
    expect(designNodes(outer).some((n) => n.kind === 'instance' && n.definitionId === headingDef)).toBe(false);
    expect(insertLanding(now, editing, null, { definitionId: wrapper.id })).toEqual({ refused: 'Would contain itself' });
    expect(insertLanding(now, editing, null, { definitionId: outer.id })).toEqual({ refused: 'Would contain itself' });
    expect(insertLanding(now, editing, null, { primitive: 'paragraph' })).toHaveProperty('where');
    // The other way round is fine: a Heading inside the Wrapper.
    expect(insertLanding(now, { kind: 'component', id: wrapper.id }, null, { definitionId: headingDef })).toHaveProperty('where');
  });

  it('has nowhere to put anything when nothing is being edited, or inside a component that holds only text', () => {
    const { state, owner, intro, headingDef, step } = site();
    for (const spec of [{ primitive: 'heading' as const }, { definitionId: headingDef }, { componentId: 'layout.section' }]) expect(insertLanding(state, null, null, spec)).toEqual({ refused: 'Nowhere to insert' });
    // A Lede made from one paragraph: its root holds no children.
    step([{ type: 'node.insert', owner, parentId: intro, slot: 'content', primitive: 'paragraph', text: 'Hall A' }]);
    const para = step([]).pages[owner.id].nodes[intro];
    const paraId = para.kind === 'instance' ? para.slots?.content?.at(-1) : undefined;
    expect(paraId).toBeTruthy();
    const now = step([{ type: 'component.createFromNode', owner, nodeId: paraId!, name: 'Lede' }]);
    const lede = Object.values(now.components).find((d) => d.name === 'Lede')!;
    expect(lede.tree?.nodes[lede.tree.rootIds[0]]).toMatchObject({ kind: 'text', tag: 'p' });
    const ledeOwner: OwnerRef = { kind: 'component', id: lede.id };
    expect(insertLanding(now, ledeOwner, null, { primitive: 'heading' })).toEqual({ refused: 'Nowhere to insert' });
    expect(insertLanding(now, ledeOwner, { owner: ledeOwner, instancePath: [], nodeId: lede.tree!.rootIds[0] }, { primitive: 'heading' })).toEqual({ refused: 'Nowhere to insert' });
  });
});
