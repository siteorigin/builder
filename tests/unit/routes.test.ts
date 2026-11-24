import { describe, expect, it } from 'vitest';
import { addressSlug, normalizeRoute, numberedSlug, readablePath, routeUrl, slugify, suggestRoute, validateRoute } from '@shared/routes';

describe('slugify', () => {
  it('never ends in a hyphen once cut to 60 characters', () => {
    // Character 60 of the slug is the hyphen between two words.
    const title = `${'a'.repeat(59)} b`;
    expect(slugify(title)).toBe('a'.repeat(59));
    for (let n = 50; n <= 70; n++) {
      const slug = slugify(`${'word '.repeat(20)}`.slice(0, n) + ' tail and more words');
      expect(slug, String(n)).not.toMatch(/^-|-$/);
      expect(slug.length).toBeLessThanOrEqual(60);
    }
  });

  it('keeps short slugs as they were', () => {
    expect(slugify('  Café & Bar!  ')).toBe('cafe-and-bar');
    expect(slugify('---')).toBe('');
    // Compatibility characters fold to their plain letters.
    expect(slugify('Oﬃce Hours')).toBe('office-hours');
    // Exactly 60 characters, when the cut lands inside a word.
    expect(slugify('b'.repeat(70))).toBe('b'.repeat(60));
  });
});

describe('normalizeRoute', () => {
  it('turns spaces and accents in an address someone types into a valid route', () => {
    expect(normalizeRoute('About Us')).toBe('/about-us/');
    expect(normalizeRoute('/Our  Team / Café Menu/')).toBe('/our-team/cafe-menu/');
    expect(normalizeRoute(' Crème Brûlée ')).toBe('/creme-brulee/');
    for (const typed of ['About Us', '/Our  Team / Café Menu/', ' Crème Brûlée ']) expect(validateRoute(normalizeRoute(typed)), typed).toBeNull();
    // Space left once the accents are gone is trimmed too, and a segment of spaces is no segment.
    expect(normalizeRoute('/\u0301 Café \u0301/')).toBe('/cafe/');
    expect(normalizeRoute('/services/  /web-design/')).toBe('/services/web-design/');
  });

  it('leaves routes that were already valid as they are', () => {
    expect(normalizeRoute('/')).toBe('/');
    expect(normalizeRoute('')).toBe('/');
    expect(normalizeRoute('/services/web-design/')).toBe('/services/web-design/');
    expect(normalizeRoute('Services/Web-Design')).toBe('/services/web-design/');
  });

  it('still lets validation refuse what it cannot clean up', () => {
    // A reserved or hidden name is never quietly turned into an ordinary one.
    expect(normalizeRoute('/_app/')).toBe('/_app/');
    expect(validateRoute(normalizeRoute('/_app/'))).not.toBeNull();
    expect(validateRoute(normalizeRoute('/a/../b/'))).toMatch(/"\."/);
    expect(validateRoute(normalizeRoute('/a&b/'))).toMatch(/may only contain/);
    // A full-width slash is not a folder, and a segment of accents alone is not the Home page.
    expect(normalizeRoute('/a／b/')).toBe('/a／b/');
    expect(validateRoute(normalizeRoute('/a／b/'))).toMatch(/may only contain/);
    expect(normalizeRoute('/\u0301/')).not.toBe('/');
    expect(normalizeRoute('/a/\u0301/b/')).toBe('/a/\u0301/b/');
    expect(validateRoute(normalizeRoute('/\u0301/'))).toMatch(/may only contain/);
  });
});

/** Titles in Latin script, whose addresses must stay exactly what they were before addresses took other scripts. */
const LATIN_TITLES = ['OʼNeil & Sons', 'Rock ʼn Roll', 'AˇB', 'AˊB', 'Hawaiʻi', 'About Us', '  Café & Bar!  ', 'Oﬃce Hours', 'Crème Brûlée', 'Straße 12', 'Đà Nẵng', 'Liên hệ', 'Ｆｕｌｌ Ｗｉｄｔｈ', 'Q&A — 2026', 'İstanbul', 'Ærø', '---', `${'a'.repeat(59)} b`, 'b'.repeat(70)];

