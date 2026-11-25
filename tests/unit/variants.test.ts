import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ProjectState, ResponsiveStyles, VariantDef } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { MIGRATIONS, migrateProject } from '@shared/migrations';
import { findVariant, selectedVariants, selectedVariantStyles } from '@shared/variants';
import { createStarterState } from '@catalogue/starters';
import { catalogueEntries, listThemes } from '@catalogue/index';
import { catalogueIndex } from '../../src/agent/context';
import { checkAuthority } from '../../src/agent/scope';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { STYLES_DIR, generateManagedComponent, generateProject } from '@generator/index';
import { readProject } from '../../src/main/project/documents';

const FIXTURE = join(__dirname, 'fixtures/v1-project');
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const add = (s: ProjectState, componentId: string, variants?: string | Record<string, string>) => {
  const node = makeInstance(s.components[installComponent(s, componentId)], {}, variants);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
};
type Legacy = ComponentDefinition & { variants?: Record<string, VariantDef>; defaultVariant?: string };
type LegacyInstance = InstanceNode & { variant?: string };
const AXES_STEP = MIGRATIONS.findIndex((m) => m.id === 'variant-axes');

/** A first-format project: the fixture as stored, with one definition's variants replaced. */
async function legacyProject(edit?: (s: ProjectState) => void) {
  const { stored } = await readProject(FIXTURE);
  const s = structuredClone(stored);
  edit?.(s);
  return s;
}
const firstPlacement = (s: ProjectState, defId: string) => Object.values(s.pages).flatMap((p) => Object.values(p.nodes)).find((n) => n.kind === 'instance' && n.definitionId === defId) as LegacyInstance;

/** The merged rules a selection puts on each node. */
function effective(def: ComponentDefinition, chosen: InstanceNode['variants']): Record<string, ResponsiveStyles> {
  const out: Record<string, ResponsiveStyles> = {};
  for (const id of Object.keys(def.tree?.nodes ?? {})) {
    const merged: ResponsiveStyles = {};
    for (const layer of selectedVariantStyles(def, chosen, id)) for (const [scope, rules] of Object.entries(layer)) Object.assign((merged[scope as keyof ResponsiveStyles] ??= {}), rules);
    if (Object.keys(merged).length) out[id] = merged;
  }
  return out;
}

