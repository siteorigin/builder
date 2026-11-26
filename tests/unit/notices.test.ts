// The app's third-party notices (issue #823): which package owns a bundled module, what licence text a package carries,
// and the notices file built from the bundles, the shipped packages and the theme packs' fonts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as notices from '../../build/notices.cjs';
import { appMenuTemplate, NOTICES_FILE, noticesFile } from '../../src/main/app-menu';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-notices-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write files under the fixture root: path → contents (objects as JSON). */
function files(tree: Record<string, string | object>) {
  for (const [rel, body] of Object.entries(tree)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
}

const pkg = (name: string, version: string, extra: object = {}) => ({ name, version, license: 'MIT', ...extra });

describe('the package that owns a bundled module', () => {
  it('keeps scoped and nested packages and drops query suffixes and virtual prefixes', () => {
    expect(notices.packageRootOf('/r/node_modules/react/cjs/react.production.js')).toBe('/r/node_modules/react');
    expect(notices.packageRootOf('/r/node_modules/@codemirror/view/dist/index.js')).toBe('/r/node_modules/@codemirror/view');
    expect(notices.packageRootOf('/r/node_modules/a/node_modules/b/index.js?commonjs-exports')).toBe('/r/node_modules/a/node_modules/b');
    expect(notices.packageRootOf('\0/r/node_modules/@radix-ui/react-menu/dist/index.mjs?v=1')).toBe('/r/node_modules/@radix-ui/react-menu');
    expect(notices.packageRootOf('C:\\r\\node_modules\\svelte\\compiler\\index.js'.split('\\').join('/'))).toBe('C:/r/node_modules/svelte');
    // A submanifest such as svelte/compiler/package.json belongs to its package, not to a package of its own.
    expect(notices.packageRootOf('/r/node_modules/svelte/compiler/package.json')).toBe('/r/node_modules/svelte');
  });

  it('owns nothing outside node_modules', () => {
    expect(notices.packageRootOf('/r/src/renderer/src/App.tsx')).toBeNull();
    expect(notices.packageRootOf('\0vite/modulepreload-polyfill.js')).toBeNull();
    expect(notices.packageRootOf('/r/node_modules/@scope')).toBeNull();
    expect(notices.packageRootOf('/r/node_modules/.vite/deps/x.js')).toBeNull();
  });

  it('records the packages of every chunk and asset of a build, sorted, for the notices to read', () => {
    files({ 'node_modules/react/package.json': pkg('react', '19.3.1'), 'node_modules/@fontsource-variable/inter/package.json': pkg('@fontsource-variable/inter', '5.3.0', { license: 'OFL-1.1' }) });
    const out = join(root, '.tmp/notices/renderer.json');
    const plugin = notices.bundledPackagesPlugin('renderer', out);
    plugin.buildStart();
    plugin.generateBundle(
      {},
      {
        'index.js': { type: 'chunk', moduleIds: [join(root, 'src/App.tsx'), join(root, 'node_modules/react/index.js'), join(root, 'node_modules/react/cjs/react.js'), '\0vite/preload-helper.js'] },
        'inter.woff2': { type: 'asset', originalFileNames: [join(root, 'node_modules/@fontsource-variable/inter/files/inter.woff2')] },
        // A module whose package is not installed where the id says is not listed.
        'gone.js': { type: 'chunk', modules: { [join(root, 'node_modules/gone/index.js')]: {} } }
      }
    );
    plugin.writeBundle();
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      target: 'renderer',
      packages: [
        { name: '@fontsource-variable/inter', version: '5.3.0', dir: join(root, 'node_modules/@fontsource-variable/inter') },
        { name: 'react', version: '19.3.1', dir: join(root, 'node_modules/react') }
      ]
    });
  });

  it('refuses to package when a bundle has not been built', () => {
    files({ '.tmp/notices/main.json': { target: 'main', packages: [] }, '.tmp/notices/renderer.json': { target: 'renderer', packages: [] } });
    expect(() => notices.bundledPackages(join(root, '.tmp/notices'))).toThrow(/preload\.json is missing: run electron-vite build/);
  });
});

