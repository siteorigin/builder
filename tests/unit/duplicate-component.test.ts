import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { instancesOf } from '@engine/tree';
import { applyOperations } from '@engine/apply';
import { developerModeReason } from '@engine/developer-mode';
import { ProjectSession } from '../../src/main/project/session';
import { canDuplicate, duplicateName, duplicateOperation } from '../../src/renderer/src/lib/duplicate-component';
import { foundationDesign, projectDesign } from './fixtures/packs';

/** Duplicate component (issue #746): what the dialog sends, the name it suggests, and where it is offered. */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A business site, with the definition its Home page's first section places, which comes with the theme. */
function business() {
  const state = createStarterState('business', 'Copies', false);
  const page = state.pages[state.site.homePageId];
  const node = page.rootIds.map((id) => page.nodes[id]).find((n): n is InstanceNode => n.kind === 'instance')!;
  return { state, themeDef: state.components[node.definitionId] };
}

/** The same site with that definition copied into the project as "Service card". */
function withServiceCard() {
  const { state, themeDef } = business();
  const out = applyOperations(state, [{ type: 'component.duplicate', definitionId: themeDef.id, name: 'Service card' }]);
  const id = out.results[0].definitionId as string;
  return { state: out.state, def: out.state.components[id] };
}

const named = (state: ProjectState, name: string) => applyOperations(state, [{ type: 'component.duplicate', definitionId: Object.keys(state.components)[0], name }]).state;

describe('the name a duplicate is offered', () => {
  it('adds "copy", then numbers it past every name already taken, whatever its case', () => {
    let { state } = withServiceCard();
    expect(duplicateName(state, 'Service card')).toBe('Service card copy');
    state = named(state, 'SERVICE CARD COPY ');
    expect(duplicateName(state, 'Service card')).toBe('Service card copy 2');
    state = named(state, 'Service card copy 2');
    expect(duplicateName(state, 'Service card')).toBe('Service card copy 3');
    // A copy of a copy carries on the series.
    expect(duplicateName(state, 'Service card copy 2')).toBe('Service card copy 3');
    expect(duplicateName(state, 'Service card COPY')).toBe('Service card copy 3');
  });

  it('stays within the name limit without splitting a character, and never comes out empty', () => {
    const { state } = business();
    expect(duplicateName(state, `${'x'.repeat(51)}😀yyyyyyy`)).toBe(`${'x'.repeat(51)} copy`);
    expect(duplicateName(state, 'x'.repeat(60))).toBe(`${'x'.repeat(52)} copy`);
    expect(duplicateName(state, `${'x'.repeat(51)} yyyyyyyy`)).toBe(`${'x'.repeat(51)} copy`);
    // A long series keeps one stem, so duplicating a numbered copy carries it on.
    let long = named(state, duplicateName(state, 'x'.repeat(60)));
    const second = duplicateName(long, 'x'.repeat(60));
    expect(second).toBe(`${'x'.repeat(52)} copy 2`);
    long = named(long, second);
    expect(duplicateName(long, second)).toBe(`${'x'.repeat(52)} copy 3`);
    expect(duplicateName(state, '   ')).toBe('Component copy');
  });
});

