/**
 * The designs the Markdown copies read Foundation's sections through (src/generator/shipped-outlines.ts, #1350) hold
 * to the committed releases' own markup: every text the markup marks for the canvas (`data-so-text`) is in its
 * design, in the markup's order, inside the same parts, and a part styled one item at a time repeats over the same
 * list; the words a design shows beyond those are the ones listed here, which the release shows without a marker. A
 * release that adds, moves or restyles marked words fails here until its design is brought along, and so does a new
 * section, until it is given a design or a reason to have none.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'svelte/compiler';
import type { ComponentDefinition, GraphNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { findTheme } from '@catalogue/index';
import { OUTLINED, outlineOf, shippedOutline } from '@generator/shipped-outlines';
import { repeatedPartList } from '@shared/item-styles';

const PACKS = ['foundation', 'foundation-alt'];

/** The sections read without a design of their own, and why. */
const ELSEWHERE: Record<string, string> = {
  'shell.header': 'the shared header is no page’s content',
  'shell.footer': 'the shared footer is no page’s content',
  'layout.section': 'shows only what is placed in its slot',
  'layout.split': 'shows only what is placed in its slots',
  'data.table': 'written with its cells by generator/markdown.ts',
  'pricing.compare': 'written as a table by generator/markdown.ts',
  'media.video': 'written by generator/markdown.ts',
  'block.video': 'written by generator/markdown.ts',
  'contact.form': 'written by generator/markdown.ts',
  'block.signup': 'written by generator/markdown.ts'
};

/** Marked words a design leaves out, each a decoration rather than what the section says. */
const LEFT_OUT: Record<string, string[]> = {
  // The title bar of the window frame drawn around the screenshot.
  'hero.screenshot': ['frameTitle'],
  // The initials drawn in place of a missing portrait.
  'block.testimonial': ['initials']
};

/**
 * The words a design shows that the release shows without marking them for the canvas: rows worked out from the site's
 * pages and entries, a featured card, the tabs' labels, and the toggle's prices with their periods' labels.
 */
const UNMARKED: Record<string, string[]> = {
  'content.article': ['article.title', 'article.dateLabel', 'article.byline', 'article.excerpt'],
  'features.bento': ['featured.title', 'featured.description', 'featured.linkLabel'],
  'tabs.showcase': ['tabs.label'],
  'pricing.toggle': ['monthlyLabel', 'plans.monthlyPrice', 'plans.monthlyNote', 'annualLabel', 'plans.annualPrice', 'plans.annualNote'],
  'content.pages': ['items.title', 'items.description'],
  'content.news': ['items.title', 'items.dateLabel', 'items.byline', 'items.excerpt'],
  'blog.featured': ['items.category', 'items.title', 'items.dateLabel', 'items.byline', 'items.excerpt'],
  'blog.grid': ['items.category', 'items.title', 'items.dateLabel', 'items.byline', 'items.excerpt'],
  'blog.list': ['items.category', 'items.title', 'items.dateLabel', 'items.byline', 'items.excerpt']
};

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type Marked = { path: string; parts: Set<string> };

/** The texts a section's markup marks, in source order, each with the parts styled on it and around it. */
function markedInMarkup(source: string): Marked[] {
  const ast = parse(source, { modern: true }) as unknown as { fragment: AstNode };
  const out: Marked[] = [];
  const partsOf = (n: AstNode): string[] => {
    const cls = ((n.attributes as AstNode[] | undefined) ?? []).find((a) => a.type === 'Attribute' && a.name === 'class');
    if (!cls || cls.value === true) return [];
    const text = source.slice(cls.start, cls.end);
    return [...text.matchAll(/so_o\?\.(\w+)/g), ...text.matchAll(/so_oi\?\.\[[^\]]+\]\?\.(\w+)/g)].map((m) => m[1]);
  };
  const markOf = (n: AstNode): string | undefined => {
    const attr = ((n.attributes as AstNode[] | undefined) ?? []).find((a) => a.type === 'Attribute' && a.name === 'data-so-text');
    if (!attr) return undefined;
    const m = /so_text\?\.\(\s*'([^']+)'/.exec(source.slice(attr.start, attr.end));
    if (!m) throw new Error(`An unreadable marker: ${source.slice(attr.start, attr.end)}`);
    return m[1];
  };
  const walk = (n: unknown, parts: string[]) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return void n.forEach((c) => walk(c, parts));
    const node = n as AstNode;
    let inner = parts;
    if (Array.isArray(node.attributes)) {
      inner = [...parts, ...partsOf(node)];
      const path = markOf(node);
      if (path) out.push({ path, parts: new Set(inner) });
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'attributes' && k !== 'metadata' && v && typeof v === 'object') walk(v, inner);
  };
  walk(ast.fragment, []);
  return out;
}

