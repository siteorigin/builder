// Design capture harness for the AI panel (the right dock's AI tab). Opt-in only, never part of
// `npm run test:e2e`, and it never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] [DESIGN_ONLY=regex] node tests/e2e/design/ai-chat.mjs
//
// DESIGN_ONLY limits the captures to states whose name matches it (`DESIGN_ONLY='^(no-provider|ready-)'` for the
// empty states); the app is still driven through every step, so the states that are kept render as they would.
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
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'ai-chat');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-ai-')));
const THEMES = ['light', 'dark'];
const ONLY = process.env.DESIGN_ONLY ? new RegExp(process.env.DESIGN_ONLY) : null;

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
  if (ONLY && !ONLY.test(state)) return;
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
// Every turn records the model it went to, as a real run does.
const MODEL = { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' };
const turn = (user, page, sel, assistant) => {
  const runId = `r_seed${++n}`;
  return [
    { id: `m_u${n}`, role: 'user', text: user, time: t(n * 3), context: ctx(page, sel), runId },
    { id: `m_a${n}`, role: 'assistant', text: assistant.result?.summary ?? '', time: t(n * 3 + 1), runId, model: MODEL, ...assistant }
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
          // A shared header change links to the header, as the report gives it one.
          { label: 'Updated the shared header navigation', owner: { kind: 'shell', id: 'header' }, nodeId: 'n_header' }
        ],
        validation: ['Fits the screen at phone width.', 'Content is wider than the screen at tablet width.', 'Project structure, links and references are valid.', 'All components build without errors.'],
        canUndo: true
      })
    }),
    ...turn('Does the About page need anything else before launch?', about, null, {
      activities: [done('a15', `Reading ${about.title}`)],
      // Advice, as a model really writes it: the prompt asks for plain sentences, but advice often comes back as two
      // short paragraphs and a list, with bold. The panel has to read well either way.
      ...result('no-changes', 'It’s in good shape for launch. The story is clear, the team section feels personal, and every link works.\n\nTwo things I’d still consider:\n\n- Add one line about your **service area**, so visitors outside Auckland know whether you’ll travel.\n- Swap the second team photo (`team-2.jpg`) for one taken on site; it’s the only studio shot on the page.\n\nI haven’t changed anything. Switch to Edit and ask if you’d like me to make either change.')
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
n = 30;
// A request that kept its valid work but did not finish: Continue, a problem check and a check that could not run.
const partialChecks = [
  { status: 'issue', text: 'Content is wider than the screen at phone width on Pricing.' },
  { status: 'unverified', text: 'Could not check the contact form at tablet width.' },
  { status: 'pass', text: 'Project structure, links and references are valid.' },
  { status: 'pass', text: 'All components build without errors.' }
];
const partialConversation = {
  id: 'c_seedpartial',
  title: 'Build out a Pricing page and link it everywhere',
  createdAt: t(16),
  messages: turn('Build out a Pricing page with three plans and link it from the header and footer', home, null, {
    activities: [done('p1', 'Reading the project'), done('p2', 'Adding Pricing page'), done('p3', 'Adding sections'), done('p4', 'Updating shared navigation'), { id: 'p5', label: 'Checking Pricing at phone width', status: 'error', detail: 'Content is wider than the screen.' }, done('p6', 'Checking the result')],
    ...result('completed', 'I added the **Pricing** page with three plans and linked it from the header. I ran out of steps before linking it from the footer.', {
      changes: [
        { label: 'Added page “Pricing” (/pricing)', pageId: about.id },
        { label: 'Added Plan cards to Pricing', pageId: about.id },
        { label: 'Updated the shared header navigation', owner: { kind: 'shell', id: 'header' }, nodeId: 'n_header' }
      ],
      validation: partialChecks.map((c) => c.text),
      checks: partialChecks,
      incomplete: true,
      canUndo: true
    })
  })
};
n = 40;
// A read-only question, answered with the field to open.
const askConversation = {
  id: 'c_seedask',
  title: 'Where do I change the phone number in the footer?',
  createdAt: t(12),
  messages: turn('Where do I change the phone number in the footer?', home, null, {
    activities: [done('q1', 'Reading the shared footer')],
    ...result('no-changes', 'The phone number is in the shared **footer**, under Contact details, so changing it there updates every page at once. It currently reads “09 555 0142”.', {
      ask: true,
      locations: [{ owner: { kind: 'shell', id: 'footer' }, nodeId: 'n_footer_contact', prop: 'phone', path: ['Footer', 'Contact details', 'Phone number'] }]
    })
  }).map((m) => (m.role === 'user' ? { ...m, context: { ...m.context, mode: 'ask' } } : m))
};
n = 50;
// A long working session, for scrolling back through many finished turns.
const longTurns = [
  ['Tighten the intro on the home page', 'Edited Intro content'],
  ['Swap the second feature icon for something calmer', 'Edited Feature icon'],
  ['Make the testimonials section two columns', 'Updated Testimonials layout'],
  ['Shorten every testimonial to two sentences', 'Edited Testimonial content'],
  ['Add a call to action under the testimonials', 'Added Call to action'],
  ['Make that call to action link to Contact', 'Edited Button link'],
  ['Give the footer a darker background', 'Updated Footer background'],
  ['Check the home page at phone width', null],
  ['Reduce the hero heading size on phones', 'Updated Heading size at phone width'],
  ['Add alt text to the gallery images', 'Edited Gallery image descriptions']
];
const longConversation = {
  id: 'c_seedlong',
  title: 'Tidy the home page before launch',
  createdAt: t(8),
  messages: longTurns.flatMap(([ask, change], i) =>
    turn(ask, home, i % 3 === 0 ? 'Section' : null, {
      activities: [done(`z${i}a`, `Reading ${home.title}`), ...(change ? [done(`z${i}b`, 'Updating content')] : []), done(`z${i}c`, 'Checking the result')],
      ...(change
        ? result('completed', `Done. ${change} on ${home.title}, and everything else is as it was.`, { changes: [{ label: `${change} on ${home.title}`, pageId: home.id }], validation: ['Project structure, links and references are valid.', 'All components build without errors.'], canUndo: true })
        : result('no-changes', 'Home fits at phone width: nothing scrolls sideways and every section stacks cleanly. The one tight spot is the hero heading, “Calm, considered interiors for real family homes”, which wraps to three lines at 390px. Shortening it, or reducing its size on phones, would keep the photo in view.'))
    })
  )
};
n = 60;
// A back-and-forth about one shared-header element: a question answered on the way, one change with a problem found
// after it, then follow-ups the AI answers without changing anything. Short turns in a row, as people really write.
const followupChecks = [
  // The newest thread carries the current wording (src/agent/report.ts); older transcripts keep what they said.
  { status: 'issue', text: 'Found 8 links or buttons too small to tap easily at phone width on Contact.' },
  { status: 'pass', text: 'Project structure, links and references are valid.' },
  { status: 'pass', text: 'All components build without errors.' },
  { status: 'pass', text: 'Fits the screen at phone width.' }
];
const followupConversation = {
  id: 'c_seedfollow',
  title: 'Can you make that button not solid green?',
  createdAt: t(2),
  messages: [
    ...turn('Can you make that button not solid green?', contact, 'Header', {
      activities: [done('f1', 'Reading the shared header'), done('f2', 'Inspecting the selected element'), done('f3', 'Waiting for your answer')],
      questions: [{ id: 'q_seedfill', text: 'This header doesn’t let me remove the green fill from the “Book a call 🔔” button. Would you like me to turn it into a regular navigation link in the shared header instead?', choices: ['Turn it into a navigation link', 'Keep the button as-is'], answered: 'Keep the button as-is' }],
      ...result('no-changes', 'I left the “Book a call 🔔” button as it is.')
    }),
    ...turn('Okay, wait. Rather a nav link then.', contact, 'Header', {
      activities: [done('f4', 'Reading the shared header'), done('f5', 'Updating shared navigation'), done('f6', 'Checking Contact at phone width'), done('f7', 'Checking Contact at tablet width'), done('f8', 'Checking the result')],
      ...result('completed', 'I replaced the solid green “Book a call 🔔” button with a regular link in the shared header. It still goes to the Contact page.', {
        changes: [{ label: 'Changed the navigation, action label and action link of the shared header', owner: { kind: 'shell', id: 'header' }, nodeId: 'n_header' }],
        validation: followupChecks.map((c) => c.text),
        checks: followupChecks,
        canUndo: true
      })
    }),
    ...turn('No wait, I want an outline link.', contact, 'Header', {
      activities: [done('f9', 'Reading the shared header'), done('f10', 'Inspecting the selected element'), done('f11', 'Looking for button styles')],
      ...result('no-changes', 'I left “Book a call 🔔” as a regular link to Contact. This header supports plain links and a solid button, but it doesn’t offer an outline style.')
    }),
    ...turn('Sorry an outline button.', contact, 'Header', {
      activities: [done('f12', 'Inspecting the selected element')],
      ...result('no-changes', 'This header only supports a solid button, not an outline button. I left “Book a call 🔔” as a regular link to Contact.')
    }),
    ...turn('Why is that?', contact, 'Header', {
      activities: [done('f13', 'Reading the shared header')],
      ...result('no-changes', 'The theme’s Header has two built-in styles: plain navigation links and a solid action button. The editor lets me change the button’s label and destination, but it doesn’t expose controls for its fill or border, so I can’t make it an outline button in this header.\n\nIf an outline button matters, I can copy the Header into your project as its own component, where its button style can be changed. That changes the header on every page, so I’d ask before doing it.')
    })
  ]
};
// The hero thread is the one continued most recently, so it is the one that opens first (the list and the first
// conversation shown go by the latest message, not by when a thread was started).
heroConversation.messages.forEach((m, i) => (m.time = t(240 + i)));
const chatDir = join(projectDir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
for (const c of [heroConversation, troubleConversation, colourConversation, partialConversation, askConversation, longConversation, followupConversation]) writeFileSync(join(chatDir, `${c.id}.json`), JSON.stringify(c));
const libraryImages = Object.values(snap.state.assets.assets).filter((a) => a.kind === 'image').slice(0, 3);
if (libraryImages.length < 3) throw new Error('the sample project has fewer than three images to attach and offer');

/** Open a seeded conversation from the history menu. */
async function openConversation(title) {
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await pause(300);
  await win.locator('.menu [role^="menuitem"]', { hasText: title }).click();
  await pause(500);
}

/** Tell the renderer this run is the newest step in undo history, through the channel the project reports on. */
async function markUndoable(undoRunId) {
  const s = await win.evaluate(() => window.builder.project.snapshot());
  const history = { ...s.history, canUndo: true, entries: [...s.history.entries, { id: 'h_seedundo', label: 'AI edit', source: 'ai', time: t(59), applied: true, runId: undoRunId }] };
  await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.send('project:changed', next), { ...s, history });
  await pause(250);
}

/** Drag the dock's edge to a width, and confirm it took. */
async function setDockWidth(width) {
  const box = await win.locator('.dock').boundingBox();
  const handle = await win.locator('.seam.right .resizer').boundingBox();
  const y = handle.y + handle.height / 2;
  await win.mouse.move(handle.x + handle.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(handle.x + handle.width / 2 + (box.width - width), y, { steps: 6 });
  await win.mouse.up();
  // The drag leaves the handle focused and hovered (a pointer that then moves into the canvas frame never un-hovers
  // it), so blur it and park the pointer on the toolbar: later captures show the panel, not the handle.
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await win.mouse.move(10, 10);
  await pause(250);
  const now = (await win.locator('.dock').boundingBox()).width;
  if (Math.abs(now - width) > 2) throw new Error(`dock is ${now}px wide, expected ${width}`);
}

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

// What a finished turn can leave behind: unfinished work, a located answer, an Undo, and a long thread.
await openConversation('Build out a Pricing page');
// Continue is offered only while the unfinished turn's changes are still applied, which history says.
await markUndoable('r_seed31');
await shot('partial', '.result-foot >> text=Continue');
await openConversation('Where do I change the phone number');
await shot('answer', '.chat-log >> text=Open in inspector');
await openConversation('Make the brand colour');
await markUndoable('r_seed21');
await shot('undo-available', '.result-foot >> text=Undo turn');
// The follow-ups thread, with its one change still the newest step in undo history.
await openConversation('Can you make that button not solid green');
await markUndoable('r_seed62');
await shot('followups', '.chat-log >> text=Why is that?');
await win.locator('.chat-log').evaluate((el) => (el.scrollTop = 0));
await pause(250);
await shot('followups-top', '.chat-log >> text=Book a call');
// A reply's details opened: its steps and the model that answered.
await win.locator('.chat-log .reply-toggle').first().click();
await pause(250);
await shot('reply-details', '.chat-log .reply-details');
await win.locator('.chat-log .reply-toggle').first().click();
await pause(150);
await setDockWidth(300);
await win.locator('.chat-log').evaluate((el) => (el.scrollTop = el.scrollHeight * 0.25));
await pause(250);
await shot('followups-narrow', '.chat-log >> text=Okay, wait');
await setDockWidth(340);
await openConversation('Tidy the home page');
await shot('long-latest', '.chat-log >> text=Add alt text to the gallery images');
await win.locator('.chat-log').evaluate((el) => (el.scrollTop = el.scrollHeight * 0.4));
await pause(250);
await shot('long-scrolled', '.chat-log >> text=Add a call to action');

// A new conversation: the ready empty state, in Edit and Ask, then with an element selected, then a draft typed.
await win.getByRole('button', { name: 'New conversation', exact: true }).click();
await pause(400);
await shot('ready-empty', '.chat-empty');
const pickMode = async (mode) => {
  await win.getByRole('button', { name: /^What your next message does/ }).click();
  await win.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click();
  await pause(200);
};
await pickMode('Ask');
await shot('ready-ask', '.chat-empty >> text=Ask how your site works');
await pickMode('Edit');
await frame.locator('h1').first().click();
await pause(500);
await frame.locator('h1').first().click();
await pause(700);
await openAiTab();
await shot('ready-selection', '.chat-empty');
// The same at the dock's narrowest, where the starters wrap.
await setDockWidth(300);
await shot('ready-narrow', '.chat-empty .suggestion');
await setDockWidth(340);
const ta = win.getByRole('textbox', { name: 'Message' });
await ta.click();
await ta.pressSequentially('Make this heading shorter and more confident, and keep the line about family-run. Use sentence case.', { delay: 0 });
await pause(300);
await shot('draft', '.chat textarea:focus');
await ta.fill('');
await win.keyboard.press('Escape');
await pause(200);

// Library images attached to the message, through the Assets panel's own action.
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await pause(300);
for (const image of libraryImages.slice(0, 2)) {
  await win.locator(`[data-asset="${image.id}"]`).click();
  await pause(200);
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await pause(300);
  await win.locator('.asset-back').click();
  await pause(200);
}
await ta.fill('Use these two photos in the gallery, with the wider one first');
await pause(300);
await shot('composer-images', '.composer .image-chip');
await ta.fill('');
while (await win.locator('.composer .image-chip button').count()) {
  await win.locator('.composer .image-chip button').first().click();
  await pause(120);
}
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await pause(200);
await openAiTab();

// A run in progress, pushed through the agent's own event channel. The conversation is the fresh one: the panel
// shows a run's messages only in the conversation they are tagged with.
const convId = (await win.evaluate(() => window.builder.ai.conversations())).active.id;
const runId = 'r_live';
const liveUser = { id: 'm_lu', role: 'user', text: 'Make the hero heading shorter and more confident', time: t(58), context: ctx(home, 'Heading'), runId };
// A run records the model it went to when it starts, so the composer has no reason to warn about a switch.
const liveAi = { id: 'm_la', role: 'assistant', text: '', time: t(58), runId, model: MODEL, activities: [] };
await emit({ runId, conversationId: convId, kind: 'status', status: 'preparing' });
await emit({ runId, conversationId: convId, kind: 'message', message: liveUser });
await emit({ runId, conversationId: convId, kind: 'message', message: liveAi });
await pause(300);
await shot('thinking', '.chat-log >> text=Make the hero heading shorter');

await emit({ runId, conversationId: convId, kind: 'status', status: 'running' });
await emit({ runId, conversationId: convId, kind: 'message', message: { ...liveAi, activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l3', label: 'Updating content', status: 'running' }] } });
await emit({ runId, conversationId: convId, kind: 'text', text: 'The heading “Calm, considered interiors for real family homes” runs to three lines on phones. I’ll tighten it to one clear promise and keep' });
await pause(300);
// The step under way is named in the run strip; the log keeps the steps already taken.
await shot('working', '.run-strip >> text=Updating content');

// Later phases of the same run, with enough steps to fold the earlier ones.
await emit({ runId, conversationId: convId, kind: 'status', status: 'validating' });
await emit({ runId, conversationId: convId, kind: 'message', message: { ...liveAi, activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), done('l3', 'Updating content'), done('l5', 'Checking Home at phone width'), done('l6', 'Checking Home at tablet width'), { id: 'l7', label: 'Checking the result', status: 'running' }] } });
await pause(300);
await shot('checking', '.run-strip >> text=Checking the result');
await emit({ runId, conversationId: convId, kind: 'status', status: 'stopping' });
await pause(200);
await shot('stopping', '.run-strip >> text=Stopping');

await emit({ runId, conversationId: convId, kind: 'status', status: 'awaiting-input' });
await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    text: '',
    activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l4', label: 'Waiting for your answer', status: 'running' }],
    questions: [{ id: 'q_seedwiden', text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes across the whole site', 'No, only change the selection'], widen: true }]
  }
});
await pause(300);
// The waiting question sits above the composer, which answers it.
await shot('question', '.question-card >> text=Can I change things outside the heading');
// The same question at the dock's narrowest.
await setDockWidth(300);
await shot('question-narrow', '.question-card >> text=Can I change things outside the heading');
await setDockWidth(340);

// A question that offers pictures from the library.
await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    text: '',
    activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l4', label: 'Waiting for your answer', status: 'running' }],
    questions: [{ id: 'q_seedimage', text: 'Which photo should lead the hero?', choices: ['Keep the current photo'], images: libraryImages.map((a) => ({ assetId: a.id, name: a.name })) }]
  }
});
await pause(400);
await shot('question-images', '.question-card .image-choice');

await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    text: '',
    activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element')],
    questions: [{ id: 'q_seedwiden', text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes across the whole site', 'No, only change the selection'], widen: true, answered: 'Yes, allow changes across the whole site' }],
    result: { status: 'failed', summary: 'The AI provider rejected the API key. Update it in Settings.', changes: [], validation: [], canUndo: false, error: 'Incorrect API key provided.' }
  }
});
await emit({ runId, conversationId: convId, kind: 'status', status: 'failed' });
await pause(300);
await shot('failed', '.chat-log >> text=rejected the API key');

// History kept, provider gone: the conversation stays readable and says how to carry on.
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.ai.setKey('openai', null));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAiTab();
await pause(400);
await shot('disconnected', '.chat-connect');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`AI panel capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
