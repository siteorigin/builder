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
import { FOUNDATION_AUTHOR } from './fixtures/packs';
import { prop, P, type ComponentSpec } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { nestingProblems, tagOptions, tagProblem } from '@engine/semantic-tags';
import { defFile, generateProject } from '@generator/index';
import { ELEMENT_TAG_GROUPS, TEXT_TAG_GROUPS, standingReason, tagSelectOptions, unavailableReasons } from '../../src/renderer/src/lib/tag-options';

const managed = (spec: ComponentSpec) => FOUNDATION_AUTHOR.managed(spec);
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
    for (const tag of TEXT_TAGS.filter((t) => !['h2', 'dt', 'dd', 'figcaption'].includes(t))) {
      const r = apply(s, [setTag(o, 'n_title01', tag)]);
      expect(home(r).nodes.n_title01).toMatchObject({ tag });
      expect(homeSvelte(r)).toMatch(new RegExp(`<${tag} class=[^>]*>\\{"Our work"\\}</${tag}>`));
      expect(errors(r)).toEqual([]);
      // And back to a heading.
      expect(homeSvelte(apply(r, [setTag(o, 'n_title01', 'h2')]))).toMatch(/<h2 class=[^>]*>\{"Our work"\}<\/h2>/);
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
    for (const tag of ['section', 'article', 'aside', 'nav', 'header', 'footer', 'figure', 'blockquote', 'address', 'details'] as const) {
      const r = apply(s, [setTag(o, 'n_stack01', tag)]);
      expect(home(r).nodes.n_stack01).toMatchObject({ tag });
      expect(homeSvelte(r)).toMatch(new RegExp(`<${tag} class=[^>]*>\\s*<h2 class=[^>]*>\\{"Our work"\\}</h2>\\s*<p class=[^>]*>\\{"Some words\\."\\}</p>\\s*</${tag}>`));
      expect(errors(r)).toEqual([]);
      // And back to a plain container.
      const back = apply(r, [setTag(o, 'n_stack01', 'div')]);
      expect(home(back).nodes.n_stack01).toMatchObject({ tag: 'div' });
      expect(homeSvelte(back)).toMatch(/<div class=[^>]*>\s*<h2 class=/);
    }
  });

  it('refuses tags a container cannot take, and leaves the project as it was', () => {
    const { s, o } = pageWithStack();
    const before = structuredClone(s);
    for (const bad of ['h2', 'video', 'script', '', null, ['section']])
      expect(() => apply(s, [setTag(o, 'n_stack01', bad)]), JSON.stringify(bad)).toThrow(/A container’s tag must be one of/);
    expect(() => apply(s, [setTag(o, 'n_title01', 'h3'), setTag(o, 'n_stack01', 'main')])).toThrow(/^Operation 2 \(node\.setContent\): A container can’t be a main area/);
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
    // A paragraph alone too.
    const para = apply(s, [{ type: 'node.remove', owner: o, nodeId: 'n_title01' }]);
    expect(() => apply(para, [setTag(o, 'n_stack01', 'ul')])).toThrow(/A paragraph can’t go directly inside a list/);
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
    // A stack holding a group (a row with two paragraphs) and a paragraph of its own.
    const s0 = blank();
    const o = pageOwner(s0);
    const s = apply(s0, [
      { type: 'node.insert', newNodeId: 'n_stack01', owner: o, parentId: null, primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_group01', owner: o, parentId: 'n_stack01', primitive: 'row' },
      { type: 'node.insert', newNodeId: 'n_term001', owner: o, parentId: 'n_group01', primitive: 'paragraph', text: 'Price' },
      { type: 'node.insert', newNodeId: 'n_desc001', owner: o, parentId: 'n_group01', primitive: 'paragraph', text: '$10' },
      { type: 'node.insert', newNodeId: 'n_term002', owner: o, parentId: 'n_stack01', primitive: 'paragraph', text: 'Size' }
    ]);
    // A term needs the list around it, or around its group.
    expect(() => apply(s, [setTag(o, 'n_term001', 'dt')])).toThrow(/is a term or description, so it goes inside a description list/);
    const dl = apply(s, [setTag(o, 'n_stack01', 'dl')]);
    // The paragraphs are only waiting to become terms and descriptions.
    expect(nesting(dl).map((d) => [d.severity, d.nodeId])).toEqual([
      ['warning', 'n_term001'],
      ['warning', 'n_desc001'],
      ['warning', 'n_term002']
    ]);
    const done = apply(dl, [setTag(o, 'n_term001', 'dt'), setTag(o, 'n_desc001', 'dd'), setTag(o, 'n_term002', 'dt')]);
    expect(nesting(done)).toEqual([]);
    expect(homeSvelte(done)).toMatch(/<dl class=[^>]*>\s*<div class=[^>]*>\s*<dt class=[^>]*>\{"Price"\}<\/dt>\s*<dd class=[^>]*>\{"\$10"\}<\/dd>\s*<\/div>\s*<dt class=[^>]*>\{"Size"\}<\/dt>\s*<\/dl>/);
    // A heading directly in the list is refused; in a group it is only unfinished.
    expect(() => apply(done, [setTag(o, 'n_term002', 'h3')])).toThrow(/A heading can’t go directly inside a description list/);
    expect(nesting(apply(done, [setTag(o, 'n_term001', 'h3')])).map((d) => [d.severity, d.nodeId])).toEqual([['warning', 'n_term001']]);
  });

  it('keeps a link off a group or figure, which the link would replace', () => {
    const { s, o } = pageWithRows();
    const link = { type: 'url', target: 'https://example.com' };
    const terms = apply(s, [setTag(o, 'n_stack01', 'dl'), setTag(o, 'n_text0001', 'dt')]);
    const linkedGroup = apply(terms, [{ type: 'node.setContent', owner: o, nodeId: 'n_row0001', field: 'link', value: link }]);
    expect(introduced(terms, linkedGroup).map((d) => [d.nodeId, d.message])).toEqual([
      ['n_row0001', expect.stringMatching(/A container is one link.*can’t go directly inside a list or description list/)],
      ['n_text0001', expect.stringMatching(/is a term or description/)]
    ]);
    const figure = apply(s, [setTag(o, 'n_row0001', 'figure'), setTag(o, 'n_text0001', 'figcaption')]);
    const linkedFigure = apply(figure, [{ type: 'node.setContent', owner: o, nodeId: 'n_row0001', field: 'link', value: link }]);
    expect(introduced(figure, linkedFigure).map((d) => [d.nodeId, d.message])).toEqual([['n_text0001', expect.stringMatching(/is a caption/)]]);
  });

  it('builds a description list around an image, one edit at a time', () => {
    const s0 = blank();
    const o = pageOwner(s0);
    const s = apply(s0, [
      { type: 'node.insert', newNodeId: 'n_stack01', owner: o, parentId: null, primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_row0001', owner: o, parentId: 'n_stack01', primitive: 'row' },
      { type: 'node.insert', newNodeId: 'n_image01', owner: o, parentId: 'n_row0001', primitive: 'image' }
    ]);
    const dl = apply(s, [setTag(o, 'n_stack01', 'dl')]);
    expect(nesting(dl).map((d) => [d.severity, d.nodeId])).toEqual([['warning', 'n_image01']]);
    expect(nesting(apply(dl, [setTag(o, 'n_row0001', 'dd')]))).toEqual([]);
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
    expect(homeSvelte(details)).toMatch(/<details class=[^>]*>(?:(?!<\/details>)[\s\S])*<summary class=[^>]*>\s*<p class=[^>]*>\{"\$10"\}<\/p>\s*<\/summary>\s*<\/details>/);
    expect(errors(details)).toEqual([]);
  });

  it('keeps disclosures out of a linked card, which holds nothing interactive', () => {
    const { s, o } = pageWithRows();
    const card = apply(s, [{ type: 'node.setContent', owner: o, nodeId: 'n_stack01', field: 'link', value: { type: 'url', target: 'https://example.com' } }]);
    expect(tagOptions(card, o, 'n_row0001').find((x) => x.tag === 'details')?.problem).toMatch(/can’t go inside a linked card/);
    expect(tagOptions(s, o, 'n_row0001').find((x) => x.tag === 'details')?.problem).toBeNull();
    // Inside a design placed in a linked card on a page.
    const nested = addDef(card, { componentId: 'test.in-card', name: 'In card', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.el('box', 'div', {}, [])]) }, false);
    const placed = apply(card, [{ type: 'node.insert', newNodeId: 'n_nested1', owner: o, parentId: 'n_row0001', definitionId: nested.id }]);
    expect(tagOptions(placed, defOwner(nested), 'box').find((x) => x.tag === 'details')?.problem).toMatch(/can’t go inside a linked card/);
  });

  it('keeps a linked card from being a list item, which the link would replace', () => {
    const { s, o } = pageWithRows();
    const list = apply(s, [setTag(o, 'n_stack01', 'ul'), setTag(o, 'n_row0001', 'li'), setTag(o, 'n_row0002', 'li')]);
    const link = { type: 'url', target: 'https://example.com' };
    // Linking the item renders <ul><a>: refused when it is brought in.
    const linked = apply(list, [{ type: 'node.setContent', owner: o, nodeId: 'n_row0001', field: 'link', value: link }]);
    expect(introduced(list, linked).map((d) => [d.code, d.nodeId])).toEqual([['TAG_NESTING', 'n_row0001']]);
    // And a linked container can't become a list item, or a list around items.
    const card = apply(s, [{ type: 'node.setContent', owner: o, nodeId: 'n_row0001', field: 'link', value: link }]);
    expect(() => apply(card, [setTag(o, 'n_stack01', 'ul'), setTag(o, 'n_row0001', 'li')])).toThrow(/^Operation 2 \(node\.setContent\): A container is one link/);
    expect(tagProblem(card, o, 'n_row0001', 'ul')).toMatch(/is one link/);
    expect(tagProblem(card, o, 'n_row0001', 'section')).toBeNull();
  });

  it('keeps a page’s one main area, and a header out of another header', () => {
    const { s, o } = pageWithRows();
    expect(() => apply(s, [setTag(o, 'n_stack01', 'main')])).toThrow(/every page already has one/);
    const header = apply(s, [setTag(o, 'n_stack01', 'header')]);
    expect(() => apply(header, [setTag(o, 'n_row0001', 'footer')])).toThrow(/can’t be a header or footer inside another header or footer/);
    expect(home(apply(header, [setTag(o, 'n_row0001', 'nav')])).nodes.n_row0001).toMatchObject({ tag: 'nav' });
    // However deep inside it.
    const deep = apply(s, [
      { type: 'node.insert', newNodeId: 'n_mid0001', owner: o, parentId: 'n_row0001', primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_inner01', owner: o, parentId: 'n_mid0001', primitive: 'stack' },
      setTag(o, 'n_stack01', 'footer')
    ]);
    expect(() => apply(deep, [setTag(o, 'n_inner01', 'header')])).toThrow(/can’t be a header or footer inside another/);
  });
});

