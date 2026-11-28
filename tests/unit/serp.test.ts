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

  it('measures a joined emoji or a flag as the one picture a reader sees, and Hebrew points as no room', () => {
    expect(textWidth('👨‍👩‍👧‍👦', 20)).toBe(20);
    expect(textWidth('👍🏽', 20)).toBe(20);
    expect(textWidth('🇦🇺', 20)).toBe(20);
    expect(textWidth('שָׁלוֹם', 14)).toBe(textWidth('שלום', 14));
    expect(textWidth('Hi', 14)).toBeCloseTo(((722 + 222) * 14) / 1000, 5);
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

  it('keeps text exactly as wide as the room whole', () => {
    const text = 'Pottery classes by the river';
    expect(fitToWidth(text, 20, textWidth(text, 20))).toMatchObject({ text, cut: false });
    expect(fitToWidth(text, 20, textWidth(text, 20) - 0.01).cut).toBe(true);
  });

  it('keeps as many whole words as fit with the “…”, and no fewer', () => {
    const long = 'Weekly wheel classes, private lessons and commissioned tableware made to order in the studio by the river';
    const r = fitToWidth(long, 20, 300);
    const kept = r.text.slice(0, -1);
    const next = long.slice(0, long.indexOf(' ', kept.length + 1));
    // One word more would not have fitted with the "…".
    expect(textWidth(`${next}…`, 20)).toBeGreaterThan(300);
    expect(kept).toBe('Weekly wheel classes, private');
  });

  it('never cuts inside a joined emoji', () => {
    const family = '👨‍👩‍👧‍👦';
    const r = fitToWidth(family.repeat(40), 20, 300);
    expect(r.cut).toBe(true);
    const kept = r.text.slice(0, -1);
    expect(kept.length % family.length).toBe(0);
    expect(kept.split(family).every((part) => part === '')).toBe(true);
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
    // The second line holds the second word cut to fit with its "…" (it has no space to go back to).
    expect(r.lines).toEqual([W, `${'W'.repeat(15)}…`]);
    expect(r.text).toBe(`${W} ${'W'.repeat(15)}…`);
    expect(fitLines(`${W} ${W}`, 20, 320, 2)).toMatchObject({ text: `${W} ${W}`, lines: [W, W], cut: false });
    expect(fitLines('', 20, 320, 2)).toMatchObject({ text: '', lines: [], cut: false });
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
    expect(fitLines('W'.repeat(30), 20, 320, 2)).toMatchObject({ text: 'W'.repeat(30), lines: ['W'.repeat(16), 'W'.repeat(14)], cut: false });
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

  it('takes the date’s room on a phone too', () => {
    const dated = serpSnippet({ title, description, datePrefix: '2 March 2027 — ' });
    expect(dated.mobile.description.max).toBeCloseTo(SERP_LAYOUT.mobile.description - textWidth('2 March 2027 — ', SERP_LAYOUT.descriptionFont), 5);
  });

  it('can fit a title on a computer’s line that a phone’s two lines cut, since a phone wraps a word at a time', () => {
    const ten = 'W'.repeat(10);
    const s = serpSnippet({ title: `${ten} ${ten} ${ten}`, description: '' });
    expect(s.desktop.title).toMatchObject({ cut: false, lines: [`${ten} ${ten} ${ten}`] });
    expect(s.mobile.title.cut).toBe(true);
    expect(s.mobile.title.lines[0]).toBe(ten);
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

  it('keeps a port in the host, and falls back to the route for an address it can’t read', () => {
    expect(serpAddress('https://studio.example:8443/work/kitchens/', '/kitchens/')).toEqual({ host: 'studio.example:8443', trail: ['work', 'kitchens'] });
    expect(serpAddress('not a url', '/kitchens/')).toEqual({ host: null, trail: ['kitchens'] });
    expect(serpAddress(null, '/bad%E0%A4%A/')).toEqual({ host: null, trail: ['bad%E0%A4%A'] });
  });
});

describe('Chinese and Japanese titles (#1446)', () => {
  const ja = '2026 冬の港で家族と楽しむ体験講座と展覧会の案内受付時間と参加方法';
  const zh = '2026 海滨博物馆冬季展览与亲子体验课程开放报名和参观时间交通指引';

  it('breaks between Chinese and Japanese letters, so a spaced year does not discard the phrase', () => {
    for (const title of [ja, zh]) {
      const r = fitToWidth(title, SERP_LAYOUT.titleFont, SERP_LAYOUT.desktop.titleLine);
      expect(r.cut).toBe(true);
      expect(r.text.length).toBeGreaterThan(20);
      expect(textWidth(r.text, SERP_LAYOUT.titleFont)).toBeLessThanOrEqual(SERP_LAYOUT.desktop.titleLine);
    }
  });

  it('wraps the phone title across both lines instead of leaving the year alone on the first', () => {
    for (const title of [ja, zh]) {
      const r = fitLines(title, SERP_LAYOUT.titleFont, SERP_LAYOUT.mobile.titleLine, SERP_LAYOUT.mobile.titleLines);
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0].length).toBeGreaterThan(10);
      expect(textWidth(r.lines[0], SERP_LAYOUT.titleFont)).toBeLessThanOrEqual(SERP_LAYOUT.mobile.titleLine);
    }
  });

  it('matches the unspaced title’s line width, and keeps latin words whole', () => {
    const spaced = fitToWidth(ja, 20, 600).text;
    const joined = fitToWidth(ja.replace(' ', ''), 20, 600).text;
    expect(Math.abs(spaced.length - joined.length)).toBeLessThanOrEqual(2);
    const mixed = fitToWidth('冬の港 Weekly classes と展覧会の案内受付時間と参加方法を掲載しています', 20, 330).text;
    expect(mixed).not.toMatch(/Wee…|Weekl…/);
  });

  it('breaks halfwidth katakana, keeps fullwidth numbers whole, and adds no second “…”', () => {
    const half = fitToWidth('2026 ' + 'ﾄｳｷｮｳﾉﾌﾕﾉﾐﾅﾄ'.repeat(5), 20, 600);
    expect(half.text.length).toBeGreaterThan(10);
    const full = fitLines('2026 ' + '冬'.repeat(12) + '２０２６年の展示会日程', 20, 320, 2);
    expect(full.lines[0].endsWith('２')).toBe(false);
    expect(fitToWidth('2026 ' + 'あ'.repeat(24) + '……' + 'い'.repeat(10), 20, 600).text).not.toMatch(/…{3}$/);
    expect(fitLines('あ'.repeat(15) + '九％割引のお知らせ', 20, 320, 2).lines[1]?.[0]).not.toBe('％');
  });

  it('never starts a line with closing punctuation', () => {
    const r = fitLines('あ'.repeat(15) + '。' + 'い'.repeat(30), 20, 300, 2);
    expect(r.lines[1]?.[0]).not.toBe('。');
  });
});
