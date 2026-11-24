// UI snapshots of the editor and its live preview (tests/driver, issue #492), against the built app in an isolated
// session. One observation covers the editor's own controls and the site inside its preview, by role and name, with
// regions and the page's own element ids, bounded and drilled into by ref. Two controls with the same name are told
// apart by region, the preview's heading is located, selected (through the exact element its ref names) and seen as
// the editor's selection. A dialog over the editor, focus, visitor mode and an unhydrated preview are reported; a
// credential typed into Settings never comes back; a preview reload and a project switch make old refs stale, never
// another element; and the generated project carries none of the editor's markers.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { flatten } from '../driver/observe.ts';
import { Session } from '../driver/session.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('snapshot');
const session = new Session({ parentDir: WORK });
let passed = false;
let n = 0;
const call = (op, args) => session.call({ v: 1, id: `s${++n}`, op, ...(args ? { args } : {}) });
const ok = (reply, what) => {
  assert.equal(reply.ok, true, `${what}: ${reply.ok ? '' : `${reply.error.code} ${reply.error.message}`}`);
  return reply.result;
};
const failed = (reply, code, what) => {
  assert.equal(reply.ok, false, `${what}: expected ${code}, got a result`);
  assert.equal(reply.error.code, code, `${what}: ${reply.error.code} ${reply.error.message}`);
  return reply.error;
};
const snapshot = async (args = {}, what = 'ui.snapshot') => ok(await call('ui.snapshot', args), what);
const locate = async (args, what = `ui.locate ${JSON.stringify(args)}`) => ok(await call('ui.locate', args), what);
/** Act through the exact element a ref names, as a person would on that element. */
const press = async (ref) => {
  const el = await session.elementFor(ref);
  try {
    await el.click();
  } finally {
    await el.dispose();
  }
};
const SECRET = 'sk-SENTINEL-4b8e2d19c07a';
const HEADING = 'Calm, considered spaces for everyday life';
/** Every file under `dir`, skipping folders named in `skip`. */
const files = (dir, skip) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (skip.includes(name)) return [];
    return statSync(path).isDirectory() ? files(path, skip) : [path];
  });

