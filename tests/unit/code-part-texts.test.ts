/**
 * The text a code component's part shows (#1416): read from its code, a selection of the part may change the text the
 * code marks inside it, and nothing the code shows elsewhere.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, sourceHash } from '@engine/apply';
import { authorityFor, checkAuthority, type Authority } from '@agent/scope';
import { selectionTools } from '@agent/selection';
import { codeContractNames, codePartTexts } from '../../src/main/codecheck';

const script = (props: string, imports = '') => `<script>\n${imports}\tlet { ${props}, so_text, so_o = undefined, so_oi = undefined, class: className = '' } = $props();\n</script>\n`;
const HAS = `\timport { has } from '../runtime/util.js';\n`;

/** The paths each part's code shows, by part. */
async function paths(source: string): Promise<Record<string, string[]> | null> {
  const texts = await codePartTexts(source);
  return texts && Object.fromEntries(Object.entries(texts).map(([part, t]) => [part, t.paths]));
}

describe('the text the code marks in each part', () => {
  it('reads the text marked on a part, inside it, and through an {#if} that shows only the part', async () => {
    expect(
      await paths(`${script(`heading = '', label = '', note = ''`)}
<section class={className}>
\t{#if heading}<h2 data-so-text={so_text?.('heading')} class={so_o?.heading}>{heading}</h2>{/if}
\t<div class={['actions', so_o?.actions]}>
\t\t{#if label}<a href="/" data-so-text={so_text?.('label')}>{label}</a>{/if}
\t</div>
\t<p data-so-part="note"><span data-so-text={so_text?.('note')}>{note}</span></p>
</section>
`)
    ).toMatchObject({ heading: ['heading'], actions: ['label'], note: ['note'] });
  });

  it('reads a text under an aliased hook', async () => {
    expect(await paths(`<script>let { heading = '', so_text: mark, so_o } = $props();</script>\n<h2 class={so_o?.heading} data-so-text={mark?.('heading')}>{heading}</h2>\n`)).toEqual({ heading: ['heading'] });
  });

  it('leaves out text the markup also shows or reads outside the part', async () => {
    expect(
      await paths(`${script(`heading = '', label = '', tagline = '', note = ''`)}
<section class={className} aria-label={tagline}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t<p>{heading}</p>
\t{#if label}
\t\t<div class={so_o?.actions}><a href="/" data-so-text={so_text?.('label')}>{label}</a></div>
\t\t<p>Shown with the label</p>
\t{/if}
\t<div class={so_o?.tag}><span data-so-text={so_text?.('tagline')}>{tagline}</span></div>
\t{#if note}<p class={so_o?.note} data-so-text={so_text?.('note')}>{note}</p>{:else}<p>No note</p>{/if}
</section>
`)
    ).toMatchObject({ heading: [], actions: [], tag: [], note: [] });
  });

  it('leaves out text marked a second time outside the part, and text in a snippet the part defines', async () => {
    expect(
      await paths(`${script(`heading = '', label = ''`)}
<section class={className}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t<p data-so-text={so_text?.('heading')}>Fixed words</p>
\t<div class={so_o?.actions}>
\t\t{#snippet button()}<a href="/" data-so-text={so_text?.('label')}>{label}</a>{/snippet}
\t\t{@render button()}
\t</div>
</section>
`)
    ).toMatchObject({ heading: [], actions: [] });
  });

  it('reads a list field marked on its own item in a part repeated over the list, and no other', async () => {
    expect(
      await paths(`${script(`plans = []`)}
<ul class={className}>
\t{#each plans as plan, i (plan.id)}
\t\t<li class={[so_o?.card, so_oi?.[plan.id]?.card]}>
\t\t\t<h3 data-so-text={so_text?.('plans.name', plan.id)}>{plan.name}</h3>
\t\t\t<em data-so-text={so_text?.('plans.badge', 'p_pro')}>Best value</em>
\t\t\t{#each plan.notes as note (note.id)}<p data-so-text={so_text?.('plans.note', note.id)}>{note.text}</p>{/each}
\t\t</li>
\t{/each}
</ul>
`)
    ).toMatchObject({ card: ['plans.name'] });
    // Another item read in a card shows its text in that card: no field of the list is one card's then.
    expect(
      await paths(`${script(`plans = []`)}
{#each plans as plan, i (plan.id)}
\t<li class={[so_o?.card, so_oi?.[plan.id]?.card]}>
\t\t<h3 data-so-text={so_text?.('plans.name', plan.id)}>{plan.name}</h3>
\t\t<em>{plans[1 - i].name}</em>
\t</li>
{/each}
`)
    ).toMatchObject({ card: [] });
  });

  it('leaves out a list field the markup shows outside the part too, by any name for its item', async () => {
    expect(
      await paths(`${script(`items = [], extras = []`)}
{#each items as row (row.id)}
\t<h3 class={so_o?.title} data-so-text={so_text?.('items.title', row.id)}>{row.title}</h3>
\t<p class={so_o?.text} data-so-text={so_text?.('items.text', row.id)}>{row.text}</p>
\t<p class={so_o?.note} data-so-text={so_text?.('items.note', row.id)}>{row.note}</p>
\t<p>{row.title}</p>
\t{#each extras as row (row.id)}<i>{row.id}</i>{:else}<em>{row.note}</em>{/each}
{/each}
{#each items as { text }}<small>{text}</small>{/each}
`)
    ).toMatchObject({ title: [], text: [], note: [] });
  });

  it('lets whether a list has items decide an {#if} elsewhere, which no change to an item’s field changes', async () => {
    expect(
      await paths(`${script(`items = []`, HAS)}{#if has(items)}<h2>Our services</h2><ul class={so_o?.grid}>{#each items as row (row.id)}<li data-so-text={so_text?.('items.title', row.id)}>{row.title}</li>{/each}</ul>{/if}\n`)
    ).toMatchObject({ grid: ['items.title'] });
  });

  it('leaves out a list field repeated over a list the script works out from it', async () => {
    expect(
      await paths(`${script(`items = []`)}{#each items.toReversed() as row (row.id)}<b class={so_o?.card} data-so-text={so_text?.('items.title', row.id)}>{row.title}</b><p>{row.title}</p>{/each}
`)
    ).toMatchObject({ card: [] });
  });

  it('leaves out text the script or a {@const} works out something shown elsewhere from, or that a tag or directive reads', async () => {
    expect(
      await paths(`<script>
\timport Contact from './Contact.svelte';
\timport About from './About.svelte';
\tlet { label = '', title = '', color = '', page = '', so_text, so_o = undefined } = $props();
\tconst shout = $derived(title.toUpperCase());
\tconst View = $derived(page === 'contact' ? Contact : About);
</script>
<h2 class={so_o?.heading}><span data-so-text={so_text?.('title')}>{title}</span></h2>
<footer>{shout}</footer>
<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>
{@const loud = label + '!'}<b>{loud}</b>
<p class={so_o?.color} data-so-text={so_text?.('color')}>{color}</p>
<i style:color>Outside</i>
<p class={so_o?.page} data-so-text={so_text?.('page')}>{page}</p>
<View />
`)
    ).toMatchObject({ heading: [], label: [], color: [], page: [] });
  });

  it('leaves out text a default value or a second name for the property shows elsewhere', async () => {
    expect(
      await paths(`<script>
\tlet { label = '', label: other, note = '', so_text, so_o = undefined } = $props();
</script>
<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>
<p>{other}</p>
<p class={so_o?.note} data-so-text={so_text?.('note')}>{note}</p>
{#each [{}] as { caption = note }}<p>{caption}</p>{/each}
`)
    ).toMatchObject({ label: [], note: [] });
  });

  it('lets whether a text is there decide an {#if} elsewhere, so long as a change keeps it there', async () => {
    const texts = await codePartTexts(`<script>
${HAS}\timport SoLink from '../runtime/Link.svelte';
\tlet { label = '', title = '', so_text, so_o = undefined } = $props();
\tconst hasActions = $derived(has(label));
</script>
{#if hasActions}
\t<div class={so_o?.actions}><SoLink data-so-text={so_text?.('label')}>{label}</SoLink></div>
\t<p>More</p>
{/if}
{#if has(title)}<h2 class={so_o?.heading}><span data-so-text={so_text?.('title')}>{title}</span></h2>{/if}
`);
    expect(texts).toMatchObject({ actions: { paths: ['label'], keep: ['label'] }, heading: { paths: ['title'], keep: [] } });
    // The same helpers named through #lib (#1479).
    const viaLib = await codePartTexts(`<script>
\timport { has } from '#lib/siteorigin/runtime/util.js';
\timport SoLink from '#lib/siteorigin/runtime/Link.svelte';
\tlet { label = '', so_text, so_o = undefined } = $props();
\tconst hasActions = $derived(has(label));
</script>
{#if hasActions}
\t<div class={so_o?.actions}><SoLink data-so-text={so_text?.('label')}>{label}</SoLink></div>
\t<p>More</p>
{/if}
`);
    expect(viaLib).toMatchObject({ actions: { paths: ['label'], keep: ['label'] } });
    // A `has` the code names again for something else says nothing of presence.
    expect(
      await paths(`<script>
${HAS}\tlet { label = '', so_text, so_o = undefined } = $props();
</script>
<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>
{#if true}{@const has = (x) => x === 'Open'}{#if has(label)}<p>Open now</p>{/if}{/if}
`)
    ).toMatchObject({ label: [] });
    expect(
      await paths(`<script>
${HAS}	let { label = '', check, so_text, so_o = undefined } = $props();
</script>
<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>
{#await check then has}{#if has(label)}<p>Open now</p>{/if}{/await}
`)
    ).toMatchObject({ label: [] });
  });

  it('takes the part an element is only where it is certain: its written-out marker, else its one part class', async () => {
    expect(
      await paths(`${script(`label = '', note = '', tip = '', hint = '', flip = false, kind = '', extra = ''`)}
<div>
\t<a href="/" class={so_o?.actions} data-so-text={so_text?.('label')}>{label}</a>
\t<p data-so-part="caption" class={so_o?.actions} data-so-text={so_text?.('note')}>{note}</p>
\t<b class={flip ? so_o?.tip : so_o?.actions} data-so-text={so_text?.('tip')}>{tip}</b>
\t<i class={[so_o?.actions, so_o?.hint]} data-so-text={so_text?.('hint')}>{hint}</i>
\t<u class={{ wrapper: so_o?.actions }} data-so-text={so_text?.('flip')}>x</u>
\t<s class={[so_o?.actions, so_o?.[kind]]} data-so-text={so_text?.('kind')}>{kind}</s>
\t<em data-so-part="actions" {...{ title: 'More' }} data-so-text={so_text?.('extra')}>{extra}</em>
</div>
`)
    ).toEqual({ actions: ['label'], caption: ['note'] });
  });

  it('gives a part nothing that a component other than the Builder’s own link and rich text shows', async () => {
    expect(
      await paths(`<script>
\timport Split from './Split.svelte';
\timport SoAction from '../runtime/Action.svelte';
\tlet { label = '', note = '', tip = '', so_text, so_o = undefined } = $props();
</script>
<Split class={so_o?.actions}><span data-so-text={so_text?.('label')}>{label}</span></Split>
<div class={so_o?.panel}><Split><span data-so-text={so_text?.('note')}>{note}</span></Split></div>
<SoAction class={so_o?.tip}><span data-so-text={so_text?.('tip')}>{tip}</span></SoAction>
<svelte:component this={Split} class={so_o?.more}><span data-so-text={so_text?.('tip')}>{tip}</span></svelte:component>
`)
    ).toMatchObject({ actions: [], panel: [], tip: [] });
  });

  it('follows what the code changes as it runs, and gives nothing of code it cannot follow', async () => {
    // A copy kept in state, in a map, or worked out as a store, shows the text where it is shown.
    expect(
      await paths(`<script>
	import { readable } from 'svelte/store';
	let { label = '', title = '', note = '', heading = '', so_id = heading, so_text, so_o = undefined } = $props();
	let copy = $state('');
	let open = $state(false);
	const map = new Map();
	$effect(() => {
		copy = label;
		map.set('title', title);
	});
	const shown = $derived(readable(note));
</script>
<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>
<footer>{copy}</footer>
<p class={so_o?.title} data-so-text={so_text?.('title')}>{title}</p>
<i>{map.get('title')}</i>
<p class={so_o?.note} data-so-text={so_text?.('note')}>{note}</p>
<b>{$shown}</b>
<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
<section id={so_id}></section>
<div class={so_o?.more}>{#if open}More{/if}</div>
<button onclick={() => (open = !open)}>Toggle</button>
`)
    ).toMatchObject({ label: [], title: [], note: [], heading: [] });
    // Through a value worked out inside the effect, a condition, a helper of the code's own, or Object.assign.
    expect(
      await paths(`<script>
	let { a = '', b = '', c = '', d = '', so_text, so_o = undefined } = $props();
	let copy = $state('');
	let chosen = $state('');
	let given = $state('');
	const box = {};
	function put(v) {
		given = v;
	}
	$effect(() => {
		const formatted = a.toUpperCase();
		copy = formatted;
		if (b === 'x') chosen = 'yes';
		put(c);
		Object.assign(box, { d });
	});
</script>
<p class={so_o?.a} data-so-text={so_text?.('a')}>{a}</p>
<p class={so_o?.b} data-so-text={so_text?.('b')}>{b}</p>
<p class={so_o?.c} data-so-text={so_text?.('c')}>{c}</p>
<p class={so_o?.d} data-so-text={so_text?.('d')}>{d}</p>
<footer>{copy}{chosen}{given}{box.d}</footer>
`)
    ).toMatchObject({ a: [], b: [], c: [], d: [] });
    // State of the code's own that nothing the placement gives reaches leaves the rest as it is.
    expect(await paths(`${script(`heading = ''`)}<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>\n<button onclick={() => (open = !open)}>Toggle</button>\n`)).toMatchObject({ heading: ['heading'] });
    // Code that reads its properties as one object, or keeps code in a module script, is not followed.
    expect(await paths(`<script>let props = $props(); let { so_text } = props;</script>\n<p class={props.so_o?.label} data-so-text={so_text?.('label')}>{props.label}</p>\n`)).toEqual({});
    expect(await paths(`<script module>export const shared = new Map();</script>\n${script(`label = ''`)}<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>\n`)).toEqual({});
  });

  it('gives nothing to a part that is itself in a component other than the Builder’s own, or in a snippet', async () => {
    expect(
      await paths(`<script>
	import Viewer from './Viewer.svelte';
	let { caption = '', note = '', so_text, so_o = undefined } = $props();
</script>
<Viewer><figcaption class={so_o?.caption} data-so-text={so_text?.('caption')}>{caption}</figcaption></Viewer>
{#snippet box()}<p class={so_o?.note} data-so-text={so_text?.('note')}>{note}</p>{/snippet}
{@render box()}
`)
    ).toMatchObject({ caption: [], note: [] });
  });

  it('names no item by a name given again on the way to the marker', async () => {
    expect(
      await paths(`${script(`plans = []`)}{#each plans as row (row.id)}<li class={[so_o?.card, so_oi?.[row.id]?.card]}>{#if true}{@const row = plans[0]}<h3 data-so-text={so_text?.('plans.name', row.id)}>{row.name}</h3>{/if}</li>{/each}\n`)
    ).toMatchObject({ card: [] });
    // An {#await}'s own name is its name only in the branch it names: elsewhere in the block, the loop's item is read.
    expect(
      await paths(`${script(`plans = [], details`)}{#each plans as row (row.id)}<li class={[so_o?.card, so_oi?.[row.id]?.card]}><h3 data-so-text={so_text?.('plans.name', row.id)}>{row.name}</h3></li>{#await details}<small>{row.name}</small>{:then row}<i>{row}</i>{/await}{/each}\n`)
    ).toMatchObject({ card: [] });
  });

  it('reads code with many writes in one effect quickly', async () => {
    const writes = Array.from({ length: 2000 }, (_, i) => `\t\tcopy = 'v${i}';`).join('\n');
    const started = performance.now();
    const texts = await paths(`<script>\n\tlet { label = '', so_text, so_o = undefined } = $props();\n\tlet copy = $state('');\n\t$effect(() => {\n${writes}\n\t});\n</script>\n<p class={so_o?.label} data-so-text={so_text?.('label')}>{label}</p>\n<footer>{copy}</footer>\n`);
    expect(texts).toMatchObject({ label: ['label'] });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads nothing from code without the text hook, and nothing from code that does not parse', async () => {
    expect(await codePartTexts(`<script>let { heading = '', so_o } = $props();</script>\n<h2 class={so_o?.heading}>{heading}</h2>\n`)).toEqual({});
    expect(await codePartTexts('<div class={')).toBeNull();
  });
});

