import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError, enclosingRepeatProp } from '@engine/tree';
import { validateState } from '@engine/validate';
import { defFile, generateProject, overrideClass } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const firstInstance = (s: ProjectState, componentId: string) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const otherPage = (s: ProjectState) => s.site.pageOrder.find((id) => id !== s.site.homePageId)!;
const headerInst = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
const rejects = (fn: () => unknown, msg: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error('expected the operation to be rejected');
};

describe('section anchors', () => {
  it('puts a section anchor on its component root as an id', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: '#pricing' }]).state;
    expect(home(s).nodes[hero.id].anchor).toBe('pricing');
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s);
    expect(files.get('src/routes/+page.svelte')).toContain('so_id={"pricing"}');
    const comp = files.get(defFile(s.components[hero.definitionId]))!;
    expect(comp).toContain('so_id = undefined,');
    expect(comp).toMatch(/id=\{so_id\}/);
  });

  it('keeps anchors unique and leaves them off duplicates', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const grid = firstInstance(s, 'features.grid');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'top' }]).state;
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: grid.id, field: 'anchor', value: 'top' }]), /already uses/);
    const r = applyOperations(s, [{ type: 'node.duplicate', owner: owner(s), nodeId: hero.id }]);
    expect(home(r.state).nodes[r.results[0].nodeId as string].anchor).toBeUndefined();
  });

  it('keeps anchors unique across a page, its shared header and footer, and the layout', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const footer = s.site.shell.footer.rootIds[0];
    s = applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footer, field: 'anchor', value: 'contact' }]).state;
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'contact' }]), /already uses/);
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'main' }]), /used by the site/);
    // Setting an element's own anchor again is not a clash with itself.
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footer, field: 'anchor', value: 'contact' }])).not.toThrow();
  });

  it('refuses anchors on code components', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id }]).state;
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'x' }]), /code components/);
  });
});

describe('code component overrides', () => {
  it('styles a code component root through an override class it receives', () => {
    let s = fresh();
    const h = headerInst(s);
    const shell = { kind: 'shell' as const, id: 'header' };
    s = applyOperations(s, [{ type: 'node.setStyle', owner: shell, nodeId: h.id, partId: 'root', scope: 'base', property: 'background', value: { token: 'color.surface-alt' } }]).state;
    const files = generateProject(s);
    const cls = overrideClass(h.id, 'root');
    expect(files.get('src/routes/+layout.svelte')).toContain(`class={"${cls}"}`);
    expect(files.get('src/routes/+layout.svelte')).toContain(`so_o={{"root":"${cls}"}}`);
    expect(files.get('src/lib/siteorigin/styles/site.css')).toContain(`.${cls}.${cls}.${cls}`);
    rejects(() => applyOperations(s, [{ type: 'node.setStyle', owner: shell, nodeId: h.id, partId: 'logo', scope: 'base', property: 'background', value: '#ff0000' }]), /has no part/);
    s = applyOperations(s, [{ type: 'node.resetStyles', owner: shell, nodeId: h.id, partId: 'root', scope: 'base' }]).state;
    expect(headerInst(s).overrides).toBeUndefined();
    // The header places the class it is given on its root element, which is what makes the override land.
    expect(s.components[h.definitionId].source).toMatch(/<header class=\{\[[^\]]*className\]\}/);
  });

  it('never gives a code component a second class attribute', () => {
    let s = fresh();
    s = applyOperations(s, [{ type: 'component.createCode', name: 'Badge', source: '<script>\n\tlet { class: cls = \'\' } = $props();\n</script>\n<span class={cls}>Hi</span>\n', properties: { class: { type: 'string', label: 'Class', default: '' } } }]).state;
    const defId = Object.values(s.components).find((d) => d.name === 'Badge')!.id;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, definitionId: defId }]);
    s = ins.state;
    const id = ins.results[0].nodeId as string;
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'root', scope: 'base', property: 'opacity', value: 0.5 }]).state;
    const page = generateProject(s).get('src/routes/+page.svelte')!;
    const at = page.indexOf(overrideClass(id, 'root'));
    const tag = page.slice(page.lastIndexOf('<C_', at), page.indexOf('/>', at));
    expect(tag).toContain('so_o=');
    expect(tag.match(/\bclass=/g) ?? []).toHaveLength(1);
  });

  it('passes declared-part override classes to code components', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id }]).state;
    const def = s.components[(home(s).nodes[hero.id] as InstanceNode).definitionId];
    def.parts.heading = { nodeId: 'heading', label: 'Heading' };
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'heading', scope: 'phone', property: 'hidden', value: true }]).state;
    const page = generateProject(s).get('src/routes/+page.svelte')!;
    expect(page).toContain(`so_o={{"heading":"${overrideClass(hero.id, 'heading')}"}}`);
  });
});

