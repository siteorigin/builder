/**
 * Item state (#383): UI state that holds which item of one of a design's own lists is the active one. Buttons in a
 * repeat of that list select their own item, and content in any repeat of the same list shows only for the active
 * item, so one list drives both a column of step buttons and a stage of pictures. Validation keeps every read and
 * select inside a repeat of the list, every edit that would move one out is refused, and the generated site holds the
 * chosen item per placement, keeping every item's content in the page for print.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, LinkNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { itemStateProblems, stateValueFits } from '@engine/schema';
import { defFile, generateManagedComponent, generateProject, keptPanels } from '@generator/index';
import { renderedContent } from '@generator/checks';
import { UTIL_JS } from '@generator/runtime-files';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { FOUNDATION_PACK } from '@catalogue/builtin';
import { P, uiState, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { executeTool, type ToolHost } from '@agent/tools';
import { newMacroMemory } from '@agent/macros';
import { conditionSources, describeConditions } from '../../src/renderer/src/lib/conditions';
import { actionWords, addStateOp, clickChoices, itemStatePositions, newStateProblem } from '../../src/renderer/src/lib/ui-state';
import { studioSpec, studioStates } from '../../src/renderer/src/lib/studio';
import { previewSpec } from '../../src/main/runtime/component-preview';
import { ProjectSession } from '../../src/main/project/session';

const { managed } = FOUNDATION;
const NONE = { type: 'none' as const, target: '' };
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(def, props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

/**
 * Steps beside a stage, both repeating `steps` and starting at its second item: each step a button that selects it
 * and its body shown for it, and a picture shown for it on the stage. Beside them a repeat of another list (with a
 * button of its own), a Next button outside every repeat, and a button that does nothing yet.
 */
function stepsDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'test.steps',
    name: 'Steps',
    properties: {
      steps: P.list('Steps', 'Step', { title: P.str('Title', 'Step'), body: P.text('Body', ''), pic: P.str('Picture', '') }, [
        { title: 'One', body: 'First body', pic: 'Pic one' },
        { title: 'Two', body: 'Second body', pic: 'Pic two' },
        { title: 'Three', body: 'Third body', pic: 'Pic three' }
      ], { titleField: 'title' }),
      other: P.list('Other', 'Other', { title: P.str('Title', 'x'), pic: P.str('Picture', '') }, [{ title: 'Elsewhere', pic: '' }]),
      spare: P.list('Spare', 'Spare', { title: P.str('Title', 'x') }, []),
      caption: P.str('Caption', '')
    },
    parts: {},
    state: {
      active: { type: 'item', label: 'Active step', list: 'steps', initial: 1 },
      plan: { type: 'enum', label: 'Plan', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: 'a' }
    },
    build: (b) =>
      b.el('root', 'section', {}, [
        b.el('list', 'div', {}, [
          b.repeat('rows', 'steps', [
            b.el('row', 'div', {}, [
              b.link('pick', NONE, { $item: 'title' }, 'secondary', { stateAction: { state: 'active', op: 'select' } }),
              b.el('body', 'div', { when: uiState('active') }, [b.text('body-text', 'p', { $item: 'body' })])
            ])
          ])
        ]),
        b.el('stage', 'div', {}, [b.repeat('pics', 'steps', [b.el('pic', 'div', { when: uiState('active') }, [b.text('pic-text', 'p', { $item: 'pic' })])])]),
        b.el('others', 'div', {}, [b.repeat('other-rows', 'other', [b.el('other-row', 'div', {}, [b.text('other-text', 'p', { $item: 'title' }), b.link('other-pick', NONE, 'Pick', 'text')])])]),
        b.link('next', NONE, 'Next step', 'text', { stateAction: { state: 'active', op: 'next', wrap: true } }),
        b.link('loose', NONE, 'Loose', 'text')
      ])
  });
}

