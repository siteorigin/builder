import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import type { ProjectState, TextStyleValue, TokenDef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { installedFonts } from '@catalogue/fonts';
import { applyOperations } from '@engine/apply';
import { effectiveTokens, generateTokensCss } from '@generator/index';
import { isTokenLength, textMetrics } from '@shared/styles';
import {
  FLUID_MAX_WIDTH,
  FLUID_MIN_WIDTH,
  FONT_PAIRINGS,
  TYPE_SCALES,
  TYPE_SCALE_IDS,
  TYPE_SCALE_ROLES,
  activePairing,
  activeTypeScale,
  availablePairings,
  fluidSize,
  pairingOps,
  scaleMetrics,
  scaleRoles,
  sizeAtWidth,
  typeScaleOps,
  type TypeScaleChoice
} from '@shared/type-scale';
import { ProjectSession } from '../../src/main/project/session';

const starter = () => createStarterState('business', 'Type Studio', false);
const themeTokens = (s: ProjectState) => getTheme(s.site.themeId).tokens;
const opsFor = (s: ProjectState, choice: TypeScaleChoice) => typeScaleOps(effectiveTokens(s), themeTokens(s), choice);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const metrics = (s: ProjectState, id: string) => textMetrics(effectiveTokens(s), id, themeTokens(s).find((t) => t.id === id)?.value)!;
const set = (s: ProjectState, tokenId: string, value: unknown) => apply(s, [{ type: 'token.set', tokenId, value }]);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('fluid sizes', () => {
  it('writes a clamp() that grows from the phone size to the desktop size', () => {
    expect(fluidSize(42, 108)).toBe('clamp(2.625rem, 1.0109rem + 7.1739vw, 6.75rem)');
    expect(fluidSize(16, 16)).toBe('1rem');
    // A size that grows faster than it starts has a negative intercept, written as a subtraction.
    const steep = fluidSize(10, 40);
    expect(steep).toBe('clamp(0.625rem, 3.2609vw - 0.1087rem, 2.5rem)');
    expect(isTokenLength(steep, { negative: false })).toBe(true);
    expect(sizeAtWidth(steep, FLUID_MIN_WIDTH)).toBeCloseTo(10, 2);
    expect(sizeAtWidth(steep, FLUID_MAX_WIDTH)).toBeCloseTo(40, 2);
    expect(() => fluidSize(20, 10)).toThrow();
  });

  it('works out a size at a window width, as the browser does, or says it cannot', () => {
    // Foundation's own display size reaches its smallest size only above a phone's width.
    expect(sizeAtWidth('clamp(2.6rem, 1.4rem + 4.4vw, 4.9rem)', 375)).toBeCloseTo(41.6, 5);
    expect(sizeAtWidth('clamp(2.6rem, 1.4rem + 4.4vw, 4.9rem)', 1000)).toBeCloseTo(66.4, 5);
    expect(sizeAtWidth('clamp(2.6rem, 1.4rem + 4.4vw, 4.9rem)', 1600)).toBeCloseTo(78.4, 5);
    expect(sizeAtWidth('1.2rem', 375)).toBeCloseTo(19.2, 5);
    expect(sizeAtWidth('18px', 1280)).toBe(18);
    // As in CSS, a smallest size above the largest wins.
    expect(sizeAtWidth('clamp(2rem, 1vw, 1rem)', 1280)).toBe(32);
    for (const v of ['calc(1rem + 2vw)', 'min(2rem, 5vw)', 'clamp(1rem, var(--x), 2rem)', 'large', '']) expect(sizeAtWidth(v, 375), v).toBeNull();
  });
});

describe('type scale presets', () => {
  it('give every style a valid fluid clamp() that reaches its phone and desktop sizes', () => {
    expect(TYPE_SCALES.map((s) => s.label)).toEqual(['Compact', 'Balanced', 'Editorial', 'Bold display']);
    for (const scale of TYPE_SCALES) {
      const m = scaleMetrics(scale.id);
      for (const role of TYPE_SCALE_ROLES) {
        const [min, max, lineHeight, tracking] = scale.roles[role];
        const { size } = m[role];
        const where = `${scale.id} ${role}`;
        expect(size, where).toMatch(/^clamp\(/);
        expect(isTokenLength(size, { negative: false }), where).toBe(true);
        expect(size, where).not.toMatch(/e[+-]?\d/i);
        expect(sizeAtWidth(size, 320), where).toBeCloseTo(min, 2);
        expect(sizeAtWidth(size, FLUID_MIN_WIDTH), where).toBeCloseTo(min, 2);
        expect(sizeAtWidth(size, (FLUID_MIN_WIDTH + FLUID_MAX_WIDTH) / 2), where).toBeCloseTo((min + max) / 2, 2);
        expect(sizeAtWidth(size, FLUID_MAX_WIDTH), where).toBeCloseTo(max, 2);
        expect(sizeAtWidth(size, 1920), where).toBeCloseTo(max, 2);
        expect(m[role].lineHeight).toBe(lineHeight);
        expect(m[role].tracking).toBe(tracking);
        expect(Number(lineHeight)).toBeGreaterThan(0.9);
      }
    }
  });

  it('keep headings above text at both a phone and a desktop width', () => {
    for (const id of TYPE_SCALE_IDS) {
      const m = scaleMetrics(id);
      for (const width of [375, 1280]) {
        const sizes = TYPE_SCALE_ROLES.map((r) => sizeAtWidth(m[r].size, width)!);
        for (let i = 1; i < sizes.length; i++) expect(sizes[i], `${id} ${TYPE_SCALE_ROLES[i]} at ${width}px`).toBeLessThan(sizes[i - 1]);
      }
    }
    // Each step up the presets makes the display size more dramatic on a desktop.
    const display = TYPE_SCALE_IDS.map((id) => sizeAtWidth(scaleMetrics(id)['text.display'].size, 1280)!);
    expect([...display].sort((a, b) => a - b)).toEqual(display);
  });
});

describe('applying a type scale', () => {
  it('sets the size, line height and spacing of every scaled style in one batch, keeping fonts, weights and case', () => {
    const s0 = starter();
    const ops = opsFor(s0, 'editorial');
    expect(ops).toHaveLength(TYPE_SCALE_ROLES.length);
    expect(ops.every((o) => o.type === 'token.set')).toBe(true);
    const s = apply(s0, ops);
    const want = scaleMetrics('editorial');
    for (const role of TYPE_SCALE_ROLES) {
      const before = metrics(s0, role);
      const after = metrics(s, role);
      expect(after, role).toEqual({ ...before, ...want[role] });
      expect(after.family, role).toEqual(before.family);
    }
    expect(metrics(s, 'text.display').family).toEqual({ token: 'font.display' });
    expect(metrics(s, 'text.body').family).toEqual({ token: 'font.body' });
    // Styles outside the scale keep the theme's values.
    for (const id of ['text.eyebrow', 'text.stat']) expect(s.tokens.overrides[id], id).toBeUndefined();
    // The site's stylesheet carries the generated sizes.
    const css = generateTokensCss(s);
    expect(css).toContain(`--so-text-display-size: ${want['text.display'].size};`);
    expect(css).toContain(`--so-text-small-line-height: ${want['text.small'].lineHeight};`);
  });

  it('is undone in one step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-type-scale-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, starter());
    // A font change first, so undo has something to go back to that is not the theme.
    await session.apply({ operations: [{ type: 'token.set', tokenId: 'text.h2', value: { weight: 600 } }] }, { label: 'Bolder headings' });
    const before = structuredClone(session.state.tokens);
    const r = await session.apply({ operations: opsFor(session.state, 'bold-display') }, { label: 'Use the Bold display type scale' });
    expect(r.ok).toBe(true);
    expect(metrics(session.state, 'text.h2')).toMatchObject({ weight: 600, size: scaleMetrics('bold-display')['text.h2'].size });
    await session.undo();
    expect(session.state.tokens).toEqual(before);
  });

  it('leaves each style editable afterwards, and each metric can go back to the theme', () => {
    let s = apply(starter(), opsFor(starter(), 'compact'));
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s))).toBe('compact');
    s = set(s, 'text.h1', { size: 'clamp(2rem, 1rem + 3vw, 4rem)' });
    expect(metrics(s, 'text.h1').size).toBe('clamp(2rem, 1rem + 3vw, 4rem)');
    expect(metrics(s, 'text.h1').lineHeight).toBe(scaleMetrics('compact')['text.h1'].lineHeight);
    // One style of its own no longer matches any scale.
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s))).toBeNull();
    const theme = textMetrics(themeTokens(s), 'text.h1')!;
    s = set(s, 'text.h1', { size: theme.size, lineHeight: theme.lineHeight, tracking: theme.tracking });
    expect(metrics(s, 'text.h1')).toEqual(theme);
    s = set(s, 'text.body', null);
    expect(s.tokens.overrides['text.body']).toBeUndefined();
    expect(metrics(s, 'text.body')).toEqual(textMetrics(themeTokens(s), 'text.body'));
  });

  it('applies again as nothing, and a weight or font of its own keeps the scale', () => {
    let s = apply(starter(), opsFor(starter(), 'balanced'));
    expect(opsFor(s, 'balanced')).toEqual([]);
    s = set(s, 'text.display', { weight: 800 });
    s = set(s, 'font.display', 'Lora');
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s))).toBe('balanced');
    expect(opsFor(s, 'balanced')).toEqual([]);
    // Another scale keeps the weight chosen by hand.
    s = apply(s, opsFor(s, 'editorial'));
    expect(metrics(s, 'text.display').weight).toBe(800);
  });

  it('goes back to the theme sizes, dropping the changes it made but keeping a style of your own', () => {
    const s0 = starter();
    expect(activeTypeScale(effectiveTokens(s0), themeTokens(s0))).toBe('theme');
    expect(opsFor(s0, 'theme')).toEqual([]);
    let s = apply(s0, opsFor(s0, 'editorial'));
    s = set(s, 'text.h3', { family: 'Lora' });
    const ops = opsFor(s, 'theme');
    s = apply(s, ops);
    // Every style but the one with its own font is the theme's again, with no change left behind.
    expect(Object.keys(s.tokens.overrides)).toEqual(['text.h3']);
    expect(metrics(s, 'text.h3').family).toContain('Lora Variable');
    expect(metrics(s, 'text.h3').size).toBe(textMetrics(themeTokens(s), 'text.h3')!.size);
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s))).toBe('theme');
  });

  it('keeps a font stack written into a style, not just a link to a font', () => {
    let s = set(starter(), 'text.lead', { family: 'Playfair Display' });
    const family = metrics(s, 'text.lead').family;
    expect(String(family)).toContain('Playfair Display Variable');
    s = apply(s, opsFor(s, 'compact'));
    expect(metrics(s, 'text.lead')).toMatchObject({ family, size: scaleMetrics('compact')['text.lead'].size });
  });

  it('writes out a style saved as a link to another, so the one it follows changing cannot carry it along', () => {
    const editorial = scaleMetrics('editorial');
    let s = starter();
    // Heading 2 already has Editorial's Heading 1 metrics, and Heading 1 follows it (a link from an older version).
    s = set(s, 'text.h2', { ...editorial['text.h1'], family: 'Lora' });
    s.tokens.overrides['text.h1'] = { token: 'text.h2' };
    expect(metrics(s, 'text.h1').size).toBe(editorial['text.h1'].size);
    s = apply(s, opsFor(s, 'editorial'));
    expect(metrics(s, 'text.h1')).toMatchObject(editorial['text.h1']);
    expect(metrics(s, 'text.h2')).toMatchObject(editorial['text.h2']);
    // Heading 1 kept the font it followed.
    expect(String(metrics(s, 'text.h1').family)).toContain('Lora Variable');
    expect(sizeAtWidth(metrics(s, 'text.h1').size, 1280)!).toBeGreaterThan(sizeAtWidth(metrics(s, 'text.h2').size, 1280)!);
  });

  it('sets only the styles a theme has', () => {
    const s = starter();
    const fewer: TokenDef[] = themeTokens(s).filter((t) => t.id !== 'text.lead' && t.id !== 'text.small');
    expect(scaleRoles(fewer)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.h3', 'text.body']);
    const ops = typeScaleOps(effectiveTokens(s), fewer, 'compact');
    expect(ops.map((o) => (o as { tokenId: string }).tokenId)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.h3', 'text.body']);
    expect(scaleRoles(themeTokens(s).filter((t) => t.group !== 'text'))).toEqual([]);
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s).filter((t) => t.group !== 'text'))).toBeNull();
  });

  it('writes a whole style out when the one saved cannot be read', () => {
    const s = starter();
    s.tokens.overrides['text.small'] = { size: '0.8rem' } as unknown as TextStyleValue;
    const ops = opsFor(s, 'balanced');
    const small = ops.find((o) => (o as { tokenId: string }).tokenId === 'text.small') as { value: TextStyleValue };
    expect(small.value).toEqual({ ...textMetrics(themeTokens(s), 'text.small'), ...scaleMetrics('balanced')['text.small'] });
    expect(metrics(apply(s, ops), 'text.small')).toMatchObject(scaleMetrics('balanced')['text.small']);
  });
});

