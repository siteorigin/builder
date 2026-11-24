/**
 * Semantic tags (#189): containers take any supported element tag and text any of its plain tags, through the same
 * `node.setContent` edit on a page and in a component's design, and the exported site renders the chosen tag. A tag
 * that would break the HTML around it (a list item outside a list, a block inside a paragraph) is refused.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { ELEMENT_TAGS, TEXT_TAGS } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState, STARTERS } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { prop, P, type ComponentSpec } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { nestingProblems, tagOptions, tagProblem } from '@engine/semantic-tags';
import { defFile, generateProject } from '@generator/index';
import { ELEMENT_TAG_GROUPS, TEXT_TAG_GROUPS, tagSelectOptions } from '../../src/renderer/src/lib/tag-options';

const { managed } = FOUNDATION;
const blank = () => createStarterState('blank', 'Blank', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageOwner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const defOwner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const nesting = (s: ProjectState) => validateState(s).filter((d) => d.code === 'TAG_NESTING');
const homeSvelte = (s: ProjectState) => generateProject(s).get('src/routes/+page.svelte')!;
const componentSvelte = (s: ProjectState, def: ComponentDefinition) => generateProject(s).get(defFile(def))!;
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const setTag = (owner: { kind: 'page' | 'component' | 'shell'; id: string }, nodeId: string, value: unknown): EditOperation => ({ type: 'node.setContent', owner, nodeId, field: 'tag', value });
/** What the session refuses: blocking problems the change brings in. */
const introduced = (before: ProjectState, after: ProjectState) => introducedDiagnostics(validateState(before, { sectionLinks: false }).filter(blocksSaving), validateState(after, { sectionLinks: false }).filter(blocksSaving));

/** A project component built with the catalogue helpers, installed into the project, and placed at the end of Home unless `placed` is false. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>, placed = true): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  if (placed) {
    const node = makeInstance(def, {});
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
  }
  return def;
}

/** A page with one stack on it holding a heading and a paragraph. */
function pageWithStack() {
  const s = blank();
  const o = pageOwner(s);
  const state = apply(s, [
    { type: 'node.insert', newNodeId: 'n_stack01', owner: o, parentId: null, primitive: 'stack' },
    { type: 'node.insert', newNodeId: 'n_title01', owner: o, parentId: 'n_stack01', primitive: 'heading', text: 'Our work' },
    { type: 'node.insert', newNodeId: 'n_body01', owner: o, parentId: 'n_stack01', primitive: 'paragraph', text: 'Some words.' }
  ]);
  return { s: state, o };
}

/** A page with a stack holding two rows, each with a paragraph: the shape a list is built from. */
function pageWithRows() {
  const s = blank();
  const o = pageOwner(s);
  const state = apply(s, [
    { type: 'node.insert', newNodeId: 'n_stack01', owner: o, parentId: null, primitive: 'stack' },
    { type: 'node.insert', newNodeId: 'n_row0001', owner: o, parentId: 'n_stack01', primitive: 'row' },
    { type: 'node.insert', newNodeId: 'n_row0002', owner: o, parentId: 'n_stack01', primitive: 'row' },
    { type: 'node.insert', newNodeId: 'n_text0001', owner: o, parentId: 'n_row0001', primitive: 'paragraph', text: 'Price' },
    { type: 'node.insert', newNodeId: 'n_text0002', owner: o, parentId: 'n_row0002', primitive: 'paragraph', text: '$10' }
  ]);
  return { s: state, o };
}

