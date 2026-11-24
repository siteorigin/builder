/** Foundation's identity, tokens, base CSS and fonts. Its component modules are written with these helpers. */
import { createPack } from '../dsl';
import { FOUNDATION_TOKENS } from './tokens';
import { FOUNDATION_BASE_CSS } from './base.css';
import { FOUNDATION_CONTRAST_PAIRS } from './contrast';
import { FOUNDATION_FONTS } from './fonts';
import { FOUNDATION_EXAMPLES } from './ai-examples';

export const FOUNDATION = createPack({
  id: 'foundation',
  name: 'Foundation',
  version: '0.1.0',
  license: 'GPL-3.0-or-later',
  description: 'Clean and restrained, for service businesses, studios and personal sites.',
  tokens: FOUNDATION_TOKENS,
  contrastPairs: FOUNDATION_CONTRAST_PAIRS,
  baseCss: FOUNDATION_BASE_CSS,
  fonts: FOUNDATION_FONTS,
  aiProfile: {
    examples: FOUNDATION_EXAMPLES,
    guidance: [
      'Foundation is calm and restrained: generous whitespace, a serif display face for headings and a sans-serif body.',
      'Alternate the tone axis (default, muted, inverse) to create rhythm; avoid two Dark sections in a row.',
      'Begin the home page with a hero, inner pages with a Page introduction, and end most pages with a Call to action.',
      'Prefer site tokens (color.*, space.*, text.*) over literal values so that brand changes stay consistent.',
      'Keep headings short (under ten words) and supporting text to one or two sentences.'
    ]
  }
});