/** Whether applying `ops` throws, and its message. */
function refusal(s: ProjectState, ops: EditOperation[]): string {
  try {
    applyOperations(s, ops);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** The node a refusal names in its details, for the editor and the assistant to point at. */
function refusedAt(s: ProjectState, ops: EditOperation[]): unknown {
  try {
    applyOperations(s, ops);
    return null;
  } catch (e) {
    return (e as { details?: { nodeId?: unknown } }).details?.nodeId;
  }
}

async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'item-state-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(out, code.replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1').replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths)).replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation)));
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body;
}

describe('declaring item state', () => {
  it('loads clean when every read and select sits in a repeat of its list', () => {
    const s = fresh();
    place(s, stepsDef(s));
    expect(errors(s)).toEqual([]);
  });

  it('adds one through component.setState, the first item by default, and refuses what it cannot hold', () => {
    const s = fresh();
    const def = stepsDef(s);
    const set = (schema: Record<string, unknown>) => ({ type: 'component.setState', definitionId: def.id, state: 'focus', schema }) as EditOperation;
    expect(apply(s, [set({ type: 'item', label: 'Focus', list: 'other' })]).components[def.id].state!.focus).toEqual({ type: 'item', label: 'Focus', list: 'other', initial: 0 });
    expect(refusal(s, [set({ type: 'item', label: 'Focus', list: 'missing' })])).toMatch(/not a list property/);
    expect(refusal(s, [set({ type: 'item', label: 'Focus', list: 'caption' })])).toMatch(/"caption", which is not a list property/);
    expect(refusal(s, [set({ type: 'item', label: 'Focus' })])).toMatch(/needs the list property/);
    expect(refusal(s, [set({ type: 'item', label: 'Focus', list: 'steps', initial: -1 })])).toMatch(/position of an item/);
    expect(refusal(s, [set({ type: 'item', label: 'Focus', list: 'steps', initial: 1.5 })])).toMatch(/position of an item/);
    expect(refusal(s, [set({ type: 'item', label: 'Focus', list: 'steps', options: ['a', 'b'] })])).toMatch(/no options/);
    expect(refusal(s, [set({ type: 'enum', label: 'Focus', list: 'steps', options: ['a', 'b'] })])).toMatch(/names no list/);
    // The wire schema takes it as the editor and the assistant send it.
    expect(validateOperation(set({ type: 'item', label: 'Focus', list: 'steps', initial: 2 }))).toMatchObject({ ok: true });
    // A change that leaves out the starting position keeps it.
    const moved = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'active', schema: { type: 'item', label: 'Current step', list: 'steps' } }]);
    expect(moved.components[def.id].state!.active).toEqual({ type: 'item', label: 'Current step', list: 'steps', initial: 1 });
  });

  it('takes positions for its values, as Component Studio previews them', () => {
    const item = { type: 'item' as const, label: 'Step', list: 'steps', initial: 0 };
    expect([stateValueFits(item, 0), stateValueFits(item, 4), stateValueFits(item, -1), stateValueFits(item, 1.5), stateValueFits(item, '1'), stateValueFits(item, Number.MAX_SAFE_INTEGER + 1)]).toEqual([true, true, false, false, false, false]);
  });
});

