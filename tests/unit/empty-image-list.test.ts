/**
 * An empty Gallery or Carousel in the editor (issue #577): while it has no images, the editor's preview shows a
 * placeholder where they will go, rendered only while editing, so Preview has none of it, and no exported file has any.
 *
 * The generator writes the placeholder into a managed design's list, so most of these run on the managed designs of
 * the Gallery's and Carousel's contracts (fixtures/component-contract-designs), registered as Foundation's; the first
 * run on the sections as Foundation ships them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { defFile, generateProject } from '@generator/index';
import { restorePacks } from './fixtures/packs';
import { registerManaged } from './fixtures/component-contract-designs';

/** Anything of the editor's placeholders. */
const EDITOR_ONLY = /so_editing|so-list-empty|data-so-list-empty|data-so-editor-only/;

/** A blank site with the component at the top of Home, its list set to `rows` when given, and the file it is written to. */
function withSection(componentId: string, prop: string, rows?: Array<Record<string, unknown>>): { s: ProjectState; file: string } {
  const start = createStarterState('blank', 'Lists', false);
  const owner = { kind: 'page' as const, id: start.site.homePageId };
  const r = applyOperations(start, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId, ...(rows ? { props: { [prop]: rows } } : {}) }]);
  const node = r.state.pages[owner.id].nodes[r.results[0].nodeId as string] as InstanceNode;
  return { s: r.state, file: defFile(r.state.components[node.definitionId]) };
}

/** What the editor's preview of an empty list says, for each section: in place of the list, only while editing. */
function showsPlaceholder(componentId: string, prop: string, label: string) {
  const { s, file } = withSection(componentId, prop);
  const src = generateProject(s, { instrument: true }).get(file)!;
  expect(src).toMatch(new RegExp(`\\{:else if so_editing\\}\\s*<div class="so-list-empty" data-so-editor-only="" data-so-list-empty=\\{"${prop}"\\}><strong>\\{"${label}"\\}</strong>`));
  expect(src).toContain('Visitors won’t see this box.');
  expect(src.match(/let so_editing = \$state\(false\);/g)).toHaveLength(1);
  expect(() => compile(src, { filename: file, generate: 'client', runes: true })).not.toThrow();
  expect(() => compile(src, { filename: file, generate: 'server', runes: true })).not.toThrow();
  // Exported, the list still hides while empty, and nothing of the placeholder is anywhere.
  for (const [p, out] of generateProject(s)) expect(out, p).not.toMatch(EDITOR_ONLY);
}

const LISTS = [
  ['media.gallery', 'images', 'No images yet'],
  ['media.carousel', 'slides', 'No slides yet']
] as const;

describe('an empty list of images in Foundation as it ships', () => {
  for (const [componentId, prop] of LISTS) {
    it(`leaves a ${componentId} with no ${prop} a page that compiles while editing, and exports nothing of the editor’s`, () => {
      const { s, file } = withSection(componentId, prop);
      const src = generateProject(s, { instrument: true }).get(file)!;
      expect(() => compile(src, { filename: file, generate: 'client', runes: true })).not.toThrow();
      expect(() => compile(src, { filename: file, generate: 'server', runes: true })).not.toThrow();
      for (const [p, out] of generateProject(s)) expect(out, p).not.toMatch(EDITOR_ONLY);
    });

    // Release gap: the empty-list placeholder is written into a managed design's list only (emptyImageListMarker in src/generator/index.ts), and a release code component has no tree, so an empty release Gallery or Carousel shows nothing in Edit.
    it.fails(`marks where a ${componentId}'s ${prop} will go in the editor’s preview`, () => {
      const { s, file } = withSection(componentId, prop);
      expect(generateProject(s, { instrument: true }).get(file)).toMatch(new RegExp(`data-so-list-empty=\\{?"${prop}"`));
    });
  }
});

describe('an empty list of images in the editor preview', () => {
  beforeAll(() => registerManaged('media.gallery', 'media.carousel'));
  afterAll(() => restorePacks());

  for (const [componentId, prop, label] of LISTS) {
    it(`shows where a managed ${componentId}'s ${prop} will go, only while editing`, () => showsPlaceholder(componentId, prop, label));
  }

  it('is left out of a list that is not filled from Assets, though its items hold an image', () => {
    // A Page list's cards each have an image, but it is filled with pages.
    const { s, file } = withSection('content.pages', 'items');
    const src = generateProject(s, { instrument: true }).get(file)!;
    expect(src).toMatch(/\{#if has\(/);
    expect(src).not.toContain('so-list-empty');
  });

  it('stays with a Gallery made unique, which keeps its list of images', () => {
    const start = createStarterState('blank', 'Lists', false);
    const owner = { kind: 'page' as const, id: start.site.homePageId };
    let r = applyOperations(start, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'media.gallery' }]);
    const nodeId = r.results[0].nodeId as string;
    r = applyOperations(r.state, [{ type: 'component.makeUnique', owner, nodeId, name: 'Our work' }]);
    const node = r.state.pages[owner.id].nodes[nodeId] as InstanceNode;
    const def = r.state.components[node.definitionId];
    expect(def.componentId).not.toBe('media.gallery');
    const src = generateProject(r.state, { instrument: true }).get(defFile(def))!;
    expect(src).toContain('data-so-list-empty={"images"}><strong>{"No images yet"}</strong>');
  });

  it('is left out of a list a feed fills, which has no images to choose', () => {
    const { s, file } = withSection('media.carousel', 'slides');
    const def = Object.values(s.components).find((d) => defFile(d) === file)!;
    const slides = def.properties.slides;
    if (slides.type !== 'list') throw new Error('slides is a list');
    slides.feed = 'entries';
    expect(generateProject(s, { instrument: true }).get(file)).not.toContain('so-list-empty');
  });

  it('still names a list whose saved definition lost its label', () => {
    const { s, file } = withSection('media.carousel', 'slides');
    const def = Object.values(s.components).find((d) => defFile(d) === file)!;
    delete (def.properties.slides as { label?: string }).label;
    const src = generateProject(s, { instrument: true }).get(file)!;
    expect(src).toContain('<strong>{"No images yet"}</strong>');
  });
});
