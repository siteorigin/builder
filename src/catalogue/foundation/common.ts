import type { ResponsiveStyles, VariantAxis, VariantDef } from '@shared/types';
import { TreeBuilder, tok } from '../dsl';

/** Standard section shell: full-bleed root with vertical rhythm, centered content container. */
export function sectionShell(
  b: TreeBuilder,
  children: string[],
  opts: { inner?: ResponsiveStyles; root?: ResponsiveStyles; width?: 'content' | 'reading'; tag?: 'section' | 'footer' } = {}
): string {
  const inner = b.el(
    'inner',
    'div',
    {
      name: 'Container',
      styles: {
        base: {
          layout: 'stack',
          gap: tok('space.2xl'),
          width: 'fill',
          maxWidth: tok(opts.width === 'reading' ? 'container.reading' : 'container.content'),
          marginInline: 'auto',
          ...(opts.inner?.base ?? {})
        },
        ...Object.fromEntries(Object.entries(opts.inner ?? {}).filter(([k]) => k !== 'base'))
      }
    },
    children
  );
  return b.el(
    'root',
    opts.tag ?? 'section',
    {
      name: 'Section',
      styles: {
        base: {
          paddingBlock: tok('space.section'),
          paddingInline: tok('container.gutter'),
          background: tok('color.background'),
          color: tok('color.text'),
          ...(opts.root?.base ?? {})
        },
        ...Object.fromEntries(Object.entries(opts.root ?? {}).filter(([k]) => k !== 'base'))
      }
    },
    [inner]
  );
}

/**
 * Tone variants shared by most sections. Muted nodes are lightened on the inverse tone, and brand-coloured
 * accents (eyebrows) switch to the accent colour, which stays readable on dark backgrounds.
 *
 * Only pass nodes that sit directly on the section background: nodes inside surface cards keep the card's
 * own colours, so lightening them would make them unreadable. Styles for nodes a component does not have
 * are dropped by `managed()`.
 */
export function toneVariants(mutedNodes: string[] = [], extra: Record<string, VariantDef> = {}): Record<string, VariantDef> {
  const inverse: Record<string, ResponsiveStyles> = {
    root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } },
    eyebrow: { base: { color: tok('color.accent') } }
  };
  for (const id of mutedNodes) inverse[id] = { base: { color: tok('color.on-inverse'), opacity: 0.78 } };
  return {
    default: { label: 'Default' },
    muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } },
    inverse: { label: 'Dark', styles: inverse },
    ...extra
  };
}

/** The tone axis most sections share. */
export function toneAxis(mutedNodes: string[] = [], extra: Record<string, VariantDef> = {}, defaultTone = 'default'): VariantAxis {
  return { label: 'Tone', default: defaultTone, options: toneVariants(mutedNodes, extra) };
}

/** A layout axis. Its "default" option is the arrangement the design has with no layout rules. */
export function layoutAxis(options: Record<string, VariantDef>): VariantAxis {
  return { label: 'Layout', default: 'default', options };
}

export const eyebrowStyles = { textStyle: tok('text.eyebrow'), color: tok('color.brand') };
export const mutedStyles = { color: tok('color.muted') };

/** Heading block: eyebrow, heading and lead stacked. */
export function headingBlock(
  b: TreeBuilder,
  opts: { level?: 'h1' | 'h2'; style?: string; align?: 'start' | 'center'; eyebrow?: boolean; lead?: boolean; maxWidth?: string } = {}
): string {
  const kids: string[] = [];
  if (opts.eyebrow !== false) kids.push(b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }));
  kids.push(b.text('heading', opts.level ?? 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok(opts.style ?? 'text.h2') } }));
  if (opts.lead !== false)
    kids.push(b.text('lead', 'p', { $prop: 'lead' }, { name: 'Lead', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles } }));
  return b.el(
    'intro',
    'div',
    {
      name: 'Heading group',
      styles: {
        base: {
          layout: 'stack',
          gap: tok('space.md'),
          maxWidth: opts.maxWidth ?? '760px',
          textAlign: opts.align ?? 'start',
          ...(opts.align === 'center' ? { marginInline: 'auto', align: 'center' } : {})
        }
      }
    },
    kids
  );
}
