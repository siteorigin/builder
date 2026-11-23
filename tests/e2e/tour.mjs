// Visual tour: screenshots of key surfaces in dark mode.
import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.SHOTS;
const WORK = process.env.WORK;
rmSync(WORK, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const app = await electron.launch({ args: ['.'], env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'dark' }));
await win.emulateMedia({ colorScheme: 'dark' });
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 60000 });
await win.waitForTimeout(1200);
const shot = (n) => win.screenshot({ path: join(OUT, n) });
await shot('30-dark-editor.png');

// Select a services card title (part in a repeated item)
await win.locator('.rail [aria-label="Layers"]').click();
const gridRow = win.locator('.list-item', { hasText: 'Services grid' });
await gridRow.locator('.tree-toggle').click();
await win.locator('.list-item', { hasText: 'Card title' }).click();
await win.waitForTimeout(800);
await shot('31-dark-part.png');

// Edit definition flow
await gridRow.click();
await win.waitForTimeout(300);
await win.locator('.section-head', { hasText: 'Component' }).click();
await win.getByRole('button', { name: 'Edit definition' }).click();
await win.waitForTimeout(300);
await shot('32-edit-definition.png');
await win.getByRole('button', { name: /Create project copy and edit/ }).click();
await win.waitForTimeout(1500);
await win.locator('.list-item', { hasText: 'Services grid' }).locator('.tree-toggle').click().catch(() => {});
await win.locator('.list-item', { hasText: 'Card' }).first().click().catch(() => {});
await win.waitForTimeout(800);
await shot('33-definition-mode.png');
await win.getByRole('button', { name: 'Done' }).click();

// Settings, export, command menu, source
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('button', { name: 'AI assistant' }).click();
await win.waitForTimeout(300);
await shot('34-settings.png');
await win.keyboard.press('Escape');
await win.keyboard.press('Meta+K');
await win.keyboard.type('fa');
await win.waitForTimeout(300);
await shot('35-cmdk.png');
await win.keyboard.press('Escape');
await win.getByRole('button', { name: 'Export', exact: true }).click();
await win.waitForTimeout(300);
await shot('36-export.png');
await win.keyboard.press('Escape');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'light' }));
await win.emulateMedia({ colorScheme: 'light' });
await win.waitForTimeout(300);
await frame.locator('h1').first().click();
await win.waitForTimeout(300);
if (!(await win.getByRole('button', { name: 'View source' }).isVisible())) await win.locator('.section-head', { hasText: 'Component' }).click();
await win.getByRole('button', { name: 'View source' }).click();
await win.waitForTimeout(500);
await shot('37-source.png');
await app.close();
