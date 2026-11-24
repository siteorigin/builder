/**
 * Empty containers in the editor (issue #511): a Grid, Row, Stack or Container inserted with nothing in it is named
 * for the frame the preview draws while editing, a click on that frame selects it, and nothing of either reaches an
 * exported file. An empty slot's placeholder is rendered only while editing, so Preview has none of it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import type { ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { isEmptyLayout } from '@engine/tree';
import { generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { generateComponentPreview } from '@generator/preview';
import { descOf, selectionFromChain } from '../../src/renderer/src/lib/model';
import { ProjectSession } from '../../src/main/project/session';

const HOME = 'src/routes/+page.svelte';
const LAYOUT = 'src/routes/+layout.svelte';
/** Anything of the editor's frames and slot placeholders. */
const EDITOR_ONLY = /data-so-empty-layout|so_editing|so-slot-empty|data-so-editor-only/;

/** A blank site with a Section at the top of Home holding one empty element of each kind the Insert panel offers. */
function site() {
  let s: ProjectState = createStarterState('blank', 'Frames', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  let r = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  s = r.state;
  const section = r.results[0].nodeId as string;
  const ids: Record<string, string> = {};
  for (const primitive of ['grid', 'row', 'stack', 'container'] as const) {
    r = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive }]);
    s = r.state;
    ids[primitive] = r.results[0].nodeId as string;
  }
  return { s, owner, section, ids };
}

const nodeOf = (s: ProjectState, pageId: string, id: string) => s.pages[pageId].nodes[id];

/**
 * A component of the site's own holding an empty Section, so its file places an empty slot, with properties called
 * "document" and "globalThis", and one called "so_editing" as only a definition written by hand (or a theme pack)
 * can have.
 */