try {
  await session.start({ fixture: 'business-v1' });

  step('one bounded observation covers the editor and the site in its preview, with context and screenshots');
  const first = await snapshot({ screenshot: true });
  assert.equal(first.context.screen, 'editor');
  assert.equal(first.context.mode, 'edit');
  assert.equal(first.context.dialog, null);
  assert.equal(first.context.selection, null, 'nothing is selected yet');
  assert.deepEqual(first.context.preview, { state: 'ready', path: '/', editing: true });
  assert.ok(first.editor.shown + first.preview.shown <= 200, 'the default bounds hold');
  assert.ok(first.editor.total > first.editor.shown || first.preview.total > first.preview.shown, 'a full outline is larger than one observation');
  const editorNodes = flatten(first.editor.nodes);
  const previewNodes = flatten(first.preview.nodes);
  assert.ok(editorNodes.some((x) => x.role === 'toolbar' && x.name === 'Panels'), 'the editor’s named toolbar is there');
  assert.ok(editorNodes.some((x) => x.role === 'button' && x.name === 'Edit' && x.pressed === true), 'pressed state is reported');
  assert.ok(previewNodes.some((x) => x.role === 'heading' && x.level === 1 && x.semantic?.node === 'heading'), 'the preview is observed, not an iframe placeholder, with the page’s own element ids');
  assert.ok(previewNodes.some((x) => x.offscreen), 'mounted content below the fold is reported as out of view');
  assert.ok([...editorNodes, ...previewNodes].every((x) => x.role === 'text' || x.ref), 'every element observed has a ref');
  for (const shot of [first.screenshots.editor, first.screenshots.preview]) {
    assert.ok(shot && shot.path.startsWith(session.paths.artifacts), 'screenshots go in the session’s artifacts');
    assert.deepEqual([...readFileSync(shot.path).subarray(1, 4)], [...Buffer.from('PNG')], `${shot.path} is a PNG`);
  }
  assert.ok(first.screenshots.preview.clip.width > 100 && first.screenshots.preview.clip.height > 100, 'the preview is captured as it shows in the editor');

  step('what the bounds left out is reached by drilling in with a ref');
  const small = await snapshot({ maxNodes: 12 });
  const cut = [...flatten(small.editor?.nodes ?? []), ...flatten(small.preview?.nodes ?? [])].find((x) => x.more?.continue);
  assert.ok(cut, 'a truncated node says how to continue');
  const inside = await snapshot(cut.more.continue);
  assert.equal(inside.within.ref, cut.ref);
  assert.ok((inside.editor ?? inside.preview).nodes.length > 0, 'its children are observed');

  step('two links named the same are told apart by region');
  const both = failed(await call('ui.locate', { role: 'link', name: 'About' }), 'AMBIGUOUS_TARGET', 'About is ambiguous');
  assert.equal(both.details.count, 2);
  assert.deepEqual(
    both.details.candidates.map((c) => c.region[0]),
    ['banner', 'contentinfo'],
    'the candidates name their regions'
  );
  const header = await locate({ role: 'link', name: 'About', region: 'banner' });
  const footer = await locate({ role: 'link', name: 'About', region: 'contentinfo' });
  assert.notEqual(header.node.ref, footer.node.ref);
  assert.deepEqual(header.region, both.details.candidates[0].region);
  assert.ok(both.details.candidates.map((c) => c.ref).includes(footer.node.ref), 'a candidate’s ref is the element located by region');
  // The editor's own controls are found the same way: the Panels rail's Pages button, not the sidebar's Pages list.
  const pages = await locate({ role: 'button', name: 'Pages', region: 'Panels' });
  assert.deepEqual(pages.region, ['toolbar "Panels"']);
  failed(await call('ui.locate', { role: 'button', name: 'No such control' }), 'TARGET_NOT_FOUND', 'a missing control');

  step('the preview’s heading is located, selected, and seen as the editor’s selection');
  const heading = await locate({ role: 'heading', name: HEADING, scope: 'preview' });
  assert.equal(heading.scope, 'preview');
  assert.equal(heading.node.semantic.node, 'heading');
  assert.deepEqual(ok(await call('ui.locate', { ref: heading.node.ref }), 'the ref again').node, heading.node, 'a ref looked at again is the same element');
  await press(heading.node.ref);
  // The first click on a section selects the section itself (Split hero); the next steps in to the heading.
  const section = await eventually(async () => {
    const s = (await snapshot()).context.selection;
    assert.ok(s?.shown, 'something is selected');
    assert.match(s.toolbar ?? '', / actions$/, 'the canvas toolbar for the selection is drawn');
    return s;
  });
  assert.equal(section.toolbar, 'Split hero actions');
  assert.notDeepEqual(section.semantic, heading.node.semantic);
  // A section's own element has no role of its own, so no observed element stands for it.
  assert.deepEqual(section.refs, []);
  await new Promise((r) => setTimeout(r, 700)); // Not a double-click: that would start editing the text.
  await press(heading.node.ref);
  const selected = await eventually(async () => {
    const s = (await snapshot()).context.selection;
    assert.deepEqual(s?.semantic, heading.node.semantic, 'the heading is the selection');
    assert.equal(s.toolbar, 'Heading actions');
    return s;
  });
  assert.deepEqual(selected.refs, [heading.node.ref], 'the selection names the heading’s own ref');

  step('a dialog over the editor, focus in it, and a credential that never comes back');
  const settings = await locate({ role: 'button', name: 'Settings', scope: 'editor' });
  await press(settings.node.ref);
  const dialogOpen = await eventually(async () => {
    const s = await snapshot();
    assert.equal(s.context.dialog?.name, 'Settings');
    return s;
  });
  assert.ok(dialogOpen.context.dialog.ref, 'the dialog has a ref');
  const behind = await locate({ ref: settings.node.ref });
  assert.equal(behind.node.blocked, true, 'what the dialog covers is reported as blocked');
  await press((await locate({ role: 'tab', name: 'AI assistant', within: dialogOpen.context.dialog.ref })).node.ref);
  const field = await eventually(() => locate({ role: 'textbox', name: 'API key (optional)', scope: 'editor' }));
  const input = await session.elementFor(field.node.ref);
  await input.fill(SECRET);
  await input.dispose();
  const typed = await call('ui.snapshot', { scope: 'editor', maxNodes: 1000 });
  const again = await call('ui.locate', { ref: field.node.ref });
  for (const reply of [typed, again]) assert.ok(!JSON.stringify(reply).includes(SECRET.slice(3)), 'the key is in no reply');
  assert.equal(ok(again, 'the key field').node.redacted, true, 'the key field says its value was left out');
  assert.equal(typed.result.context.focus?.name, 'API key (optional)', 'focus is reported');
  assert.equal(typed.result.context.focus.ref, field.node.ref);
  // Closing with a key typed but not saved asks first: that question is now the topmost dialog.
  await session.page.keyboard.press('Escape');
  const asked = await eventually(async () => {
    const d = (await snapshot()).context.dialog;
    assert.equal(d?.name, 'Save the API key you entered?');
    return d;
  });
  assert.ok(!JSON.stringify(await call('ui.snapshot', { within: asked.ref })).includes(SECRET.slice(3)), 'nor in the question about it');
  await press((await locate({ role: 'button', name: 'Discard', within: asked.ref })).node.ref);
  await eventually(async () => assert.equal((await snapshot()).context.dialog, null, 'the dialogs closed'));

  step('visitor mode is told apart from a preview still loading');
  await press((await locate({ role: 'button', name: 'Preview', region: 'Mode' })).node.ref);
  await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context;
    assert.equal(c.mode, 'preview');
    assert.deepEqual(c.preview, { state: 'ready', path: '/', editing: false });
  });
  await press((await locate({ role: 'button', name: 'Edit', region: 'Mode' })).node.ref);
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.preview.editing, true));

  step('a preview reloading is loading until its page is hydrated, and its old refs are stale');
  let release;
  const held = new Promise((r) => (release = r));
  const hold = (url) => /siteorigin-bridge/.test(url.href);
  await session.app.context().route(hold, async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  const previewFrame = await (await session.page.$('.frame-box iframe')).contentFrame();
  await previewFrame.evaluate(() => location.reload()).catch(() => undefined);
  const loading = await eventually(async () => {
    const s = await snapshot({ scope: 'preview' });
    assert.equal(s.context.preview.state, 'loading');
    assert.ok(s.preview?.nodes.length, 'the page is there to see');
    return s;
  }, 30000);
  assert.equal(loading.preview.refs, false, 'a page not yet hydrated gives no refs to act on');
  assert.ok(flatten(loading.preview.nodes).every((x) => !x.ref));
  const whileLoading = failed(await call('ui.locate', { ref: heading.node.ref }), 'STALE_REF', 'a ref while the page loads');
  assert.ok(whileLoading.details.hint, 'a stale ref says how to get a fresh one');
  release();
  await session.app.context().unroute(hold);
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.preview.state, 'ready'), 60000);
  const reloaded = failed(await call('ui.locate', { ref: heading.node.ref }), 'STALE_REF', 'a ref from before the reload');
  assert.equal(reloaded.details.reason, 'document');
  assert.match(reloaded.details.hint, /ui\.snapshot/);
  await assert.rejects(session.elementFor(heading.node.ref), (e) => e.code === 'STALE_REF', 'nothing can act through it either');
  const fresh = await locate({ role: 'heading', name: HEADING, scope: 'preview' });
  assert.notEqual(fresh.node.ref, heading.node.ref, 'the same heading in the new page has a new ref');
  assert.deepEqual(fresh.node.semantic, heading.node.semantic);

  step('opening another project makes every ref from the last one stale');
  const settingsBefore = (await locate({ role: 'button', name: 'Settings', scope: 'editor' })).node.ref;
  const created = await session.page.evaluate((parentDir) => window.builder.projects.create({ name: 'Second Business', starter: 'business', sampleImages: false, parentDir }), session.paths.projects);
  assert.equal(created.ok, true, `the second project was made: ${created.message ?? ''}`);
  await eventually(async () => {
    const s = await snapshot({ maxNodes: 20 });
    assert.equal(s.context.preview.state, 'ready');
    const r = await call('ui.locate', { ref: settingsBefore });
    assert.equal(r.ok ? 'ok' : r.error.details?.reason, 'project');
  }, 90000);
  assert.equal(failed(await call('ui.locate', { ref: fresh.node.ref }), 'STALE_REF', 'a preview ref from the last project').details.reason, 'project');
  const now = await locate({ role: 'heading', name: HEADING, scope: 'preview' });
  assert.notEqual(now.node.ref, fresh.node.ref);
  failed(await call('ui.locate', { ref: 'ffff:1' }), 'STALE_REF', 'a ref this session never gave out');

  step('the projects carry none of the editor’s markers');
  for (const file of files(session.paths.projects, ['.siteorigin', 'node_modules'])) {
    const text = readFileSync(file, 'utf8');
    for (const marker of ['data-so-bridge', 'data-selection', 'data-opening']) assert.ok(!text.includes(marker), `${file} has no ${marker}`);
  }

  passed = true;
  console.log('\nsnapshot: all checks passed');
} finally {
  await session.close({ failed: !passed }).catch((e) => console.error('close failed', e));
  if (passed) cleanup();
}
