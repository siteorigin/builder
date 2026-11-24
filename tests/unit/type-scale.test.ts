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
import { followedText, isTokenLength, textMetrics } from '@shared/styles';
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
const opsFor = (s: ProjectState, choice: TypeScaleChoice) => typeScaleOps(effectiveTokens(s), themeTokens(s), s.tokens.overrides, choice).ops;
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
    // A size that starts at zero at the narrowest width needs no intercept.
    expect(fluidSize(36, 128)).toBe('clamp(2.25rem, 10vw, 8rem)');
    for (const bad of [[20, 10], [0, 10], [16, Infinity], [16, NaN], [16, 1e9]]) expect(() => fluidSize(bad[0], bad[1]), String(bad)).toThrow();
    expect(() => fluidSize(16, 20, 800, 800)).toThrow();
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
    // Small, large and dynamic viewport widths are the window's width.
    expect(sizeAtWidth('clamp(16px, 2dvw, 32px)', 1280)).toBeCloseTo(25.6, 5);
    expect(sizeAtWidth('CLAMP(1REM, 1REM + 1SVW, 3REM)', 1000)).toBeCloseTo(26, 5);
    expect(sizeAtWidth('clamp(1rem, 1rem + 1lvw, 3rem)', 1000)).toBeCloseTo(26, 5);
    for (const v of ['calc(1rem + 2vw)', 'min(2rem, 5vw)', 'clamp(1rem, var(--x), 2rem)', 'clamp(1rem, 1rem 2vw, 4rem)', 'clamp(1rem, 2vw +, 4rem)', 'large', ''])
      expect(sizeAtWidth(v, 375), v).toBeNull();
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
        expect(size, where).toMatch(min === max ? /^[\d.]+rem$/ : /^clamp\(/);
        expect(Number.isInteger(min) && Number.isInteger(max), `${where}: whole pixels, so the size fields show both ends exactly`).toBe(true);
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
    for (let i = 1; i < display.length; i++) expect(display[i]).toBeGreaterThan(display[i - 1]);
    // The approved ends of a few styles, pinned apart from the table they are written from.
    expect(scaleMetrics('balanced')['text.h3'].size).toBe(fluidSize(19, 22));
    expect(scaleMetrics('editorial')['text.h2'].size).toBe(fluidSize(26, 40));
    expect(scaleMetrics('bold-display')['text.display'].size).toBe('clamp(2.625rem, 1.0109rem + 7.1739vw, 6.75rem)');
    expect(scaleMetrics('compact')['text.body'].size).toBe('1rem');
  });
});

