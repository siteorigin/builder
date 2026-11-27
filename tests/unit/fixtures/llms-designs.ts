/**
 * Managed designs for the Markdown copies' tests (llms.test.ts): what the Markdown writer reads out of a design's
 * tree (headings, rich text, a quote in a list item, a details summary, a button, a card linking to a page, the rows
 * of a feed). Each is the slice of the managed Foundation section it was taken from that the tests read, added to the
 * project as its own design.
 */
import type { ProjectState } from '@shared/types';
import { P } from '@catalogue/dsl';
import { projectDesign } from './packs';

/** The fields a feed's rows fill (shared/articles.ts, shared/entry-feed.ts), as a list's item fields. */
const rowFields = () => ({ pageLink: P.link('Entry'), title: P.str('Title', ''), date: P.str('Date', ''), dateLabel: P.str('Date as shown', ''), byline: P.str('Byline', ''), excerpt: P.text('Excerpt', '') });

/** Add the designs to the project; returns each one's definition ID. */
export function markdownDesigns(state: ProjectState) {
  const text = projectDesign(state, {
    componentId: 'md.text',
    name: 'Text section',
    properties: { heading: P.str('Heading', 'How we work'), body: P.rich('Text', ['We keep our team small.']) },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, heading: { nodeId: 'heading', label: 'Heading', styleControls: [] }, body: { nodeId: 'body', label: 'Text', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }), b.rich('body', { $prop: 'body' }, { name: 'Text' })])
  });
  const faq = projectDesign(state, {
    componentId: 'md.faq',
    name: 'FAQ',
    properties: {
      heading: P.str('Heading', 'Frequently asked questions'),
      items: P.list('Questions', 'Question', { question: P.str('Question', 'Question?'), answer: P.text('Answer', 'Answer.') }, [], { titleField: 'question' })
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, question: { nodeId: 'question', label: 'Question text', styleControls: [] }, answer: { nodeId: 'answer', label: 'Answer', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.repeat('questions', 'items', [
          b.el('item', 'details', { name: 'Question' }, [
            b.el('summary', 'summary', { name: 'Summary' }, [b.text('question', 'span', { $item: 'question' }, { name: 'Question text' })]),
            b.text('answer', 'p', { $item: 'answer' }, { name: 'Answer' })
          ])
        ])
      ])
  });
  const testimonials = projectDesign(state, {
    componentId: 'md.testimonials',
    name: 'Testimonials',
    properties: {
      heading: P.str('Heading', 'What our clients say'),
      items: P.list('Testimonials', 'Testimonial', { quote: P.text('Quote', 'A short quote.'), name: P.str('Name', 'Client name'), role: P.str('Role', '') }, [], { titleField: 'name' })
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, quote: { nodeId: 'quote', label: 'Quote', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.el('grid', 'ul', { name: 'Grid' }, [
          b.repeat('quotes', 'items', [
            b.el('card', 'li', { name: 'Card' }, [
              b.el('quote-block', 'blockquote', { name: 'Quote block' }, [b.text('quote', 'p', { $item: 'quote' }, { name: 'Quote' })]),
              b.el('person', 'div', { name: 'Attribution' }, [
                b.text('name', 'cite', { $item: 'name' }, { name: 'Name' }),
                b.text('role', 'span', { $item: 'role' }, { name: 'Role', when: { $item: 'role' } })
              ])
            ])
          ])
        ])
      ])
  });
  const cta = projectDesign(state, {
    componentId: 'md.cta',
    name: 'Call to action',
    properties: { heading: P.str('Heading', 'Ready to start?'), primaryLabel: P.str('Primary button label', 'Get in touch'), primaryLink: P.link('Primary button link') },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { name: 'Primary button', when: { $prop: 'primaryLabel' } })
      ])
  });
  // A card shows its page's own title and description while its fields are empty (the list's page teaser).
  const pages = projectDesign(state, {
    componentId: 'md.pages',
    name: 'Page list',
    properties: {
      heading: P.str('Heading', 'Selected work'),
      items: P.list('Pages', 'Page', { pageLink: P.link('Page'), title: P.str('Title', ''), description: P.text('Description', '') }, [], {
        titleField: 'title',
        min: 0,
        pageTeaser: { link: 'pageLink', title: 'title', description: 'description' }
      })
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, card: { nodeId: 'card', label: 'Card', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true }, [
          b.repeat('cards', 'items', [
            b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' }, collapseEmpty: true }, [
              b.el('card', 'div', { name: 'Card', when: { $item: 'title' } }, [
                b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title' }),
                b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', when: { $item: 'description' } })
              ])
            ])
          ])
        ])
      ])
  });
  // The site's dated articles, filled in when the site is generated, each row a link to its article.
  const news = projectDesign(state, {
    componentId: 'md.news',
    name: 'News list',
    properties: { heading: P.str('Heading', 'Latest news'), items: P.list('Articles', 'Article', rowFields(), [], { titleField: 'title', min: 0, max: 12, feed: 'articles' }) },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true }, [
          b.repeat('cards', 'items', [
            b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' } }, [
              b.el('card', 'article', { name: 'Card' }, [
                b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title' }),
                b.text('card-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' } })
              ])
            ])
          ])
        ])
      ])
  });
  // A collection's newest entries, read by the entry feed from the placement's collection, category, tag and count.
  const posts = projectDesign(state, {
    componentId: 'md.posts',
    name: 'Post list',
    properties: {
      heading: P.str('Heading', 'Recent posts'),
      items: P.list('Entries', 'Entry', rowFields(), [], { titleField: 'title', min: 0, max: 24, feed: 'entries' }),
      collection: P.str('Collection', ''),
      category: P.str('Category', ''),
      tag: P.str('Tag', ''),
      count: P.num('Number of entries', 5, 1, 24)
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
        b.el('list', 'ul', { name: 'List', collapseEmpty: true }, [
          b.repeat('rows', 'items', [
            b.el('row-item', 'li', { name: 'Row item', when: { $item: 'pageLink' } }, [
              b.el('row', 'article', { name: 'Row', link: { $item: 'pageLink' }, ariaLabel: { $item: 'title' } }, [
                b.text('row-title', 'h3', { $item: 'title' }, { name: 'Title' }),
                b.text('row-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' } })
              ])
            ])
          ])
        ])
      ])
  });
  return { text: text.id, faq: faq.id, testimonials: testimonials.id, cta: cta.id, pages: pages.id, news: news.id, posts: posts.id };
}
