/**
 * The copy a live session's Copy Editor may change on Foundation's sections (#1344) is copy in the committed
 * releases' own markup: each listed property is shown only as words, rich text or a picture, and otherwise only
 * tested for being set (fixtures/svelte-copy-uses.ts). A release that starts using one some other way fails here.
 */
import { describe, expect, it } from 'vitest';
import type { PropSchema } from '@shared/types';
import { findTheme } from '@catalogue/index';
import { SHIPPED_COPY } from '@engine/shipped-copy';
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
const hero = () => pack('foundation').components.find((c) => c.componentId === 'hero.split')!;

describe('the copy Builder lets a copy editor change on Foundation’s sections', () => {
  const cases = PACKS.flatMap((id) => Object.entries(SHIPPED_COPY).flatMap(([componentId, props]) => props.map((prop) => ({ id, componentId, prop }))));

  it.each(cases)('$id’s $componentId shows $prop only as copy', ({ id, componentId, prop }) => {
    const def = pack(id).components.find((c) => c.componentId === componentId);
    expect(def, `${id} ${componentId}`).toBeDefined();
    expect(def!.kind).toBe('code');
    const schema = def!.properties[prop];
    const shown = schema && SHOWN[schema.type];
    expect(shown, `${componentId}.${prop} is ${schema?.type ?? 'missing'}`).toBeDefined();
    if (schema.type === 'richtext') expect(schema.codeForm).toBe('blocks');
    const { uses, problems } = copyUses(def!.source ?? '', prop, def!.properties);
    expect(problems).toEqual([]);
    expect(uses).toContain(shown);
    expect(uses.every((u) => u === shown || u === 'presence')).toBe(true);
  });

  it.each(PACKS)('lists all of %s’s copy, so none of it is left to the host by omission', (id) => {
    const found: Record<string, string[]> = {};
    for (const def of pack(id).components) {
      if (SHELL.has(def.componentId)) continue;
      for (const [prop, schema] of Object.entries(def.properties)) {
        const shown = SHOWN[schema.type];
        if (!shown || (schema.type === 'richtext' && schema.codeForm !== 'blocks')) continue;
        const { uses, problems } = copyUses(def.source ?? '', prop, def.properties);
        if (!problems.length && uses.includes(shown)) (found[def.componentId] ??= []).push(prop);
      }
    }
    const listed = Object.fromEntries(Object.entries(SHIPPED_COPY).map(([k, v]) => [k, [...v].sort()]));
    expect(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.sort()]))).toEqual(listed);
  });
});

describe('reading how a section uses a property', () => {
  const source = hero().source!;
  const properties = hero().properties;
  const eyebrow = '<p data-so-text={so_text?.(\'eyebrow\')} class={[\'hero__eyebrow\', so_o?.eyebrow]}>{eyebrow}</p>';
  const uses = (src: string, prop = 'eyebrow') => copyUses(src, prop, properties);

  it('finds the release’s own uses: tested for being set, then shown', () => {
    expect(source).toContain(eyebrow);
    const found = uses(source);
    expect(found.problems).toEqual([]);
    expect([...found.uses].sort()).toEqual(['presence', 'presence', 'text']);
    expect(uses(source, 'heading').problems).toEqual([]);
    expect(uses(source, 'image')).toEqual({ uses: ['image'], problems: [] });
    // Shown, but as a button's words.
    expect(uses(source, 'primaryLabel').problems).toEqual([expect.stringMatching(/words of <SoLink>/)]);
  });

  it('refuses any other use beside the one that shows it', () => {
    const swap = (to: string) => {
      expect(source).toContain(eyebrow);
      return uses(source.replace(eyebrow, to)).problems;
    };
    // As an attribute, a class, a tag's words inside a link, a test of its raw value, each item of a list, a value
    // worked out from it.
    expect(swap(`<p title={eyebrow}>{eyebrow}</p>`)).toEqual([expect.stringMatching(/title attribute of <p>/)]);
    expect(swap(`<p class={['x', eyebrow]}>{eyebrow}</p>`)).toEqual([expect.stringMatching(/ArrayExpression/)]);
    expect(swap(`<a href="/x"><p>{eyebrow}</p></a>`)).toEqual([expect.stringMatching(/inside <a>/)]);
    expect(swap(`{#if eyebrow}<p>{eyebrow}</p>{/if}`)).toEqual([expect.stringMatching(/IfBlock/)]);
    expect(swap(`{#each [1, 2] as n}<p>{eyebrow}</p>{/each}`)).toEqual([expect.stringMatching(/inside EachBlock/)]);
    expect(swap(`<p>{eyebrow.trim()}</p>`)).toEqual([expect.stringMatching(/MemberExpression/)]);
    expect(swap(`<button>{eyebrow}</button>`)).toEqual([expect.stringMatching(/words of <button>/)]);
    // A heading's tag a property chooses from anything but headings and paragraphs.
    const level = { ...properties, headingLevel: { ...(properties.headingLevel as Extract<PropSchema, { type: 'enum' }>), options: [{ value: 'h1', label: 'H1' }, { value: 'a', label: 'Link' }] } };
    expect(copyUses(source, 'heading', level).problems).toEqual([expect.stringMatching(/words of SvelteElement/)]);
  });

  it('cannot follow a property taken under another name, or not taken at all', () => {
    expect(uses(source.replace(/\beyebrow = 'Interior design studio'/, "eyebrow: label = 'Interior design studio'")).problems).toContainEqual(expect.stringMatching(/under another name/));
    expect(uses(source, 'nothing').problems).toEqual([expect.stringMatching(/not taken from \$props\(\)/)]);
  });
});
