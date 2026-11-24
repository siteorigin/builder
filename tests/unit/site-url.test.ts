import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { GEN_ROOT, generateProject, generateRedirect, generateRobots, generateSitemap } from '@generator/index';
import { checkPublicUrl, publicUrl } from '@shared/public-url';
import { LANGUAGE_CODE_ERROR, siteLanguageProblem } from '@shared/languages';
import { publicUrlWarning } from '../../src/main/export';

const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const refusal = (s: ProjectState, op: Partial<Extract<Parameters<typeof applyOperations>[1][number], { type: 'site.update' }>>) => {
  try {
    applyOperations(s, [{ type: 'site.update', ...op }]);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};
const about = (s: ProjectState) => generateProject(s).get('src/routes/about/+page.svelte')!;

describe('the public URL', () => {
  it('stores a normal https address in the form browsers use', () => {
    expect(apply(fresh(), { type: 'site.update', baseUrl: '  https://Studio.Example:443/  ' }).site.baseUrl).toBe('https://studio.example');
    expect(apply(fresh(), { type: 'site.update', baseUrl: 'https://studio.example:8443' }).site.baseUrl).toBe('https://studio.example:8443');
  });

  it('stores a subdirectory deployment without its trailing slash', () => {
    expect(apply(fresh(), { type: 'site.update', baseUrl: 'https://me.github.io/my-site/' }).site.baseUrl).toBe('https://me.github.io/my-site');
  });

  it('refuses a port browsers reject, names it, and keeps the last valid setting', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://studio.example' });
    expect(refusal(s, { baseUrl: 'https://example.com:65536' })).toBe('The port 65536 is not valid. Use a port from 1 to 65535.');
    expect(refusal(s, { baseUrl: 'https://example.com:0' })).toMatch(/port 0 is not valid/);
    expect(s.site.baseUrl).toBe('https://studio.example');
  });

  it('clears the setting when emptied', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://studio.example' });
    expect(apply(s, { type: 'site.update', baseUrl: '  ' }).site.baseUrl).toBeUndefined();
  });

  it('names the part that is wrong, checked before the parser repairs it', () => {
    const message = (t: string) => {
      const c = checkPublicUrl(t);
      return c.ok ? null : c.message;
    };
    expect(message('https://example.com:abc')).toMatch(/port “abc” is not a number/);
    expect(message('https://example.com:')).toMatch(/Add the port number/);
    expect(message('https://user:pw@example.com')).toMatch(/user name and password/);
    expect(message('https://@example.com')).toMatch(/user name and password/);
    expect(message('https://example.com/?')).toMatch(/query/);
    expect(message('https://example.com/#')).toMatch(/“#”/);
    expect(message('https:///about')).toMatch(/needs a host name/);
    expect(message('https://example.com/a/../b')).toMatch(/“\.\.” can’t be part/);
    expect(message('https://example.com/a/%2e%2e/b')).toMatch(/“%2e%2e” can’t be part/);
    expect(message('https://example.com//studio')).toMatch(/empty part/);
    expect(message('https://exa_mple.com')).toMatch(/“exa_mple\.com” is not a host name/);
    expect(message('https://exa mple.com')).toMatch(/spaces/);
    expect(message('ftp://example.com')).toMatch(/not ftp:/);
    expect(message(`https://example.com/${'a'.repeat(200)}`)).toMatch(/at most 200/);
    expect(checkPublicUrl('https://[::1]:8080/')).toEqual({ ok: true, url: 'https://[::1]:8080' });
    expect(checkPublicUrl('https://bücher.example')).toEqual({ ok: true, url: 'https://xn--bcher-kva.example' });
  });

  it('offers https:// for an ordinary host name, and https for http', () => {
    expect(checkPublicUrl('kloof.example')).toEqual({ ok: false, message: 'Start the public URL with https://, as in https://kloof.example.', suggestion: 'https://kloof.example' });
    expect(checkPublicUrl('kloof.example:8443/studio/')).toMatchObject({ ok: false, suggestion: 'https://kloof.example:8443/studio' });
    expect(checkPublicUrl('http://kloof.example/')).toMatchObject({ ok: false, message: expect.stringMatching(/Change http:\/\/ to https:\/\//), suggestion: 'https://kloof.example' });
    // Not an address anyone meant: no offer.
    for (const t of ['English', 'localhost:3000', '/studio', '//kloof.example', 'kloof.example:65536']) expect(checkPublicUrl(t)).not.toHaveProperty('suggestion');
  });
});

describe('links built from the public URL', () => {
  it('agree with the accepted address at the root', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://Studio.Example/' });
    const files = generateProject(s);
    expect(about(s)).toContain('<link rel="canonical" href={"https://studio.example/about/"} />');
    expect(about(s)).toContain('<meta property="og:url" content={"https://studio.example/about/"} />');
    expect(files.get('static/sitemap.xml')).toContain('<loc>https://studio.example/about/</loc>');
    expect(files.get('static/robots.txt')).toContain('Sitemap: https://studio.example/sitemap.xml');
    expect(JSON.parse(files.get(`${GEN_ROOT}/paths.json`)!)).toEqual({ base: '' });
  });

  it('agree with the accepted address in a subdirectory', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://me.github.io/studio/' });
    const files = generateProject(s);
    expect(about(s)).toContain('<link rel="canonical" href={"https://me.github.io/studio/about/"} />');
    expect(files.get('static/sitemap.xml')).toContain('<loc>https://me.github.io/studio/about/</loc>');
    expect(files.get('static/robots.txt')).toContain('Sitemap: https://me.github.io/studio/sitemap.xml');
    expect(JSON.parse(files.get(`${GEN_ROOT}/paths.json`)!)).toEqual({ base: '/studio' });
    const page = s.pages[s.site.pageOrder[1]];
    expect(generateRedirect(s, '/old/', page)).toContain(`href={"https://me.github.io/studio${page.route}"}`);
  });

  it('leave out every absolute link when the saved address cannot be used', () => {
    // Saved by an earlier version, or by hand: the build must not crawl a link browsers reject.
    for (const saved of ['https://example.com:65536', 'http://studio.example', 'kloof.example', 'https://studio.example/a b']) {
      const s = fresh();
      s.site.baseUrl = saved;
      expect(publicUrl(s.site)).toBeUndefined();
      const files = generateProject(s);
      expect(files.has('static/sitemap.xml')).toBe(false);
      expect(generateSitemap(s)).toBeNull();
      expect(generateRobots(s)).not.toContain('Sitemap');
      expect(about(s)).not.toMatch(/canonical|og:url/);
      expect(JSON.parse(files.get(`${GEN_ROOT}/paths.json`)!)).toEqual({ base: '' });
    }
  });

  it('read an old address with a trailing slash as the address without it', () => {
    const s = fresh();
    s.site.baseUrl = 'https://me.github.io/studio/';
    expect(generateSitemap(s)).toContain('<loc>https://me.github.io/studio/about/</loc>');
  });
});

describe('the export warning about the public URL', () => {
  it('says when none is set, says why a saved one cannot be used, and is quiet for a good one', () => {
    const s = fresh();
    expect(publicUrlWarning(s)).toMatch(/^No public site URL is set/);
    s.site.baseUrl = '   ';
    expect(publicUrlWarning(s)).toMatch(/^No public site URL is set/);
    s.site.baseUrl = 'https://example.com:65536';
    expect(publicUrlWarning(s)).toBe(
      'The public site URL “https://example.com:65536” can’t be used, so canonical links, social image URLs and the sitemap were omitted. The port 65536 is not valid. Use a port from 1 to 65535. Correct it in Site settings.'
    );
    s.site.baseUrl = 'https://studio.example/';
    expect(publicUrlWarning(s)).toBeNull();
  });
});

describe('the site language', () => {
  it('is refused with the same reason Site details shows beside the field', () => {
    const s = fresh();
    expect(siteLanguageProblem(s, 'English')).toBe(LANGUAGE_CODE_ERROR);
    expect(refusal(s, { language: 'English' })).toBe(LANGUAGE_CODE_ERROR);
    expect(siteLanguageProblem(s, 'en-GB')).toBeNull();
    expect(apply(s, { type: 'site.update', language: 'en-GB' }).site.language).toBe('en-GB');
  });
});
