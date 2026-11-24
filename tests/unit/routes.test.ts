import { describe, expect, it } from 'vitest';
import { normalizeRoute, slugify, validateRoute } from '@shared/routes';

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
  });
});

describe('normalizeRoute', () => {
  it('turns spaces and accents in an address someone types into a valid route', () => {
    expect(normalizeRoute('About Us')).toBe('/about-us/');
    expect(normalizeRoute('/Our  Team / Café Menu/')).toBe('/our-team/cafe-menu/');
    expect(normalizeRoute(' Crème Brûlée ')).toBe('/creme-brulee/');
    for (const typed of ['About Us', '/Our  Team / Café Menu/', ' Crème Brûlée ']) expect(validateRoute(normalizeRoute(typed)), typed).toBeNull();
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
  });
});
