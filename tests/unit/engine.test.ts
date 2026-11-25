import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme, listThemes } from '@catalogue/index';
import { applyOperations, planHomeChange, sourceHash } from '@engine/apply';
import { propertiesHash } from '@shared/ops';
import { uniqueCopyName } from '@engine/definitions';
import { pageIds, shellPageLinks } from '@generator/checks';
import { EngineError, instancesOf } from '@engine/tree';
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import { effectiveTokens, generateProject, resolveInstanceProps } from '@generator/index';
import { tokenUsageCounts } from '@engine/tokens';
import { slotFill } from '@engine/slots';
import { validateOperation } from '@shared/ops';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const firstInstance = (s: ProjectState, componentId: string) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
/** A blank site with one empty layout section placed on Home, for the tests that build inside a section. */
const blankWithSection = () => {
  const s = createStarterState('blank', 'Blank', false);
  return applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'layout.section' }]).state;
};

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
    expect(node.variants?.tone).toBe('inverse');
    expect(node.overrides?.value?.tablet?.color).toBe('#ff0000');
    expect(r.state.components[node.definitionId].owner).toBe('project');
  });

  it('names repeated unnamed forks without stacking "(unique)" (#56)', () => {
    let s = fresh();
    const stats = firstInstance(s, 'stats.row');
    const original = s.components[stats.definitionId].name;
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: stats.id }]);
      s = r.state;
      names.push(s.components[r.results[0].definitionId as string].name);
    }
    for (const n of names) expect(n).not.toMatch(/\(unique\).*\(unique\)/);
    expect(new Set([original, ...names]).size).toBe(4);
    expect(names).toEqual([`${original} (unique)`, `${original} (unique 2)`, `${original} (unique 3)`]);
  });

  it('suggests copy names that recover stacked suffixes, avoid every installed name and fit the limit (#56)', () => {
    const s = fresh();
    const stats = firstInstance(s, 'stats.row');
    const def = s.components[stats.definitionId];
    // A project saved before the fix: its stacked name recovers on the next copy.
    expect(uniqueCopyName(s, 'Exhibitor card (unique) (UNIQUE 2)')).toBe('Exhibitor card (unique)');
    expect(uniqueCopyName(s, `${def.name.toUpperCase()} (unique)`)).toBe(`${def.name.toUpperCase()} (unique)`);
    // Names compare without case or outer spaces, including theme components'.
    s.components[stats.definitionId] = { ...def, name: `  ${def.name.toLowerCase()} (UNIQUE) ` };
    expect(uniqueCopyName(s, def.name)).toBe(`${def.name} (unique 2)`);
    // Ordinary numbers stay part of the name, and a name of suffixes alone still gets one.
    expect(uniqueCopyName(s, 'Press copy 2')).toBe('Press copy 2 (unique)');
    expect(uniqueCopyName(s, ' (unique) ')).toBe('Component (unique)');
    // Long names keep one stem for the whole series, and a cut never exposes an old suffix or splits a character.
    expect(uniqueCopyName(s, 'x'.repeat(70))).toBe(`${'x'.repeat(48)} (unique)`);
    expect(uniqueCopyName(s, `${'x'.repeat(39)} (unique) extra words`)).toBe(`${'x'.repeat(39)} (unique)`);
    const emoji = uniqueCopyName(s, `${'x'.repeat(47)}😀yyy`);
    expect(emoji).toBe(`${'x'.repeat(47)} (unique)`);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('numbers a series of copies of a long name without starting again (#56)', () => {
    let s = fresh();
    const stats = firstInstance(s, 'stats.row');
    s.components[stats.definitionId] = { ...s.components[stats.definitionId], name: 'x'.repeat(52) };
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: stats.id }]);
      s = r.state;
      names.push(s.components[r.results[0].definitionId as string].name);
    }
    const stem = 'x'.repeat(48);
    expect(names).toEqual([`${stem} (unique)`, `${stem} (unique 2)`, `${stem} (unique 3)`]);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(60);
  });

  it('keeps a name the author chose for a separate copy, even one another component has', () => {
    let s = fresh();
    const stats = firstInstance(s, 'stats.row');
    const other = s.components[firstInstance(s, 'cta.banner').definitionId].name;
    expect(other).not.toBe(s.components[stats.definitionId].name);
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: stats.id, name: `  ${other}  ` }]);
    s = r.state;
    const copy = r.results[0].definitionId as string;
    expect(copy).not.toBe(stats.definitionId);
    expect(s.components[copy].name).toBe(other);
    expect((home(s).nodes[stats.id] as InstanceNode).definitionId).toBe(copy);
  });

  it('creates a component from a subtree with generated properties (3.4)', () => {
    let s = blankWithSection();
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

  describe('a component made from a single leaf element keeps one part per element (#185)', () => {
    // Each leaf, the properties its content becomes, and the field of the element each one is bound to.
    const leaves = [
      { primitive: 'heading', text: 'Opening hours', props: { heading: 'text' } },
      { primitive: 'paragraph', text: 'Open daily', props: { text: 'text' } },
      { primitive: 'richtext', text: '- Mornings\n- Evenings', props: { body: 'text' } },
      { primitive: 'image', props: { image: 'image' } },
      { primitive: 'button', text: 'Book now', props: { buttonLabel: 'label', buttonLink: 'link' } },
      { primitive: 'icon', props: { icon: 'icon' } }
    ] as const;
    it.each(leaves)('$primitive', ({ primitive, props, ...rest }) => {
      const base = blankWithSection();
      const text = 'text' in rest ? { text: rest.text } : {};
      const ins = applyOperations(base, [{ type: 'node.insert', owner: owner(base), parentId: home(base).rootIds[0], slot: 'content', primitive, ...text }]);
      const s = ins.state;
      const source = home(s).nodes[ins.results[0].nodeId as string] as unknown as Record<string, unknown>;
      const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: ins.results[0].nodeId as string, name: 'Lead' }]);
      const id = r.results[0].definitionId as string;
      const placed = r.results[0].nodeId as string;
      const def = r.state.components[id];
      const rootId = def.tree!.rootIds[0];
      const root = def.tree!.nodes[rootId] as unknown as Record<string, unknown>;
      // Its content still becomes properties: the design reads them, they default to what it held, and the placement
      // fills them in with the same.
      expect(Object.keys(def.properties).sort()).toEqual(Object.keys(props).sort());
      for (const [prop, field] of Object.entries(props)) {
        expect(root[field]).toEqual({ $prop: prop });
        expect(def.properties[prop].default).toEqual(source[field]);
        expect((home(r.state).nodes[placed] as InstanceNode).props[prop]).toEqual(source[field]);
      }
      // The element is the component itself: its root part, and no second part on the same element.
      expect(Object.keys(def.parts)).toEqual(['root']);
      expect(def.parts.root.nodeId).toBe(rootId);
      // So the part can be renamed, and a placement styled through it.
      const after = applyOperations(r.state, [
        { type: 'component.setPart', definitionId: id, partId: 'root', nodeId: rootId, label: 'Lead' },
        { type: 'node.setStyle', owner: owner(r.state), nodeId: placed, partId: 'root', scope: 'base', property: 'radius', value: '8px' }
      ]).state;
      expect(after.components[id].parts.root.label).toBe('Lead');
      expect((home(after).nodes[placed] as InstanceNode).overrides).toEqual({ root: { base: { radius: '8px' } } });
      expect(errors(after)).toEqual([]);
    });

    it('a button inside a design, its label from the list item and its link written in, keeps both and one part', () => {
      const f = fork(fresh(), 'features.grid');
      const own = { kind: 'component' as const, id: f.id };
      const link = { type: 'url' as const, target: 'https://example.com/book' };
      (f.state.components[f.id].tree!.nodes['card-link'] as { link: unknown }).link = link;
      const r = applyOperations(f.state, [{ type: 'component.createFromNode', owner: own, nodeId: 'card-link', name: 'Card button' }]);
      const def = r.state.components[r.results[0].definitionId as string];
      const root = def.tree!.nodes[def.tree!.rootIds[0]] as unknown as Record<string, unknown>;
      expect(Object.keys(def.parts)).toEqual(['root']);
      // The label (and the condition that shows it) read the list field handed in; the link is a property of its own.
      expect(root.label).toEqual({ $prop: 'linkLabel' });
      expect(root.when).toEqual({ $prop: 'linkLabel' });
      expect(root.link).toEqual({ $prop: 'buttonLink' });
      expect(def.properties.buttonLink).toEqual({ type: 'link', label: 'Button link', default: link });
      const inst = r.state.components[f.id].tree!.nodes[r.results[0].nodeId as string] as InstanceNode;
      expect(inst.props).toEqual({ linkLabel: { $item: 'linkLabel' }, buttonLink: link });
      expect(errors(r.state)).toEqual([]);
    });
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

  it('moves a Foundation site to Editorial and back with its content, links, images, styles and forks intact (#390)', () => {
    let s = fresh();
    const p = owner(s);
    const about = s.site.pageOrder.find((id) => id !== s.site.homePageId)!;
    const hero = firstInstance(s, 'hero.split');
    const grid = firstInstance(s, 'features.grid');
    const firstCard = (grid.props.items as Array<{ id: string }>)[0].id;
    const media = firstInstance(s, 'content.media');
    s = applyOperations(s, [
      { type: 'asset.add', asset: { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image', createdAt: 'now' } },
      { type: 'instance.setProp', owner: p, nodeId: hero.id, prop: 'image', value: { assetId: 'a_pic', alt: 'A studio' } },
      { type: 'instance.setProp', owner: p, nodeId: hero.id, prop: 'primaryLink', value: { type: 'page', target: about } },
      { type: 'instance.setProp', owner: p, nodeId: grid.id, prop: 'items', itemId: firstCard, field: 'title', value: 'Surveys' },
      { type: 'instance.setVariant', owner: p, nodeId: media.id, axis: 'layout', variant: 'media-end' },
      { type: 'node.setStyle', owner: p, nodeId: hero.id, partId: 'heading', scope: 'base', property: 'color', value: { token: 'color.accent' } },
      { type: 'node.setStyle', owner: p, nodeId: grid.id, partId: 'cardTitle', itemId: firstCard, scope: 'base', property: 'color', value: { token: 'color.brand' } },
      { type: 'token.set', tokenId: 'color.brand', value: '#123456' },
      { type: 'token.set', tokenId: 'font.display', value: 'Lora' }
    ] as EditOperation[]).state;
    const cta = firstInstance(s, 'cta.banner');
    const fork = applyOperations(s, [{ type: 'component.fork', definitionId: cta.definitionId }]);
    s = fork.state;
    const forkId = fork.results[0].definitionId as string;
    // A project component built around a placed section keeps the definition it was made with.
    const built = applyOperations(s, [{ type: 'component.createFromNode', owner: p, nodeId: firstInstance(s, 'stats.row').id, name: 'Figures' }]);
    s = built.state;
    const builtId = built.results[0].definitionId as string;
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);

    const editorial = applyOperations(s, [{ type: 'theme.apply', themeId: 'editorial' }]).state;
    expect(editorial.site.themeId).toBe('editorial');
    expect(editorial.themeLock.theme).toMatchObject({ id: 'editorial' });
    // Every placement of a theme section now uses Editorial's, with what the author set unchanged.
    for (const page of Object.values(editorial.pages))
      for (const n of Object.values(page.nodes)) {
        if (n.kind !== 'instance') continue;
        const def = editorial.components[n.definitionId];
        if (def.owner === 'theme') expect(n.definitionId, `${page.title} ${def.componentId}`).toBe(`editorial.${def.componentId}`);
        const was = s.pages[page.id].nodes[n.id] as InstanceNode;
        expect({ props: n.props, overrides: n.overrides, itemOverrides: n.itemOverrides, variants: n.variants }).toEqual({ props: was.props, overrides: was.overrides, itemOverrides: was.itemOverrides, variants: was.variants });
      }
    expect(editorial.site.shell).toEqual({ header: expect.anything(), footer: expect.anything() });
    for (const part of ['header', 'footer'] as const) expect(Object.values(editorial.site.shell[part].nodes).map((n) => (n.kind === 'instance' ? n.definitionId : n.kind))).toEqual([`editorial.shell.${part}`]);
    expect(editorial.components[forkId]).toEqual(s.components[forkId]);
    expect(editorial.components[builtId]).toEqual(s.components[builtId]);
    expect(editorial.assets).toEqual(s.assets);
    expect(editorial.tokens).toEqual(s.tokens);
    expect(validateState(editorial).filter((d) => d.severity === 'error')).toEqual([]);
    // Editorial's own layout reaches the site: its split hero is asymmetric and its stylesheet is the theme's.
    const files = generateProject(editorial);
    expect(files.get('src/lib/siteorigin/styles/components.css')).toMatch(/\.so-editorial-hero-split__grid \{[^}]*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\);/);
    expect(files.get('src/lib/siteorigin/styles/theme.css')).toContain('Editorial theme base styles');

    const back = applyOperations(editorial, [{ type: 'theme.apply', themeId: 'foundation' }]).state;
    // Nothing was lost or changed on the way: the project is the one it was before the two switches.
    expect(back).toEqual(s);
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

  it('keeps what placements showed from their old definition when the new theme’s defaults differ (#103)', () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const grid = firstInstance(s, 'features.grid');
    // An installed hero and grid whose defaults differ from the new theme's, and placements that rely on them.
    const heroDef = s.components[hero.definitionId];
    heroDef.properties.heading.default = 'Keepsake';
    heroDef.variantAxes!.tone.default = 'muted';
    // A choice naming no option shows the default too.
    hero.variants = { tone: 'gone' };
    const gridDef = s.components[grid.definitionId];
    const items = gridDef.properties.items as Extract<typeof gridDef.properties.items, { type: 'list' }>;
    items.fields.title.default = 'Untitled';
    delete hero.props.heading;
    const explicitLead = hero.props.lead;
    const gridItems = grid.props.items as Array<Record<string, unknown>>;
    delete gridItems[0].title;
    delete grid.props.heading;
    const shown = (st: ProjectState, id: string) => resolveInstanceProps(st.components[(home(st).nodes[id] as InstanceNode).definitionId], home(st).nodes[id] as InstanceNode, { state: st });
    const before = { hero: shown(s, hero.id), grid: shown(s, grid.id) };
    const after = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const heroAfter = home(after).nodes[hero.id] as InstanceNode;
    const gridAfter = home(after).nodes[grid.id] as InstanceNode;
    expect(heroAfter.definitionId).toBe('foundation-alt.hero.split');
    // The heading it inherited, an item field left empty and the tone it never chose are what it shows still.
    expect(shown(after, hero.id)).toEqual(before.hero);
    expect(shown(after, grid.id)).toEqual(before.grid);
    expect(heroAfter.props.heading).toBe('Keepsake');
    expect(heroAfter.props.lead).toBe(explicitLead);
    expect(heroAfter.variants).toEqual({ tone: 'muted' });
    expect((gridAfter.props.items as Array<Record<string, unknown>>)[0].title).toBe('Untitled');
    expect((gridAfter.props.items as Array<{ id: string }>).map((i) => i.id)).toEqual(gridItems.map((i) => i.id));
    // A default the new theme shares is still left to the definition.
    expect(Object.hasOwn(gridAfter.props, 'heading')).toBe(false);
    expect(gridAfter.variants).toBeUndefined();
    // A default the new theme cannot hold stops the switch, naming the placement.
    const bad = structuredClone(s);
    bad.components[hero.definitionId].properties.headingLevel = { ...bad.components[hero.definitionId].properties.headingLevel, default: 'h7' } as never;
    (bad.components[hero.definitionId].properties.headingLevel as { options: Array<{ value: string; label: string }> }).options.push({ value: 'h7', label: 'H7' });
    delete (home(bad).nodes[hero.id] as InstanceNode).props.headingLevel;
    expect(() => applyOperations(bad, [{ type: 'theme.apply', themeId: 'foundation-alt' }])).toThrow(/Home: Split hero → Heading level: must be one of/);
  });

  it('keeps cards following their pages, values the generator falls back from, and the shell, on a theme switch (#103)', () => {
    let s = fresh();
    const about = Object.values(s.pages).find((p) => p.title === 'About')!;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'content.pages' }]);
    s = ins.state;
    const list = home(s).nodes[ins.results[0].nodeId as string] as InstanceNode;
    const listDef = s.components[list.definitionId];
    // The installed card title defaults to fixed text; the new theme's follows the page.
    (listDef.properties.items as { fields: Record<string, { default?: unknown }> }).fields.title.default = 'Untitled';
    list.props.items = [
      { id: 'i_follows', pageLink: { type: 'page', target: about.id }, title: null },
      { id: 'i_fixed', pageLink: { type: 'page', target: about.id } }
    ];
    // The shared header: a setting stored as the wrong kind of value shows its default, which the new theme changes.
    const header = Object.values(s.site.shell.header.nodes).find((n) => n.kind === 'instance') as InstanceNode;
    const altSticky = getTheme('foundation-alt').components.find((c) => c.componentId === 'shell.header')!.properties.sticky.default;
    s.components[header.definitionId].properties.sticky.default = !altSticky;
    header.props.sticky = 'yes';
    const shown = (st: ProjectState, tree: 'home' | 'header', id: string) => {
      const node = (tree === 'home' ? home(st) : st.site.shell.header).nodes[id] as InstanceNode;
      return resolveInstanceProps(st.components[node.definitionId], node, { state: st });
    };
    const before = { list: shown(s, 'home', list.id), header: shown(s, 'header', header.id) };
    expect((before.list.items as Array<{ title: string }>).map((i) => i.title)).toEqual([about.title, 'Untitled']);
    const after = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    expect(shown(after, 'home', list.id)).toEqual(before.list);
    expect(shown(after, 'header', header.id)).toEqual(before.header);
    const items = (home(after).nodes[list.id] as InstanceNode).props.items as Array<Record<string, unknown>>;
    // The card that followed its page still does; the one that showed the old default keeps it as its own.
    expect(items[0].title).toBeNull();
    expect(items[1].title).toBe('Untitled');
    expect((after.site.shell.header.nodes[header.id] as InstanceNode).props.sticky).toBe(!altSticky);
  });

  it('refuses a theme switch that would drop item styles waiting for items of an inherited list (#103)', () => {
    const s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const def = s.components[grid.definitionId];
    const items = def.properties.items as { default: Array<Record<string, unknown>> };
    // The grid shows the installed default's items, which differ from the new theme's, and keeps styles for an item
    // that list does not show now.
    items.default[0].title = 'Installed title';
    delete grid.props.items;
    grid.itemOverrides = { card: { list: 'items', items: { 'item-gone': { base: { opacity: 0.5 } } } } } as never;
    expect(() => applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }])).toThrow(/keeps styles for “.*” items its list does not show now/);
    // Without them, the switch keeps the items the grid showed.
    delete grid.itemOverrides;
    const after = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    expect(((after.pages[after.site.homePageId].nodes[grid.id] as InstanceNode).props.items as Array<{ title: string }>)[0].title).toBe('Installed title');
  });

  it('refuses a theme switch that would hide a placement’s slot content inside an empty list (#103)', () => {
    let s = fresh();
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'layout.section' }]);
    s = ins.state;
    const id = ins.results[0].nodeId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: id, slot: 'content', primitive: 'paragraph', text: 'My words' }]).state;
    const alt = getTheme('foundation-alt');
    const at = alt.components.findIndex((c) => c.componentId === 'layout.section');
    const shipped = alt.components[at];
    try {
      const next = structuredClone(shipped);
      next.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { text: { type: 'string', label: 'Text', default: '' } }, default: [] } as never;
      const slotId = Object.values(next.tree!.nodes).find((n) => n.kind === 'slot')!.id;
      const parent = Object.values(next.tree!.nodes).find((n) => (n.kind === 'element' || n.kind === 'repeat') && n.children.includes(slotId)) as { children: string[] };
      parent.children = parent.children.map((c) => (c === slotId ? 'each' : c));
      next.tree!.nodes.each = { id: 'each', kind: 'repeat', list: { $prop: 'rows' }, children: [slotId] };
      alt.components[at] = next;
      expect(() => applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }])).toThrow(/would no longer show the content in its "content" slot/);
    } finally {
      alt.components[at] = shipped;
    }
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
    // The move itself is refused (#205); a file that holds the same tree still reports it when loaded.
    expect(() => applyOperations(s, [{ type: 'node.move', owner: { kind: 'component', id: defId }, nodeId: 'card-title', parentId: 'inner', index: 0 }])).toThrow(/stay inside a repeat/);
    const tree = s.components[defId].tree!;
    (tree.nodes.card as { children: string[] }).children = (tree.nodes.card as { children: string[] }).children.filter((c) => c !== 'card-title');
    (tree.nodes.inner as { children: string[] }).children.unshift('card-title');
    expect(validateState(s).some((d) => d.code === 'BINDING_INVALID' && d.nodeId === 'card-title')).toBe(true);
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

