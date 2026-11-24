import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P, tok } from '../dsl';
import { FOUNDATION } from './pack';
import { mutedStyles } from './common';
import { SAMPLE_CONTACT } from '@shared/sample-contact';

const { managed } = FOUNDATION;

const HEADER_SOURCE = `<script>
	/**
	 * Site header with a working, accessible mobile menu.
	 * Foundation theme code component. Props are edited in SiteOrigin Builder.
	 */
	import { onMount } from 'svelte';
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import SoImage from '../runtime/Image.svelte';
	import { fill, visitorText } from '../runtime/visitor-text.js';

	let {
		siteName = 'Studio',
		logo = null,
		links = [],
		ctaLabel = '',
		ctaLink = null,
		ctaStyle = 'primary',
		sticky = true,
		surface = 'background',
		showSiteName = true,
		notice = '',
		noticeLabel = '',
		noticeLink = null,
		class: className = ''
	} = $props();

	// The names of the menu and submenu buttons and of the navigation, in the language of the page.
	const text = visitorText();
	// The item ID of the link whose submenu is open; one at a time.
	let openSub = $state(null);
	let header = $state();
	// The phone menu is a native disclosure, and its open attribute is the menu's only state: the browser opens it
	// before the site's script runs (or when it never does), and the script keeps whatever the visitor chose.
	let menu = $state();
	let toggle = $state();
	// A link marked to show under the link above joins the submenu of the nearest top-level link before it; one
	// with none before it stays at the top level.
	const groups = $derived.by(() => {
		const out = [];
		for (const item of Array.isArray(links) ? links : []) {
			if (item?.sub === true && out.length) out[out.length - 1].children.push(item);
			else out.push({ item, children: [] });
		}
		return out;
	});
	// Route IDs ("/about") do not depend on the base path the site is published under.
	const current = $derived(page.route.id);
	// The visible name, when there is one to show. Beside it the logo is decorative, so the brand is announced once.
	const name = $derived(typeof siteName === 'string' ? siteName.trim() : '');
	const nameShown = $derived(!!name && (showSiteName || !logo?.src));
	// A logo shown alone names the link by its own alternative text, which matches what it visibly says.
	const logoAlt = $derived(logo?.src && !logo.decorative && typeof logo.alt === 'string' ? logo.alt.trim() : '');
	// The logo shows 34px tall and at most 160px wide, so a small copy of the picture is all it needs.
	const logoSizes = $derived(logo?.width > 0 && logo?.height > 0 ? \`\${Math.min(160, Math.ceil((34 * logo.width) / logo.height))}px\` : '160px');
	// The notice above the header, on every page that shows it. Its words show it, so clearing them removes it
	// (link and all); its link follows them once it has both a label and somewhere to go.
	const noticeText = $derived(typeof notice === 'string' ? notice.trim() : '');
	const noticeLinkText = $derived(noticeText && typeof noticeLabel === 'string' && noticeLink?.href ? noticeLabel.trim() : '');

	/** Site-relative links go through resolve() so the site works under a sub-path. */
	const href = (link) => (link?.href?.startsWith('/') && !link.href.startsWith('//') ? resolve(link.href) : link?.href);
	/** A link to one of the site's documents downloads it under its own file name. */
	const download = (link) => (link?.href?.startsWith('/') && typeof link.download === 'string' && link.download ? link.download : undefined);
	const isCurrent = (link) => !!link?.href?.startsWith('/') && !link.href.includes('#') && (link.href.length > 1 && link.href.endsWith('/') ? link.href.slice(0, -1) : link.href) === current;

	function closeMenu() {
		if (menu?.open) menu.open = false;
	}

	// Arriving on another page closes any open submenu.
	$effect(() => {
		void current;
		openSub = null;
	});

	/** The element ID of the submenu under the link with this item ID: by its place in the menu, unique and safe.
	 *  A section's anchor cannot hold a colon, so it never shares an ID with one. */
	const subId = (id) => \`so-sub:\${groups.findIndex((g) => g.item.id === id)}\`;
	const subToggle = (id) => header?.querySelector(\`[aria-controls="\${subId(id)}"]\`);

	/** Choosing a link closes the menus, including links to the current page or an anchor on it. */
	function chose() {
		closeMenu();
		openSub = null;
	}

	/**
	 * Publishes how far down the window the header reaches while it stays at the top (0 when it scrolls away, is
	 * hidden or stays at the bottom) as --so-header-offset on the page root. The theme's [id] scroll margin adds
	 * to it, so jump links land below it. The computed style also counts a position set as a style: a sticky
	 * header stays in view at its top inset (only when it has one), a fixed one where it is, and either covers
	 * the top of the window when it sits nearer the top edge than the bottom.
	 *
	 * First it measures the notice above the brand row as --so-header-notice on the header: a sticky header is
	 * pinned that far above the window's top edge, so the notice scrolls away with the page however long it is,
	 * and the brand row, the menu button and the menu stay on screen.
	 */
	function publishOffset(el) {
		// Down to the notice's bottom edge, so the header's own padding and border above it scroll away too.
		const notice = el.querySelector('.so-header__notice');
		const noticeHeight = notice ? notice.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 'px' : '';
		if (el.style.getPropertyValue('--so-header-notice') !== noticeHeight) {
			if (noticeHeight) el.style.setProperty('--so-header-notice', noticeHeight);
			else el.style.removeProperty('--so-header-notice');
		}
		const root = el.ownerDocument.documentElement;
		const style = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		const top = parseFloat(style.top);
		const pinned = style.position === 'sticky' && Number.isFinite(top) ? top : style.position === 'fixed' ? box.top : NaN;
		const bottom = pinned + box.height;
		const reach = box.height > 0 && pinned < el.ownerDocument.defaultView.innerHeight - bottom ? Math.max(bottom, 0) : 0;
		const value = Math.ceil(reach) + 'px';
		if (root.style.getPropertyValue('--so-header-offset') !== value) root.style.setProperty('--so-header-offset', value);
	}

	// The height changes when the brand or the links wrap, at a breakpoint, and when the fonts load; an inset in
	// window units changes with the window. The sticky setting changes the position without the size, which the
	// observer would miss.
	$effect(() => {
		const el = header;
		if (!el) return;
		void sticky;
		const win = el.ownerDocument.defaultView;
		const update = () => publishOffset(el);
		// Chromium can resolve window units against the old size for a frame after the resize event.
		let frame = 0;
		const resized = () => {
			win.cancelAnimationFrame(frame);
			frame = win.requestAnimationFrame(() => {
				update();
				frame = win.requestAnimationFrame(update);
			});
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el, { box: 'border-box' });
		win.addEventListener('resize', resized);
		return () => {
			observer.disconnect();
			win.removeEventListener('resize', resized);
			win.cancelAnimationFrame(frame);
			el.ownerDocument.documentElement.style.removeProperty('--so-header-offset');
			el.style.removeProperty('--so-header-notice');
		};
	});

	/**
	 * A visitor who opens a link to an anchor is scrolled there by the browser before the height above is
	 * published, so a tall header can cover the target. Once that scroll (smooth by default) has come to rest, and
	 * again once the fonts have loaded (they can make the header taller), reveals the target if the header covers
	 * it, until the visitor moves on. Returns a function that stops it.
	 */
	function revealBookmark(el) {
		const doc = el.ownerDocument;
		const win = doc.defaultView;
		const hash = win.location.hash;
		let done = false;
		let frame = 0;
		const moves = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
		const stop = () => {
			done = true;
			win.cancelAnimationFrame(frame);
			for (const type of moves) win.removeEventListener(type, stop, { capture: true });
		};
		for (const type of moves) win.addEventListener(type, stop, { capture: true, passive: true });
		const reveal = () => {
			if (done || win.location.hash !== hash) return;
			let target;
			try {
				target = doc.getElementById(decodeURIComponent(hash.slice(1)));
			} catch {
				return;
			}
			if (!target || el.contains(target)) return;
			publishOffset(el);
			const box = target.getBoundingClientRect();
			const cover = el.getBoundingClientRect();
			if (box.top < cover.bottom - 0.5 && box.bottom > Math.max(cover.top, 0)) target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
		};
		// At rest once the page has not moved for three frames, or after two seconds of movement.
		const settle = () => {
			let last = NaN;
			let still = 0;
			let frames = 0;
			const step = () => {
				if (done) return;
				still = win.scrollY === last ? still + 1 : 0;
				last = win.scrollY;
				if (still >= 3 || ++frames >= 120) reveal();
				else frame = win.requestAnimationFrame(step);
			};
			win.cancelAnimationFrame(frame);
			frame = win.requestAnimationFrame(step);
		};
		settle();
		doc.fonts?.ready.then(() => {
			if (!done) settle();
		});
		return stop;
	}

	// Only on arriving at the site with an anchor in a fresh visit: a reload, a history visit or a reopened tab
	// (whose position SvelteKit has restored) keeps that position, and a header shown again later in the visit
	// leaves the page where it is.
	let stopReveal;
	afterNavigate(({ type }) => {
		// Arriving on another page folds the menu away; the page the visit starts on keeps it as the visitor left it.
		if (type !== 'enter') closeMenu();
		stopReveal?.();
		stopReveal = undefined;
		const win = header?.ownerDocument.defaultView;
		if (type !== 'enter' || !win || win.location.hash.length < 2) return;
		if (win.performance.getEntriesByType?.('navigation')[0]?.type !== 'navigate' || win.history.scrollRestoration === 'manual') return;
		stopReveal = revealBookmark(header);
	});
	// Leaving the page, the outgoing one stays put until the next one renders.
	beforeNavigate(() => {
		stopReveal?.();
		stopReveal = undefined;
	});
	onMount(() => () => stopReveal?.());
	// A menu opened before the script started, which focus has since left for the page, folds away as it starts.
	onMount(() => {
		const active = header?.ownerDocument.activeElement;
		if (active && active !== header.ownerDocument.body && !header.contains(active)) closeMenu();
	});

	// Escape closes an open submenu first, back to its toggle, and then the phone menu, back to its button. Focus goes
	// back only from inside the header (or from nowhere), never from the page.
	function onKeydown(event) {
		if (event.key !== 'Escape') return;
		const active = header?.ownerDocument.activeElement;
		const inside = !active || active === header?.ownerDocument.body || !!header?.contains(active);
		if (openSub !== null) {
			const id = openSub;
			openSub = null;
			if (inside) subToggle(id)?.focus();
		} else if (menu?.open) {
			closeMenu();
			if (inside) toggle?.focus();
		}
	}

	// A press outside the open submenu's link and list closes it; one outside the header closes the phone menu.
	function onPointerdown(event) {
		if (openSub !== null && !subToggle(openSub)?.closest('li')?.contains(event.target)) openSub = null;
		if (menu?.open && header && !header.contains(event.target)) closeMenu();
	}

	// Focus that leaves the header (Tab past the last link, Shift+Tab past the brand) folds the menu away and stays
	// on the control it reached. Moving between the button and the links keeps it open.
	function onFocusin(event) {
		if (menu?.open && header && !header.contains(event.target)) closeMenu();
	}

	// Focus moving to something outside a submenu's link and list closes it. Focus going nowhere (a press on the
	// page, another window) is left to the press.
	function onGroupFocusout(event, id) {
		if (openSub === id && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) openSub = null;
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointerdown} onfocusin={onFocusin} />

<header class={['so-header', \`so-header--\${surface}\`, sticky && 'so-header--sticky', className]} bind:this={header}>
	{#if noticeText}
		<div class="so-header__notice">
			<p class="so-header__notice-inner">
				<span>{noticeText}</span>
				{#if noticeLinkText}
					<a
						href={href(noticeLink)}
						target={noticeLink.newTab ? '_blank' : undefined}
						rel={noticeLink.newTab ? 'noopener noreferrer' : undefined}
						onclick={chose}>{noticeLinkText}</a
					>
				{/if}
			</p>
		</div>
	{/if}
	<div class="so-header__inner">
		<!-- Without the visible name, the link is still named for screen readers. -->
		<a class="so-header__brand" href={resolve('/')} aria-label={nameShown || logoAlt ? undefined : name || text().home}>
			{#if logo?.src}
				<SoImage image={nameShown ? { ...logo, decorative: true } : logo} class="so-header__logo" sizes={logoSizes} eager />
			{/if}
			{#if nameShown}
				<span>{name}</span>
			{/if}
		</a>

		<!-- The browser announces whether the menu is expanded, so the button's name stays the same either way. Opening
		     or closing it folds any open submenu away. -->
		<details class="so-header__menu" bind:this={menu} ontoggle={() => (openSub = null)}>
			<summary bind:this={toggle} class="so-header__toggle" aria-controls="so-site-nav">
				<span class="so-visually-hidden">{text().menu}</span>
				<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
					<path class="so-header__icon-open" d="M4 7h16M4 12h16M4 17h16" />
					<path class="so-header__icon-close" d="M6 6l12 12M18 6L6 18" />
				</svg>
			</summary>
		</details>

		<!-- A link with others under it keeps going to its own page; the button beside it shows and hides them. -->
		<nav id="so-site-nav" class="so-header__nav" aria-label={text().mainNav}>
			<ul class="so-header__list">
				{#each groups as { item, children } (item.id)}
					{#if children.length}
						<li class={['so-header__group', children.some((c) => isCurrent(c.link)) && 'so-header__group--current']} onfocusout={(e) => onGroupFocusout(e, item.id)}>
							{@render menuLink(item)}
							<button
								type="button"
								class="so-header__sub-toggle"
								aria-expanded={openSub === item.id}
								aria-controls={subId(item.id)}
								onclick={() => (openSub = openSub === item.id ? null : item.id)}
							>
								<span class="so-visually-hidden">{fill(text().submenu, { link: item.label })}</span>
								<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
									<path d="M4 6l4 4 4-4" />
								</svg>
							</button>
							<ul id={subId(item.id)} class="so-header__sub" hidden={openSub !== item.id}>
								{#each children as child (child.id)}
									<li>{@render menuLink(child)}</li>
								{/each}
							</ul>
						</li>
					{:else}
						<li>{@render menuLink(item)}</li>
					{/if}
				{/each}
			</ul>
			{#if ctaLabel && ctaLink?.href}
				<a
					class={['so-btn', ctaStyle === 'secondary' ? 'so-btn--secondary' : 'so-btn--primary', 'so-header__cta']}
					href={href(ctaLink)}
					download={download(ctaLink)}
					target={ctaLink.newTab ? '_blank' : undefined}
					rel={ctaLink.newTab ? 'noopener noreferrer' : undefined}
					onclick={chose}>{ctaLabel}</a
				>
			{/if}
		</nav>
	</div>
</header>

{#snippet menuLink(item)}
	<a
		href={href(item.link) ?? '#'}
		download={download(item.link)}
		target={item.link?.newTab ? '_blank' : undefined}
		rel={item.link?.newTab ? 'noopener noreferrer' : undefined}
		aria-current={isCurrent(item.link) ? 'page' : undefined}
		onclick={chose}>{item.label}</a
	>
{/snippet}

<style>
	.so-header {
		position: relative;
		z-index: 50;
		background: var(--so-color-background);
		/* Everything inside takes its colour from here, so one colour change reaches the whole header. */
		color: var(--so-color-text);
		border-bottom: 1px solid color-mix(in srgb, var(--so-color-border) 70%, transparent);
	}
	.so-header--sticky {
		position: sticky;
		/* Pinned by the brand row: a notice above it scrolls away with the page (publishOffset measures it). */
		top: calc(-1 * var(--so-header-notice, 0px));
	}
	/* The phone menu takes the header's own background and text colour (see the phone rules), so a colour set on
	   the header reaches the menu too. A submenu's panel, which hangs over the page on wider screens, takes the
	   header's surface. */
	.so-header--surface,
	.so-header--surface .so-header__sub {
		background: var(--so-color-surface);
	}
	.so-header--subtle,
	.so-header--subtle .so-header__sub {
		background: var(--so-color-surface-alt);
	}
	.so-header--inverse,
	.so-header--inverse .so-header__sub {
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
	}
	.so-header--inverse,
	.so-header--inverse .so-header__nav,
	.so-header--inverse .so-header__sub {
		border-color: transparent;
	}
	/* The notice spans the header's full width above the brand row. On a phone its words wrap and push the row
	   (and the menu that hangs from the header's bottom edge) down, so it never covers the menu button, and it
	   scrolls away with the page while the brand row stays (see .so-header--sticky). Its brand colour is painted
	   over the page colour over white, as the theme's contrast check measures Text on brand on Brand, whatever
	   the header's own background. */
	.so-header__notice {
		background: linear-gradient(var(--so-color-brand), var(--so-color-brand)), linear-gradient(var(--so-color-background), var(--so-color-background)) #fff;
		color: var(--so-color-on-brand);
	}
	.so-header__notice-inner {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: baseline;
		gap: 0.25em 0.75em;
		max-width: calc(var(--so-container-content) + 2 * var(--so-container-gutter));
		margin: 0 auto;
		padding: 0.55rem var(--so-container-gutter);
		overflow-wrap: anywhere;
		font-size: 0.9rem;
		font-weight: 500;
		line-height: 1.4;
		text-align: center;
	}
	.so-header__notice a {
		color: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}
	.so-header__notice a:hover {
		text-decoration-thickness: 2px;
	}
	/* The theme's focus colour can match the band (or nearly): the outline takes the band's text colour instead. */
	.so-header__notice a:focus-visible {
		outline-color: currentColor;
	}

	.so-header__inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--so-space-lg);
		max-width: calc(var(--so-container-content) + 2 * var(--so-container-gutter));
		min-height: 72px;
		margin-inline: auto;
		padding-inline: var(--so-container-gutter);
	}
	.so-header__brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		overflow-wrap: anywhere;
		color: inherit;
		font-family: var(--so-font-display);
		font-size: 1.35rem;
		font-weight: 520;
		letter-spacing: -0.02em;
		text-decoration: none;
	}
	.so-header__brand :global(.so-header__logo) {
		width: auto;
		max-width: 160px;
		height: 34px;
		object-fit: contain;
	}
	/* The menu button keeps its whole 44 × 44 target beside the brand, however long the name: the brand wraps instead. */
	.so-header__menu {
		display: none;
		flex: none;
		margin-inline-end: -10px;
	}
	.so-header__toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: var(--so-radius-md);
		color: inherit;
	}
	.so-header__toggle svg {
		width: 24px;
		height: 24px;
	}
	.so-header__icon-close,
	.so-header__menu[open] .so-header__icon-open {
		display: none;
	}
	.so-header__menu[open] .so-header__icon-close {
		display: inline;
	}
	.so-header__nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		min-width: 0;
		gap: var(--so-space-xl);
	}
	.so-header__list {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--so-space-lg);
	}
	@media (min-width: 768px) and (max-width: 1023.98px) {
		.so-header__nav,
		.so-header__list {
			gap: var(--so-space-md);
		}
	}
	.so-header__nav ul a {
		position: relative;
		color: color-mix(in srgb, currentColor 72%, transparent);
		font-size: 0.95rem;
		font-weight: 500;
		text-decoration: none;
		transition: color 150ms ease;
	}
	.so-header__nav ul a:hover,
	.so-header__nav ul a[aria-current='page'] {
		color: inherit;
	}
	/* A link with a submenu is marked while one of the pages under it is open. */
	.so-header__nav .so-header__group--current > a {
		color: inherit;
	}
	.so-header__list > li > a[aria-current='page']::after,
	.so-header__group--current > a::after {
		content: '';
		position: absolute;
		inset-inline: 0;
		bottom: -6px;
		height: 2px;
		border-radius: 2px;
		background: var(--so-surface-ink, var(--so-color-brand));
	}
	/* A link with others under it: the link, then a button that shows them in a panel hanging below it. */
	.so-header__group {
		position: relative;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.so-header__sub-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-inline-end: -6px;
		padding: 0;
		border: 0;
		border-radius: var(--so-radius-sm);
		background: transparent;
		color: color-mix(in srgb, currentColor 72%, transparent);
		cursor: pointer;
	}
	.so-header__sub-toggle:hover,
	.so-header__sub-toggle[aria-expanded='true'] {
		color: inherit;
	}
	.so-header__sub-toggle svg {
		width: 16px;
		height: 16px;
		transition: transform 150ms ease;
	}
	.so-header__sub-toggle[aria-expanded='true'] svg {
		transform: rotate(180deg);
	}
	.so-header__sub {
		position: absolute;
		top: calc(100% + 12px);
		inset-inline-start: -14px;
		z-index: 1;
		display: flex;
		flex-direction: column;
		min-width: 220px;
		max-width: min(320px, calc(100vw - 2 * var(--so-container-gutter)));
		padding: 6px;
		background: var(--so-color-background);
		color: var(--so-color-text);
		border: 1px solid var(--so-color-border);
		border-radius: var(--so-radius-md);
		box-shadow: var(--so-shadow-md);
	}
	.so-header--inverse .so-header__sub {
		color: var(--so-color-on-inverse);
		border-color: transparent;
	}
	/* The last link's panel opens back from its end edge (leftwards, or rightwards on a right-to-left page), so it
	   stays inside the window; a long one scrolls. */
	.so-header__list > .so-header__group:last-child .so-header__sub {
		inset-inline-start: auto;
		inset-inline-end: -10px;
	}
	.so-header__sub {
		max-height: min(70vh, 480px);
		overflow-y: auto;
	}
	.so-header__sub[hidden] {
		display: none;
	}
	.so-header__nav .so-header__sub a {
		display: block;
		padding: 9px 12px;
		border-radius: var(--so-radius-sm);
		overflow-wrap: anywhere;
	}
	.so-header__nav .so-header__sub a:hover {
		background: color-mix(in srgb, currentColor 7%, transparent);
	}
	.so-header__nav .so-header__sub a[aria-current='page'] {
		font-weight: 600;
	}
	.so-header__cta {
		min-height: 40px;
		padding: 0.55em 1.15em;
		font-size: 0.92rem;
	}

	/* Matches the phone breakpoint used by every other component (MEDIA_QUERIES.phone). */
	@media (max-width: 767.98px) {
		.so-header__menu {
			display: block;
		}
		.so-header__nav {
			position: absolute;
			top: 100%;
			inset-inline: 0;
			display: none;
			flex-direction: column;
			flex-wrap: nowrap;
			justify-content: flex-start;
			align-items: stretch;
			gap: var(--so-space-md);
			padding: var(--so-space-md) var(--so-container-gutter) var(--so-space-xl);
			border-bottom: 1px solid var(--so-color-border);
			box-shadow: var(--so-shadow-md);
			/* The menu hangs from a sticky header, so the page cannot scroll to it. When enlarged text or a short
			   screen makes it taller than the space below the header's brand row (a notice above that row scrolls
			   away with the page), it scrolls on its own. */
			max-height: calc(100vh - 100% + var(--so-header-notice, 0px));
			max-height: calc(100dvh - 100% + var(--so-header-notice, 0px));
			overflow-y: auto;
		}
		/* The menu hangs below the brand row in the header's own background, which the row passes on, and its links
		   inherit the header's text colour: whatever colours the header has, the menu reads the same. */
		.so-header__inner,
		.so-header__nav {
			background: inherit;
		}
		.so-header__menu[open] ~ .so-header__nav {
			display: flex;
		}
		.so-header__list {
			flex-direction: column;
			align-items: stretch;
			gap: 0;
		}
		.so-header__list > li > a {
			display: block;
			padding: 14px 0;
			font-size: 1.05rem;
			border-bottom: 1px solid var(--so-color-border);
		}
		.so-header__list > li > a[aria-current='page']::after,
		.so-header__group--current > a::after {
			display: none;
		}
		/* In the phone menu a submenu opens in place, indented under its link; its button is finger-sized. */
		.so-header__group {
			flex-wrap: wrap;
			gap: 0;
			border-bottom: 1px solid var(--so-color-border);
		}
		.so-header__list > .so-header__group > a {
			flex: 1;
			min-width: 0;
			border-bottom: 0;
		}
		.so-header__sub-toggle {
			width: 44px;
			height: 44px;
			margin-inline-end: -10px;
		}
		.so-header__sub,
		.so-header__list > .so-header__group:last-child .so-header__sub {
			position: static;
			flex-basis: 100%;
			min-width: 0;
			max-width: none;
			max-height: none;
			overflow: visible;
			margin: 0 0 10px;
			padding: 0;
			padding-inline-start: var(--so-space-md);
			background: transparent;
			border: 0;
			border-inline-start: 2px solid var(--so-color-border);
			border-radius: 0;
			box-shadow: none;
		}
		/* There it takes the menu's own background and text colour, like the links above it. */
		.so-header__sub,
		.so-header--surface .so-header__sub,
		.so-header--subtle .so-header__sub,
		.so-header--inverse .so-header__sub {
			background: transparent;
			color: inherit;
		}
		.so-header__nav .so-header__sub a {
			padding: 11px 0;
			padding-inline-start: 4px;
			font-size: 1rem;
		}
		.so-header__nav .so-header__sub a:hover {
			background: none;
		}
	}
</style>
`;