const SOURCE = `${script(`heading = 'Plans', label = 'Compare', plans = []`, HAS)}
<section class={className}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t{#if has(label)}
\t\t<div class={so_o?.actions}><a href="/" data-so-text={so_text?.('label')}>{label}</a></div>
\t\t<p>Compare every plan side by side.</p>
\t{/if}
\t<ul>
\t\t{#each plans as plan (plan.id)}
\t\t\t<li class={['plan', so_o?.card, so_oi?.[plan.id]?.card]}>
\t\t\t\t<h3 data-so-text={so_text?.('plans.name', plan.id)}>{plan.name}</h3>
\t\t\t\t<p>{plan.price}</p>
\t\t\t</li>
\t\t{/each}
\t</ul>
</section>
`;
const PLANS: ListItem[] = [
  { id: 'p_basic', name: 'Basic', price: '$1' },
  { id: 'p_pro', name: 'Pro', price: '$9' }
];
const PROPERTIES = {
  heading: { type: 'string', label: 'Heading', default: 'Plans' },
  label: { type: 'string', label: 'Button label', default: 'Compare' },
  plans: { type: 'list', label: 'Plans', itemLabel: 'Plan', titleField: 'name', fields: { name: { type: 'string', label: 'Name', default: '' }, price: { type: 'string', label: 'Price', default: '' } }, default: PLANS }
};