// ---------------------------------------------------------------------------
// Component and engine operations (review 04 §1.5, §2)
// ---------------------------------------------------------------------------

const defOf = (s: ProjectState, componentId: string) => Object.values(s.components).find((d) => d.componentId === componentId && d.owner === 'theme')!;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const fork = (s: ProjectState, componentId: string) => {
  const r = applyOperations(s, [{ type: 'component.fork', definitionId: firstInstance(s, componentId).definitionId }]);
  return { state: r.state, id: r.results[0].definitionId as string };
};
async function compiles(path: string, src: string) {
  const { compile } = await import('svelte/compiler');
  return compile(src, { filename: path, generate: 'server', runes: true });
}

describe('style token groups (§1.5)', () => {
  it('lets side padding use the page gutter and max width use a spacing step', () => {
    const s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const r = applyOperations(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'paddingInline', value: { token: 'container.gutter' } },
      { type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'maxWidth', value: { token: 'space.2xl' } }
    ]).state;
    expect((home(r).nodes[hero.id] as InstanceNode).overrides?.root?.base).toMatchObject({ paddingInline: { token: 'container.gutter' }, maxWidth: { token: 'space.2xl' } });
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'paddingInline', value: { token: 'color.brand' } }])).toThrow(/space or container/);
  });
});