describe('reading and selecting the active item', () => {
  it('reads it only plainly, in a condition, inside a repeat of its list alone', () => {
    const s = fresh();
    const def = stepsDef(s);
    const when = (nodeId: string, extra: Record<string, unknown> = {}) => ({ type: 'node.setBinding', owner: owner(def), nodeId, field: 'when', binding: { $state: 'active' }, ...extra }) as EditOperation;
    expect(refusal(s, [when('loose')])).toMatch(/not inside a repeat of "Steps"/);
    expect(refusal(s, [when('other-text')])).toMatch(/inside a repeat of "Other", not of "Steps"/);
    expect(refusal(s, [when('pic-text', { eq: true })])).toMatch(/read it plainly/);
    expect(refusal(s, [when('pic-text', { ne: false })])).toMatch(/read it plainly/);
    expect(refusal(s, [when('pic-text')])).toBe('');
    // A repeat with a category filter could hide the active item, and one inside another repeat is not one item each.
    const filtered = structuredClone(def);
    (filtered.tree!.nodes.rows as { filter?: unknown }).filter = { field: 'title' };
    // Each read and each select in the filtered repeat is its own problem, at its own node.
    expect([...itemStateProblems(filtered).values()].map((p) => [p.nodeId, /category filter, which could hide the active item/.test(p.message)])).toEqual([['body', true], ['pick', true]]);
    const nested = structuredClone(def);
    nested.tree!.nodes['other-row'] = { ...nested.tree!.nodes['other-row'], children: ['other-text', 'other-pick', 'list'] } as never;
    (nested.tree!.nodes.root as { children: string[] }).children = (nested.tree!.nodes.root as { children: string[] }).children.filter((c) => c !== 'list');
    expect([...itemStateProblems(nested).values()].map((p) => [p.nodeId, /inside a repeat within another repeat/.test(p.message)])).toEqual([['body', true], ['pick', true]]);
  });

  it('selects from a button in a repeat of its list, steps from anywhere, and is never set or toggled', () => {
    const s = fresh();
    const def = stepsDef(s);
    const act = (nodeId: string, action: unknown) => ({ type: 'node.setStateAction', owner: owner(def), nodeId, action }) as EditOperation;
    expect(refusal(s, [act('loose', { state: 'active', op: 'select' })])).toMatch(/not inside a repeat of "Steps"/);
    expect(refusal(s, [act('other-pick', { state: 'active', op: 'select' })])).toMatch(/inside a repeat of "Other"/);
    expect(refusal(s, [act('loose', { state: 'active', op: 'set', value: 'x' })])).toMatch(/sets the active item/);
    expect(refusal(s, [act('loose', { state: 'active', op: 'toggle' })])).toMatch(/toggles the active item/);
    expect(refusal(s, [act('loose', { state: 'plan', op: 'select' })])).toMatch(/not the active item of a list/);
    expect((apply(s, [act('loose', { state: 'active', op: 'prev' })]).components[def.id].tree!.nodes.loose as LinkNode).stateAction).toEqual({ state: 'active', op: 'prev' });
    expect(refusal(s, [act('pic-text', { state: 'active', op: 'select' })])).toMatch(/not a button/);
  });

  it('refuses an edit that would leave a read or a select outside a repeat of its list, whichever operation makes it', () => {
    const s = fresh();
    const def = stepsDef(s);
    place(s, def);
    // Moving the select button out of its repeat.
    const unbound = { type: 'node.setBinding', owner: owner(def), nodeId: 'pick', field: 'label', binding: null } as EditOperation;
    expect(refusal(s, [unbound, { type: 'node.move', owner: owner(def), nodeId: 'pick', parentId: 'root', index: 0 }])).toMatch(/Steps: .*selects its item.*not inside a repeat of "Steps"/);
    expect(refusedAt(s, [unbound, { type: 'node.move', owner: owner(def), nodeId: 'pick', parentId: 'root', index: 0 }])).toBe('pick');
    // Repeating another list where the pictures show for the active step.
    expect(refusal(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'pics', field: 'list', binding: { $prop: 'other' } }])).toMatch(/inside a repeat of "Other", not of "Steps"/);
    // Removing the list an unused item state holds the active item of.
    const unused = apply(s, [{ type: 'component.setState', definitionId: def.id, state: 'spareItem', schema: { type: 'item', label: 'Spare item', list: 'spare' } }]);
    expect(refusal(unused, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'spare' }])).toMatch(/not a list property/);
    // Judged where the batch leaves the design: a move out of the repeat that a later step makes good is fine.
    expect(refusal(s, [unbound, { type: 'node.move', owner: owner(def), nodeId: 'pick', parentId: 'root', index: 0 }, { type: 'node.setStateAction', owner: owner(def), nodeId: 'pick', action: null }])).toBe('');
    // Removing the state with everything that uses it, in one batch, is fine; so is removing the button.
    expect(refusal(s, [{ type: 'node.remove', owner: owner(def), nodeId: 'pick' }])).toBe('');
    const cleared = [
      { type: 'node.setStateAction', owner: owner(def), nodeId: 'pick', action: null },
      { type: 'node.setStateAction', owner: owner(def), nodeId: 'next', action: null },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'body', field: 'when', binding: null },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'pic', field: 'when', binding: null },
      { type: 'component.removeState', definitionId: def.id, state: 'active' }
    ] as EditOperation[];
    expect(refusal(s, cleared)).toBe('');
  });

  it('reports a hand-edited design whose reads, selects or list went astray, without refusing other edits to it', () => {
    const s = fresh();
    const def = stepsDef(s);
    place(s, def);
    const tree = def.tree!;
    // The select button moved out of its repeat by hand, and a read added outside one.
    (tree.nodes.row as { children: string[] }).children = ['body'];
    (tree.nodes.root as { children: string[] }).children.push('pick');
    tree.nodes.loose.when = { $state: 'active' };
    const codes = errors(s).map((d) => [d.code, d.nodeId]);
    expect(codes).toEqual(expect.arrayContaining([['STATE_ACTION_INVALID', 'pick'], ['BINDING_INVALID', 'loose']]));
    expect([...itemStateProblems(def).values()].map((p) => p.nodeId).sort()).toEqual(['loose', 'pick']);
    // What was already wrong does not block an unrelated edit, but a new problem beside it is still refused.
    expect(refusal(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'next', field: 'label', value: 'Onwards' } as EditOperation])).toBe('');
    expect(refusal(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'pics', field: 'list', binding: { $prop: 'other' } }])).toMatch(/inside a repeat of "Other", not of "Steps"/);
    expect(refusedAt(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'pics', field: 'list', binding: { $prop: 'other' } }])).toBe('pic');
    // A declaration whose list is gone.
    delete def.properties.spare;
    def.state!.lost = { type: 'item', label: 'Lost', list: 'spare', initial: 0 };
    expect(errors(s).some((d) => d.code === 'STATE_INVALID' && /"spare", which is not a list property/.test(d.message))).toBe(true);
  });
});

