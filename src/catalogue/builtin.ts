/**
 * The packs authored in this repository, which tests and scripts register directly (see registerBuiltinPacks).
 * `npm run build:packs` builds Editorial and Signal into release files the app loads at startup like any other pack;
 * the app's Foundation and foundation-alt are the releases built from siteorigin/builder-components and committed in
 * `resources/` (scripts/packs/locked-releases.ts), not these copies.
 */
import type { AuthoredPack } from './pack';
import { FOUNDATION } from './foundation/pack';
import { heroCentered, heroSplit, pageIntro } from './foundation/heroes';
import { articleHeader, carousel, container, featuresGrid, gallery, mediaSplit, newsList, pageList, splitLayout, stats, stepsMedia, tabsShowcase, textSection } from './foundation/content';
import { blogFeatured, blogGrid, blogList } from './foundation/blog';
import { logoStrip, team, testimonials } from './foundation/people';
import { contact, cta, faq, pricing, pricingToggle } from './foundation/conversion';
import { footer, header } from './foundation/shell';
import { contactForm, signupForm } from './foundation/form';
import { dataTable } from './foundation/table';
import { siteSearch } from './foundation/search';
import { video, videoBlock } from './foundation/video';
import { calloutBox, featureCard, statCard, testimonialCard } from './foundation/blocks';
import { makeAltPack } from './foundation-alt';

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
  tabsShowcase,
  stepsMedia,
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
  container,
  splitLayout,
  // Blocks: compact components that go inside a column, a grid cell or a component's slot.
  featureCard,
  statCard,
  testimonialCard,
  calloutBox,
  signupForm,
  videoBlock
]);

/** Development-only: an alternate implementation of the same contracts, for exercising theme switches. */
export const FOUNDATION_ALT_PACK: AuthoredPack = makeAltPack(FOUNDATION_PACK);

/** Shipped packs, then development fixtures. */
export const BUILTIN_PACKS: AuthoredPack[] = [FOUNDATION_PACK, FOUNDATION_ALT_PACK];
