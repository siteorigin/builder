/**
 * The graded prompts. IDs are stable: reports from different models and dates are compared by them. Grading looks
 * only at the resulting project, so any model may get there its own way; the scripts exist for the free fake run.
 */
import type { ComponentDefinition, InstanceNode, LinkValue, ListItem, PageDoc, ProjectState } from '@shared/types';
import type { ModelEvent } from '@agent/types';
import { applyOperations } from '@engine/apply';
import { richTextToPlain, type RichText } from '@shared/richtext';
import { renderedContent } from '@generator/checks';
import type { Check, EvalCase, ScriptTurn } from './harness';

/** Bump when cases are added, removed or re-graded. */
export const SUITE_VERSION = 2;

let nextCall = 0;
const call = (name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: `call_${++nextCall}`, name, arguments: JSON.stringify(args) }] });
const calls = (...list: Array<[string, unknown]>): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: list.map(([name, args]) => ({ id: `call_${++nextCall}`, name, arguments: JSON.stringify(args) })) });
const finish = (text: string): ScriptTurn => () => [{ type: 'done', stopReason: 'end', text, toolCalls: [] }];

const check = (id: string, pass: boolean, detail?: string): Check => ({ id, pass: !!pass, ...(pass || !detail ? {} : { detail }) });
const pageAt = (s: ProjectState, route: string): PageDoc | undefined => Object.values(s.pages).find((p) => p.route === route);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const instance = (p: PageDoc | undefined, i: number) => (p ? (p.nodes[p.rootIds[i]] as InstanceNode | undefined) : undefined);
const componentId = (s: ProjectState, n: unknown) => (n && (n as InstanceNode).kind === 'instance' ? s.components[(n as InstanceNode).definitionId]?.componentId : undefined);
const sectionIds = (s: ProjectState, p: PageDoc | undefined) => (p ? p.rootIds.map((id) => componentId(s, p.nodes[id]) ?? p.nodes[id]?.kind ?? '') : []);
const findSection = (s: ProjectState, p: PageDoc | undefined, id: string) => (p ? (Object.values(p.nodes).find((n) => p.rootIds.includes(n.id) && componentId(s, n) === id) as InstanceNode | undefined) : undefined);
const shell = (s: ProjectState, part: 'header' | 'footer') => s.site.shell[part].nodes[s.site.shell[part].rootIds[0]] as InstanceNode;
const linksTo = (s: ProjectState, part: 'header' | 'footer', p: PageDoc | undefined) => !!p && ((shell(s, part).props.links as Array<ListItem & { link: LinkValue }>) ?? []).some((l) => l.link?.type === 'page' && l.link.target === p.id);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const selectRoot = (index: number, label: string) => (s: ProjectState) => ({ ref: { owner: { kind: 'page' as const, id: s.site.homePageId }, instancePath: [], nodeId: home(s).rootIds[index] }, label });
const otherSectionsUntouched = (before: ProjectState, after: ProjectState, index: number) => {
  const a = home(before);
  const b = home(after);
  return same(a.rootIds, b.rootIds) && a.rootIds.every((id, i) => i === index || same(a.nodes[id], b.nodes[id]));
};
const shellUntouched = (before: ProjectState, after: ProjectState) => same(before.site.shell, after.site.shell) && same(before.tokens, after.tokens);

const BROKEN_SOURCE = `<script>
	let { quote = 'Quality first' } = $props();
</script>

<blockquote class="quote">{quote</blockquote>

<style>
	.quote { font-style: italic; }
</style>
`;
const WORKING_SOURCE = BROKEN_SOURCE.replace('{quote<', '{quote}<');

/**
 * Grading a page built from pasted copy, by what a visitor sees on it: its sections' words, a piece per field, list
 * item and paragraph, and where its links go. Compared without case, runs of spaces, curly quotes or dash styles, and
 * nothing else: a changed word, figure or punctuation mark is a change.
 */