describe('the generated site', () => {
  it('holds the chosen item per placement, selects a button’s own item, and names each item’s content', () => {
    const s = fresh();
    const def = stepsDef(s);
    place(s, def);
    const source = generateManagedComponent(s, def, { instrument: false });
    expect(source).toContain('let so_state_active = $state(null);');
    expect(source).toContain('const so_state_active_item = $derived(activeItem((steps ?? []), so_state_active, 1));');
    expect(source).toContain('onclick={() => (so_state_active = item.id)}');
    expect(source).toContain('onclick={() => (so_state_active = stepItem((steps ?? []), so_state_active_item, 1, true))}');
    // The button says whether its item's body is expanded and names that body and its picture.
    expect(source).toContain('aria-expanded={so_state_active_item === item.id}');
    expect(source).toContain('aria-controls={[`${uid}.panel.body.${itemKey(item.id)}`, `${uid}.panel.pic.${itemKey(item.id)}`].join(\' \')}');
    // Every item's body and picture stays in the page, hidden on screen while another item is active.
    expect(source).toContain('!((so_state_active_item === item.id)) && "so-state-off"');
    expect(source).not.toMatch(/\{#if \(?so_state_active_item/);
    expect([...keptPanels(s, def)].sort()).toEqual(['body', 'pic']);
  });

  it('names each item’s content by an ID no item can break, beside a property named like the helper', async () => {
    const s = fresh();
    const def = stepsDef(s);
    def.properties.itemKey = P.str('Key', 'k');
    def.properties.encodeURIComponent = P.str('Encode', 'e');
    home(s).rootIds = [];
    const node = place(s, def);
    node.props.steps = [{ id: 'a b', title: 'Spaced', body: 'Spaced body', pic: '' }, { id: '\ud800', title: 'Lone', body: 'Lone body', pic: '' }, { id: 'a_0020b', title: 'Lookalike', body: 'Lookalike body', pic: '' }, { id: 'tab\there', title: 'Tabbed', body: 'Tabbed body', pic: '' }];
    const html = await renderHome(s);
    const ids = [...html.matchAll(/ id="([^"]*\.panel\.body\.[^"]*)"/g)].map((m) => m[1].split('.panel.body.')[1]);
    expect(ids).toEqual(['a_0020b', '_d800', 'a_005f0020b', 'tab_0009here']);
    // The buttons name the same IDs their panels carry.
    expect([...html.matchAll(/aria-controls="([^"]*)"/g)].map((m) => m[1].split(' ')[0].split('.panel.body.')[1])).toEqual(ids);
  });

  it('compiles without a warning, in the site and the editor', () => {
    const s = fresh();
    const def = stepsDef(s);
    place(s, def);
    const warnings: string[] = [];
    for (const instrument of [false, true])
      for (const generate of ['server', 'client'] as const) warnings.push(...compile(generateManagedComponent(s, def, { instrument }), { filename: defFile(def), generate, runes: true }).warnings.map((w) => w.code));
    expect(warnings).toEqual([]);
  });

  it('shows content kept from print in a conditional host only while its item is active, and says pressed without content to name', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.loose-steps',
      name: 'Loose steps',
      properties: { steps: P.list('Steps', 'Step', { title: P.str('Title', 'Step'), on: P.bool('On', true) }, [{ title: 'One', on: true }], { titleField: 'title' }) },
      parts: {},
      state: { active: { type: 'item', label: 'Active', list: 'steps', initial: 0 } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('rows', 'steps', [
            b.el('row', 'div', { when: { $item: 'on' } }, [b.link('pick', NONE, { $item: 'title' }, 'secondary', { stateAction: { state: 'active', op: 'select' } }), b.el('body', 'div', { when: uiState('active') }, [b.text('t', 'p', { $item: 'title' })])])
          ])
        ])
    });
    place(s, def);
    const source = generateManagedComponent(s, def, { instrument: false });
    expect(source).toContain('{#if (so_state_active_item === item.id)}');
    expect(source).toContain('aria-pressed={so_state_active_item === item.id}');
    expect(keptPanels(s, def).size).toBe(0);
  });

  it('renders the item each placement starts at, the last one for a shorter list, and nothing for an empty one', async () => {
    const s = fresh();
    const def = stepsDef(s);
    home(s).rootIds = [];
    place(s, def);
    place(s, def, { steps: [{ id: 'only', title: 'Only', body: 'Only body' }] });
    place(s, def, { steps: [] });
    const html = await renderHome(s);
    const sections = html.split('<section').slice(1);
    expect(sections).toHaveLength(3);
    const off = (section: string, words: string) => new RegExp(`class="[^"]*so-state-off[^"]*"[^>]*>\\s*<p[^>]*>${words}<`).test(section);
    const on = (section: string, words: string) => new RegExp(`class="(?![^"]*so-state-off)[^"]*"[^>]*>\\s*<p[^>]*>${words}<`).test(section);
    // Starting at the second step: its body and picture show, the others are in the page, hidden.
    expect([on(sections[0], 'Second body'), off(sections[0], 'First body'), off(sections[0], 'Third body'), on(sections[0], 'Pic two'), off(sections[0], 'Pic one')]).toEqual([true, true, true, true, true]);
    expect(sections[0].match(/aria-expanded="true"/g)).toHaveLength(1);
    // One item: it is the last, so it is active.
    expect(on(sections[1], 'Only body')).toBe(true);
    expect(sections[1]).not.toContain('so-state-off');
    expect(sections[2]).not.toContain('aria-expanded');
  });

  it('keeps a chosen item active while the list changes around it, and steps through the items', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(join(resolve('.tmp'), 'item-state-util-'));
    roots.push(dir);
    writeFileSync(join(dir, 'util.mjs'), UTIL_JS);
    const { activeItem, stepItem } = (await import(/* @vite-ignore */ join(dir, 'util.mjs'))) as {
      activeItem: (items: unknown, chosen: unknown, start: number) => string | null;
      stepItem: (items: unknown, active: unknown, by: number, wrap: boolean) => string | null;
    };
    const rows = (...ids: string[]) => ids.map((id) => ({ id }));
    // Before any choice: the starting position, the last for a shorter list, none for an empty one.
    expect([activeItem(rows('a', 'b', 'c'), null, 1), activeItem(rows('a'), null, 1), activeItem(rows('a', 'b'), null, 5), activeItem([], null, 0), activeItem(undefined, null, 0)]).toEqual(['b', 'a', 'b', null, null]);
    // A choice stays while items move or are added; once it is removed, the starting position again.
    expect([activeItem(rows('c', 'a', 'b'), 'c', 1), activeItem(rows('x', 'c'), 'c', 0), activeItem(rows('a', 'b'), 'c', 1)]).toEqual(['c', 'c', 'b']);
    expect([stepItem(rows('a', 'b', 'c'), 'a', 1, false), stepItem(rows('a', 'b', 'c'), 'c', 1, false), stepItem(rows('a', 'b', 'c'), 'c', 1, true), stepItem(rows('a', 'b', 'c'), 'a', -1, true)]).toEqual(['b', 'c', 'a', 'c']);
    expect([stepItem(rows('a', 'b'), 'gone', 1, true), stepItem([], 'a', 1, true), stepItem(rows('a', 'b', 'c'), 'a', -1, false)]).toEqual(['a', null, 'a']);
  });

  it('checks a page the way the site renders it: only the starting item’s content shows at first', () => {
    const s = fresh();
    const def = stepsDef(s);
    home(s).rootIds = [];
    place(s, def);
    const content = renderedContent(s, home(s)).filter((c) => c.kind === 'text');
    const words = content.map((c) => c.value);
    expect(words).toEqual(expect.arrayContaining(['Second body', 'Pic two', 'One', 'Two', 'Three']));
    // The stage shows the starting step's picture alone; the step buttons show every title.
    expect(content.filter((c) => c.defNodeId === 'pic-text').map((c) => c.value)).toEqual(['Pic two']);
    expect(words).not.toContain('First body');
    expect(words).not.toContain('Third body');
    // A placement with fewer items starts at its last.
    const short = fresh();
    home(short).rootIds = [];
    const node = place(short, stepsDef(short));
    node.props.steps = [{ id: 'x', title: 'Only', body: 'Only body', pic: 'Only pic' }];
    expect(renderedContent(short, home(short)).filter((c) => c.defNodeId === 'pic-text').map((c) => c.value)).toEqual(['Only pic']);
  });
});

