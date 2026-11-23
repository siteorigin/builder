// End-to-end smoke test: drives the real Electron app.
import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.SHOTS ?? '/tmp/so-shots';
const WORK = process.env.WORK ?? '/tmp/so-work';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
await win.screenshot({ path: join(OUT, '01-welcome.png') });
// API keys are stored in a user-only local file, never the OS keychain.
const saved = await win.evaluate(async () => (await window.builder.ai.setKey('anthropic', 'sk-ant-test')).find((p) => p.id === 'anthropic'));
console.log('key saved:', saved.configured, saved.source, saved.storage);
const { statSync } = await import('node:fs');
console.log('key file mode:', (statSync(join(WORK, 'userdata', 'api-keys.json')).mode & 0o777).toString(8));
await win.evaluate(() => window.builder.ai.setKey('anthropic', null));

await win.getByRole('button', { name: /New project/ }).first().click();
await win.waitForSelector('.modal');
await win.fill('input[placeholder^="For example"]', 'Harbour Lane Studio');
await win.screenshot({ path: join(OUT, '02-new-project.png') });
// The folder picker is a native dialog; create through the same IPC call the dialog uses.
const t0 = Date.now();
const res = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
console.log('create', res, Date.now() - t0, 'ms');
await win.waitForSelector('.editor');
await win.waitForSelector('.frame-box iframe', { timeout: 60000 });
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 60000 });
await win.waitForTimeout(1500);
await win.screenshot({ path: join(OUT, '03-editor.png') });

// Select the hero, then its heading.
await frame.locator('h1').first().click();
await win.waitForTimeout(400);
await frame.locator('h1').first().click();
await win.waitForTimeout(600);
await win.screenshot({ path: join(OUT, '04-selected-heading.png') });
console.log(logs.slice(-30).join('\n'));
await app.close();
