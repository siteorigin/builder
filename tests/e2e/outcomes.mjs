// Bounded waits, independent outcome checks and failure evidence (tests/driver, issue #497), against the built app in
// an isolated session. Every step a person takes goes through the driver's actions and menus; every pause is a named
// condition the session waits for (never a timed sleep); every outcome is checked independently of the editor's UI,
// in the project's documents on disk and in the files the export wrote. A visible edit is saved, survives Close and
// Open Project (through a preview held back on the way, whose wait times out with evidence), and reaches the exported
// website. An export to a refused place fails visibly and changes nothing; a control that is not there times out with
// what was seen instead. The session's record keeps setup, input and observation apart, leaves out credentials and
// host paths, and the edit journey replays from it in a fresh session.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { replay } from '../driver/replay.ts';
import { REPO_ROOT, Session } from '../driver/session.ts';
import { scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('outcomes');
const session = new Session({ parentDir: WORK });
let replayed = null;
let passed = false;
let n = 0;
const call = (op, args, extra = {}) => session.call({ v: 1, id: `o${++n}`, op, ...(args ? { args } : {}), ...extra });
const describe = (reply) => (reply.ok ? '' : `${reply.error.code} ${reply.error.message} ${JSON.stringify(reply.error.details ?? {})}`);
const ok = (reply, what) => {
  assert.equal(reply.ok, true, `${what}: ${describe(reply)}`);
  return reply.result;
};
const failed = (reply, code, what) => {
  assert.equal(reply.ok, false, `${what}: expected ${code}, got a result ${JSON.stringify(reply.result ?? null)}`);
  assert.equal(reply.error.code, code, `${what}: ${describe(reply)}`);
  return reply.error;
};
const find = async (args) => ok(await call('ui.locate', args), `ui.locate ${JSON.stringify(args)}`).node;
const until = async (condition, params = {}, timeoutMs = 30000) => ok(await call('wait.for', { condition, ...params }, { timeoutMs }), `wait.for ${condition} ${JSON.stringify(params)}`);
const act = async (op, args) => ok(await call(op, args), `${op} ${JSON.stringify(args)}`);
const click = (ref) => act('ui.click', { target: { ref } });
const menu = (...path) => act('menu.invoke', { path });

const MARKER = 'Harbour light in every season';
const KEY = 'sk-OUTCOMES-SENTINEL-4b8e1d';

/** The edit a person makes: Split hero chosen in Layers, its Heading replaced in the Inspector and committed. */
async function editHeading(text) {
  await click((await find({ role: 'button', name: 'Layers', region: 'Panels' })).ref);
  await until('ui.present', { role: 'treeitem', name: 'Split hero' });
  await click((await find({ role: 'treeitem', name: 'Split hero' })).ref);
  // The right panel opens on the AI (#696): the Inspector is chosen from its tab.
  await click((await find({ role: 'tab', name: 'Inspector', scope: 'editor' })).ref);
  await until('ui.present', { role: 'textbox', name: 'Heading', scope: 'editor' });
  const field = await find({ role: 'textbox', name: 'Heading', scope: 'editor' });
  await act('ui.fill', { target: { ref: field.ref }, text });
  await act('ui.press', { key: 'Tab' });
  return field;
}

try {
  ok(await call('session.start', { fixture: 'business-v1' }, { timeoutMs: 240000 }), 'session.start');
  const paths = session.paths;

  step('waiting for a save with no input sent times out, saying there is nothing to compare with');
  await until('preview.ready', { path: '/' });
  const before = ok(await call('project.summary'), 'project.summary');
  assert.equal(before.screen, 'editor');
  assert.equal(before.save.kind, 'saved');
  assert.match(before.project.path, /^workspace\/SiteOrigin\//, 'the project is named by its session path');
  const home = before.project.pages.find((p) => p.home);
  assert.equal(home.route, '/');
  const early = failed(await call('wait.for', { condition: 'save.settled' }, { timeoutMs: 1500 }), 'TIMEOUT', 'a save with nothing to compare with');
  assert.match(early.details.pending, /no input was sent/);

  step('a visible edit is saved: the editor says Saved past the revision it started at, and the document on disk holds it');
  const field = await editHeading(MARKER);
  const settled = await until('save.settled');
  assert.ok(settled.revision > before.revision, `the revision moved on (${before.revision} → ${settled.revision})`);
  assert.equal(settled.save.text, 'Saved');
  const onDisk = ok(await call('project.summary', { find: MARKER }), 'project.summary find');
  assert.equal(onDisk.revision, settled.revision);
  assert.deepEqual(
    onDisk.project.find.matches.map((m) => [m.file, /props\.heading$/.test(m.pointer)]),
    [[`siteorigin/pages/${home.id}.json`, true]],
    'the home page document holds the heading'
  );
  assert.equal(onDisk.project.find.complete, true, 'every document was read');
  await until('ui.present', { role: 'heading', name: MARKER, scope: 'preview' });
  // The ref given for the field before the edit names the same field (its name did not change).
  assert.equal((await find({ ref: field.ref })).value, MARKER);
  // An input that changes nothing: the editor still says Saved, but that is no save of it.
  await act('ui.press', { key: 'Tab' });
  const nothing = failed(await call('wait.for', { condition: 'save.settled' }, { timeoutMs: 1500 }), 'TIMEOUT', 'a save after an input that changed nothing');
  assert.match(nothing.details.pending, new RegExp(`revision ${settled.revision}, as it was before the last input`));
  assert.equal(nothing.details.last.app.save.text, 'Saved', 'though the indicator says Saved');
  const journey = ok(await call('evidence.save'), 'evidence.save').record;
  assert.ok(journey.evidence.screenshots?.editor, 'the record has a screenshot of the editor');
  assert.ok(existsSync(join(paths.artifacts, journey.evidence.screenshots.editor)), 'in the artifacts');
  assert.ok(journey.artifacts.includes('replay.json'));

  step('the edit survives Close Project and Open Project, through a preview held back on the way');
  await menu('File', 'Close Project');
  await until('ui.context', { screen: 'welcome' });
  // Test setup, outside the driver: the reopened preview's bridge module is held, so the page renders but is not ready.
  const hold = (url) => url.pathname.includes('virtual:siteorigin-bridge');
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
    ok(await call('desktop.setAnswers', { answers: [{ dialog: 'open', paths: [`${before.project.path}/siteorigin.project.json`] }] }), 'the chooser’s answer');
    await menu('File', 'Open Project…');
    await withTimeout(caughtIt, 180000, 'holding the reopened preview’s bridge');
    const late = failed(await call('wait.for', { condition: 'preview.ready' }, { timeoutMs: 6000 }), 'TIMEOUT', 'a preview held back');
    assert.equal(late.retryable, true, 'a wait may be repeated');
    assert.equal(late.details.condition.condition, 'preview.ready', 'it names the pending condition');
    assert.match(late.details.pending, /the preview is still loading/);
    assert.equal(late.details.last.context.preview.state, 'loading', 'and the last thing it saw');
    assert.equal(late.details.observation.context.screen, 'editor', 'with an observation of the editor');
    assert.ok(late.details.samples >= 1);
    assert.ok(Array.isArray(late.details.errors.page) && Array.isArray(late.details.errors.log), 'and the page and app errors');
    assert.equal(late.details.app.project, before.project.path, 'the project open, by its session path');
  } finally {
    release();
    await session.app.context().unroute(hold);
  }
  await until('preview.ready', { path: '/' }, 120000);
  const reopened = ok(await call('project.summary', { find: MARKER }), 'project.summary after reopening');
  assert.notEqual(reopened.opening, before.opening, 'a new opening of the project');
  assert.equal(reopened.project.path, before.project.path, 'the same project');
  assert.equal(reopened.project.find.matches.length, 1, 'still holding the edit');
  await until('ui.present', { role: 'heading', name: MARKER, scope: 'preview' });

  step('the website exported to a folder holds the edit');
  await menu('File', 'Export…');
  await until('ui.context', { dialog: 'Export your website' });
  await click((await find({ role: 'button', name: 'Folder', scope: 'editor' })).ref);
  ok(await call('desktop.setAnswers', { answers: [{ dialog: 'open', selection: 'folder', paths: ['exports'] }] }), 'the folder chooser’s answer');
  await click((await find({ role: 'button', name: 'Website files, ready to upload', exact: false, scope: 'editor' })).ref);
  const exported = await until('export.finished', {}, 300000);
  assert.equal(exported.outcome, 'exported', `the export finished: ${JSON.stringify(exported)}`);
  assert.match(exported.export.path, /^exports\/[^/]+$/, 'into a new folder in exports');
  assert.equal(exported.export.kind, 'site');
  const site = ok(await call('exports.inspect', { path: exported.export.path, find: MARKER }), 'exports.inspect');
  assert.equal(site.type, 'folder');
  assert.ok(site.listed.some((f) => f.file === 'index.html'), 'the website has its home page');
  assert.ok(site.find.matches.some((m) => m.file === 'index.html'), `the home page shows the edit: ${JSON.stringify(site.find)}`);
  assert.equal(site.find.complete, true);
  const page = ok(await call('exports.inspect', { path: exported.export.path, file: 'index.html', find: MARKER }), 'the home page');
  assert.ok(page.find.matches[0].excerpt.includes(MARKER));

  step('an export to a refused place fails visibly, and nothing is written');
  // A finished export's dialog shows where it went; the choices come back when it is opened again.
  await act('ui.press', { key: 'Escape' });
  await until('ui.context', { dialog: null });
  await menu('File', 'Export…');
  await until('ui.context', { dialog: 'Export your website' });
  ok(await call('desktop.setAnswers', { answers: [{ dialog: 'open', selection: 'folder', paths: [before.project.path] }] }), 'answering with the project’s own folder');
  await click((await find({ role: 'button', name: 'Website files, ready to upload', exact: false, scope: 'editor' })).ref);
  const refusedExport = await until('export.finished', {}, 60000);
  assert.equal(refusedExport.outcome, 'failed', `the export failed: ${JSON.stringify(refusedExport)}`);
  assert.match(refusedExport.message, /outside the project folder/);
  // The failure still on screen is not the outcome of what comes next.
  await act('ui.press', { key: 'Tab' });
  const stale = failed(await call('wait.for', { condition: 'export.finished' }, { timeoutMs: 1500 }), 'TIMEOUT', 'the failure from before the last input');
  assert.match(stale.details.pending, /no export has finished since the last input/);
  const afterFailure = ok(await call('project.summary'), 'project.summary after the failure');
  assert.equal(afterFailure.exports.count, 1, 'no export was added');
  assert.equal(afterFailure.exports.newest.path, exported.export.path);
  assert.deepEqual(ok(await call('files.list'), 'files.list').entries.map((e) => e.name), [exported.export.path.split('/').pop()], 'the exports folder has the one website');
  assert.equal(ok(await call('project.summary', { find: 'fixture-business-site' }), 'the project folder').project.find.matches.length, 0);
  const inProject = ok(await call('files.list', { path: before.project.path }), 'the project folder').entries.map((e) => e.name);
  assert.ok(!inProject.some((name) => /-site/.test(name)), `nothing was written into the project folder: ${inProject.join(', ')}`);

  step('a control that is not there: the wait times out with what was there instead, and the session goes on');
  const missing = failed(await call('wait.for', { condition: 'ui.present', role: 'button', name: 'Publish to the Moon' }, { timeoutMs: 3000 }), 'TIMEOUT', 'a missing control');
  assert.match(missing.message, /ui\.present did not hold/);
  assert.match(missing.details.pending, /no button "Publish to the Moon" is there/);
  assert.equal(missing.details.last.search.code, 'TARGET_NOT_FOUND');
  assert.equal(missing.details.observation.context.dialog?.name, 'Export your website', 'the observation shows what was on screen');
  failed(await call('ui.locate', { role: 'button', name: 'Publish to the Moon' }), 'TARGET_NOT_FOUND', 'looking it up');
  await until('ui.absent', { role: 'button', name: 'Publish to the Moon' });
  await act('ui.press', { key: 'Escape' });
  await until('ui.context', { dialog: null });
  // Nothing has ended the run: no exit, no closed window, no page error, no preview failure.
  const going = failed(await call('wait.for', { condition: 'outcome.terminal', since: 'start' }, { timeoutMs: 1500 }), 'TIMEOUT', 'no terminal outcome');
  assert.match(going.details.pending, /the app is running/);

  step('an error the page raises is a terminal outcome, reported with its host paths hidden');
  // Test setup, outside the driver: the editor's page throws, naming a file of the host's.
  const THROWN = 'outcomes-sentinel failure at /Users/nobody-here/private/thing.js:3:9';
  await session.page.evaluate((m) => setTimeout(() => { throw new Error(m); }), THROWN);
  const ended = await until('outcome.terminal', {}, 10000);
  assert.equal(ended.outcome, 'page-error');
  assert.equal(ended.errors.length, 1);
  assert.match(ended.errors[0], /outcomes-sentinel failure at <host-path>/);
  assert.ok(!JSON.stringify(ended).includes('nobody-here'), 'the host path is hidden');

  step('a credential typed into Settings is kept out of the record');
  await click((await find({ role: 'button', name: 'Settings', scope: 'editor' })).ref);
  await until('ui.context', { dialog: 'Settings' });
  await click((await find({ role: 'tab', name: 'AI assistant', scope: 'editor' })).ref);
  await until('ui.present', { role: 'textbox', name: 'API key (optional)', scope: 'editor' });
  await act('ui.fill', { target: { ref: (await find({ role: 'textbox', name: 'API key (optional)', scope: 'editor' })).ref }, text: KEY });
  await act('ui.press', { key: 'Escape' });
  await until('ui.context', { dialog: 'Save the API key you entered?' });
  await click((await find({ role: 'button', name: 'Discard', scope: 'editor' })).ref);
  await until('ui.context', { dialog: null });
  // The key, and a folder of the host's, sent later as arguments: the record keeps neither, whatever the field.
  ok(await call('project.summary', { find: KEY }), 'a search for the key');
  failed(await call('ui.locate', { role: KEY }), 'BAD_REQUEST', 'the key as a role');
  failed(await call('exports.inspect', { path: '/Volumes/Backup/elsewhere-site' }), 'BAD_REQUEST', 'a path outside the session');

  step('the record: ordered, classed, bounded, without credentials or host paths');
  const log = ok(await call('evidence.log', { after: 0, limit: 200 }), 'evidence.log');
  assert.equal(log.dropped, 0);
  const seqs = log.entries.map((e) => e.seq);
  assert.ok(seqs.every((x, i) => i === 0 || x > seqs[i - 1]), 'in order, each once');
  const classOf = (op) => [...new Set(log.entries.filter((e) => e.op === op).map((e) => e.class))];
  assert.deepEqual([classOf('session.start'), classOf('desktop.setAnswers'), classOf('ui.click'), classOf('menu.invoke'), classOf('wait.for'), classOf('project.summary')], [['session'], ['setup'], ['input'], ['input'], ['observation'], ['observation']]);
  const fill = log.entries.find((e) => e.op === 'ui.fill' && e.args?.text === MARKER);
  assert.deepEqual(fill.targets.map((t) => [t.at, t.role, t.name, t.replayable]), [['target', 'textbox', 'Heading', true]], 'an input says how to find its target again');
  const keyFill = log.entries.filter((e) => e.op === 'ui.fill').at(-1);
  assert.deepEqual(keyFill.args.textLeftOut, { length: KEY.length }, 'the typed credential is left out');
  const searched = log.entries.filter((e) => e.op === 'project.summary').at(-1);
  assert.equal(searched.args.find, '[redacted]', 'a credential sent as an argument is scrubbed');
  const asRole = log.entries.filter((e) => e.op === 'ui.locate').at(-1);
  assert.equal(asRole.args.role, '[redacted]', 'even in a field the protocol fixes, such as a role');
  const outside = log.entries.filter((e) => e.op === 'exports.inspect').at(-1);
  assert.equal(outside.args.path, '<host-path>', 'and a host path is hidden');
  const saved = ok(await call('evidence.save'), 'evidence.save at the end');
  const record = JSON.parse(readFileSync(saved.file, 'utf8'));
  assert.deepEqual(record, saved.record, 'replay.json is what was returned');
  assert.equal(record.scenario.fixture, 'business-v1');
  assert.equal(record.scenario.provider, 'scripted');
  assert.match(record.build.fingerprint, /^sha256:/);
  assert.equal(record.complete, true);
  assert.match(record.evidence.screenshots?.withheld ?? '', /credential/, 'no screenshot once a credential is known');
  assert.equal(record.evidence.observation.context.screen, 'editor', 'the latest observation');
  assert.ok(record.evidence.observation.editor.nodes.length > 0, 'with its tree');
  assert.deepEqual([record.evidence.failure.op, record.evidence.failure.code, record.evidence.failure.seq], ['exports.inspect', 'BAD_REQUEST', outside.seq], 'the last failure');
  assert.equal(record.evidence.pageErrors.total, 1);
  assert.match(record.evidence.pageErrors.latest[0], /<host-path>/);
  const text = JSON.stringify(record);
  for (const leak of ['OUTCOMES-SENTINEL', '4b8e1d', paths.root, REPO_ROOT, homedir(), 'nobody-here', '/Volumes/']) assert.ok(!text.includes(leak), `the record does not hold ${leak}`);
  assert.ok(text.includes('"path": "<host-path>"') || text.includes('"path":"<host-path>"'), 'the outside path is in the record, hidden');

  step('the edit journey replays in a fresh session, finding its targets again');
  replayed = await replay(journey, { session: { parentDir: WORK } });
  assert.equal(replayed.ok, true, `the replay diverged: ${JSON.stringify(replayed.divergence)}`);
  const kinds = replayed.steps.filter((s) => s.status === 'replayed').map((s) => s.op);
  assert.ok(['ui.click', 'ui.fill', 'ui.press', 'wait.for', 'project.summary'].every((op) => kinds.includes(op)), `it replayed the inputs, waits and checks: ${kinds.join(', ')}`);
  const again = ok(await replayed.session.call({ v: 1, id: 'r-check', op: 'project.summary', args: { find: MARKER } }), 'the replayed project');
  assert.equal(again.project.find.matches.length, 1, 'the replayed session holds the edit on disk');
  assert.notEqual(replayed.session.paths.root, paths.root, 'in its own session');

  assert.equal(session.pageErrors.length, 1, 'the editor raised no errors but the one the test threw');
  assert.match(session.pageErrors[0], /outcomes-sentinel/);
  passed = true;
  console.log('\noutcomes: all checks passed');
} finally {
  let closedOk = true;
  for (const s of [replayed?.session, session].filter(Boolean)) {
    await s.close({ failed: !passed }).catch((e) => {
      closedOk = false;
      console.error('close failed', e);
    });
  }
  if (passed && closedOk) cleanup();
  else console.log(`kept ${WORK}`);
  if (!passed || !closedOk) process.exitCode = 1;
}
