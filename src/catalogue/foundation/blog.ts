/**
 * Blog feeds: sections that show a collection's published entries (posts, case studies) anywhere on the site, newest
 * first, worked out each time the site is generated (see shared/entry-feed.ts). A placement chooses the collection,
 * a category or tag and how many to show; a post published, backdated, retitled or turned back into a draft changes
 * every feed with nothing to edit here. Each card links to its entry by ID and states its date in a `<time>` element.
 */
import type { ScalarPropSchema } from '@shared/types';
import { P, tok } from '../dsl';
import { FOUNDATION } from './pack';
import { eyebrowStyles, headingBlock, headingLevel, layoutAxis, mutedStyles, sectionShell, toneAxis } from './common';

const { managed } = FOUNDATION;

/** The fields an entry feed's rows fill (see shared/entry-feed.ts), as a list's item fields. */
const entryFields = () => ({
  pageLink: P.link('Entry'),
  title: P.str('Title', ''),
  date: P.str('Date', ''),
  dateLabel: P.str('Date as shown', ''),
  byline: P.str('Author', ''),
  excerpt: P.text('Excerpt', ''),
  image: P.image('Featured image'),
  category: P.str('Category', '')
});

/** What a placement shows, read by name by the entry feed: the collection, a category, a tag and, for lists, how many. */
function query(count?: { def: number; max: number }): Record<string, ScalarPropSchema> {
  return P.group('Entries shown', {
    collection: P.str('Collection', '', { description: 'The collection’s ID, such as "posts". Empty: the blog, or on an entry’s page, that entry’s collection.' }),
    category: P.str('Category', '', { description: 'Only entries in this category, by its name or ID. Empty: every category.' }),
    tag: P.str('Tag', '', { description: 'Only entries with this tag, by its name or ID. Empty: every tag.' }),
    ...(count ? { count: { ...P.num('Number of entries', count.def, 1, count.max), description: 'The most entries shown, newest first.' } as ScalarPropSchema } : {})
  });
}

const metaStyles = { layout: 'row', wrap: true, columnGap: tok('space.md'), textStyle: tok('text.small'), ...mutedStyles } as const;
const DESCRIPTION_TAIL = 'Drafts are left out; on a post’s own page that post is left out, so it works as “Related posts”.';
const TAGS = ['blog', 'posts', 'articles', 'latest', 'recent', 'news', 'journal', 'feed', 'collection', 'entries', 'case studies', 'related posts'];

/** The date and author line of a card. */
const meta = (b: Parameters<Parameters<typeof managed>[0]['build']>[0], id: string) =>
  b.el(id, 'p', { name: 'Date and author', collapseEmpty: true, styles: metaStyles }, [
    b.text(`${id}-date`, 'span', { $item: 'dateLabel' }, { name: 'Date', datetime: { $item: 'date' }, when: { $item: 'dateLabel' } }),
    b.text(`${id}-byline`, 'span', { $item: 'byline' }, { name: 'Author', when: { $item: 'byline' } })
  ]);

