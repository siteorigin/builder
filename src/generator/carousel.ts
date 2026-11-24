/**
 * The carousel helper (`ElementNode.carousel`), written into every site's runtime folder beside the other helpers. A
 * carousel is plain HTML and CSS first: its list scrolls sideways and stops at each slide by touch, trackpad, scroll
 * bar or keyboard, with or without the page's script, and prints as a stack. The script adds what only it can: the
 * Previous and Next buttons and the count of the slides showing.
 */

/** Where a carousel is: what it measures on the page, which slides show and where its buttons go. */
export const CAROUSEL_JS = String.raw`/**
 * Where a carousel is (see Carousel.svelte): the slides that show and where its Previous and Next buttons go. Every
 * distance is measured along the list from the side it starts on, so a right-to-left list works the same way.
 */

/**
 * The list as it is laid out now: where each slide starts and how wide it is, how far the list has scrolled (at),
 * how much of it shows (size) and how far it can scroll (max), all in the list's own units, as it scrolls.
 */
export function measure(list) {
	const rtl = getComputedStyle(list).direction === 'rtl';
	const box = list.getBoundingClientRect();
	// A list drawn larger or smaller than it is laid out (a scale on it or around it) is measured as it is laid out.
	const k = (list.offsetWidth ? box.width / list.offsetWidth : 1) || 1;
	const left = box.left + list.clientLeft * k;
	const right = left + list.clientWidth * k;
	// A right-to-left list scrolls to negative positions.
	const at = Math.abs(list.scrollLeft);
	const slides = [];
	for (const el of list.children) {
		const r = el.getBoundingClientRect();
		if (r.width > 0) slides.push({ start: (rtl ? right - r.right : r.left - left) / k + at, size: r.width / k });
	}
	return { rtl, at, size: list.clientWidth, max: Math.max(0, list.scrollWidth - list.clientWidth), slides };
}

/**
 * Which slides show: each one at least half in view (or filling at least half of it), and whether the list can
 * scroll back or forward. A pixel either way is rounding, not a slide.
 */
export function view(m) {
	const end = m.at + m.size;
	const shown = [];
	let best = -1;
	let most = -Infinity;
	m.slides.forEach((s, i) => {
		const seen = Math.min(s.start + s.size, end) - Math.max(s.start, m.at);
		if (seen >= Math.min(s.size, m.size) / 2 - 1) shown.push(i);
		if (seen > most) {
			most = seen;
			best = i;
		}
	});
	if (!shown.length && best >= 0) shown.push(best);
	return {
		total: m.slides.length,
		first: shown.length ? shown[0] : 0,
		last: shown.length ? shown[shown.length - 1] : 0,
		scrolls: m.max > 1,
		back: m.at > 1,
		forward: m.at < m.max - 1
	};
}

/** What the count says: "Slide 2 of 5", or "Slides 2–4 of 5" while several show. */
export function status(v) {
	if (!v.total) return '';
	if (v.first === v.last) return 'Slide ' + (v.first + 1) + ' of ' + v.total;
	return 'Slides ' + (v.first + 1) + '–' + (v.last + 1) + ' of ' + v.total;
}

/**
 * Where a step goes: to the start of the next slide (dir 1) or the previous one (-1), as far as the list scrolls,
 * or to its very end (Infinity) or start (-Infinity). Null when the list is already there.
 */
export function step(m, dir) {
	if (dir > 0 ? m.at >= m.max - 1 : m.at <= 1) return null;
	if (dir === Infinity) return m.max;
	if (dir === -Infinity) return 0;
	const stops = m.slides.map((s) => Math.min(m.max, Math.max(0, s.start)));
	if (dir > 0) return stops.filter((s) => s > m.at + 1).reduce((a, b) => Math.min(a, b), m.max);
	return stops.filter((s) => s < m.at - 1).reduce((a, b) => Math.max(a, b), 0);
}
`;

/**
 * The carousel's list and its controls. The generator passes it the list's classes, name, anchor and (in the editor)
 * the attributes that find it, and renders the slides inside it.
 */
