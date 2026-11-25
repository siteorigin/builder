// The Inspector's state switcher (issue #350): what a hover, focus or pressed state shows through when this element
// sets nothing for it, which states hold changes, the state going back to the resting style when the selection
// moves on, and the class the editor's preview gives a code component's parts so the canvas can show one in a state.
import { describe, expect, it, vi } from 'vitest';
import type { ComponentDefinition, ElementRef, InstanceNode, ProjectState, ResponsiveStyles } from '@shared/types';
import type { StyleLayer } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { generateProject, overrideClass, pageFile } from '@generator/index';
import { designLayers, selectedVariants } from '@shared/variants';
import { stateChangeCount, statesWithChanges, stateUnder, type StateSourceInput } from '../../src/renderer/src/lib/style-source';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => {} }, ai: { stop: async () => {} }, platform: 'darwin' } });

const under = (input: Partial<StateSourceInput> & Pick<StateSourceInput, 'styles'>) =>
  stateUnder({ prop: 'background', scope: 'base', state: 'hover', preview: 'desktop', inherited: undefined, ...input });

describe('what a state shows through', () => {
  it('is this element’s own value for the state at every size, when one size is edited', () => {
    const styles: ResponsiveStyles = { base: { background: 'white' }, 'base:hover': { background: 'red' } };
    expect(under({ styles, scope: 'phone' })).toEqual({ value: 'red', from: 'all-sizes' });
    // Within one rule block, a state beats every resting value, a size's own included, as the stylesheet orders them.
    expect(under({ styles: { ...styles, phone: { background: 'blue' } }, scope: 'phone' })).toEqual({ value: 'red', from: 'all-sizes' });
  });

  it('is the resting style when the state sets nothing, the size’s own resting value first', () => {
    expect(under({ styles: { base: { background: 'white' }, phone: { background: 'blue' } }, scope: 'phone' })).toEqual({ value: 'blue', from: 'default' });
    expect(under({ styles: { base: { background: 'white' } } })).toEqual({ value: 'white', from: 'default' });
    // Under All sizes it is named for the size the canvas shows.
    expect(under({ styles: { base: { background: 'white' }, phone: { background: 'blue' } }, preview: 'phone' })).toEqual({ value: 'blue', from: 'default' });
  });

  it('leaves the element’s own single-size values for the state out under All sizes: they are its exceptions', () => {
    expect(under({ styles: { base: { background: 'white' }, 'phone:hover': { background: 'green' } }, preview: 'phone' })).toEqual({ value: 'white', from: 'default' });
  });

  it('takes the design’s and the chosen look’s own state values, which a stronger resting value still beats', () => {
    const design: StyleLayer[] = [
      { styles: { base: { background: 'white' }, 'base:hover': { background: 'grey' } }, strength: 1 },
      { styles: { base: { background: 'black' } }, strength: 2 }
    ];
    // The look's resting value is in a stronger rule than the design's own hover.
    expect(under({ styles: undefined, layers: design })).toEqual({ value: 'black', from: 'design' });
    // The look's own hover beats them both.
    const look: StyleLayer[] = [design[0], { styles: { base: { background: 'black' }, 'base:hover': { background: 'navy' } }, strength: 2 }];
    expect(under({ styles: undefined, layers: look })).toEqual({ value: 'navy', from: 'design' });
    // The placement's own resting value beats any state of its design.
    expect(under({ styles: { base: { background: 'pink' } }, layers: look })).toEqual({ value: 'pink', from: 'default' });
  });

  it('finds a look’s hover through the design layers of a real placement', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const page = s.pages[s.site.homePageId];
    const grid = page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
    const def = structuredClone(s.components[grid.definitionId]);
    const card = def.parts.card.nodeId;
    // The look in use on the tone axis gets a hover background for the card.
    const tone = def.variantAxes!.tone;
    const chosen = selectedVariants(def, grid.variants).tone;
    const option = tone.options[typeof chosen === 'string' ? chosen : tone.default];
    option.styles = { ...option.styles, [card]: { ...option.styles?.[card], 'base:hover': { background: '#123456' } } };
    expect(under({ styles: grid.overrides?.card, layers: designLayers(def, card, grid.variants) })).toEqual({ value: '#123456', from: 'design' });
  });

  it('brings the original design’s state value back when a design is edited everywhere', () => {
    const original: ResponsiveStyles = { base: { background: 'white' }, 'base:hover': { background: 'grey' } };
    expect(under({ styles: { 'base:hover': { background: 'red' } }, inherited: original, designSizesWin: true })).toEqual({ value: 'grey', from: 'design' });
    // A change of the resting style replaces the original's there, and shows through the state when it sets nothing.
    expect(under({ styles: { base: { background: 'pink' } }, inherited: { base: { background: 'white' } }, designSizesWin: true })).toEqual({ value: 'pink', from: 'default' });
  });

  it('never takes a property a state cannot hold from a state rule', () => {
    expect(under({ prop: 'paddingBlock', styles: { base: { paddingBlock: '8px' }, 'base:hover': { paddingBlock: '20px' } } })).toEqual({ value: '8px', from: 'default' });
  });
});

