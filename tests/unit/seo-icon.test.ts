/**
 * The magnifying glass means "find" in the editor, so SEO has an icon of its own (#950): the same one on the rail, in
 * the SEO view's header, in the toolbar's breadcrumb, in the Inspector while the view is open and on Open in SEO view.
 * The search box drawn in the results preview is a search box, and keeps the plain glass.
 */
import { readFileSync } from 'node:fs';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';

// Renderer code, outside this test project's types: loaded by a path the type checker does not follow.
const TABS = '../../src/renderer/src/panels/LeftTabs';
const { LEFT_TABS } = (await import(/* @vite-ignore */ TABS)) as { LEFT_TABS: readonly { id: string; icon: { type: unknown } }[] };

const source = (name: string) => readFileSync(`src/renderer/src/panels/${name}.tsx`, 'utf8');

describe('the SEO icon', () => {
  it('is on the rail, and no rail button shows the find icon', () => {
    expect(LEFT_TABS.find((t) => t.id === 'seo')?.icon.type).toBe(lucide.SearchCheck);
    expect(LEFT_TABS.filter((t) => t.icon.type === lucide.Search)).toEqual([]);
  });

  // These places are inside whole panels, so their markup is read where it is written.
  it.each([
    ['the SEO view’s header', 'SeoView', /<SearchCheck aria-hidden="true" \/>\s*<h2 className="seo-title">SEO<\/h2>/],
    ['the toolbar’s breadcrumb', 'Toolbar', /\{seo \? \(\s*<SearchCheck aria-hidden="true" \/>/],
    ['the Inspector’s header', 'Inspector', /<Header title=\{doc\?\.title \?\? 'SEO'\} kind=\{kind\} icon=\{<SearchCheck \/>\} \/>/],
    ['the Inspector’s empty state', 'Inspector', /<div className="insp-empty">\s*<SearchCheck aria-hidden="true" \/>\s*<p>\{doc \? `The SEO view shows/],
    ['Open in SEO view', 'SeoPreview', /<SearchCheck aria-hidden \/> Open in SEO view/]
  ])('is on %s', (_place, file, markup) => {
    expect(source(file)).toMatch(markup);
  });

  it('leaves the results preview’s search box the plain magnifying glass', () => {
    expect(source('SeoPreview')).toMatch(/<div className="serp-search" aria-hidden="true">\s*<Search \/>/);
  });
});
