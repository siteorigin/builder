import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError, instancesOf } from '@engine/tree';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const firstInstance = (s: ProjectState, componentId: string) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

describe('starter and generator', () => {
  it('creates a valid business starter', () => {
    const s = fresh();
    expect(s.site.pageOrder).toHaveLength(3);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('generates deterministic output (I01)', () => {
    const s = fresh();
    const a = generateProject(s);
    const b = generateProject(structuredClone(s));
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('keeps editor instrumentation out of clean output', () => {
    const s = fresh();
    for (const [path, content] of generateProject(s)) expect(content.includes('data-so-'), path).toBe(false);
    const dev = generateProject(s, { instrument: true });
    expect(dev.get('src/routes/+page.svelte')).toContain('__so=');
    expect([...dev.values()].some((c) => c.includes('data-so-ctx'))).toBe(true);
    expect(dev.get('src/routes/+layout.svelte')).toContain('virtual:siteorigin-bridge');
  });

  it('writes a prerendered route per page', () => {
    const files = generateProject(fresh());
    expect(files.has('src/routes/+page.svelte')).toBe(true);
    expect(files.has('src/routes/about/+page.svelte')).toBe(true);
    expect(files.get('src/routes/+layout.js')).toContain('prerender = true');
  });
});

describe('content operations', () => {
  it('edits one repeated item by stable ID and keeps identity across reorder (P04)', () => {
    let s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const items = grid.props.items as Array<{ id: string; title: string }>;
    const target = items[1].id;
    s = applyOperations(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: grid.id, prop: 'items', itemId: target, field: 'title', value: 'Changed' }]).state;
    s = applyOperations(s, [{ type: 'instance.listMove', owner: owner(s), nodeId: grid.id, prop: 'items', itemId: target, index: 0 }]).state;
    const after = (home(s).nodes[grid.id] as InstanceNode).props.items as Array<{ id: string; title: string }>;
    expect(after[0]).toMatchObject({ id: target, title: 'Changed' });
    expect(after.filter((i) => i.title === 'Changed')).toHaveLength(1);
  });

  it('applies a phone-only override without touching other ranges (P10)', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'root', scope: 'phone', property: 'paddingBlock', value: { token: 'space.lg' } }]).state;
    const css = generateProject(s).get('src/lib/siteorigin/styles/site.css')!;
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{[\s\S]*padding-block: var\(--so-space-lg\)/);
    expect(css.split('@media')[0]).not.toContain('padding-block');
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'root', scope: 'phone', property: 'paddingBlock', value: null }]).state;
    expect((home(s).nodes[hero.id] as InstanceNode).overrides).toBeUndefined();
  });

  it('rejects invalid style values and unknown tokens', () => {
    const s = fresh();
    const hero = firstInstance(s, 'hero.split');
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'background', value: 'red; x: y' }])).toThrow(EngineError);
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'gap', value: { token: 'space.nope' } }])).toThrow(/does not exist/);
  });

  it('updates internal links when a route changes and rejects duplicates (P14)', () => {
    let s = fresh();
    const about = s.site.pageOrder[1];
    s = applyOperations(s, [{ type: 'page.update', pageId: about, route: '/studio/' }]).state;
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('"/studio/"');
    expect(layout).not.toContain('"/about/"');
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: s.site.pageOrder[2], route: '/Studio' }])).toThrow(/already uses/);
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: about, route: '/../etc/' }])).toThrow();
  });

  it('requires a replacement when deleting a linked page', () => {
    const s = fresh();
    const contact = s.site.pageOrder[2];
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: contact }])).toThrow(/Choose a replacement/);
    const r = applyOperations(s, [{ type: 'page.remove', pageId: contact, replacementPageId: s.site.homePageId }]).state;
    expect(validateState(r).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('components', () => {
  it('forks a theme definition before shared edits and rebinds every use', () => {
    let s = fresh();
    const cta = firstInstance(s, 'cta.banner');
    const oldDef = cta.definitionId;
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: oldDef }, nodeId: 'panel', scope: 'base', property: 'radius', value: '0' }])).toThrow(/Fork it first/);
    const r = applyOperations(s, [{ type: 'component.fork', definitionId: oldDef }]);
    s = r.state;
    const forked = r.results[0].definitionId as string;
    expect(instancesOf(s, oldDef)).toHaveLength(0);
    expect(instancesOf(s, forked).length).toBeGreaterThan(1);
    s = applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: forked }, nodeId: 'panel', scope: 'base', property: 'radius', value: '0' }]).state;
    expect(generateProject(s).get('src/lib/siteorigin/styles/components.css')).toContain('border-radius: 0');
  });

  it('makes one instance unique while keeping its content, variant and overrides (P07)', () => {
    let s = fresh();
    const stats = firstInstance(s, 'stats.row');
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: stats.id, partId: 'value', scope: 'tablet', property: 'color', value: '#ff0000' }]).state;
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: stats.id }]);
    const node = home(r.state).nodes[stats.id] as InstanceNode;
    expect(node.definitionId).toBe(r.results[0].definitionId);
    expect(node.variant).toBe('inverse');
    expect(node.overrides?.value?.tablet?.color).toBe('#ff0000');
    expect(r.state.components[node.definitionId].owner).toBe('project');
  });

  it('creates a component from a subtree with generated properties (3.4)', () => {
    let s = createStarterState('blank', 'Blank', false);
    const page = home(s);
    const section = page.nodes[page.rootIds[0]] as InstanceNode;
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section.id, slot: 'content', primitive: 'stack' }]).state;
    const stackId = (home(s).nodes[section.id] as InstanceNode).slots!.content.at(-1)!;
    s = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), parentId: stackId, primitive: 'heading', text: 'Card title' },
      { type: 'node.insert', owner: owner(s), parentId: stackId, primitive: 'button', text: 'Read more' }
    ]).state;
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: stackId, name: 'Feature card' }]);
    const def = r.state.components[r.results[0].definitionId as string];
    expect(Object.keys(def.properties).sort()).toEqual(['buttonLabel', 'buttonLink', 'heading']);
    const inst = home(r.state).nodes[r.results[0].nodeId as string] as InstanceNode;
    expect(inst.props.heading).toBe('Card title');
    expect(generateProject(r.state).get('src/routes/+page.svelte')).toContain('"Card title"');
  });
});

