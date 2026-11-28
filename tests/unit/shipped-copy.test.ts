/**
 * The copy a live session's Copy Editor may change on Foundation's sections (#1344) is copy in the committed
 * releases' own markup: each listed property is shown only as words, rich text or a picture, and otherwise only
 * tested for being set (fixtures/svelte-copy-uses.ts). A release that starts using one some other way fails here, and
 * so does one that shows copy the list leaves out, so a refreshed release's copy is a decision someone makes.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, PropSchema } from '@shared/types';
import { findTheme } from '@catalogue/index';
import { compile } from 'svelte/compiler';
import { unmarkedSource, SHIPPED_COPY, rendersAsShipped } from '@engine/shipped-copy';
import { copyUses, type CopyUse } from './fixtures/svelte-copy-uses';

const PACKS = ['foundation', 'foundation-alt'];
/** The use that shows a property of each type. */
const SHOWN: Partial<Record<PropSchema['type'], CopyUse>> = { string: 'text', richtext: 'rich', image: 'image' };
/** The shared header and footer: never on a page, so never a Copy Editor's. */
const SHELL = new Set(['shell.header', 'shell.footer']);

const pack = (id: string) => {
  const theme = findTheme(id);
  if (!theme) throw new Error(`${id} is not registered.`);
  return theme;
};

/** Why a property of a definition is not copy a Copy Editor may change, or an empty list when it is. */
function notCopy(def: ComponentDefinition, prop: string): string[] {
  if (def.kind !== 'code') return [`${def.componentId} is not code.`];
  const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
  const shown = schema && SHOWN[schema.type];
  if (!shown) return [`${def.componentId}.${prop} is ${schema?.type ?? 'missing'}.`];
  if (schema.type === 'richtext' && schema.codeForm !== 'blocks') return [`${def.componentId}.${prop} is rich text given as paragraphs.`];
  const { uses, problems } = copyUses(def.source ?? '', prop, def.properties);
  if (problems.length) return problems;
  if (!uses.includes(shown)) return [`${def.componentId}.${prop} is never shown.`];
  const other = uses.find((u) => u !== shown && u !== 'presence');
  return other ? [`${def.componentId}.${prop} is also shown as ${other}.`] : [];
}

describe('the copy Builder lets a copy editor change on Foundation’s sections', () => {
  const cases = PACKS.flatMap((id) => Object.entries(SHIPPED_COPY).flatMap(([componentId, props]) => props.map((prop) => ({ id, componentId, prop }))));

  it.each(cases)('$id’s $componentId shows $prop only as copy', ({ id, componentId, prop }) => {
    const def = pack(id).components.find((c) => c.componentId === componentId);
    expect(def, `${id} ${componentId}`).toBeDefined();
    expect(notCopy(def!, prop)).toEqual([]);
  });

  it.each(PACKS)('lists all of %s’s copy, so none of it is left to the host by omission', (id) => {
    const found: Record<string, string[]> = {};
    for (const def of pack(id).components) {
      if (SHELL.has(def.componentId)) continue;
      for (const prop of Object.keys(def.properties)) if (!notCopy(def, prop).length) (found[def.componentId] ??= []).push(prop);
    }
    const sorted = (r: Readonly<Record<string, readonly string[]>>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(found)).toEqual(sorted(SHIPPED_COPY));
  });

  it('leaves the release’s buttons, and the headings that name a form or a search, to the host', () => {
    const def = (componentId: string) => pack('foundation').components.find((c) => c.componentId === componentId)!;
    expect(notCopy(def('hero.split'), 'primaryLabel')).toEqual([expect.stringMatching(/words of <SoLink>/)]);
    for (const componentId of ['contact.form', 'site.search']) expect(notCopy(def(componentId), 'heading')).toContainEqual(expect.stringMatching(/which has an ID/));
  });
});

