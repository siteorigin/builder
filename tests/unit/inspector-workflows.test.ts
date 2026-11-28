import { describe, expect, it } from 'vitest';
import type { ElementNode, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, captureClipboard } from '@engine/apply';
import { EngineError, anchorCapable, codeTakesOverrides, enclosingRepeatProp, entranceCapable } from '@engine/tree';
import { validateState } from '@engine/validate';
import { defFile, generateProject, overrideClass } from '@generator/index';
import { pageSections, planSectionPick } from '@generator/checks';
import { columnLayoutPart } from '@shared/styles';
import { P, item, prop } from '@catalogue/dsl';
import { foundationDesign, projectDesign } from './fixtures/packs';
import { contentSection, installThemeDesigns, placeOnHome, servicesGrid, splitHero, statsRow } from './fixtures/inspector-workflows-designs';

const fresh = () => createStarterState('business', 'Test Studio', false);
/**
 * The business starter with designs built in the editor installed as Foundation's own and placed first on Home, in
 * this order: a Split hero (test.hero), a Services grid (test.grid) and Statistics (test.stats); and an empty Section
 * (test.section) installed. Foundation's own sections are code components, which have no design to
 * paste into, so what copy and paste do with a design's tree is checked on these.
 */
const managed = () => {
  const s = fresh();
  const [hero, grid, stats] = installThemeDesigns(s, splitHero(), servicesGrid(), statsRow(), contentSection());
  [hero, grid, stats].forEach((def, i) => placeOnHome(s, def, i));
  return s;
};
const SECTION = 'foundation.test.section';
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
  /** The managed designs on Home, with an empty Section (test.section) placed in the shared footer. */
  const withFooterSection = () => {
    let s = managed();
    s = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, parentId: null, definitionId: SECTION }]).state;
    const footer = s.site.shell.footer;
    return { s, footer: footer.rootIds.find((id) => (footer.nodes[id] as InstanceNode).definitionId === SECTION)! };
  };

  it('puts a section anchor on its component root as an id', () => {
    let s = managed();
    const hero = firstInstance(s, 'test.hero');
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
    let s = managed();
    const hero = firstInstance(s, 'test.hero');
    const grid = firstInstance(s, 'test.grid');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'top' }]).state;
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: grid.id, field: 'anchor', value: 'top' }]), /already uses/);
    const r = applyOperations(s, [{ type: 'node.duplicate', owner: owner(s), nodeId: hero.id }]);
    expect(home(r.state).nodes[r.results[0].nodeId as string].anchor).toBeUndefined();
  });

  it('keeps anchors unique across a page, its shared header and footer, and the layout', () => {
    let { s, footer } = withFooterSection();
    const hero = firstInstance(s, 'test.hero');
    s = applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footer, field: 'anchor', value: 'contact' }]).state;
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'contact' }]), /already uses/);
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'main' }]), /used by the site/);
    // Setting an element's own anchor again is not a clash with itself.
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footer, field: 'anchor', value: 'contact' }])).not.toThrow();
  });

  it('puts a section anchor on a section of the shipped theme, which renders it as its id', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    expect(s.components[hero.definitionId].source).toMatch(/id=\{so_id\}/);
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: '#pricing' }]).state;
    expect(home(s).nodes[hero.id].anchor).toBe('pricing');
    expect(generateProject(s).get('src/routes/+page.svelte')).toContain('so_id={"pricing"}');
  });

  it('puts a section anchor on the shipped theme’s footer', () => {
    const s = fresh();
    const footer = s.site.shell.footer.rootIds[0];
    expect(applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'shell', id: 'footer' }, nodeId: footer, field: 'anchor', value: 'contact' }]).state.site.shell.footer.nodes[footer].anchor).toBe('contact');
  });

  it('puts an anchor on code that places id={so_id}, and refuses it on code that places none', () => {
    let s = managed();
    const hero = firstInstance(s, 'test.hero');
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id }]).state;
    // A design converted to code places the placement's id on its root, as the theme's sections do.
    const def = s.components[(home(s).nodes[hero.id] as InstanceNode).definitionId];
    expect(def.source).toMatch(/id=\{so_id/);
    expect(applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'x' }]).state.pages[s.site.homePageId].nodes[hero.id].anchor).toBe('x');
    def.source = def.source!.replace(/\s+id=\{\s*so_id[^}]*\}/g, '');
    expect(def.source).not.toMatch(/id=\{\s*so_id/);
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'x' }]), /code components/);
  });
});

