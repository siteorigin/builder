// Design capture for the Settings dialog: General, the AI assistant section for each provider, and the local
// model server states. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/settings.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, cropped to the dialog unless a state needs
// the whole window. A dialog that scrolls also gets a `{state}-end` capture of its last screen. Every capture
// checks its state on screen after it settles and throws rather than writing a wrong image.
//
// No real key is ever used or shown: provider keys are cleared from the environment, the only key is the
// placeholder below, the user data folder is a scratch one, and connection tests are answered by a fixture
// in the main process, so nothing is sent to a provider. The local model server is a fixture on loopback.
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('settings capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'settings');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-settings-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const PLACEHOLDER_KEY = 'fixture-placeholder-not-a-key';
const LONG_MODEL_ID = 'ft:gpt-6.2-sol:harbour-lane-studio:brochure-writer-v3:9xQ2kLmP';
const LOCAL_MODELS = ['qwen3.5-coder-32b-instruct-q5_k_m.gguf', 'llama-4-scout-17b-instruct', 'gemma-4-27b-it'];

// An OpenAI-compatible model server on loopback; `serverModels` is what it currently offers.
let serverModels = LOCAL_MODELS;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/models')) res.end(JSON.stringify({ object: 'list', data: serverModels.map((id) => ({ id, object: 'model' })) }));
  else {
    res.statusCode = 404;
    res.end('{}');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const FIXTURE_URL = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1280, height: 900 });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
// Connection tests answer from here, so a placeholder key never reaches a provider.
await app.evaluate(({ ipcMain }) => {
  globalThis.__settingsTestResult = { ok: true, message: 'Connected.' };
  ipcMain.removeHandler('ai:test');
  ipcMain.handle('ai:test', () => globalThis.__settingsTestResult);
});
const testAnswers = (result) => app.evaluate((_electron, r) => void (globalThis.__settingsTestResult = r), result);

const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const tab = (name) => win.getByRole('tab', { name });
const keyInput = win.locator('#settings-api-key');
const urlInput = win.locator('#settings-local-url');
const STATUS = '.settings-status';
const PROBLEM = '.settings-status.problem';
const statusSays = (text) => win.locator(STATUS, { hasText: text }).first().waitFor({ timeout: 20000 });
const button = (name) => win.locator('.modal').last().locator('button, [role="radio"], [role="tab"]').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();
const testButton = win.locator('.modal button').filter({ hasText: /^\s*Test/ }).first();

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The top dialog with a margin, so its edge and shadow read. */
async function dialogClip() {
  const box = await win.locator('.modal').last().boundingBox();
  const view = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 20));
  const y = Math.max(0, Math.floor(box.y - 20));
  return { x, y, width: Math.min(view.width - x, Math.ceil(box.width + 40)), height: Math.min(view.height - y, Math.ceil(box.height + 40)) };
}

/** Capture a state; `check` must be visible at the moment of capture, in every theme. */
async function shot(state, check, themes = BOTH, { full = false, keepFocus = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(4, 4);
    await pause(150);
    const write = async (name) => {
      const visible = await win.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
      const path = join(OUT, `${name}--${theme}.png`);
      await win.screenshot({ path, ...(full ? {} : { clip: await dialogClip() }) });
      written.push(path);
      console.log('wrote', path);
    };
    await write(state);
    // The last screen of a dialog that scrolls, since its lower settings are otherwise never seen.
    if (!full && !keepFocus) {
      // Settings scrolls its open section; a dialog on top of it (or any other) scrolls its body.
      const dialog = win.locator('.modal').last();
      const panel = dialog.locator('.settings-panel:not([hidden])');
      const scroller = (await panel.count()) ? panel.first() : dialog.locator('.modal-body');
      const scrolls = await scroller.evaluate((el) => {
        if (el.scrollHeight <= el.clientHeight + 1) return false;
        el.scrollTop = el.scrollHeight;
        return true;
      });
      if (scrolls) {
        await pause(120);
        await write(`${state}-end`);
        await scroller.evaluate((el) => void (el.scrollTop = 0));
      }
    }
  }
  await setTheme('light');
}

async function openSettings(section) {
  await win.locator('.welcome button', { hasText: 'Settings' }).click();
  await win.locator('.modal').waitFor();
  await pause(250);
  if (section) {
    await tab(section).click();
    await win.locator(`.modal [role="tab"][aria-selected="true"]`, { hasText: section }).waitFor();
    await pause(250);
  }
}
async function closeSettings() {
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached' });
  await pause(150);
}
async function chooseProvider(name) {
  await button(name).click();
  await pause(450);
}
/** Type an address and commit it, as pressing Enter in the field does. */
async function typeServer(url) {
  await urlInput.fill(url);
  await urlInput.press('Enter');
  await pause(500);
}

