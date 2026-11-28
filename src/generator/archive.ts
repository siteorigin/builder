/**
 * A collection's index and category archive pages (see shared/archives.ts), written as static pages inside the site's
 * own header and footer. Each lists its share of the collection's published entries, newest first, as cards (featured
 * picture, categories, title, date, author and excerpt; the boxed card the Post grid section shows, each one link to
 * its entry through its title), and links to the pages before and after it in its series,
 * in its head (`<link rel="prev">`, `<link rel="next">`) and in a labelled list of page links. Everything shown is
 * written into the page when the site is generated: visitors' browsers look nothing up.
 */
import type { ArchivePage } from '@shared/archives';
import { archivePages, archiveWords, categoryTerms, fillWords as fill } from '@shared/archives';
import { entryRow } from '@shared/entry-feed';
import { archivePageSize } from '@shared/collections';
import { BROWSE_COMPONENT_FILE, browseControls, browseIndexFile, browsesIndex } from './collection-browse';
import { siteLanguage } from '@shared/languages';
import { routeDir } from '@shared/routes';
import { visitorTextFor } from '@shared/visitor-text';
import type { ProjectState } from '@shared/types';
import { derived } from './cache';
import { HEADER_NOTE, RUNTIME_DIR, emitArchiveLayout, js, relImport, resolveImage, seoHead, type GenerateOptions } from './index';
import { archiveMetadata } from './seo-metadata';
import { archiveGraphScript } from './structured-data';

/** The route file of an archive page. */
export function archiveFile(route: string): string {
  return `src/routes/${routeDir(route)}/+page.svelte`;
}

/**
 * The archive pages of one collection, worked out once per state in a cached run: an archive page depends on its own
 * series and the entries it lists, not on every entry of every collection.
 */
export function collectionArchives(state: ProjectState, collectionId: string): ArchivePage[] {
  return derived(state, `archivePages:${collectionId}`, (s) => siteArchives(s).filter((p) => p.collectionId === collectionId));
}

/** Every archive page of the site (see shared/archives.ts), worked out once per state in a cached run. */
export function siteArchives(state: ProjectState): ArchivePage[] {
  return derived(state, 'archivePages', archivePages);
}

/** The page numbers its page links show: the first, the last and two on either side of the current one; null for a gap. */
export function pageLinks(page: number, pages: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) out.push(n);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

const href = (route: string) => `{resolve(${js(route)})}`;

/** Whether a collection's archive pages show its own layout (`archiveTemplate`) in place of the ready-made cards. */
export function hasArchiveLayout(settings: { archiveTemplate?: unknown }): boolean {
  const t = settings.archiveTemplate as { rootIds?: unknown; nodes?: unknown } | undefined;
  return !!t && typeof t === 'object' && Array.isArray(t.rootIds) && !!t.nodes && typeof t.nodes === 'object';
}

/**
 * One archive page: `route` must be one of the collection's archive pages in `state`. With an archive layout of the
 * collection's own, the layout shows the page's entries between its heading and its page links (see
 * emitArchiveLayout); otherwise they are the ready-made cards.
 */