describe('which components take an anchor', () => {
  it('reads code for an element placing id={so_id}, and never takes an entrance on it', () => {
    const s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const def = s.components[hero.definitionId];
    const as = (source: string) => ({ ...def, source });
    expect(anchorCapable(s, def)).toBe(true);
    expect(anchorCapable(s, as('<section class="x" id={so_id}></section>'))).toBe(true);
    expect(anchorCapable(s, as('<section id={ so_id ?? "top" }></section>'))).toBe(true);
    // Another attribute holding it, or code that never places it, gives links nothing to jump to.
    expect(anchorCapable(s, as('<section id = {so_id}></section>'))).toBe(true);
    expect(anchorCapable(s, as("<section id={so_id || 'top'}></section>"))).toBe(true);
    // Another attribute holding it, another value made from it, or code that never places it: nothing to jump to. Code
    // that hands it on to a component it places cannot say whether that one renders it.
    expect(anchorCapable(s, as('<section data-id={so_id}></section>'))).toBe(false);
    expect(anchorCapable(s, as('<section myid={so_id}></section>'))).toBe(false);
    expect(anchorCapable(s, as('<Inner so_id={so_id} />'))).toBe(false);
    expect(anchorCapable(s, as('<section id={so_id_suffix}></section>'))).toBe(false);
    expect(anchorCapable(s, as("<section id={so_id + '-x'}></section>"))).toBe(false);
    expect(anchorCapable(s, as('<section id={sectionId}></section>'))).toBe(false);
    expect(anchorCapable(s, as(''))).toBe(false);
    expect(entranceCapable(s, def)).toBe(false);
  });

  it('clears an anchor that code no longer places, and refuses a new one', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'top' }]).state;
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: hero.id }]);
    s = r.state;
    const def = s.components[(home(s).nodes[hero.id] as InstanceNode).definitionId];
    expect(def).toMatchObject({ kind: 'code', owner: 'project' });
    def.source = def.source!.replace(/\s+id=\{\s*so_id[^}]*\}/g, '');
    rejects(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: 'other' }]), /code components/);
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: hero.id, field: 'anchor', value: '' }]).state;
    expect(Object.hasOwn(home(s).nodes[hero.id], 'anchor')).toBe(false);
  });

  it('names a theme Section by its own heading after a theme block inside it, with the block under it', () => {
    const s0 = fresh();
    const page: OwnerRef = { kind: 'page', id: s0.site.homePageId };
    const r = applyOperations(s0, [{ type: 'node.insert', owner: page, parentId: null, index: 0, componentId: 'layout.section' }]);
    const section = r.results[0].nodeId as string;
    const inner = applyOperations(r.state, [
      { type: 'node.insert', owner: page, parentId: section, slot: 'content', index: 0, componentId: 'block.callout' },
      { type: 'node.insert', owner: page, parentId: section, slot: 'content', index: 1, primitive: 'heading', text: 'Opening hours' }
    ]);
    const s = inner.state;
    const callout = inner.results[0].nodeId as string;
    const listed = pageSections(s, page.id);
    expect(listed.find((x) => x.nodeId === section)).toMatchObject({ label: 'Opening hours', nested: false });
    expect(listed.find((x) => x.nodeId === callout)).toMatchObject({ nested: true });
    expect(planSectionPick(s, page.id, section)?.anchor).toBe('opening-hours');
  });

  it('never names a wrapper by a heading its own design shows after a theme block placed in it', () => {
    let s = fresh();
    const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
    const wrap = projectDesign(s, {
      componentId: 'project.wrap',
      name: 'Wrap',
      properties: {},
      slots: { content: { label: 'Content' } },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'div', {}, [b.slot('content-slot', 'content'), b.el('inner', 'section', {}, [b.text('heading', 'h2', 'Inner heading')])])
    });
    const r = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: null, index: 0, definitionId: wrap.id }]);
    const wrapper = r.results[0].nodeId as string;
    s = applyOperations(r.state, [{ type: 'node.insert', owner: page, parentId: wrapper, slot: 'content', index: 0, componentId: 'block.callout' }]).state;
    expect(pageSections(s, page.id).find((x) => x.nodeId === wrapper)).toBeUndefined();
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
    const source = '<script>\n\tlet { class: cls = \'\' } = $props();\n</script>\n<span class={cls}>Hi</span>\n';
    // "class" can never be a declared property, so it cannot be emitted twice that way either.
    expect(() => applyOperations(s, [{ type: 'component.createCode', name: 'Badge', source, properties: { class: { type: 'string', label: 'Class', default: '' } } }])).toThrow(/reserved/);
    s = applyOperations(s, [{ type: 'component.createCode', name: 'Badge', source }]).state;
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
    // Foundation's Split hero is a code component that declares its heading as a part.
    const hero = firstInstance(s, 'hero.split');
    const def = s.components[hero.definitionId];
    expect(def.kind).toBe('code');
    expect(def.parts.heading).toMatchObject({ nodeId: 'heading' });
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'heading', scope: 'phone', property: 'hidden', value: true }]).state;
    const page = generateProject(s).get('src/routes/+page.svelte')!;
    expect(page).toContain(`so_o={{"heading":"${overrideClass(hero.id, 'heading')}"}}`);
  });
});

describe('copy and paste', () => {
  it('copies a section to another page with new node and item IDs', () => {
    let s = managed();
    const grid = firstInstance(s, 'test.grid');
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
    let s = managed();
    const grid = firstInstance(s, 'test.grid');
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: grid.definitionId }]);
    s = fork.state;
    const defId = fork.results[0].definitionId as string;
    const inner = s.components[defId].tree!.rootIds[0];
    rejects(() => applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: grid.id, toOwner: { kind: 'component', id: defId }, parentId: inner }]), /contain itself/);
    // The same section converted to code still renders the design it came from.
    const hero = firstInstance(s, 'test.hero');
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

