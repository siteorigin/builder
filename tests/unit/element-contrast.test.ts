/**
 * Text an element's own colours make hard to read (#1489): a text colour picked in the Inspector that disappears into
 * its background, and text over a background picture nothing makes readable, each a warning in Project health on the
 * text it is about, at the screen sizes and in the palettes where it happens. Only what is known is measured: the
 * theme's own colours, a placed component's markup and anything this can't read stay quiet.
 */
import { describe, expect, it } from 'vitest';
import type { ElementNode, GraphNode, InstanceNode, ProjectState, ResponsiveStyles, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { STARTERS, createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { adviceValidation, blocksSaving, validateState, type Diagnostic } from '@engine/validate';
import { elementContrastDiagnostics } from '@engine/element-contrast';
import { ValidationCache } from '@engine/validation-cache';

const LOW = 'TEXT_CONTRAST_LOW';
const UNVERIFIED = 'TEXT_CONTRAST_UNVERIFIED';

/** A blank Foundation site with the issue's colours: an acid accent, and cards a warm off-white. */
function fresh(): ProjectState {
  const s = createStarterState('blank', 'Blank', false);
  s.tokens.overrides['color.accent'] = '#d4ff3a';
  s.tokens.overrides['color.surface'] = '#faf9f5';
  return s;
}
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

const el = (id: string, styles?: ResponsiveStyles, children: string[] = [], extra: Partial<ElementNode> = {}): ElementNode =>
  ({ id, kind: 'element', tag: 'div', children, ...(styles ? { styles } : {}), ...extra }) as ElementNode;
const text = (id: string, words = 'Fresh bread every morning', styles?: ResponsiveStyles, extra: Partial<TextNode> = {}): TextNode =>
  ({ id, kind: 'text', tag: 'p', text: words, ...(styles ? { styles } : {}), ...extra }) as TextNode;

/** Home holding these nodes, the first placed at the top of the page (inside `into`'s content slot, when given). */
function page(nodes: GraphNode[], s = fresh(), into?: InstanceNode): ProjectState {
  const p = home(s);
  for (const n of nodes) p.nodes[n.id] = n;
  if (into) {
    p.nodes[into.id] = into;
    into.slots = { content: [nodes[0].id] };
    p.rootIds.push(into.id);
  } else p.rootIds.push(nodes[0].id);
  return s;
}
/** A Foundation Section placed on the page, as Insert wraps what it puts at the top of a page. */
const section = (s: ProjectState): InstanceNode => makeInstance(s.components[installComponent(s, 'layout.section')], {}) as InstanceNode;

const contrast = (s: ProjectState): Diagnostic[] => validateState(s).filter((d) => d.code === LOW || d.code === UNVERIFIED);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const setStyle = (s: ProjectState, nodeId: string, scope: string, property: string, value: unknown) =>
  apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId, scope, property, value } as EditOperation]);

const ACCENT = { token: 'color.accent' };
const CARD = { token: 'color.surface' };
const INK = { token: 'color.text' };

function withPhoto(s: ProjectState): ProjectState {
  s.assets.assets['as_dark'] = { id: 'as_dark', name: 'Night street', file: 'static/assets/night.jpg', mime: 'image/jpeg', bytes: 1, width: 800, height: 600, hash: 'h', kind: 'image', createdAt: '' } as never;
  return s;
}