describe('text tags (#189)', () => {
  it('takes every plain text tag on a page, and the page renders it', () => {
    const { s, o } = pageWithStack();
    for (const tag of ['h1', 'h5', 'h6', 'p', 'span', 'small', 'strong', 'blockquote', 'div', 'cite'] as const) {
      const r = apply(s, [setTag(o, 'n_title01', tag)]);
      expect(home(r).nodes.n_title01).toMatchObject({ tag });
      expect(homeSvelte(r)).toMatch(new RegExp(`<${tag} class=[^>]*>\\{"Our work"\\}</${tag}>`));
      expect(errors(r)).toEqual([]);
    }
  });

  it('refuses tags text cannot take, and rich text keeps its structure', () => {
    const { s, o } = pageWithStack();
    for (const bad of ['h7', 'section', 'video', '', 3, ['span'], null])
      expect(() => apply(s, [setTag(o, 'n_title01', bad)]), JSON.stringify(bad)).toThrow(/Text’s tag must be one of/);
    const rich = apply(s, [{ type: 'node.insert', newNodeId: 'n_rich01', owner: o, parentId: 'n_stack01', primitive: 'richtext' }]);
    expect(() => apply(rich, [setTag(o, 'n_rich01', 'p')])).toThrow(/paragraph structure/);
  });
});

describe('element tags (#189)', () => {
  it('changes a container’s tag on a page, and the page renders it', () => {
    const { s, o } = pageWithStack();
    for (const tag of ['section', 'article', 'aside', 'nav', 'header', 'footer', 'figure', 'blockquote', 'address', 'details', 'div'] as const) {
      const r = apply(s, [setTag(o, 'n_stack01', tag)]);
      expect(home(r).nodes.n_stack01).toMatchObject({ tag });
      expect(homeSvelte(r)).toMatch(new RegExp(`<${tag} class=[^>]*>\\s*<h2 class=[^>]*>\\{"Our work"\\}</h2>`));
      expect(errors(r)).toEqual([]);
    }
  });

  it('refuses tags a container cannot take, and leaves the project as it was', () => {
    const { s, o } = pageWithStack();
    const before = structuredClone(s);
    for (const bad of ['h2', 'video', 'script', '', null, ['section']])
      expect(() => apply(s, [setTag(o, 'n_stack01', bad)]), JSON.stringify(bad)).toThrow(/A container’s tag must be one of/);
    expect(() => apply(s, [setTag(o, 'n_title01', 'h3'), setTag(o, 'n_stack01', 'main')])).toThrow(/Operation 1 \(node\.setContent\).*every page already has one/);
    expect(s).toEqual(before);
  });

  it('changes tags in a component’s design, for every placement', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.tags',
      name: 'Tag test',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'div', {}, [b.el('box', 'div', {}, [b.text('title', 'h2', 'Tag test'), b.text('by', 'p', 'Ada')])])
    });
    const r = apply(s, [setTag(defOwner(def), 'box', 'article'), setTag(defOwner(def), 'title', 'h6'), setTag(defOwner(def), 'by', 'cite'), setTag(defOwner(def), 'root', 'section')]);
    const tree = r.components[def.id].tree!;
    expect(tree.nodes).toMatchObject({ root: { tag: 'section' }, box: { tag: 'article' }, title: { tag: 'h6' }, by: { tag: 'cite' } });
    expect(componentSvelte(r, def)).toMatch(/<section class=[^>]*>\s*<article class=[^>]*>\s*<h6 class=[^>]*>\{"Tag test"\}<\/h6>\s*<cite class=[^>]*>\{"Ada"\}<\/cite>\s*<\/article>\s*<\/section>/);
    expect(errors(r)).toEqual([]);
    expect((home(r).nodes[home(r).rootIds.at(-1)!] as InstanceNode).definitionId).toBe(def.id);
  });
});

