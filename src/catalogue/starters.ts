import type { GraphNode, ImageValue, InstanceNode, LinkValue, NodeTree, PageDoc, ProjectState } from '@shared/types';
import { SCHEMA_VERSION, GENERATOR_VERSION } from '@shared/types';
import { installComponent, makeInstance } from '@engine/install';
import { newId } from '@shared/ids';
import { getTheme, themeLockEntry } from './index';
import { canonicalRich } from './dsl';
import { TEMPLATE_VERSION } from './fonts';

export type StarterId = 'business' | 'blank';

export const STARTERS: Array<{ id: StarterId; name: string; description: string }> = [
  { id: 'business', name: 'Business starter', description: 'Home, About and Contact pages with shared navigation, ready to make your own.' },
  { id: 'blank', name: 'Blank site', description: 'A single Home page with one empty section and the shared header and footer.' }
];

export interface StarterAsset {
  id: string;
  /** File name inside the bundled starter asset folder. */
  source: string;
  name: string;
  alt: string;
}

/** Sample images bundled with the business starter. They are fictional and free to replace. */
export const STARTER_ASSETS: StarterAsset[] = [
  { id: 'a_hero', source: 'hero.jpg', name: 'Hero interior', alt: 'A bright living room with oak furniture and linen curtains' },
  { id: 'a_studio', source: 'studio.jpg', name: 'Studio table', alt: 'Material samples and drawings spread across a studio table' },
  { id: 'a_kitchen', source: 'kitchen.jpg', name: 'Kitchen', alt: 'A calm kitchen with timber cabinets and a stone worktop' },
  { id: 'a_bedroom', source: 'bedroom.jpg', name: 'Bedroom', alt: 'A quiet bedroom with soft morning light' },
  { id: 'a_reading', source: 'reading.jpg', name: 'Reading nook', alt: 'A reading corner with an armchair and shelves of books' },
  { id: 'a_dining', source: 'dining.jpg', name: 'Dining room', alt: 'A dining table set beside a tall window' },
  { id: 'a_person1', source: 'person-1.jpg', name: 'Portrait 1', alt: 'Portrait of Hannah Wells' },
  { id: 'a_person2', source: 'person-2.jpg', name: 'Portrait 2', alt: 'Portrait of Marcus Lee' },
  { id: 'a_person3', source: 'person-3.jpg', name: 'Portrait 3', alt: 'Portrait of Sofia Alvarez' }
];

const pageLink = (pageId: string): LinkValue => ({ type: 'page', target: pageId });
const img = (assetId: string | null, alt: string): ImageValue => ({ assetId, alt });

function page(id: string, title: string, route: string, nodes: GraphNode[], seo: PageDoc['seo'] = {}): PageDoc {
  const map: Record<string, GraphNode> = {};
  for (const n of nodes) map[n.id] = n;
  const rootIds = nodes.filter((n) => !(n as { _child?: boolean })._child).map((n) => n.id);
  for (const n of nodes) delete (n as { _child?: boolean })._child;
  return { schemaVersion: SCHEMA_VERSION, id, title, route, seo, showHeader: true, showFooter: true, rootIds, nodes: map };
}

function emptyState(name: string, themeId = 'foundation'): ProjectState {
  // The theme the site records is the one it is made with, even when the one asked for is not installed here.
  const theme = getTheme(themeId);
  return {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      projectId: newId('p', 12),
      name,
      createdAt: new Date().toISOString(),
      template: { id: 'sveltekit-brochure', version: TEMPLATE_VERSION },
      generator: GENERATOR_VERSION,
      app: '0.1.0'
    },
    site: {
      schemaVersion: SCHEMA_VERSION,
      name,
      language: 'en',
      description: '',
      homePageId: '',
      pageOrder: [],
      themeId: theme.id,
      shell: { header: { rootIds: [], nodes: {} }, footer: { rootIds: [], nodes: {} } }
    },
    pages: {},
    components: {},
    tokens: { schemaVersion: SCHEMA_VERSION, overrides: {}, custom: [] },
    assets: { schemaVersion: SCHEMA_VERSION, assets: {} },
    themeLock: { schemaVersion: SCHEMA_VERSION, theme: themeLockEntry(theme), components: {} }
  };
}

