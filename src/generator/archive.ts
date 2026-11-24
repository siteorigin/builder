/**
 * A collection's index and category archive pages (see shared/archives.ts), written as static pages inside the site's
 * own header and footer. Each lists its share of the collection's published entries, newest first, as cards (featured
 * picture, categories, title, date, author and excerpt), and links to the pages before and after it in its series,
 * in its head (`<link rel="prev">`, `<link rel="next">`) and in a labelled list of page links. Everything shown is
 * written into the page when the site is generated: visitors' browsers look nothing up.
 */
import type { ArchivePage } from '@shared/archives';
import { archivePages, categoryTerms } from '@shared/archives';
import { entryRow } from '@shared/entry-feed';
import { siteLanguage } from '@shared/languages';
import { publicUrl } from '@shared/public-url';
import { routeDir } from '@shared/routes';
import { visitorTextFor } from '@shared/visitor-text';
import type { ProjectState } from '@shared/types';
import { derived } from './cache';
import { HEADER_NOTE, RUNTIME_DIR, js, relImport, resolveImage } from './index';

/** The route file of an archive page. */
export function archiveFile(route: string): string {
  return `src/routes/${routeDir(route)}/+page.svelte`;
}

/**
 * The archive pages of one collection, worked out once per state in a cached run: an archive page depends on its own
 * series and the entries it lists, not on every entry of every collection.
 */