export function holder(): { s: ProjectState; defId: string } {
  let s: ProjectState = createStarterState('blank', 'Holder', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  let r = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  const outer = r.results[0].nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: outer, slot: 'content', primitive: 'stack' }]);
  const stack = r.results[0].nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: stack, componentId: 'layout.section' }]);
  r = applyOperations(r.state, [{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Holder' }]);
  const defId = r.results[0].definitionId as string;
  s = applyOperations(r.state, [
    { type: 'component.setPropSchema', definitionId: defId, prop: 'document', schema: { type: 'string', label: 'Document', default: 'Brochure' } },
    { type: 'component.setPropSchema', definitionId: defId, prop: 'globalThis', schema: { type: 'string', label: 'Scope', default: 'Here' } }
  ]).state;
  s.components[defId].properties.so_editing = { ...s.components[defId].properties.document, label: 'Editing' };
  return { s, defId };
}
/** The opening tag of the element the editor marks with `id`. */
const tagOf = (src: string, id: string) => src.match(new RegExp(`<[a-z]+ [^>]*data-so-node="${id}"[^>]*>`))?.[0] ?? '';

describe('which elements are empty containers', () => {
  it('takes an element with a layout at some size and nothing in it', () => {
    const { s, owner, ids } = site();
    for (const id of Object.values(ids)) expect(isEmptyLayout(nodeOf(s, owner.id, id))).toBe(true);
    const el = (styles: ElementNode['styles'], children: string[] = []): ElementNode => ({ id: 'x', kind: 'element', tag: 'div', children, styles });
    // A layout only on desktop still makes it a container.
    expect(isEmptyLayout(el({ desktop: { layout: 'grid', columns: 3 } }))).toBe(true);
    // Something inside it, no layout of its own (a spacer, a decorative block), or another kind of node: not one.
    expect(isEmptyLayout(el({ base: { layout: 'grid' } }, ['y']))).toBe(false);
    expect(isEmptyLayout(el({ base: { hidden: true }, desktop: { hidden: false } }))).toBe(false);
    expect(isEmptyLayout(el(undefined))).toBe(false);
    expect(isEmptyLayout({ id: 'h', kind: 'divider' })).toBe(false);
    expect(isEmptyLayout(undefined)).toBe(false);
  });
});

describe('the frame of an empty container in the editor preview', () => {
  it('names each empty container by its kind, only in the editor’s files', () => {
    const { s, ids } = site();
    const cache = new GenerationCache();
    const dev = generateProject(s, { instrument: true }, cache);
    const home = dev.get(HOME)!;
    expect(tagOf(home, ids.grid)).toContain('data-so-empty-layout="Grid"');
    expect(tagOf(home, ids.row)).toContain('data-so-empty-layout="Row"');
    // A Container is a Stack with room around it, and Layers calls it a Stack too.
    expect(tagOf(home, ids.stack)).toContain('data-so-empty-layout="Stack"');
    expect(tagOf(home, ids.container)).toContain('data-so-empty-layout="Stack"');
    expect(home.match(/data-so-empty-layout=/g)).toHaveLength(4);
    // An attribute on the container itself: it gains no element inside.
    expect(home).toMatch(new RegExp(`data-so-node="${ids.grid}"[^>]*></div>`));
    for (const [path, src] of dev) if (path.endsWith('.svelte')) expect(() => compile(src, { filename: path, generate: 'client', runes: true }), path).not.toThrow();
    // No exported file has any of it, from a fresh run or from the cache the editor's run filled.
    for (const files of [generateProject(s, {}, cache), generateProject(s)]) for (const [path, src] of files) expect(src, path).not.toMatch(EDITOR_ONLY);
  });

  it('leaves a container with something in it, and an empty element with no layout, unframed', () => {
    const { s, owner, ids } = site();
    const cache = new GenerationCache();
    generateProject(s, { instrument: true }, cache);
    const filled = applyOperations(s, [{ type: 'node.insert', owner, parentId: ids.grid, primitive: 'paragraph', text: 'In the grid' }]).state;
    const home = generateProject(filled, { instrument: true }, cache).get(HOME)!;
    expect(tagOf(home, ids.grid)).not.toContain('data-so-empty-layout');
    expect(home.match(/data-so-empty-layout=/g)).toHaveLength(3);
    // Emptied again (Undo), the frame comes back.
    const para = (filled.pages[owner.id].nodes[ids.grid] as ElementNode).children[0];
    const emptied = applyOperations(filled, [{ type: 'node.remove', owner, nodeId: para }]).state;
    expect(tagOf(generateProject(emptied, { instrument: true }, cache).get(HOME)!, ids.grid)).toContain('data-so-empty-layout="Grid"');
    // The footer's spacer is empty by design and has no layout: it is drawn as designed, on every page.
    const business = generateProject(createStarterState('business', 'Studio', false), { instrument: true });
    for (const [path, src] of business) expect(src, path).not.toContain('data-so-empty-layout');
  });

  it('frames an empty container in a component’s design, in every placement and the isolated preview', () => {
    const { s, owner, ids } = site();
    const made = applyOperations(s, [{ type: 'component.createFromNode', owner, nodeId: ids.row, name: 'Empty row' }]);
    const defId = made.results[0].definitionId as string;
    const dev = generateProject(made.state, { instrument: true });
    const file = [...dev.entries()].find(([, src]) => src.includes('siteorigin/components/' + defId + '/component.json'));
    expect(file?.[1]).toContain('data-so-empty-layout="Row"');
    const preview = generateComponentPreview(made.state, { definitionId: defId });
    expect('files' in preview && [...preview.files.values()].some((src) => src.includes('data-so-empty-layout="Row"'))).toBe(true);
    for (const [path, src] of generateProject(made.state)) expect(src, path).not.toMatch(EDITOR_ONLY);
  });
});

describe('an empty slot’s placeholder in the editor preview', () => {
  it('is rendered only while editing, from state of the file that places it', () => {
    let s = createStarterState('blank', 'Slots', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]).state;
    const home = generateProject(s, { instrument: true }).get(HOME)!;
    expect(home).toMatch(/\{#snippet slot_content\(\)\}\s*\{#if so_editing\}\s*<span class="so-slot-empty"[^\n]*\s*\{\/if\}\s*\{\/snippet\}/);
    expect(home).toContain('let so_editing = $state(false);');
    expect(home).toContain("attributeFilter: ['data-so-editing']");
    expect(home.match(/let so_editing/g)).toHaveLength(1);
    expect(() => compile(home, { filename: HOME, generate: 'client', runes: true })).not.toThrow();
    expect(() => compile(home, { filename: HOME, generate: 'server', runes: true })).not.toThrow();
    // A file with no empty slot has no such state, and no exported file has any.
    expect(generateProject(s, { instrument: true }).get(LAYOUT)).not.toContain('so_editing');
    for (const [path, src] of generateProject(s)) expect(src, path).not.toMatch(EDITOR_ONLY);
  });

  it('keeps its state apart from a component’s own properties, whatever they are called', () => {
    const { s, defId } = holder();
    const dev = generateProject(s, { instrument: true });
    const file = [...dev.values()].find((src) => src.includes(`siteorigin/components/${defId}/component.json`))!;
    expect(file).toContain('{#if so_editing}');
    // The properties called "so_editing" and "globalThis" have locals of their own; "document" leaves the page's alone.
    expect(file.match(/let so_editing = \$state\(false\);/g)).toHaveLength(1);
    expect(file).toMatch(/so_editing: prop_so_editing = /);
    expect(file).toMatch(/globalThis: prop_globalThis = /);
    expect(file).toContain('globalThis.document.documentElement');
    expect(file).toContain('new globalThis.MutationObserver(sync)');
    expect(() => compile(file, { filename: 'Holder.svelte', generate: 'client', runes: true })).not.toThrow();
    // Exported, the property keeps its name, and nothing of the editor's state is there.
    for (const [path, src] of generateProject(s)) expect(src, path).not.toMatch(/let so_editing|data-so-editing|so-slot-empty|data-so-editor-only|data-so-empty-layout/);
  });
});

describe('a click on an empty container’s frame', () => {
  it('selects the container at once, where a click on a container with content steps in from the section', () => {
    const { s, owner, section, ids } = site();
    const at = (instancePath: string[], nodeId: string) => ({ owner, instancePath, nodeId });
    const sectionDef = s.components[(s.pages[owner.id].nodes[section] as InstanceNode).definitionId];
    const inner = sectionDef.parts.container.nodeId;
    // What the bridge reports for a click: innermost first, up to the section.
    const chain = (state: ProjectState, id: string) => [descOf(state, at([], id)), descOf(state, at([section], inner)), descOf(state, at([], section))];
    const strip = (r: ReturnType<typeof selectionFromChain>) => r && { owner: r.owner, instancePath: r.instancePath, nodeId: r.nodeId };
    expect(strip(selectionFromChain(s, chain(s, ids.grid), null, false))).toEqual(at([], ids.grid));
    // With the section selected, or the grid itself, it stays the grid.
    expect(strip(selectionFromChain(s, chain(s, ids.grid), at([], section), false))).toEqual(at([], ids.grid));
    expect(strip(selectionFromChain(s, chain(s, ids.grid), at([], ids.grid), false))).toEqual(at([], ids.grid));
    // Filled, a click on the grid's own space steps in one level at a time again: the section first.
    const filled = applyOperations(s, [{ type: 'node.insert', owner, parentId: ids.grid, primitive: 'paragraph', text: 'In the grid' }]).state;
    expect(strip(selectionFromChain(filled, chain(filled, ids.grid), null, false))).toEqual(at([], section));
    // Something under the pointer the project no longer has (stale, inside the grid) is not the grid's frame.
    const stale = [{ ...descOf(s, at([], ids.grid))!, node: 'gone' }, ...chain(s, ids.grid)];
    expect(strip(selectionFromChain(s, stale, null, false))).toEqual(at([], section));
  });

  it('steps in as to any part when the empty container is in a placed component’s design, which Insert cannot fill', () => {
    const { s: base, owner, section, ids } = site();
    const made = applyOperations(base, [{ type: 'component.createFromNode', owner, nodeId: ids.row, name: 'Empty row' }]);
    const s = made.state;
    const placement = made.results[0].nodeId as string;
    const root = s.components[made.results[0].definitionId as string].tree!.rootIds[0];
    expect(isEmptyLayout(s.components[made.results[0].definitionId as string].tree!.nodes[root])).toBe(true);
    const at = (instancePath: string[], nodeId: string) => ({ owner, instancePath, nodeId });
    const inner = s.components[(s.pages[owner.id].nodes[section] as InstanceNode).definitionId].parts.container.nodeId;
    const chain = [descOf(s, at([placement], root)), descOf(s, at([section], inner)), descOf(s, at([], section))];
    const strip = (r: ReturnType<typeof selectionFromChain>) => r && { owner: r.owner, instancePath: r.instancePath, nodeId: r.nodeId };
    expect(strip(selectionFromChain(s, chain, null, false))).toEqual(at([], section));
  });
});

describe('a change only the editor’s variant shows, in a project the preview reads directly', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('touches the visitor’s file, unchanged, so the preview loads the new variant', async () => {
    const { s: start, owner, ids } = site();
    const dir = mkdtempSync(join(tmpdir(), 'so-frames-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, start);
    const file = join(dir, HOME);
    const variant = join(dir, '.siteorigin/cache/dev', HOME);
    expect(readFileSync(variant, 'utf8')).toContain('data-so-empty-layout="Grid"');
    const before = readFileSync(file, 'utf8');
    const long = new Date('2001-01-01T00:00:00Z');
    utimesSync(file, long, long);
    // Arranged as a Row: the visitor's file is the same (its styles are in the stylesheet), the editor's names a Row.
    const r = await session.apply({ operations: [{ type: 'node.setStyle', owner, nodeId: ids.grid, scope: 'base', property: 'layout', value: 'row' }] }, { label: 'Arrange' });
    expect(r.ok).toBe(true);
    expect(readFileSync(variant, 'utf8')).toContain('data-so-empty-layout="Row"');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBeGreaterThan(long.getTime());
    // A change the variant does not show either leaves the file alone.
    utimesSync(file, long, long);
    const token = await session.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }] }, { label: 'Add style' });
    expect(token.ok).toBe(true);
    expect(statSync(file).mtimeMs).toBe(long.getTime());
    await session.close();
  });
});
