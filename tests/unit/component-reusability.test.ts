/**
 * Reusability warnings for project components (#363): content a placement should choose that is written into the
 * design, colors and spacing written as values where a site style applies, and repeated cards and pictures that are
 * not parts. Warnings never block a save, and the built-in Foundation components, read as project components, raise
 * none.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ProjectState } from '@shared/types';
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
const at = (ds: Diagnostic[], code: string) => ds.filter((d) => d.code === code).map((d) => d.nodeId);

describe('the built-in Foundation components', () => {
  const managedDefs = FOUNDATION_PACK.components.filter((d) => d.kind === 'managed');

  it('raise no reusability warning, read as project components', () => {
    expect(managedDefs.length).toBeGreaterThan(15);
    for (const pack of BUILTIN_PACKS) {
      // Every check has site styles to compare with, so none passes by having nothing to suggest.
      expect(['color', 'space'].every((g) => pack.tokens.some((t) => t.group === g))).toBe(true);
      const found = pack.components.filter((d) => d.kind === 'managed').flatMap((d) => componentReusabilityDiagnostics({ ...structuredClone(d), owner: 'project' }, pack.tokens));
      expect(found.map((d) => d.message)).toEqual([]);
    }
  });

  it('are still read: a part taken away from one is reported', () => {
    // Without this the check above could pass by reading nothing.
    const pages = structuredClone(managedDefs.find((d) => d.componentId === 'content.pages')!);
    delete pages.parts.cardImage;
    const team = structuredClone(managedDefs.find((d) => d.componentId === 'team.grid')!);
    const portrait = Object.entries(team.parts).find(([, p]) => p.nodeId === 'portrait')![0];
    delete team.parts[portrait];
    expect(componentReusabilityDiagnostics({ ...pages, owner: 'project' }, FOUNDATION_PACK.tokens).map((d) => [d.code, d.nodeId])).toEqual([['COMPONENT_PART_MISSING', 'card-image']]);
    // The team's portrait is the card's picture; the 44px testimonial portrait beside a name is a detail, and stays quiet.
    expect(componentReusabilityDiagnostics({ ...team, owner: 'project' }, FOUNDATION_PACK.tokens).map((d) => [d.code, d.nodeId])).toEqual([['COMPONENT_PART_MISSING', 'portrait']]);
    // And a literal color in one is reported, against the pack's own site styles.
    const features = structuredClone(managedDefs.find((d) => d.componentId === 'features.grid')!);
    features.tree!.nodes.card.styles = { base: { ...features.tree!.nodes.card.styles?.base, background: '#ffffff' } };
    const [literal] = componentReusabilityDiagnostics({ ...features, owner: 'project' }, FOUNDATION_PACK.tokens);
    expect(literal.code).toBe('COMPONENT_LITERAL_STYLE');
    // White is two site colors here (cards and text on brand), so neither is guessed.
    expect(literal.message).toContain('uses #ffffff for its background. Link it to one of the site colors');
  });

  it('are never reported in a project, which cannot change them', () => {
    const s = fresh();
    const theme = Object.values(s.components).find((d) => d.owner === 'theme' && d.kind === 'managed' && d.tree)!;
    const root = theme.tree!.nodes[theme.tree!.rootIds[0]];
    root.styles = { ...root.styles, base: { ...root.styles?.base, background: '#ff0000' } };
    expect(reusability(s)).toEqual([]);
    // The same change in a project's own copy is.
    s.components[theme.id] = { ...theme, owner: 'project' };
    expect(reusability(s).map((d) => d.code)).toEqual(['COMPONENT_LITERAL_STYLE']);
  });
});

describe('content written into a design', () => {
  const build = (s: ProjectState) =>
    addDef(s, {
      name: 'Promo',
      properties: { heading: P.str('Heading', 'Hello'), link: P.link('Link'), image: P.image('Image') },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) =>
        b.el('root', 'section', { name: 'Section' }, [
          b.text('eyebrow', 'span', 'New this season', { name: 'Eyebrow' }),
          b.text('title', 'h2', 'Spring', { name: 'Title' }),
          b.text('bound-title', 'h2', prop('heading'), { name: 'Bound title' }),
          b.text('body', 'p', 'We design calm, practical homes for growing families.', { name: 'Body' }),
          b.rich('rich', ['A paragraph of sample copy.'], { name: 'Rich' }),
          b.text('separator', 'span', '·'),
          b.text('legal', 'p', 'Prices include GST and are subject to change without notice.', { name: 'Shared legal note' }),
          b.image('photo', { assetId: null, alt: '' }, { name: 'Photo' }),
          b.image('bound-photo', prop('image'), { name: 'Bound photo' }),
          b.link('more', { type: 'page', target: 'pg_x' }, 'Read more', 'text', { name: 'More' }),
          b.link('cta', prop('link'), 'Book your free design consultation today', 'primary', { name: 'Call to action' }),
          b.link('bound', prop('link'), prop('heading'), 'primary', { name: 'Bound button' }),
          b.el('card', 'div', { name: 'Linked card', link: { type: 'url', target: 'https://example.com' } }, [])
        ])
    });

  it('flags headings, body copy, pictures and destinations, each on its own element', () => {
    const s = fresh();
    const def = build(s);
    const found = reusability(s);
    expect(found.every((d) => d.code === 'COMPONENT_UNBOUND_CONTENT' && d.severity === 'warning' && d.owner?.id === def.id)).toBe(true);
    expect(found.map((d) => [d.nodeId, JSON.parse(d.site!)[2]])).toEqual([
      ['title', 'text'],
      ['body', 'text'],
      ['rich', 'text'],
      ['photo', 'image'],
      ['more', 'link'],
      ['cta', 'label'],
      ['card', 'link']
    ]);
    expect(found[0].message).toBe('Promo: the heading “Spring” is written into the design, so every placement shows the same words. Bind its text to a text property, with these words as the default, or name the layer “Shared …” if it is meant to be the same everywhere.');
    expect(found.find((d) => d.nodeId === 'more')!.message).toContain('where the “Read more” button goes is set in the design');
  });

  it('leaves short labels, separators, bound fields and shared layers alone', () => {
    expect(isMicroLabel('New this season')).toBe(true);
    expect(isMicroLabel('/ month')).toBe(true);
    expect(isMicroLabel('—')).toBe(true);
    expect(isMicroLabel('Spring', true)).toBe(false);
    expect(isMicroLabel('Five words is too many here')).toBe(false);
    const s = fresh();
    build(s);
    const flagged = new Set(reusability(s).map((d) => d.nodeId));
    for (const id of ['eyebrow', 'bound-title', 'separator', 'legal', 'bound-photo', 'bound']) expect(flagged.has(id)).toBe(false);
  });

  it('asks for a list item field inside a list', () => {
    const s = fresh();
    addDef(s, {
      name: 'Cards',
      properties: { items: P.list('Cards', 'Card', { title: P.str('Title', '') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' }, card: { nodeId: 'card', label: 'Card' } },
      build: (b) => b.el('root', 'section', {}, [b.repeat('cards', 'items', [b.el('card', 'div', { name: 'Card' }, [b.text('title', 'h3', 'Service', { name: 'Title' }), b.text('text', 'p', item('title'))])])])
    });
    const [d] = reusability(s);
    expect(d.nodeId).toBe('title');
    expect(d.message).toContain('every item of every placement shows the same words. Bind its text to a text field of the list item');
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
          b.el('inner', 'div', { name: 'Inner', styles: { gap: '2px', marginBlockStart: 'auto', paddingInline: '0', maxWidth: '640px', background: 'color-mix(in srgb, var(--so-color-brand) 10%, transparent)', color: 'inherit' } }, [
            b.text('badge', 'span', prop('heading'), { name: 'Badge', styles: { paddingBlock: '4px', paddingInline: '10px', marginBlockEnd: '16px', background: tok('color.brand') } })
          ])
        ])
    });

  it('flags hex and rgb colors and spacing lengths, naming the matching site style', () => {
    const s = fresh();
    build(s);
    const found = reusability(s);
    expect(found.every((d) => d.code === 'COMPONENT_LITERAL_STYLE')).toBe(true);
    expect(found.map((d) => JSON.parse(d.site!).slice(1))).toEqual([
      ['style', 'own', 'base', 'background'],
      ['style', 'own', 'base', 'color'],
      ['style', 'own', 'base', 'gap'],
      ['style', 'own', 'base', 'paddingBlock'],
      ['style', 'own', 'tablet', 'gap'],
      ['style', 'own', 'base', 'marginBlockEnd'],
      ['style', 'variant:tone:dark', 'base', 'background']
    ]);
    const tokens = effectiveTokens(s);
    const brand = tokens.find((t) => t.id === 'color.brand')!;
    const byKey = (key: string) => found.find((d) => d.site!.includes(key))!.message;
    expect(byKey('"own","base","background"')).toContain(`uses #1f5a4c for its background. Link it to ${brand.value === '#1f5a4c' ? `the site style “${brand.label}” (color.brand)` : 'one of the site colors'}`);
    expect(byKey('"own","base","gap"')).toBe('Banner: “Section” uses 24px for its gap. Link it to the site style “Large” (space.lg), so it follows the site’s spacing.');
    expect(byKey('"tablet","gap"')).toContain('uses 1.5rem for its gap on tablets. Link it to the site style “Large” (space.lg)');
    expect(byKey('"base","paddingBlock"')).toContain('uses 20px for its vertical padding. Link it to one of the spacing styles');
    expect(byKey('variant:tone:dark')).toContain('for its background in the “Dark” tone variant');
  });

  it('leaves keywords, mixes, resets, sizes, hairlines and a text’s own padding alone', () => {
    const s = fresh();
    build(s);
    const nodes = new Set(reusability(s).map((d) => `${d.nodeId}|${JSON.parse(d.site!)[4]}`));
    for (const k of ['inner|gap', 'inner|marginBlockStart', 'inner|paddingInline', 'inner|maxWidth', 'inner|background', 'inner|color', 'badge|paddingBlock', 'badge|paddingInline', 'badge|background']) expect(nodes.has(k)).toBe(false);
  });

  it('flags nothing where the project has no site style of that kind', () => {
    const s = fresh();
    const def = build(s);
    const tokens = effectiveTokens(s).filter((t) => t.group !== 'color' && t.group !== 'space');
    expect(componentReusabilityDiagnostics(def, tokens)).toEqual([]);
  });
});

describe('repeated cards and pictures', () => {
  const build = (s: ProjectState, parts: ComponentSpec['parts']) =>
    addDef(s, {
      name: 'Team',
      properties: { people: P.list('People', 'Person', { name: P.str('Name', ''), photo: P.image('Photo'), avatar: P.image('Avatar') }, []) },
      parts: { root: { nodeId: 'root', label: 'Section' }, ...parts },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('people', 'people', [
            b.el('wrap', 'li', { name: 'Item' }, [
              b.el('card', 'div', { name: 'Card', styles: { background: tok('color.surface'), radius: tok('radius.lg') } }, [
                b.el('frame', 'div', { name: 'Frame' }, [b.image('photo', item('photo'), { name: 'Photo' })]),
                b.image('avatar', item('avatar'), { name: 'Avatar', styles: { width: '40px' } }),
                b.text('name', 'h3', item('name'), { name: 'Name' })
              ])
            ])
          ]),
          b.repeat('plain', 'people', [b.el('row', 'div', { name: 'Row' }, [b.text('row-name', 'p', item('name')), b.image('row-photo', item('avatar'), { styles: { maxHeight: '48px' } })])])
        ])
    });

  it('flags a styled card, a picture and an unexposed plain item', () => {
    const s = fresh();
    build(s, {});
    const found = reusability(s);
    expect(found.every((d) => d.code === 'COMPONENT_PART_MISSING')).toBe(true);
    expect(at(found, 'COMPONENT_PART_MISSING')).toEqual(['card', 'photo', 'row']);
    expect(found[0].message).toBe('Team: “Card” is repeated for each list item, but it is not one of the component’s parts, so placements cannot restyle it. Add it to the parts.');
    expect(found[1].message).toContain('the image “Photo” is repeated for each list item');
  });

  it('is satisfied by parts on the card, the picture or its frame, matched by element', () => {
    const s = fresh();
    build(s, { tile: { nodeId: 'card', label: 'Card' }, media: { nodeId: 'frame', label: 'Photo frame' }, rowName: { nodeId: 'row-name', label: 'Name' } });
    expect(reusability(s)).toEqual([]);
  });
});

describe('as diagnostics', () => {
  it('never block a save, and count as new only where one is added', () => {
    const s = fresh();
    const def = addDef(s, {
      name: 'Promo',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'section', { styles: { gap: '24px' } }, [b.text('title', 'h2', 'Spring')])
    });
    const before = validateState(s);
    expect(before.filter(isReusabilityWarning).every((d) => !blocksSaving(d))).toBe(true);
    expect(validateState(s, { sectionLinks: false }).filter(isReusabilityWarning)).toEqual([]);
    // Renaming the component or editing the heading's words keeps each warning the same one.
    const after = structuredClone(s);
    after.components[def.id].name = 'Spring promo';
    (after.components[def.id].tree!.nodes.title as { text: string }).text = 'Summer';
    after.components[def.id].tree!.nodes.root.styles = { base: { gap: '25px' } };
    expect(introducedDiagnostics(before, validateState(after)).filter(isReusabilityWarning)).toEqual([]);
    // A second heading is a new one.
    const more = structuredClone(after);
    const tree = more.components[def.id].tree!;
    tree.nodes.sub = { id: 'sub', kind: 'text', tag: 'h3', text: 'Autumn' };
    (tree.nodes.root as { children: string[] }).children.push('sub');
    expect(introducedDiagnostics(validateState(after), validateState(more)).map((d) => d.nodeId)).toEqual(['sub']);
  });
});
