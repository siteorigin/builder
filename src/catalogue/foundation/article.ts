/**
 * Foundation's layout for a collection's entries: a header band with the category, the title, the excerpt and a line
 * of date, author and reading time (the theme divides them); the featured image, cropped to 3:2, and the text in one
 * reading column; and links to the previous and next entries, one at each end of a row. Every element reads the entry it is shown for through `{ $entry: field }`, so a new collection
 * starts with a clean article page that the author then edits like any page.
 */
import type { NodeTree } from '@shared/types';
import { TreeBuilder, tok } from '../dsl';

export function foundationArticleTemplate(): NodeTree {
  const b = new TreeBuilder();
  const column = (extra: Record<string, unknown> = {}) => ({ layout: 'stack', width: 'fill', maxWidth: tok('container.reading'), marginInline: 'auto', ...extra });
  const band = b.el(
    'header',
    'header',
    { name: 'Header band', styles: { base: { paddingBlock: tok('space.3xl'), paddingInline: tok('container.gutter'), background: tok('color.surface-alt'), color: tok('color.text') } } },
    [
      b.el('header-column', 'div', { name: 'Header column', styles: { base: column({ gap: tok('space.md') }) } }, [
        b.text('category', 'p', { $entry: 'categories' }, { name: 'Category', when: { $entry: 'categories' }, styles: { textStyle: tok('text.eyebrow'), color: tok('color.brand') } }),
        b.text('title', 'h1', { $entry: 'title' }, { name: 'Title', styles: { textStyle: tok('text.h1') } }),
        b.text('excerpt', 'p', { $entry: 'excerpt' }, { name: 'Excerpt', when: { $entry: 'excerpt' }, styles: { textStyle: tok('text.lead'), color: tok('color.muted') } }),
        b.el('meta', 'p', { name: 'Date, author and reading time', collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, columnGap: tok('space.sm'), textStyle: tok('text.small'), color: tok('color.muted') } } }, [
          b.text('date', 'span', { $entry: 'publishedAt' }, { name: 'Date', datetime: { $entry: 'publishedAt' }, when: { $entry: 'publishedAt' } }),
          b.text('author', 'span', { $entry: 'author' }, { name: 'Author', when: { $entry: 'author' } }),
          b.text('reading-time', 'span', { $entry: 'readingTime' }, { name: 'Reading time', when: { $entry: 'readingTime' } })
        ])
      ])
    ]
  );
  const content = b.el('content', 'div', { name: 'Content', styles: { base: { paddingBlock: tok('space.2xl'), paddingInline: tok('container.gutter') } } }, [
    b.el('column', 'div', { name: 'Reading column', styles: { base: column({ gap: tok('space.xl') }) } }, [
      b.image('image', { $entry: 'featuredImage' }, { name: 'Featured image', when: { $entry: 'featuredImage' }, styles: { width: 'fill', aspectRatio: '3/2', objectFit: 'cover', radius: tok('radius.md') } }),
      b.rich('body', { $entry: 'body' }, { name: 'Text', when: { $entry: 'body' } })
    ])
  ]);
  const nav = b.el('more', 'nav', { name: 'Previous and next', ariaLabel: { $entry: 'entryNavLabel' }, collapseEmpty: true, styles: { base: { paddingBlock: tok('space.xl'), paddingInline: tok('container.gutter') } } }, [
    b.el(
      'more-row',
      'div',
      {
        name: 'Links',
        collapseEmpty: true,
        styles: {
          base: column({ gap: tok('space.md'), paddingBlock: tok('space.lg'), borderBlockStart: tok('border.default') }),
          tablet: { layout: 'row', gap: tok('space.xl') },
          desktop: { layout: 'row', gap: tok('space.xl') }
        }
      },
      [
        // Two links of one kind. Side by side from tablets up, each takes half the row (a long title wraps within its
        // half), and Next keeps to the end of the row even when it is the only one; on phones they stack.
        b.link('prev', { $entry: 'prevEntry' }, { $entry: 'prevEntry.label' }, 'link', { name: 'Previous entry', when: { $entry: 'prevEntry' }, styles: { width: 'fill' } }),
        b.link('next', { $entry: 'nextEntry' }, { $entry: 'nextEntry.label' }, 'link', {
          name: 'Next entry',
          when: { $entry: 'nextEntry' },
          styles: { base: { width: 'fill' }, tablet: { textAlign: 'end' }, desktop: { textAlign: 'end' } }
        })
      ]
    )
  ]);
  const article = b.el('article', 'article', { name: 'Article' }, [band, content, nav]);
  return { rootIds: [article], nodes: b.nodes };
}
