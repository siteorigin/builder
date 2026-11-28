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
import { bodyPaints, elementContrastDiagnostics } from '@engine/element-contrast';
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
/** A fresh site with the same site styles as `s`. */
const fresh2 = (s: ProjectState) => Object.assign(fresh(), { tokens: structuredClone(s.tokens) });
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
    // The text's own background is what it sits on: a highlight.
    s = page([el('n_card', { base: { background: { token: 'color.inverse' }, color: ACCENT } }, ['n_t']), text('n_t', undefined, { base: { background: CARD } })]);
    expect(contrast(s).map((d) => d.nodeId)).toEqual(['n_t']);
    // A card with no colour of its own keeps the colour around it: the theme's ink on a dark card.
    s = page([el('n_card', { base: { background: { token: 'color.inverse' } } }, ['n_t']), text('n_t')]);
    expect(contrast(s).map((d) => d.nodeId)).toEqual(['n_t']);
    // Positioned or moved away from its card, the text may be over anything: not measured.
    s = page([el('n_card', { base: { background: CARD, color: ACCENT } }, ['n_t']), text('n_t', undefined, { base: { position: 'absolute' } })]);
    expect(contrast(s)).toEqual([]);
    // An inset shadow paints over the card's background.
    s = page([el('n_card', { base: { background: CARD, color: ACCENT, shadow: 'inset 0 0 0 1000px #000' } }, ['n_t']), text('n_t')]);
    expect(contrast(s)).toEqual([]);
  });

  it('says the screen sizes and palette where it happens', () => {
    let s = page([el('n_card', { base: { background: CARD }, phone: { color: ACCENT } }, ['n_t']), text('n_t')]);
    expect(contrast(s)[0].message).toMatch(/^[^:]+: On phones, the text “Fresh bread every morning” is hard to read/);
    // Hidden on phones, it never shows to go wrong.
    s = setStyle(s, 'n_t', 'phone', 'hidden', true);
    expect(contrast(s)).toEqual([]);
    // Failing everywhere, but hidden on tablets and desktops and shown again on desktops.
    s = page([el('n_card', { base: { background: CARD, color: ACCENT }, tablet: { hidden: true } }, ['n_t']), text('n_t')]);
    expect(contrast(s).map((d) => d.message.match(/: (On [a-z ]+),/)?.[1])).toEqual(['On phones and desktops']);

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
    // Ink at 10% over the card is nearly the card: ink on it reads well (ink at full strength would be ink on ink).
    let s = page([el('n_card', { base: { background: CARD } }, ['n_tint']), el('n_tint', { base: { background: { token: 'color.text', alpha: 0.1 } } }, ['n_t']), text('n_t', undefined, { base: { color: INK } })]);
    expect(contrast(s)).toEqual([]);
    expect(contrast(setStyle(s, 'n_tint', 'base', 'background', INK)).map((d) => d.nodeId)).toEqual(['n_t']);
    // Muted text a touch too light: 3.5:1 fails body text and passes a heading.
    s = fresh();
    s.tokens.overrides['color.muted'] = '#8a8a86';
    s = page([el('n_card', { base: { background: CARD, color: { token: 'color.muted' } } }, ['n_p', 'n_h']), text('n_p'), text('n_h', 'Big news', undefined, { tag: 'h2' })], s);
    expect(contrast(s).map((d) => d.nodeId)).toEqual(['n_p']);
    // Body text at a large size needs only 3:1 too, as does one a large text style sizes.
    expect(contrast(setStyle(s, 'n_p', 'base', 'fontSize', '28px'))).toEqual([]);
    expect(contrast(setStyle(s, 'n_p', 'base', 'textStyle', { token: 'text.h1' }))).toEqual([]);
    // A text style at one size and a font size at another: which wins there is not read, so 3:1 is the bar.
    expect(contrast(setStyle(setStyle(s, 'n_p', 'base', 'fontSize', '14px'), 'n_p', 'desktop', 'textStyle', { token: 'text.h1' })).map((d) => d.message.match(/: (On [a-z ]+),/)?.[1])).toEqual([
      'On phones and tablets'
    ]);
    // Where sizes need different minimums, the message gives the higher.
    const mixed = contrast(setStyle(s, 'n_p', 'phone', 'fontSize', '28px'));
    expect(mixed.map((d) => d.message.match(/needs at least ([\d.]+):1/)?.[1])).toEqual(['4.5']);
  });

  it('stays quiet where it can’t know the colours: a component’s own paint, custom CSS, a fade, a container width', () => {
    // Inside a placed section with no text colour of the page's own, the section's tone decides: nothing is measured,
    // though the theme's ink on a dark card would fail at the top of the page.
    let s = fresh();
    s = page([el('n_card', { base: { background: { token: 'color.inverse' } } }, ['n_t']), text('n_t')], s, section(s));
    expect(contrast(s)).toEqual([]);
    // A part of the section hidden at some size may hold its content: nothing placed in it is read.
    s = fresh();
    const hiding = section(s);
    hiding.overrides = { container: { base: { hidden: true }, desktop: { hidden: false } } };
    expect(contrast(page([el('n_card', { base: { background: CARD, color: ACCENT } }, ['n_t']), text('n_t')], s, hiding))).toEqual([]);
    // The theme's own colours alone are its pairs' to check, however they read.
    s = fresh();
    s.tokens.overrides['color.text'] = '#f8f8f4';
    expect(contrast(page([el('n_box', undefined, ['n_t']), text('n_t')], s))).toEqual([]);
    const failing = (styles: ResponsiveStyles) => contrast(page([el('n_card', { base: { background: CARD, color: ACCENT }, ...styles }, ['n_t']), text('n_t')]));
    expect(failing({})).toHaveLength(1);
    // Custom CSS that may paint is read only where it applies.
    expect(failing({ desktop: { customCss: 'color: black;' } })[0].message).toMatch(/: On phones and tablets, /);
    expect(failing({ base: { background: CARD, color: ACCENT, customCss: 'box-shadow: inset 0 0 0 99px #000;' } })).toEqual([]);
    expect(failing({ desktop: { backdropBlur: '12px' } })[0].message).toMatch(/: On phones and tablets, /);
    expect(failing({ desktop: { backdropBlur: '0' } })[0].message).not.toMatch(/: On /);
    expect(failing({ desktop: { opacity: 0.8 } })[0].message).toMatch(/: On phones and tablets, /);
    expect(failing({ 'cq-wide': { color: INK } } as ResponsiveStyles)).toEqual([]);
    // Hover styles are not read.
    expect(failing({ 'base:hover': { color: INK } } as ResponsiveStyles)).toHaveLength(1);
    // A colour this can't read.
    expect(contrast(page([el('n_card', { base: { background: 'linear-gradient(#fff, #eee)', color: ACCENT } }, ['n_t']), text('n_t')]))).toEqual([]);
  });

  it('leaves alone text that may not show: empty, bound, conditional, in a collection’s items, or a button', () => {
    const inCard = (...nodes: GraphNode[]) => contrast(page([el('n_card', { base: { background: CARD, color: ACCENT } }, [nodes[0].id]), ...nodes]));
    expect(inCard(text('n_t', '  '))).toEqual([]);
    expect(inCard({ id: 'n_b', kind: 'link', link: { type: 'url', href: 'https://example.com' }, label: 'Order', appearance: 'primary' } as unknown as GraphNode)).toEqual([]);
    expect(inCard(text('n_t', undefined, undefined, { when: { $entry: 'title' } } as never))).toEqual([]);
    expect(inCard(text('n_t', undefined, undefined, { unless: { $entry: 'title' } } as never))).toEqual([]);
    expect(inCard({ id: 'n_loop', kind: 'repeat', list: { $query: { collection: 'posts' } }, children: ['n_t'] } as unknown as GraphNode, text('n_t'))).toEqual([]);
    expect(inCard(text('n_t', { $entry: 'title' } as never))).toEqual([]);
    expect(inCard(text('n_t'))).toHaveLength(1);
  });

  it('reads the header and footer while a page shows them', () => {
    const s = fresh();
    const header = s.site.shell.header;
    header.nodes.n_bar = el('n_bar', { base: { background: CARD, color: ACCENT } }, ['n_t']);
    header.nodes.n_t = text('n_t', 'Call us');
    header.rootIds.push('n_bar');
    expect(contrast(s).map((d) => [d.owner, d.nodeId])).toEqual([[{ kind: 'shell', id: 'header' }, 'n_t']]);
    for (const p of Object.values(s.pages)) p.showHeader = false;
    expect(contrast(s)).toEqual([]);
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
    // A card on the picture covers it; a nearly opaque one is measured over every colour the picture may have.
    const onCard = (background: unknown, color: unknown = INK) =>
      contrast(page([el('n_hero', { base: { backgroundImage: { assetId: 'as_dark' } } as never }, ['n_card']), el('n_card', { base: { background, color } as never }, ['n_t']), text('n_t')], withPhoto(fresh())));
    expect(onCard(CARD)).toEqual([]);
    expect(onCard('rgb(0 0 0 / 95%)', '#ffffff')).toEqual([]);
    expect(onCard('rgb(0 0 0 / 40%)', '#ffffff').map((d) => d.code)).toEqual([UNVERIFIED]);
    // A transparent card over it leaves the picture unmeasured.
    expect(onCard('transparent').map((d) => d.message.includes('with no overlay'))).toEqual([true]);
    // The card's own colour sits under its picture, which still needs checking.
    expect(contrast(page([el('n_hero', { base: { background: '#000000', backgroundImage: { assetId: 'as_dark' }, color: '#ffffff' } as never }, ['n_t']), text('n_t')], withPhoto(fresh()))).map((d) => d.code)).toEqual([UNVERIFIED]);
    // A picture the site can't show (a file it can't serve) paints nothing.
    const broken = withPhoto(fresh());
    broken.assets.assets.as_dark.file = 'static/assets/night photo.jpg';
    expect(contrast(page([el('n_hero', { base: { backgroundImage: { assetId: 'as_dark' } } as never }, ['n_t']), text('n_t')], broken))).toEqual([]);
    // Nor does one on desktops that the site can't show: the picture set for every size may still be there, under its overlay.
    const both = withPhoto(fresh());
    both.assets.assets.as_bad = { ...both.assets.assets.as_dark, id: 'as_bad', file: 'static/assets/bad name.jpg' };
    const hero = { base: { background: '#ffffff', color: '#ffffff', backgroundImage: { assetId: 'as_dark', scrim: '#000000' } }, desktop: { backgroundImage: { assetId: 'as_bad', scrim: '#000000' } } };
    expect(contrast(page([el('n_hero', hero as never, ['n_t']), text('n_t')], both))).toEqual([]);
  });

  it('checks the text against its overlay: a solid one exactly, a see-through one over both light and dark parts', () => {
    expect(contrast(photo('#111111', { token: 'color.on-inverse' }))).toEqual([]);
    expect(contrast(photo('#111111')).map((d) => d.code)).toEqual([LOW]);
    // White on Darken strongly reads well over any picture; on Darken, the light parts of a picture can show through.
    expect(contrast(photo('rgba(0, 0, 0, 0.65)', '#ffffff'))).toEqual([]);
    const [d] = contrast(photo('rgba(0, 0, 0, 0.45)', '#ffffff'));
    expect(d.code).toBe(UNVERIFIED);
    expect(d.message).toContain('sits on a background picture that shows through the color over it, so where the picture is light it has as little as 3.35:1 contrast, and text this size needs at least 4.5:1.');
    // Black text on a light overlay: the picture's dark parts are the ones to check.
    expect(contrast(photo('rgba(255, 255, 255, 0.75)', '#000000'))).toEqual([]);
    expect(contrast(photo('rgba(255, 255, 255, 0.45)', '#000000'))[0].message).toContain('where the picture is dark it has as little as 4.4');
    // Gray text on a light overlay matches some part of any picture, see-through or not.
    expect(contrast(photo('rgba(0, 0, 0, 0.1)', '#777777'))[0].message).toContain('where the picture is close to the text’s color it has as little as 1.00:1');
    expect(contrast(photo('rgba(0, 0, 0, 0.1)', 'rgba(119, 119, 119, 0.95)'))[0].message).toContain('where the picture is close to the text’s color it has as little as 1.0');
    // See-through text is measured over grounds the picture can give: never below what any of them makes.
    expect(contrast(photo('rgba(255, 0, 0, 0.99)', 'rgba(0, 147, 0, 0.5)'))[0].message).toMatch(/as little as 1\.(7|8)\d:1/);
    // A see-through card over a gradient overlay: what shows through can't be measured.
    const overGradient = page(
      [el('n_hero', { base: { backgroundImage: { assetId: 'as_dark', scrim: 'linear-gradient(#000000, #111111)' } } } as never, ['n_card']), el('n_card', { base: { background: 'rgb(0 0 0 / 40%)', color: '#ffffff' } }, ['n_t']), text('n_t')],
      withPhoto(fresh())
    );
    expect(contrast(overGradient).map((d) => d.message.includes('with a gradient overlay'))).toEqual([true]);
    // A gradient overlay can't be measured.
    expect(contrast(photo('linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.7))', '#ffffff'))[0].message).toContain('with a gradient overlay, so its contrast can’t be measured');
  });
});