describe('migrating single variants to axes', () => {
  it('renders every placement of the real v1 project exactly as before', async () => {
    const stored = await legacyProject();
    const { state } = migrateProject(stored)!;
    let checked = 0;
    const trees = [stored.site.shell.header, stored.site.shell.footer, ...Object.values(stored.pages)];
    const after = [state.site.shell.header, state.site.shell.footer, ...Object.values(state.pages)];
    trees.forEach((tree, i) => {
      for (const n of Object.values(tree.nodes) as LegacyInstance[]) {
        if (n.kind !== 'instance') continue;
        const oldDef = stored.components[n.definitionId] as Legacy;
        const newDef = state.components[n.definitionId];
        if (newDef.kind !== 'managed') continue;
        const was = oldDef.variants?.[n.variant ?? oldDef.defaultVariant ?? '']?.styles ?? {};
        const nonEmpty = Object.fromEntries(Object.entries(was).filter(([, r]) => Object.keys(r).length));
        expect(effective(newDef, (after[i].nodes[n.id] as InstanceNode).variants), `${newDef.id} ${n.variant}`).toEqual(nonEmpty);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(15);
  });

  it('leaves no first-format fields behind', async () => {
    const { state } = migrateProject(await legacyProject())!;
    const text = JSON.stringify({ c: state.components, p: state.pages, s: state.site });
    expect(text).not.toContain('"defaultVariant"');
    expect(text).not.toContain('"variant":');
    for (const def of Object.values(state.components)) expect((def as Legacy).variants).toBeUndefined();
  });

  it('separates tone from layout, so they can be combined', async () => {
    const { state } = migrateProject(await legacyProject())!;
    const grid = state.components['foundation.features.grid'].variantAxes!;
    expect(Object.keys(grid.tone.options)).toEqual(['default', 'muted', 'inverse']);
    expect(Object.keys(grid.layout.options)).toEqual(['default', 'two-columns', 'four-columns']);
    const placed = Object.values(home(state).nodes).filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === 'foundation.features.grid');
    expect(placed.map((p) => p.variants)).toEqual(expect.arrayContaining([{ layout: 'four-columns' }, { tone: 'inverse' }]));
  });

  it('keeps a placement off a default tone it was never on', async () => {
    const stored = await legacyProject((s) => {
      const def = s.components['foundation.features.grid'] as Legacy;
      def.defaultVariant = 'muted';
      firstPlacement(s, def.id).variant = 'two-columns';
    });
    const { state } = migrateProject(stored)!;
    const def = state.components['foundation.features.grid'];
    expect(def.variantAxes!.tone.default).toBe('muted');
    expect(firstPlacement(state, def.id).variants).toEqual({ layout: 'two-columns', tone: 'default' });
  });

  it('keeps options exclusive when the default adds styles of its own', async () => {
    const stored = await legacyProject((s) => {
      const def = s.components['foundation.features.grid'] as Legacy;
      def.variants!.default.styles = { root: { base: { opacity: 0.9 } } };
    });
    const axes = migrateProject(stored)!.state.components['foundation.features.grid'].variantAxes!;
    expect(Object.keys(axes)).toEqual(['style']);
    expect(Object.keys(axes.style.options)).toContain('four-columns');
  });

  it('keeps a code component on one axis, the single value its source reads', async () => {
    const stored = await legacyProject((s) => {
      const code = Object.values(s.components).find((d) => d.kind === 'code' && d.owner === 'project') as Legacy;
      code.variants = { default: { label: 'Default' }, wide: { label: 'Wide' } };
      code.defaultVariant = 'default';
    });
    const code = Object.values(migrateProject(stored)!.state.components).find((d) => d.kind === 'code' && d.owner === 'project')!;
    expect(Object.keys(code.variantAxes!)).toEqual(['style']);
  });

  it('keeps a forked definition and its own variant rules', async () => {
    const stored = await legacyProject();
    const fork = Object.values(stored.components).find((d) => d.owner === 'project' && d.kind === 'managed') as Legacy;
    const { state } = migrateProject(stored)!;
    expect(state.components[fork.id].variantAxes!.tone.options.muted.styles).toEqual(fork.variants!.muted.styles);
    expect(state.components[fork.id].owner).toBe('project');
  });

  it('drops a value that names no variant, which already rendered as the default', async () => {
    const stored = await legacyProject((s) => {
      firstPlacement(s, 'foundation.features.grid').variant = 'gone';
    });
    expect(firstPlacement(migrateProject(stored)!.state, 'foundation.features.grid').variants).toBeUndefined();
  });

  it('migrates a page restored from an older copy against definitions already on axes', async () => {
    const current = migrateProject(await legacyProject())!.state;
    const page = home(current);
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.features.grid') as LegacyInstance;
    delete node.variants;
    node.variant = 'four-columns';
    page.schemaVersion = AXES_STEP + 1;
    const { state } = migrateProject(current)!;
    expect((home(state).nodes[node.id] as InstanceNode).variants).toEqual({ layout: 'four-columns' });
    expect(state.manifest.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('keeps a code placement’s value that names no variant, so its code still gets no `variant` (#103)', async () => {
    let codeId = '';
    const stored = await legacyProject((s) => {
      const code = Object.values(s.components).find((d) => d.kind === 'code' && d.owner === 'project') as Legacy;
      codeId = code.id;
      code.variants = { default: { label: 'Default' }, wide: { label: 'Wide' } };
      code.defaultVariant = 'default';
      code.source = '<script>\n\tlet { text = "Note", variant = "own-fallback", variant_style = "own-style", class: className = "" } = $props();\n</script>\n\n<p class={[className, variant, variant_style]}>{text}</p>\n';
      const page = home(s);
      for (const [id, text, variant] of [['n_stale', 'Stale', 'gone'], ['n_empty', 'Empty', ''], ['n_wide', 'Wide', 'wide'], ['n_plain', 'Plain', undefined]] as const) {
        page.nodes[id] = { id, kind: 'instance', definitionId: code.id, props: { text }, ...(variant !== undefined ? { variant } : {}) } as LegacyInstance;
        page.rootIds.push(id);
      }
    });
    const { state } = migrateProject(stored)!;
    expect((home(state).nodes.n_stale as InstanceNode).variants).toEqual({ style: 'gone' });
    expect((home(state).nodes.n_empty as InstanceNode).variants).toEqual({ style: '' });
    expect((home(state).nodes.n_wide as InstanceNode).variants).toEqual({ style: 'wide' });
    expect((home(state).nodes.n_plain as InstanceNode).variants).toBeUndefined();
    const call = (s: ProjectState, text: string) => generateProject(s).get('src/routes/+page.svelte')!.match(new RegExp(`<[A-Z][^<>]*text=\\{"${text}"\\}[^<>]*>`))![0];
    // As before axes: the stale value passes nothing, so the code's own fallback shows; the others pass their option.
    for (const text of ['Stale', 'Empty']) expect(call(state, text)).not.toMatch(/\bvariant(_style)?=/);
    expect(call(state, 'Wide')).toContain('variant="wide"');
    expect(call(state, 'Wide')).toContain('variant_style="wide"');
    expect(call(state, 'Plain')).toContain('variant="default"');
    // Choosing an option replaces the stale value, and the code gets it.
    const chosen = applyOperations(state, [{ type: 'instance.setVariant', owner: owner(state), nodeId: 'n_stale', variant: 'wide' }]).state;
    expect((home(chosen).nodes.n_stale as InstanceNode).variants).toEqual({ style: 'wide' });
    expect(call(chosen, 'Stale')).toContain('variant="wide"');
    expect(state.components[codeId].kind).toBe('code');
  });

  it('refuses to guess an older page’s choice that is now an option on several axes (#103)', async () => {
    const current = migrateProject(await legacyProject())!.state;
    // A later version added the same option to the tone axis, while the layout keeps it.
    current.components['foundation.features.grid'].variantAxes!.tone.options['four-columns'] = { label: 'Four columns tone' };
    const page = home(current);
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.features.grid') as LegacyInstance;
    delete node.variants;
    node.variant = 'four-columns';
    page.schemaVersion = AXES_STEP + 1;
    expect(() => migrateProject(current)).toThrow(/"four-columns" for "Services grid".*several of its axes \(tone, layout\)/);
    // "default" is the plain option on each axis it is on, as the first format meant it.
    node.variant = 'default';
    expect((home(migrateProject(current)!.state).nodes[node.id] as InstanceNode).variants).toEqual({ tone: 'default' });
  });

  it('matches the theme byte for byte where only the format changed', async () => {
    const { state } = migrateProject(await legacyProject())!;
    const theme = listThemes()[0].components.find((c) => c.id === 'foundation.faq.list')!;
    expect(JSON.stringify(state.components[theme.id].variantAxes)).toBe(JSON.stringify(theme.variantAxes));
    expect(Object.keys(state.components[theme.id])).toEqual(Object.keys(JSON.parse(JSON.stringify(theme))));
  });
});

describe('choosing variants', () => {
  it('changes one axis and keeps the other', () => {
    const s = fresh();
    const grid = add(s, 'features.grid', { layout: 'four-columns' });
    const { state } = applyOperations(s, [{ type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, axis: 'tone', variant: 'inverse' }]);
    expect((home(state).nodes[grid.id] as InstanceNode).variants).toEqual({ layout: 'four-columns', tone: 'inverse' });
  });

  it('finds the axis from the option alone', () => {
    const s = fresh();
    const grid = add(s, 'features.grid');
    const { state } = applyOperations(s, [{ type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, variant: 'two-columns' }]);
    expect((home(state).nodes[grid.id] as InstanceNode).variants).toEqual({ layout: 'two-columns' });
  });

  it('refuses an option or axis that does not exist, naming the valid ones', () => {
    const s = fresh();
    const grid = add(s, 'features.grid');
    expect(() => applyOperations(s, [{ type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, variant: 'nope' }])).toThrow(/tone: default, muted, inverse; layout:/);
    expect(() => applyOperations(s, [{ type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, axis: 'tone', variant: 'two-columns' }])).toThrow(/no tone "two-columns"/);
    expect(() => applyOperations(s, [{ type: 'instance.setVariant', owner: owner(s), nodeId: grid.id, axis: 'size', variant: 'default' }])).toThrow(/no variant axis "size"/);
  });

  it('asks for the axis when an option ID is on several', () => {
    const def = structuredClone(listThemes()[0].components.find((c) => c.componentId === 'features.grid')!);
    def.variantAxes!.layout.options.muted = { label: 'Muted layout' };
    expect(findVariant(def, 'muted')).toEqual({ error: expect.stringMatching(/several variant axes/) });
    expect(findVariant(def, 'muted', 'layout')).toEqual({ axis: 'layout', id: 'muted' });
    expect(findVariant(def, 'default')).toEqual({ axis: 'tone', id: 'default' });
  });

  it('inserts with options on several axes', () => {
    const s = fresh();
    const { state, results } = applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'features.grid', variants: { tone: 'muted', layout: 'two-columns' } }]);
    expect((home(state).nodes[results[0].nodeId as string] as InstanceNode).variants).toEqual({ tone: 'muted', layout: 'two-columns' });
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'features.grid', variants: { tone: 'two-columns' } }])).toThrow(/no tone/);
  });

  it('falls back to the axis default for a stale choice', () => {
    const def = listThemes()[0].components.find((c) => c.componentId === 'features.grid')!;
    expect(selectedVariants(def, { tone: 'gone' })).toEqual({ tone: 'default', layout: 'default' });
  });

  it('warns about a placement naming an option that is gone', () => {
    const s = fresh();
    const grid = add(s, 'features.grid');
    grid.variants = { tone: 'gone' };
    expect(validateState(s).some((d) => d.code === 'VARIANT_UNKNOWN' && d.nodeId === grid.id)).toBe(true);
  });
});