describe('lists (#189)', () => {
  it('builds a list one edit at a time, and takes it apart again the same way', () => {
    const { s, o } = pageWithRows();
    // An item needs its list first.
    expect(() => apply(s, [setTag(o, 'n_row0001', 'li')])).toThrow(/is a list item, so it goes directly inside a list/);
    const list = apply(s, [setTag(o, 'n_stack01', 'ul')]);
    // Rows directly in a list are allowed while it is built, and named in Project health.
    expect(nesting(list).map((d) => [d.severity, d.nodeId])).toEqual([
      ['warning', 'n_row0001'],
      ['warning', 'n_row0002']
    ]);
    const done = apply(list, [setTag(o, 'n_row0001', 'li'), setTag(o, 'n_row0002', 'li')]);
    expect(nesting(done)).toEqual([]);
    expect(homeSvelte(done)).toMatch(/<ul class=[^>]*>\s*<li class=[^>]*>\s*<p class=[^>]*>\{"Price"\}<\/p>\s*<\/li>\s*<li class=[^>]*>\s*<p class=[^>]*>\{"\$10"\}<\/p>\s*<\/li>\s*<\/ul>/);
    // An ordered list keeps its items.
    expect(home(apply(done, [setTag(o, 'n_stack01', 'ol')])).nodes.n_stack01).toMatchObject({ tag: 'ol' });
    // The list can't stop being one while it has items, nor an item hold an item directly.
    expect(() => apply(done, [setTag(o, 'n_stack01', 'div')])).toThrow(/is a list item/);
    expect(() => apply(done, [setTag(o, 'n_stack01', 'li')])).toThrow(/is a list item/);
    // Items first, then the list.
    const undone = apply(done, [setTag(o, 'n_row0001', 'div'), setTag(o, 'n_row0002', 'div'), setTag(o, 'n_stack01', 'div')]);
    expect(home(undone).nodes.n_stack01).toMatchObject({ tag: 'div' });
    expect(nesting(undone)).toEqual([]);
  });

  it('refuses a list around content that can’t be a list item', () => {
    const { s, o } = pageWithStack();
    expect(() => apply(s, [setTag(o, 'n_stack01', 'ul')])).toThrow(/A heading can’t go directly inside a list/);
    expect(tagProblem(s, o, 'n_stack01', 'ol')).toMatch(/can’t go directly inside a list/);
  });

  it('turns a list into a description list in one batch, which no single edit could', () => {
    const { s, o } = pageWithRows();
    const list = apply(s, [setTag(o, 'n_stack01', 'ul'), setTag(o, 'n_row0001', 'li'), setTag(o, 'n_row0002', 'li')]);
    // Either way round alone, one of them is out of place.
    expect(() => apply(list, [setTag(o, 'n_stack01', 'dl')])).toThrow(/is a list item/);
    expect(() => apply(list, [setTag(o, 'n_row0001', 'dt')])).toThrow(/is a term or description/);
    const terms = apply(list, [setTag(o, 'n_stack01', 'dl'), setTag(o, 'n_row0001', 'dt'), setTag(o, 'n_row0002', 'dd')]);
    expect(nesting(terms)).toEqual([]);
    expect(homeSvelte(terms)).toMatch(/<dl class=[^>]*>\s*<dt class=[^>]*>\s*<p[^>]*>\{"Price"\}<\/p>\s*<\/dt>\s*<dd class=[^>]*>/);
  });

  it('takes terms as text directly in a description list, or grouped in a container', () => {
    const { s, o } = pageWithRows();
    const dl = apply(s, [setTag(o, 'n_stack01', 'dl')]);
    // A container directly in a description list groups a term and its description; the paragraphs in each group
    // are only waiting to become one.
    expect(nesting(dl).map((d) => [d.severity, d.nodeId])).toEqual([
      ['warning', 'n_text0001'],
      ['warning', 'n_text0002']
    ]);
    const grouped = apply(dl, [setTag(o, 'n_text0001', 'dt'), setTag(o, 'n_text0002', 'dd')]);
    expect(nesting(grouped)).toEqual([]);
    // Inside a group, a paragraph is only waiting to become a term or description.
    expect(nesting(apply(grouped, [setTag(o, 'n_text0001', 'p')])).map((d) => d.severity)).toEqual(['warning']);
    expect(() => apply(grouped, [setTag(o, 'n_text0001', 'h3')])).toThrow(/can’t go directly inside a description list/);
    // A term needs the list around it, or around its group.
    expect(() => apply(s, [setTag(o, 'n_text0001', 'dt')])).toThrow(/is a term or description, so it goes inside a description list/);
  });
});

