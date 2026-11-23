import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P, PACK_ID, PACK_VERSION, definitionIdFor, managed, tok } from '../dsl';
import { mutedStyles } from './common';

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
		class: className = ''
	} = $props();

	let open = $state(false);
	let header = $state();
	let toggle = $state();
	// Route IDs ("/about") do not depend on the base path the site is published under.
	const current = $derived(page.route.id);
	// The visible name, when there is one to show. Beside it the logo is decorative, so the brand is announced once.
	const name = $derived(typeof siteName === 'string' ? siteName.trim() : '');
	const nameShown = $derived(!!name && (showSiteName || !logo?.src));
	// A logo shown alone names the link by its own alternative text, which matches what it visibly says.
	const logoAlt = $derived(logo?.src && !logo.decorative && typeof logo.alt === 'string' ? logo.alt.trim() : '');

	/** Site-relative links go through resolve() so the site works under a sub-path. */
	const href = (link) => (link?.href?.startsWith('/') && !link.href.startsWith('//') ? resolve(link.href) : link?.href);
	const isCurrent = (link) => !!link?.href?.startsWith('/') && !link.href.includes('#') && (link.href.length > 1 && link.href.endsWith('/') ? link.href.slice(0, -1) : link.href) === current;

	$effect(() => {
		void current;
		open = false;
	});

	/**
	 * Publishes how far down the window the header reaches while it stays at the top (0 when it scrolls away, is
	 * hidden or stays at the bottom) as --so-header-offset on the page root. The theme's [id] scroll margin adds
	 * to it, so jump links land below it. The computed style also counts a position set as a style: a sticky
	 * header stays in view at its top inset (only when it has one), a fixed one where it is, and either covers
	 * the top of the window when it sits nearer the top edge than the bottom.
	 */
	function publishOffset(el) {
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

	function onKeydown(event) {
		if (event.key === 'Escape' && open) {
			open = false;
			toggle?.focus();
		}
	}

	function onPointerdown(event) {
		if (open && header && !header.contains(event.target)) open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointerdown} />

<header class={['so-header', \`so-header--\${surface}\`, sticky && 'so-header--sticky', open && 'so-header--open', className]} bind:this={header}>
	<div class="so-header__inner">
		<!-- Without the visible name, the link is still named for screen readers. -->
		<a class="so-header__brand" href={resolve('/')} aria-label={nameShown || logoAlt ? undefined : name || 'Home'}>
			{#if logo?.src}
				<SoImage image={nameShown ? { ...logo, decorative: true } : logo} class="so-header__logo" eager />
			{/if}
			{#if nameShown}
				<span>{name}</span>
			{/if}
		</a>

		<button
			bind:this={toggle}
			type="button"
			class="so-header__toggle"
			aria-expanded={open}
			aria-controls="so-site-nav"
			onclick={() => (open = !open)}
		>
			<span class="so-visually-hidden">{open ? 'Close menu' : 'Open menu'}</span>
			<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
				{#if open}
					<path d="M6 6l12 12M18 6L6 18" />
				{:else}
					<path d="M4 7h16M4 12h16M4 17h16" />
				{/if}
			</svg>
		</button>

		<!-- Choosing a link closes the menu, including links to the current page or an anchor on it. -->
		<nav id="so-site-nav" class="so-header__nav" aria-label="Main">
			<ul>
				{#each links as item (item.id)}
					<li>
						<a
							href={href(item.link) ?? '#'}
							target={item.link?.newTab ? '_blank' : undefined}
							rel={item.link?.newTab ? 'noopener noreferrer' : undefined}
							aria-current={isCurrent(item.link) ? 'page' : undefined}
							onclick={() => (open = false)}>{item.label}</a
						>
					</li>
				{/each}
			</ul>
			{#if ctaLabel && ctaLink?.href}
				<a
					class={['so-btn', ctaStyle === 'secondary' ? 'so-btn--secondary' : 'so-btn--primary', 'so-header__cta']}
					href={href(ctaLink)}
					target={ctaLink.newTab ? '_blank' : undefined}
					rel={ctaLink.newTab ? 'noopener noreferrer' : undefined}
					onclick={() => (open = false)}>{ctaLabel}</a
				>
			{/if}
		</nav>
	</div>
</header>

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
		top: 0;
	}
	.so-header--surface,
	.so-header--surface .so-header__nav {
		background: var(--so-color-surface);
	}
	.so-header--subtle,
	.so-header--subtle .so-header__nav {
		background: var(--so-color-surface-alt);
	}
	.so-header--inverse,
	.so-header--inverse .so-header__nav {
		background: var(--so-color-inverse);
		border-color: transparent;
		color: var(--so-color-on-inverse);
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
		height: 34px;
	}
	.so-header__toggle {
		display: none;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		margin-right: -10px;
		border: 0;
		border-radius: var(--so-radius-md);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.so-header__toggle svg {
		width: 24px;
		height: 24px;
	}
	.so-header__nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		min-width: 0;
		gap: var(--so-space-xl);
	}
	.so-header__nav ul {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--so-space-lg);
	}
	@media (min-width: 768px) and (max-width: 1023.98px) {
		.so-header__nav,
		.so-header__nav ul {
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
	.so-header__nav ul a[aria-current='page']::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: -6px;
		height: 2px;
		border-radius: 2px;
		background: var(--so-color-brand);
	}
	.so-header__cta {
		min-height: 40px;
		padding: 0.55em 1.15em;
		font-size: 0.92rem;
	}

	/* Matches the phone breakpoint used by every other component (MEDIA_QUERIES.phone). */
	@media (max-width: 767.98px) {
		.so-header__toggle {
			display: inline-flex;
		}
		.so-header__nav {
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			display: none;
			flex-direction: column;
			flex-wrap: nowrap;
			justify-content: flex-start;
			align-items: stretch;
			gap: var(--so-space-md);
			padding: var(--so-space-md) var(--so-container-gutter) var(--so-space-xl);
			background: var(--so-color-background);
			border-bottom: 1px solid var(--so-color-border);
			box-shadow: var(--so-shadow-md);
			/* The menu hangs from a sticky header, so the page cannot scroll to it. When enlarged text or a short
			   screen makes it taller than the space below the header, it scrolls on its own. */
			max-height: calc(100vh - 100%);
			max-height: calc(100dvh - 100%);
			overflow-y: auto;
		}
		.so-header--open .so-header__nav {
			display: flex;
		}
		.so-header__nav ul {
			flex-direction: column;
			align-items: stretch;
			gap: 0;
		}
		.so-header__nav ul a {
			display: block;
			padding: 14px 0;
			font-size: 1.05rem;
			border-bottom: 1px solid var(--so-color-border);
		}
		.so-header__nav ul a[aria-current='page']::after {
			display: none;
		}
	}
</style>
`;

export const header: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: definitionIdFor('shell.header'),
  componentId: 'shell.header',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Header',
  description: 'Site name or logo, navigation links, an optional action and a working mobile menu.',
  category: 'shell',
  tags: ['header', 'navigation', 'menu', 'nav', 'logo'],
  icon: 'panel-top',
  properties: {
    siteName: P.str('Site name', 'Studio'),
    logo: P.image('Logo'),
    showSiteName: { ...P.bool('Show site name', true), description: 'With a logo, turn this off to show the logo alone.' },
    links: P.list('Navigation', 'Link', { label: P.str('Label', 'Page'), link: P.link('Destination') }, [], { titleField: 'label', max: 10 }),
    ctaLabel: P.str('Action label', ''),
    ctaLink: P.link('Action link'),
    ctaStyle: { group: 'Action', ...P.choice('Action style', 'primary', [
      ['primary', 'Filled button'],
      ['secondary', 'Outlined button']
    ]) },
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
  provenance: { pack: PACK_ID, packVersion: PACK_VERSION, componentId: 'shell.header' },
  license: 'GPL-3.0-or-later'
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
    contact: P.list('Contact links', 'Contact link', { label: P.str('Label', 'hello@example.com'), link: P.link('Destination') }, [
      { label: 'hello@example.com', link: { type: 'email', target: 'hello@example.com' } },
      { label: '+1 555 0134', link: { type: 'tel', target: '+15550134' } }
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