describe('text whose own colours disappear into its background (#1489)', () => {
  /** The issue's grid of cards in a section, one card's text set to Accent. */
  const cards = () => {
    const s = fresh();
    const sec = section(s);
    return page(
      [
        el('n_grid', { base: { layout: 'grid', columns: 2 } }, ['n_card1', 'n_card2']),
        el('n_card1', { base: { layout: 'stack', background: CARD, color: ACCENT } }, ['n_title1', 'n_body1']),
        el('n_card2', { base: { layout: 'stack', background: CARD } }, ['n_body2']),
        text('n_title1', 'Sourdough', undefined, { tag: 'h3' }),
        text('n_body1'),
        text('n_body2')
      ],
      s,
      sec
    );
  };

  it('is a warning on each text of the card, saying its ratio and what it needs, inside a placed section', () => {
    const s = cards();
    const found = contrast(s);
    expect(found.map((d) => [d.severity, d.code, d.owner, d.nodeId])).toEqual([
      ['warning', LOW, owner(s), 'n_title1'],
      ['warning', LOW, owner(s), 'n_body1']
    ]);
    expect(found[1].message).toBe(
      `${home(s).title}: The text “Fresh bread every morning” is hard to read: its color has 1.09:1 contrast with the background behind it, and text this size needs at least 4.5:1. Choose a text color or a background that stands further apart.`
    );
    // A heading may be large: it needs only 3:1, and still fails.
    expect(found[0].message).toContain('The text “Sourdough” is hard to read: its color has 1.09:1 contrast with the background behind it, and text even this large needs at least 3:1.');
    expect(found.some(blocksSaving)).toBe(false);
    // The other card, with the theme's text on it, is fine; so is the first once its text is readable.
    expect(contrast(setStyle(s, 'n_card1', 'base', 'color', INK))).toEqual([]);
  });

  it('reads the colour and background from the text itself or the nearest element around it', () => {
    // Text colour on the text, background two levels up.
    let s = page([el('n_card', { base: { background: CARD } }, ['n_wrap']), el('n_wrap', undefined, ['n_t']), text('n_t', undefined, { base: { color: ACCENT } })]);
    expect(contrast(s).map((d) => d.nodeId)).toEqual(['n_t']);
    // A nearer opaque background covers the card's.
    s = page([el('n_card', { base: { background: CARD, color: ACCENT } }, ['n_band']), el('n_band', { base: { background: { token: 'color.inverse' } } }, ['n_t']), text('n_t')]);
    expect(contrast(s)).toEqual([]);
    // A text colour alone is read against the page background, at the top of the page.
    s = page([text('n_t', undefined, { base: { color: ACCENT } })]);
    expect(contrast(s).map((d) => d.message.match(/has ([\d.]+):1/)?.[1])).toEqual(['1.10']);
  });

  it('says the screen sizes and palette where it happens', () => {
    let s = page([el('n_card', { base: { background: CARD }, phone: { color: ACCENT } }, ['n_t']), text('n_t')]);
    expect(contrast(s)[0].message).toMatch(/^[^:]+: On phones, the text “Fresh bread every morning” is hard to read/);
    // Hidden on phones, it never shows to go wrong.
    s = setStyle(s, 'n_t', 'phone', 'hidden', true);
    expect(contrast(s)).toEqual([]);

    // A dark palette visitors can see is checked too: here only it fails.
    s = page([el('n_card', { base: { background: CARD, color: INK } }, ['n_t']), text('n_t')]);
    expect(contrast(s)).toEqual([]);
    s.tokens.colorSchemeMode = 'toggle';
    s.tokens.darkOverrides = { 'color.surface': '#1a1b19', 'color.text': '#222322' };
    expect(contrast(s).map((d) => d.message.replace(/^[^:]+: /, '').slice(0, 65))).toEqual(['In the dark palette, the text “Fresh bread every morning” is hard']);
    // A dark palette visitors never see is not.
    s.tokens.colorSchemeMode = 'single';
    expect(contrast(s)).toEqual([]);
  });

  it('lays a see-through colour over what is beneath it, and measures text that may be large against 3:1', () => {
    // Accent at 10% over the card is nearly the card: dark ink on it reads well.
    let s = page([el('n_card', { base: { background: CARD } }, ['n_tint']), el('n_tint', { base: { background: { token: 'color.accent', alpha: 0.1 } } }, ['n_t']), text('n_t', undefined, { base: { color: INK } })]);
    expect(contrast(s)).toEqual([]);
    // Muted text a touch too light: 3.5:1 fails body text and passes a heading.
    s = fresh();
    s.tokens.overrides['color.muted'] = '#8a8a86';
    s = page([el('n_card', { base: { background: CARD, color: { token: 'color.muted' } } }, ['n_p', 'n_h']), text('n_p'), text('n_h', 'Big news', undefined, { tag: 'h2' })], s);
    expect(contrast(s).map((d) => d.nodeId)).toEqual(['n_p']);
    // Body text at a large size needs only 3:1 too; small text at a heading's tag still may be large.
    expect(contrast(setStyle(s, 'n_p', 'base', 'fontSize', '28px'))).toEqual([]);
  });

  it('stays quiet where it can’t know the colours: a component’s own paint, custom CSS, a fade, a container width', () => {
    // Inside a placed section with no colour of the page's own, the section's tone decides: nothing is measured.
    let s = fresh();
    s = page([el('n_card', { base: { background: CARD } }, ['n_t']), text('n_t')], s, section(s));
    expect(contrast(s)).toEqual([]);
    // The theme's own colours alone are its pairs' to check.
    expect(contrast(page([el('n_box', undefined, ['n_t']), text('n_t')]))).toEqual([]);
    const failing = (styles: ResponsiveStyles) => contrast(page([el('n_card', { base: { background: CARD, color: ACCENT }, ...styles }, ['n_t']), text('n_t')]));
    expect(failing({})).toHaveLength(1);
    expect(failing({ desktop: { customCss: 'color: black;' } })).toEqual([]);
    expect(failing({ desktop: { opacity: 0.8 } })[0].message).toMatch(/: On phones and tablets, /);
    expect(failing({ 'cq-wide': { color: INK } } as ResponsiveStyles)).toEqual([]);
    // Hover styles are not read.
    expect(failing({ 'base:hover': { color: INK } } as ResponsiveStyles)).toHaveLength(1);
    // A colour this can't read.
    expect(contrast(page([el('n_card', { base: { background: 'linear-gradient(#fff, #eee)', color: ACCENT } }, ['n_t']), text('n_t')]))).toEqual([]);
  });

  it('leaves empty text and buttons alone', () => {
    expect(contrast(page([el('n_card', { base: { background: CARD, color: ACCENT } }, ['n_t']), text('n_t', '  ')]))).toEqual([]);
  });
});

