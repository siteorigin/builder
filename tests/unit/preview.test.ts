import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { externalLink } from '@shared/links';
import { devPlugin } from '@runtime/dev-plugin';
import { projectSrcPath } from '@runtime/paths';
import { chainOf, measuredRects, rectList } from '../../src/renderer/src/lib/payload';

describe('external links from the preview', () => {
  it('allows web pages, email addresses and phone numbers', () => {
    expect(externalLink('https://example.com/a?b=1#c')).toEqual({ href: 'https://example.com/a?b=1#c', kind: 'web', target: 'https://example.com/a?b=1#c' });
    expect(externalLink('mailto:hello@studio.example?subject=Hi')).toEqual({ href: 'mailto:hello@studio.example?subject=Hi', kind: 'email', target: 'hello@studio.example' });
    expect(externalLink('mailto:a@x.io,b@y.io')).toEqual({ href: 'mailto:a@x.io,b@y.io', kind: 'email', target: 'a@x.io, b@y.io' });
    expect(externalLink('tel:+61 2 9999 0000')).toEqual({ href: 'tel:+61 2 9999 0000', kind: 'phone', target: '+61 2 9999 0000' });
    expect(externalLink('tel:(02)%209999-0000')).toEqual({ href: 'tel:(02)%209999-0000', kind: 'phone', target: '(02) 9999-0000' });
    expect(externalLink('https://example.com/' + 'a'.repeat(2050))).not.toBeNull();
  });

  it('refuses everything else', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'https://user:pw@example.com/', 'mailto:', 'mailto:not-an-address', 'mailto:team@example.com?bcc=archive@example.com', 'mailto:team@example.com?cc=x@y.io', 'mailto:team%00@example.com', 'mailto:a@b.io?subject=x%0Ay', 'tel:call-me', 'tel:123?x=1', 'tel:()', 'tel:1-2', 'http://exa\nmple.com', '', 42, null, 'x'.repeat(3000)]) expect(externalLink(bad)).toBeNull();
  });
});

describe('dev instrumentation paths', () => {
  it('finds project source on POSIX', () => {
    expect(projectSrcPath('/work/site', '/work/site/src/routes/+page.svelte?v=1')).toBe('src/routes/+page.svelte');
    expect(projectSrcPath('/work/site/', '/work/site/src/lib/a.js')).toBe('src/lib/a.js');
    expect(projectSrcPath('/work/site', '/work/site/node_modules/x/src/a.js')).toBeNull();
    expect(projectSrcPath('/work/site', '/work/site-other/src/a.js')).toBeNull();
    expect(projectSrcPath('/work/site', '/work/site/src/../vite.config.js')).toBeNull();
    expect(projectSrcPath('/work/site', '\0/work/site/src/a.js')).toBeNull();
    // A project opened through a link is also matched by its real path.
    expect(projectSrcPath(['/links/site', '/real/site'], '/real/site/src/a.js')).toBe('src/a.js');
    expect(projectSrcPath('/Work/Site', '/work/site/src/a.js')).toBeNull();
  });

  it('matches Vite’s forward-slash ids against a Windows project folder', () => {
    expect(projectSrcPath('C:\\Users\\me\\Sites\\studio', 'C:/Users/me/Sites/studio/src/routes/+layout.svelte')).toBe('src/routes/+layout.svelte');
    expect(projectSrcPath('C:\\Users\\me\\Sites\\studio', 'c:/Users/me/Sites/studio/src/lib/x.js?import')).toBe('src/lib/x.js');
    expect(projectSrcPath('C:\\Users\\me\\Sites\\studio', 'C:/Users/me/Sites/studio/.svelte-kit/generated/root.js')).toBeNull();
    expect(projectSrcPath('C:\\Users\\Me\\sites\\Studio', 'c:/users/me/Sites/studio/src/a.js')).toBe('src/a.js');
    expect(projectSrcPath('\\\\server\\share\\studio', '/server/share/studio/src/a.js')).toBe('src/a.js');
  });
});

