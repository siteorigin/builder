/**
 * The graded prompts. IDs are stable: reports from different models and dates are compared by them. Grading looks
 * only at the resulting project, so any model may get there its own way; the scripts exist for the free fake run.
 */
import type { ComponentDefinition, EntryDoc, InstanceNode, LinkValue, ListItem, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { CanonicalModelRequest, ModelEvent } from '@agent/types';
import { applyOperations } from '@engine/apply';
import { richTextToPlain, type RichText } from '@shared/richtext';
import { renderedContent, type RenderedContent } from '@generator/checks';
import { childLists } from '@engine/tree';
import type { Check, EvalCase, ScriptTurn } from './harness';

/** Bump when cases are added, removed or re-graded. */
export const SUITE_VERSION = 3;

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
 * Grading a page built from pasted copy, by what a visitor sees on it, section by section: its words, a piece per
 * field, list item and paragraph, and its links with the label each shows. Compared without case, runs of spaces,
 * curly quotes or dash styles, and nothing else: a changed word, figure or punctuation mark is a change.
 */
const plain = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
interface Piece {
  text: string;
  /** The list item it belongs to (a card, a question, a figure), so what belongs together can be told apart. */
  item?: string;
}
interface Shown {
  pieces: Piece[];
  /** Where each link goes, and the words that can be its label: its label field's, or in a card any of the card's. */
  links: Array<{ target: string; labels: string[] }>;
}
const linkTarget = (l: Partial<LinkValue> | undefined) => (l?.target ? (l.type === 'page' ? `page:${l.target}` : l.target) : '');
/** A link field's label field, by the catalogue's naming: primaryLink → primaryLabel, link → linkLabel. */
const labelOf = (field: string) => (field === 'link' ? 'linkLabel' : field.replace(/Link$/, 'Label'));
const shownOn = (s: ProjectState, p: PageDoc | undefined): Shown[] => {
  if (!p) return [];
  // Content inside hand-built layout is reported by its own node: it belongs to the section it sits in.
  const rootOf = new Map<string, string>();
  const claim = (id: string, root: string) => {
    if (rootOf.has(id) || !p.nodes[id]) return;
    rootOf.set(id, root);
    for (const list of childLists(p.nodes[id])) for (const child of list.ids) claim(child, root);
  };
  for (const root of p.rootIds) claim(root, root);
  const content = renderedContent(s, p);
  /** Where a piece of content is stored, so a link can find the label shown with it. */
  const keyOf = (c: RenderedContent, field?: string) => {
    const src = c.source;
    return src?.kind === 'prop' ? `${c.nodeId}|${src.itemId ?? ''}|${field ?? src.field ?? src.prop}` : `${c.nodeId}|node|${field ?? src?.field ?? c.at ?? ''}`;
  };
  const labels = new Map<string, string>();
  for (const c of content) if (c.kind === 'text' && typeof c.value === 'string') labels.set(keyOf(c), plain(c.value));
  return p.rootIds.map((root) => {
    const shown: Shown = { pieces: [], links: [] };
    for (const c of content) {
      if (rootOf.get(c.nodeId) !== root) continue;
      const item = c.source?.kind === 'prop' && c.source.itemId ? `${c.nodeId}|${c.source.itemId}` : undefined;
      if (c.kind === 'link') {
        const target = linkTarget(c.value as Partial<LinkValue> | undefined);
        const field = c.source?.kind === 'prop' ? labelOf(c.source.field ?? c.source.prop) : 'label';
        const label = labels.get(keyOf(c, field));
        // A card's link may show another of its fields as its words (a contact row's value, say).
        const card = item ? content.filter((o) => o.kind === 'text' && typeof o.value === 'string' && o.source?.kind === 'prop' && `${o.nodeId}|${o.source.itemId}` === item).map((o) => plain(o.value as string)) : [];
        if (target) shown.links.push({ target, labels: label ? [label] : card });
        continue;
      }
      if (Array.isArray(c.value)) {
        const blocks = c.value as RichText;
        // A link inside text goes where its words say, and counts like any other: its words are the label, whatever
        // their emphasis.
        for (const b of blocks)
          for (const spans of 'spans' in b ? [b.spans] : 'items' in b ? b.items : []) {
            // Spans of one link are one label, also across the space between them that the link's own words leave out.
            const runs: Array<{ target: string; text: string; gap: string | null }> = [];
            for (const span of spans) {
              const target = span.link ? linkTarget(span.link) : '';
              const last = runs.at(-1);
              if (target && last?.target === target && last.gap !== null) {
                last.text += last.gap + span.text;
                last.gap = '';
              } else if (target) runs.push({ target, text: span.text, gap: '' });
              else if (last && last.gap !== null) last.gap = /^\s*$/.test(span.text) ? last.gap + span.text : null;
            }
            for (const r of runs) shown.links.push({ target: r.target, labels: [plain(r.text)] });
          }
        shown.pieces.push(...richTextToPlain(blocks).split(/\n+/).map((w) => ({ text: plain(w), item })).filter((x) => x.text));
      } else if (typeof c.value === 'string' && plain(c.value)) shown.pieces.push({ text: plain(c.value), item });
    }
    // A quote may keep the quotation marks the draft had around it.
    for (const x of shown.pieces) x.text = x.text.replace(/^"(.*)"$/, '$1');
    return shown;
  });
};
/** `inner` inside `outer`, whole words at both ends: "146" is in "146 appliances", "46" is not. */
const wordsIn = (outer: string, inner: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(outer);
/** What belongs together is shown together: in one list item, in consecutive pieces in order, or in one piece. */
const together = (x: Shown, members: string[]) => {
  const want = members.map(plain);
  const pieces = x.pieces;
  const items = new Set(pieces.map((p) => p.item).filter(Boolean));
  if ([...items].some((item) => want.every((m) => pieces.some((p) => p.item === item && p.text === m)))) return true;
  // Consecutive pieces count only within one list item, or outside any: two cards side by side are not one.
  if (pieces.some((first, i) => want.every((m, j) => pieces[i + j]?.text === m && pieces[i + j].item === first.item))) return true;
  return pieces.some((p) => want.every((m) => wordsIn(p.text, m)) && want.every((m, j) => j === 0 || p.text.indexOf(m) > p.text.indexOf(want[j - 1])));
};
interface Block {
  id: string;
  /** Each shown whole, as one piece. */
  texts: string[];
  /** Each shown together: a question and its answer, a figure and its label, a name and a role. */
  pairs?: string[][];
  /** A button or link: its label and where it goes. */
  link?: [string, string];
}
const blockMet = (x: Shown, b: Block) =>
  b.texts.every((t) => x.pieces.some((p) => p.text === plain(t))) && (b.pairs ?? []).every((m) => together(x, m)) && (!b.link || x.links.some((l) => l.labels.includes(plain(b.link![0])) && l.target === b.link![1]));
/** What a block is missing on the page, for the report. */
const missing = (shown: Shown[], b: Block) =>
  b.texts.find((t) => !shown.some((x) => x.pieces.some((p) => p.text === plain(t)))) ??
  b.pairs?.find((m) => !shown.some((x) => together(x, m)))?.join(' + ') ??
  (b.link && !shown.some((x) => x.links.some((l) => l.labels.includes(plain(b.link![0])) && l.target === b.link![1])) ? `${b.link[0]} → ${b.link[1]}` : 'a block split across sections');
/**
 * Each block of the draft is shown whole, in a section of its own, in the draft's order; nothing else is shown (no
 * sample text left behind, no filler, nothing twice, no other link); and no placeholder section is left.
 */
const pastedChecks = (before: ProjectState, s: ProjectState, route: string, body: string, blocks: Block[]): Check[] => {
  const was = pageAt(before, route);
  const p = pageAt(s, route);
  const shown = shownOn(s, p);
  const at = blocks.map((b) => shown.findIndex((x) => blockMet(x, b)));
  // The draft's own lines, without their Markdown or "Q:" markers. The request around the draft is not copy.
  const lines = body.split('\n').map((l) => plain(l.replace(/^\s*(#+|[-*]|Q:|A:|Button:)\s*/i, ''))).filter(Boolean);
  // Two lines of the draft may be shown as one piece: a question with its answer, a name with its role.
  const joined = lines.slice(1).map((l, i) => `${lines[i]} ${l}`);
  const all = shown.flatMap((x) => x.pieces.map((q) => q.text));
  // Each piece is shown at most as often as the draft has it, so a figure repeated as an eyebrow is extra.
  const inDraft = (t: string) => lines.filter((l) => wordsIn(l, t)).length || joined.filter((l) => wordsIn(l, t)).length;
  // Two lines shown as one piece use those lines up: shown again on their own, they are shown twice.
  const reused = (t: string) => !lines.some((l) => wordsIn(l, t)) && joined.some((j, i) => wordsIn(j, t) && (all.includes(lines[i]) || all.includes(lines[i + 1])));
  const extra = [...new Set(all.filter((t) => all.filter((x) => x === t).length > inDraft(t) || reused(t)))];
  // Each link is one of the draft's, with its label: no other destination, and no second way to the same one.
  const wanted = blocks.flatMap((b) => (b.link ? [{ label: plain(b.link[0]), target: b.link[1] }] : []));
  const links = shown.flatMap((x) => x.links);
  const meant = (l: Shown['links'][number]) => wanted.findIndex((w) => w.target === l.target && l.labels.includes(w.label));
  const strayLinks = links.filter((l, i) => meant(l) < 0 || links.findIndex((o) => meant(o) === meant(l)) !== i).map((l) => `${l.labels[0] ?? '(no label)'} → ${l.target}`);
  // A section still exactly as it was, or one showing nothing at all, is a placeholder left behind.
  const left = (p?.rootIds ?? []).filter((id, i) => (was?.rootIds.includes(id) && same(was.nodes[id], p!.nodes[id])) || (!shown[i].pieces.length && !shown[i].links.length));
  return [
    ...blocks.map((b, i) => check(b.id, at[i] >= 0, missing(shown, b))),
    // Each block its own section, so a draft poured whole into one text section is not a layout.
    check('reading-order', at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), at.join(', ')),
    check('placeholders-removed', !!p && left.length === 0, left.map((id) => componentId(s, p!.nodes[id]) ?? id).join(', ')),
    check('only-supplied-copy', extra.length === 0, extra.slice(0, 3).join(' | ')),
    check('only-supplied-links', strayLinks.length === 0, strayLinks.join(', '))
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

const CLINIC_ASK = 'Here is the copy for this page. Please lay it out.';
const CLINIC_DRAFT = `# Give your kettle another winter
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
const CLINIC_BLOCKS: Block[] = [
  { id: 'opening', texts: ['Give your kettle another winter', 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.'], link: ['Reserve a bench', 'https://bench.example/book'] },
  { id: 'what-to-bring', texts: ['What to bring', 'The appliance, even if it no longer switches on.', 'Its plug, cable and any loose screws.'] },
  {
    id: 'figures',
    texts: ['Last winter at the clinic'],
    pairs: [
      ['146', 'appliances assessed'],
      ['73%', 'repaired on the day']
    ]
  },
  {
    id: 'questions',
    texts: ['Before you visit'],
    pairs: [
      ['Can I bring a lamp?', 'Yes. Bring the shade separately so it travels safely.'],
      ['What does it cost?', 'Assessment is free. We agree the price of parts with you first.']
    ]
  }
];

const CYCLES_ASK = 'Here is our real About copy for this page, in place of the sample text:';
const CYCLES_DRAFT = `# The people behind North Quay Cycles
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
const cyclesBlocks = (s: ProjectState): Block[] => [
  { id: 'opening', texts: ['The people behind North Quay Cycles', 'We are a worker-owned workshop under the railway arches in Hull.'] },
  {
    id: 'services',
    texts: ['Two ways we can help'],
    pairs: [
      ['Bench repair', 'Bring us a fault you can show us. We quote before we order parts.'],
      ['Cargo-bike check', 'We check the stand, steering linkage and brakes under load.']
    ]
  },
  { id: 'testimonial', texts: ['From a rider', "They found the rattle I'd been chasing for 18 months."], pairs: [['Jo Bell', 'school-run rider']] },
  { id: 'closing', texts: ['Visit the workshop', 'The blue door is beside arch 17. Ring once and bring your bike inside.'], link: ['Find our opening hours', `page:${pageAt(s, '/contact/')?.id}`] }
];

const page = (slug: string, title: string, sections: unknown[], nav = true) => ({ slug, title, addToHeaderNav: nav, sections });

/** The post with typos: proofreading changes those two words and nothing else. */
const OPEN_BODY = ['## Who is coming', 'Twnety makers will show there work on **Saturday**.', '- Clay', '- Glass', 'Book a place on the [contact page](/contact/).'];
const OPEN_FIXED = OPEN_BODY.map((l) => l.replace('Twnety', 'Twenty').replace('there work', 'their work'));

/**
 * A blog for the post cases (#400): News and Craft categories, three published posts, and a post with typos that
 * proofreading should fix and nothing else.
 */
const withBlog = (state: ProjectState) =>
  Object.assign(
    state,
    applyOperations(state, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News', termId: 'news' },
      { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Craft', termId: 'craft' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_hours', title: 'New winter hours', publishedAt: '2026-11-02', draft: false, excerpt: 'Shorter days, earlier closing.', terms: { categories: ['news'] }, body: ['From November the studio closes at 4pm.'] },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_glaze', title: 'Mixing a celadon glaze', publishedAt: '2026-10-12', draft: false, terms: { categories: ['craft'] }, body: ['A pale green glaze, step by step.'] },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Spring open studio', publishedAt: '2026-09-20', draft: false, author: 'Ana Ruiz', excerpt: 'Twenty makers open their doors.', terms: { categories: ['news'] }, body: OPEN_BODY },
      // A fourth published post, so a feed with no limit of its own shows more than the three newest.
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_summer', title: 'Summer raku evenings', publishedAt: '2026-07-05', draft: false, body: ['Raku firing on Thursday evenings.'] }
    ] as EditOperation[]).state
  );
const posts = (s: ProjectState) => s.collections.posts?.entries ?? {};
const postText = (e: EntryDoc | undefined) => (e ? richTextToPlain(e.body) : '');
const blocks = (e: EntryDoc | undefined) => (e ? e.body.map((b) => b.type) : []);
const feedOn = (s: ProjectState, p: PageDoc | undefined) => (p ? p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => n?.kind === 'instance' && /^blog\./.test(componentId(s, n) ?? '')) : undefined);
/** A post long enough to be read in many parts, so the budget collapses reads of it. */
const LONG_POST = [
  ...Array.from({ length: 130 }, (_, i) => (i % 13 === 0 ? `## Chapter ${i / 13 + 1}` : `Part ${i + 1} of the history of the riverside studio.${' The kiln, the wheel and the river shaped every season of work here, from the first pots to the newest glazes.'.repeat(4)}`)),
  // What only a reader who reached the end knows.
  'Today the studio is a cooperative of twelve potters.'
];
const lastResult = (req: CanonicalModelRequest) => {
  const it = req.items.at(-1);
  try {
    return it?.kind === 'tool_result' ? (JSON.parse(it.content) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
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
    prompt: `${CLINIC_ASK}\n\n${CLINIC_DRAFT}`,
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
    prompt: `${CYCLES_ASK}\n\n${CYCLES_DRAFT}`,
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
  },
  {
    id: 'draft-post-and-add-home-feed',
    version: 1,
    category: 'posts',
    prompt:
      'Draft a blog post from my notes and file it under News and a new Events category, dated 2027-05-10, with a one-line excerpt. Notes: Kiln opening night. Doors open 6pm. What to expect: studio tours, glaze demos, tea. Book on the contact page. Then add a "Latest news" section with the three newest posts to the home page.',
    setup: withBlog,
    grade: ({ before, after }) => {
      const added = Object.values(posts(after)).filter((e) => !Object.hasOwn(posts(before), e.id));
      const post = added[0];
      const events = Object.entries(after.collections.posts?.settings.taxonomies.categories?.terms ?? {}).find(([, t]) => t.label.toLowerCase() === 'events')?.[0];
      const cats = post?.terms.categories ?? [];
      const feed = feedOn(after, home(after));
      const contact = pageAt(after, '/contact/')?.id;
      const feedId = feed ? componentId(after, feed) : undefined;
      const text = postText(post);
      return [
        check('one-new-post', added.length === 1, String(added.length)),
        check('still-a-draft', post?.draft === true),
        check('dated', post?.publishedAt === '2027-05-10', post?.publishedAt),
        check('categories', cats.includes('news') && !!events && cats.includes(events), JSON.stringify(cats)),
        check('excerpt', !!post?.excerpt?.trim()),
        check('heading-and-list', blocks(post).some((b) => b === 'h2' || b === 'h3') && blocks(post).some((b) => b === 'ul' || b === 'ol'), blocks(post).join(', ')),
        check('links-to-contact', !!contact && JSON.stringify(post?.body ?? []).includes(`"type":"page","target":"${contact}"`)),
        check('notes-kept', /6\s?pm/i.test(text) && /tour/i.test(text) && /glaze demo/i.test(text) && /\btea\b/i.test(text), text.slice(0, 200)),
        check('home-feed', (feedId === 'blog.grid' || feedId === 'blog.list') && /latest news/i.test(String(feed?.props.heading ?? '')) && feed?.props.count === 3 && (feed.props.collection === undefined || feed.props.collection === '' || feed.props.collection === 'posts'), feed ? `${feedId} ${JSON.stringify(feed.props)}` : 'none'),
        check('home-sections-kept', home(before).rootIds.every((id) => home(after).rootIds.includes(id))),
        check('other-posts-untouched', Object.keys(posts(before)).every((id) => same(posts(before)[id], posts(after)[id]))),
        check('shell-and-tokens-untouched', shellUntouched(before, after))
      ];
    },
    script: () => [
      () => [
        call('upsert_collection_entry', {
          collectionId: 'posts',
          title: 'Kiln opening night',
          publishedAt: '2027-05-10',
          excerpt: 'Come and see the new kiln fired for the first time.',
          categories: ['News', 'Events'],
          body: ['Doors open at **6pm**.', '## What to expect', '- Studio tours', '- Glaze demos', '- Tea', 'Book a place on the [contact page](/contact/).']
        })
      ],
      () => [call('upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'blog.grid', props: { heading: 'Latest news', collection: 'posts', count: 3 } }] })],
      finish('Drafted “Kiln opening night” under News and Events, and added a Latest news section to the home page.')
    ]
  },
  {
    id: 'proofread-open-post',
    version: 1,
    category: 'posts',
    prompt: 'Proofread this post and fix the spelling and grammar mistakes. Change nothing else.',
    setup: withBlog,
    postScope: { collectionId: 'posts', entryId: 'en_open' },
    grade: ({ before, after }) => {
      const was = posts(before).en_open;
      const now = posts(after).en_open;
      // The text as it should be: the two words fixed, every mark, list item and link as it was.
      const fixed = applyOperations(before, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_open', body: OPEN_FIXED }]).state.collections.posts.entries.en_open.body;
      return [
        check('typos-fixed', /twenty makers/i.test(postText(now)) && /their work/i.test(postText(now)) && !/twnety|there work/i.test(postText(now)), postText(now).slice(0, 200)),
        check('nothing-else-changed', same(now?.body, fixed), JSON.stringify(now?.body).slice(0, 300)),
        check('details-kept', !!now && same({ ...now, body: null }, { ...was, body: null })),
        check('other-posts-untouched', Object.keys(posts(before)).every((id) => id === 'en_open' || same(posts(before)[id], posts(after)[id]))),
        check('pages-untouched', same(before.pages, after.pages) && same(before.collections.posts.settings, after.collections.posts.settings))
      ];
    },
    script: () => [
      () => [call('read_collection_entry', { collectionId: 'posts', entryId: 'en_open' })],
      () => [call('upsert_collection_entry', { collectionId: 'posts', entryId: 'en_open', body: OPEN_FIXED })],
      finish('Fixed “Twnety” and “there work”.')
    ]
  },
  {
    id: 'excerpt-for-long-post',
    version: 1,
    category: 'posts',
    prompt: 'Read this whole post and write a one-sentence excerpt for it. Leave its text as it is.',
    setup: (state) => {
      withBlog(state);
      Object.assign(state, applyOperations(state, [{ type: 'entry.create', collectionId: 'posts', entryId: 'en_history', title: 'A history of the studio', publishedAt: '2026-08-01', draft: false, body: LONG_POST }]).state);
    },
    postScope: { collectionId: 'posts', entryId: 'en_history' },
    grade: ({ before, after }) => {
      const was = posts(before).en_history;
      const now = posts(after).en_history;
      return [
        // One sentence about the studio, as a summary of the whole post would be.
        check('excerpt-written', !!now?.excerpt && now.excerpt.trim().length >= 30 && now.excerpt.length <= 320 && !/[.!?]\s+\S/.test(now.excerpt.trim()) && /studio/i.test(now.excerpt), now?.excerpt),
        check('text-kept', same(now?.body, was?.body)),
        check('other-posts-untouched', Object.keys(posts(before)).every((id) => id === 'en_history' || same(posts(before)[id], posts(after)[id])))
      ];
    },
    // Reads every part, then the first again: the budget collapses the first read, which the script checks it was
    // sent collapsed before it writes, so the free run proves a long post is read without filling the window.
    script: () => {
      let reread = false;
      // Where the next part should start: a gap or an early end means the post was not read whole, so nothing is written.
      let expected = 0;
      const step = (req: CanonicalModelRequest): ModelEvent[] => {
        const last = lastResult(req);
        if (!reread) {
          if (last?.offset !== expected || typeof last.text !== 'string') return finish('A part of the post was skipped.')(req);
          expected += last.text.length;
          if (typeof last.next === 'number') return [call('read_collection_entry', { collectionId: 'posts', entryId: 'en_history', offset: last.next })];
          if (expected !== last.length || !last.text.includes('cooperative of twelve potters')) return finish('The post was not read to its end.')(req);
          reread = true;
          return [call('read_collection_entry', { collectionId: 'posts', entryId: 'en_history' })];
        }
        if (last?.ok === true) return finish('Wrote the excerpt.')(req);
        // Without the collapsed read the script writes nothing, and the case fails.
        const collapsed = req.items.some((it) => it.kind === 'tool_result' && it.name === 'read_collection_entry' && it.content.startsWith('[Superseded read_collection_entry posts/en_history'));
        if (!collapsed) return finish('The first read was never collapsed.')(req);
        return [call('upsert_collection_entry', { collectionId: 'posts', entryId: 'en_history', excerpt: 'How a riverside studio grew from one wheel into a cooperative of twelve potters.' })];
      };
      return [() => [call('read_collection_entry', { collectionId: 'posts', entryId: 'en_history' })], ...Array.from({ length: 40 }, () => step)];
    }
  }
];
