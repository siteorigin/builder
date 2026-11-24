import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { instancesOf } from '@engine/tree';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { partStyleControls, placementStyleControls } from '@shared/styles';
import { ProjectSession } from '../../src/main/project/session';
import { createComponentTarget } from '../../src/renderer/src/lib/model';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const home = (s: ProjectState) => s.pages[s.site.homePageId];

/** A blank site's Section holding a heading, a paragraph and a button: the issue's "custom layout inside a Section". */
async function composedSection() {
  const dir = mkdtempSync(join(tmpdir(), 'so-create-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Expo', false));
  const owner = { kind: 'page' as const, id: s.state.site.homePageId };
  const section = home(s.state).rootIds[0];
  await s.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: 'Book a visit' }] }, { label: 'Insert button' });
  const other = await s.apply({ operations: [{ type: 'page.create', title: 'Visit' }] }, { label: 'Add page' });
  return { s, owner, section, otherPage: other.results![0].pageId as string };
}

describe('Create component from a composed Section (#173)', () => {
  it('packages the section and its slotted content, replaces the placement, inserts intact copies and undoes in one step', async () => {
    const { s, owner, section, otherPage } = await composedSection();
    const before = structuredClone(home(s.state));
    const slotted = (home(s.state).nodes[section] as InstanceNode).slots!.content;
    expect(slotted).toHaveLength(3);

    const made = await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: section, name: 'Welcome band' }] }, { label: 'Create component Welcome band' });
    expect(made.ok).toBe(true);
    const defId = made.results![0].definitionId as string;
    const placed = made.results![0].nodeId as string;
    const def = s.state.components[defId];

    // The design is the section with its content inside it, every piece of copy a property of its own.
    const root = def.tree!.nodes[def.tree!.rootIds[0]] as InstanceNode;
    expect(root.kind).toBe('instance');
    expect(root.definitionId).toBe('foundation.layout.section');
    expect(root.slots!.content).toHaveLength(3);
    expect(Object.keys(def.properties).sort()).toEqual(['buttonLabel', 'buttonLink', 'heading', 'text']);
    expect(def.properties.heading.default).toBe('Welcome to Expo');
    expect(def.parts.root.label).toBe('Section');

    // The page now holds one placement where the section was, and none of the section's own nodes.
    const page = home(s.state);
    expect(page.rootIds).toEqual([placed]);
    for (const id of [section, ...slotted]) expect(page.nodes[id]).toBeUndefined();
    expect(Object.keys(page.nodes)).toEqual([placed]);
    expect((page.nodes[placed] as InstanceNode).props.heading).toBe('Welcome to Expo');

    // Placed on another page, the copy shows the same section with the same content.
    const ins = await s.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: otherPage }, parentId: null, definitionId: defId }] }, { label: 'Insert Welcome band' });
    expect(ins.ok).toBe(true);
    expect(instancesOf(s.state, defId)).toHaveLength(2);
    expect(validateState(s.state).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s.state);
    const visit = files.get(`src/routes${s.state.pages[otherPage].route}+page.svelte`)!;
    expect(visit).toBeDefined();
    const svelte = [...files].find(([p]) => p.includes(defId.replace(/\./g, '-')))?.[1] ?? '';
    expect(svelte).toContain('Welcome to Expo');
    expect(svelte).toContain('slot_content');

    // Undo the insert, then the creation: one step puts the section and its content back exactly as they were.
    await s.undo();
    expect(s.historyInfo().undoLabel).toBe('Create component Welcome band');
    await s.undo();
    expect(home(s.state)).toEqual(before);
    expect(s.state.components[defId]).toBeUndefined();
  });
});

/** The business starter with a Section on top holding a stack (with a heading), a paragraph, an image, a button, an
 *  icon and a divider, an empty Section below it, and a project component being edited everywhere. */
