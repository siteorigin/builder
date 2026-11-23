import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The sub-path the site is published under (for example "/my-site" on GitHub Pages), written by
// SiteOrigin Builder from the public URL in Site settings. Development always runs at the root.
function publishedBase() {
	try {
		const { base } = JSON.parse(readFileSync(new URL('./src/lib/siteorigin/paths.json', import.meta.url), 'utf8'));
		return typeof base === 'string' && /^(\/[\w.-]+)*$/.test(base) ? base : '';
	} catch {
		return '';
	}
}

export default defineConfig(({ command, isPreview }) => ({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			// Every page is prerendered into plain HTML in the build/ folder.
			adapter: adapter({ pages: 'build', assets: 'build', fallback: undefined, strict: true }),
			paths: { base: command === 'build' || isPreview ? publishedBase() : '' }
		})
	]
}));