describe('reading how a section uses a property', () => {
  const properties: Record<string, PropSchema> = {
    heading: { type: 'string', label: 'Heading', default: '' },
    headingLevel: { type: 'enum', label: 'Level', default: 'h2', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }] },
    image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } },
    body: { type: 'richtext', label: 'Body', default: [], codeForm: 'blocks' }
  };
  /** A section's source: the runtime's helpers, these properties, then `script` and `markup`. */
  const sample = (markup: string, script = '', imports = '') =>
    [
      '<script>',
      "\timport { has } from '../runtime/util.js';",
      "\timport SoImage from '../runtime/Image.svelte';",
      "\timport SoRichText from '../runtime/RichText.svelte';",
      imports,
      "\tlet { heading = 'Hi', headingLevel = 'h2', image = null, body = [], so_id = undefined } = $props();",
      script,
      '</script>',
      `<section id={so_id}><div>${markup}</div></section>`
    ].join('\n');
  const check = (markup: string, prop = 'heading', script = '', imports = '') => copyUses(sample(markup, script, imports), prop, properties);
  const problems = (markup: string, prop = 'heading', script = '', imports = '') => check(markup, prop, script, imports).problems;

  it('reads presence tests, words, pictures and rich text', () => {
    const r = check('{#if has(heading)}<svelte:element this={headingLevel}>{heading}</svelte:element>{/if}', 'heading', 'const shown = $derived(has(heading));');
    expect(r.problems).toEqual([]);
    expect([...r.uses].sort()).toEqual(['presence', 'presence', 'text']);
    expect(check('<figure><SoImage {image} eager sizes="50vw" fallbackAlt="" class="x" /></figure>', 'image')).toEqual({ uses: ['image'], problems: [] });
    expect(check('<SoRichText data-so-text="body" value={body} class="x" />', 'body')).toEqual({ uses: ['rich'], problems: [] });
    // A presence test in the markup may sit anywhere: it never changes, so neither does what it decides.
    expect(problems('<p>{heading}</p><form aria-describedby={has(heading) ? "a" : undefined}></form>')).toEqual([]);
  });

  it('refuses words that are an attribute, a link’s or a button’s, a raw test, a value worked out, or shown once per item', () => {
    expect(problems('<p title={heading}>{heading}</p>')).toEqual([expect.stringMatching(/title attribute of <p>/)]);
    expect(problems("<p class={['x', heading]}>{heading}</p>")).toEqual([expect.stringMatching(/ArrayExpression/)]);
    expect(problems('<a href="/x"><p>{heading}</p></a>')).toEqual([expect.stringMatching(/inside <a>/)]);
    expect(problems('<button>{heading}</button>')).toEqual([expect.stringMatching(/words of <button>/)]);
    expect(problems('{#if heading}<p>{heading}</p>{/if}')).toEqual([expect.stringMatching(/IfBlock/)]);
    expect(problems('<p>{heading.trim()}</p>')).toEqual([expect.stringMatching(/MemberExpression/)]);
    expect(problems('{#each [1, 2] as n}<p>{heading}</p>{/each}')).toEqual([expect.stringMatching(/inside EachBlock/)]);
    expect(problems('{#await Promise.resolve(1) then n}<p>{heading}</p>{/await}')).toEqual([expect.stringMatching(/inside AwaitBlock/)]);
    expect(problems('{@html heading}')).toEqual([expect.stringMatching(/HtmlTag/)]);
    expect(problems('<p style:heading>{heading}</p>')).toEqual([expect.stringMatching(/StyleDirective/)]);
  });

  it('refuses words in an element that acts, or that something may name by its ID', () => {
    expect(problems('<div role="button" tabindex="0"><span>{heading}</span></div>')).toEqual([expect.stringMatching(/inside <div>, which has role/)]);
    expect(problems('<div onclick={() => {}}><p>{heading}</p></div>')).toEqual([expect.stringMatching(/which has onclick/)]);
    expect(problems('<div on:click={() => {}}><p>{heading}</p></div>')).toEqual([expect.stringMatching(/which handles events/)]);
    expect(problems('<h2 id="title">{heading}</h2><form aria-labelledby="title"></form>')).toEqual([expect.stringMatching(/inside <h2>, which has an ID/)]);
    expect(problems('<div {...{ role: "link" }}><p>{heading}</p></div>')).toEqual([expect.stringMatching(/spreads/)]);
  });

  it('refuses a heading whose tag is anything but a property choosing headings and paragraphs', () => {
    const level = { ...properties, headingLevel: { ...(properties.headingLevel as Extract<PropSchema, { type: 'enum' }>), options: [{ value: 'h2', label: 'H2' }, { value: 'a', label: 'Link' }] } };
    expect(copyUses(sample('<svelte:element this={headingLevel}>{heading}</svelte:element>'), 'heading', level).problems).toEqual([expect.stringMatching(/words of SvelteElement/)]);
    // A choice of headings the component is never given.
    expect(copyUses(sample('<svelte:element this={level}>{heading}</svelte:element>'), 'heading', { ...properties, level: properties.headingLevel }).problems).toEqual([expect.stringMatching(/words of SvelteElement/)]);
    // A tag of the script's own, or the markup's.
    expect(problems('<svelte:element this={tag}>{heading}</svelte:element>', 'heading', "const tag = 'a';")).toEqual([expect.stringMatching(/words of SvelteElement/)]);
    expect(problems("{#if true}{@const tag = 'a'}<svelte:element this={tag}>{heading}</svelte:element>{/if}")).toEqual([expect.stringMatching(/words of SvelteElement/)]);
    // The choosing property itself bound again where the heading is.
    expect(problems("{#if true}{@const headingLevel = 'a'}<svelte:element this={headingLevel}>{heading}</svelte:element>{/if}")).toEqual([expect.stringMatching(/words of SvelteElement/)]);
  });

  it('refuses a picture or rich text given anything that changes how the runtime shows it', () => {
    expect(problems('<SoImage image="x{image}" />', 'image')).toEqual([expect.stringMatching(/part of the image given to <SoImage>/)]);
    expect(problems('<SoImage {image} {...{ image: null }} />', 'image')).toEqual([expect.stringMatching(/given SpreadAttribute/)]);
    expect(problems('<SoRichText value={body} list="check" />', 'body')).toEqual([expect.stringMatching(/given “list”/)]);
    expect(problems('<SoImage {image} decorative />', 'image')).toEqual([expect.stringMatching(/given “decorative”/)]);
  });

  it('reads a presence test only where nothing but true or false runs again when the words change', () => {
    const again = [expect.stringMatching(/more than the test may run again/)];
    expect(problems('<p>{heading}</p>', 'heading', 'const shown = $derived(!has(heading) || (has(heading) ? true : false));')).toEqual([]);
    expect(problems('<p>{heading}</p>', 'heading', '$effect(() => { if (has(heading)) console.log(1); });')).toEqual(again);
    expect(problems('<p>{heading}</p>', 'heading', 'function report() { return has(heading); }\n$effect(report);')).toEqual(again);
    expect(problems('<p>{heading}</p>', 'heading', '$inspect(has(heading));')).toEqual(again);
    expect(problems('<p>{heading}</p>', 'heading', "const shown = $derived.by(() => { console.log('read'); return has(heading); });")).toEqual(again);
    expect(problems('<p>{heading}</p>', 'heading', '$effect(() => { const shown = $derived(has(heading)); void shown; });')).toEqual(again);
    expect(problems('<p>{heading}</p>', 'heading', 'const shown = $derived(String(has(heading)));')).toEqual(again);
    expect(problems('<p>{heading}</p>{report(has(heading))}', 'heading', 'const report = (v) => v;')).toEqual(again);
  });

  it('takes only the runtime’s own helpers, never a name bound again or imported from elsewhere', () => {
    // `has` bound again, by a parameter or a `let:`, or imported from another module.
    expect(problems('<p>{heading}</p>', 'heading', 'const check = (has) => has(heading);')).toContainEqual(expect.stringMatching(/bound again/));
    expect(problems('<p>{heading}</p><Pass let:has>{#if has(heading)}<span></span>{/if}</Pass>', 'heading', '', "\timport Pass from './Pass.svelte';")).toContainEqual(expect.stringMatching(/bound again/));
    expect(problems('<p>{heading}</p><Pass let:check={has}>{#if has(heading)}<span></span>{/if}</Pass>', 'heading', '', "\timport Pass from './Pass.svelte';")).toContainEqual(expect.stringMatching(/bound again/));
    expect(problems("<p>{heading}</p>{#await Promise.resolve({ check: (s) => s === 'Hi' }) then { check: has }}{#if has(heading)}<span></span>{/if}{/await}")).toContainEqual(expect.stringMatching(/bound again/));
    const elsewhere = copyUses(sample('{#if has(heading)}<p>{heading}</p>{/if}').replace("'../runtime/util.js'", "'./runtime/util.js'"), 'heading', properties);
    expect(elsewhere.problems).toEqual([expect.stringMatching(/CallExpression/)]);
    const rich = copyUses(sample('<SoRichText value={body} />').replace("'../runtime/RichText.svelte'", "'./runtime/RichText.svelte'"), 'body', properties);
    expect(rich.problems).toEqual([expect.stringMatching(/value attribute of <SoRichText>/)]);
    // SoImage bound again inside the markup.
    expect(problems('{#if true}{@const SoImage = Other}<SoImage {image} />{/if}', 'image', '', "\timport Other from './Other.svelte';")).toContainEqual(expect.stringMatching(/bound again/));
    // The property itself bound again.
    expect(problems('<p>{heading}</p>', 'heading', 'function f(heading) {}')).toContainEqual(expect.stringMatching(/bound again besides/));
  });

  it('cannot follow a property taken under another name, not taken at all, or taken twice', () => {
    const renamed = sample('<p>{heading}</p>').replace("heading = 'Hi'", "heading: label = 'Hi'");
    expect(copyUses(renamed, 'heading', properties).problems).toContainEqual(expect.stringMatching(/under another name/));
    expect(problems('<p>{heading}</p>', 'nothing')).toEqual([expect.stringMatching(/not taken from \$props\(\)/)]);
    expect(problems('<p>{heading}</p>', 'heading', 'let { ...rest } = $props();')).toContainEqual(expect.stringMatching(/more than once/));
  });
});

