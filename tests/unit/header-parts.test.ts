/**
 * The shared header's site name, menu links, current page link and action, and the shared footer's links and current
 * page link, are parts of their placements (#1492): styled through the shell's placement like any section's part,
 * picked on the canvas by the class the editor's preview gives them, and written into the website's stylesheet with no
 * marker.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { isStateStyleProp, placementStyleControls } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { codeTakesOverrides } from '@engine/tree';
import { generateProject } from '@generator/index';

const TYPE = ['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'color'];
/** Each part's label and the controls it declares (the inspector adds Hidden to every code part). */
const HEADER_PARTS: Record<string, [string, string[]]> = {
  brand: ['Site name', TYPE],
  link: ['Menu links', [...TYPE, 'background']],
  linkCurrent: ['Current page link', ['fontWeight', 'color', 'background']],
  action: ['Action button', [...TYPE, 'background']]
};
const FOOTER_PARTS: Record<string, [string, string[]]> = {
  link: ['Links', TYPE],
  linkCurrent: ['Current page link', ['fontWeight', 'color']]
};

const shell = (s: ProjectState, id: 'header' | 'footer') => ({ owner: { kind: 'shell' as const, id }, nodeId: s.site.shell[id].rootIds[0] });
const defOf = (s: ProjectState, id: 'header' | 'footer') => {
  const node = s.site.shell[id].nodes[shell(s, id).nodeId];
  return s.components[(node as { definitionId: string }).definitionId];
};
/** Every `so_o` map the layout passes, in order. */
const maps = (layout: string) => [...layout.matchAll(/so_o=\{(\{[^}]*\})\}/g)].map((m) => JSON.parse(m[1]) as Record<string, string>);
const tokens = (cls: string | undefined) => (cls ?? '').split(/\s+/).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the shared header and footer expose their type as parts (#1492)', () => {
  for (const themeId of ['foundation', 'foundation-alt']) {
    it(`declares the header's site name, links, current link and action, and the footer's links and current link (${themeId})`, () => {
      const s = createStarterState('business', 'Parts Studio', false, themeId);
      for (const [shellId, parts] of [['header', HEADER_PARTS], ['footer', FOOTER_PARTS]] as const) {
        const def = defOf(s, shellId);
        expect(codeTakesOverrides(def), shellId).toBe(true);
        expect(Object.keys(def.parts).sort(), shellId).toEqual([...Object.keys(parts), ...(shellId === 'header' ? ['root'] : ['brand', 'copyright', 'root'])].sort());
        for (const [id, [label, controls]] of Object.entries(parts)) {
          expect(def.parts[id], `${shellId}.${id}`).toEqual({ nodeId: id, label, styleControls: controls });
          const offered = placementStyleControls(def, id, codeTakesOverrides(def))!;
          expect(offered, `${shellId}.${id}`).toEqual([...controls, 'hidden']);
          // Text colour changes on hover and with keyboard focus, so the part offers those states.
          expect(isStateStyleProp('color', 'hover') && isStateStyleProp('color', 'focus')).toBe(true);
        }
      }
    });
  }

  it('styles each part through the shell placement, marks it in the preview, and writes its rules with no marker', () => {
    const s = createStarterState('business', 'Parts Studio', false);
    const h = shell(s, 'header');
    const f = shell(s, 'footer');
    const set = (at: typeof h, partId: string, property: string, value: unknown, state?: 'hover' | 'focus') =>
      ({ type: 'node.setStyle', ...at, partId, scope: 'base', ...(state ? { state } : {}), property, value }) as EditOperation;
    const { state } = applyOperations(s, [
      set(h, 'brand', 'textTransform', 'uppercase'),
      set(h, 'brand', 'letterSpacing', '0.08em'),
      set(h, 'link', 'color', '#123456'),
      set(h, 'link', 'fontWeight', '400'),
      set(h, 'link', 'color', '#654321', 'hover'),
      set(h, 'linkCurrent', 'fontWeight', '700'),
      set(h, 'action', 'background', '#0a0a0a', 'focus'),
      set(f, 'link', 'textTransform', 'uppercase'),
      set(f, 'linkCurrent', 'color', '#ff0000')
    ]);
    const stored = (id: 'header' | 'footer', at: typeof h) => Object.keys((state.site.shell[id].nodes[at.nodeId] as { overrides?: Record<string, unknown> }).overrides ?? {}).sort();
    expect(stored('header', h)).toEqual(['action', 'brand', 'link', 'linkCurrent']);
    expect(stored('footer', f)).toEqual(['link', 'linkCurrent']);

    // The editor's preview names every declared part of each, styled or not, by a class of its own.
    const preview = maps(generateProject(state, { instrument: true }).get('src/routes/+layout.svelte')!);
    const headerMarks = preview.find((m) => Object.hasOwn(m, 'action'))!;
    const footerMarks = preview.find((m) => Object.hasOwn(m, 'copyright'))!;
    expect(Object.keys(headerMarks).sort()).toEqual(['action', 'brand', 'link', 'linkCurrent']);
    expect(Object.keys(footerMarks).sort()).toEqual(['brand', 'copyright', 'link', 'linkCurrent']);
    for (const [map, ids] of [[headerMarks, Object.keys(HEADER_PARTS)], [footerMarks, Object.keys(FOOTER_PARTS)]] as const)
      for (const id of ids) expect(tokens(map[id]), id).toContain(`so-part--${id}`);

    const site = generateProject(state, { instrument: false });
    const layout = site.get('src/routes/+layout.svelte')!;
    expect(layout).not.toContain('so-part--');
    const exported = maps(layout);
    const headerMap = exported.find((m) => Object.hasOwn(m, 'action'))!;
    const footerMap = exported.find((m) => !Object.hasOwn(m, 'action'))!;
    expect(Object.keys(footerMap).sort()).toEqual(['link', 'linkCurrent']);
    const cls = (map: Record<string, string>, part: string) => tokens(map[part])[0];
    const css = [...site.entries()].filter(([p]) => p.endsWith('.css')).map(([, c]) => c).join('\n');
    /** The rule for exactly this part's override (three classes, as a code part's), in this state, setting this. */
    const rule = (c: string, decl: string, pseudo = '') => new RegExp(`(?:^|[\\s,}])\\.${escape(c)}\\.${escape(c)}\\.${escape(c)}${pseudo} \\{[^}]*${decl} !important;`, 'm');
    expect(css).toMatch(rule(cls(headerMap, 'brand'), 'text-transform: uppercase'));
    expect(css).toMatch(rule(cls(headerMap, 'brand'), 'letter-spacing: 0\\.08em'));
    expect(css).toMatch(rule(cls(headerMap, 'link'), 'color: #123456'));
    expect(css).toMatch(rule(cls(headerMap, 'link'), 'color: #654321', ':where\\(:hover\\)'));
    expect(css).toMatch(rule(cls(headerMap, 'linkCurrent'), 'font-weight: 700'));
    expect(css).toMatch(rule(cls(headerMap, 'action'), 'background: #0a0a0a', ':where\\(:focus-visible, \\.so-action:focus-visible > \\*\\)'));
    expect(css).toMatch(rule(cls(footerMap, 'link'), 'text-transform: uppercase'));
    expect(css).toMatch(rule(cls(footerMap, 'linkCurrent'), 'color: #ff0000'));
    // Both set the weight at rest for every size: the current link's rule comes after every link's, so it wins.
    /** Where the last rule for this part setting this starts: the one that wins among them. */
    const at = (c: string, decl: string) => Math.max(-1, ...[...css.matchAll(new RegExp(rule(c, decl).source, 'gm'))].map((m) => m.index!));
    expect(at(cls(headerMap, 'link'), 'font-weight: 400')).toBeGreaterThan(-1);
    expect(at(cls(headerMap, 'linkCurrent'), 'font-weight: 700')).toBeGreaterThan(at(cls(headerMap, 'link'), 'font-weight'));
  });
});