describe('paste what was copied (#62)', () => {
  const to = (s: ProjectState) => ({ kind: 'page' as const, id: otherPage(s) });
  const items = (n: InstanceNode) => n.props.items as Array<{ id: string; title: string }>;
  const paste = (s: ProjectState, clip: ReturnType<typeof captureClipboard>, toOwner: OwnerRef = to(s), extra: { parentId?: string | null; index?: number } = {}) =>
    applyOperations(s, [{ type: 'node.paste', clipboardId: clip.id, toOwner, ...extra }], { clipboards: [clip] });
  const pasted = (r: ReturnType<typeof paste>, pageId: string, definitionId?: string) => (definitionId ? r.state.components[definitionId].tree!.nodes : r.state.pages[pageId].nodes)[r.results[0].nodeId as string] as InstanceNode;
  /** A section holding a button and an image, to copy. */
  const sectionWith = (s: ProjectState, content: { link?: unknown; image?: unknown }) => {
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
    const section = r.results[0].nodeId as string;
    let next = r.state;
    if (content.link) {
      const b = applyOperations(next, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'button', text: 'Go' }]);
      next = applyOperations(b.state, [{ type: 'node.setContent', owner: owner(s), nodeId: b.results[0].nodeId as string, field: 'link', value: content.link }]).state;
    }
    if (content.image) {
      const i = applyOperations(next, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'image' }]);
      next = applyOperations(i.state, [{ type: 'node.setContent', owner: owner(s), nodeId: i.results[0].nodeId as string, field: 'image', value: content.image }]).state;
    }
    return { s: next, section };
  };

  it('pastes a section on another page after the original is deleted, with new IDs and its anchor', () => {
    let s = managed();
    const grid = firstInstance(s, 'test.grid');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: grid.id, field: 'anchor', value: 'services' }]).state;
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    s = applyOperations(s, [{ type: 'node.remove', owner: owner(s), nodeId: grid.id }]).state;
    const r = paste(s, clip, to(s), { parentId: null, index: 0 });
    const copy = pasted(r, otherPage(s));
    expect(r.state.pages[otherPage(s)].rootIds[0]).toBe(copy.id);
    expect(copy.id).not.toBe(grid.id);
    expect(copy.definitionId).toBe(grid.definitionId);
    expect(copy.anchor).toBe('services');
    expect(copy.props.heading).toBe(grid.props.heading);
    expect(items(copy).map((i) => i.title)).toEqual(items(grid).map((i) => i.title));
    expect(items(copy).some((i) => items(grid).some((g) => g.id === i.id))).toBe(false);
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('pastes the content as it was copied, not as it was edited since, every time with fresh IDs', () => {
    let s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const heading = grid.props.heading as string;
    const titles = items(grid).map((i) => i.title);
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    // The copy shares nothing with the document it was taken from, even when that is changed in place.
    items(grid)[1].title = 'Changed in place';
    expect(items(clip.tree.nodes[grid.id] as InstanceNode)[1].title).toBe(titles[1]);
    items(grid)[1].title = titles[1];
    s = applyOperations(s, [
      { type: 'instance.setProp', owner: owner(s), nodeId: grid.id, prop: 'heading', value: 'Edited after copying' },
      { type: 'instance.listRemove', owner: owner(s), nodeId: grid.id, prop: 'items', itemId: items(grid)[0].id }
    ]).state;
    const first = paste(s, clip);
    const second = paste(first.state, clip);
    const a = pasted(first, otherPage(s));
    const b = pasted(second, otherPage(s));
    for (const copy of [a, b]) {
      expect(copy.props.heading).toBe(heading);
      expect(items(copy).map((i) => i.title)).toEqual(titles);
    }
    expect(a.id).not.toBe(b.id);
    expect(items(a).some((i) => items(b).some((x) => x.id === i.id))).toBe(false);
    // The clipboard itself is never changed by a paste, and the edited original keeps its edits.
    expect((clip.tree.nodes[grid.id] as InstanceNode).props.heading).toBe(heading);
    expect((home(second.state).nodes[grid.id] as InstanceNode).props.heading).toBe('Edited after copying');
  });

  it('keeps an anchor on the same page only once the original no longer uses it', () => {
    let s = managed();
    const grid = firstInstance(s, 'test.grid');
    s = applyOperations(s, [{ type: 'node.setContent', owner: owner(s), nodeId: grid.id, field: 'anchor', value: 'services' }]).state;
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    expect(pasted(paste(s, clip, owner(s)), s.site.homePageId).anchor).toBeUndefined();
    const moved = applyOperations(s, [{ type: 'node.remove', owner: owner(s), nodeId: grid.id }]).state;
    expect(pasted(paste(moved, clip, owner(s)), s.site.homePageId).anchor).toBe('services');
  });

  it('pastes after the component is restyled, and refuses once what it takes has changed', () => {
    const base = managed();
    const f = applyOperations(base, [{ type: 'component.fork', definitionId: firstInstance(base, 'test.grid').definitionId }]);
    let s = f.state;
    const defId = f.results[0].definitionId as string;
    const grid = firstInstance(s, 'test.grid');
    expect(grid.definitionId).toBe(defId);
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    const root = s.components[defId].tree!.rootIds[0];
    s = applyOperations(s, [
      { type: 'node.remove', owner: owner(s), nodeId: grid.id },
      { type: 'node.setStyle', owner: { kind: 'component', id: defId }, nodeId: root, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } },
      { type: 'component.rename', definitionId: defId, name: 'Our services' }
    ]).state;
    expect(s.components[defId].tree!.nodes[root].styles?.base?.paddingBlock).toEqual({ token: 'space.lg' });
    expect(pasted(paste(s, clip), otherPage(s)).definitionId).toBe(defId);
    const changed = /content "Services grid" takes has changed since it was copied/;
    const heading = s.components[defId].properties.heading;
    expect(heading.type).toBe('string');
    rejects(() => paste(applyOperations(s, [{ type: 'component.setPropSchema', definitionId: defId, prop: 'heading', schema: { ...heading, maxLength: 999 } }]).state, clip), changed);
    rejects(() => paste(applyOperations(s, [{ type: 'component.setPropSchema', definitionId: defId, prop: 'note', schema: { type: 'string', label: 'Note' } }]).state, clip), changed);
    rejects(() => paste(applyOperations(s, [{ type: 'component.setSlot', definitionId: defId, slot: 'extra', label: 'Extra' }]).state, clip), changed);
  });

  it('drops variant options and parts removed since copying, as from every live placement', () => {
    const f = applyOperations(fresh(), [{ type: 'component.fork', definitionId: firstInstance(fresh(), 'features.grid').definitionId }]);
    const defId = f.results[0].definitionId as string;
    const def = f.state.components[defId];
    const [axis, a] = Object.entries(def.variantAxes!).find(([, x]) => Object.keys(x.options).some((o) => o !== x.default))!;
    const option = Object.keys(a.options).find((o) => o !== a.default)!;
    const part = Object.keys(def.parts).find((p) => p !== 'root')!;
    const grid = firstInstance(f.state, 'features.grid');
    const teal = applyOperations(f.state, [{ type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }]);
    const tokenId = teal.results[0].tokenId as string;
    let s = applyOperations(teal.state, [
      { type: 'instance.setVariant', owner: owner(f.state), nodeId: grid.id, variant: option, axis },
      { type: 'node.setStyle', owner: owner(f.state), nodeId: grid.id, partId: part, scope: 'base', property: 'color', value: { token: tokenId } },
      { type: 'node.setStyle', owner: owner(f.state), nodeId: grid.id, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } }
    ]).state;
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    // Unchanged, the choices come along.
    const kept = pasted(paste(s, clip), otherPage(s));
    expect(kept.variants?.[axis]).toBe(option);
    expect(kept.overrides?.[part]).toBeDefined();
    s = applyOperations(s, [
      { type: 'component.removeVariant', definitionId: defId, variant: option, axis },
      { type: 'component.removePart', definitionId: defId, partId: part },
      // The site style only that part used goes too; the paste no longer needs it.
      { type: 'token.remove', tokenId }
    ]).state;
    const copy = pasted(paste(s, clip), otherPage(s));
    expect(copy.variants?.[axis]).toBeUndefined();
    expect(copy.overrides?.[part]).toBeUndefined();
    expect(copy.overrides?.root).toBeDefined();
  });

  it('pastes inside a project component edited everywhere, inside its root, and nowhere else in it (#200)', () => {
    const base = managed();
    const f = applyOperations(base, [{ type: 'component.fork', definitionId: firstInstance(base, 'test.hero').definitionId }]);
    const defId = f.results[0].definitionId as string;
    const s = f.state;
    const inComponent = { kind: 'component' as const, id: defId };
    const root = s.components[defId].tree!.rootIds[0];
    const stats = firstInstance(s, 'stats.row');
    const clip = captureClipboard(s, s.site.homePageId, stats.id);
    const tree = (st: ProjectState) => st.components[defId].tree!;
    const slotOrChildren = (st: ProjectState, id: string) => {
      const n = tree(st).nodes[id];
      return n.kind === 'element' ? n.children : Object.values((n as InstanceNode).slots ?? {}).flat();
    };
    const before = JSON.stringify(s);
    const r = paste(s, clip, inComponent, { parentId: root });
    const id = r.results[0].nodeId as string;
    // The copy is the component's own node, in its root, with an ID of its own, still a placement of the same section.
    expect(slotOrChildren(r.state, root)).toContain(id);
    expect(id).not.toBe(stats.id);
    expect((tree(r.state).nodes[id] as InstanceNode).definitionId).toBe(stats.definitionId);
    expect(r.state.pages[s.site.homePageId].nodes[stats.id]).toBeDefined();
    expect(validateState(r.state)).toEqual([]);
    // Beside the root, where the component's one designated root would be joined by another, it is refused.
    rejects(() => paste(s, clip, inComponent), /inside the component, not beside its root/);
    // The shared header and footer take no pasted content.
    rejects(() => paste(s, clip, { kind: 'shell', id: 'header' } as never), /shared header and footer take no pasted content/);
    // The footer too, and a theme's own component, which is forked before it is edited.
    rejects(() => paste(s, clip, { kind: 'shell', id: 'footer' } as never), /shared header and footer take no pasted content/);
    rejects(() => paste(s, clip, { kind: 'shell', id: 'header' } as never, { parentId: s.site.shell.header.rootIds[0] }), /shared header and footer take no pasted content/);
    const theme = Object.values(s.components).find((d) => d.owner === 'theme' && d.tree)!;
    rejects(() => paste(s, clip, { kind: 'component', id: theme.id }, { parentId: theme.tree!.rootIds[0] }), /theme component/);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('pastes a group inside a component whole, in order, or not at all (#200)', () => {
    const base = managed();
    const stats = firstInstance(base, 'test.stats');
    // Both are sections of Home, in the page's order: the grid first. Pasted inside the stats design, the grid is fine
    // and the stats section would contain itself, so the second of the pair is what refuses.
    const forked = applyOperations(base, [{ type: 'component.fork', definitionId: stats.definitionId }]);
    const s = forked.state;
    const inStats = { kind: 'component' as const, id: forked.results[0].definitionId as string };
    const root = s.components[inStats.id].tree!.rootIds[0];
    const pair = captureClipboard(s, s.site.homePageId, [firstInstance(s, 'test.grid').id, firstInstance(s, 'test.stats').id]);
    expect(pair.tree.rootIds.map((id) => (s.pages[s.site.homePageId].nodes[id] as InstanceNode).definitionId)).toEqual([firstInstance(s, 'test.grid').definitionId, firstInstance(s, 'test.stats').definitionId]);
    const before = JSON.stringify(s);
    rejects(() => paste(s, pair, inStats, { parentId: root }), /contain itself/);
    expect(JSON.stringify(s)).toBe(before);
    // Pasted inside a design that neither of them is, both go in, in the order they were copied.
    const hero = applyOperations(s, [{ type: 'component.fork', definitionId: firstInstance(s, 'test.hero').definitionId }]);
    const inHero = { kind: 'component' as const, id: hero.results[0].definitionId as string };
    const heroRoot = hero.state.components[inHero.id].tree!.rootIds[0];
    const ok = paste(hero.state, captureClipboard(hero.state, hero.state.site.homePageId, [firstInstance(hero.state, 'test.grid').id, firstInstance(hero.state, 'test.stats').id]), inHero, { parentId: heroRoot });
    const ids = ok.results[0].nodeIds as string[];
    expect(ids).toHaveLength(2);
    const kids = (ok.state.components[inHero.id].tree!.nodes[heroRoot] as { children: string[] }).children;
    expect(kids.slice(-2)).toEqual(ids);
    expect(ids.map((id) => (ok.state.components[inHero.id].tree!.nodes[id] as InstanceNode).definitionId)).toEqual([firstInstance(hero.state, 'test.grid').definitionId, firstInstance(hero.state, 'test.stats').definitionId]);
    // From a position, they go in one after the other from there, not all at it.
    const at = paste(hero.state, captureClipboard(hero.state, hero.state.site.homePageId, [firstInstance(hero.state, 'test.grid').id, firstInstance(hero.state, 'test.stats').id]), inHero, { parentId: heroRoot, index: 0 });
    expect((at.state.components[inHero.id].tree!.nodes[heroRoot] as { children: string[] }).children.slice(0, 2)).toEqual(at.results[0].nodeIds);
  });

  it('keeps no page anchor inside a component, where every placement would repeat it (#200)', () => {
    let s = managed();
    // A section with an anchor of its own, and a heading in it with another.
    const made = applyOperations(s, [
      { type: 'node.insert', newNodeId: 'n_anchored', owner: owner(s), parentId: null, index: 0, definitionId: SECTION },
      { type: 'node.insert', newNodeId: 'n_title', owner: owner(s), parentId: 'n_anchored', slot: 'content', primitive: 'heading', text: 'Numbers' },
      { type: 'node.setContent', owner: owner(s), nodeId: 'n_anchored', field: 'anchor', value: 'figures' },
      { type: 'node.setContent', owner: owner(s), nodeId: 'n_title', field: 'anchor', value: 'numbers-title' }
    ]);
    s = made.state;
    const clip = captureClipboard(s, s.site.homePageId, 'n_anchored');
    // On another page the anchors come along, while nothing there uses them.
    const onPage = paste(s, clip);
    const copy = pasted(onPage, otherPage(s));
    expect(copy.anchor).toBe('figures');
    expect(onPage.state.pages[otherPage(s)].nodes[copy.slots!.content[0]].anchor).toBe('numbers-title');
    const f = applyOperations(s, [{ type: 'component.fork', definitionId: firstInstance(s, 'test.hero').definitionId }]);
    const inHero = { kind: 'component' as const, id: f.results[0].definitionId as string };
    const heroRoot = f.state.components[inHero.id].tree!.rootIds[0];
    // Pasted inside the component, none of the copy keeps one.
    const r = paste(f.state, clip, inHero, { parentId: heroRoot });
    const tree = r.state.components[inHero.id].tree!;
    const section = tree.nodes[r.results[0].nodeId as string] as InstanceNode;
    expect(section.anchor).toBeUndefined();
    expect(section.slots!.content).toHaveLength(1);
    expect(tree.nodes[section.slots!.content[0]].anchor).toBeUndefined();
    // The AI's node.copy into a component is as it was: a unique anchor stays with its copy.
    const aiCopy = applyOperations(f.state, [{ type: 'node.copy', owner: owner(s), nodeId: 'n_anchored', toOwner: inHero, parentId: heroRoot }]);
    expect((aiCopy.state.components[inHero.id].tree!.nodes[aiCopy.results[0].nodeId as string] as InstanceNode).anchor).toBe('figures');
  });

  it('refuses a paste into a component that a pasted code component imports, but not one that only names its file (#200)', () => {
    // A code component that imports the hero's file renders it, though it declares no dependency on it.
    const base = managed();
    const f = applyOperations(base, [{ type: 'component.fork', definitionId: firstInstance(base, 'test.hero').definitionId }]);
    let s = f.state;
    const heroDef = f.results[0].definitionId as string;
    const file = defFile(s.components[heroDef]).split('/').pop()!;
    const place = (name: string, source: string) => {
      const made = applyOperations(s, [{ type: 'component.createCode', name, source, properties: {} }]);
      const placed = applyOperations(made.state, [{ type: 'node.insert', owner: owner(made.state), parentId: null, definitionId: made.results[0].definitionId as string }]);
      s = placed.state;
      return captureClipboard(s, s.site.homePageId, placed.results[0].nodeId as string);
    };
    const into = { kind: 'component' as const, id: heroDef };
    const imports = place('Wrapper', `<script>\n  import Hero from '../generated/${file}';\n</script>\n<Hero />`);
    const mentions = place('Plain', `<!-- Not ../generated/${file}, which this does not use. -->\n<p>Plain</p>`);
    const root = s.components[heroDef].tree!.rootIds[0];
    rejects(() => paste(s, imports, into, { parentId: root }), /contain itself/);
    expect(pasted(paste(s, mentions, into, { parentId: root }), s.site.homePageId, heroDef)).toBeDefined();
  });

  it('names what the copy needs that was removed after copying, and pastes nothing', () => {
    const fork = applyOperations(fresh(), [{ type: 'component.fork', definitionId: firstInstance(fresh(), 'features.grid').definitionId }]);
    let s = fork.state;
    const grid = firstInstance(s, 'features.grid');
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    s = applyOperations(s, [
      { type: 'node.remove', owner: owner(s), nodeId: grid.id },
      { type: 'component.remove', definitionId: fork.results[0].definitionId as string }
    ]).state;
    rejects(() => paste(s, clip), /the copy uses the "Services grid" component, which has been removed since it was copied/);

    const base = fresh();
    const about = otherPage(base);
    expect(base.pages[about].title).toBe('About');
    const linked = sectionWith(base, { link: { type: 'page', target: about } });
    const linkClip = captureClipboard(linked.s, linked.s.site.homePageId, linked.section);
    // While the page is there, the section and the button in its slot paste with new IDs and the same link.
    const ok = paste(linked.s, linkClip);
    const okSection = pasted(ok, otherPage(linked.s));
    const button = ok.state.pages[otherPage(linked.s)].nodes[okSection.slots!.content[0]];
    const source = linked.s.pages[linked.s.site.homePageId].nodes[(linked.s.pages[linked.s.site.homePageId].nodes[linked.section] as InstanceNode).slots!.content[0]];
    expect(button.id).not.toBe(source.id);
    expect(button).toMatchObject({ kind: 'link', link: { type: 'page', target: about } });
    s = applyOperations(linked.s, [
      { type: 'node.remove', owner: owner(linked.s), nodeId: linked.section },
      { type: 'page.remove', pageId: about, replacementPageId: linked.s.site.homePageId }
    ]).state;
    rejects(() => paste(s, linkClip, owner(s)), /links to the "About" page, which has been removed/);

    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    const withAsset = sectionWith(applyOperations(fresh(), [{ type: 'asset.add', asset: pic }]).state, { image: { assetId: 'a_pic', alt: 'A room' } });
    const picClip = captureClipboard(withAsset.s, withAsset.s.site.homePageId, withAsset.section);
    s = applyOperations(withAsset.s, [
      { type: 'node.remove', owner: owner(withAsset.s), nodeId: withAsset.section },
      { type: 'asset.remove', assetId: 'a_pic' }
    ]).state;
    rejects(() => paste(s, picClip, owner(s)), /shows the image "Pic", which has been removed/);

    const styled = applyOperations(fresh(), [{ type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }]);
    s = styled.state;
    const tokenId = styled.results[0].tokenId as string;
    const g = firstInstance(s, 'features.grid');
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: g.id, scope: 'base', property: 'background', value: { token: tokenId } }]).state;
    const tokenClip = captureClipboard(s, s.site.homePageId, g.id);
    s = applyOperations(s, [
      { type: 'node.remove', owner: owner(s), nodeId: g.id },
      { type: 'token.remove', tokenId }
    ]).state;
    rejects(() => paste(s, tokenClip), new RegExp(`uses the site style "${tokenId}", which has been removed`));
  });

  it('refuses a paste without the clipboard it names', () => {
    const s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const clip = captureClipboard(s, s.site.homePageId, grid.id);
    rejects(() => applyOperations(s, [{ type: 'node.paste', clipboardId: clip.id, toOwner: to(s) }]), /Copy it again/);
    rejects(() => applyOperations(s, [{ type: 'node.paste', clipboardId: 'clip_other', toOwner: to(s) }], { clipboards: [clip] }), /Copy it again/);
  });

  it('copies only attached page content, never the shared header', () => {
    const s = fresh();
    rejects(() => captureClipboard(s, s.site.homePageId, 'n_missing'), /does not exist/);
    rejects(() => captureClipboard(s, 'pg_missing', firstInstance(s, 'features.grid').id), /does not exist/);
    const h = headerInst(s);
    rejects(() => captureClipboard(s, s.site.homePageId, h.id), /does not exist/);
  });
});