// ---- General ----
await openSettings();
await shot('general', '.modal [role="switch"]');
// Always at least one real Tab press: focus placed when a click opened the dialog does not show a ring.
for (let i = 0; i < 12; i++) {
  await win.keyboard.press('Tab');
  if (await win.evaluate(() => document.activeElement?.getAttribute('role') === 'tab')) break;
}
await shot('general-focus', '.modal [role="tab"]:focus-visible', LIGHT, { keepFocus: true });
await shot('context', '.modal', LIGHT, { full: true, keepFocus: true });

// ---- Keyboard shortcuts: Ask AI's recorder ----
const shortcutRow = '.modal .settings-shortcut';
await win.locator(shortcutRow).getByRole('button', { name: /^Change/ }).focus();
await win.keyboard.press('Enter');
await win.locator('.modal .settings-shortcut .recording').first().waitFor();
await pause(200);
await shot('shortcut-recording', shortcutRow, BOTH, { keepFocus: true });
// A press another shortcut has is refused, naming what has it; recording goes on.
await win.keyboard.press('Meta+K');
await win.locator('.modal #settings-ask-ai-key-note.field-error, .modal .field-error').first().waitFor();
await pause(200);
await shot('shortcut-refused', '.modal .field-error', BOTH, { keepFocus: true });
await win.keyboard.press('Meta+Shift+L');
await pause(500);
await win.locator(shortcutRow, { hasText: /Reset/ }).first().waitFor();
await shot('shortcut-custom', shortcutRow, BOTH);
await win.locator(shortcutRow).getByRole('button', { name: /Reset/ }).click();
await pause(400);

// ---- AI assistant, hosted providers ----
await tab('AI assistant').click();
await keyInput.waitFor();
await pause(300);
await shot('openai-empty', '#settings-api-key');

// A key typed but not saved, always masked.
await keyInput.fill(PLACEHOLDER_KEY);
await pause(200);
await shot('openai-typed', '#settings-api-key');

// Testing the typed key, and what a rejected key says.
await testAnswers({ ok: false, message: 'Incorrect API key provided. Check it and try again.' });
await testButton.click();
await statusSays('didn’t accept this key');
await pause(250);
await shot('openai-test-failed', PROBLEM, LIGHT, { full: true });

// Closing with the key still typed asks first.
await win.keyboard.press('Escape');
await win.getByRole('button', { name: 'Keep editing' }).waitFor();
await pause(300);
await shot('unsaved-confirm', '.modal >> text=Keep editing', BOTH, { full: true });
await win.getByRole('button', { name: 'Keep editing' }).click();
await pause(250);

// Saved, after pasting the key again (the failed test above stays with the key it tested, even once saved).
await keyInput.fill('');
await keyInput.fill(PLACEHOLDER_KEY);
await win.locator('.modal button', { hasText: /^\s*Save key\s*$/ }).click();
// The placeholder does not look like an OpenAI key, so saving it asks first.
const anyway = win.getByRole('button', { name: 'Save anyway' });
if (await anyway.waitFor({ timeout: 3000 }).then(() => true, () => false)) await anyway.click();
await win.locator('.modal button', { hasText: 'Remove' }).first().waitFor();
await statusSays('key saved');
await shot('openai-saved', '.settings-key-saved');

// Replacing a saved key opens the field again, with a way back.
await win.locator('#settings-key-replace').click();
await keyInput.waitFor();
await pause(200);
await shot('openai-replacing', '#settings-api-key', LIGHT);
await win.locator('.modal button', { hasText: 'Cancel' }).click();
await win.locator('.settings-key-saved').waitFor();

await testAnswers({ ok: true, message: 'Connected. gpt-6.2-sol responded.' });
await testButton.click();
await statusSays('Connection test passed');
await pause(250);
await shot('openai-test-ok', STATUS, LIGHT, { full: true });

// A custom model ID, which needs Developer mode.
await tab('General').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await pause(200);
await shot('general-developer', '.modal [role="switch"][aria-checked="true"]', LIGHT);
await tab('AI assistant').click();
await win.locator('.settings-key-saved').waitFor();
const customModel = win.getByLabel('Model ID', { exact: true });
await customModel.fill(LONG_MODEL_ID);
await customModel.press('Enter');
await pause(300);
await shot('openai-custom-model', '.modal input#settings-model', LIGHT);
await pause(250);
await tab('General').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await tab('AI assistant').click();
await win.locator('.settings-key-saved').waitFor();

// The other hosted provider, with no key yet.
await chooseProvider('Anthropic');
await shot('anthropic-empty', '#settings-api-key', LIGHT);

