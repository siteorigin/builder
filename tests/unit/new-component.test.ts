import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { newId } from '@shared/ids';
import { PROJECT_DEFINITION_ID, projectDefinitionId } from '@shared/component-ids';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { componentStructure, STRUCTURE_CHARS } from '@agent/context';
import { executeTool, searchProjectComponents, serializeResult } from '@agent/tools';
import { ProjectSession } from '../../src/main/project/session';
import { componentRequest, componentRequestContext, newComponentPlace, startBlankOps } from '../../src/renderer/src/lib/new-component';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function blankSession() {
  const dir = mkdtempSync(join(tmpdir(), 'so-new-component-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Expo', false));
  return { s, owner: { kind: 'page' as const, id: s.state.site.homePageId } };
}

/** What the Create component dialog's Start blank sends: the component and its placement, in one change. */
const startBlank = (owner: { kind: 'page'; id: string }, name: string, definitionId = projectDefinitionId(name), nodeId = newId('n')) => ({
  definitionId,
  nodeId,
  operations: [
    { type: 'component.create' as const, definitionId, name, description: 'Plans side by side.' },
    { type: 'node.insert' as const, newNodeId: nodeId, owner, parentId: null, definitionId }
  ]
});

describe('component.create (#172)', () => {
  it('makes an empty managed component and places it in one change, which one undo takes back', async () => {
    const { s, owner } = await blankSession();
    const before = structuredClone(s.state.pages[owner.id]);
    const blank = startBlank(owner, '  Pricing card ');
    const r = await s.apply({ operations: blank.operations }, { label: 'Create component Pricing card' });
    expect(r.ok).toBe(true);
    const def = s.state.components[blank.definitionId];
    expect(r.results![0]).toEqual({ definitionId: blank.definitionId, rootNodeId: def.tree!.rootIds[0] });
    expect(def).toMatchObject({ kind: 'managed', owner: 'project', name: 'Pricing card', description: 'Plans side by side.', category: 'custom', properties: {} });
    // One container, its root, which the design is built inside and which placements style as the root part.
    const root = def.tree!.nodes[def.tree!.rootIds[0]] as ElementNode;
    expect(def.tree!.rootIds).toHaveLength(1);
    expect(root).toMatchObject({ kind: 'element', tag: 'div', children: [] });
    expect(def.parts.root.nodeId).toBe(root.id);
    expect(def.parts.root.styleControls?.length).toBeGreaterThan(0);
    const placed = s.state.pages[owner.id].nodes[blank.nodeId] as InstanceNode;
    expect(placed).toMatchObject({ kind: 'instance', definitionId: blank.definitionId });
    expect(s.state.pages[owner.id].rootIds.at(-1)).toBe(blank.nodeId);

    // A component with no properties yet is a valid design, and the site builds with it.
    expect(validateState(s.state).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s.state);
    expect([...files.keys()].some((p) => p.includes(blank.definitionId.replace(/\./g, '-')))).toBe(true);

    expect(s.historyInfo().undoLabel).toBe('Create component Pricing card');
    await s.undo();
    expect(s.state.components[blank.definitionId]).toBeUndefined();
    expect(s.state.pages[owner.id]).toEqual(before);
    await s.redo();
    expect(s.state.components[blank.definitionId]?.name).toBe('Pricing card');
    expect(s.state.pages[owner.id].nodes[blank.nodeId]).toBeDefined();
  });

  it('builds a design inside the new root with the ordinary node and contract operations', () => {
    let st: ProjectState = createStarterState('blank', 'Expo', false);
    const made = applyOperations(st, [{ type: 'component.create', name: 'Note' }]);
    st = made.state;
    const { definitionId, rootNodeId } = made.results[0] as { definitionId: string; rootNodeId: string };
    expect(definitionId).toMatch(PROJECT_DEFINITION_ID);
    const owner = { kind: 'component' as const, id: definitionId };
    const heading = newId('n');
    st = applyOperations(st, [
      { type: 'node.insert', newNodeId: heading, owner, parentId: rootNodeId, primitive: 'heading', text: 'Opening hours' },
      { type: 'component.setPropSchema', definitionId, prop: 'heading', schema: { type: 'string', label: 'Heading', default: 'Opening hours' } },
      { type: 'node.setBinding', owner, nodeId: heading, field: 'text', binding: { $prop: 'heading' } },
      { type: 'component.setPart', definitionId, partId: 'heading', nodeId: heading, label: 'Heading', styleControls: ['textStyle', 'color'] }
    ]).state;
    const def = st.components[definitionId];
    expect(def.tree!.nodes[heading]).toMatchObject({ kind: 'text', text: { $prop: 'heading' } });
    expect(def.parts.heading.nodeId).toBe(heading);
    expect(validateState(st).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses a blank name and an ID that is malformed or taken, and keeps nothing when the placement fails', async () => {
    const { s, owner } = await blankSession();
    const entries = s.historyInfo().entries.length;
    const components = Object.keys(s.state.components).sort();
    const refused = async (operations: unknown[], why: RegExp) => {
      const r = await s.apply({ operations: operations as never }, { label: 'Create component' });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(why);
    };
    await refused([{ type: 'component.create', name: '   ' }], /needs a name/);
    for (const id of ['proj.../x', 'foundation.layout.section', 'proj.card', 'proj.card-ABCDE'])
      await refused([{ type: 'component.create', definitionId: id, name: 'Card' }], /not a project component ID/);
    const id = projectDefinitionId('Card');
    await refused([{ type: 'component.create', definitionId: id, name: 'Card' }, { type: 'component.create', definitionId: id, name: 'Card again' }], /already exists/);
    // The placement fails: the component it was made for is not kept either.
    await refused([{ type: 'component.create', definitionId: id, name: 'Card' }, { type: 'node.insert', owner, parentId: 'n_gone', definitionId: id }], /.+/);
    expect(Object.keys(s.state.components).sort()).toEqual(components);
    expect(s.historyInfo().entries.length).toBe(entries);
  });

  it('gives two components of the same name IDs of their own', () => {
    const r = applyOperations(createStarterState('blank', 'Expo', false), [
      { type: 'component.create', name: 'Card' },
      { type: 'component.create', name: 'Card' }
    ]);
    const [a, b] = r.results.map((x) => x.definitionId as string);
    expect(a).not.toBe(b);
    expect([r.state.components[a].name, r.state.components[b].name]).toEqual(['Card', 'Card']);
  });
});

describe('read_component with structure (#172)', () => {
  const host = (s: ProjectState) => ({ state: () => s, revision: () => 1 }) as unknown as Parameters<typeof executeTool>[2];
  const read = async (s: ProjectState, args: Record<string, unknown>) => (await executeTool('read_component', JSON.stringify(args), host(s), 'c1')).content as Record<string, any>;

  it('shows a theme design as stored: its nodes, bindings to properties and list items, parts, screen-size rules and every token it uses', async () => {
    const s = createStarterState('blank', 'Expo', false);
    const grid = catalogueComponent('foundation', 'features.grid')!;
    const out = await read(s, { componentId: 'features.grid', structure: true });
    // The contract comes with it.
    expect(Object.keys(out.properties)).toEqual(expect.arrayContaining(['heading', 'items']));
    const st = out.structure;
    expect(st.rootIds).toEqual(grid.tree!.rootIds);
    expect(st.next).toBeNull();
    const byId = Object.fromEntries(st.nodes.map((n: { id: string }) => [n.id, n]));
    // Document order: the root first, then what it holds.
    expect(st.nodes[0].id).toBe(grid.tree!.rootIds[0]);
    expect(st.nodes.map((n: { id: string }) => n.id).sort()).toEqual(Object.keys(grid.tree!.nodes).sort());
    expect(byId.heading.text).toEqual({ $prop: 'heading' });
    expect(byId.cards).toMatchObject({ kind: 'repeat' });
    expect(JSON.stringify(byId['card-title'])).toContain('"$item"');
    expect(byId['card-title'].parts).toEqual(['cardTitle']);
    // A rule for one screen size, and the variant rules by node.
    expect(byId.grid.styles.desktop).toBeDefined();
    expect(st.variantStyles.layout['two-columns'].grid.desktop.columns).toBe(2);
    expect(st.variantStyles.tone.default).toBeUndefined();
    // A token only the dark option uses is listed with the rest.
    expect(st.tokensUsed).toEqual(expect.arrayContaining(['color.on-inverse', 'color.surface-alt', 'space.section']));
    expect(st.propertyDefaults.heading).toBe(grid.properties.heading.default);
  });

  it('reads a project design by its definition ID, and says a code component has no tree', async () => {
    let s = createStarterState('blank', 'Expo', false);
    const made = applyOperations(s, [{ type: 'component.create', name: 'Note' }]);
    s = made.state;
    const id = made.results[0].definitionId as string;
    const out = await read(s, { definitionId: id, structure: true });
    expect(out.structure.nodes).toHaveLength(1);
    expect(out.structure.nodes[0].parts).toEqual(['root']);
    const code = { ...structuredClone(s.components[id]), kind: 'code', tree: undefined, source: '<p>Hi</p>' } as ComponentDefinition;
    expect(componentStructure(s, code)).toMatchObject({ kind: 'code', note: expect.stringContaining('Svelte source') });
    // Without structure, the contract alone, as before.
    expect((await read(s, { definitionId: id })).structure).toBeUndefined();
  });

  it('fits every theme design in the result limit, and reads a long one a part at a time', async () => {
    const s = createStarterState('blank', 'Expo', false);
    for (const c of getTheme('foundation').components) {
      const first = await read(s, { componentId: c.componentId, structure: true });
      expect(serializeResult(first).length, c.componentId).toBeLessThan(24000);
      expect(JSON.parse(serializeResult(first)).truncated, c.componentId).toBeUndefined();
    }
    // A long design: more nodes than one read holds.
    const long = structuredClone(catalogueComponent('foundation', 'features.grid')!);
    long.id = 'proj.long-abcde';
    long.owner = 'project';
    const root = long.tree!.nodes[long.tree!.rootIds[0]] as ElementNode;
    for (let i = 0; i < 120; i++) {
      const id = `n_filler${i}`;
      long.tree!.nodes[id] = { id, kind: 'text', tag: 'p', text: `Filler paragraph number ${i} with some words to take up room in the read.`, styles: { base: { textStyle: { token: 'text.body' } } } };
      root.children.push(id);
    }
    s.components[long.id] = long;
    const seen: string[] = [];
    let offset = 0;
    for (let reads = 0; reads < 20; reads++) {
      const out = await read(s, { definitionId: long.id, structure: true, ...(offset ? { offset } : {}) });
      const part = out.structure;
      expect(JSON.stringify(part.nodes).length).toBeLessThanOrEqual(STRUCTURE_CHARS + 400);
      // Later parts carry only the nodes: the contract and the whole-design summaries came with the first.
      if (offset) expect(out.properties).toBeUndefined();
      seen.push(...part.nodes.map((n: { id: string }) => n.id));
      if (part.next === null) break;
      expect(part.next).toBeGreaterThan(offset);
      offset = part.next;
    }
    expect(offset).toBeGreaterThan(0);
    expect(seen.sort()).toEqual(Object.keys(long.tree!.nodes).sort());
  });
});

describe('search_components finds project components (#172)', () => {
  it('matches any of the words, best first, within the limit', () => {
    let s = createStarterState('blank', 'Expo', false);
    s = applyOperations(s, [
      { type: 'component.create', name: 'Pricing card', description: 'One plan with its price.' },
      { type: 'component.create', name: 'Team member', description: 'A photo, name and role.' },
      { type: 'component.create', name: 'Comparison table', description: 'Plans compared, with pricing per feature.' }
    ]).state;
    const names = (q: string, limit = 8) => searchProjectComponents(s, q, limit).map((d) => d.name);
    // The whole phrase appears in neither, yet both are found: the one named for a word first.
    expect(names('pricing comparison')).toEqual(['Comparison table', 'Pricing card']);
    expect(names('pricing comparison', 1)).toHaveLength(1);
    expect(names('photo')).toEqual(['Team member']);
    expect(names('zzz')).toEqual([]);
  });
});

describe('the Create component dialog (#172)', () => {
  it('places a blank component where the next section goes, or at the end of the page a design was opened from', () => {
    const st = createStarterState('business', 'Test Studio', false);
    const home = st.site.homePageId;
    expect(newComponentPlace(st, { pageId: home, definitionMode: null }, 1)).toEqual({ pageId: home, index: 1 });
    expect(newComponentPlace(st, { pageId: home, definitionMode: null })).toEqual({ pageId: home });
    // Editing a design everywhere: never inside it, which would change every placement of it.
    const other = st.site.pageOrder.find((id) => id !== home)!;
    expect(newComponentPlace(st, { pageId: home, definitionMode: { returnPageId: other } }, 2)).toEqual({ pageId: other });
    expect(newComponentPlace(st, { pageId: 'pg_gone', definitionMode: null }, 0)).toBeNull();
    expect(newComponentPlace(st, { pageId: null, definitionMode: null })).toBeNull();
  });

  it('starts blank as one change that makes the component and its placement, which the editor opens by the IDs it named', () => {
    const st = createStarterState('business', 'Test Studio', false);
    const home = st.site.homePageId;
    const plan = startBlankOps({ pageId: home, index: 1 }, ' Price tag ', '  ');
    const r = applyOperations(st, plan.ops);
    expect(r.results[0].definitionId).toBe(plan.definitionId);
    expect(r.state.components[plan.definitionId]).toMatchObject({ name: 'Price tag', description: 'Project component.' });
    expect(r.state.pages[home].rootIds[1]).toBe(plan.nodeId);
    expect((r.state.pages[home].nodes[plan.nodeId] as InstanceNode).definitionId).toBe(plan.definitionId);
    // Two starts never share an ID, even under one name.
    expect(startBlankOps({ pageId: home }, 'Price tag', '').definitionId).not.toBe(plan.definitionId);
  });

  it('asks the AI in the author\'s words, about the whole site, marked as a new component', () => {
    expect(componentRequest(' Price tag ', 'One plan and its price.')).toBe('Create a component called "Price tag": One plan and its price.');
    expect(componentRequest('Price tag', '')).toBe('Create a component called "Price tag".');
    expect(componentRequest('', 'A quote with a photo')).toBe('Create a component: A quote with a photo');
    expect(componentRequest('The "best" card', '')).toBe('Create a component called "The ”best” card".');
    const st = createStarterState('business', 'Test Studio', false);
    const other = st.site.pageOrder.find((id) => id !== st.site.homePageId)!;
    expect(componentRequestContext(st, { pageId: other }, 1024)).toEqual({ pageId: other, pageTitle: st.pages[other].title, selection: null, selectionLabel: null, viewport: 1024, mode: 'edit', task: 'component' });
    expect(componentRequestContext(st, null, 1280).pageId).toBe(st.site.homePageId);
  });
});
