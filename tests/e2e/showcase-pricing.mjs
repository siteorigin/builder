// The Tabbed showcase and Pricing with billing switch sections (#380) against the real app and its exported website.
// Both are inserted from Insert (Content, Conversion), the showcase given a fourth tab, which the canvas shows with the
// first tab chosen and only its panel showing. The exported site is then used at a 1280px desktop and a 390px phone: the
// showcase switched by pointer and keyboard, its tab row scrolling sideways on the phone; the billing switch changing
// every plan's price by pointer and keyboard; printed with every tab's panel and without the controls; read without
// JavaScript, which shows every tab's panel under its label and both periods' prices, without the tab row or the
// switch (#885). The website is opened in a headless browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { answerChoosers, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('showcase-pricing');
const { app, win, errors } = await launch(WORK);
let browser;
try {
  const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
  const snapshot = async () => (await win.evaluate(() => window.builder.project.snapshot())).state;
  const apply = async (operations, label) => {
    const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
    assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
    return r.results;
  };
  const s0 = await snapshot();
  const home = s0.site.homePageId;
  const owner = { kind: 'page', id: home };
  const placed = (s, componentId) => Object.values(s.pages[home].nodes).filter((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId);

  step('Insert offers the Tabbed showcase under Content and Pricing with billing switch under Conversion');
  await win.getByRole('button', { name: 'Insert', exact: true }).click();
  const tile = (group, name) =>
    win
      .locator('.side-panel-view:not([hidden]) .insert-group[data-kind="section"]', { has: win.locator('.insert-head', { hasText: new RegExp(`^${group}$`) }) })
      .locator('.insert-tile.section', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
  await tile('Content', 'Tabbed showcase').click();
  await eventually(async () => assert.equal(placed(await snapshot(), 'tabs.showcase').length, 1, 'one Tabbed showcase is on Home'));
  // The panel takes one insert at a time, and the project holds the first a moment before its save comes back (a
  // second or more on Windows): the next tile is clicked once the panel says the first one was added.
  await win.getByRole('button', { name: 'Undo adding Tabbed showcase' }).waitFor();
  await tile('Conversion', 'Pricing with billing switch').click();
  await eventually(async () => assert.equal(placed(await snapshot(), 'pricing.toggle').length, 1, 'one Pricing with billing switch is on Home'));
  const showcase = placed(await snapshot(), 'tabs.showcase')[0];
  await apply([{ type: 'instance.setProp', owner, nodeId: showcase.id, prop: 'tab4', value: { label: 'Support', heading: 'Help when you need it', copy: 'Call us any weekday.' } }], 'A fourth tab');

  step('the canvas shows the four tabs, the first one chosen and only its panel showing');
  const canvasList = frame.locator(`[data-so-ctx="page:${home}|${showcase.id}"][role="tablist"]`);
  await canvasList.waitFor({ timeout: 30000 });
  await eventually(async () => assert.deepEqual(await canvasList.getByRole('tab').allInnerTexts(), ['Design', 'Build', 'Care', 'Support'], 'the canvas shows four tabs'));
  assert.equal(await canvasList.getByRole('tab', { name: 'Design' }).getAttribute('aria-selected'), 'true', 'the first tab is chosen on the canvas');
  const canvasPanels = frame.locator(`[data-so-ctx="page:${home}|${showcase.id}"][role="tabpanel"]`);
  assert.equal(await canvasPanels.count(), 4, 'every tab’s panel is in the canvas page');
  assert.deepEqual(await canvasPanels.evaluateAll((ps) => ps.map((p) => p.checkVisibility())), [true, false, false, false], 'only the first panel shows');

  step('export the website');
  const exportsDir = join(WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
  const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
  assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
  assert.ok(stat.previewUrl, 'the export starts a preview');
  const url = stat.previewUrl;

  browser = await chromium.launch({ headless: true });
  const monthly = ['$29', '$49', '$119'];
  const annual = ['$290', '$490', '$1,190'];

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }]
  ]) {
    step(`${label}: the showcase switches by pointer and keyboard, the billing switch by pointer and keyboard`);
    const context = await browser.newContext({ viewport, hasTouch: label === 'phone', isMobile: label === 'phone' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Once the network is quiet the page's script has run and the server's markup is hydrated.
    await page.goto(url, { waitUntil: 'networkidle' });
    const list = page.getByRole('tablist', { name: 'From first sketch to finished room' });
    await list.waitFor();
    const chosen = () => list.locator('[role="tab"][aria-selected="true"]').innerText();
    const shownHeading = () => page.locator('[role="tabpanel"]').filter({ visible: true }).locator('h3').innerText();
    await eventually(async () => assert.equal(await list.getByRole('tab').count(), 4, 'four tabs'));
    assert.equal(await chosen(), 'Design');
    await list.getByRole('tab', { name: 'Build' }).click();
    await eventually(async () => assert.equal(await shownHeading(), 'One team from demolition to handover', 'clicking Build shows its panel'));
    for (const [key, to, heading] of [
      ['ArrowRight', 'Care', 'Looked after long after we leave'],
      ['End', 'Support', 'Help when you need it'],
      ['ArrowRight', 'Design', 'Plans drawn around how you live'],
      ['ArrowLeft', 'Support', 'Help when you need it'],
      ['Home', 'Design', 'Plans drawn around how you live']
    ]) {
      await page.keyboard.press(key);
      await eventually(async () => assert.equal(await chosen(), to, `${key} chooses ${to}`));
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), to, `${key} moves the focus to ${to}`);
      assert.equal(await shownHeading(), heading);
    }
    const row = await list.evaluate((el) => ({
      lines: new Set([...el.children].map((t) => Math.round(t.getBoundingClientRect().top))).size,
      scrolls: el.scrollWidth > el.clientWidth,
      overflow: document.documentElement.scrollWidth - innerWidth
    }));
    assert.equal(row.lines, 1, `${label}: the tabs sit on one line`);
    assert.equal(row.overflow, 0, `${label}: the page is no wider than the screen`);
    if (label === 'phone') assert.equal(row.scrolls, true, 'on a phone the tab row scrolls sideways');

    const group = page.getByRole('group', { name: 'Billing period' });
    const prices = () => page.locator('li p').filter({ visible: true }).locator('span').filter({ hasText: /^\$/ }).allInnerTexts();
    assert.deepEqual(await prices(), monthly, 'monthly prices show at first');
    await group.getByRole('button', { name: 'Annual' }).click();
    await eventually(async () => assert.deepEqual(await prices(), annual, 'Annual shows the annual prices'));
    assert.equal(await group.getByRole('button', { name: 'Annual' }).getAttribute('aria-pressed'), 'true');
    await group.getByRole('button', { name: 'Monthly' }).focus();
    await page.keyboard.press('Space');
    await eventually(async () => assert.deepEqual(await prices(), monthly, 'Space on Monthly brings the monthly prices back'));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await eventually(async () => assert.deepEqual(await prices(), annual, 'Enter on Annual shows the annual prices'));

    if (label === 'desktop') {
      step('print: every tab’s panel under its label, the plans as chosen, no tab row or billing switch');
      await page.emulateMedia({ media: 'print' });
      const printed = await page.evaluate(() => ({
        list: getComputedStyle(document.querySelector('[role="tablist"]')).display,
        labels: [...document.querySelectorAll('[role="tabpanel"]')].filter((p) => p.checkVisibility()).map((p) => getComputedStyle(p, '::before').content),
        group: getComputedStyle(document.querySelector('[role="group"]')).display
      }));
      assert.equal(printed.list, 'none', 'the tab row is left out of print');
      assert.deepEqual(printed.labels, ['"Design"', '"Build"', '"Care"', '"Support"'], 'every tab’s panel prints under its label');
      assert.equal(printed.group, 'none', 'the billing switch is left out of print');
      assert.deepEqual(await prices(), annual, 'the prices chosen print');
      await page.emulateMedia({ media: 'screen' });
    }
    assert.deepEqual(pageErrors, [], `${label}: no errors in the exported site`);
    await context.close();
  }

  step('without JavaScript every tab’s panel shows under its label, and both periods’ prices, with no tab row or switch');
  {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(url);
    const panels = page.locator('[role="tabpanel"]').filter({ visible: true });
    assert.equal(await panels.count(), 4, 'every panel shows');
    assert.deepEqual(await panels.locator('h3').allInnerTexts(), ['Plans drawn around how you live', 'One team from demolition to handover', 'Looked after long after we leave', 'Help when you need it']);
    const seen = await page.evaluate(() => ({
      list: getComputedStyle(document.querySelector('[role="tablist"]')).display,
      labels: [...document.querySelectorAll('[role="tabpanel"]')].map((p) => getComputedStyle(p, '::before').content),
      group: getComputedStyle(document.querySelector('[role="group"]')).display
    }));
    assert.equal(seen.list, 'none', 'the tab row, which would do nothing, is left out');
    assert.deepEqual(seen.labels, ['"Design"', '"Build"', '"Care"', '"Support"'], 'each panel shows under its tab’s label');
    assert.equal(seen.group, 'none', 'the billing switch, which would do nothing, is left out');
    const shown = await page.locator('li p').filter({ visible: true }).locator('span').filter({ hasText: /^\$/ }).allInnerTexts();
    assert.deepEqual(shown, monthly.flatMap((m, i) => [m, annual[i]]), 'every plan shows both periods’ prices');
    await context.close();
  }

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
  await browser.close();
  await app.close();
  cleanup();
  console.log('\nshowcase-pricing: passed');
} catch (e) {
  await browser?.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  throw e;
}
