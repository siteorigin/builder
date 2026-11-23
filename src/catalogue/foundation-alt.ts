/**
 * Development-only compatibility fixture: an alternate implementation of the Foundation contracts.
 * Same componentIds, properties, parts, slots and variants; different tokens and at least one changed
 * internal layout. It exists to exercise theme switching and is never offered in packaged builds.
 */
import type { TokenDef } from '@shared/types';
import { createPack } from './dsl';
import type { AuthoredPack } from './pack';

const TOKEN_CHANGES: Record<string, TokenDef['value']> = {
  'color.background': '#f6f7fb',
  'color.surface-alt': '#eceef6',
  'color.brand': '#3442b8',
  'color.brand-strong': '#27329a',
  'color.accent': '#e2725b',
  'color.inverse': '#161a33',
  'font.display': "'Inter Variable', 'Inter', system-ui, sans-serif",
  'radius.lg': '8px',
  'radius.md': '6px'
};

export function makeAltPack(base: AuthoredPack): AuthoredPack {
  const { components: baseComponents, ...meta } = base;
  const alt = createPack({
    ...meta,
    id: 'foundation-alt',
    name: 'Foundation Alt (development fixture)',
    description: 'Alternate implementation of the Foundation contracts used to test theme switching.',
    tokens: meta.tokens.map((t) => (t.id in TOKEN_CHANGES ? { ...t, value: TOKEN_CHANGES[t.id] } : t)),
    devOnly: true
  });
  const components = baseComponents.map((d) => {
    const c = alt.adopt(d);
    if (c.componentId === 'hero.split' && c.tree) {
      // Changed internal layout: media stacked above centered copy, same public parts.
      const grid = c.tree.nodes['grid'];
      if (grid?.kind === 'element') {
        grid.styles = { base: { layout: 'stack', gap: { token: 'space.2xl' }, align: 'center', textAlign: 'center' } };
        grid.children = [...grid.children].reverse();
      }
      const media = c.tree.nodes['media'];
      if (media) media.styles = { base: { aspectRatio: '16/9', radius: { token: 'radius.lg' }, objectFit: 'cover' } };
      const content = c.tree.nodes['content'];
      if (content) content.styles = { base: { layout: 'stack', gap: { token: 'space.lg' }, align: 'center', maxWidth: '760px' } };
    }
    return c;
  });
  return alt.define(components);
}