describe('figures, disclosures and landmarks (#189)', () => {
  it('needs a figure around a caption, and details around a summary', () => {
    const { s, o } = pageWithRows();
    expect(() => apply(s, [setTag(o, 'n_text0001', 'figcaption')])).toThrow(/is a caption, so it goes directly inside a figure/);
    const figure = apply(s, [setTag(o, 'n_row0001', 'figure'), setTag(o, 'n_text0001', 'figcaption')]);
    expect(homeSvelte(figure)).toMatch(/<figure class=[^>]*>\s*<figcaption class=[^>]*>\{"Price"\}<\/figcaption>\s*<\/figure>/);
    expect(() => apply(figure, [setTag(o, 'n_row0001', 'section')])).toThrow(/is a caption/);

    expect(() => apply(s, [setTag(o, 'n_row0002', 'summary')])).toThrow(/is a summary, so it goes directly inside a details element/);
    const details = apply(s, [setTag(o, 'n_stack01', 'details'), setTag(o, 'n_row0002', 'summary')]);
    expect(homeSvelte(details)).toMatch(/<details class=[^>]*>[\s\S]*<summary class=[^>]*>/);
    expect(errors(details)).toEqual([]);
  });

  it('keeps a page’s one main area, and a header out of another header', () => {
    const { s, o } = pageWithRows();
    expect(() => apply(s, [setTag(o, 'n_stack01', 'main')])).toThrow(/every page already has one/);
    const header = apply(s, [setTag(o, 'n_stack01', 'header')]);
    expect(() => apply(header, [setTag(o, 'n_row0001', 'footer')])).toThrow(/can’t be a header or footer inside another header or footer/);
    expect(home(apply(header, [setTag(o, 'n_row0001', 'nav')])).nodes.n_row0001).toMatchObject({ tag: 'nav' });
  });
});

describe('paragraph and span containers (#189)', () => {
  it('holds only inline content, so the browser never splits it', () => {
    const { s, o } = pageWithStack();
    // A heading would close the paragraph.
    expect(() => apply(s, [setTag(o, 'n_stack01', 'p')])).toThrow(/A heading can’t go inside a paragraph or span container/);
    const inline = apply(s, [setTag(o, 'n_title01', 'strong'), setTag(o, 'n_body01', 'span'), setTag(o, 'n_stack01', 'p')]);
    expect(homeSvelte(inline)).toMatch(/<p class=[^>]*>\s*<strong class=[^>]*>\{"Our work"\}<\/strong>\s*<span class=[^>]*>\{"Some words\."\}<\/span>\s*<\/p>/);
    expect(errors(inline)).toEqual([]);
    // Text inside it can't become a block either.
    expect(() => apply(inline, [setTag(o, 'n_body01', 'div')])).toThrow(/can’t go inside a paragraph or span container/);
    // A heading or image inserted into it is a new problem, which the session refuses.
    const withImage = apply(inline, [{ type: 'node.insert', newNodeId: 'n_image01', owner: o, parentId: 'n_stack01', primitive: 'image' }]);
    expect(introduced(inline, withImage).map((d) => d.code)).toEqual(['TAG_NESTING']);
    const moved = apply(inline, [{ type: 'node.insert', newNodeId: 'n_head02', owner: o, parentId: null, primitive: 'heading' }]);
    expect(introduced(moved, apply(moved, [{ type: 'node.move', owner: o, nodeId: 'n_head02', parentId: 'n_stack01', index: 0 }])).map((d) => d.message)).toEqual([
      expect.stringMatching(/A heading can’t go inside a paragraph or span container/)
    ]);
  });

  it('refuses a slot inside a paragraph container, whose content can’t be known', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.inline-slot',
      name: 'Inline slot',
      properties: {},
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) => b.el('root', 'div', {}, [b.el('line', 'span', {}, [b.text('lead', 'span', 'Note:')]), b.el('wrap', 'div', {}, [b.slot('extra-slot', 'extra')])])
    });
    expect(() => apply(s, [setTag(defOwner(def), 'wrap', 'span')])).toThrow(/A slot can’t go inside a paragraph or span container/);
    expect(() => apply(s, [setTag(defOwner(def), 'root', 'p')])).toThrow(/can’t go inside a paragraph or span container/);
  });
});

