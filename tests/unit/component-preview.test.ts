import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { installComponent } from '@engine/install';
import { compile } from 'svelte/compiler';
import { COMPONENT_PREVIEW_ROUTE, PREVIEW_COMPONENT_STYLES, PREVIEW_MODULE, previewKeyOf } from '@shared/component-preview';
import { generateComponentPreview, PREVIEW_NODE_ID } from '@generator/preview';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';

const starter = () => createStarterState('blank', 'Preview Studio', false);

/** The files of a preview that is expected to work. */
function preview(state: ProjectState, spec: Parameters<typeof generateComponentPreview>[1]) {
  const out = generateComponentPreview(state, spec);
  if ('error' in out) throw new Error(out.error);
  return out;
}

/** A code component with a variant axis, made through the same operations the editor uses. */
function withCodeComponent(state: ProjectState) {
  const source = `<script>\n\tlet { title = 'Hello', variant = 'plain', so_o, class: className = '' } = $props();\n</script>\n\n<p class="sample {className} sample--{variant}">{title}</p>\n`;
  const made = applyOperations(state, [{ type: 'component.createCode', name: 'Sample note', source, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }]);
  const id = made.results[0].definitionId as string;
  const withAxis = applyOperations(made.state, [
    { type: 'component.setVariant', definitionId: id, axis: 'tone', axisLabel: 'Tone', variant: 'plain', label: 'Plain', makeDefault: true },
    { type: 'component.setVariant', definitionId: id, axis: 'tone', variant: 'loud', label: 'Loud' }
  ]);
  return { state: withAxis.state, id };
}