describe('editing axes on a project component', () => {
  const forked = () => {
    const s = fresh();
    const grid = add(s, 'features.grid');
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: grid.id, name: 'Mine' }]);
    return { s: r.state, id: r.results[0].definitionId as string, nodeId: grid.id };
  };

  it('adds an option to a named axis, and a new axis on request', () => {
    const { s, id } = forked();
    const { state } = applyOperations(s, [
      { type: 'component.setVariant', definitionId: id, axis: 'tone', variant: 'quiet', label: 'Quiet' },
      { type: 'component.setVariant', definitionId: id, axis: 'density', axisLabel: 'How dense', variant: 'compact', label: 'Compact' }
    ]);
    const axes = state.components[id].variantAxes!;
    expect(axes.tone.options.quiet.label).toBe('Quiet');
    expect(axes.tone.default).toBe('default');
    // A new axis keeps a plain base option as its default, so placements look as they did.
    expect(axes.density).toEqual({ label: 'How dense', default: 'default', options: { default: { label: 'Default' }, compact: { label: 'Compact' } } });
  });

  it('asks which axis when there are several', () => {
    const { s, id } = forked();
    expect(() => applyOperations(s, [{ type: 'component.setVariant', definitionId: id, variant: 'quiet', label: 'Quiet' }])).toThrow(/Name the axis/);
  });

  it('removes an option, resets placements on it and drops an empty axis', () => {
    const { s, id, nodeId } = forked();
    const { state } = applyOperations(s, [
      { type: 'component.setVariant', definitionId: id, axis: 'density', variant: 'compact', label: 'Compact' },
      { type: 'instance.setVariant', owner: owner(s), nodeId, axis: 'density', variant: 'compact' },
      { type: 'instance.setVariant', owner: owner(s), nodeId, axis: 'tone', variant: 'muted' },
      { type: 'component.removeVariant', definitionId: id, axis: 'density', variant: 'compact' }
    ]);
    expect(state.components[id].variantAxes!.density.options).toEqual({ default: { label: 'Default' } });
    expect((home(state).nodes[nodeId] as InstanceNode).variants).toEqual({ tone: 'muted' });
    const emptied = applyOperations(state, [{ type: 'component.removeVariant', definitionId: id, axis: 'density', variant: 'default' }]).state;
    expect(emptied.components[id].variantAxes!.density).toBeUndefined();
  });

  it('refuses an axis with no option on a style operation, which would edit the base styles', () => {
    const { s, id } = forked();
    const own = { kind: 'component' as const, id };
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: own, nodeId: 'grid', axis: 'tone', scope: 'base', property: 'gap', value: '7px' }])).toThrow(/needs a "variant"/);
    expect(() => applyOperations(s, [{ type: 'node.resetStyles', owner: own, nodeId: 'grid', axis: 'tone' }])).toThrow(/needs a "variant"/);
  });

  it('styles one option of a named axis', () => {
    const { s, id } = forked();
    const { state } = applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'component', id }, nodeId: 'grid', axis: 'layout', variant: 'two-columns', scope: 'base', property: 'gap', value: '7px' }]);
    expect(state.components[id].variantAxes!.layout.options['two-columns'].styles!.grid.base!.gap).toBe('7px');
  });
});