describe('across documents (#189)', () => {
  /** A list component whose items hold a slot, placed on Home with a stack in that slot. */
  function listWithSlot() {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.list-slot',
      name: 'List slot',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('root', 'ul', {}, [b.el('item', 'li', {}, [b.slot('body-slot', 'body')])])
    });
    const o = pageOwner(s);
    const inst = home(s).rootIds.at(-1)!;
    const state = apply(s, [{ type: 'node.insert', newNodeId: 'n_inner01', owner: o, parentId: inst, slot: 'body', primitive: 'stack' }]);
    return { s: state, def, o };
  }

  it('reads slot content where the component renders it', () => {
    const { s, def, o } = listWithSlot();
    expect(errors(s)).toEqual([]);
    // In the design's list item, a list item would be cut out of it by the browser.
    expect(() => apply(s, [setTag(o, 'n_inner01', 'li')])).toThrow(/is a list item/);
    expect(home(apply(s, [setTag(o, 'n_inner01', 'section')])).nodes.n_inner01).toMatchObject({ tag: 'section' });
    // The design's item can stop being one only while nothing placed in it needs it.
    expect(home(apply(s, [setTag(defOwner(def), 'item', 'div')])).nodes.n_inner01).toMatchObject({ tag: 'div' });
  });

  it('refuses a design change that leaves a placement’s slot content out of place', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.list-outlet',
      name: 'List outlet',
      properties: {},
      parts: {},
      slots: { items: { label: 'Items' } },
      build: (b) => b.el('root', 'ul', {}, [b.slot('items-slot', 'items')])
    });
    const o = pageOwner(s);
    const inst = home(s).rootIds.at(-1)!;
    const placed = apply(s, [
      { type: 'node.insert', newNodeId: 'n_item0001', owner: o, parentId: inst, slot: 'items', primitive: 'stack' },
      setTag(o, 'n_item0001', 'li')
    ]);
    expect(errors(placed)).toEqual([]);
    // Home's item would be left outside any list.
    expect(() => apply(placed, [setTag(defOwner(def), 'root', 'div')])).toThrow(/Home: A container is a list item/);
    expect(tagProblem(placed, defOwner(def), 'root', 'section')).toMatch(/Home: A container is a list item/);
    expect(tagProblem(placed, defOwner(def), 'root', 'ol')).toBeNull();
  });

  it('checks a design’s root where each placement puts it', () => {
    const s = blank();
    const def = addDef(s, { componentId: 'test.root', name: 'Root', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.text('t', 'p', 'Hi')]) });
    // Its own design can't know where it goes, but Home places it among the page's sections.
    expect(nestingProblems(s, defOwner(def), s.components[def.id].tree!, { owner: defOwner(def), nodeId: 'root', tag: 'li' })).toEqual([]);
    expect(() => apply(s, [setTag(defOwner(def), 'root', 'li')])).toThrow(/Home: .*is a list item/);
    expect(tagProblem(s, defOwner(def), 'root', 'li')).toMatch(/Home: .*is a list item/);
    // Unplaced, it may be anything a list could hold.
    const unplaced = blank();
    const free = addDef(unplaced, { componentId: 'test.free', name: 'Free', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.text('t', 'p', 'Hi')]) }, false);
    expect(home(unplaced).rootIds.some((r) => (home(unplaced).nodes[r] as InstanceNode).definitionId === free.id)).toBe(false);
    expect(apply(unplaced, [setTag(defOwner(free), 'root', 'li')]).components[free.id].tree!.nodes.root).toMatchObject({ tag: 'li' });
  });

  it('judges a bound tag by every option it can render', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.bound',
      name: 'Bound',
      properties: { wrap: P.choice('Wrap', 'div', [['div', 'Div'], ['p', 'Paragraph']]) },
      parts: {},
      build: (b) => b.el('root', 'div', {}, [b.el('box', prop('wrap'), {}, [b.text('t', 'h2', 'Title')])])
    });
    expect(nesting(s).map((d) => d.message)).toEqual([expect.stringMatching(/Bound: A heading can’t go inside a paragraph or span container/)]);
    // Its default is still a choice among its options.
    expect(apply(s, [setTag(defOwner(def), 'box', 'p')]).components[def.id].properties.wrap.default).toBe('p');
  });
});

