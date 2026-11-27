// Design capture for the Project tab of the right dock: the project's private brief (a description and working
// notes) empty, filled in, being typed, with notes long enough to fill the dock, and with the project open read-only.
// Opt-in only, never part of `npm run test:e2e`, and it never calls a provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/project-brief.mjs
//
// The brief is written through the project's own `brief.update` operation, and read-only is shown by sending the
// project's snapshot through the channel the project reports on, so the tab renders exactly what it would for a project
// in that state. Each capture checks the brief is on screen and throws rather than write an image of anything else.
// Files are `{state}--{theme}.png`, cropped to the dock.
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project brief capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'project-brief');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const READ_ONLY = { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true };
const DESCRIPTION = 'A brochure site for Harbour Lane Studio, a two-person architecture practice in Lyttelton. For homeowners planning a renovation.';
const NOTES = [
  'Client: Marama Tuhoe and Sam Price. They want enquiries for residential renovations, not new builds.',
  '',
  'Audience: homeowners in Christchurch and Banks Peninsula, mostly 35 to 60, who have a budget but no architect yet.',
  '',
  'Tone: warm, plain, confident. No jargon ("bespoke", "curated"). Short sentences.',
  '',
  'To do before launch:',
  '- Three project case studies with before and after photos',
  '- Fees page: a range, not a price list',
  '- Contact form goes to studio@harbourlane.nz'
].join('\n');
const LONG_NOTES = [
  NOTES,
  '',
  'Meeting notes, 14 November:',
  '- Sam wants the gallery first on the home page; Marama prefers the process. Try both and show them.',
  '- The old site ranks for "Lyttelton architect". Keep the /about address.',
  '- Photos from the Governors Bay house arrive next week.',
  '',
  'Meeting notes, 21 November:',
  '- Approved the terracotta brand colour.',
  '- Case studies: Governors Bay, Cass Bay, the Sumner bach.',
  '- They want a short "How we work" section: brief, design, consent, build.',
  '',
  'Questions for the client:',
  '- Do they want to list fees at all?',
  '- Who answers the contact form while they are on site?',
  '- Is the Instagram account staying?',
  '',
  'Ideas:',
  '- A small map of finished projects around the harbour.',
  '- Testimonials from the Cass Bay owners.',
  '- A FAQ about consents and timelines.'
].join('\n');
const started = Date.now();

const { WORK, cleanup } = scratch('design-project-brief');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const dock = win.locator('#editor-dock');
const brief = win.locator('#dock-panel-project .brief');