describe('paragraph and span containers (#189)', () => {
  it('holds only inline content, so the browser never splits it', () => {
    const { s, o } = pageWithStack();
    // A heading would close the paragraph.
    expect(() => apply(s, [setTag(o, 'n_stack01', 'p')])).toThrow(/A heading can’t go inside a paragraph container/);
    expect(() => apply(s, [setTag(o, 'n_stack01', 'span')])).toThrow(/A heading can’t go inside a span container/);
    const inline = apply(s, [setTag(o, 'n_title01', 'strong'), setTag(o, 'n_body01', 'span'), setTag(o, 'n_stack01', 'p')]);
    expect(homeSvelte(inline)).toMatch(/<p class=[^>]*>\s*<strong class=[^>]*>\{"Our work"\}<\/strong>\s*<span class=[^>]*>\{"Some words\."\}<\/span>\s*<\/p>/);
    expect(errors(inline)).toEqual([]);
    // Text inside it can't become a block either.
    expect(() => apply(inline, [setTag(o, 'n_body01', 'div')])).toThrow(/A paragraph can’t go inside a paragraph container|Text can’t go inside a paragraph container/);
    // An image (whose placeholder is a block) or a heading moved into it is a new problem, which the session refuses.
    const withImage = apply(inline, [{ type: 'node.insert', newNodeId: 'n_image01', owner: o, parentId: 'n_stack01', primitive: 'image' }]);
    expect(introduced(inline, withImage).map((d) => [d.code, d.nodeId])).toEqual([['TAG_NESTING', 'n_image01']]);
    const moved = apply(inline, [{ type: 'node.insert', newNodeId: 'n_head02', owner: o, parentId: null, primitive: 'heading' }]);
    expect(introduced(moved, apply(moved, [{ type: 'node.move', owner: o, nodeId: 'n_head02', parentId: 'n_stack01', index: 0 }])).map((d) => d.message)).toEqual([
      expect.stringMatching(/A heading can’t go inside a paragraph container/)
    ]);
    // Text inserted into it from Insert is inline text.
    const added = apply(inline, [
      { type: 'node.insert', newNodeId: 'n_head03', owner: o, parentId: 'n_stack01', primitive: 'heading', text: 'More' },
      { type: 'node.insert', newNodeId: 'n_para03', owner: o, parentId: 'n_stack01', primitive: 'paragraph', text: 'Words' }
    ]);
    expect(home(added).nodes.n_head03).toMatchObject({ tag: 'span' });
    expect(home(added).nodes.n_para03).toMatchObject({ tag: 'span' });
    expect(introduced(inline, added)).toEqual([]);
  });

  it('refuses a paragraph around a block an older span already held, which only the paragraph breaks', () => {
    const { s, o } = pageWithStack();
    // Written by hand: a span holding a heading, which browsers leave alone.
    (home(s).nodes.n_stack01 as { tag: string }).tag = 'span';
    expect(nesting(s).map((d) => [d.severity, d.site])).toEqual([
      ['error', 'n_title01|in-span'],
      ['error', 'n_body01|in-span']
    ]);
    expect(() => apply(s, [setTag(o, 'n_stack01', 'p')])).toThrow(/A heading can’t go inside a paragraph container/);
    // A paragraph around that span can be taken away, leaving the span's older problem as it was.
    const wrapped = apply(s, [{ type: 'node.insert', newNodeId: 'n_outer01', owner: o, parentId: null, primitive: 'stack', index: 0 }]);
    const ws = home(wrapped);
    ws.rootIds = ws.rootIds.filter((r) => r !== 'n_stack01');
    (ws.nodes.n_outer01 as { children: string[]; tag: string }).children.push('n_stack01');
    (ws.nodes.n_outer01 as { tag: string }).tag = 'p';
    expect(home(apply(wrapped, [setTag(o, 'n_outer01', 'div')])).nodes.n_outer01).toMatchObject({ tag: 'div' });
    // And an older main area inside a paragraph can still be repaired one edit at a time.
    const legacy = blank();
    const lo = pageOwner(legacy);
    const t = apply(legacy, [
      { type: 'node.insert', newNodeId: 'n_stack01', owner: lo, parentId: null, primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_inner01', owner: lo, parentId: 'n_stack01', primitive: 'stack' }
    ]);
    Object.assign(home(t).nodes.n_stack01, { tag: 'p' });
    Object.assign(home(t).nodes.n_inner01, { tag: 'main' });
    expect(home(apply(t, [setTag(lo, 'n_stack01', 'div')])).nodes.n_stack01).toMatchObject({ tag: 'div' });
  });

  it('refuses a slot inside a paragraph container, whose content can’t be known', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.inline-slot',
      name: 'Inline slot',
      properties: {},
      parts: {},
      slots: { extra: { label: 'Extra' }, more: { label: 'More' } },
      build: (b) => b.el('root', 'div', {}, [b.el('line', 'div', {}, [b.slot('more-slot', 'more')]), b.el('wrap', 'div', {}, [b.el('inner', 'span', {}, [b.slot('extra-slot', 'extra')])])])
    });
    expect(() => apply(s, [setTag(defOwner(def), 'line', 'p')])).toThrow(/A slot can’t go inside a paragraph container/);
    // However deep inside it.
    expect(() => apply(s, [setTag(defOwner(def), 'wrap', 'p')])).toThrow(/A slot can’t go inside a paragraph container/);
  });

  it('takes a component whose design is inline, even through another component', () => {
    const s = blank();
    const label = addDef(s, { componentId: 'test.label', name: 'Label', properties: {}, parts: {}, build: (b) => b.el('root', 'span', {}, [b.text('t', 'strong', 'New')]) }, false);
    const wrapped = addDef(s, { componentId: 'test.wrapped', name: 'Wrapped', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, []) }, false);
    // A design whose root is the inline component placed again.
    const inner = makeInstance(label, {});
    wrapped.tree = { rootIds: [inner.id], nodes: { [inner.id]: inner } };
    const { s: page, o } = pageWithStack();
    page.components[label.id] = label;
    page.components[wrapped.id] = wrapped;
    const placed = apply(page, [setTag(o, 'n_title01', 'span'), setTag(o, 'n_body01', 'span'), { type: 'node.insert', newNodeId: 'n_badge01', owner: o, parentId: 'n_stack01', definitionId: wrapped.id }]);
    expect(home(apply(placed, [setTag(o, 'n_stack01', 'p')])).nodes.n_stack01).toMatchObject({ tag: 'p' });
  });

  it('refuses a component whose design holds a block inside its inline root', () => {
    const { s, o } = pageWithStack();
    const badge = addDef(s, { componentId: 'test.badge', name: 'Badge', properties: {}, parts: {}, build: (b) => b.el('root', 'span', {}, [b.text('t', 'h2', 'New')]) }, false);
    const placed = apply(s, [setTag(o, 'n_title01', 'span'), setTag(o, 'n_body01', 'span'), { type: 'node.insert', newNodeId: 'n_badge01', owner: o, parentId: 'n_stack01', definitionId: badge.id }]);
    expect(() => apply(placed, [setTag(o, 'n_stack01', 'p')])).toThrow(/A component can’t go inside a paragraph container/);
  });

  it('inserts inline text wherever it renders in a paragraph: through a repeat, a bound choice or a slot', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.inline-insert',
      name: 'Inline insert',
      properties: { wrap: P.choice('Wrap', 'span', [['span', 'Inline'], ['p', 'Paragraph']]), items: { type: 'list', label: 'Items', itemLabel: 'Item', fields: {}, default: [] } as never },
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) => b.el('root', 'div', {}, [b.el('box', prop('wrap'), {}, []), b.el('line', 'p', {}, [b.repeat('each', 'items', [])]), b.el('plain', 'div', {}, [b.slot('extra-slot', 'extra')])])
    });
    const d = defOwner(def);
    const r = apply(s, [
      { type: 'node.insert', newNodeId: 'n_head01', owner: d, parentId: 'box', primitive: 'heading' },
      { type: 'node.insert', newNodeId: 'n_head02', owner: d, parentId: 'each', primitive: 'paragraph' },
      { type: 'node.insert', newNodeId: 'n_head03', owner: d, parentId: 'plain', primitive: 'heading' }
    ]);
    const nodes = r.components[def.id].tree!.nodes;
    expect([nodes.n_head01, nodes.n_head02, nodes.n_head03].map((n) => (n as { tag: string }).tag)).toEqual(['span', 'span', 'h2']);
    // And into a slot the design renders inside a span.
    const outlet = blank();
    const label = addDef(outlet, { componentId: 'test.outlet-span', name: 'Outlet span', properties: {}, parts: {}, slots: { extra: { label: 'Extra' } }, build: (b) => b.el('root', 'div', {}, [b.el('line', 'span', {}, [b.slot('extra-slot', 'extra')])]) });
    const oo = pageOwner(outlet);
    const inst = home(outlet).rootIds.at(-1)!;
    const filled = apply(outlet, [{ type: 'node.insert', newNodeId: 'n_text0001', owner: oo, parentId: inst, slot: 'extra', primitive: 'paragraph' }]);
    expect(home(filled).nodes.n_text0001).toMatchObject({ tag: 'span' });
    expect(label.tree!.nodes.line).toMatchObject({ tag: 'span' });
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
    const plain = apply(s, [setTag(defOwner(def), 'item', 'div')]);
    expect(plain.components[def.id].tree!.nodes.item).toMatchObject({ tag: 'div' });
    expect(nesting(plain).map((d) => [d.severity, d.owner?.id, d.nodeId])).toEqual([['warning', def.id, 'item']]);
    expect(() => apply(apply(s, [setTag(o, 'n_inner01', 'section')]), [])).not.toThrow();
  });

  it('follows a slot a design forwards into another component, and every place it renders a slot', () => {
    const s = blank();
    const inner = addDef(s, {
      componentId: 'test.inner-list',
      name: 'Inner list',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('root', 'ul', {}, [b.el('item', 'li', {}, [b.slot('body-slot', 'body')])])
    }, false);
    const outer = addDef(s, { componentId: 'test.outer', name: 'Outer', properties: {}, parts: {}, slots: { body: { label: 'Body' } }, build: (b) => b.el('root', 'div', {}, []) });
    // Outer's design places Inner, and renders its own slot inside Inner's.
    const placedInner = makeInstance(inner, {});
    const tree = outer.tree!;
    tree.nodes[placedInner.id] = { ...placedInner, slots: { body: ['outer-slot'] } };
    tree.nodes['outer-slot'] = { id: 'outer-slot', kind: 'slot', slot: 'body' };
    (tree.nodes.root as { children: string[] }).children.push(placedInner.id);
    const o = pageOwner(s);
    const inst = home(s).rootIds.at(-1)!;
    const filled = apply(s, [{ type: 'node.insert', newNodeId: 'n_inner01', owner: o, parentId: inst, slot: 'body', primitive: 'stack' }]);
    expect(errors(filled)).toEqual([]);
    // Home's content renders inside Inner's list item, two designs down.
    expect(() => apply(filled, [setTag(o, 'n_inner01', 'li')])).toThrow(/is a list item/);

    // A design that renders one slot in two places: content must fit both, whichever comes first.
    for (const listFirst of [true, false]) {
      const twice = blank();
      const def = addDef(twice, {
        componentId: 'test.twice',
        name: 'Twice',
        properties: {},
        parts: {},
        slots: { body: { label: 'Body' } },
        build: (b) => {
          const list = b.el('list', 'ul', {}, [b.slot('a-slot', 'body')]);
          const item = b.el('item', 'li', {}, [b.slot('b-slot', 'body')]);
          return b.el('root', 'div', {}, listFirst ? [list, item] : [item, list]);
        }
      });
      const to = pageOwner(twice);
      const tinst = home(twice).rootIds.at(-1)!;
      const both = apply(twice, [{ type: 'node.insert', newNodeId: 'n_inner01', owner: to, parentId: tinst, slot: 'body', primitive: 'stack' }]);
      expect(() => apply(both, [setTag(to, 'n_inner01', 'li')]), String(listFirst)).toThrow(/is a list item/);
      expect(def.tree!.nodes.item).toMatchObject({ tag: 'li' });
    }
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
    expect(tagOptions(placed, defOwner(def), 'root').filter((x) => x.problem).map((x) => x.tag)).toContain('div');
    // The item it strands is in another document: not the root's own placement, so the Inspector keeps the words.
    expect(tagOptions(placed, defOwner(def), 'root').find((x) => x.tag === 'section')?.self).toBe(false);
  });

  it('leaves older problems alone in a document a batch first places an edited design in', () => {
    const s = blank();
    const o = pageOwner(s);
    const def = addDef(s, { componentId: 'test.unused', name: 'Unused', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.text('t', 'p', 'Hi')]) }, false);
    const legacy = apply(s, [{ type: 'node.insert', newNodeId: 'n_item0001', owner: o, parentId: null, primitive: 'stack' }]);
    // Written by hand: a list item among the page's sections.
    (home(legacy).nodes.n_item0001 as { tag: string }).tag = 'li';
    const r = apply(legacy, [{ type: 'node.insert', newNodeId: 'n_place01', owner: o, parentId: null, definitionId: def.id }, setTag(defOwner(def), 'root', 'section')]);
    expect(r.components[def.id].tree!.nodes.root).toMatchObject({ tag: 'section' });
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
      properties: { wrap: P.choice('Wrap', 'div', [['div', 'Div'], ['p', 'Paragraph'], ['section', 'Section']]) },
      parts: {},
      build: (b) => b.el('root', 'div', {}, [b.el('box', prop('wrap'), {}, [b.text('t', 'h2', 'Title')])])
    });
    // The paragraph is neither its default nor its last option.
    expect(nesting(s).map((d) => [d.message, d.nodeId])).toEqual([[expect.stringMatching(/^Bound: A heading can’t go inside a paragraph container/), 't']]);
    // Its default is still a choice among its options, and it stays bound.
    const r = apply(s, [setTag(defOwner(def), 'box', 'section')]);
    expect(r.components[def.id].properties.wrap.default).toBe('section');
    expect(r.components[def.id].tree!.nodes.box).toMatchObject({ tag: { $prop: 'wrap' } });
    // A tag is a name, as it is for a fixed tag.
    expect(() => apply(s, [setTag(defOwner(def), 'box', ['section'])])).toThrow(/A tag is the name of one/);
  });
});