describe('convert to code (§2.1)', () => {
  it('carries its own styles, so deleting the original keeps the appearance', async () => {
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    // A project copy used once, so it can be deleted after converting.
    const u = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: hero.id, name: 'Hero copy' }]);
    s = u.state;
    const managedId = u.results[0].definitionId as string;
    const c = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id, name: 'Hero code' }]);
    s = c.state;
    const code = s.components[c.results[0].definitionId as string];
    const src = code.source!;
    const prefix = `so-${code.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
    expect(src).toContain('<style>');
    expect(src).toContain(`:global(.${prefix}__`);
    expect(src).toMatch(/@media \(min-width: 1024px\)/);
    expect(src).toContain(`:global(.${prefix}--`);
    // Parts keep their hooks, so placement overrides still reach the same elements.
    expect(Object.keys(code.parts)).toEqual(Object.keys(s.components[managedId].parts));
    expect(src).toContain('so_o?.["heading"]');
    expect(src).not.toContain(`so-${managedId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}__`);
    s = applyOperations(s, [{ type: 'component.remove', definitionId: managedId }]).state;
    expect(s.components[managedId]).toBeUndefined();
    expect(generateProject(s).get('src/lib/siteorigin/styles/components.css')).not.toContain('Hero copy');
    expect(s.components[code.id].source).toBe(src);
    const out = await compiles(code.sourcePath!, src);
    expect(out.css?.code ?? '').toContain(`.${prefix}__`);
    expect(errors(s)).toEqual([]);
  });
});

describe('code component schemas (§2.2)', () => {
  it('accepts full property schemas and rejects invalid ones', () => {
    const s = fresh();
    const r = applyOperations(s, [
      {
        type: 'component.createCode',
        name: 'Plans',
        source: '<p>x</p>\n',
        properties: {
          tone: { type: 'enum', label: 'Tone', options: [{ value: 'light', label: 'Light' }, 'dark'], default: 'dark' },
          count: { type: 'number', label: 'Count', min: 1, max: 5, default: 3 },
          intro: { type: 'string', label: 'Intro', multiline: true, maxLength: 200, default: 'a\nb' },
          rows: { type: 'list', label: 'Rows', itemLabel: 'Row', titleField: 'name', min: 1, fields: { name: { type: 'string', label: 'Name', default: 'Row' } } }
        }
      }
    ]);
    const def = r.state.components[r.results[0].definitionId as string];
    expect(def.properties.tone).toMatchObject({ type: 'enum', default: 'dark', options: [{ value: 'light' }, { value: 'dark', label: 'dark' }] });
    expect(def.properties.count).toMatchObject({ min: 1, max: 5, default: 3 });
    expect(def.properties.intro).toMatchObject({ multiline: true, maxLength: 200, default: 'a\nb' });
    const rows = def.properties.rows as unknown as { default: Array<{ id: string; name: string }>; min: number };
    expect(rows.min).toBe(1);
    expect(rows.default).toHaveLength(1);
    expect(rows.default[0]).toMatchObject({ name: 'Row' });
    expect(rows.default[0].id).toMatch(/^i_/);
    const bad = (properties: Record<string, unknown>) => () => applyOperations(s, [{ type: 'component.createCode', name: 'X', source: '', properties }]);
    expect(bad({ t: { type: 'enum', options: [] } })).toThrow(/1 to 50 options/);
    expect(bad({ n: { type: 'number', min: 5, max: 1 } })).toThrow(/min is greater/);
    expect(bad({ n: { type: 'number', max: 2, default: 9 } })).toThrow(/at most 2/);
    expect(bad({ default: { type: 'string' } })).toThrow(/reserved/);
    expect(bad({ l: { type: 'list', fields: { inner: { type: 'list', fields: {} } } } })).toThrow(/type of/);
  });

  it('edits a schema and moves instance content to it', () => {
    let s = fresh();
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { label: { type: 'string', label: 'Label', default: 'Hi' } } }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), definitionId: id, props: { label: 'dark' } }]);
    s = ins.state;
    const nodeId = ins.results[0].nodeId as string;
    s = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'label', schema: { type: 'enum', label: 'Tone', options: ['light', 'dark'] } }]).state;
    expect((home(s).nodes[nodeId] as InstanceNode).props.label).toBe('dark');
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'label', schema: { type: 'enum', label: 'Tone', options: ['light'] } }])).toThrow(/must be one of/);
    s = applyOperations(s, [{ type: 'component.updateSource', definitionId: id, source: '<p>y</p>\n', properties: { size: { type: 'number', label: 'Size', default: 2 } } }]).state;
    expect(Object.keys(s.components[id].properties)).toEqual(['size']);
    expect((home(s).nodes[nodeId] as InstanceNode).props.label).toBeUndefined();
    s = applyOperations(s, [{ type: 'component.removePropSchema', definitionId: id, prop: 'size' }]).state;
    expect(s.components[id].properties).toEqual({});
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: defOf(s, 'cta.banner').id, prop: 'x', schema: { type: 'string' } }])).toThrow(/Fork it first/);
  });

  it('refuses a whole schema edited from one that has changed since, keeping the newer property and its content (#103)', () => {
    let s = fresh();
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { title: { type: 'string', label: 'Title', default: 'Hi' } } }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    // The Properties tab opens on this schema, and its rows are edited.
    const opened = propertiesHash(s.components[id].properties);
    const edited = { title: { type: 'string', label: 'Heading', default: 'Hi' } };
    // Meanwhile another change adds a property, and a placement fills it.
    s = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'subtitle', schema: { type: 'string', label: 'Subtitle' } }]).state;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), definitionId: id, props: { subtitle: 'Kept' } }]);
    s = ins.state;
    const nodeId = ins.results[0].nodeId as string;
    const source = s.components[id].source!;
    const save = (expectedPropertiesHash: string) => () =>
      applyOperations(s, [{ type: 'component.updateSource', definitionId: id, source: '<p>y</p>\n', expectedHash: sourceHash(source), properties: edited, expectedPropertiesHash }]);
    const err = (() => {
      try {
        save(opened)();
      } catch (e) {
        return e as EngineError;
      }
    })();
    expect(err).toBeInstanceOf(EngineError);
    expect(err!.code).toBe('CONFLICT');
    expect(err!.message).toMatch(/properties of "Note" changed/);
    // Nothing was applied: the input state still has the newer property, its content, and the old source.
    expect(Object.keys(s.components[id].properties)).toEqual(['title', 'subtitle']);
    expect((home(s).nodes[nodeId] as InstanceNode).props.subtitle).toBe('Kept');
    expect(s.components[id].source).toBe(source);
    // Saved from the current schema, the same edit goes through, and an unrelated page edit does not invalidate it.
    s = applyOperations(s, [{ type: 'page.update', pageId: s.site.homePageId, title: 'Elsewhere' }]).state;
    const next = save(propertiesHash(s.components[id].properties))().state;
    expect(next.components[id].properties.title.label).toBe('Heading');
    expect(next.components[id].source).toBe('<p>y</p>\n');
    // A change to an existing property, with the same names, is a newer schema too.
    const relabelled = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'subtitle', schema: { type: 'string', label: 'Kicker' } }]).state;
    expect(Object.keys(relabelled.components[id].properties)).toEqual(Object.keys(s.components[id].properties));
    expect(() => applyOperations(relabelled, [{ type: 'component.updateSource', definitionId: id, source: '<p>y</p>\n', properties: edited, expectedPropertiesHash: propertiesHash(s.components[id].properties) }])).toThrow(/changed since they were opened/);
  });
});

describe('renaming code component properties', () => {
  const text = (label: string, extra: Record<string, unknown> = {}) => ({ type: 'string', label, default: '', ...extra });
  /** A code component placed on the home page and inside a managed component that binds one of its properties. */
  function placed(properties: Record<string, unknown>, props: Record<string, unknown>) {
    let s = fresh();
    const o = owner(s);
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties }]);
    s = c.state;
    const noteId = c.results[0].definitionId as string;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: o, definitionId: noteId, props }]);
    s = ins.state;
    const pageNote = ins.results[0].nodeId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
    const stack = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: stack, definitionId: noteId }]).state;
    const outer = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: stack, name: 'Outer' }]);
    s = outer.state;
    const outerId = outer.results[0].definitionId as string;
    const boundNote = Object.values(s.components[outerId].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === noteId)!.id;
    const page = (st: ProjectState) => (home(st).nodes[pageNote] as InstanceNode).props;
    const bound = (st: ProjectState) => (st.components[outerId].tree!.nodes[boundNote] as InstanceNode).props;
    return { s, noteId, outerId, boundNote, page, bound };
  }
  const save = (s: ProjectState, definitionId: string, properties: Record<string, unknown>, renames?: Array<{ from: string; to: string }>) =>
    applyOperations(s, [{ type: 'component.updateSource', definitionId, source: '<p>y</p>\n', properties, ...(renames ? { renames } : {}) }]).state;

  it('moves placement content and managed bindings to the new name', () => {
    const p = placed({ label: text('Label', { default: 'Hi' }) }, { label: 'Authored' });
    let s = applyOperations(p.s, [
      { type: 'component.setPropSchema', definitionId: p.outerId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Welcome' } },
      { type: 'node.setBinding', owner: { kind: 'component', id: p.outerId }, nodeId: p.boundNote, field: 'prop', prop: 'label', binding: { $prop: 'title' } }
    ]).state;
    s.components[p.noteId].examples = [{ description: 'Short', props: { label: 'Example' } }];
    s = save(s, p.noteId, { caption: text('Caption', { default: 'Hi' }) }, [{ from: 'label', to: 'caption' }]);
    expect(Object.keys(s.components[p.noteId].properties)).toEqual(['caption']);
    expect(p.page(s)).toEqual({ caption: 'Authored' });
    expect(p.bound(s)).toEqual({ caption: { $prop: 'title' } });
    expect(s.components[p.noteId].examples![0].props).toEqual({ caption: 'Example' });
    expect(errors(s)).toEqual([]);
    // Without a rename the old property is removed, content and binding with it, as before.
    const dropped = save(p.s, p.noteId, { caption: text('Caption') });
    expect(p.page(dropped)).toEqual({});
  });

  it('swaps names at once, retypes moved content and lets a new property reuse a vacated name', () => {
    const p = placed({ a: text('A'), b: text('B'), c: text('C') }, { a: 'first', b: 'second', c: 'third' });
    let s = save(p.s, p.noteId, { b: text('B'), a: text('A'), c: text('C') }, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }
    ]);
    expect(p.page(s)).toEqual({ a: 'second', b: 'first', c: 'third' });
    // A chain with a type change: c becomes rich text under d, and a fresh c starts empty.
    s = save(s, p.noteId, { b: text('B'), a: text('A'), d: { type: 'richtext', label: 'D' }, c: text('New C') }, [{ from: 'c', to: 'd' }]);
    expect(p.page(s).d).toEqual([{ type: 'p', spans: [{ text: 'third' }] }]);
    expect(p.page(s).c).toBeUndefined();
    expect(s.components[p.noteId].properties.c.label).toBe('New C');
    // Removing b and renaming a to b keeps a's content and drops b's.
    s = save(s, p.noteId, { b: text('Was A'), d: { type: 'richtext', label: 'D' }, c: text('New C') }, [{ from: 'a', to: 'b' }]);
    expect(p.page(s).b).toBe('second');
    expect(p.page(s).a).toBeUndefined();
    expect(errors(s)).toEqual([]);
  });

  it('keeps examples to the properties the component has, with values their schemas accept', () => {
    let s = fresh();
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { a: text('A'), b: text('B'), c: text('C') } }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    s.components[id].examples = [{ description: 'One', props: { a: 'words', b: 'kept', c: 'gone' } }];
    s = save(s, id, { flag: { type: 'boolean', label: 'Flag' }, d: text('D') }, [
      { from: 'a', to: 'flag' },
      { from: 'b', to: 'd' }
    ]);
    expect(s.components[id].examples![0].props).toEqual({ d: 'kept' });
  });

  it('refuses content the renamed property cannot keep and malformed renames, changing nothing', () => {
    const p = placed({ a: text('A'), b: text('B') }, { a: 'words', b: 'more' });
    const before = JSON.stringify(p.s);
    expect(() => save(p.s, p.noteId, { n: { type: 'boolean', label: 'N' }, b: text('B') }, [{ from: 'a', to: 'n' }])).toThrow(/cannot keep/);
    expect(() => save(p.s, p.noteId, { n: text('N') }, [{ from: 'zz', to: 'n' }])).toThrow(/no property "zz"/);
    expect(() => save(p.s, p.noteId, { n: text('N') }, [{ from: 'a', to: 'm' }])).toThrow(/not one of the new properties/);
    expect(() => save(p.s, p.noteId, { a: text('A') }, [{ from: 'a', to: 'a' }])).toThrow(/to itself/);
    expect(() => save(p.s, p.noteId, { n: text('N'), m: text('M') }, [{ from: 'a', to: 'n' }, { from: 'a', to: 'm' }])).toThrow(/renamed twice/);
    expect(() => save(p.s, p.noteId, { n: text('N') }, [{ from: 'a', to: 'n' }, { from: 'b', to: 'n' }])).toThrow(/More than one/);
    expect(() => applyOperations(p.s, [{ type: 'component.updateSource', definitionId: p.noteId, source: '', renames: [{ from: 'a', to: 'n' }] }])).toThrow(/needs the whole new schema/);
    expect(JSON.stringify(p.s)).toBe(before);
  });
});

describe('create component from a selection (§2.3)', () => {
  it('turns icons into properties, keeps the anchor on the placement and records dependencies', () => {
    let s = blankWithSection();
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'stack' }]).state;
    const stackId = (home(s).nodes[section] as InstanceNode).slots!.content.at(-1)!;
    s = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), parentId: stackId, primitive: 'icon' },
      { type: 'node.insert', owner: owner(s), parentId: stackId, componentId: 'stats.row' },
      { type: 'node.setContent', owner: owner(s), nodeId: stackId, field: 'anchor', value: 'offer' }
    ]).state;
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: stackId, name: 'Offer' }]);
    const def = r.state.components[r.results[0].definitionId as string];
    const inst = home(r.state).nodes[r.results[0].nodeId as string] as InstanceNode;
    expect(def.properties.icon).toEqual({ type: 'icon', label: 'Icon', default: 'sparkles' });
    expect(inst.props.icon).toBe('sparkles');
    expect(inst.anchor).toBe('offer');
    expect(Object.values(def.tree!.nodes).some((n) => n.anchor)).toBe(false);
    expect(def.dependencies).toEqual([defOf(r.state, 'stats.row').id]);
    expect(def.parts.icon.styleControls).toContain('color');
    expect(def.parts.icon.styleControls).not.toContain('columns');
    expect(def.parts.root.styleControls).toContain('gap');
    expect(errors(r.state)).toEqual([]);
  });

  it("hoists the owner component's properties, list fields and slots", async () => {
    const f = fork(fresh(), 'features.grid');
    const own = { kind: 'component' as const, id: f.id };
    // A variant that restyles the card text is something the new component could not follow.
    f.state.components[f.id].variantAxes!.tone.options.inverse.styles!['card-text'] = { base: { opacity: 0.78 } };
    expect(() => applyOperations(f.state, [{ type: 'component.createFromNode', owner: own, nodeId: 'card', name: 'Card' }])).toThrow(/variant styles elements inside/);
    const styled = Object.entries(f.state.components[f.id].variantAxes!.tone.options).filter(([, v]) => v.styles?.['card-text']);
    const reset = applyOperations(
      f.state,
      styled.map(([vid]) => ({ type: 'node.resetStyles' as const, owner: own, nodeId: 'card-text', variant: vid }))
    ).state;
    for (const [vid] of styled) expect(reset.components[f.id].variantAxes!.tone.options[vid].styles?.['card-text']).toBeUndefined();
    const r = applyOperations(reset, [{ type: 'component.createFromNode', owner: own, nodeId: 'card', name: 'Card' }]);
    const s = r.state;
    const card = s.components[r.results[0].definitionId as string];
    expect(Object.keys(card.properties).sort()).toEqual(['description', 'icon', 'link', 'linkLabel', 'title']);
    expect(card.properties.title).toMatchObject({ type: 'string', label: 'Title' });
    const inst = s.components[f.id].tree!.nodes[r.results[0].nodeId as string] as InstanceNode;
    expect(inst.props.title).toEqual({ $item: 'title' });
    expect(JSON.stringify(s.components[f.id])).not.toContain('[object Object]');
    expect(errors(s)).toEqual([]);
    for (const [path, src] of generateProject(s)) if (path.endsWith('.svelte')) await compiles(path, src);

    const sec = fork(blankWithSection(), 'layout.section');
    const w = applyOperations(sec.state, [{ type: 'component.createFromNode', owner: { kind: 'component', id: sec.id }, nodeId: 'inner', name: 'Inner' }]);
    const inner = w.state.components[w.results[0].definitionId as string];
    expect(inner.slots).toEqual({ content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } });
    const through = w.state.components[sec.id].tree!.nodes[w.results[0].nodeId as string] as InstanceNode;
    expect(through.slots?.content).toHaveLength(1);
    expect(errors(w.state)).toEqual([]);
  });
});

describe('fork keeps theme data fixed (§2.4)', () => {
  it('does not rebind uses inside theme-owned definitions', () => {
    const s = fresh();
    const cta = defOf(s, 'cta.banner');
    const hero = defOf(s, 'hero.split');
    // A theme definition that places another one.
    hero.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: cta.id, props: {} };
    (hero.tree!.nodes[hero.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
    const r = applyOperations(s, [{ type: 'component.fork', definitionId: cta.id }]);
    const forked = r.results[0].definitionId as string;
    expect((r.state.components[hero.id].tree!.nodes.nested as InstanceNode).definitionId).toBe(cta.id);
    expect(instancesOf(r.state, forked).every((u) => u.owner.kind !== 'component')).toBe(true);
    expect(instancesOf(r.state, forked).length).toBeGreaterThan(0);
  });
});

describe('definition editing operations (§2.5)', () => {
  it('removes only unused components', () => {
    let s = fresh();
    const cta = firstInstance(s, 'cta.banner');
    expect(() => applyOperations(s, [{ type: 'component.remove', definitionId: cta.definitionId }])).toThrow(/is used/);
    const d = applyOperations(s, [{ type: 'component.duplicate', definitionId: cta.definitionId, name: 'Spare' }]);
    s = applyOperations(d.state, [{ type: 'component.remove', definitionId: d.results[0].definitionId as string }]).state;
    expect(s.components[d.results[0].definitionId as string]).toBeUndefined();
  });

  it('adds and removes parts, variants and slots', () => {
    const f = fork(fresh(), 'features.grid');
    let s = f.state;
    const id = f.id;
    const grid = firstInstance(s, 'features.grid');
    const own = { kind: 'component' as const, id };
    s = applyOperations(s, [
      { type: 'component.setPart', definitionId: id, partId: 'cardText', nodeId: 'card-text', label: 'Card text' },
      { type: 'node.setStyle', owner: owner(s), nodeId: grid.id, partId: 'cardText', scope: 'base', property: 'color', value: '#ff0000' },
      { type: 'component.setVariant', definitionId: id, axis: 'layout', variant: 'compact', label: 'Compact' },
      { type: 'node.setStyle', owner: own, nodeId: 'grid', variant: 'compact', scope: 'desktop', property: 'gap', value: { token: 'space.sm' } },
      { type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, variant: 'compact' },
      { type: 'component.setSlot', definitionId: id, slot: 'footer', label: 'Footer' },
      { type: 'node.insert', owner: own, parentId: 'inner', primitive: 'slot', bind: 'footer' }
    ]).state;
    const def = s.components[id];
    expect(def.parts.cardText.styleControls).toContain('textStyle');
    expect(def.variantAxes!.layout.options.compact.styles!.grid.desktop!.gap).toEqual({ token: 'space.sm' });
    const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toMatch(/--layout-compact\.so-[^{]*__grid \{\n\t\tgap: var\(--so-space-sm\)/);
    expect(errors(s)).toEqual([]);
    expect(() => applyOperations(s, [{ type: 'component.setPart', definitionId: id, partId: 'again', nodeId: 'card-text', label: 'x' }])).toThrow(/already the "cardText" part/);
    expect(() => applyOperations(s, [{ type: 'component.removePart', definitionId: id, partId: 'root' }])).toThrow();
    s = applyOperations(s, [
      { type: 'component.removePart', definitionId: id, partId: 'cardText' },
      { type: 'node.resetStyles', owner: own, nodeId: 'grid', variant: 'compact' },
      { type: 'component.removeVariant', definitionId: id, variant: 'compact' },
      { type: 'component.removeSlot', definitionId: id, slot: 'footer' }
    ]).state;
    const after = home(s).nodes[grid.id] as InstanceNode;
    expect(after.overrides?.cardText).toBeUndefined();
    expect(after.variants?.layout).toBeUndefined();
    expect(s.components[id].variantAxes?.layout.options.compact).toBeUndefined();
    expect(s.components[id].slots).toBeUndefined();
    expect(Object.values(s.components[id].tree!.nodes).some((n) => n.kind === 'slot')).toBe(false);
    expect(errors(s)).toEqual([]);
  });

  it('refuses to remove a slot that holds content', () => {
    const f = fork(blankWithSection(), 'layout.section');
    let s = f.state;
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'heading' }]).state;
    expect(() => applyOperations(s, [{ type: 'component.removeSlot', definitionId: f.id, slot: 'content' }])).toThrow(/has content/);
    // However much it holds.
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'paragraph', text: 'More' }]).state;
    expect(() => applyOperations(s, [{ type: 'component.removeSlot', definitionId: f.id, slot: 'content' }])).toThrow(/has content/);
  });

  describe('slot contracts (issue #96)', () => {
    /** A blank site whose Section is the project's own, with two placements of it on Home: the first holds a heading and a paragraph. */
    function sections() {
      let start = blankWithSection();
      const first = home(start).rootIds[0];
      start = applyOperations(start, [
        { type: 'node.insert', owner: owner(start), parentId: first, slot: 'content', primitive: 'heading', text: 'Welcome to Blank' },
        { type: 'node.insert', owner: owner(start), parentId: first, slot: 'content', primitive: 'paragraph', text: 'Select this text to edit it.' }
      ]).state;
      const f = fork(start, 'layout.section');
      let s = applyOperations(f.state, [{ type: 'node.insert', owner: owner(f.state), parentId: null, definitionId: f.id }]).state;
      const [a, b] = home(s).rootIds;
      const own = { kind: 'component' as const, id: f.id };
      s = applyOperations(s, [
        { type: 'component.setSlot', definitionId: f.id, slot: 'content', label: 'Content', description: 'Words and buttons', categories: ['media'], primitives: ['text', 'link'], max: 2 },
        { type: 'component.setSlot', definitionId: f.id, slot: 'aside', label: 'Aside', primitives: ['text'], max: 1 },
        { type: 'node.insert', owner: own, parentId: 'inner', primitive: 'slot', bind: 'aside' }
      ]).state;
      return { s, id: f.id, a, b, page: owner(s) };
    }
    const slotOf = (s: ProjectState, nodeId: string, slot = 'content') => (home(s).nodes[nodeId] as InstanceNode).slots?.[slot] ?? [];

    it('takes only the components and elements it lists, and no more than its limit', () => {
      const { s: base, id, b, page } = sections();
      expect(base.components[id].slots!.content).toEqual({ label: 'Content', description: 'Words and buttons', categories: ['media'], primitives: ['text', 'link'], max: 2 });
      let s = applyOperations(base, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'heading' }]).state;
      expect(() => applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'image' }])).toThrow(/“Content” slot of “Section” takes media components, text and buttons, not an image/);
      expect(() => applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'stack' }])).toThrow(/not a container/);
      expect(() => applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', componentId: 'features.grid' }])).toThrow(/not “Services grid” \(a content component\)/);
      s = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', componentId: 'media.gallery' }]).state;
      expect(slotOf(s, b)).toHaveLength(2);
      expect(() => applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'button' }])).toThrow(/holds at most 2 items/);
      // Duplicating inside a full slot would put a third there.
      expect(() => applyOperations(s, [{ type: 'node.duplicate', owner: page, nodeId: slotOf(s, b)[0] }])).toThrow(/holds at most 2 items/);
      expect(errors(s)).toEqual([]);
    });

    it('lets a full slot reorder its own content, and refuses moves and copies into one that is full or does not take it', () => {
      const { s: base, a, b, page } = sections();
      // The first section already holds a heading and a paragraph: its Content slot is full.
      let s = applyOperations(base, [
        { type: 'node.insert', owner: page, parentId: a, slot: 'aside', primitive: 'paragraph' },
        { type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'button' }
      ]).state;
      const [first, second] = slotOf(s, a);
      expect(slotOf(s, a)).toHaveLength(2);
      // Reordering within the full slot changes nothing it holds.
      s = applyOperations(s, [{ type: 'node.move', owner: page, nodeId: first, parentId: a, slot: 'content', index: 1 }]).state;
      expect(slotOf(s, a)).toEqual([second, first]);
      // Into the full slot of the same placement, or of another one, is refused, and the content stays where it was.
      const aside = slotOf(s, a, 'aside')[0];
      expect(() => applyOperations(s, [{ type: 'node.move', owner: page, nodeId: aside, parentId: a, slot: 'content', index: 0 }])).toThrow(/holds at most 2 items/);
      expect(() => applyOperations(s, [{ type: 'node.move', owner: page, nodeId: slotOf(s, b)[0], parentId: a, slot: 'aside', index: 0 }])).toThrow(/“Aside” slot of “Section” takes text, not a button/);
      expect(() => applyOperations(s, [{ type: 'node.copy', owner: page, nodeId: slotOf(s, b)[0], toOwner: page, parentId: a, slot: 'content' }])).toThrow(/holds at most 2 items/);
      // A copy into a slot with room is still refused when the slot does not take what it is.
      expect(() => applyOperations(s, [{ type: 'node.copy', owner: page, nodeId: slotOf(s, b)[0], toOwner: page, parentId: b, slot: 'aside' }])).toThrow(/“Aside” slot of “Section” takes text, not a button/);
      // Making a component of text in a text-only slot would put a custom component there.
      const [asideText] = slotOf(s, a, 'aside');
      expect(() => applyOperations(s, [{ type: 'component.createFromNode', owner: page, nodeId: asideText, name: 'Note' }])).toThrow(/takes text, not “Note” \(a custom component\)/);
      expect(slotOf(s, a, 'aside')).toEqual([aside]);
      // A slot with room takes content moved out of a full one.
      s = applyOperations(s, [{ type: 'node.move', owner: page, nodeId: first, parentId: b, slot: 'content', index: 0 }]).state;
      expect(slotOf(s, b)).toHaveLength(2);
      expect(errors(s)).toEqual([]);
    });

    it('keeps a contract a label change leaves out, clears one sent as null, and refuses one its content no longer fits', () => {
      const { s: base, id, b, page } = sections();
      const s = applyOperations(base, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'button' }]).state;
      const relabelled = applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Body' }]).state;
      expect(relabelled.components[id].slots!.content).toEqual({ label: 'Body', description: 'Words and buttons', categories: ['media'], primitives: ['text', 'link'], max: 2 });
      const opened = applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', categories: null, primitives: null, max: null, description: null }]).state;
      expect(opened.components[id].slots!.content).toEqual({ label: 'Content' });
      expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', max: 1 }])).toThrow(/Home: the “Content” slot already holds more than 1/);
      expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', primitives: ['text'] }])).toThrow(/already holds a button, which it would no longer take/);
      expect(validateOperation({ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'x', primitives: ['video'] }).ok).toBe(false);
    });

    it('refuses a contract that a collection layout’s content no longer fits, and keeps that content (#655)', () => {
      const { s: base, id, a, b, page } = sections();
      const posts = { kind: 'template' as const, id: 'posts' };
      // Only the layout's placement holds content, so only it can refuse.
      const made = applyOperations(base, [{ type: 'node.remove', owner: page, nodeId: a }, { type: 'node.remove', owner: page, nodeId: b }, { type: 'collection.create', collectionId: 'posts' }]).state;
      const placed = applyOperations(made, [{ type: 'node.insert', owner: posts, parentId: null, index: 0, definitionId: id }]);
      const holder = placed.results[0].nodeId as string;
      const s = applyOperations(placed.state, [{ type: 'node.insert', owner: posts, parentId: holder, slot: 'content', primitive: 'paragraph', text: 'Entry intro' }]).state;
      const held = [...(s.collections.posts.settings.template.nodes[holder] as InstanceNode).slots!.content];
      expect(held).toHaveLength(1);
      expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', primitives: ['image'] }])).toThrow(/layout: the “Content” slot already holds text, which it would no longer take/);
      expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', max: 0 }])).toThrow(/layout: the “Content” slot already holds more than 0/);
      expect(s.components[id].slots!.content.max).toBe(2);
      expect((s.collections.posts.settings.template.nodes[holder] as InstanceNode).slots!.content).toEqual(held);
      // A contract it still fits is taken, with the layout's content as it was.
      const kept = applyOperations(s, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', primitives: ['text'], max: 1 }]).state;
      expect((kept.collections.posts.settings.template.nodes[holder] as InstanceNode).slots!.content).toEqual(held);
      expect(kept.collections.posts.settings.template.nodes[held[0]]).toEqual(s.collections.posts.settings.template.nodes[held[0]]);
    });

    it('reports content a slot does not take, or more than it holds, and damaged slots, when the project is opened', () => {
      const { s: base, id, b, page } = sections();
      const s = applyOperations(base, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'heading' }]).state;
      const inst = home(s).nodes[b] as InstanceNode;
      home(s).nodes.img1 = { id: 'img1', kind: 'image', image: { assetId: null, alt: '' } };
      inst.slots!.content.push('img1');
      expect(errors(s).map((d) => [d.code, d.nodeId])).toEqual([['SLOT_REFUSED', 'img1']]);
      // Each child the slot does not take is its own problem, so a second one is never hidden behind the first.
      home(s).nodes.img2 = { id: 'img2', kind: 'image', image: { assetId: null, alt: '' } };
      const saved = [...inst.slots!.content];
      inst.slots!.content = ['img1', 'img2'];
      expect(errors(s).map((d) => [d.code, d.nodeId])).toEqual([['SLOT_REFUSED', 'img1'], ['SLOT_REFUSED', 'img2']]);
      inst.slots!.content = saved;
      delete home(s).nodes.img2;
      home(s).nodes.img1 = { id: 'img1', kind: 'text', tag: 'p', text: 'More' };
      home(s).nodes.t2 = { id: 't2', kind: 'text', tag: 'p', text: 'Most' };
      inst.slots!.content.push('t2');
      expect(errors(s).map((d) => [d.code, d.message])).toEqual([['SLOT_FULL', 'Home: the “Content” slot of Section holds at most 2, but shows more.']]);
      // Taking one out of a slot still over its limit is no new problem, so the session lets the author repair it.
      home(s).nodes.t3 = { id: 't3', kind: 'text', tag: 'p', text: 'Even more' };
      inst.slots!.content.push('t3');
      const over = errors(s).map((d) => d.message);
      inst.slots!.content.pop();
      expect(errors(s).map((d) => d.message)).toEqual(over);
      // A hand edit that is not a list of children, or a contract that cannot be read, is reported rather than failing
      // the open or the generator.
      for (const damaged of ['img1', {}, 42]) {
        inst.slots!.content = damaged as never;
        expect(errors(s).map((d) => d.code)).toContain('SLOT_INVALID');
        expect(() => generateProject(s)).not.toThrow();
        expect(() => generateProject(s, { instrument: true })).not.toThrow();
        // New content starts the damaged list again.
        const fixed = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'heading', text: 'Again' }]).state;
        expect(slotOf(fixed, b)).toHaveLength(1);
      }
      inst.slots!.content = [];
      s.components[id].slots!.content.categories = ['banner' as never];
      expect(errors(s).map((d) => d.message)).toEqual(['Section: the slot "content" lists categories other than hero, content, social-proof, conversion, media, layout, shell, primitive, custom.']);
    });

    it('lets a component be made from content in a slot already over its limit, since it only takes that content’s place', () => {
      const { s: base, id, b, page } = sections();
      let s = applyOperations(base, [
        { type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', categories: ['custom'], primitives: ['text'], max: 3 },
        { type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'heading' },
        { type: 'node.insert', owner: page, parentId: b, slot: 'content', primitive: 'paragraph' }
      ]).state;
      // A hand edit then lowers the limit below what the slot holds.
      s.components[id].slots!.content.max = 1;
      s = applyOperations(s, [{ type: 'component.createFromNode', owner: page, nodeId: slotOf(s, b)[0], name: 'Lead' }]).state;
      expect(slotOf(s, b)).toHaveLength(2);
    });

    it('counts a repeat in a slot as any number of items, whatever its list holds today', () => {
      const tree = { rootIds: ['r'], nodes: { r: { id: 'r', kind: 'repeat' as const, list: { $prop: 'rows' }, children: ['t'] }, t: { id: 't', kind: 'text' as const, tag: 'p' as const, text: 'x' }, e: { id: 'e', kind: 'repeat' as const, list: { $prop: 'rows' }, children: [] } } };
      const s = fresh();
      // The list can be handed in from an enclosing component with more items than its own maximum allows.
      expect(slotFill(s, tree, ['r'], { label: 'Content', max: 1 }).count).toBe(Infinity);
      expect(slotFill(s, tree, ['e'], { label: 'Content', max: 1 }).count).toBe(0);
      expect(slotFill(s, tree, ['r'], { label: 'Content', primitives: ['image'] }).refusedAll.map((r) => r.nodeId)).toEqual(['t']);
    });

    it('takes a slot passed on from outside only when what that slot allows fits it', () => {
      const { s: base, id } = sections();
      // The section's inner box becomes a component of its own: its slots pass the section's slots straight on.
      const w = applyOperations(base, [{ type: 'component.createFromNode', owner: { kind: 'component', id }, nodeId: 'inner', name: 'Inner' }]);
      const inner = w.results[0].definitionId as string;
      expect(w.state.components[inner].slots!.content).toEqual(w.state.components[id].slots!.content);
      expect(errors(w.state)).toEqual([]);
      // Narrower than what is passed on is refused: the outer slot can bring two items, or an image.
      expect(() => applyOperations(w.state, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Content', max: 1 }])).toThrow(/already holds more than 1/);
      expect(() => applyOperations(w.state, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Content', categories: null }])).toThrow(/already holds the content of “Content”, which can be media components, text and buttons/);
      // Widening the outer slot past what the inner one holds is refused too, at the outer slot.
      // Widening the outer slot past what the inner one holds is reported when the edit is saved...
      const wider = applyOperations(w.state, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', max: 3 }]).state;
      expect(errors(wider).map((d) => d.code)).toEqual(['SLOT_FULL']);
      // ...and once the inner one is over its limit, which the save cannot tell apart, widening further is refused here.
      expect(() => applyOperations(wider, [{ type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', max: 4 }])).toThrow(/slot it passes this content to holds at most 2/);
      // Both ends can change together in one edit.
      const images = applyOperations(w.state, [
        { type: 'component.setSlot', definitionId: id, slot: 'aside', label: 'Aside', primitives: ['image'] },
        { type: 'component.setSlot', definitionId: inner, slot: 'aside', label: 'Aside', primitives: ['image'] }
      ]).state;
      expect(errors(images)).toEqual([]);
      // A contract damaged by hand is reported, and decides nothing until it is fixed.
      (images.components[inner].slots!.aside as { primitives: unknown }).primitives = { bad: true };
      expect(() => applyOperations(images, [{ type: 'component.setSlot', definitionId: id, slot: 'aside', label: 'Side' }])).not.toThrow();
      expect(errors(images).map((d) => d.code)).toEqual(['SLOT_INVALID']);
    });
  });

  it('binds and unbinds node fields with type checks', () => {
    const f = fork(fresh(), 'features.grid');
    let s = f.state;
    const id = f.id;
    const own = { kind: 'component' as const, id };
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: id, prop: 'note', schema: { type: 'string', label: 'Note', default: 'Hello' } },
      { type: 'node.insert', owner: own, parentId: 'inner', primitive: 'paragraph' }
    ]).state;
    const pid = (s.components[id].tree!.nodes.inner as { children: string[] }).children.at(-1)!;
    s = applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: pid, field: 'text', binding: { $prop: 'note' } }]).state;
    expect(generateProject(s).get(`src/lib/siteorigin/generated/${id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.svelte`)).toContain('{note}');
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: pid, field: 'text', binding: { $prop: 'items' } }])).toThrow(/list property cannot/);
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: pid, field: 'text', binding: { $item: 'title' } }])).toThrow(/inside a repeat/);
    expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: id, prop: 'note' }])).toThrow(/still shown/);
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'note', schema: { type: 'image', label: 'Note' } }])).toThrow(/Unbind it first/);
    s = applyOperations(s, [
      { type: 'node.setBinding', owner: own, nodeId: 'card-title', field: 'when', binding: { $item: 'title' } },
      { type: 'node.setBinding', owner: own, nodeId: pid, field: 'text', binding: null }
    ]).state;
    expect(s.components[id].tree!.nodes[pid]).toMatchObject({ text: 'Hello' });
    expect(s.components[id].tree!.nodes['card-title'].when).toEqual({ $item: 'title' });
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: owner(s), nodeId: home(s).rootIds[0], field: 'when', binding: { $prop: 'x' } }])).toThrow(/component definitions/);
    expect(errors(s)).toEqual([]);
  });

  it('binds, checks, hoists and unbinds an image fallback alt like any other field', () => {
    const f = fork(fresh(), 'logos.strip');
    let s = f.state;
    const own = { kind: 'component' as const, id: f.id };
    expect(s.components[f.id].tree!.nodes['logo-image']).toMatchObject({ fallbackAlt: { $item: 'name' } });
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: 'logo-image', field: 'fallbackAlt', binding: { $item: 'logo' } }])).toThrow(/cannot be used as the fallbackAlt/);
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: 'wordmark', field: 'fallbackAlt', binding: { $item: 'name' } }])).toThrow(/has no "fallbackAlt" to bind/);
    // A property only the fallback shows is still in use: it can be bound, but not removed or retyped.
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: f.id, prop: 'brand', schema: { type: 'string', label: 'Brand', default: 'Acme' } },
      { type: 'node.setBinding', owner: own, nodeId: 'logo-image', field: 'fallbackAlt', binding: { $prop: 'brand' } }
    ]).state;
    expect(s.components[f.id].tree!.nodes['logo-image']).toMatchObject({ fallbackAlt: { $prop: 'brand' } });
    expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: f.id, prop: 'brand' }])).toThrow(/still shown/);
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: f.id, prop: 'brand', schema: { type: 'image', label: 'Brand' } }])).toThrow(/Unbind it first/);
    s = applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: 'logo-image', field: 'fallbackAlt', binding: { $item: 'name' } }]).state;

    // A logo item made into its own component takes the name as a property, for its wordmark and its fallback alt.
    const styled = Object.entries(s.components[f.id].variantAxes!.tone.options).filter(([, v]) => v.styles?.wordmark);
    const reset = applyOperations(s, styled.map(([vid]) => ({ type: 'node.resetStyles' as const, owner: own, nodeId: 'wordmark', variant: vid }))).state;
    const r = applyOperations(reset, [{ type: 'component.createFromNode', owner: own, nodeId: 'logo-item', name: 'Logo' }]);
    const logo = r.state.components[r.results[0].definitionId as string];
    const image = Object.values(logo.tree!.nodes).find((n) => n.kind === 'image')!;
    const wordmark = Object.values(logo.tree!.nodes).find((n) => n.kind === 'text')!;
    expect(image).toMatchObject({ fallbackAlt: { $prop: expect.any(String) } });
    expect((image as { fallbackAlt: unknown }).fallbackAlt).toEqual((wordmark as { text: unknown }).text);
    expect(errors(r.state)).toEqual([]);

    s = applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: 'logo-image', field: 'fallbackAlt', binding: null }]).state;
    expect('fallbackAlt' in s.components[f.id].tree!.nodes['logo-image']).toBe(false);
    expect(errors(s)).toEqual([]);
    (s.components[f.id].tree!.nodes['logo-image'] as { fallbackAlt?: unknown }).fallbackAlt = { $prop: 'missing' };
    expect(errors(s).map((d) => d.code)).toContain('BINDING_INVALID');
  });

  it('inserts rich text, repeats and slots only where they make sense', async () => {
    const f = fork(fresh(), 'features.grid');
    let s = f.state;
    const own = { kind: 'component' as const, id: f.id };
    const r = applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'inner', primitive: 'repeat', bind: 'items' }]);
    s = r.state;
    const rep = r.results[0].nodeId as string;
    s = applyOperations(s, [
      { type: 'node.insert', owner: own, parentId: rep, primitive: 'richtext', text: 'One\n\nTwo' },
      { type: 'node.insert', owner: own, parentId: rep, primitive: 'heading' }
    ]).state;
    const repNode = s.components[f.id].tree!.nodes[rep] as { children: string[] };
    expect(s.components[f.id].tree!.nodes[repNode.children[0]]).toMatchObject({ kind: 'text', rich: true, text: [{ type: 'p', spans: [{ text: 'One' }] }, { type: 'p', spans: [{ text: 'Two' }] }] });
    s = applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: repNode.children[1], field: 'text', binding: { $item: 'title' } }]).state;
    expect(errors(s)).toEqual([]);
    for (const [path, src] of generateProject(s)) if (path.endsWith('.svelte')) await compiles(path, src);
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'inner', primitive: 'repeat', bind: 'heading' }])).toThrow(/not a list/);
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'inner', primitive: 'slot', bind: 'nope' }])).toThrow(/setSlot/);
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: owner(s), primitive: 'repeat', bind: 'items' }])).toThrow(/editing a component/);
  });

  it('builds new list items from field defaults', () => {
    const s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const r = applyOperations(s, [{ type: 'instance.listInsert', owner: owner(s), nodeId: grid.id, prop: 'items' }]);
    const items = (home(r.state).nodes[grid.id] as InstanceNode).props.items as Array<{ id: string; title: string; icon: string }>;
    const added = items.find((i) => i.id === r.results[0].itemId)!;
    expect(added).toMatchObject({ title: 'Service', icon: 'sparkles' });
  });

  it('sets and clears a page social image', () => {
    let s = fresh();
    s = applyOperations(s, [
      { type: 'asset.add', asset: { id: 'a_one', name: 'One', file: 'static/assets/one.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image', createdAt: 'now' } },
      { type: 'page.update', pageId: s.site.homePageId, socialImage: 'a_one' }
    ]).state;
    expect(home(s).seo.socialImage).toBe('a_one');
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: s.site.homePageId, socialImage: 'a_missing' }])).toThrow(/not found/);
    s = applyOperations(s, [{ type: 'page.update', pageId: s.site.homePageId, socialImage: null }]).state;
    expect(home(s).seo.socialImage).toBeUndefined();
  });
});

describe('custom site styles (§2.5, spec §7.2)', () => {
  it('creates, uses, renames, replaces and removes custom tokens', async () => {
    const { tokenUsageCounts } = await import('@engine/tokens');
    let s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const c = applyOperations(s, [{ type: 'token.create', group: 'color', label: 'Sea green', value: '#2e8b57' }]);
    s = c.state;
    const id = c.results[0].tokenId as string;
    expect(id).toBe('color.custom-sea-green');
    expect(s.tokens.custom.find((t) => t.id === id)?.value).toBe('#2e8b57');
    expect(s.tokens.overrides[id]).toBeUndefined();
    expect(generateProject(s).get('src/lib/siteorigin/styles/tokens.css')).toContain('--so-color-custom-sea-green: #2e8b57;');
    expect(() => applyOperations(s, [{ type: 'token.create', group: 'color', label: 'Bad', value: 'red; x' }])).toThrow();
    expect(() => applyOperations(s, [{ type: 'token.create', group: 'text', label: 'Bad', value: { size: '1rem' } }])).toThrow(/needs family/);
    s = applyOperations(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: hero.id, scope: 'base', property: 'background', value: { token: id } },
      { type: 'token.create', group: 'color', label: 'Sea green', value: { token: id } },
      { type: 'token.rename', tokenId: id, label: 'Ocean' }
    ]).state;
    const follower = s.tokens.custom[1].id;
    expect(follower).toBe('color.custom-sea-green-2');
    expect(tokenUsageCounts(s)[id]).toBe(2);
    expect(s.tokens.custom[0].label).toBe('Ocean');
    // Changing a custom style changes its own value; there is no theme default to override.
    const changed = applyOperations(s, [{ type: 'token.set', tokenId: id, value: '#225544' }]).state;
    expect(changed.tokens.custom[0].value).toBe('#225544');
    expect(changed.tokens.overrides[id]).toBeUndefined();
    expect(() => applyOperations(s, [{ type: 'token.rename', tokenId: 'color.brand', label: 'x' }])).toThrow(/belongs to the theme/);
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: id }])).toThrow(/used 2 times/);
    expect(() => applyOperations(s, [{ type: 'token.replace', tokenId: id, withTokenId: 'space.md' }])).toThrow(/color style/);
    expect(() => applyOperations(s, [{ type: 'token.replace', tokenId: id, withTokenId: follower }])).toThrow(/loop/);
    const detached = applyOperations(s, [{ type: 'token.remove', tokenId: id, detach: true }]).state;
    expect((home(detached).nodes[hero.id] as InstanceNode).overrides?.root?.base?.background).toBe('#2e8b57');
    expect(detached.tokens.custom.map((t) => t.value)).toEqual(['#2e8b57']);
    s = applyOperations(s, [{ type: 'token.remove', tokenId: id, replacementTokenId: 'color.brand' }]).state;
    expect((home(s).nodes[hero.id] as InstanceNode).overrides?.root?.base?.background).toEqual({ token: 'color.brand' });
    expect(s.tokens.custom.find((t) => t.id === follower)?.value).toEqual({ token: 'color.brand' });
    expect(errors(s)).toEqual([]);
  });
});

describe('token properties (issue #96)', () => {
  /** A project component with a spacing token property and a list whose items choose an accent colour. */
  function tokenDef(s: ProjectState) {
    const r = applyOperations(s, [
      { type: 'token.create', group: 'space', label: 'Roomy', value: '3rem' },
      { type: 'token.create', group: 'color', label: 'Sea green', value: '#2e8b57' }
    ]);
    const [space, color] = [r.results[0].tokenId as string, r.results[1].tokenId as string];
    s = r.state;
    const def = {
      ...structuredClone(Object.values(s.components).find((d) => d.componentId === 'content.text')!),
      id: 'proj.panel',
      componentId: 'proj.panel',
      name: 'Panel',
      owner: 'project' as const,
      kind: 'code' as const,
      tree: undefined,
      source: '<script>let { spacing, cards } = $props();</script><div style:gap={spacing}>{#each cards as c (c.id)}<p style:color={c.accent}>{c.title}</p>{/each}</div>',
      properties: {
        spacing: { type: 'token' as const, label: 'Spacing', tokenGroup: 'space' as const, default: { token: space } },
        cards: { type: 'list' as const, label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string' as const, label: 'Title', default: 'Card' }, accent: { type: 'token' as const, label: 'Accent', tokenGroup: 'color' as const, default: { token: 'color.brand' } } }, default: [] },
        frame: { type: 'object' as const, label: 'Frame', fields: { note: { type: 'string' as const, label: 'Note', default: '' }, edge: { type: 'token' as const, label: 'Edge', tokenGroup: 'color' as const, default: { token: 'color.brand' } } }, default: { note: '', edge: { token: 'color.brand' } } }
      }
    };
    s.components[def.id] = def as never;
    return { s, def, space, color };
  }

  it('offers only tokens of its group, counts each one it holds, refuses removal while used and follows a replacement', () => {
    const { s: base, def, space, color } = tokenDef(fresh());
    let s = applyOperations(base, [{ type: 'node.insert', owner: owner(base), parentId: null, definitionId: def.id, props: { cards: [{ title: 'One', accent: color }, { title: 'Two', accent: { token: 'color.brand' } }], frame: { edge: color } } }]).state;
    const inst = () => home(s).nodes[home(s).rootIds.at(-1)!] as InstanceNode;
    // The placement's own choice, its default (unchanged, so the same token) and one card's accent are each a use.
    expect(inst().props.spacing).toEqual({ token: space });
    expect(tokenUsageCounts(s)[space]).toBe(2);
    // One card's accent and the object's edge.
    expect(tokenUsageCounts(s)[color]).toBe(2);
    // A token of another group, or one that does not exist, is not a choice.
    const at = { owner: owner(s), nodeId: inst().id };
    expect(() => applyOperations(s, [{ type: 'instance.setProp', ...at, prop: 'spacing', value: { token: 'color.brand' } }])).toThrow(/"Brand" is a color token; choose a space token/);
    expect(() => applyOperations(s, [{ type: 'instance.setProp', ...at, prop: 'spacing', value: 'space.nope' }])).toThrow(/there is no token "space.nope"/);
    // Removing a token a property holds is refused, and a property cannot keep a plain value in its place.
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: space }])).toThrow(/used 2 times/);
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: space, detach: true }])).toThrow(/chosen by 2 component properties/);
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: color, replacementTokenId: 'space.md' }])).toThrow(/replace it with a color style/);
    // Replacing moves every property that holds it, the definition's default included.
    s = applyOperations(s, [{ type: 'token.remove', tokenId: space, replacementTokenId: 'space.lg' }]).state;
    expect(inst().props.spacing).toEqual({ token: 'space.lg' });
    expect((s.components[def.id].properties.spacing as { default: unknown }).default).toEqual({ token: 'space.lg' });
    s = applyOperations(s, [{ type: 'token.replace', tokenId: color, withTokenId: 'color.accent' }]).state;
    expect((inst().props.cards as Array<{ accent: unknown }>).map((c) => c.accent)).toEqual([{ token: 'color.accent' }, { token: 'color.brand' }]);
    expect(inst().props.frame).toEqual({ note: '', edge: { token: 'color.accent' } });
    expect(tokenUsageCounts(s)[color]).toBeUndefined();
    expect(errors(s)).toEqual([]);
    // What the placement chose is the token's own variable, so it follows later edits to the token.
    const page = [...generateProject(s)].find(([p]) => p.endsWith('+page.svelte') && p.startsWith('src/routes/+'))![1];
    expect(page).toContain('var(--so-space-lg)');
    expect(page).toContain('var(--so-color-accent)');
  });

  it('reports a token property whose token is gone or of another group', () => {
    const { s: base, def, space } = tokenDef(fresh());
    const s = applyOperations(base, [{ type: 'node.insert', owner: owner(base), parentId: null, definitionId: def.id }]).state;
    const inst = home(s).nodes[home(s).rootIds.at(-1)!] as InstanceNode;
    inst.props.spacing = { token: 'space.gone' };
    expect(errors(s).map((d) => [d.code, d.nodeId])).toEqual([['TOKEN_MISSING', inst.id]]);
    inst.props.spacing = { token: 'color.brand' };
    expect(errors(s)[0]?.message).toMatch(/which is not a space style/);
    inst.props.spacing = { token: space };
    expect(errors(s)).toEqual([]);
  });

  it('declares a token property through the schema operation, starting on a token of its group', () => {
    const s = fresh();
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: home(s).rootIds[0], name: 'Mine' }]);
    const id = r.results[0].definitionId as string;
    const set = applyOperations(r.state, [
      { type: 'component.setPropSchema', definitionId: id, prop: 'accent', schema: { type: 'token', label: 'Accent', tokenGroup: 'color' } },
      { type: 'component.setPropSchema', definitionId: id, prop: 'gap', schema: { type: 'token', label: 'Gap', tokenGroup: 'space' } }
    ]).state;
    // Each starts on the first token of its own group.
    const first = (group: string) => effectiveTokens(set).find((t) => t.group === group)!.id;
    expect(set.components[id].properties.accent).toEqual({ type: 'token', label: 'Accent', tokenGroup: 'color', default: { token: first('color') } });
    expect(set.components[id].properties.gap).toEqual({ type: 'token', label: 'Gap', tokenGroup: 'space', default: { token: first('space') } });
    expect(() => applyOperations(r.state, [{ type: 'component.setPropSchema', definitionId: id, prop: 'accent', schema: { type: 'token', label: 'Accent', tokenGroup: 'text' } }])).toThrow(/tokenGroup must be one of color, font, space/);
    expect(() => applyOperations(r.state, [{ type: 'component.setPropSchema', definitionId: id, prop: 'accent', schema: { type: 'token', label: 'Accent', tokenGroup: 'color', default: 'space.md' } }])).toThrow(/is a space token; choose a color token/);
  });
});

describe('site styles that follow other styles (#201)', () => {
  const css = (s: ProjectState) => generateProject(s).get('src/lib/siteorigin/styles/tokens.css')!;
  const create = (s: ProjectState, group: 'space' | 'container' | 'radius' | 'shadow' | 'border' | 'font' | 'color', label: string, value: unknown) => {
    const r = applyOperations(s, [{ type: 'token.create', group, label, value }]);
    return { state: r.state, id: r.results[0].tokenId as string };
  };
  const set = (s: ProjectState, tokenId: string, value: unknown) => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;

  it('links a custom style of every non-text kind to another of its kind, and unlinks it again', () => {
    const cases = [
      ['space', '20px', 'space.md'],
      ['container', '900px', 'container.reading'],
      ['radius', '10px', 'radius.lg'],
      ['shadow', '0 1px 2px rgb(0 0 0 / 0.1)', 'shadow.md'],
      ['border', '2px solid var(--so-color-brand)', 'border.default'],
      ['font', 'Georgia, serif', 'font.body']
    ] as const;
    for (const [group, literal, target] of cases) {
      const made = create(fresh(), group, 'Mine', literal);
      const linked = set(made.state, made.id, { token: target });
      expect(linked.tokens.custom[0].value, group).toEqual({ token: target });
      expect(linked.tokens.overrides[made.id], group).toBeUndefined();
      expect(css(linked), group).toContain(`--so-${made.id.replace('.', '-')}: var(--so-${target.replace('.', '-')});`);
      expect(errors(linked), group).toEqual([]);
      const own = set(linked, made.id, literal);
      expect(own.tokens.custom[0].value, group).toBe(literal);
    }
  });

  it('creates a custom style that follows another from the start, and lets theme styles follow too', () => {
    const made = create(fresh(), 'space', 'Gutter', { token: 'space.lg' });
    expect(made.state.tokens.custom[0].value).toEqual({ token: 'space.lg' });
    const theme = set(made.state, 'radius.sm', { token: 'radius.md' });
    expect(theme.tokens.overrides['radius.sm']).toEqual({ token: 'radius.md' });
    expect(css(theme)).toContain('--so-radius-sm: var(--so-radius-md);');
    expect(errors(theme)).toEqual([]);
  });

  it('refuses links to missing styles, to another kind of style and in a loop', () => {
    const made = create(fresh(), 'space', 'Gutter', '20px');
    expect(() => set(made.state, made.id, { token: 'space.nope' })).toThrow(/does not exist/);
    expect(() => set(made.state, 'color.brand', { token: 'color.nope' })).toThrow(/does not exist/);
    expect(() => set(made.state, made.id, { token: 'color.brand' })).toThrow(/spacing style|space style/);
    expect(() => set(made.state, 'font.body', { token: 'space.md' })).toThrow(/font style/);
    expect(() => set(made.state, made.id, { token: 'space.md', extra: 1 })).toThrow(/must be \{ "token"/);
    expect(() => set(made.state, made.id, { token: 7 })).toThrow(/must be \{ "token"/);
    // A style that already leads nowhere cannot be followed: its followers would lose their value too.
    const broken = fresh();
    broken.tokens.overrides['color.accent'] = { token: 'color.missing' };
    expect(() => set(broken, 'color.brand', { token: 'color.accent' })).toThrow(/does not exist/);
    const wrongKind = fresh();
    wrongKind.tokens.overrides['color.accent'] = { token: 'space.md' };
    expect(() => set(wrongKind, 'color.brand', { token: 'color.accent' })).toThrow(/spacing style/);
    // An older document's link with an extra key is still a link to the style it names, as tokens.css writes it.
    const extra = fresh();
    extra.tokens.overrides['color.accent'] = { token: 'color.missing', extra: 1 } as never;
    expect(() => set(extra, 'color.brand', { token: 'color.accent' })).toThrow(/does not exist/);
    // Keys an older document left beside a color's link do not hide it: tokens.css still writes the link.
    const shaped = fresh();
    shaped.tokens.overrides['color.accent'] = { token: 'color.brand', size: 'legacy' } as never;
    expect(() => set(shaped, 'color.brand', { token: 'color.accent' })).toThrow(/loop/);
    const chain = set(made.state, 'space.md', { token: made.id });
    expect(() => set(chain, made.id, { token: 'space.md' })).toThrow(/loop/);
    expect(() => create(fresh(), 'radius', 'Bad', { token: 'radius.nope' })).toThrow(/does not exist/);
  });

  it('refuses a text style following another text style, and leaves the style and its CSS whole', () => {
    const s = fresh();
    expect(() => set(s, 'text.h1', { token: 'text.h2' })).toThrow(/text style/i);
    const custom = applyOperations(s, [{ type: 'token.create', group: 'text', label: 'Callout', value: { family: { token: 'font.body' }, size: '1rem', lineHeight: '1.5', weight: 400, tracking: '0' } }]);
    const id = custom.results[0].tokenId as string;
    expect(() => set(custom.state, id, { token: 'text.h2' })).toThrow(/text style/i);
    expect(() => applyOperations(s, [{ type: 'token.create', group: 'text', label: 'Alias', value: { token: 'text.h2' } }])).toThrow(/cannot follow/);
    const before = css(custom.state);
    expect(() => set(custom.state, 'text.h1', { token: 'text.h2' })).toThrow(/cannot follow/);
    expect(css(custom.state)).toBe(before);
    const out = css(custom.state);
    const name = `--so-${id.replace('.', '-')}`;
    for (const k of ['family', 'size', 'line-height', 'weight', 'tracking']) expect(out).toContain(`${name}-${k}:`);
    expect(out).toContain('--so-text-h1-size:');
  });

  it('checks spacing, page width and corner values are CSS lengths', () => {
    const made = create(fresh(), 'space', 'Gutter', '20px');
    for (const bad of ['red', '12px solid', '1 2', 'url(x)', '#fff'])
      expect(() => set(made.state, made.id, bad), bad).toThrow(/length/);
    for (const good of ['0', '1.5rem', '-8px', 'clamp(1rem, 2vw + 1rem, 3rem)', 'calc(100% - 2rem)', 'min(90vw, 1200px)'])
      expect(set(made.state, made.id, good).tokens.custom[0].value, good).toBe(good);
    expect(() => set(fresh(), 'container.content', 'wide')).toThrow(/length/);
    expect(set(fresh(), 'container.content', '100%').tokens.overrides['container.content']).toBe('100%');
    expect(() => set(fresh(), 'radius.md', 'round')).toThrow(/length/);
    expect(() => create(fresh(), 'radius', 'Soft', 'soft')).toThrow(/length/);
    // The theme's own values all pass the same check.
    for (const t of effectiveTokens(fresh()).filter((x) => ['space', 'container', 'radius'].includes(x.group)))
      expect(set(fresh(), t.id, t.value).tokens.overrides[t.id], t.id).toBe(t.value);
  });

  it('says a custom style has no theme default to go back to', () => {
    const made = create(fresh(), 'color', 'Sea', '#2e8b57');
    expect(() => set(made.state, made.id, null)).toThrow(/no theme default/);
    // An override left on a custom style by an older version is the value in use, so it is not thrown away either.
    const stray = structuredClone(made.state);
    stray.tokens.overrides[made.id] = '#123456';
    expect(() => set(stray, made.id, null)).toThrow(/no theme default/);
    const mended = set(stray, made.id, '#654321');
    expect(mended.tokens.custom[0].value).toBe('#654321');
    expect(mended.tokens.overrides[made.id]).toBeUndefined();
    // A theme style still goes back to the theme's value.
    const changed = set(made.state, 'color.brand', '#123456');
    expect(set(changed, 'color.brand', null).tokens.overrides['color.brand']).toBeUndefined();
  });

  it('keeps a followed font working for a text style family', () => {
    expect(() => set(fresh(), 'text.h1', { family: { token: 'space.md' } })).toThrow(/existing font token/);
    expect(() => set(fresh(), 'text.h1', { size: null })).toThrow(/Invalid size/);
    expect(() => set(fresh(), 'text.h1', { lineHeight: null })).toThrow(/Invalid lineHeight/);
    const made = create(fresh(), 'font', 'Accent', { token: 'font.display' });
    const s = set(made.state, 'text.h1', { family: { token: made.id } });
    expect(errors(s)).toEqual([]);
    const out = css(s);
    expect(out).toContain(`--so-${made.id.replace('.', '-')}: var(--so-font-display);`);
    expect(out).toContain(`--so-text-h1-family: var(--so-${made.id.replace('.', '-')});`);
  });
});

describe('validateState catches external corruption (§2.5)', () => {
  it('reports token cycles, missing tokens, bad tags, stray slots and component cycles', () => {
    const s = fresh();
    s.tokens.overrides['color.brand'] = { token: 'color.accent' };
    s.tokens.overrides['color.accent'] = { token: 'color.brand' };
    const page = home(s);
    const hero = firstInstance(s, 'hero.split');
    hero.overrides = { root: { base: { background: { token: 'color.nope' } } } };
    page.nodes.bad = { id: 'bad', kind: 'element', tag: 'script' as never, children: [] };
    page.nodes.slot = { id: 'slot', kind: 'slot', slot: 'content' };
    page.rootIds.push('bad', 'slot');
    const def = structuredClone(s.components[firstInstance(s, 'cta.banner').definitionId]);
    def.id = 'proj.loop';
    def.owner = 'project';
    def.tree!.nodes.self = { id: 'self', kind: 'instance', definitionId: def.id, props: {} };
    (def.tree!.nodes[def.tree!.rootIds[0]] as { children: string[] }).children.push('self');
    s.components[def.id] = def;
    const codes = new Set(errors(s).map((d) => d.code));
    for (const c of ['TOKEN_CYCLE', 'TOKEN_MISSING', 'TAG_INVALID', 'SLOT_INVALID', 'DEF_CYCLE']) expect(codes.has(c), c).toBe(true);
  });
});

describe('theme switching contracts (§2.5)', () => {
  it('blocks a switch when an enum value in use has no option in the new theme', () => {
    const s = fresh();
    const hero = firstInstance(s, 'hero.split');
    const def = s.components[hero.definitionId];
    def.properties.mood = { type: 'enum', label: 'Mood', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'loud', label: 'Loud' }] };
    hero.props.mood = 'loud';
    expect(() => applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }])).toThrow(/property "mood" is not compatible/);
  });

  it('leaves pinned theme definitions untouched and uses one lock hash format', async () => {
    const { definitionHash } = await import('@engine/install');
    let s = fresh();
    const cta = defOf(s, 'cta.banner');
    const stats = defOf(s, 'stats.row');
    // A theme definition (CTA) placing another (Stats), pinned by a project component that places the CTA.
    cta.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: stats.id, props: {} };
    (cta.tree!.nodes[cta.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.move', owner: owner(s), nodeId: firstInstance(s, 'cta.banner').id, parentId: section, slot: 'content', index: 0 }]).state;
    s = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: section, name: 'Pinned' }]).state;
    s = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    expect(s.components[cta.id]).toBeDefined();
    expect((s.components[cta.id].tree!.nodes.nested as InstanceNode).definitionId).toBe(stats.id);
    expect(s.components[stats.id]).toBeDefined();
    const alt = s.components['foundation-alt.hero.split'];
    expect(s.themeLock.components[alt.id].hash).toBe(definitionHash(alt));
  });
});

describe('review follow-ups for definition editing', () => {
  it('rejects names generated code already uses, and inherited object keys', () => {
    const s = fresh();
    const bad = (properties: Record<string, unknown>) => () => applyOperations(s, [{ type: 'component.createCode', name: 'X', source: '', properties }]);
    for (const name of ['has', 'item2', 'toString', 'constructor']) expect(bad({ [name]: { type: 'string' } }), name).toThrow(/reserved|camelCase/);
    expect(bad({ rows: { type: 'list', fields: { id: { type: 'string' } } } })).toThrow(/reserved/);
    const f = fork(s, 'features.grid');
    expect(() => applyOperations(f.state, [{ type: 'component.setSlot', definitionId: f.id, slot: 'toString', label: 'x' }])).toThrow(/camelCase/);
    expect(() => applyOperations(f.state, [{ type: 'component.setPart', definitionId: f.id, partId: 'x', nodeId: 'card-text', label: 'x', styleControls: ['toString'] }])).toThrow(/Unknown style/);
    expect(() => applyOperations(f.state, [{ type: 'node.setStyle', owner: owner(s), nodeId: firstInstance(s, 'hero.split').id, scope: 'base', property: 'toString', value: '1' }])).toThrow(/Unknown style/);
    expect(() => applyOperations(f.state, [{ type: 'node.setStyle', owner: owner(s), nodeId: firstInstance(s, 'hero.split').id, scope: 'base', property: 'maxWidth', value: { token: 'color.brand' } }])).toThrow(/container or space/);
  });

  it('refuses type changes that would lose placed content', () => {
    let s = fresh();
    s = applyOperations(s, [{ type: 'asset.add', asset: { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image', createdAt: 'now' } }]).state;
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Pic', source: '<p>x</p>\n', properties: { photo: { type: 'image', label: 'Photo' } } }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), definitionId: id, props: { photo: { assetId: 'a_pic', alt: 'A' } } }]).state;
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: id, prop: 'photo', schema: { type: 'link', label: 'Photo' } }])).toThrow(/cannot keep/);
  });

  it('checks item fields when a repeat changes list, and when an element moves out of its list', () => {
    const f = fork(fresh(), 'features.grid');
    const own = { kind: 'component' as const, id: f.id };
    const s = applyOperations(f.state, [{ type: 'component.setPropSchema', definitionId: f.id, prop: 'names', schema: { type: 'list', label: 'Names', fields: { name: { type: 'string', label: 'Name' } } } }]).state;
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: own, nodeId: 'cards', field: 'list', binding: { $prop: 'names' } }])).toThrow(/items do not have/);
    expect(s.components[f.id].tree!.nodes.cards).toMatchObject({ list: { $prop: 'items' } });
  });

  it('drops placement overrides of a part whose element is removed from the definition', () => {
    const f = fork(fresh(), 'hero.split');
    const hero = firstInstance(f.state, 'hero.split');
    let s = applyOperations(f.state, [{ type: 'node.setStyle', owner: owner(f.state), nodeId: hero.id, partId: 'eyebrow', scope: 'base', property: 'color', value: '#ff0000' }]).state;
    expect((home(s).nodes[hero.id] as InstanceNode).overrides?.eyebrow).toBeDefined();
    s = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'component', id: f.id }, nodeId: 'eyebrow' }]).state;
    expect((home(s).nodes[hero.id] as InstanceNode).overrides?.eyebrow).toBeUndefined();
  });

  it('keeps managed dependencies current and blocks removing what code imports or names', () => {
    let s = blankWithSection();
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'stack' }]).state;
    const stackId = (home(s).nodes[section] as InstanceNode).slots!.content.at(-1)!;
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: stackId, componentId: 'stats.row' }]).state;
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: stackId, name: 'Wrap' }]);
    s = r.state;
    const wrap = s.components[r.results[0].definitionId as string];
    const nested = Object.values(wrap.tree!.nodes).find((n) => n.kind === 'instance')!;
    s = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'component', id: wrap.id }, nodeId: nested.id }]).state;
    expect(s.components[wrap.id].dependencies).toBeUndefined();
    // A code component importing the wrapper's generated file keeps it installed.
    const target = `${wrap.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.svelte`;
    s = applyOperations(s, [
      { type: 'node.remove', owner: owner(s), nodeId: r.results[0].nodeId as string },
      { type: 'component.createCode', name: 'Uses wrap', source: `<script>\n\timport W from '../generated/${target}';\n</script>\n<W />\n<p style="color: var(--so-color-custom-teal)">x</p>\n` },
      { type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }
    ]).state;
    expect(() => applyOperations(s, [{ type: 'component.remove', definitionId: wrap.id }])).toThrow(/needed by/);
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: 'color.custom-teal' }])).toThrow(/written into the source/);
  });

  it('rejects variant rules on elements that render nothing', () => {
    const f = fork(fresh(), 'features.grid');
    const variant = Object.keys(f.state.components[f.id].variantAxes!.tone.options)[0];
    expect(() => applyOperations(f.state, [{ type: 'node.setStyle', owner: { kind: 'component', id: f.id }, nodeId: 'cards', variant, scope: 'base', property: 'gap', value: '1px' }])).toThrow(/render no element/);
  });

  it('checks enum options in use against the new theme, ignoring pinned placements', async () => {
    const { getTheme } = await import('@catalogue/index');
    const altHero = getTheme('foundation-alt').components.find((c) => c.componentId === 'hero.split')!;
    altHero.properties.mood = { type: 'enum', label: 'Mood', default: 'calm', options: [{ value: 'calm', label: 'Calm' }] };
    try {
      const s = fresh();
      const hero = firstInstance(s, 'hero.split');
      s.components[hero.definitionId].properties.mood = { type: 'enum', label: 'Mood', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'loud', label: 'Loud' }] };
      hero.props.mood = 'loud';
      expect(() => applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }])).toThrow(/has no option "loud"/);
      hero.props.mood = 'calm';
      expect(applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state.site.themeId).toBe('foundation-alt');
    } finally {
      delete altHero.properties.mood;
    }
  });
});

describe('schema type changes on placed components', () => {
  it('treats an untouched default as no content, so the type can change', () => {
    let s = fresh();
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Flag', source: '<p>x</p>\n', properties: { shown: { type: 'string', label: 'Shown', default: 'yes' } } }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), definitionId: id }]);
    s = applyOperations(ins.state, [{ type: 'component.setPropSchema', definitionId: id, prop: 'shown', schema: { type: 'boolean', label: 'Shown', default: true } }]).state;
    expect((home(s).nodes[ins.results[0].nodeId as string] as InstanceNode).props.shown).toBe(true);
  });
});

describe('duplicating a page', () => {
  /** A Contact page with an "Hours" section and links: to its own section, to the page itself, and to another page's section. */
  const contactWithLinks = () => {
    let s = fresh();
    const [homeId, aboutId, contactId] = s.site.pageOrder;
    const o = { kind: 'page' as const, id: contactId };
    const sec = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, componentId: 'layout.section' }]);
    const sectionId = sec.results[0].nodeId as string;
    s = applyOperations(sec.state, [{ type: 'node.setContent', owner: o, nodeId: sectionId, field: 'anchor', value: 'studio-hours' }]).state;
    const button = (link: unknown) => {
      const b = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: sectionId, slot: 'content', primitive: 'button', text: 'Go' }]);
      const id = b.results[0].nodeId as string;
      s = applyOperations(b.state, [{ type: 'node.setContent', owner: o, nodeId: id, field: 'link', value: link }]).state;
      return id;
    };
    // Another page's section with the same ID as Contact's own: only the link's target tells them apart.
    const aboutRoot = s.pages[aboutId].nodes[s.pages[aboutId].rootIds[0]];
    s = structuredClone(s);
    s.pages[aboutId].nodes[aboutRoot.id].anchor = 'studio-hours';
    const own = button({ type: 'page', target: contactId, anchor: 'studio-hours' });
    const whole = button({ type: 'page', target: contactId });
    const other = button({ type: 'page', target: aboutId, anchor: 'studio-hours' });
    const local = button({ type: 'anchor', target: 'studio-hours' });
    // A link inside rich text, which the engine stores the same way.
    const rich = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: sectionId, slot: 'content', primitive: 'richtext', text: 'See the hours' }]);
    s = structuredClone(rich.state);
    const richId = rich.results[0].nodeId as string;
    const richNode = s.pages[contactId].nodes[richId] as unknown as { text: Array<{ spans: Array<Record<string, unknown>> }> };
    richNode.text[0].spans[0].link = { type: 'page', target: contactId, anchor: 'studio-hours' };
    return { s, homeId, aboutId, contactId, ids: { own, whole, other, local, richId } };
  };
  const linkOf = (s: ProjectState, pageId: string, id: string) => (s.pages[pageId].nodes[id] as { link: unknown }).link;

  it("points the copy's links to its own sections at the copy, and leaves every other link alone", () => {
    const { s, aboutId, contactId, ids } = contactWithLinks();
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: contactId, title: 'Contact copy' }]);
    const copyId = r.results[0].pageId as string;
    const copy = r.state.pages[copyId];
    // Nodes get new IDs; find the copied buttons by their links, in page order.
    const links = Object.values(copy.nodes).filter((n) => n.kind === 'link').map((n) => (n as { link: Record<string, unknown> }).link);
    expect(links).toContainEqual({ type: 'page', target: copyId, anchor: 'studio-hours' });
    expect(links).toContainEqual({ type: 'page', target: contactId });
    expect(links).toContainEqual({ type: 'page', target: aboutId, anchor: 'studio-hours' });
    expect(links).toContainEqual({ type: 'anchor', target: 'studio-hours' });
    expect(links.filter((l) => l.target === contactId && l.anchor)).toEqual([]);
    const spans = Object.values(copy.nodes).flatMap((n) => (n.kind === 'text' && Array.isArray(n.text) ? (n.text as Array<{ spans?: Array<{ link?: unknown }> }>).flatMap((b) => b.spans ?? []) : []));
    expect(spans.find((sp) => sp.link)?.link).toEqual({ type: 'page', target: copyId, anchor: 'studio-hours' });
    // The original is untouched, and both pages have the section and a working link to it.
    expect(linkOf(r.state, contactId, ids.own)).toEqual({ type: 'page', target: contactId, anchor: 'studio-hours' });
    expect(s.pages[contactId]).toEqual(r.state.pages[contactId]);
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('leaves a link to a header or footer section pointing at the source page', () => {
    const { s, contactId } = contactWithLinks();
    // The starter header's navigation renders with this ID on every page.
    expect(pageIds(s, contactId).has('so-site-nav')).toBe(true);
    const btn = Object.values(s.pages[contactId].nodes).find((n) => n.kind === 'link')!;
    (btn as { link: unknown }).link = { type: 'page', target: contactId, anchor: 'so-site-nav' };
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: contactId, title: 'Contact copy' }]);
    const copy = r.state.pages[r.results[0].pageId as string];
    const link = Object.values(copy.nodes).find((n) => n.kind === 'link' && (n as { link: { anchor?: string } }).link.anchor === 'so-site-nav') as { link: { target: string } };
    expect(link.link.target).toBe(contactId);
  });
});

describe('making another page Home keeps its old address working (#37)', () => {
  const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
  const setHome = (s: ProjectState, pageId: string, keepOldAddress?: boolean) => applyOperations(s, [{ type: 'page.setHome', pageId, ...(keepOldAddress === undefined ? {} : { keepOldAddress }) }]);
  const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
  /** The generated route at `dir`: "redirect" with its destination, "page" for a page, or undefined. */
  const routeAt = (s: ProjectState, dir: string) => {
    const f = generateProject(s).get(`src/routes/${dir}/+page.svelte`);
    if (f === undefined) return undefined;
    return f.includes('http-equiv="refresh"') ? `redirect ${f.match(/resolve\(("[^"]*")\)/)![1]}` : 'page';
  };

  it('moves both pages, reports it, and generates a redirect at the vacated address', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    const homeId = s.site.homePageId;
    const r = setHome(s, about);
    expect(r.results[0]).toEqual({ moved: [{ pageId: about, from: '/about/', to: '/' }, { pageId: homeId, from: '/', to: '/home/' }], kept: '/about/' });
    expect(r.state.pages[about].route).toBe('/');
    expect(r.state.pages[homeId].route).toBe('/home/');
    expect(r.state.site.redirects).toEqual([{ from: '/about/', pageId: about }]);
    expect(errors(r.state)).toEqual([]);
    expect(routeAt(r.state, 'about')).toBe('redirect "/"');
    expect(routeAt(r.state, 'home')).toBe('page');
    // The redirect is not a page: the sitemap and page count stay as they were.
    expect(r.state.site.pageOrder).toHaveLength(3);
  });

  it('never gives the previous Home the address it keeps, even when the titles match', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const homeId = s.site.homePageId;
    s = applyOperations(s, [{ type: 'page.update', pageId: homeId, title: 'About' }]).state;
    const r = setHome(s, about);
    expect(r.state.pages[homeId].route).toBe('/about-2/');
    expect(r.state.site.redirects).toEqual([{ from: '/about/', pageId: about }]);
    expect(routeAt(r.state, 'about')).toBe('redirect "/"');
    expect(routeAt(r.state, 'about-2')).toBe('page');
    expect(errors(r.state)).toEqual([]);
    // Without keeping it, the previous Home may take the address, and the preview says so exactly.
    const plain = setHome(s, about, false);
    expect(plain.state.pages[homeId].route).toBe('/about/');
    expect(planHomeChange(s, about, false)).toEqual(plain.results[0]);
    expect(routeAt(plain.state, 'about')).toBe('page');
  });

  it('keeps nothing when asked not to', () => {
    const s = fresh();
    const r = setHome(s, byTitle(s, 'About').id, false);
    expect(r.results[0]).toEqual({ moved: expect.any(Array) });
    expect(r.state.site.redirects).toBeUndefined();
    expect(r.results[0]).toEqual({ moved: [{ pageId: r.state.site.homePageId, from: '/about/', to: '/' }, expect.objectContaining({ to: '/home/' })] });
    expect(routeAt(r.state, 'about')).toBeUndefined();
  });

  it('gives a page its own old address back when it stops being Home', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const homeId = s.site.homePageId;
    s = setHome(s, about).state;
    const r = setHome(s, homeId);
    expect(r.state.pages[homeId].route).toBe('/');
    expect(r.state.pages[about].route).toBe('/about/');
    // Old links to /home/ still reach the original Home page; /about/ is a page again.
    expect(r.state.site.redirects).toEqual([{ from: '/home/', pageId: homeId }]);
    expect(routeAt(r.state, 'about')).toBe('page');
    expect(routeAt(r.state, 'home')).toBe('redirect "/"');
    expect(errors(r.state)).toEqual([]);
  });

  it('changes no link, menu label or unrelated link: page links follow the pages', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const homeId = s.site.homePageId;
    const header = s.site.shell.header.rootIds[0];
    const links = (s.site.shell.header.nodes[header] as InstanceNode).props.links as Array<{ id: string; label: string }>;
    const aboutItem = links.find((l) => l.label === 'About')!.id;
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: aboutItem, field: 'label', value: 'Our practice' }]).state;
    const shellBefore = structuredClone(s.site.shell);
    const r = setHome(s, about);
    expect(r.state.site.shell).toEqual(shellBefore);
    const shown = shellPageLinks(r.state, [about, homeId]).map((l) => `${l.part}:${l.label}->${r.state.pages[l.pageId].route}`);
    expect(shown).toEqual(['header:Home->/home/', 'header:Our practice->/', 'footer:Home->/home/', 'footer:About->/']);
    const layout = generateProject(r.state).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('Our practice');
    expect(layout).toContain('"/contact/"');
    expect(layout).toContain('hello@example.com');
  });

  it('lets a page take over a kept address it is given, and skips one when choosing an address itself', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    s = setHome(s, about).state;
    const auto = applyOperations(s, [{ type: 'page.create', title: 'About' }]);
    expect(auto.results[0].route).toBe('/about-2/');
    expect(auto.state.site.redirects).toEqual([{ from: '/about/', pageId: about }]);
    const dup = applyOperations(s, [{ type: 'page.duplicate', pageId: byTitle(s, 'Contact').id, title: 'About' }]);
    expect(dup.results[0].route).toBe('/about-2/');
    const chosen = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/' }]);
    expect(chosen.state.site.redirects).toBeUndefined();
    // Taking one address over leaves the others.
    const two = { ...s, site: { ...s.site, redirects: [...s.site.redirects!, { from: '/old/', pageId: about }] } };
    expect(applyOperations(two, [{ type: 'page.create', title: 'Team', route: '/about/' }]).state.site.redirects).toEqual([{ from: '/old/', pageId: about }]);
    expect(routeAt(chosen.state, 'about')).toBe('page');
    const moved = applyOperations(s, [{ type: 'page.update', pageId: byTitle(s, 'Contact').id, route: '/ABOUT/' }]);
    // Contact takes /about/ over; the address it leaves is kept working for it in turn (#169).
    expect(moved.state.site.redirects).toEqual([{ from: '/contact/', pageId: byTitle(s, 'Contact').id }]);
    expect(errors(moved.state)).toEqual([]);
  });

  it('sends a kept address to the replacement when its page is removed, or drops it', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const contact = byTitle(s, 'Contact').id;
    s = setHome(s, about).state;
    const replaced = applyOperations(s, [{ type: 'page.remove', pageId: about, replacementPageId: contact }]).state;
    expect(replaced.pages[contact].route).toBe('/');
    expect(replaced.site.redirects).toEqual([{ from: '/about/', pageId: contact }]);
    expect(errors(replaced)).toEqual([]);
    // A page nothing links to can go without a replacement; its kept address goes with it.
    let t = fresh();
    const homeId = t.site.homePageId;
    const extra = applyOperations(t, [{ type: 'page.create', title: 'Team' }]);
    const team = extra.results[0].pageId as string;
    t = setHome(extra.state, team).state;
    t = applyOperations(t, [{ type: 'page.update', pageId: team, title: 'Crew' }]).state;
    t = setHome(t, homeId).state;
    expect(t.pages[team].route).toBe('/crew/');
    expect(t.site.redirects).toEqual([{ from: '/team/', pageId: team }, { from: '/home/', pageId: homeId }]);
    const gone = applyOperations(t, [{ type: 'page.remove', pageId: team }]).state;
    expect(gone.site.redirects).toEqual([{ from: '/home/', pageId: homeId }]);
    expect(errors(gone)).toEqual([]);
    // Removing Home promotes another page, which keeps no address of its own.
    const homeGone = applyOperations(replaced, [{ type: 'page.remove', pageId: contact, replacementPageId: byTitle(replaced, 'Home').id }]).state;
    expect(homeGone.pages[byTitle(replaced, 'Home').id].route).toBe('/');
    expect(homeGone.site.redirects).toEqual([{ from: '/about/', pageId: byTitle(replaced, 'Home').id }]);
  });

  it('gives the previous Home a valid address when its title is a reserved name', () => {
    let s = fresh();
    const homeId = s.site.homePageId;
    s = applyOperations(s, [{ type: 'page.update', pageId: homeId, title: 'API' }]).state;
    const r = setHome(s, byTitle(s, 'About').id);
    expect(r.state.pages[homeId].route).toBe('/api-page/');
    expect(errors(r.state)).toEqual([]);
  });

  it('previews the change without making it', () => {
    const s = fresh();
    const before = structuredClone(s);
    const about = byTitle(s, 'About').id;
    expect(planHomeChange(s, about, true)).toEqual(setHome(s, about).results[0]);
    expect(planHomeChange(s, about, false).kept).toBeUndefined();
    expect(planHomeChange(s, s.site.homePageId, true)).toEqual({ moved: [] });
    expect(s).toEqual(before);
  });

  it('reports damaged or colliding kept addresses, and never generates one outside the routes folder', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    s.site.redirects = [
      { from: '/about/', pageId: about },
      { from: '/../../escape/', pageId: about },
      { from: '/gone/', pageId: 'pg_missing' },
      { from: '/', pageId: about }
    ];
    const codes = validateState(s).map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['ROUTE_DUPLICATE', 'ROUTE_INVALID', 'REDIRECT_TARGET']));
    expect(validateState(s).some((d) => d.code === 'ROUTE_INVALID' && d.message.startsWith('Old address /:'))).toBe(true);
    expect(validateState(s).some((d) => d.code === 'ROUTE_INVALID' && d.message.startsWith('Old address /../../escape/:'))).toBe(true);
    const files = generateProject(s);
    expect([...files.values()].filter((f) => f.includes('http-equiv="refresh"'))).toEqual([]);
    expect([...files.keys()].some((f) => f.includes('..'))).toBe(false);
    (s.site as { redirects: unknown }).redirects = { from: '/x/' };
    expect(validateState(s).map((d) => d.code)).toContain('REDIRECT_INVALID');
    expect(() => generateProject(s)).not.toThrow();
  });

  it('refuses a replacement Home that is not one of the pages', () => {
    const s = fresh();
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: s.site.homePageId, replacementPageId: 'toString' }])).toThrow(/replacement page does not exist/);
  });

  it('removes the list once its last kept address goes', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    s = setHome(s, about).state;
    expect(s.site.redirects).toHaveLength(1);
    const claimed = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/' }]).state;
    expect('redirects' in claimed.site).toBe(false);
    const team = applyOperations(s, [{ type: 'page.create', title: 'Team' }]);
    const teamId = team.results[0].pageId as string;
    // A page nothing links to, owning the only kept address, goes with it.
    const only = { ...team.state, site: { ...team.state.site, redirects: [{ from: '/about/', pageId: teamId }] } };
    expect('redirects' in applyOperations(only, [{ type: 'page.remove', pageId: teamId }]).state.site).toBe(false);
  });

  it('lists the header and footer links visitors see, with their own words, wherever they are', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const header = s.site.shell.header.rootIds[0];
    // A labelled call to action counts; one without a label is not shown, so it is not listed.
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'ctaLink', value: { type: 'page', target: about } }]).state;
    expect(shellPageLinks(s, [about]).map((l) => `${l.part}:${l.label}`)).toEqual(['header:About', 'header:Book a call', 'footer:About']);
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'ctaLabel', value: '' }]).state;
    expect(shellPageLinks(s, [about]).map((l) => `${l.part}:${l.label}`)).toEqual(['header:About', 'footer:About']);
    // A link inside footer text counts too, and names the footer element it is in.
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, primitive: 'richtext' }]);
    const text = r.results[0].nodeId as string;
    (r.state.site.shell.footer.nodes[text] as { text: unknown }).text = [{ type: 'p', spans: [{ text: 'Read ' }, { text: 'our story', link: { type: 'page', target: about } }] }];
    const inText = shellPageLinks(r.state, [about]).find((l) => l.nodeId === text);
    expect(inText).toMatchObject({ part: 'footer', label: 'our story', pageId: about });
  });
});