/** One large card for the newest entry (or the newest of a category): picture beside its title, date and excerpt. */
export const blogFeatured = managed({
  componentId: 'blog.featured',
  name: 'Featured post',
  description: `The newest entry of a collection (the blog unless you choose another), shown large: its featured image, category, title, date, author and excerpt, filled in automatically. Choose a category or tag to feature the newest of those. ${DESCRIPTION_TAIL}`,
  category: 'content',
  tags: [...TAGS, 'featured', 'featured post', 'hero', 'lead story', 'highlight'],
  icon: 'star',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', ''),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    ...query(),
    items: P.list('Featured entry', 'Entry', entryFields(), [], { titleField: 'title', min: 0, max: 1, feed: 'entries' })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline', 'gap'] },
    cardImage: { nodeId: 'card-image', label: 'Featured image', styleControls: ['aspectRatio', 'radius'] },
    cardCategory: { nodeId: 'card-category', label: 'Category', styleControls: ['textStyle', 'color'] },
    cardTitle: { nodeId: 'card-title', label: 'Title', styleControls: ['textStyle', 'color'] },
    cardMeta: { nodeId: 'card-meta', label: 'Date and author', styleControls: ['textStyle', 'color'] },
    cardText: { nodeId: 'card-text', label: 'Excerpt', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: toneAxis(['lead', 'card-meta', 'card-text']),
    layout: layoutAxis({
      default: { label: 'Image beside text' },
      stacked: { label: 'Image above text', styles: { card: { tablet: { layout: 'stack' }, desktop: { layout: 'stack' } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.repeat('featured', 'items', [
        // Side by side from tablets, each half the card; a post without a picture has its text across the whole card.
        b.el('card', 'article', { name: 'Card', when: { $item: 'pageLink' }, styles: { base: { layout: 'stack', gap: tok('space.xl') }, tablet: { layout: 'row', align: 'center' } } }, [
          b.image('card-image', { $item: 'image' }, { name: 'Featured image', when: { $item: 'image' }, styles: { width: 'fill', aspectRatio: '3/2', radius: tok('radius.lg'), objectFit: 'cover' } }),
          b.el('card-body', 'div', { name: 'Text', styles: { layout: 'stack', width: 'fill', gap: tok('space.md') } }, [
            b.text('card-category', 'p', { $item: 'category' }, { name: 'Category', when: { $item: 'category' }, styles: eyebrowStyles }),
            b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title', styles: { textStyle: tok('text.h2') } }),
            meta(b, 'card-meta'),
            b.text('card-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' }, styles: { textStyle: tok('text.lead'), ...mutedStyles } })
          ])
        ])
      ])
    ])
});

/** Cards in a grid: picture, category, title, date and excerpt, newest first. */
export const blogGrid = managed({
  componentId: 'blog.grid',
  name: 'Post grid',
  description: `The newest entries of a collection (the blog unless you choose another) as cards in a grid, filled in automatically: each card shows the featured image, category, title (its link), date, author and excerpt. Choose a category or tag, and how many to show. Use for a “Latest articles” strip, a blog index or “Related posts”. ${DESCRIPTION_TAIL}`,
  category: 'content',
  tags: [...TAGS, 'grid', 'cards', 'latest articles', 'latest posts'],
  icon: 'layout-grid',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Latest articles'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    ...query({ def: 3, max: 24 }),
    items: P.list('Entries', 'Entry', entryFields(), [], { titleField: 'title', min: 0, max: 24, feed: 'entries' })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gridAutoFlow', 'gridAutoRows', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline', 'gap'] },
    cardImage: { nodeId: 'card-image', label: 'Card image', styleControls: ['aspectRatio', 'radius'] },
    cardCategory: { nodeId: 'card-category', label: 'Category', styleControls: ['textStyle', 'color'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardMeta: { nodeId: 'card-meta', label: 'Date and author', styleControls: ['textStyle', 'color'] },
    cardText: { nodeId: 'card-text', label: 'Card excerpt', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: toneAxis(['lead', 'card-meta', 'card-text']),
    layout: layoutAxis({
      default: { label: 'Three columns' },
      'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
      'four-columns': { label: 'Four columns', styles: { grid: { desktop: { columns: 4 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      // No entries yet leaves no empty <ul> behind.
      b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true, styles: { base: { layout: 'grid', columns: 1, gap: tok('space.xl') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' } }, [
            // Each card is a bordered box (no fill, so the section's tone still decides the text colours), so a post without a picture is plainly its own and does not read as the caption of the picture beside it.
            b.el('card', 'article', { name: 'Card', styles: { layout: 'stack', gap: tok('space.sm'), paddingBlock: tok('space.md'), paddingInline: tok('space.md'), border: tok('border.default'), radius: tok('radius.lg') } }, [
              b.image('card-image', { $item: 'image' }, { name: 'Card image', when: { $item: 'image' }, styles: { width: 'fill', aspectRatio: '3/2', radius: tok('radius.md'), objectFit: 'cover', marginBlockEnd: tok('space.xs') } }),
              b.text('card-category', 'p', { $item: 'category' }, { name: 'Category', when: { $item: 'category' }, styles: eyebrowStyles }),
              b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              meta(b, 'card-meta'),
              b.text('card-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' }, styles: mutedStyles })
            ])
          ])
        ])
      ])
    ])
});

/** A compact list: date, title, category and excerpt per row, without pictures. */
export const blogList = managed({
  componentId: 'blog.list',
  name: 'Post list',
  description: `The newest entries of a collection (the blog unless you choose another) as a compact list without pictures, filled in automatically: each row shows the title (its link), date, author, category and excerpt. Choose a category or tag, and how many to show. Use beside other content, in a sidebar-like column or for an archive. ${DESCRIPTION_TAIL}`,
  category: 'content',
  tags: [...TAGS, 'list', 'compact', 'headlines', 'archive'],
  icon: 'list',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Recent posts'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    ...query({ def: 5, max: 24 }),
    items: P.list('Entries', 'Entry', entryFields(), [], { titleField: 'title', min: 0, max: 24, feed: 'entries' })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    list: { nodeId: 'list', label: 'List', styleControls: ['gap', 'maxWidth'] },
    row: { nodeId: 'row', label: 'Row', styleControls: ['borderBlockEnd', 'paddingBlock', 'gap'] },
    rowCategory: { nodeId: 'row-category', label: 'Category', styleControls: ['textStyle', 'color'] },
    rowTitle: { nodeId: 'row-title', label: 'Title', styleControls: ['textStyle', 'color'] },
    rowMeta: { nodeId: 'row-meta', label: 'Date and author', styleControls: ['textStyle', 'color'] },
    rowText: { nodeId: 'row-text', label: 'Excerpt', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead', 'row-meta', 'row-text']) },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('list', 'ul', { name: 'List', collapseEmpty: true, styles: { base: { layout: 'stack', gap: '0', maxWidth: tok('container.reading') } } }, [
        b.repeat('rows', 'items', [
          b.el('row-item', 'li', { name: 'Row item', when: { $item: 'pageLink' } }, [
            b.el('row', 'article', { name: 'Row', styles: { layout: 'stack', gap: tok('space.xs'), paddingBlock: tok('space.lg'), borderBlockEnd: tok('border.default') } }, [
              b.text('row-category', 'p', { $item: 'category' }, { name: 'Category', when: { $item: 'category' }, styles: eyebrowStyles }),
              b.link('row-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              meta(b, 'row-meta'),
              b.text('row-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' }, styles: mutedStyles })
            ])
          ])
        ])
      ])
    ])
});

// Brand-coloured category labels switch to the accent colour on the dark tone, as section eyebrows do.
blogFeatured.variantAxes!.tone.options.inverse.styles!['card-category'] = { base: { color: tok('color.accent') } };
blogGrid.variantAxes!.tone.options.inverse.styles!['card-category'] = { base: { color: tok('color.accent') } };
blogList.variantAxes!.tone.options.inverse.styles!['row-category'] = { base: { color: tok('color.accent') } };