describe('edges the final review found (#189)', () => {
  it('survives a hand-edited inline design that holds itself, inside a paragraph', () => {
    const { s, o } = pageWithStack();
    const loop = addDef(s, { componentId: 'test.loop', name: 'Loop', properties: {}, parts: {}, build: (b) => b.el('root', 'span', {}, []) }, false);
    (loop.tree!.nodes.root as { children: string[] }).children.push('root');
    const placed = apply(s, [setTag(o, 'n_title01', 'span'), setTag(o, 'n_body01', 'span'), { type: 'node.insert', newNodeId: 'n_loop0001', owner: o, parentId: 'n_stack01', definitionId: loop.id }]);
    (home(placed).nodes.n_stack01 as { tag: string }).tag = 'p';
    expect(() => validateState(placed)).not.toThrow();
  });

  it('keeps a term out of a group whose list is decided outside the design', () => {
    const s = blank();
    const def = addDef(s, { componentId: 'test.term-group', name: 'Term group', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.text('t', 'p', 'Price'), b.el('inner', 'dl', {}, [b.el('g', 'div', {}, [b.text('u', 'p', 'Size')])])]) });
    // Placed in a description, a term at the design's edge would close it.
    expect(tagProblem(s, defOwner(def), 't', 'dt')).toMatch(/is a term or description/);
    // A group whose list is in the design is fine.
    expect(tagProblem(s, defOwner(def), 'u', 'dt')).toBeNull();
  });

  it('takes a group at a design’s edge where every placement puts it in a description list', () => {
    const { s, o } = pageWithRows();
    const terms = apply(s, [setTag(o, 'n_stack01', 'dl'), setTag(o, 'n_text0001', 'dt')]);
    // Made into a component where it stands: still in its list.
    const made = apply(terms, [{ type: 'component.createFromNode', owner: o, nodeId: 'n_row0001', name: 'Term group' }]);
    expect(nesting(made)).toEqual([expect.objectContaining({ severity: 'warning', nodeId: 'n_text0002' })]);
    expect(introduced(terms, made)).toEqual([]);
    // And refused where a placement is not in one.
    const def = Object.values(made.components).find((d) => d.name === 'Term group')!;
    const termId = Object.values(def.tree!.nodes).find((n) => n.kind === 'text' && n.tag === 'dt')!.id;
    const loose = apply(made, [{ type: 'node.insert', owner: o, parentId: null, definitionId: def.id }]);
    expect(nesting(loose).find((d) => d.nodeId === termId && d.severity === 'error')?.message).toMatch(/is a term or description/);
  });

  it('lets a paragraph hold an inline component whatever sits in a slot it never renders', () => {
    const { s, o } = pageWithStack();
    const badge = addDef(s, { componentId: 'test.badge-slot', name: 'Badge slot', properties: {}, parts: {}, slots: { unused: { label: 'Unused' } }, build: (b) => b.el('root', 'span', {}, [b.text('t', 'strong', 'New')]) }, false);
    const placed = apply(s, [
      setTag(o, 'n_title01', 'span'),
      setTag(o, 'n_body01', 'span'),
      { type: 'node.insert', newNodeId: 'n_badge01', owner: o, parentId: 'n_stack01', definitionId: badge.id },
      { type: 'node.insert', newNodeId: 'n_hidden1', owner: o, parentId: 'n_badge01', slot: 'unused', primitive: 'heading' }
    ]);
    expect(home(placed).nodes.n_hidden1).toMatchObject({ tag: 'h2' });
    expect(home(apply(placed, [setTag(o, 'n_stack01', 'p')])).nodes.n_stack01).toMatchObject({ tag: 'p' });
  });

  it('reads a card that renders plain (something interactive is inside) as its own tag', () => {
    const { s, o } = pageWithRows();
    const broken = apply(s, [
      setTag(o, 'n_row0001', 'figure'),
      { type: 'node.setContent', owner: o, nodeId: 'n_row0001', field: 'link', value: { type: 'url', target: 'https://example.com' } },
      { type: 'node.insert', newNodeId: 'n_button01', owner: o, parentId: 'n_row0001', primitive: 'button' }
    ]);
    expect(validateState(broken).map((d) => d.code)).toContain('CARD_LINK_INTERACTIVE');
    expect(home(apply(broken, [setTag(o, 'n_text0001', 'figcaption')])).nodes.n_text0001).toMatchObject({ tag: 'figcaption' });
  });

  it('inserts inline text into a component’s first slot when no slot is named', () => {
    const s = blank();
    addDef(s, { componentId: 'test.first-slot', name: 'First slot', properties: {}, parts: {}, slots: { extra: { label: 'Extra' } }, build: (b) => b.el('root', 'div', {}, [b.el('line', 'span', {}, [b.slot('extra-slot', 'extra')])]) });
    const o = pageOwner(s);
    const inst = home(s).rootIds.at(-1)!;
    const r = apply(s, [{ type: 'node.insert', newNodeId: 'n_text0001', owner: o, parentId: inst, primitive: 'heading' }]);
    expect(home(r).nodes.n_text0001).toMatchObject({ tag: 'span' });
    expect((home(r).nodes[inst] as InstanceNode).slots).toEqual({ extra: ['n_text0001'] });
  });
});