describe('inserting a node the same batch fills (#13)', () => {
  const photo = { id: 'img_nook', name: 'Reading nook', file: 'static/assets/reading-nook.png', mime: 'image/png', bytes: 10, hash: 'nook', kind: 'image' as const, createdAt: '2026-11-24T00:00:00.000Z', altSuggestion: 'A reading corner with an armchair' };
  const withPhoto = () => applyOperations(fresh(), [{ type: 'asset.add', asset: photo }]).state;

  it('puts a new section and a picture placed in it into one batch, with the asset’s suggested alt text', () => {
    const s = withPhoto();
    const o = owner(s);
    const r = applyOperations(s, [
      { type: 'node.insert', newNodeId: 'n_section1', owner: o, parentId: null, index: 1, componentId: 'layout.section' },
      { type: 'node.insert', newNodeId: 'n_picture1', owner: o, parentId: 'n_section1', slot: 'content', primitive: 'image' },
      { type: 'node.setContent', owner: o, nodeId: 'n_picture1', field: 'image', value: photo.id }
    ]);
    expect(r.results.slice(0, 2)).toEqual([{ nodeId: 'n_section1' }, { nodeId: 'n_picture1' }]);
    const page = home(r.state);
    expect(page.rootIds[1]).toBe('n_section1');
    expect((page.nodes.n_section1 as InstanceNode).slots).toEqual({ content: ['n_picture1'] });
    expect(page.nodes.n_picture1).toMatchObject({ id: 'n_picture1', kind: 'image', image: { assetId: photo.id, alt: photo.altSuggestion } });
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('still names new nodes itself when no ID is given', () => {
    const s = fresh();
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, componentId: 'layout.section' }]);
    expect(r.results[0].nodeId).toMatch(/^n_[a-z0-9]{8}$/);
  });

  it('refuses an ID already in the tree, and applies nothing of the batch', () => {
    const s = withPhoto();
    const o = owner(s);
    const taken = home(s).rootIds[0];
    expect(() => applyOperations(s, [{ type: 'node.insert', newNodeId: taken, owner: o, parentId: null, primitive: 'image' }])).toThrow(/already exists/);
    // Or one inserted earlier in the same batch.
    expect(() =>
      applyOperations(s, [
        { type: 'node.insert', newNodeId: 'n_twice1', owner: o, parentId: null, primitive: 'image' },
        { type: 'node.insert', newNodeId: 'n_twice1', owner: o, parentId: null, componentId: 'layout.section' }
      ])
    ).toThrow(/already exists/);
    // The batch is one change: a failure in its last step leaves the section it began with out too.
    const before = structuredClone(s);
    expect(() =>
      applyOperations(s, [
        { type: 'node.insert', newNodeId: 'n_section2', owner: o, parentId: null, componentId: 'layout.section' },
        { type: 'node.insert', newNodeId: 'n_picture2', owner: o, parentId: 'n_section2', slot: 'content', primitive: 'image' },
        { type: 'node.setContent', owner: o, nodeId: 'n_picture2', field: 'image', value: 'img_gone' }
      ])
    ).toThrow(/does not exist/);
    expect(s).toEqual(before);
  });

  it('accepts only IDs shaped like the ones it makes', async () => {
    const { validateOperation } = await import('@shared/ops');
    const o = { kind: 'page', id: 'pg_home' };
    for (const good of ['n_abcd', 'n_abc123', `n_${'a'.repeat(32)}`]) expect(validateOperation({ type: 'node.insert', newNodeId: good, owner: o, primitive: 'image' }).ok, good).toBe(true);
    for (const bad of ['abc', 'n_', 'n_abc', `n_${'a'.repeat(33)}`, 'pg_abcdef', 'n_ABC123', '__proto__']) expect(validateOperation({ type: 'node.insert', newNodeId: bad, owner: o, primitive: 'image' }).ok, bad).toBe(false);
  });
});