describe('adding pages to the menu', () => {
  it('adds a new page to the header navigation in the same step', () => {
    const s = fresh();
    const before = (headerInst(s).props.links as unknown[]).length;
    const r = applyOperations(s, [{ type: 'page.create', title: 'Pricing', addToNavigation: true }]);
    const id = r.results[0].pageId as string;
    expect(r.results[0].addedToNavigation).toBe(true);
    const links = headerInst(r.state).props.links as Array<{ id: string; label: string; link: { type: string; target: string } }>;
    expect(links).toHaveLength(before + 1);
    expect(links[links.length - 1]).toMatchObject({ label: 'Pricing', link: { type: 'page', target: id } });
    expect(links[links.length - 1].id).toBeTruthy();
    // Without the option the menu is left alone.
    const plain = applyOperations(s, [{ type: 'page.create', title: 'Quiet' }]);
    expect((headerInst(plain.state).props.links as unknown[]).length).toBe(before);
  });

  it('reports a full menu instead of failing the new page', () => {
    let s = fresh();
    const h = headerInst(s);
    h.props.links = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, label: `L${i}`, link: { type: 'none', target: '' } }));
    const full = structuredClone(h.props.links);
    const r = applyOperations(s, [{ type: 'page.create', title: 'Eleventh', addToNavigation: true }]);
    s = r.state;
    expect(r.results[0].addedToNavigation).toBe(false);
    expect(s.pages[r.results[0].pageId as string]).toBeTruthy();
    expect(headerInst(s).props.links).toEqual(full);
  });
});