/** A page with a placed code component, declared as saving its code declares it. */
async function placed() {
  let s: ProjectState = createStarterState('business', 'Code Texts', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  const names = (await codeContractNames(SOURCE))!;
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Price list', source: SOURCE, properties: PROPERTIES } as EditOperation], { codeNames: () => names });
  const defId = made.results[0].definitionId as string;
  s = made.state;
  const ins = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId } as EditOperation]);
  const nodeId = ins.results[0].nodeId as string;
  const state = applyOperations(ins.state, [{ type: 'instance.setProp', owner, nodeId, prop: 'plans', value: structuredClone(PLANS) } as EditOperation]).state;
  const texts = (await codePartTexts(SOURCE))!;
  /** A selection of one part, with the text its code shows there as a request reads it (`paths` in place of what it read). */
  const part = (partId: string, itemId?: string, paths?: string[]): Extract<Authority, { kind: 'selection' }> => {
    const a = authorityFor({ owner, instancePath: [nodeId], nodeId: state.components[defId].parts[partId].nodeId, partId, ...(itemId ? { itemPath: [itemId] } : {}) }, 'Price list', null, state);
    if (a.kind !== 'selection' || !a.part) throw new Error('not a part');
    return { ...a, part: { ...a.part, texts: { sourceHash: sourceHash(SOURCE), paths: paths ?? texts[partId]?.paths ?? [], keep: texts[partId]?.keep ?? [], perItem: texts[partId]?.perItem ?? [] } } };
  };
  return { state, owner, nodeId, defId, part };
}

