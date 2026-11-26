/**
 * The not-found page (issue 66): a branded 404.html that hosts show at any address the site does not have, with a
 * link home, wording the author can change, and every address in it working at any depth and under a sub-path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { LinkNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import { ERROR_PAGE_FILE, NOT_FOUND_COMPONENT, NOT_FOUND_DIR, NOT_FOUND_PAGE_JS, RUNTIME_DIR, SERVER_HOOK_FILE, generateLayout, generateNotFound, generateProject, generateServerHook } from '@generator/index';
import { notFoundSectionRoutes, pageIds } from '@generator/checks';
import { GenerationCache } from '@generator/cache';
import { NOT_FOUND_JS } from '@generator/runtime-files';
import { NOT_FOUND_DEFAULTS, NOT_FOUND_ROUTE, clipText, notFoundCopy, notFoundPath } from '@shared/not-found';
import { settleServerHook, notFoundAddressWarning, notFoundHostNote, notFoundPageProblem, ownNotFoundFileStop, pageRelativeAddresses, readNotFoundPage, srcsetUrls } from '../../src/main/export';
import { StaticPreviews } from '../../src/main/static-preview';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);

const roots: string[] = [];
const scratch = (name: string) => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), `${name}-`));
  roots.push(dir);
  return dir;
};
const previews: StaticPreviews[] = [];
afterAll(() => {
  previews.forEach((p) => p.stopAll());
  roots.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The generated runtime module that the site's build hook runs. */
let runtime: Promise<{ publishNotFound: (html: string, base: unknown, sections?: unknown) => string }> | undefined;
const publishNotFound = async (html: string, base: unknown, sections?: unknown) => {
  runtime ??= (async () => {
    const file = join(scratch('not-found-runtime'), 'not-found.mjs');
    writeFileSync(file, NOT_FOUND_JS);
    return import(/* @vite-ignore */ file);
  })();
  return (await runtime).publishNotFound(html, base, sections);
};

/** The generated server hook, run as SvelteKit runs it while building /404.html under `base`. */
async function runHook(s: ProjectState, html: string, opts: { base?: string; route?: string; building?: boolean } = {}): Promise<string> {
  const dir = scratch('not-found-hook');
  writeFileSync(join(dir, 'env.mjs'), `export const building = ${opts.building ?? true};\n`);
  writeFileSync(join(dir, 'not-found.mjs'), NOT_FOUND_JS);
  const hook = join(dir, 'hooks.server.mjs');
  writeFileSync(hook, generateServerHook(s).replace("'$app/env'", JSON.stringify(join(dir, 'env.mjs'))).replace("'./lib/siteorigin/runtime/not-found.js'", JSON.stringify(join(dir, 'not-found.mjs'))));
  const { handle } = await import(/* @vite-ignore */ hook);
  const route = opts.route ?? NOT_FOUND_ROUTE;
  const event = { route: { id: route }, url: new URL(`http://sveltekit-prerender${opts.base ?? ''}${route}`) };
  return handle({ event, resolve: (_: unknown, o?: { transformPageChunk?: (c: { html: string; done: boolean }) => string }) => (o?.transformPageChunk ? o.transformPageChunk({ html, done: true }) : html) });
}

/** The Business starter with a "Pricing" link in the shared header to a section of Home with that ID. */
function withPricingLink(): ProjectState {
  const s = fresh();
  const home = s.pages[s.site.homePageId];
  home.nodes[home.rootIds[1]].anchor = 'pricing';
  const link: LinkNode = { id: 'n_pricinglink', kind: 'link', link: { type: 'anchor', target: 'pricing' }, label: 'Pricing', appearance: 'text' };
  s.site.shell.header.nodes[link.id] = link;
  s.site.shell.header.rootIds.push(link.id);
  return s;
}

/**
 * Server-render the generated not-found page as SvelteKit prerenders it at /404.html: at the root, so resolve()
 * gives addresses relative to the root ("./"), as it does for every prerendered page.
 */
async function renderNotFound(s: ProjectState): Promise<{ head: string; body: string }> {
  const dir = scratch('not-found-page');
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => "." + p; export const asset = (p) => "./" + p;\n');
  const out = join(dir, 'page.svelte.js');
  mkdirSync(dirname(out), { recursive: true });
  const code = compile(generateNotFound(s), { filename: `${NOT_FOUND_DIR}/+page.svelte`, generate: 'server', runes: true }).js.code;
  writeFileSync(out, code.replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths)));
  const Page = (await import(/* @vite-ignore */ out)).default as Component<Record<string, unknown>>;
  const r = render(Page, { props: {} });
  return { head: r.head, body: r.body.replace(/<!--[\s\S]*?-->/g, '') };
}

/**
 * Server-render one of the generated project's routes that show the not-found page (the 404.html route or the
 * site's error page), with the component they share, as SvelteKit renders it for an error with `status`.
 */
