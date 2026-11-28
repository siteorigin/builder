/**
 * Leaving a project whose save is refused (its folder moved, so it turned read-only while a field was being typed in)
 * asks before the typed text goes, every time (#1383). Keep editing returns to the field with its text; leaving again
 * sends it again and, refused again, asks again, rather than closing as if nothing were left. Leaving the field after
 * Keep editing keeps the text too, for the next leave to ask about, and a change made to the field somewhere else
 * meanwhile is never written over. An explicit save that is refused puts the saved value back, as it always has. The
 * real DraftInput, store and leave run in a real browser, on a real project, against a main process that refuses every
 * save, holds one until told, or (for a save that lands) takes it, the project's copy catching up only when told.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findTheme } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://leave-refused.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));
const TOKEN = 'color.brand';

// One field of the open project, locked once the project turns read-only, as the Inspector's are.
const ENTRY = [
  "import { createElement as h, useRef, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput } from ${renderer('components/ui')};`,
  `import { applyOps, getConfirm, markDraft, useStore } from ${renderer('store')};`,
  `import { prepareToLeave, saveNow } from ${renderer('lib/leave')};`,
  "import { registerPacks } from '@catalogue/index';",
  `const TOKEN = ${JSON.stringify(TOKEN)};`,
  // The theme the project uses, as the editor receives it before it first renders.
  'registerPacks([window.__theme]);',
  "useStore.setState({ screen: 'editor', snapshot: { state: window.__project, revision: 1, workspaceKey: 'w1', dir: '/projects/test-studio', conflicts: [], diagnostics: [] } });",
  'function App() {',
  "  const [value, setValue] = useState('#d14131');",
  '  const [locked, setLocked] = useState(false);',
  '  window.lock = () => flushSync(() => setLocked(true));',
  '  window.setSaved = (v) => flushSync(() => setValue(v));',
  // How a formatting command saves the text where it is first, as Rich text fields do.
  '  const handle = useRef(null);',
  '  window.commitNow = (text) => void handle.current.commitNow(text);',
  "  return h(DraftInput, { className: 'input', ariaLabel: 'Brand color value', value, readOnly: locked, handle, onCommit: (v) => applyOps([{ type: 'token.set', tokenId: TOKEN, value: v }], 'Change Brand', `token:${TOKEN}`) });",
  '}',
  'window.leave = () => {',
  '  window.left = undefined;',
  '  void prepareToLeave(() => undefined).then((ok) => (window.left = ok));',
  '};',
  'window.save = () => void saveNow();',
  'window.question = () => getConfirm()?.title ?? null;',
  'window.body = () => getConfirm()?.body ?? null;',
  'window.answer = (ok) => getConfirm().resolve(ok);',
  'window.drafting = () => useStore.getState().drafting;',
  'window.held = () => useStore.getState().heldEdits.map((e) => ({ phase: e.phase, text: e.text }));',
  // The colour changed somewhere else: the project's copy moves on to the next revision, and the field with it.
  'window.changedElsewhere = (v) => {',
  '  const s = useStore.getState().snapshot;',
  '  useStore.setState({ snapshot: { ...s, revision: s.revision + 1, state: { ...s.state, tokens: { ...s.state.tokens, overrides: { ...s.state.tokens.overrides, [TOKEN]: v } } } } });',
  '  window.setSaved(v);',
  '};',
  // A page being added and not created yet: something else left open, so leaving asks.
  "window.addingPage = (on) => markDraft('page-add', on);",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save. Main refuses it, as it does once the project's
 *  folder has moved, at once or (`window.holding`) only when `window.answerSave()` says; or (`window.saving`) takes it,
 *  the project's copy catching up only when `window.catchUp()` says. */