describe('a section as a publication carries it', () => {
  it('is read as shipped with its editor markers taken out exactly as the exports take them out, and only then (#1351)', async () => {
    const { withoutCodeMarkers } = await import('../../src/main/codecheck');
    let checked = 0;
    for (const pack of ['foundation', 'foundation-alt']) {
      for (const def of findTheme(pack)?.components ?? []) {
        if (def.kind !== 'code' || typeof def.source !== 'string') continue;
        const clean = await withoutCodeMarkers(def.source);
        // What the check expects of a publication is what the export writes, to the byte.
        expect(unmarkedSource(def.source), `${pack} ${def.componentId}`).toBe(clean);
        expect(clean, `${pack} ${def.componentId}`).not.toContain('so_text');
        expect(() => compile(clean, { generate: 'server', runes: true }), `${pack} ${def.componentId}`).not.toThrow();
        expect(rendersAsShipped({ ...def, source: clean }), `${pack} ${def.componentId}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    const bento = findTheme('foundation')!.components.find((c) => c.componentId === 'features.bento')!;
    const clean = await withoutCodeMarkers(bento.source!);
    // Words that only look like a marker are the section's own, and any other change is the definition's own code.
    const title = clean.indexOf('{featured?.title}') + '{featured?.title}'.length;
    expect(title).toBeGreaterThan(20);
    expect(rendersAsShipped({ ...bento, source: clean.slice(0, title) + ' data-so-text="sample"' + clean.slice(title) })).toBe(false);
    expect(rendersAsShipped({ ...bento, source: clean.replace('{featured?.title}', '{featured?.description}') })).toBe(false);
    expect(rendersAsShipped({ ...bento, source: clean, name: 'Bento (mine)' })).toBe(false);
    expect(rendersAsShipped({ ...bento, source: clean, properties: { ...bento.properties, heading: { ...bento.properties.heading, default: 'Mine' } as PropSchema } })).toBe(false);
  });
});