describe('copy and paste', () => {
  it('copies a section to another page with new node and item IDs', () => {
    let s = fresh();
    const grid = firstInstance(s, 'features.grid');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: grid.id, field: 'anchor', value: 'services' }]).state;
    const to = otherPage(s);
    const before = s.pages[to].rootIds.length;
    const r = applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: grid.id, toOwner: { kind: 'page', id: to }, parentId: null, index: 0 }]);
    const id = r.results[0].nodeId as string;
    const copy = r.state.pages[to].nodes[id] as InstanceNode;
    expect(r.state.pages[to].rootIds).toHaveLength(before + 1);
    expect(r.state.pages[to].rootIds[0]).toBe(id);
    expect(id).not.toBe(grid.id);
    expect(copy.definitionId).toBe(grid.definitionId);
    expect(copy.anchor).toBe('services');
    const oldItems = (grid.props.items as Array<{ id: string; title: string }>).map((i) => i.id);
    const newItems = copy.props.items as Array<{ id: string; title: string }>;
    expect(newItems.map((i) => i.title)).toEqual((grid.props.items as Array<{ title: string }>).map((i) => i.title));
    expect(newItems.some((i) => oldItems.includes(i.id))).toBe(false);
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
    // Pasting again on the same page keeps the first copy's anchor and leaves the second without one.
    const again = applyOperations(r.state, [{ type: 'node.copy', owner: owner(s), nodeId: grid.id, toOwner: { kind: 'page', id: to } }]);
    expect(again.state.pages[to].nodes[again.results[0].nodeId as string].anchor).toBeUndefined();
  });

  it('refuses to copy the shared header or content out of a definition', () => {
    const s = fresh();
    const h = headerInst(s);
    rejects(() => applyOperations(s, [{ type: 'node.copy', owner: { kind: 'shell', id: 'header' }, nodeId: h.id, toOwner: owner(s) }]), /Only content on a page/);
  });

  it('refuses a copy that would make a component contain itself, even through code converted from it', () => {
    let s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: grid.definitionId }]);
    s = fork.state;
    const defId = fork.results[0].definitionId as string;
    const inner = s.components[defId].tree!.rootIds[0];
    rejects(() => applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: grid.id, toOwner: { kind: 'component', id: defId }, parentId: inner }]), /contain itself/);
    // The same section converted to code still renders the design it came from.
    const hero = firstInstance(s, 'hero.split');
    const wrap = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: hero.id, name: 'Wrapper' }]);
    s = wrap.state;
    const wrapId = wrap.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: wrap.results[0].nodeId as string }]).state;
    const heroDef = s.components[hero.definitionId];
    const heroFork = applyOperations(s, [{ type: 'component.fork', definitionId: heroDef.id }]);
    s = heroFork.state;
    const heroOwn = heroFork.results[0].definitionId as string;
    // Point the wrapper's design at the project copy of the hero, as a fork does for its uses.
    for (const n of Object.values(s.components[wrapId].tree!.nodes)) if (n.kind === 'instance') n.definitionId = heroOwn;
    const codeInst = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.provenance?.forkedFrom === wrapId)!;
    const heroRoot = s.components[heroOwn].tree!.rootIds[0];
    rejects(() => applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: codeInst.id, toOwner: { kind: 'component', id: heroOwn }, parentId: heroRoot }]), /contain itself/);
    rejects(() => applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: grid.id, toOwner: { kind: 'component', id: heroOwn } }]), /inside the component/);
  });
});

describe('multi-list definitions', () => {
  it('finds the list a footer contact link repeats over', () => {
    const s = fresh();
    const footer = s.components[(s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode).definitionId];
    expect(enclosingRepeatProp(footer, 'contact-link')).toBe('contact');
    expect(enclosingRepeatProp(footer, 'explore-link')).toBe('links');
    expect(enclosingRepeatProp(footer, 'copyright')).toBeUndefined();
  });
});