/** The texts a design shows, in tree order, each named as a marker names it, with the parts it sits in. */
function shownInOutline(def: ComponentDefinition): Marked[] {
  const tree = def.tree!;
  const partOf = new Map(Object.entries(def.parts).map(([name, p]) => [p.nodeId, name]));
  const out: Marked[] = [];
  const named = (b: unknown, list: string | undefined): string | undefined => {
    const v = b as { $prop?: unknown; field?: unknown; $item?: unknown } | null;
    if (!v || typeof v !== 'object') return undefined;
    if (typeof v.$prop === 'string') return typeof v.field === 'string' ? `${v.$prop}.${v.field}` : v.$prop;
    if (typeof v.$item === 'string' && list) return `${list}.${v.$item}`;
    return undefined;
  };
  const walk = (id: string, parts: string[], list: string | undefined) => {
    const n: GraphNode = tree.nodes[id];
    const here = partOf.has(id) ? [...parts, partOf.get(id)!] : parts;
    const path = n.kind === 'text' ? named(n.text, list) : n.kind === 'link' ? named(n.label, list) : undefined;
    if (path) out.push({ path, parts: new Set(here) });
    if (n.kind === 'element') for (const c of n.children) walk(c, here, list);
    if (n.kind === 'repeat') for (const c of n.children) walk(c, here, '$prop' in n.list ? n.list.$prop : list);
  };
  for (const r of tree.rootIds) walk(r, [], undefined);
  return out;
}

/** The parts styled on and around each path, over every place it shows. */
const partsByPath = (marked: Marked[]) => {
  const out: Record<string, string[]> = {};
  for (const m of marked) out[m.path] = [...new Set([...(out[m.path] ?? []), ...m.parts])].sort();
  return out;
};

/** A state no cached run tracks. */
const untracked: ProjectState = createStarterState('blank', 'Check', false);

const pack = (id: string) => {
  const theme = findTheme(id);
  if (!theme) throw new Error(`${id} is not registered.`);
  return theme;
};

describe('the designs Foundation’s sections are read through for their Markdown', () => {
  it.each(PACKS)('gives each of %s’s sections a design, or a reason to have none', (id) => {
    const ids = pack(id).components.map((c) => c.componentId);
    expect(ids.filter((c) => !OUTLINED.includes(c) && !Object.hasOwn(ELSEWHERE, c))).toEqual([]);
    expect(ids.filter((c) => OUTLINED.includes(c) && Object.hasOwn(ELSEWHERE, c))).toEqual([]);
    expect(OUTLINED.filter((c) => !ids.includes(c))).toEqual([]);
    // Each bundled section is read through its design, and none of them has slots a design would have to show.
    for (const def of pack(id).components) {
      expect(!!shippedOutline(untracked, def), def.componentId).toBe(OUTLINED.includes(def.componentId));
      if (OUTLINED.includes(def.componentId)) expect(Object.keys(def.slots ?? {}), def.componentId).toEqual([]);
    }
  });

  const cases = PACKS.flatMap((id) => OUTLINED.map((componentId) => ({ id, componentId })));

  it.each(cases)('$id’s $componentId shows its marked words in the release’s order, inside the same parts', ({ id, componentId }) => {
    const def = pack(id).components.find((c) => c.componentId === componentId)!;
    const outline = outlineOf(def);
    const skipped = LEFT_OUT[componentId] ?? [];
    const marked = markedInMarkup(def.source ?? '').filter((m) => !skipped.includes(m.path));
    const shown = shownInOutline(outline);
    expect(marked.length, `${componentId} marks no words`).toBeGreaterThan(0);
    // Every marked text, in order, among what the design shows, each where it sits inside no part the markup does not
    // put around it (a part on a choice of two elements, such as a featured card's, is on one of them each).
    let at = 0;
    for (const m of marked) {
      const found = shown.findIndex((s, i) => i >= at && s.path === m.path && [...s.parts].every((p) => m.parts.has(p)));
      expect(found, `${componentId}: ${m.path} after ${shown[at - 1]?.path ?? 'the start'}`).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
    for (const left of skipped) expect(shown.map((s) => s.path)).not.toContain(left);
    // Nothing else: no setting, and no words the release does not show.
    const known = new Set([...marked.map((m) => m.path), ...(UNMARKED[componentId] ?? [])]);
    expect(shown.map((s) => s.path).filter((p) => !known.has(p))).toEqual([]);
    const markedParts = partsByPath(marked);
    const shownParts = partsByPath(shown.filter((s) => Object.hasOwn(markedParts, s.path)));
    expect(shownParts).toEqual(markedParts);
    // A part the release styles one item at a time is read over the same list. Any other part a placement can only
    // style for every item (its item styles are refused, and the markup reads none), so its list here never matters.
    for (const [part, p] of Object.entries(def.parts)) if (outline.tree!.nodes[p.nodeId] && repeatedPartList(def, part)) expect(repeatedPartList(outline, part), `${componentId}.${part}`).toBe(repeatedPartList(def, part));
  });

  it('reads only a definition exactly as the app ships it', () => {
    const def = pack('foundation').components.find((c) => c.componentId === 'faq.list')!;
    expect(shippedOutline(untracked, structuredClone(def))?.tree).toBeDefined();
    expect(shippedOutline(untracked, { ...structuredClone(def), source: `${def.source}\n<p>{heading}</p>` })).toBeUndefined();
    expect(shippedOutline(untracked, { ...structuredClone(def), owner: 'project' })).toBeUndefined();
    // Its code as shipped, and anything else changed: a property's default.
    const changed = structuredClone(def);
    changed.properties.heading = { ...changed.properties.heading, default: 'Something else' } as typeof changed.properties.heading;
    expect(shippedOutline(untracked, changed)).toBeUndefined();
    expect(shippedOutline(untracked, pack('foundation').components.find((c) => c.componentId === 'data.table')!)).toBeUndefined();
  });
});
