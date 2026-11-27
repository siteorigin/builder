/**
 * A Carousel of the editor's own design, for the tests of what the editor and the generator do with a list marked as a
 * carousel. Foundation's Carousel is a code component now, which uses the carousel helper in its own markup, so this
 * is the slice of its old managed design those tests walk: the container around the list, the list itself named by
 * the heading, and a slide's card, picture and caption.
 */
import { P, item, prop, tok } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

export const CAROUSEL: DesignSpec = {
  componentId: 'project.carousel',
  name: 'Carousel',
  category: 'media',
  properties: {
    heading: P.str('Heading', 'Featured projects'),
    slides: P.list('Slides', 'Slide', { image: P.image('Image'), caption: P.str('Caption', ''), link: P.link('Link') }, [], { titleField: 'caption', max: 24 })
  },
  parts: { root: { nodeId: 'root', label: 'Section' }, slide: { nodeId: 'slide-card', label: 'Slide' }, caption: { nodeId: 'caption', label: 'Caption' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.2xl') } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('track', 'ul', { name: 'Slides', carousel: true, collapseEmpty: true, ariaLabel: prop('heading'), styles: { layout: 'row', gap: tok('space.lg') } }, [
          b.repeat('slides', 'slides', [
            b.el('slide', 'li', { name: 'Slide', styles: { width: '85%' } }, [
              // A slide with a destination is one link around its picture and caption.
              b.el('slide-card', 'div', { name: 'Slide card', link: item('link'), styles: { layout: 'stack' } }, [
                b.el('figure', 'figure', { name: 'Figure', styles: { layout: 'stack' } }, [
                  b.image('image', item('image'), { name: 'Image', fallbackAlt: 'Slide' }),
                  b.text('caption', 'figcaption', item('caption'), { name: 'Caption', when: item('caption') })
                ])
              ])
            ])
          ])
        ])
      ])
    ])
};
