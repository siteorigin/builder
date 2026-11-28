import { describe, expect, it } from 'vitest';
import { createStarterState } from '../../src/catalogue/starters';
import { hidePaths, stripTerminal } from '../../src/main/build-failure';
import { explainBuildFailure } from '../../src/main/export';
import { serializeBuildError } from '../../src/runtime/build-diagnostics';

const state = () => createStarterState('business', 'Studio', false);
const ctx = { appVersion: '1.2.3', platform: 'darwin arm64', roots: [{ path: '/var/folders/ab/T/export-1/project', label: '<project>' }, { path: '/var/folders/ab/T/export-1', label: '<temp>' }, { path: '/Users/ada', label: '~' }] };

describe('hidePaths', () => {
  const roots = [
    { path: '/private/var/folders/ab/T/export-1/project', label: '<project>' },
    { path: '/var/folders/ab/T/export-1/project', label: '<project>' },
    { path: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\export-1\\project', label: '<project>' },
    { path: '/Users/ada', label: '~' }
  ];

  it('names files by where they sit in the project', () => {
    expect(hidePaths('at Contact (/private/var/folders/ab/T/export-1/project/src/routes/contact/+page.svelte:9:5)', roots)).toBe('at Contact (<project>/src/routes/contact/+page.svelte:9:5)');
    expect(hidePaths('Error in /var/folders/ab/T/export-1/project/src/lib/Hero.svelte', roots)).toBe('Error in <project>/src/lib/Hero.svelte');
  });

  it('reads Windows paths with either slash, whatever the case of the drive', () => {
    expect(hidePaths('C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\export-1\\project\\src\\lib\\Hero.svelte:3', roots)).toBe('<project>/src/lib/Hero.svelte:3');
    expect(hidePaths('c:/users/ada lovelace/appdata/local/temp/export-1/project/src/a.js', roots)).toBe('<project>/src/a.js');
  });

  it('reads file URLs, percent-encoded or not', () => {
    expect(hidePaths('at file:///var/folders/ab/T/export-1/project/src/a.js:1:1', roots)).toBe('at <project>/src/a.js:1:1');
    expect(hidePaths('file:///C:/Users/Ada%20Lovelace/AppData/Local/Temp/export-1/project/src/a.js', roots)).toBe('<project>/src/a.js');
  });

  it('shows the home folder as ~, and leaves a folder with a similar name alone', () => {
    expect(hidePaths('/Users/ada/Sites/mine/index.html', roots)).toBe('~/Sites/mine/index.html');
    expect(hidePaths('/var/folders/ab/T/export-1/project-old/src/a.js', roots)).toBe('/var/folders/ab/T/export-1/project-old/src/a.js');
    expect(hidePaths('/Users/adam/a.js and /elsewhere/Users/ada/a.js', roots)).toBe('/Users/adam/a.js and /elsewhere/Users/ada/a.js');
  });

  it('replaces each folder a line names, and not the one that only starts the same way', () => {
    expect(hidePaths('/Users/ada/a,/Users/ada/b;/Users/ada', roots)).toBe('~/a,~/b;~');
    expect(hidePaths('/Users/ada!work and /Users/ada2/x', roots)).toBe('/Users/ada!work and /Users/ada2/x');
    expect(hidePaths('file:///Sites/My%20Site+Demo/src/a.js', [{ path: '/Sites/My Site+Demo', label: '<project>' }])).toBe('<project>/src/a.js');
  });

  it('keeps a URL fragment after a folder', () => {
    expect(hidePaths('file:///Users/ada#L3 and /Users/ada#L4', roots)).toBe('~#L3 and ~#L4');
  });

  it('does not search a long run of slashes from every position', () => {
    const started = Date.now();
    const line = `${'/'.repeat(2000)}Users nobody`;
    for (let i = 0; i < 200; i++) hidePaths(line, roots);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('puts the longer folder first when one holds the other', () => {
    expect(hidePaths('/Users/ada/export/project/src/a.js', [{ path: '/Users/ada', label: '~' }, { path: '/Users/ada/export/project', label: '<project>' }])).toBe('<project>/src/a.js');
  });

  it('strips colours and cursor movement', () => {
    expect(stripTerminal('\x1b[31merror\x1b[39m \x1b[2K\x1b[1Gdone')).toBe('error done');
  });
});

describe('explaining a failed production build', () => {
  const noise = Array.from({ length: 12 }, (_, i) => `vite warning ${i}`);

  it('shows the underlying error even when more than eight lines come first', () => {
    const cause = Object.assign(new Error("Cannot read properties of undefined (reading 'title')"), {});
    const r = explainBuildFailure(
      state(),
      {
        error: 'Prerendering failed',
        failure: { message: 'Prerendering failed', cause: { message: cause.message, name: 'TypeError', stack: `TypeError: ${cause.message}\n    at Contact (/var/folders/ab/T/export-1/project/src/routes/contact/+page.svelte:9:5)` } },
        logs: [...noise, '500 /contact/ (linked from /)']
      },
      ctx
    );
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(r.warnings[0]).toBe("TypeError: Cannot read properties of undefined (reading 'title')");
    expect(r.warnings.length).toBeLessThanOrEqual(8);
    expect(r.details).toContain('Page: Contact (/contact/)');
    expect(r.details).toContain('at Contact (<project>/src/routes/contact/+page.svelte:9:5)');
    // Nothing the author was not shown is lost: every printed line is in the report.
    for (const l of noise) expect(r.details).toContain(l);
  });

  it('finds the cause among printed lines when the thrown error only says it failed', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs: [...noise, 'Error: title is not defined', '    at Contact (src/routes/contact/+page.svelte:9:5)', '500 /contact/ (linked from /)'] }, ctx);
    expect(r.warnings[0]).toBe('Error: title is not defined');
    expect(r.warnings).not.toContain('Prerendering failed');
    expect(r.message).toMatch(/Contact page \(\/contact\/\)/);
  });

  it('puts an error that names its module on the page that module builds', () => {
    const r = explainBuildFailure(state(), { error: 'x', failure: { message: 'Build failed', cause: { message: 'Unexpected token', plugin: 'vite-plugin-svelte', id: '/var/folders/ab/T/export-1/project/src/routes/about/+page.svelte?svelte&type=script', loc: { line: 7, column: 2 } } }, logs: [] }, ctx);
    expect(r.message).toBe('The production build failed while building the About page (/about/).');
    expect(r.warnings).toContain('Unexpected token');
    expect(r.warnings).toContain('The build was working in src/routes/about/+page.svelte, line 7.');
    expect(r.details).toContain('plugin vite-plugin-svelte');
  });

  it('names a shared file without guessing which page used it', () => {
    const r = explainBuildFailure(state(), { error: 'x', failure: { message: 'x', cause: { message: 'boom', loc: { file: '/var/folders/ab/T/export-1/project/src/lib/siteorigin/components/Hero.svelte', line: 12 } } }, logs: [] }, ctx);
    expect(r.message).toBe('The production build failed in src/lib/siteorigin/components/Hero.svelte, line 12.');
    expect(r.details).toContain('File: src/lib/siteorigin/components/Hero.svelte, line 12');
  });

  it('names the project component an error came from, as the author knows it', () => {
    const s = state();
    s.components.cmp_hours = { schemaVersion: 1, id: 'cmp_hours', componentId: 'custom.hours', contractVersion: 1, kind: 'code', owner: 'project', name: 'Opening hours', description: '', category: 'content', tags: [], properties: {}, parts: {}, sourcePath: 'src/lib/siteorigin/custom/OpeningHours.svelte' } as never;
    const r = explainBuildFailure(
      s,
      { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs: ['Error: The hours could not be read', '    at <project>/src/lib/siteorigin/custom/OpeningHours.svelte:3:9', 'prerender_http_error', 'Failed to prerender `/contact/`', 'https://svelte.dev/e/kit/prerender_http_error', 'To suppress or handle this error, implement `handleHttpError` in https://svelte.dev/docs/kit/configuration#prerender'] },
      ctx
    );
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(r.warnings).toEqual(['Error: The hours could not be read', 'The build was working in the “Opening hours” component (src/lib/siteorigin/custom/OpeningHours.svelte, line 3).']);
    expect(r.details).toContain('File: src/lib/siteorigin/custom/OpeningHours.svelte, line 3 (the “Opening hours” component)');
    // What the author cannot act on is not among the first lines, but the report keeps it.
    expect(r.details).toContain('To suppress or handle this error');
    expect(explainBuildFailure(s, { error: 'x', failure: { message: 'x', cause: { message: 'boom', id: '<project>/src/lib/siteorigin/custom/OpeningHours.svelte' } }, logs: [] }, ctx).message).toBe('The production build failed in the “Opening hours” component (src/lib/siteorigin/custom/OpeningHours.svelte).');
  });

  it('gives a SvelteKit error’s explanation with its code, not the code alone (#1479)', () => {
    const removed = 'module_removed_lib\n`$lib` has been removed. Use `#lib` instead: https://svelte.dev/docs/kit/$lib.\nhttps://svelte.dev/e/kit/module_removed_lib';
    const r = explainBuildFailure(state(), { error: 'x', failure: { name: 'SvelteKit error', message: removed, stack: '' }, logs: [] }, ctx);
    expect(r.warnings[0]).toBe('SvelteKit error: module_removed_lib: `$lib` has been removed. Use `#lib` instead: https://svelte.dev/docs/kit/$lib.');
    // As a real build reports it: Kit's error gathered under the bundler's own, the component it came from named.
    const s = state();
    s.components.cmp_hours = { schemaVersion: 1, id: 'cmp_hours', componentId: 'custom.hours', contractVersion: 1, kind: 'code', owner: 'project', name: 'Opening hours', description: '', category: 'content', tags: [], properties: {}, parts: {}, sourcePath: 'src/lib/siteorigin/custom/OpeningHours.svelte' } as never;
    const inner = Object.assign(new Error(removed), { name: 'SvelteKit error', id: '/var/folders/ab/T/export-1/project/src/lib/siteorigin/custom/OpeningHours.svelte' });
    const wrapped = explainBuildFailure(s, { error: 'x', failure: serializeBuildError(Object.assign(new Error('Build failed with 1 error:'), { errors: [inner] })), logs: [] }, ctx);
    expect(wrapped.warnings[0]).toBe(r.warnings[0]);
    expect(wrapped.message).toBe('The production build failed in the “Opening hours” component (src/lib/siteorigin/custom/OpeningHours.svelte).');
    // Any other error keeps its first line.
    const other = explainBuildFailure(state(), { error: 'x', failure: { name: 'TypeError', message: 'not_a_code at all\nmore' }, logs: [] }, ctx);
    expect(other.warnings[0]).toBe('TypeError: not_a_code at all');
  });

  it('matches a route under the site’s public address path, and names it as the build did', () => {
    const s = state();
    s.site.baseUrl = 'https://example.com/studio';
    expect(explainBuildFailure(s, { error: 'Prerendering failed', logs: ['Error: boom', '500 /studio/about/ (linked from /studio)'] }, ctx).message).toBe('The production build failed while building the About page (/studio/about/).');
  });

  it('names a route that is not one of the pages', () => {
    expect(explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['404 /old-page (linked from /)'] }, ctx).message).toBe('The production build failed while building /old-page.');
  });

  it('says plainly when the build said nothing more, and still gives a report', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: [] }, ctx);
    expect(r.message).toBe('The production build failed.');
    expect(r.warnings).toEqual(['The build did not say what went wrong. The technical details list everything it printed.']);
    expect(r.details).toContain('SiteOrigin Builder 1.2.3 on darwin arm64');
    expect(r.details).toContain('Prerendering failed');
  });

  it('explains a build that ran out of time or died', () => {
    expect(explainBuildFailure(state(), { error: 'The build took too long and was stopped.', logs: [] }, ctx).warnings).toEqual(['The build took too long and was stopped.']);
    expect(explainBuildFailure(state(), { error: 'Build process exited (134). ', logs: ['FATAL ERROR: heap out of memory'] }, ctx).warnings).toEqual(['Build process exited (134).', 'FATAL ERROR: heap out of memory']);
  });

  it('shows no absolute path, terminal code or home folder anywhere it returns', () => {
    const r = explainBuildFailure(
      state(),
      {
        error: 'Prerendering failed',
        failure: { message: 'Prerendering failed', stack: 'Error: Prerendering failed\n    at run (file:///var/folders/ab/T/export-1/project/node_modules/@sveltejs/kit/src/a.js:1:1)', cause: { message: '\x1b[31mfailed\x1b[39m reading /Users/ada/Library/Application Support/Builder/x.json', loc: { file: '/var/folders/ab/T/export-1/project/src/lib/A.svelte', line: 1 } } },
        logs: ['\x1b[2mcache at /var/folders/ab/T/export-1/.svelte-kit\x1b[22m', 'Error: also /Users/ada/Sites/mine']
      },
      ctx
    );
    const everything = JSON.stringify([r.message, r.warnings, r.details]);
    expect(everything).not.toMatch(/\/var\/folders|\/Users\/ada|\x1b|\\u001b/);
    expect(r.details).toContain('<project>/node_modules/@sveltejs/kit/src/a.js:1:1');
    expect(r.details).toContain('~/Library/Application Support/Builder/x.json');
    expect(r.details).toContain('<temp>/.svelte-kit');
  });

  it('keeps a build with an enormous log inside a bounded report, newest lines first', () => {
    const logs = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(100)}`);
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs }, ctx);
    expect(r.details.length).toBeLessThan(50_000);
    expect(r.details.split('\n')).toContain(`  line 4999 ${'x'.repeat(100)}`);
    expect(r.details.split('\n')).not.toContain(`  line 0 ${'x'.repeat(100)}`);
    expect(r.details).toMatch(/\n  … \d+ lines omitted\n/);
    expect(r.details).toContain('Build output (the lines that matter most):');
  });

  it('names the route that failed, not an earlier request that worked', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['200 GET /about/', '500 GET /contact/', 'Error: boom', 'Failed to prerender `/contact/`'] }, ctx);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
  });

  it('does not name a page for a failed request that is not one of its routes', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['404 /img/hero.png (linked from /contact/)', 'Error: not found', '    at Contact (src/routes/contact/+page.svelte:3:1)'] }, ctx);
    expect(r.message).toBe('The production build failed while building /img/hero.png.');
    expect(r.details).toContain('Route: /img/hero.png');
  });

  it('takes the file from the error’s own stack, not from an image the build mentioned first', () => {
    const r = explainBuildFailure(state(), { error: 'x', logs: ['src/lib/hero.png was optimized', 'src/lib/old.js is unused', '500 GET /about/', 'Error: boom', '    at node_modules/svelte/src/internal/server/renderer.js:416:11', '    at About (src/routes/about/+page.svelte:12:3)'] }, ctx);
    expect(r.message).toBe('The production build failed while building the About page (/about/).');
    expect(r.details).toContain('File: src/routes/about/+page.svelte, line 12');
  });

  it('looks past an outer module in node_modules for the project file in a cause', () => {
    const r = explainBuildFailure(state(), { error: 'x', failure: { message: 'Build failed', id: '/var/folders/ab/T/export-1/project/node_modules/vite/dist/x.js', cause: { message: 'Unexpected token', id: '/var/folders/ab/T/export-1/project/src/routes/contact/+page.svelte', loc: { line: 7 } } }, logs: [] }, ctx);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(r.details).toContain('File: src/routes/contact/+page.svelte, line 7');
  });

  it('puts an exception before warnings that merely mention a failure', () => {
    const warnings = Array.from({ length: 4 }, (_, i) => `Warning: invalid CSS selector ${i}`);
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: [...warnings, 'Error: hours unavailable'] }, ctx);
    expect(r.warnings).toEqual(['Error: hours unavailable']);
  });

  it('keeps the exception in the copied report however much the build printed after it', () => {
    const progress = Array.from({ length: 200 }, (_, i) => `transforming module ${i} ${'x'.repeat(600)}`);
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['Error: hours unavailable', '    at Hours (src/lib/Hours.svelte:2:1)', ...progress] }, ctx);
    expect(r.details.split('\n')).toContain('  Error: hours unavailable');
    expect(r.details.split('\n')).toContain('      at Hours (src/lib/Hours.svelte:2:1)');
    expect(r.details.length).toBeLessThan(50_000);
    expect(r.details).toContain(`transforming module 199 ${'x'.repeat(600)}`);
  });

  it('masks credentials a code frame quotes, and cleans every field it shows', () => {
    const r = explainBuildFailure(
      state(),
      {
        error: 'x',
        failure: {
          message: 'Unexpected token',
          name: '/Users/ada/PluginError',
          plugin: '/Users/ada/plugins/x',
          code: '\x1b]8;;https://evil.example\x07LINK\x1b]8;;\x07',
          frame: '3: const apiKey = "abcd1234efgh5678";\n4: fetch("https://ada:hunter2@example.com/x", { headers: { Authorization: "Bearer abcdefghijklmnop1234" } }); // sk-live_abcdefgh12345678'
        },
        logs: []
      },
      ctx
    );
    const everything = JSON.stringify([r.message, r.warnings, r.details]);
    expect(everything).not.toMatch(/abcd1234efgh5678|hunter2|abcdefghijklmnop1234|sk-live_abcdefgh|\/Users\/ada|evil\.example|\\u001b|\\u0007/);
    expect(r.details).toContain('apiKey = "…');
    expect(r.details).toContain('code LINK');
    expect(r.warnings[0]).toBe('~/PluginError: Unexpected token');
  });

  it('bounds a report whose errors are huge', () => {
    let cause: { message: string; frame: string; stack: string; cause?: unknown } | undefined;
    for (let i = 0; i < 5; i++) cause = { message: `error ${i}\n${'m'.repeat(1900)}`, frame: 'f'.repeat(1400), stack: `Error: e\n${Array.from({ length: 60 }, (_, k) => `    at frame${k} (src/a.js:${k}:1)`).join('\n')}`, cause };
    const r = explainBuildFailure(state(), { error: 'x', failure: cause as never, logs: Array.from({ length: 50 }, (_, i) => `line ${i}`) }, ctx);
    expect(r.details.length).toBeLessThan(50_000);
    expect(r.details).toContain('more of this error is left out');
    // The error at the root of the chain has its own share, however long the wrappers around it are.
    expect(r.details).toContain('  error 0');
    expect(r.details).toContain('  line 49');
  });

  it('shows the whole first line of an error in the report, however long', () => {
    const long = `Error: ${'detail '.repeat(100)}end-of-message`;
    const r = explainBuildFailure(state(), { error: long, failure: { message: long }, logs: [] }, ctx);
    expect(r.details).toContain('end-of-message');
    expect(r.warnings[0].length).toBeLessThanOrEqual(301);
  });

  it('keeps the missing-section explanation when only the error the manager reported names it', () => {
    const line = 'Error: The following pages contain links to /contact/#gone, but no element with id="gone" exists on /contact/ - see the `handleMissingId` option';
    const r = explainBuildFailure(state(), { error: `The build stopped with an error: ${line}`, failure: { message: 'bad' }, logs: [] }, ctx);
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
  });

  it('names the route the framework says failed, not an earlier failed request for something else', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['404 /img/hero.png (linked from /)', 'Error: boom', 'Failed to prerender `/contact/`'] }, ctx);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
  });

  it('prefers the page of the file an error was raised in over a progress line that mentions another route', () => {
    const r = explainBuildFailure(state(), { error: 'x', failure: { message: 'Build failed', cause: { message: 'Unexpected token', id: '/var/folders/ab/T/export-1/project/src/routes/contact/+page.svelte', loc: { line: 4 } } }, logs: ['prerendering /about/'] }, ctx);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['prerendering /about/'] }, ctx).message).toBe('The production build failed while building the About page (/about/).');
  });

  it('takes the file from the deepest error’s stack, and does not mistake a source map for the file', () => {
    const r = explainBuildFailure(
      state(),
      { error: 'x', failure: { message: 'Build failed', stack: 'Error: Build failed\n    at wrap (src/lib/Outer.svelte:1:1)', cause: { message: 'boom', stack: 'Error: boom\n    at inner (src/lib/Inner.svelte:9:2)' } }, logs: [] },
      ctx
    );
    expect(r.details).toContain('File: src/lib/Inner.svelte, line 9');
    expect(explainBuildFailure(state(), { error: 'x', logs: ['Error: boom', '    at src/routes/about/+page.svelte.map:1:1'] }, ctx).message).toBe('The production build failed.');
  });

  it('masks a credential in a URL’s query without eating the parameters around it, or a source expression', () => {
    const r = explainBuildFailure(
      state(),
      { error: 'Prerendering failed', logs: ['Error: GET https://api.example.com/x?mode=preview&access_token=abcdef123456&lang=en failed', 'Error: https://ada:pw@example.com/x?a=b:c@d', 'Error: token = componentState.currentToken'] },
      ctx
    );
    expect(r.warnings[0]).toBe('Error: GET https://api.example.com/x?mode=preview&access_token=…&lang=en failed');
    expect(r.warnings[1]).toBe('Error: https://…@example.com/x?a=b:c@d');
    expect(r.warnings[2]).toBe('Error: token = componentState.currentToken');
  });

  it('shows what a crashed build printed, and a warning when nothing else was said', () => {
    expect(explainBuildFailure(state(), { error: 'Build process exited (139).', logs: ['Segmentation fault'] }, ctx).warnings).toEqual(['Build process exited (139).', 'Segmentation fault']);
    expect(explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['(!) Could not resolve "./Missing.svelte" from "src/lib/A.svelte"'] }, ctx).warnings).toEqual(['(!) Could not resolve "./Missing.svelte" from "src/lib/A.svelte"']);
  });

  it('keeps a page title of any length out of the headline and the report’s limit', () => {
    const s = state();
    s.pages[Object.keys(s.pages).find((id) => s.pages[id].route === '/contact/')!].title = 'T'.repeat(25_000);
    const r = explainBuildFailure(s, { error: 'Prerendering failed', logs: ['500 GET /contact/', 'Error: boom'] }, ctx);
    expect(r.message.length).toBeLessThan(200);
    expect(r.details.length).toBeLessThan(2000);
  });

  it('counts the marks that say lines are left out against the report’s size', () => {
    // Separate errors, each far from the next, so every one needs a mark of its own.
    const logs = Array.from({ length: 4000 }, (_, i) => (i % 7 === 0 ? `Error: failure ${i} ${'x'.repeat(100)}` : `progress ${i}`));
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs }, ctx);
    expect(r.details.length).toBeLessThanOrEqual(48_000);
  });

  it('shows the last failure, not only the first ones, when a long build failed many times', () => {
    const early = Array.from({ length: 12 }, (_, i) => `Error: early failure ${i} ${'e'.repeat(1500)}`);
    const logs = [...early, 'TypeError: the failure that ended it', '    at Last (src/lib/Last.svelte:7:1)', ...Array.from({ length: 400 }, (_, i) => `progress ${i} ${'p'.repeat(200)}`)];
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs }, ctx);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toMatch(/^Error: early failure 0/);
    expect(r.warnings.at(-1)).toBe('TypeError: the failure that ended it');
    expect(r.details.split('\n')).toContain('  TypeError: the failure that ended it');
    expect(r.details.split('\n')).toContain('      at Last (src/lib/Last.svelte:7:1)');
    expect(r.details.length).toBeLessThanOrEqual(48_000);
  });

  it('does not take a route or a cause from a warning that mentions a status', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['Warning: cached 404 /old/', 'Error: the real failure', '500 GET /contact/'] }, ctx);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(r.warnings).toEqual(['Error: the real failure']);
  });

  it('names the route of a failure whatever kind of error line carries it', () => {
    expect(explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['Http2Error: 500 /contact/ (linked from /)'] }, ctx).message).toBe('The production build failed while building the Contact page (/contact/).');
  });

  it('keeps every frame of the latest exception’s stack that fits, among a long progress tail', () => {
    const logs = ['Error: first', 'TypeError: the one that ended it', ...Array.from({ length: 10 }, (_, i) => `    at frame${i} (src/lib/F.svelte:${i}:1) ${'f'.repeat(800)}`), ...Array.from({ length: 300 }, (_, i) => `progress ${i} ${'p'.repeat(300)}`)];
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs }, ctx);
    expect(r.warnings).toContain('TypeError: the one that ended it');
    expect(r.details.split('\n').filter((l) => /^\s+at frame\d \(src\/lib\/F\.svelte/.test(l))).toHaveLength(10);
  });

  it('names the component from a stack Windows prints with backslashes, relative to the project', () => {
    const s = state();
    s.components.cmp_hours = { schemaVersion: 1, id: 'cmp_hours', componentId: 'custom.hours', contractVersion: 1, kind: 'code', owner: 'project', name: 'Opening hours', description: '', category: 'content', tags: [], properties: {}, parts: {}, sourcePath: 'src/lib/siteorigin/custom/OpeningHours-jvnuj.svelte' } as never;
    // What a real export on Windows 11 printed (tests/e2e/export-failure.mjs).
    const logs = [
      'vite v8.3.8 building ssr environment for production...',
      '✓ built in 249ms',
      '500 GET /contact/',
      'Error: The opening hours widget could not read its hours',
      '    at src\\lib\\siteorigin\\custom\\OpeningHours-jvnuj.svelte:3:23',
      '    at node_modules\\svelte\\src\\internal\\server\\renderer.js:416:11',
      '    at Renderer.child (node_modules\\svelte\\src\\internal\\server\\renderer.js:305:18)',
      '    at Renderer.component (node_modules\\svelte\\src\\internal\\server\\renderer.js:414:8)',
      '    at OpeningHours_jvnuj (src\\lib\\siteorigin\\custom\\OpeningHours-jvnuj.svelte:1:1)',
      '    at _page (src\\routes\\contact\\+page.svelte:43:8)',
      'prerender_http_error',
      'Failed to prerender `/contact/`'
    ];
    const windows = { ...ctx, platform: 'win32 x64', roots: [{ path: 'C:\\Users\\greg\\AppData\\Local\\Temp\\export-1\\project', label: '<project>' }, { path: 'C:\\Users\\greg', label: '~' }] };
    const r = explainBuildFailure(s, { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs }, windows);
    expect(r.message).toBe('The production build failed while building the Contact page (/contact/).');
    expect(r.warnings).toContain('The build was working in the “Opening hours” component (src/lib/siteorigin/custom/OpeningHours-jvnuj.svelte, line 3).');
    expect(r.details).toContain('File: src/lib/siteorigin/custom/OpeningHours-jvnuj.svelte, line 3 (the “Opening hours” component)');
    // A module the error names, relative and with backslashes, is read the same way.
    const id = explainBuildFailure(s, { error: 'x', failure: { message: 'x', cause: { message: 'boom', id: 'src\\lib\\siteorigin\\custom\\OpeningHours-jvnuj.svelte' } }, logs: [] }, windows);
    expect(id.message).toBe('The production build failed in the “Opening hours” component (src/lib/siteorigin/custom/OpeningHours-jvnuj.svelte).');
  });

  it('does not list a warning beside a cause that was stated', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed', cause: { message: 'Unexpected token' } }, logs: ['(!) Some chunks are larger than 500 kB'] }, ctx);
    expect(r.warnings).toEqual(['Unexpected token']);
  });

  it('reads a JSX or TSX file, and stops a file name at the end of its path', () => {
    const tsx = explainBuildFailure(state(), { error: 'x', failure: { message: 'Build failed', cause: { message: 'Unexpected token', loc: { file: '/var/folders/ab/T/export-1/project/src/lib/Widget.tsx', line: 3 } } }, logs: [] }, ctx);
    expect(tsx.details).toContain('File: src/lib/Widget.tsx, line 3');
    const data = explainBuildFailure(state(), { error: 'Error: boom', logs: ['    at load (src/lib/fixtures.js/data.json:1:1)'] }, ctx);
    expect(data.details).not.toContain('File:');
  });

  it('keeps a component or page name of any length out of the headline and report limits', () => {
    const s = state();
    s.components.cmp_big = { schemaVersion: 1, id: 'cmp_big', componentId: 'custom.big', contractVersion: 1, kind: 'code', owner: 'project', name: 'N'.repeat(49_000), description: '', category: 'content', tags: [], properties: {}, parts: {}, sourcePath: 'src/lib/siteorigin/custom/Big.svelte' } as never;
    const r = explainBuildFailure(s, { error: 'Prerendering failed', logs: ['Error: boom', '    at Big (src/lib/siteorigin/custom/Big.svelte:2:1)', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)] }, ctx);
    expect(r.message.length).toBeLessThan(300);
    expect(r.details.length).toBeLessThan(5000);
    expect(r.details).toContain('  line 19');
  });

  it('hides a folder a file URL names with escapes in either case', () => {
    const root = [{ path: '/Users/ada/Café', label: '<project>' }];
    expect(hidePaths('file:///Users/ada/Caf%C3%A9/a.js and file:///Users/ada/Caf%c3%a9/b.js', root)).toBe('<project>/a.js and <project>/b.js');
  });

  it('keeps each mark that says lines are left out, even when two read the same', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', logs: ['… 3 lines omitted', 'Error: first', '… 3 lines omitted', 'Error: second'] }, ctx);
    expect(r.details.split('\n').filter((l) => l.trim() === '… 3 lines omitted')).toHaveLength(2);
  });

  it('cuts a report that is somehow still too long', () => {
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs: Array.from({ length: 60 }, (_, i) => `Error: ${i} ${'x'.repeat(1990)}`) }, ctx);
    expect(r.details.length).toBeLessThanOrEqual(48_100);
  });

  it('keeps the missing-section explanation, and its build lines, in the report', () => {
    const line = 'Error: The following pages contain links to /contact/#gone, but no element with id="gone" exists on /contact/ - see the `handleMissingId` option';
    const r = explainBuildFailure(state(), { error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs: [...noise, line] }, ctx);
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
    expect(r.warnings[0]).toBe(line);
    expect(r.details).toContain(line);
    expect(r.details.startsWith('SiteOrigin Builder 1.2.3 on darwin arm64\nThe production build failed because a link goes')).toBe(true);
  });
});