async function renderRoute(s: ProjectState, route: string, status = 404, message = 'Not Found'): Promise<{ head: string; body: string }> {
  const dir = scratch('not-found-route');
  const files = generateProject(s);
  writeFileSync(join(dir, 'app-paths.js'), 'export const resolve = (p) => "." + p; export const asset = (p) => "./" + p;\n');
  writeFileSync(join(dir, 'app-state.js'), `export const page = ${JSON.stringify({ status, error: { message } })};\n`);
  const build = (path: string) => {
    const out = join(dir, path + '.js');
    mkdirSync(dirname(out), { recursive: true });
    const code = compile(files.get(path)!, { filename: path, generate: 'server', runes: true }).js.code;
    writeFileSync(
      out,
      code
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(join(dir, 'app-paths.js')))
        .replace(/(["'])\$app\/state\1/g, JSON.stringify(join(dir, 'app-state.js')))
        .replace(/(["'])(\.[^"']*\.svelte)\1/g, (_, q: string, rel: string) => JSON.stringify(join(dirname(join(dir, path)), rel) + '.js'))
    );
    return out;
  };
  build(NOT_FOUND_COMPONENT);
  const Page = (await import(/* @vite-ignore */ build(route))).default as Component<Record<string, unknown>>;
  const r = render(Page, { props: {} });
  return { head: r.head, body: r.body.replace(/<!--[\s\S]*?-->/g, '') };
}

/** A built 404.html as SvelteKit writes it at the root: shared header with an image, the page, and the start script. */
const builtDocument = ({ head, body }: { head: string; body: string }) => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<link href="./_app/immutable/entry/start.abc.js" rel="modulepreload">
		<link href="./_app/immutable/nodes/3.def.js" rel="modulepreload">
		<link rel="icon" href="./favicon.svg" type="image/svg+xml"/>${head}
		<link href="./_app/immutable/assets/0.css" rel="stylesheet">
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents"><a class="so-skip-link" href="#main">Skip to content</a> <header><a class="so-header__brand" href="./">Test Studio</a><nav><a href="./about/">About</a> <a href="./contact/#form">Contact</a> <a href="#pricing">Pricing</a> <a href="services/">Services</a> <a href="mailto:hello@example.com">Email</a> <a href="https://example.org/x">Elsewhere</a></nav><script-example><a href="./from-custom/">Custom</a></script-example><svg><use xlink:href="./assets/brand.svg#mark"></use></svg><span style="background-image: url(&quot;./assets/bg.png&quot;); color: red"></span><picture><source srcset="./assets/logo-1x.webp 1x,./assets/logo-2x.webp 2x" type="image/webp"><img src="./assets/logo.png" srcset="./assets/logo-640.png 640w, ./assets/logo-1280.png 1280w" alt="Test Studio" title="a > b"></picture></header> <main id="main">${body}</main>
			<script>
				{
					__sveltekit_abc = {
						base: new URL(".", location).pathname.slice(0, -1),
						version: "1"
					};

					const element = document.currentScript.parentElement;

					import("./_app/immutable/entry/start.abc.js").then(async (kit) => {
						kit.init(__sveltekit_abc);
						const app = await import("./_app/immutable/entry/app.ghi.js");
						const leaf = () => import('./_app/immutable/nodes/3.def.js');
						kit.start(app, element, { node_ids: [0, 3], data: [null,null], form: null, error: null });
					});
				}
			</script>
		</div>
	</body>
</html>
`;

describe('not-found page wording', () => {
  it('uses the defaults until the author sets their own, and keeps the link home named', () => {
    expect(notFoundCopy({})).toEqual(NOT_FOUND_DEFAULTS);
    expect(notFoundCopy({ notFoundHeading: '  Lost?  ', notFoundMessage: 'Try the menu.', notFoundLinkLabel: 'Accueil' })).toEqual({ heading: 'Lost?', message: 'Try the menu.', linkLabel: 'Accueil' });
    // site.json edited by hand: blank, too long or not text at all.
    const odd = notFoundCopy({ notFoundHeading: '   ', notFoundMessage: 42 as unknown as string, notFoundLinkLabel: 'x'.repeat(500) });
    expect(odd.heading).toBe(NOT_FOUND_DEFAULTS.heading);
    expect(odd.message).toBe(NOT_FOUND_DEFAULTS.message);
    expect(odd.linkLabel).toHaveLength(60);
    // Text that shows nothing, and text cut at the limit without splitting a character.
    expect(notFoundCopy({ notFoundLinkLabel: '\u200b\u2060 \ufeff', notFoundMessage: '  Try again.  ' })).toMatchObject({ linkLabel: NOT_FOUND_DEFAULTS.linkLabel, message: 'Try again.' });
    expect(notFoundCopy({ notFoundLinkLabel: `${'x'.repeat(59)}😀` }).linkLabel).toBe('x'.repeat(59));
    expect(clipText(`ab😀c`, 3)).toBe('ab');
    expect(clipText(`ab😀c`, 4)).toBe('ab😀');
  });

  it('is set through site.update: trimmed, and cleared back to the default with empty text', () => {
    const s = fresh();
    const set = applyOperations(s, [{ type: 'site.update', notFoundHeading: ' Nothing here ', notFoundMessage: 'Have a look around.', notFoundLinkLabel: 'Back home' }]).state;
    expect(set.site).toMatchObject({ notFoundHeading: 'Nothing here', notFoundMessage: 'Have a look around.', notFoundLinkLabel: 'Back home' });
    // Changing one field leaves the others as they are.
    const one = applyOperations(set, [{ type: 'site.update', notFoundMessage: 'Try the menu above.' }]).state;
    expect(one.site).toMatchObject({ notFoundHeading: 'Nothing here', notFoundMessage: 'Try the menu above.', notFoundLinkLabel: 'Back home' });
    const cleared = applyOperations(set, [{ type: 'site.update', notFoundHeading: '', notFoundMessage: '  ', notFoundLinkLabel: '' }]).state;
    expect(notFoundCopy(cleared.site)).toEqual(NOT_FOUND_DEFAULTS);
    expect(JSON.parse(JSON.stringify(cleared.site))).not.toHaveProperty('notFoundHeading');
    expect(validateOperation({ type: 'site.update', notFoundHeading: 'Lost?', notFoundMessage: '', notFoundLinkLabel: 'Home' }).ok).toBe(true);
    expect(validateOperation({ type: 'site.update', notFoundHeading: 'x'.repeat(120), notFoundLinkLabel: 'x'.repeat(60) }).ok).toBe(true);
    expect(validateOperation({ type: 'site.update', notFoundHeading: 'x'.repeat(121) }).ok).toBe(false);
    expect(validateOperation({ type: 'site.update', notFoundMessage: 'x'.repeat(400) }).ok).toBe(true);
    expect(validateOperation({ type: 'site.update', notFoundMessage: 'x'.repeat(401) }).ok).toBe(false);
    expect(validateOperation({ type: 'site.update', notFoundLinkLabel: 'x'.repeat(61) }).ok).toBe(false);
  });
});

describe('generated not-found page', () => {
  it('is generated for every project, built as 404.html, with a hook that only rewrites it during a build', () => {
    for (const instrument of [false, true]) {
      const files = generateProject(fresh(), { instrument });
      expect(NOT_FOUND_DIR).toBe('src/routes/404.html');
      // One component, shown by the 404.html route and the site's error page alike.
      expect(NOT_FOUND_COMPONENT).toBe(`${RUNTIME_DIR}/NotFound.svelte`);
      expect(files.get(NOT_FOUND_COMPONENT)).toBe(generateNotFound(fresh()));
      expect(files.get(`${NOT_FOUND_DIR}/+page.svelte`)).toContain("import NotFound from '../../lib/siteorigin/runtime/NotFound.svelte';");
      expect(ERROR_PAGE_FILE).toBe('src/routes/+error.svelte');
      expect(files.get(ERROR_PAGE_FILE)).toContain("import NotFound from '../lib/siteorigin/runtime/NotFound.svelte';");
      expect(files.get(`${NOT_FOUND_DIR}/+page.js`)).toBe(NOT_FOUND_PAGE_JS);
      expect(NOT_FOUND_PAGE_JS).toMatch(/^export const trailingSlash = 'never';$/m);
      expect(files.get(SERVER_HOOK_FILE)).toBe(generateServerHook(fresh()));
      expect(files.get(`${RUNTIME_DIR}/not-found.js`)).toBe(NOT_FOUND_JS);
      // No editor instrumentation, in the export or in the editor's preview.
      for (const f of [NOT_FOUND_COMPONENT, `${NOT_FOUND_DIR}/+page.svelte`, ERROR_PAGE_FILE, 'src/hooks.server.js', `${RUNTIME_DIR}/not-found.js`]) expect(files.get(f)).not.toMatch(/data-so-|siteorigin-bridge|builderTest/);
    }
    const hook = generateServerHook(fresh());
    expect([...hook.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['$app/env', './lib/siteorigin/runtime/not-found.js']);
    // Not a page: it is never listed, linked or put in the sitemap.
    const s = fresh();
    s.site.baseUrl = 'https://example.com/studio';
    expect(s.site.pageOrder.map((id) => s.pages[id].route)).not.toContain(NOT_FOUND_ROUTE);
    const sitemap = generateProject(s).get('static/sitemap.xml');
    expect(sitemap).toContain('<loc>https://example.com/studio/about/</loc>');
    expect(sitemap).not.toContain('404');
  });

  it('rewrites only the not-found page, only while building, under the sub-path SvelteKit builds it at', async () => {
    const html = '<link href="./_app/a.css" rel="stylesheet"><a href="./">Home</a>';
    expect(await runHook(fresh(), html, { base: '/studio' })).toBe('<link href="/studio/_app/a.css" rel="stylesheet"><a href="/studio/">Home</a>');
    // A project whose build has no sub-path (an older one, whose vite.config.js does not read paths.json) keeps the root.
    const old = fresh();
    old.site.baseUrl = 'https://example.com/studio';
    expect(await runHook(old, html)).toBe('<link href="/_app/a.css" rel="stylesheet"><a href="/">Home</a>');
    expect(await runHook(fresh(), html, { route: '/about' })).toBe(html);
    expect(await runHook(fresh(), html, { base: '/studio', building: false })).toBe(html);
  });

  it('sends the header and footer links to sections of a page to the page that has them', async () => {
    const s = withPricingLink();
    expect(notFoundSectionRoutes(s)).toEqual({ pricing: '/' });
    // On another page too, the first published page that has it.
    const home = s.pages[s.site.homePageId];
    delete home.nodes[home.rootIds[1]].anchor;
    expect(notFoundSectionRoutes(s)).toEqual({});
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    about.nodes[about.rootIds[0]].anchor = 'pricing';
    expect(notFoundSectionRoutes(s)).toEqual({ pricing: '/about/' });
    // Where the link works: a page that shows the part it is in, before one that does not.
    home.nodes[home.rootIds[1]].anchor = 'pricing';
    home.showHeader = false;
    expect(notFoundSectionRoutes(s)).toEqual({ pricing: '/about/' });
    home.showHeader = true;
    delete home.nodes[home.rootIds[1]].anchor;
    // A section of the header or footer itself is on the not-found page already.
    const shellPricing = withPricingLink();
    shellPricing.site.shell.footer.nodes[shellPricing.site.shell.footer.rootIds[0]].anchor = 'pricing';
    expect(notFoundSectionRoutes(shellPricing)).toEqual({});
    const shellLinks = '<a href="#main">Skip</a> <a href="#pricing">Pricing</a> <a href="#team">Team</a> <a href="#top">Top</a> <a href="#">Here</a><main id="main"></main>';
    // A section no known page has (a code component's own link, say) gets an empty target, outside what SvelteKit hydrates.
    expect(await runHook(withPricingLink(), `<body>${shellLinks}</body>`, { base: '/studio' })).toBe(
      '<body><a href="#main">Skip</a> <a href="/studio/#pricing">Pricing</a> <a href="#team">Team</a> <a href="#top">Top</a> <a href="#">Here</a><main id="main"></main><span id="team"></span></body>'
    );
    // The footer's links count as the header's do, and the page keeps a target for each, built with or without the hook.
    const footer = withPricingLink();
    const [linkId] = footer.site.shell.header.rootIds.splice(-1);
    footer.site.shell.footer.nodes[linkId] = footer.site.shell.header.nodes[linkId];
    delete footer.site.shell.header.nodes[linkId];
    footer.site.shell.footer.rootIds.push(linkId);
    expect(notFoundSectionRoutes(footer)).toEqual({ pricing: '/' });
    expect(generateNotFound(footer)).toContain('<span id={"pricing"}></span>');
    expect(generateNotFound(fresh())).not.toContain('<span id=');
  });

  it('is made again by a cached generation when its wording or the sections it links to change, and only then', () => {
    const cache = new GenerationCache();
    const run = (s: ProjectState) => {
      const out = generateProject(s, {}, cache);
      expect([...out]).toEqual([...generateProject(s)]);
      return cache.made.slice();
    };
    const linked = withPricingLink();
    const home = linked.pages[linked.site.homePageId];
    const anchored = home.nodes[home.rootIds[1]];
    delete anchored.anchor;
    run(linked);
    expect(run(linked)).toEqual([]);
    const worded = applyOperations(linked, [{ type: 'site.update', notFoundHeading: 'Lost?' }]).state;
    expect(run(worded)).toEqual(['not-found']);
    const sectioned = structuredClone(worded);
    sectioned.pages[sectioned.site.homePageId].nodes[anchored.id].anchor = 'pricing';
    expect(run(sectioned)).toEqual(expect.arrayContaining(['not-found', 'hooks.server.js']));
    expect(generateProject(sectioned, {}, cache).get(SERVER_HOOK_FILE)).toContain('const SECTIONS = {"pricing":"/"};');
  });

  it("reads a code component's IDs again when its source changes in place, as an edit batch changes it", () => {
    let s = fresh();
    const coded = applyOperations(s, [{ type: 'component.createCode', name: 'Pricing table', source: '<section id="pricing">Plans</section>\n' }]);
    s = coded.state;
    const codeId = coded.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: s.site.homePageId }, definitionId: codeId }]).state;
    expect(pageIds(s, s.site.homePageId).has('pricing')).toBe(true);
    s.components[codeId].source = '<section id="plans">Plans</section>\n';
    expect(pageIds(s, s.site.homePageId).has('pricing')).toBe(false);
    expect(pageIds(s, s.site.homePageId).has('plans')).toBe(true);
  });

  it('shows the header and the footer when a page does, and not one that every page hides', () => {
    const s = fresh();
    expect(generateLayout(s, {})).not.toContain(NOT_FOUND_ROUTE);
    for (const id of s.site.pageOrder) s.pages[id].showFooter = false;
    const layout = generateLayout(s, {});
    const without = (part: string) => JSON.parse(new RegExp(`const pagesWithout${part} = new Set\\((\\[[^\\]]*\\])\\);`).exec(layout)![1]) as string[];
    // Served at a missing address, the page starts with no route.
    expect(without('Footer')).toEqual(expect.arrayContaining(['', NOT_FOUND_ROUTE]));
    expect(without('Header')).toEqual([]);
    // Links in a part the page does not show need no destination.
    const hidden = withPricingLink();
    for (const id of hidden.site.pageOrder) hidden.pages[id].showHeader = false;
    expect(notFoundSectionRoutes(hidden)).toEqual({});
  });

  it('shows the wording as text, asks not to be indexed, and always links home', async () => {
    const s = fresh();
    s.site.notFoundHeading = 'Lost? {oops} </script>';
    s.site.notFoundMessage = 'Use import("./help") or href="./x" to find it.';
    s.site.notFoundLinkLabel = 'Back <home>';
    const { head, body } = await renderNotFound(s);
    expect(head).toContain('<title>Lost? {oops} &lt;/script> · Test Studio</title>');
    expect(head).toContain('<meta name="robots" content="noindex"/>');
    expect(body).toMatch(/<h1 class="so-not-found__heading[^"]*">Lost\? \{oops\} &lt;\/script><\/h1>/);
    expect(body).toContain('Use import("./help") or href="./x" to find it.');
    expect(body).toMatch(/<a class="so-btn so-btn--primary[^"]*" href="\.\/">Back &lt;home><\/a>/);
    // With nothing set, the defaults, and still exactly one heading and one link home.
    const plain = await renderNotFound(fresh());
    expect(plain.body).toContain(`>${NOT_FOUND_DEFAULTS.heading}</h1>`);
    expect(plain.body).toContain(`>${NOT_FOUND_DEFAULTS.message}</p>`);
    expect(plain.body).toContain(`>${NOT_FOUND_DEFAULTS.linkLabel}</a>`);
    expect(plain.body.match(/<h1\b/g)).toHaveLength(1);
    expect(plain.body.match(/<a\b/g)).toHaveLength(1);
  });
});

describe("the site's error page", () => {
  it('#882: shows the site\'s own not-found page at a missing address, as the 404.html route does', async () => {
    const s = fresh();
    s.site.notFoundHeading = 'Nothing at this address';
    const own = await renderNotFound(s);
    for (const route of [ERROR_PAGE_FILE, `${NOT_FOUND_DIR}/+page.svelte`]) {
      const { head, body } = await renderRoute(s, route);
      expect(body, route).toContain('>Nothing at this address</h1>');
      // The same page, whichever shows it (the scoped styles' class follows the file compiled).
      const scoped = (html: string) => html.replace(/\bsvelte-[a-z0-9]+\b/g, 'svelte-scoped');
      expect(scoped(body), route).toBe(scoped(own.body));
      const bare = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
      expect(bare(head), route).toBe(bare(own.head));
      expect(body, route).not.toContain('Not Found');
    }
  });

  it('says what went wrong for any other error, and asks not to be indexed', async () => {
    const { head, body } = await renderRoute(fresh(), ERROR_PAGE_FILE, 500, 'Internal Error');
    expect(head).toContain('<title>Error 500</title>');
    expect(head).toContain('<meta name="robots" content="noindex"/>');
    expect(body).toMatch(/<h1[^>]*>Error 500<\/h1>/);
    expect(body).toContain('>Internal Error</p>');
    expect(body).not.toContain('so-not-found');
  });
});

describe('not-found page addresses', () => {
  it('makes every address relative to the root start from the sub-path, and leaves text and other addresses alone', async () => {
    const s = fresh();
    s.site.notFoundMessage = 'Use import("./help") or href="./x" to find it.';
    const built = builtDocument(await renderNotFound(s));
    expect(pageRelativeAddresses(built).length).toBeGreaterThan(10);
    const html = await publishNotFound(built, '/studio', { pricing: '/' });
    for (const expected of [
      '<link href="/studio/_app/immutable/entry/start.abc.js" rel="modulepreload">',
      '<link rel="icon" href="/studio/favicon.svg" type="image/svg+xml"/>',
      '<link href="/studio/_app/immutable/assets/0.css" rel="stylesheet">',
      '<a class="so-skip-link" href="#main">',
      '<a class="so-header__brand" href="/studio/">',
      '<a href="/studio/about/">',
      '<a href="/studio/contact/#form">',
      '<a href="/studio/#pricing">Pricing</a>',
      '<a href="/studio/services/">Services</a>',
      '<script-example><a href="/studio/from-custom/">Custom</a></script-example>',
      '<use xlink:href="/studio/assets/brand.svg#mark">',
      'style="background-image: url(&quot;/studio/assets/bg.png&quot;); color: red"',
      'import(\'/studio/_app/immutable/nodes/3.def.js\')'.replace(/'/g, '"'),
      '<a href="mailto:hello@example.com">',
      '<a href="https://example.org/x">',
      'srcset="/studio/assets/logo-1x.webp 1x,/studio/assets/logo-2x.webp 2x"',
      'src="/studio/assets/logo.png" srcset="/studio/assets/logo-640.png 640w, /studio/assets/logo-1280.png 1280w" alt="Test Studio" title="a > b"',
      'base: "/studio",',
      'import("/studio/_app/immutable/entry/start.abc.js")',
      'import("/studio/_app/immutable/entry/app.ghi.js")',
      // The author's words are text, not addresses.
      'Use import("./help") or href="./x" to find it.'
    ])
      expect(html).toContain(expected);
    expect(html).toMatch(/<a class="so-btn so-btn--primary[^"]*" href="\/studio\/">Go to the home page<\/a>/);
    expect(pageRelativeAddresses(html)).toEqual([]);
    expect(notFoundAddressWarning(html)).toBeNull();
    // Running it again changes nothing.
    expect(await publishNotFound(html, '/studio', { pricing: '/' })).toBe(html);
    expect(await publishNotFound(built, '/studio', { pricing: '/about/' })).toContain('<a href="/studio/about/#pricing">Pricing</a>');
    // A section no known page has stays on the page, with an empty target, once.
    const unknown = await publishNotFound(built, '/studio');
    expect(unknown).toContain('<a href="#pricing">Pricing</a>');
    expect(unknown).toMatch(/<span id="pricing"><\/span>\n?\t*<\/body>/);
    expect(await publishNotFound(unknown, '/studio')).toBe(unknown);
    // An ID SvelteKit cannot read as a fragment gets none; the others go after the page's last </body>, as written.
    const odd = '<body><a href="#price$$">A</a><a href="#100%">B</a><a href="#pricing.details">C</a><script>"</body>"</script></body>';
    expect(await publishNotFound(odd, '')).toBe('<body><a href="#price$$">A</a><a href="#100%">B</a><a href="#pricing.details">C</a><script>"</body>"</script><span id="price$$"></span><span id="pricing.details"></span></body>');
    // Addresses that only look relative: another site with spaces around it, or a backslash.
    expect(await publishNotFound('<a href=" https://example.org/help">Help</a><a href="\\\\example.org/x">X</a>', '/studio')).toBe('<a href=" https://example.org/help">Help</a><a href="\\\\example.org/x">X</a>');
    expect(pageRelativeAddresses('<a href=" https://example.org/help">Help</a><a href=" ./help/">Help</a>')).toEqual([' ./help/']);
    // A quoted url() may hold brackets and spaces.
    const styled = '<span style="background: url(&quot;./a(b) c.png&quot;) no-repeat"></span><button formaction="./send/">Send</button>';
    expect(await publishNotFound(styled, '/studio')).toBe('<span style="background: url(&quot;/studio/a(b)%20c.png&quot;) no-repeat"></span><button formaction="/studio/send/">Send</button>');
    expect(pageRelativeAddresses(styled)).toEqual(['./a(b) c.png', './send/']);
  });

  it('starts from the root when the site is not in a sub-path, or the sub-path is not a valid one', async () => {
    const built = builtDocument(await renderNotFound(fresh()));
    for (const base of ['', '/../x', 'studio', null]) {
      const html = await publishNotFound(built, base);
      expect(html).toContain('<link href="/_app/immutable/assets/0.css" rel="stylesheet">');
      expect(html).toContain('base: "",');
      expect(html).toMatch(/href="\/">Go to the home page<\/a>/);
      expect(pageRelativeAddresses(html)).toEqual([]);
    }
  });

  it('reads each srcset candidate as a browser does', async () => {
    expect(srcsetUrls('./a.png 1x,./b.png 2x')).toEqual(['./a.png', './b.png']);
    expect(srcsetUrls(' ./a.png,, ./b.png 640w , ./c.png')).toEqual(['./a.png', './b.png', './c.png']);
    expect(srcsetUrls('./a.png (min-width: 2px, 3px) 1x, ./b.png')).toEqual(['./a.png', './b.png']);
    // A no-break space is part of the address, not a separator.
    expect(srcsetUrls('/img/a\u00a0,\u00a0./b.png 2x')).toEqual(['/img/a\u00a0,\u00a0./b.png']);
    expect(await publishNotFound('<img srcset="/img/a\u00a0,\u00a0./b.png 2x">', '/studio')).toBe('<img srcset="/img/a\u00a0,\u00a0./b.png 2x">');
    expect(await publishNotFound('<img srcset="./a.png 1x,./b.png 2x">', '/studio')).toBe('<img srcset="/studio/a.png 1x,/studio/b.png 2x">');
  });

  it('warns when a build leaves the page relative to where it was built', async () => {
    const built = builtDocument(await renderNotFound(fresh()));
    expect(notFoundAddressWarning(built)).toMatch(/^404\.html, the not-found page, still uses addresses relative to where it was built \(\.\/_app\/[^)]+\), so at deeper missing addresses it may show without the site's styles and links\. This happens when the project has a server hook of its own \(src\/hooks\.server\) in place of the generated one\.$/);
    // Each kind of address is caught on its own.
    const done = await publishNotFound(built, '', { pricing: '/' });
    expect(pageRelativeAddresses(done.replace('base: "",', 'base: new URL(".", location).pathname.slice(0, -1),'))).toEqual(['new URL(".", location)']);
    expect(pageRelativeAddresses(done.replace('import("/_app/immutable/entry/app.ghi.js")', "import('./_app/immutable/entry/app.ghi.js')"))).toEqual(['./_app/immutable/entry/app.ghi.js']);
    expect(pageRelativeAddresses(done.replace('srcset="/assets/logo-640.png 640w, /assets/logo-1280.png 1280w"', 'srcset="/assets/logo-640.png 640w, assets/logo-1280.png 1280w"'))).toEqual(['assets/logo-1280.png']);
    expect(pageRelativeAddresses(done.replace('url(&quot;/assets/bg.png&quot;)', 'url(&quot;../bg.png&quot;)'))).toEqual(['../bg.png']);
    expect(pageRelativeAddresses(done.replace('xlink:href="/assets/brand.svg#mark"', 'xlink:href="assets/brand.svg#mark"'))).toEqual(['assets/brand.svg#mark']);
  });
});

describe('exporting the not-found page', () => {
  it('stops an export whose build has no 404.html or one with editor markup', () => {
    expect(notFoundPageProblem(null)).toBe('The build is missing 404.html, the page shown at addresses the site does not have.');
    expect(notFoundPageProblem('<main data-so-node="n_1"></main>')).toBe('Editor-only markup was found in 404.html. Export aborted.');
    expect(notFoundPageProblem('<main data-so-ctx="page:pg_1"></main>')).toMatch(/Editor-only markup/);
    expect(notFoundPageProblem('<script>import("virtual:siteorigin-bridge")</script>')).toMatch(/Editor-only markup/);
    expect(notFoundPageProblem('<main><h1>Page not found</h1></main>')).toBeNull();
  });

  it('tells the author where to point a host that needs an error-document setting', () => {
    expect(notFoundPath('')).toBe('/404.html');
    expect(notFoundHostNote('', 'cloudflare')).toBe(
      'Addresses your site does not have show its not-found page, 404.html. Cloudflare Pages, Netlify and Vercel use it automatically when they publish the exported website as it is. On another host, set the 404 error document to /404.html (on Apache: ErrorDocument 404 /404.html).'
    );
    expect(notFoundHostNote('/studio', 'cloudflare')).toContain('set the 404 error document to /studio/404.html (on Apache: ErrorDocument 404 /studio/404.html).');
    expect(notFoundHostNote('/a/b-c', 'cloudflare')).toContain('ErrorDocument 404 /a/b-c/404.html');
  });

  it('#817: says only what applies to the host the Redirects setting names', () => {
    const netlify = notFoundHostNote('', 'netlify');
    expect(netlify).toBe('Addresses your site does not have show its not-found page, 404.html. Netlify uses it automatically when it publishes the exported website as it is.');
    const vercel = notFoundHostNote('/studio', 'vercel');
    expect(vercel).toBe('Addresses your site does not have show its not-found page, 404.html. The website is built to be served under /studio/, where Vercel does not find it on its own: have it show /studio/404.html for missing addresses under /studio/.');
    const netlifyStudio = notFoundHostNote('/studio', 'netlify');
    expect(netlifyStudio).toContain('where Netlify does not find it on its own: have it show /studio/404.html');
    for (const note of [netlify, vercel, netlifyStudio]) expect(note).not.toMatch(/Cloudflare|GitHub|error document|Apache/);
    expect(netlify).not.toMatch(/Vercel/);
    expect(vercel).not.toMatch(/Netlify/);
    expect(notFoundHostNote('', 'cloudflare')).not.toMatch(/GitHub/);
    // Under a sub-path no host finds the page on its own: the note never says one does.
    for (const host of ['cloudflare', 'netlify', 'vercel'] as const) expect(notFoundHostNote('/studio', host)).not.toMatch(/automatically/);
  });

  it('reads 404.html only as a plain file, and stops a build that has a 404.html of its own', async () => {
    const out = scratch('not-found-out');
    expect(await readNotFoundPage(out)).toBeNull();
    mkdirSync(join(out, '404.html'));
    expect(await readNotFoundPage(out)).toBeNull();
    const linked = scratch('not-found-linked');
    writeFileSync(join(linked, 'real.html'), '<h1>Elsewhere</h1>');
    symlinkSync(join(linked, 'real.html'), join(linked, '404.html'));
    expect(await readNotFoundPage(linked)).toBeNull();
    const plain = scratch('not-found-plain');
    writeFileSync(join(plain, '404.html'), '<h1>Page not found</h1>');
    expect(await readNotFoundPage(plain)).toBe('<h1>Page not found</h1>');
    const project = scratch('not-found-project');
    expect(ownNotFoundFileStop(project)).toBeNull();
    mkdirSync(join(project, 'static'));
    writeFileSync(join(project, 'static/404.html'), '<p>Mine</p>');
    expect(ownNotFoundFileStop(project)).toBe('static/404.html takes the place of the not-found page SiteOrigin Builder generates, and the website cannot have both. Delete or rename static/404.html (the page\'s wording is set in Site styles, under Not-found page), then export again.');
  });

  /** An exported website folder whose 404.html is `notFound`, with the files it names. */
  const website = (notFound: string) => {
    const dir = scratch('not-found-site');
    mkdirSync(join(dir, '_app/immutable/assets'), { recursive: true });
    mkdirSync(join(dir, 'about'), { recursive: true });
    writeFileSync(join(dir, '404.html'), notFound);
    writeFileSync(join(dir, 'index.html'), '<title>Home</title>');
    writeFileSync(join(dir, 'about/index.html'), '<title>About</title>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, '_app/immutable/assets/0.css'), 'body { color: teal; }');
    mkdirSync(join(dir, '_app/immutable/entry'), { recursive: true });
    writeFileSync(join(dir, '_app/immutable/entry/app.ghi.js'), 'export {};');
    writeFileSync(join(dir, '_app/immutable/entry/start.abc.js'), 'export {};');
    return dir;
  };
  const fetched = async (url: string) => {
    const r = await fetch(url, { redirect: 'manual' });
    return { status: r.status, type: r.headers.get('content-type'), location: r.headers.get('location'), body: await r.text() };
  };
  /** The addresses in `html` a browser loads or follows, resolved against the address it was served at. */
  const resolved = (html: string, at: string) => {
    const attr = (re: RegExp) => new URL(re.exec(html)![1], at).href;
    return {
      css: attr(/<link href="([^"]+)" rel="stylesheet">/),
      icon: attr(/<link rel="icon" href="([^"]+)"/),
      home: attr(/<a class="so-btn so-btn--primary[^"]*" href="([^"]+)">/),
      about: attr(/<a href="([^"]+)">About<\/a>/),
      pricing: attr(/<a href="([^"]+)">Pricing<\/a>/),
      app: attr(/import\("([^"]+app\.ghi\.js)"\)/),
      start: attr(/import\("([^"]+start\.abc\.js)"\)/)
    };
  };

  for (const base of ['', '/studio']) {
    it(`serves it with status 404 at a nested missing address${base ? ' under a sub-path' : ''}, and everything it names loads from there`, async () => {
      const s = fresh();
      s.site.notFoundHeading = 'Nothing at this address';
      const built = builtDocument(await renderNotFound(s));
      const p = new StaticPreviews();
      previews.push(p);
      const root = await p.serve(website(await publishNotFound(built, base, { pricing: '/' })), base);
      const missing = new URL('customer-storie/deep/path/', root).href;
      const page = await fetched(missing);
      expect(page).toMatchObject({ status: 404, type: 'text/html; charset=utf-8', location: null });
      expect(page.body).toContain('>Nothing at this address</h1>');
      // Without a trailing slash, and one level down, too.
      for (const other of ['customer-storie', 'a/b/c/d/e.html']) expect(await fetched(new URL(other, root).href)).toMatchObject({ status: 404, body: expect.stringContaining('>Nothing at this address</h1>') });
      const at = resolved(page.body, missing);
      expect(await fetched(at.css)).toMatchObject({ status: 200, type: 'text/css', body: 'body { color: teal; }' });
      expect(await fetched(at.icon)).toMatchObject({ status: 200, type: 'image/svg+xml' });
      expect(at.home).toBe(root);
      expect(await fetched(at.home)).toMatchObject({ status: 200, body: '<title>Home</title>' });
      expect(await fetched(at.about)).toMatchObject({ status: 200, body: '<title>About</title>' });
      for (const script of [at.app, at.start]) expect(await fetched(script)).toMatchObject({ status: 200, type: 'text/javascript' });
      expect(at.pricing).toBe(`${root}#pricing`);

      // As SvelteKit builds it, before the hook: at a nested address its styles and links lead nowhere.
      const raw = resolved(built, missing);
      expect((await fetched(raw.css)).status).toBe(404);
      expect(raw.home).toBe(missing);
    });
  }
});