describe('the editor and Component Studio', () => {
  it('offers select only to a button in a repeat of the list, and the active item only as a condition there', () => {
    const s = fresh();
    const def = stepsDef(s);
    const ops = (nodeId: string) => clickChoices(def, nodeId).filter((c) => c.action?.state === 'active').map((c) => c.action!.op);
    expect(ops('pick')).toEqual(['select', 'next', 'prev']);
    expect(ops('loose')).toEqual(['next', 'prev']);
    expect(ops('other-pick')).toEqual(['next', 'prev']);
    // A hand-edited select that names no state still reads as words, for the Inspector to offer clearing it.
    expect(actionWords(def, { op: 'select' } as never)).toBe('Make its item the active item');
    expect(actionWords(def, { state: 'active', op: 'select' })).toBe('Make its item the active step');
    const states = (nodeId: string) => conditionSources(def, nodeId).state.map((x) => [x.key, !!x.activeItem]);
    expect(states('body')).toEqual([['state:active', true], ['state:plan', false]]);
    expect(states('loose')).toEqual([['state:plan', false]]);
    expect(states('other-text')).toEqual([['state:plan', false]]);
    expect(describeConditions(def, def.tree!.nodes.body)).toEqual(['Show when its item is the active step']);
  });

  it('adds an item state for one of the lists, and names its positions by the design’s items', () => {
    const s = fresh();
    const def = stepsDef(s);
    expect(newStateProblem(def, 'Focus', 'item', [], undefined)).toMatch(/Choose the list/);
    expect(newStateProblem(def, 'Focus', 'item', [], 'other')).toBeNull();
    const op = addStateOp(def, 'Focus', 'item', [], 'other');
    expect(op).toEqual({ type: 'component.setState', definitionId: def.id, state: 'focus', schema: { type: 'item', label: 'Focus', list: 'other' } });
    expect(apply(s, [op]).components[def.id].state!.focus).toMatchObject({ type: 'item', initial: 0 });
    expect(itemStatePositions(def, def.state!.active as never)).toEqual([{ value: 0, label: '1. One' }, { value: 1, label: '2. Two' }, { value: 2, label: '3. Three' }]);
    // A position past the design's items (set by the assistant) is listed as the one in use, and a preview's own items name theirs.
    expect(itemStatePositions(def, { type: 'item', label: 'Far', list: 'steps', initial: 50 }).at(-1)).toEqual({ value: 50, label: 'Step 51' });
    // Previewing another position keeps the one each placement starts at in the list, to go back to.
    expect(itemStatePositions(def, { type: 'item', label: 'Far', list: 'steps', initial: 4 }, undefined, 0).map((o) => o.value)).toEqual([0, 1, 2, 4]);
    expect(itemStatePositions(def, { type: 'item', label: 'Far', list: 'steps', initial: 0 }, undefined, 6).map((o) => o.value)).toEqual([0, 1, 2, 6]);
    expect(itemStatePositions(def, def.state!.active as never, [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]).map((o) => o.label)).toEqual(['1. A', '2. B', '3. C', '4. D']);
  });

  it('previews another item in Component Studio, from the position chosen', () => {
    const s = fresh();
    const def = stepsDef(s);
    expect(studioStates(def, { variants: {}, sample: 'design', states: { active: 2 } } as never).active).toBe(2);
    expect(studioStates(def, { variants: {}, sample: 'design', states: { active: 'b' } } as never).active).toBe(1);
    const spec = studioSpec(def, { variants: {}, sample: 'defaults', states: { active: 2 } } as never);
    expect(spec.states).toEqual({ active: 2 });
    // The preview request crosses to the main process with the position, and only a position.
    expect(previewSpec(JSON.parse(JSON.stringify(spec)))?.states).toEqual({ active: 2 });
    expect(previewSpec({ ...spec, states: { active: -1 } })).toBeNull();
  });
});