describe('which code components take style changes', () => {
  const code = (source: string, owner: 'project' | 'theme' = 'project') => ({ kind: 'code', owner, parts: { root: { nodeId: 'root', label: 'Root' } }, source }) as unknown as Parameters<typeof codeTakesOverrides>[0];
  it('reads the props a project component takes, not class: directives in its markup', () => {
    expect(codeTakesOverrides(code("<script>\n\tlet { heading, class: cls = '' } = $props();\n</script>\n<section class={cls}>{heading}</section>"))).toBe(true);
    expect(codeTakesOverrides(code("<script>\n\tlet { on } = $props();\n</script>\n<section class:active={on}>Hi</section>"))).toBe(false);
    expect(codeTakesOverrides(code('<script>\n\tlet { so_o } = $props();\n</script>\n<p class={so_o?.root}>x</p>'))).toBe(true);
  });
  it('trusts a theme component only when its root declares style controls', () => {
    const s = fresh();
    expect(codeTakesOverrides(s.components[headerInst(s).definitionId])).toBe(true);
    expect(codeTakesOverrides(code('<header class={className}></header>', 'theme'))).toBe(false);
  });
});

describe('multi-list definitions', () => {
  it('finds the list a footer contact link repeats over', () => {
    // A footer built in the editor with two link lists, each repeated in its own group, and a copyright line.
    const link = { label: P.str('Label', 'Link'), link: P.link('Link') };
    const footer = foundationDesign({
      componentId: 'test.footer',
      name: 'Footer',
      properties: { contact: P.list('Contact', 'Contact link', link, [{ label: 'Email us' }]), links: P.list('Explore', 'Link', link, [{ label: 'About' }]), copyright: P.str('Copyright', '© Studio') },
      parts: { root: { nodeId: 'root', label: 'Footer' } },
      build: (b) =>
        b.el('root', 'footer', { name: 'Footer' }, [
          b.el('contact', 'ul', { name: 'Contact' }, [b.repeat('contact-items', 'contact', [b.link('contact-link', item('link'), item('label'), 'text', { name: 'Contact link' })])]),
          b.el('explore', 'ul', { name: 'Explore' }, [b.repeat('explore-items', 'links', [b.link('explore-link', item('link'), item('label'), 'text', { name: 'Link' })])]),
          b.text('copyright', 'p', prop('copyright'), { name: 'Copyright' })
        ])
    });
    expect(enclosingRepeatProp(footer, 'contact-link')).toBe('contact');
    expect(enclosingRepeatProp(footer, 'explore-link')).toBe('links');
    expect(enclosingRepeatProp(footer, 'copyright')).toBeUndefined();
  });
});

