/**
 * Slots and marked parts of a project code component, end to end without the app: saving the code declares what it
 * shows, the code check holds it to that contract, a placement's slot takes managed content, the editor names a
 * marked part from the preview's descriptor and back, its styles reach the part through the class the code places,
 * and the website's build carries no marker.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject, generateStandaloneComponent } from '@generator/index';
import { checkSvelteSource, withoutPartMarkers } from '../../src/main/codecheck';
import { descOf, isCodePart, selectionFromChain } from '../../src/renderer/src/lib/model';

const SOURCE = `<script>
\tlet { title = 'Total', class: className = '', so_o = undefined, slot_content = undefined } = $props();
</script>

<section class={className}>
\t<output class={['amount', so_o?.total]} data-so-part="total">{title}</output>
\t<div class="extras">{@render slot_content?.()}</div>
</section>
`;

/** A page with a placed code component whose code marks a "total" part and shows a "content" slot. */
function calculator() {
  let s: ProjectState = createStarterState('business', 'Code Parts', false);
  const pageId = s.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Price calculator', source: SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Total' } } }]);
  const defId = made.results[0].definitionId as string;
  s = made.state;
  const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId } as EditOperation]);
  s = placed.state;
  const calc = placed.results[0].nodeId as string;
  return { s, pageId, owner, defId, calc };
}

const homeFile = (s: ProjectState, pageId: string) => (s.pages[pageId].route === '/' ? 'src/routes/+page.svelte' : `src/routes${s.pages[pageId].route}+page.svelte`);

describe('a code component declares what its code shows', () => {
  it('declares the parts it marks and the slots it renders when it is saved, and keeps them when they go', () => {
    const { s, defId } = calculator();
    const def = s.components[defId];
    expect(def.parts.total).toEqual({ nodeId: 'total', label: 'Total' });
    expect(def.slots).toEqual({ content: { label: 'Content' } });
    // A slot taken from $props() under its own name counts, rendered through an alias.
    const aliased = `<script>\n\tlet { slot_sidebarItems: items } = $props();\n</script>\n\n<aside>{@render items?.()}</aside>\n`;
    const next = applyOperations(s, [{ type: 'component.updateSource', definitionId: defId, source: aliased }]).state;
    expect(next.components[defId].slots).toEqual({ content: { label: 'Content' }, sidebarItems: { label: 'Sidebar items' } });
    // Nothing is taken away: the "total" part keeps its placements' styles until it is removed.
    expect(next.components[defId].parts.total).toBeDefined();
  });
});

describe('the code check holds code to its contract', () => {
  const contract = (s: ProjectState, defId: string) => ({ slots: s.components[defId].slots, parts: s.components[defId].parts });

  it('accepts code that renders its slots safely and marks its parts with their classes', async () => {
    const { s, defId } = calculator();
    const problems = await checkSvelteSource(SOURCE, { contract: contract(s, defId) });
    expect(problems).toEqual([]);
  });

  it('refuses a slot rendered without a guard, which fails on the server while a placement leaves it empty', async () => {
    const { s, defId } = calculator();
    const plain = SOURCE.replace('{@render slot_content?.()}', '{@render slot_content()}');
    const errors = (await checkSvelteSource(plain, { contract: contract(s, defId) })).filter((p) => p.severity === 'error');
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('{@render slot_content?.()}')]);
    expect(errors[0].line).toBe(7);
    // Inside a block that shows it only when it is given, a plain call is safe.
    const guarded = SOURCE.replace('{@render slot_content?.()}', '{#if slot_content}{@render slot_content()}{/if}');
    expect((await checkSvelteSource(guarded, { contract: contract(s, defId) })).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('says when a declared slot is never shown, or is not taken from $props()', async () => {
    const { s, defId } = calculator();
    const typo = SOURCE.replace('{@render slot_content?.()}', '{@render slot_contnet?.()}');
    const found = await checkSvelteSource(typo, { contract: contract(s, defId) });
    expect(found).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('“Content” slot is never shown') }));
    const notProp = SOURCE.replace(', slot_content = undefined', '');
    const errors = (await checkSvelteSource(notProp, { contract: contract(s, defId) })).filter((p) => p.severity === 'error');
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('slot_content must be taken from $props()') }));
  });

  it('names a part marked without its class, one it does not mark, and a marker it cannot read', async () => {
    const { s, defId } = calculator();
    const c = { slots: s.components[defId].slots, parts: { ...s.components[defId].parts, note: { nodeId: 'note', label: 'Note' } } };
    const unhooked = SOURCE.replace("class={['amount', so_o?.total]}", 'class="amount"').replace('<div class="extras">', '<div class="extras" data-so-part={which}>');
    const messages = (await checkSvelteSource(unhooked, { contract: c })).map((p) => `${p.severity}: ${p.message}`);
    expect(messages).toContainEqual(expect.stringMatching(/^warning: Give the element marked “total” the part's class/));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: The “Note” part is not marked in the code/));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: Mark a part with its name written out/));
    const badName = SOURCE.replace('data-so-part="total"', 'data-so-part="grand total"');
    expect((await checkSvelteSource(badName, { contract: c })).filter((p) => p.severity === 'error').map((p) => p.message)).toEqual([expect.stringContaining('camelCase')]);
  });
});

