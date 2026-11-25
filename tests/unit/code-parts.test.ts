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
import { generateProject } from '@generator/index';
import { checkSvelteSource, codeContractNames, withoutPartMarkers, type CodeContract } from '../../src/main/codecheck';
import { declareCodeNames } from '@engine/definitions';
import { carriesPartMarker } from '../../src/main/export';
import { descOf, isCodePart, selectionFromChain } from '../../src/renderer/src/lib/model';

const SOURCE = `<script>
\tlet { title = 'Total', class: className = '', so_o = undefined, slot_content = undefined } = $props();
</script>

<section class={className}>
\t<output class={['amount', so_o?.total]} data-so-part="total">{title}</output>
\t<div class="extras">{@render slot_content?.()}</div>
</section>
`;

/** A page with a placed code component whose code marks a "total" part and shows a "content" slot, declared as saving it declares them. */
async function calculator(source = SOURCE) {
  let s: ProjectState = createStarterState('business', 'Code Parts', false);
  const pageId = s.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Price calculator', source, properties: { title: { type: 'string', label: 'Title', default: 'Total' } } }]);
  const defId = made.results[0].definitionId as string;
  s = made.state;
  declareCodeNames(s.components[defId], (await codeContractNames(source))!);
  const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId } as EditOperation]);
  s = placed.state;
  const calc = placed.results[0].nodeId as string;
  return { s, pageId, owner, defId, calc };
}

const homeFile = (s: ProjectState, pageId: string) => (s.pages[pageId].route === '/' ? 'src/routes/+page.svelte' : `src/routes${s.pages[pageId].route}+page.svelte`);
/** The component as saving `source` leaves it: the code, and what it declares. */
async function save(s: ProjectState, defId: string, source: string) {
  const def = applyOperations(s, [{ type: 'component.updateSource', definitionId: defId, source }]).state.components[defId];
  declareCodeNames(def, (await codeContractNames(source))!);
  return def;
}

describe('a code component declares what its code shows', () => {
  it('declares the parts it marks or hooks and the slots it takes from $props() when it is saved, and keeps them when they go', async () => {
    const { s, defId } = await calculator();
    const def = s.components[defId];
    expect(def.parts.total).toEqual({ nodeId: 'total', label: 'Total' });
    expect(def.slots).toEqual({ content: { label: 'Content' } });
    // A slot taken under an alias, after an object default; a part only hooked, and one marked without quotes.
    const next = await save(
      s,
      defId,
      `<script>\n\tlet { options = { a: {} }, slot_sidebarItems: items } = $props();\n</script>\n\n<aside class={so_o?.["footNote"]}>{@render items?.()}</aside>\n<p data-so-part=badge>x</p>\n`
    );
    expect(next.slots).toEqual({ content: { label: 'Content' }, sidebarItems: { label: 'Sidebar items' } });
    expect(next.parts.footNote).toEqual({ nodeId: 'footNote', label: 'Foot note' });
    expect(next.parts.badge).toEqual({ nodeId: 'badge', label: 'Badge' });
    // A typed $props() pattern, and a hook written with a plain dot.
    const typed = await save(s, defId, `<script lang="ts">\n\tlet { slot_aside, so_o }: { slot_aside?: () => unknown; so_o?: Record<string, string> } = $props();\n</script>\n\n<p class={so_o.lede}>{@render slot_aside?.()}</p>\n`);
    expect(typed.slots?.aside).toEqual({ label: 'Aside' });
    expect(typed.parts.lede).toEqual({ nodeId: 'lede', label: 'Lede' });
    // Nothing is taken away: the "total" part keeps its placements' styles until it is removed.
    expect(next.parts.total).toBeDefined();
  });

  it('declares nothing from comments, from a snippet of its own, or from a name that is not a part’s', async () => {
    const { s, defId } = await calculator();
    const before = s.components[defId];
    const next = await save(
      s,
      defId,
      `<script>\n\t// let { slot_ghost } = $props();\n\t/* so_o?.phantom */\n\tlet { slot_content, so_o, options = { slot_inner: null, note: '}' } } = $props();\n\tconst debug = so_o?.debugOnly;\n</script>\n\n<!-- <p data-so-part="hidden"></p> -->\n{#snippet slot_badge()}<b>!</b>{/snippet}\n{@render slot_badge()}\n<p data-so-part=" padded " title='docs // data-so-part="ghost"'>x</p>\n{@render slot_content?.()}\n`
    );
    expect(Object.keys(next.slots ?? {})).toEqual(Object.keys(before.slots ?? {}));
    expect(Object.keys(next.parts).sort()).toEqual(Object.keys(before.parts).sort());
  });
});