describe('site style lengths and older text links (#201)', () => {
  const css = (s: ProjectState) => generateProject(s).get('src/lib/siteorigin/styles/tokens.css')!;
  const set = (s: ProjectState, tokenId: string, value: unknown) => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;

  it('accepts math of lengths, and refuses names inside it, negative widths and corners, and lists', () => {
    for (const good of ['max(1rem, 2vw)', 'calc(100% - clamp(1rem, 2vw, 3rem))', 'clamp(1.25rem, 0.8rem + 2.4vw, 2.5rem)', '0.5em'])
      expect(set(fresh(), 'space.md', good).tokens.overrides['space.md'], good).toBe(good);
    for (const bad of ['calc(red)', 'calc(1px + auto)', 'min()', 'clamp(1rem,, 2rem)', 'var(--so-space-md)', 'auto', '24', '1px 2px', 'calc(1px; x)', 'clamp(40rem, 80vw)', 'calc(1rem, 2rem)', 'min(, 2rem)', 'min(2rem,)', 'calc(1px+)', 'calc(1px+2px)', 'calc(1px -2px)', '12.px', 'calc(1px +(-2px))', 'calc(1px + 2)', 'calc(2 + 3)', 'calc(2px * 3px)', 'calc(2 / 1px)', 'clamp(0, 2vw, 1rem)', 'calc(1px\u00a0+\u00a02px)', 'calc(VAR(--so-space-md) * 2)'])
      expect(() => set(fresh(), 'space.md', bad), bad).toThrow(/length/);
    for (const good of ['+12px', '0.0', '10vmin', '100lvh', '2lh', 'calc(100dvw - 2rem)', 'calc((1rem + 2px) * 1.5)', 'calc(1px + -2px)', '100dvi', 'calc(2 * 1rem)', 'calc(10px / 2)', 'max(1rem, 2vw, 10px)'])
      expect(set(fresh(), 'space.md', good).tokens.overrides['space.md'], good).toBe(good);
    // Variables are not part of a length: a style that should follow another links to it.
    for (const bad of ['calc(var(--so-space-md) * 2)', 'calc(var(--so-space-missing) * 2)', 'calc(1 + 2 * 3px)', 'max(1px, 2)'])
      expect(() => set(fresh(), 'space.lg', bad), bad).toThrow(/length/);
    // * and / bind before + and -.
    for (const good of ['calc(1px + 2 * 3px)', 'calc(100% - 2rem / 2)', 'max(1px, 2px, 3px, 4px)'])
      expect(set(fresh(), 'space.lg', good).tokens.overrides['space.lg'], good).toBe(good);
    expect(set(fresh(), 'space.md', '-8px').tokens.overrides['space.md']).toBe('-8px');
    expect(() => set(fresh(), 'radius.md', '-4px')).toThrow(/positive/);
    expect(() => set(fresh(), 'container.content', '-10px')).toThrow(/positive/);
    expect(set(fresh(), 'container.content', 'calc(100vw - 2rem)').tokens.overrides['container.content']).toBe('calc(100vw - 2rem)');
  });

  it('refuses creating a text style that follows another, even beside metrics', () => {
    const metrics = { family: { token: 'font.body' }, size: '1rem', lineHeight: '1.5', weight: 400, tracking: '0' };
    expect(() => applyOperations(fresh(), [{ type: 'token.create', group: 'text', label: 'Alias', value: { ...metrics, token: 'text.h2' } }])).toThrow(/cannot follow/);
  });

  it('writes every metric for a text style an older version left with a stray link, and mends it on the next edit', () => {
    let s = fresh();
    const h1 = effectiveTokens(s).find((t) => t.id === 'text.h1')!.value as Record<string, unknown>;
    s.tokens.overrides['text.h1'] = { ...h1, size: '3.3rem', token: 'text.h2' } as never;
    expect(validateState(s).some((d) => d.code === 'TOKEN_TEXT_LINK')).toBe(true);
    const out = css(s);
    expect(out).toContain('--so-text-h1-size: 3.3rem;');
    expect(out).not.toMatch(/--so-text-h1: /);
    s = set(s, 'text.h1', { weight: 600 });
    expect(s.tokens.overrides['text.h1']).toEqual({ ...h1, size: '3.3rem', weight: 600 });
    expect(validateState(s).some((d) => d.code === 'TOKEN_TEXT_LINK')).toBe(false);
  });

  it('keeps the metrics of a text style with a stray link when the style it named is replaced', () => {
    let s = fresh();
    const c = applyOperations(s, [{ type: 'token.create', group: 'text', label: 'Callout', value: { family: { token: 'font.body' }, size: '1rem', lineHeight: '1.5', weight: 400, tracking: '0' } }]);
    s = c.state;
    const h1 = effectiveTokens(s).find((t) => t.id === 'text.h1')!.value as Record<string, unknown>;
    s.tokens.overrides['text.h1'] = { ...h1, size: '3.3rem', token: c.results[0].tokenId } as never;
    const after = applyOperations(s, [{ type: 'token.remove', tokenId: c.results[0].tokenId as string, replacementTokenId: 'text.h2' }]).state;
    expect(after.tokens.custom.some((t) => t.id === c.results[0].tokenId)).toBe(false);
    expect((after.tokens.overrides['text.h1'] as unknown as { size: string }).size).toBe('3.3rem');
    expect(css(after)).toContain('--so-text-h1-size: 3.3rem;');
  });

  it('keeps the theme metrics of a text style linked to one that does not exist, and edits from them', () => {
    let s = fresh();
    const h1 = effectiveTokens(s).find((t) => t.id === 'text.h1')!.value as Record<string, unknown>;
    s.tokens.overrides['text.h1'] = { token: 'text.missing' } as never;
    for (const [k, v] of [['size', h1.size], ['line-height', h1.lineHeight], ['weight', h1.weight], ['tracking', h1.tracking], ['family', 'var(--so-font-display)'], ['transform', 'none']])
      expect(css(s)).toContain(`--so-text-h1-${k}: ${v};`);
    // Through a style of another kind, the link leads to no text style either.
    const through = fresh();
    through.tokens.overrides['text.h1'] = { token: 'font.body' } as never;
    expect(css(through)).toContain(`--so-text-h1-size: ${h1.size};`);
    expect(css(through)).not.toContain('var(--so-font-body-');
    // A text style it does reach is followed whatever its metrics hold, as before.
    const bold = fresh();
    const h2 = effectiveTokens(bold).find((t) => t.id === 'text.h2')!.value as Record<string, unknown>;
    bold.tokens.overrides['text.h2'] = { ...h2, weight: 'bold' } as never;
    bold.tokens.overrides['text.h1'] = { token: 'text.h2' } as never;
    expect(css(bold)).toContain('--so-text-h1-weight: var(--so-text-h2-weight);');
    expect(css(s)).not.toContain('var(--so-text-missing');
    s = set(s, 'text.h1', { weight: 600 });
    expect(s.tokens.overrides['text.h1']).toEqual({ ...h1, weight: 600 });
  });

  it('writes a hand-made text link metric by metric, and starts the next edit from the style it follows', () => {
    let s = fresh();
    s.tokens.overrides['text.h1'] = { token: 'text.h2' } as never;
    const out = css(s);
    for (const k of ['family', 'size', 'line-height', 'weight', 'tracking', 'transform']) expect(out).toContain(`--so-text-h1-${k}: var(--so-text-h2-${k});`);
    expect(out).not.toContain('[object Object]');
    const h2 = effectiveTokens(s).find((t) => t.id === 'text.h2')!.value as Record<string, unknown>;
    s = set(s, 'text.h1', { size: '3rem' });
    expect(s.tokens.overrides['text.h1']).toEqual({ ...h2, size: '3rem' });
  });

  it('keeps links and the text family through font removal, replacement and rename', async () => {
    const { tokenUsageCounts } = await import('@engine/tokens');
    let s = fresh();
    const a = applyOperations(s, [{ type: 'token.create', group: 'font', label: 'A', value: { token: 'font.display' } }]);
    s = a.state;
    const A = a.results[0].tokenId as string;
    const b = applyOperations(s, [{ type: 'token.create', group: 'font', label: 'B', value: { token: A } }]);
    s = b.state;
    const B = b.results[0].tokenId as string;
    s = set(s, 'text.h1', { family: { token: A } });
    expect(tokenUsageCounts(s)[A]).toBe(2);
    // Pointing B at itself through the replacement is refused, and nothing changes.
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: A, replacementTokenId: B }])).toThrow(/loop/);
    const display = String(effectiveTokens(s).find((t) => t.id === 'font.display')!.value);
    const detached = applyOperations(s, [{ type: 'token.remove', tokenId: A, detach: true }]).state;
    expect(detached.tokens.custom.some((t) => t.id === A)).toBe(false);
    expect(detached.tokens.custom.find((t) => t.id === B)?.value).toBe(display);
    const replaced = applyOperations(s, [{ type: 'token.remove', tokenId: A, replacementTokenId: 'font.body' }]).state;
    expect(replaced.tokens.custom.some((t) => t.id === A)).toBe(false);
    expect(replaced.tokens.custom.find((t) => t.id === B)?.value).toEqual({ token: 'font.body' });
    expect((replaced.tokens.overrides['text.h1'] as unknown as { family: unknown }).family).toEqual({ token: 'font.body' });
    expect((detached.tokens.overrides['text.h1'] as unknown as { family: unknown }).family).toBe(display);
    const out = css(detached);
    for (const k of ['family', 'size', 'line-height', 'weight', 'tracking', 'transform']) expect(out).toContain(`--so-text-h1-${k}:`);
    expect(errors(detached)).toEqual([]);
  });
});