describe('the Foundation layouts', () => {
  const foundation = (componentId: string) => structuredClone(FOUNDATION_PACK.components.find((d) => d.componentId === componentId)!);

  it('ships Steps with pictures, one list driving its step buttons and its pictures', async () => {
    const s = fresh();
    const def = foundation('content.steps-media');
    s.components[def.id] = def;
    home(s).rootIds = [];
    place(s, def);
    expect(errors(s)).toEqual([]);
    expect(def.state).toEqual({ activeStep: { type: 'item', label: 'Active step', list: 'steps', initial: 0 } });
    const repeats = Object.values(def.tree!.nodes).filter((n) => n.kind === 'repeat');
    expect(repeats.map((r) => (r as { list: { $prop: string } }).list.$prop)).toEqual(['steps', 'steps']);
    expect([...keptPanels(s, def)].sort()).toEqual(['step-details', 'step-media']);
    const trigger = def.tree!.nodes['step-trigger'] as LinkNode;
    expect(trigger.stateAction).toEqual({ state: 'activeStep', op: 'select' });
    const html = await renderHome(s);
    expect(html.match(/<figure[^>]*>/g)).toHaveLength(3);
    expect(html.match(/<button[^>]*aria-expanded="true"/g)).toHaveLength(1);
  });

  it('pins the picture and the Services grid heading below the sticky header from tablet width up, never on phones', () => {
    const steps = foundation('content.steps-media');
    const stage = steps.tree!.nodes['media-stage'].styles!;
    const grid = foundation('features.grid');
    const option = grid.variantAxes!.layout.options['sticky-split'];
    for (const styles of [stage, option.styles!.intro]) {
      expect(styles.base?.position).toBeUndefined();
      for (const size of ['tablet', 'desktop'] as const) expect(styles[size]).toMatchObject({ position: 'sticky', inset: 'calc(var(--so-header-offset, 4.5rem) + 1.5rem) auto auto auto', alignSelf: 'start' });
    }
    expect(option.styles!.inner.tablet).toMatchObject({ layout: 'grid', gridTemplate: '1fr 1.5fr' });
    expect(option.styles!.inner.base).toBeUndefined();
    const s = fresh();
    s.components[grid.id] = grid;
    const node = place(s, grid);
    node.variants = { layout: 'sticky-split' };
    expect(errors(s)).toEqual([]);
  });

  it('prints pinned columns in their place, one after the other', () => {
    const print = FOUNDATION_BASE_CSS.slice(FOUNDATION_BASE_CSS.indexOf('@media print'));
    expect(print).toContain(":is([class$='--layout-sticky-split'], [class*='--layout-sticky-split ']):is([class$='__intro'], [class*='__intro ']):not(#so-print) { position: static !important; inset: auto !important; }");
    expect(print).toContain(":is([class$='__steps-layout'], [class*='__steps-layout ']) > :is([class$='__steps-stage'], [class*='__steps-stage ']):not(#so-print) { order: 0 !important; }");
    // Every browser that prints a site applies them: none of the print resets needs :has().
    expect(print.slice(print.indexOf('What stays in view'), print.indexOf('Where the sheet has room'))).not.toContain(':has(');
    expect(print).toContain("{ position: static !important; inset: auto !important; }");
    expect(print).toContain("{ grid-template-columns: minmax(0, 1fr) !important; }");
  });
});

