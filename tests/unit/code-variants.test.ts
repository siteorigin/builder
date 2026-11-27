/**
 * A code component takes each variant axis through the property its manifest declares (`VariantAxis.prop`, #1073):
 * the generator passes exactly those props, and the code check reports an axis whose prop the code does not take
 * from $props().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { codeAxisProblems } from '@shared/variants';
import { createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { checkSvelteSource, codeAxisPropProblems, type CodeContract } from '../../src/main/codecheck';
import { ProjectSession } from '../../src/main/project/session';

/** Takes the layout through a renamed prop, the tone by its own name; a comment names what a design's file would take. */
const SOURCE = `<script>
\t// Not read: variant_layout, variant_tone, variant.
\tlet { title = 'Hi', arrangement: layout = 'stack', palette = 'light', class: className = '' } = $props();
</script>

<p class={[className, layout, palette]}>{title}</p>
`;

function axes(defId: string): EditOperation[] {
  return [
    { type: 'component.setVariant', definitionId: defId, axis: 'layout', axisLabel: 'Layout', prop: 'arrangement', variant: 'stack', label: 'Stacked', makeDefault: true },
    { type: 'component.setVariant', definitionId: defId, axis: 'layout', variant: 'row', label: 'In a row' },
    { type: 'component.setVariant', definitionId: defId, axis: 'tone', axisLabel: 'Tone', prop: 'palette', variant: 'light', label: 'Light', makeDefault: true },
    { type: 'component.setVariant', definitionId: defId, axis: 'tone', variant: 'dark', label: 'Dark' }
  ];
}

/** A page with the two-axis code component placed on it. */
function placed(variants: Record<string, string> = { layout: 'row', tone: 'dark' }) {
  let s: ProjectState = createStarterState('business', 'Code variants', false);
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Two axes', source: SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Hi' } } }]);
  const defId = made.results[0].definitionId as string;
  s = applyOperations(made.state, axes(defId)).state;
  const home = s.site.homePageId;
  const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, definitionId: defId, props: { title: 'Placed' }, variants } as EditOperation]);
  return { s: r.state, defId, nodeId: r.results[0].nodeId as string };
}