describe('the licence text a package carries', () => {
  it('reads every licence file, however it is spelled, and vendored ones inside the package', () => {
    files({
      'p/package.json': pkg('openai', '7.62.0', { license: 'Apache-2.0', repository: { url: 'git+https://github.com/openai/openai-node.git' } }),
      'p/LICENSE': 'Apache License\r\nVersion 2.0',
      'p/NOTICE.md': 'Copyright OpenAI',
      'p/src/internal/qs/LICENSE.md': 'qs: BSD-3-Clause, Copyright Jordan Harband',
      'p/README.md': '# openai\n\n## License\n\nApache-2.0',
      // Not licences: a nested package's own (it is a package of its own), node_modules, and a file merely named like one.
      'p/node_modules/dep/LICENSE': 'nested',
      'p/vendor/inner/package.json': pkg('inner', '1.0.0'),
      'p/vendor/inner/LICENSE': 'inner package',
      'p/licensed-files.js': 'code'
    });
    expect(notices.readPackage(join(root, 'p'))).toEqual({
      name: 'openai',
      version: '7.62.0',
      licence: 'Apache-2.0',
      repository: 'https://github.com/openai/openai-node.git',
      texts: [
        { file: 'LICENSE', text: 'Apache License\nVersion 2.0' },
        { file: 'NOTICE.md', text: 'Copyright OpenAI' },
        { file: 'src/internal/qs/LICENSE.md', text: 'qs: BSD-3-Clause, Copyright Jordan Harband' }
      ],
      missing: false
    });
    for (const name of ['LICENCE', 'license.txt', 'LICENSE-MIT', 'COPYING', 'COPYRIGHT', 'ThirdPartyNotices.txt', 'third-party-notices.md']) expect(notices.LICENCE_FILE.test(name), name).toBe(true);
    for (const name of ['licensed.js', 'README.md', 'notices.cjs', 'package.json']) expect(notices.LICENCE_FILE.test(name), name).toBe(false);
  });

  it('with no licence file, follows SEE LICENSE IN, then the README’s Licence section, and otherwise says it is missing', () => {
    files({
      'a/package.json': pkg('a', '1.0.0', { license: 'SEE LICENSE IN terms.txt' }),
      'a/terms.txt': 'Terms of a',
      'b/package.json': pkg('@img/sharp-libvips-darwin-arm64', '1.3.4', { license: 'LGPL-3.0-or-later' }),
      'b/README.md': '# libvips\n\nPrebuilt binaries.\n\n## Licensing\n\nLGPL-3.0-or-later; see THIRD-PARTY-NOTICES.\n\n### Bundled\n\nlibpng, mozjpeg\n\n## Building\n\nnot this',
      'c/package.json': pkg('is-reference', '3.0.3'),
      'c/README.md': '# is-reference\n\nNo licence heading here.',
      'd/package.json': { name: 'old', version: '0.1.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }
    });
    const a = notices.readPackage(join(root, 'a'));
    expect([a.texts, a.missing]).toEqual([[{ file: 'terms.txt', text: 'Terms of a' }], false]);
    const b = notices.readPackage(join(root, 'b'));
    expect([b.texts, b.missing]).toEqual([[{ file: 'README.md', text: '## Licensing\n\nLGPL-3.0-or-later; see THIRD-PARTY-NOTICES.\n\n### Bundled\n\nlibpng, mozjpeg' }], false]);
    const c = notices.readPackage(join(root, 'c'));
    expect([c.licence, c.texts, c.missing]).toEqual(['MIT', [], true]);
    expect(notices.readPackage(join(root, 'd')).licence).toBe('(MIT OR Apache-2.0)');
  });

  it('finds every installed package, scoped and nested', () => {
    files({
      'node_modules/a/package.json': pkg('a', '1.0.0'),
      'node_modules/a/node_modules/b/package.json': pkg('b', '2.0.0'),
      'node_modules/@s/c/package.json': pkg('@s/c', '3.0.0'),
      'node_modules/.bin/x': '',
      'node_modules/not-a-package/index.js': ''
    });
    expect(notices.packagesUnder(join(root, 'node_modules')).map((d) => d.slice(root.length + 1).split('\\').join('/'))).toEqual(['node_modules/@s/c', 'node_modules/a', 'node_modules/a/node_modules/b']);
    expect(notices.packagesUnder(join(root, 'nowhere'))).toEqual([]);
  });

  it('takes the production packages from the lockfile, never the development-only ones', () => {
    files({
      'package-lock.json': { packages: { '': {}, 'node_modules/svelte': {}, 'node_modules/react': { dev: true }, 'node_modules/@img/sharp-linux-x64': { optional: true }, 'node_modules/fsevents': { devOptional: true }, 'node_modules/@img/sharp-win32-x64': {} } },
      'node_modules/svelte/package.json': pkg('svelte', '5.59.1'),
      'node_modules/react/package.json': pkg('react', '19.3.1'),
      'node_modules/@img/sharp-linux-x64/package.json': pkg('@img/sharp-linux-x64', '0.35.5'),
      'node_modules/fsevents/package.json': pkg('fsevents', '2.3.3')
    });
    // A platform package that is not installed here is not shipped from here.
    expect(notices.productionPackages(root).map((d) => d.slice(root.length + 1).split('\\').join('/'))).toEqual(['node_modules/@img/sharp-linux-x64', 'node_modules/svelte']);
  });

  it('carries Lucide’s ISC licence with the Feather attribution it keeps', () => {
    const lucide = notices.readPackage(join(process.cwd(), 'node_modules', 'lucide-react'));
    expect(lucide.licence).toBe('ISC');
    expect(lucide.texts.map((t) => t.text).join('\n')).toMatch(/Cole Bemis/);
  });
});

describe('the notices file', () => {
  const fixture = () => {
    files({
      'node_modules/react/package.json': pkg('react', '19.3.1'),
      'node_modules/react/LICENSE': 'MIT License\n\nCopyright (c) Meta Platforms',
      'node_modules/svelte/package.json': pkg('svelte', '5.59.1'),
      'node_modules/svelte/LICENSE.md': 'Copyright (c) 2016 Svelte contributors',
      'node_modules/locate-character/package.json': pkg('locate-character', '3.0.0'),
      'packs/foundation/pack.json': { name: 'Foundation', fonts: [{ name: 'Inter', family: 'Inter Variable', license: 'OFL-1.1', notice: 'Copyright 2020 The Inter Project Authors\r\nSIL OPEN FONT LICENSE Version 1.1' }] },
      'packs/editorial/pack.json': { name: 'Editorial', fonts: [{ name: 'Inter', family: 'Inter Variable', license: 'OFL-1.1', notice: 'Copyright 2020 The Inter Project Authors\nSIL OPEN FONT LICENSE Version 1.1' }, { name: 'Fraunces', family: 'Fraunces Variable', license: 'OFL-1.1', notice: 'Copyright 2018 The Fraunces Project Authors' }] },
      'packs/.staging/x/pack.json': { name: 'never', fonts: [{ name: 'Never', family: 'Never', license: 'OFL-1.1', notice: 'x' }] }
    });
    const nm = (n: string) => join(root, 'node_modules', n);
    return {
      parts: {
        renderer: [nm('react'), nm('svelte')],
        main: [nm('svelte')],
        shipped: [nm('svelte'), nm('locate-character')],
        starter: [{ name: 'vite', version: '8.3.8', licence: 'MIT', repository: null, texts: [{ file: 'LICENSE.md', text: 'Copyright (c) 2019-present VoidZero Inc.' }], missing: false }]
      },
      packsDirs: [join(root, 'packs'), join(root, 'nowhere')]
    };
  };

  it('lists each package version once with where it ships and its full licence text, then each font family', () => {
    const { text, missing } = notices.buildNotices(fixture());
    expect(text).toMatch(/^SiteOrigin Builder: third-party notices\n\nSiteOrigin Builder is licensed under the Apache License, Version 2.0: see LICENSE.txt/);
    expect(text).toContain('Packages: 4. Font families: 2.');
    const rule = '='.repeat(78);
    const entries = text.split(`${rule}\n`).slice(1);
    expect(entries.map((e) => e.split('\n')[0])).toEqual(['locate-character 3.0.0', 'react 19.3.1', 'svelte 5.59.1', 'vite 8.3.8', 'Font: Fraunces (Fraunces Variable)', 'Font: Inter (Inter Variable)']);
    expect(entries[2]).toBe('svelte 5.59.1\nLicence: MIT\nIncluded in: compiled into the app; compiled into the editor; shipped with the app\n\n--- LICENSE.md ---\n\nCopyright (c) 2016 Svelte contributors\n\n');
    expect(entries[0]).toContain('The package carries no licence text; its declared licence is above.');
    expect(entries[3]).toContain('Included in: the website starter, cached for setting projects up offline');
    // One family with the same notice in two packs is listed once, with both packs.
    expect(entries[5]).toBe('Font: Inter (Inter Variable)\nLicence: OFL-1.1\nIncluded in theme packs: Editorial, Foundation\n\nCopyright 2020 The Inter Project Authors\nSIL OPEN FONT LICENSE Version 1.1\n');
    expect(missing).toEqual(['locate-character@3.0.0 (MIT)']);
  });

  it('is the same file whatever order the packages and packs are read in', () => {
    const input = fixture();
    const shuffled = { parts: Object.fromEntries(Object.entries(input.parts).reverse().map(([k, v]) => [k, [...v].reverse()])), packsDirs: [...input.packsDirs].reverse() };
    expect(notices.buildNotices(shuffled).text).toBe(notices.buildNotices(input).text);
  });

  it('warns about the packages with no licence text, and says nothing when there are none', () => {
    const said: string[] = [];
    notices.warnMissing([], (m) => said.push(m));
    notices.warnMissing(['a@1.0.0 (MIT)'], (m) => said.push(m));
    expect(said).toEqual(['Third-party notices: 1 package(s) carry no licence text, so only their declared licence is listed:\n  a@1.0.0 (MIT)']);
  });
});

describe('Help > Third-Party Notices', () => {
  it('is in the menu on every platform, with or without a project, and opens the notices', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const)
      for (const open of [true, false]) {
        let opened = 0;
        const menu = appMenuTemplate(platform, open, { command: () => undefined, history: () => () => undefined, openNotices: () => opened++ });
        const help = menu.find((m) => m.label === 'Help');
        expect(help, `${platform} ${open}`).toBeTruthy();
        const item = (help!.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Third-Party Notices')!;
        expect([item.id, item.enabled ?? true]).toEqual(['third-party-notices', true]);
        (item.click as () => void)();
        expect(opened).toBe(1);
        // Help is the last menu of the bar.
        expect(menu.at(-1)).toBe(help);
      }
  });

  it('opens the file beside LICENSE.txt in a packaged app, and the development build’s in the repository', () => {
    expect(NOTICES_FILE).toBe(notices.NOTICES_FILE);
    expect(noticesFile(true, join('/Applications/SiteOrigin Builder.app/Contents/Resources'), '/ignored')).toBe(join('/Applications/SiteOrigin Builder.app/Contents/Resources', 'THIRD_PARTY_NOTICES.txt'));
    expect(noticesFile(false, '/ignored', join('/repo'))).toBe(join('/repo', '.tmp', 'notices', 'THIRD_PARTY_NOTICES.txt'));
  });
});
