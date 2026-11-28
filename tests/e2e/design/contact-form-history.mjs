// Design capture for the exported Contact form across the tab's history: a visitor sends a message, follows one of
// the site's own links while it is still sending, and comes back with Back after the form service has answered (or
// before it has). Opt-in only, never part of `npm run test:e2e`:
//
//   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/contact-form-history.mjs
//
// It needs no app build: export-forms-search-site.ts generates the site from the catalogue as it stands, the site's
// own tools are installed once into a folder under the OS temp folder, and the site runs on its development server,
// so leaving and coming back go through SvelteKit's real router and snapshots. Nothing is ever delivered: the forms
// send to a .test address, which this script holds and answers itself.
//
// Each capture is checked after it settles (the page it should be on, the reply the service gave), and a state that
// did not get there throws instead of writing a plausible-looking wrong image. What each form held when it was
// captured goes to observations.json beside the images. Files are named `{state}--{tone or width}.png`.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('contact form history capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });

const ROOT = resolve(import.meta.dirname, '../../..');
// Its own folder and port, so it can run beside export-forms-search.mjs. Resolved, because Vite fails to import
// through a symlinked project path (macOS tmpdir is one).
const SITE = join(realpathSync(tmpdir()), 'so-design-contact-history-site');
const PORT = 5393;
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
const observations = {};

const WIDTHS = { desktop: 1280, phone: 390 };

/**
 * A fresh tab on a page of the site. Every form request is held until the scenario answers it with `reply(status)`,
 * oldest first, and every answer given is kept in `answered`.
 */