describe('older text links read the same in the editor, an edit and the export (#201)', () => {
  const css = (s: ProjectState) => generateProject(s).get('src/lib/siteorigin/styles/tokens.css')!;
  const set = (s: ProjectState, tokenId: string, value: unknown) => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;

  it('edits a text style linked to one with a written-out weight from the style it follows', async () => {
    const { textMetrics } = await import('@shared/styles');
    let s = fresh();
    const h2 = effectiveTokens(s).find((t) => t.id === 'text.h2')!.value as Record<string, unknown>;
    s.tokens.overrides['text.h2'] = { ...h2, weight: 'bold' } as never;
    s.tokens.overrides['text.h1'] = { token: 'text.h2' } as never;
    expect(textMetrics(effectiveTokens(s), 'text.h1')).toMatchObject({ size: h2.size, weight: 700 });
    // A change that leaves the weight alone keeps it, as the number it stands for.
    expect(set(s, 'text.h1', { size: '3rem' }).tokens.overrides['text.h1']).toEqual({ ...h2, size: '3rem', weight: 700 });
    s = set(s, 'text.h1', { weight: 600 });
    expect(s.tokens.overrides['text.h1']).toEqual({ ...h2, weight: 600 });
  });

  it('shows and edits the theme metrics when the link runs through another kind of style, as the export writes them', async () => {
    const { textMetrics } = await import('@shared/styles');
    let s = fresh();
    const h1 = effectiveTokens(s).find((t) => t.id === 'text.h1')!.value as Record<string, unknown>;
    s.tokens.overrides['text.h1'] = { token: 'font.body' } as never;
    s.tokens.overrides['font.body'] = { token: 'text.h2' } as never;
    expect(css(s)).toContain(`--so-text-h1-size: ${h1.size};`);
    const { getTheme } = await import('@catalogue/index');
    const theme = getTheme(s.site.themeId).tokens.find((t) => t.id === 'text.h1')!.value;
    expect(textMetrics(effectiveTokens(s), 'text.h1', theme)?.size).toBe(h1.size);
    s = set(s, 'text.h1', { weight: 600 });
    expect(s.tokens.overrides['text.h1']).toEqual({ ...h1, weight: 600 });
  });
});

