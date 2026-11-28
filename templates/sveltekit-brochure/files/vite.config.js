import { readFileSync } from 'node:fs';
import nodeAdapter from '@sveltejs/adapter-node';
import staticAdapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// How the site is published, written by SiteOrigin Builder from Site settings: the sub-path it lives under (for example
// "/my-site" on GitHub Pages), from its public URL, and whether it is built as a static website or a Node.js server.
function published() {
	try {
		const settings = JSON.parse(readFileSync(new URL('./src/lib/siteorigin/paths.json', import.meta.url), 'utf8'));
		return settings && typeof settings === 'object' ? settings : {};
	} catch {
		return {};
	}
}

// The sub-path the site is published under. Development always runs at the root.
function publishedBase(settings) {
	const { base } = settings;
	return typeof base === 'string' && /^(\/[\w.-]+)*$/.test(base) ? base : '';
}

// A static website: every page is prerendered into plain HTML in the build/ folder.
// A Node.js server (node build/index.js): pages are still prerendered, and it also answers the site's own API
// endpoints (src/routes/**/+server.js) when they are asked for.
function adapter(settings, build) {
	if (build && settings.deployTarget === 'node') return nodeAdapter({ out: 'build' });
	return staticAdapter({ pages: 'build', assets: 'build', fallback: undefined, strict: true });
}

export default defineConfig(({ command, isPreview }) => {
	const settings = command === 'build' || isPreview ? published() : {};
	return {
		// A CSS rule the build's minifier cannot read is left out with a warning, as a browser leaves it out, rather than
		// stopping the build: the site's own CSS (Site settings > Custom code) is written by hand.
		css: { lightningcss: { errorRecovery: true } },
		plugins: [
			sveltekit({
				compilerOptions: {
					runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
				},
				adapter: adapter(settings, command === 'build'),
				paths: { base: publishedBase(settings) }
			})
		]
	};
});
