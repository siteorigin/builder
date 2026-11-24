// Design capture for the source and code editing dialogs (SourceModal.tsx, CodeEditor.tsx): a new component at
// rest and filled in, an editable component at rest, edited, leaving the editor, with a live diagnostic and its
// tooltip, checking, refused and saved, the discard prompt, the Properties tab, a newer version arriving under
// unsaved edits, read-only managed source, generated page source and a small window.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/code-editor.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a
// state that did not render. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('code editor capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'code-editor');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-code-')));
const THEMES = ['light', 'dark'];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const NAME = 'Booking enquiry card';

const SOURCE = `<script>
	let {
		heading = 'Book a table at Harbour Lane',
		text = 'Tell us when you would like to visit and we will confirm within the hour.',
		seats = 4
	} = $props();

	let guests = $state(2);
	let sent = $state(false);
	const remaining = $derived(seats - guests);

	function submit(event) {
		event.preventDefault();
		sent = true;
	}
</script>

<section class="booking" aria-labelledby="booking-title">
	<h2 id="booking-title">{heading}</h2>
	<p>{text}</p>
	{#if sent}
		<p role="status">Thanks. We will be in touch shortly about your table for {guests}.</p>
	{:else}
		<form onsubmit={submit}>
			<label>
				Guests
				<input type="number" min="1" max={seats} bind:value={guests} />
			</label>
			<small>{remaining} seats left at this sitting</small>
			<button type="submit">Request booking</button>
		</form>
	{/if}
</section>

<style>
	.booking {
		padding: var(--so-space-section) var(--so-container-gutter);
		max-width: var(--so-container-content);
		margin-inline: auto;
	}
	h2 {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
	}
	form {
		display: grid;
		gap: var(--so-space-sm);
	}
</style>
`;
const BROKEN = SOURCE.replace('<h2 id="booking-title">{heading}</h2>', '<h2 id="booking-title">{heading</h2>');
if (BROKEN === SOURCE) throw new Error('the broken fixture did not change the source');

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1280, height: 900 });
await win.waitForSelector('.welcome', { timeout: 120000 });
await win.emulateMedia({ reducedMotion: 'reduce' });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** The live check has reported on the code on screen, so both themes show the same result. */
const settled = () => win.waitForFunction(() => !document.querySelector('.modal .code-status')?.textContent?.includes('Checking'), null, { timeout: 30000 });

/** Capture the dialog (or the whole window) in each theme; every `checks` selector must be visible then. */
async function shot(state, checks, { themes = THEMES, full = false, hover = false } = {}) {
  await settled();
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!hover) await win.mouse.move(2, 2);
    await pause(350);
    for (const check of [].concat(checks)) {
      const visible = await win.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    if (full) await win.screenshot({ path });
    else await win.locator('.modal').last().screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Replace the editor's document the way a paste does, so no auto-indent rewrites the fixture. */
async function setDoc(text) {
  await win.locator('.modal .cm-content').click();
  await win.keyboard.press(`${MOD}+A`);
  await win.keyboard.insertText(text);
  await pause(150);
}

/** Hold the next validation calls in the main process, so the checking state stays on screen. */
const holdValidation = () =>
  app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const real = handlers.get('project:validateSource');
    globalThis.__designRelease = null;
    const gate = new Promise((resolve) => (globalThis.__designRelease = resolve));
    handlers.set('project:validateSource', async (...args) => {
      await gate;
      return real(...args);
    });
    globalThis.__designRestore = () => handlers.set('project:validateSource', real);
  });
const releaseValidation = () =>
  app.evaluate(() => {
    globalThis.__designRelease?.();
    globalThis.__designRestore?.();
  });

const closeDialog = async () => {
  await win.locator('.modal').last().getByRole('button', { name: 'Close', exact: true }).first().click();
  await win.locator('.modal').first().waitFor({ state: 'detached' });
};

// ---- A populated project, in Developer mode ----
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
if (!created.ok) throw new Error(`project creation failed: ${created.message}`);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60000 });
await pause(1200);
await win.locator('[aria-label="Settings"]').click();
await win.locator('.modal [role="tab"][aria-selected="true"]').press('End');
await win.getByRole('tab', { name: 'AI assistant', selected: true }).waitFor();
await win.getByRole('tab', { name: 'AI assistant' }).press('Home');
await win.getByRole('tab', { name: 'General', selected: true }).waitFor();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- New code component ----
await win.locator('.rail [aria-label="Insert"]').click();
await win.getByRole('button', { name: 'New code component' }).click();
await win.locator('.modal .cm-content').waitFor();
await shot('new-rest', ['.modal .cm-content', 'input[placeholder="Booking widget"]']);
await win.fill('input[placeholder="Booking widget"]', NAME);
await setDoc(SOURCE);
// Named and written: the draft shows as unsaved, and the action is ready.
await win.locator('.modal .code-chip.unsaved').waitFor({ timeout: 5000 });
await shot('new-filled', ['.modal .code-chip.unsaved', '.modal .tab .code-tab-dot']);
await win.getByRole('button', { name: 'Create and insert' }).click();
await win.locator('.modal').waitFor({ state: 'detached', timeout: 60000 });
// The starter's Heading and Text properties keep their own defaults, so wait on text the source alone sets.
await frame.getByText('Request booking').first().waitFor({ timeout: 60000 });
await pause(800);

