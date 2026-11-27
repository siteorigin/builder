/**
 * The scoped styles of a generated site's Svelte files, for a browser test that puts a server-rendered page and the
 * bundle that hydrates it (tests/unit/generated-site.ts) in a page of its own.
 *
 * Foundation's sections are code components whose layout, pinning and print rules are their own scoped styles, which a
 * site build bundles with the page; the test's page has to take them as well as the site's stylesheets. A file's scope
 * class comes from its file name, and the bundle names the site's files `clean/…` and the editor's `dev/…`, where the
 * server render named them `src/…`: so the page takes each variant's styles under the names the bundle gives them,
 * and the server-rendered markup takes the scope classes the hydrating bundle sets, as one build would give both.
 */
import { compile } from 'svelte/compiler';

const scopeOf = (css: string) => /svelte-[a-z0-9]+/.exec(css)![0];

/** The scoped styles of the site's and the editor's variants, and the server-rendered page with the bundle's scope classes. */
export function scopedStyles(clean: Map<string, string>, dev: Map<string, string>, ssr: string): { css: string; ssr: string } {
  const sheets: string[] = [];
  let page = ssr;
  for (const [prefix, files] of [['clean/', clean], ['dev/', dev]] as const) {
    for (const [path, source] of files) {
      if (!path.startsWith('src/') || !path.endsWith('.svelte')) continue;
      const styles = compile(source, { filename: `${prefix}${path}`, generate: 'client', runes: true, css: 'external' }).css?.code;
      if (!styles) continue;
      sheets.push(styles);
      if (prefix === 'clean/') page = page.replaceAll(scopeOf(compile(source, { filename: path, generate: 'client', runes: true, css: 'external' }).css!.code), scopeOf(styles));
    }
  }
  return { css: sheets.join('\n'), ssr: page };
}
