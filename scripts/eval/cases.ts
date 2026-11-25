/**
 * The graded prompts. IDs are stable: reports from different models and dates are compared by them. Grading looks
 * only at the resulting project, so any model may get there its own way; the scripts exist for the free fake run.
 */
import type { ComponentDefinition, EntryDoc, InstanceNode, LinkValue, ListItem, PageDoc, ProjectState, PropSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { CanonicalModelRequest, ModelEvent } from '@agent/types';
import type { ManagedComponentArgs } from '@agent/managed-component';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { richTextToPlain, type RichText } from '@shared/richtext';
import { axesOf, designStyles, selectedVariants } from '@shared/variants';
import { renderedContent, type RenderedContent } from '@generator/checks';
import { childLists, findParent } from '@engine/tree';
import { measureComponent } from './component-diagnostics';
import type { Check, EvalCase, ScriptTurn } from './harness';

/** Bump when cases are added, removed or re-graded. */
export const SUITE_VERSION = 4;

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
/** A tool result's fields, or null for one that is not JSON. */
const lastResultOf = (content: string) => {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const lastResult = (req: CanonicalModelRequest) => {
  const it = req.items.at(-1);
  return it?.kind === 'tool_result' ? lastResultOf(it.content) : null;
};
// ---------------------------------------------------------------------------
// Components (#365): graded by what a placement of the design shows and how it is styled, never by the tools used
// ---------------------------------------------------------------------------

/** A project component by its name, as an author would call it. */
const defNamed = (s: ProjectState, name: string) => Object.values(s.components).find((d) => d.owner === 'project' && plain(d.name) === plain(name));
/** A project component the run made, by its name. */
const madeNamed = (before: ProjectState, after: ProjectState, name: string) => Object.values(after.components).find((d) => !Object.hasOwn(before.components, d.id) && d.owner === 'project' && plain(d.name) === plain(name));
const editedEverywhere = (name: string) => (s: ProjectState) => {
  const d = defNamed(s, name);
  return { id: d?.id ?? `missing ${name}`, name };
};
/** Seeds a managed component, placed on Home once per entry of `placements` (its property values). */
const seedComponent = (state: ProjectState, op: Record<string, unknown>, placements: Array<Record<string, unknown>> = [{}]) => {
  const made = applyOperations(state, [{ type: 'component.upsert', ...op } as EditOperation]);
  const definitionId = String(made.results[0].definitionId);
  const placed = applyOperations(made.state, placements.map((props) => ({ type: 'node.insert', owner: { kind: 'page', id: made.state.site.homePageId }, definitionId, props }) as EditOperation));
  Object.assign(state, placed.state);
};
/**
 * What one placement of a design renders with these property values and variant choices, as the generator does
 * (conditions, repeats), less what its styles hide at every screen size.
 */
const placementShows = (s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}, variants?: Record<string, string>): RenderedContent[] => {
  const node = makeInstance(def, props, variants);
  return renderedContent(s, { rootIds: [node.id], nodes: { [node.id]: node } }).filter((c) => !c.defNodeId || !def.tree?.nodes[c.defNodeId] || !hiddenEverywhere(def, c.defNodeId, variants));
};
/**
 * What one placement already on Home shows, less what its design's styles hide at every screen size; nothing when the
 * placement's own styles hide it at every size.
 */
const homePlacementShows = (s: ProjectState, nodeId: string) => {
  const placed = home(s).nodes[nodeId] as InstanceNode | undefined;
  const def = placed?.kind === 'instance' ? s.components[placed.definitionId] : undefined;
  const variants = placed?.variants as Record<string, string> | undefined;
  const own = (placed?.overrides?.root ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (SIZES.every((size) => (own[size]?.hidden ?? own.base?.hidden) === true)) return [];
  return renderedContent(s, { ...home(s), rootIds: [nodeId] }).filter((c) => !def || !c.defNodeId || !def.tree?.nodes[c.defNodeId] || !hiddenEverywhere(def, c.defNodeId, variants));
};
const textOf = (c: RenderedContent): string[] => (c.kind !== 'text' ? [] : typeof c.value === 'string' ? [plain(c.value)] : Array.isArray(c.value) ? richTextToPlain(c.value as RichText).split(/\n+/).map(plain) : []).filter(Boolean);
const textsShown = (list: RenderedContent[]) => list.flatMap(textOf);
/** A value for a text property that shows `text`. */
const textValue = (schema: PropSchema, text: string) => (schema.type === 'richtext' ? [{ type: 'p', spans: [{ text }] }] : text);
const TEXT_TYPES = new Set(['string', 'richtext']);
/**
 * The text property an author edits to change what the design shows as `wanted`: setting it shows the new words in
 * place of those. Undefined when nothing does (the words are fixed in the design, or not shown at all).
 */
const editedBy = (s: ProjectState, def: ComponentDefinition, wanted: string, base: Record<string, unknown> = {}): string | undefined => {
  if (!textsShown(placementShows(s, def, base)).includes(plain(wanted))) return undefined;
  // Each text property, and each text field of an object property, set on its own.
  const edits = Object.entries(def.properties).flatMap(([name, schema]): Array<[string, (marker: string) => unknown]> => {
    if (TEXT_TYPES.has(schema.type)) return [[name, (marker) => textValue(schema, marker)]];
    if (schema.type !== 'object') return [];
    return Object.entries(schema.fields)
      .filter(([, f]) => TEXT_TYPES.has(f.type))
      .map(([field, f]) => [`${name}.${field}`, (marker) => ({ ...((base[name] ?? schema.default) as object), [field]: textValue(f as PropSchema, marker) })]);
  });
  return edits.find(([path, value]) => {
    const marker = `Edited ${path} for the benchmark`;
    const shown = textsShown(placementShows(s, def, { ...base, [path.split('.')[0]]: value(marker) }));
    return shown.includes(plain(marker)) && !shown.includes(plain(wanted));
  })?.[0];
};
/** The design node that renders `wanted` with these property values. */
const nodeShowing = (s: ProjectState, def: ComponentDefinition, wanted: string, props: Record<string, unknown> = {}) => placementShows(s, def, props).find((c) => textOf(c).includes(plain(wanted)))?.defNodeId;
/**
 * The texts each card shows: each list item's, as one repeat of the design renders it. Two repeats of the same list
 * (the titles in one, the rooms in another) are two runs of text, not cards.
 */
const itemTexts = (def: ComponentDefinition, list: RenderedContent[]) => {
  const items = new Map<string, string[]>();
  for (const c of list) {
    if (c.source?.kind !== 'prop' || !c.source.itemId) continue;
    const repeat = c.defNodeId ? lineage(def, c.defNodeId).find((n) => def.tree?.nodes[n]?.kind === 'repeat') : undefined;
    const key = `${c.nodeId}|${repeat ?? ''}|${c.source.itemId}`;
    items.set(key, [...(items.get(key) ?? []), ...textOf(c)]);
  }
  return [...items.values()];
};
/**
 * The new definition is placed once, after Home's sections, which are all kept as they were; and the placement shows
 * what `shows` asks of it.
 */
const placedLastOnHome = (before: ProjectState, after: ProjectState, def: ComponentDefinition | undefined, shows: (content: RenderedContent[]) => boolean) => {
  const h = home(after);
  const lastId = h.rootIds.at(-1) ?? '';
  const last = h.nodes[lastId] as InstanceNode | undefined;
  const was = home(before);
  // Home's earlier sections, and the designs they show, as they were.
  const designs = Object.values(was.nodes).flatMap((n) => (n.kind === 'instance' ? [n.definitionId] : []));
  const kept = Object.keys(was.nodes).every((id) => same(was.nodes[id], h.nodes[id])) && designs.every((id) => same(before.components[id], after.components[id]));
  return !!def && last?.kind === 'instance' && last.definitionId === def.id && same(was.rootIds, h.rootIds.slice(0, -1)) && kept && shows(homePlacementShows(after, lastId));
};
const tokenOf = (v: unknown) => (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' && (v as { alpha?: unknown }).alpha === undefined ? (v as { token: string }).token : undefined);
const SIZES = ['phone', 'tablet', 'desktop'] as const;
type Size = (typeof SIZES)[number];
/** A style property's value on a design node at one size, as the generated CSS cascades it. */
const styleAt = (def: ComponentDefinition, nodeId: string, size: Size, prop: string, variants?: Record<string, string>) => designStyles(def, nodeId, variants)[size]?.[prop];
/** The node and the containers around it, innermost first. */
const lineage = (def: ComponentDefinition, nodeId: string) => {
  const out: string[] = [];
  for (let at: string | null | undefined = nodeId; at && def.tree && !out.includes(at); at = findParent(def.tree, at)?.parentId) out.push(at);
  return out;
};
/** The nearest value of a style property on a node or the containers around it: its text color, or what it sits on. */
const nearestStyle = (def: ComponentDefinition, nodeId: string, size: Size, prop: string, variants?: Record<string, string>) => {
  for (const at of lineage(def, nodeId)) {
    const v = styleAt(def, at, size, prop, variants);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};
/** Custom CSS that can take something off the page or out of sight. */
const CSS_HIDES = /(^|[;{\s])(display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|opacity\s*:\s*0(\.0*)?\s*(;|!|$)|(max-)?height\s*:\s*0(px)?\s*(;|!|$))/i;
/**
 * Whether styles hide a node, or a container around it, at every screen size: by Hidden, or by custom CSS that can.
 * Hidden at one size only is judged where it matters, by the measurer (see phoneRepairChecks).
 */
const hiddenEverywhere = (def: ComponentDefinition, nodeId: string, variants?: Record<string, string>) =>
  SIZES.every((size) => lineage(def, nodeId).some((n) => styleAt(def, n, size, 'hidden', variants) === true || CSS_HIDES.test(String(styleAt(def, n, size, 'customCss', variants) ?? ''))));
/**
 * Whether every side of a node is padded with `token` at one size. A side's longhand and its shorthand can both be
 * set from different rules, and which wins depends on the order the stylesheet writes them in: both must be the token.
 */
const paddedWith = (def: ComponentDefinition, nodeId: string, size: Size, token: string) =>
  [
    ['paddingBlockStart', 'paddingBlock'],
    ['paddingBlockEnd', 'paddingBlock'],
    ['paddingInlineStart', 'paddingInline'],
    ['paddingInlineEnd', 'paddingInline']
  ].every((props) => {
    const set = props.map((p) => styleAt(def, nodeId, size, p)).filter((v) => v !== undefined && v !== null);
    return set.length > 0 && set.every((v) => tokenOf(v) === token);
  });
/** Every style value a design sets, at every size and state and in every variant option. */
const everyStyle = (def: ComponentDefinition) => {
  const out: Array<{ nodeId: string; prop: string; value: unknown }> = [];
  const add = (nodeId: string, styles: Record<string, Record<string, unknown> | undefined> | undefined) => {
    for (const scoped of Object.values(styles ?? {})) for (const [prop, value] of Object.entries(scoped ?? {})) out.push({ nodeId, prop, value });
  };
  for (const n of Object.values(def.tree?.nodes ?? {})) add(n.id, n.styles as Record<string, Record<string, unknown>> | undefined);
  for (const [, axis] of axesOf(def)) for (const o of Object.values(axis.options)) for (const [nodeId, styles] of Object.entries(o.styles ?? {})) add(nodeId, styles as Record<string, Record<string, unknown>>);
  return out;
};
const COLOR_PROPS = new Set(['color', 'background']);
const SPACING_PROP = /^(padding|margin|gap|rowGap|columnGap)/;
/** A color or spacing value that is not one of the site's styles: a hex, a pixel length, custom CSS that sets either. */
const offToken = (prop: string, value: unknown) => {
  if (value === undefined || value === null || tokenOf(value)) return false;
  // A declaration of one of those properties (not a value that names one, as a transition does).
  if (prop === 'customCss') return /(^|[;{\s])(padding|margin|gap|row-gap|column-gap|color|background(-color)?)(-[a-z-]+)?\s*:/i.test(String(value));
  if (COLOR_PROPS.has(prop)) return !['transparent', 'inherit', 'currentcolor'].includes(String(value).toLowerCase());
  if (SPACING_PROP.test(prop)) return !['0', '0px', 'auto'].includes(String(value).toLowerCase());
  return false;
};
const textNodes = (def: ComponentDefinition) => Object.values(def.tree?.nodes ?? {}).filter((n) => n.kind === 'text').map((n) => n.id);

/**
 * A component that fits a phone and reads there, and keeps its 720px panel on desktop: graded from the design by the
 * benchmark's measurer, at the widths inspect_component measures. Its own editable text must be among what it
 * measured, visible and readable: hidden, faded or cut off, it is not.
 */
const phoneRepairChecks = (after: ProjectState, def: ComponentDefinition | undefined, message: string): Check[] => {
  // The text nodes that show the editable message: each one bound to its property (a phone and a desktop rendering
  // of it, say), or the one node that shows the words.
  const path = def && editedBy(after, def, message);
  const [prop, field] = (path ?? '').split('.');
  const bound = def && path ? textNodes(def).filter((n) => same((def.tree!.nodes[n] as { text?: unknown }).text, field ? { $prop: prop, field } : { $prop: prop })) : [];
  const shownAt = def && nodeShowing(after, def, message);
  const lines = new Set(bound.length ? bound : shownAt ? [shownAt] : []);
  const line = [...lines][0];
  const measure = (width: number) => {
    const m = def ? measureComponent(after, { definitionId: def.id }, width) : { error: 'gone' };
    return 'error' in m ? null : m;
  };
  const phone = measure(390);
  const desktop = measure(1280);
  const readable = (m: ReturnType<typeof measure>) => !!m && m.texts.some((t) => lines.has(t.nodeId) && (t.ratio ?? 0) >= 4.5) && !m.findings.some((f) => f.kind === 'low-contrast');
  const fits = (m: ReturnType<typeof measure>) => !!m && m.widths.checked > 0 && !m.widths.unmeasured.length && !m.findings.some((f) => f.kind === 'element-overflow');
  const root = def?.tree?.rootIds[0] ?? '';
  return [
    check('message-editable', !!path),
    check('fits-on-phone', fits(phone), JSON.stringify(phone ? { findings: phone.findings, unmeasured: phone.widths.unmeasured } : 'not measured')),
    check('readable-on-phone', readable(phone), JSON.stringify(phone?.texts)),
    // The panel still renders 720px wide on its desktop background, with its text readable.
    check('desktop-kept', fits(desktop) && readable(desktop) && desktop?.boxes[root] === 720 && !!def && desktop.texts.some((t) => lines.has(t.nodeId) && tokenOf(nearestStyle(def, t.nodeId, 'desktop', 'background')) === 'color.surface'), String(desktop?.boxes[root])),
    // The panel itself on the site's panel color, at every size: not its text alone.
    check('panel-background', !!def && SIZES.every((size) => tokenOf(styleAt(def, root, size, 'background')) === 'color.surface'))
  ];
};
/** An inspection that found something, could not measure something, or did not run. */
const stillWrong = (r: Record<string, unknown> | null) => !r || r.ok === false || !!r.error || ['findings', 'runtimeErrors', 'failed'].some((k) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0);
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
          const read = JSON.parse((req.items.at(-1) as { content: string }).content) as { hash: string; revision: number };
          return [call('apply_source_patch', { definitionId: id(), expectedRevision: read.revision, expectedHash: read.hash, scope: { kind: 'site' }, edits: [{ find: '{quote<', replace: '{quote}<' }] })];
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
        check('home-feed', (feedId === 'blog.grid' || feedId === 'blog.list') && /latest news/i.test(String(feed?.props.heading ?? '')) && feed?.props.count === 3 && !feed.props.category && !feed.props.tag && (feed.props.collection === undefined || feed.props.collection === '' || feed.props.collection === 'posts'), feed ? `${feedId} ${JSON.stringify(feed.props)}` : 'none'),
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
        check('excerpt-written', !!now?.excerpt && now.excerpt.trim().length >= 30 && now.excerpt.length <= 320 && !/[.!?]\s+\S/.test(now.excerpt.trim()) && /studio/i.test(now.excerpt) && /kiln|wheel|potter|cooperative|glaze|river/i.test(now.excerpt), now?.excerpt),
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
        // Every result has ok: only the write's says the excerpt was written.
        if (req.items.at(-1)?.kind === 'tool_result' && (req.items.at(-1) as { name: string }).name === 'upsert_collection_entry' && last?.ok === true) return finish('Wrote the excerpt.')(req);
        // Without the collapsed read the script writes nothing, and the case fails.
        const collapsed = req.items.some((it) => it.kind === 'tool_result' && it.name === 'read_collection_entry' && String(lastResultOf(it.content)?.superseded ?? '').startsWith('read_collection_entry posts/en_history'));
        if (!collapsed) return finish('The first read was never collapsed.')(req);
        return [call('upsert_collection_entry', { collectionId: 'posts', entryId: 'en_history', excerpt: 'How a riverside studio grew from one wheel into a cooperative of twelve potters.' })];
      };
      return [() => [call('read_collection_entry', { collectionId: 'posts', entryId: 'en_history' })], ...Array.from({ length: 40 }, () => step)];
    }
  },
  {
    id: 'create-workshop-notice',
    version: 1,
    category: 'component',
    prompt: 'Create a component called "Workshop notice" with an editable heading that starts as "Saturday workshop" and an editable message that starts as "Doors open at nine." Put one at the end of the home page.',
    task: 'component',
    scriptedProfile: 'cloud',
    grade: ({ before, after }) => {
      const def = madeNamed(before, after, 'Workshop notice');
      const heading = def && editedBy(after, def, 'Saturday workshop');
      const message = def && editedBy(after, def, 'Doors open at nine.');
      return [
        check('component-created', !!def, Object.values(after.components).filter((d) => !Object.hasOwn(before.components, d.id)).map((d) => d.name).join(', ') || 'none'),
        check('managed', def?.kind === 'managed', def?.kind),
        check('heading-editable', !!heading),
        check('message-editable', !!message && message !== heading),
        check('placed-last-on-home', placedLastOnHome(before, after, def, (c) => ['Saturday workshop', 'Doors open at nine.'].every((t) => textsShown(c).includes(plain(t))))),
        check('rest-untouched', shellUntouched(before, after) && Object.keys(before.pages).every((id) => id === before.site.homePageId || same(before.pages[id], after.pages[id])))
      ];
    },
    script: () => [
      () => [
        call('upsert_managed_component', {
          name: 'Workshop notice',
          description: 'A short notice: a heading and a message.',
          properties: [
            { type: 'string', name: 'heading', label: 'Heading', default: 'Saturday workshop' },
            { type: 'string', name: 'message', label: 'Message', default: 'Doors open at nine.' }
          ],
          nodes: [
            { kind: 'element', id: 'panel', tag: 'section', children: ['title', 'body'], styles: [{ property: 'paddingBlock', value: { token: 'space.xl' } }] },
            { kind: 'text', id: 'title', tag: 'h2', text: { $prop: 'heading' } },
            { kind: 'text', id: 'body', tag: 'p', text: { $prop: 'message' } }
          ],
          placeOnPage: { pageId: '/' }
        } satisfies ManagedComponentArgs)
      ],
      finish('Made Workshop notice and put one at the end of the home page.')
    ]
  },
  {
    id: 'create-repeated-workshop-cards',
    version: 1,
    category: 'component',
    prompt: 'Create a component called "Workshop cards": a set of cards authors edit as one list, each card with a title and a room. Start it with two cards, Glazing in the Kiln room and Weaving in the Loom room, and put one at the end of the home page.',
    task: 'component',
    scriptedProfile: 'constrained-json',
    grade: ({ before, after }) => {
      const def = madeNamed(before, after, 'Workshop cards');
      const lists = def ? Object.entries(def.properties).filter(([, p]) => p.type === 'list' && !p.feed) : [];
      const twoCards = (cards: string[][]) => cards.length === 2 && [['Glazing', 'Kiln room'], ['Weaving', 'Loom room']].every(([title, room]) => cards.some((t) => t.includes(plain(title)) && t.includes(plain(room))));
      const starts = def ? itemTexts(def, placementShows(after, def)) : [];
      // A third item in the list, which an author may add, shows a third card with each of its fields in it.
      const repeats =
        !!def &&
        lists.some(([name, p]) => {
          if (p.type !== 'list' || (p.max !== undefined && p.max < 3)) return false;
          const fields = Object.entries(p.fields).filter(([, f]) => TEXT_TYPES.has(f.type));
          const items = [1, 2, 3].map((i) => Object.fromEntries(fields.map(([f, schema]) => [f, textValue(schema as PropSchema, `${f} ${i} for the benchmark`)])));
          const shown = itemTexts(def, placementShows(after, def, { [name]: items }));
          return shown.length === 3 && [1, 2, 3].every((i) => shown.some((t) => fields.filter(([f]) => t.includes(plain(`${f} ${i} for the benchmark`))).length >= 2));
        });
      return [
        check('component-created', !!def),
        check('one-list', lists.length >= 1),
        check('starts-with-two-cards', twoCards(starts), JSON.stringify(starts)),
        check('card-per-item', repeats),
        check('placed-last-on-home', placedLastOnHome(before, after, def, (c) => !!def && twoCards(itemTexts(def, c))))
      ];
    },
    script: () => [
      () => [
        call('upsert_managed_component', {
          name: 'Workshop cards',
          description: 'A card per workshop: its title and the room it is in.',
          properties: [
            {
              type: 'list',
              name: 'cards',
              label: 'Cards',
              itemLabel: 'Card',
              titleField: 'title',
              fields: [
                { type: 'string', name: 'title', label: 'Title', default: 'Workshop' },
                { type: 'string', name: 'room', label: 'Room', default: 'Studio' }
              ],
              default: [
                { values: [{ field: 'title', value: 'Glazing' }, { field: 'room', value: 'Kiln room' }] },
                { values: [{ field: 'title', value: 'Weaving' }, { field: 'room', value: 'Loom room' }] }
              ]
            }
          ],
          nodes: [
            { kind: 'element', id: 'panel', tag: 'section', children: ['grid'], styles: [{ property: 'paddingBlock', value: { token: 'space.xl' } }] },
            { kind: 'element', id: 'grid', tag: 'ul', children: ['each'], styles: [{ property: 'layout', value: 'grid' }, { property: 'columns', value: 1 }, { property: 'columns', value: 2, scope: 'desktop' }, { property: 'gap', value: { token: 'space.lg' } }] },
            { kind: 'repeat', id: 'each', list: 'cards', children: ['card'] },
            { kind: 'element', id: 'card', tag: 'li', children: ['title', 'room'] },
            { kind: 'text', id: 'title', tag: 'h3', text: { $item: 'title' } },
            { kind: 'text', id: 'room', tag: 'p', text: { $item: 'room' } }
          ],
          parts: [{ id: 'card', nodeId: 'card', label: 'Card' }],
          placeOnPage: { pageId: '/' }
        } satisfies ManagedComponentArgs)
      ],
      finish('Made Workshop cards, a card per item of its list, and put one at the end of the home page.')
    ]
  },
  {
    id: 'add-panel-tone-axis',
    version: 1,
    category: 'component',
    prompt: "Give Studio panel a Tone choice that each placement can pick. Keep how it looks now as the default, and add an Inverse option that uses the site's dark section background with the text color meant for dark sections.",
    setup: (state) =>
      seedComponent(state, {
        name: 'Studio panel',
        properties: { title: { type: 'string', label: 'Title', default: 'Visit the studio' }, note: { type: 'string', label: 'Note', default: 'Open every weekday.' } },
        nodes: [
          { kind: 'element', id: 'panel', tag: 'section', children: ['title', 'note'], styles: { base: { background: { token: 'color.surface' }, color: { token: 'color.text' }, paddingBlock: { token: 'space.xl' }, paddingInline: { token: 'space.lg' } } } },
          { kind: 'text', id: 'title', tag: 'h2', text: { $prop: 'title' } },
          { kind: 'text', id: 'note', tag: 'p', text: { $prop: 'note' } }
        ]
      }),
    component: editedEverywhere('Studio panel'),
    scriptedProfile: 'constrained-json',
    grade: ({ before, after }) => {
      const was = defNamed(before, 'Studio panel')!;
      const def = after.components[was.id];
      // An Inverse option on a Tone axis, whatever their IDs.
      const found =
        def &&
        axesOf(def)
          .filter(([axis, a]) => /\btone\b/i.test(a.label || axis))
          .flatMap(([axis, a]) => Object.entries(a.options).filter(([, o]) => plain(o.label ?? '') === 'inverse').map(([option]) => ({ axis, option, isDefault: a.default === option })))[0];
      const inverse = found ? { [found.axis]: found.option } : undefined;
      const texts = def ? textNodes(def) : [];
      const root = def?.tree?.rootIds[0] ?? '';
      // How it looks: the panel's background, each text's color and what it sits on, and every other style of the
      // design's nodes (colors are compared where they show, so moving one onto the texts changes nothing).
      const look = (d: ComponentDefinition, variants?: Record<string, string>) =>
        JSON.stringify([
          SIZES.map((size) => styleAt(d, d.tree!.rootIds[0], size, 'background', variants)),
          textNodes(was).map((n) => SIZES.map((size) => [nearestStyle(d, n, size, 'color', variants), nearestStyle(d, n, size, 'background', variants), lineage(d, n).some((a) => styleAt(d, a, size, 'hidden', variants) === true)])),
          Object.keys(was.tree!.nodes).map((n) => SIZES.map((size) => Object.entries(designStyles(d, n, variants)[size] ?? {}).filter(([prop]) => !COLOR_PROPS.has(prop)).sort(([a], [b]) => a.localeCompare(b))))
        ]);
      const placement = Object.values(home(after).nodes).find((n) => n.kind === 'instance' && n.definitionId === was.id) as InstanceNode | undefined;
      return [
        check('inverse-option', !!found),
        check('default-unchanged', !!def && !found?.isDefault && look(def) === look(was), def && look(def)),
        // The whole panel is dark, and so is what every text sits on.
        check('inverse-background', !!inverse && texts.length > 0 && SIZES.every((size) => tokenOf(styleAt(def, root, size, 'background', inverse)) === 'color.inverse' && texts.every((n) => tokenOf(nearestStyle(def, n, size, 'background', inverse)) === 'color.inverse'))),
        check('inverse-text', !!inverse && texts.length > 0 && texts.every((n) => SIZES.every((size) => tokenOf(nearestStyle(def, n, size, 'color', inverse)) === 'color.on-inverse'))),
        check('placement-keeps-default', !!found && !!placement && selectedVariants(def, placement.variants)[found.axis] !== found.option),
        check('rest-untouched', shellUntouched(before, after) && same(Object.keys(before.components).sort(), Object.keys(after.components).sort()))
      ];
    },
    script: () => [
      () => [call('add_definition_variant', { axis: 'tone', option: 'inverse', label: 'Inverse' })],
      () => [
        call('style_definition_element', {
          nodeId: 'panel',
          variant: { axis: 'tone', option: 'inverse' },
          scope: 'base',
          styles: [
            { property: 'background', value: { token: 'color.inverse' } },
            { property: 'color', value: { token: 'color.on-inverse' } }
          ]
        })
      ],
      finish('Added a Tone choice to Studio panel: Inverse uses the dark section colors, and every placement keeps its current look.')
    ]
  },
  {
    id: 'show-booking-status-conditionally',
    version: 1,
    category: 'component',
    prompt: 'Create a component called "Booking status" with a yes/no setting "Bookings open" that starts off. While it is on, show only "Taking bookings"; while it is off, show only "Waitlist only". Authors should be able to edit both messages.',
    task: 'component',
    scriptedProfile: 'cloud',
    grade: ({ before, after }) => {
      const def = madeNamed(before, after, 'Booking status');
      const switches = def ? Object.entries(def.properties).filter(([, p]) => p.type === 'boolean' && plain(p.label ?? '') === 'bookings open').map(([name]) => name) : [];
      const shows = (props: Record<string, unknown>) => (def ? textsShown(placementShows(after, def, props)) : []);
      const only = (props: Record<string, unknown>, yes: string, no: string) => shows(props).includes(plain(yes)) && !shows(props).includes(plain(no));
      // The setting that switches between the two messages, whatever it is called.
      const open = switches.find((b) => only({ [b]: true }, 'Taking bookings', 'Waitlist only') && only({ [b]: false }, 'Waitlist only', 'Taking bookings'));
      const onEdit = def && open && editedBy(after, def, 'Taking bookings', { [open]: true });
      const offEdit = def && open && editedBy(after, def, 'Waitlist only', { [open]: false });
      return [
        check('component-created', !!def),
        check('yes-no-setting', !!open, switches.join(', ') || 'none'),
        check('starts-off', !!def && only({}, 'Waitlist only', 'Taking bookings'), shows({}).join(' | ')),
        check('open-message-editable', !!onEdit),
        check('closed-message-editable', !!offEdit && offEdit !== onEdit),
        check('shell-and-tokens-untouched', shellUntouched(before, after))
      ];
    },
    script: () => [
      () => [
        call('upsert_managed_component', {
          name: 'Booking status',
          description: 'Whether bookings are open, in the words of each placement.',
          properties: [
            { type: 'boolean', name: 'open', label: 'Bookings open', default: false },
            { type: 'string', name: 'openMessage', label: 'Open message', default: 'Taking bookings' },
            { type: 'string', name: 'closedMessage', label: 'Closed message', default: 'Waitlist only' }
          ],
          nodes: [
            { kind: 'element', id: 'panel', tag: 'div', children: ['open', 'closed'] },
            { kind: 'text', id: 'open', tag: 'p', text: { $prop: 'openMessage' }, when: { $prop: 'open' } },
            { kind: 'text', id: 'closed', tag: 'p', text: { $prop: 'closedMessage' }, unless: { $prop: 'open' } }
          ]
        } satisfies ManagedComponentArgs)
      ],
      finish('Made Booking status: it shows the open message while Bookings open is on, and the closed one while it is off.')
    ]
  },
  {
    id: 'style-component-with-site-tokens',
    version: 1,
    category: 'component',
    prompt: 'Create a reusable component called "Collection notice" with an editable line that starts as "Collect at reception". Give it the site\'s Cards and panels background, its Primary text color and Large padding on every side, using the site\'s own styles so it follows any change to them.',
    scriptedProfile: 'constrained-json',
    grade: ({ before, after }) => {
      const def = madeNamed(before, after, 'Collection notice');
      const line = def && nodeShowing(after, def, 'Collect at reception');
      // The container around the line (or the line itself) that carries the padding.
      const padded = def && line && lineage(def, line).find((n) => SIZES.every((size) => paddedWith(def, n, size, 'space.lg')));
      const off = def ? everyStyle(def).filter((x) => offToken(x.prop, x.value)) : [];
      return [
        check('component-created', !!def),
        check('line-editable', !!def && !!editedBy(after, def, 'Collect at reception')),
        check('surface-background', !!line && SIZES.every((size) => tokenOf(nearestStyle(def, line, size, 'background')) === 'color.surface')),
        // Set on the component itself: placed in a dark section, the color it would inherit is not the site's text color.
        check('text-color', !!line && SIZES.every((size) => tokenOf(nearestStyle(def, line, size, 'color')) === 'color.text')),
        check('large-padding', !!padded),
        check('only-site-styles', !!def && off.length === 0, off.map((x) => `${x.nodeId}.${x.prop}=${JSON.stringify(x.value)}`).join(', ')),
        check('site-styles-untouched', same(before.tokens, after.tokens))
      ];
    },
    script: () => [
      () => [
        call('upsert_managed_component', {
          name: 'Collection notice',
          description: 'A one-line notice on a panel.',
          properties: [{ type: 'string', name: 'message', label: 'Message', default: 'Collect at reception' }],
          nodes: [
            {
              kind: 'element',
              id: 'panel',
              tag: 'aside',
              children: ['line'],
              styles: [
                { property: 'background', value: { token: 'color.surface' } },
                { property: 'color', value: { token: 'color.text' } },
                { property: 'paddingBlock', value: { token: 'space.lg' } },
                { property: 'paddingInline', value: { token: 'space.lg' } }
              ]
            },
            { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'message' } }
          ]
        } satisfies ManagedComponentArgs)
      ],
      finish("Made Collection notice on the site's panel background, text color and large padding.")
    ]
  },
  {
    id: 'make-panel-caption-editable',
    version: 1,
    category: 'component',
    prompt: 'Make the caption of Service panel editable on each placement: a field labelled "Caption" that starts as "Ask at reception". Also let authors style the caption on each placement. Keep both placements\' headings as they are.',
    setup: (state) =>
      seedComponent(
        state,
        {
          name: 'Service panel',
          properties: { heading: { type: 'string', label: 'Heading', default: 'Our services' } },
          nodes: [
            { kind: 'element', id: 'panel', tag: 'section', children: ['heading', 'caption'], styles: { base: { paddingBlock: { token: 'space.xl' } } } },
            { kind: 'text', id: 'heading', tag: 'h2', text: { $prop: 'heading' } },
            { kind: 'text', id: 'caption', tag: 'p', text: 'Ask at reception' }
          ]
        },
        [{ heading: 'Repairs' }, { heading: 'Fittings' }]
      ),
    component: editedEverywhere('Service panel'),
    scriptedProfile: 'constrained-json',
    grade: ({ before, after }) => {
      const was = defNamed(before, 'Service panel')!;
      const def = after.components[was.id];
      const field = def && editedBy(after, def, 'Ask at reception');
      // A property, or a field of an object property.
      const [prop, sub] = (field ?? '').split('.');
      const top = field ? def.properties[prop] : undefined;
      const schema = sub && top?.type === 'object' ? top.fields[sub] : top;
      const caption = def && nodeShowing(after, def, 'Ask at reception');
      const placements = Object.values(home(before).nodes).filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === was.id);
      const now = placements.map((p) => home(after).nodes[p.id] as InstanceNode | undefined);
      // Each placement shows its own heading, not the other's, and the caption.
      const headings = placements.map((p) => plain(String(p.props.heading)));
      const eachShows = placements.length === 2 && placements.every((p, i) => {
        const shown = textsShown(homePlacementShows(after, p.id));
        return shown.includes(headings[i]) && !shown.includes(headings[1 - i]) && shown.includes(plain('Ask at reception'));
      });
      return [
        check('caption-editable', !!field),
        // Editable, and showing the words to start with: so they are its default.
        check('caption-field', !!schema && plain(schema.label ?? '') === 'caption', schema?.label),
        check('caption-part', !!caption && Object.entries(def.parts ?? {}).some(([id, part]) => id !== 'root' && part.nodeId === caption)),
        check('placements-kept', placements.length === 2 && now.every((n, i) => n?.kind === 'instance' && n.definitionId === was.id && same(n.props.heading, placements[i].props.heading))),
        check('placements-show-caption', eachShows),
        check('rest-untouched', shellUntouched(before, after) && Object.keys(before.pages).every((id) => id === before.site.homePageId || same(before.pages[id], after.pages[id])))
      ];
    },
    script: () => [
      () => [call('manage_component_prop', { change: { action: 'add', prop: 'caption', label: 'Caption', type: 'string', default: 'Ask at reception' } })],
      () => [call('bind_definition_field', { nodeId: 'caption', field: 'text', binding: { $prop: 'caption' } })],
      () => [call('edit_definition_node', { nodeId: 'caption', exposeAsPart: { partId: 'caption', label: 'Caption' } })],
      finish('The caption of Service panel is now a Caption field on each placement, and a part authors can style.')
    ]
  },
  {
    id: 'repair-component-on-phones',
    version: 1,
    category: 'component',
    prompt: 'Counter hours looks broken on phones. Inspect it at phone and desktop width and fix anything that does not fit or is hard to read, without changing how it looks on desktop.',
    setup: (state) =>
      seedComponent(state, {
        name: 'Counter hours',
        properties: { message: { type: 'string', label: 'Message', default: 'Counter closes at four' } },
        nodes: [
          { kind: 'element', id: 'panel', tag: 'aside', children: ['line'], styles: { base: { width: '720px', background: { token: 'color.surface' }, paddingBlock: { token: 'space.lg' }, paddingInline: { token: 'space.lg' } } } },
          // On phones its text takes the panel's own color: it cannot be read.
          { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'message' }, styles: { base: { color: { token: 'color.text' } }, phone: { color: { token: 'color.surface' } } } }
        ]
      }),
    component: editedEverywhere('Counter hours'),
    measureComponents: true,
    scriptedProfile: 'cloud',
    grade: ({ before, after }) => {
      const was = defNamed(before, 'Counter hours')!;
      return [...phoneRepairChecks(after, after.components[was.id], 'Counter closes at four'), check('site-styles-untouched', shellUntouched(before, after))];
    },
    script: (state) => {
      const id = () => defNamed(state(), 'Counter hours')!.id;
      type Inspected = { revision?: number; findings?: Array<{ kind: string; at?: { nodeId?: string } }> } | null;
      const found = (r: Inspected, kind: string, nodeId: string) => !!r?.findings?.some((f) => f.kind === kind && f.at?.nodeId === nodeId);
      return [
        () => [call('inspect_component', { definitionId: id() })],
        (req) => {
          const r = lastResult(req) as Inspected;
          // The fix follows what the inspection found: without the findings nothing is changed, and the case fails.
          if (!found(r, 'element-overflow', 'panel') || !found(r, 'low-contrast', 'line')) return finish('The inspection found nothing to fix.')(req);
          const owner = { kind: 'component', id: id() };
          return [
            call('apply_operations', {
              expectedRevision: r!.revision,
              operations: [
                { type: 'node.setStyle', owner, nodeId: 'panel', scope: 'phone', property: 'width', value: 'fill' },
                { type: 'node.setStyle', owner, nodeId: 'line', scope: 'phone', property: 'color', value: null }
              ]
            })
          ];
        },
        () => [call('inspect_component', { definitionId: id() })],
        (req) => finish(stillWrong(lastResult(req)) ? 'Counter hours still has problems on phones.' : 'Counter hours now fills a phone screen and its text is readable there; desktop is unchanged.')(req)
      ];
    }
  },
  {
    id: 'create-and-check-on-phones',
    version: 1,
    category: 'component',
    prompt: 'Create a component called "Opening hours": a panel 720px wide on the site\'s Cards and panels background, holding an editable line that starts as "Open nine to five". Then inspect it at phone and desktop width and fix anything that does not fit or is hard to read on phones, keeping it 720px wide on desktop.',
    task: 'component',
    measureComponents: true,
    scriptedProfile: 'constrained-json',
    grade: ({ before, after }) => {
      const def = madeNamed(before, after, 'Opening hours');
      return [check('component-created', !!def), ...phoneRepairChecks(after, def, 'Open nine to five'), check('site-styles-untouched', shellUntouched(before, after))];
    },
    // Built as asked, 720px for every size; measured; the phone width fixed from what was found; measured again.
    script: (state) => {
      const id = () => defNamed(state(), 'Opening hours')!.id;
      type Inspected = { revision?: number; findings?: Array<{ kind: string; at?: { nodeId?: string } }> } | null;
      return [
        () => [
          call('upsert_managed_component', {
            name: 'Opening hours',
            properties: [{ type: 'string', name: 'hours', label: 'Hours', default: 'Open nine to five' }],
            nodes: [
              {
                kind: 'element',
                id: 'panel',
                tag: 'aside',
                children: ['line'],
                styles: [
                  { property: 'width', value: '720px' },
                  { property: 'background', value: { token: 'color.surface' } },
                  { property: 'color', value: { token: 'color.text' } },
                  { property: 'paddingBlock', value: { token: 'space.lg' } },
                  { property: 'paddingInline', value: { token: 'space.lg' } }
                ]
              },
              { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'hours' } }
            ]
          } satisfies ManagedComponentArgs)
        ],
        () => [call('inspect_component', { definitionId: id() })],
        (req) => {
          const r = lastResult(req) as Inspected;
          if (!r?.findings?.some((f) => f.kind === 'element-overflow' && f.at?.nodeId === 'panel')) return finish('The inspection found nothing to fix.')(req);
          return [call('apply_operations', { expectedRevision: r.revision, operations: [{ type: 'node.setStyle', owner: { kind: 'component', id: id() }, nodeId: 'panel', scope: 'phone', property: 'width', value: 'fill' }] })];
        },
        () => [call('inspect_component', { definitionId: id() })],
        (req) => finish(stillWrong(lastResult(req)) ? 'Opening hours still has problems on phones.' : 'Made Opening hours; on phones it now fills the screen, and it stays 720px wide on desktop.')(req)
      ];
    }
  }
];
