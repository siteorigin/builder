/**
 * A theme for the dated articles tests (articles.test.ts): Foundation's sections under another theme's name, with its
 * Article header, News list and Text drawn as designs built in the editor, on the very properties the release declares
 * (the header's and the list's rows a computed feed fills). Foundation's are code components whose words Builder does
 * not read (see the Release gap tests), so what the checks and search read of computed rows is tried on these.
 */
import type { ComponentDefinition } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { item, prop, type ComponentSpec } from '@catalogue/dsl';
import { registerBeside, testPack } from './packs';

export const ARTICLES_THEME = 'articles-theme';

/** A design with the release component's identity and properties, and parts and a tree of its own. */
function like(release: ComponentDefinition, parts: ComponentSpec['parts'], build: ComponentSpec['build']): ComponentSpec {
  const { componentId, name, description, category, tags, icon } = release;
  return { componentId, name, description, category, tags: [...tags], icon: icon ?? 'square', properties: structuredClone(release.properties), parts, build };
}

/** The article header: its page's own row, as the title (the page's Heading 1), the date and byline, and the excerpt. */
const header = (release: ComponentDefinition) =>
  like(release, { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Title' }, lead: { nodeId: 'lead', label: 'Excerpt' } }, (b) =>
    b.el('root', 'header', { name: 'Section' }, [
      b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
      b.repeat('rows', 'article', [
        b.text('heading', 'h1', item('title'), { name: 'Title' }),
        b.el('meta', 'p', { name: 'Date and byline', collapseEmpty: true }, [
          b.text('date', 'span', item('dateLabel'), { name: 'Date', datetime: item('date'), when: item('dateLabel') }),
          b.text('byline', 'span', item('byline'), { name: 'Byline', when: item('byline') })
        ]),
        b.text('lead', 'p', item('excerpt'), { name: 'Excerpt', when: item('excerpt') })
      ])
    ])
  );

/** The News list: its heading over a card per article, each its title linked, its date and byline, and its excerpt. */
const news = (release: ComponentDefinition) =>
  like(release, { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' }, card: { nodeId: 'card', label: 'Card' } }, (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
      b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') }),
      b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true }, [
        b.repeat('cards', 'items', [
          b.el('card', 'li', { name: 'Card' }, [
            b.link('card-title', item('pageLink'), item('title'), 'link', { name: 'Card title' }),
            b.el('card-meta', 'p', { name: 'Date and byline', collapseEmpty: true }, [
              b.text('card-date', 'span', item('dateLabel'), { name: 'Date', datetime: item('date'), when: item('dateLabel') }),
              b.text('card-byline', 'span', item('byline'), { name: 'Byline', when: item('byline') })
            ]),
            b.text('card-text', 'p', item('excerpt'), { name: 'Card excerpt', when: item('excerpt') })
          ])
        ])
      ])
    ])
  );

/** The text section: its eyebrow and heading over rich text. */
const text = (release: ComponentDefinition) =>
  like(release, { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' }, body: { nodeId: 'body', label: 'Text' } }, (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
      b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.rich('body', prop('body'), { name: 'Text' })
    ])
  );

/** Register the theme beside the releases (restorePacks takes it away again). */
export function registerArticlesTheme() {
  const foundation = getTheme('foundation');
  const release = (id: string) => foundation.components.find((c) => c.componentId === id)!;
  const author = testPack(ARTICLES_THEME);
  const designed = ['content.article', 'content.news', 'content.text'];
  const others = foundation.components.filter((c) => !designed.includes(c.componentId)).map((c) => author.adopt(c));
  registerBeside(author.define([...others, author.managed(header(release('content.article'))), author.managed(news(release('content.news'))), author.managed(text(release('content.text')))]));
}