const BRIDGE = `
  window.saves = [];
  window.saving = false;
  window.holding = false;
  let unseen = null;
  let answer = null;
  window.catchUp = () => window.setSaved(unseen);
  window.answerSave = () => answer();
  const refusal = { ok: false, revision: 1, error: { code: 'SCOPE_MISMATCH', message: 'The project folder was moved or renamed, so changes can’t be saved here.', recoverable: false } };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path !== 'project.apply') return any('');
      const value = args[0].operations[0].value;
      window.saves.push(value);
      if (window.saving) {
        unseen = value;
        return Promise.resolve({ ok: true, revision: 2, results: [{}] });
      }
      if (window.holding) return new Promise((resolve) => (answer = () => resolve(refusal)));
      return Promise.resolve(refusal);
    }
  });
  window.builder = any('');
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'leave-refused',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The field did not bundle');
  return chunk.code;
}

const LEAVE_QUESTION = 'Leave without your last change?';
const TYPED = '#1d4ed8';
/** Longer than a field waits, once its change has landed or been refused, before it puts the saved value back. */
const PAST_RESET_MS = 1_000;

describe.skipIf(!browserInstalled)('leaving a project that refuses its save asks every time', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const state = createStarterState('blank', 'Test Studio', false);
    const project = JSON.stringify(state).replace(/</g, '\\u003c');
    const theme = JSON.stringify(findTheme(state.site.themeId)).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}window.__project = ${project}; window.__theme = ${theme};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const poll = <T>(fn: () => Promise<T>) => expect.poll(fn, { timeout: 5_000 });
  const field = () => page.getByRole('textbox', { name: 'Brand color value' });
  const question = () => page.evaluate<string | null>('window.question()');
  const left = () => page.evaluate<boolean | undefined>('window.left');
  const saves = () => page.evaluate<string[]>('window.saves');
  const focused = () => page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Brand color value'`);
  const drafting = () => page.evaluate<number>('window.drafting()');
  const blur = () => page.evaluate(`document.activeElement?.blur()`);
  /** Answer the question leaving asks: Keep editing (false) or Leave without it (true). */
  const answer = async (ok: boolean) => {
    await poll(question).toBe(LEAVE_QUESTION);
    await page.evaluate(`window.answer(${ok})`);
    await poll(left).toBe(ok);
  };
  const leaveAnswering = async (ok: boolean) => {
    await page.evaluate('window.leave()');
    await answer(ok);
  };
  /** Type in the field, and leave it focused as the folder moves: the project is read-only now, and the field with it. */
  const typeThenLock = async () => {
    await field().fill(TYPED);
    await page.evaluate('window.lock()');
  };

  it('asks again on the next leave after Keep editing, and leaves only when told to', async () => {
    await typeThenLock();
    await leaveAnswering(false);
    expect(await field().inputValue()).toBe(TYPED);
    await poll(focused).toBe(true);
    expect(await drafting()).toBe(1);
    // Leaving again sends the text again, hears it refused again, and asks again.
    await leaveAnswering(false);
    expect(await saves()).toEqual([TYPED, TYPED]);
    expect(await field().inputValue()).toBe(TYPED);
    expect(await drafting()).toBe(1);
    // And once more, this time leaving without it.
    await leaveAnswering(true);
    expect(await saves()).toEqual([TYPED, TYPED, TYPED]);
  });

  it('keeps the text when the field is left after Keep editing, and asks on the next leave', async () => {
    await typeThenLock();
    await leaveAnswering(false);
    await poll(focused).toBe(true);
    // Clicking somewhere else sends it again, refused again: the text stays, not saved, past the field's wait.
    await blur();
    await poll(saves).toHaveLength(2);
    await page.waitForTimeout(PAST_RESET_MS);
    expect(await field().inputValue()).toBe(TYPED);
    expect(await drafting()).toBe(1);
    // Leaving now, with nothing focused, asks about it, and Keep editing goes back to it.
    await leaveAnswering(false);
    expect(await saves()).toHaveLength(2);
    await poll(focused).toBe(true);
    // Left again, and refused again: it still stays, for as long as the project cannot take it.
    await blur();
    await poll(saves).toHaveLength(3);
    await page.waitForTimeout(PAST_RESET_MS);
    expect(await field().inputValue()).toBe(TYPED);
    expect(await drafting()).toBe(1);
    // Once the project holds that very text, nothing is left unsaved, and leaving sends nothing more.
    await page.evaluate(`window.setSaved('${TYPED}')`);
    await poll(drafting).toBe(0);
    await page.evaluate('window.leave()');
    await poll(left).toBe(true);
    expect(await question()).toBe(null);
    expect(await saves()).toHaveLength(3);
  });

  it('keeps text whose refusal arrives once leaving has started', async () => {
    await typeThenLock();
    await page.evaluate('window.holding = true');
    // Tabbed out just before choosing to leave: the refusal comes back while leaving waits for it.
    await blur();
    await poll(saves).toHaveLength(1);
    await page.evaluate('window.leave()');
    await page.evaluate('window.answerSave()');
    await answer(false);
    await poll(focused).toBe(true);
    await page.waitForTimeout(PAST_RESET_MS);
    expect(await field().inputValue()).toBe(TYPED);
    expect(await drafting()).toBe(1);
    await page.evaluate('window.holding = false');
    await leaveAnswering(false);
    expect(await saves()).toEqual([TYPED, TYPED]);
  });

  it('keeps the text when a formatting command saves it after Keep editing', async () => {
    await typeThenLock();
    await leaveAnswering(false);
    await poll(focused).toBe(true);
    // Bold, say: the text is saved where it is first, and refused again.
    await page.evaluate(`window.commitNow('${TYPED}')`);
    await poll(saves).toHaveLength(2);
    await poll(drafting).toBe(1);
    expect(await field().inputValue()).toBe(TYPED);
    await leaveAnswering(false);
    expect(await saves()).toEqual([TYPED, TYPED, TYPED]);
  });

  it('never writes kept text over a change made to the field somewhere else meanwhile', async () => {
    await typeThenLock();
    await leaveAnswering(false);
    await poll(focused).toBe(true);
    // The kept text stays while the field changes under it.
    await page.evaluate("window.changedElsewhere('#15803d')");
    expect(await field().inputValue()).toBe(TYPED);
    // Leaving checks it against where typing began: it is held beside the newer value, not sent over it.
    await leaveAnswering(false);
    expect(await saves()).toEqual([TYPED]);
    expect(await page.evaluate('window.held()')).toEqual([{ phase: 'changed', text: TYPED }]);
  });

  it('puts the saved value back after a save that is refused, as always', async () => {
    await typeThenLock();
    await page.evaluate('window.save()');
    await poll(saves).toHaveLength(1);
    await poll(() => field().inputValue()).toBe('#d14131');
    expect(await drafting()).toBe(0);
  });

  it('sends a saved edit only once when something else made leaving ask', async () => {
    await page.evaluate('window.saving = true');
    await field().fill(TYPED);
    await page.evaluate('window.addingPage(true)');
    await page.evaluate('window.leave()');
    await poll(question).toBe(LEAVE_QUESTION);
    // Only the page being added is left: the edit itself was saved.
    expect(await page.evaluate('window.body()')).toBe('The page you started adding has not been created yet.');
    await answer(false);
    expect(await saves()).toEqual([TYPED]);
    await poll(focused).toBe(true);
    // The project's copy of the saved colour arrives after Keep editing has put focus back.
    await page.evaluate('window.catchUp()');
    await page.evaluate('window.addingPage(false)');
    await page.evaluate('window.leave()');
    await poll(left).toBe(true);
    expect(await question()).toBe(null);
    expect(await saves()).toEqual([TYPED]);
  });
});