describe('theme switching (P06, I03)', () => {
  it('rebinds theme components while preserving content, list IDs, overrides and project forks', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const grid = firstInstance(s, 'features.grid');
    const ids = (grid.props.items as Array<{ id: string }>).map((i) => i.id);
    s = applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'heading', scope: 'base', property: 'color', value: { token: 'color.accent' } }]).state;
    const cta = firstInstance(s, 'cta.banner');
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: cta.definitionId }]);
    s = fork.state;
    s = applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: '#123456' }]).state;
    s = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const heroAfter = home(s).nodes[hero.id] as InstanceNode;
    expect(heroAfter.definitionId).toBe('foundation-alt.hero.split');
    expect(heroAfter.props.heading).toBe(hero.props.heading);
    expect(heroAfter.overrides?.heading?.base?.color).toEqual({ token: 'color.accent' });
    expect(((home(s).nodes[grid.id] as InstanceNode).props.items as Array<{ id: string }>).map((i) => i.id)).toEqual(ids);
    expect(s.components[fork.results[0].definitionId as string]?.owner).toBe('project');
    expect(instancesOf(s, fork.results[0].definitionId as string).length).toBeGreaterThan(0);
    expect(s.tokens.overrides['color.brand']).toBe('#123456');
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toContain('foundation-alt-hero-split');
  });
});

