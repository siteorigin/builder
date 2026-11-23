// P01: the packaged app creates a project and previews it with no system Node on PATH, makes the starter
// images' responsive copies in its media worker, and serves the preview with the packaged-only frame policy.
// Works on macOS, Windows and Linux (CI runs it on all three). APP_BIN overrides the executable.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The preview may be framed by the packaged editor's origin only, never by a loopback dev server. */
const PACKAGED_FRAME_POLICY = 'frame-ancestors app://editor';

const WORK = process.env.WORK ?? join(tmpdir(), 'so-packaged');
rmSync(WORK, { recursive: true, force: true });
const defaults = {
  darwin: 'dist/mac-arm64/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder',
  win32: 'dist/win-unpacked/SiteOrigin Builder.exe',
  linux: 'dist/linux-unpacked/siteorigin-builder'
};
const minimalPath = process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin';
const env = { PATH: minimalPath, SITEORIGIN_USER_DATA: join(WORK, 'u') };
for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[k]) env[k] = process.env[k];
const app = await electron.launch({
  executablePath: process.env.APP_BIN ?? defaults[process.platform],
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
