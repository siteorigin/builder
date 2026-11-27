/**
 * The scoped styles of a generated site's Svelte files, for a browser test that puts a server-rendered page and the
 * bundle that hydrates it (tests/unit/generated-site.ts) in a page of its own.
 *
 * Foundation's sections are code components whose layout, pinning and print rules are their own scoped styles, which a
 * site build bundles with the page. The bundle injects them only once it starts, so a test that measures the
 * server-rendered page first puts them in the page itself. Each file is compiled under its own name, as both the server
 * render and the bundle compile it, so the scope classes are the markup's own.
 */
import { compile } from 'svelte/compiler';

/** The scoped styles of the site's Svelte files, and the editor's where they differ, with the server-rendered page as it is. */
export function scopedStyles(clean: Map<string, string>, dev: Map<string, string>, ssr: string): { css: string; ssr: string } {
  const sheets = new Set<string>();
  for (const files of [clean, dev]) {
    for (const [path, source] of files) {
      if (!path.startsWith('src/') || !path.endsWith('.svelte')) continue;
      const styles = compile(source, { filename: path, generate: 'client', runes: true, css: 'external' }).css?.code;
      if (styles) sheets.add(styles);
    }
  }
  return { css: [...sheets].join('\n'), ssr };
}