describe('the check as Project health runs it', () => {
  it('starts a page from the theme’s colours only when its body rule paints with them alone', () => {
    const ok = 'body { margin: 0; background: var(--so-color-background); color: var( --so-color-text ); }';
    expect(bodyPaints(ok)).toBe(true);
    expect(bodyPaints('/* body */ ' + ok)).toBe(true);
    expect(bodyPaints('body { background: var(--so-color-background); background-color: #000; color: var(--so-color-text); }')).toBe(false);
    expect(bodyPaints(`${ok} @media (prefers-color-scheme: dark) { body { background: #000; } }`)).toBe(false);
    expect(bodyPaints('main body { background: var(--so-color-background); color: var(--so-color-text); }')).toBe(false);
    expect(bodyPaints('body { color: var(--so-color-text); }')).toBe(false);
    expect(bodyPaints('@media screen { body { background: var(--so-color-background); color: var(--so-color-text); } }')).toBe(false);
    expect(bodyPaints('body { background: #000 !important; background: var(--so-color-background); color: var(--so-color-text); }')).toBe(false);
    expect(bodyPaints('body { background: var(--so-color-background); color: var(--so-color-text); @media (prefers-color-scheme: dark) { background: #000; } }')).toBe(false);
    expect(bodyPaints('body { background: var(--so-color-BACKGROUND); color: var(--so-color-text); }')).toBe(false);
    expect(bodyPaints('body { --label: "x; background: var(--so-color-background)"; background: #000; color: var(--so-color-text); }')).toBe(false);
    // Read in one pass: a long stylesheet with no braces at its end is quick.
    const started = performance.now();
    expect(bodyPaints(`${ok}${'@layer a, b, c;'.repeat(40_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('measures rich text holding a heading against 3:1', () => {
    const s = fresh();
    s.tokens.overrides['color.muted'] = '#888888';
    const rich = (blocks: unknown) => ({ id: 'n_t', kind: 'text', tag: 'div', rich: true, text: blocks }) as unknown as TextNode;
    const card = { base: { background: '#ffffff', color: { token: 'color.muted' } } };
    expect(contrast(page([el('n_card', card, ['n_t']), rich([{ type: 'h3', spans: [{ text: 'Opening hours' }] }])], s))).toEqual([]);
    expect(contrast(page([el('n_card', card, ['n_t']), rich([{ type: 'p', spans: [{ text: 'Opening hours' }] }])], fresh2(s))).map((d) => d.code)).toEqual([LOW]);
  });

  it('measures an inherited bold weight as unknown once a text style and a size meet', () => {
    const s = fresh();
    s.tokens.overrides['color.muted'] = '#888888';
    const card = { base: { background: '#ffffff', color: { token: 'color.muted' }, textStyle: { token: 'text.h3' }, fontSize: '24px', fontWeight: '700' } };
    // #888 on white is 3.54:1: a 20px paragraph that may be bold needs only 3:1.
    expect(contrast(page([el('n_card', card as never, ['n_t']), text('n_t', undefined, { base: { fontSize: '20px' } })], s))).toEqual([]);
  });

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
    expect(before).toBeDefined();
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
