/**
 * Foundation's sections as the Markdown copies read them (#1350). The sections are code, so nothing in a design says
 * what they show; Builder vouches for its own release instead, as it does for their copy (engine/shipped-copy.ts).
 * Each section is written here as a managed design that stands for its markup: the words it shows, in the order it
 * shows them, inside the elements that make them headings, lists, list items, quotes and links, with the conditions
 * that decide whether they render beyond having words. Its elements carry the node IDs of the parts the markup styles,
 * so a part its placement hides at every size is left out with everything inside it (hiddenInDesignEverywhere), as
 * the website leaves it out. Nothing else of the markup is here: no styles, pictures, icons, controls (tabs, toggles,
 * filters) or decoration (a window frame's title, a speaker's initials).
 *
 * Only a definition exactly as the app bundles it (shippedAsIs) is read this way: a copy made unique, one from an
 * installed pack, or one changed from what the app ships decides in its own code what it shows, which is unknown.
 * tests/unit/shipped-outlines.test.ts holds each one to the release's markup.
 */
import type { Binding, ButtonAppearance, ComponentDefinition, ProjectState } from '@shared/types';
import { TreeBuilder, item, prop } from '@catalogue/dsl';
import { shippedAsIs } from '@engine/shipped-copy';
import { derived, isTracked } from './cache';

type Build = (b: TreeBuilder) => string;

/** A heading whose tag the placement chooses, as `<svelte:element this={headingLevel}>` renders it. */
const chosenHeading = (b: TreeBuilder, id: string, text: Binding) => b.text(id, prop('headingLevel'), text);

/** The eyebrow, heading and lead most sections open with. */
const intro = (b: TreeBuilder) => [b.text('eyebrow', 'p', prop('eyebrow')), chosenHeading(b, 'heading', prop('heading')), b.text('lead', 'p', prop('lead'))];

/** A section's primary and secondary buttons, where they are given words. */
const buttons = (b: TreeBuilder, primary: ButtonAppearance = 'primary', secondary: ButtonAppearance = 'secondary') => [
  b.link('md-primary', prop('primaryLink'), prop('primaryLabel'), primary),
  b.link('md-secondary', prop('secondaryLink'), prop('secondaryLabel'), secondary)
];

/** A plain link (`appearance="plain"` or `"link"`): without a destination the website shows its words on their own. */
const plainLink = (b: TreeBuilder, id: string, link: Binding, label: Binding, textId = `${id}-text`) => [
  b.link(id, link, label, 'plain', { when: link }),
  b.text(textId, 'span', label, { unless: link })
];

/** Rich text the code shows with its RichText helper (its property's `plainAs` reads text given as plain strings). */
const rich = (b: TreeBuilder, id: string, text: Binding) => b.rich(id, text);

/** Words that name what follows them: their own, or `fallback` while they are empty, as `has(x) ? x : 'Fallback'` shows them. */
const named = (b: TreeBuilder, id: string, words: Binding, fallback: string) => [b.text(id, 'span', words), b.text(`${id}-fallback`, 'span', fallback, { unless: words })];

/** A row of a computed list (news, posts): its title as a link to it, its date and byline, and its excerpt. */
const row = (b: TreeBuilder, p: { card: string; category?: string; title: string; meta: string; text: string }, tag: 'article' = 'article') =>
  b.el(p.card, tag, { when: item('pageLink') }, [
    ...(p.category ? [b.text(p.category, 'p', item('category'))] : []),
    b.link(p.title, item('pageLink'), item('title'), 'plain'),
    b.el(p.meta, 'p', {}, [b.text(`${p.meta}-date`, 'span', item('dateLabel')), b.text(`${p.meta}-byline`, 'span', item('byline'))]),
    b.text(p.text, 'p', item('excerpt'))
  ]);

/** A list of plans, each with its name, badge and description, its price lines (`prices`), features and action. */
const plans = (b: TreeBuilder, prices: (b: TreeBuilder) => string[]) =>
  b.el('grid', 'ul', {}, [
    b.repeat('md-plans', 'plans', [
      b.el('plan', 'li', {}, [
        b.text('md-name', 'h3', item('name')),
        b.text('md-badge', 'span', item('badge')),
        b.text('md-description', 'p', item('description')),
        ...prices(b),
        rich(b, 'md-features', item('features')),
        b.link('md-action', item('actionLink'), item('actionLabel'), 'secondary')
      ])
    ])
  ]);