describe('generating variant axes', () => {
  it('puts one class per axis on the root and combines their rules', () => {
    const s = fresh();
    add(s, 'features.grid', { tone: 'inverse', layout: 'four-columns' });
    const files = generateProject(s);
    const css = files.get(`${STYLES_DIR}/components.css`)!;
    expect(css).toContain('.so-foundation-features-grid--tone-inverse.so-foundation-features-grid__root');
    expect(css).toContain('.so-foundation-features-grid--layout-four-columns.so-foundation-features-grid__grid');
    const component = generateManagedComponent(s, s.components['foundation.features.grid'], {});
    expect(component).toContain('variant_tone = "default"');
    expect(component).toContain('variant_layout = "default"');
    expect(component).toContain('`so-foundation-features-grid--tone-${variant_tone}`');
    expect(component).toContain('`so-foundation-features-grid--layout-${variant_layout}`');
    const page = [...files.entries()].find(([p]) => p === 'src/routes/+page.svelte')![1];
    expect(page).toContain('variant_tone="inverse"');
    expect(page).toContain('variant_layout="four-columns"');
  });

  it('compiles with every combination in place', () => {
    const s = fresh();
    for (const tone of ['default', 'muted', 'inverse']) for (const layout of ['default', 'two-columns', 'four-columns']) add(s, 'features.grid', { tone, layout });
    for (const [path, source] of generateProject(s)) {
      if (!path.endsWith('.svelte')) continue;
      expect(() => compile(source, { filename: path, generate: 'server', runes: true })).not.toThrow();
    }
  });

  it('gives a code component its tone as `variant`', () => {
    const s = fresh();
    add(s, 'contact.form', { tone: 'inverse' });
    const page = generateProject(s).get('src/routes/+page.svelte')!;
    expect(page).toContain('variant="inverse"');
  });

  it('ignores axis and option IDs from a hand-edited file that cannot be generated', () => {
    const s = fresh();
    const placed = add(s, 'features.grid');
    const def = s.components['foundation.features.grid'];
    const bad = 'x{}body{display:none}';
    def.variantAxes!.tone.options[bad] = { label: 'Bad', styles: { root: { base: { opacity: 0.5 } } } };
    def.variantAxes!['bad`${1}'] = { label: 'Bad', default: 'a', options: { a: { label: 'A' } } };
    placed.variants = { tone: bad };
    const files = generateProject(s);
    expect(files.get(`${STYLES_DIR}/components.css`)).not.toContain('display:none');
    expect(files.get('src/routes/+page.svelte')).not.toContain('display:none');
    for (const [path, source] of files) if (path.endsWith('.svelte')) expect(() => compile(source, { filename: path, generate: 'server', runes: true })).not.toThrow();
    def.owner = 'project';
    expect(validateState(s).some((d) => d.code === 'VARIANT_ID_INVALID')).toBe(true);
  });

  it('lets the later axis win a property both set, as the Inspector shows it', () => {
    const s = fresh();
    add(s, 'features.grid', { tone: 'muted', layout: 'two-columns' });
    const def = s.components['foundation.features.grid'];
    def.variantAxes!.tone.options.muted.styles!.grid = { base: { gap: '1.234px' } };
    def.variantAxes!.layout.options['two-columns'].styles!.grid = { base: { gap: '2.345px' } };
    const css = generateProject(s).get(`${STYLES_DIR}/components.css`)!;
    expect(css.indexOf('gap: 1.234px')).toBeGreaterThan(-1);
    expect(css.indexOf('gap: 2.345px')).toBeGreaterThan(css.indexOf('gap: 1.234px'));
    expect(selectedVariantStyles(def, { tone: 'muted', layout: 'two-columns' }, 'grid').at(-1)!.base!.gap).toBe('2.345px');
  });

  it('lets one axis show a node another axis hides', () => {
    const s = fresh();
    add(s, 'features.grid', { tone: 'muted', layout: 'two-columns' });
    const def = s.components['foundation.features.grid'];
    def.variantAxes!.tone.options.muted.styles!.grid = { base: { hidden: true } };
    def.variantAxes!.layout.options['two-columns'].styles!.grid = { base: { hidden: false } };
    expect(generateProject(s).get(`${STYLES_DIR}/components.css`)).toMatch(/--layout-two-columns\.so-foundation-features-grid__grid \{[^}]*display: /);
  });

  /** A first-format conversion: its source places a managed child with one `variant` and reuses the child's classes. */
  function legacyConversion(s: ProjectState, source: string) {
    const r = applyOperations(s, [{ type: 'component.createCode', name: 'Old conversion', source: '<p>x</p>', properties: {} }]);
    const id = r.results[0].definitionId as string;
    r.state.components[id].source = source;
    return r.state;
  }

  it('still honours the single variant a first-format conversion passes to a managed child', () => {
    const s = fresh();
    installComponent(s, 'hero.split');
    const next = legacyConversion(s, `<script>import Hero from '../generated/foundation-hero-split.svelte';</script>\n<Hero variant="media-start" />\n`);
    const child = generateManagedComponent(next, next.components['foundation.hero.split'], {});
    expect(child).toContain('variant = undefined');
    expect(child).toContain('["default","media-start"].includes(variant) ? variant');
    expect(() => compile(child, { generate: 'server', runes: true })).not.toThrow();
    // Without such a caller the component carries none of this.
    expect(generateManagedComponent(s, s.components['foundation.hero.split'], {})).not.toContain('variant = undefined');
  });

  it('keeps the one-class names a conversion from before standalone CSS relies on', () => {
    const s = fresh();
    installComponent(s, 'features.grid');
    const next = legacyConversion(s, '<section class={[`so-foundation-features-grid--${variant}`]}></section>\n');
    const css = generateProject(next).get(`${STYLES_DIR}/components.css`)!;
    expect(css).toContain(':is(.so-foundation-features-grid--layout-two-columns, .so-foundation-features-grid--two-columns)');
    expect(generateProject(s).get(`${STYLES_DIR}/components.css`)).not.toContain(':is(.so-foundation-features-grid--layout');
  });

  it('gives a code component an axis prop only when its source reads it', () => {
    const s = fresh();
    add(s, 'contact.form', { tone: 'inverse' });
    const page = generateProject(s).get('src/routes/+page.svelte')!;
    const tag = page.slice(page.indexOf('<C_foundation_contact_form'));
    const form = tag.slice(0, tag.indexOf('/>'));
    expect(form).toContain('variant="inverse"');
    expect(form).not.toContain('variant_tone');
  });

  it('never renames a property into the variant prop namespace', () => {
    const s = fresh();
    const def = s.components[installComponent(s, 'features.grid')];
    def.properties.variant_tone = { type: 'string', label: 'Clash', default: 'x' };
    expect(() => compile(generateManagedComponent(s, def, {}), { generate: 'server', runes: true })).not.toThrow();
  });
});

