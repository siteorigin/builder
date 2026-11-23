// Linux smoke test: run inside a Linux container with Xvfb. Creates and previews a project with the packaged app.
import { _electron as electron } from 'playwright';
import { rmSync } from 'node:fs';
const WORK = '/tmp/so-linux';
rmSync(WORK, { recursive: true, force: true });
const app = await electron.launch({
  executablePath: process.env.APP_BIN,
  args: ['--no-sandbox'],
  env: { HOME: '/tmp', PATH: '/usr/bin:/bin', DISPLAY: process.env.DISPLAY, SITEORIGIN_USER_DATA: `${WORK}/u` }
});
const win = await app.firstWindow();
await win.waitForSelector('.welcome');
const t0 = Date.now();
const r = await win.evaluate((dir) => window.builder.projects.create({ name: 'Linux Test', parentDir: dir, starter: 'business', sampleImages: true }), `${WORK}/s`);
console.log('create', JSON.stringify(r), Date.now() - t0, 'ms');
const frame = await (await win.waitForSelector('.frame-box iframe', { timeout: 120000 })).contentFrame();
await frame.waitForSelector('h1', { timeout: 120000 });
console.log('preview h1:', await frame.innerText('h1'));
await win.screenshot({ path: '/out/linux-editor.png' });
await app.close();
