/**
 * Search result previews (#597): text is measured by width, as results pages cut it, and cut at a word with "…" on
 * a computer and on a phone; the address line names the host and each folder of the path.
 */
import { describe, expect, it } from 'vitest';
import { fitLines, fitToWidth, SERP_LAYOUT, serpAddress, serpSnippet, textWidth } from '@shared/serp';

describe('textWidth', () => {
  it('measures with Arial’s letter widths at the given size', () => {
    // H 722, e 556, l 222, l 222, o 556 thousandths of the type size.
    expect(textWidth('Hello', 20)).toBeCloseTo(45.56, 2);
    expect(textWidth('WWW', 10)).toBeGreaterThan(textWidth('iii', 10) * 4);
  });

  it('gives accented letters their base letter’s width, joining marks none, and wide scripts and emoji a full square', () => {
    expect(textWidth('é', 20)).toBe(textWidth('e', 20));
    expect(textWidth('é', 20)).toBe(textWidth('e', 20));
    expect(textWidth('東京', 20)).toBe(40);
    expect(textWidth('🙂', 14)).toBe(14);
    expect(textWidth('', 20)).toBe(0);
  });
});

describe('fitToWidth', () => {
  it('keeps text that fits whole, with whitespace collapsed as the page’s head reads', () => {
    expect(fitToWidth('  Pottery   classes ', 20, 600)).toMatchObject({ text: 'Pottery classes', cut: false, max: 600 });
    expect(fitToWidth('', 20, 600)).toMatchObject({ text: '', cut: false, width: 0 });
  });

  it('cuts text too wide at the last whole word, with “…”, and never past the width', () => {
    const long = 'Weekly wheel classes, private lessons and commissioned tableware made to order in the studio by the river';
    const r = fitToWidth(long, 20, 300);
    expect(r.cut).toBe(true);
    expect(r.width).toBeCloseTo(textWidth(long, 20), 5);
    expect(r.text.endsWith('…')).toBe(true);
    expect(textWidth(r.text, 20)).toBeLessThanOrEqual(300);
    // Whole words only, and no comma left hanging before the "…".
    const kept = r.text.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toMatch(/[ ,]/);
    expect(kept).not.toMatch(/[,\s]$/);
  });

  it('cuts mid-word only when not even the first word fits', () => {
    const r = fitToWidth('Supercalifragilisticexpialidocious', 20, 100);
    expect(r.cut).toBe(true);
    expect(textWidth(r.text, 20)).toBeLessThanOrEqual(100);
    expect(r.text).toMatch(/^Super\w*…$/);
  });
});

describe('fitLines', () => {
  const W = 'W'.repeat(16);

  it('wraps a whole word at a time, so a word that doesn’t fit wastes the end of a line and can tip the last one over', () => {
    // Two 302px words and a short one: 628px in all, inside two 320px lines, but the second word starts the second line.
    const text = `${W} ${W} iii`;
    expect(textWidth(text, 20)).toBeLessThan(640);
    const r = fitLines(text, 20, 320, 2);
    expect(r).toMatchObject({ cut: true, max: 640 });
    expect(r.text.startsWith(`${W} `)).toBe(true);
    expect(r.text.endsWith('…')).toBe(true);
    expect(fitLines(`${W} ${W}`, 20, 320, 2)).toMatchObject({ text: `${W} ${W}`, cut: false });
  });

  it('is fitToWidth on one line', () => {
    const long = 'Weekly wheel classes, private lessons and commissioned tableware made to order';
    expect(fitLines(long, 20, 300, 1)).toEqual(fitToWidth(long, 20, 300));
  });

  it('breaks a word wider than a whole line where the line ends, with no space between its halves', () => {
    const word = 'W'.repeat(40);
    const r = fitLines(word, 20, 320, 2);
    expect(r.cut).toBe(true);
    expect(r.text).toMatch(/^W+…$/);
    expect(fitLines('W'.repeat(30), 20, 320, 2)).toMatchObject({ text: 'W'.repeat(30), cut: false });
  });
});

describe('serpSnippet', () => {
  const title = 'Spring pottery classes for beginners, families and groups · Riverside Studio';
  const description = 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing, and every student leaves with a set of bowls and cups.';

  it('cuts a title wider than a computer’s line, and a description past a phone’s three lines but not a computer’s two', () => {
    const s = serpSnippet({ title, description });
    expect(textWidth(title, SERP_LAYOUT.titleFont)).toBeGreaterThan(SERP_LAYOUT.desktop.titleLine);
    expect(s.desktop.title.cut).toBe(true);
    expect(s.desktop.description.cut).toBe(false);
    expect(s.mobile.description.cut).toBe(true);
    expect(s.mobile.description.max).toBe(SERP_LAYOUT.mobile.description);
  });

  it('gives a dated result’s date its room out of the description', () => {
    const plain = serpSnippet({ title, description });
    const dated = serpSnippet({ title, description, datePrefix: '2 March 2027 — ' });
    expect(dated.desktop.description.max).toBeLessThan(plain.desktop.description.max);
    expect(dated.desktop.description.max).toBeCloseTo(SERP_LAYOUT.desktop.description - textWidth('2 March 2027 — ', SERP_LAYOUT.descriptionFont), 5);
  });
});

describe('serpAddress', () => {
  it('names the host and each folder of the public URL, decoded', () => {
    expect(serpAddress('https://example.com/studio/blog/spring-pottery-classes/', '/blog/spring-pottery-classes/')).toEqual({ host: 'example.com', trail: ['studio', 'blog', 'spring-pottery-classes'] });
    expect(serpAddress('https://example.com/caf%C3%A9/', '/café/')).toEqual({ host: 'example.com', trail: ['café'] });
    expect(serpAddress('https://example.com/', '/')).toEqual({ host: 'example.com', trail: [] });
  });

  it('falls back to the route without a public URL', () => {
    expect(serpAddress(null, '/services/kitchens/')).toEqual({ host: null, trail: ['services', 'kitchens'] });
  });
});