export function generateArchive(state: ProjectState, collectionId: string, route: string, opts: GenerateOptions = {}): string {
  const series = collectionArchives(state, collectionId);
  const here = series.find((p) => p.route === route)!;
  const collection = state.collections[collectionId];
  const site = state.site;
  const words = visitorTextFor(site, siteLanguage(site));
  const file = archiveFile(route);
  // Category labels link to their archive while the category has one.
  const archives = new Map(series.filter((p) => p.category && p.page === 1).map((p) => [p.category!, p.route]));
  const terms = new Map(categoryTerms(collection).map((t) => [t.id, t.label]));
  const { heading } = archiveWords(state, here);
  // A category's pages lead back to the whole collection's index, by its own heading.
  const index = here.category ? series.find((p) => !p.category && p.page === 1) : undefined;
  const rctx = { state };
  // What the markup below turns out to hold, so that the page is styled for that and nothing more: Svelte warns of
  // every selector that matches nothing, in the build of the exported project.
  const uses = new Set<ArchivePart>();

  const card = (entryId: string, lead: boolean, level: 'h2' | 'h3') => {
    const entry = collection.entries[entryId];
    const row = entryRow(state, collection, entry);
    const image = row.image?.assetId ? resolveImage(row.image, rctx) : null;
    uses.add('card');
    if (lead) uses.add('lead');
    // The lead's picture takes every card picture's rule, and one of its own.
    if (image) uses.add('image');
    if (image && lead) uses.add('leadImage');
    // The lead sets its picture beside its text; without one, its text takes the whole width.
    if (image && lead) uses.add('split');
    const ids = Array.isArray(entry.terms?.categories) ? entry.terms.categories.filter((t) => terms.has(t)) : [];
    const lines: string[] = [];
    if (image) lines.push(`\t\t\t<SoImage image={${js(image)}} sizes=${js(lead ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw')}${lead && here.page === 1 ? ' eager' : ''} class="so-archive__image" />`);
    lines.push(`\t\t\t<div class="so-archive__text">`);
    if (ids.length) {
      uses.add('category');
      lines.push(
        `\t\t\t\t<p class="so-archive__category">${ids
          .map((t) => {
            const label = `{${js(terms.get(t))}}`;
            const to = archives.get(t);
            if (!to || to === route) return `<span>${label}</span>`;
            uses.add('categoryLink');
            return `<a href=${href(to)}>${label}</a>`;
          })
          .join(', ')}</p>`
      );
    }
    lines.push(`\t\t\t\t<${level} class="so-archive__title"><a href=${href(entryRouteOf(entryId))}>{${js(row.title)}}</a></${level}>`);
    const meta = [row.date ? `<time datetime=${js(row.date)}>{${js(row.dateLabel)}}</time>` : '', row.byline ? `<span>{${js(row.byline)}}</span>` : ''].filter(Boolean);
    if (meta.length) {
      uses.add('meta');
      lines.push(`\t\t\t\t<p class="so-archive__meta">${meta.join(' ')}</p>`);
    }
    if (row.excerpt) {
      uses.add('excerpt');
      lines.push(`\t\t\t\t<p class="so-archive__excerpt">{${js(row.excerpt)}}</p>`);
    }
    lines.push(`\t\t\t</div>`);
    return `<article class="so-archive__card${lead ? ' so-archive__card--lead' : ''}${lead && image ? ' so-archive__card--split' : ''}">\n${lines.join('\n')}\n\t\t</article>`;
  };
  const entryRouteOf = (entryId: string) => `${collection.settings.route}${collection.entries[entryId].slug}/`;

  // The first page of the index leads with its newest entry, shown large; every other page is a grid of cards.
  const ids = here.entryIds.filter((id) => Object.hasOwn(collection.entries, id));
  const layout = hasArchiveLayout(collection.settings) ? emitArchiveLayout(state, collectionId, ids, file, opts) : null;
  const lead = !layout && !here.category && here.page === 1 && ids.length ? ids[0] : undefined;
  const rest = layout ? [] : lead ? ids.slice(1) : ids;
  const body: string[] = [];
  if (lead) body.push(`\t\t${card(lead, true, 'h2')}`);
  if (rest.length) {
    uses.add('grid');
    body.push(`\t\t<ul class="so-archive__grid">\n${rest.map((id) => `\t\t\t<li>${card(id, false, 'h2').replace(/\n/g, '\n\t')}</li>`).join('\n')}\n\t\t</ul>`);
  }
  if (!ids.length && !layout) {
    uses.add('empty');
    body.push(`\t\t<p class="so-archive__empty">{${js(words.archiveEmpty)}}</p>`);
  }
  if (here.pages > 1) {
    uses.add('pages');
    const step = (to: string | undefined, rel: 'prev' | 'next', label: string) => (to ? `\t\t\t<a class="so-archive__step" rel=${js(rel)} href=${href(to)}>{${js(label)}}</a>` : '');
    const links = pageLinks(here.page, here.pages);
    if (links.includes(null)) uses.add('gap');
    const numbers = links
      .map((n) => {
        if (n === null) return `\t\t\t\t<li aria-hidden="true">…</li>`;
        const to = series.find((p) => p.category === here.category && p.page === n)!.route;
        // Wording that leaves the number out still names each link apart.
        const name = words.archivePage.includes('{page}') ? fill(words.archivePage, { page: n }) : `${words.archivePage} ${n}`;
        return `\t\t\t\t<li><a href=${href(to)} aria-label={${js(name)}}${n === here.page ? ' aria-current="page"' : ''}>${n}</a></li>`;
      })
      .join('\n');
    body.push(
      [`\t\t<nav class="so-archive__pages" aria-label={${js(words.archiveNav)}}>`, step(here.prev, 'prev', words.archivePrevious), `\t\t\t<ol>\n${numbers}\n\t\t\t</ol>`, step(here.next, 'next', words.archiveNext), `\t\t</nav>`]
        .filter(Boolean)
        .join('\n')
    );
  }

  // The first page of the index, with something to list, gives visitors the collection's search, filters and sorting
  // when it offers them: until a visitor uses one, the page shows what is written above.
  const controls = !layout && !here.category && here.page === 1 && ids.length > 0 && browsesIndex(state, collectionId) ? browseControls(state, collectionId) : undefined;
  // Only with a control that does something: a filter whose grouping has lost its last term offers none.
  const browsing = !!controls && (controls.search || controls.filters.length > 0 || controls.sorts.length > 0);
  if (browsing) {
    for (const part of ['grid', 'card', 'image', 'category', 'categoryLink', 'meta', 'excerpt'] as const) uses.add(part);
    const content = body.splice(0).map((b) => b.replace(/^/gm, '\t'));
    const load = js(relImport(file, `${RUNTIME_DIR}/${browseIndexFile(collectionId)}`));
    body.push(
      [
        `\t\t<SoBrowse controls={${js(controls)}} load={() => import(${load})} size={${archivePageSize(collection.settings)}} name={${js(heading)}}>`,
        browseResults(),
        ...content,
        `\t\t</SoBrowse>`
      ].join('\n')
    );
  }

  // What it says when it is found or shared, as a page does: its title and description, its sharing tags, its own
  // address and, once the site has a public URL, the site's structured data with its trail from Home.
  const head = seoHead(state, archiveMetadata(state, here), { article: false, alternates: [] });
  const graph = archiveGraphScript(state, collectionId, route);
  if (graph) head.push(`\t{@html ${js(graph)}}`);
  if (here.prev) head.push(`\t<link rel="prev" href=${href(here.prev)} />`);
  if (here.next) head.push(`\t<link rel="next" href=${href(here.next)} />`);

  const imports = [
    `\timport { resolve } from '$app/paths';`,
    ...(uses.has('image') ? [`\timport SoImage from ${js(relImport(file, `${RUNTIME_DIR}/Image.svelte`))};`] : []),
    ...(browsing ? [`\timport SoBrowse from ${js(relImport(file, `${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`))};`] : [])
  ];
  // The layout's own imports, each once (the layout may show pictures too).
  for (const line of layout?.imports ?? []) if (!imports.includes(line)) imports.push(line);
  const script = [imports.join('\n'), layout?.script ?? ''].filter(Boolean).join('\n\n');
  if (here.category) uses.add('eyebrow');
  if (index) uses.add('trail');
  if (here.page > 1) uses.add('count');
  const intro = [
    here.category
      ? `\t\t\t<p class="so-archive__eyebrow">${index ? `<a href=${href(index.route)}>{${js(archiveWords(state, index).heading)}}</a><span aria-hidden="true">/</span>` : ''}{${js(words.archiveCategory)}}</p>`
      : '',
    `\t\t\t<h1 class="so-archive__heading">{${js(heading)}}</h1>`,
    here.page > 1 ? `\t\t\t<p class="so-archive__count">{${js(fill(words.archivePageOf, { page: here.page, count: here.pages }))}}</p>` : ''
  ].filter(Boolean);
  const header = `\t\t<header class="so-archive__header">\n${intro.join('\n')}\n\t\t</header>`;
  // With a layout of its own: the heading, the layout's sections at the page's full width, then the page links.
  const sections = layout
    ? [`<section class="so-archive">\n\t<div class="so-container so-archive__inner">\n${header}\n\t</div>\n</section>`, layout.markup, body.length ? `<section class="so-archive">\n\t<div class="so-container so-archive__inner">\n${body.join('\n')}\n\t</div>\n</section>` : ''].filter(Boolean).join('\n')
    : `<section class="so-archive">\n\t<div class="so-container so-archive__inner">\n${header}\n${body.join('\n')}\n\t</div>\n</section>`;
  return HEADER_NOTE(`siteorigin/collections/${collectionId}/collection.json`) + `<script>\n${script}\n</script>\n\n<svelte:head>\n${head.join('\n')}\n</svelte:head>\n\n` + `${sections}\n\n${archiveStyle(uses)}`;
}

/**
 * The snippet an index's browse component lists the entries that match with: the grid of ready-made cards, each card
 * written from the entry's row in the collection's browse index (see generator/collection-browse.ts) as the page's own
 * cards are written from the entry.
 */
function browseResults(): string {
  return [
    `\t\t\t{#snippet results(entries)}`,
    `\t\t\t\t<ul class="so-archive__grid">`,
    `\t\t\t\t\t{#each entries as entry (entry.id)}`,
    `\t\t\t\t\t\t<li>`,
    `\t\t\t\t\t\t\t<article class="so-archive__card">`,
    `\t\t\t\t\t\t\t\t{#if entry.image}<SoImage image={entry.image} sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw" class="so-archive__image" />{/if}`,
    `\t\t\t\t\t\t\t\t<div class="so-archive__text">`,
    `\t\t\t\t\t\t\t\t\t{#if entry.categories.length}<p class="so-archive__category">{#each entry.categories as category, i (i)}{#if i}, {/if}{#if category.route}<a href={resolve(category.route)}>{category.label}</a>{:else}<span>{category.label}</span>{/if}{/each}</p>{/if}`,
    `\t\t\t\t\t\t\t\t\t<h2 class="so-archive__title"><a href={resolve(entry.route)}>{entry.title}</a></h2>`,
    `\t\t\t\t\t\t\t\t\t{#if entry.date || entry.byline}<p class="so-archive__meta">{#if entry.date}<time datetime={entry.date}>{entry.dateLabel}</time>{/if}{#if entry.date && entry.byline}{' '}{/if}{#if entry.byline}<span>{entry.byline}</span>{/if}</p>{/if}`,
    `\t\t\t\t\t\t\t\t\t{#if entry.excerpt}<p class="so-archive__excerpt">{entry.excerpt}</p>{/if}`,
    `\t\t\t\t\t\t\t\t</div>`,
    `\t\t\t\t\t\t\t</article>`,
    `\t\t\t\t\t\t</li>`,
    `\t\t\t\t\t{/each}`,
    `\t\t\t\t</ul>`,
    `\t\t\t{/snippet}`
  ].join('\n');
}

/** The parts of an archive page that not every one has, each with rules of its own. */
type ArchivePart = 'eyebrow' | 'trail' | 'count' | 'empty' | 'grid' | 'card' | 'lead' | 'split' | 'image' | 'leadImage' | 'category' | 'categoryLink' | 'meta' | 'excerpt' | 'pages' | 'gap';

/** A style rule: its selectors, each with the part it matches (none: every page has it), its declarations, and its media query if it has one. */
type ArchiveRule = [selectors: Array<[selector: string, part?: ArchivePart]>, declarations: string, media?: string];

/** How an archive page looks: the site's own type, colours and spacing, through its design tokens. */
const ARCHIVE_RULES: ArchiveRule[] = [
  [
    [['.so-archive']],
    `padding-block: var(--so-space-3xl, 5rem);`
  ],
  [
    [['.so-archive__inner']],
    `display: flex;
flex-direction: column;
gap: var(--so-space-2xl, 3rem);`
  ],
  [
    [['.so-archive__header']],
    `display: flex;
flex-direction: column;
gap: var(--so-space-sm, 0.75rem);`
  ],
  [
    [['.so-archive__eyebrow', 'eyebrow'], ['.so-archive__category', 'category']],
    `font-family: var(--so-text-eyebrow-family, inherit);
font-size: var(--so-text-eyebrow-size, 0.78rem);
line-height: var(--so-text-eyebrow-line-height, 1.4);
font-weight: var(--so-text-eyebrow-weight, 600);
letter-spacing: var(--so-text-eyebrow-tracking, 0.12em);
text-transform: var(--so-text-eyebrow-transform, uppercase);
color: var(--so-color-brand, inherit);`
  ],
  [
    // A category link (and, on a category's pages, the link back to the index) is a label, not a link in running text:
    // underlined only under the pointer, and at least 24px square to hit. It sits above the card's own link.
    [['.so-archive__category a', 'categoryLink'], ['.so-archive__eyebrow a', 'trail']],
    `position: relative;
z-index: 1;
display: inline-flex;
align-items: center;
min-height: 24px;
min-inline-size: 24px;
color: inherit;
text-decoration: none;`
  ],
  [
    // The link back to the index is underlined at rest: it is the one link in the heading.
    [['.so-archive__category a:hover', 'categoryLink'], ['.so-archive__eyebrow a', 'trail']],
    `text-decoration: underline;
text-underline-offset: 0.2em;`
  ],
  [
    [['.so-archive__eyebrow span', 'trail']],
    `margin-inline: var(--so-space-xs, 0.5rem);`
  ],
  [
    [['.so-archive__heading']],
    `font-family: var(--so-text-h1-family, inherit);
font-size: var(--so-text-h1-size, 2.5rem);
line-height: var(--so-text-h1-line-height, 1.1);
font-weight: var(--so-text-h1-weight, 600);
letter-spacing: var(--so-text-h1-tracking, normal);
text-transform: var(--so-text-h1-transform, none);`
  ],
  [
    [['.so-archive__count', 'count'], ['.so-archive__meta', 'meta'], ['.so-archive__excerpt', 'excerpt'], ['.so-archive__empty', 'empty']],
    `color: var(--so-color-muted, inherit);`
  ],
  [
    // The theme divides the date from the author (a line holding a date), spaced as this gap.
    [['.so-archive__meta', 'meta']],
    `display: flex;
flex-wrap: wrap;
column-gap: var(--so-space-sm, 0.75rem);
font-family: var(--so-text-small-family, inherit);
font-size: var(--so-text-small-size, 0.875rem);
line-height: var(--so-text-small-line-height, 1.5);`
  ],
  [
    // The Post grid section's columns: one on phones, two on tablets, three from desktops.
    [['.so-archive__grid', 'grid']],
    `display: grid;
grid-template-columns: minmax(0, 1fr);
gap: var(--so-space-xl, 2rem);
margin: 0;
padding: 0;
list-style: none;`
  ],
  [[['.so-archive__grid', 'grid']], `grid-template-columns: repeat(2, minmax(0, 1fr));`, '(min-width: 768px)'],
  [[['.so-archive__grid', 'grid']], `grid-template-columns: repeat(3, minmax(0, 1fr));`, '(min-width: 1024px)'],
  [
    [['.so-archive__card', 'card']],
    `position: relative;
display: flex;
flex-direction: column;
gap: var(--so-space-sm, 0.75rem);`
  ],
  [
    // Each card of the grid is a bordered box with no fill, as the Post grid section's are, so a post without a picture
    // is plainly its own and does not read as the caption of the picture beside it.
    [['.so-archive__grid .so-archive__card', 'grid']],
    `height: 100%;
padding: var(--so-space-md, 1rem);
border: var(--so-border-default, 1px solid currentColor);
border-radius: var(--so-radius-lg, 10px);`
  ],
  [
    // The lead's picture, text and their lines spaced as the Featured post section spaces its card.
    [['.so-archive__card--lead', 'lead']],
    `gap: var(--so-space-lg, 1.5rem);`
  ],
  [[['.so-archive__card--lead .so-archive__text', 'lead']], `gap: var(--so-space-md, 1rem);`],
  [
    // The whole card opens its entry: the title's link reaches over it, so the card has one link and one stop.
    [['.so-archive__title a::after', 'card']],
    `content: '';
position: absolute;
inset: 0;
border-radius: inherit;`
  ],
  [
    // Focus on the title's link rings the whole card it opens.
    [['.so-archive__card:has(.so-archive__title a:focus-visible)', 'card']],
    `outline: 2px solid var(--so-surface-ink, var(--so-color-focus, currentColor));
outline-offset: 3px;`
  ],
  [[['.so-archive__title a:focus-visible', 'card']], `outline: none;`],
  [
    [['.so-archive__text', 'card']],
    `display: flex;
flex-direction: column;
gap: var(--so-space-sm, 0.75rem);`
  ],
  [
    [['.so-archive__card :global(.so-archive__image)', 'image']],
    `width: 100%;
height: auto;
aspect-ratio: 3 / 2;
object-fit: cover;
border-radius: var(--so-radius-md, 6px);`
  ],
  [
    [['.so-archive__title', 'card']],
    `font-family: var(--so-text-h3-family, inherit);
font-size: var(--so-text-h3-size, 1.2rem);
line-height: var(--so-text-h3-line-height, 1.35);
font-weight: var(--so-text-h3-weight, 600);
letter-spacing: var(--so-text-h3-tracking, normal);`
  ],
  [
    [['.so-archive__title a', 'card']],
    `color: inherit;
text-decoration: none;`
  ],
  [
    // Under the pointer anywhere the title's link reaches (not on a category link, which goes elsewhere).
    [['.so-archive__title a:hover', 'card'], ['.so-archive__title a:focus-visible', 'card']],
    `text-decoration: underline;
text-decoration-thickness: 1px;
text-underline-offset: 0.15em;`
  ],
  [
    [['.so-archive__card--split', 'split']],
    `display: grid;
grid-template-columns: 1fr 1fr;
align-items: center;
gap: var(--so-space-xl, 2rem);`,
    '(min-width: 768px)'
  ],
  [
    [['.so-archive__card--lead .so-archive__title', 'lead']],
    `font-family: var(--so-text-h2-family, inherit);
font-size: var(--so-text-h2-size, 2rem);
line-height: var(--so-text-h2-line-height, 1.2);
font-weight: var(--so-text-h2-weight, 600);
letter-spacing: var(--so-text-h2-tracking, normal);`
  ],
  [
    [['.so-archive__card--lead :global(.so-archive__image)', 'leadImage']],
    `border-radius: var(--so-radius-lg, 10px);`
  ],
  [
    [['.so-archive__pages', 'pages']],
    `display: flex;
flex-wrap: wrap;
align-items: center;
gap: var(--so-space-md, 1rem);`
  ],
  [
    [['.so-archive__pages ol', 'pages']],
    `display: flex;
flex-wrap: wrap;
gap: var(--so-space-xs, 0.5rem);
margin: 0;
padding: 0;
list-style: none;`
  ],
  [
    [['.so-archive__pages a', 'pages']],
    `display: inline-flex;
align-items: center;
justify-content: center;
min-width: 2.75rem;
min-height: 2.75rem;
padding-inline: var(--so-space-sm, 0.75rem);
border: var(--so-border-default, 1px solid currentColor);
border-radius: var(--so-radius-md, 6px);
color: inherit;
text-decoration: none;`
  ],
  [
    [['.so-archive__pages a:hover', 'pages']],
    `border-color: currentColor;`
  ],
  [
    [[".so-archive__pages a[aria-current='page']", 'pages']],
    `background: var(--so-color-text, #111);
color: var(--so-color-background, #fff);`
  ],
  [
    [[".so-archive__pages li[aria-hidden='true']", 'gap']],
    `align-self: center;`
  ]
];

/** The style block of a page holding `uses`: each selector that matches something on it, and no other. */
function archiveStyle(uses: ReadonlySet<ArchivePart>): string {
  const indent = (text: string) => text.replace(/^/gm, '\t');
  const rules = ARCHIVE_RULES.flatMap(([selectors, declarations, media]) => {
    const matched = selectors.filter(([, part]) => !part || uses.has(part)).map(([selector]) => selector);
    if (!matched.length) return [];
    const rule = `${matched.join(',\n')} {\n${indent(declarations)}\n}`;
    return [indent(media ? `@media ${media} {\n${indent(rule)}\n}` : rule)];
  });
  return `<style>\n${rules.join('\n')}\n</style>\n`;
}