describe('saving code declares what it shows inside the operation itself', () => {
  it('lets the same batch fill a slot the code just gained, and declares again on a save of the same code', async () => {
    const { s, owner, defId, calc } = await calculator();
    const source = SOURCE.replace('slot_content = undefined', 'slot_content = undefined, slot_aside = undefined').replace('</section>', '\t<aside>{@render slot_aside?.()}</aside>\n</section>');
    const names = (await codeContractNames(source))!;
    const r = applyOperations(s, [{ type: 'component.updateSource', definitionId: defId, source }, { type: 'node.insert', owner, parentId: calc, slot: 'aside', primitive: 'button', text: 'Aside' }], { codeNames: (src) => (src === source ? names : undefined) });
    expect(r.state.components[defId].slots?.aside).toEqual({ label: 'Aside' });
    expect((r.state.pages[owner.id].nodes[calc] as InstanceNode).slots?.aside).toHaveLength(1);
    // The same code saved again (after an edit outside the app, say) still declares what it shows.
    const bare = structuredClone(s);
    bare.components[defId].source = source;
    const again = applyOperations(bare, [{ type: 'component.updateSource', definitionId: defId, source }], { codeNames: () => names });
    expect(again.state.components[defId].slots?.aside).toEqual({ label: 'Aside' });
  });
});

