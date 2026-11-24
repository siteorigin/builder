/**
 * The packs authored in this repository. `npm run build:packs` builds them into release files, which the app
 * loads at startup like any other pack; tests and scripts register them directly (see ./register-builtin).
 */
import type { AuthoredPack } from './pack';
import { FOUNDATION } from './foundation/pack';
import { heroCentered, heroSplit, pageIntro } from './foundation/heroes';
import { articleHeader, carousel, container, featuresGrid, gallery, mediaSplit, newsList, pageList, stats, stepsMedia, tabsShowcase, textSection } from './foundation/content';
import { blogFeatured, blogGrid, blogList } from './foundation/blog';
import { logoStrip, team, testimonials } from './foundation/people';
import { contact, cta, faq, pricing, pricingToggle } from './foundation/conversion';
import { footer, header } from './foundation/shell';
import { contactForm } from './foundation/form';
import { dataTable } from './foundation/table';
import { siteSearch } from './foundation/search';
import { video } from './foundation/video';
import { makeAltPack } from './foundation-alt';
import { makeEditorialPack } from './editorial';
import { makeSignalPack } from './signal/pack';

export const FOUNDATION_PACK: AuthoredPack = FOUNDATION.define([
  header,
  footer,
  heroCentered,
  heroSplit,
  pageIntro,
  articleHeader,
  logoStrip,
  featuresGrid,
  mediaSplit,
  stepsMedia,
  tabsShowcase,
  textSection,
  stats,
  testimonials,
  team,
  pricing,
  pricingToggle,
  dataTable,
  faq,
  pageList,
  newsList,
  blogFeatured,
  blogGrid,
  blogList,
  gallery,
  carousel,
  video,
  cta,
  contact,
  contactForm,
  siteSearch,
  container
]);

/** Editorial: the same contracts with magazine typography, hairline rules and asymmetric layouts. */
export const EDITORIAL_PACK: AuthoredPack = makeEditorialPack(FOUNDATION_PACK);

/** Signal: Foundation's contracts in a contemporary geometric design (see ./signal). */
export const SIGNAL_PACK: AuthoredPack = makeSignalPack(FOUNDATION_PACK);

/** Development-only: an alternate implementation of the same contracts, for exercising theme switches. */
export const FOUNDATION_ALT_PACK: AuthoredPack = makeAltPack(FOUNDATION_PACK);

/** Shipped packs, then development fixtures. */
export const BUILTIN_PACKS: AuthoredPack[] = [FOUNDATION_PACK, EDITORIAL_PACK, SIGNAL_PACK, FOUNDATION_ALT_PACK];
