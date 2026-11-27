/**
 * Site styles' contrast notes: what a colour that is hard to read somewhere says under its row and under the Brand
 * shortcut, the fix it owns before any offer, what an offer costs before it is taken, the "Show all" control's state,
 * and what is said when a colour cannot be measured.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenDef } from '@shared/types';
import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_TOKENS } from '../../src/catalogue/foundation/tokens';
import { FOUNDATION_CONTRAST_PAIRS } from '../../src/catalogue/foundation/contrast';

/** Renderer code, outside the Node type-check project: loaded by path at run time. */
const NOTES_PATH = '../../src/renderer/src/panels/ContrastNotes';
type Model = { results: unknown[] };
type FlagProps = { model: Model; tokenId: string; onUse: () => void; onJump?: () => void; onShowAll?: () => void; expanded?: boolean; controls?: string };
let buildContrastModel: (tokens: TokenDef[], pairs: readonly ContrastPair[]) => Model;
let ContrastFlags: FunctionComponent<FlagProps>;
let BrandContrast: FunctionComponent<{ model: Model; onUse: () => void; onJump?: () => void }>;

beforeAll(async () => {
  ({ buildContrastModel, ContrastFlags, BrandContrast } = (await import(/* @vite-ignore */ NOTES_PATH)) as {
    buildContrastModel: typeof buildContrastModel;
    ContrastFlags: typeof ContrastFlags;
    BrandContrast: typeof BrandContrast;
  });
});

const model = (values: Record<string, string>) => buildContrastModel(FOUNDATION_TOKENS.map((t) => (t.id in values ? { ...t, value: values[t.id] } : t)), FOUNDATION_CONTRAST_PAIRS);
const noop = () => undefined;
/** The rendered text, tags dropped, as a reader meets it. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|’/g, "'");
const flags = (m: Model, tokenId: string, extra: Partial<FlagProps> = {}) => renderToStaticMarkup(createElement(ContrastFlags, { model: m, tokenId, onUse: noop, onJump: noop, ...extra }));

describe('the Brand shortcut in Basics', () => {
  const yellow = () => renderToStaticMarkup(createElement(BrandContrast, { model: model({ 'color.brand': '#f4d35e' }), onUse: noop, onJump: noop }));

  it('gives each preview its ratio and, when it fails, the ratio it needs', () => {
    const t = text(yellow());
    expect(t).toContain('1.46:1Needs 4.5:1');
    expect(t).toContain('10.92:1Readable');
  });

  it('leads with the brand colour’s own fix, and says what else it fixes', () => {
    const t = text(yellow());
    expect(t).toContain('Darken the brand color until links and text buttons reach 4.5:1 on alternate sections, the hardest background (now 1.27:1). That fixes button text too.');
  });

  it('offers a readable button text as the other route, with its cost before the button', () => {
    const html = yellow();
    const t = text(html);
    const trade = 'To keep the brand color as it is: dark text fixes button text, but makes button text on hover and light button text (at rest and on hover) hard to read. Links stay hard to read.';
    expect(t).toContain(trade);
    expect(t.indexOf(trade)).toBeLessThan(t.indexOf('Use dark button text'));
    expect(t.indexOf('Darken the brand color')).toBeLessThan(t.indexOf(trade));
    expect(t).toContain('Change Brand (strong) to fix what dark text breaks.');
    // The value it sets is on the button, not only in a tooltip.
    expect(html).toMatch(/<button type="button" class="btn btn-sm"[^>]*>.*Use dark button text.*#14181a<\/span><\/button>/);
    expect(html).not.toMatch(/title="#14181a"/);
  });

  it('says when brand-coloured links sit on a background that cannot be measured', () => {
    const t = text(renderToStaticMarkup(createElement(BrandContrast, { model: model({ 'color.surface': 'currentColor' }), onUse: noop, onJump: noop })));
    expect(t).toContain("Links on cards and panels can't be checked until Cards and panels has a plain color.");
  });
});

describe('the notes under a colour’s row', () => {
  it('flags the worst case in plain words and points a background’s row to the colour that has the fix', () => {
    const m = model({ 'color.text': '#8d8d8d' });
    expect(text(flags(m, 'color.text'))).toContain('Text on alternate sections is hard to read: 2.89:1, needs 4.5:1. Also low in 2 other places.');
    expect(text(flags(m, 'color.text'))).toContain('Dark text fixes text on all 3 backgrounds.');
    expect(text(flags(m, 'color.text'))).toContain('Use dark text for Primary text');
    expect(text(flags(m, 'color.surface-alt'))).toContain('A fix is offered on Primary text.');
  });

  it('makes "Show all" a disclosure while the details are closed, and only a jump once they are open', () => {
    const m = model({ 'color.text': '#8d8d8d' });
    const closed = flags(m, 'color.text', { onShowAll: noop, expanded: false, controls: 'detail-1' });
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="detail-1"[^>]*>Show all/);
    const open = flags(m, 'color.text', { onShowAll: noop, expanded: true, controls: 'detail-1' });
    expect(open).toContain('See the list below');
    expect(open).not.toContain('aria-expanded');
  });

  it('says only what the checker established when a background cannot be measured', () => {
    const m = model({ 'color.text': '#8d8d8d', 'color.surface': 'currentColor' });
    const t = text(flags(m, 'color.text'));
    expect(t).toContain("No readable text color can be worked out while Cards and panels can't be checked. Give it a plain color first.");
    expect(t).not.toContain('No single');
  });

  it('is not silent about a colour whose only trouble is a pair that cannot be measured', () => {
    const m = model({ 'color.surface': 'currentColor' });
    expect(text(flags(m, 'color.muted'))).toContain("Muted text on cards and panels can't be checked until Cards and panels has a plain color.");
    expect(flags(model({}), 'color.muted')).toBe('');
  });
});