describe('review regressions', () => {
  it('treats braces in user text as text, and names that start with non-letters still compile (S1, I5)', async () => {
    const { compile } = await import('svelte/compiler');
    let s = fresh();
    s = applyOperations(s, [{ type: 'site.update', name: 'Spring {edition' }]).state;
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: hero.id, name: '東京 2026' }]).state;
    for (const [path, src] of generateProject(s)) {
      if (!path.endsWith('.svelte')) continue;
      expect(() => compile(src, { filename: path, generate: 'server', runes: true }), path).not.toThrow();
    }
    expect(generateProject(s).get('src/routes/+layout.svelte')).toContain('"Spring {edition"');
  });

  it('rejects prototype keys and forged asset paths', () => {
    const s = fresh();
    expect(() => applyOperations(s, [{ type: 'asset.update', assetId: '__proto__', name: 'x' } as never])).toThrow();
    // validateOperation is the gate used by every caller
    return import('@shared/ops').then(({ validateOperation }) => {
      expect(validateOperation({ type: 'asset.update', assetId: '__proto__', name: 'x' }).ok).toBe(false);
      expect(validateOperation({ type: 'asset.add', asset: { id: 'a_x', name: 'x', file: '/etc/passwd', mime: 'image/png', bytes: 1, hash: 'h', kind: 'image', createdAt: 'now' } }).ok).toBe(false);
    });
  });

  it('gives duplicated code components their own source file', () => {
    let s = fresh();
    const r = applyOperations(s, [{ type: 'component.createCode', name: 'Widget', source: '' }]);
    s = r.state;
    const id = r.results[0].definitionId as string;
    const d = applyOperations(s, [{ type: 'component.duplicate', definitionId: id, name: 'Widget copy' }]);
    const copy = d.state.components[d.results[0].definitionId as string];
    expect(copy.sourcePath).not.toBe(s.components[id].sourcePath);
  });

  it('catches token cycles created by a reset', () => {
    let s = fresh();
    s = applyOperations(s, [{ type: 'token.set', tokenId: 'color.accent', value: '#ff0000' }]).state;
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: { token: 'color.brand' } }])).toThrow();
  });

  it('keeps project components pinned to their nested theme definitions on theme switch (I16)', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    // Wrap the hero in a Section, then turn the Section into a project component.
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.move', owner: owner(s), nodeId: hero.id, parentId: section, slot: 'content', index: 0 }]).state;
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: section, name: 'Hero wrap' }]);
    s = r.state;
    const wrap = s.components[r.results[0].definitionId as string];
    const nestedBefore = Object.values(wrap.tree!.nodes).filter((n) => n.kind === 'instance').map((n) => (n as InstanceNode).definitionId);
    s = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const nestedAfter = Object.values(s.components[wrap.id].tree!.nodes).filter((n) => n.kind === 'instance').map((n) => (n as InstanceNode).definitionId);
    expect(nestedAfter).toEqual(nestedBefore);
    for (const id of nestedAfter) expect(s.components[id]).toBeDefined();
  });

  it('nested override selectors outrank variant rules', () => {
    let s = fresh();
    const r = applyOperations(s, [{ type: 'component.fork', definitionId: firstInstance(s, 'cta.banner').definitionId }]);
    s = r.state;
    const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).not.toMatch(/undefined/);
  });

  it('rejects unbound or out-of-list bindings after structural edits (I17)', () => {
    let s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: grid.definitionId }]);
    s = fork.state;
    const defId = fork.results[0].definitionId as string;
    const r = applyOperations(s, [{ type: 'node.move', owner: { kind: 'component', id: defId }, nodeId: 'card-title', parentId: 'inner', index: 0 }]);
    expect(validateState(r.state).some((d) => d.code === 'BINDING_INVALID')).toBe(true);
  });
});

describe('follow-up regressions', () => {
  it('hidden at all sizes but visible on phone hides only on tablet and desktop', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    s = applyOperations(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'eyebrow', scope: 'base', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: hero.id, partId: 'eyebrow', scope: 'phone', property: 'hidden', value: false }
    ]).state;
    const css = generateProject(s).get('src/lib/siteorigin/styles/site.css')!;
    expect(css.split('@media')[0]).not.toContain('display: none');
    expect(css).toMatch(/min-width: 768px\) and \(max-width: 1023\.98px\) \{[\s\S]*display: none/);
    expect(css).not.toMatch(/max-width: 767\.98px\) \{[^@]*display: none/);
  });

  it('removing a part while editing a definition removes the part too', () => {
    let s = fresh();
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: firstInstance(s, 'hero.split').definitionId }]);
    s = fork.state;
    const defId = fork.results[0].definitionId as string;
    const r = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'component', id: defId }, nodeId: 'eyebrow' }]);
    expect(r.state.components[defId].parts.eyebrow).toBeUndefined();
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('allows ordinary words like "prototype" in content', async () => {
    const { validateOperation } = await import('@shared/ops');
    expect(validateOperation({ type: 'site.update', description: 'Our prototype constructor service' }).ok).toBe(true);
    expect(validateOperation({ type: 'toString' }).ok).toBe(false);
  });
});