function inst(state: ProjectState, componentId: string, props: Record<string, unknown> = {}, variant?: string): InstanceNode {
  const defId = installComponent(state, componentId);
  const def = state.components[defId];
  const stored = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Object.hasOwn(def.properties, k) ? canonicalRich(def.properties[k], v) : v]));
  return makeInstance(def, stored, variant);
}

function tree(node: InstanceNode): NodeTree {
  return { rootIds: [node.id], nodes: { [node.id]: node } };
}

export function createStarterState(starter: StarterId, siteName: string, withSampleImages: boolean): ProjectState {
  const s = emptyState(siteName);
  const A = (id: string) => (withSampleImages ? id : null);
  const alt = (id: string) => STARTER_ASSETS.find((a) => a.id === id)?.alt ?? '';

  const home = newId('pg');
  const about = newId('pg');
  const contact = newId('pg');

  if (starter === 'blank') {
    const heading: GraphNode & { _child?: boolean } = { id: newId('n'), kind: 'text', tag: 'h1', text: `Welcome to ${siteName}`, styles: { base: { textStyle: { token: 'text.h1' } } }, _child: true };
    const para: GraphNode & { _child?: boolean } = { id: newId('n'), kind: 'text', tag: 'p', text: 'Select this text to edit it, or add sections from the Insert panel.', styles: { base: { textStyle: { token: 'text.lead' }, color: { token: 'color.muted' } } }, _child: true };
    const section = inst(s, 'layout.section');
    section.slots = { content: [heading.id, para.id] };
    s.pages[home] = page(home, 'Home', '/', [section, heading, para]);
    s.site.homePageId = home;
    s.site.pageOrder = [home];
    s.site.shell.header = tree(inst(s, 'shell.header', { siteName, links: [{ id: 'i1', label: 'Home', link: pageLink(home) }] }));
    s.site.shell.footer = tree(inst(s, 'shell.footer', { siteName, tagline: 'A short sentence about what you do.', links: [{ id: 'i1', label: 'Home', link: pageLink(home) }], copyright: `© ${new Date().getFullYear()} ${siteName}.` }));
    return s;
  }

  s.site.description = `${siteName} is an independent interior design studio creating calm, practical homes and small workplaces.`;
  const homeNodes: GraphNode[] = [
    inst(s, 'hero.split', {
      eyebrow: 'Interior design studio',
      heading: 'Calm, considered spaces for everyday life',
      lead: `${siteName} designs homes and small workplaces that feel good to live and work in, with clear plans, honest materials and no surprises.`,
      primaryLabel: 'Start a project',
      primaryLink: pageLink(contact),
      secondaryLabel: 'About the studio',
      secondaryLink: pageLink(about),
      image: img(A('a_hero'), alt('a_hero'))
    }),
    inst(s, 'logos.strip', { heading: 'Trusted by homeowners and local businesses' }),
    inst(s, 'features.grid', {
      eyebrow: 'Services',
      heading: 'Everything your project needs, in one place',
      lead: 'Choose a single stage or let us guide the whole project from first sketch to final styling.',
      items: [
        { id: 'i1', icon: 'compass', title: 'Planning & layout', description: 'Room-by-room plans that make the most of light, flow and storage before anything is built.', linkLabel: '', link: { type: 'none', target: '' } },
        { id: 'i2', icon: 'palette', title: 'Materials & colour', description: 'Finishes, colours and lighting chosen to work together and to last for years.', linkLabel: '', link: { type: 'none', target: '' } },
        { id: 'i3', icon: 'hammer', title: 'Project delivery', description: 'We coordinate trusted trades and keep you informed until the final handover.', linkLabel: '', link: { type: 'none', target: '' } }
      ]
    }),
    inst(s, 'content.media', {
      eyebrow: 'Our approach',
      heading: 'Good design starts with listening',
      body: [
        'Before we draw anything we spend time understanding how you live and work, what matters most and what you would happily leave behind.',
        'That conversation shapes **every decision** that follows, from the first sketch to the last cushion.'
      ],
      image: img(A('a_studio'), alt('a_studio')),
      actionLabel: 'Meet the team',
      actionLink: pageLink(about)
    }, 'media-end'),
    inst(s, 'stats.row', {}, 'inverse'),
    inst(s, 'media.gallery', {
      eyebrow: 'Selected work',
      heading: 'Recent projects',
      images: [
        { id: 'i1', image: img(A('a_kitchen'), alt('a_kitchen')), caption: 'Kitchen, Millbrook', action: 'image' },
        { id: 'i2', image: img(A('a_bedroom'), alt('a_bedroom')), caption: 'Bedroom, Ashford', action: 'image' },
        { id: 'i3', image: img(A('a_reading'), alt('a_reading')), caption: 'Reading room, Old Mill', action: 'image' }
      ]
    }),
    inst(s, 'testimonials.grid', {}, 'muted'),
    inst(s, 'cta.banner', {
      heading: 'Let’s make your space work better',
      lead: 'Tell us about your home or workplace and we will arrange a free first conversation.',
      primaryLabel: 'Get in touch',
      primaryLink: pageLink(contact)
    })
  ];
  s.pages[home] = page(home, 'Home', '/', homeNodes, { description: s.site.description });

  const aboutNodes: GraphNode[] = [
    inst(s, 'intro.page', { eyebrow: 'About', heading: 'A small studio with a long view', lead: `${siteName} was founded to make good design straightforward, personal and affordable.` }),
    inst(s, 'content.media', {
      eyebrow: 'Our story',
      heading: 'Fifteen years of homes, studios and cafés',
      body: [
        'We started as a two-person practice working on family homes. Today we are a team of five, still working from the same small studio on Harbour Lane.',
        'We take on a limited number of projects each year so that every client gets our full attention.'
      ],
      image: img(A('a_dining'), alt('a_dining')),
      actionLabel: '',
      actionLink: { type: 'none', target: '' }
    }),
    inst(s, 'team.grid', {
      people: [
        { id: 'i1', portrait: img(A('a_person1'), alt('a_person1')), name: 'Hannah Wells', role: 'Founder & lead designer', bio: 'Fifteen years designing homes and small workplaces.' },
        { id: 'i2', portrait: img(A('a_person2'), alt('a_person2')), name: 'Marcus Lee', role: 'Project manager', bio: 'Keeps every schedule, budget and contractor on track.' },
        { id: 'i3', portrait: img(A('a_person3'), alt('a_person3')), name: 'Sofia Alvarez', role: 'Interior designer', bio: 'Specialises in materials, colour and lighting.' }
      ]
    }, 'muted'),
    inst(s, 'cta.banner', { heading: 'Have a project in mind?', primaryLabel: 'Contact the studio', primaryLink: pageLink(contact) })
  ];
  s.pages[about] = page(about, 'About', '/about/', aboutNodes, { description: `Meet the team behind ${siteName}.` });

  const contactNodes: GraphNode[] = [
    inst(s, 'intro.page', { eyebrow: 'Contact', heading: 'Let’s talk', lead: 'Whether you are planning a single room or a whole building, we would love to hear about it.' }),
    inst(s, 'contact.details', { heading: 'Get in touch', eyebrow: '' }),
    inst(s, 'faq.list', {}, 'muted')
  ];
  s.pages[contact] = page(contact, 'Contact', '/contact/', contactNodes, { description: `Contact ${siteName}.` });

  s.site.homePageId = home;
  s.site.pageOrder = [home, about, contact];
  const nav = [
    { id: 'i1', label: 'Home', link: pageLink(home) },
    { id: 'i2', label: 'About', link: pageLink(about) },
    { id: 'i3', label: 'Contact', link: pageLink(contact) }
  ];
  s.site.shell.header = tree(inst(s, 'shell.header', { siteName, links: nav, ctaLabel: 'Book a call', ctaLink: pageLink(contact) }));
  s.site.shell.footer = tree(
    inst(s, 'shell.footer', {
      siteName,
      tagline: 'Calm, considered interiors for homes and small workplaces.',
      links: nav,
      copyright: `© ${new Date().getFullYear()} ${siteName}. All rights reserved.`
    })
  );
  return s;
}