describe('a component keeps its one root (#205)', () => {
  const setup = () => {
    const f = fork(fresh(), 'features.grid');
    return { s: f.state, own: { kind: 'component' as const, id: f.id }, id: f.id };
  };

  it('refuses removing, moving or duplicating the root, and putting anything beside it', () => {
    const { s, own, id } = setup();
    const before = JSON.stringify(s.components[id]);
    const refused: Array<[EditOperation, RegExp]> = [
      [{ type: 'node.remove', owner: own, nodeId: 'root' }, /component itself, so it cannot be removed/],
      [{ type: 'node.duplicate', owner: own, nodeId: 'root' }, /component itself, so it cannot be duplicated/],
      [{ type: 'node.move', owner: own, nodeId: 'root', parentId: null, index: 0 }, /component itself, so it cannot be moved/],
      [{ type: 'node.move', owner: own, nodeId: 'inner', parentId: null, index: 0 }, /Move it inside the component, not beside its root/],
      [{ type: 'node.move', owner: own, nodeId: 'heading', parentId: null, index: 1 }, /not beside its root/],
      [{ type: 'node.insert', owner: own, parentId: null, index: 0, primitive: 'heading' }, /Insert inside the component, not beside its root/],
      [{ type: 'node.insert', owner: own, primitive: 'container' }, /Insert inside the component/],
      [{ type: 'node.insert', owner: own, parentId: null, componentId: 'cta.banner' }, /Insert inside the component/]
    ];
    for (const [op, message] of refused) expect(() => applyOperations(s, [op]), JSON.stringify(op)).toThrow(message);
    expect(JSON.stringify(s.components[id])).toBe(before);
  });

  it('still edits inside the root, and on a page’s own top level', () => {
    const { s, own, id } = setup();
    const r = applyOperations(s, [
      { type: 'node.insert', owner: own, parentId: 'root', index: 0, primitive: 'heading' },
      { type: 'node.duplicate', owner: own, nodeId: 'inner' },
      { type: 'node.move', owner: own, nodeId: 'heading', parentId: 'root', index: 0 },
      { type: 'node.remove', owner: own, nodeId: 'lead' }
    ]);
    expect(r.state.components[id].tree!.rootIds).toEqual(['root']);
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
    const page = { kind: 'page' as const, id: s.site.homePageId };
    const first = home(s).rootIds[0];
    const p = applyOperations(s, [
      { type: 'node.insert', owner: page, parentId: null, index: 0, componentId: 'cta.banner' },
      { type: 'node.duplicate', owner: page, nodeId: first },
      { type: 'node.move', owner: page, nodeId: first, parentId: null, index: 0 }
    ]);
    expect(home(p.state).rootIds.length).toBe(home(s).rootIds.length + 2);
  });

  it('lets a definition with an extra top-level element from an older version be put right', () => {
    const { s, own, id } = setup();
    const tree = s.components[id].tree!;
    tree.nodes.extra = { id: 'extra', kind: 'text', tag: 'p', text: 'Loose' };
    tree.rootIds.push('extra');
    expect(validateState(s).filter((d) => d.code === 'COMPONENT_ROOT').map((d) => d.nodeId)).toEqual(['extra']);
    expect(() => applyOperations(s, [{ type: 'node.duplicate', owner: own, nodeId: 'extra' }])).toThrow(/cannot be duplicated/);
    const moved = applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'extra', parentId: 'inner', index: 0 }]).state;
    expect(moved.components[id].tree!.rootIds).toEqual(['root']);
    expect(validateState(moved).some((d) => d.code === 'COMPONENT_ROOT')).toBe(false);
    const removed = applyOperations(s, [{ type: 'node.remove', owner: own, nodeId: 'extra' }]).state;
    expect(removed.components[id].tree!.rootIds).toEqual(['root']);
  });

  it('keeps every element of an older design whose top level holds two paragraphs, or nothing', () => {
    const { s, own, id } = setup();
    const tree = s.components[id].tree!;
    tree.nodes.p1 = { id: 'p1', kind: 'text', tag: 'p', text: 'One' };
    tree.nodes.p2 = { id: 'p2', kind: 'text', tag: 'p', text: 'Two' };
    tree.rootIds = ['p1', 'p2'];
    s.components[id].parts.root.nodeId = 'p1';
    // Until it has its one root, an element that holds others can go at the top level, and the top level reordered.
    const r = applyOperations(s, [
      { type: 'node.insert', owner: own, parentId: null, primitive: 'container', newNodeId: 'n_hold' },
      { type: 'node.move', owner: own, nodeId: 'n_hold', parentId: null, index: 0 }
    ]);
    // The component's root part is its first top-level element, which carries the placement's styles.
    expect(r.state.components[id].parts.root.nodeId).toBe('n_hold');
    const fixed = applyOperations(r.state, [
      { type: 'node.move', owner: own, nodeId: 'p1', parentId: 'n_hold', index: 0 },
      { type: 'node.move', owner: own, nodeId: 'p2', parentId: 'n_hold', index: 1 }
    ]).state;
    expect(fixed.components[id].tree!.rootIds).toEqual(['n_hold']);
    expect(fixed.components[id].tree!.nodes.n_hold).toMatchObject({ children: ['p1', 'p2'] });
    expect(validateState(fixed).filter((d) => d.code === 'COMPONENT_ROOT' || d.code === 'PART_MISSING')).toEqual([]);
    // Each step on the way is a repair, never a new problem.
    const step = applyOperations(r.state, [{ type: 'node.move', owner: own, nodeId: 'p1', parentId: 'n_hold', index: 0 }]).state;
    expect(introducedDiagnostics(validateState(s), validateState(r.state)).filter(blocksSaving)).toEqual([]);
    expect(introducedDiagnostics(validateState(r.state), validateState(step)).filter(blocksSaving)).toEqual([]);
    // Nothing else joins the top level meanwhile.
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: own, parentId: null, index: 0, primitive: 'paragraph' }])).toThrow(/no single top-level element yet/);
    expect(() => applyOperations(r.state, [{ type: 'node.move', owner: own, nodeId: 'heading', parentId: null, index: 0 }])).toThrow(/no single top-level element yet/);
    // Removing the first old root leaves the next one as the root, part and all.
    const kept = applyOperations(s, [{ type: 'node.remove', owner: own, nodeId: 'p1' }]).state;
    expect(kept.components[id].tree!.rootIds).toEqual(['p2']);
    expect(kept.components[id].parts.root.nodeId).toBe('p2');
    expect(introducedDiagnostics(validateState(s), validateState(kept)).filter(blocksSaving)).toEqual([]);
    // Once settled, the top level is closed again.
    expect(() => applyOperations(fixed, [{ type: 'node.insert', owner: own, parentId: null, primitive: 'container' }])).toThrow(/Insert inside the component/);
    const empty = structuredClone(s);
    empty.components[id].tree!.rootIds = [];
    const first = applyOperations(empty, [{ type: 'node.insert', owner: own, primitive: 'container' }]).state;
    expect(first.components[id].tree!.rootIds).toHaveLength(1);
    expect(first.components[id].parts.root.nodeId).toBe(first.components[id].tree!.rootIds[0]);
    expect(validateState(first).some((d) => d.code === 'COMPONENT_ROOT')).toBe(false);
  });

  it('counts a design left with nothing to carry the component as a new problem, and a repeat at the top as one to put right', () => {
    const { s, own, id } = setup();
    const tree = s.components[id].tree!;
    tree.nodes.extra = { id: 'extra', kind: 'text', tag: 'p', text: 'Loose' };
    tree.rootIds.push('extra');
    const before = validateState(s).filter(blocksSaving);
    const gate = (next: ProjectState) => introducedDiagnostics(before, validateState(next).filter(blocksSaving)).map((d) => d.code);
    // No design at all, as an external edit could leave it.
    const noTree = structuredClone(s);
    delete noTree.components[id].tree;
    expect(gate(noTree)).toContain('COMPONENT_ROOT');
    // The element that renders moved into the repeat: only the repeat is left at the top.
    const repeatFirst = structuredClone(s);
    repeatFirst.components[id].tree!.rootIds = ['cards', 'root'];
    (repeatFirst.components[id].tree!.nodes.grid as { children: string[] }).children = [];
    const intoRepeat = applyOperations(repeatFirst, [{ type: 'node.move', owner: own, nodeId: 'root', parentId: 'cards', index: 0 }]);
    expect(intoRepeat.state.components[id].tree!.rootIds).toEqual(['cards']);
    expect(introducedDiagnostics(validateState(s).filter(blocksSaving), validateState(intoRepeat.state).filter(blocksSaving)).map((d) => d.code)).toContain('COMPONENT_ROOT');
    // A repeat at the top is put right with a container that holds it, one step at a time.
    const lone = structuredClone(repeatFirst);
    lone.components[id].tree!.rootIds = ['cards'];
    const held = applyOperations(lone, [{ type: 'node.insert', owner: own, parentId: null, primitive: 'container', newNodeId: 'n_hold' }]).state;
    expect(introducedDiagnostics(validateState(lone).filter(blocksSaving), validateState(held).filter(blocksSaving))).toEqual([]);
    const done = applyOperations(held, [{ type: 'node.move', owner: own, nodeId: 'cards', parentId: 'n_hold', index: 0 }]).state;
    expect(done.components[id].tree!.rootIds).toEqual(['n_hold']);
    expect(validateState(done).some((d) => d.code === 'COMPONENT_ROOT')).toBe(false);
  });
});