/** The attributes of the placement's tag on the home page, by name. */
function call(s: ProjectState, title = 'Placed'): Record<string, string> {
  const page = generateProject(s, { instrument: false }).get('src/routes/+page.svelte')!;
  const tag = page.match(new RegExp(`<C_[^<>]*title=\\{"${title}"\\}[^<>]*>`))![0];
  return Object.fromEntries([...tag.matchAll(/^\s*([\w$]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}

describe('the generator passes a code component exactly the props its axes declare', () => {
  it('passes each chosen option in its declared prop, a renamed one included, and nothing a comment or a guess names', () => {
    const { s } = placed();
    const attrs = call(s);
    expect(attrs.arrangement).toBe('"row"');
    expect(attrs.palette).toBe('"dark"');
    expect(Object.keys(attrs).filter((k) => k !== 'title' && k !== 'arrangement' && k !== 'palette')).toEqual([]);
  });

  it('keeps each axis on its own prop whatever order the manifest lists them in', () => {
    const { s, defId } = placed();
    const def = s.components[defId];
    def.variantAxes = { tone: def.variantAxes!.tone, layout: def.variantAxes!.layout };
    const attrs = call(s);
    expect([attrs.arrangement, attrs.palette]).toEqual(['"row"', '"dark"']);
  });

  it('passes the default to a placement that chose nothing, and nothing on an axis whose own choice names no option', () => {
    const plain = call(placed({}).s);
    expect([plain.arrangement, plain.palette]).toEqual(['"stack"', '"light"']);
    // A value no option has any more (a file put back from an older copy, say).
    const old = placed();
    (old.s.pages[old.s.site.homePageId].nodes[old.nodeId] as { variants?: Record<string, string> }).variants = { layout: 'gone', tone: 'dark' };
    const stale = call(old.s);
    expect(stale.arrangement).toBeUndefined();
    expect(stale.palette).toBe('"dark"');
  });

  it('passes nothing for an axis whose manifest names no sound prop, and validation says why', () => {
    const { s, defId } = placed();
    const def = s.components[defId];
    delete def.variantAxes!.layout.prop;
    def.variantAxes!.tone.prop = 'class';
    expect(call(s)).toEqual({ title: '{"Placed"}' });
    const said = validateState(s).filter((d) => d.code === 'VARIANT_INVALID').map((d) => d.message);
    expect(said).toEqual([expect.stringContaining('“Layout” variant axis names no property'), expect.stringContaining('“Tone” variant axis arrives in “class”')]);
  });
});

describe('adding an axis to a code component declares its prop', () => {
  const made = () => {
    const r = applyOperations(createStarterState('business', 'Code variants', false), [{ type: 'component.createCode', name: 'Note', source: SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Hi' } } }]);
    return { s: r.state, defId: r.results[0].definitionId as string };
  };
  const setVariant = (s: ProjectState, defId: string, more: Record<string, unknown>) => applyOperations(s, [{ type: 'component.setVariant', definitionId: defId, variant: 'loud', label: 'Loud', ...more } as EditOperation]).state;

  it('names a new axis’s prop after the axis unless one is given, and keeps it while options change', () => {
    const { s, defId } = made();
    const once = setVariant(s, defId, { axis: 'palette' });
    expect(once.components[defId].variantAxes!.palette.prop).toBe('palette');
    const again = setVariant(once, defId, { axis: 'palette', variant: 'soft', label: 'Soft' });
    expect(again.components[defId].variantAxes!.palette.prop).toBe('palette');
  });

  it('moves an axis to another prop, keeping what placements chose', () => {
    const { s, defId, nodeId } = placed();
    const next = setVariant(s, defId, { axis: 'tone', variant: 'dark', label: 'Dark', prop: 'mood' });
    expect(next.components[defId].variantAxes!.tone.prop).toBe('mood');
    expect((next.pages[next.site.homePageId].nodes[nodeId] as { variants?: unknown }).variants).toEqual({ layout: 'row', tone: 'dark' });
    expect(call(next).mood).toBe('"dark"');
  });

  it('refuses a prop a placement passes itself, one of the component’s properties, another axis’s, or no name at all', () => {
    const { s, defId } = placed();
    for (const [prop, said] of [
      ['so_o', 'a name every placement already passes'],
      ['slot_content', 'a name every placement already passes'],
      ['title', "also one of the component's properties"],
      ['arrangement', 'as the “Layout” axis does'],
      ['two words', 'not a property name']
    ])
      expect(() => setVariant(s, defId, { axis: 'tone', variant: 'dark', label: 'Dark', prop }), prop).toThrow(said);
  });

  it('refuses a prop on a design, which takes every axis itself', () => {
    const r = applyOperations(createStarterState('business', 'Code variants', false), [{ type: 'component.create', name: 'Block' } as EditOperation]);
    const id = r.results[0].definitionId as string;
    expect(() => setVariant(r.state, id, { axis: 'tone', prop: 'tone' })).toThrow('only a code component takes one through a property');
    expect(setVariant(r.state, id, { axis: 'tone' }).components[id].variantAxes!.tone.prop).toBeUndefined();
  });

  it('is reported when a property added later takes the axis’s name', () => {
    const { s, defId } = placed();
    s.components[defId].properties.palette = { type: 'string', label: 'Palette', default: '' };
    expect(codeAxisProblems(s.components[defId])).toEqual([{ axis: 'tone', message: expect.stringContaining('also one of the component') }]);
  });
});

describe('the code check holds code to the props its axes declare', () => {
  const contract = (s: ProjectState, defId: string): CodeContract => ({ slots: s.components[defId].slots, parts: s.components[defId].parts, variantAxes: s.components[defId].variantAxes });
  const said = async (source: string, c: CodeContract) => (await checkSvelteSource(source, { contract: c })).filter((p) => /variant arrives/.test(p.message)).map((p) => `${p.severity}: ${p.message}`);

  it('accepts code that takes each axis’s prop, under a name of its own or its own', async () => {
    const { s, defId } = placed();
    expect(await said(SOURCE, contract(s, defId))).toEqual([]);
  });

  it('refuses code that never takes an axis’s prop, however often a comment or string names it', async () => {
    const { s, defId } = placed();
    const dropped = SOURCE.replace("palette = 'light', ", '').replace('Not read: ', 'Not read: palette, ').replace('{title}</p>', '{title} palette</p>');
    expect(await said(dropped, contract(s, defId))).toEqual([expect.stringMatching(/^error: The “Tone” variant arrives in palette, which the code never takes from \$props\(\)/)]);
  });

  it('only warns when the code takes its props whole or keeps the rest, where it may read the axis', async () => {
    const { s, defId } = placed();
    const whole = `<script>\n\tlet props = $props();\n\tconst look = (p) => [p.arrangement, p.palette].join(' ');\n</script>\n\n<p class={look(props)}>{props.title}</p>\n`;
    const rest = SOURCE.replace("palette = 'light', ", '').replace("class: className = ''", "class: className = '', ...others");
    expect(await said(whole, contract(s, defId))).toEqual([expect.stringMatching(/^warning: The “Layout” variant arrives in arrangement/), expect.stringMatching(/^warning: The “Tone” variant arrives in palette/)]);
    expect(await said(rest, contract(s, defId))).toEqual([expect.stringMatching(/^warning: The “Tone” variant arrives in palette/)]);
  });

  it('checks the axes alone against code that is unchanged', async () => {
    const { s, defId } = placed();
    expect(await codeAxisPropProblems(SOURCE, s.components[defId].variantAxes)).toEqual([]);
    const moved = { ...s.components[defId].variantAxes!, tone: { ...s.components[defId].variantAxes!.tone, prop: 'mood' } };
    expect(await codeAxisPropProblems(SOURCE, moved)).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('arrives in mood') })]);
    expect(await codeAxisPropProblems('<p>{', moved)).toBeNull();
  });

  it('passes every bundled theme’s code components, each axis declared and taken', async () => {
    const code = new Map<string, ComponentDefinition>();
    for (const t of listThemes()) for (const d of t.components) if (d.kind === 'code' && d.source && Object.keys(d.variantAxes ?? {}).length) code.set(d.id, d);
    expect(code.size).toBeGreaterThan(0);
    for (const d of code.values()) {
      expect(codeAxisProblems(d), d.id).toEqual([]);
      expect(await codeAxisPropProblems(d.source!, d.variantAxes), d.id).toEqual([]);
    }
  });
});

describe('saving a project’s code holds it to its axes’ props', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('refuses an axis whose prop the unchanged code never takes, and a change of code that stops taking one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-code-variants-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Code variants', false));
    try {
      const opts = { label: 'Edit', source: 'user' as const, codeAllowed: true };
      const made = await session.apply({ operations: [{ type: 'component.createCode', name: 'Two axes', source: SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Hi' } } }] }, opts);
      expect(made.ok).toBe(true);
      const defId = Object.values(session.state.components).find((d) => d.name === 'Two axes')!.id;
      const missing = await session.apply({ operations: [{ type: 'component.setVariant', definitionId: defId, axis: 'tone', variant: 'dark', label: 'Dark' }] }, opts);
      expect(missing.ok).toBe(false);
      expect(!missing.ok && missing.error.message).toContain('The “Tone” variant arrives in tone, which the code never takes');
      expect(session.state.components[defId].variantAxes).toBeUndefined();
      expect((await session.apply({ operations: axes(defId) }, opts)).ok).toBe(true);
      const dropped = await session.apply({ operations: [{ type: 'component.updateSource', definitionId: defId, source: SOURCE.replace("arrangement: layout = 'stack', ", '').replace('[className, layout, palette]', '[className, palette]') }] }, opts);
      expect(dropped.ok).toBe(false);
      expect(!dropped.ok && dropped.error.message).toContain('The “Layout” variant arrives in arrangement');
    } finally {
      await session.close();
    }
  });
});