describe('addresses in any script (#36)', () => {
  it('gives a page titled in Japanese, or other scripts, its natural address', () => {
    expect(addressSlug('お問い合わせ')).toBe('お問い合わせ');
    expect(addressSlug('FAQ よくある質問')).toBe('faq-よくある質問');
    expect(addressSlug('会社概要・沿革')).toBe('会社概要-沿革');
    expect(addressSlug('コーヒー')).toBe('コーヒー');
    expect(addressSlug('Привет Мир')).toBe('привет-мир');
    // Marks that make letters of their own are kept: "й" is not "и", nor "ά" just "α".
    expect(addressSlug('Мой дом')).toBe('мой-дом');
    expect(addressSlug('Επικοινωνία')).toBe('επικοινωνία');
    expect(addressSlug('한국어 페이지')).toBe('한국어-페이지');
    expect(addressSlug('हिन्दी पृष्ठ')).toBe('हिन्दी-पृष्ठ');
    expect(addressSlug('اتصل بنا')).toBe('اتصل-بنا');
    // An apostrophe or tone mark Latin text shares is part of a word in another script, never at its start.
    expect(addressSlug('Обʼєкт')).toBe('обʼєкт');
    expect(addressSlug('ㄅˊ')).toBe('ㄅˊ');
    expect(addressSlug('ʼобʼ ʼєкт')).toBe('обʼ-єкт');
    expect(validateRoute('/обʼєкт/')).toBeNull();
    expect(validateRoute('/oʼneil/')).toMatch(/may only contain/);
    for (const t of ['お問い合わせ', 'Привет Мир', 'Мой дом', 'Επικοινωνία', 'ΟΔΟΣ ΕΡΜΟΥ', '한국어 페이지', 'हिन्दी पृष्ठ', 'ภาษาไทย', 'צור קשר', '联系我们', '𠮷野家', 'ｶﾌｪ', 'Ἀθῆναι ᾳ']) {
      expect(validateRoute(`/${addressSlug(t)}/`), t).toBeNull();
    }
  });

  it('keeps every Latin title\'s address exactly as slugify makes it', () => {
    for (const t of LATIN_TITLES) expect(addressSlug(t), t).toBe(slugify(t));
    expect(addressSlug('Café & Bar!')).toBe('cafe-and-bar');
  });

  it('spells two titles that read the same with the same address', () => {
    // Half-width katakana, and kana written with a separate voicing mark, are the same words.
    expect(addressSlug('ｶﾌｪ')).toBe('カフェ');
    expect(addressSlug('ガイド'.normalize('NFD'))).toBe('ガイド');
    expect(addressSlug('ПРИВЕТ')).toBe(addressSlug('привет'));
    // Letters a case-insensitive file system reads as one are spelled one way: sigma by its place in the word.
    expect(addressSlug('ΟΔΟΣ')).toBe('οδος');
    expect(addressSlug('οδοσ')).toBe('οδος');
    expect(addressSlug('ᾳ')).toBe('αι');
    const taken = new Set(['/カフェ/']);
    expect(suggestRoute('ｶﾌｪ', (r) => taken.has(r))).toEqual({ route: '/カフェ-2/', base: '/カフェ/' });
  });

  it('cuts to 60 characters and 120 bytes, so a deep address stays a path the disk can hold', () => {
    // Two-byte letters fill all 60 characters; Japanese takes 40, and characters beyond the BMP 30, never split.
    expect(addressSlug('я'.repeat(70))).toBe('я'.repeat(60));
    expect(addressSlug('お'.repeat(70))).toBe('お'.repeat(40));
    const astral = addressSlug('𠮷'.repeat(70));
    expect(astral).toBe('𠮷'.repeat(30));
    for (const seg of ['я'.repeat(60), 'お'.repeat(40), astral, 'a'.repeat(60)]) expect(validateRoute(`/${seg}/${seg}/${seg}/${seg}/`), seg).toBeNull();
    expect(validateRoute(`/${'я'.repeat(61)}/`)).toMatch(/60 characters/);
    expect(validateRoute(`/${'お'.repeat(41)}/`)).toMatch(/40 in Japanese/);
    expect(validateRoute(`/${'お'.repeat(40)}a/`)).toMatch(/40 in Japanese/);
    expect(validateRoute(`/${'𠮷'.repeat(31)}/`)).toMatch(/40 in Japanese/);
    const deepest = `/${Array(4).fill(astral).join('/')}/`;
    expect(new TextEncoder().encode(deepest).length).toBeLessThanOrEqual(485);
    const numbered = numberedSlug(astral, 12);
    expect(numbered).toBe(`${'𠮷'.repeat(29)}-12`);
    expect(validateRoute(`/${numbered}/`)).toBeNull();
    expect(numberedSlug('お'.repeat(40), 2)).toBe(`${'お'.repeat(39)}-2`);
    // The cut can leave a sigma ending the word, which is then spelled as one.
    const greek = `${'a'.repeat(57)}σβ`;
    expect(numberedSlug(addressSlug(greek), 2)).toBe(`${'a'.repeat(57)}ς-2`);
    expect(validateRoute(`/${numberedSlug(addressSlug(greek), 2)}/`)).toBeNull();
    expect(validateRoute(`/${numberedSlug('a'.repeat(60), 2)}/`)).toBeNull();
  });

  it('always makes a valid address, whatever the title mixes', () => {
    // Punctuation turned into a hyphen ends the word before it, so a sigma there is then spelled as final, or not.
    expect(addressSlug('Α.Σ.')).toBe('α-σ');
    expect(addressSlug('ΟΔΟΣ.')).toBe('οδος');
    const pool = Array.from('aZé ß-.&/_ʼˇ0１お問ガｶﾞ𠮷ΣσςΑάᾳПйъ\u0301\u0345\u3099ー・한ि्ภ่');
    let seed = 36;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 4000; i++) {
      const title = Array.from({ length: 1 + Math.floor(next() * 90) }, () => pool[Math.floor(next() * pool.length)]).join('');
      const slug = addressSlug(title);
      if (!slug) continue;
      expect(validateRoute(`/${slug}/`), JSON.stringify(title)).toBeNull();
      expect(validateRoute(`/${numberedSlug(slug, 2 + (i % 120))}/`), JSON.stringify(title)).toBeNull();
      expect(normalizeRoute(slug), JSON.stringify(title)).toBe(`/${slug}/`);
    }
  });

  it('accepts a typed or pasted address in another script, spelled as addresses are', () => {
    expect(normalizeRoute('/お問い合わせ/')).toBe('/お問い合わせ/');
    expect(normalizeRoute('お問い合わせ')).toBe('/お問い合わせ/');
    expect(normalizeRoute(encodeURI('/お問い合わせ/'))).toBe('/お問い合わせ/');
    expect(normalizeRoute('/Привет Мир/')).toBe('/привет-мир/');
    expect(normalizeRoute('/ｶﾌｪ/')).toBe('/カフェ/');
    expect(normalizeRoute('/ＡＢＯＵＴ/')).toBe('/about/');
    expect(normalizeRoute('/οσ/')).toBe('/ος/');
    for (const typed of ['/お問い合わせ/', encodeURI('/会社/概要/'), '/Привет Мир/', '/ｶﾌｪ/', '/οσ/']) expect(validateRoute(normalizeRoute(typed)), typed).toBeNull();
    // An escaped slash is not a folder, and a malformed escape is refused rather than guessed at.
    expect(validateRoute(normalizeRoute('/a%2Fb/'))).toMatch(/may only contain/);
    expect(validateRoute(normalizeRoute('/%E3%81/'))).toMatch(/may only contain/);
  });

  it('refuses any other spelling of an address, naming the one to use', () => {
    expect(validateRoute('/お問い合わせ/')).toBeNull();
    expect(validateRoute('/会社/お問い合わせ/')).toBeNull();
    expect(validateRoute('/ｶﾌｪ/')).toBe('"ｶﾌｪ" must be written "カフェ".');
    expect(validateRoute('/Привет/')).toBe('"Привет" must be written "привет".');
    expect(validateRoute(`/${'ガイド'.normalize('NFD')}/`)).toMatch(/must be written "ガイド"/);
    expect(validateRoute('/οσ/')).toMatch(/must be written "ος"/);
    expect(validateRoute('/ᾳ/')).toMatch(/must be written "αι"/);
    // Latin letters are plain a–z, as they always were; punctuation and a word that starts with a mark are refused.
    expect(validateRoute('/café/')).toMatch(/may only contain/);
    expect(validateRoute('/About/')).toMatch(/may only contain/);
    expect(validateRoute('/お・問/')).toMatch(/may only contain/);
    expect(validateRoute('/-お/')).toMatch(/may only contain/);
    expect(validateRoute('/\u3099お/')).toMatch(/may only contain/);
    expect(validateRoute('/_お問い合わせ/')).toMatch(/may only contain/);
  });

  it('escapes an address for a URL and reads an escaped one back', () => {
    expect(routeUrl('/お問い合わせ/')).toBe('/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/');
    expect(routeUrl('/services/web-design/')).toBe('/services/web-design/');
    expect(readablePath(routeUrl('/お問い合わせ/'))).toBe('/お問い合わせ/');
    // Escapes of a slash stay escaped, and a malformed one leaves the path as it is. Decoded once only: an escaped
    // "%" is a "%", never the start of another escape.
    expect(readablePath('/a%2Fb/')).toBe('/a%2Fb/');
    expect(readablePath('/a%3Fb%23c/')).toBe('/a%3Fb%23c/');
    expect(readablePath(encodeURI(routeUrl('/お/')))).toBe(routeUrl('/お/'));
    expect(readablePath('/%E3%81/')).toBe('/%E3%81/');
  });
});