describe('a code placement takes managed content in its slot', () => {
  it('passes what is placed as the slot’s snippet, and in the editor marks an empty slot only while editing', () => {
    const { s, pageId, owner, calc } = calculator();
    const dev = generateProject(s, { instrument: true }).get(homeFile(s, pageId))!;
    // Empty: the placeholder is given only while editing, so the code's own {:else} still shows in Preview.
    expect(dev).toMatch(/\{#snippet (so_slot_empty_\d+)\(\)\}\s*<span class="so-slot-empty" data-so-editor-only="" data-so-slot-empty=\{"content"\}>/);
    expect(dev).toMatch(/slot_content=\{so_editing \? so_slot_empty_\d+ : undefined\}/);
    const clean = generateProject(s, { instrument: false }).get(homeFile(s, pageId))!;
    expect(clean).not.toContain('slot_content');
    expect(clean).not.toContain('so-slot-empty');

    // A Stack placed in the slot, holding a Button.
    let next = applyOperations(s, [{ type: 'node.insert', owner, parentId: calc, slot: 'content', primitive: 'stack' }]).state;
    const stack = (next.pages[pageId].nodes[calc] as InstanceNode).slots!.content[0];
    next = applyOperations(next, [{ type: 'node.insert', owner, parentId: stack, primitive: 'button', text: 'Book a call' }]).state;
    const filled = generateProject(next, { instrument: false }).get(homeFile(next, pageId))!;
    expect(filled).toMatch(/\{#snippet slot_content\(\)\}[\s\S]*Book a call[\s\S]*\{\/snippet\}/);
    expect(filled).not.toContain('so_slot_empty');
  });
});

describe('a marked part of a code placement is picked and styled', () => {
  it('names the part from the preview’s descriptor and finds it again by the same descriptor', () => {
    const { s, owner, calc } = calculator();
    const part: ElementRef = { owner, instancePath: [calc], nodeId: 'total', partId: 'total' };
    expect(isCodePart(s, part)).toBe(true);
    const desc = descOf(s, part);
    expect(desc).toEqual({ ctx: `page:${owner.id}`, node: calc, items: '', part: 'total' });
    const placement = descOf(s, { owner, instancePath: [], nodeId: calc });
    // A click on the part: the bridge names the part just inside its placement.
    const chain = [{ ...desc, tag: 'output' }, { ...placement, code: true }];
    const first = selectionFromChain(s, chain, null, false);
    expect(first).toEqual({ owner, instancePath: [], nodeId: calc });
    expect(selectionFromChain(s, chain, first, false)).toEqual(part);
    // A part it does not declare, or its root, names nothing more than the placement.
    for (const other of ['gone', 'root']) expect(selectionFromChain(s, [{ ...desc, part: other }, { ...placement, code: true }], first, false)).toEqual(first);
  });

  it('goes from the placement straight to content placed in its slot, past the part around it', () => {
    const { s, owner, pageId, calc } = calculator();
    const next = applyOperations(s, [{ type: 'node.insert', owner, parentId: calc, slot: 'content', primitive: 'button', text: 'Book' }]).state;
    const button = (next.pages[pageId].nodes[calc] as InstanceNode).slots!.content[0];
    const placement = descOf(next, { owner, instancePath: [], nodeId: calc });
    const chain = [descOf(next, { owner, instancePath: [], nodeId: button }), { ...descOf(next, { owner, instancePath: [calc], nodeId: 'total', partId: 'total' }), tag: 'div' }, { ...placement, code: true }];
    const first = selectionFromChain(next, chain, null, false);
    expect(selectionFromChain(next, chain, first, false)).toEqual({ owner, instancePath: [], nodeId: button });
  });

  it('applies the part’s phone and hover styles through the class the code places', () => {
    const { s, owner, calc } = calculator();
    const styled = applyOperations(s, [
      { type: 'node.setStyle', owner, nodeId: calc, partId: 'total', scope: 'phone', property: 'color', value: '#ff0000' },
      { type: 'node.setStyle', owner, nodeId: calc, partId: 'total', scope: 'base', state: 'hover', property: 'color', value: '#00ff00' }
    ]).state;
    const files = generateProject(styled, { instrument: false });
    const page = files.get(homeFile(styled, s.site.homePageId))!;
    const map = page.match(/so_o=\{(\{[^}]*\})\}/);
    expect(map).not.toBeNull();
    const cls = (JSON.parse(map![1]) as Record<string, string>).total.split(' ')[0];
    const css = [...files.entries()].filter(([p]) => p.endsWith('.css')).map(([, c]) => c).join('\n');
    expect(css).toMatch(new RegExp(`@media[^{]*max-width[^{]*\\{[^}]*\\.${cls}[^{]*\\{[^}]*color: #ff0000`));
    expect(css).toMatch(new RegExp(`@media \\(hover: hover\\)[^{]*\\{[^}]*\\.${cls}:where\\(:hover\\)[^{]*\\{[^}]*color: #00ff00`));
  });
});

describe('converting a design to code keeps its parts and slots findable', () => {
  it('marks each part but the root in the converted code, beside its class, and keeps the slots', () => {
    let s: ProjectState = createStarterState('business', 'Convert', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const section = s.pages[owner.id].rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: 'Kept' }]).state;
    const def = s.components[(s.pages[owner.id].nodes[section] as InstanceNode).definitionId];
    const source = generateStandaloneComponent(s, { ...def, kind: 'code' });
    for (const [pid] of Object.entries(def.parts).filter(([p]) => p !== 'root')) {
      expect(source).toMatch(new RegExp(`so_o\\?\\.\\["${pid}"\\][^>]*data-so-part="${pid}"`));
    }
    expect(source).not.toContain('data-so-part="root"');
    const converted = applyOperations(s, [{ type: 'component.convertToCode', owner, nodeId: section }]);
    const code = converted.state.components[converted.results[0].definitionId as string];
    expect(code.kind).toBe('code');
    expect(code.slots).toEqual(def.slots);
    expect(Object.keys(code.parts)).toEqual(Object.keys(def.parts));
    expect((converted.state.pages[owner.id].nodes[section] as InstanceNode).slots?.content).toHaveLength(1);
    expect(code.source).toContain('{@render slot_content?.()}');
  });
});

describe('the website’s build carries no part marker', () => {
  it('takes every marker out of the code, written out or not, and leaves the rest as it was', async () => {
    const src = SOURCE.replace('<div class="extras">', '<div class="extras" data-so-part={"extras"}>');
    const clean = await withoutPartMarkers(src);
    expect(clean).not.toContain('data-so-part');
    expect(clean).toBe(SOURCE.replace(' data-so-part="total"', ''));
    // Text that only mentions a marker is the site's own words.
    const said = '<p>Mark parts with data-so-part="name".</p>\n';
    expect(await withoutPartMarkers(said)).toBe(said);
  });
});