describe('the Inspector’s choices (#189)', () => {
  it('offers every tag of the kind, and says why one can’t go here', () => {
    const { s, o } = pageWithRows();
    const row = tagOptions(s, o, 'n_row0001');
    expect(row.map((x) => x.tag)).toEqual([...ELEMENT_TAGS]);
    expect(row.find((x) => x.tag === 'section')?.problem).toBeNull();
    expect(row.find((x) => x.tag === 'li')?.problem).toMatch(/is a list item/);
    expect(row.find((x) => x.tag === 'main')?.problem).toMatch(/every page already has one/);
    const text = tagOptions(s, o, 'n_text0001');
    expect(text.map((x) => x.tag)).toEqual([...TEXT_TAGS]);
    expect(text.filter((x) => x.problem).map((x) => x.tag)).toEqual(['dt', 'dd', 'figcaption']);
  });
});

describe('the tag select (#189)', () => {
  it('names every tag once, so a stored tag always has its option', () => {
    expect(TEXT_TAG_GROUPS.flatMap((g) => g.tags.map(([t]) => t)).sort()).toEqual([...TEXT_TAGS].sort());
    expect(ELEMENT_TAG_GROUPS.flatMap((g) => g.tags.map(([t]) => t)).sort()).toEqual([...ELEMENT_TAGS].sort());
    for (const tag of TEXT_TAGS) expect(tagSelectOptions('text', tag, new Map()), tag).toMatchObject({ value: tag, unknown: null });
    for (const tag of ELEMENT_TAGS) expect(tagSelectOptions('element', tag, new Map()), tag).toMatchObject({ value: tag, unknown: null });
  });

  it('shows a tag this version doesn’t offer as the one the node has, and marks tags that don’t fit', () => {
    expect(tagSelectOptions('text', 'marquee', new Map())).toMatchObject({ value: 'marquee', unknown: 'marquee' });
    const { groups } = tagSelectOptions('element', 'div', new Map([['li', 'A container is a list item, so it goes directly inside a list (ul or ol).']]));
    const options = groups.flatMap((g) => g.options);
    expect(options.find((o) => o.tag === 'li')).toEqual({ tag: 'li', name: 'List item', problem: expect.stringMatching(/list item/) });
    expect(options.find((o) => o.tag === 'section')?.problem).toBeNull();
  });
});

describe('shipped content (#189)', () => {
  it('has no nesting problems in any starter or theme design', () => {
    for (const { id } of STARTERS) {
      const s = createStarterState(id, 'Test', false);
      expect(nesting(s), id).toEqual([]);
      for (const theme of listThemes())
        for (const def of theme.components) {
          if (def.kind !== 'managed' || !def.tree) continue;
          const st = { ...s, components: { ...s.components, [def.id]: def } };
          expect(nestingProblems(st, defOwner(def), def.tree), `${theme.id} ${def.id}`).toEqual([]);
        }
    }
  });
});
