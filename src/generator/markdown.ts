/**
 * Clean Markdown of what a page or collection entry says, for AI agents (see shared/llms.ts): its headings,
 * paragraphs, lists, quotes, links, tables and questions with their answers, without the header, footer, layout or
 * styling around them.
 *
 * A page is read as its generated page renders it (walkRendered): the page's own content only, never the shared
 * header and footer; what is hidden at every size left out (its own layers, as site search leaves them out, and a
 * component's parts its design or placement hides); and the panels a component keeps in the page while its state hides
 * them (a tab not chosen yet) kept, since the page ships their words. Code components are read only where the site
 * knows what they show (the theme's table, form and video): any other code's output is unknown, so nothing of it is
 * written.
 *
 * Nothing about a document agents are not told of reaches the Markdown of another: the rows of news and post lists
 * and the cards of page lists that lead to one are left out where the list is filled, before any design hands them
 * on; and a link to one keeps its words but not where it goes.
 */
import type { ComponentDefinition, EntryDoc, GraphNode, LinkValue, PageDoc, ProjectState, TableValue } from '@shared/types';
import { asParagraphList, isImageBlock, isListBlock, toRichText, type RichBlock, type RichSpan, type RichText } from '@shared/richtext';
import { findEntry } from '@shared/collections';
import { evaluate, hiddenInDesignEverywhere, shippedCode, walkRendered, type Scope } from './checks';
import { hiddenLayers } from './search';
import { resolveLink, sortedBrokenCards } from './index';
import { cardKey, isCardLink } from './card-links';
import { derived } from './cache';
import { isFormContract } from '@catalogue/foundation/form';