describe('the code check holds code to its contract', () => {
  const contract = (s: ProjectState, defId: string, more: Partial<CodeContract> = {}): CodeContract => ({ slots: s.components[defId].slots, parts: s.components[defId].parts, ...more });
  const errors = async (source: string, c: CodeContract) => (await checkSvelteSource(source, { contract: c })).filter((p) => p.severity === 'error').map((p) => p.message);

  it('accepts code that renders its slots safely and marks its parts with their classes', async () => {
    const { s, defId } = await calculator();
    expect(await checkSvelteSource(SOURCE, { contract: contract(s, defId) })).toEqual([]);
  });

  it('refuses a slot rendered where a placement with nothing in it fails on the server, and only there', async () => {
    const { s, defId } = await calculator();
    const c = contract(s, defId);
    const with_ = (render: string) => SOURCE.replace('{@render slot_content?.()}', render);
    const plain = await checkSvelteSource(with_('{@render slot_content()}'), { contract: c });
    expect(plain.filter((p) => p.severity === 'error').map((e) => e.message)).toEqual([expect.stringContaining('{@render slot_content?.()}')]);
    expect(plain.find((p) => p.severity === 'error')!.line).toBe(7);
    // Shown only while it is given: safe.
    expect(await errors(with_('{#if slot_content}{@render slot_content()}{/if}'), c)).toEqual([]);
    expect(await errors(with_('{#if open && slot_content}{@render slot_content()}{/if}'), c)).toEqual([]);
    // Shown while it is missing, or in the branch for when it is: not safe.
    expect(await errors(with_('{#if !slot_content}{@render slot_content()}{/if}'), c)).toHaveLength(1);
    expect(await errors(with_('{#if slot_content}<i></i>{:else}{@render slot_content()}{/if}'), c)).toHaveLength(1);
    expect(await errors(with_('{#if slot_content || open}{@render slot_content()}{/if}'), c)).toHaveLength(1);
    // Tests that rule out nothing given: safe; one that lets undefined through: not.
    expect(await errors(with_('{#if slot_content != null}{@render slot_content()}{/if}'), c)).toEqual([]);
    expect(await errors(with_("{#if typeof slot_content === 'function'}{@render slot_content()}{/if}"), c)).toEqual([]);
    expect(await errors(with_('{#if !!slot_content}{@render slot_content()}{/if}'), c)).toEqual([]);
    expect(await errors(with_('{#if slot_content !== null}{@render slot_content()}{/if}'), c)).toHaveLength(1);
    expect(await errors(with_('{#if slot_content !== undefined}{@render slot_content()}{/if}'), c)).toHaveLength(1);
    // A variable as the default may hold undefined itself: no fallback.
    expect(await errors(SOURCE.replace('slot_content = undefined', 'slot_content = fallback').replace('{@render slot_content?.()}', '{@render slot_content()}').replace('</script>', '\tconst fallback = undefined;\n</script>'), c)).toHaveLength(1);
    // A default that may itself be missing is no fallback.
    expect(await errors(SOURCE.replace('slot_content = undefined', 'slot_content = open ? fallback : undefined').replace('{@render slot_content?.()}', '{@render slot_content()}'), c)).toHaveLength(1);
    // A fallback of the code's own is never missing.
    expect(await errors(SOURCE.replace('slot_content = undefined', 'slot_content = fallback').replace('{@render slot_content?.()}', '{@render slot_content()}').replace('<section', '{#snippet fallback()}<i>none</i>{/snippet}\n<section'), c)).toEqual([]);
  });

  it('follows a slot taken under another name, and says when one is not taken from $props() or never shown', async () => {
    const { s, defId } = await calculator();
    const c = contract(s, defId);
    const aliased = SOURCE.replace('slot_content = undefined', 'slot_content: body').replace('{@render slot_content?.()}', '{@render body?.()}');
    expect(await errors(aliased, c)).toEqual([]);
    expect(await errors(aliased.replace('{@render body?.()}', '{@render body()}'), c)).toEqual([expect.stringContaining('{@render body?.()}')]);
    const typo = SOURCE.replace('{@render slot_content?.()}', '{@render slot_contnet?.()}');
    expect(await checkSvelteSource(typo, { contract: c })).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('“Content” slot is never shown') }));
    expect(await errors(SOURCE.replace(', slot_content = undefined', ''), c)).toContainEqual(expect.stringContaining('slot_content must be taken from $props()'));
  });

  it('refuses code that stops showing a slot holding content, which would hide that content', async () => {
    const { s, defId } = await calculator();
    const gone = SOURCE.replace('{@render slot_content?.()}', '');
    expect(await errors(gone, contract(s, defId))).toEqual([]);
    expect(await errors(gone, contract(s, defId, { filled: ['other', 'content'] }))).toEqual([expect.stringContaining('holds content on the site')]);
    // Only tested, never rendered or handed on, the content still disappears.
    expect(await errors(SOURCE.replace('{@render slot_content?.()}', '{#if slot_content}<i></i>{/if}'), contract(s, defId, { filled: ['content'] }))).toEqual([expect.stringContaining('holds content on the site')]);
    // Handed on to a snippet of its own that renders it, the slot is still shown.
    const handed = SOURCE.replace('{@render slot_content?.()}', '{#snippet frame(inner)}<i>{@render inner?.()}</i>{/snippet}{@render frame(slot_content)}');
    expect(await errors(handed, contract(s, defId, { filled: ['content'] }))).toEqual([]);
  });

  it('names a part marked without its class, one not in the code, a marker it cannot read, and one in a spread', async () => {
    const { s, defId } = await calculator();
    const c = { slots: s.components[defId].slots, parts: { ...s.components[defId].parts, note: { nodeId: 'note', label: 'Note' } } };
    const said = async (source: string) => (await checkSvelteSource(source, { contract: c })).map((p) => `${p.severity}: ${p.message}`);
    const warnsUnhooked = (m: string[]) => m.some((x) => /^warning: Give the element marked “total” the part's class/.test(x));
    // Written as text, or naming another part, the class does not reach this one.
    expect(warnsUnhooked(await said(SOURCE.replace("class={['amount', so_o?.total]}", 'class="amount so_o.total"')))).toBe(true);
    expect(warnsUnhooked(await said(SOURCE.replace('so_o?.total', 'so_o?.note')))).toBe(true);
    expect(warnsUnhooked(await said(SOURCE))).toBe(false);
    const messages = await said(SOURCE.replace('<div class="extras">', '<div class="extras" data-so-part={which}>'));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: The “Note” part is not in the code/));
    expect(messages).toContainEqual(expect.stringMatching(/^warning: Mark a part with its name written out/));
    // A part given only its class is in the code.
    expect(await said(SOURCE.replace('<div class="extras">', '<div class={["extras", so_o?.note]}>'))).not.toContainEqual(expect.stringMatching(/“Note” part is not in the code/));
    expect(await errors(SOURCE.replace('data-so-part="total"', 'data-so-part=" total "'), c)).toEqual([expect.stringContaining('camelCase')]);
    expect(await errors(SOURCE.replace('<div class="extras">', `<div class="extras" {...{ "data-so-part": 'note' }}>`), c)).toEqual([expect.stringContaining('not in a spread')]);
    // A default so_o of its own is replaced by each placement's classes.
    expect((await checkSvelteSource(SOURCE.replace('so_o = undefined', "so_o = { total: 'amount' }"), { contract: c })).map((p) => p.message)).toContainEqual(expect.stringContaining('Give so_o no default of its own'));
    // Words that only mention a marker are not one.
    expect(await errors(SOURCE.replace('<div class="extras">', `<div class="extras" {...{ title: 'data-so-part' }}>`), c)).toEqual([]);
  });
});

