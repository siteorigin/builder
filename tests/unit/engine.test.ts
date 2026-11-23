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
    expect(node.variants?.tone).toBe('inverse');
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
});

describe('create component from a selection (§2.3)', () => {
  it('turns icons into properties, keeps the anchor on the placement and records dependencies', () => {
    let s = createStarterState('blank', 'Blank', false);
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

    const sec = fork(createStarterState('blank', 'Blank', false), 'layout.section');
    const w = applyOperations(sec.state, [{ type: 'component.createFromNode', owner: { kind: 'component', id: sec.id }, nodeId: 'inner', name: 'Inner' }]);
    const inner = w.state.components[w.results[0].definitionId as string];
    expect(inner.slots).toEqual({ content: { label: 'Content' } });
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
    expect(css).toMatch(/--layout-compact \.so-[^{]*__grid \{\n\t\tgap: var\(--so-space-sm\)/);
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
    const f = fork(createStarterState('blank', 'Blank', false), 'layout.section');
    let s = f.state;
    const section = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: section, slot: 'content', primitive: 'heading' }]).state;
    expect(() => applyOperations(s, [{ type: 'component.removeSlot', definitionId: f.id, slot: 'content' }])).toThrow(/has content/);
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
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: f.id, prop: 'logos', schema: { ...s.components[f.id].properties.logos, fields: { logo: { type: 'image', label: 'Logo', default: { assetId: null, alt: '' } } } } as never }])).toThrow(/"name"/);

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
    let s = createStarterState('blank', 'Blank', false);
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