// ---- Local model ----
// The default preset with nothing listening on it (the usual first visit).
await chooseProvider('Local model');
await urlInput.waitFor();
await win.locator('.settings-status:not(:has-text("Checking"))').first().waitFor({ timeout: 20000 });
await pause(300);
await shot('local-first-run', '.settings-presets [aria-pressed="true"]', LIGHT);
await typeServer('http://127.0.0.1:9/v1');
await statusSays('Can’t reach the server');
await pause(300);
await shot('local-unreachable', PROBLEM);

await typeServer(FIXTURE_URL);
await win.locator(`#settings-local-model option[value="${LOCAL_MODELS[0]}"]`).waitFor({ state: 'attached', timeout: 20000 });
await pause(400);
await win.locator('#settings-local-model').selectOption(LOCAL_MODELS[0]);
await pause(300);
await shot('local-connected', `#settings-local-model`);
await testAnswers({ ok: true, message: `Connected. ${LOCAL_MODELS[0]} is available.` });
await statusSays('Server reachable');
await testButton.click();
await statusSays('Connection test passed');
await pause(250);
await shot('local-test-ok', STATUS, LIGHT, { full: true });

// The advanced server options, opened.
await win.locator('.settings-advanced > summary').click();
await pause(200);
await shot('local-advanced', '.settings-advanced[open] select', LIGHT);
// A customized option, with the options closed again.
await win.locator('#settings-local-tools-select').selectOption('constrained-json');
await pause(250);
await win.locator('.settings-advanced > summary').click();
await pause(250);
await shot('local-customized', '.settings-advanced:not([open])', LIGHT);
await win.locator('.settings-advanced > summary').click();
await pause(200);
await win.locator('#settings-local-tools-select').selectOption('auto');
await pause(250);
await win.locator('.settings-advanced > summary').click();
await pause(200);

// The chosen model is no longer on the server.
serverModels = LOCAL_MODELS.slice(1);
await win.locator('.modal button', { hasText: /^\s*Refresh\s*$/ }).click();
await statusSays('isn’t on this server');
await pause(300);
await shot('local-model-missing', '#settings-local-model', LIGHT);
serverModels = LOCAL_MODELS;
await win.locator('.modal button', { hasText: /^\s*Refresh\s*$/ }).click();
await pause(800);
await win.locator('#settings-local-model').selectOption(LOCAL_MODELS[0]);
await pause(300);

// The same dialog in a small window.
await win.setViewportSize({ width: 860, height: 600 });
await pause(300);
await shot('compact-local', '#settings-local-url', LIGHT);
await win.setViewportSize({ width: 1280, height: 900 });
await pause(300);

// A server with nothing loaded.
serverModels = [];
await win.locator('#settings-local-model').selectOption('');
await pause(250);
await win.locator('.modal button', { hasText: /^\s*Refresh\s*$/ }).click();
await statusSays('No models loaded');
await pause(300);
await shot('local-no-models', PROBLEM, LIGHT);
serverModels = LOCAL_MODELS;

// An address that is not one.
await urlInput.fill('not a server address');
await pause(250);
await shot('local-invalid-url', '#settings-local-url[aria-invalid="true"]', LIGHT);

// A server on another machine: refused until allowed, then warned about. `.invalid` never resolves, so
// nothing leaves this computer.
await urlInput.fill('http://models.harbour-lane.invalid:11434/v1');
await pause(250);
await shot('local-remote-blocked', '.modal [role="switch"]', LIGHT);
await win.getByRole('switch', { name: 'Allow a server on another machine' }).click();
await win.locator('.modal .settings-remote-warning').first().waitFor();
await pause(600);
await shot('local-remote-allowed', '.modal .settings-remote-warning');
// A different machine typed while one is allowed: leaving the field does not switch to it, the status asks first.
await urlInput.fill('http://gpu-box.harbour-lane.invalid:8080/v1');
await urlInput.press('Tab');
await win.locator(STATUS, { hasText: 'Switch to' }).first().waitFor();
await pause(300);
await shot('local-remote-switch', STATUS, LIGHT);
await win.locator('.modal button', { hasText: 'Keep current server' }).waitFor();
await urlInput.fill('http://models.harbour-lane.invalid:11434/v1');
await urlInput.press('Enter');
await pause(300);
await win.getByRole('switch', { name: 'Allow a server on another machine' }).click();
await pause(300);
await typeServer(FIXTURE_URL);
await chooseProvider('OpenAI');
await closeSettings();

// ---- A key from the environment (development builds only) ----
await win.evaluate(() => window.builder.ai.setKey('openai', null));
await app.evaluate((_electron, key) => void (process.env.OPENAI_API_KEY = key), PLACEHOLDER_KEY);
await openSettings('AI assistant');
await win.locator('.settings-key-saved').waitFor();
await pause(300);
await shot('openai-environment', '.settings-key-saved', LIGHT);
await app.evaluate(() => void (process.env.OPENAI_API_KEY = ''));
await closeSettings();

await app.close();
server.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`settings capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