describe('which states hold changes', () => {
  it('counts each state at every size, and lists them in the stylesheet’s order', () => {
    const styles: ResponsiveStyles = { base: { background: 'white' }, 'base:active': { opacity: 0.8 }, 'base:hover': { background: 'red', color: 'black' }, 'phone:hover': { background: 'blue' }, 'tablet:focus': {} };
    expect(stateChangeCount(styles, 'hover')).toBe(3);
    expect(stateChangeCount(styles, 'focus')).toBe(0);
    expect(statesWithChanges(styles)).toEqual(['hover', 'active']);
    expect(statesWithChanges({ base: { background: 'white' } })).toEqual([]);
  });
});

// The editor's store is DOM code, outside this test project's types: loaded by a path the type checker does not follow.
interface EditorState {
  pageId: string | null;
  selection: ElementRef | null;
  styleState: 'hover' | 'focus' | 'active' | null;
  styleStatePart: string | null;
  definitionMode: { definitionId: string; returnPageId: string } | null;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { getState, setState } = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };
const ref = (nodeId: string, itemPath?: string[]): ElementRef => ({ owner: { kind: 'page', id: 'pg_home' }, instancePath: [], nodeId, ...(itemPath ? { itemPath } : {}) });

describe('the state being edited', () => {
  it('goes back to the resting style when another element, item, page or component is shown', () => {
    setState({ pageId: 'pg_home', selection: ref('a'), definitionMode: null });
    setState({ styleState: 'hover', styleStatePart: 'title' });
    // The same element selected again keeps it.
    setState({ selection: ref('a') });
    expect(getState().styleState).toBe('hover');
    setState({ selection: ref('b') });
    expect(getState()).toMatchObject({ styleState: null, styleStatePart: null });

    setState({ selection: ref('b', ['i1']) });
    setState({ styleState: 'focus' });
    setState({ selection: ref('b', ['i2']) });
    expect(getState().styleState).toBeNull();

    setState({ styleState: 'active' });
    setState({ pageId: 'pg_about' });
    expect(getState().styleState).toBeNull();

    setState({ styleState: 'hover' });
    setState({ definitionMode: { definitionId: 'cmp_x', returnPageId: 'pg_about' } });
    expect(getState().styleState).toBeNull();
  });
});

/** A code component with a Title part, which places the classes it is given. */
const CODE = `<script>
	let { title = 'Title', so_o = undefined, class: className = '' } = $props();
</script>

<div class={['fancy', className]}>
	<h3 class={['title', so_o?.title]}>{title}</h3>
</div>
`;

function codePlacement(): { s: ProjectState; def: ComponentDefinition; node: InstanceNode } {
  const s = createStarterState('business', 'Test Studio', false);
  const r = applyOperations(s, [{ type: 'component.createCode', name: 'Fancy', source: CODE, properties: { title: { type: 'string', label: 'Title', default: 'Title' } } }]);
  const def = r.state.components[r.results[0].definitionId as string];
  def.parts.title = { nodeId: 'title', label: 'Title', styleControls: ['color', 'textStyle'] };
  const node = makeInstance(def, {});
  const page = r.state.pages[r.state.site.homePageId];
  page.nodes[node.id] = node;
  page.rootIds.push(node.id);
  return { s: r.state, def, node };
}

describe('a code component’s parts in the editor’s preview', () => {
  it('carry their class before any change of their own, so the canvas can show one in a state; the site does not', () => {
    const { s, node } = codePlacement();
    const file = pageFile(s.pages[s.site.homePageId]);
    const dev = generateProject(s, { instrument: true }).get(file)!;
    const clean = generateProject(s, { instrument: false }).get(file)!;
    expect(dev).toContain(overrideClass(node.id, 'title'));
    expect(clean).not.toContain(overrideClass(node.id, 'title'));
  });

  it('keep the class with a change of their own, in the editor and the site alike', () => {
    const { s, node } = codePlacement();
    node.overrides = { title: { 'base:hover': { color: '#00aa00' } } };
    const file = pageFile(s.pages[s.site.homePageId]);
    for (const instrument of [true, false]) expect(generateProject(s, { instrument }).get(file)!.match(new RegExp(overrideClass(node.id, 'title'), 'g'))).toHaveLength(1);
  });
});
