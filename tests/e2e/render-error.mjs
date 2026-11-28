// A code component that throws while the page renders (#1526), through the real preview: inserted, it shows a note in
// its place and every other section stays; the page problem bar names it and its error, with Open source (Create and
// insert is two changes, so no Revert), and the status bar says the preview has a problem. Loaded afresh (the throw now on the server), the same. Fixed in
// its source, it comes back. A `$effect` that writes what it reads is reported the same way.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const BROKEN = `<script>
\tlet { class: className = '', data = undefined } = $props();
</script>

<section class={className}><p>Value: {data.nested.value}</p></section>
`;
const FIXED = `<script>
\tlet { class: className = '', data = undefined } = $props();
</script>

<section class={className}><p>Value: {data?.nested?.value ?? 'none yet'}</p></section>
`;
const LOOP = `<script>
\tlet { class: className = '' } = $props();
\tlet count = $state(0);
\t$effect(() => {
\t\tcount = count + 1;
\t});
</script>

<section class={className}><p>Count: {count}</p></section>
`;

const { WORK, cleanup } = scratch('render-error');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Render Errors', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
const issue = win.locator('.canvas-notice.issue');
const detail = issue.locator('.issue-detail');
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r;
  }, [operations, label]);
async function frame() {
  const content = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  if (!content) throw new Error('the preview frame has no page');
  return content;
}
const inFrame = (fn, arg) => eventually(async () => (await frame()).evaluate(fn, arg), 10000);
const buttons = () => issue.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent.trim()));
await win.evaluate(() => {
  window.__lastWorkingReport = Date.now();
  window.addEventListener('message', (e) => {
    if (['ready', 'navigated', 'revisionApplied'].includes(e.data?.type)) window.__lastWorkingReport = Date.now();
  });
});
/** Long enough for the page to count as working (1.5 s without an error), the sighting Revert works from. */
const settle = () => eventually(async () => assert.ok(await win.evaluate(() => Date.now() - window.__lastWorkingReport > 1700), 'the preview has had a quiet working interval'), 30000);

const s0 = await snapshot();
const home = s0.state.pages[s0.state.site.homePageId];
const owner = { kind: 'page', id: home.id };
const [heroId, nextId] = home.rootIds;
const sectionsShown = () => inFrame((ids) => ids.every((id) => !!document.querySelector(`[data-so-node="${id}"]`)), [heroId, nextId]);

step('a code component that throws as it is inserted shows a note in its place, and the bar names it and its error');
await settle();
const made = await apply([{ type: 'component.createCode', name: 'Nested value', source: BROKEN }], 'Create code component');
const defId = made.results[0].definitionId;
await apply([{ type: 'node.insert', owner, parentId: null, index: 1, definitionId: defId }], 'Insert Nested value');
await detail.waitFor({ timeout: 30000 });
assert.match(await detail.innerText(), /^Nested value: Cannot read properties of undefined \(reading 'nested'\)/);
// Created and inserted, as Create and insert does: two changes since the page last worked, so no Revert (#738).
await eventually(async () => assert.deepEqual(await buttons(), ['Project health', 'Open source', 'Try again']), 10000);
assert.ok(await sectionsShown(), 'the sections before and after it are still on the page');
assert.match(await inFrame(() => document.querySelector('[data-so-render-error]')?.textContent ?? ''), /Nested value couldn’t be shown/);
await win.locator('.status-bar .preview-status.error', { hasText: 'Preview problem' }).waitFor({ timeout: 10000 });
assert.equal(await detail.getAttribute('title'), await detail.innerText(), 'the whole of the error on hover');

step('Open source opens the component that threw');
await issue.getByRole('button', { name: 'Open source' }).click();
await win.getByRole('textbox', { name: /Nested value Svelte source/ }).waitFor({ timeout: 10000 });
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

step('loaded afresh, where the page is rendered on the server first, the page still opens and says the same');
const sessionBefore = await inFrame(() => window.name);
await issue.getByRole('button', { name: 'Try again' }).click();
await eventually(async () => assert.notEqual(await inFrame(() => window.name), sessionBefore, 'the preview loads again'), 30000);
await eventually(async () => assert.match(await detail.innerText(), /^Nested value: Cannot read properties of undefined \(reading 'nested'\)/), 30000);
assert.ok(await sectionsShown(), 'the page opened with its other sections');

step('fixed in its source, the component comes back and the problem clears');
await apply([{ type: 'component.updateSource', definitionId: defId, source: FIXED }], 'Fix Nested value');
await issue.waitFor({ state: 'detached', timeout: 30000 });
await eventually(async () => assert.match(await inFrame(() => document.body.innerText), /Value: none yet/), 30000);
assert.equal(await inFrame(() => document.querySelectorAll('[data-so-render-error]').length), 0, 'no note is left');

step('a $effect that writes what it reads is reported the same way, and Undo takes it away');
await settle();
const loop = await apply([{ type: 'component.createCode', name: 'Looping counter', source: LOOP }], 'Create looping counter');
await apply([{ type: 'node.insert', owner, parentId: null, index: 1, definitionId: loop.results[0].definitionId }], 'Insert Looping counter');
await detail.waitFor({ timeout: 30000 });
assert.match(await detail.innerText(), /^Looping counter: .*(update depth|effect_update_depth_exceeded)/is);
assert.ok(await sectionsShown(), 'the other sections are still on the page');
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
await issue.waitFor({ state: 'detached', timeout: 60000 });
await eventually(async () => assert.equal(await inFrame(() => document.querySelectorAll('[data-so-render-error]').length), 0), 30000);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nrender-error: passed');