describe('a code placement takes managed content in its slot', () => {
  it('passes what is placed as the slot’s snippet, and in the editor marks an empty slot only while editing', async () => {
    const { s, pageId, owner, calc } = await calculator();
    const dev = generateProject(s, { instrument: true }).get(homeFile(s, pageId))!;
    // Empty: the placeholder is given only while editing, so the code's own {:else} still shows in Preview. It names the
    // code placement it belongs to, as a managed placement's does (#652).
    expect(dev).toMatch(/\{#snippet (so_slot_empty_\d+)\(\)\}\s*<span class="so-slot-empty" data-so-editor-only="" data-so-slot-empty=\{"content"\} data-so-slot-ctx=\{"page:[^"]+"\} data-so-slot-node=\{"[^"]+"\}>[\s\S]*slot_content=\{so_editing \? \1 : undefined\}/);
    expect(dev).toContain(`data-so-slot-node={"${calc}"}`);
    const clean = generateProject(s, { instrument: false }).get(homeFile(s, pageId))!;
    expect(clean).not.toContain('slot_content');
    expect(clean).not.toContain('so-slot-empty');
    expect(clean).not.toContain('data-so-slot-');

    // A Stack placed in the slot, holding a Button.
    let next = applyOperations(s, [{ type: 'node.insert', owner, parentId: calc, slot: 'content', primitive: 'stack' }]).state;
    const stack = (next.pages[pageId].nodes[calc] as InstanceNode).slots!.content[0];
    next = applyOperations(next, [{ type: 'node.insert', owner, parentId: stack, primitive: 'button', text: 'Book a call' }]).state;
    const filled = generateProject(next, { instrument: false }).get(homeFile(next, pageId))!;
    expect(filled).toMatch(/\{#snippet slot_content\(\)\}[\s\S]*Book a call[\s\S]*\{\/snippet\}/);
    expect(filled).not.toContain('so_slot_empty');
  });

  it('names each declared part through its class in the editor’s preview only', async () => {
    const { s, pageId } = await calculator();
    const so = (file: string) => JSON.parse(file.match(/so_o=\{(\{[^}]*\})\}/)?.[1] ?? 'null') as Record<string, string> | null;
    expect(so(generateProject(s, { instrument: true }).get(homeFile(s, pageId))!)).toEqual({ total: 'so-part--total' });
    expect(so(generateProject(s, { instrument: false }).get(homeFile(s, pageId))!)).toBeNull();
  });
});

describe('a marked part of a code placement is picked and styled', () => {
  it('names the part from the preview’s descriptor and finds it again by the same descriptor', async () => {
    const t = await calculator();
    const { owner, calc } = t;
    // A part declared under another node name than its ID (as a converted design's are) is still named by its ID.
    const s = structuredClone(t.s);
    s.components[t.defId].parts.total = { nodeId: 'n_total', label: 'Total' };
    const part: ElementRef = { owner, instancePath: [calc], nodeId: 'n_total', partId: 'total' };
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

  it('goes from the placement straight to content placed in its slot, past the part around it', async () => {
    const { s, owner, pageId, calc } = await calculator();
    const next = applyOperations(s, [{ type: 'node.insert', owner, parentId: calc, slot: 'content', primitive: 'button', text: 'Book' }]).state;
    const button = (next.pages[pageId].nodes[calc] as InstanceNode).slots!.content[0];
    const placement = descOf(next, { owner, instancePath: [], nodeId: calc });
    const part = descOf(next, { owner, instancePath: [calc], nodeId: 'total', partId: 'total' });
    const chain = [descOf(next, { owner, instancePath: [], nodeId: button }), { ...part, tag: 'div' }, { ...placement, code: true }];
    const first = selectionFromChain(next, chain, null, false);
    expect(selectionFromChain(next, chain, first, false)).toEqual({ owner, instancePath: [], nodeId: button });
    // With the part itself clicked, the part is the next step.
    expect(selectionFromChain(next, [{ ...part, tag: 'output' }, { ...placement, code: true }], first, false)).toEqual({ owner, instancePath: [calc], nodeId: 'total', partId: 'total' });
  });

  it('applies the part’s phone and hover styles through the class the code places', async () => {
    const { s, owner, calc } = await calculator();
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
    expect(css).toMatch(new RegExp(`@media \\(max-width: 767\\.98px\\) \\{[^}]*\\.${cls}[^{]*\\{[^}]*color: #ff0000`));
    expect(css).toMatch(new RegExp(`@media \\(hover: hover\\)[^{]*\\{[^}]*\\.${cls}:where\\(:hover\\)[^{]*\\{[^}]*color: #00ff00`));
  });
});

describe('converting a design to code keeps its parts and slots', () => {
  it('keeps every part’s class hook and the slots, writes no marker, and the preview still names each part', async () => {
    let s: ProjectState = createStarterState('business', 'Convert', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const section = s.pages[owner.id].rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: 'Kept' }]).state;
    const def = s.components[(s.pages[owner.id].nodes[section] as InstanceNode).definitionId];
    const converted = applyOperations(s, [{ type: 'component.convertToCode', owner, nodeId: section }]);
    const code = converted.state.components[converted.results[0].definitionId as string];
    expect(code.kind).toBe('code');
    expect(code.slots).toEqual(def.slots);
    expect(Object.keys(code.parts)).toEqual(Object.keys(def.parts));
    expect((converted.state.pages[owner.id].nodes[section] as InstanceNode).slots?.content).toHaveLength(1);
    expect(code.source).toContain('{@render slot_content?.()}');
    expect(code.source).not.toContain('data-so-part');
    const inner = Object.keys(def.parts).filter((p) => p !== 'root');
    expect(inner.length).toBeGreaterThan(0);
    for (const pid of inner) expect(code.source).toContain(`so_o?.[${JSON.stringify(pid)}]`);
    const dev = generateProject(converted.state, { instrument: true }).get(homeFile(converted.state, owner.id))!;
    const so = JSON.parse(dev.match(/so_o=\{(\{[^}]*\})\}/)![1]) as Record<string, string>;
    for (const pid of inner) expect(so[pid]).toContain(`so-part--${pid}`);
  });
});

describe('the website’s build carries no part marker', () => {
  it('takes every marker out of the code, on elements and components alike, and leaves the rest as it was', async () => {
    const src = SOURCE.replace('<div class="extras">', '<div class="extras" data-so-part={"extras"}>').replace('</section>', '\t<Thing data-so-part="thing" />\n</section>');
    const clean = await withoutPartMarkers(src);
    expect(clean).not.toContain('data-so-part');
    expect(clean).toBe(SOURCE.replace(' data-so-part="total"', '').replace('</section>', '\t<Thing />\n</section>'));
    // Text that only mentions a marker is the site's own words.
    const said = '<p>Mark parts with data-so-part="name".</p>\n';
    expect(await withoutPartMarkers(said)).toBe(said);
  });

  it('keeps a byte order mark and the space between the attributes around a marker', async () => {
    expect(await withoutPartMarkers('﻿<p data-so-part="total" class="x">a</p>\n')).toBe('﻿<p class="x">a</p>\n');
    expect(await withoutPartMarkers('<p data-so-part="total"class="x">a</p>\n')).toBe('<p class="x">a</p>\n');
  });

  it('finds a marker left in a built page or script, never words that only mention one', async () => {
    expect(carriesPartMarker('<output class="amount" data-so-part="total">10</output>')).toBe(true);
    expect(carriesPartMarker('const t = $.from_html(`<div data-so-part="extras"><b></b></div>`);')).toBe(true);
    expect(carriesPartMarker('<div title="Example data-so-part=total">x</div>')).toBe(false);
    expect(carriesPartMarker('<p>Mark a part with data-so-part="total".</p>')).toBe(false);
  });
});