export const CAROUSEL_SVELTE = String.raw`<script>
	/**
	 * A carousel (ElementNode.carousel): a list that scrolls sideways and stops at each slide, by touch, trackpad,
	 * scroll bar or keyboard, with or without the page's script. Once the script runs it adds Previous and Next
	 * buttons and says which slides show. The buttons, and the arrow keys, Home and End while the list has focus,
	 * move a slide at a time, at once for a visitor who asks for reduced motion. Printed, the slides stack down the page.
	 */
	import { onMount } from 'svelte';
	import { measure, status, step, view } from './carousel.js';

	let { children, class: className = '', id = undefined, 'aria-label': label = undefined, ...rest } = $props();
	const uid = $props.id();
	const listId = $derived(id || 'so-carousel-' + uid);
	let list = $state();
	// Until the script has measured it, the list is taken to scroll, so a keyboard can always reach it.
	let shown = $state({ total: 0, first: 0, last: 0, scrolls: true, back: false, forward: false });
	let said = $state('');
	let ready = $state(false);
	let frame = 0;
	let settle = 0;
	// Where the step under way is going, so a second press before it arrives goes on from there.
	let aim = null;

	function update() {
		frame = 0;
		if (!list) return;
		const m = measure(list);
		// A step that has arrived is over: the next one goes on from where the list is.
		if (aim !== null && Math.abs(m.at - aim) <= 1) aim = null;
		shown = view(m);
		// The count changes once the list comes to rest, so a screen reader hears where it stopped, not each slide passed.
		if (!settle) said = status(shown);
	}

	function schedule() {
		if (!frame) frame = requestAnimationFrame(update);
	}

	function scrolled() {
		schedule();
		clearTimeout(settle);
		settle = setTimeout(() => {
			settle = 0;
			aim = null;
			schedule();
		}, 150);
	}

	function go(dir) {
		if (!list) return;
		const m = measure(list);
		const to = step(aim === null ? m : { ...m, at: aim }, dir);
		if (to === null) return;
		// Asked at each step, so a change of the setting applies at once.
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		list.scrollTo({ left: m.rtl ? -to : to, behavior: reduce ? 'instant' : 'smooth' });
		aim = reduce ? null : to;
		if (aim !== null) scrolled();
	}

	// The arrow keys on the list itself; on a link inside it they keep doing what they do there.
	function keydown(event) {
		if (event.target !== list || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const back = getComputedStyle(list).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
		const dir = event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : event.key === back ? -1 : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 1 : 0;
		if (!dir) return;
		event.preventDefault();
		go(dir);
	}

	onMount(() => {
		const el = list;
		// Another width, a slide added or removed, or an image loaded changes what shows.
		const sizes = new ResizeObserver(schedule);
		const watch = () => {
			sizes.disconnect();
			sizes.observe(el);
			for (const slide of el.children) sizes.observe(slide);
		};
		const slides = new MutationObserver(() => {
			watch();
			schedule();
		});
		watch();
		slides.observe(el, { childList: true });
		// A new width can change the space between slides without changing any of their sizes.
		window.addEventListener('resize', schedule);
		ready = true;
		update();
		return () => {
			sizes.disconnect();
			slides.disconnect();
			window.removeEventListener('resize', schedule);
			cancelAnimationFrame(frame);
			clearTimeout(settle);
			frame = 0;
			settle = 0;
		};
	});
</script>

<div class="so-carousel">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<ul
		{...rest}
		bind:this={list}
		id={listId}
		class={['so-carousel__list', className]}
		aria-label={label || 'Slides'}
		tabindex={shown.scrolls ? 0 : undefined}
		onscroll={scrolled}
		onkeydown={keydown}
	>
		{@render children?.()}
	</ul>
	{#if ready && shown.scrolls && shown.total}
		<div class="so-carousel__controls">
			<p class="so-carousel__status" role="status">{said}</p>
			<button type="button" class="so-carousel__step" aria-controls={listId} aria-disabled={!shown.back} onclick={() => go(-1)}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
				<span class="so-visually-hidden">Previous</span>
			</button>
			<button type="button" class="so-carousel__step" aria-controls={listId} aria-disabled={!shown.forward} onclick={() => go(1)}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
				<span class="so-visually-hidden">Next</span>
			</button>
		</div>
	{/if}
</div>

<style>
	.so-carousel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		max-width: 100%;
	}
	/* One row that scrolls sideways and stops at the start of each slide. Weightless, so whatever the design sets on
	   the list or its slides (hiding them, their overflow) wins. */
	:global(:where(.so-carousel__list)) {
		display: flex;
		min-width: 0;
		max-width: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
	}
	:global(:where(.so-carousel__list) > *) {
		flex: none;
		min-width: 0;
		scroll-snap-align: start;
	}
	/* What is inside draws its focus ring inside itself, where the scrolling box shows all of it. */
	.so-carousel__list :global(:focus-visible) {
		outline-offset: -3px;
	}
	.so-carousel__controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.so-carousel__status {
		margin-inline-end: auto;
		font-variant-numeric: tabular-nums;
	}
	.so-carousel__step {
		cursor: pointer;
	}
	.so-carousel__step[aria-disabled='true'] {
		cursor: default;
		opacity: 0.4;
	}
	.so-carousel__step svg {
		display: block;
		width: 1.25rem;
		height: 1.25rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.so-carousel__step:dir(rtl) svg {
		transform: scaleX(-1);
	}
	/* Printed, every slide shows, one below the other, and the buttons, which only work on screen, are left out. A
	   list the design hides stays hidden; the slides' widths for each screen give way. */
	@media print {
		:global(:where(.so-carousel__list)) {
			display: grid;
			gap: 1rem;
			overflow: visible;
			scroll-snap-type: none;
		}
		:global(:where(.so-carousel__list) > *) {
			width: auto !important;
		}
		.so-carousel__controls {
			display: none !important;
		}
	}
</style>
`;
