import { afterAll, describe, expect, it } from 'vitest';
import { removeRendered, serverHtml } from './generated-site';
import { compile } from 'svelte/compiler';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { findTheme, listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { STICKY_BELOW_HEADER } from '@shared/styles';
import { layerSlots } from '../../src/renderer/src/lib/layer-drop';
import { shownSlots } from '../../src/renderer/src/lib/slot-target';
import { insertAt, insertOps } from '../../src/renderer/src/lib/insert-at';

/**
 * Foundation's Split layout (#669): two named slots side by side, whose proportions, tone and pinned Secondary column
 * each placement chooses, stacked into one column on phones, and exported as plain Svelte and CSS.
 */

function placed(themeId = 'foundation') {
  let state: ProjectState = createStarterState('blank', 'Split', false, themeId);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const run = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [{ nodeId, definitionId }] = run([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.split' }]);
  return {
    owner,
    id: nodeId as string,
    definitionId: definitionId ?? (state.pages[state.site.homePageId].nodes[nodeId as string] as InstanceNode).definitionId,
    run,
    state: () => state,
    node: () => state.pages[state.site.homePageId].nodes[nodeId as string] as InstanceNode
  };
}

/** Fill both slots: a heading and a Statistics section in Primary, a paragraph and a button in Secondary. */
function fill(p: ReturnType<typeof placed>) {
  const into = (slot: string, spec: Partial<Extract<EditOperation, { type: 'node.insert' }>>) =>
    p.run([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot, ...spec } as EditOperation])[0].nodeId as string;
  // Secondary first: what goes there must not depend on Primary holding anything.
  const note = into('secondary', { primitive: 'paragraph', text: 'Get the monthly newsletter' });
  const heading = into('primary', { primitive: 'heading', text: 'This season in the garden' });
  const stats = into('primary', { componentId: 'stats.row' });
  const button = into('secondary', { primitive: 'button', text: 'Sign up' });
  return { primary: [heading, stats], secondary: [note, button] };
}

/** The stylesheet's rules for the placed definitions (the theme's own base CSS is separate), spaces run together. */
function componentCss(state: ProjectState): string {
  return [...generateProject(state)]
    .filter(([path]) => path.startsWith(STYLES_DIR) && !/(theme|tokens)\.css$/.test(path))
    .map(([, src]) => src)
    .join('\n')
    .replace(/\s+/g, ' ');
}

/** The exported Home page, and the Split's own Svelte file. */
function exported(state: ProjectState) {
  const files = generateProject(state);
  const page = files.get(pageFile(state.pages[state.site.homePageId]))!;
  const split = [...files].find(([path]) => path.endsWith('-layout-split.svelte'))![1];
  return { files, page, split };
}

/** What a column of the exported static page holds, Svelte's hydration comments left out. */
const columnHtml = (html: string, which: 'primary' | 'secondary') =>
  html.replace(/<!--.*?-->/g, '').match(new RegExp(`<div class="[^"]*__split-${which}[^"]*">([\\s\\S]*?)</div>`))?.[1];

afterAll(removeRendered);

describe('Split layout (#669)', () => {
  it('ships in every theme with two named slots and its three choices', () => {
    for (const theme of listThemes()) {
      const def = theme.components.find((c) => c.componentId === 'layout.split')!;
      expect(def, theme.id).toBeDefined();
      expect([def.name, def.kind, def.category]).toEqual(['Split layout', 'managed', 'layout']);
      expect(Object.entries(def.slots!).map(([id, s]) => [id, s.label])).toEqual([['primary', 'Primary'], ['secondary', 'Secondary']]);
      expect(Object.fromEntries(Object.entries(def.variantAxes!).map(([axis, a]) => [axis, Object.values(a.options).map((o) => o.label)]))).toEqual({
        ratio: ['Equal (1:1)', 'Wide left (2:1)', 'Wide right (1:2)'],
        tone: ['Default', 'Soft background', 'Dark'],
        sticky: ['Scrolls with the page', 'Stays in view (sticky)']
      });
    }
  });

  it('lists both slots in Layers while empty, and takes basic elements and components into each', () => {
    const p = placed();
    expect(shownSlots(p.state(), p.definitionId)).toEqual(['primary', 'secondary']);
    expect(layerSlots(p.state(), p.node()).map((s) => [s.slot, s.label, s.ids, s.shown])).toEqual([
      ['primary', 'Primary', [], true],
      ['secondary', 'Secondary', [], true]
    ]);
    const content = fill(p);
    expect(p.node().slots).toEqual(content);
    expect(validateState(p.state()).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('takes an element inserted with a slot picked into that slot', () => {
    const p = placed();
    const selected: ElementRef = { owner: p.owner, instancePath: [], nodeId: p.id, slot: 'secondary' } as ElementRef;
    const at = insertAt(p.state(), p.owner, 'element', selected)!;
    p.run(insertOps(at, { primitive: 'paragraph', text: 'Aside' }, 'element'));
    expect(p.node().slots?.secondary).toHaveLength(1);
    expect(p.node().slots?.primary ?? []).toEqual([]);
  });

  it('keeps one column on phones and sets each ratio from tablet up, keeping the slot content', () => {
    const p = placed();
    const content = fill(p);
    for (const [ratio, a, b] of [['equal', '1fr', '1fr'], ['wide-left', '2fr', '1fr'], ['wide-right', '1fr', '2fr'], ['equal', '1fr', '1fr']]) {
      p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'ratio', variant: ratio }]);
      expect(p.node().slots).toEqual(content);
      expect(p.node().variants?.ratio ?? 'equal').toBe(ratio);
      const css = componentCss(p.state());
      expect(css).toMatch(new RegExp(`\\.so-foundation-layout-split__inner \\{[^}]*grid-template-columns: repeat\\(1, minmax\\(0, 1fr\\)\\)`));
      const rule = ratio === 'equal' ? '\\.so-foundation-layout-split__inner' : `\\.so-foundation-layout-split--ratio-${ratio}\\.so-foundation-layout-split__inner`;
      expect(css, ratio).toMatch(new RegExp(`@media \\(min-width: 768px\\) \\{[^@]*${rule} \\{[^}]*grid-template-columns: minmax\\(0, ${a}\\) minmax\\(0, ${b}\\)`));
      // The default needs no prop on the placement; the other ratios are passed to it.
      if (ratio !== 'equal') expect(exported(p.state()).page).toContain(`variant_ratio="${ratio}"`);
    }
  });

  it('pins Secondary below the site header from tablet up only when chosen', () => {
    const p = placed();
    const pinned = /\.so-foundation-layout-split--sticky-pin-secondary\.so-foundation-layout-split__split-secondary \{ align-self: start; inset: [^;]+; position: sticky;/g;
    p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'sticky', variant: 'pin-secondary' }]);
    const css = componentCss(p.state());
    // One rule for tablets and one for desktops, each also clearing the header; none for phones or all sizes.
    expect(css.match(pinned)).toHaveLength(2);
    expect(css).toContain(`inset: ${STICKY_BELOW_HEADER.inset};`);
    expect(css.slice(0, css.indexOf('@media'))).not.toContain('sticky');
    expect(exported(p.state()).page).toContain('variant_sticky="pin-secondary"');
  });

  it('exports both columns as plain elements with no Builder runtime, and marks empty slots only in the editor', async () => {
    for (const themeId of ['foundation', 'editorial', 'signal']) {
      const p = placed(themeId);
      const dev = [...generateProject(p.state(), { instrument: true }).values()].join('\n');
      expect(dev.match(/data-so-slot-empty=\{"(primary|secondary)"\}/g), themeId).toHaveLength(2);

      const empty = exported(p.state());
      expect(empty.split).toMatch(/<section[\s\S]*__split-primary[\s\S]*\{@render slot_primary\?\.\(\)\}[\s\S]*__split-secondary[\s\S]*\{@render slot_secondary\?\.\(\)\}/);
      // The static page's empty columns hold nothing but comments, so `:empty` finds them.
      const bare = await serverHtml(empty.files, 'split-layout-');
      expect([columnHtml(bare, 'primary'), columnHtml(bare, 'secondary')], themeId).toEqual(['', '']);

      fill(p);
      const out = exported(p.state());
      const html = await serverHtml(out.files, 'split-layout-');
      expect(html.indexOf('This season in the garden')).toBeGreaterThan(html.indexOf('__split-primary'));
      expect(html.indexOf('This season in the garden')).toBeLessThan(html.indexOf('__split-secondary'));
      expect(html.indexOf('Get the monthly newsletter')).toBeGreaterThan(html.indexOf('__split-secondary'));
      for (const [path, src] of out.files) {
        if (!path.startsWith('src/')) continue;
        expect(src, path).not.toMatch(/data-so-slot|so-slot-empty|data-so-editor|\.siteorigin\/|so_editing/);
        if (path.endsWith('.svelte')) expect(() => compile(src, { filename: path, generate: 'client', runes: true }), path).not.toThrow();
      }
      // A column left empty takes no gap where the two stack; the print sheet unpins Secondary.
      const theme = findTheme(themeId)!.baseCss;
      expect(theme).toMatch(/@media \(max-width: 767\.98px\) \{ [^\n]*__split-primary[^\n]*__split-secondary[^\n]*:empty:not\(#so-split\) \{ display: none; \} \}/);
      expect(theme).toMatch(/--sticky-pin-secondary'\][^\n]*__split-secondary[^\n]*position: static !important/);
    }
  });
});
