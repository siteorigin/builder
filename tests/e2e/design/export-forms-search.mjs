// Design capture for the exported site's forms and search: the Contact form, the Signup form card and Site search,
// in each tone, at rest and through sending, sent, failed, invalid and results. Opt-in only, never part of
// `npm run test:e2e`:
//
//   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/export-forms-search.mjs
//
// It needs no app build: export-forms-search-site.ts generates the site from the catalogue as it stands, the site's
// own tools are installed once into a folder under the OS temp folder, and the site runs on its development server.
// Nothing is ever delivered: the forms send to a .test address, which this script answers itself.
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{tone or width}.png`.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('forms and search capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });

const ROOT = resolve(import.meta.dirname, '../../..');
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const SITE = join(realpathSync(tmpdir()), 'so-design-export-forms-site');
const ENDPOINT = 'https://forms.harbour-lane.test/f/studio';
const PORT = 5391;
const ORIGIN = `http://localhost:${PORT}`;

// The site's tools are kept between runs; everything else is generated afresh.
const tools = existsSync(join(SITE, 'node_modules', '@sveltejs', 'kit', 'package.json'));
if (existsSync(SITE)) for (const name of readdirSync(SITE)) if (name !== 'node_modules') rmSync(join(SITE, name), { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
cpSync(join(ROOT, 'templates/sveltekit-brochure/files'), SITE, { recursive: true });
const gen = spawnSync('npx', ['tsx', '--tsconfig', 'tsconfig.node.json', 'tests/e2e/design/export-forms-search-site.ts', SITE], { cwd: ROOT, stdio: 'inherit' });
if (gen.status !== 0) throw new Error('the site did not generate');
if (!tools) {
  const ci = spawnSync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: SITE, stdio: 'inherit' });
  if (ci.status !== 0) throw new Error('the site tools did not install');
}

