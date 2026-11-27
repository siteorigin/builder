// Design capture for the AI conversations manager (Earlier conversations → Find, rename or delete…), in every state
// that carries design weight. Opt-in only, never part of `npm run test:e2e`, and it never calls a provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/conversations.mjs
//
// Conversations from the last year are seeded through the project's own chat storage before the project opens, so
// the manager lists exactly what it would for a project worked on that long. The AI at work is pushed through the
// agent's own `ai:event` channel, and a read-only opening through the channel the project reports its snapshot on.
// Each capture checks its state is on screen and throws rather than write an image of anything else. Files are
// `{state}--{theme}.png`, cropped to the dialog with a margin of the window; `context` is the whole window.
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('conversations capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'conversations');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-conversations');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const manager = win.getByRole('dialog', { name: 'AI conversations' });

/** The dialog with a margin of the window around it, so its edge and shadow read. */
async function clip() {
  const box = await win.locator('.modal').last().boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 48)), height: Math.min(size.height - y, Math.ceil(box.height + 48)) };
}

/** Capture the manager in each theme; `check` must be visible inside it. `hover` keeps the pointer where it is. */
async function shot(state, check, { themes = BOTH, full = false, hover = false } = {}) {
  await manager.waitFor({ timeout: 30000 });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!hover) await win.mouse.move(4, 4);
    await pause(280);
    const target = typeof check === 'string' ? manager.locator(check).first() : check;
    if (!(await target.isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): ${check} is not on screen; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await clip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

// ---- A real project, then a year of conversations in its chat storage ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const projectDir = (await win.evaluate(() => window.builder.project.snapshot())).dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

const now = new Date();
/** A time `days` back from today at `hour:minute`, local, so the day headings fall where a reader expects. */
const at = (days, hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour, minute).toISOString();
let n = 0;
/** A conversation whose requests were sent at `when`, one assistant reply after each. */
function conversation(id, requests, when, extra = {}) {
  const messages = [];
  requests.forEach((text, i) => {
    const time = new Date(new Date(when).getTime() - (requests.length - 1 - i) * 6 * 60e3).toISOString();
    const runId = `r_cap${++n}`;
    messages.push({ id: `m_u${n}`, role: 'user', text, time, runId });
    messages.push({ id: `m_a${n}`, role: 'assistant', text: 'Done.', time, runId, result: { status: 'completed', summary: 'Done.', changes: [], validation: [], canUndo: false } });
  });
  return { id, title: extra.title ?? requests[0].slice(0, 60), createdAt: messages[0].time, messages, ...(extra.named ? { named: true } : {}) };
}
const SEED = [
  conversation('c_hero', ['Rewrite the home page hero to sound warmer and more confident', 'Make the button say “Book a consultation” instead', 'Now tighten the intro to one sentence'], at(0, 14, 40), { title: 'Home page hero, warmer', named: true }),
  conversation('c_faq', ['Add an FAQ section to the Services page with five questions about parking, bookings and cancellations'], at(0, 11, 5)),
  conversation('c_brand', ['Make the brand colour a deeper terracotta and check every button still reads'], at(0, 9, 12)),
  conversation('c_pricing', ['Build out a Pricing page with three tiers, a comparison table and an FAQ about refunds', 'Continue'], at(1, 16, 30)),
  conversation('c_phone', ['Where do I change the phone number in the footer?'], at(1, 10, 2)),
  conversation(
    'c_long',
    [
      'Tidy the home page: the testimonials and the gallery both feel crowded on a laptop screen, and the section spacing is uneven between the hero, the services grid and the contact strip at the bottom'
    ],
    at(3, 15, 20),
    { title: 'Tidy the home page spacing so the testimonials, gallery and services grid breathe on a laptop', named: true }
  ),
  conversation('c_about', ['Write an About page for the studio: founded in 2014 by Marama Tuhoe, two architects and a joiner'], at(5, 13, 45)),
  conversation('c_alt', ['Add alt text to the gallery images'], at(12, 9, 30)),
  conversation('c_contact', ['Interview me about the Contact page'], at(40, 17, 0)),
  conversation('c_launch', ['Plan the spring launch: a banner, a news post and a booking form for open days'], at(400, 10, 0))
];
const chatDir = join(projectDir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
for (const c of SEED) writeFileSync(join(chatDir, `${c.id}.json`), JSON.stringify(c));

await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 90000 });
await pause(1000);
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await pause(400);