/** What the Markdown of one document is written for. */
export interface MarkdownContext {
  state: ProjectState;
  /** The address of the document being written ("/about/"), which its links within the page are read against. */
  route: string;
  /** Whether agents are told of a page or an entry: a link to anything else keeps only its words. */
  listedPage: (pageId: string) => boolean;
  listedEntry: (collectionId: string, entryId: string) => boolean;
  /** A path of the site ("/contact/#hours", "/guide.pdf") as a link of this output writes it. */
  href: (path: string) => string;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Characters that would read as Markdown inside a line. */
const escapeInline = (text: string) => text.replace(/[\\`*_[\]<]/g, '\\$&');

/**
 * A line kept from reading as a block marker: a heading's #s, a quote's >, a list's bullet or number, a rule, a
 * setext underline or a code fence keeps its marker literal. For a line's start, and the start after a quote's marker.
 */
export const escapeLineStart = (line: string) =>
  line
    .replace(/^(\s*)(#{1,6}(?=\s|$)|>|[+-](?=\s|$))/, '$1\\$2')
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
    .replace(/^(\s*)([-=~])(?=\2\2)/, '$1\\$2');

/** Lines of one block, each kept from reading as a marker, with a hard line break between them (as `<br>` shows them). */
const brokenLines = (lines: string[], indent = '') => lines.map(escapeLineStart).join(`\\\n${indent}`);

/** Text as quoted lines. */
const quoted = (lines: string[]) => lines.map((l, i) => `> ${escapeLineStart(l)}${i < lines.length - 1 ? '\\' : ''}`).join('\n');

/** The whitespace before and after text, and the text between, found in one pass whatever its length. */
function aroundSpace(text: string): [string, string, string] {
  let a = 0;
  let b = text.length;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return [text.slice(0, a), text.slice(a, b), text.slice(b)];
}

/** Plain text as Markdown paragraphs: blank lines part them, its other line breaks are kept, and every line is written literally. */
function paragraphs(value: string): string[][] {
  return value
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => escapeInline(l.replace(/[ \t]+/g, ' ').trim()))
        .filter(Boolean)
    )
    .filter((lines) => lines.length > 0);
}

/** Text on one line, written literally: for headings, list items, table cells and link words. */
export const inlineMarkdown = (value: string) => escapeInline(value.replace(/\s+/g, ' ').trim());
const inline = inlineMarkdown;

/** A link's destination, in angle brackets when it holds a space or a bracket. */
const destination = (href: string) => (/[()\s<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href);

/** Words as a link to `href`, or the words alone without one. */
const linked = (words: string, href: string | null) => (href && words ? `[${words}](${destination(href)})` : words);

/** Whether a destination is a page or an entry agents are told of; any other kind of destination is no document. */
function listedTarget(ctx: MarkdownContext, link: unknown): boolean {
  if (!link || typeof link !== 'object') return true;
  const { type, target } = link as Partial<LinkValue>;
  if (type === 'page') return typeof target === 'string' && ctx.listedPage(target);
  if (type !== 'entry') return true;
  const found = typeof target === 'string' ? findEntry(ctx.state, target) : undefined;
  return !!found && ctx.listedEntry(found.collection.settings.id, found.entry.id);
}

/** Where a link goes, as this output writes it; null for a link that goes nowhere, or to a document agents are not told of. */
export function markdownHref(ctx: MarkdownContext, link: LinkValue | null | undefined): string | null {
  if (!link || typeof link !== 'object' || !listedTarget(ctx, link)) return null;
  const resolved = resolveLink(link, { state: ctx.state });
  if (!resolved) return null;
  const { href } = resolved;
  // A link within the page goes to that place on the page, not in its Markdown.
  if (href.startsWith('#')) return ctx.href(ctx.route + href);
  return href.startsWith('/') ? ctx.href(href) : href;
}

/** Spans as Markdown lines: marks and links inline, a line for each line break, empty lines left out. */
function spansMarkdown(ctx: MarkdownContext, spans: RichSpan[]): string[] {
  return spans
    .map((s) => {
      const text = typeof s.text === 'string' ? s.text : '';
      if (!text) return '';
      // Marks hold to the words: spaces around them stay outside, where Markdown needs them.
      const [lead, words, trail] = aroundSpace(text);
      const mark = s.strong && s.em ? '***' : s.strong ? '**' : s.em ? '*' : '';
      const body = words ? `${mark}${escapeInline(words)}${mark}` : '';
      return lead + (s.link ? linked(body, markdownHref(ctx, s.link)) : body) + trail;
    })
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A heading's level in Markdown: `shift` levels below the one it has, at most six. */
const headingMark = (level: number, shift: number) => '#'.repeat(Math.min(6, Math.max(1, level + shift)));

/** One block of rich text: a heading, a paragraph, a list, a quote, or a picture's caption. */
function richBlockMarkdown(ctx: MarkdownContext, b: RichBlock): { heading?: number; text: string } | null {
  if (isImageBlock(b)) {
    const caption = typeof b.caption === 'string' ? b.caption.trim() : '';
    return caption ? { text: `*${inline(caption)}*` } : null;
  }
  if (isListBlock(b)) {
    const items = b.items.map((it) => spansMarkdown(ctx, it)).filter((lines) => lines.length);
    if (!items.length) return null;
    return {
      text: items
        .map((lines, i) => {
          const marker = b.type === 'ol' ? `${i + 1}. ` : b.type === 'check' ? '- [x] ' : '- ';
          return marker + brokenLines(lines, ' '.repeat(b.type === 'check' ? 2 : marker.length));
        })
        .join('\n')
    };
  }
  const lines = spansMarkdown(ctx, b.spans);
  if (!lines.length) return null;
  const level = { h2: 2, h3: 3, h4: 4 }[b.type as string];
  if (level) return { heading: level, text: lines.join(' ') };
  if (b.type === 'blockquote') return { text: quoted(lines) };
  return { text: brokenLines(lines) };
}

/** Rich text as Markdown blocks, its headings `shift` levels below their own. */
export function richTextMarkdown(ctx: MarkdownContext, blocks: RichText, shift = 0): string {
  return blocks
    .map((b) => richBlockMarkdown(ctx, b))
    .filter((b): b is { heading?: number; text: string } => !!b)
    .map((b) => (b.heading ? `${headingMark(b.heading, shift)} ${b.text}` : b.text))
    .join('\n\n');
}

/** A table as Markdown: its column names, then each row's cells in the columns' order. */
export function tableMarkdown(value: unknown): string {
  const table = value as Partial<TableValue> | null;
  const columns = Array.isArray(table?.columns) ? table.columns.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : [];
  if (!columns.length) return '';
  const cell = (v: unknown) => (typeof v === 'string' ? inline(v).replace(/\|/g, '\\|') : '');
  const row = (cells: string[]) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
  const rows = (Array.isArray(table?.rows) ? table.rows : []).filter((r) => r && typeof r === 'object' && r.cells && typeof r.cells === 'object');
  return [row(columns.map((c) => cell(c.label))), row(columns.map(() => '---')), ...rows.map((r) => row(columns.map((c) => cell(Object.hasOwn(r.cells, c.id) ? r.cells[c.id] : ''))))].join('\n');
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Where the content inside an element goes while it is written: a list collects its items, an item or a quote its
 * blocks, an inline element (a paragraph, a question's summary) its words on one line; anything else passes its
 * content on. A linked card (any of them) hands its first words its link.
 */
type Frame = (
  | { kind: 'root' | 'item' | 'quote'; blocks: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'inline'; bold: boolean; parts: string[] }
  | { kind: 'pass' }
) & { link?: string | null };
type Sink = Extract<Frame, { kind: 'root' | 'item' | 'quote' | 'list' | 'inline' }>;

const TAG_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** A tag as the page renders it: a fixed one, or the one a property chooses. */
const tagOf = (tag: unknown, scope: Scope) => {
  const v = typeof tag === 'string' ? tag : evaluate(tag, scope);
  return typeof v === 'string' ? v : '';
};

/** Whether a block of an item is a quote or a list, which a paragraph after it must leave a blank line below. */
const endsOwnBlock = (block: string) => /^(>|[-+*] |\d+[.)] )/.test(block);

/**
 * A page's content as Markdown, its headings one level below their own: the document's title is its only top heading.
 * Empty when it shows no words.
 */
export function pageMarkdown(ctx: MarkdownContext, page: PageDoc): string {
  const { state } = ctx;
  const hidden = hiddenLayers(page);
  const root: Frame = { kind: 'root', blocks: [] };
  const stack: Frame[] = [root];
  const SHIFT = 1;

  /** The innermost frame that collects content. */
  const sink = (): Sink => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f.kind !== 'pass') return f;
    }
    return root as Sink;
  };
  /** The link a card hands the first words inside it, taken once. */
  const cardLink = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f.link) {
        const href = f.link;
        f.link = null;
        return href;
      }
    }
    return null;
  };
  /** Adds a block: a heading (`level`), a paragraph, or Markdown already formed (a list, a table, a quote). */
  const add = (text: string, level?: number) => {
    if (!text) return;
    const to = sink();
    if (to.kind === 'inline') return void to.parts.push(level ? `**${text}**` : text);
    if (to.kind === 'list') return void to.items.push(level ? `**${text}**` : text);
    // A heading inside a list item reads as its strong first words.
    if (level && to.kind === 'item') return void to.blocks.push(`**${text}**`);
    to.blocks.push(level ? `${headingMark(level, SHIFT)} ${text}` : text);
  };
  const addRich = (value: unknown, paragraphList?: unknown) => {
    let blocks = toRichText(value);
    if (paragraphList === 'ul' || paragraphList === 'check') blocks = asParagraphList(blocks, paragraphList);
    for (const b of blocks) {
      const md = richBlockMarkdown(ctx, b);
      if (!md) continue;
      // A card's link goes on its first words: a heading's, or a paragraph's without a link of its own.
      const plain = md.heading !== undefined || (!isListBlock(b) && !isImageBlock(b) && b.type !== 'blockquote' && !md.text.includes(']('));
      add(plain ? linked(md.text, cardLink()) : md.text, md.heading);
    }
  };
  const addPlain = (value: unknown, level?: number) => {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
    if (level) {
      const words = inline(text);
      if (words) add(linked(words, cardLink()), level);
      return;
    }
    paragraphs(text).forEach((lines, i) => add(i === 0 ? linked(brokenLines(lines), cardLink()) : brokenLines(lines)));
  };

  /** What is hidden at every size: the page's own layers, and a component's parts its design, options or placement hide. */
  const pruned = (n: GraphNode, scope: Scope, reportId: string, def: ComponentDefinition | undefined) => hidden.has(reportId) || (!!def?.tree && def.tree.nodes[n.id] === n && hiddenInDesignEverywhere(def, n.id, scope));

  let broken: Set<string> | undefined;
  /** Whether the website renders an element as a card: one with a destination, and nothing interactive inside it. */
  const isCard = (n: GraphNode, def: ComponentDefinition | undefined) => {
    if (!isCardLink(n)) return false;
    broken ??= new Set(derived(state, 'brokenCards', sortedBrokenCards));
    return !broken.has(cardKey({ owner: def ? { kind: 'component', id: def.id } : { kind: 'page', id: page.id }, cardId: n.id }));
  };

  const open = (n: GraphNode, scope: Scope, def: ComponentDefinition | undefined): Frame => {
    if (n.kind !== 'element') return { kind: 'pass' };
    // A card: the whole container is a link where the website makes it one (see generator/card-links.ts), while it goes
    // somewhere and no other action takes the click.
    const action = n.action === undefined || n.action === null ? undefined : evaluate(n.action, scope);
    const href = isCard(n, def) && (action === undefined || action === 'link') ? markdownHref(ctx, evaluate(n.link, scope) as LinkValue) : null;
    const link = href ? { link: href } : {};
    const tag = tagOf(n.tag, scope);
    if (tag === 'ul' || tag === 'ol') return { kind: 'list', ordered: tag === 'ol', items: [], ...link };
    if (tag === 'li') return { kind: 'item', blocks: [], ...link };
    if (tag === 'blockquote') return { kind: 'quote', blocks: [], ...link };
    if (tag === 'summary' || tag === 'dt') return { kind: 'inline', bold: true, parts: [], ...link };
    if (tag === 'p' || tag === 'dd') return { kind: 'inline', bold: false, parts: [], ...link };
    return { kind: 'pass', ...link };
  };

  const close = (f: Frame) => {
    switch (f.kind) {
      case 'list': {
        if (!f.items.length) return;
        const lines = f.items.map((it, i) => {
          const marker = f.ordered ? `${i + 1}. ` : '- ';
          // Continuation lines sit under the item's words; a blank line stays blank.
          return marker + it.split('\n').map((l, j) => (j === 0 || !l ? l : ' '.repeat(marker.length) + l)).join('\n');
        });
        const to = sink();
        // A list inside a list's item is part of that item.
        if (to.kind === 'item') to.blocks.push(lines.join('\n'));
        else add(lines.join('\n'));
        return;
      }
      case 'item': {
        if (!f.blocks.length) return;
        // A paragraph after a quote or a list in the same item starts afresh, so it is not read as part of them.
        const text = f.blocks.map((b, i) => (i === 0 ? b : `${endsOwnBlock(f.blocks[i - 1]) ? '\n\n' : '\n'}${b}`)).join('');
        const to = sink();
        if (to.kind === 'list') to.items.push(text);
        else add(text);
        return;
      }
      case 'quote':
        if (f.blocks.length)
          add(
            f.blocks
              .join('\n\n')
              .split('\n')
              .map((l) => (l ? `> ${l}` : '>'))
              .join('\n')
          );
        return;
      case 'inline': {
        const text = f.parts.join(' ').replace(/[ \t]+/g, ' ').trim();
        if (text) add(f.bold && !/^\*\*.*\*\*$/s.test(text) ? `**${text}**` : text);
        return;
      }
    }
  };

  /** What the theme's own code components show: their words around the table, form or video, and a table's cells. */
  const code = (def: ComponentDefinition, props: Record<string, unknown>) => {
    const which = shippedCode(state, def);
    // The compact video's only words are its caption.
    if (which === 'block.video') return void addPlain(props.caption);
    if (which !== 'data.table' && !isFormContract(which) && which !== 'media.video') return;
    const words = (key: string) => (Array.isArray(props[key]) ? addRich(props[key]) : addPlain(props[key]));
    words('eyebrow');
    addPlain(props.heading, which === 'block.signup' ? 3 : 2);
    words('lead');
    if (which !== 'data.table') return;
    const caption = typeof props.caption === 'string' ? inline(props.caption) : '';
    if (caption) add(`**${caption}**`);
    const table = tableMarkdown(props.table);
    if (table) add(table);
  };

  walkRendered(state, page, {
    kept: true,
    // The rows of news and post lists, and the cards of page lists, leading to a document agents are not told of.
    listed: (link) => listedTarget(ctx, link),
    prune: pruned,
    node: (n, scope, _reportId, _inDef, def) => void stack.push(open(n, scope, def)),
    done: () => {
      const f = stack.pop();
      if (f) close(f);
    },
    text: (n, scope) => {
      const value = evaluate(n.text, scope);
      if (n.rich) return addRich(value, n.paragraphList);
      const tag = tagOf(n.tag, scope);
      if (tag === 'blockquote') {
        const paras = paragraphs(typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
        if (paras.length) add(paras.map(quoted).join('\n>\n'));
        return;
      }
      addPlain(value, TAG_LEVEL[tag]);
    },
    link: (n, scope) => {
      const label = evaluate(n.label, scope);
      const words = typeof label === 'string' || typeof label === 'number' ? inline(String(label)) : '';
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      const href = markdownHref(ctx, link);
      if (!words) return;
      if (href) add(linked(words, href));
      // A link to a document agents are not told of keeps its words. A button that changes the component's state (a
      // tab, a toggle) or goes nowhere says nothing of the page's content.
      else if (resolveLink(link, { state })) add(words);
    },
    code: (def, props) => code(def, props)
  });
  return root.blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Collection entries
// ---------------------------------------------------------------------------

/** An entry's text as Markdown: its body, whose headings (Heading 2 and below) sit under the entry's title. */
export function entryMarkdown(ctx: MarkdownContext, entry: EntryDoc): string {
  return richTextMarkdown(ctx, toRichText(entry.body));
}
