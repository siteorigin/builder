import type { ComponentDefinition, TokenDef } from '@shared/types';
import { FOUNDATION_TOKENS } from './foundation/tokens';
import { FOUNDATION_BASE_CSS } from './foundation/base.css';
import { heroCentered, heroSplit, pageIntro } from './foundation/heroes';
import { container, featuresGrid, gallery, mediaSplit, stats, textSection } from './foundation/content';
import { logoStrip, team, testimonials } from './foundation/people';
import { contact, cta, faq, pricing } from './foundation/conversion';
import { footer, header } from './foundation/shell';
import { contactForm } from './foundation/form';
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
    faq,
    gallery,
    cta,
    contact,
    contactForm,
    container
  ],
  aiProfile: {
    examples: FOUNDATION_EXAMPLES,
    guidance: [
      'Foundation is calm and restrained: generous whitespace, a serif display face for headings and a sans-serif body.',
      'Alternate section tones (Default, Soft background, Dark) to create rhythm; avoid two Dark sections in a row.',
      'Begin the home page with a hero, inner pages with a Page introduction, and end most pages with a Call to action.',
      'Prefer site tokens (color.*, space.*, text.*) over literal values so that brand changes stay consistent.',
      'Keep headings short (under ten words) and supporting text to one or two sentences.'
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
  variants: Array<{ id: string; label: string }>;
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
      variants: Object.entries(c.variants ?? {}).map(([id, v]) => ({ id, label: v.label }))
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
