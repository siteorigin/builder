// Real-provider smoke test for the agent. It uses OPENAI_API_KEY from the environment (development builds
// only) and costs money, so it is never part of `npm run test:e2e`. ONLY=targeted or ONLY=multi runs one half.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

if (!process.env.OPENAI_API_KEY) throw new Error('ai.mjs needs OPENAI_API_KEY in the environment; it calls the real provider.');
const ONLY = process.env.ONLY ?? 'both';
const { WORK, SHOTS: OUT, cleanup } = scratch('ai');
const { app, win, errors } = await launch(WORK, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await win.waitForTimeout(1000);

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const chipLabel = async () => ((await win.locator('.ov-chip .label').count()) ? win.locator('.ov-chip .label').first().innerText() : null);

/** Send a prompt; `whileRunning` runs once the reply is streaming. Resolves with the finished result card. */
async function runChat(prompt, shot, whileRunning) {
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  const before = await win.locator('.result-card').count();
  await win.fill('.composer textarea', prompt);
  const t0 = Date.now();
  await win.keyboard.press('Enter');
  if (whileRunning) {
    await win.locator('.msg-ai[aria-busy="true"]').waitFor({ timeout: 30000 });
    await whileRunning();
  }
  await eventually(async () => assert.ok((await win.locator('.result-card').count()) > before, 'the run finishes with a result card'), 300000, 500);
  await win.waitForTimeout(1500);
  const card = win.locator('.result-card').last();
  const status = (await card.getAttribute('class')).replace('result-card', '').trim();
  const text = await win.locator('.msg-ai').last().innerText();
  console.log(`--- ${prompt}\n(${Math.round((Date.now() - t0) / 1000)}s, ${status})\n${text}\n`);
  await win.screenshot({ path: join(OUT, shot) });
  return status;
}

if (ONLY !== 'multi') {
  step('A01: a targeted edit changes only the element selected when it was sent');
  const h1 = frame.locator('h1').first();
  const oldHeading = await h1.innerText();
  await h1.click();
  await win.waitForTimeout(300);
  await h1.click();
  await eventually(async () => assert.match((await chipLabel()) ?? '', /heading/i, 'the hero heading is selected'));
  const s0 = await snapshot();
  const home = s0.state.pages[s0.state.site.homePageId];
  const heroId = home.rootIds[0];
  const status = await runChat('Make this headline shorter and more confident.', '20-ai-targeted.png', async () => {
    // While the reply streams: clear the selection, then select a different section.
    for (let i = 0; i < 3 && (await chipLabel()) !== null; i++) await frame.locator('body').press('Escape');
    await eventually(async () => assert.equal(await chipLabel(), null, 'the selection is cleared while the run streams'));
    await frame.getByText('Everything your project needs', { exact: false }).first().click();
    await eventually(async () => assert.equal(await chipLabel(), 'Services grid', 'another section is selected while the run streams'));
    // The live model can finish quickly; if this fails, the run ended before the selection changed and the
    // A01 comparison below would prove nothing.
    assert.ok((await win.locator('.msg-ai[aria-busy="true"]').count()) > 0, 'the run is still going after the selection changed');
  });
  assert.equal(status, 'completed', 'the targeted run completes');
  const newHeading = await frame.locator('h1').first().innerText();
  console.log('h1 now:', newHeading);
  assert.notEqual(newHeading, oldHeading, 'the originally selected heading changed');
  const s1 = await snapshot();
  // The selected Heading part is bound to the hero's `heading` prop; everything else must be untouched.
  const others = (s) => {
    const state = structuredClone(s.state);
    delete state.pages[state.site.homePageId].nodes[heroId].props.heading;
    return state;
  };
  assert.notDeepEqual(s1.state.pages[s1.state.site.homePageId].nodes[heroId].props.heading, s0.state.pages[s0.state.site.homePageId].nodes[heroId].props.heading, 'the hero heading prop changed');
  assert.deepEqual(others(s1), others(s0), 'nothing but the originally selected heading changed');
  for (let i = 0; i < 3 && (await chipLabel()) !== null; i++) await frame.locator('body').press('Escape');
}

if (ONLY !== 'targeted') {
  step('A02: a multi-step request adds a page and updates shared navigation');
  const status = await runChat('Add a Services page with three service cards, link it from the header navigation, and add a contact call to action at the bottom.', '21-ai-multi.png');
  assert.equal(status, 'completed', 'the multi-step run completes');
  const s = await snapshot();
  const page = Object.values(s.state.pages).find((p) => /services/i.test(p.title));
  assert.ok(page, 'a Services page exists');
  const nav = frame.locator('header nav').first();
  console.log('nav:', (await nav.innerText()).replace(/\n/g, ' | '));
  const hrefs = await nav.locator('a').evaluateAll((as) => as.map((a) => new URL(a.href).pathname.replace(/\/$/, '') || '/'));
  assert.ok(hrefs.includes(page.route.replace(/\/$/, '') || '/'), `the header navigation links to ${page.route} (links: ${hrefs.join(', ')})`);
}

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nai: passed');