export const header: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('shell.header'),
  componentId: 'shell.header',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Header',
  description: 'Site name or logo, navigation links, an optional action, an optional notice bar shown on every page with the header (a closure, holiday hours or an announcement) and a working mobile menu.',
  category: 'shell',
  tags: ['header', 'navigation', 'menu', 'nav', 'logo', 'notice', 'announcement'],
  icon: 'panel-top',
  properties: {
    siteName: P.str('Site name', 'Studio'),
    logo: P.image('Logo'),
    showSiteName: { ...P.bool('Show site name', true), description: 'With a logo, turn this off to show the logo alone.' },
    // A link can show under the link above it, in that link's submenu: the menu stays one list, so moving links
    // and adding pages work as they always have.
    links: P.list('Navigation', 'Link', {
      label: P.str('Label', 'Page'),
      link: P.link('Destination'),
      sub: { ...P.bool('Show under the link above', false), description: 'In the submenu of the nearest top-level link above.' }
    }, [], { titleField: 'label', max: 10 }),
    ...P.group('Action', {
      ctaLabel: P.str('Action label', ''),
      ctaLink: P.link('Action link'),
      ctaStyle: P.choice('Action style', 'primary', [
        ['primary', 'Filled button'],
        ['secondary', 'Outlined button']
      ])
    }),
    // A notice for every page that shows the header, such as a closure: set it once here, clear it to remove it.
    // A sentence or two: a notice is not the place for a page's content.
    ...P.group('Notice', {
      notice: { ...P.str('Notice text', '', { maxLength: 160 }), description: 'A sentence or two, shown in a bar above the header on every page that shows the header. Clear it to remove the notice and its link.' },
      noticeLabel: P.str('Notice link label', '', { maxLength: 40 }),
      noticeLink: P.link('Notice link')
    }),
    surface: P.choice('Background', 'background', [
      ['background', 'Page background'],
      ['surface', 'Cards and panels'],
      ['subtle', 'Alternate background'],
      ['inverse', 'Dark']
    ]),
    sticky: P.bool('Stick to top while scrolling', true)
  },
  parts: { root: { nodeId: 'root', label: 'Header', styleControls: ['paddingBlock', 'background', 'color', 'border', 'shadow', 'hidden'] } },
  source: HEADER_SOURCE,
  provenance: FOUNDATION.provenance('shell.header'),
  license: FOUNDATION.meta.license
};

