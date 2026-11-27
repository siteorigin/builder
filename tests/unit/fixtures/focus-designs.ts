/**
 * Content with image as the managed design Foundation shipped before the theme moved to its own repository (#998),
 * for the Image focus tests: an image beside a heading and text, its picture a part that can be cropped. Only the
 * slice of the old tree those tests reach, on the loaded Foundation's tokens and stamped as Foundation's.
 */
import type { ComponentDefinition } from '@shared/types';
import { P, tok } from '@catalogue/dsl';
import { foundationDesign } from './packs';

export const contentMedia = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'content.media',
    name: 'Content with image',
    properties: {
      heading: P.str('Heading', 'Good projects start with listening'),
      body: P.rich('Text', ['Before we draw anything we spend time understanding how you live and work.']),
      image: P.image('Image', 'Two people reviewing plans at a table')
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      body: { nodeId: 'body', label: 'Text', styleControls: ['textStyle', 'color'] },
      media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section') } }, [
        b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 2 } } }, [
          b.el('media-wrap', 'figure', { name: 'Media' }, [
            b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.lg'), objectFit: 'cover' } })
          ]),
          b.el('content', 'div', { name: 'Content', styles: { layout: 'stack', gap: tok('space.lg') } }, [
            b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
            b.rich('body', { $prop: 'body' }, { name: 'Text' })
          ])
        ])
      ])
  });