const server = spawn(join(SITE, 'node_modules/.bin/vite'), ['dev', '--port', String(PORT), '--strictPort'], { cwd: SITE, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stop = () => server.exitCode === null && server.kill();
process.on('exit', stop);
for (let i = 0; ; i++) {
  if (server.exitCode !== null) throw new Error(`the site's server stopped:\n${serverLog}`);
  if (await fetch(ORIGIN).then((r) => r.ok, () => false)) break;
  if (i > 240) throw new Error(`the site's server never answered:\n${serverLog}`);
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const written = [];
const errors = [];

/** How the next form request is answered: held until released, sent, or refused. */
let answer = 'ok';
let release = () => {};

async function open(path, width = 1280) {
  // Tall enough that each section fits whole, so a capture never scrolls under the sticky header.
  const context = await browser.newContext({ viewport: { width, height: 1600 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e}`));
  await page.route('https://forms.harbour-lane.test/**', async (route) => {
    if (answer === 'hold') await new Promise((r) => (release = r));
    if (answer === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  // The page's scripts have started when <html> takes so-js and the form's handler is attached.
  await page.waitForFunction(() => document.documentElement.classList.contains('so-js'));
  // The header stays where it is, so a section scrolled into view is never drawn under it.
  await page.addStyleTag({ content: '.so-header--sticky { position: static !important; }' });
  await page.waitForTimeout(400);
  await page.mouse.move(1, 1);
  return page;
}

/** Capture one element once `check` (a locator) is visible inside it. */
async function shot(name, target, check) {
  await target.page().waitForTimeout(250);
  if (check && !(await check.first().isVisible().catch(() => false))) throw new Error(`state "${name}" did not render its check; refusing to write`);
  if (!(await target.isVisible())) throw new Error(`state "${name}" has nothing to capture`);
  const path = join(OUT, `${name}.png`);
  await target.screenshot({ path, animations: 'disabled', caret: 'hide' });
  written.push(path);
  console.log('wrote', path);
}

async function fill(form) {
  await form.getByLabel('Name').fill('Aroha Ngata');
  await form.getByLabel('Email').fill('aroha@example.com');
  await form.getByLabel('Phone').fill('021 555 0142');
  await form.getByLabel('Built-in joinery').check();
  await form.getByLabel('Message').fill('We are after floor-to-ceiling shelves either side of a fireplace, in oak if possible. The room is in a 1920s villa.');
}

// ---- Contact form ----
for (const tone of ['default', 'muted', 'inverse']) {
  const page = await open(`/form-${tone}/`);
  const section = page.locator('.so-form').first();
  const form = section.locator('form');
  await shot(`contact-rest--${tone}`, section, form.getByLabel('Message'));
  if (tone === 'default') {
    // Hover on a field and focus in another.
    await form.getByLabel('Email').hover();
    await form.getByLabel('Name').focus();
    await shot('contact-focus--default', section, form.getByLabel('Name'));
    await page.mouse.move(1, 1);
  }
  // Sent with nothing filled in: the browser stops it, and the form shows what is missing.
  await form.getByLabel('Email').fill('aroha@');
  await form.getByLabel('Email').blur();
  await section.getByRole('button', { name: /Send/ }).click();
  await page.waitForTimeout(300);
  await shot(`contact-invalid--${tone}`, section, form.getByLabel('Name'));
  await fill(form);
  if (tone === 'default') {
    answer = 'hold';
    await section.getByRole('button', { name: /Send/ }).click();
    await shot('contact-sending--default', section, section.locator('[aria-busy="true"]'));
    answer = 'ok';
    release();
    await page.waitForTimeout(400);
    await shot('contact-sent--default', section, section.locator('[role="status"]').filter({ hasText: /\S/ }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.classList.contains('so-js'));
    await fill(form);
  }
  answer = 'fail';
  await section.getByRole('button', { name: /Send/ }).click();
  await page.waitForTimeout(400);
  await shot(`contact-failed--${tone}`, section, section.locator('[role="alert"]').filter({ hasText: /\S/ }));
  answer = 'ok';
  await page.context().close();
}
{
  const page = await open('/form-offline/');
  const section = page.locator('.so-form').first();
  await shot('contact-offline--default', section, section.getByRole('button', { name: /Send/ }));
  await page.context().close();
}
{
  const page = await open('/form-default/', 390);
  const section = page.locator('.so-form').first();
  await shot('contact-rest--phone', section, section.getByLabel('Message'));
  await fill(section.locator('form'));
  answer = 'ok';
  await section.getByRole('button', { name: /Send/ }).click();
  await page.waitForTimeout(400);
  await shot('contact-sent--phone', section, section.locator('[role="status"]').filter({ hasText: /\S/ }));
  await page.context().close();
}

// ---- Signup card ----
{
  const page = await open('/signup/');
  const tones = ['default', 'muted', 'inverse'];
  for (const [i, tone] of tones.entries()) {
    const split = page.locator('main > *').filter({ has: page.locator('.so-form') }).nth(i);
    await split.scrollIntoViewIfNeeded();
    const card = split.locator('.so-form');
    await shot(`signup-rest--${tone}`, split, card.getByLabel('Email'));
    if (tone !== 'muted') {
      await card.getByLabel('Email').fill('aroha@');
      await card.getByRole('button').click();
      await page.waitForTimeout(300);
      await shot(`signup-invalid--${tone}`, split, card.getByLabel('Email'));
      await card.getByLabel('Email').fill('aroha@example.com');
      answer = 'fail';
      await card.getByRole('button').click();
      await page.waitForTimeout(400);
      await shot(`signup-failed--${tone}`, split, card.locator('[role="alert"]').filter({ hasText: /\S/ }));
      answer = 'ok';
      await card.getByLabel('Email').fill('aroha@example.com');
      await card.getByRole('button').click();
      await page.waitForTimeout(400);
      await shot(`signup-sent--${tone}`, split, card.locator('[role="status"]').filter({ hasText: /\S/ }));
    }
  }
  await page.context().close();
}

// ---- Site search ----
for (const tone of ['default', 'muted', 'inverse']) {
  const page = await open(`/search-${tone}/`);
  const section = page.locator('.so-search').first();
  const box = section.getByRole('searchbox');
  if (tone === 'default') {
    await shot('search-rest--default', section, box);
    await section.getByRole('button', { name: 'Search' }).click();
    await shot('search-empty--default', section, section.locator('[role="status"]').filter({ hasText: /\S/ }));
    await box.fill('walnut parquet');
    await box.press('Enter');
    await shot('search-none--default', section, section.locator('[role="status"]').filter({ hasText: /\S/ }));
  }
  await box.fill('oak');
  await box.press('Enter');
  await shot(`search-results--${tone}`, section, section.locator('.so-search__result'));
  await page.context().close();
}
{
  const page = await open('/search-default/', 390);
  const section = page.locator('.so-search').first();
  await section.getByRole('searchbox').fill('oak');
  await section.getByRole('searchbox').press('Enter');
  await shot('search-results--phone', section, section.locator('.so-search__result'));
  await page.context().close();
}
{
  // The index cannot be read: a search that fails.
  const page = await open('/search-default/');
  await page.route('**/*', (route) => (/site-search|search-index/.test(route.request().url()) ? route.abort() : route.fallback()));
  const section = page.locator('.so-search').first();
  await section.getByRole('searchbox').fill('oak');
  await section.getByRole('searchbox').press('Enter');
  await page.waitForTimeout(500);
  await shot('search-failed--default', section, section.locator('[role="status"]').filter({ hasText: /\S/ }));
  await page.context().close();
}

await browser.close();
stop();
const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`wrote ${written.length} captures (${count} PNGs in ${OUT})`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (count < written.length) throw new Error('fewer files on disk than captures written');
