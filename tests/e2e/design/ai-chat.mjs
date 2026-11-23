// Design capture harness for the AI panel (the right dock's AI tab). Opt-in only, never part of
// `npm run test:e2e`, and it never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/ai-chat.mjs
//
// Conversations are seeded through the project's own chat storage before the project opens, and a run in
// progress is pushed through the same `ai:event` channel the agent uses. The API key is a placeholder that
// is never sent anywhere, because no message is ever sent. Each capture is verified on screen after it
// settles; a state that did not render throws instead of writing an image. Files are `ai-{state}--{theme}.png`
// (the dock only, at the display's density), plus one full window for context.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('AI panel capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repository');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-ai-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const pause = (ms) => win.waitForTimeout(ms);
await win.waitForSelector('.welcome');
// Size the real window rather than emulating a viewport, so captures keep the display's own pixel density.
// The app opens maximized, so restore it first, and confirm the size took.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setContentSize(1440, 900);
});
await pause(600);
const size = await win.evaluate(() => [innerWidth, innerHeight]);
if (size[0] !== 1440 || size[1] !== 900) throw new Error(`window is ${size.join('x')}, expected 1440x900`);
const frame = win.frameLocator('.frame-box iframe');
const written = [];

await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Capture the dock in each theme; `check` must be visible inside it at the moment of capture. */
async function shot(state, check, { themes = THEMES, full = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(700, 450);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `ai-${state}--${theme}.png`);
    if (full) await win.screenshot({ path });
    else await win.locator('.dock').screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

/** Push an agent event through the main process, exactly as a real run does. */
async function emit(e) {
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
  await pause(120);
}

const openAiTab = async () => {
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await pause(300);
};

// ---- A project to work in ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);

// No provider connected.
await openAiTab();
await shot('no-provider', '.chat-empty');

const snap = await win.evaluate(() => window.builder.project.snapshot());
const pages = Object.values(snap.state.pages);
const home = snap.state.pages[snap.state.site.homePageId];
const byTitle = (t) => pages.find((p) => p.title === t) ?? home;
const about = byTitle('About');
const contact = byTitle('Contact');
const [{ dir: projectDir }] = await win.evaluate(() => window.builder.projects.recents());
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

// ---- Seed conversation history through the project's own chat storage ----
const t = (min) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();
const ctx = (page, selectionLabel = null) => ({ pageId: page.id, pageTitle: page.title, selection: null, selectionLabel, viewport: 1280 });
const done = (id, label) => ({ id, label, status: 'done' });
let n = 0;
const turn = (user, page, sel, assistant) => {
  const runId = `r_seed${++n}`;
  return [
    { id: `m_u${n}`, role: 'user', text: user, time: t(n * 3), context: ctx(page, sel), runId },
    { id: `m_a${n}`, role: 'assistant', text: assistant.result?.summary ?? '', time: t(n * 3 + 1), runId, ...assistant }
  ];
};
const result = (status, summary, extra = {}) => ({ result: { status, summary, changes: [], validation: [], canUndo: false, ...extra } });

const heroConversation = {
  id: 'c_seedhero',
  title: 'Rewrite the home page hero to sound warmer and more confident',
  createdAt: t(50),
  messages: [
    ...turn('Rewrite the home page hero to sound warmer and more confident', home, 'Split hero', {
      activities: [done('a1', `Reading ${home.title}`), done('a2', 'Inspecting the selected element'), done('a3', 'Updating content'), done('a4', 'Checking the result')],
      ...result('completed', 'I rewrote the hero so it speaks directly to homeowners. The heading now leads with **what they get**, and the intro is one sentence shorter.', {
        changes: [
          { label: `Edited Heading content on ${home.title}`, pageId: home.id },
          { label: `Edited Intro content on ${home.title}`, pageId: home.id }
        ],
        validation: ['Project structure, links and references are valid.', 'All components build without errors.'],
        canUndo: true
      })
    }),
    ...turn('Make the button say “Book a consultation” instead', home, 'Button', {
      activities: [done('a5', 'Inspecting the selected element'), done('a6', 'Updating content'), done('a7', 'Checking the result')],
      ...result('completed', 'Done. The hero button now reads “Book a consultation” and still links to the Contact page.', {
        changes: [{ label: `Edited Button content on ${home.title}`, pageId: home.id }],
        validation: ['Project structure, links and references are valid.', 'All components build without errors.'],
        canUndo: true
      })
    }),
    ...turn('Add a Services page with three service cards and link it from the header', home, null, {
      activities: [done('a8', 'Reading the project'), done('a9', 'Looking for card components'), done('a10', 'Adding Services page'), done('a11', 'Adding sections'), done('a12', 'Updating shared navigation'), done('a13', 'Checking Services at phone width'), done('a14', 'Checking the result')],
      ...result('completed', 'I added a **Services** page with a card grid for interior styling, renovation planning and colour consultations, and linked it from the header after About.', {
        changes: [
          { label: 'Added page “Services” (/services)', pageId: about.id },
          { label: 'Added Card grid to Services', pageId: about.id },
          { label: 'Updated the shared header navigation' }
        ],
        validation: ['Fits the screen at phone width.', 'Content is wider than the screen at tablet width.', 'Project structure, links and references are valid.', 'All components build without errors.'],
        canUndo: true
      })
    }),
    ...turn('Does the About page need anything else before launch?', about, null, {
      activities: [done('a15', `Reading ${about.title}`)],
      ...result('no-changes', 'It reads well. Two optional ideas: add a short line about your **service area**, and swap the second team photo for one taken on site. I have not changed anything.')
    })
  ]
};
n = 10;
const troubleConversation = {
  id: 'c_seedfaq',
  title: 'Add an FAQ section to the Contact page',
  createdAt: t(20),
  messages: [
    ...turn('Add an FAQ section to the Contact page', contact, null, {
      activities: [done('b1', `Reading ${contact.title}`), done('b2', 'Adding sections'), { id: 'b3', label: 'Checking the result', status: 'error', detail: 'FaqList.svelte: Unexpected token at line 14.' }, done('b4', 'Fixing a problem'), { id: 'b5', label: 'Checking the result', status: 'error', detail: 'FaqList.svelte: Unexpected token at line 14.' }],
      // A rolled-back run reports no changes: the project is back to how it was.
      ...result('failed', 'The changes introduced errors that could not be repaired. The project was restored to how it was before this request.', { error: 'FaqList.svelte: Unexpected token at line 14.' })
    }),
    ...turn('Try again with a simpler accordion', contact, null, {
      activities: [done('b6', `Reading ${contact.title}`), { id: 'b7', label: 'Adding sections', status: 'error' }],
      ...result('cancelled', 'Stopped.')
    }),
    ...turn('Add the FAQ as plain headings and paragraphs', contact, 'Contact form', {
      activities: [done('b8', 'Inspecting the selected element'), done('b9', 'Adding sections')],
      ...result('conflicted', 'I added the questions under the form. A file was changed outside the app, so the AI changes were kept for you to review.', {
        changes: [{ label: `Added Text to ${contact.title}`, pageId: contact.id }],
        error: 'conflict',
        canUndo: false
      })
    })
  ]
};
n = 20;
const colourConversation = {
  id: 'c_seedcolour',
  title: 'Make the brand colour a deep navy blue',
  createdAt: t(5),
  messages: turn('Make the brand colour a deep navy blue', home, null, {
    activities: [done('c1', 'Reading the project'), done('c2', 'Updating site styles'), done('c3', 'Checking the result')],
    ...result('completed', 'Your brand colour is now deep navy (#1f2f5c). Buttons, links and accents across every page use it.', {
      changes: [{ label: 'Updated site colour Brand' }],
      validation: ['Project structure, links and references are valid.', 'All components build without errors.'],
      canUndo: true
    })
  })
};
const chatDir = join(projectDir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
for (const c of [heroConversation, troubleConversation, colourConversation]) writeFileSync(join(chatDir, `${c.id}.json`), JSON.stringify(c));

// Connect a provider (a placeholder key; nothing is ever sent), then reload so the renderer reads providers
// through the same channel it uses on start, and reopen the project with its seeded history.
await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAiTab();

// The newest conversation opens with the project, scrolled to its latest turn.
await pause(400);
await shot('conversation', '.chat-log >> text=Does the About page need anything else');
await shot('conversation-window', '.chat-log >> text=Does the About page need anything else', { themes: ['light'], full: true });
await win.locator('.chat-log').evaluate((el) => (el.scrollTop = 0));
await pause(200);
await shot('conversation-top', '.chat-log >> text=Rewrite the home page hero');

// Switching conversations from the history menu.
await win.getByRole('button', { name: 'Earlier conversations' }).click();
await pause(300);
await shot('history-menu', '.menu >> text=Add an FAQ section');
await win.locator('.menu [role^="menuitem"]', { hasText: 'Add an FAQ section' }).click();
await pause(500);
await shot('conversation-problems', '.chat-log >> text=Add the FAQ as plain headings');

// A new conversation: the ready empty state, then with an element selected, then a draft typed.
await win.getByRole('button', { name: 'New conversation', exact: true }).click();
await pause(400);
await shot('ready-empty', '.chat-empty');
await frame.locator('h1').first().click();
await pause(500);
await frame.locator('h1').first().click();
await pause(700);
await openAiTab();
await shot('ready-selection', '.chat-empty');
const ta = win.getByRole('textbox', { name: 'Message' });
await ta.click();
await ta.pressSequentially('Make this heading shorter and more confident, and keep the line about family-run. Use sentence case.', { delay: 0 });
await pause(300);
await shot('draft', '.chat textarea:focus');
await ta.fill('');
await win.keyboard.press('Escape');
await pause(200);

// A run in progress, pushed through the agent's own event channel. The conversation is the fresh one.
const convId = 'live';
const runId = 'r_live';
const liveUser = { id: 'm_lu', role: 'user', text: 'Make the hero heading shorter and more confident', time: t(58), context: ctx(home, 'Heading'), runId };
const liveAi = { id: 'm_la', role: 'assistant', text: '', time: t(58), runId, activities: [] };
await emit({ runId, conversationId: convId, kind: 'status', status: 'preparing' });
await emit({ runId, conversationId: convId, kind: 'message', message: liveUser });
await emit({ runId, conversationId: convId, kind: 'message', message: liveAi });
await pause(300);
await shot('thinking', '.chat-log >> text=Make the hero heading shorter');

await emit({ runId, conversationId: convId, kind: 'status', status: 'running' });
await emit({ runId, conversationId: convId, kind: 'message', message: { ...liveAi, activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l3', label: 'Updating content', status: 'running' }] } });
await emit({ runId, conversationId: convId, kind: 'text', text: 'The current heading runs to two lines on phones. I will tighten it to one clear promise' });
await pause(300);
await shot('working', '.chat-log >> text=Updating content');

await emit({ runId, conversationId: convId, kind: 'status', status: 'awaiting-input' });
await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    text: '',
    activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l4', label: 'Waiting for your answer', status: 'running' }],
    question: { text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes beyond the selection', 'No, only change the selection'] }
  }
});
await pause(300);
await shot('question', '.chat-log >> text=Can I change things outside the heading');

await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    text: '',
    activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element')],
    question: { text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes beyond the selection', 'No, only change the selection'], answered: 'Yes, allow changes beyond the selection' },
    result: { status: 'failed', summary: 'The AI provider rejected the API key. Update it in Settings.', changes: [], validation: [], canUndo: false, error: 'Incorrect API key provided.' }
  }
});
await emit({ runId, conversationId: convId, kind: 'status', status: 'failed' });
await pause(300);
await shot('failed', '.chat-log >> text=rejected the API key');

await win.evaluate(() => window.builder.ai.setKey('openai', null));
await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`AI panel capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