function library() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
  const ins = (op: Record<string, unknown>) => {
    const r = applyOperations(s, [{ type: 'node.insert', owner: page, ...op } as never]);
    s = r.state;
    return r.results[0].nodeId as string;
  };
  const section = ins({ parentId: null, index: 0, componentId: 'layout.section' });
  const empty = ins({ parentId: null, index: 1, componentId: 'layout.section' });
  const into = (primitive: string, extra: Record<string, unknown> = {}) => ins({ parentId: section, slot: 'content', primitive, ...extra });
  const stack = into('stack');
  ins({ parentId: stack, primitive: 'heading', text: 'Title' });
  const kinds = { stack, text: into('paragraph', { text: 'Copy' }), image: into('image'), link: into('button', { text: 'Go' }), icon: into('icon'), divider: into('divider') };
  const hero = s.pages[page.id].rootIds.find((id) => s.components[(s.pages[page.id].nodes[id] as InstanceNode).definitionId]?.componentId === 'hero.split')!;
  const cardStack = into('stack');
  ins({ parentId: cardStack, primitive: 'heading', text: 'Card title' });
  const card = applyOperations(s, [{ type: 'component.createFromNode', owner: page, nodeId: cardStack, name: 'Card' }]);
  s = card.state;
  const cardDef = s.components[card.results[0].definitionId as string];
  const at = (owner: OwnerRef, nodeId: string, instancePath: string[] = []): ElementRef => ({ owner, instancePath, nodeId });
  return { s, page, section, empty, kinds, hero, card: card.results[0].nodeId as string, cardDef, at };
}

describe('where Create component… is offered (#173)', () => {
  it('offers every element and basic element, and a section holding content, on a page', () => {
    const { s, page, section, kinds, at } = library();
    const snap = { state: s };
    for (const [kind, id] of Object.entries(kinds)) expect(createComponentTarget(snap, at(page, id)), kind).toEqual(at(page, id));
    expect(createComponentTarget(snap, at(page, section))).toEqual(at(page, section));
    // What the menu acts on is the node alone, whichever repeated item it was picked in.
    expect(createComponentTarget(snap, { ...at(page, kinds.text), itemPath: ['i1'], partId: 'x' })).toEqual(at(page, kinds.text));
  });

  it('leaves out an empty section, a plain placement, a code component and a slot that is not declared', () => {
    const { s, page, section, empty, hero, card, at } = library();
    expect(createComponentTarget({ state: s }, at(page, empty))).toBeNull();
    // A theme section or a project component with no content of its own: Make unique copies its design instead.
    expect(createComponentTarget({ state: s }, at(page, hero))).toBeNull();
    expect(createComponentTarget({ state: s }, at(page, card))).toBeNull();
    // Content kept under a slot name the section does not declare is not content it shows.
    const stray = structuredClone(s);
    const sec = stray.pages[page.id].nodes[empty] as InstanceNode;
    sec.slots = { sidebar: [(stray.pages[page.id].nodes[section] as InstanceNode).slots!.content[0]] };
    expect(createComponentTarget({ state: stray }, at(page, empty))).toBeNull();
    // A code component is its own source: nothing in it to package.
    const coded = structuredClone(s);
    coded.components[(coded.pages[page.id].nodes[section] as InstanceNode).definitionId] = { ...coded.components[(coded.pages[page.id].nodes[section] as InstanceNode).definitionId], kind: 'code', source: '<section></section>' };
    expect(createComponentTarget({ state: coded }, at(page, section))).toBeNull();
  });

  it('leaves out the shared header and footer, parts inside a placement, missing nodes and a read-only project', () => {
    const { s, page, section, kinds, at } = library();
    const header = s.site.shell.header.rootIds[0];
    expect(createComponentTarget({ state: s }, at({ kind: 'shell', id: 'header' }, header))).toBeNull();
    const sectionDef = s.components[(s.pages[page.id].nodes[section] as InstanceNode).definitionId];
    // A part row in Layers, even one naming the placed component's own root, is not the placement.
    expect(createComponentTarget({ state: s }, at(page, sectionDef.tree!.rootIds[0], [section]))).toBeNull();
    expect(createComponentTarget({ state: s }, at(page, sectionDef.parts.container.nodeId, [section]))).toBeNull();
    expect(createComponentTarget({ state: s }, at(page, 'n_gone0000'))).toBeNull();
    expect(createComponentTarget({ state: s, readOnly: true }, at(page, kinds.text))).toBeNull();
    expect(createComponentTarget(null, at(page, kinds.text))).toBeNull();
    expect(createComponentTarget({ state: s }, null)).toBeNull();
  });

  it('offers what is inside a project component being edited everywhere, but not its root, its slots or a theme design', () => {
    const { s, cardDef, at } = library();
    const owner: OwnerRef = { kind: 'component', id: cardDef.id };
    const root = cardDef.tree!.rootIds[0];
    const heading = Object.values(cardDef.tree!.nodes).find((n) => n.kind === 'text')!.id;
    expect(createComponentTarget({ state: s }, at(owner, heading))).toEqual(at(owner, heading));
    expect(createComponentTarget({ state: s }, at(owner, root))).toBeNull();
    const section = s.components['foundation.layout.section'];
    const slot = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot')!.id;
    expect(createComponentTarget({ state: s }, at({ kind: 'component', id: section.id }, section.parts.container.nodeId))).toBeNull();
    expect(createComponentTarget({ state: s }, at({ kind: 'component', id: section.id }, slot))).toBeNull();
  });
});