const plain = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
interface Shown {
  texts: string[];
  links: string[];
}
const shownOn = (s: ProjectState, p: PageDoc | undefined): Shown[] =>
  (p?.rootIds ?? []).map((root) => {
    const shown: Shown = { texts: [], links: [] };
    for (const c of p ? renderedContent(s, p) : []) {
      if (c.nodeId !== root) continue;
      if (c.kind === 'link') {
        const l = c.value as Partial<LinkValue> | undefined;
        if (l?.target) shown.links.push(l.type === 'page' ? `page:${l.target}` : l.target);
        continue;
      }
      const words = Array.isArray(c.value) ? richTextToPlain(c.value as RichText).split(/\n+/) : typeof c.value === 'string' ? [c.value] : [];
      // A quote may keep the quotation marks the draft had around it.
      shown.texts.push(...words.map((w) => plain(w).replace(/^"(.*)"$/, '$1')).filter(Boolean));
    }
    return shown;
  });
/** The first section showing all of `texts`, or -1. */
const sectionWith = (shown: Shown[], ...texts: string[]) => shown.findIndex((x) => texts.every((t) => x.texts.includes(plain(t))));
/** Each block of the draft is shown whole, in a section of its own, in the draft's order. */
const pastedChecks = (before: ProjectState, s: ProjectState, route: string, draft: string, blocks: Array<{ id: string; texts: string[]; link?: [string, string] }>): Check[] => {
  const was = pageAt(before, route);
  const p = pageAt(s, route);
  const shown = shownOn(s, p);
  // The draft is the whole page: a section still exactly as it was is a placeholder left behind.
  const left = (p?.rootIds ?? []).filter((id) => was?.rootIds.includes(id) && same(was.nodes[id], p!.nodes[id]));
  const at = blocks.map((b) => sectionWith(shown, ...b.texts, ...(b.link ? [b.link[0]] : [])));
  const source = plain(draft);
  const extra = shown.flatMap((x) => x.texts).filter((t) => !source.includes(t));
  return [
    ...blocks.map((b, i) => {
      const where = at[i];
      const linked = !b.link || (where >= 0 && shown[where].links.includes(b.link[1]));
      return check(b.id, where >= 0 && linked, where < 0 ? `missing: ${b.texts.find((t) => sectionWith(shown, t) < 0) ?? b.link?.[0] ?? 'a block split across sections'}` : `link: ${shown[where].links.join(', ')}`);
    }),
    // Each block its own section, so a draft poured whole into one text section is not a layout.
    check('reading-order', at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), at.join(', ')),
    check('placeholders-removed', !!p && left.length === 0, left.map((id) => componentId(s, p!.nodes[id])).join(', ')),
    // Every word shown is the draft's: no sample text left behind, no section the draft did not ask for, no filler.
    check('only-supplied-copy', extra.length === 0, extra.slice(0, 3).join(' | '))
  ];
};
/** Nothing outside the page changed: every other page, the header and footer, and the site's styles. */
const restUntouched = (before: ProjectState, after: ProjectState, route: string): Check[] => {
  const target = pageAt(before, route)?.id;
  const others = Object.keys(before.pages).filter((id) => id !== target);
  return [
    check('same-pages', same(Object.keys(before.pages).sort(), Object.keys(after.pages).sort()) && same(before.site.pageOrder, after.site.pageOrder)),
    check('other-pages-untouched', others.every((id) => same(before.pages[id], after.pages[id])), others.filter((id) => !same(before.pages[id], after.pages[id])).join(', ')),
    check('shell-untouched', shellUntouched(before, after))
  ];
};