describe('moving definition content across repeats (#205)', () => {
  /** The Features grid with a second list ("names", whose items have a `title` and a `when`) repeated in its intro. */
  const setup = (fields: Record<string, unknown> = { title: { type: 'string', label: 'Title' } }) => {
    const f = fork(fresh(), 'features.grid');
    const own = { kind: 'component' as const, id: f.id };
    let s = applyOperations(f.state, [{ type: 'component.setPropSchema', definitionId: f.id, prop: 'names', schema: { type: 'list', label: 'Names', itemLabel: 'Name', fields } as never }]).state;
    const r = applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'intro', primitive: 'repeat', bind: 'names' }]);
    s = r.state;
    return { s, own, id: f.id, names: r.results[0].nodeId as string };
  };

  it('moves an item field into a repeat over a list that has it, and between repeats over the same list', () => {
    const { s, own, id, names } = setup();
    const into = applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'card-title', parentId: names, index: 0 }]).state;
    expect(validateState(into).filter((d) => d.severity === 'error')).toEqual([]);
    // A second repeat over the cards' own list: the fields are the same, so nothing to check.
    const again = applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'intro', primitive: 'repeat', bind: 'items' }]);
    const twin = again.results[0].nodeId as string;
    const moved = applyOperations(again.state, [{ type: 'node.move', owner: own, nodeId: 'card-icon-wrap', parentId: twin, index: 0 }]).state;
    expect(moved.components[id].tree!.nodes[twin]).toMatchObject({ children: ['card-icon-wrap'] });
  });

  it('refuses a move that leaves an item field without its list, or with a list that lacks it', () => {
    const { s, own, names } = setup();
    expect(() => applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'card-title', parentId: 'intro', index: 0 }])).toThrow(/"title", so it has to stay inside a repeat over its list/);
    // The card's link shows its label and is shown only when there is one: "names" items have no linkLabel.
    expect(() => applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'card-link', parentId: names, index: 0 }])).toThrow(/"linkLabel", which "names" items do not have\./);
    // A whole card moves with every field it shows.
    expect(() => applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'card', parentId: names, index: 0 }])).toThrow(/which "names" items do not have/);
  });

  it('refuses an item field of a type that cannot show there', () => {
    const { s, own, names } = setup({ title: { type: 'link', label: 'Title' } });
    expect(() => applyOperations(s, [{ type: 'node.move', owner: own, nodeId: 'card-title', parentId: names, index: 0 }])).toThrow(/"title", which "names" items do not have in a fitting type/);
  });

  it('refuses a repeat moved inside a repeat over its own list', () => {
    const { s, own } = setup();
    const again = applyOperations(s, [{ type: 'node.insert', owner: own, parentId: 'intro', primitive: 'repeat', bind: 'items' }]);
    const twin = again.results[0].nodeId as string;
    expect(() => applyOperations(again.state, [{ type: 'node.move', owner: own, nodeId: twin, parentId: 'card', index: 0 }])).toThrow(/cannot repeat the list it is already inside/);
  });
});

describe('load validation (#205)', () => {
  const codes = (s: ProjectState, code: string) => validateState(s).filter((d) => d.code === code);

  it('compares problems by place and count, and an external change’s others by element too', () => {
    const d = (over: Partial<Diagnostic>): Diagnostic => ({ severity: 'error', code: 'X', message: 'M', owner: { kind: 'page', id: 'p' }, ...over });
    // One more at the same place is new; the same place with other words is not.
    expect(introducedDiagnostics([d({ site: 's' })], [d({ site: 's', message: 'Other words' }), d({ site: 's' })])).toHaveLength(1);
    expect(introducedDiagnostics([d({ site: 's' })], [d({ site: 's', message: 'Other words' })])).toEqual([]);
    // Without a place, an edit is told by its message; an external change by element too.
    expect(introducedDiagnostics([d({ nodeId: 'a' })], [d({ nodeId: 'a' }), d({ nodeId: 'b' })])).toEqual([]);
    expect(introducedDiagnostics([d({ nodeId: 'a' })], [d({ nodeId: 'a' }), d({ nodeId: 'b' })], { byNode: true })).toEqual([d({ nodeId: 'b' })]);
  });

  it('counts a problem by where it is: a rename or a second one at another place tells them apart', () => {
    const s = fresh();
    const page = home(s);
    page.nodes.n_t = { id: 'n_t', kind: 'text', tag: 'p', text: 'x', styles: { base: { radius: { token: 'color.brand' } } }, when: { $prop: 'show' } };
    page.rootIds.push('n_t');
    const before = validateState(s).filter(blocksSaving);
    // Renaming the page changes every message that names it, and brings in nothing.
    const renamed = applyOperations(s, [{ type: 'page.update', pageId: page.id, title: 'Start here' }]).state;
    expect(introducedDiagnostics(before, validateState(renamed).filter(blocksSaving))).toEqual([]);
    // The same site style wrong again on another size of the same element is one more problem.
    const again = structuredClone(s);
    home(again).nodes.n_t.styles!.phone = { radius: { token: 'color.brand' } };
    expect(introducedDiagnostics(before, validateState(again).filter(blocksSaving)).map((d) => d.code)).toEqual(['TOKEN_GROUP']);
  });

  it('reports a component design with no root, several roots, or a root that renders nothing of its own', () => {
    const f = fork(fresh(), 'features.grid');
    const def = f.state.components[f.id];
    const empty = structuredClone(f.state);
    empty.components[f.id].tree!.rootIds = [];
    expect(codes(empty, 'COMPONENT_ROOT')[0].message).toMatch(/no top-level element/);
    const repeatRoot = structuredClone(f.state);
    repeatRoot.components[f.id].tree!.rootIds = ['cards'];
    (repeatRoot.components[f.id].tree!.nodes.grid as { children: string[] }).children = [];
    expect(codes(repeatRoot, 'COMPONENT_ROOT')[0].message).toMatch(/top-level element is a repeat/);
    const noTree = structuredClone(f.state);
    delete noTree.components[f.id].tree;
    expect(codes(noTree, 'COMPONENT_ROOT')[0]).toMatchObject({ severity: 'error', owner: { kind: 'component', id: def.id } });
    expect(codes(f.state, 'COMPONENT_ROOT')).toEqual([]);
  });

  it('reports repeats and bindings on a page or in the shared header and footer', () => {
    const s = fresh();
    const page = home(s);
    page.nodes.n_rep = { id: 'n_rep', kind: 'repeat', list: { $prop: 'items' }, children: [] };
    page.nodes.n_when = { id: 'n_when', kind: 'text', tag: 'p', text: 'Shown', when: { ref: { $prop: 'show' }, eq: true } };
    page.rootIds.push('n_rep', 'n_when');
    const header = s.site.shell.header;
    const inst = header.nodes[header.rootIds[0]] as InstanceNode;
    inst.props.links = { $prop: 'menu' };
    expect(codes(s, 'BINDING_SCOPE').map((d) => d.nodeId).sort()).toEqual(['n_rep', 'n_when', inst.id].sort());
    expect(codes(s, 'BINDING_SCOPE').every((d) => d.severity === 'error')).toBe(true);
  });

  it('reports a site style of the wrong kind for its property', () => {
    const s = fresh();
    const page = home(s);
    page.nodes.n_t = { id: 'n_t', kind: 'text', tag: 'p', text: 'x', styles: { base: { textStyle: { token: 'color.brand' }, paddingBlock: { token: 'space.lg' } }, phone: { radius: { token: 'color.brand' } } } };
    page.nodes.n_o = { id: 'n_o', kind: 'text', tag: 'p', text: 'y', styles: { base: { opacity: { token: 'space.md' } } } };
    page.rootIds.push('n_t', 'n_o');
    const found = codes(s, 'TOKEN_GROUP');
    expect(found.map((d) => d.nodeId)).toEqual(['n_t', 'n_t', 'n_o']);
    expect(found[0].message).toMatch(/Text style uses the site style "color\.brand", which is a color style; it needs a text style/);
    expect(found[2].message).toMatch(/cannot use a site style/);
    expect(codes(fresh(), 'TOKEN_GROUP')).toEqual([]);
  });

  it('reports list items that share an ID, list by list, in placements and in a component’s defaults', () => {
    const s = fresh();
    const grid = firstInstance(s, 'features.grid');
    const items = (s.components[grid.definitionId].properties.items as { default: Array<Record<string, unknown>> }).default;
    grid.props.items = [{ ...items[0], id: 'x' }, { ...items[1], id: 'x' }, { ...items[2], id: 'x-2' }];
    expect(codes(s, 'LIST_ITEM_DUPLICATE').map((d) => [d.nodeId, d.message.match(/"([^"]+)"/)?.[1]])).toEqual([[grid.id, 'x']]);
    const f = fork(fresh(), 'features.grid');
    const schema = f.state.components[f.id].properties.items as { default: Array<{ id: string }> };
    schema.default[1].id = schema.default[0].id;
    expect(codes(f.state, 'LIST_ITEM_DUPLICATE')).toMatchObject([{ owner: { kind: 'component', id: f.id }, severity: 'error' }]);
    expect(codes(fresh(), 'LIST_ITEM_DUPLICATE')).toEqual([]);
    // A theme's own defaults too, which placements show until they set their own (a theme update can bring them).
    const t = fresh();
    const themeDef = t.components[firstInstance(t, 'features.grid').definitionId];
    expect(themeDef.owner).toBe('theme');
    (themeDef.properties.items as { default: Array<{ id: string }> }).default[2].id = 'same';
    (themeDef.properties.items as { default: Array<{ id: string }> }).default[1].id = 'same';
    expect(codes(t, 'LIST_ITEM_DUPLICATE')).toMatchObject([{ owner: { kind: 'component', id: themeDef.id } }]);
    // No theme ships one.
    for (const theme of listThemes())
      for (const d of theme.components)
        for (const [k, sch] of Object.entries(d.properties)) {
          if (sch.type !== 'list' || !Array.isArray(sch.default)) continue;
          const ids = (sch.default as Array<{ id: string }>).map((i) => i.id);
          expect(new Set(ids).size, `${theme.id} ${d.id} ${k}`).toBe(ids.length);
        }
  });

  it('reports a font or a document shown as a picture, the site icon and sharing images included', () => {
    const s = fresh();
    const record = (id: string, kind: 'font' | 'document') => ({ id, name: `${id}.file`, file: `static/${id}`, mime: 'application/octet-stream', bytes: 10, hash: id, kind, createdAt: '2026-01-01T00:00:00.000Z' });
    s.assets.assets.a_font = record('a_font', 'font');
    s.assets.assets.a_doc = record('a_doc', 'document');
    const page = home(s);
    page.nodes.n_img = { id: 'n_img', kind: 'image', image: { assetId: 'a_font', alt: 'x' } };
    page.rootIds.push('n_img');
    s.site.favicon = 'a_font';
    s.site.socialImage = 'a_doc';
    page.seo.socialImage = 'a_font';
    // A project component's picture default is shown by every placement that sets none.
    const f = fork(s, 'hero.split');
    const pictureProp = Object.entries(f.state.components[f.id].properties).find(([, sch]) => sch.type === 'image')![0];
    (f.state.components[f.id].properties[pictureProp] as { default: unknown }).default = { assetId: 'a_doc', alt: '' };
    expect(codes(f.state, 'ASSET_NOT_IMAGE').filter((d) => d.owner?.id === f.id).map((d) => d.message)).toEqual([expect.stringMatching(/the default of “.+” shows “a_doc\.file”, which is a document/)]);
    const found = codes(s, 'ASSET_NOT_IMAGE');
    expect(found.map((d) => d.message)).toEqual([
      expect.stringMatching(/an image shows “a_font\.file”, which is a font, not a picture/),
      'The site icon is “a_font.file”, which is a font, not a picture. Choose an image instead.',
      'The site’s sharing image is “a_doc.file”, which is a document, not a picture. Choose an image instead.',
      `${page.title}: the page’s sharing image is “a_font.file”, which is a font, not a picture. Choose an image instead.`
    ]);
    expect(found.every((d) => d.severity === 'error')).toBe(true);
  });

  it('leaves the stored items of a computed list alone: the site’s pages fill it', () => {
    const s = fresh();
    s.assets.assets.a_doc = { id: 'a_doc', name: 'guide.pdf', file: 'static/a_doc', mime: 'application/pdf', bytes: 10, hash: 'a_doc', kind: 'document', createdAt: '2026-01-01T00:00:00.000Z' };
    const grid = firstInstance(s, 'features.grid');
    const def = s.components[grid.definitionId];
    const items = def.properties.items as { type: 'list'; feed?: string; fields: Record<string, unknown> };
    items.fields.image = { type: 'image', label: 'Image' };
    grid.props.items = [{ id: 'x', image: { assetId: 'a_doc', alt: '' } }];
    expect(codes(s, 'ASSET_NOT_IMAGE').map((d) => d.nodeId)).toEqual([grid.id]);
    items.feed = 'articles';
    expect(codes(s, 'ASSET_NOT_IMAGE')).toEqual([]);
  });
});