/**
 * A period's price and the note beside it, as the toggle's price snippet shows them, named by the period's label on
 * the switch that shows it (both are in the page, one shown at a time), while there is a price or a note to name.
 */
const periodPrice = (b: TreeBuilder, period: 'monthly' | 'annual', fallback: string) => {
  const price = item(`${period}Price`);
  const note = item(`${period}Note`);
  const label = (id: string) => named(b, id, prop(`${period}Label`), fallback);
  return b.el(`md-${period}`, 'p', {}, [
    b.el(`md-${period}-label`, 'dt', { when: price }, label(`md-${period}-name`)),
    b.el(`md-${period}-label-note`, 'dt', { when: note, unless: price }, label(`md-${period}-name-note`)),
    b.text(`md-${period}-price`, 'span', price),
    b.text(`md-${period}-note`, 'span', note)
  ]);
};

/** By component ID, the design each of Foundation's sections is read as. */
const OUTLINES: Readonly<Record<string, Build>> = {
  'hero.centered': (b) => b.el('root', 'section', {}, [b.el('container', 'div', {}, [...intro(b), b.el('actions', 'div', {}, buttons(b)), b.text('note', 'p', prop('note'))])]),
  'hero.split': (b) => b.el('root', 'section', {}, [b.el('container', 'div', {}, [...intro(b), b.el('actions', 'div', {}, buttons(b))])]),
  'hero.screenshot': (b) => b.el('root', 'section', {}, [b.el('container', 'div', {}, [...intro(b), b.el('actions', 'div', {}, buttons(b)), b.text('caption', 'figcaption', prop('caption'))])]),
  'intro.page': (b) => b.el('root', 'section', {}, intro(b)),
  // The article's own title, date, byline and summary, from the page it is placed on.
  'content.article': (b) =>
    b.el('root', 'section', {}, [
      b.text('eyebrow', 'p', prop('eyebrow')),
      b.repeat('md-article', 'article', [b.text('heading', 'h1', item('title')), b.el('meta', 'p', {}, [b.text('md-date', 'span', item('dateLabel')), b.text('md-byline', 'span', item('byline'))]), b.text('lead', 'p', item('excerpt'))])
    ]),
  // A logo's name shows only while it has no picture.
  'logos.strip': (b) => b.el('root', 'section', {}, [b.text('heading', 'p', prop('heading')), b.el('row', 'ul', {}, [b.repeat('md-logos', 'logos', [b.el('md-logo', 'li', {}, [b.text('wordmark', 'span', item('name'), { unless: item('logo') })])])])]),
  'features.grid': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'ul', {}, [b.repeat('md-items', 'items', [b.el('card', 'li', {}, [b.text('cardTitle', 'h3', item('title')), b.text('md-description', 'p', item('description')), b.link('md-link', item('link'), item('linkLabel'), 'text')])])])
    ]),
  'features.bento': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'ul', {}, [
        b.el('featured', 'li', {}, [
          b.text('md-featured-title', 'h3', { $prop: 'featured', field: 'title' }),
          b.text('md-featured-description', 'p', { $prop: 'featured', field: 'description' }),
          b.link('md-featured-link', { $prop: 'featured', field: 'link' }, { $prop: 'featured', field: 'linkLabel' }, 'text')
        ]),
        b.repeat('md-items', 'items', [b.el('card', 'li', {}, [b.text('cardTitle', 'h3', item('title')), b.text('md-description', 'p', item('description')), b.link('md-link', item('link'), item('linkLabel'), 'text')])])
      ])
    ]),
  'content.media': (b) =>
    b.el('root', 'section', {}, [
      b.text('eyebrow', 'p', prop('eyebrow')),
      chosenHeading(b, 'heading', prop('heading')),
      rich(b, 'body', prop('body')),
      b.el('points', 'ul', {}, [b.repeat('md-points', 'points', [b.el('md-point', 'li', {}, [b.text('md-point-text', 'span', item('text'))])])]),
      b.link('action', prop('actionLink'), prop('actionLabel'), 'primary'),
      b.link('link', prop('link'), prop('linkLabel'), 'text')
    ]),
  'features.alternating': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('rows', 'ul', {}, [
        b.repeat('md-items', 'items', [b.el('md-row', 'li', {}, [b.text('md-eyebrow', 'p', item('eyebrow')), b.text('rowTitle', 'h3', item('title')), b.text('rowText', 'p', item('text')), b.link('md-link', item('link'), item('linkLabel'), 'text')])])
      ])
    ]),
  // Every tab's panel is in the page, chosen or not, each named by the label of the tab that shows it.
  'tabs.showcase': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.repeat('md-tabs', 'tabs', [
        b.el('list', 'div', {}, [b.el('md-tab', 'dt', {}, [b.text('md-label', 'span', item('label'))])]),
        b.el('panels', 'div', {}, [b.el('md-panel', 'div', {}, [b.text('md-heading', 'h3', item('heading')), rich(b, 'md-copy', item('copy')), b.link('md-action', item('actionLink'), item('actionLabel'), 'text')])])
      ])
    ]),
  // Each step's title is the button that shows its picture, read as the step's heading.
  'content.steps-media': (b) =>
    b.el('root', 'section', {}, [...intro(b), b.el('md-steps', 'ol', {}, [b.repeat('md-step', 'steps', [b.el('step', 'li', {}, [b.text('stepTitle', 'h3', item('title')), b.text('stepText', 'p', item('description'))])])])]),
  'content.steps': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('md-steps', 'ol', {}, [b.repeat('md-step', 'steps', [b.el('md-step-item', 'li', {}, [b.text('stepTitle', 'h3', item('title')), b.text('stepText', 'p', item('description'))])])]),
      b.link('action', prop('actionLink'), prop('actionLabel'), 'primary')
    ]),
  'content.text': (b) => b.el('root', 'section', {}, [b.text('eyebrow', 'p', prop('eyebrow')), chosenHeading(b, 'heading', prop('heading')), rich(b, 'body', prop('body'))]),
  'stats.row': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'dl', {}, [
        b.repeat('md-items', 'items', [
          b.el('md-figure', 'div', {}, [
            b.el('label', 'dt', {}, [b.text('md-label', 'span', item('label'))]),
            b.el('md-value-row', 'dd', {}, [b.text('value', 'span', item('value')), b.text('md-unit', 'span', item('unit'))]),
            b.text('md-context', 'dd', item('context'))
          ])
        ])
      ]),
      b.text('md-note', 'p', prop('note'))
    ]),
  // A featured quote is styled as a part of its own.
  'testimonials.grid': (b) => {
    const card = (id: string, quote: string, featured: boolean) =>
      b.el(id, 'li', featured ? { when: item('featured') } : { unless: item('featured') }, [
        b.el(`${id}-quote`, 'blockquote', {}, [b.text(quote, 'p', item('quote'))]),
        b.el(`${id}-person`, 'div', {}, [b.text(`${id}-name`, 'cite', item('name')), b.text(`${id}-role`, 'span', item('role')), b.text(`${id}-source`, 'span', item('source'))])
      ]);
    return b.el('root', 'section', {}, [...intro(b), b.el('grid', 'ul', {}, [b.repeat('md-items', 'items', [card('featuredCard', 'featuredQuote', true), card('card', 'quote', false)])])]);
  },
  'team.grid': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'ul', {}, [b.repeat('md-people', 'people', [b.el('md-person', 'li', {}, [b.text('name', 'h3', item('name')), b.text('md-role', 'p', item('role')), b.text('md-bio', 'p', item('bio'))])])])
    ]),
  'pricing.plans': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      plans(b, (b) => [b.el('md-price', 'p', {}, [b.text('md-prefix', 'span', item('pricePrefix')), b.text('price', 'span', item('price')), b.text('md-period', 'span', item('period')), b.text('md-price-note', 'span', item('priceNote'))])])
    ]),
  // Both periods' prices are in the page (the switch shows one at a time), each with its own note.
  'pricing.toggle': (b) => b.el('root', 'section', {}, [...intro(b), plans(b, (b) => [periodPrice(b, 'monthly', 'Monthly'), periodPrice(b, 'annual', 'Annual')])]),
  'faq.list': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('md-list', 'div', {}, [b.repeat('md-items', 'items', [b.el('item', 'details', {}, [b.el('md-summary', 'summary', {}, [b.text('question', 'span', item('question'))]), b.text('answer', 'p', item('answer'))])])])
    ]),
  // A card shows only with a page to go to and a title.
  'content.pages': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'ul', {}, [
        b.repeat('md-items', 'items', [b.el('md-item', 'li', { when: item('pageLink') }, [b.el('card', 'div', { when: item('title') }, [b.link('cardTitle', item('pageLink'), item('title'), 'plain'), b.text('cardText', 'p', item('description'))])])])
      ])
    ]),
  'content.news': (b) => b.el('root', 'section', {}, [...intro(b), b.el('grid', 'ul', {}, [b.repeat('md-items', 'items', [b.el('md-item', 'li', {}, [row(b, { card: 'card', title: 'cardTitle', meta: 'cardMeta', text: 'cardText' })])])])]),
  'blog.featured': (b) => b.el('root', 'section', {}, [...intro(b), b.repeat('md-items', 'items', [row(b, { card: 'card', category: 'cardCategory', title: 'cardTitle', meta: 'cardMeta', text: 'cardText' })])]),
  'blog.grid': (b) =>
    b.el('root', 'section', {}, [...intro(b), b.el('grid', 'ul', {}, [b.repeat('md-items', 'items', [b.el('md-item', 'li', {}, [row(b, { card: 'card', category: 'cardCategory', title: 'cardTitle', meta: 'cardMeta', text: 'cardText' })])])])]),
  'blog.list': (b) =>
    b.el('root', 'section', {}, [...intro(b), b.el('list', 'ul', {}, [b.repeat('md-items', 'items', [b.el('md-item', 'li', {}, [row(b, { card: 'row', category: 'rowCategory', title: 'rowTitle', meta: 'rowMeta', text: 'rowText' })])])])]),
  // A picture whose click follows its link takes its caption there.
  'media.gallery': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.el('grid', 'ul', {}, [b.repeat('md-images', 'images', [b.el('md-image', 'li', {}, [b.el('md-tile', 'figure', { link: item('link'), action: item('action') }, [b.text('caption', 'figcaption', item('caption'))])])])])
    ]),
  'media.carousel': (b) =>
    b.el('root', 'section', {}, [...intro(b), b.el('md-track', 'ul', {}, [b.repeat('md-slides', 'slides', [b.el('md-item', 'li', {}, [b.el('slide', 'div', { link: item('link') }, [b.text('caption', 'figcaption', item('caption'))])])])])]),
  'cta.banner': (b) => b.el('root', 'section', {}, [b.el('panel', 'div', {}, [...intro(b), ...buttons(b, 'light', 'text')])]),
  'contact.details': (b) =>
    b.el('root', 'section', {}, [
      ...intro(b),
      b.link('md-action', prop('actionLink'), prop('actionLabel'), 'primary'),
      b.el('list', 'ul', {}, [b.repeat('md-items', 'items', [b.el('method', 'li', {}, [b.text('md-label', 'span', item('label')), ...plainLink(b, 'md-value', item('link'), item('value'))])])])
    ]),
  // The search form's own words are controls; its results are found as the visitor searches.
  'site.search': (b) => b.el('root', 'section', {}, [b.text('eyebrow', 'p', prop('eyebrow')), b.text('heading', 'h2', prop('heading')), b.text('lead', 'p', prop('lead'))]),
  'block.feature': (b) => b.el('root', 'div', {}, [chosenHeading(b, 'title', prop('title')), b.el('md-badge', 'p', {}, [b.text('badge', 'span', prop('badge'))]), b.text('description', 'p', prop('description')), b.link('link', prop('link'), prop('linkLabel'), 'text')]),
  'block.stat': (b) =>
    b.el('root', 'div', {}, [b.el('md-figure', 'dl', {}, [b.el('label', 'dt', {}, [b.text('md-label', 'span', prop('label'))]), b.el('md-value-row', 'dd', {}, [b.text('value', 'span', prop('value')), b.text('unit', 'span', prop('unit'))])]), b.text('footnote', 'p', prop('footnote'))]),
  'block.testimonial': (b) =>
    b.el('root', 'figure', {}, [
      b.el('md-quote', 'blockquote', {}, [b.text('quote', 'p', prop('quote'))]),
      b.el('attribution', 'figcaption', {}, [b.text('md-name', 'p', prop('name')), b.text('md-role', 'p', prop('role')), b.link('source', prop('sourceLink'), prop('sourceLabel'), 'text'), b.text('md-disclosure', 'p', prop('disclosure'))])
    ]),
  'block.callout': (b) => b.el('root', 'div', {}, [b.text('eyebrow', 'p', prop('eyebrow')), chosenHeading(b, 'heading', prop('heading')), b.text('text', 'p', prop('text')), b.link('action', prop('actionLink'), prop('actionLabel'), 'primary')]),
  // A file's card links to it from its title; its format shows on the tile beside it.
  'block.download': (b) =>
    b.el('root', 'div', {}, [
      chosenHeading(b, 'heading', prop('heading')),
      b.el('list', 'ul', {}, [
        b.repeat('md-files', 'files', [
          b.el('md-file', 'li', {}, [
            b.el('tile', 'div', {}, [b.text('md-format', 'span', item('format'))]),
            b.el('md-card', 'div', { link: item('file') }, [b.text('title', 'p', item('title')), b.text('md-size', 'p', item('size')), b.text('md-description', 'p', item('description'))])
          ])
        ])
      ])
    ]),
  // A fact without a value shows a dash.
  'block.facts': (b) =>
    b.el('root', 'div', {}, [
      chosenHeading(b, 'heading', prop('heading')),
      b.el('md-facts', 'dl', {}, [
        b.repeat('md-items', 'items', [
          b.el('row', 'div', {}, [
            b.el('label', 'dt', {}, [b.text('md-label', 'span', item('label'))]),
            b.el('md-value', 'dd', {}, [b.text('md-none', 'span', '—', { unless: item('value') }), b.el('md-shown', 'span', { when: item('value') }, plainLink(b, 'md-link', item('link'), item('value'), 'value'))])
          ])
        ])
      ])
    ])
};