describe('a component made from a section (#173)', () => {
  it('keeps the section’s name and the styles its root offers', () => {
    const { s, page, section } = library();
    const named = applyOperations(s, [{ type: 'node.rename', owner: page, nodeId: section, name: 'Studio intro' }]).state;
    const unnamed = applyOperations(s, [{ type: 'component.createFromNode', owner: page, nodeId: section, name: 'Intro band' }]);
    const def = unnamed.state.components[unnamed.results[0].definitionId as string];
    const sectionDef = s.components['foundation.layout.section'];
    expect(def.parts.root.label).toBe('Section');
    expect(def.description).toBe('Project component created from Section.');
    expect(def.parts.root.styleControls).toEqual(partStyleControls(sectionDef, 'root'));
    expect(placementStyleControls(def, 'root', false)).toEqual([...partStyleControls(sectionDef, 'root')!, 'hidden']);
    const r = applyOperations(named, [{ type: 'component.createFromNode', owner: page, nodeId: section, name: 'Intro band' }]);
    expect(r.state.components[r.results[0].definitionId as string].parts.root.label).toBe('Studio intro');
  });

  it('keeps the section’s own styles, tone and anchor, and every anchor inside it', () => {
    const { s: base, page, section, kinds } = library();
    let s = base;
    const tone = Object.keys(s.components['foundation.layout.section'].variantAxes!.tone.options).find((o) => o !== 'default')!;
    s = applyOperations(s, [
      { type: 'node.setStyle', owner: page, nodeId: section, partId: 'root', scope: 'base', property: 'paddingBlock', value: '5rem' },
      { type: 'instance.setVariant', owner: page, nodeId: section, axis: 'tone', variant: tone },
      { type: 'node.setContent', owner: page, nodeId: section, field: 'anchor', value: 'intro' },
      { type: 'node.setContent', owner: page, nodeId: kinds.text, field: 'anchor', value: 'story' }
    ]).state;
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: page, nodeId: section, name: 'Intro band' }]);
    const def = r.state.components[r.results[0].definitionId as string];
    const root = def.tree!.nodes[def.tree!.rootIds[0]] as InstanceNode;
    expect(root.overrides?.root?.base?.paddingBlock).toBe('5rem');
    expect(root.variants?.tone).toBe(tone);
    expect(root.anchor).toBeUndefined();
    expect((r.state.pages[page.id].nodes[r.results[0].nodeId as string] as InstanceNode).anchor).toBe('intro');
    // A link to the paragraph keeps working: the one copy on the page still renders it.
    expect(Object.values(def.tree!.nodes).some((n) => n.anchor === 'story')).toBe(true);
  });

  it('refuses a code component whose inner part has styles of its own, which a component cannot carry', () => {
    let s: ProjectState = createStarterState('business', 'Test Studio', false);
    const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
    const cta = s.pages[page.id].rootIds.find((id) => s.components[(s.pages[page.id].nodes[id] as InstanceNode).definitionId]?.componentId === 'cta.banner')!;
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: page, nodeId: cta }]).state;
    const sec = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: null, index: 0, componentId: 'layout.section' }]);
    s = sec.state;
    const section = sec.results[0].nodeId as string;
    s = applyOperations(s, [{ type: 'node.move', owner: page, nodeId: cta, parentId: section, slot: 'content', index: 0 }]).state;
    // Styles on its root still apply inside a design: that is fine.
    const rooted = applyOperations(s, [{ type: 'node.setStyle', owner: page, nodeId: cta, partId: 'root', scope: 'base', property: 'paddingBlock', value: '4rem' }]).state;
    expect(() => applyOperations(rooted, [{ type: 'component.createFromNode', owner: page, nodeId: section, name: 'Band' }])).not.toThrow();
    const styled = applyOperations(rooted, [{ type: 'node.setStyle', owner: page, nodeId: cta, partId: 'panel', scope: 'base', property: 'background', value: '#123456' }]).state;
    expect(() => applyOperations(styled, [{ type: 'component.createFromNode', owner: page, nodeId: section, name: 'Band' }])).toThrow(/own styles on its Panel part/);
    expect(() => applyOperations(styled, [{ type: 'component.createFromNode', owner: page, nodeId: cta, name: 'Band' }])).toThrow(/own styles on its Panel part/);
  });
});
