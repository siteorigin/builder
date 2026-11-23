import type { ComponentDefinition, TableValue } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P, PACK_ID, PACK_VERSION, definitionIdFor } from '../dsl';

/**
 * Data table: named columns and rows of plain text, for timetables and side-by-side comparisons. A theme code
 * component, so the exported page holds a real table: every cell sits under a column header (and, when chosen, a
 * row heading), and a table wider than a phone scrolls sideways inside its own region instead of the page.
 *
 * The source reads its table defensively, so a document edited by hand into an odd shape still renders.
 */
const TABLE_SOURCE = `<script>
	/**
	 * Data table: named columns and rows of plain text. Foundation theme code component.
	 *
	 * Each column's name is a header cell, so a screen reader announces it with every cell below it. With
	 * row headings on, the first column names its row the same way. A table wider than the screen scrolls
	 * sideways inside its own focusable region, so the page itself never does.
	 */
	let {
		eyebrow = '',
		heading = '',
		lead = '',
		caption = '',
		table = { columns: [], rows: [] },
		rowHeaders = false,
		variant = 'default',
		class: className = ''
	} = $props();
	const uid = $props.id();
	const isEntry = (v) => !!v && typeof v === 'object';
	const columns = $derived((Array.isArray(table?.columns) ? table.columns : []).filter(isEntry));
	const rows = $derived((Array.isArray(table?.rows) ? table.rows : []).filter(isEntry));
	const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
	const cell = (row, column) => (isEntry(row.cells) ? text(row.cells[column.id]) : '');
	// The scrolling region is named by the caption, else the heading, so it is never an unnamed stop.
	const captionText = $derived(text(caption).trim());
	const headingText = $derived(text(heading).trim());
	const regionLabel = $derived(captionText ? undefined : headingText || 'Table');
</script>

<section class={['so-table', 'so-table--' + variant, className]}>
	<div class="so-table__inner">
		{#if eyebrow || headingText || lead}
			<div class="so-table__intro">
				{#if eyebrow}<p class="so-table__eyebrow">{eyebrow}</p>{/if}
				{#if headingText}<h2 class="so-table__heading">{heading}</h2>{/if}
				{#if lead}<p class="so-table__lead">{lead}</p>{/if}
			</div>
		{/if}
		<div class="so-table__scroll" role="region" tabindex="0" aria-labelledby={captionText ? uid + '-caption' : undefined} aria-label={regionLabel}>
			<table class="so-table__table">
				{#if captionText}<caption id={uid + '-caption'}>{captionText}</caption>{/if}
				<thead>
					<tr>
						{#each columns as column}
							<th scope="col">{text(column.label)}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row}
						<tr>
							{#each columns as column, i}
								{#if rowHeaders && i === 0}
									<th scope="row">{cell(row, column)}</th>
								{:else}
									<td>{cell(row, column)}</td>
								{/if}
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<style>
	/* Inside a row or grid the section may shrink to its container: only the table's own region scrolls. */
	.so-table {
		min-width: 0;
		max-width: 100%;
		padding-block: var(--so-space-section);
		padding-inline: var(--so-container-gutter);
		background: var(--so-color-background);
		color: var(--so-color-text);
	}
	.so-table--muted {
		background: var(--so-color-surface-alt);
	}
	.so-table--inverse {
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
	}
	.so-table__inner {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xl);
		max-width: var(--so-container-content);
		min-width: 0;
		margin-inline: auto;
	}
	.so-table__intro {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
		max-width: 760px;
	}
	.so-table__eyebrow {
		font-family: var(--so-text-eyebrow-family);
		font-size: var(--so-text-eyebrow-size);
		font-weight: var(--so-text-eyebrow-weight);
		letter-spacing: var(--so-text-eyebrow-tracking);
		line-height: var(--so-text-eyebrow-line-height);
		text-transform: var(--so-text-eyebrow-transform, none);
		color: var(--so-color-brand);
	}
	.so-table--inverse .so-table__eyebrow {
		color: var(--so-color-accent);
	}
	.so-table__heading {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
		font-weight: var(--so-text-h2-weight);
		letter-spacing: var(--so-text-h2-tracking);
		line-height: var(--so-text-h2-line-height);
	}
	.so-table__lead {
		font-size: var(--so-text-lead-size);
		line-height: var(--so-text-lead-line-height);
		color: var(--so-color-muted);
	}
	.so-table--inverse .so-table__lead {
		color: var(--so-color-on-inverse);
		opacity: 0.78;
	}
	/* The table scrolls inside this box, which never grows wider than the section. */
	.so-table__scroll {
		max-width: 100%;
		min-width: 0;
		overflow-x: auto;
		overscroll-behavior-inline: contain;
	}
	.so-table__table {
		width: 100%;
		border-collapse: collapse;
	}
	.so-table__table caption {
		caption-side: top;
		padding-block-end: var(--so-space-sm);
		text-align: start;
		font-weight: 600;
	}
	.so-table__table th,
	.so-table__table td {
		/* Columns keep a readable width and the table scrolls, rather than wrapping each word onto its own line. */
		min-width: 8em;
		padding: 0.8em 1em;
		border-block-end: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		text-align: start;
		vertical-align: top;
		overflow-wrap: normal;
	}
	.so-table__table th:first-child,
	.so-table__table td:first-child {
		padding-inline-start: 0;
	}
	.so-table__table th {
		font-weight: 600;
	}
	.so-table__table thead th {
		border-block-end: 2px solid currentColor;
		font-size: 0.92em;
	}
</style>
`;

/** The table a new placement starts with: a small weekly timetable. */
const DEFAULT_TABLE: TableValue = {
  columns: [
    { id: 'col_day', label: 'Day' },
    { id: 'col_workshop', label: 'Workshop' },
    { id: 'col_time', label: 'Start time' }
  ],
  rows: [
    { id: 'row_1', cells: { col_day: 'Monday', col_workshop: 'Wheel throwing', col_time: '10:00' } },
    { id: 'row_2', cells: { col_day: 'Wednesday', col_workshop: 'Hand building', col_time: '18:30' } },
    { id: 'row_3', cells: { col_day: 'Saturday', col_workshop: 'Glazing', col_time: '09:30' } }
  ]
};

export const dataTable: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: definitionIdFor('data.table'),
  componentId: 'data.table',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Data table',
  description:
    'A table of plain text with named columns: timetables, schedules, opening hours, price lists and side-by-side comparisons. Every cell keeps its column header, and a wide table scrolls sideways on a phone.',
  category: 'content',
  tags: ['table', 'data table', 'timetable', 'schedule', 'comparison', 'compare', 'side by side', 'rows', 'columns', 'opening hours', 'price list', 'specifications'],
  icon: 'list',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Workshop timetable'),
    lead: P.text('Supporting text', ''),
    caption: P.str('Caption', 'Weekly workshops', { description: 'A short title for the table, read out before it. It also names the table’s scrolling area.' }),
    table: { type: 'table', label: 'Table', default: DEFAULT_TABLE },
    rowHeaders: P.bool('Use the first column as row headings', false)
  },
  // The root places the classes it is given, so these style changes (hiding at a size included) show.
  parts: { root: { nodeId: 'root', label: 'Table section', styleControls: ['paddingBlock', 'background', 'color', 'hidden'] } },
  variantAxes: {
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: TABLE_SOURCE,
  provenance: { pack: PACK_ID, packVersion: PACK_VERSION, componentId: 'data.table' },
  license: 'GPL-3.0-or-later'
};