describe('what the Duplicate dialog sends', () => {
  it('copies the definition and leaves every placement on the original; Undo and Redo keep the ID', async () => {
    const { state, def } = withServiceCard();
    const owner = { kind: 'page' as const, id: state.site.homePageId };
    const placed = applyOperations(state, [
      { type: 'node.insert', owner, definitionId: def.id },
      { type: 'node.insert', owner, definitionId: def.id }
    ]).state;
    const dir = mkdtempSync(join(tmpdir(), 'so-duplicate-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, placed);
    const original = structuredClone(s.state.components[def.id]);
    const uses = () => instancesOf(s.state, def.id).map((u) => u.node.id);
    const before = uses();
    expect(before).toHaveLength(2);
    const pages = structuredClone(s.state.pages);

    const suggested = duplicateName(s.state, original.name);
    const op = duplicateOperation(s.state, s.state.components[def.id], suggested, suggested);
    expect(op).toEqual({ type: 'component.duplicate', definitionId: def.id, name: 'Service card copy' });
    const r = await s.apply({ operations: [op] }, { label: 'Duplicate component Service card' });
    expect(r.ok).toBe(true);
    const id = r.results![0].definitionId as string;
    const copy = s.state.components[id];
    expect(id).not.toBe(def.id);
    expect(copy).toMatchObject({ name: 'Service card copy', owner: 'project', provenance: { forkedFrom: def.id } });
    // Everything but what makes it a component of its own: properties and defaults, design, parts, variants, the rest.
    // Foundation's hero is code, so the copy's source is the original's, in a file of its own.
    const contract = ({ id: _id, name: _name, componentId: _componentId, owner: _owner, category: _category, provenance: _provenance, sourcePath: _sourcePath, ...rest }: ComponentDefinition) => rest;
    expect(original.sourcePath).toBeTruthy();
    expect(copy.sourcePath).toBeTruthy();
    expect(copy.sourcePath).not.toBe(original.sourcePath);
    expect(Object.keys(original.variantAxes ?? {}).length).toBeGreaterThan(0);
    expect(contract(copy)).toEqual(contract(original));
    expect(uses()).toEqual(before);
    expect(instancesOf(s.state, id)).toEqual([]);
    expect(s.state.pages).toEqual(pages);
    expect(s.state.components[def.id]).toEqual(original);

    await s.undo();
    expect(s.state.components[id]).toBeUndefined();
    expect(uses()).toEqual(before);
    await s.redo();
    expect(s.state.components[id]).toEqual(copy);
    expect(s.state.pages).toEqual(pages);
  });

  it('sends a name the author chose as it is, and settles an untouched suggestion against the project as it is by then', () => {
    const { state, def } = withServiceCard();
    const suggested = duplicateName(state, def.name);
    const later = named(state, suggested);
    expect(duplicateOperation(later, def, suggested, suggested)).toMatchObject({ name: 'Service card copy 2' });
    expect(duplicateOperation(later, def, 'Service card (wide)', suggested)).toMatchObject({ name: 'Service card (wide)' });
    expect(duplicateOperation(later, def, 'Service card', suggested)).toMatchObject({ name: 'Service card' });
  });

  it('is refused for a code component outside Developer mode, with the reason shown, and nothing changes', async () => {
    const { state, def } = withServiceCard();
    const code = structuredClone(state);
    Object.assign(code.components[def.id], { kind: 'code', source: '<div></div>', sourcePath: 'src/lib/components/custom/ServiceCard.svelte' });
    delete code.components[def.id].tree;
    // Code that takes none of the design's variant axes declares none.
    delete code.components[def.id].variantAxes;
    const op = duplicateOperation(code, code.components[def.id], 'Service card copy', 'Service card copy');
    const reason = developerModeReason(code, op)!;
    expect(reason).toBe('“Service card” is a code component. Duplicating it copies its Svelte source into a new code component, which needs Developer mode.');
    const dir = mkdtempSync(join(tmpdir(), 'so-duplicate-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, code);
    const components = structuredClone(s.state.components);
    const r = await s.apply({ operations: [op] }, { label: 'Duplicate component Service card', codeAllowed: false });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe(`${reason} Turn on Developer mode in Settings to work with code.`);
    expect(s.state.components).toEqual(components);
    // Developer mode is what it lacks: with it, the same change applies.
    expect((await s.apply({ operations: [op] }, { label: 'Duplicate component Service card', codeAllowed: true })).ok).toBe(true);
  });
});

describe('where Duplicate is offered', () => {
  it('offers managed components, theme ones included, code only in Developer mode, and never the header or footer', () => {
    const { state, themeDef } = business();
    const { def } = withServiceCard();
    // A theme's managed design; Foundation's own sections are code, offered like any other code.
    const designed = foundationDesign({ componentId: 'designed.card', name: 'Card', properties: {}, parts: { root: { nodeId: 'root', label: 'Card' } }, build: (b) => b.el('root', 'div', {}, []) });
    expect(designed.owner).toBe('theme');
    expect(canDuplicate(designed, false)).toBe(true);
    expect(canDuplicate(projectDesign(structuredClone(state), { componentId: 'project.card', name: 'Card', properties: {}, parts: { root: { nodeId: 'root', label: 'Card' } }, build: (b) => b.el('root', 'div', {}, []) }), false)).toBe(true);
    expect(themeDef).toMatchObject({ owner: 'theme', kind: 'code' });
    expect([canDuplicate(themeDef, false), canDuplicate(themeDef, true)]).toEqual([false, true]);
    expect(canDuplicate({ ...def, kind: 'code' }, false)).toBe(false);
    expect(canDuplicate({ ...def, kind: 'code' }, true)).toBe(true);
    const shell = Object.values(state.components).filter((d) => d.category === 'shell');
    expect(shell.length).toBeGreaterThan(0);
    for (const d of shell) expect([canDuplicate(d, false), canDuplicate(d, true)]).toEqual([false, false]);
  });
});