describe('the Inspector’s choices (#189)', () => {
  it('offers every tag of the kind, and says why one can’t go here', () => {
    const { s, o } = pageWithRows();
    const row = tagOptions(s, o, 'n_row0001');
    expect(row.map((x) => x.tag)).toEqual([...ELEMENT_TAGS]);
    expect(row.find((x) => x.tag === 'section')?.problem).toBeNull();
    expect(row.find((x) => x.tag === 'li')).toMatchObject({ problem: expect.stringMatching(/is a list item/), self: true });
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
    // Spelled out beside the select, one line per reason with the tags it rules out.
    const dl = 'Only goes inside a description list.';
    const several = tagSelectOptions('element', 'div', new Map([['main', 'Every page already has one.'], ['dt', dl], ['dd', dl]]));
    expect(unavailableReasons(several.groups)).toEqual([
      { reason: 'Every page already has one.', names: ['Main area (main)'] },
      { reason: dl, names: ['Term (dt)', 'Description (dd)'] }
    ]);
    // A group one reason rules out entirely is named as the group.
    const inline = 'Text inside a paragraph container has to be inline text.';
    const headings = tagSelectOptions('text', 'span', new Map([1, 2, 3, 4, 5, 6].map((n) => [`h${n}`, inline])));
    expect(unavailableReasons(headings.groups)).toEqual([{ reason: inline, names: ['Headings (h1–h6)'] }]);
  });

  it('says a tag’s own placement rule as where the tag goes, and keeps what it would strand as the check words it', () => {
    const li = 'A container is a list item, so it goes directly inside a list (ul or ol).';
    expect(standingReason('li', li, true)).toBe('Only goes directly inside a bulleted or numbered list.');
    expect(standingReason('dd', 'A heading is a term or description, so it goes inside a description list (dl).', true)).toBe('Only goes inside a description list.');
    expect(standingReason('figcaption', 'A heading is a caption, so it goes directly inside a figure.', true)).toBe('Only goes directly inside a figure.');
    expect(standingReason('summary', 'A container is a summary, so it goes directly inside a details element.', true)).toBe('Only goes directly inside an expandable section.');
    expect(standingReason('main', 'A container can’t be a main area: every page already has one, around its sections.', true)).toBe('Every page already has one, around its sections.');
    expect(standingReason('h2', 'A heading can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.', true)).toBe('Text inside a paragraph container has to be inline text.');
    const inP = 'A container can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.';
    expect(standingReason('section', inP, true, 'element')).toBe('Can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.');
    // Out of the paragraph, a caption still needs its figure: its own rule says what would make it available.
    expect(standingReason('figcaption', 'Text can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.', true)).toBe('Only goes directly inside a figure.');
    expect(standingReason('details', 'A disclosure can’t go inside a linked card, which can hold nothing interactive.', true, 'element')).toBe('Can’t go inside a linked card, which can hold nothing interactive.');
    // Another tag's rule (a list item the change strands) is not this tag's placement, nor is a problem elsewhere.
    expect(standingReason('figcaption', li, true)).toBe(li);
    expect(standingReason('li', li, false)).toBe(li);
    const card = 'A container is one link, which renders in place of its tag, so it can’t be a list.';
    expect(standingReason('ul', card, true)).toBe(card);
  });
});

describe('shipped content (#189)', () => {
  // The themes' sections are Svelte code (built and checked in their own repository), so what Builder lays out from
  // element tags is the starters' pages.
  it('has no nesting problems in any starter', () => {
    for (const { id } of STARTERS) {
      const s = createStarterState(id, 'Test', false);
      expect(nesting(s), id).toEqual([]);
    }
  });
});
