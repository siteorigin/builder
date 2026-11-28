/**
 * What the website gives home screens, bookmarks and installed shortcuts beside its favicon (issue 584): the web app
 * manifest, the browser's theme colour, and a description of the PNG icons and favicon.ico made from the favicon (or
 * the monogram while none is chosen). The icons are pictures, which this pure generator cannot draw: it says what they are made
 * from, and the editor renders them (src/main/project/site-icons.ts) and writes them beside the generated text.
 */
import type { ProjectState, TokenDef } from '@shared/types';
import { parseColor, toHex6, type Rgba } from '@shared/color';
import { colorSchemeMode, resolvedCss } from '@shared/color-scheme';
import { compositeOver } from '@shared/contrast';
import { siteDirection, siteLanguage } from '@shared/languages';
import { APP_ICONS, APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_ICO_SIZES, WEB_MANIFEST } from '@shared/site-icons';
import { effectiveTokens, generateFaviconSvg, js } from './index';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The first of `ids` whose colour the parser reads, as an opaque colour: links to other tokens followed, and a colour
 * with opacity laid over `under` (a manifest's colours and the theme colour have none). A dangling or circular link,
 * or a colour the parser leaves alone (`var()`, `color-mix()`), passes to the next; `fallback` when none can be read.
 */
function opaqueToken(tokens: readonly TokenDef[], ids: readonly string[], under: Rgba, fallback: string): Rgba {
  for (const id of ids) {
    const css = resolvedCss(tokens, id);
    const c = css ? parseColor(css) : null;
    if (c) return c.a >= 1 ? c : compositeOver(c, under);
  }
  return parseColor(fallback)!;
}

/** The site's colours for a palette as #rrggbb: the page's background, its brand, and the text on its brand. */
export function siteColors(tokens: readonly TokenDef[]): { background: string; brand: string; onBrand: string } {
  const background = opaqueToken(tokens, ['color.background', 'color.surface'], WHITE, '#ffffff');
  const brand = opaqueToken(tokens, ['color.brand', 'color.accent'], background, '#1f5a4c');
  const onBrand = opaqueToken(tokens, ['color.on-brand'], brand, '#ffffff');
  return { background: toHex6(background), brand: toHex6(brand), onBrand: toHex6(onBrand) };
}

/**
 * The <meta name="theme-color"> tags for the root layout's <svelte:head>, from the brand colour. With one palette, one
 * tag. While visitors can see the dark palette, the dark one comes first for a device set to dark, and the light one
 * for any other (a browser takes the first that applies). With the visitor's Light/Dark switch, `chosen` is the
 * layout's variable holding their choice, so the browser's colour follows it rather than only the device.
 */
export function themeColorMeta(state: ProjectState, chosen?: string): string {
  const light = siteColors(effectiveTokens(state)).brand;
  const mode = colorSchemeMode(state.tokens);
  if (mode === 'single') return `<meta name="theme-color" content=${js(light)} />`;
  const dark = siteColors(effectiveTokens(state, 'dark')).brand;
  if (mode === 'toggle' && chosen)
    return `<meta name="theme-color" content={${chosen} === 'light' ? ${js(light)} : ${js(dark)}} media="(prefers-color-scheme: dark)" />\n\t<meta name="theme-color" content={${chosen} === 'dark' ? ${js(dark)} : ${js(light)}} />`;
  return `<meta name="theme-color" content=${js(dark)} media="(prefers-color-scheme: dark)" />\n\t<meta name="theme-color" content=${js(light)} />`;
}

/**
 * The root layout's function for the addresses of the files its head links to (the favicon, the home-screen icon, the
 * manifest), and the script that defines it. On the server SvelteKit's asset() is relative to the page rendered
 * ("../manifest.webmanifest" on About), and when the page starts Svelte keeps a <link>'s address as the server wrote
 * it. The root layout's head is never drawn again, so after the visitor moves to another page that address would
 * lead nowhere. Once the page has started, each address is written again in full ("https://example.com/shop/
 * manifest.webmanifest"), which leads to the same file from every page. It has to differ from what the page started
 * with, or Svelte would not write it: in the browser asset() already gives the address from the root.
 */
export const HEAD_ASSET = 'headAsset';
export const HEAD_ASSET_SCRIPT = `
	// The head's links lead to the site's own files from every page the visitor moves on to, not only the first.
	let started = $state(false);
	$effect(() => {
		started = true;
	});
	const ${HEAD_ASSET} = (file) => {
		if (!started) return asset(file);
		// A page with no address of its own (about:blank) has nothing to resolve it from.
		try {
			return new URL(asset(file), location.href).href;
		} catch {
			return asset(file);
		}
	};`;

/** The head links to the icon iOS puts on the home screen and to the manifest, beside the favicon's. */
export function siteIconLinks(): string {
  const apple = APP_ICONS.find((i) => i.file === APPLE_TOUCH_ICON)!;
  return `<link rel="apple-touch-icon" sizes="${apple.size}x${apple.size}" href={${HEAD_ASSET}(${js(APPLE_TOUCH_ICON)})} />\n\t<link rel="manifest" href={${HEAD_ASSET}(${js(WEB_MANIFEST)})} />`;
}

/**
 * static/manifest.webmanifest: the site's name, description, language, direction and colours, and its icons. Every
 * address in it is relative to the manifest, so the site works the same under a sub-path ("https://example.com/shop/").
 * No short name: a cut one reads worse than the browser's own shortening of the name.
 */
export function generateWebManifest(state: ProjectState): string {
  const colors = siteColors(effectiveTokens(state));
  // The documents can be edited by hand: anything but text is left out, as the page metadata leaves it out.
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const description = text(state.site.description);
  const manifest = {
    name: text(state.site.name) || 'Website',
    ...(description ? { description } : {}),
    lang: siteLanguage(state.site),
    dir: siteDirection(state.site),
    start_url: './',
    scope: './',
    // A brochure site keeps Back and Reload when it is opened from a home screen.
    display: 'minimal-ui',
    background_color: colors.background,
    theme_color: colors.brand,
    icons: APP_ICONS.filter((i) => i.file !== APPLE_TOUCH_ICON).map((i) => ({ src: i.file, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: 'any' }))
  };
  return JSON.stringify(manifest, null, '\t') + '\n';
}

/** What the PNG icons are made from: the favicon picture chosen, by its file in the project, or the monogram's SVG. */
export type SiteIconSource = { kind: 'file'; file: string; mime: string } | { kind: 'svg'; svg: string };

/** One drawn icon: its project path, its square size and, for the one iOS shows, the opaque colour behind it. */
export interface SiteIcon {
  path: string;
  size: number;
  /**
   * The colour see-through parts are filled with: iOS fills them with black itself. Absent for the manifest's icons,
   * which keep their transparency.
   */
  background?: string;
  /** For favicon.ico: the file is an ICO holding a square PNG at each of these sizes, of which `size` is the largest. */
  ico?: readonly number[];
}

/** The drawn icons the website serves, and what all of them are made from. */
export interface SiteIconSet {
  source: SiteIconSource;
  /** The monogram the icons fall back to when the favicon picture cannot be read. */
  monogram: string;
  icons: SiteIcon[];
}

/**
 * The PNG icons and favicon.ico, made from the favicon picture while one is chosen and its record is there, and from the monogram
 * otherwise. The monogram is drawn edge to edge here, since home screens round an icon's corners themselves.
 */
export function siteIconSet(state: ProjectState): SiteIconSet {
  const favicon = state.site.favicon ? state.assets.assets[state.site.favicon] : undefined;
  const monogram = generateFaviconSvg(state, { square: true });
  const source: SiteIconSource = favicon?.kind === 'image' ? { kind: 'file', file: favicon.file, mime: favicon.mime } : { kind: 'svg', svg: monogram };
  const { background } = siteColors(effectiveTokens(state));
  const pngs: SiteIcon[] = APP_ICONS.map((i) => ({ path: `static/${i.file}`, size: i.size, ...(i.file === APPLE_TOUCH_ICON ? { background } : {}) }));
  return { source, monogram, icons: [...pngs, { path: `static/${FAVICON_ICO}`, size: Math.max(...FAVICON_ICO_SIZES), ico: FAVICON_ICO_SIZES }] };
}
