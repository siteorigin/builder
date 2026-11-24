import type { ComponentDefinition, TokenDef } from '@shared/types';
import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_TOKENS } from './foundation/tokens';
import { FOUNDATION_BASE_CSS } from './foundation/base.css';
import { FOUNDATION_CONTRAST_PAIRS } from './foundation/contrast';
import { heroCentered, heroSplit, pageIntro } from './foundation/heroes';
import { container, featuresGrid, gallery, mediaSplit, pageList, stats, textSection } from './foundation/content';
import { logoStrip, team, testimonials } from './foundation/people';
import { contact, cta, faq, pricing } from './foundation/conversion';
import { footer, header } from './foundation/shell';
import { contactForm } from './foundation/form';
import { dataTable } from './foundation/table';
import { siteSearch } from './foundation/search';
import { PACK_VERSION } from './dsl';
import { BUNDLED_FONTS } from './fonts';
import { makeAltTheme } from './foundation-alt';
import { FOUNDATION_EXAMPLES, type AiExample } from './foundation/ai-examples';

export interface ThemePack {
  id: string;
  name: string;
  version: string;
  description: string;
  tokens: TokenDef[];
  /** The colour tokens the theme sets against each other, so Site styles can say when a pair stops being readable. */
  contrastPairs?: ContrastPair[];
  baseCss: string;
  /** Font packages the website template installs. The generated layout imports the ones a site uses. */
  fontImports: string[];
  components: ComponentDefinition[];
  aiProfile: { guidance: string[]; examples?: AiExample[] };
  /** Compatibility fixtures are only offered in development builds. */
  devOnly?: boolean;
}

const FOUNDATION: ThemePack = {
  id: 'foundation',
  name: 'Foundation',
  version: PACK_VERSION,
  description: 'Clean and restrained, for service businesses, studios and personal sites.',
  tokens: FOUNDATION_TOKENS,
  contrastPairs: FOUNDATION_CONTRAST_PAIRS,
  baseCss: FOUNDATION_BASE_CSS,
  fontImports: BUNDLED_FONTS.map((f) => f.package),
  components: [
    header,
    footer,
    heroCentered,
    heroSplit,
    pageIntro,
    logoStrip,
    featuresGrid,
    mediaSplit,
    textSection,
    stats,
    testimonials,
    team,
    pricing,
    dataTable,
    faq,
    pageList,
    gallery,
    cta,
    contact,
    contactForm,
    siteSearch,
    container
  ],
  aiProfile: {
    examples: FOUNDATION_EXAMPLES,
    guidance: [
      'Foundation is calm and restrained: generous whitespace, a serif display face for headings and a sans-serif body.',
      'Alternate the tone axis (default, muted, inverse) to create rhythm; avoid two Dark sections in a row.',
      'Begin the home page with a hero, inner pages with a Page introduction, and end most pages with a Call to action.',
      'Prefer site tokens (color.*, space.*, text.*) over literal values so that brand changes stay consistent.',
      'Keep headings short (under ten words) and supporting text to one or two sentences.',
      'A page has one Heading 1, its title. A hero or Page introduction placed below another section heading takes headingLevel "h2"; headingLevel changes the outline, never the look.'
    ]
  }
};

const ALT = makeAltTheme(FOUNDATION.components);
const FOUNDATION_ALT: ThemePack = {
  ...FOUNDATION,
  id: 'foundation-alt',
  name: 'Foundation Alt (development fixture)',
  description: 'Alternate implementation of the Foundation contracts used to test theme switching.',
  tokens: ALT.tokens,
  baseCss: ALT.baseCss,
  components: ALT.components,
  devOnly: true
};

const THEMES: Record<string, ThemePack> = { foundation: FOUNDATION, 'foundation-alt': FOUNDATION_ALT };

export function getTheme(id: string): ThemePack {
  return THEMES[id] ?? FOUNDATION;
}

export function listThemes(): ThemePack[] {
  return Object.values(THEMES);
}

export function catalogueComponent(themeId: string, componentId: string): ComponentDefinition | undefined {
  return getTheme(themeId).components.find((c) => c.componentId === componentId);
}

export interface CatalogueEntry {
  componentId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon?: string;
  /** Option IDs on each variant axis. */
  axes: Record<string, string[]>;
}

export function catalogueEntries(themeId: string): CatalogueEntry[] {
  return getTheme(themeId)
    .components.filter((c) => c.category !== 'shell')
    .map((c) => ({
      componentId: c.componentId,
      name: c.name,
      description: c.description,
      category: c.category,
      tags: c.tags,
      icon: c.icon,
      axes: Object.fromEntries(Object.entries(c.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)]))
    }));
}

export function searchCatalogue(themeId: string, query: string, limit = 10): CatalogueEntry[] {
  const q = query.toLowerCase().trim();
  const entries = catalogueEntries(themeId);
  if (!q) return entries.slice(0, limit);
  const words = q.split(/\s+/);
  return entries
    .map((e) => {
      const hay = `${e.name} ${e.description} ${e.tags.join(' ')} ${e.category} ${e.componentId}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? (e.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

export const CATEGORY_LABELS: Record<string, string> = {
  hero: 'Heroes & intros',
  content: 'Content',
  'social-proof': 'Social proof',
  conversion: 'Conversion',
  media: 'Media',
  layout: 'Layout',
  custom: 'Project components',
  primitive: 'Basics'
};
