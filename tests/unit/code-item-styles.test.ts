/**
 * One item's parts styled on their own in a code component (#1075): the code says which list a part repeats over by
 * giving it that item's class (`so_oi?.[plan.id]?.card` inside `{#each plans as plan (plan.id)}`), saving it declares
 * that list on the part, the editor picks and styles one card through the preview's item classes, the style follows
 * its card when the list is reordered, and a theme switch keeps it while the new implementation repeats the same part.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { afterAll, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ElementRef, InstanceNode, ListItem, ProjectState } from '@shared/types';
import { itemOverrideClass, repeatedPartList } from '@shared/item-styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { contractConflicts } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { authorityFor, checkAuthority } from '@agent/scope';
import { generateProject } from '@generator/index';
import { checkSvelteSource, codeContractNames } from '../../src/main/codecheck';
import { descOf, isCodePart, itemStep, refExists, selectionFromChain } from '../../src/renderer/src/lib/model';
import { chainOf } from '../../src/renderer/src/lib/payload';

const SOURCE = `<script>
\tlet { heading = 'Plans', plans = [], class: className = '', so_o = undefined, so_oi = undefined } = $props();
</script>

<section class={className}>
\t<h2>{heading}</h2>
\t<ul>
\t\t{#each plans as plan (plan.id)}
\t\t\t<li class={['plan', so_o?.card, so_oi?.[plan.id]?.card]}>
\t\t\t\t<h3 class={so_o?.name}>{plan.name}</h3>
\t\t\t</li>
\t\t{/each}
\t</ul>
</section>
`;

const PLANS: ListItem[] = [
  { id: 'p_basic', name: 'Basic' },
  { id: 'p_plus', name: 'Plus' },
  { id: 'p_pro', name: 'Pro' }
];
const PROPERTIES = {
  heading: { type: 'string', label: 'Heading', default: 'Plans' },
  plans: { type: 'list', label: 'Plans', itemLabel: 'Plan', titleField: 'name', fields: { name: { type: 'string', label: 'Name', default: '' } }, default: PLANS }
};

const homeFile = 'src/routes/+page.svelte';
const siteCss = (s: ProjectState) => generateProject(s, { instrument: false }).get('src/lib/siteorigin/styles/site.css')!;
const page = (s: ProjectState, instrument = false) => generateProject(s, { instrument }).get(homeFile)!;
const soOi = (file: string) => JSON.parse(file.match(/so_oi=\{(\{.*?\}\})\}/)?.[1] ?? 'null') as Record<string, Record<string, string>> | null;

/** A page with a placed code component showing three plan cards, declared as saving its code declares it. */
async function pricing(source = SOURCE) {
  let s: ProjectState = createStarterState('business', 'Code Items', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  const names = (await codeContractNames(source))!;
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Price list', source, properties: PROPERTIES } as EditOperation], { codeNames: () => names });
  const defId = made.results[0].definitionId as string;
  s = made.state;
  const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId } as EditOperation]);
  const list = placed.results[0].nodeId as string;
  // The placement's own cards, under IDs the tests can name.
  const state = applyOperations(placed.state, [{ type: 'instance.setProp', owner, nodeId: list, prop: 'plans', value: structuredClone(PLANS) } as EditOperation]).state;
  return { s: state, owner, defId, list };
}

const node = (s: ProjectState, id: string) => s.pages[s.site.homePageId].nodes[id] as InstanceNode;
const styleItem = (s: ProjectState, owner: { kind: 'page'; id: string }, list: string, itemId: string | undefined, value: string, partId = 'card') =>
  applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: list, partId, ...(itemId ? { itemId } : {}), scope: 'base', property: 'background', value } as EditOperation]).state;

