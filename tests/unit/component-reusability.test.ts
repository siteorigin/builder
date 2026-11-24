/**
 * Reusability warnings for project components (#363): content a placement should choose that is written into the
 * design, colors and spacing written as values where a site style applies, and repeated cards and pictures that are
 * not parts. Warnings never block a save, and the built-in Foundation components, read as project components, raise
 * none.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ProjectState, TokenDef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { BUILTIN_PACKS, FOUNDATION_PACK } from '@catalogue/builtin';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { P, item, prop, tok, type ComponentSpec } from '@catalogue/dsl';
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import { componentReusabilityDiagnostics, isMicroLabel, isReusabilityWarning } from '@engine/reusability';
import { effectiveTokens } from '@generator/index';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description' | 'componentId'> & { componentId?: string }): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', componentId: 'custom.test', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

const reusability = (s: ProjectState) => validateState(s).filter(isReusabilityWarning);
const where = (ds: Diagnostic[]) => ds.map((d) => [d.code, d.nodeId]);
const field = (d: Diagnostic) => JSON.parse(d.site!) as string[];

describe('the built-in Foundation components', () => {
  const managedDefs = FOUNDATION_PACK.components.filter((d) => d.kind === 'managed');
  const asProject = (pack: (typeof BUILTIN_PACKS)[number], componentId: string) => ({ ...structuredClone(pack.components.find((d) => d.componentId === componentId)!), owner: 'project' as const });

  it('raise no reusability warning, read as project components', () => {
    expect(managedDefs.length).toBeGreaterThan(15);
    for (const pack of BUILTIN_PACKS) {
      // Every check has site styles to compare with, so none passes by having nothing to suggest.
      expect(['color', 'space'].every((g) => pack.tokens.some((t) => t.group === g))).toBe(true);
      const found = pack.components.filter((d) => d.kind === 'managed').flatMap((d) => componentReusabilityDiagnostics({ ...structuredClone(d), owner: 'project' }, pack.tokens));
      expect(found.map((d) => d.message)).toEqual([]);
      // Each pack is really read: a fixed heading added to one of its components is reported.
      const features = asProject(pack, 'features.grid');
      (features.tree!.nodes.card as { children: string[] }).children.push('fixed');
      features.tree!.nodes.fixed = { id: 'fixed', kind: 'text', tag: 'h4', text: 'Popular' };
      expect(where(componentReusabilityDiagnostics(features, pack.tokens))).toEqual([['COMPONENT_UNBOUND_CONTENT', 'fixed']]);
    }
  });

  it('are still read: a part or a style taken away from one is reported', () => {
    const pages = asProject(FOUNDATION_PACK, 'content.pages');
    delete pages.parts.cardImage;
    expect(where(componentReusabilityDiagnostics(pages, FOUNDATION_PACK.tokens))).toEqual([['COMPONENT_PART_MISSING', 'card-image']]);
    // The team's portrait is the card's picture, so it needs its part.
    const team = asProject(FOUNDATION_PACK, 'team.grid');
    delete team.parts[Object.entries(team.parts).find(([, p]) => p.nodeId === 'portrait')![0]];
    expect(where(componentReusabilityDiagnostics(team, FOUNDATION_PACK.tokens))).toEqual([['COMPONENT_PART_MISSING', 'portrait']]);
    // The testimonial's 44px portrait beside a name is a detail; at 65px across it is the card's picture.
    const quotes = asProject(FOUNDATION_PACK, 'testimonials.grid');
    expect(Object.values(quotes.parts).some((p) => p.nodeId === 'portrait')).toBe(false);
    expect(componentReusabilityDiagnostics(quotes, FOUNDATION_PACK.tokens)).toEqual([]);
    quotes.tree!.nodes.portrait.styles = { base: { ...quotes.tree!.nodes.portrait.styles!.base, width: '64px' } };
    expect(componentReusabilityDiagnostics(quotes, FOUNDATION_PACK.tokens)).toEqual([]);
    quotes.tree!.nodes.portrait.styles = { base: { ...quotes.tree!.nodes.portrait.styles!.base, width: '65px' } };
    expect(where(componentReusabilityDiagnostics(quotes, FOUNDATION_PACK.tokens))).toEqual([['COMPONENT_PART_MISSING', 'portrait']]);
    // Small on phones but large from desktop up is not a detail.
    quotes.tree!.nodes.portrait.styles = { base: { ...quotes.tree!.nodes.portrait.styles!.base, width: '44px' }, desktop: { width: '320px' } };
    expect(where(componentReusabilityDiagnostics(quotes, FOUNDATION_PACK.tokens))).toEqual([['COMPONENT_PART_MISSING', 'portrait']]);
    // The news card is an article named Card, with only a gap of its own: still the card a placement restyles.
    const news = asProject(FOUNDATION_PACK, 'content.news');
    const card = Object.entries(news.parts).find(([, p]) => news.tree!.nodes[p.nodeId]?.name === 'Card')!;
    delete news.parts[card[0]];
    expect(where(componentReusabilityDiagnostics(news, FOUNDATION_PACK.tokens))).toEqual([['COMPONENT_PART_MISSING', card[1].nodeId]]);
    // A literal color in one is reported against the pack's own site styles. White is two site colors here (cards,
    // and text on brand), so neither is guessed.
    const features = asProject(FOUNDATION_PACK, 'features.grid');
    features.tree!.nodes.card.styles = { base: { ...features.tree!.nodes.card.styles?.base, background: '#ffffff' } };
    const [literal] = componentReusabilityDiagnostics(features, FOUNDATION_PACK.tokens);
    expect(literal.message).toContain('uses #ffffff for its background. Link it to one of the site colors');
  });

  it('are never reported in a project, which cannot change them', () => {
    const s = fresh();
    const theme = Object.values(s.components).find((d) => d.owner === 'theme' && d.componentId === 'features.grid')!;
    const nodes = theme.tree!.nodes;
    nodes.root.styles = { ...nodes.root.styles, base: { ...nodes.root.styles?.base, background: '#ff0000' } };
    nodes.fixed = { id: 'fixed', kind: 'text', tag: 'h2', text: 'Our services' };
    (nodes.root as { children: string[] }).children.push('fixed');
    for (const p of Object.keys(theme.parts)) if (theme.parts[p].nodeId === 'card') delete theme.parts[p];
    expect(reusability(s)).toEqual([]);
    // The same in a project's own copy is reported, all three kinds.
    s.components[theme.id] = { ...theme, owner: 'project' };
    expect(new Set(reusability(s).map((d) => d.code))).toEqual(new Set(['COMPONENT_LITERAL_STYLE', 'COMPONENT_UNBOUND_CONTENT', 'COMPONENT_PART_MISSING']));
  });
});

describe('content written into a design', () => {
  const build = (s: ProjectState) =>
    addDef(s, {
      name: 'Promo',
      properties: { heading: P.str('Heading', 'Hello'), link: P.link('Link'), image: P.image('Image'), level: P.choice('Level', 'span', [['span', 'Inline'], ['small', 'Small']]) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) =>
        b.el('root', 'section', { name: 'Section' }, [
          b.text('eyebrow', 'span', 'New this season', { name: 'Eyebrow' }),
          b.text('title', 'h2', 'Spring', { name: 'Title' }),
          b.text('bound-title', 'h2', prop('heading'), { name: 'Bound title' }),
          b.text('body', 'p', 'We design calm, practical homes for growing families.', { name: 'Body' }),
          b.rich('rich', ['Short rich copy.'], { name: 'Rich' }),
          b.text('separator', 'span', '·'),
          b.text('badge', prop('level'), 'Popular', { name: 'Badge' }),
          b.text('styled', 'p', 'Garden Studio', { name: 'Styled', styles: { textStyle: tok('text.h3') } }),
          b.text('legal', 'p', 'Prices include GST and are subject to change without notice.', { name: 'Shared legal note' }),
          b.text('not-shared', 'p', 'Prices include GST and are subject to change without notice.', { name: 'Not shared' }),
          b.image('photo', { assetId: null, alt: '' }, { name: 'Photo' }),
          b.image('bound-photo', prop('image'), { name: 'Bound photo' }),
          b.link('more', { type: 'page', target: 'pg_x' }, 'Read more', 'text', { name: 'More' }),
          b.link('nowhere', { type: 'none', target: '' }, prop('heading'), 'primary', { name: 'Nowhere' }),
          b.link('cta', prop('link'), 'Book your free design consultation today', 'primary', { name: 'Call to action' }),
          b.link('title-link', prop('link'), 'Garden Studio', 'plain', { name: 'Title link', styles: { textStyle: tok('text.h3') } }),
          b.link('bound', prop('link'), prop('heading'), 'primary', { name: 'Bound button' }),
          b.el('card', 'div', { name: 'Linked card', link: { type: 'url', target: 'https://example.com' } }, []),
          b.el('viewer', 'div', { name: 'Viewer', link: { type: 'url', target: 'https://example.com' }, action: 'image' }, []),
          b.el('no-link', 'div', { name: 'No link', link: { type: 'none', target: '' } }, [])
        ])
    });

  it('flags headings, body copy, pictures and destinations, each on its own element', () => {
    const s = fresh();
    const def = build(s);
    const found = reusability(s);
    expect(found.every((d) => d.code === 'COMPONENT_UNBOUND_CONTENT' && d.severity === 'warning' && d.owner?.id === def.id)).toBe(true);
    expect(found.map((d) => [d.nodeId, field(d)[2]])).toEqual([
      ['title', 'text'],
      ['body', 'text'],
      ['rich', 'text'],
      ['styled', 'text'],
      ['not-shared', 'text'],
      ['photo', 'image'],
      ['more', 'link'],
      ['nowhere', 'link'],
      ['cta', 'label'],
      ['title-link', 'label'],
      ['card', 'link']
    ]);
    const message = (id: string) => found.find((d) => d.nodeId === id)!.message;
    expect(message('title')).toBe('Promo: the heading “Spring” is written into the design, so every placement shows the same words. Bind its text to a text property, with these words as the default, or name the layer “Shared …” if it is meant to be the same everywhere.');
    expect(message('rich')).toContain('Bind its text to a rich text property');
    expect(message('styled')).toContain('the heading “Garden Studio”');
    expect(message('more')).toContain('where the “Read more” button goes is set in the design, so every placement links to the same place');
    expect(message('nowhere')).toContain('the button “Nowhere” has no destination in the design, and placements cannot give it one');
    expect(message('title-link')).toContain('the link text “Garden Studio” is written into the design');
  });

  it('leaves short labels, separators, bound fields and shared layers alone', () => {
    expect(isMicroLabel('New this season')).toBe(true);
    expect(isMicroLabel('one two three four')).toBe(true);
    expect(isMicroLabel('one two three four five')).toBe(false);
    expect(isMicroLabel('x'.repeat(32))).toBe(true);
    expect(isMicroLabel('x'.repeat(33))).toBe(false);
    expect(isMicroLabel('/ month')).toBe(true);
    expect(isMicroLabel('—', true)).toBe(true);
    expect(isMicroLabel('Spring', true)).toBe(false);
    const s = fresh();
    build(s);
    const flagged = new Set(reusability(s).map((d) => d.nodeId));
    // The badge's tag is bound to inline tags only, so it is a label, not a heading; a container's link that its fixed
    // action never follows, or that goes nowhere, is not a destination.
    for (const id of ['eyebrow', 'bound-title', 'separator', 'badge', 'legal', 'bound-photo', 'bound', 'viewer', 'no-link']) expect(flagged.has(id)).toBe(false);
  });

  it('asks for a list item field inside a list', () => {
    const s = fresh();
    addDef(s, {
      name: 'Cards',
      properties: { items: P.list('Cards', 'Card', { title: P.str('Title', '') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' }, card: { nodeId: 'card', label: 'Card' } },
      build: (b) => b.el('root', 'section', {}, [b.repeat('cards', 'items', [b.el('card', 'div', { name: 'Card' }, [b.text('title', 'h3', 'Service', { name: 'Title' }), b.text('text', 'p', item('title'))])])])
    });
    const found = reusability(s);
    expect(where(found)).toEqual([['COMPONENT_UNBOUND_CONTENT', 'title']]);
    expect(found[0].message).toContain('every item of every placement shows the same words. Bind its text to a text field of the list item');
  });
});

describe('literal colors and spacing', () => {
  const build = (s: ProjectState) =>
    addDef(s, {
      name: 'Banner',
      properties: { heading: P.str('Heading', 'Hello') },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      variantAxes: { tone: { label: 'Tone', default: 'light', options: { light: { label: 'Light' }, dark: { label: 'Dark', styles: { root: { base: { background: '#14211d' } } } } } } },
      build: (b) =>
        b.el('root', 'section', { name: 'Section', styles: { base: { background: '#1f5a4c', color: 'rgb(255 255 255)', gap: '24px', paddingBlock: '20px' }, tablet: { gap: '1.5rem' } } }, [
          b.el('inner', 'div', { name: 'Inner', styles: { gap: '2px', marginBlockStart: 'auto', marginBlockEnd: '-12px', paddingInline: '0', maxWidth: '640px', background: 'color-mix(in srgb, var(--so-color-brand) 10%, transparent)', color: 'inherit' } }, [
            b.text('badge', 'span', prop('heading'), { name: 'Badge', styles: { paddingBlock: '4px', paddingInline: '10px', marginBlockEnd: '16px', background: tok('color.brand') } }),
            b.text('body', 'p', prop('heading'), { name: 'Body', styles: { paddingBlock: '24px' } }),
            b.el('measure', 'div', { name: 'Measure', styles: { maxWidth: '720px' } }, [])
          ])
        ])
    });

  it('flags hex and rgb colors and spacing lengths, naming the matching site style', () => {
    const s = fresh();
    build(s);
    const found = reusability(s);
    expect(found.every((d) => d.code === 'COMPONENT_LITERAL_STYLE')).toBe(true);
    expect(found.map((d) => [d.nodeId, ...field(d).slice(2)])).toEqual([
      ['root', 'own', 'base', 'background'],
      ['root', 'own', 'base', 'color'],
      ['root', 'own', 'base', 'gap'],
      ['root', 'own', 'base', 'paddingBlock'],
      ['root', 'own', 'tablet', 'gap'],
      ['badge', 'own', 'base', 'marginBlockEnd'],
      ['body', 'own', 'base', 'paddingBlock'],
      ['measure', 'own', 'base', 'maxWidth'],
      ['root', 'variant:tone:dark', 'base', 'background']
    ]);
    const tokens = effectiveTokens(s);
    const brand = tokens.find((t) => t.id === 'color.brand')!;
    expect(brand.value).toBe('#1f5a4c');
    const byKey = (...key: string[]) => found.find((d) => JSON.stringify(field(d).slice(0, key.length)) === JSON.stringify(key))!.message;
    expect(byKey('root', 'style', 'own', 'base', 'background')).toBe('Banner: “Section” uses #1f5a4c for its background. Link it to the site style “Brand” (color.brand), so it follows Site styles.');
    expect(byKey('root', 'style', 'own', 'base', 'gap')).toBe('Banner: “Section” uses 24px for its gap. Link it to the site style “Large” (space.lg), so it follows the site’s spacing.');
    expect(byKey('root', 'style', 'own', 'tablet', 'gap')).toContain('uses 1.5rem for its gap on tablets. Link it to the site style “Large” (space.lg)');
    expect(byKey('root', 'style', 'own', 'base', 'paddingBlock')).toContain('uses 20px for its vertical padding. Link it to one of the spacing styles');
    expect(byKey('measure')).toContain('uses 720px for its max width. Link it to the site style “Reading width” (container.reading)');
    expect(byKey('root', 'style', 'variant:tone:dark')).toContain('for its background in the “Dark” tone variant');
  });

  it('matches colors by value through linked site styles, in any notation', () => {
    const s = fresh();
    build(s);
    s.tokens.custom.push({ id: 'color.ink', label: 'Ink', group: 'color', value: 'rgb(1 2 3)' }, { id: 'color.ink-link', label: 'Ink (linked)', group: 'color', value: { token: 'color.ink' } } as TokenDef);
    const def = Object.values(s.components).find((d) => d.name === 'Banner')!;
    def.tree!.nodes.root.styles!.base!.color = '#010203';
    const color = reusability(s).find((d) => d.nodeId === 'root' && field(d)[4] === 'color')!;
    // Both the style and the one that follows it resolve to the same color, so neither is guessed.
    expect(color.message).toContain('uses #010203 for its text color. Link it to one of the site colors');
    s.tokens.custom.pop();
    expect(reusability(s).find((d) => d.nodeId === 'root' && field(d)[4] === 'color')!.message).toContain('Link it to the site style “Ink” (color.ink)');
  });

  it('leaves keywords, mixes, resets, unmatched sizes, hairlines, pulls and a chip’s own padding alone', () => {
    const s = fresh();
    build(s);
    const nodes = new Set(reusability(s).map((d) => `${d.nodeId}|${field(d)[4]}`));
    for (const k of ['inner|gap', 'inner|marginBlockStart', 'inner|marginBlockEnd', 'inner|paddingInline', 'inner|maxWidth', 'inner|background', 'inner|color', 'badge|paddingBlock', 'badge|paddingInline', 'badge|background'])
      expect(nodes.has(k)).toBe(false);
  });

  it('keeps the hairline floor whatever the spacing scale', () => {
    const s = fresh();
    build(s);
    // A spacing scale that starts at 8px still has nothing for 6px, which is flagged; one that adds 1px still leaves 2px alone.
    s.tokens.overrides['space.2xs'] = '8px';
    s.tokens.custom.push({ id: 'space.hair', label: 'Hairline', group: 'space', value: '1px' });
    const def = Object.values(s.components).find((d) => d.name === 'Banner')!;
    def.tree!.nodes.root.styles!.base!.gap = '6px';
    const keys = new Set(reusability(s).map((d) => `${d.nodeId}|${field(d)[3]}|${field(d)[4]}`));
    expect(keys.has('root|base|gap')).toBe(true);
    expect(keys.has('inner|base|gap')).toBe(false);
  });

  it('flags each kind only where the project has a site style of that kind', () => {
    const s = fresh();
    const def = build(s);
    const all = effectiveTokens(s);
    const codesFor = (tokens: TokenDef[]) => componentReusabilityDiagnostics(def, tokens).map((d) => field(d)[4]);
    expect(codesFor(all.filter((t) => t.group !== 'color' && t.group !== 'space' && t.group !== 'container'))).toEqual([]);
    // Without colors, spacing is still flagged, and the other way round.
    expect(codesFor(all.filter((t) => t.group !== 'color'))).toEqual(['gap', 'paddingBlock', 'gap', 'marginBlockEnd', 'paddingBlock', 'maxWidth']);
    expect(codesFor(all.filter((t) => t.group !== 'space' && t.group !== 'container'))).toEqual(['background', 'color', 'background']);
  });
});

describe('repeated cards and pictures', () => {
  const build = (s: ProjectState, parts: ComponentSpec['parts']) =>
    addDef(s, {
      name: 'Team',
      properties: { people: P.list('People', 'Person', { name: P.str('Name', ''), photo: P.image('Photo'), avatar: P.image('Avatar'), link: P.link('Link'), icon: P.icon('Icon', 'star') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' }, ...parts },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('people', 'people', [
            b.el('wrap', 'li', { name: 'Item' }, [
              b.el('card', 'div', { name: 'Person', styles: { background: tok('color.surface'), radius: tok('radius.lg') } }, [
                b.el('frame', 'div', { name: 'Frame' }, [b.image('photo', item('photo'), { name: 'Photo' })]),
                b.image('avatar', item('avatar'), { name: 'Avatar', styles: { width: '40px' } }),
                b.text('name', 'h3', item('name'), { name: 'Name' })
              ])
            ])
          ]),
          b.repeat('plain', 'people', [b.el('row', 'div', { name: 'Row' }, [b.text('row-name', 'p', item('name')), b.image('row-photo', item('avatar'), { styles: { maxHeight: '48px' } })])]),
          // An icon beside a link is a navigation row, not a card.
          b.repeat('nav', 'people', [b.el('nav-row', 'div', { name: 'Nav row' }, [b.icon('nav-icon', item('icon')), b.link('nav-link', item('link'), item('name'), 'plain')])]),
          // A styled card holding one exposed element is still a card of its own.
          b.repeat('tiles', 'people', [b.el('tile', 'div', { name: 'Tile', styles: { border: tok('border.default') } }, [b.text('tile-name', 'p', item('name'))])])
        ])
    });

  it('flags a styled card, a picture, an unexposed plain item, and a card with one exposed child', () => {
    const s = fresh();
    build(s, { tileName: { nodeId: 'tile-name', label: 'Name' } });
    const found = reusability(s);
    expect(where(found)).toEqual([
      ['COMPONENT_PART_MISSING', 'card'],
      ['COMPONENT_PART_MISSING', 'photo'],
      ['COMPONENT_PART_MISSING', 'row'],
      ['COMPONENT_PART_MISSING', 'tile']
    ]);
    expect(found[0].message).toBe('Team: “Person” is repeated for each list item, but it is not one of the component’s parts, so placements cannot restyle it. Add it to the parts.');
    expect(found[1].message).toContain('the image “Photo” is repeated for each list item');
  });

  it('is satisfied by parts on the card and the picture, or a frame that crops it, matched by element', () => {
    const s = fresh();
    build(s, { person: { nodeId: 'card', label: 'Card' }, media: { nodeId: 'photo', label: 'Photo' }, rowName: { nodeId: 'row-name', label: 'Name' }, tile: { nodeId: 'tile', label: 'Tile' } });
    expect(reusability(s)).toEqual([]);
    const framed = fresh();
    build(framed, { person: { nodeId: 'card', label: 'Card' }, media: { nodeId: 'frame', label: 'Photo frame', styleControls: ['aspectRatio', 'radius'] }, rowName: { nodeId: 'row-name', label: 'Name' }, tile: { nodeId: 'tile', label: 'Tile' } });
    expect(reusability(framed)).toEqual([]);
    // A frame part that cannot change the crop does not stand in for the picture.
    const spaced = fresh();
    build(spaced, { person: { nodeId: 'card', label: 'Card' }, media: { nodeId: 'frame', label: 'Photo frame', styleControls: ['gap'] }, rowName: { nodeId: 'row-name', label: 'Name' }, tile: { nodeId: 'tile', label: 'Tile' } });
    expect(where(reusability(spaced))).toEqual([['COMPONENT_PART_MISSING', 'photo']]);
  });
});

describe('hand-edited definitions', () => {
  it('never stop the project being checked', () => {
    const s = fresh();
    const def = addDef(s, {
      name: 'Odd',
      properties: { items: P.list('Items', 'Item', { title: P.str('Title', '') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      variantAxes: { tone: { label: 'Tone', default: 'a', options: { a: { label: 'A' }, b: { label: 'B', styles: { root: { base: { gap: '24px' } } } } } } },
      build: (b) => b.el('root', 'section', {}, [b.repeat('list', 'items', [b.el('loop', 'div', {}, [])])])
    });
    // A container that holds itself, a label that is not text, and styles and links of the wrong shape.
    (def.tree!.nodes.loop as { children: string[] }).children = ['loop'];
    (def.variantAxes!.tone as { label: unknown }).label = 123;
    (def.variantAxes!.tone.options.b as { label: unknown }).label = null;
    def.tree!.nodes.root.styles = { base: { gap: { $prop: 'x' } as never, paddingBlock: null as never }, phone: 'wide' as never };
    (def.tree!.nodes.root as { link: unknown }).link = null;
    const found = validateState(s);
    expect(found.some((d) => d.code === 'NODE_SHARED')).toBe(true);
    // Only the variant's gap is a finding, named by the axis and option IDs since their labels are not text.
    expect(found.filter(isReusabilityWarning).map((d) => d.message)).toEqual(['Odd: a container uses 24px for its gap in the “b” tone variant. Link it to the site style “Large” (space.lg), so it follows the site’s spacing.']);
  });
});

describe('hand-edited values the checks read', () => {
  it('read links, labels and styles of any shape without failing', () => {
    const s = fresh();
    const def = addDef(s, {
      name: 'Odd links',
      properties: { items: P.list('Items', 'Item', { title: P.str('Title', '') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.link('weird', { type: 'url', target: 'x' }, 'Go', 'primary'),
          b.el('box', 'div', { link: { type: 'url', target: 'x' } }, []),
          b.text('styled', 'p', 'Garden Studio', { styles: { textStyle: 'text.h3' } }),
          b.repeat('list', 'items', [b.el('a', 'div', {}, [b.el('b', 'div', {}, [])])])
        ])
    });
    const nodes = def.tree!.nodes as unknown as Record<string, Record<string, unknown>>;
    const unprintable = { toString: null, valueOf: null };
    nodes.weird.link = { type: 'url', target: unprintable };
    nodes.weird.label = unprintable;
    nodes.weird.appearance = unprintable;
    nodes.box.link = { type: 'url', target: unprintable };
    // Two containers that hold each other inside a list item.
    (nodes.b as { children: string[] }).children = ['a'];
    const found = componentReusabilityDiagnostics(def, effectiveTokens(s));
    // The heading style named by its ID alone still makes the short title a heading.
    expect(where(found)).toEqual([
      ['COMPONENT_UNBOUND_CONTENT', 'weird'],
      ['COMPONENT_UNBOUND_CONTENT', 'styled']
    ]);
    expect(found[0].message).toContain('has no destination in the design');
  });

  it('read a card that wraps one element, and pictures sized differently by width or variant', () => {
    const s = fresh();
    const def = addDef(s, {
      name: 'Grid',
      properties: { items: P.list('Items', 'Item', { title: P.str('Title', ''), photo: P.image('Photo') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' }, inner: { nodeId: 'inner', label: 'Inner' }, framed: { nodeId: 'frame-all', label: 'Frame', styleControls: [] }, fit: { nodeId: 'frame-fit', label: 'Frame', styleControls: ['objectFit'] } },
      variantAxes: { size: { label: 'Size', default: 'small', options: { small: { label: 'Small' }, large: { label: 'Large', styles: { 'grows-variant': { base: { width: '320px' } }, 'lifted': { base: { maxWidth: '320px' } } } } } } },
      build: (b) =>
        b.el('root', 'section', {}, [
          // An article holding one exposed element is still the card.
          b.repeat('cards', 'items', [b.el('card', 'article', {}, [b.el('inner', 'div', {}, [b.text('t', 'p', item('title'))])])]),
          b.repeat('pics', 'items', [
            b.el('pic', 'div', { name: 'Pic', styles: { border: tok('border.default') } }, [
              b.image('grows', item('photo'), { styles: { base: { width: '40px' }, desktop: { width: 'fill' } } }),
              b.image('capped', item('photo'), { styles: { base: { maxWidth: '40px' }, desktop: { width: '320px' } } }),
              b.image('grows-variant', item('photo'), { styles: { width: '40px' } }),
              // Capped by its own maximum, until a variant lifts the maximum at the width that grows it.
              b.image('lifted', item('photo'), { styles: { base: { width: '40px', maxWidth: '40px' }, desktop: { width: '320px' } } }),
              b.el('frame-all', 'div', {}, [b.image('in-all', item('photo'))]),
              b.el('frame-fit', 'div', {}, [b.image('in-fit', item('photo'))])
            ])
          ])
        ])
    });
    def.parts.pic = { nodeId: 'pic', label: 'Pic' };
    expect(where(componentReusabilityDiagnostics(def, effectiveTokens(s)))).toEqual([
      ['COMPONENT_PART_MISSING', 'card'],
      ['COMPONENT_PART_MISSING', 'grows'],
      ['COMPONENT_PART_MISSING', 'grows-variant'],
      ['COMPONENT_PART_MISSING', 'lifted'],
      ['COMPONENT_PART_MISSING', 'in-fit']
    ]);
  });

  it('leave a hairline alone even where a spacing style matches it exactly', () => {
    const s = fresh();
    s.tokens.custom.push({ id: 'space.hair', label: 'Hairline', group: 'space', value: '2px' });
    const def = addDef(s, { name: 'Lines', properties: {}, parts: { root: { nodeId: 'root', label: 'Section' } }, build: (b) => b.el('root', 'section', { styles: { gap: '2px', rowGap: '0em' } }, []) });
    expect(componentReusabilityDiagnostics(def, effectiveTokens(s))).toEqual([]);
  });
});

describe('as diagnostics', () => {
  const promo = (s: ProjectState) =>
    addDef(s, {
      name: 'Promo',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'section', { styles: { gap: '24px' } }, [b.text('title', 'h2', 'Spring')])
    });

  it('never block a save, and are not worked out for one', () => {
    const s = fresh();
    promo(s);
    const found = validateState(s).filter(isReusabilityWarning);
    expect(found).toHaveLength(2);
    expect(found.some(blocksSaving)).toBe(false);
    expect(validateState(s, { sectionLinks: false }).filter(isReusabilityWarning)).toEqual([]);
  });

  it('keep their identity through a rename or an edit, and count one more at another element as new', () => {
    const s = fresh();
    const def = promo(s);
    const before = validateState(s).filter(isReusabilityWarning);
    const after = structuredClone(s);
    after.components[def.id].name = 'Spring promo';
    (after.components[def.id].tree!.nodes.title as { text: string }).text = 'Summer';
    after.components[def.id].tree!.nodes.root.styles = { base: { gap: '25px' } };
    const renamed = validateState(after).filter(isReusabilityWarning);
    expect(renamed.map((d) => [d.code, d.nodeId, d.site])).toEqual(before.map((d) => [d.code, d.nodeId, d.site]));
    expect(introducedDiagnostics(before, renamed)).toEqual([]);
    // The same words on a second heading are a second warning.
    const more = structuredClone(after);
    const tree = more.components[def.id].tree!;
    tree.nodes.sub = { id: 'sub', kind: 'text', tag: 'h3', text: 'Summer' };
    (tree.nodes.root as { children: string[] }).children.push('sub');
    expect(introducedDiagnostics(renamed, validateState(more)).map((d) => d.nodeId)).toEqual(['sub']);
  });
});

describe('what an AI run is told', () => {
  it('names only what a change brought in on the components it changed', async () => {
    const { changedComponents, introducedReusability, reusabilityNudge } = await import('@agent/reusability');
    const s = fresh();
    const spec = (componentId: string) => ({ componentId, name: componentId, properties: {}, parts: { root: { nodeId: 'root', label: 'Section' } }, build: (b: Parameters<ComponentSpec['build']>[0]) => b.el('root', 'section', {}, [b.text('title', 'h2', 'Spring')]) });
    const a = addDef(s, spec('custom.a'));
    const b = addDef(s, spec('custom.b'));
    const before = validateState(s);
    const after = structuredClone(s);
    const tree = after.components[a.id].tree!;
    tree.nodes.more = { id: 'more', kind: 'text', tag: 'p', text: 'Every engagement is different, and so is every home.' };
    (tree.nodes.root as { children: string[] }).children.push('more');
    // B gets a warning too; told only A changed, the run hears of A's alone.
    after.components[b.id].tree!.nodes.root.styles = { base: { background: '#123456' } };
    // Key order alone is no change.
    const reordered = after.components[a.id];
    after.components[a.id] = Object.fromEntries(Object.entries(reordered).reverse()) as typeof reordered;
    const changed = changedComponents(s, after);
    expect([...changed].sort()).toEqual([a.id, b.id].sort());
    const onlyA = new Set([a.id]);
    expect(introducedReusability(before, validateState(after), onlyA).map((d) => [d.owner?.id, d.nodeId])).toEqual([[a.id, 'more']]);
    const unchanged = structuredClone(s);
    unchanged.components[a.id] = Object.fromEntries(Object.entries(unchanged.components[a.id]).reverse()) as typeof reordered;
    expect([...changedComponents(s, unchanged)]).toEqual([]);
    expect(reusabilityNudge(introducedReusability(before, validateState(after), onlyA))).toContain(`(component ${a.id}, node more)`);
  });
});
