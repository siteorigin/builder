// P01: the packaged app creates a project and previews it with no system Node on PATH.
import { _electron as electron } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
const WORK = process.env.WORK;
rmSync(WORK, { recursive: true, force: true });
const app = await electron.launch({
  executablePath: 'dist/mac-arm64/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder',
  env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', SITEORIGIN_USER_DATA: join(WORK, 'u') }
});
const win = await app.firstWindow();
await win.waitForSelector('.welcome');
const progress = [];
await win.exposeFunction('__progress', (p) => progress.push(p));
await win.evaluate(() => window.builder.on('create:progress', (p) => window.__progress(p.detail ?? p.message)));
const t0 = Date.now();
const r = await win.evaluate((dir) => window.builder.projects.create({ name: 'Packaged Test', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 's'));
console.log('create', r, Date.now() - t0, 'ms');
await win.waitForTimeout(8000);
console.log(JSON.stringify(await win.evaluate(() => window.builder.project.snapshot().then((s) => s && s.runtime))));
const frame = await (await win.waitForSelector('.frame-box iframe', { timeout: 60000 })).contentFrame();
await frame.waitForSelector('h1', { timeout: 60000 });
console.log('preview h1:', await frame.innerText('h1'));
console.log('setup:', progress.filter((p) => /bundled|download/i.test(p)).join(' | '));
console.log('which node:', await app.evaluate(() => process.env.PATH));
await app.close();
