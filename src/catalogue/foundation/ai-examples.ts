import type { AiExample } from '../pack';

export type { AiExample };

const NO_IMAGE = { assetId: null, alt: '' };

export const FOUNDATION_EXAMPLES: AiExample[] = [
  {
    id: 'hero-centered-trade',
    componentId: 'hero.centered',
    keywords: ['home', 'homepage', 'hero', 'landing', 'banner', 'headline', 'site', 'website'],
    description: 'Home page opening for a local trade business',
    props: { eyebrow: 'Family-run since 1998', heading: 'Plumbing you can set your watch by', lead: 'Same-day repairs and honest quotes across the Harbour district.', primaryLabel: 'Book a visit', primaryLink: '/contact/', secondaryLabel: 'See services', secondaryLink: '/services/' }
  },
  {
    id: 'hero-split-studio',
    componentId: 'hero.split',
    keywords: ['hero', 'image', 'photo', 'studio', 'portfolio', 'landing'],
    description: 'Opening section with an image beside the headline',
    variant: 'muted',
    props: { eyebrow: 'Interior design', heading: 'Rooms that work as well as they look', lead: 'We plan, source and install calm, durable interiors.', primaryLabel: 'Start a project', primaryLink: '/contact/', image: NO_IMAGE }
  },
  {
    id: 'intro-page-services',
    componentId: 'intro.page',
    keywords: ['intro', 'about', 'services', 'pricing', 'inner', 'contact'],
    description: 'Opening section for an inner page',
    props: { eyebrow: 'Services', heading: 'Everything your garden needs, all year', lead: 'From a one-off tidy to full landscape design.' }
  },
  {
    id: 'logos-clients',
    componentId: 'logos.strip',
    keywords: ['logos', 'clients', 'partners', 'trusted', 'brands'],
    description: 'A row of client names',
    props: { heading: 'Trusted by local businesses', logos: [{ name: 'Northwind' }, { name: 'Alder & Co' }, { name: 'Tidewater' }, { name: 'Fernhill' }] }
  },
  {
    id: 'features-services',
    componentId: 'features.grid',
    keywords: ['services', 'features', 'benefits', 'offer', 'what', 'grid', 'cards', 'site', 'website'],
    description: 'Three service cards with icons',
    props: {
      eyebrow: 'What we do',
      heading: 'Three ways we can help',
      lead: 'Pick one service or combine them into a yearly plan.',
      items: [
        { icon: 'leaf', title: 'Garden care', description: 'Weekly or monthly visits to keep beds, lawns and hedges in shape.' },
        { icon: 'compass', title: 'Landscape design', description: 'A clear plan and planting scheme drawn for your site.' },
        { icon: 'sparkles', title: 'Seasonal refresh', description: 'A one-day reset before spring or after a long winter.' }
      ]
    }
  },
  {
    id: 'content-media-story',
    componentId: 'content.media',
    keywords: ['about', 'story', 'history', 'mission', 'image', 'photo', 'approach'],
    description: 'A short story beside an image',
    variant: 'media-end',
    props: { eyebrow: 'Our story', heading: 'Started with one van and a good reputation', body: 'We began in 2009 fixing boilers for neighbours.\n\nToday a team of **twelve** looks after homes across the county.', image: NO_IMAGE, actionLabel: 'Meet the team', actionLink: '/about/' }
  },
  {
    id: 'content-text-policy',
    componentId: 'content.text',
    keywords: ['text', 'article', 'policy', 'privacy', 'terms', 'legal', 'paragraphs'],
    description: 'A heading with plain paragraphs',
    props: { heading: 'How we handle your details', body: 'We only keep the details needed to answer your enquiry.\n\nAsk us at any time and we will delete them.' }
  },
  {
    id: 'stats-results',
    componentId: 'stats.row',
    keywords: ['stats', 'numbers', 'results', 'figures', 'metrics', 'achievements'],
    description: 'A row of proof points',
    variant: 'inverse',
    props: { heading: 'A track record you can check', items: [{ value: '1,200+', label: 'Homes served' }, { value: '25 yrs', label: 'In business' }, { value: '4.9/5', label: 'Average review' }] }
  },
  {
    id: 'testimonials-clients',
    componentId: 'testimonials.grid',
    keywords: ['testimonials', 'reviews', 'quotes', 'customers', 'feedback', 'social'],
    description: 'Client quotes',
    props: {
      eyebrow: 'Kind words',
      heading: 'What our clients say',
      lead: 'A few notes from recent projects.',
      items: [
        { quote: 'They arrived on time, explained everything and left the place spotless.', name: 'Priya Nair', role: 'Homeowner', portrait: NO_IMAGE },
        { quote: 'The clearest quote we received, and the final bill matched it.', name: 'Tom Becker', role: 'Cafe owner', portrait: NO_IMAGE }
      ]
    }
  },
  {
    id: 'team-people',
    componentId: 'team.grid',
    keywords: ['team', 'people', 'staff', 'about', 'founders', 'who'],
    description: 'Team members',
    props: {
      eyebrow: 'The team',
      heading: 'The people behind the work',
      lead: 'Small on purpose, so you always know who you are talking to.',
      people: [
        { portrait: NO_IMAGE, name: 'Sara Lindqvist', role: 'Founder', bio: 'Twenty years in residential architecture.' },
        { portrait: NO_IMAGE, name: 'Marcus Hale', role: 'Project lead', bio: 'Keeps every build on schedule.' }
      ]
    }
  },
  {
    id: 'pricing-three-plans',
    componentId: 'pricing.plans',
    keywords: ['pricing', 'prices', 'plans', 'packages', 'cost', 'rates', 'fees', 'tiers'],
    description: 'Three priced packages',
    props: {
      eyebrow: 'Pricing',
      heading: 'Simple packages, fixed fees',
      lead: 'Every package starts with a free consultation.',
      plans: [
        { name: 'Essential', price: '$490', period: 'per project', description: 'For a single room.', features: 'One design concept\nShopping list', actionLabel: 'Choose Essential', actionLink: '/contact/' },
        { name: 'Complete', price: '$1,450', period: 'per project', description: 'For a whole floor.', badge: 'Most popular', features: 'Three design concepts\nSourcing and orders\nTwo site visits', actionLabel: 'Choose Complete', actionLink: '/contact/' },
        { name: 'Managed', price: '$3,200', period: 'per project', description: 'We run the whole job.', features: 'Everything in Complete\nContractor management', actionLabel: 'Talk to us', actionLink: '/contact/' }
      ]
    }
  },
  {
    id: 'faq-common',
    componentId: 'faq.list',
    keywords: ['faq', 'faqs', 'questions', 'answers', 'help'],
    description: 'Frequently asked questions',
    props: {
      eyebrow: 'Questions',
      heading: 'Good to know',
      lead: 'Still unsure? Send us a message.',
      items: [
        { question: 'How soon can you start?', answer: 'Most jobs start within two weeks of your approval.' },
        { question: 'Do you offer a guarantee?', answer: 'All work is guaranteed for twelve months.' }
      ]
    }
  },
  {
    id: 'pages-portfolio',
    componentId: 'content.pages',
    keywords: ['portfolio', 'projects', 'case', 'studies', 'study', 'directory', 'index', 'pages', 'work', 'list'],
    description: "A portfolio index of the site's own project pages: leave a card's title, description and image empty to show the page's own; type them only to override",
    props: { eyebrow: 'Our work', heading: 'Selected projects', items: [{ pageLink: '/about/' }, { pageLink: '/contact/', description: 'Tell us about your project and we will reply within two days.' }] }
  },
  {
    id: 'news-latest',
    componentId: 'content.news',
    keywords: ['news', 'articles', 'posts', 'blog', 'announcements', 'updates', 'latest', 'recent', 'journal'],
    description: "The latest dated articles, newest first. The cards fill themselves from the site's article pages: never send items. Make a page an article with page.create starter \"article\" or page.update articleDate",
    props: { eyebrow: 'News', heading: 'Latest from the market' }
  },
  {
    id: 'blog-featured',
    componentId: 'blog.featured',
    keywords: ['featured', 'blog', 'posts', 'lead', 'highlight', 'spotlight'],
    description: "The newest blog post shown large. It fills itself from a collection's published entries: never send items. Choose which with collection, category and tag",
    props: { heading: 'From the journal' }
  },
  {
    id: 'blog-grid-latest',
    componentId: 'blog.grid',
    keywords: ['blog', 'posts', 'latest', 'related', 'articles', 'journal', 'studies', 'stories'],
    description: "Cards for the newest blog posts. They fill themselves from a collection's published entries, newest first: never send items. Choose which with collection, category, tag and count; in a collection's layout it lists the other posts",
    props: { heading: 'Latest articles', count: 3 }
  },
  {
    id: 'blog-list-recent',
    componentId: 'blog.list',
    keywords: ['blog', 'posts', 'recent', 'headlines', 'archive', 'list'],
    description: "A compact list of recent blog posts without pictures. It fills itself from a collection's published entries: never send items. Choose which with collection, category (a term ID or name), tag and count",
    props: { heading: 'Recent posts', count: 5 }
  },
  {
    id: 'article-header',
    componentId: 'content.article',
    keywords: ['article', 'news', 'post', 'announcement', 'byline', 'date', 'published'],
    description: "The top of a dated article page. Its title, date, byline and excerpt come from the page's article settings (page.update articleDate, byline, excerpt): never send them as props",
    props: { eyebrow: 'Announcement' }
  },
  {
    id: 'gallery-work',
    componentId: 'media.gallery',
    keywords: ['gallery', 'portfolio', 'work', 'photos', 'images', 'projects'],
    description: 'A gallery of recent work: an image can open full size (action "image") or lead to its project page (action "link")',
    props: {
      eyebrow: 'Recent work',
      heading: 'A few favourite projects',
      lead: 'Each one shaped around how the client lives.',
      images: [
        { image: NO_IMAGE, caption: 'Kitchen, Millbrook', action: 'link', link: '/about/' },
        { image: NO_IMAGE, caption: 'Courtyard, Eastside', action: 'image' }
      ]
    }
  },
  {
    id: 'carousel-product-tour',
    componentId: 'media.carousel',
    keywords: ['carousel', 'slider', 'slides', 'slideshow', 'swipe', 'product tour', 'case study', 'portfolio'],
    description: 'Slides that scroll sideways with Previous and Next buttons: an image and caption each, optionally linking to a page. layout one-column, two-columns or default (three) sets how many show at once on a desktop',
    variants: { layout: 'two-columns' },
    props: {
      eyebrow: 'Product tour',
      heading: 'See how it comes together',
      slides: [
        { image: NO_IMAGE, caption: 'Measuring the room', link: '/about/' },
        { image: NO_IMAGE, caption: 'Choosing the finishes' },
        { image: NO_IMAGE, caption: 'Fitting day' }
      ]
    }
  },
  {
    id: 'video-studio-tour',
    componentId: 'media.video',
    keywords: ['video', 'youtube', 'vimeo', 'embed', 'film', 'tour', 'demo', 'watch', 'clip'],
    description: "One YouTube or Vimeo video under a heading. The url is the author's own video: leave it empty and ask them for the address of a single video. Never make one up or reuse one from elsewhere",
    props: { heading: 'Take a tour of the studio', lead: 'Two minutes inside the workshop, from the bench to the kiln.', title: 'Tour of our studio', url: '' }
  },
  {
    id: 'cta-contact',
    componentId: 'cta.banner',
    keywords: ['cta', 'action', 'call', 'banner', 'closing', 'site', 'website', 'services', 'pricing'],
    description: 'A closing call to action',
    props: { heading: 'Ready when you are', lead: 'Tell us what you need and we will reply within two working days.', primaryLabel: 'Get in touch', primaryLink: '/contact/' }
  },
  {
    id: 'contact-details',
    componentId: 'contact.details',
    keywords: ['contact', 'phone', 'email', 'address', 'hours', 'location'],
    description: 'Ways to get in touch',
    props: {
      eyebrow: 'Contact',
      heading: 'Talk to a real person',
      lead: 'We answer every message within two working days.',
      items: [
        { icon: 'mail', label: 'Email', value: 'hello@example.com', link: { type: 'email', target: 'hello@example.com' } },
        { icon: 'phone', label: 'Phone', value: '+1 555 0134', link: { type: 'tel', target: '+15550134' } },
        { icon: 'map-pin', label: 'Workshop', value: '12 Harbour Lane' }
      ]
    }
  },
  {
    id: 'contact-form-enquiry',
    componentId: 'contact.form',
    keywords: ['form', 'enquiry', 'inquiry', 'message', 'contact', 'booking', 'quote'],
    description: 'An enquiry form',
    props: {
      eyebrow: 'Enquiries',
      heading: 'Tell us about your project',
      lead: 'A few details help us give you a useful first answer.',
      fields: [
        { label: 'Name', name: 'name', type: 'text', required: true },
        { label: 'Email', name: 'email', type: 'email', required: true },
        { label: 'Message', name: 'message', type: 'textarea', required: true }
      ],
      submitLabel: 'Send enquiry'
    }
  },
  {
    id: 'data-table-plans',
    componentId: 'data.table',
    keywords: ['table', 'timetable', 'schedule', 'comparison', 'compare', 'plans', 'hours', 'price list', 'rows', 'columns'],
    description: 'A side-by-side plan comparison, with the first column naming each row',
    props: {
      heading: 'Compare plans',
      caption: 'What each plan includes',
      rowHeaders: true,
      table: {
        columns: ['Feature', 'Starter', 'Studio'],
        rows: [
          ['Monthly sessions', '2', 'Unlimited'],
          ['Materials included', 'No', 'Yes'],
          ['Kiln firings', '4', '12']
        ]
      }
    }
  },
  {
    id: 'site-search-portfolio',
    componentId: 'site.search',
    keywords: ['search', 'find', 'look up', 'lookup', 'portfolio', 'projects', 'archive', 'directory'],
    description: 'A search box visitors use to find a page by its name or the words on it',
    props: { eyebrow: 'Portfolio', heading: 'Find a project', lead: 'Search every project by name, place or material.', label: 'Search projects', placeholder: 'For example: walnut table', buttonLabel: 'Search' }
  }
];