describe('text over a background picture (#1489)', () => {
  const photo = (scrim?: string, color: unknown = INK) =>
    page([el('n_hero', { base: { layout: 'stack', backgroundImage: { assetId: 'as_dark', ...(scrim ? { scrim } : {}) }, color } as never }, ['n_t']), text('n_t', 'Open late')], withPhoto(fresh()));

  it('is a warning that it needs checking when the picture has no overlay', () => {
    const s = photo();
    const [d, ...rest] = contrast(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: 'warning', code: UNVERIFIED, owner: owner(s), nodeId: 'n_t' });
    expect(d.message).toBe(
      `${home(s).title}: The text “Open late” sits on a background picture with no overlay, so its contrast can’t be measured, and text is hard to read wherever the picture is close to its color. Add an overlay to the picture (Darken, say), or check that the text reads well across it.`
    );
    // Even with the theme's own text colour on it.
    expect(contrast(page([el('n_hero', { base: { backgroundImage: { assetId: 'as_dark' } } as never }, ['n_t']), text('n_t')], withPhoto(fresh()))).map((d) => d.code)).toEqual([UNVERIFIED]);
    // A card on the picture covers it.
    expect(contrast(page([el('n_hero', { base: { backgroundImage: { assetId: 'as_dark' } } as never }, ['n_card']), el('n_card', { base: { background: CARD } }, ['n_t']), text('n_t')], withPhoto(fresh())))).toEqual([]);
  });

  it('checks the text against its overlay: a solid one exactly, a see-through one over both light and dark parts', () => {
    expect(contrast(photo('#111111', { token: 'color.on-inverse' }))).toEqual([]);
    expect(contrast(photo('#111111')).map((d) => d.code)).toEqual([LOW]);
    // White on Darken strongly reads well over any picture; on Darken, the light parts of a picture can show through.
    expect(contrast(photo('rgba(0, 0, 0, 0.65)', '#ffffff'))).toEqual([]);
    const [d] = contrast(photo('rgba(0, 0, 0, 0.45)', '#ffffff'));
    expect(d.code).toBe(UNVERIFIED);
    expect(d.message).toContain('sits on a background picture its overlay lets show through, so where the picture is light it has as little as 3.');
    // A gradient overlay can't be measured.
    expect(contrast(photo('linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.7))', '#ffffff'))[0].message).toContain('with a gradient overlay, so its contrast can’t be measured');
  });
});

describe('the check as Project health runs it', () => {
  it('finds nothing in any starter of any theme', () => {
    for (const theme of listThemes())
      for (const starter of STARTERS) expect(contrast(createStarterState(starter.id, 'Site', false, theme.id)), `${theme.id} ${starter.id}`).toEqual([]);
  });

  it('is advice: kept by the validation cache for pages that did not change, and left out of what a save checks', () => {
    let s = page([el('n_card', { base: { background: CARD, color: ACCENT } }, ['n_t']), text('n_t')]);
    s = apply(s, [{ type: 'page.create', title: 'About', route: '/about' } as EditOperation]);
    const other = s.pages[Object.keys(s.pages).find((id) => id !== s.site.homePageId)!];
    other.nodes.n_other = text('n_other');
    other.rootIds.push('n_other');
    expect(validateState(s, { sectionLinks: false }).filter((d) => d.code === LOW)).toEqual([]);
    const cache = new ValidationCache();
    const low = (st: ProjectState) => adviceValidation(st, cache)[1].find((d) => d.code === LOW);
    const before = low(s);
    expect(before).toEqual(elementContrastDiagnostics(s)[0]);
    // Another page's content edited: the home page's finding is the very one kept.
    const about = Object.keys(s.pages).find((id) => id !== s.site.homePageId)!;
    s = apply(s, [{ type: 'node.setStyle', owner: { kind: 'page', id: about }, nodeId: 'n_other', scope: 'base', property: 'color', value: INK } as EditOperation]);
    expect(low(s)).toBe(before);
    // A site style the text uses changed: worked out again, and gone once readable.
    s = apply(s, [{ type: 'token.set', tokenId: 'color.accent', value: '#14181a' } as EditOperation]);
    expect(low(s)).toBeUndefined();
    expect(adviceValidation(s, cache)).toStrictEqual(adviceValidation(structuredClone(s)));
  });
});
