/**
 * Signal: a contemporary theme for product teams, consultancies and modern trades. It implements Foundation's
 * component contracts (see ./components) with its own tokens, fonts, stylesheet, article layout and assistant
 * guidance, so a site can switch between the two and keep everything it holds.
 */
import type { NodeTree } from '@shared/types';
import { createPack } from '../dsl';
import type { AuthoredPack } from '../pack';
import { foundationArticleTemplate } from '../foundation/article';
import { SIGNAL_TOKENS } from './tokens';
import { SIGNAL_BASE_CSS } from './base.css';
import { SIGNAL_CONTRAST_PAIRS } from './contrast';
import { SIGNAL_FONTS } from './fonts';
import { SIGNAL_EXAMPLES, SIGNAL_GUIDANCE } from './ai-profile';
import { EYEBROW_PILL, mergeStyles, signalRestyle } from './components';

/** Foundation's article layout with Signal's touches: the category in an eyebrow pill, and the picture's larger corners. */
function signalArticleTemplate(): NodeTree {
  const tree = foundationArticleTemplate();
  const { category, image } = tree.nodes;
  if (!category || !image) throw new Error('The article layout has no category or featured image to restyle.');
  category.styles = mergeStyles(category.styles, EYEBROW_PILL);
  image.styles = mergeStyles(image.styles, { base: { radius: { token: 'radius.lg' } } });
  return tree;
}

/** Signal, built over the authored Foundation pack whose contracts it implements. */
export function makeSignalPack(foundation: AuthoredPack): AuthoredPack {
  const signal = createPack({
    id: 'signal',
    name: 'Signal',
    version: '0.1.0',
    license: 'MIT-0',
    description: 'Geometric and crisp, for product teams, consultancies and modern trades.',
    tokens: SIGNAL_TOKENS,
    contrastPairs: SIGNAL_CONTRAST_PAIRS,
    baseCss: SIGNAL_BASE_CSS,
    fonts: SIGNAL_FONTS,
    articleTemplate: signalArticleTemplate(),
    aiProfile: { guidance: SIGNAL_GUIDANCE, examples: SIGNAL_EXAMPLES }
  });
  return signal.define(foundation.components.map((d) => signalRestyle(signal.adopt(d))));
}
