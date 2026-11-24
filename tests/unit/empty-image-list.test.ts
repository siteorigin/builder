/**
 * An empty Gallery or Carousel in the editor (issue #577): while it has no images, the editor's preview shows a
 * placeholder where they will go, rendered only while editing, so Preview has none of it, and no exported file has any.
 */
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { defFile, generateProject } from '@generator/index';

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

describe('an empty list of images in the editor preview', () => {
  for (const [componentId, prop, label] of [
    ['media.gallery', 'images', 'No images yet'],
    ['media.carousel', 'slides', 'No slides yet']
  ] as const) {
    it(`shows where a ${componentId}'s ${prop} will go, only while editing`, () => {
      const { s, file } = withSection(componentId, prop);
      const src = generateProject(s, { instrument: true }).get(file)!;
      // In place of the list while it hides, and only while editing.
      expect(src).toMatch(new RegExp(`\\{:else if so_editing\\}\\s*<div class="so-list-empty" data-so-editor-only="" data-so-list-empty=\\{"${prop}"\\}><strong>\\{"${label}"\\}</strong>`));
      expect(src).toContain('Visitors won’t see this box.');
      expect(src.match(/let so_editing = \$state\(false\);/g)).toHaveLength(1);
      expect(() => compile(src, { filename: file, generate: 'client', runes: true })).not.toThrow();
      expect(() => compile(src, { filename: file, generate: 'server', runes: true })).not.toThrow();
      // Exported, the list still hides while empty, and nothing of the placeholder is anywhere.
      for (const [p, out] of generateProject(s)) expect(out, p).not.toMatch(EDITOR_ONLY);
    });
  }

  it('is left out of a list that is not filled from Assets, though its items hold an image', () => {
    // A Page list's cards each have an image, but it is filled with pages.
    const { s, file } = withSection('content.pages', 'items');
    const src = generateProject(s, { instrument: true }).get(file)!;
    expect(src).toMatch(/\{#if has\(/);
    expect(src).not.toContain('so-list-empty');
  });

  it('stands only in place of the list, under the list’s own condition', () => {
    const { s, file } = withSection('media.gallery', 'images', [{ image: { assetId: null, alt: '' }, caption: 'One' }]);
    const src = generateProject(s, { instrument: true }).get(file)!;
    // The placeholder is in the file, for when the list is emptied, but stands only in place of an empty list.
    expect(src).toMatch(/\{#if has\(images\)\}[\s\S]*\{:else if so_editing\}/);
  });
});