describe('selection-scoped AI runs', () => {
  it('cannot rename an axis while adding an option to it', () => {
    const s = fresh();
    const grid = add(s, 'features.grid');
    const r = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: grid.id, name: 'Mine' }]);
    const id = r.results[0].definitionId as string;
    const authority = { kind: 'selection' as const, owner: { kind: 'component' as const, id }, nodeId: 'grid', label: 'Grid' };
    expect(checkAuthority(r.state, [{ type: 'component.setVariant', definitionId: id, axis: 'tone', variant: 'quiet', label: 'Quiet' }], authority)).toBeNull();
    expect(checkAuthority(r.state, [{ type: 'component.setVariant', definitionId: id, axis: 'tone', axisLabel: 'Renamed', variant: 'quiet', label: 'Quiet' }], authority)).not.toBeNull();
  });
});

describe('the AI catalogue signature', () => {
  it('lists each axis with its options', () => {
    const grid = catalogueIndex('foundation').find((c) => c.componentId === 'features.grid')!;
    expect(grid.variants).toEqual({ tone: ['default', 'muted', 'inverse'], layout: ['default', 'two-columns', 'four-columns', 'sticky-split'] });
    expect(catalogueEntries('foundation').find((c) => c.componentId === 'contact.form')!.axes).toEqual({ tone: ['default', 'muted', 'inverse'] });
  });
});