describe('a Section’s columns, arranged from the placement (#514)', () => {
  /** A blank site with one Section placed, and the Section's installed definition. */
  const withSection = () => {
    const s = createStarterState('blank', 'Blank', false);
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, componentId: 'layout.section' }]);
    return { s: r.state, def: r.state.components['foundation.layout.section'], id: r.results[0].nodeId as string };
  };

  /**
   * A blank site with a Section built in the editor installed as Foundation's own (its Container holding its Content
   * slot, with the controls the release's Section offers) and placed.
   */
  const withManagedSection = () => {
    const s = createStarterState('blank', 'Blank', false);
    const def = foundationDesign(contentSection('layout.section'));
    s.components[def.id] = def;
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, definitionId: def.id }]);
    return { s: r.state, def: r.state.components[def.id], id: r.results[0].nodeId as string };
  };
  const COLUMNS = { partId: 'container', controls: ['layout', 'columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'gap', 'rowGap', 'columnGap', 'align', 'justify'] };

  it('offers Column sizes and separate row and column gaps on its Container, beside its layout and columns', () => {
    // The release's Section declares them on its Container.
    expect(withSection().def.parts.container.styleControls).toEqual(expect.arrayContaining(['layout', 'columns', 'gridTemplate', 'rowGap', 'columnGap']));
    const { def } = withManagedSection();
    expect(def.parts.container.styleControls).toEqual(expect.arrayContaining(['layout', 'columns', 'gridTemplate', 'rowGap', 'columnGap']));
    // The placement's inspector reaches them without Parts: the one part that holds the section's slot.
    expect(columnLayoutPart(def)).toEqual(COLUMNS);
  });

  it('offers the shipped theme’s Section its column controls without Parts', () => {
    expect(columnLayoutPart(withSection().def)).toEqual(COLUMNS);
  });

  it('offers the same column controls on a code Section with a Content slot', () => {
    const { def } = withSection();
    const code = { ...def, kind: 'code' as const, tree: undefined, slots: { content: { label: 'Content' } } };
    expect(columnLayoutPart(code)).toEqual({ partId: 'container', controls: ['layout', 'columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'gap', 'rowGap', 'columnGap', 'align', 'justify'] });
  });

  it('offers what an older installed Section has, and the same on a copy made unique', () => {
    const { s, def: installed, id } = withManagedSection();
    const def = structuredClone(installed);
    def.parts.container.styleControls = ['maxWidth', 'gap', 'layout', 'columns', 'align', 'justify', 'textAlign'];
    expect(columnLayoutPart(def)).toEqual({ partId: 'container', controls: ['layout', 'columns', 'gap', 'align', 'justify'] });
    // Its layout locked: nothing to arrange.
    def.parts.container.styleControls = ['maxWidth', 'gap'];
    expect(columnLayoutPart(def)).toBeNull();
    // Make unique gives the copy a project component ID; the copy is still a Section, through its provenance.
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: id, name: 'Wide band' }]);
    const copy = r.state.components[r.results[0].definitionId as string];
    expect(copy.componentId).not.toBe('layout.section');
    expect(columnLayoutPart(copy)).toEqual(columnLayoutPart(installed));
    expect(columnLayoutPart(copy)).toEqual(COLUMNS);
  });

  it('offers nothing for a design whose slot is not a Section’s content', () => {
    const { s } = withSection();
    // A Section built in the editor, whose Container holds its Content slot, to take apart below.
    const installed = foundationDesign(contentSection('layout.section'));
    expect(columnLayoutPart(installed)).toMatchObject({ partId: 'container' });
    // A section of the theme with no slot (a split hero).
    const hero = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, componentId: 'hero.split' }]).state.components['foundation.hero.split'];
    expect(columnLayoutPart(hero)).toBeNull();
    // Another design with a part holding a slot (a footnote holding a pricing table's notes): its columns are not that.
    const other = { ...structuredClone(installed), componentId: 'project.pricing', provenance: { createdBy: 'ai' as const } };
    expect(columnLayoutPart(other)).toBeNull();
    // A Section whose Container no longer holds the Content slot (moved to the root while editing the copy).
    const moved = structuredClone(installed);
    const inner = moved.tree!.nodes[moved.parts.container.nodeId] as ElementNode;
    const slotId = inner.children.find((c) => moved.tree!.nodes[c].kind === 'slot')!;
    inner.children = inner.children.filter((c) => c !== slotId);
    (moved.tree!.nodes[moved.tree!.rootIds[0]] as ElementNode).children.push(slotId);
    expect(columnLayoutPart(moved)).toBeNull();
    // No Container part at all.
    const bare = structuredClone(installed);
    delete (bare.parts as Record<string, unknown>).container;
    expect(columnLayoutPart(bare)).toBeNull();
  });

  it('splits one Section into asymmetric columns with separate gaps, leaving the other Section and the design alone', () => {
    const { s: one, id: split } = withSection();
    const at = owner(one);
    const r = applyOperations(one, [{ type: 'node.insert', owner: at, parentId: null, componentId: 'layout.section' }]);
    const plain = r.results[0].nodeId as string;
    const design = structuredClone(r.state.components['foundation.layout.section']);
    const set = (property: string, value: unknown) => ({ type: 'node.setStyle' as const, owner: at, nodeId: split, partId: 'container', scope: 'base' as const, property, value: value as never });
    const s = applyOperations(r.state, [set('layout', 'grid'), set('gridTemplate', '1fr 2fr'), set('rowGap', '32px'), set('columnGap', { token: 'space.xl' })]).state;
    expect((home(s).nodes[split] as InstanceNode).overrides?.container?.base).toEqual({ layout: 'grid', gridTemplate: '1fr 2fr', rowGap: '32px', columnGap: { token: 'space.xl' } });
    expect((home(s).nodes[plain] as InstanceNode).overrides).toBeUndefined();
    expect(s.components['foundation.layout.section']).toEqual(design);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const css = generateProject(s).get('src/lib/siteorigin/styles/site.css')!;
    const rules = css.split('}').filter((rule) => rule.includes(`.${overrideClass(split, 'container')}`)).join('}');
    expect(rules).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)');
    expect(rules).toContain('row-gap: 32px');
    expect(rules).toContain('column-gap: var(--so-space-xl)');
    expect(css).not.toContain(overrideClass(plain, 'container'));
  });
});
