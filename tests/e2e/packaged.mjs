// P01: the packaged app creates a project and previews it with no system Node on PATH, makes the starter
// images' responsive copies in its media worker, and serves the preview with the packaged-only frame policy. It carries
// its own licence and the generated third-party notices, which Help > Third-Party Notices opens (#823). On macOS its
// bundle also declares no camera, microphone, audio capture or Bluetooth use.
// Written for macOS, Windows and Linux; for now only the local stabilization run takes it, on macOS. APP_BIN overrides
// the executable.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseMenu, desktopCursor, desktopIntents } from './harness.mjs';

/** The preview may be framed by the packaged editor's origin only, never by a loopback dev server. */
const PACKAGED_FRAME_POLICY = 'frame-ancestors app://editor';

const WORK = process.env.WORK ?? join(tmpdir(), 'so-packaged');
rmSync(WORK, { recursive: true, force: true });
const defaults = {
  darwin: 'dist/mac-arm64/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder',
  win32: 'dist/win-unpacked/SiteOrigin Builder.exe',
  linux: 'dist/linux-unpacked/siteorigin-builder'
};
const executablePath = process.env.APP_BIN ?? defaults[process.platform];
if (process.platform === 'darwin') {
  // The bundle that holds this executable: Contents/MacOS/<executable> beside Contents/Info.plist.
  const plistPath = join(dirname(realpathSync(executablePath)), '..', 'Info.plist');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], { encoding: 'utf8' }));
  const declared = Object.keys(plist).filter((key) => /^NS(Camera|Microphone|AudioCapture|Bluetooth\w*)UsageDescription$/.test(key));
  assert.deepEqual(declared, [], 'the bundle declares no camera, microphone, audio capture or Bluetooth use');
  assert.equal(plist.LSApplicationCategoryType, 'public.app-category.graphics-design', 'the bundle is in Graphics & Design');
}
const minimalPath = process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin';
// Launched by path, the app does not see Playwright's loader: SITEORIGIN_HEADLESS says a test drives it, so it stays
// off screen and answers its own native choosers (#494).
const env = { PATH: minimalPath, SITEORIGIN_USER_DATA: join(WORK, 'u'), SITEORIGIN_HEADLESS: '1' };
for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[k]) env[k] = process.env[k];
const app = await electron.launch({
  executablePath,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  env
});
try {
  const win = await app.firstWindow();
  await win.waitForSelector('.welcome', { timeout: 60000 });
  // The editor itself is served from the app's own origin, under its own content policy.
  const editor = await win.evaluate(() => ({ origin: location.origin, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '' }));
  assert.equal(editor.origin, 'app://editor', 'the packaged editor is served from app://editor');
  assert.match(editor.csp, /default-src 'self'/, 'the editor page carries its content security policy');
  assert.match(editor.csp, /script-src 'self'(;|$)/, 'the editor runs only its own scripts');

  // With no Bluetooth use declared, macOS would end the app if a page reached for it.
  if (process.platform === 'darwin') assert.equal(await win.evaluate(() => 'bluetooth' in navigator), false, 'Web Bluetooth is off');

  // A packaged build registers none of the development-only builderTest handlers (#494). Driven by a test it still
  // answers its own native choosers, so a chooser nobody answered is closed and recorded, never shown on screen.
  assert.equal(await app.evaluate(({ app: a }) => a.isPackaged), true, 'this is the packaged app');
  const devHooks = await win.evaluate(() =>
    Promise.all(Object.entries(window.builderTest).map(([name, call]) => call().then(() => [name, 'answered'], (e) => [name, String(e?.message ?? e)])))
  );
  assert.ok(devHooks.length >= 7, `the preload offers the builderTest calls (${devHooks.length})`);
  for (const [name, outcome] of devHooks) assert.match(outcome, /No handler registered for 'test:/, `a packaged build has no handler for builderTest.${name}`);
  assert.equal(await app.evaluate(() => typeof globalThis[Symbol.for('siteorigin.desktopFixtures')]?.events), 'function', 'the packaged app answers its choosers from the test');
  const picked = await Promise.race([win.evaluate(() => window.builder.dialogs.chooseFolder('Choose a folder')), new Promise((_, reject) => setTimeout(() => reject(new Error('the folder chooser did not close within 10s')), 10000))]);
  assert.equal(picked, null, 'an unanswered folder chooser chooses nothing');
  const choosers = await app.evaluate(() => globalThis[Symbol.for('siteorigin.desktopFixtures')].events(0).entries.filter((e) => e.type === 'chooser').map((e) => [e.title, e.outcome]));
  assert.deepEqual(choosers, [['Choose a folder', 'unanswered']], 'it was closed and recorded, not shown');

  // The app's own licence and the notices the build generated sit in its resources, on every platform (#823).
  const resources = await app.evaluate(() => process.resourcesPath);
  assert.equal(readFileSync(join(resources, 'LICENSE.txt'), 'utf8'), readFileSync('LICENSE', 'utf8'), 'the app ships its own licence');
  const notices = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  console.log('notices', `${(notices.length / 1024).toFixed(0)} KB`, notices.match(/^Packages: .*$/m)?.[0]);
  // Each package and font is checked inside its own entry, so a label or a licence text from a neighbour cannot stand in.
  const entries = new Map(
    notices
      .split(`${'='.repeat(78)}\n`)
      .slice(1)
      .map((e) => [e.split('\n')[0], e])
  );
  const entry = (heading) => {
    const found = [...entries.entries()].find(([h]) => heading.test(h));
    assert.ok(found, `the notices have an entry for ${heading}`);
    return found[1];
  };
  // [heading, declared licence, a part it is included in, a line of its licence text]
  const listed = [
    [/^react \d/, 'MIT', 'compiled into the editor', /Permission is hereby granted/],
    [/^@codemirror\/view \d/, 'MIT', 'compiled into the editor', /Copyright \(C\) .*Marijn Haverbeke/],
    [/^@radix-ui\/react-dropdown-menu \d/, 'MIT', 'compiled into the editor', /Copyright \(c\) .*WorkOS/],
    [/^lucide-react \d/, 'ISC', 'compiled into the editor', /Copyright \(c\) 2013-present Cole Bemis/],
    [/^rolldown \d/, 'MIT', 'compiled into the editor', /--- THIRD-PARTY-LICENSE ---\n\n[\s\S]*github\.com\/rollup\/rollup[\s\S]*Copyright \(c\) 2020 Evan Wallace/],
    [/^@oxc-project\/runtime \d/, 'MIT', 'compiled into the app', /Sebastian McKenzie/],
    [/^svelte \d/, 'MIT', 'shipped with the app', /Copyright \(c\) .*Svelte Contributors/],
    [/^sharp \d/, 'Apache-2.0', 'shipped with the app', /Apache License/],
    [/^npm \d/, 'Artistic-2.0', 'npm, which sets projects up', /The Artistic License 2\.0/],
    [/^@sveltejs\/kit \d/, 'MIT', 'the website starter, cached for setting projects up offline', /Copyright \(c\) 2020 \[these people\]/],
    [/^Font: Inter \(Inter Variable\)$/, 'OFL-1.1', null, /The Inter Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1[\s\S]*PERMISSION & CONDITIONS/]
  ];
  for (const [heading, licence, part, text] of listed) {
    const e = entry(heading);
    // The header is the lines before the first blank one; the licence texts follow it.
    const header = e.slice(0, e.indexOf('\n\n')).split('\n');
    assert.equal(header.find((l) => l.startsWith('Licence: ')), `Licence: ${licence}`, `${heading} declares ${licence}`);
    if (part) assert.ok((header.find((l) => l.startsWith('Included in: ')) ?? '').slice('Included in: '.length).split('; ').includes(part), `${heading} is listed as ${part}`);
    assert.match(e.slice(e.indexOf('\n\n')), text, `${heading} carries its licence text`);
  }
  // Help > Third-Party Notices hands that file to the desktop (recorded, as a test drives the app).
  const before = await desktopCursor(app);
  await chooseMenu(app, ['Help', 'Third-Party Notices']);
  const opened = (await desktopIntents(app, before)).map((e) => [e.kind, e.target]);
  assert.deepEqual(opened, [['open-path', join(resources, 'THIRD_PARTY_NOTICES.txt')]], 'Help > Third-Party Notices opens the notices');

  const progress = [];
  await win.exposeFunction('__progress', (p) => progress.push(p));
  await win.evaluate(() => window.builder.on('create:progress', (p) => window.__progress(p.detail ?? p.message)));
  const t0 = Date.now();
  const r = await win.evaluate((dir) => window.builder.projects.create({ name: 'Packaged Test', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 's'));
  console.log('create', JSON.stringify(r), Date.now() - t0, 'ms');
  if (!r.ok) {
    console.log(progress.join('\n'));
    process.exitCode = 1;
  } else {
    const frame = await (await win.waitForSelector('.frame-box iframe', { timeout: 120000 })).contentFrame();
    await frame.waitForSelector('h1', { timeout: 120000 });
    console.log('preview h1:', await frame.innerText('h1'));
    console.log('setup:', progress.filter((p) => /bundled|download/i.test(p)).join(' | '));

    // The starter's photos got their responsive copies from the packaged media worker.
    const snap = await win.evaluate(() => window.builder.project.snapshot());
    const photo = Object.values(snap.state.assets.assets).find((a) => a.variants?.length);
    assert.ok(photo, 'the starter images have responsive copies');

    // The policy is on the wire: on a page SvelteKit renders, and on a static file.
    const page = new URL(frame.url());
    const responses = [
      { what: 'rendered page', url: page.href, accept: 'text/html', type: /^text\/html/ },
      { what: 'image copy', url: new URL(`/${photo.variants[0].file.replace(/^static\//, '')}`, page.origin).href, accept: 'image/*', type: /^image\/jpeg/ }
    ];
    for (const { what, url, accept, type } of responses) {
      const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(30000) });
      await res.arrayBuffer();
      console.log(what, res.status, res.headers.get('content-type'), '|', res.headers.get('content-security-policy'));
      assert.equal(res.status, 200, `the ${what} is served (${url})`);
      assert.match(res.headers.get('content-type') ?? '', type, `the ${what} has its content type`);
      assert.equal(res.headers.get('content-security-policy'), PACKAGED_FRAME_POLICY, `the ${what} carries the packaged frame policy`);
    }
    await win.screenshot({ path: join(WORK, `packaged-${process.platform}.png`) });
    console.log('packaged checks passed');
  }
} finally {
  await app.close();
}
