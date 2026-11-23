// P01: the packaged app creates a project and previews it with no system Node on PATH.
// Works on macOS, Windows and Linux (CI runs it on all three). APP_BIN overrides the executable.
import { _electron as electron } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
const win = await app.firstWindow();
await win.waitForSelector('.welcome', { timeout: 60000 });
const progress = [];
await win.exposeFunction('__progress', (p) => progress.push(p));
await win.evaluate(() => window.builder.on('create:progress', (p) => window.__progress(p.detail ?? p.message)));
const t0 = Date.now();
const r = await win.evaluate((dir) => window.builder.projects.create({ name: 'Packaged Test', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 's'));
console.log('create', JSON.stringify(r), Date.now() - t0, 'ms');
if (!r.ok) {
  console.log(progress.join('\n'));
  process.exit(1);
}
const frame = await (await win.waitForSelector('.frame-box iframe', { timeout: 120000 })).contentFrame();
await frame.waitForSelector('h1', { timeout: 120000 });
console.log('preview h1:', await frame.innerText('h1'));
console.log('setup:', progress.filter((p) => /bundled|download/i.test(p)).join(' | '));
await win.screenshot({ path: join(WORK, `packaged-${process.platform}.png`) });
await app.close();
