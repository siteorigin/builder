/**
 * WCAG contrast for every Foundation component and tone variant, computed from the theme's resolved tokens.
 * Walks each managed component tree the way the browser cascades colour: backgrounds paint over their
 * parent's background, text colour inherits, and opacity fades a node towards whatever is behind it.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, GraphNode, StyleProps, TokenDef } from '@shared/types';
import { isBinding } from '@shared/types';
import { selectedVariantStyles } from '@shared/variants';
import { listThemes } from '@catalogue/index';

type RGBA = { r: number; g: number; b: number; a: number };

function hex(h: string): RGBA {
  let s = h.replace('#', '');
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) throw new Error(`Malformed colour "${h}".`);
  if (s.length <= 4) s = [...s].map((c) => c + c).join('');
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16), a };
}

function over(top: RGBA, under: RGBA): RGBA {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function resolver(tokens: TokenDef[]) {
  const byId = new Map(tokens.map((t) => [t.id, t.value]));
  const color = (v: unknown, current: RGBA): RGBA => {
    if (v && typeof v === 'object' && 'token' in v) {
      const value = byId.get((v as { token: string }).token);
      if (value === undefined) throw new Error(`Unknown token ${(v as { token: string }).token}`);
      return color(value, current);
    }
    const s = String(v).trim().toLowerCase();
    if (s.startsWith('#')) return hex(s);
    if (s === 'inherit' || s === 'currentcolor') return current;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (s === 'white') return hex('#fff');
    if (s === 'black') return hex('#000');
    const mix = s.match(/^color-mix\(in srgb, var\(--so-color-([a-z-]+)\) (\d+(?:\.\d+)?)%, transparent\)$/);
    if (mix) return { ...color({ token: `color.${mix[1]}` }, current), a: Number(mix[2]) / 100 };
    throw new Error(`Unsupported colour "${s}" in the contrast test; teach the test how to read it.`);
  };
  return color;
}

/** Colours the Foundation base stylesheet gives each link appearance (before node styles). */
const APPEARANCE: Record<string, { fg?: string; bg?: string }> = {
  primary: { fg: 'color.on-brand', bg: 'color.brand' },
  light: { fg: 'color.brand-strong', bg: 'color.on-brand' },
  text: { fg: 'color.brand' },
  link: { fg: 'color.brand' }
};

/** Large text (WCAG: 24px and up, or 18.66px bold) only needs 3:1. Heading 3 is 19.2px at weight 600, so it is not. */
const LARGE_TEXT = new Set(['text.display', 'text.h1', 'text.h2', 'text.stat']);
/** Purely decorative icons carry no information and are exempt (WCAG 1.4.11). */
const DECORATIVE_ICONS = new Set(['quote-mark']);

interface Finding {
  component: string;
  variant: string;
  node: string;
  ratio: number;
  min: number;
}

/** Every combination of one option per variant axis. */
function combinations(def: ComponentDefinition): Array<Record<string, string>> {
  return Object.entries(def.variantAxes ?? {}).reduce<Array<Record<string, string>>>(
    (acc, [axis, a]) => acc.flatMap((c) => Object.keys(a.options).map((id) => ({ ...c, [axis]: id }))),
    [{}]
  );
}

function check(def: ComponentDefinition, selection: Record<string, string>, tokens: TokenDef[]): Finding[] {
  const variant = Object.values(selection).join('+') || 'default';
  const color = resolver(tokens);
  const out: Finding[] = [];
  const tree = def.tree!;
  const pageBg = color({ token: 'color.background' }, hex('#000'));
  const text = color({ token: 'color.text' }, pageBg);
  /**
   * `bg` is the backdrop inside the innermost opacity group; `groups` holds each enclosing group's opacity and
   * the backdrop behind it (in its parent group's space). An element with opacity is composited as a whole:
   * its content is painted first, then blended over what is behind it.
   */
  type Group = { opacity: number; under: RGBA };
  const flatten = (c: RGBA, groups: Group[]) => groups.reduceRight((acc, g) => over({ ...acc, a: g.opacity }, g.under), c);
  const walk = (id: string, fg: RGBA, bg: RGBA, groups: Group[]) => {
    const n: GraphNode | undefined = tree.nodes[id];
    if (!n) return;
    const styles: StyleProps = Object.assign({}, n.styles?.base, ...selectedVariantStyles(def, selection, id).map((l) => l.base));
    const opacity = styles.opacity !== undefined ? Number(styles.opacity) : 1;
    const inner = opacity < 1 ? [...groups, { opacity, under: bg }] : groups;
    let nodeFg = fg;
    let nodeBg = bg;
    if (n.kind === 'link' && !isBinding(n.appearance)) {
      const a = APPEARANCE[String(n.appearance)];
      if (a?.bg) nodeBg = over(color({ token: a.bg }, fg), bg);
      if (a?.fg) nodeFg = color({ token: a.fg }, fg);
    }
    if (styles.background !== undefined) nodeBg = over(color(styles.background, fg), bg);
    if (styles.color !== undefined) nodeFg = color(styles.color, fg);
    const visible = flatten(over(nodeFg, nodeBg), inner);
    const shownBg = flatten(nodeBg, inner);
    const textStyle = styles.textStyle && typeof styles.textStyle === 'object' ? (styles.textStyle as { token: string }).token : '';
    let min = 0;
    if (n.kind === 'text') min = LARGE_TEXT.has(textStyle) ? 3 : 4.5;
    else if (n.kind === 'link') min = 4.5;
    else if (n.kind === 'icon' && !DECORATIVE_ICONS.has(id)) min = 3;
    if (min) {
      const ratio = contrast(visible, shownBg);
      if (!Number.isFinite(ratio)) throw new Error(`Could not compute contrast for ${def.componentId} ${id}.`);
      if (ratio < min) out.push({ component: def.componentId, variant, node: id, ratio: Math.round(ratio * 100) / 100, min });
    }
    const children = n.kind === 'element' || n.kind === 'repeat' ? n.children : [];
    for (const c of children) walk(c, nodeFg, nodeBg, inner);
  };
  for (const r of tree.rootIds) walk(r, text, pageBg, []);
  return out;
}

describe('Foundation contrast (WCAG AA)', () => {
  for (const theme of listThemes()) {
    it(`every ${theme.name} component and tone variant is readable`, () => {
      const findings: Finding[] = [];
      let checked = 0;
      for (const def of theme.components) {
        if (def.kind !== 'managed' || !def.tree) continue;
        for (const selection of combinations(def)) {
          findings.push(...check(def, selection, theme.tokens));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
      expect(findings).toEqual([]);
    });
  }

  it('catches text that inherits a light colour into a white card', () => {
    const theme = listThemes()[0];
    const def = structuredClone(theme.components.find((c) => c.componentId === 'features.grid')!);
    def.variantAxes!.tone.options.inverse.styles!['card-text'] = { base: { color: { token: 'color.on-inverse' } } };
    expect(check(def, { tone: 'inverse', layout: 'four-columns' }, theme.tokens).map((f) => f.node)).toContain('card-text');
  });

  it('catches a brand-coloured eyebrow on the dark tone', () => {
    const theme = listThemes()[0];
    const def = structuredClone(theme.components.find((c) => c.componentId === 'hero.centered')!);
    delete def.variantAxes!.tone.options.inverse.styles!.eyebrow;
    expect(check(def, { tone: 'inverse' }, theme.tokens).map((f) => f.node)).toEqual(['eyebrow']);
  });
});
