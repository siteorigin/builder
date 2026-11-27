/**
 * The managed designs the image-drop tests point at: a Split hero with one image of its own, a Team whose people each
 * have a portrait shown only once it has a picture, and a Gallery of repeated pictures. Foundation's sections are
 * code components now, so these are the slices of its old managed designs the drop is worked out from: the element
 * chain the page sends, the image fields, and the conditions that hide an empty one.
 */
import { P, item, prop } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

export const SPLIT_HERO: DesignSpec = {
  componentId: 'project.split-hero',
  name: 'Split hero',
  properties: { heading: P.str('Heading', 'Designed for living in'), lead: P.text('Supporting text', 'A calm studio.'), image: P.image('Image', 'A calm, light-filled studio workspace') },
  parts: { root: { nodeId: 'root', label: 'Section' }, media: { nodeId: 'media', label: 'Image' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.el('content', 'div', { name: 'Content' }, [
        b.text('heading', 'h1', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') })
      ]),
      b.el('media-wrap', 'figure', { name: 'Media' }, [b.image('media', prop('image'), { name: 'Image' })])
    ])
};

export const TEAM: DesignSpec = {
  componentId: 'project.team',
  name: 'Team',
  properties: {
    heading: P.str('Heading', 'The people you will work with'),
    people: P.list(
      'People',
      'Person',
      { portrait: P.image('Portrait'), name: P.required(P.str('Name', 'Name')), role: P.str('Role', '') },
      [
        { portrait: { assetId: null, alt: '' }, name: 'Hannah Wells', role: 'Founder & lead designer' },
        { portrait: { assetId: null, alt: '' }, name: 'Marcus Lee', role: 'Project manager' },
        { portrait: { assetId: null, alt: '' }, name: 'Sofia Alvarez', role: 'Interior designer' }
      ],
      { titleField: 'name', max: 16 }
    )
  },
  parts: { root: { nodeId: 'root', label: 'Section' }, portrait: { nodeId: 'portrait', label: 'Portrait' }, name: { nodeId: 'name', label: 'Name' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.el('grid', 'ul', { name: 'Grid' }, [
        b.repeat('members', 'people', [
          b.el('member', 'li', { name: 'Person' }, [
            // People without a portrait show no empty image box.
            b.image('portrait', item('portrait'), { name: 'Portrait', when: item('portrait') }),
            b.text('name', 'h3', item('name'), { name: 'Name' }),
            b.text('role', 'p', item('role'), { name: 'Role', when: item('role') })
          ])
        ])
      ])
    ])
};

export const GALLERY: DesignSpec = {
  componentId: 'project.gallery',
  name: 'Gallery',
  properties: {
    heading: P.str('Heading', 'Recent projects'),
    images: P.list('Images', 'Image', { image: P.image('Image'), caption: P.str('Caption', '') }, [], { titleField: 'caption', max: 24 })
  },
  parts: { root: { nodeId: 'root', label: 'Section' }, image: { nodeId: 'image', label: 'Image' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.el('grid', 'ul', { name: 'Grid', collapseEmpty: true }, [
        b.repeat('photos', 'images', [
          b.el('photo', 'li', { name: 'Photo' }, [
            b.el('photo-figure', 'figure', { name: 'Figure' }, [
              b.image('image', item('image'), { name: 'Image' }),
              b.text('caption', 'figcaption', item('caption'), { name: 'Caption', when: item('caption') })
            ])
          ])
        ])
      ])
    ])
};
