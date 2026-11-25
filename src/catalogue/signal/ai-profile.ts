/**
 * What the assistant is told about Signal: how its design reads, and worked examples in its voice (product teams,
 * consultancies and modern trades). Signal's components are Foundation's contracts, so the examples for sections
 * whose copy suits either theme are Foundation's; the ones that set a site's voice are Signal's own.
 */
import type { AiExample } from '../pack';
import { FOUNDATION_EXAMPLES } from '../foundation/ai-examples';

const NO_IMAGE = { assetId: null, alt: '' };

export const SIGNAL_GUIDANCE: string[] = [
  'Signal is crisp and contemporary: geometric Sora headings, DM Sans text, small mono eyebrow labels in soft pills, and tinted cards with generous corners that lift on hover.',
  'Give every section a short eyebrow (one to three words): Signal sets it in capitals in a pill, so it reads as a label, not a sentence.',
  'Put the most important offer first in a Services grid: with three or more cards Signal shows the first as a large featured tile, so three or five cards fill the grid best.',
  'Alternate the tone axis (default, muted, inverse) for rhythm; on a muted section cards turn white, which suits pricing, FAQs and contact details. Avoid two Dark sections in a row.',
  'Begin the home page with a hero (the split hero suits a product screenshot), inner pages with a Page introduction, and end most pages with a Call to action.',
  'Write in a direct, specific voice: concrete outcomes and numbers over adjectives. Keep headings under ten words and supporting text to one or two sentences.',
  'Prefer site tokens (color.*, space.*, text.*) over literal values so that brand changes stay consistent.'
];

const OWN: AiExample[] = [
  {
    id: 'hero-centered-product',
    componentId: 'hero.centered',
    keywords: ['home', 'homepage', 'hero', 'landing', 'banner', 'headline', 'site', 'website', 'product', 'software', 'app'],
    description: 'Home page opening for a software product',
    props: { eyebrow: 'Now in beta', heading: 'Scheduling that runs itself', lead: 'Crewline books jobs, routes your team and invoices on completion, all from one board.', primaryLabel: 'Start free', primaryLink: '/contact/', secondaryLabel: 'See how it works', secondaryLink: '/about/' }
  },
  {
    id: 'hero-split-consultancy',
    componentId: 'hero.split',
    keywords: ['hero', 'image', 'photo', 'consultancy', 'agency', 'landing', 'screenshot'],
    description: 'Opening section with an image beside the headline, for a consultancy',
    variant: 'muted',
    props: { eyebrow: 'Data strategy', heading: 'Decisions backed by numbers you trust', lead: 'We audit, clean and connect your data in six weeks, then hand you the keys.', primaryLabel: 'Book a call', primaryLink: '/contact/', image: NO_IMAGE }
  },
  {
    id: 'features-product',
    componentId: 'features.grid',
    keywords: ['services', 'features', 'benefits', 'offer', 'what', 'grid', 'cards', 'site', 'website', 'product', 'platform'],
    description: 'Feature cards with the headline feature first',
    props: {
      eyebrow: 'Platform',
      heading: 'Everything a field team needs',
      lead: 'One tool from first call to final invoice.',
      items: [
        { icon: 'calendar', title: 'Smart scheduling', description: 'Drag a job onto the board and Crewline finds the nearest free technician with the right skills.' },
        { icon: 'map-pin', title: 'Live routing', description: 'Routes update as jobs move, so nobody drives across town twice.' },
        { icon: 'zap', title: 'Instant invoicing', description: 'Invoices go out the moment a job is signed off.' }
      ]
    }
  },
  {
    id: 'stats-product',
    componentId: 'stats.row',
    keywords: ['stats', 'numbers', 'results', 'figures', 'metrics', 'achievements', 'impact'],
    description: 'A row of product metrics',
    variant: 'inverse',
    props: { heading: 'Numbers our customers report', items: [{ value: '38%', label: 'Less time scheduling' }, { value: '2.4x', label: 'Faster payment' }, { value: '99.9%', label: 'Uptime last year' }, { value: '12k', label: 'Jobs a week' }] }
  },
  {
    id: 'pricing-tiers',
    componentId: 'pricing.plans',
    keywords: ['pricing', 'prices', 'plans', 'packages', 'cost', 'rates', 'fees', 'tiers', 'subscription'],
    description: 'Three subscription tiers',
    variant: 'muted',
    props: {
      eyebrow: 'Pricing',
      heading: 'Plans that grow with your team',
      lead: 'Every plan starts with a 14-day trial.',
      plans: [
        { name: 'Starter', price: '$29', period: 'per month', description: 'For a solo operator.', features: 'One user\nUnlimited jobs', actionLabel: 'Start Starter', actionLink: '/contact/' },
        { name: 'Team', price: '$89', period: 'per month', description: 'For crews of up to ten.', badge: 'Most popular', features: 'Ten users\nLive routing\nInvoicing', actionLabel: 'Start Team', actionLink: '/contact/' },
        { name: 'Scale', price: '$249', period: 'per month', description: 'For multiple depots.', features: 'Unlimited users\nPriority support', actionLabel: 'Talk to sales', actionLink: '/contact/' }
      ]
    }
  },
  {
    id: 'cta-trial',
    componentId: 'cta.banner',
    keywords: ['cta', 'action', 'call', 'banner', 'closing', 'site', 'website', 'trial', 'demo', 'signup'],
    description: 'A closing call to action for a product trial',
    props: { heading: 'See it on your own jobs', lead: 'Set up takes ten minutes. No card needed.', primaryLabel: 'Start free trial', primaryLink: '/contact/' }
  }
];

/** Signal's own examples, then Foundation's for the sections Signal has none of its own for. */
export const SIGNAL_EXAMPLES: AiExample[] = [...OWN, ...FOUNDATION_EXAMPLES.filter((e) => !OWN.some((o) => o.componentId === e.componentId))];