export function collectionArchives(state: ProjectState, collectionId: string): ArchivePage[] {
  return derived(state, `archivePages:${collectionId}`, (s) => archivePages(s).filter((p) => p.collectionId === collectionId));
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

const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((t, [k, v]) => t.replaceAll(`{${k}}`, String(v)), text);
const href = (route: string) => `{resolve(${js(route)})}`;

/** One archive page: `route` must be one of the collection's archive pages in `state`. */
export function generateArchive(state: ProjectState, collectionId: string, route: string): string {
  const series = collectionArchives(state, collectionId);
  const here = series.find((p) => p.route === route)!;
  const collection = state.collections[collectionId];
  const site = state.site;
  const words = visitorTextFor(site, siteLanguage(site));
  const file = archiveFile(route);
  // Category labels link to their archive while the category has one.
  const archives = new Map(series.filter((p) => p.category && p.page === 1).map((p) => [p.category!, p.route]));
  const terms = new Map(categoryTerms(collection).map((t) => [t.id, t.label]));
  const name = collection.settings.name;
  const heading = here.category ? (terms.get(here.category) ?? here.category) : name;
  const title = `${heading}${here.page > 1 ? ` – ${fill(words.archivePageOf, { page: here.page, count: here.pages })}` : ''} · ${site.name}`;
  const rctx = { state };
  let usesImage = false;

  const card = (entryId: string, lead: boolean, level: 'h2' | 'h3') => {
    const entry = collection.entries[entryId];
    const row = entryRow(state, collection, entry);
    const image = row.image?.assetId ? resolveImage(row.image, rctx) : null;
    if (image) usesImage = true;
    const ids = Array.isArray(entry.terms?.categories) ? entry.terms.categories.filter((t) => terms.has(t)) : [];
    const lines: string[] = [];
    if (image) lines.push(`\t\t\t<SoImage image={${js(image)}} sizes=${js(lead ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw')}${lead && here.page === 1 ? ' eager' : ''} class="so-archive__image" />`);
    lines.push(`\t\t\t<div class="so-archive__text">`);
    if (ids.length)
      lines.push(
        `\t\t\t\t<p class="so-archive__category">${ids
          .map((t) => {
            const label = `{${js(terms.get(t))}}`;
            const to = archives.get(t);
            return to && to !== route ? `<a href=${href(to)}>${label}</a>` : `<span>${label}</span>`;
          })
          .join(', ')}</p>`
      );
    lines.push(`\t\t\t\t<${level} class="so-archive__title"><a href=${href(entryRouteOf(entryId))}>{${js(row.title)}}</a></${level}>`);
    const meta = [row.date ? `<time datetime=${js(row.date)}>{${js(row.dateLabel)}}</time>` : '', row.byline ? `<span>{${js(row.byline)}}</span>` : ''].filter(Boolean);
    if (meta.length) lines.push(`\t\t\t\t<p class="so-archive__meta">${meta.join(' ')}</p>`);
    if (row.excerpt) lines.push(`\t\t\t\t<p class="so-archive__excerpt">{${js(row.excerpt)}}</p>`);
    lines.push(`\t\t\t</div>`);
    return `<article class="so-archive__card${lead ? ' so-archive__card--lead' : ''}">\n${lines.join('\n')}\n\t\t</article>`;
  };
  const entryRouteOf = (entryId: string) => `${collection.settings.route}${collection.entries[entryId].slug}/`;

  // The first page of the index leads with its newest entry, shown large; every other page is a grid of cards.
  const ids = here.entryIds.filter((id) => Object.hasOwn(collection.entries, id));
  const lead = !here.category && here.page === 1 && ids.length ? ids[0] : undefined;
  const rest = lead ? ids.slice(1) : ids;
  const body: string[] = [];
  if (lead) body.push(`\t\t${card(lead, true, 'h2')}`);
  if (rest.length) body.push(`\t\t<ul class="so-archive__grid">\n${rest.map((id) => `\t\t\t<li>${card(id, false, 'h2').replace(/\n/g, '\n\t')}</li>`).join('\n')}\n\t\t</ul>`);
  if (!ids.length) body.push(`\t\t<p class="so-archive__empty">{${js(words.archiveEmpty)}}</p>`);
  if (here.pages > 1) {
    const step = (to: string | undefined, rel: 'prev' | 'next', label: string) => (to ? `\t\t\t<a class="so-archive__step" rel=${js(rel)} href=${href(to)}>{${js(label)}}</a>` : '');
    const numbers = pageLinks(here.page, here.pages)
      .map((n) => {
        if (n === null) return `\t\t\t\t<li aria-hidden="true">…</li>`;
        const to = series.find((p) => p.category === here.category && p.page === n)!.route;
        return `\t\t\t\t<li><a href=${href(to)} aria-label={${js(fill(words.archivePage, { page: n }))}}${n === here.page ? ' aria-current="page"' : ''}>${n}</a></li>`;
      })
      .join('\n');
    body.push(
      [`\t\t<nav class="so-archive__pages" aria-label={${js(words.archiveNav)}}>`, step(here.prev, 'prev', words.archivePrevious), `\t\t\t<ol>\n${numbers}\n\t\t\t</ol>`, step(here.next, 'next', words.archiveNext), `\t\t</nav>`]
        .filter(Boolean)
        .join('\n')
    );
  }

  const head: string[] = [`\t<title>{${js(title)}}</title>`, `\t<meta property="og:type" content="website" />`, `\t<meta property="og:title" content={${js(title)}} />`];
  const base = publicUrl(site);
  if (base) head.push(`\t<link rel="canonical" href={${js(base + route)}} />`, `\t<meta property="og:url" content={${js(base + route)}} />`);
  if (here.prev) head.push(`\t<link rel="prev" href=${href(here.prev)} />`);
  if (here.next) head.push(`\t<link rel="next" href=${href(here.next)} />`);

  const imports = [`\timport { resolve } from '$app/paths';`, ...(usesImage ? [`\timport SoImage from ${js(relImport(file, `${RUNTIME_DIR}/Image.svelte`))};`] : [])];
  const intro = [
    here.category ? `\t\t\t<p class="so-archive__eyebrow">{${js(words.archiveCategory)}}</p>` : '',
    `\t\t\t<h1 class="so-archive__heading">{${js(heading)}}</h1>`,
    here.page > 1 ? `\t\t\t<p class="so-archive__count">{${js(fill(words.archivePageOf, { page: here.page, count: here.pages }))}}</p>` : ''
  ].filter(Boolean);
  return (
    HEADER_NOTE(`siteorigin/collections/${collectionId}/collection.json`) +
    `<script>\n${imports.join('\n')}\n</script>\n\n<svelte:head>\n${head.join('\n')}\n</svelte:head>\n\n` +
    `<section class="so-archive">\n\t<div class="so-container so-archive__inner">\n\t\t<header class="so-archive__header">\n${intro.join('\n')}\n\t\t</header>\n${body.join('\n')}\n\t</div>\n</section>\n\n${ARCHIVE_STYLE}`
  );
}

/** How an archive page looks: the site's own type, colours and spacing, through its design tokens. */
const ARCHIVE_STYLE = `<style>
	.so-archive {
		padding-block: var(--so-space-3xl, 5rem);
	}
	.so-archive__inner {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xl, 3rem);
	}
	.so-archive__header {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-sm, 0.75rem);
	}
	.so-archive__eyebrow,
	.so-archive__category {
		font-family: var(--so-text-eyebrow-family, inherit);
		font-size: var(--so-text-eyebrow-size, 0.78rem);
		line-height: var(--so-text-eyebrow-line-height, 1.4);
		font-weight: var(--so-text-eyebrow-weight, 600);
		letter-spacing: var(--so-text-eyebrow-tracking, 0.12em);
		text-transform: var(--so-text-eyebrow-transform, uppercase);
		color: var(--so-color-brand, inherit);
	}
	.so-archive__category a {
		color: inherit;
	}
	.so-archive__heading {
		font-family: var(--so-text-h1-family, inherit);
		font-size: var(--so-text-h1-size, 2.5rem);
		line-height: var(--so-text-h1-line-height, 1.1);
		font-weight: var(--so-text-h1-weight, 600);
		letter-spacing: var(--so-text-h1-tracking, normal);
		text-transform: var(--so-text-h1-transform, none);
	}
	.so-archive__count,
	.so-archive__meta,
	.so-archive__excerpt,
	.so-archive__empty {
		color: var(--so-color-muted, inherit);
	}
	.so-archive__meta {
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--so-space-md, 1rem);
		font-family: var(--so-text-small-family, inherit);
		font-size: var(--so-text-small-size, 0.875rem);
		line-height: var(--so-text-small-line-height, 1.5);
	}
	.so-archive__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
		gap: var(--so-space-xl, 2rem);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.so-archive__card {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-sm, 0.75rem);
	}
	.so-archive__text {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-sm, 0.75rem);
	}
	.so-archive__card :global(.so-archive__image) {
		width: 100%;
		height: auto;
		aspect-ratio: 3 / 2;
		object-fit: cover;
		border-radius: var(--so-radius-md, 6px);
	}
	.so-archive__title {
		font-family: var(--so-text-h3-family, inherit);
		font-size: var(--so-text-h3-size, 1.2rem);
		line-height: var(--so-text-h3-line-height, 1.35);
		font-weight: var(--so-text-h3-weight, 600);
		letter-spacing: var(--so-text-h3-tracking, normal);
	}
	.so-archive__title a {
		color: inherit;
		text-decoration: none;
	}
	.so-archive__title a:hover,
	.so-archive__title a:focus-visible {
		text-decoration: underline;
	}
	@media (min-width: 768px) {
		.so-archive__card--lead {
			display: grid;
			grid-template-columns: 1fr 1fr;
			align-items: center;
			gap: var(--so-space-xl, 2rem);
		}
	}
	.so-archive__card--lead .so-archive__title {
		font-family: var(--so-text-h2-family, inherit);
		font-size: var(--so-text-h2-size, 2rem);
		line-height: var(--so-text-h2-line-height, 1.2);
		font-weight: var(--so-text-h2-weight, 600);
		letter-spacing: var(--so-text-h2-tracking, normal);
	}
	.so-archive__card--lead :global(.so-archive__image) {
		border-radius: var(--so-radius-lg, 10px);
	}
	.so-archive__pages {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--so-space-md, 1rem);
	}
	.so-archive__pages ol {
		display: flex;
		flex-wrap: wrap;
		gap: var(--so-space-xs, 0.5rem);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.so-archive__pages a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2.75rem;
		min-height: 2.75rem;
		padding-inline: var(--so-space-sm, 0.75rem);
		border: var(--so-border-default, 1px solid currentColor);
		border-radius: var(--so-radius-md, 6px);
		color: inherit;
		text-decoration: none;
	}
	.so-archive__pages a[aria-current='page'] {
		background: var(--so-color-text, #111);
		color: var(--so-color-background, #fff);
	}
	.so-archive__pages li[aria-hidden='true'] {
		align-self: center;
	}
</style>
`;