let held = null;
/** Capture the dock in each theme; every `checks` selector must be visible inside the brief. */
async function shot(state, checks, { themes = LIGHT, before } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    if (held) await push(held);
    if (before) await before();
    await pause(300);
    if (!(await brief.isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): the brief is not on screen; refusing to write`);
    for (const check of [].concat(checks)) {
      if (!(await brief.locator(check).first().isVisible().catch(() => false))) {
        await win.screenshot({ path: join(WORK, `failed-${state}.png`) }).catch(() => undefined);
        throw new Error(`"${state}" (${theme}): ${check} is not on screen; refusing to write (window: ${join(WORK, `failed-${state}.png`)})`);
      }
    }
    const box = await dock.boundingBox();
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: Math.floor(box.x), y: Math.max(0, Math.floor(box.y) - 1), width: Math.ceil(box.width), height: Math.ceil(box.height) + 1 } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const send = (channel, payload) =>
  app.evaluate(({ BrowserWindow }, [channel, payload]) => {
    const known = globalThis[Symbol.for('siteorigin.desktopFixtures')]?.editor;
    const editor =
      (known !== null && known !== undefined ? BrowserWindow.fromId(known) : null) ??
      BrowserWindow.getAllWindows().find((w) => {
        try {
          const u = new URL(w.webContents.getURL());
          return !w.isDestroyed() && u.protocol === 'app:' && u.host === 'editor';
        } catch {
          return false;
        }
      });
    if (!editor) throw new Error('no editor window');
    editor.webContents.send(channel, payload);
  }, [channel, payload]);
async function push(change) {
  held = change;
  const s = await snapshot();
  const next = change(s);
  await send('project:changed', { seq: 0, base: null, revision: next.revision, snapshot: next });
  await pause(500);
}
const real = async () => {
  await push((s) => s);
  held = null;
};
async function setBrief(description, notes) {
  const r = await win.evaluate(([d, n]) => window.builder.project.apply({ operations: [{ type: 'brief.update', description: d, notes: n }] }, { label: 'Capture brief' }), [description, notes]);
  if (!r?.ok) throw new Error(`brief.update: ${JSON.stringify(r?.error ?? r)}`);
  await pause(400);
}
const blur = async () => {
  await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await pause(200);
};
async function openProjectTab() {
  const tab = win.locator('#dock-tab-project');
  await tab.waitFor();
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await brief.waitFor();
  await pause(300);
}

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
  const frame = win.frameLocator('.frame-box iframe');
  await frame.locator('h1').first().waitFor({ timeout: 90000 });
  await pause(800);
  await openProjectTab();

  // ---- Empty: a new project's brief ----
  await setBrief('', '');
  await shot('empty', ['textarea'], { themes: BOTH });

  // ---- Filled in ----
  await setBrief(DESCRIPTION, NOTES);
  await shot('populated', ['textarea'], { themes: BOTH });

  // ---- Typing in the description: focused, a draft not yet saved ----
  await shot('typing', ['textarea:focus'], {
    before: async () => {
      const field = brief.locator('textarea').first();
      await field.click();
      // The caret at the end of the text (End alone goes to the end of the clicked line).
      await field.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
      await win.keyboard.type(' Most work comes by word of mouth.');
    }
  });
  await win.keyboard.press('Escape');
  await blur();

  // ---- Description near its limit, being typed: the count in the box's corner, the hint under the box ----
  await shot('near-limit', ['textarea:focus', '.field-frame:has(textarea:focus) > .field-count'], {
    before: async () => {
      const field = brief.locator('textarea').first();
      await field.click();
      await field.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
      await win.keyboard.type(' Most work comes by word of mouth from neighbours of past clients, so the site has to answer the questions a neighbour would ask first.');
    }
  });
  await win.keyboard.press('Escape');
  await blur();

  // ---- Typing in the notes ----
  await shot('notes-typing', ['textarea:focus'], {
    before: async () => {
      const field = brief.locator('textarea').nth(1);
      await field.click();
      await field.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
      await win.keyboard.type('\n- Ask about the parking for clients');
    }
  });
  await win.keyboard.press('Escape');
  await blur();

  // ---- A short window: the notes keep their floor and the panel scrolls ----
  await win.setViewportSize({ width: 1440, height: 620 });
  await pause(400);
  await shot('short-window', ['textarea']);
  await win.setViewportSize({ width: 1440, height: 900 });
  await pause(400);

  // ---- Notes long enough to fill the dock, scrolled to the top and to the end ----
  await setBrief(DESCRIPTION, LONG_NOTES);
  await shot('notes-long', ['textarea']);
  await shot('notes-long-end', ['textarea'], {
    before: async () => {
      await brief.evaluate((el) => {
        const body = el.closest('.panel-body') ?? el;
        body.scrollTop = body.scrollHeight;
        for (const t of el.querySelectorAll('textarea')) t.scrollTop = t.scrollHeight;
      });
    }
  });
  await brief.evaluate((el) => ((el.closest('.panel-body') ?? el).scrollTop = 0));
  await setBrief(DESCRIPTION, NOTES);

  // ---- Read-only: the project opened read-only, and one that turned read-only while open ----
  await push((s) => ({ ...s, readOnly: READ_ONLY }));
  await shot('read-only-while-open', ['textarea'], { themes: LIGHT });
  await real();
  // A project opened read-only: the brief mounts afresh for each opening (its workspace key), so a snapshot with a new
  // key that is read-only from the start draws it as a project opened that way.
  await push((s) => ({ ...s, workspaceKey: `${s.workspaceKey}:capture`, readOnly: READ_ONLY }));
  await openProjectTab();
  await shot('read-only', ['textarea[readonly]'], { themes: BOTH });
  await real();
} finally {
  console.log(`\n${written.length} captures in ${OUT} (${Math.round((Date.now() - started) / 1000)}s)`);
  if (errors?.length) console.log('page errors:', errors.slice(0, 5));
  await app.close().catch(() => undefined);
  cleanup?.();
}