describe('the assistant', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('builds steps with pictures from one list in one upsert_managed_component call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-item-state-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('blank', 'Expo', false));
    const host: ToolHost = {
      state: () => session.state,
      revision: () => session.revision,
      diagnostics: () => validateState(session.state),
      apply: async (operations, expectedRevision, label) => {
        const r = await session.apply({ operations, expectedRevision }, { label });
        return { ok: r.ok, revision: r.revision, results: r.results, error: r.error };
      },
      compileAll: async () => [],
      inspectLayout: async () => ({}),
      ask: async () => '',
      macros: newMacroMemory()
    };
    const design = (selectAt: string) => ({
      name: 'Process',
      description: 'Steps and their pictures.',
      category: 'content',
      tags: ['steps'],
      properties: [
        {
          type: 'list',
          name: 'steps',
          label: 'Steps',
          itemLabel: 'Step',
          titleField: 'title',
          fields: [{ type: 'string', name: 'title', label: 'Title', default: 'Step' }],
          default: [{ values: [{ field: 'title', value: 'Plan' }] }, { values: [{ field: 'title', value: 'Build' }] }]
        }
      ],
      state: [{ type: 'item', name: 'active', label: 'Active step', list: 'steps' }],
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['list', 'stage', 'after'] },
        { kind: 'element', id: 'list', tag: 'div', children: ['rows'] },
        { kind: 'repeat', id: 'rows', list: 'steps', children: ['pick'] },
        { kind: 'link', id: 'pick', link: '', label: { $item: 'title' }, appearance: 'secondary', stateAction: { op: 'select', state: 'active' } },
        { kind: 'element', id: 'stage', tag: 'div', children: ['pics'] },
        { kind: 'repeat', id: 'pics', list: 'steps', children: ['pic'] },
        { kind: 'text', id: 'pic', tag: 'p', text: { $item: 'title' }, when: { $state: 'active' } },
        { kind: 'link', id: 'after', link: '', label: 'Next', appearance: 'text', stateAction: selectAt === 'after' ? { op: 'select', state: 'active' } : { op: 'next', state: 'active', wrap: true } }
      ]
    });
    const refused = await executeTool('upsert_managed_component', JSON.stringify(design('after')), host, 'c1');
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.content)).toMatch(/not inside a repeat of \\"Steps\\"/);
    // The refusal points at the button to move or change, not at the state.
    expect((refused.content as { error: { details?: { fields?: Array<{ field: string }> } } }).error.details?.fields?.map((f) => f.field)).toEqual(['nodes[7]']);
    const made = await executeTool('upsert_managed_component', JSON.stringify(design('pick')), host, 'c2');
    expect(made.ok).toBe(true);
    const def = Object.values(session.state.components).find((d) => d.name === 'Process')!;
    expect(def.state).toEqual({ active: { type: 'item', label: 'Active step', list: 'steps', initial: 0 } });
    expect(generateManagedComponent(session.state, def, { instrument: false })).toContain('onclick={() => (so_state_active = item.id)}');
    expect(validateState(session.state).filter(blocksSaving)).toEqual([]);
  });
});
