/**
 * A review edition's offline sheet (#1134): one HTML file holding every picture of the edition, with each page's title
 * and address, each picture's width and its name, the edition's ID and digest, and the note that links, menus and
 * forms only work in a live preview. Everything the edition says is shown as text, never as markup, and the file
 * loads nothing from anywhere.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REVIEW_SHEET_NOTE, reviewSheet } from '../../src/main/review-sheet';
import type { ReviewEditionManifest } from '../../src/shared/review-edition';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const png = (what: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(what)]);

/** The whole sheet of an edition whose pictures are `images`, by file. */
async function reviewSheetHtml({ manifest, images }: { manifest: ReviewEditionManifest; images: Map<string, Buffer> }): Promise<string> {
  let html = '';
  for await (const chunk of reviewSheet(manifest, async (c) => images.get(c.file)!)) html += chunk;
  return html;
}

function edition(): { manifest: ReviewEditionManifest; images: Map<string, Buffer> } {
  const a = png('home desktop');
  const b = png('home tablet');
  const manifest: ReviewEditionManifest = {
    editionId: '2026-11-27T10-00-00Z-0badc0de',
    createdAt: '2026-11-27T10:00:05.000Z',
    siteName: 'Tom & Jerry’s <Books>',
    revision: 12,
    basePath: '',
    routes: [
      { route: '/', title: 'Home "first"' },
      { route: '/a/<script>alert(1)</script>/', title: '<img src=x onerror=alert(1)>' }
    ],
    widths: [
      { label: 'Wide <desk>', width: 1440 },
      { label: 'Tablet', width: 768 }
    ],
    captures: [
      { route: '/', width: 1440, status: 'captured', file: 'images/001-1440.png', height: 900, sha256: sha(a) },
      { route: '/', width: 768, status: 'captured', file: 'images/001-768.png', height: 1400, sha256: sha(b) },
      { route: '/a/<script>alert(1)</script>/', width: 1440, status: 'unavailable', reason: 'assets', detail: 'GET https://cdn.example/x.css 404' },
      { route: '/a/<script>alert(1)</script>/', width: 768, status: 'unavailable', reason: 'timeout', detail: 'The page took too long.' }
    ],
    siteDigest: 'a'.repeat(64),
    contentDigest: 'b'.repeat(64)
  };
  return {
    manifest,
    images: new Map([
      ['images/001-1440.png', a],
      ['images/001-768.png', b]
    ])
  };
}

describe('the offline review sheet', () => {
  it('names the site, the edition, its date, revision and digest, and says what pictures cannot do', async () => {
    const html = await reviewSheetHtml(edition());
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<h1>Tom &#38; Jerry’s &#60;Books&#62;</h1>');
    expect(html).toContain('<title>Tom &#38; Jerry’s &#60;Books&#62; – review 2026-11-27T10-00-00Z-0badc0de</title>');
    expect(html).toContain('Review edition <code>2026-11-27T10-00-00Z-0badc0de</code> · made November 27, 2026, 10:00 UTC · 2 pages, 2 pictures');
    expect(html).toContain(`revision 12 · content digest <code>${'b'.repeat(64)}</code>`);
    expect(html).toContain(REVIEW_SHEET_NOTE);
    expect(REVIEW_SHEET_NOTE).toMatch(/links, menus, forms .* live preview/i);
  });

  it('shows every page in order with its title and address, each width by its name, and the pictures it holds', async () => {
    const { manifest, images } = edition();
    const html = await reviewSheetHtml({ manifest, images });
    // In the edition's order, linked from the list of pages at the top.
    expect(html.indexOf('id="page-1"')).toBeLessThan(html.indexOf('id="page-2"'));
    expect(html).toContain('<li><a href="#page-1">Home &#34;first&#34;</a></li>');
    expect(html).toContain('Wide &#60;desk&#62; <span>· 1440 px</span>');
    expect(html).toContain('Tablet <span>· 768 px</span>');
    // Each page's address under its title, as text.
    expect(html).toContain('<h2>Home &#34;first&#34;</h2><span class="route">/</span>');
    expect(html).toContain('<span class="route">/a/&#60;script&#62;alert(1)&#60;/script&#62;/</span>');
    // A picture's description carries its page's title, escaped.
    expect(html).toContain('alt="Home &#34;first&#34;, Wide &#60;desk&#62;, 1440 pixels wide"');
    // Each picture's own bytes, at the size it was taken.
    expect(html).toContain(`<img src="data:image/png;base64,${images.get('images/001-1440.png')!.toString('base64')}" width="1440" height="900"`);
    expect(html).toContain(`<img src="data:image/png;base64,${images.get('images/001-768.png')!.toString('base64')}" width="768" height="1400"`);
    // A picture that could not be taken is said in plain words, never with its diagnostic detail.
    expect(html).toContain('Not pictured. An image, stylesheet or other file did not load.');
    expect(html).toContain('Not pictured. The page took too long to load.');
    expect(html).not.toContain('cdn.example');
  });

  it('shows what the edition says as text, runs no script, and loads nothing but the pictures it holds', async () => {
    const html = await reviewSheetHtml(edition());
    expect(html).not.toMatch(/<script|<img src=x|<desk>|<Books>/i);
    expect(html).toContain("<h2>&#60;img src=x onerror=alert(1)&#62;</h2>");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
    // Every address in the file is one of its own pictures or a place on the sheet.
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^(data:image\/png;base64,|#page-\d+$)/);
    expect(html).not.toMatch(/url\(|@import|https?:\/\//);
  });

  it('lists no pages for a single page, and names a site without a name as a website', async () => {
    const { manifest, images } = edition();
    const one = { ...manifest, siteName: '  ', routes: manifest.routes.slice(0, 1), captures: manifest.captures.slice(0, 2) };
    const html = await reviewSheetHtml({ manifest: one, images });
    expect(html).not.toContain('<nav');
    expect(html).toContain('<h1>Website</h1>');
    expect(await reviewSheetHtml({ manifest, images })).toContain('<nav aria-label="Pages">');
  });

  it('reads each picture only when its place comes, and stops at one that fails its check', async () => {
    const { manifest, images } = edition();
    const read: string[] = [];
    const chunks = reviewSheet(manifest, async (c) => {
      read.push(c.file);
      if (c.file === 'images/001-768.png') throw new Error('changed');
      return images.get(c.file)!;
    });
    expect((await chunks.next()).value).toContain('<h1>');
    expect(read).toEqual([]);
    await expect((async () => { for await (const _ of chunks) void _; })()).rejects.toThrow('changed');
    expect(read).toEqual(['images/001-1440.png', 'images/001-768.png']);
  });
});