describe('dev instrumentation plugin', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A project with one component and the editor's instrumented variant of it, told apart by their markup. */
  function project() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-devplugin-')));
    dirs.push(dir);
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    const rel = 'src/lib/siteorigin/generated/foundation-contact-form.svelte';
    const source = (marker: string) => `<script>\n\tconst uid = $props.id();\n</script>\n\n{#if heading}<h2${marker}>{heading}</h2>{/if}\n<input id={uid + '-0'} />\n\n<style>\n\th2 { margin: 0; }\n</style>\n`;
    put(rel, source(''));
    put(`.siteorigin/cache/dev/${rel}`, source(' data-so-node="n1"'));
    return { load: devPlugin(dir).load, id: `${dir}/${rel}`, variant: source(' data-so-node="n1"') };
  }

  it('serves the instrumented variant in place of the component module', () => {
    const { load, id, variant } = project();
    expect(load(id)).toBe(variant);
    // A dependency version stamp still names the module itself.
    expect(load(`${id}?v=3f9a1c2e`)).toBe(variant);
  });

  it('leaves a component’s stylesheet and other derived requests to the plugins that serve them', () => {
    const { load, id } = project();
    // The component's stylesheet, as the browser imports it and as SvelteKit inlines it into a server-rendered page.
    // Served the variant, the whole component source became the stylesheet, and its markup leaked into the page.
    expect(load(`${id}?svelte&type=style&lang.css`)).toBeNull();
    expect(load(`${id}?inline&svelte&type=style&lang.css`)).toBeNull();
    // Anything else is left alone too, a version stamp mixed with another query or hiding one included.
    for (const query of ['direct', 'raw', 'url', 'inline', 'svelte&type=script', 'worker_file&type=module', 'v=1&raw', 'v=1&url', 'v=?raw', 'svelte&type=style&lang.css&v=1']) {
      expect(load(`${id}?${query}`), query).toBeNull();
    }
  });
});

describe('bridge payload shapes', () => {
  it('keeps only well-formed boxes', () => {
    expect(rectList('nope')).toEqual([]);
    const ok = { x: 1, y: 2, width: 3, height: 4 };
    expect(rectList([ok, { ...ok, x: 'a' }, { ...ok, y: null }, { ...ok, width: -1 }, { ...ok, height: Infinity }, null])).toEqual([ok]);
    // Each measured box keeps its CSS order, 0 when it has none or a malformed one.
    expect(measuredRects([{ x: 0, y: 0, width: 1, height: 1 }, null], 2)).toEqual([{ x: 0, y: 0, width: 1, height: 1, order: 0 }, null]);
    expect(measuredRects([{ x: 0, y: 0, width: 1, height: 1, order: -2 }, { x: 0, y: 0, width: 1, height: 1, order: '3' }], 2)).toEqual([
      { x: 0, y: 0, width: 1, height: 1, order: -2 },
      { x: 0, y: 0, width: 1, height: 1, order: 0 }
    ]);
    // Holes in a sparse array are missing measurements, never skipped entries.
    expect(measuredRects(new Array(2), 2)).toEqual([null, null]);
    expect(measuredRects([null], 2)).toBeNull();
    expect(measuredRects({ length: 2 }, 2)).toBeNull();
  });

  it('drops a chain with any malformed entry', () => {
    const d = { ctx: 'page:p1', node: 'n1', items: '', tag: 'section', text: 'Welcome', code: false };
    expect(chainOf([d])).toEqual([d]);
    expect(chainOf([d, { ...d, ctx: 1 }])).toEqual([]);
    expect(chainOf([d, { ...d, code: 'yes' }])).toEqual([]);
    expect(chainOf([d, { ...d, items: undefined }])).toEqual([]);
    expect(chainOf({ 0: d })).toEqual([]);
    expect(chainOf(new Array(2000).fill(d))).toEqual([]);
    expect(chainOf(new Array(2))).toEqual([]);
  });
});