const made = new WeakMap<ComponentDefinition, ComponentDefinition | null>();

/** The design `state`'s definition `id` is read as, or null; a function of the ID alone, for a derived value. */
const outlineFor = (id: string) => (s: ProjectState) => {
  const def = Object.hasOwn(s.components, id) ? s.components[id] : undefined;
  return def && shippedAsIs(def) ? outlineOf(def) : null;
};

/**
 * The managed design a shipped Foundation section of `state` is read as for its Markdown, with the section's own ID,
 * properties and parts. Undefined for any other definition, and for one not exactly as the app ships it. In a cached
 * run it is the run's derived value for the definition, so every file that reads it depends on what went into it;
 * otherwise it is kept for each definition object, which a change replaces.
 */
export function shippedOutline(state: ProjectState, def: ComponentDefinition): ComponentDefinition | undefined {
  if (def.kind !== 'code' || !Object.hasOwn(OUTLINES, def.componentId)) return undefined;
  if (isTracked(state)) return derived(state, `shippedOutline:${def.id}`, outlineFor(def.id)) ?? undefined;
  let out = made.get(def);
  if (out === undefined) {
    out = shippedAsIs(def) ? outlineOf(def) : null;
    made.set(def, out);
  }
  return out ?? undefined;
}

/** The component IDs read through a design of their own. */
export const OUTLINED: readonly string[] = Object.keys(OUTLINES);

/** The design `build` makes, standing in for `def`. Exported for the release check. */
export function outlineOf(def: ComponentDefinition, build: Build = OUTLINES[def.componentId]): ComponentDefinition {
  const b = new TreeBuilder();
  const root = build(b);
  const { source: _source, sourcePath: _sourcePath, ...rest } = def;
  return { ...rest, kind: 'managed', tree: { rootIds: [root], nodes: b.nodes } };
}