const CLINIC_DRAFT = `Here is the copy for this page. Please lay it out.

# Give your kettle another winter
Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.
Button: Reserve a bench (https://bench.example/book)

## What to bring
- The appliance, even if it no longer switches on.
- Its plug, cable and any loose screws.

## Last winter at the clinic
- 146 appliances assessed
- 73% repaired on the day

## Before you visit
Q: Can I bring a lamp?
A: Yes. Bring the shade separately so it travels safely.
Q: What does it cost?
A: Assessment is free. We agree the price of parts with you first.`;
const CLINIC_BLOCKS = [
  { id: 'opening', texts: ['Give your kettle another winter', 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.'], link: ['Reserve a bench', 'https://bench.example/book'] as [string, string] },
  { id: 'what-to-bring', texts: ['What to bring', 'The appliance, even if it no longer switches on.', 'Its plug, cable and any loose screws.'] },
  { id: 'figures', texts: ['Last winter at the clinic', '146', 'appliances assessed', '73%', 'repaired on the day'] },
  { id: 'questions', texts: ['Before you visit', 'Can I bring a lamp?', 'Yes. Bring the shade separately so it travels safely.', 'What does it cost?', 'Assessment is free. We agree the price of parts with you first.'] }
];

const CYCLES_DRAFT = `Here is our real About copy for this page, in place of the sample text:

# The people behind North Quay Cycles
We are a worker-owned workshop under the railway arches in Hull.

## Two ways we can help
- Bench repair: Bring us a fault you can show us. We quote before we order parts.
- Cargo-bike check: We check the stand, steering linkage and brakes under load.

## From a rider
"They found the rattle I'd been chasing for 18 months."
Jo Bell, school-run rider

## Visit the workshop
The blue door is beside arch 17. Ring once and bring your bike inside.
Button: Find our opening hours (link to our Contact page, /contact/)`;
const cyclesBlocks = (s: ProjectState) => [
  { id: 'opening', texts: ['The people behind North Quay Cycles', 'We are a worker-owned workshop under the railway arches in Hull.'] },
  { id: 'services', texts: ['Two ways we can help', 'Bench repair', 'Bring us a fault you can show us. We quote before we order parts.', 'Cargo-bike check', 'We check the stand, steering linkage and brakes under load.'] },
  { id: 'testimonial', texts: ['From a rider', "They found the rattle I'd been chasing for 18 months.", 'Jo Bell', 'school-run rider'] },
  { id: 'closing', texts: ['Visit the workshop', 'The blue door is beside arch 17. Ring once and bring your bike inside.'], link: ['Find our opening hours', `page:${pageAt(s, '/contact/')?.id}`] as [string, string] }
];

const page = (slug: string, title: string, sections: unknown[], nav = true) => ({ slug, title, addToHeaderNav: nav, sections });
const intro = (heading: string) => ({ componentId: 'intro.page', props: { heading, lead: `${heading}, explained simply.` } });
const closing = { componentId: 'cta.banner', props: { heading: 'Ready when you are', primaryLabel: 'Get in touch', primaryLink: '/contact/' } };

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'copy-edit-hero-heading',
    version: 1,
    category: 'copy',
    prompt: 'Change this headline to "Calm rooms, clear plans".',
    selection: selectRoot(0, 'Split hero'),
    grade: ({ before, after }) => [
      check('heading-changed', instance(home(after), 0)?.props.heading === 'Calm rooms, clear plans', String(instance(home(after), 0)?.props.heading)),
      check('other-sections-untouched', otherSectionsUntouched(before, after, 0)),
      check('shell-and-tokens-untouched', shellUntouched(before, after))
    ],
    script: () => [() => [call('update_selected_props', { props: { heading: 'Calm rooms, clear plans' } })], finish('Updated the headline.')]
  },
  {
    id: 'brand-retheme',
    version: 1,
    category: 'brand',
    prompt: 'Rebrand this site as Harbour Plumbing. Use navy #12355b as the brand color, Lora for headings and DM Sans for body text. The email is help@harbourplumbing.example and the phone is +1 555 0199.',
    grade: ({ after }) => {
      const footer = shell(after, 'footer').props;
      const contact = (footer.contact as Array<{ link: LinkValue }>) ?? [];
      return [
        check('site-name', after.site.name === 'Harbour Plumbing', after.site.name),
        check('header-name', shell(after, 'header').props.siteName === 'Harbour Plumbing'),
        check('footer-name', footer.siteName === 'Harbour Plumbing'),
        check('copyright-follows', !String(footer.copyright).includes('Harbour Lane Studio'), String(footer.copyright)),
        check('brand-token', String(after.tokens.overrides['color.brand']).toLowerCase() === '#12355b'),
        check('display-font', String(after.tokens.overrides['font.display']).includes('Lora')),
        check('body-font', String(after.tokens.overrides['font.body']).includes('DM Sans')),
        check('email', contact.some((c) => c.link?.type === 'email' && c.link.target === 'help@harbourplumbing.example')),
        check('phone', contact.some((c) => c.link?.type === 'tel' && c.link.target.replace(/[^0-9]/g, '') === '15550199'))
      ];
    },
    script: () => [
      () => [call('update_site_brand', { siteName: 'Harbour Plumbing', brandColor: '#12355b', headingFont: 'Lora', bodyFont: 'DM Sans', contactEmail: 'help@harbourplumbing.example', contactPhone: '+1 555 0199' })],
      finish('Rebranded the site as Harbour Plumbing.')
    ]
  },
  {
    id: 'add-services-page-nav',
    version: 1,
    category: 'page',
    prompt: 'Add a Services page describing three services, and link to it from the header.',
    grade: ({ after }) => {
      const p = pageAt(after, '/services/');
      const grid = findSection(after, p, 'features.grid');
      return [
        check('page-exists', !!p),
        check('has-sections', (p?.rootIds.length ?? 0) >= 2, `${p?.rootIds.length ?? 0} sections`),
        check('three-services', ((grid?.props.items as unknown[]) ?? []).length >= 3),
        check('header-link', linksTo(after, 'header', p))
      ];
    },
    script: () => [
      () => [
        call(
          'upsert_page_with_sections',
          page('services', 'Services', [
            intro('Our services'),
            { componentId: 'features.grid', props: { heading: 'What we do', items: [{ icon: 'compass', title: 'Planning', description: 'Layouts that work.' }, { icon: 'palette', title: 'Materials', description: 'Finishes that last.' }, { icon: 'hammer', title: 'Delivery', description: 'Managed from start to finish.' }] } },
            closing
          ])
        )
      ],
      finish('Added a Services page and linked it from the header.')
    ]
  },
  {
    id: 'build-five-page-site',
    version: 1,
    category: 'site',
    prompt: 'Build a complete five page website for a garden design business: Home, Services, Pricing, About and Contact. Every page needs real content, and all of them should be in the header.',
    grade: ({ after }) => {
      const routes = ['/', '/services/', '/pricing/', '/about/', '/contact/'];
      const pricing = findSection(after, pageAt(after, '/pricing/'), 'pricing.plans');
      return [
        ...routes.map((r) => check(`page-${r === '/' ? 'home' : r.slice(1, -1)}`, (pageAt(after, r)?.rootIds.length ?? 0) >= 2, `${r} has ${pageAt(after, r)?.rootIds.length ?? 0} sections`)),
        ...routes.slice(1).map((r) => check(`nav-${r.slice(1, -1)}`, linksTo(after, 'header', pageAt(after, r)))),
        check('pricing-plans', ((pricing?.props.plans as unknown[]) ?? []).length >= 2),
        check('services-content', sectionIds(after, pageAt(after, '/services/')).some((c) => c === 'features.grid' || c === 'content.media'))
      ];
    },
    script: () => [
      () => [
        calls(
          ['upsert_page_with_sections', page('home', 'Home', [{ componentId: 'hero.split', props: { heading: 'Gardens that grow with you', primaryLabel: 'See pricing', primaryLink: '/pricing/' } }, closing])],
          ['upsert_page_with_sections', page('services', 'Services', [intro('Services'), { componentId: 'features.grid', props: { heading: 'What we do', items: [{ icon: 'leaf', title: 'Garden care', description: 'Weekly visits.' }] } }, closing])],
          ['upsert_page_with_sections', page('pricing', 'Pricing', [intro('Pricing'), { componentId: 'pricing.plans', props: { plans: [{ name: 'Tidy', price: '$90', features: 'One visit', actionLabel: 'Book', actionLink: '/contact/' }, { name: 'Care', price: '$290', features: 'Monthly visits', actionLabel: 'Book', actionLink: '/contact/' }] } }, closing])],
          ['upsert_page_with_sections', page('about', 'About', [intro('About us'), { componentId: 'team.grid', props: { heading: 'The team', people: [{ name: 'Ada', role: 'Founder', bio: 'Twenty years in gardens.' }] } }])],
          ['upsert_page_with_sections', page('contact', 'Contact', [intro('Contact'), { componentId: 'contact.details', props: { heading: 'Talk to us' } }])]
        )
      ],
      finish('Built the five page site.')
    ]
  },
  {
    id: 'fix-broken-code-component',
    version: 1,
    category: 'code',
    prompt: 'The Quote Card component on the home page is broken and the site will not build. Please fix it without changing what it says.',
    setup: (state) => {
      const made = applyOperations(state, [{ type: 'component.createCode', name: 'Quote Card', source: WORKING_SOURCE, properties: { quote: { type: 'string', label: 'Quote', default: 'Quality first' } } }]);
      const definitionId = String(made.results[0].definitionId);
      const placed = applyOperations(made.state, [{ type: 'node.insert', owner: { kind: 'page', id: made.state.site.homePageId }, definitionId }]);
      placed.state.components[definitionId].source = BROKEN_SOURCE;
      Object.assign(state, placed.state);
    },
    grade: ({ after }) => {
      const def = Object.values(after.components).find((d: ComponentDefinition) => d.name === 'Quote Card');
      return [
        check('component-kept', !!def),
        check('source-changed', !!def?.source && def.source !== BROKEN_SOURCE),
        check('keeps-markup', !!def?.source?.includes('<blockquote')),
        check('still-on-page', Object.values(home(after).nodes).some((n) => n.kind === 'instance' && n.definitionId === def?.id))
      ];
    },
    script: (state) => {
      const id = () => Object.values(state().components).find((d) => d.name === 'Quote Card')!.id;
      return [
        () => [call('read_source', { definitionId: id() })],
        (req) => {
          const read = JSON.parse((req.items.at(-1) as { content: string }).content) as { hash: string };
          return [call('apply_source_patch', { definitionId: id(), expectedHash: read.hash, edits: [{ find: '{quote<', replace: '{quote}<' }] })];
        },
        finish('Closed the unterminated expression in Quote Card.')
      ];
    }
  },
  {
    id: 'mobile-spacing-override',
    version: 1,
    category: 'style',
    prompt: 'This section has too much space above and below it on phones. Reduce it on phones only.',
    selection: selectRoot(2, 'Features'),
    grade: ({ before, after }) => {
      const n = instance(home(after), 2);
      const was = instance(home(before), 2);
      const phone = n?.overrides?.root?.phone;
      return [
        check('phone-padding-set', !!phone && ('paddingBlock' in phone || 'paddingBlockStart' in phone)),
        check('desktop-unchanged', same(n?.overrides?.root?.base, was?.overrides?.root?.base) && same(n?.overrides?.root?.desktop, was?.overrides?.root?.desktop)),
        check('content-unchanged', same(n?.props, was?.props)),
        check('other-sections-untouched', otherSectionsUntouched(before, after, 2))
      ];
    },
    script: () => [() => [call('style_selected_element', { partId: 'root', scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.xl' } }] })], finish('Reduced the spacing on phones.')]
  },
  {
    id: 'edit-list-items',
    version: 1,
    category: 'copy',
    prompt: 'Rename the first card to "Space planning" and add a fourth card about aftercare.',
    selection: selectRoot(2, 'Features'),
    grade: ({ before, after }) => {
      const items = (instance(home(after), 2)?.props.items as Array<ListItem & { title: string }>) ?? [];
      const was = (instance(home(before), 2)?.props.items as Array<ListItem & { title: string }>) ?? [];
      return [
        check('renamed', items[0]?.title === 'Space planning', items[0]?.title),
        check('item-identity-kept', items[0]?.id === was[0]?.id),
        check('four-cards', items.length === 4, `${items.length} cards`),
        check('aftercare', items.some((i) => /aftercare/i.test(`${i.title} ${String(i.description)}`))),
        check('others-kept', same(items[1], was[1]) && same(items[2], was[2])),
        check('other-sections-untouched', otherSectionsUntouched(before, after, 2))
      ];
    },
    script: (state) => [
      () => {
        const first = (instance(home(state()), 2)!.props.items as ListItem[])[0].id;
        return [call('edit_selected_list', { prop: 'items', action: 'update', itemId: first, fields: { title: 'Space planning' } })];
      },
      () => [call('edit_selected_list', { prop: 'items', action: 'insert', fields: { icon: 'leaf', title: 'Aftercare', description: 'We check in after handover.' } })],
      finish('Renamed the first card and added an aftercare card.')
    ]
  },
  {
    id: 'pricing-page-forward-links',
    version: 1,
    category: 'page',
    prompt: 'Add a Pricing page with three plans. Each plan button should go to a new Booking page, which you should also create with a booking form.',
    grade: ({ after }) => {
      const pricing = pageAt(after, '/pricing/');
      const booking = pageAt(after, '/booking/');
      const plans = (findSection(after, pricing, 'pricing.plans')?.props.plans as Array<{ actionLink: LinkValue }>) ?? [];
      return [
        check('pricing-page', !!pricing),
        check('booking-page', !!booking),
        check('three-plans', plans.length === 3, `${plans.length} plans`),
        check('plans-link-to-booking', plans.length > 0 && plans.every((x) => x.actionLink?.type === 'page' && x.actionLink.target === booking?.id)),
        check('booking-form', !!findSection(after, booking, 'contact.form'))
      ];
    },
    script: () => {
      const plan = (name: string, price: string) => ({ name, price, features: 'Included support', actionLabel: 'Book', actionLink: '/booking/' });
      return [
        () => [call('upsert_page_with_sections', page('pricing', 'Pricing', [intro('Pricing'), { componentId: 'pricing.plans', props: { plans: [plan('Small', '$100'), plan('Medium', '$200'), plan('Large', '$300')] } }], false))],
        () => [call('upsert_page_with_sections', page('booking', 'Booking', [intro('Book a visit'), { componentId: 'contact.form', props: { heading: 'Book a visit' } }], false))],
        finish('Added Pricing and Booking pages, with each plan linking to Booking.')
      ];
    }
  },
  {
    id: 'stay-in-selection',
    version: 1,
    category: 'scope',
    prompt: 'Make this headline shorter, and also change the footer tagline to "Quiet design".',
    answers: ['No, only change the selection'],
    selection: selectRoot(0, 'Split hero'),
    grade: ({ before, after }) => [
      check('heading-shorter', String(instance(home(after), 0)?.props.heading).length < String(instance(home(before), 0)?.props.heading).length),
      check('footer-untouched', same(before.site.shell.footer, after.site.shell.footer)),
      check('other-sections-untouched', otherSectionsUntouched(before, after, 0))
    ],
    script: () => [
      () => [call('request_wider_scope', { question: 'The footer is outside this selection. May I change it too?' })],
      () => [call('update_selected_props', { props: { heading: 'Calm, considered spaces' } })],
      finish('Shortened the headline and left the footer alone, as you asked.')
    ]
  },
  {
    id: 'paste-copy-onto-intro-page',
    version: 1,
    category: 'page',
    prompt: CLINIC_DRAFT,
    // A page just made with only its introduction (the page's title), as Add page's Page introduction starter makes it.
    setup: (state) => Object.assign(state, applyOperations(state, [{ type: 'page.create', title: 'Repair café', route: '/repair-cafe/', starter: 'intro' }]).state),
    pageScope: '/repair-cafe/',
    grade: ({ before, after }) => [...pastedChecks(before, after, '/repair-cafe/', CLINIC_DRAFT, CLINIC_BLOCKS), ...restUntouched(before, after, '/repair-cafe/')],
    script: () => [
      () => [
        call('upsert_page_with_sections', {
          slug: 'repair-cafe',
          removeOtherSections: true,
          sections: [
            { componentId: 'hero.centered', props: { eyebrow: '', heading: 'Give your kettle another winter', lead: 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.', primaryLabel: 'Reserve a bench', primaryLink: 'https://bench.example/book', secondaryLabel: '' } },
            { componentId: 'content.text', props: { heading: 'What to bring', body: '- The appliance, even if it no longer switches on.\n- Its plug, cable and any loose screws.' } },
            { componentId: 'stats.row', props: { heading: 'Last winter at the clinic', items: [{ value: '146', label: 'appliances assessed' }, { value: '73%', label: 'repaired on the day' }] } },
            { componentId: 'faq.list', props: { eyebrow: '', heading: 'Before you visit', lead: '', items: [{ question: 'Can I bring a lamp?', answer: 'Yes. Bring the shade separately so it travels safely.' }, { question: 'What does it cost?', answer: 'Assessment is free. We agree the price of parts with you first.' }] } }
          ]
        })
      ],
      finish('Laid out the Repair café page from your copy.')
    ]
  },
  {
    id: 'paste-copy-onto-starter-page',
    version: 1,
    category: 'page',
    prompt: CYCLES_DRAFT,
    // The starter's About page, still holding the theme's sample story, team and call to action.
    pageScope: '/about/',
    grade: ({ before, after }) => [...pastedChecks(before, after, '/about/', CYCLES_DRAFT, cyclesBlocks(after)), ...restUntouched(before, after, '/about/')],
    script: () => [
      () => [
        call('upsert_page_with_sections', {
          slug: 'about',
          removeOtherSections: true,
          sections: [
            { componentId: 'intro.page', props: { eyebrow: '', heading: 'The people behind North Quay Cycles', lead: 'We are a worker-owned workshop under the railway arches in Hull.' } },
            {
              componentId: 'features.grid',
              props: {
                eyebrow: '',
                heading: 'Two ways we can help',
                lead: '',
                items: [
                  { icon: 'hammer', title: 'Bench repair', description: 'Bring us a fault you can show us. We quote before we order parts.' },
                  { icon: 'compass', title: 'Cargo-bike check', description: 'We check the stand, steering linkage and brakes under load.' }
                ]
              }
            },
            { componentId: 'testimonials.grid', props: { eyebrow: '', heading: 'From a rider', lead: '', items: [{ quote: "They found the rattle I'd been chasing for 18 months.", name: 'Jo Bell', role: 'school-run rider' }] } },
            { componentId: 'cta.banner', props: { heading: 'Visit the workshop', lead: 'The blue door is beside arch 17. Ring once and bring your bike inside.', primaryLabel: 'Find our opening hours', primaryLink: '/contact/', secondaryLabel: '' } }
          ]
        })
      ],
      finish('Replaced the sample About copy with yours.')
    ]
  },
  {
    id: 'faq-page-repair',
    version: 1,
    category: 'page',
    prompt: 'Add an FAQ page with at least three questions about our design process, ending with a call to action.',
    grade: ({ after }) => {
      const p = pageAt(after, '/faq/');
      const ids = sectionIds(after, p);
      return [
        check('page-exists', !!p),
        check('three-questions', ((findSection(after, p, 'faq.list')?.props.items as unknown[]) ?? []).length >= 3),
        check('ends-with-cta', ids.at(-1) === 'cta.banner', ids.join(', '))
      ];
    },
    // The first attempt has a bad field on purpose, so a run exercises the one-section repair path.
    script: () => {
      const faq = { componentId: 'faq.list', props: { heading: 'Questions', items: [{ question: 'How long?', answer: 'Six weeks.' }, { question: 'How much?', answer: 'A fixed fee.' }, { question: 'Where?', answer: 'Across the region.' }] } };
      return [
        () => [call('upsert_page_with_sections', page('faq', 'FAQ', [intro('Questions'), { ...faq, props: { ...faq.props, title: 'Wrong field' } }, closing], false))],
        () => [call('upsert_page_with_sections', { slug: 'faq', repair: true, sections: [{ ...faq, index: 1 }] })],
        finish('Added an FAQ page.')
      ];
    }
  }
];