describe('isolated component preview files', () => {
  it('shows a catalogue component the project does not have, without adding it to the project', () => {
    const state = starter();
    const source = catalogueComponent(state.site.themeId, 'content.media')!;
    expect(state.components[source.id]).toBeUndefined();
    const before = JSON.stringify(state);
    const out = preview(state, { componentId: 'content.media', variants: { layout: 'media-end' }, props: { heading: 'A sample heading' } });
    expect(JSON.stringify(state)).toBe(before);
    expect(out.definitionId).toBe(source.id);
    const module = out.files.get(PREVIEW_MODULE)!;
    // The component's own generated file comes with the preview, and the preview imports it where it is.
    expect(out.files.has(defFile(source))).toBe(true);
    expect(module).toContain(`from "../generated/${defFile(source).split('/').pop()}"`);
    expect(module).toContain('variant_layout="media-end"');
    expect(module).toContain('heading={"A sample heading"}');
    // Its styles, variants included, are in the preview's component stylesheet.
    expect(out.files.get(PREVIEW_COMPONENT_STYLES)).toMatch(/--layout-media-end/);
    // Identity attributes for the bridge's measurements, under a context no page uses.
    expect(module).toContain(`__so={"preview:${source.id}|${PREVIEW_NODE_ID}"}`);
    // The project's tokens, base styles and fonts are loaded from the project, never copied.
    for (const path of out.files.keys()) expect(path).not.toMatch(/styles\/(tokens|theme|site)\.css$|\/fonts\//);
  });

  it('renders each variant choice, and an axis left out keeps its default', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const base = preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)!;
    const two = preview(state, { definitionId: id, variants: { layout: 'two-columns' } }).files.get(PREVIEW_MODULE)!;
    const four = preview(state, { definitionId: id, variants: { layout: 'four-columns', tone: Object.keys(state.components[id].variantAxes!.tone.options).at(-1)! } }).files.get(PREVIEW_MODULE)!;
    expect(base).toContain('variant_layout="default"');
    expect(two).toContain('variant_layout="two-columns"');
    expect(four).toContain('variant_layout="four-columns"');
    expect(new Set([base, two, four]).size).toBe(3);
    for (const module of [base, two, four]) expect(() => compile(module, { generate: 'client', filename: 'Preview.svelte' })).not.toThrow();
  });

  it('places the instance exactly as a page placement with the same values would', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    const home = state.site.homePageId;
    const placed = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: home }, definitionId: id, props: { heading: 'Same words' }, variants: { layout: 'media-end' } } as never]);
    // The page holds this placement alone, so its attributes are the only ones there.
    placed.state.pages[home].rootIds = [placed.results[0].nodeId as string];
    const page = [...generateProject(placed.state, { instrument: true }).entries()].find(([path]) => path === 'src/routes/+page.svelte')![1];
    const module = preview(placed.state, { definitionId: id, variants: { layout: 'media-end' }, props: { heading: 'Same words' } }).files.get(PREVIEW_MODULE)!;
    const attrs = (text: string) => [...text.matchAll(/^\s*((?:heading|variant_\w+|image|body)=.*)$/gm)].map((m) => m[1]).sort();
    expect(attrs(module).length).toBeGreaterThan(3);
    expect(attrs(module)).toEqual(attrs(page));
  });

  it('shows a code component with its first axis as `variant`, as a placement passes it', () => {
    const { state, id } = withCodeComponent(starter());
    const loud = preview(state, { definitionId: id, variants: { tone: 'loud' }, props: { title: 'Shout' } });
    const module = loud.files.get(PREVIEW_MODULE)!;
    expect(module).toContain('variant="loud"');
    expect(module).toContain('title={"Shout"}');
    expect(module).toContain('data-so-code="true"');
    expect(loud.files.get(defFile(state.components[id]))).toBe(state.components[id].source);
    expect(preview(state, { definitionId: id }).files.get(PREVIEW_MODULE)).toContain('variant="plain"');
  });

  it('carries an icon that only the sample values name', () => {
    const state = starter();
    const id = installComponent(state, 'features.grid');
    const items = (state.components[id].properties.items as { default: Array<Record<string, unknown>> }).default.map((it, i) => (i === 0 ? { ...it, icon: 'stethoscope' } : it));
    const projectIcons = generateProject(state, { instrument: true }).get(`${RUNTIME_DIR}/icons.js`)!;
    expect(projectIcons).not.toContain('"stethoscope"');
    expect(preview(state, { definitionId: id, props: { items } }).files.get(`${RUNTIME_DIR}/icons.js`)).toContain('"stethoscope"');
  });

  it('refuses what a placement could not hold', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    const error = (spec: Parameters<typeof generateComponentPreview>[1]) => {
      const out = generateComponentPreview(state, spec);
      return 'error' in out ? out.error : null;
    };
    expect(error({})).toMatch(/Name one component/);
    expect(error({ definitionId: id, componentId: 'content.media' })).toMatch(/Name one component/);
    expect(error({ definitionId: 'missing' })).toMatch(/no component "missing"/);
    expect(error({ componentId: 'no.such' })).toMatch(/theme has no component/);
    expect(error({ definitionId: id, variants: { size: 'big' } })).toMatch(/no variant axis "size"/);
    expect(error({ definitionId: id, variants: { layout: 'sideways' } })).toMatch(/no option "sideways"/);
    expect(error({ definitionId: id, props: { nope: 1 } })).toMatch(/no property "nope"/);
    expect(error({ definitionId: id, props: { heading: { $prop: 'heading' } } })).toMatch(/cannot be bound/);
    expect(error({ definitionId: id, props: { headingLevel: 'h9' } })).toMatch(/Heading level|h9/i);
  });

  it('uses the project’s own copy of a catalogue component it already has', () => {
    const state = starter();
    const id = installComponent(state, 'content.media');
    state.components[id] = { ...state.components[id], name: 'Our media' };
    expect(preview(state, { componentId: 'content.media' })).toMatchObject({ definitionId: id, name: 'Our media' });
  });
});

describe('isolated previews stay out of the website', () => {
  it('generates no preview route, module or files for the project, placed components or not', () => {
    const { state } = withCodeComponent(starter());
    installComponent(state, 'content.media');
    for (const instrument of [false, true]) {
      for (const [path, content] of generateProject(state, { instrument })) {
        expect(path).not.toBe(PREVIEW_MODULE);
        expect(path).not.toMatch(/__siteorigin|\/preview\//);
        expect(content).not.toContain(COMPONENT_PREVIEW_ROUTE);
        expect(content).not.toMatch(/preview:/);
      }
    }
  });

  it('only answers the preview address with a well-formed key', () => {
    const key = 'a1b2c3d4e5f6a7b8c9d0';
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}/`)).toBe(key);
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}/?x=1`)).toBe(key);
    expect(previewKeyOf(`${COMPONENT_PREVIEW_ROUTE}${key}`)).toBe(key);
    for (const bad of [`${COMPONENT_PREVIEW_ROUTE}../${key}/`, `${COMPONENT_PREVIEW_ROUTE}${key}/x`, `${COMPONENT_PREVIEW_ROUTE}SHORT/`, '/about/', undefined]) expect(previewKeyOf(bad)).toBeNull();
  });
});