async function open(path, width = WIDTHS.desktop) {
  // Tall enough that each section fits whole, so a capture never scrolls under the sticky header.
  const context = await browser.newContext({ viewport: { width, height: 1600 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e}`));
  const held = [];
  const answered = [];
  const arrivals = [];
  await page.route('https://forms.harbour-lane.test/**', (route) => {
    held.push(route);
    arrivals.splice(0).forEach((r) => r());
  });
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  await ready(page);
  const reply = async (status) => {
    if (!held.length) {
      // A form that refused to send (an empty required field) never asks; that is a failure here, not a wait.
      const arrived = await new Promise((r) => {
        const timer = setTimeout(() => r(false), 5000);
        arrivals.push(() => (clearTimeout(timer), r(true)));
      });
      if (!arrived) throw new Error(`${path}: no message reached the form service to answer`);
    }
    const route = held.shift();
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: status < 400 }) });
    answered.push(status);
    // The form's own handler runs once the reply has been read.
    await page.waitForTimeout(300);
  };
  const posted = async () => {
    for (let i = 0; i < 40 && !held.length; i++) await page.waitForTimeout(50);
    if (!held.length) throw new Error(`${path}: no message reached the form service`);
  };
  return { page, reply, posted, answered, context };
}

async function ready(page) {
  // The page's scripts have started when <html> takes so-js and the form's handler is attached.
  await page.waitForFunction(() => document.documentElement.classList.contains('so-js'));
  // The header stays where it is, so a section scrolled into view is never drawn under it.
  await page.addStyleTag({ content: '.so-header--sticky { position: static !important; }' });
  await page.waitForTimeout(300);
  await page.mouse.move(1, 1);
}

/** What a form holds: each text answer, the ticked choice and the checkbox, the alert and the status line. */
async function holding(section) {
  return section.evaluate((el) => {
    const form = el.querySelector('form');
    const text = [...form.querySelectorAll('input[type=text], input[type=email], input[type=tel], textarea')].map((c) => c.value);
    const choice = form.querySelector('input[type=radio]:checked')?.value ?? null;
    const box = form.querySelector('input[type=checkbox]:not(.so-form__bait)')?.checked ?? null;
    const alert = el.querySelector('[role=alert]')?.textContent.trim() ?? '';
    const status = el.querySelector('[role=status]')?.textContent.trim() ?? '';
    // The draft keeper's note after a form it gave a message back to, and the site-wide region that reads it out.
    const note = el.querySelector('.so-draft-note')?.textContent.trim() ?? '';
    const announced = document.querySelector('.so-draft-announce')?.textContent.trim() ?? '';
    return { text, choice, box, alert, status, note, announced, busy: form.getAttribute('aria-busy') };
  });
}

/** Capture one element once `check()` is true of the page; record what its form holds. */
async function shot(name, target, check, why) {
  await target.page().waitForTimeout(250);
  if (!(await check())) throw new Error(`state "${name}" did not get there (${why}); refusing to write`);
  if (!(await target.isVisible())) throw new Error(`state "${name}" has nothing to capture`);
  const path = join(OUT, `${name}.png`);
  await target.screenshot({ path, animations: 'disabled', caret: 'hide' });
  if (await target.locator('form').count()) observations[name] = await holding(target);
  written.push(path);
  console.log('wrote', path);
}

async function fill(form, phone = true) {
  await form.getByLabel('Name').fill('Aroha Ngata');
  await form.getByLabel('Email').fill('aroha@example.com');
  if (phone) await form.getByLabel('Phone').fill('021 555 0142');
  await form.getByLabel('Built-in joinery').check();
  await form.getByLabel('Message').fill('We are after floor-to-ceiling shelves either side of a fireplace, in oak if possible. The room is in a 1920s villa.');
  await form.getByLabel('Send me the occasional studio newsletter').check();
}

/** Follows the site's own Home link (in the footer, which every width shows), as a visitor leaving the form would. */
async function leave(page) {
  await page.getByRole('contentinfo').getByRole('link', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await page.waitForTimeout(300);
}

/** Browser Back, to the page with the form; resolves once SvelteKit has put the page back and handed its snapshot over. */
async function back(page, path) {
  await page.goBack();
  await page.waitForURL(ORIGIN + path);
  await ready(page);
  await page.waitForTimeout(300);
}

const onPage = (page, path) => async () => new URL(page.url()).pathname === path;

/**
 * Send, leave while it sends, let the service answer `status` (or not yet, for 'pending'), and come back with Back.
 * Captures the form as the visitor finds it on their return, under `name`.
 */
async function leaveWhileSending({ path = '/form-default/', width = WIDTHS.desktop, status, name, sending, then }) {
  const { page, reply, posted, answered, context } = await open(path, width);
  const section = page.locator('main .so-form').first();
  await fill(section.locator('form'));
  await section.getByRole('button', { name: /Send/ }).click();
  await posted();
  if (sending) await shot(sending, section, async () => (await section.locator('form').getAttribute('aria-busy')) === 'true', 'the form is sending');
  await leave(page);
  if (status !== 'pending') await reply(status);
  await back(page, path);
  const returned = page.locator('main .so-form').first();
  await shot(name, returned, async () => (await onPage(page, path)()) && answered.join() === (status === 'pending' ? '' : String(status)), `back on ${path} after ${status}`);
  if (then) await then({ page, reply, section: returned, answered });
  await context.close();
}

// ---- The issue: a failure that lands while the visitor is on another page ----
await leaveWhileSending({ status: 503, name: 'back-after-failure--default', sending: 'sending--default' });
await leaveWhileSending({ path: '/form-inverse/', status: 503, name: 'back-after-failure--inverse' });
await leaveWhileSending({ width: WIDTHS.phone, status: 503, name: 'back-after-failure--phone' });

// ---- Sent while away: the message stays retired ----
await leaveWhileSending({
  status: 200,
  name: 'back-after-sent--default',
  then: async ({ page }) => {
    // Away and Back to the same entry again: it still says the message went.
    await leave(page);
    await back(page, '/form-default/');
    const again = page.locator('main .so-form').first();
    await shot('back-after-sent-again--default', again, async () => (await onPage(page, '/form-default/')()) && (await again.locator('.so-draft-note').count()) === 1, 'the receipt came back');
  }
});

// ---- Back before the service has answered, then the answer arrives ----
await leaveWhileSending({
  status: 'pending',
  name: 'back-while-sending--default',
  then: async ({ page, reply, section, answered }) => {
    await reply(503);
    await shot('back-while-sending-then-failed--default', section, async () => answered.join() === '503', 'the held reply failed after returning');
    void page;
  }
});

await leaveWhileSending({
  status: 'pending',
  name: 'back-while-sending-2--default',
  then: async ({ reply, section, answered }) => {
    await reply(200);
    await shot('back-while-sending-then-sent--default', section, async () => answered.join() === '200', 'the held reply went after returning');
  }
});

await leaveWhileSending({
  status: 'pending',
  name: 'back-while-sending-3--default',
  then: async ({ reply, section, answered }) => {
    // Changed before the reply: a message of its own, which the first one going never empties or calls sent.
    await section.locator('form').getByLabel('Message').fill('We are after floor-to-ceiling shelves either side of a fireplace, in oak if possible. The room is in a 1920s villa, and we would like it fitted before winter.');
    await reply(200);
    await shot('back-while-sending-edited-then-sent--default', section, async () => answered.join() === '200', 'the held reply went after the visitor changed the copy');
  }
});

// ---- Sending again from the form the visitor came back to ----
await leaveWhileSending({
  status: 503,
  name: 'retry-from-returned--before',
  then: async ({ reply, section, answered }) => {
    // A form that came back empty has nothing to send again: that is the defect itself, recorded rather than captured.
    if (!(await section.locator('form').getByLabel('Message').inputValue())) {
      observations['retry-from-returned--sent'] = 'not captured: the form came back empty, so there was nothing to send again';
      console.log('skipped retry-from-returned--sent: the form came back empty');
      return;
    }
    await section.getByRole('button', { name: /Send/ }).click();
    await reply(200);
    await shot('retry-from-returned--sent', section, async () => answered.join() === '503,200' && /\S/.test(await section.locator('[role=status]').innerText()), 'the retry was sent');
  }
});

// ---- Control: staying on the page through the same failure ----
{
  const { page, reply, posted, answered, context } = await open('/form-default/');
  const section = page.locator('main .so-form').first();
  await fill(section.locator('form'));
  await section.getByRole('button', { name: /Send/ }).click();
  await posted();
  await reply(503);
  await shot('stay-failure--default', section, async () => answered.join() === '503' && /\S/.test(await section.locator('[role=alert]').innerText()), 'the alert shows');
  await context.close();
}

// ---- The Signup card keeps drafts the same way ----
{
  const path = '/signup/';
  const { page, reply, posted, answered, context } = await open(path);
  const split = () => page.locator('main > *').filter({ has: page.locator('.so-form') }).first();
  await split().scrollIntoViewIfNeeded();
  const card = split().locator('.so-form');
  await card.getByLabel('Email').fill('aroha@example.com');
  await card.getByRole('button').click();
  await posted();
  await leave(page);
  await reply(503);
  await back(page, path);
  await split().scrollIntoViewIfNeeded();
  await shot('signup-back-after-failure--default', split(), async () => (await onPage(page, path)()) && answered.join() === '503', 'back on the signup page after 503');
  await context.close();
}

await browser.close();
stop();
writeFileSync(join(OUT, 'observations.json'), JSON.stringify(observations, null, 2));
const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`wrote ${written.length} captures (${count} PNGs in ${OUT})`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (count < written.length) throw new Error('fewer files on disk than captures written');
