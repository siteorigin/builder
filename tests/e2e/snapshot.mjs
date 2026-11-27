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
import { eventually, scratch, step, withTimeout } from './harness.mjs';

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
/** Pieces of the key, any of which in a reply would be a leak. */
const FRAGMENTS = ['SENTINEL', '4b8e2d19c07a', 'SENTINEL-4b8e'];
const leaks = (reply) => FRAGMENTS.filter((f) => JSON.stringify(reply).includes(f));
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
  // The first observation after starting: the fixture waits for the page to take the editor's mode.
  const first = await eventually(async () => {
    const observation = await snapshot({ screenshot: true });
    assert.equal(observation.context.preview.state, 'ready', 'the preview is ready for the first observation');
    return observation;
  }, 60000);
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
  assert.ok(editorNodes.some((x) => x.role === 'radio' && x.name === 'Edit' && x.checked === true), 'the selected mode is reported');
  const previewDetail = flatten((await snapshot({ scope: 'preview', maxNodes: 1000 })).preview.nodes);
  const h1 = previewDetail.find((x) => x.role === 'heading' && x.level === 1 && x.name === HEADING && x.ref);
  assert.ok(h1, 'the preview is observed, not an iframe placeholder, with its heading');
  const h1Element = await session.elementFor(h1.ref);
  try {
    assert.ok(await h1Element.evaluate((el) => el.closest('[data-so-node]')?.getAttribute('data-so-node')), 'the heading belongs to an identified page component');
  } finally {
    await h1Element.dispose();
  }
  assert.ok(previewNodes.some((x) => x.offscreen), 'mounted content below the fold is reported as out of view');
  assert.ok([...editorNodes, ...previewNodes].every((x) => x.role === 'text' || x.ref), 'every element observed has a ref');
  assert.equal(first.screenshots.withheld, undefined);
  for (const shot of [first.screenshots.editor, first.screenshots.preview]) {
    assert.ok(shot && shot.path.startsWith(session.paths.artifacts), 'screenshots go in the session’s artifacts');
    assert.deepEqual([...readFileSync(shot.path).subarray(1, 4)], [...Buffer.from('PNG')], `${shot.path} is a PNG`);
  }
  assert.ok(first.screenshots.preview.clip.width > 100 && first.screenshots.preview.clip.height > 100, 'the preview is captured as it shows in the editor');

  step('what the bounds left out is reached by drilling in with a ref, resuming exactly where it stopped');
  const small = await snapshot({ scope: 'preview', maxNodes: 12 });
  // A node some of whose children were shown: its continuation resumes after the last of them.
  const cut = flatten(small.preview.nodes).find((x) => x.more?.continue?.after && x.children?.length);
  assert.ok(cut, 'a node cut short says how to continue');
  const all = await snapshot({ within: cut.ref, maxNodes: 1000, depth: 0 });
  const everyChild = all.preview.nodes.map((x) => x.ref ?? x.text);
  assert.deepEqual(everyChild.slice(0, cut.children.length), cut.children.map((x) => x.ref ?? x.text), 'the children shown come first');
  const rest = await snapshot({ ...cut.more.continue, depth: 0 });
  assert.equal(rest.within.ref, cut.ref);
  assert.deepEqual(rest.preview.nodes.map((x) => x.ref ?? x.text), everyChild.slice(cut.children.length), 'the continuation is exactly the children left out');
  assert.equal(rest.preview.nodes.length, cut.more.children);
  // The top of a scope continues the same way.
  const top = await snapshot({ scope: 'editor', maxNodes: 3, depth: 0 });
  assert.ok(top.editor.more?.continue?.scope === 'editor', 'the scope’s own top level says how to continue');
  const after = await snapshot({ ...top.editor.more.continue, maxNodes: 1000, depth: 0 });
  assert.equal(after.editor.nodes.length, top.editor.more.children);
  assert.ok(!after.editor.nodes.some((x) => top.editor.nodes.some((y) => y.ref && y.ref === x.ref)), 'nothing shown twice');

  step('two links named the same are told apart by region');
  const both = failed(await call('ui.locate', { role: 'link', name: 'About' }), 'AMBIGUOUS_TARGET', 'About is ambiguous');
  assert.equal(both.details.count, 2);
  assert.deepEqual(
    both.details.candidates.map((c) => c.region[0]),
    ['banner', 'contentinfo'],
    'the candidates name their regions'
  );
  assert.match(both.details.hint, /region/);
  const header = await locate({ role: 'link', name: 'About', region: 'banner' });
  const footer = await locate({ role: 'link', name: 'About', region: 'contentinfo' });
  assert.notEqual(header.node.ref, footer.node.ref);
  assert.equal(header.node.ref, both.details.candidates[0].ref, 'the header’s candidate is the header’s link');
  assert.equal(footer.node.ref, both.details.candidates[1].ref, 'the footer’s candidate is the footer’s link');
  assert.deepEqual(header.region, both.details.candidates[0].region);
  assert.equal(footer.node.offscreen, true, 'the footer’s link is mounted but below the fold');
  assert.equal(header.node.offscreen, undefined);
  // A name matched in part, case aside, finds the same link; matched exactly, case counts.
  assert.equal((await locate({ role: 'link', name: 'ABOU', exact: false, region: 'banner' })).node.ref, header.node.ref);
  failed(await call('ui.locate', { role: 'link', name: 'about', region: 'banner' }), 'TARGET_NOT_FOUND', 'an exact name in the wrong case');
  // The editor's own controls are found the same way: the Panels rail's Pages button, not the sidebar's Pages list.
  const pages = await locate({ role: 'button', name: 'Pages', region: 'Panels' });
  assert.deepEqual(pages.region, ['toolbar "Panels"']);
  failed(await call('ui.locate', { role: 'button', name: 'No such control' }), 'TARGET_NOT_FOUND', 'a missing control');

  step('the preview’s heading is located, selected, and seen as the editor’s selection');
  const heading = await eventually(() => locate({ role: 'heading', name: HEADING, scope: 'preview' }), 30000);
  assert.equal(heading.scope, 'preview');
  assert.ok(heading.node.ref, 'the heading has a stable element reference');
  const headingIdentity = await (async () => {
    const element = await session.elementFor(heading.node.ref);
    try {
      return element.evaluate((el) => {
        const host = el.closest('[data-so-node]');
        return { ctx: host?.getAttribute('data-so-ctx'), node: host?.getAttribute('data-so-node') };
      });
    } finally {
      await element.dispose();
    }
  })();
  assert.deepEqual(ok(await call('ui.locate', { ref: heading.node.ref }), 'the ref again').node, heading.node, 'a ref looked at again is the same element');
  await press(heading.node.ref);
  // The packed code section owns the heading; clicking it selects the component.
  const section = await eventually(async () => {
    const s = (await snapshot()).context.selection;
    assert.equal(s?.shown, true, 'something is selected');
    assert.equal(s.toolbar, 'Split hero actions', 'the section is selected and its toolbar drawn');
    assert.equal(s.outlined, true);
    assert.equal(s.semantic.ctx, headingIdentity.ctx, 'the heading’s own section');
    return s;
  });
  assert.equal(section.semantic.node, headingIdentity.node);
  // A section's own element has no role of its own, so no observed element stands for it.
  assert.deepEqual(section.refs, []);
  const selected = await eventually(async () => {
    const s = (await snapshot()).context.selection;
    assert.deepEqual(s?.semantic, headingIdentity, 'the heading’s component is the selection');
    assert.equal(s.toolbar, 'Split hero actions');
    assert.deepEqual(s.refs, [], 'the code component has no accessible role of its own');
    return s;
  });
  assert.equal(selected.outlined, true);
  assert.equal(selected.element?.owner?.kind, 'page', 'the selection as the editor holds it');
  assert.equal(typeof selected.element.nodeId, 'string');
  // With Site styles open the canvas draws no outline, though the selection stays and still has its place.
  await press((await locate({ role: 'button', name: 'Site styles', region: 'Panels' })).node.ref);
  await eventually(async () => {
    const s = (await snapshot({ maxNodes: 20 })).context.selection;
    assert.equal(s.shown, true);
    assert.equal(s.outlined, false);
    assert.deepEqual(s.semantic, headingIdentity);
  });

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
  assert.equal((await locate({ ref: heading.node.ref })).node.blocked, true, 'the preview under it too');
  await press((await locate({ role: 'tab', name: 'AI assistant', within: dialogOpen.context.dialog.ref })).node.ref);
  const field = await eventually(() => locate({ role: 'textbox', name: 'API key (optional)', scope: 'editor' }));
  const input = await session.elementFor(field.node.ref);
  await input.fill(SECRET);
  assert.equal(await input.evaluate((el) => el.value), SECRET, 'the key is really in the field');
  await input.dispose();
  const typed = await call('ui.snapshot', { scope: 'editor', maxNodes: 1000 });
  const again = await call('ui.locate', { ref: field.node.ref });
  const byRole = await call('ui.locate', { role: 'textbox', name: 'API key (optional)' });
  for (const [reply, what] of [
    [typed, 'snapshot'],
    [again, 'locate by ref'],
    [byRole, 'locate by role']
  ]) {
    ok(reply, what);
    assert.deepEqual(leaks(reply), [], `no piece of the key is in the ${what} reply`);
  }
  for (const node of [again.result.node, byRole.result.node, flatten(typed.result.editor.nodes).find((x) => x.ref === field.node.ref)]) {
    assert.equal(node.redacted, true, 'the key field says its value was left out');
    assert.equal(node.value, undefined);
  }
  // Pixels cannot be scrubbed: no screenshot while a credential is known.
  const shotDir = join(session.paths.artifacts, 'snapshots');
  const pngsBefore = readdirSync(shotDir).length;
  const covered = ok(await call('ui.snapshot', { maxNodes: 5, screenshot: true }), 'a snapshot with a key typed');
  assert.deepEqual([covered.screenshots.editor, covered.screenshots.preview], [null, null]);
  assert.match(covered.screenshots.withheld, /credential/);
  assert.equal(readdirSync(shotDir).length, pngsBefore, 'no PNG was written');
  // An ordinary field's value is still reported.
  assert.ok(flatten(typed.result.editor.nodes).some((x) => x.role === 'spinbutton' && x.value === '1280'), 'other values are kept');
  assert.equal(typed.result.context.focus?.name, 'API key (optional)', 'focus is reported');
  assert.equal(typed.result.context.focus.ref, field.node.ref);
  // Closing with a key typed but not saved asks first: that question is now the topmost dialog.
  await session.page.keyboard.press('Escape');
  const asked = await eventually(async () => {
    const d = (await snapshot()).context.dialog;
    assert.equal(d?.name, 'Save the API key you entered?');
    return d;
  });
  const question = await call('ui.snapshot', { within: asked.ref });
  ok(question, 'the question');
  assert.deepEqual(leaks(question), [], 'nor in the question about it');
  await press((await locate({ role: 'button', name: 'Discard', within: asked.ref })).node.ref);
  await eventually(async () => assert.equal((await snapshot()).context.dialog, null, 'the dialogs closed'));

  step('visitor mode is told apart from a preview still loading');
  await press((await locate({ role: 'radio', name: 'Preview', region: 'Mode' })).node.ref);
  await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context;
    assert.equal(c.mode, 'preview');
    assert.deepEqual(c.preview, { state: 'ready', path: '/', editing: false });
  });
  await press((await locate({ role: 'radio', name: 'Edit', region: 'Mode' })).node.ref);
  await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context;
    assert.equal(c.mode, 'edit');
    assert.deepEqual(c.preview, { state: 'ready', path: '/', editing: true });
  });

  step('a preview reloading is loading until its page is hydrated, and its old refs are stale');
  const previewFrame = await (await session.page.$('.frame-box iframe')).contentFrame();
  const origin = new URL(previewFrame.url()).origin;
  // Only this preview's bridge module is held, so its page renders but is not hydrated.
  const hold = (url) => url.origin === origin && url.pathname.includes('virtual:siteorigin-bridge');
  let release;
  const held = new Promise((r) => (release = r));
  let caught;
  const caughtIt = new Promise((r) => (caught = r));
  await session.app.context().route(hold, async (route) => {
    caught();
    await held;
    await route.continue().catch(() => undefined);
  });
  try {
    await previewFrame.evaluate(() => location.reload()).catch((e) => assert.match(String(e), /context was destroyed|navigat/i));
    await withTimeout(caughtIt, 30000, 'holding the reloaded page’s bridge');
    const loading = await eventually(async () => {
      const s = await snapshot({ scope: 'preview' });
      assert.equal(s.context.preview.state, 'loading');
      assert.ok(s.preview?.nodes.length, 'the page is there to see');
      return s;
    }, 30000);
    assert.equal(loading.preview.refs, false, 'a page not yet hydrated gives no refs to act on');
    assert.ok(flatten(loading.preview.nodes).every((x) => !x.ref));
    const whileLoading = failed(await call('ui.locate', { ref: heading.node.ref }), 'STALE_REF', 'a ref while the page loads');
    assert.equal(whileLoading.details.reason, 'loading');
    assert.match(whileLoading.details.hint, /ui\.snapshot/, 'a stale ref says how to get a fresh one');
  } finally {
    release();
    await session.app.context().unroute(hold);
  }
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
  const created = await withTimeout(
    session.page.evaluate((parentDir) => window.builder.projects.create({ name: 'Second Business', starter: 'business', sampleImages: false, parentDir }), session.paths.projects),
    120000,
    'creating the second project'
  );
  assert.equal(created.ok, true, `the second project was made: ${created.message ?? ''}`);
  await eventually(async () => {
    const s = await snapshot({ maxNodes: 20 });
    assert.equal(s.context.preview.state, 'ready');
    await locate({ role: 'button', name: 'Second Business Home', scope: 'editor' });
  }, 90000);
  for (const [ref, what] of [
    [settingsBefore, 'an editor ref from the last project'],
    [fresh.node.ref, 'a preview ref from the last project']
  ]) {
    const e = failed(await call('ui.locate', { ref }), 'STALE_REF', what);
    assert.equal(e.details.reason, 'project', what);
    assert.match(e.details.hint, /ui\.snapshot/);
  }
  const now = await locate({ role: 'heading', name: HEADING, scope: 'preview' });
  assert.notEqual(now.node.ref, fresh.node.ref);
  // A ref in the same form that this session never gave out.
  const [tag] = now.node.ref.split(':');
  const foreign = `${tag === 'ffffff' ? 'eeeeee' : 'ffffff'}:1`;
  assert.equal(failed(await call('ui.locate', { ref: foreign }), 'STALE_REF', 'a ref this session never gave out').details.reason, 'unknown');

  step('the projects carry none of the editor’s markers');
  const projectFiles = files(session.paths.projects, ['.siteorigin', 'node_modules']);
  assert.ok(projectFiles.filter((f) => /\.svelte$/.test(f)).length >= 4, `both projects generated their source (${projectFiles.length} files)`);
  for (const file of projectFiles) {
    const text = readFileSync(file, 'utf8');
    for (const marker of ['data-so-bridge', 'data-selection', 'data-selected-ref', 'data-opening', 'data-frame', 'siteorigin-bridge']) assert.ok(!text.includes(marker), `${file} has no ${marker}`);
  }

  passed = true;
  console.log('\nsnapshot: all checks passed');
} finally {
  await session.close({ failed: !passed }).catch((e) => console.error('close failed', e));
  if (passed) cleanup();
}
