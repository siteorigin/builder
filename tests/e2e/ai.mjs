// Real-provider smoke test for the agent (uses OPENAI_API_KEY from the environment in development builds).
import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.SHOTS;
const WORK = process.env.WORK;
const ONLY = process.env.ONLY ?? 'both';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const app = await electron.launch({ args: ['.'], env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), ANTHROPIC_API_KEY: '' } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 60000 });
await win.waitForTimeout(1000);

async function runChat(prompt, shot) {
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await win.fill('.composer textarea', prompt);
  const t0 = Date.now();
  await win.keyboard.press('Enter');
  await win.waitForSelector('.result-card', { timeout: 300000 });
  await win.waitForTimeout(1500);
  const last = await win.evaluate(() => {
    const cards = document.querySelectorAll('.msg-ai');
    return cards[cards.length - 1].innerText;
  });
  console.log(`--- ${prompt}\n(${Math.round((Date.now() - t0) / 1000)}s)\n${last}\n`);
  await win.screenshot({ path: join(OUT, shot) });
}

if (ONLY !== 'multi') {
  // Targeted edit: select the hero heading first.
  const h1 = frame.locator('h1').first();
  await h1.click();
  await win.waitForTimeout(300);
  await h1.click();
  await win.waitForTimeout(300);
  await runChat('Make this headline shorter and more confident.', '20-ai-targeted.png');
  console.log('h1 now:', await frame.locator('h1').first().innerText());
  // Selecting something else afterwards must not matter; clear selection for the next run.
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
}
if (ONLY !== 'targeted') {
  await win.evaluate(() => document.querySelectorAll('.msg-ai .result-card').forEach((e) => e.classList.remove('result-card')));
  await runChat('Add a Services page with three service cards, link it from the header navigation, and add a contact call to action at the bottom.', '21-ai-multi.png');
  const nav = await frame.locator('header nav').innerText();
  console.log('nav:', nav.replace(/\n/g, ' | '));
}
await app.close();
