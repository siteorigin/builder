/**
 * A code component's code is held to its manifest (#1080): every declared property is taken from $props(), every prop
 * it takes is declared (or is one the editor passes), and a default written in the code is the manifest's. Errors for
 * the assistant's code, an installed pack's and the pack build; warnings in the code editor and for a user's save.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, PropSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { BUILTIN_PACKS } from '@catalogue/builtin';
import { checkSvelteSource, codeManifestProblems, packManifestProblems, type CodeManifest } from '../../src/main/codecheck';
import { ProjectSession } from '../../src/main/project/session';

const props = (properties: Record<string, PropSchema>, variantAxes?: ComponentDefinition['variantAxes']): CodeManifest => ({ properties, ...(variantAxes ? { variantAxes } : {}) });
const str = (label: string, d = ''): PropSchema => ({ type: 'string', label, default: d });
const TITLE = props({ title: str('Title', 'Hi') });
const messages = async (source: string, manifest: CodeManifest, strict = true) => (await codeManifestProblems(source, manifest, strict))!.map((p) => `${p.severity}: ${p.message}`);

describe('checking a code component against its manifest', () => {
  it('passes code that takes exactly its properties, with their defaults or none', async () => {
    expect(await messages(`<script>\n\tlet { title = 'Hi' } = $props();\n</script>\n<p>{title}</p>\n`, TITLE)).toEqual([]);
    expect(await messages(`<script>\n\tlet { title } = $props();\n</script>\n<p>{title}</p>\n`, TITLE)).toEqual([]);
  });

  it('reports a declared property the code never takes', async () => {
    const source = `<script>\n\tlet { title } = $props();\n</script>\n<p>{title}</p>\n`;
    const found = await messages(source, props({ title: str('Title'), lead: str('Supporting text') }));
    expect(found).toEqual(['error: The “Supporting text” property arrives in lead, which the code never takes from $props(): take it (let { lead } = $props()), or remove the property, as what placements set there will not show.']);
    // In the code editor it only warns.
    expect(await messages(source, props({ title: str('Title'), lead: str('Supporting text') }), false)).toEqual([found[0].replace(/^error/, 'warning')]);
  });

  it('reports a prop the code takes that no property declares, on its line, apart from the editor’s own', async () => {
    const source = `<script>\n\tlet {\n\t\ttitle,\n\t\tsubtitle = '',\n\t\tclass: className = '',\n\t\tso_o,\n\t\tso_id,\n\t\tchildren,\n\t\tslot_content,\n\t\tpalette = 'light'\n\t} = $props();\n</script>\n<p id={so_id} class={[className, so_o?.root, palette]}>{title}{subtitle}{@render slot_content?.()}{@render children?.()}</p>\n`;
    const tone = { tone: { label: 'Tone', prop: 'palette', default: 'light', options: { light: { label: 'Light' }, dark: { label: 'Dark' } } } };
    const found = await codeManifestProblems(source, props({ title: str('Title') }, tone), true);
    expect(found).toEqual([{ severity: 'error', message: "The code takes subtitle from $props(), which is not one of the component's properties: declare it, or stop reading it, as no placement can set it.", line: 4 }]);
    // Without the axis that names it, palette is a prop nothing passes too.
    expect((await messages(source, props({ title: str('Title') }))).filter((m) => m.includes('palette'))).toHaveLength(1);
  });

  it('counts a prop destructured under a rename by the name it arrives in, and its default', async () => {
    const renamed = `<script>\n\tlet { title: heading = 'Hi' } = $props();\n</script>\n<h2>{heading}</h2>\n`;
    expect(await messages(renamed, TITLE)).toEqual([]);
    // The local's name is no property: heading is not taken, title is.
    expect(await messages(renamed, props({ heading: str('Heading', 'Hi') }))).toEqual([
      'error: The “Heading” property arrives in heading, which the code never takes from $props(): take it (let { heading } = $props()), or remove the property, as what placements set there will not show.',
      "error: The code takes title from $props(), which is not one of the component's properties: declare it, or stop reading it, as no placement can set it."
    ]);
    expect(await messages(renamed.replace("= 'Hi'", "= 'Hello'"), TITLE)).toEqual(['error: The code\'s default for title ("Hello") is not the “Title” property\'s default ("Hi"): write the manifest\'s default, or none.']);
  });

  it('reads the rest of the props by name, and only warns about what a rest it hands on may carry', async () => {
    const manifest = props({ title: str('Title'), lead: str('Supporting text') });
    // Read by name from the rest: lead is taken, and extra is a prop no property declares.
    const read = `<script>\n\tlet { title, ...rest } = $props();\n</script>\n<p>{title} {rest.lead} {rest.extra}</p>\n`;
    expect(await messages(read, manifest)).toEqual(["error: The code takes extra from $props(), which is not one of the component's properties: declare it, or stop reading it, as no placement can set it."]);
    // Spread onto an element, the rest may carry lead there, which the check cannot see: a warning, even for the assistant.
    const spread = `<script>\n\tlet { title, ...rest } = $props();\n</script>\n<p {...rest}>{title}</p>\n`;
    expect(await messages(spread, manifest)).toEqual([
      'warning: The “Supporting text” property arrives in lead, which the code does not take from $props() by name: take it (let { lead } = $props()) so the check can see the code reads it.'
    ]);
    // So does the whole props object taken as one, read by name.
    expect(await messages(`<script>\n\tlet p = $props();\n</script>\n<p>{p.title}{p['lead']}</p>\n`, manifest)).toEqual([]);
  });

  it('compares a default written as a literal with the one the code is given, and skips one the code works out', async () => {
    const manifest = props({
      count: { type: 'number', label: 'Count', default: 3 },
      open: { type: 'boolean', label: 'Open', default: false },
      size: { type: 'enum', label: 'Size', default: 'md', options: [{ value: 'md', label: 'Medium' }, { value: 'lg', label: 'Large' }] },
      body: { type: 'richtext', label: 'Body', default: 'First paragraph' },
      table: { type: 'table', label: 'Table', default: { columns: [{ id: 'col_a', label: 'A' }], rows: [] } }
    });
    const take = (defaults: string) => `<script>\n\tlet { ${defaults} } = $props();\n</script>\n<p>{count}{open}{size}{body}{table}</p>\n`;
    expect(await messages(take(`count = 3, open = false, size = 'md', body = ['First paragraph'], table = { rows: [], columns: [{ label: 'A', id: 'col_a' }] }`), manifest)).toEqual([]);
    // Worked out, or explicitly undefined or null, a default says nothing against the manifest's.
    expect(await messages(take(`count = 1 + 2, open = undefined, size = null, body = [], table`).replace('body = []', 'body = [...[]]'), manifest)).toEqual([]);
    const off = await messages(take(`count = -3, open = true, size = 'lg', body = [], table = { columns: [], rows: [] }`), manifest);
    expect(off.map((m) => /default for (\w+)/.exec(m)?.[1])).toEqual(['count', 'open', 'size', 'body', 'table']);
    expect(off[0]).toBe('error: The code\'s default for count (-3) is not the “Count” property\'s default (3): write the manifest\'s default, or none.');
  });

  it('runs in the full check with the manifest given, at the policy’s severity', async () => {
    const source = `<script>\n\tlet { title = 'Hello', extra } = $props();\n</script>\n<p>{title}{extra}</p>\n`;
    const strict = (await checkSvelteSource(source, { strict: true, manifest: TITLE })).filter((p) => /default for title|takes extra/.test(p.message));
    expect(strict.map((p) => p.severity)).toEqual(['error', 'error']);
    const lenient = (await checkSvelteSource(source, { manifest: TITLE })).filter((p) => /default for title|takes extra/.test(p.message));
    expect(lenient.map((p) => p.severity)).toEqual(['warning', 'warning']);
    // Without a manifest nothing is said about properties.
    expect((await checkSvelteSource(source, { strict: true })).filter((p) => /default for title|takes extra/.test(p.message))).toEqual([]);
  });

  it('passes every code component of every pack this repository builds', async () => {
    let checked = 0;
    for (const pack of BUILTIN_PACKS) {
      checked += pack.components.filter((c) => c.kind === 'code').length;
      expect(await packManifestProblems(pack.components), pack.id).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
    // A pack whose code takes a prop its manifest lacks is named, with the problem.
    const table = BUILTIN_PACKS[0].components.find((c) => c.componentId === 'data.table')!;
    const { caption: _caption, ...rest } = table.properties;
    expect(await packManifestProblems([{ ...table, properties: rest }])).toEqual([expect.stringMatching(/^Component data\.table: line \d+: The code takes caption from \$props\(\)/)]);
  });
});

describe('saving a code component holds its code to its manifest', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const SOURCE = `<script>\n\tlet { title = 'Hi', subtitle = '', class: className = '' } = $props();\n</script>\n\n<p class={className}>{title} {subtitle}</p>\n`;

  it('refuses the assistant’s code that takes a prop no property declares, and saves the user’s with a warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-code-manifest-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Code manifest', false));
    try {
      const create = { type: 'component.createCode' as const, name: 'Titled', source: SOURCE, properties: { title: str('Title', 'Hi') } };
      const revision = session.revision;
      const ai = await session.apply({ operations: [create] }, { label: 'Create', source: 'ai', codeAllowed: true });
      expect(ai.ok).toBe(false);
      expect(ai.error?.message).toContain('The code takes subtitle from $props()');
      expect(session.revision).toBe(revision);
      // The user's own code is saved: the code editor showed the same finding as a warning.
      const user = await session.apply({ operations: [create] }, { label: 'Create', source: 'user', codeAllowed: true });
      expect(user.ok).toBe(true);
      const defId = Object.values(session.state.components).find((d) => d.name === 'Titled')!.id;
      // A manifest-only change by the assistant to unchanged code is checked too: a property the code never takes.
      const added = await session.apply({ operations: [{ type: 'component.setPropSchema', definitionId: defId, prop: 'lead', schema: str('Lead') }] }, { label: 'Edit', source: 'ai', codeAllowed: true });
      expect(added.ok).toBe(false);
      expect(added.error?.message).toContain('The “Lead” property arrives in lead, which the code never takes');
      expect(Object.keys(session.state.components[defId].properties)).toEqual(['title']);
      // Declaring what the code takes is saved.
      const declared = await session.apply({ operations: [{ type: 'component.setPropSchema', definitionId: defId, prop: 'subtitle', schema: str('Subtitle') }] }, { label: 'Edit', source: 'ai', codeAllowed: true });
      expect(declared.ok).toBe(true);
    } finally {
      await session.close();
    }
  });
});
