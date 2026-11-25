/** Editorial's identity, tokens, base CSS, fonts and composition guidance. Its components are Foundation's contracts, laid out the Editorial way (./components). */
import { createPack } from '../dsl';
import { FOUNDATION_EXAMPLES } from '../foundation/ai-examples';
import { foundationArticleTemplate } from '../foundation/article';
import { EDITORIAL_TOKENS } from './tokens';
import { EDITORIAL_BASE_CSS } from './base.css';
import { EDITORIAL_CONTRAST_PAIRS } from './contrast';
import { EDITORIAL_FONTS } from './fonts';

export const EDITORIAL = createPack({
  id: 'editorial',
  name: 'Editorial',
  version: '0.1.0',
  license: 'MIT-0',
  description: 'High-contrast and typographic, for magazines, architects and studios: a display serif, hairline rules and asymmetric columns.',
  tokens: EDITORIAL_TOKENS,
  contrastPairs: EDITORIAL_CONTRAST_PAIRS,
  baseCss: EDITORIAL_BASE_CSS,
  fonts: EDITORIAL_FONTS,
  // Built from the site's tokens, so it reads as Editorial without a layout of its own.
  articleTemplate: foundationArticleTemplate(),
  aiProfile: {
    // The components keep Foundation's contracts, so its worked examples hold here unchanged.
    examples: FOUNDATION_EXAMPLES,
    guidance: [
      'Editorial reads like a printed magazine: a high-contrast display serif for headings, a grotesk for text, square corners, hairline rules and no shadows. Let type and whitespace carry the design instead of boxes and colour.',
      'Compose in asymmetric columns. Split hero and Content with image already set copy and picture at about 2:3; Text section and FAQ set their heading in a narrow column beside a wide one, like an index. Prefer these to centered layouts on inner pages.',
      'Services grid is a numbered index (01, 02, 03): write three to six entries with short, parallel titles, in the order a reader should take them.',
      'Keep most sections on the default paper tone; use one Dark section (inverse) per page at most, for statistics or a closing call to action, and the Soft background tone (muted) to separate long runs of text.',
      'Write headlines like a magazine: short, declarative and specific (under eight words), with one or two sentences of supporting text. Use eyebrows as section labels ("Practice", "Selected work", "Index").',
      'Prefer site tokens (color.*, space.*, text.*) over literal values so that brand changes stay consistent. Brand is the single signal colour: keep it for actions, links and the index numbers.'
    ]
  }
});