describe('a code component declares the list a part repeats over', () => {
  it('reads it from the item class its code gives the part, keyed by the item it repeats', async () => {
    expect((await codeContractNames(SOURCE))!.lists).toEqual({ card: 'plans' });
    const { s, defId } = await pricing();
    const def = s.components[defId];
    expect(def.parts.card).toEqual({ nodeId: 'card', label: 'Card', list: 'plans' });
    expect(def.parts.name).toEqual({ nodeId: 'name', label: 'Name' });
    expect(repeatedPartList(def, 'card')).toBe('plans');
    expect(repeatedPartList(def, 'name')).toBeUndefined();
    expect(validateState(s).filter((i) => i.code === 'PART_LIST')).toEqual([]);
    expect(await checkSvelteSource(SOURCE, { contract: { parts: def.parts, slots: def.slots } })).toEqual([]);
  });

  it('follows aliases and a fallback list, and names none where one class could land on several elements', async () => {
    const lists = async (src: string) => (await codeContractNames(src))!.lists;
    // Taken under another name, with a fallback, and a part named in brackets.
    expect(await lists(SOURCE.replace('plans = []', 'plans: rows').replace('{#each plans as plan (plan.id)}', '{#each rows ?? [] as plan (plan.id)}').replace('so_oi?.[plan.id]?.card', 'so_oi?.[plan.id]?.["card"]'))).toEqual({ card: 'plans' });
    // Not keyed by the item, an index for an ID, outside any list, in a list the code worked out, or inside another list.
    expect(await lists(SOURCE.replace('{#each plans as plan', '{#each plans || [] as plan'))).toEqual({ card: 'plans' });
    // A hook anywhere but a class gives no element its class: it neither names a list nor takes one away.
    expect(await lists(SOURCE.replace('<h3 class={so_o?.name}>', '<h3 class={so_o?.name} title={so_oi?.[plan.id]?.card}>'))).toEqual({ card: 'plans' });
    // Read plainly, inside a snippet (which can be given any list), in a list inside the card, or under a name declared again.
    expect(await lists(SOURCE.replace('so_oi?.[plan.id]?.card', 'so_oi[plan.id].card'))).toEqual({});
    expect(await lists(SOURCE.replace('<ul>', '{#snippet cards(plans)}<ul>').replace('</ul>', '</ul>{/snippet}{@render cards(addons)}'))).toEqual({});
    expect(await lists(SOURCE.replace(', so_oi?.[plan.id]?.card', '').replace("<h3 class={so_o?.name}>{plan.name}</h3>", "{#each [1, 2] as n}<i class={[so_o?.card, so_oi?.[plan.id]?.card]}>{n}</i>{/each}"))).toEqual({});
    expect(await lists(SOURCE.replace("<li class=", "{@const plan = plans[0]}<li class="))).toEqual({});
    expect(await lists(SOURCE.replace("<li class=", "{@const so_oi = {}}<li class="))).toEqual({});
    // The list's name declared again inside the loop reads nothing the loop repeats over.
    expect(await lists(SOURCE.replace("<li class=", "{@const plans = plan.name}<li class="))).toEqual({ card: 'plans' });
    // Content given to a component renders wherever, and as often as, that component renders it.
    expect(await lists(SOURCE.replace('<li class=', '<Wrap><li class=').replace('</li>', '</li></Wrap>').replace('</script>', "\timport Wrap from './Wrap.svelte';\n</script>"))).toEqual({});
    // An so_oi of the code's own is not the placement's.
    expect(await lists(SOURCE.replace(', so_oi = undefined', '').replace('</script>', '\tconst so_oi = {};\n</script>'))).toEqual({});
    expect(await lists(SOURCE.replace('(plan.id)', ''))).toEqual({});
    expect(await lists(SOURCE.replace('{#each plans as plan (plan.id)}', '{#each plans as plan, i (plan.id)}').replace('so_oi?.[plan.id]', 'so_oi?.[i]'))).toEqual({});
    expect(await lists(SOURCE.replace("<h2>{heading}</h2>", "<h2 class={so_oi?.[heading.id]?.title}>{heading}</h2>"))).toEqual({ card: 'plans' });
    expect(await lists(SOURCE.replace('{#each plans as plan', '{#each plans.slice(1) as plan'))).toEqual({});
    expect(await lists(SOURCE.replace('{#each plans as plan (plan.id)}', '{#each [1, 2] as row}{#each plans as plan (plan.id)}').replace('{/each}', '{/each}{/each}'))).toEqual({});
    // One part given item classes from two lists names neither: an item ID is unique only within its list.
    const two = SOURCE.replace('plans = []', 'plans = [], addons = []').replace('</ul>', '</ul>\n\t{#each addons as addon (addon.id)}<p class={so_oi?.[addon.id]?.card}>{addon.name}</p>{/each}');
    expect(await lists(two)).toEqual({});
    const problems = await checkSvelteSource(two, { contract: { parts: { root: { nodeId: 'root', label: 'Root' }, card: { nodeId: 'card', label: 'Card' } } } });
    expect(problems.map((p) => p.message).join(' ')).toMatch(/more than one list/);
    const contract = { parts: { root: { nodeId: 'root', label: 'Root' }, card: { nodeId: 'card', label: 'Card' }, name: { nodeId: 'name', label: 'Name' } } };
    const readErrors = async (src: string) => (await checkSvelteSource(src, { contract })).filter((p) => p.severity === 'error').map((p) => p.message);
    // A read that fails for a card styled with the rest, wherever it is and however it is written, is refused.
    for (const bad of ['so_oi[plan.id].card', '(so_oi?.[plan.id]).card', 'so_oi?.[plan.id].card']) expect(await readErrors(SOURCE.replace('so_oi?.[plan.id]?.card', bad))).toEqual([expect.stringMatching(/optional at every step/)]);
    expect(await readErrors(SOURCE.replace('<h3 class={so_o?.name}>', '<h3 class={so_o?.name} title={so_oi[plan.id].card}>'))).toHaveLength(1);
    // The code's own so_oi is its own to read.
    expect(await readErrors(SOURCE.replace(', so_oi = undefined', '').replace('so_oi?.[plan.id]?.card', 'so_oi[plan.id].card').replace('</script>', "\tconst so_oi = { p_basic: { card: 'x' } };\n</script>"))).toEqual([]);
    const itemOnly = await checkSvelteSource(SOURCE.replace("so_o?.card, ", ''), { contract: { parts: { root: { nodeId: 'root', label: 'Root' }, card: { nodeId: 'card', label: 'Card' }, name: { nodeId: 'name', label: 'Name' } } } });
    expect(itemOnly.map((p) => p.message).join(' ')).toMatch(/shared class too/);
    const unkeyed = await checkSvelteSource(SOURCE.replace('(plan.id)', ''), { contract: { parts: { root: { nodeId: 'root', label: 'Root' }, card: { nodeId: 'card', label: 'Card' }, name: { nodeId: 'name', label: 'Name' } } } });
    expect(unkeyed.map((p) => p.message).join(' ')).toMatch(/keyed by the item's ID/);
  });

  it('takes the list back when the code stops repeating the part over it, and keeps a label edit’s list', async () => {
    const { s, defId } = await pricing();
    const relabelled = applyOperations(s, [{ type: 'component.setPart', definitionId: defId, partId: 'card', nodeId: 'card', label: 'Plan card' } as EditOperation]).state;
    expect(relabelled.components[defId].parts.card).toEqual({ nodeId: 'card', label: 'Plan card', list: 'plans' });
    const plain = SOURCE.replace(', so_oi?.[plan.id]?.card', '');
    const names = (await codeContractNames(plain))!;
    const saved = applyOperations(relabelled, [{ type: 'component.updateSource', definitionId: defId, source: plain }], { codeNames: () => names }).state;
    expect(saved.components[defId].parts.card).toEqual({ nodeId: 'card', label: 'Plan card' });
    // Repeated over another of its lists, the part says so.
    const both = { ...PROPERTIES, tiers: { ...PROPERTIES.plans, label: 'Tiers' } };
    const tiers = SOURCE.replace(/plans/g, 'tiers');
    const tierNames = (await codeContractNames(tiers))!;
    const switched = applyOperations(relabelled, [{ type: 'component.updateSource', definitionId: defId, source: tiers, properties: both } as EditOperation], { codeNames: () => tierNames });
    expect(switched.state.components[defId].parts.card).toEqual({ nodeId: 'card', label: 'Plan card', list: 'tiers' });
    // A list the component has no such property for is never declared.
    const other = (await codeContractNames(SOURCE.replace(/plans/g, 'tiers')))!;
    expect(other.lists).toEqual({ card: 'tiers' });
    const unknown = applyOperations(relabelled, [{ type: 'component.updateSource', definitionId: defId, source: SOURCE.replace(/plans/g, 'tiers') }], { codeNames: () => other }).state;
    expect(unknown.components[defId].parts.card.list).toBeUndefined();
  });

  it('warns about a declared list that is not one of the component’s own lists', async () => {
    const { s, defId } = await pricing();
    const bad = structuredClone(s);
    bad.components[defId].parts.card.list = 'heading';
    bad.components[defId].parts.root.list = 'plans';
    const issues = validateState(bad).filter((i) => i.code === 'PART_LIST');
    expect(issues.map((i) => [i.severity, i.message])).toEqual([
      ['warning', expect.stringContaining('part "root": the root part is the whole component')],
      ['warning', expect.stringContaining('part "card": it repeats over "heading", which is not a list')]
    ]);
    expect(repeatedPartList(bad.components[defId], 'card')).toBeUndefined();
    expect(repeatedPartList(bad.components[defId], 'root')).toBeUndefined();
  });
});

describe('one card of a code component is styled on its own', () => {
  it('gives that card’s class to it alone, one class stronger than the shared style', async () => {
    const { s: base, owner, list } = await pricing();
    let s = styleItem(base, owner, list, undefined, '#fff5cc');
    s = styleItem(s, owner, list, 'p_plus', '#dbeeff');
    expect(node(s, list).itemOverrides).toEqual({ card: { list: 'plans', items: { p_plus: { base: { background: '#dbeeff' } } } } });
    const cls = itemOverrideClass(list, 'card', 'p_plus');
    expect(soOi(page(s))).toEqual({ p_plus: { card: cls } });
    const css = siteCss(s);
    // Four classes against the shared override's three, so the card's own value wins whatever order rules load in.
    expect(css).toMatch(new RegExp(`\\.${cls}\\.${cls}\\.${cls}\\.${cls}\\s*\\{[^}]*background:\\s*#dbeeff`));
    expect(css).not.toMatch(new RegExp(`(?<!\\.${cls})\\.${cls}\\.${cls}\\.${cls}\\s*\\{`));
    // The other cards take no class of their own.
    expect(css.match(/so-oi-[0-9a-f]+/g)?.every((c) => c === cls)).toBe(true);
  });

  it('keeps the style on the same card when the list is reordered, and renders it there', async () => {
    const { s: base, owner, list } = await pricing();
    let s = styleItem(base, owner, list, 'p_plus', '#dbeeff');
    s = applyOperations(s, [{ type: 'instance.listMove', owner, nodeId: list, prop: 'plans', itemId: 'p_plus', index: 0 } as EditOperation]).state;
    expect((node(s, list).props.plans as ListItem[]).map((p) => p.id)).toEqual(['p_plus', 'p_basic', 'p_pro']);
    expect(node(s, list).itemOverrides?.card.items).toEqual({ p_plus: { base: { background: '#dbeeff' } } });
    const so_oi = soOi(page(s))!;
    expect(so_oi).toEqual({ p_plus: { card: itemOverrideClass(list, 'card', 'p_plus') } });
    // Rendered as the website renders it: the class is on the card now first, and on no other.
    const cards = await renderCards(SOURCE, { plans: node(s, list).props.plans, so_oi });
    expect(cards).toEqual([
      { name: 'Plus', styled: true },
      { name: 'Basic', styled: false },
      { name: 'Pro', styled: false }
    ]);
  });

  it('styles a card shown from the component’s defaults, resets it, and refuses one the list does not have', async () => {
    const { s: placed, owner, list } = await pricing();
    const base = structuredClone(placed);
    delete node(base, list).props.plans;
    const s = styleItem(base, owner, list, 'p_pro', '#dbeeff');
    expect(Object.keys(node(s, list).itemOverrides!.card.items)).toEqual(['p_pro']);
    const reset = applyOperations(s, [{ type: 'node.resetStyles', owner, nodeId: list, partId: 'card', itemId: 'p_pro' } as EditOperation]).state;
    expect(node(reset, list).itemOverrides).toBeUndefined();
    expect(() => styleItem(base, owner, list, 'p_gone', '#000')).toThrow(EngineError);
    // A part the code shows once for every card together is styled for all of them.
    expect(() => styleItem(base, owner, list, 'p_pro', '#000', 'name')).toThrow(/not shown once per list item/);
  });
});

describe('the canvas picks one card of a code component', () => {
  it('marks every card in the preview only, and names the clicked card from its class', async () => {
    const { s, owner, list } = await pricing();
    const preview = page(s, true);
    const marks = Object.fromEntries(PLANS.map((p) => [p.id, { card: itemOverrideClass(list, 'card', p.id) }]));
    expect(soOi(preview)).toEqual(marks);
    const lookup = JSON.parse(JSON.parse(preview.match(/data-so-part-items=\{("(?:[^"\\]|\\.)*")\}/)![1])) as Record<string, [string, string]>;
    expect(lookup).toEqual(Object.fromEntries(PLANS.map((p) => [itemOverrideClass(list, 'card', p.id), ['card', p.id]])));
    // The website's build carries none of it.
    expect(soOi(page(s))).toBeNull();
    expect(page(s)).not.toContain('data-so-part-items');

    const card: ElementRef = { owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['p_plus'] };
    expect(isCodePart(s, card)).toBe(true);
    expect(refExists(s, card)).toBe(true);
    const desc = descOf(s, card);
    expect(desc).toEqual({ ctx: `page:${owner.id}`, node: list, items: '', part: 'card', partItem: 'p_plus' });
    const placement = descOf(s, { owner, instancePath: [], nodeId: list });
    // As the editor reads the page's message: the card's item comes through.
    const chain = chainOf([{ ...desc, tag: 'li' }, { ...placement, code: true }]);
    expect(chain[0].partItem).toBe('p_plus');
    const first = selectionFromChain(s, chain, null, false);
    expect(selectionFromChain(s, chain, first, false)).toEqual(card);
    // Previous and Next step through the cards.
    const step = itemStep(s, card)!;
    expect(step.n).toBe(2);
    expect(step.parts.map((p) => p?.itemPath)).toEqual([['p_basic'], ['p_plus'], ['p_pro']]);
  });

  it('names no single item for a part shown for every card, or a card the list no longer has', async () => {
    const { s, owner, list } = await pricing();
    const name: ElementRef = { owner, instancePath: [list], nodeId: 'name', partId: 'name', itemPath: ['p_plus'] };
    expect(isCodePart(s, name)).toBe(false);
    expect(refExists(s, name)).toBe(false);
    const gone = applyOperations(s, [{ type: 'instance.listRemove', owner, nodeId: list, prop: 'plans', itemId: 'p_plus' } as EditOperation]).state;
    const card: ElementRef = { owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['p_plus'] };
    expect(refExists(gone, card)).toBe(false);
    expect(isCodePart(gone, { ...card, itemPath: ['p_basic'] })).toBe(true);
    const placement = descOf(gone, { owner, instancePath: [], nodeId: list });
    const chain = [{ ...descOf(s, card), tag: 'li' }, { ...placement, code: true }];
    const first = selectionFromChain(gone, chain, null, false);
    // A stale card selects the placement, never every card's shared style.
    expect(selectionFromChain(gone, chain, first, false)).toEqual(first);
  });

  it('keeps the assistant on the selected card', async () => {
    const { s, owner, list } = await pricing();
    const authority = authorityFor({ owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['p_plus'] }, 'the Plus card', null, s);
    const op = (itemId?: string) => ({ type: 'node.setStyle', owner, nodeId: list, partId: 'card', ...(itemId ? { itemId } : {}), scope: 'base', property: 'background', value: '#000' }) as EditOperation;
    expect(checkAuthority(s, [op('p_plus')], authority)).toBeNull();
    expect(checkAuthority(s, [op()], authority)).toMatch(/every item/);
    expect(checkAuthority(s, [op('p_basic')], authority)).toMatch(/another item/);
  });
});

describe('one card’s style stays with its card and its list', () => {
  it('follows its list when the code’s properties rename it', async () => {
    const { s: base, owner, list, defId } = await pricing();
    const s = styleItem(base, owner, list, 'p_plus', '#dbeeff');
    const tiers = SOURCE.replace(/plans/g, 'tiers');
    const names = (await codeContractNames(tiers))!;
    const { plans, ...rest } = PROPERTIES;
    const renamed = applyOperations(s, [{ type: 'component.updateSource', definitionId: defId, source: tiers, properties: { ...rest, tiers: plans }, renames: [{ from: 'plans', to: 'tiers' }] } as EditOperation], { codeNames: () => names }).state;
    expect(renamed.components[defId].parts.card.list).toBe('tiers');
    expect(node(renamed, list).itemOverrides).toEqual({ card: { list: 'tiers', items: { p_plus: { base: { background: '#dbeeff' } } } } });
    expect(soOi(page(renamed))).toEqual({ p_plus: { card: itemOverrideClass(list, 'card', 'p_plus') } });
  });

  it('keeps its list when the part is pointed at another name, and refuses one card of a list a collection fills', async () => {
    const { s, owner, list, defId } = await pricing();
    const moved = applyOperations(s, [{ type: 'component.setPart', definitionId: defId, partId: 'card', nodeId: 'row', label: 'Card' } as EditOperation]).state;
    expect(moved.components[defId].parts.card.list).toBe('plans');
    const connected = structuredClone(s);
    node(connected, list).listSources = { plans: { collectionId: 'nope' } } as unknown as InstanceNode['listSources'];
    expect(() => styleItem(connected, owner, list, 'p_plus', '#000')).toThrow(/collection's entries/);
    const card: ElementRef = { owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['p_plus'] };
    expect(isCodePart(connected, card)).toBe(false);
  });

  it('names an item with a comma or a percent sign, and finds it again', async () => {
    const { s: base, owner, list } = await pricing();
    const s = applyOperations(base, [{ type: 'instance.setProp', owner, nodeId: list, prop: 'plans', value: [{ id: 'a,b%c,%', name: 'Odd' }, { id: 'p_pro', name: 'Pro' }] } as EditOperation]).state;
    const card: ElementRef = { owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['a,b%c,%'] };
    const desc = descOf(s, card);
    expect(desc.partItem).toBe('a%2Cb%25c%2C%25');
    const placement = descOf(s, { owner, instancePath: [], nodeId: list });
    const chain = [{ ...desc, tag: 'li' }, { ...placement, code: true }];
    const first = selectionFromChain(s, chain, null, false);
    expect(first).toEqual({ owner, instancePath: [], nodeId: list });
    expect(selectionFromChain(s, chain, first, false)).toEqual(card);
  });

  it('keeps the assistant on the selected card once its code stops repeating it, and for a reset too', async () => {
    const { s, owner, list, defId } = await pricing();
    const authority = authorityFor({ owner, instancePath: [list], nodeId: 'card', partId: 'card', itemPath: ['p_plus'] }, 'the Plus card', null, s);
    const reset = (itemId?: string) => ({ type: 'node.resetStyles', owner, nodeId: list, partId: 'card', ...(itemId ? { itemId } : {}) }) as EditOperation;
    expect(checkAuthority(s, [reset('p_plus')], authority)).toBeNull();
    expect(checkAuthority(s, [reset()], authority)).toMatch(/every item/);
    const flat = structuredClone(s);
    delete flat.components[defId].parts.card.list;
    expect(checkAuthority(flat, [{ type: 'node.setStyle', owner, nodeId: list, partId: 'card', scope: 'base', property: 'background', value: '#000' } as EditOperation], authority)).toMatch(/ask the user/);
  });

  it('reports a list declared by something other than a name, without failing', async () => {
    const { s, defId } = await pricing();
    const bad = structuredClone(s);
    (bad.components[defId].parts.card as { list?: unknown }).list = { toString: 'plans' };
    expect(validateState(bad).filter((i) => i.code === 'PART_LIST').map((i) => i.message)).toEqual([expect.stringContaining('not named by a property name')]);
  });
});

describe('a theme switch keeps one card’s style', () => {
  it('while the new implementation repeats the same part over the same list', async () => {
    const { s: base, owner, list, defId } = await pricing();
    const s = styleItem(base, owner, list, 'p_plus', '#dbeeff');
    const def = s.components[defId];
    expect(contractConflicts(s, def, def)).toEqual([]);
    // A managed implementation of the same contract: the card in a repeat over the plans.
    const managed: ComponentDefinition = {
      ...structuredClone(def),
      kind: 'managed',
      source: undefined,
      sourcePath: undefined,
      parts: { root: { nodeId: 'root', label: 'Root' }, card: { nodeId: 'n_card', label: 'Card' }, name: { nodeId: 'n_name', label: 'Name' } },
      tree: {
        rootIds: ['root'],
        nodes: {
          root: { id: 'root', kind: 'element', tag: 'section', children: ['n_rep'] },
          n_rep: { id: 'n_rep', kind: 'repeat', list: { $prop: 'plans' }, children: ['n_card'] },
          n_card: { id: 'n_card', kind: 'element', tag: 'li', children: ['n_name'] },
          n_name: { id: 'n_name', kind: 'text', tag: 'h3', text: { $item: 'name' } }
        }
      } as unknown as ComponentDefinition['tree']
    };
    expect(repeatedPartList(managed, 'card')).toBe('plans');
    expect(contractConflicts(s, def, managed)).toEqual([]);
    // And back: code that repeats the card over the plans keeps a managed card's style; code that does not loses it.
    expect(contractConflicts(s, managed, def)).toEqual([]);
    const flat = structuredClone(def);
    delete flat.parts.card.list;
    expect(contractConflicts(s, def, flat).join(' ')).toMatch(/single item of its "card" part/);
  });
});

mkdirSync(resolve('.tmp'), { recursive: true });
const tmp = mkdtempSync(join(resolve('.tmp'), 'code-items-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The cards a code component's source renders on the server with these props, in order, and whether each took the item class. */
async function renderCards(source: string, props: Record<string, unknown>): Promise<Array<{ name: string; styled: boolean }>> {
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, `c${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, compile(source, { generate: 'server', filename: 'Price.svelte' }).js.code);
  const { render } = await import('svelte/server');
  const component = (await import(pathToFileURL(file).href)).default;
  const body = render(component, { props }).body;
  return [...body.matchAll(/<li class="([^"]*)"[^>]*>\s*<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => ({ name: m[2], styled: /\bso-oi-/.test(m[1]) }));
}
