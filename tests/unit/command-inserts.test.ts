import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { catalogueEntries } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { insertChoices, insertLanding, type InsertChoice } from '../../src/renderer/src/lib/command-inserts';
import { projectInsertDefinitions } from '../../src/renderer/src/lib/insert-search';
import { commandText, matchesWords } from '../../src/renderer/src/lib/page-switch';

/**
 * The command menu inserts what the Insert panel does (#174): the project's own components, the basic elements and the
 * theme's sections, found by the same words, each saying where it would land.
 */

/** A page with an Intro section, and a closing Section made into a project component called Heading, the same name as
 *  the basic element, so the two can only be told apart by what they are and where they go. */
function site() {
  let state: ProjectState = createStarterState('blank', 'Expo', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [intro, closing] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ]).map((r) => r.nodeId as string);
  step([{ type: 'node.insert', owner, parentId: closing, slot: 'content', primitive: 'heading', text: 'See you there' }]);
  const [made] = step([{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Heading' }]);
  return { state, owner, intro, headingDef: made.definitionId as string, step: (ops: EditOperation[]) => (step(ops), state) };
}

/** What the menu finds for a search: every word in the row's label or its other words (see CommandMenu's `searched`). */
const found = (choices: InsertChoice[], q: string) => choices.filter((c) => matchesWords(q, `${commandText(`Insert ${c.name}`)} ${c.keywords}`));

/** A code component of the project's own, as Developer mode makes them. */
function withCode(state: ProjectState, from: string): ProjectState {
  const code = { ...structuredClone(state.components[from]), id: 'proj.ticker', name: 'Ticker', kind: 'code', description: 'Marquee of headlines' } as ComponentDefinition;
  return { ...state, components: { ...state.components, [code.id]: code } };
}

describe('what the command menu inserts', () => {
  it('finds a project component and the basic element of the same name, told apart by what they are', () => {
    const { state, headingDef } = site();
    const both = found(insertChoices(state, false), 'Insert Heading');
    expect(both.map((c) => [c.id, c.kind, c.spec])).toEqual([
      [`ins:c:${headingDef}`, 'Component', { definitionId: headingDef }],
      ['ins:e:heading', 'Element', { primitive: 'heading' }]
    ]);
  });

  it('finds the basic elements and column layouts by the words Insert finds them by', () => {
    const choices = insertChoices(site().state, false);
    expect(found(choices, 'two columns')[0]).toMatchObject({ id: 'ins:e:columns-2', kind: 'Layout', spec: { primitive: 'grid', columns: 2 } });
    expect(found(choices, 'bullet points').map((c) => c.name)).toEqual(['Bulleted list']);
    for (const name of ['Heading', 'Paragraph', 'Button', 'Image', 'Grid', 'Stack', 'Container']) expect(found(choices, name).some((c) => c.id.startsWith('ins:e:') && c.name === name)).toBe(true);
  });

  it('lists the project’s components first, then the basic elements, then the theme’s sections in catalogue order', () => {
    const { state, headingDef } = site();
    const ids = insertChoices(state, false).map((c) => c.id);
    const sections = catalogueEntries(state.site.themeId).map((e) => `ins:${e.componentId}`);
    expect(sections.length).toBeGreaterThan(0);
    expect(ids[0]).toBe(`ins:c:${headingDef}`);
    expect(ids.slice(1, 1 + ids.filter((id) => id.startsWith('ins:e:')).length).every((id) => id.startsWith('ins:e:'))).toBe(true);
    expect(ids.slice(ids.length - sections.length)).toEqual(sections);
  });

  it('offers code components only in Developer mode, and never the shared header or footer or a theme’s own components', () => {
    const { state, headingDef } = site();
    const coded = withCode(state, headingDef);
    const shell = Object.values(coded.components).filter((d) => d.category === 'shell');
    expect(shell.length).toBeGreaterThan(0);
    const ids = (dev: boolean) => insertChoices(coded, dev).filter((c) => c.id.startsWith('ins:c:')).map((c) => c.id);
    expect(ids(false)).toEqual([`ins:c:${headingDef}`]);
    expect(ids(true)).toEqual([`ins:c:${headingDef}`, 'ins:c:proj.ticker']);
    expect(found(insertChoices(coded, true), 'marquee')).toEqual([expect.objectContaining({ id: 'ins:c:proj.ticker', kind: 'Code component', spec: { definitionId: 'proj.ticker' } })]);
    // The Insert panel, a + on the canvas and the menu share the one list.
    expect(projectInsertDefinitions(coded, true).map((d) => d.id)).toEqual([headingDef, 'proj.ticker']);
    expect(projectInsertDefinitions(coded, true).some((d) => d.owner !== 'project' || d.category === 'shell')).toBe(false);
  });
});

describe('where an insert from the command menu lands', () => {
  it('says the place each one goes, which can differ between two of the same name', () => {
    const { state, owner, intro, headingDef } = site();
    const selected: ElementRef = { owner, instancePath: [], nodeId: intro };
    // The basic Heading goes inside the selected Section; the Heading component, made from a whole section, after it.
    expect(insertLanding(state, owner, selected, { primitive: 'heading' })).toEqual({ where: 'inside Section' });
    expect(insertLanding(state, owner, selected, { definitionId: headingDef })).toEqual({ where: 'after Section' });
    expect(insertLanding(state, owner, selected, { componentId: 'layout.section' })).toEqual({ where: 'after Section' });
    // Nothing selected: a section goes at the end of the page.
    expect(insertLanding(state, owner, null, { componentId: 'layout.section' })).toEqual({ where: 'at the end of Home' });
  });

  it('refuses a component inside itself, or inside one it holds, while it is edited everywhere', () => {
    const { state, owner, headingDef, step } = site();
    expect(insertLanding(state, { kind: 'component', id: headingDef }, null, { definitionId: headingDef })).toEqual({ refused: 'Would contain itself' });
    // A Wrapper holding a Heading cannot go into the Heading either; a basic element still can.
    let now = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
    const wrapperNode = now.pages[owner.id].rootIds.at(-1)!;
    now = step([{ type: 'node.insert', owner, parentId: wrapperNode, slot: 'content', definitionId: headingDef }]);
    now = step([{ type: 'component.createFromNode', owner, nodeId: wrapperNode, name: 'Wrapper' }]);
    const wrapper = Object.values(now.components).find((d) => d.name === 'Wrapper')!;
    expect(insertLanding(now, { kind: 'component', id: headingDef }, null, { definitionId: wrapper.id })).toEqual({ refused: 'Would contain itself' });
    expect(insertLanding(now, { kind: 'component', id: headingDef }, null, { primitive: 'paragraph' })).toHaveProperty('where');
    // The other way round is fine: a Heading inside the Wrapper.
    expect(insertLanding(now, { kind: 'component', id: wrapper.id }, null, { definitionId: headingDef })).toHaveProperty('where');
  });

  it('has nowhere to put anything when nothing is being edited', () => {
    expect(insertLanding(site().state, null, null, { primitive: 'heading' })).toEqual({ refused: 'Nowhere to insert' });
  });
});
