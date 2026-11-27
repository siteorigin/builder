/**
 * A Gallery of the editor's own design, for the tests of what a repeated figure's click action makes of each photo.
 * Foundation's Gallery is a code component now, with markup of its own, so this is the slice of its old managed design
 * those tests read: a list of photos, each a figure that does nothing, opens its image full size or follows its link,
 * holding the picture and a caption the tone colours.
 */
import { P, item, prop, tok } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

export const GALLERY: DesignSpec = {
  componentId: 'project.gallery',
  name: 'Gallery',
  category: 'media',
  properties: {
    heading: P.str('Heading', 'Recent projects'),
    images: P.list(
      'Images',
      'Image',
      {
        image: P.image('Image'),
        caption: P.str('Caption', ''),
        action: P.choice('When clicked', 'none', [
          ['none', 'Nothing'],
          ['image', 'Show full image'],
          ['link', 'Follow link']
        ]),
        link: P.link('Link')
      },
      [],
      { titleField: 'caption', max: 24 }
    )
  },
  parts: { root: { nodeId: 'root', label: 'Section' }, image: { nodeId: 'image', label: 'Image' }, caption: { nodeId: 'caption', label: 'Caption' } },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Default' },
        inverse: { label: 'Dark', styles: { root: { base: { background: tok('color.inverse') } }, caption: { base: { color: tok('color.on-inverse') } } } }
      }
    }
  },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
      // An empty gallery leaves no empty <ul> behind.
      b.el('grid', 'ul', { name: 'Grid', collapseEmpty: true, styles: { layout: 'grid', columns: 1 } }, [
        b.repeat('photos', 'images', [
          b.el('photo', 'li', { name: 'Photo' }, [
            // A working action wraps the whole figure, image and caption, in one link: to the full-size image (which
            // opens in a viewer) or to the item's destination.
            b.el('photo-figure', 'figure', { name: 'Figure', action: item('action'), link: item('link'), styles: { layout: 'stack' } }, [
              b.image('image', item('image'), { name: 'Image', styles: { aspectRatio: '4/3', objectFit: 'cover' } }),
              b.text('caption', 'figcaption', item('caption'), { name: 'Caption', when: item('caption') })
            ])
          ])
        ])
      ])
    ])
};