describe('font pairings', () => {
  it('offers the pairings whose fonts the theme ships', () => {
    const names = installedFonts(starter()).map((f) => f.name);
    expect(availablePairings(names)).toEqual(FONT_PAIRINGS);
    expect(availablePairings(['Inter', 'fraunces']).map((p) => p.id)).toEqual(['fraunces-inter']);
  });

  it('sets both fonts in one batch, and only the one that changes', () => {
    const s0 = starter();
    const stack = (s: ProjectState, id: string) => String(effectiveTokens(s).find((t) => t.id === id)!.value);
    const pairings = availablePairings(installedFonts(s0).map((f) => f.name));
    expect(activePairing(pairings, stack(s0, 'font.display'), stack(s0, 'font.body'))?.id).toBe('fraunces-inter');
    const playfair = pairings.find((p) => p.id === 'playfair-lora')!;
    const s = apply(s0, pairingOps(playfair, stack(s0, 'font.display'), stack(s0, 'font.body')));
    expect(stack(s, 'font.display')).toContain('Playfair Display Variable');
    expect(stack(s, 'font.body')).toContain('Lora Variable');
    expect(activePairing(pairings, stack(s, 'font.display'), stack(s, 'font.body'))).toBe(playfair);
    expect(pairingOps(playfair, stack(s, 'font.display'), stack(s, 'font.body'))).toEqual([]);
    const loraDm = pairings.find((p) => p.id === 'lora-dm-sans')!;
    expect(pairingOps(loraDm, stack(s, 'font.display'), stack(s, 'font.body'))).toEqual([
      { type: 'token.set', tokenId: 'font.display', value: 'Lora' },
      { type: 'token.set', tokenId: 'font.body', value: 'DM Sans' }
    ]);
    expect(pairingOps(pairings[0], "'Fraunces Variable', serif", "'Lora Variable', serif")).toEqual([{ type: 'token.set', tokenId: 'font.body', value: 'Inter' }]);
  });
});