const openManager = async () => {
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await win.getByRole('menuitem', { name: 'Find, rename or delete…' }).click();
  await manager.waitFor();
  await pause(400);
};
const close = async () => {
  await win.keyboard.press('Escape');
  await manager.waitFor({ state: 'detached' });
  await pause(150);
};
const search = () => manager.getByRole('searchbox', { name: 'Find a conversation' });
const find = async (text) => {
  await search().fill(text);
  await pause(250);
};
const row = (id) => manager.locator(`li[data-conversation-id="${id}"]`);
/** Push an agent event through the main process, exactly as a real run does. */
const emit = (e) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const showSnapshot = (s) => app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.send('project:changed', { seq: 0, base: null, revision: next.revision, snapshot: next }), s);

// ---- Populated, the newest conversation open ----
await openManager();
await shot('populated', '[data-conversation-id="c_hero"]');
await shot('context', '[data-conversation-id="c_hero"]', { full: true, themes: ['light'] });
// Scrolled to the oldest.
await row('c_launch').scrollIntoViewIfNeeded();
await pause(200);
await shot('scrolled', '[data-conversation-id="c_launch"]', { themes: ['light'] });
// Keyboard: from the find box into the list, then down two rows.
await search().focus();
await win.keyboard.press('Tab');
await win.keyboard.press('ArrowDown');
await win.keyboard.press('ArrowDown');
await pause(150);
await shot('keyboard', ':focus-visible', { themes: ['light'] });
// The pointer on Delete.
const del = row('c_brand').getByRole('button', { name: /^Delete/ });
await del.hover();
await shot('delete-hover', del, { hover: true, themes: ['light'] });

// ---- Finding ----
// The open conversation matched by its name: the match must read on that row too.
await find('hero');
await shot('find-title', '[data-conversation-id="c_hero"] mark');
await find('parking');
await shot('find-request', '[data-testid="conversation-match"] mark');
await find('wallpaper');
await shot('find-none', '.empty-insp');
await find('');

// ---- Renaming, then a name that is too long ----
await row('c_faq').getByRole('button', { name: /^Rename/ }).click();
await pause(200);
await shot('renaming', '.conversation-rename');
await row('c_faq').getByRole('textbox').fill('Services FAQ: parking, bookings, cancellations, deposits, accessibility, dogs, gift vouchers and the rest');
await pause(150);
await shot('rename-too-long', '.conversation-error', { themes: ['light'] });
await win.keyboard.press('Escape');
await pause(150);
await close();

// ---- A conversation that can't be opened: its file went missing after the list was read ----
await openManager();
rmSync(join(chatDir, 'c_phone.json'));
await row('c_phone').getByRole('button', { name: /^Open/ }).click();
await manager.locator('[role="alert"]').waitFor({ timeout: 10000 });
await shot('open-failed', '[role="alert"]');
await close();

// ---- Read-only ----
const real = await snapshot();
await openManager();
await showSnapshot({ ...real, readOnly: { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true } });
await pause(300);
await shot('read-only', '[data-conversation-id="c_hero"]');
await showSnapshot(real);
await pause(300);

// ---- The AI at work: pushed through the agent's own channel, for the conversation on screen ----
const convId = (await win.evaluate(() => window.builder.ai.conversations())).active.id;
await emit({ runId: 'r_capture', conversationId: convId, kind: 'status', status: 'running' });
await pause(300);
await shot('ai-running', '[data-conversation-id="c_hero"]');
await emit({ runId: 'r_capture', conversationId: convId, kind: 'status', status: 'failed' });
await pause(200);
await close();

if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const path of written) if (!files.includes(path.slice(OUT.length + 1))) throw new Error(`missing ${path}`);
console.log(`conversations capture: ${written.length} images in ${OUT}`);
await app.close();
cleanup();