// ---- The editable component ----
await win.locator('.rail [aria-label="Layers"]').click();
await win.getByRole('treeitem', { name: new RegExp(NAME) }).first().click();
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'component' })));
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Edit code' }).first().click();
await win.locator('.modal .cm-content').waitFor();
await pause(500);
// The stored code must be on screen with nothing to save: a blank editor here would save over the component.
await win.locator('.modal .cm-content').getByText('Request booking').first().waitFor({ timeout: 15000 });
if (await win.getByRole('button', { name: 'Save', exact: true }).isEnabled()) throw new Error('Save is enabled with no edits; refusing to write');
await shot('source-rest', ['.modal .cm-content', '.modal .cm-lineNumbers']);

await setDoc(SOURCE.replace('Request booking', 'Request a table'));
await win.getByRole('button', { name: 'Save', exact: true }).waitFor();
await shot('source-dirty', ['.modal .cm-content']);

// Escape in the editor offers the way out instead of closing the dialog.
await win.keyboard.press('Escape');
await win.locator('.modal .code-status-hint', { hasText: 'Press Tab' }).waitFor({ timeout: 5000 });
await shot('source-leave', ['.modal .code-status-hint.active']);

// A live compiler diagnostic: the strip names it, and its jump puts the caret on the line.
await setDoc(BROKEN);
await win.waitForSelector('.modal .cm-lint-marker-error', { timeout: 30000 });
await win.locator('.modal button.code-status-problems').click();
await pause(300);
await shot('source-lint', ['.modal .cm-lint-marker-error', '.modal button.code-status-problems']);
// Its tooltip on the gutter mark names the severity and the line.
await win.locator('.modal .cm-lint-marker-error').first().hover();
await win.waitForSelector('.cm-tooltip-lint', { timeout: 10000 });
await shot('source-lint-tooltip', ['.cm-tooltip-lint', '.cm-tooltip-lint .code-diag-kind'], { hover: true });
await win.mouse.move(2, 2);
await win.locator('.cm-tooltip-lint').waitFor({ state: 'detached', timeout: 10000 });

// Checking: the validation call is held in the main process while the dialog waits on it.
await holdValidation();
await win.getByRole('button', { name: 'Review errors', exact: true }).click();
await win.locator('.modal').getByText('Checking your code').first().waitFor({ timeout: 10000 });
await shot('source-checking', ['.modal .cm-content']);
await releaseValidation();

// Save refused: no AI provider is connected, so the compiler's problems are listed and focus goes to the list.
await win.locator('.modal').getByText('Connect an AI provider').first().waitFor({ timeout: 30000 });
await pause(300);
if (!(await win.evaluate(() => !!document.activeElement?.closest('.code-problems')))) throw new Error('focus did not move to the problems list; refusing to write');
await shot('source-save-error', ['.modal .cm-content', '.modal >> text=Connect an AI provider']);

// The compact window keeps the code, the problems and the actions on screen.
await win.setViewportSize({ width: 1024, height: 640 });
await pause(500);
await shot('compact-error', ['.modal .cm-content'], { full: true });
await win.setViewportSize({ width: 1280, height: 900 });
await pause(400);

// The discard prompt over unsaved code.
await win.locator('.modal').last().getByRole('button', { name: 'Close', exact: true }).first().click();
await win.getByRole('button', { name: 'Keep editing' }).waitFor();
await shot('discard-confirm', ['text=Keep editing'], { full: true });
await win.getByRole('button', { name: 'Keep editing' }).click();
await win.getByRole('button', { name: 'Keep editing' }).waitFor({ state: 'detached' });

// A clean save, with its confirmation.
await setDoc(SOURCE.replace('Request booking', 'Request a table'));
await win.getByRole('button', { name: 'Save', exact: true }).click();
await win.locator('.modal').getByText('Saved. Every page using this component is updated.').waitFor({ timeout: 30000 });
await pause(300);
await shot('source-saved', ['.modal >> text=Saved. Every page', '.modal .cm-content'], { full: true });

await win.getByRole('tab', { name: /^Properties/ }).click();
await win.locator('.modal .schema-row').first().waitFor();
await shot('source-properties', ['.modal .schema-row']);
await win.getByRole('tab', { name: 'Svelte source' }).click();
await win.locator('.modal .cm-content').waitFor();

// A newer version arrives underneath unsaved edits (the AI, an undo): the dialog says so rather than save over it.
await setDoc(SOURCE.replace('Request booking', 'Ask for a table'));
const defId = await win.evaluate(async (name) => Object.entries((await window.builder.project.snapshot()).state.components).find(([, d]) => d.name === name)?.[0], NAME);
if (!defId) throw new Error('the component definition was not found');
await win.evaluate(([id, source]) => window.builder.project.apply({ operations: [{ type: 'component.updateSource', definitionId: id, source }] }, { label: 'Outside edit' }), [defId, SOURCE.replace('Request booking', 'Book now')]);
await win.locator('.modal .source-stale', { hasText: 'This code changed' }).waitFor({ timeout: 15000 });
await shot('source-conflict', ['.modal .source-stale', '.modal >> text=Use the newer code']);
await win.getByRole('button', { name: 'Use the newer code' }).click();
await win.locator('.modal .source-stale').waitFor({ state: 'detached' });
await closeDialog();

// ---- Read-only managed source ----
await win.getByRole('treeitem', { name: /Hero/i }).first().click();
await pause(700);
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'component' })));
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'View source' }).first().click();
await win.locator('.modal .cm-content').waitFor();
await pause(500);
await shot('readonly', ['.modal .cm-content', '.modal >> text=Convert to code']);
await closeDialog();

// ---- Generated page source ----
await win.keyboard.press('Escape');
await pause(400);
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'page-adv' })));
await pause(400);
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'View generated source' }).first().click();
await win.locator('.modal .cm-content').waitFor();
await pause(500);
await shot('page-source', ['.modal .cm-content']);
await closeDialog();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`code editor capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
