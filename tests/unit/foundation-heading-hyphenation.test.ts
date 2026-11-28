/**
 * A heading word too long for its line (a German compound in the Split hero, issue #1472) hyphenates at a break the
 * page's language allows, where the browser has a dictionary for it, instead of splitting at whatever letter reached
 * the edge. Foundation's headings ask for automatic hyphenation of long words only (12 letters or more), so a shorter
 * word still moves to the next line whole, and `overflow-wrap: anywhere` on the body stays the last resort that keeps
 * a word without a dictionary inside its box.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RELEASES = ['resources/packs/foundation/pack.json', 'resources/packs-dev/foundation-alt/pack.json'];
const browserInstalled = existsSync(chromium.executablePath());

const LONG = 'Hochwasserschutzmaßnahmen';
/** Where German allows the long word to break: Hoch-was-ser-schutz-maß-nah-men. */
const LONG_BREAKS = [4, 7, 10, 16, 19, 22];
/** Those at least 5 letters from either end, as the theme asks. */
const LONG_THEME_BREAKS = [7, 10, 16, 19];
/** Eleven letters, one short of the theme's minimum: German allows Wasser-stand. */
const SHORT = 'Wasserstand';
/** Turns the body's emergency wrapping off, so a word can only break at a hyphen. */
const NO_EMERGENCY = 'h1 { overflow-wrap: normal; }';

const baseCss = (file: string): string => (JSON.parse(readFileSync(file, 'utf8')) as { baseCss: string }).baseCss;

describe.each(RELEASES)('%s', (file) => {
  it('hyphenates long heading words automatically, keeping the break a few letters in from each end', () => {
    const css = baseCss(file);
    const rule = css.match(/(^|\n)h1, h2, h3, h4, h5, h6 \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/-webkit-hyphens: auto;/);
    expect(rule).toMatch(/[^-]hyphens: auto;/);
    expect(rule).toMatch(/hyphenate-limit-chars: 12 5 5;/);
    // Safari versions without hyphenate-limit-chars still keep the break 5 letters in from each end.
    expect(rule).toMatch(/-webkit-hyphenate-limit-before: 5;/);
    expect(rule).toMatch(/-webkit-hyphenate-limit-after: 5;/);
    // The last resort for a word with no dictionary is unchanged.
    expect(css).toMatch(/body \{[^}]*overflow-wrap: anywhere;/);
  });
});

describe.skipIf(!browserInstalled)('a long German heading word in a narrow column', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /**
   * Lays `word` (followed by more words) out in a German `h1` with `css` and then `extra` applied. `index` is the
   * first letter of `word` that starts a new line, or -1 when the word stays on one line.
   */
  async function lay(css: string, word: string, width: number, extra = '') {
    await page.setContent(
      `<!doctype html><html lang="de"><head><style>${css}</style><style>
        body { margin: 0; font-family: Arial, sans-serif; }
        h1 { box-sizing: border-box; width: ${width}px; margin: 0 16px; font-size: 44px; line-height: 1.1; font-weight: 700; }
        ${extra}
      </style></head><body><h1>${word} für das Mündungsgebiet.</h1></body></html>`,
    );
    return page.evaluate((word) => {
      const h1 = document.querySelector('h1')!;
      const text = h1.firstChild as Text;
      // The lines the text up to and including letter i covers. A single letter's own box is no guide: next to a
      // hyphenated break it can report the other line's position.
      const lines = (i: number) => {
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, i + 1);
        return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      };
      let index = -1;
      for (let i = 1; i < word.length; i++) {
        if (lines(i) > 1) {
          index = i;
          break;
        }
      }
      const range = document.createRange();
      range.selectNodeContents(h1);
      const right = Math.max(...[...range.getClientRects()].map((r) => r.right));
      return { index, hyphens: getComputedStyle(h1).hyphens, right, edge: h1.getBoundingClientRect().right };
    }, word);
  }

  /** Whether this browser hyphenates German: with no emergency wrapping, the long word breaks only at a hyphen. */
  async function hasGermanDictionary(): Promise<boolean> {
    const probe = await lay('h1 { hyphens: auto; overflow-wrap: normal; }', LONG, 358);
    if (probe.index === -1) return false;
    // A break anywhere else means the measurement, not the dictionary, is wrong.
    expect(LONG_BREAKS).toContain(probe.index);
    return true;
  }

  it.each(RELEASES)('%s asks for hyphenation on the heading and keeps the word inside it', async (file) => {
    const result = await lay(baseCss(file), LONG, 358);
    expect(result.hyphens).toBe('auto');
    expect(result.index).toBeGreaterThan(0);
    expect(result.right).toBeLessThanOrEqual(result.edge + 0.5);
  });

  it.for(RELEASES)('%s hyphenates the long word where German allows it', async (file, { skip }) => {
    // Playwright's Chromium may ship without a German dictionary (on Linux), and then only the fallback can be seen.
    if (!(await hasGermanDictionary())) skip('this browser has no German hyphenation dictionary');
    const result = await lay(baseCss(file), LONG, 358, NO_EMERGENCY);
    expect(LONG_THEME_BREAKS).toContain(result.index);
    // The same heading without hyphenation does not break the word at all, so the break above was a hyphen.
    const manual = await lay(baseCss(file), LONG, 358, `${NO_EMERGENCY} h1 { hyphens: manual; }`);
    expect(manual.index).toBe(-1);
  });

  it.for(RELEASES)('%s leaves a word shorter than 12 letters whole', async (file, { skip }) => {
    if (!(await hasGermanDictionary())) skip('this browser has no German hyphenation dictionary');
    // The browser alone hyphenates the short word in this column (Wasser-stand)...
    const plain = await lay(`h1 { hyphens: auto; }`, SHORT, 200, NO_EMERGENCY);
    expect(plain.index).toBe(6);
    // ...and the theme moves it to its own line whole.
    const themed = await lay(baseCss(file), SHORT, 200, NO_EMERGENCY);
    expect(themed.index).toBe(-1);
  });
});