describe('applying a type scale', () => {
  it('sets the size, line height and spacing of every scaled style in one batch, keeping fonts, weights and case', () => {
    let s0 = apply(starter(), [{ type: 'token.create', group: 'text', label: 'Callout', value: { family: { token: 'font.body' }, size: '1.4rem', lineHeight: '1.3', weight: 500, tracking: '0em' } }]);
    s0 = set(s0, 'text.h2', { transform: 'uppercase' });
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
    expect(metrics(s, 'text.h2').transform).toBe('uppercase');
    expect(s.tokens.custom).toEqual(s0.tokens.custom);
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
    expect((await session.apply({ operations: [{ type: 'token.set', tokenId: 'text.h2', value: { weight: 600 } }] }, { label: 'Bolder headings' })).ok).toBe(true);
    const before = structuredClone(session.state.tokens);
    const r = await session.apply({ operations: opsFor(session.state, 'bold-display') }, { label: 'Use the Bold display type scale' });
    expect(r.ok).toBe(true);
    expect(metrics(session.state, 'text.h2')).toMatchObject({ weight: 600, ...scaleMetrics('bold-display')['text.h2'] });
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
    const compact = scaleMetrics('compact')['text.h1'];
    // Each metric goes back on its own, leaving the others as the scale set them.
    s = set(s, 'text.h1', { lineHeight: theme.lineHeight });
    expect(metrics(s, 'text.h1')).toMatchObject({ lineHeight: theme.lineHeight, tracking: compact.tracking });
    s = set(s, 'text.h1', { tracking: theme.tracking });
    expect(metrics(s, 'text.h1')).toMatchObject({ lineHeight: theme.lineHeight, tracking: theme.tracking, size: 'clamp(2rem, 1rem + 3vw, 4rem)' });
    s = set(s, 'text.h1', { size: theme.size });
    expect(metrics(s, 'text.h1')).toEqual(theme);
    s = set(s, 'text.body', null);
    expect(s.tokens.overrides['text.body']).toBeUndefined();
    expect(metrics(s, 'text.body')).toEqual(textMetrics(themeTokens(s), 'text.body'));
  });

  it('applies again as nothing, and a weight or font of its own keeps the scale', () => {
    let s = apply(starter(), opsFor(starter(), 'balanced'));
    expect(opsFor(s, 'balanced')).toEqual([]);
    s = set(s, 'text.display', { weight: 800 });
    s = set(s, 'text.h2', { family: 'Space Grotesk' });
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
    // A weight of its own is a change the theme's scale keeps.
    s = set(s, 'text.h2', { weight: 700 });
    s = apply(s, opsFor(s, 'theme'));
    expect(metrics(s, 'text.h2').weight).toBe(700);
  });

  it("clears a change that only repeats the theme when the theme's scale is chosen", () => {
    const s0 = starter();
    const theme = textMetrics(themeTokens(s0), 'text.h3')!;
    const s = apply(s0, [{ type: 'token.set', tokenId: 'text.h3', value: { ...theme } }]);
    expect(s.tokens.overrides['text.h3']).toBeDefined();
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s))).toBe('theme');
    expect(opsFor(s, 'theme')).toEqual([{ type: 'token.set', tokenId: 'text.h3', value: null }]);
    // A preset leaves it alone where it already matches: nothing to undo for a change nobody sees.
    const balanced = apply(s, opsFor(s, 'balanced'));
    expect(opsFor(balanced, 'balanced')).toEqual([]);
  });

  it("leaves a style the theme writes as a link following it when the theme's scale is chosen", () => {
    const s = starter();
    const linked: TokenDef[] = themeTokens(s).map((t) => (t.id === 'text.h3' ? { ...t, value: { token: 'text.h2' } } : t));
    // Untouched: the theme's own scale has nothing to do, and the link is kept.
    expect(typeScaleOps(linked, linked, {}, 'theme')).toEqual({ ops: [], unscalable: [] });
    expect(activeTypeScale(linked, linked)).toBe('theme');
    // A preset has to give it its own sizes; the engine writes it out with the font and weight it showed.
    const h3 = typeScaleOps(linked, linked, {}, 'editorial').ops.find((o) => (o as { tokenId: string }).tokenId === 'text.h3') as { value: TextStyleValue };
    expect(h3.value).toEqual(scaleMetrics('editorial')['text.h3']);
  });

  it("never sends a style back to a link of the theme's, which could follow a style the scale does not set", () => {
    const s = starter();
    const linked: TokenDef[] = themeTokens(s).map((t) => (t.id === 'text.h3' ? { ...t, value: { token: 'text.eyebrow' } } : t));
    const eyebrow = textMetrics(linked, 'text.eyebrow')!;
    // Heading 3 has its own value now, with the theme's sizes; the eyebrow style it would follow has been made heavier.
    const overrides = { 'text.h3': { ...eyebrow }, 'text.eyebrow': { ...eyebrow, weight: 800 } };
    const tokens = linked.map((t) => (t.id in overrides ? { ...t, value: overrides[t.id as keyof typeof overrides] } : t));
    expect(typeScaleOps(tokens, linked, overrides, 'theme').ops).toEqual([]);
    // Untouched, but following a style that was changed: the theme's scale writes the theme's sizes out.
    const followsBig = { 'text.eyebrow': { ...eyebrow, size: '3rem' } };
    const viaLink = linked.map((t) => (t.id === 'text.eyebrow' ? { ...t, value: followsBig['text.eyebrow'] } : t));
    expect(typeScaleOps(viaLink, linked, followsBig, 'theme').ops).toEqual([{ type: 'token.set', tokenId: 'text.h3', value: { size: eyebrow.size, lineHeight: eyebrow.lineHeight, tracking: eyebrow.tracking } }]);
    const toBig = { ...overrides, 'text.h3': { ...eyebrow, size: '3rem' } };
    const h3 = typeScaleOps(linked.map((t) => (t.id in toBig ? { ...t, value: toBig[t.id as keyof typeof toBig] } : t)), linked, toBig, 'theme').ops;
    expect(h3).toEqual([{ type: 'token.set', tokenId: 'text.h3', value: { size: eyebrow.size, lineHeight: eyebrow.lineHeight, tracking: eyebrow.tracking } }]);
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

  it('keeps the font of a style that followed a broken link through a style repaired earlier in the batch', () => {
    let s = starter();
    const h3 = textMetrics(themeTokens(s), 'text.h3')!;
    // Heading 1 follows a style that is gone, so it shows the theme's own; Heading 3 follows Heading 1, so it shows its own too.
    s.tokens.overrides['text.h1'] = { token: 'text.missing' };
    s.tokens.overrides['text.h3'] = { token: 'text.h1' };
    expect(metrics(s, 'text.h3')).toMatchObject({ family: h3.family, weight: h3.weight });
    s = apply(s, opsFor(s, 'editorial'));
    expect(metrics(s, 'text.h1')).toMatchObject({ family: { token: 'font.display' }, ...scaleMetrics('editorial')['text.h1'] });
    expect(metrics(s, 'text.h3')).toMatchObject({ family: { token: 'font.body' }, weight: 600, ...scaleMetrics('editorial')['text.h3'] });
  });

  it('writes a style out before the style it follows changes, keeping its font, weight and case', () => {
    let s = starter();
    const h1 = textMetrics(themeTokens(s), 'text.h1')!;
    // Heading 1 follows Heading 2, which shows uppercase in a font of its own; Heading 2 then takes Compact's sizes.
    s = set(s, 'text.h2', { family: 'Lora', transform: 'uppercase', weight: 700 });
    s.tokens.overrides['text.h1'] = { token: 'text.h2' };
    const shown = metrics(s, 'text.h1');
    s = apply(s, opsFor(s, 'compact'));
    expect(metrics(s, 'text.h1')).toEqual({ ...shown, ...scaleMetrics('compact')['text.h1'] });
    expect(metrics(s, 'text.h1').family).not.toEqual(h1.family);
  });

  it('breaks a loop of saved links first, so the engine takes the batch', () => {
    let s = starter();
    const h3 = textMetrics(themeTokens(s), 'text.h3')!;
    // Display and Heading 1 follow each other (as no edit can save, but a hand-edited file can), and Heading 3 follows Display.
    s.tokens.overrides['text.display'] = { token: 'text.h1' };
    s.tokens.overrides['text.h1'] = { token: 'text.display' };
    s.tokens.overrides['text.h3'] = { token: 'text.display' };
    // A link that leads round in a loop shows the theme's own metrics: the body font at 600 for Heading 3.
    expect(metrics(s, 'text.h3')).toMatchObject({ family: { token: 'font.body' }, weight: 600 });
    const ops = opsFor(s, 'editorial');
    expect((ops[0] as { tokenId: string }).tokenId).toBe('text.display');
    s = apply(s, ops);
    for (const role of ['text.display', 'text.h1', 'text.h3'] as const) expect(metrics(s, role), role).toMatchObject(scaleMetrics('editorial')[role]);
    // Heading 3 keeps the font and weight it showed, not those of Display, which it would follow once the loop is gone.
    expect(metrics(s, 'text.h3')).toMatchObject({ family: h3.family, weight: h3.weight });
  });

  it('sends none for a letter case saved as something other than text, which the engine would refuse to keep', () => {
    for (const saved of [
      { family: 'Georgia, serif', size: '0.8rem', lineHeight: '1.4', weight: 700, tracking: '0em', transform: null },
      { family: 'Georgia, serif', size: '0.8rem', weight: 700, transform: null }
    ]) {
      const s = starter();
      s.tokens.overrides['text.small'] = saved as unknown as TextStyleValue;
      for (const choice of ['balanced', 'theme'] as const) {
        const ops = opsFor(s, choice);
        expect(ops.find((o) => (o as { tokenId: string }).tokenId === 'text.small'), `${choice}`).toMatchObject({ value: { transform: 'none' } });
        expect(metrics(apply(s, ops), 'text.small'), choice).toMatchObject({ family: 'Georgia, serif', weight: 700, transform: 'none' });
      }
    }
  });

  it('sets only the styles a theme has', () => {
    const s = starter();
    const fewer: TokenDef[] = themeTokens(s).filter((t) => t.id !== 'text.lead' && t.id !== 'text.small');
    expect(scaleRoles(fewer)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.h3', 'text.body']);
    const ops = typeScaleOps(effectiveTokens(s), fewer, {}, 'compact').ops;
    expect(ops.map((o) => (o as { tokenId: string }).tokenId)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.h3', 'text.body']);
    expect(scaleRoles(themeTokens(s).filter((t) => t.group !== 'text'))).toEqual([]);
    expect(activeTypeScale(effectiveTokens(s), themeTokens(s).filter((t) => t.group !== 'text'))).toBeNull();
    // An ID used for another kind of style, or a text style the theme cannot write out, is not a style to scale.
    const odd: TokenDef[] = themeTokens(s).map((t) => (t.id === 'text.h3' ? { ...t, group: 'space', value: '1rem' } : t.id === 'text.lead' ? { ...t, value: { token: 'text.gone' } } : t));
    expect(scaleRoles(odd)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.body', 'text.small']);
    expect(typeScaleOps(odd, odd, {}, 'compact').ops.map((o) => (o as { tokenId: string }).tokenId)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.body', 'text.small']);
    // The theme's own scale is named only when every style it has matches, not some of them.
    expect(activeTypeScale(odd, odd)).toBe('theme');
    const one = odd.map((t) => (t.id === 'text.body' ? { ...t, value: { ...(t.value as TextStyleValue), size: '1.1rem' } } : t));
    expect(activeTypeScale(one, odd)).toBeNull();
    // A style the theme cannot write out that the project gave a value of its own is scaled, and keeps the theme's scale from matching.
    const lead = textMetrics(themeTokens(s), 'text.lead')!;
    const own = odd.map((t) => (t.id === 'text.lead' ? { ...t, value: lead } : t));
    expect(scaleRoles(odd, own)).toContain('text.lead');
    expect(typeScaleOps(own, odd, { 'text.lead': lead }, 'compact').ops.map((o) => (o as { tokenId: string }).tokenId)).toContain('text.lead');
    expect(activeTypeScale(own, odd)).toBeNull();
    // The theme has no sizes of its own to give it, so choosing the theme's reports it rather than quietly skipping it.
    expect(typeScaleOps(own, odd, { 'text.lead': lead }, 'theme').unscalable).toEqual(['text.lead']);
  });

  it('writes a whole style out when the one saved cannot be read, keeping what it saved that reads', () => {
    const s = starter();
    const georgia = 'Georgia, serif';
    s.tokens.overrides['text.small'] = { family: georgia, size: '0.8rem', lineHeight: '1.4', weight: 700 } as unknown as TextStyleValue;
    const ops = opsFor(s, 'balanced');
    const small = ops.find((o) => (o as { tokenId: string }).tokenId === 'text.small') as { value: TextStyleValue };
    // Only what the engine cannot keep from the saved style is sent.
    expect(small.value).toEqual(scaleMetrics('balanced')['text.small']);
    expect(metrics(apply(s, ops), 'text.small')).toMatchObject({ family: georgia, weight: 700, ...scaleMetrics('balanced')['text.small'] });
    // The theme's own scale repairs it too, rather than taking the theme's sizes it shows for a match.
    const back = apply(s, opsFor(s, 'theme'));
    expect(metrics(back, 'text.small')).toMatchObject({ family: georgia, weight: 700, size: textMetrics(themeTokens(s), 'text.small')!.size });
    // A saved style without a font takes the theme's.
    const fontless = starter();
    fontless.tokens.overrides['text.small'] = { size: '0.8rem', weight: 700 } as unknown as TextStyleValue;
    const sent = (opsFor(fontless, 'balanced').find((o) => (o as { tokenId: string }).tokenId === 'text.small') as { value: Record<string, unknown> }).value;
    expect(sent).toEqual({ family: { token: 'font.body' }, ...scaleMetrics('balanced')['text.small'] });
    expect(metrics(apply(fontless, opsFor(fontless, 'balanced')), 'text.small')).toMatchObject({ family: { token: 'font.body' }, weight: 700 });
  });

  it('leaves out a style whose font or case would be refused, so the rest still applies', () => {
    const s = starter();
    s.tokens.overrides['text.h3'] = { ...textMetrics(themeTokens(s), 'text.h3')!, transform: 'full-width' };
    s.tokens.overrides['text.lead'] = { ...textMetrics(themeTokens(s), 'text.lead')!, family: { token: 'font.gone' } };
    const { ops, unscalable } = typeScaleOps(effectiveTokens(s), themeTokens(s), s.tokens.overrides, 'compact');
    expect(unscalable).toEqual(['text.h3', 'text.lead']);
    expect(ops.map((o) => (o as { tokenId: string }).tokenId)).toEqual(['text.display', 'text.h1', 'text.h2', 'text.body', 'text.small']);
    expect(() => applyOperations(s, ops)).not.toThrow();
    // A style that already has the scale needs no change, whatever it holds.
    const done = starter();
    done.tokens.overrides['text.h3'] = { ...textMetrics(themeTokens(done), 'text.h3')!, ...scaleMetrics('compact')['text.h3'], transform: 'full-width' };
    expect(typeScaleOps(effectiveTokens(done), themeTokens(done), done.tokens.overrides, 'compact').unscalable).toEqual([]);
  });
});

describe('font pairings', () => {
  it('offers the pairings whose fonts the theme ships, with their stacks', () => {
    const fonts = installedFonts(starter());
    const pairings = availablePairings(fonts);
    expect(pairings.map((p) => p.id)).toEqual(['fraunces-inter', 'playfair-lora', 'lora-dm-sans', 'space-grotesk-dm-sans', 'jakarta-inter']);
    expect(pairings.map(({ displayStack: _d, bodyStack: _b, ...p }) => p)).toEqual(FONT_PAIRINGS);
    expect(pairings[1].displayStack).toBe(fonts.find((f) => f.name === 'Playfair Display')!.stack);
    const only = (names: string[]) => fonts.filter((f) => names.includes(f.name));
    expect(availablePairings(only(['Inter', 'Fraunces'])).map((p) => p.id)).toEqual(['fraunces-inter']);
    // Both fonts are needed.
    expect(availablePairings(only(['Fraunces', 'Playfair Display', 'Space Grotesk']))).toEqual([]);
  });

  it('sets both fonts in one batch, and only the one that changes', () => {
    const s0 = starter();
    const stack = (s: ProjectState, id: string) => followedText(effectiveTokens(s), id);
    const pairings = availablePairings(installedFonts(s0));
    const by = (id: string) => pairings.find((p) => p.id === id)!;
    expect(activePairing(pairings, stack(s0, 'font.display'), stack(s0, 'font.body'))?.id).toBe('fraunces-inter');
    const playfair = by('playfair-lora');
    const s = apply(s0, pairingOps(playfair, effectiveTokens(s0)));
    expect(stack(s, 'font.display')).toBe(playfair.displayStack);
    expect(stack(s, 'font.body')).toBe(playfair.bodyStack);
    expect(activePairing(pairings, stack(s, 'font.display'), stack(s, 'font.body'))).toBe(playfair);
    expect(pairingOps(playfair, effectiveTokens(s))).toEqual([]);
    expect(pairingOps(by('lora-dm-sans'), effectiveTokens(s))).toEqual([
      { type: 'token.set', tokenId: 'font.display', value: by('lora-dm-sans').displayStack },
      { type: 'token.set', tokenId: 'font.body', value: by('lora-dm-sans').bodyStack }
    ]);
    // A matching display font with another body font is not the pairing.
    expect(activePairing(pairings, playfair.displayStack, by('fraunces-inter').bodyStack)).toBeNull();
    expect(pairingOps(by('fraunces-inter'), effectiveTokens(s0))).toEqual([]);
  });

  it('sets a font that follows the other one, so both end up as the pairing', () => {
    let s = set(starter(), 'font.body', 'Lora');
    s = set(s, 'font.display', { token: 'font.body' });
    const pairings = availablePairings(installedFonts(s));
    const loraDm = pairings.find((p) => p.id === 'lora-dm-sans')!;
    s = apply(s, pairingOps(loraDm, effectiveTokens(s)));
    expect(followedText(effectiveTokens(s), 'font.display')).toBe(loraDm.displayStack);
    expect(followedText(effectiveTokens(s), 'font.body')).toBe(loraDm.bodyStack);
  });

  it('names a font whose stack is longer than a font style takes', () => {
    const long = { ...availablePairings(installedFonts(starter()))[1], displayStack: `'Playfair Display Variable', ${Array.from({ length: 30 }, (_, i) => `'Fallback ${i}'`).join(', ')}, serif` };
    expect(long.displayStack.length).toBeGreaterThan(200);
    expect(pairingOps(long, effectiveTokens(starter()))[0]).toEqual({ type: 'token.set', tokenId: 'font.display', value: 'Playfair Display' });
  });

  it('names a font whose stack has characters a font style does not take', () => {
    const odd = { ...availablePairings(installedFonts(starter()))[1], displayStack: "'Playfair Display Variable', 'A+B', serif" };
    expect(pairingOps(odd, effectiveTokens(starter()))[0]).toEqual({ type: 'token.set', tokenId: 'font.display', value: 'Playfair Display' });
  });

  it('tells a shipped font from a project font of the same name', () => {
    const pairings = availablePairings(installedFonts(starter()));
    const fraunces = pairings[0];
    // A project's own font called Inter, as its stack starts.
    expect(activePairing(pairings, fraunces.displayStack, "'Inter', system-ui, sans-serif")).toBeNull();
    expect(pairingOps(fraunces, [{ id: 'font.display', label: 'Display', group: 'font', value: fraunces.displayStack }, { id: 'font.body', label: 'Body', group: 'font', value: "'Inter', sans-serif" }])).toEqual([
      { type: 'token.set', tokenId: 'font.body', value: fraunces.bodyStack }
    ]);
  });
});
