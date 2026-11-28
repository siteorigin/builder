/**
 * The text a code component's part shows (#1416): read from its code, a selection of the part may change the text the
 * code marks inside it, and nothing the code shows elsewhere.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ListItem, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, sourceHash } from '@engine/apply';
import { authorityFor, checkAuthority, type Authority } from '@agent/scope';
import { selectionTools } from '@agent/selection';
import { codeContractNames, codePartTexts } from '../../src/main/codecheck';

const script = (props: string) => `<script>\n\tlet { ${props}, so_text, so_o = undefined, so_oi = undefined, class: className = '' } = $props();\n</script>\n`;

describe('the text the code marks in each part', () => {
  it('reads the text marked on a part, inside it, and through an {#if} that shows only the part', async () => {
    const texts = await codePartTexts(`${script(`heading = '', label = '', note = ''`)}
<section class={className}>
\t{#if heading}<h2 data-so-text={so_text?.('heading')} class={so_o?.heading}>{heading}</h2>{/if}
\t<div class={['actions', so_o?.actions]}>
\t\t{#if label}<a href="/" data-so-text={so_text?.('label')}>{label}</a>{/if}
\t</div>
\t<p data-so-part="note"><span data-so-text={so_text?.('note')}>{note}</span></p>
</section>
`);
    expect(texts).toMatchObject({ heading: ['heading'], actions: ['label'], note: ['note'] });
  });

  it('leaves out text the markup also shows or reads outside the part', async () => {
    const texts = await codePartTexts(`${script(`heading = '', label = '', tagline = ''`)}
<section class={className} aria-label={tagline}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t<p>{heading}</p>
\t{#if label}
\t\t<div class={so_o?.actions}><a href="/" data-so-text={so_text?.('label')}>{label}</a></div>
\t\t<p>Shown with the label</p>
\t{/if}
\t<div class={so_o?.tag}><span data-so-text={so_text?.('tagline')}>{tagline}</span></div>
</section>
`);
    expect(texts).toMatchObject({ heading: [], actions: [], tag: [] });
  });

  it('leaves out text marked twice, once outside the part, and text in a snippet the part defines', async () => {
    const texts = await codePartTexts(`${script(`heading = '', label = ''`)}
<section class={className}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t<p data-so-text={so_text?.('heading')}>{heading}</p>
\t<div class={so_o?.actions}>
\t\t{#snippet button()}<a href="/" data-so-text={so_text?.('label')}>{label}</a>{/snippet}
\t\t{@render button()}
\t</div>
</section>
`);
    expect(texts).toMatchObject({ heading: [], actions: [] });
  });

  it('reads a list field marked in a part repeated over the list, and not one repeated inside another list', async () => {
    const texts = await codePartTexts(`${script(`plans = []`)}
<ul class={className}>
\t{#each plans as plan (plan.id)}
\t\t<li class={[so_o?.card, so_oi?.[plan.id]?.card]}>
\t\t\t<h3 data-so-text={so_text?.('plans.name', plan.id)}>{plan.name}</h3>
\t\t\t{#each plan.notes as note (note.id)}<p data-so-text={so_text?.('plans.note', note.id)}>{note.text}</p>{/each}
\t\t</li>
\t{/each}
</ul>
`);
    expect(texts).toMatchObject({ card: ['plans.name'] });
  });

  it('reads nothing from code without the text hook, and nothing from code that does not parse', async () => {
    expect(await codePartTexts(`<script>let { heading = '', so_o } = $props();</script>\n<h2 class={so_o?.heading}>{heading}</h2>\n`)).toEqual({});
    expect(await codePartTexts('<div class={')).toBeNull();
  });
});

const SOURCE = `${script(`heading = 'Plans', label = 'Compare', plans = []`)}
<section class={className}>
\t<h2 class={so_o?.heading} data-so-text={so_text?.('heading')}>{heading}</h2>
\t<div class={so_o?.actions}><a href="/" data-so-text={so_text?.('label')}>{label}</a></div>
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
  /** A selection of one part, with the text its code shows there as a request reads it. */
  const part = (partId: string, itemId?: string): Authority => {
    const a = authorityFor({ owner, instancePath: [nodeId], nodeId: state.components[defId].parts[partId].nodeId, partId, ...(itemId ? { itemPath: [itemId] } : {}) }, 'Price list', null, state);
    if (a.kind !== 'selection' || !a.part) throw new Error('not a part');
    return { ...a, part: { ...a.part, texts: { sourceHash: sourceHash(SOURCE), paths: texts[partId] ?? [] } } };
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
    // Without the reading, or with a reading of other code, the part has only its own styles.
    const unread = authorityFor({ owner, instancePath: [nodeId], nodeId: 'actions', partId: 'actions' }, 'Price list', null, state);
    expect(checkAuthority(state, [set('label', 'See plans')], unread)).toMatch(/selected part/);
    const stale = part('actions') as Extract<Authority, { kind: 'selection' }>;
    expect(checkAuthority(state, [set('label', 'See plans')], { ...stale, part: { ...stale.part!, texts: { ...stale.part!.texts!, sourceHash: 'deadbeef' } } })).toMatch(/selected part/);
  });

  it('may change the selected card’s marked field, never another card’s or an unmarked field', async () => {
    const { state, owner, nodeId, part } = await placed();
    const field = (itemId: string, f: string, value: string): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop: 'plans', itemId, field: f, value });
    const card = part('card', 'p_pro');
    expect(checkAuthority(state, [field('p_pro', 'name', 'Premium')], card)).toBeNull();
    expect(checkAuthority(state, [field('p_basic', 'name', 'Starter')], card)).toMatch(/other than the selected one/);
    expect(checkAuthority(state, [field('p_pro', 'price', '$10')], card)).toMatch(/does not show/);
    expect(checkAuthority(state, [{ type: 'instance.listRemove', owner, nodeId, prop: 'plans', itemId: 'p_pro' }], card)).toMatch(/selected part/);
  });

  it('offers the selection tools for the text the part shows', async () => {
    const { state, owner, nodeId, part } = await placed();
    const a = part('actions') as Extract<Authority, { kind: 'selection' }>;
    const tools = selectionTools(state, { owner, nodeId, partId: 'actions', texts: a.part!.texts });
    const props = (tools?.find((t) => t.name === 'update_selected_props')?.parameters as { properties: { props: { properties: Record<string, unknown> } } }).properties.props.properties;
    expect(Object.keys(props)).toEqual(['label']);
    // Unread, the part offers no content to change.
    expect(selectionTools(state, { owner, nodeId, partId: 'actions' })?.some((t) => t.name === 'update_selected_props') ?? false).toBe(false);
  });
});