describe('a project with a server hook of its own', () => {
  it('keeps it: the generated hook is left out beside it, and comes back once it is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-not-found-hook-'));
    roots.push(dir);
    const s = await ProjectSession.create(dir, fresh());
    try {
      const generated = join(dir, SERVER_HOOK_FILE);
      expect(existsSync(generated)).toBe(true);
      writeFileSync(join(dir, 'src/hooks.server.ts'), 'export const handle = ({ event, resolve }) => resolve(event);\n');
      await s.apply({ operations: [{ type: 'site.update', notFoundHeading: 'Lost?' }] }, { label: 'Not-found heading' });
      expect(existsSync(generated)).toBe(false);
      expect(readFileSync(join(dir, 'src/hooks.server.ts'), 'utf8')).toContain('resolve(event)');
      expect(s.conflicts).toEqual([]);
      expect(readFileSync(join(dir, NOT_FOUND_COMPONENT), 'utf8')).toContain('"Lost?"');
      rmSync(join(dir, 'src/hooks.server.ts'));
      await s.apply({ operations: [{ type: 'site.update', notFoundHeading: 'Lost again?' }] }, { label: 'Not-found heading' });
      expect(readFileSync(generated, 'utf8')).toBe(generateServerHook(s.state));
    } finally {
      await s.close();
    }
  });

  it('never replaces a src/hooks.server.js that SiteOrigin Builder did not write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-not-found-own-'));
    roots.push(dir);
    const first = await ProjectSession.create(dir, fresh());
    await first.close();
    // As an older version left the project: no generated hook in the manifest, and the author's own file there.
    const manifestPath = join(dir, 'siteorigin/generated-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.files[SERVER_HOOK_FILE];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(dir, SERVER_HOOK_FILE), '// mine\n');
    const s = await ProjectSession.open(dir, 'test');
    try {
      await s.apply({ operations: [{ type: 'site.update', notFoundHeading: 'Lost?' }] }, { label: 'Not-found heading' });
      expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe('// mine\n');
      expect(s.conflicts).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe('a server hook added or removed while the project is open', () => {
  it('is settled in a staged copy as the next regeneration would, with the manifest saying so', async () => {
    const dir = scratch('not-found-staged');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'siteorigin'), { recursive: true });
    const manifest = { generator: 1, files: { [SERVER_HOOK_FILE]: 'abc', 'src/app.html': 'def' } };
    writeFileSync(join(dir, 'siteorigin/generated-manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, SERVER_HOOK_FILE), '// generated');
    // Without a hook of the project's own, nothing changes: a folder of helpers with no index file is not one.
    await settleServerHook(dir, fresh());
    mkdirSync(join(dir, 'src/hooks.server'));
    writeFileSync(join(dir, 'src/hooks.server/helpers.js'), '// helpers');
    await settleServerHook(dir, fresh());
    expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe('// generated');
    writeFileSync(join(dir, 'src/hooks.server.ts'), '// mine');
    await settleServerHook(dir, fresh());
    expect(existsSync(join(dir, SERVER_HOOK_FILE))).toBe(false);
    expect(readFileSync(join(dir, 'src/hooks.server.ts'), 'utf8')).toBe('// mine');
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')).files).toEqual({ 'src/app.html': 'def' });
    // Its own hook gone again before the next regeneration, the copy gets the generated one back.
    rmSync(join(dir, 'src/hooks.server.ts'));
    await settleServerHook(dir, fresh());
    expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe(generateServerHook(fresh()));
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')).files).sort()).toEqual(['src/app.html', SERVER_HOOK_FILE]);
    // A src/hooks.server.js the manifest does not list is the project's own, and stays.
    const mine = scratch('not-found-own-js');
    mkdirSync(join(mine, 'src'));
    writeFileSync(join(mine, SERVER_HOOK_FILE), '// also mine');
    writeFileSync(join(mine, 'src/hooks.server.ts'), '// mine');
    await settleServerHook(mine, fresh());
    expect(readFileSync(join(mine, SERVER_HOOK_FILE), 'utf8')).toBe('// also mine');
  });
});