describe('a selected part of a code component', () => {
  it('may change the text its code marks inside it, and nothing else', async () => {
    const { state, owner, nodeId, part } = await placed();
    const set = (prop: string, value: unknown): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop, value });
    expect(checkAuthority(state, [set('label', 'See plans')], part('actions'))).toBeNull();
    expect(checkAuthority(state, [set('heading', 'Prices')], part('actions'))).toMatch(/more of Price list than the selected part/);
    // A batch is refused whole when one change in it is outside.
    expect(checkAuthority(state, [set('label', 'See plans'), set('heading', 'Prices')], part('actions'))).toMatch(/selected part/);
    // A path the component does not declare as text is never the part's, whatever the reading says.
    expect(checkAuthority(state, [set('plans', [])], part('actions', undefined, ['label', 'plans']))).toMatch(/selected part/);
    // Without the reading, or with a reading of other code, the part has only its own styles.
    const unread = authorityFor({ owner, instancePath: [nodeId], nodeId: 'actions', partId: 'actions' }, 'Price list', null, state);
    expect(checkAuthority(state, [set('label', 'See plans')], unread)).toMatch(/selected part/);
    const stale = part('actions');
    expect(checkAuthority(state, [set('label', 'See plans')], { ...stale, part: { ...stale.part!, texts: { ...stale.part!.texts!, sourceHash: 'deadbeef' } } })).toMatch(/selected part/);
  });

  it('may change the words of a text whose presence decides more, but not empty it', async () => {
    const { state, owner, nodeId, part } = await placed();
    const set = (value: unknown): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop: 'label', value });
    expect(part('actions').part?.texts?.keep).toEqual(['label']);
    expect(checkAuthority(state, [set('See plans')], part('actions'))).toBeNull();
    expect(checkAuthority(state, [set('  ')], part('actions'))).toMatch(/would empty "label"/);
    // Judged against the batch as it goes: a later step that empties it is refused.
    expect(checkAuthority(state, [set('See plans'), set('')], part('actions'))).toMatch(/would empty/);
    // Judged as the engine saves it: a number is saved as its text.
    expect(checkAuthority(state, [set(0)], part('actions'))).toBeNull();
    const emptied = structuredClone(state);
    ((emptied.pages[owner.id].nodes[nodeId] as InstanceNode).props as Record<string, unknown>).label = '';
    expect(checkAuthority(emptied, [set('See plans')], part('actions'))).toMatch(/would fill "label"/);
  });

  it('may change the selected card’s marked field, never another card’s or an unmarked field', async () => {
    const { state, owner, nodeId, part } = await placed();
    const field = (itemId: string, f: string, value: string): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop: 'plans', itemId, field: f, value });
    const card = part('card', 'p_pro');
    expect(checkAuthority(state, [field('p_pro', 'name', 'Premium')], card)).toBeNull();
    expect(checkAuthority(state, [field('p_basic', 'name', 'Starter')], card)).toMatch(/other than the selected one/);
    expect(checkAuthority(state, [field('p_pro', 'price', '$10')], card)).toMatch(/does not show/);
    // An item sent whole must hold only fields the part shows.
    expect(checkAuthority(state, [{ type: 'instance.setProp', owner, nodeId, prop: 'plans', itemId: 'p_pro', value: { name: 'Premium', price: '$10' } }], card)).toMatch(/does not show/);
    expect(checkAuthority(state, [{ type: 'instance.listRemove', owner, nodeId, prop: 'plans', itemId: 'p_pro' }], card)).toMatch(/selected part/);
  });

  it('reaches no item of a part shown once per item, picked with no item to say which', async () => {
    const { state, owner, nodeId, part } = await placed();
    expect(part('card').part?.texts?.perItem).toEqual(['plans']);
    expect(checkAuthority(state, [{ type: 'instance.setProp', owner, nodeId, prop: 'plans', itemId: 'p_basic', field: 'name', value: 'Starter' }], part('card'))).toMatch(/selected part/);
  });

  it('never reaches the items of a list the placement fills from a collection', async () => {
    const { state, owner, nodeId, part } = await placed();
    const connected = structuredClone(state);
    (connected.pages[owner.id].nodes[nodeId] as InstanceNode).listSources = { plans: { collectionId: 'posts' } } as never;
    expect(checkAuthority(connected, [{ type: 'instance.setProp', owner, nodeId, prop: 'plans', itemId: 'p_pro', field: 'name', value: 'Premium' }], part('card', 'p_pro'))).toMatch(/selected part/);
  });

  it('offers the selection tools for the text the part shows', async () => {
    const { state, owner, nodeId, part } = await placed();
    const a = part('actions');
    const tools = selectionTools(state, { owner, nodeId, partId: 'actions', texts: a.part!.texts });
    const props = (tools?.find((t) => t.name === 'update_selected_props')?.parameters as { properties: { props: { properties: Record<string, unknown> } } }).properties.props.properties;
    expect(Object.keys(props)).toEqual(['label']);
    // A card offers its list, for the field it shows.
    expect(selectionTools(state, { owner, nodeId, partId: 'card', itemId: 'p_pro', texts: part('card', 'p_pro').part!.texts })?.some((t) => t.name === 'edit_selected_list')).toBe(true);
    // Unread, the part offers no content to change.
    expect(selectionTools(state, { owner, nodeId, partId: 'actions' })?.some((t) => t.name === 'update_selected_props') ?? false).toBe(false);
  });
});