export const footer = managed({
  componentId: 'shell.footer',
  name: 'Footer',
  description: 'Site identity, link groups and copyright.',
  category: 'shell',
  tags: ['footer', 'links', 'copyright', 'bottom'],
  icon: 'panel-bottom',
  properties: {
    siteName: P.str('Site name', 'Studio'),
    tagline: P.text('Tagline', 'Thoughtful design for homes and small workplaces.'),
    linksHeading: P.str('Links heading', 'Explore'),
    links: P.list('Links', 'Link', { label: P.str('Label', 'Page'), link: P.link('Destination') }, [], { titleField: 'label', max: 12 }),
    contactHeading: P.str('Contact heading', 'Contact'),
    contact: P.list('Contact links', 'Contact link', { label: P.str('Label', SAMPLE_CONTACT.email), link: P.link('Destination') }, [
      { label: SAMPLE_CONTACT.email, link: { type: 'email', target: SAMPLE_CONTACT.email } },
      { label: SAMPLE_CONTACT.phone, link: { type: 'tel', target: SAMPLE_CONTACT.phoneDial } }
    ], { titleField: 'label', max: 8 }),
    copyright: P.str('Copyright', '© 2026 Studio. All rights reserved.')
  },
  parts: {
    root: { nodeId: 'root', label: 'Footer', styleControls: ['paddingBlock', 'background', 'color'] },
    brand: { nodeId: 'brand-name', label: 'Site name', styleControls: ['textStyle', 'color'] },
    copyright: { nodeId: 'copyright', label: 'Copyright', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Dark' },
        light: { label: 'Light', styles: { root: { base: { background: tok('color.surface-alt'), color: tok('color.text') } } } }
      }
    }
  },
  build: (b) => {
    const linkGroup = (id: string, headingProp: string, listProp: string) =>
      // A group without links would be an empty landmark: it is left out.
      b.el(`${id}-group`, 'nav', { name: 'Link group', when: { $prop: listProp }, styles: { layout: 'stack', gap: tok('space.md') } }, [
        b.text(`${id}-heading`, 'h2', { $prop: headingProp }, { name: 'Group heading', when: { $prop: headingProp }, styles: { textStyle: tok('text.eyebrow'), opacity: 0.7 } }),
        b.el(`${id}-list`, 'ul', { name: 'Links', styles: { layout: 'stack', gap: tok('space.sm') } }, [
          b.repeat(`${id}-items`, listProp, [
            b.el(`${id}-item`, 'li', { name: 'Link item' }, [
              b.link(`${id}-link`, { $item: 'link' }, { $item: 'label' }, 'plain', { name: 'Link', styles: { color: 'inherit', opacity: 0.85 } })
            ])
          ])
        ])
      ]);
    const top = b.el('top', 'div', { name: 'Top row', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl') }, tablet: { columns: 3 }, desktop: { columns: 4 } } }, [
      b.el('brand', 'div', { name: 'Brand', styles: { base: { layout: 'stack', gap: tok('space.sm'), maxWidth: '340px' }, desktop: { marginBlockEnd: '0' } } }, [
        b.text('brand-name', 'p', { $prop: 'siteName' }, { name: 'Site name', styles: { fontFamily: tok('font.display'), fontSize: '1.5rem', fontWeight: '500', letterSpacing: '-0.02em' } }),
        b.text('tagline', 'p', { $prop: 'tagline' }, { name: 'Tagline', when: { $prop: 'tagline' }, styles: { opacity: 0.7, textStyle: tok('text.small') } })
      ]),
      b.el('spacer', 'div', { name: 'Spacer', styles: { base: { hidden: true }, desktop: { hidden: false } } }, []),
      linkGroup('explore', 'linksHeading', 'links'),
      linkGroup('contact', 'contactHeading', 'contact')
    ]);
    const bottom = b.el('bottom', 'div', { name: 'Bottom row', styles: { layout: 'row', wrap: true, justify: 'space-between', gap: tok('space.md'), paddingBlock: tok('space.lg'), border: '0', marginBlockStart: tok('space.2xl') } }, [
      b.text('copyright', 'p', { $prop: 'copyright' }, { name: 'Copyright', styles: { textStyle: tok('text.small'), opacity: 0.7 } })
    ]);
    const inner = b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto' } }, [top, b.divider('rule', { name: 'Divider', styles: { opacity: 0.18, marginBlockStart: tok('space.2xl') } }), bottom]);
    return b.el('root', 'footer', { name: 'Footer', styles: { paddingBlock: tok('space.3xl'), paddingInline: tok('container.gutter'), background: tok('color.inverse'), color: tok('color.on-inverse') } }, [inner]);
  }
});
// The bottom row sits directly under the divider.
footer.tree!.nodes['bottom'].styles = { base: { layout: 'row', wrap: true, justify: 'space-between', gap: tok('space.md'), paddingBlock: '0', marginBlockStart: tok('space.lg') } };
void mutedStyles;
