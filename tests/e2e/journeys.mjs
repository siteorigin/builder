// The principal journey through the whole app, as a person makes it, and its replay (issue #498). One isolated session
// at Welcome with a scripted assistant; every step goes through the test driver's public operations, the same ones the
// MCP server gives an external model (scripts/model-smoke.mjs), and every outcome is checked independently of the
// editor's UI: in the project's documents on disk, the preview and the exported files.
//
// Cancelled first: an Open Project chooser cancelled from Welcome opens nothing. Then a site is created from Welcome's
// New project dialog, its hero heading edited in the Inspector, a question asked in Ask mode and its answer read, an
// edit asked for that needs more than the selection (declined once, which leaves the site as it was, then allowed),
// Undo and Redo from the toolbar moving only the assistant's change, the website exported to a folder and read back,
// and the project closed and opened again. The run's own record must prove the journey (tests/coverage/journey-proof.ts),
// and it replays from that record in a fresh session, which ends with the same project and the same export.
import assert from 'node:assert/strict';
import { describeProof, proveJourney } from '../coverage/journey-proof.ts';
import { replay } from '../driver/replay.ts';
import { Session } from '../driver/session.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('journeys');
const session = new Session({ parentDir: WORK });
/** The session the helpers talk to: the recording, then the replay. */
let current = session;
let replayed = null;
let replaySession = null;
let passed = false;
let n = 0;

const call = (op, args, extra = {}) => current.call({ v: 1, id: `j${++n}`, op, ...(args ? { args } : {}), ...extra });
const explain = (reply) => (reply.ok ? '' : `${reply.error.code} ${reply.error.message} ${JSON.stringify(reply.error.details ?? {})}`);
const ok = async (op, args, extra) => {
  const reply = await call(op, args, extra);
  assert.equal(reply.ok, true, `${op} ${JSON.stringify(args ?? {})}: ${explain(reply)}`);
  return reply.result;
};
const find = async (query) => (await ok('ui.locate', query)).node;
const click = async (query) => ok('ui.click', { target: { ref: (await find(query)).ref } });
const fill = async (query, text) => ok('ui.fill', { target: { ref: (await find(query)).ref }, text });
const press = (key) => ok('ui.press', { key });
const menu = (...path) => ok('menu.invoke', { path });
/** A named condition the app must reach: recorded, so a replay waits for it too. */
const until = (condition, params = {}, timeoutMs = 30000) => ok('wait.for', { condition, ...params }, { timeoutMs });
const summary = (find) => ok('project.summary', find ? { find } : undefined);
const editor = (role, name, extra = {}) => ({ role, name, scope: 'editor', ...extra });

// The assistant, as the chat shows it: a message sent from the composer, and the run it started.
let latest = 0;
const observe = async (args = {}) => {
  const r = await ok('assistant.observe', args);
  latest = Math.max(latest, r.next);
  return r;
};
async function send(text) {
  await fill(editor('textbox', 'Message'), text);
  const at = (await observe({ after: latest })).next;
  await press('Enter');
  return eventually(async () => {
    const started = (await observe({ after: at })).entries.find((e) => e.type === 'run.started' && e.request.text === text);
    assert.ok(started, `a run started for "${text}"`);
    return started;
  }, 15000);
}
const wait = (runId, after) => ok('assistant.wait', { runId, ...(after !== undefined ? { after } : {}) }, { timeoutMs: 30000 });
const mode = async (from, to) => {
  await click(editor('button', `What your next message does: ${from}`));
  await click(editor('menuitemradio', to, { exact: false }));
};

const PROJECT = 'Harbour Lane Studio';
const HEADING = 'Harbour light in every season';
const QUESTION = 'What does the hero heading say now?';
const ANSWER = `It says “${HEADING}”.`;
const NEW_NAME = 'Quayside Rooms';
const ALLOW = 'Yes, allow changes across the whole site';
const DECLINE = 'No, only change the selection';

try {
  await ok('session.start', { provider: 'scripted' }, { timeoutMs: 240000 });

  step('cancelled journey: an Open Project chooser cancelled from Welcome opens nothing');
  await until('ui.context', { screen: 'welcome', dialog: null });
  const workspaceBefore = (await ok('files.list', { path: 'workspace' })).entries.map((e) => e.name);
  await ok('desktop.setAnswers', { answers: [{ dialog: 'open', cancel: true }] });
  await click(editor('button', 'Open project…', { exact: false }));
  const cancelled = await eventually(async () => {
    const choosers = (await ok('desktop.events', { after: 0 })).entries.filter((e) => e.type === 'chooser');
    assert.equal(choosers.length, 1, 'the chooser was shown once');
    return choosers[0];
  });
  assert.equal(cancelled.outcome, 'cancelled', `the chooser was cancelled: ${JSON.stringify(cancelled)}`);
  await until('ui.context', { screen: 'welcome', dialog: null });
  assert.deepEqual((await ok('files.list', { path: 'workspace' })).entries.map((e) => e.name), workspaceBefore, 'nothing was made');
  assert.equal((await summary()).screen, 'welcome', 'no project is open');

  step('principal journey: a new site from Welcome, through the New project dialog');
  await click(editor('button', 'New project'));
  await until('ui.context', { dialog: 'New project' });
  await fill(editor('textbox', 'Project name'), PROJECT);
  await click(editor('button', 'Create project'));
  await until('preview.ready', { path: '/' }, 180000);
  const created = await summary();
  assert.equal(created.screen, 'editor');
  assert.match(created.project.path, /^workspace\//, 'the project is in the session’s workspace, by its session path');
  const oldName = created.project.site.name;
  assert.equal(oldName, PROJECT, 'the site is named as the project was');
  const home = created.project.pages.find((p) => p.home);

  step('principal journey: the hero heading edited in the Inspector, saved and shown');
  await click({ role: 'button', name: 'Layers', region: 'Panels' });
  await until('ui.present', { role: 'treeitem', name: 'Split hero' });
  await click({ role: 'treeitem', name: 'Split hero' });
  await click(editor('tab', 'Inspector'));
  await until('ui.present', editor('textbox', 'Heading'));
  await fill(editor('textbox', 'Heading'), HEADING);
  await press('Tab');
  await until('save.settled');
  const edited = await summary(HEADING);
  assert.deepEqual(
    edited.project.find.matches.map((m) => [m.file, /props\.heading$/.test(m.pointer)]),
    [[`siteorigin/pages/${home.id}.json`, true]],
    'the home page document holds the heading'
  );
  await until('ui.present', { role: 'heading', name: HEADING, scope: 'preview' });

  step('principal journey: a question asked in Ask mode is answered, and the site is unchanged');
  await click({ role: 'tab', name: 'AI', exact: false, region: 'Right panel views' });
  await mode('Edit', 'Ask');
  await ok('assistant.script', { scenario: 'read-and-answer', params: { text: ANSWER } });
  const revisionBeforeAsk = (await summary()).revision;
  const ask = await send(QUESTION);
  assert.equal(ask.request.mode, 'ask');
  const asked = await wait(ask.runId);
  assert.deepEqual([asked.reason, asked.run.status, asked.run.text], ['terminal', 'no-changes', ANSWER], 'the answer is the one the assistant gave');
  assert.equal(asked.shown.reply.result.heading, 'Answered · site unchanged');
  await until('ui.present', editor('button', 'Answered · site unchanged', { exact: false }));
  assert.equal((await summary()).revision, revisionBeforeAsk, 'a question changes nothing');

  step('cancelled journey: an edit that needs more than the selection is declined, and the site keeps its name');
  // The Split hero is still selected: an edit is limited to it, and renaming the site is outside it.
  await mode('Ask, a read-only question', 'Edit');
  await ok('assistant.script', { scenario: 'widen', params: { question: 'May I rename the whole site too?', siteName: NEW_NAME, then: 'Kept to the hero.' } });
  const declineRun = await send(`Rename the site to ${NEW_NAME}`);
  assert.equal(declineRun.request.mode, 'edit');
  assert.equal((await wait(declineRun.runId)).reason, 'input', 'the assistant asks first');
  await until('ui.present', editor('button', DECLINE));
  let at = (await observe({ after: latest })).next;
  await click(editor('button', DECLINE));
  const declined = await wait(declineRun.runId, at);
  assert.deepEqual([declined.reason, declined.run.questions[0].answer], ['terminal', DECLINE]);
  await until('ui.present', editor('button', 'No changes made', { exact: false }));
  assert.equal((await summary()).project.site.name, oldName, 'the site keeps its name');

  step('principal journey: an edit asked for, the request to change more allowed, and the change made');
  await ok('assistant.script', { scenario: 'widen', params: { question: 'May I rename the whole site too?', siteName: NEW_NAME, then: 'Renamed the site.' } });
  const allowRun = await send(`Rename the site to ${NEW_NAME}, please`);
  assert.equal((await wait(allowRun.runId)).reason, 'input');
  await until('ui.present', editor('button', ALLOW));
  assert.equal((await summary()).project.site.name, oldName, 'nothing changes before the answer');
  at = (await observe({ after: latest })).next;
  await click(editor('button', ALLOW));
  const allowed = await wait(allowRun.runId, at);
  assert.deepEqual([allowed.reason, allowed.run.status], ['terminal', 'completed'], JSON.stringify(allowed.run.steps));
  // A turn that changed the site is shown as a card with its own Undo turn.
  await until('ui.present', editor('button', 'Undo turn'));
  await until('ui.present', { role: 'link', name: NEW_NAME, scope: 'preview' });
  await until('save.settled');
  const renamed = await summary(HEADING);
  assert.deepEqual([renamed.project.site.name, renamed.project.find.matches.length], [NEW_NAME, 1], 'renamed, with the heading kept');

  step('principal journey: Undo takes back the assistant’s change and Redo makes it again, leaving the heading');
  await click({ role: 'button', name: 'Undo', exact: false, region: 'banner' });
  await until('ui.present', { role: 'link', name: oldName, scope: 'preview' });
  await until('save.settled');
  const undone = await summary(HEADING);
  assert.deepEqual([undone.project.site.name, undone.project.find.matches.length], [oldName, 1], 'the name is back, the heading stays');
  await click({ role: 'button', name: 'Redo', exact: false, region: 'banner' });
  await until('ui.present', { role: 'link', name: NEW_NAME, scope: 'preview' });
  await until('save.settled');
  const redone = await summary(HEADING);
  assert.deepEqual([redone.project.site.name, redone.project.find.matches.length], [NEW_NAME, 1]);

  step('principal journey: the website exported to a folder holds both changes');
  await menu('File', 'Export…');
  await until('ui.context', { dialog: 'Export your website' });
  await click(editor('radio', 'Folder'));
  await ok('desktop.setAnswers', { answers: [{ dialog: 'open', selection: 'folder', paths: ['exports'] }] });
  await click(editor('button', 'Website files, ready to upload', { exact: false }));
  const exported = await until('export.finished', {}, 300000);
  assert.equal(exported.outcome, 'exported', `the export finished: ${JSON.stringify(exported)}`);
  const site = await ok('exports.inspect', { path: exported.export.path, find: HEADING });
  assert.ok(site.find.matches.some((m) => m.file === 'index.html'), `the home page has the heading: ${JSON.stringify(site.find)}`);
  const named = await ok('exports.inspect', { path: exported.export.path, file: 'index.html', find: NEW_NAME });
  assert.ok(named.find.matches.length > 0, 'and the site’s new name');
  // Escape on the dialog itself: untargeted, it would go wherever the dialog has just put the focus (its result), and the
  // dialog's two Close buttons share their name.
  await ok('ui.press', { key: 'Escape', target: { ref: (await find(editor('dialog', 'Export your website'))).ref } });
  await until('ui.context', { dialog: null });

  step('principal journey: closed and opened again, the project still holds both');
  await menu('File', 'Close Project');
  await until('ui.context', { screen: 'welcome' });
  await ok('desktop.setAnswers', { answers: [{ dialog: 'open', paths: [`${created.project.path}/siteorigin.project.json`] }] });
  await menu('File', 'Open Project…');
  await until('preview.ready', { path: '/' }, 180000);
  const reopened = await summary(HEADING);
  assert.notEqual(reopened.opening, created.opening, 'a new opening');
  assert.deepEqual([reopened.project.path, reopened.project.site.name, reopened.project.find.matches.length], [created.project.path, NEW_NAME, 1]);
  await until('ui.present', { role: 'heading', name: HEADING, scope: 'preview' });

  step('the record proves the principal journey');
  const record = (await ok('evidence.save')).record;
  assert.deepEqual([record.complete, record.dropped, record.scenario.fixture], [true, 0, 'welcome']);
  const proof = proveJourney(record, { edit: HEADING, oldName: PROJECT, newName: NEW_NAME, answer: ANSWER });
  assert.ok(proof.ok, `the record proves the journey:\n${describeProof(proof)}`);
  assert.ok(record.evidence.screenshots?.editor && record.evidence.screenshots?.preview, 'with screenshots of the editor and the preview');
  assert.deepEqual(session.pageErrors, [], 'the editor raised no errors');

  step('the recorded journey replays in a fresh session');
  // The replay's session is held before it starts, so it is closed whatever the replay does.
  replayed = await replay(record, { make: () => (replaySession = new Session({ parentDir: WORK })) });
  assert.equal(replayed.ok, true, `the replay diverged: ${JSON.stringify(replayed.divergence)}`);
  const kinds = new Set(replayed.steps.filter((s) => s.status === 'replayed').map((s) => s.op));
  for (const op of ['desktop.setAnswers', 'assistant.script', 'ui.click', 'ui.fill', 'ui.press', 'menu.invoke', 'wait.for', 'project.summary', 'exports.inspect']) assert.ok(kinds.has(op), `it replayed ${op}`);
  current = replayed.session;
  assert.notEqual(replayed.session.paths.root, session.paths.root, 'in its own session');
  const again = await summary(HEADING);
  assert.deepEqual([again.project.path, again.project.site.name, again.project.find.matches.length], [created.project.path, NEW_NAME, 1], 'the replay ends with the same project, reopened');
  // The app lists the exports of the project's current opening, and the replay reopened it: the folder is the record.
  const exportsAgain = (await ok('files.list', { path: 'exports' })).entries;
  assert.deepEqual(exportsAgain.map((e) => e.name), [exported.export.path.split('/').pop()], 'and the one export, named as the recording named it');
  const againSite = await ok('exports.inspect', { path: exported.export.path, file: 'index.html', find: HEADING });
  assert.ok(againSite.find.matches.length > 0, 'whose home page has the heading');
  const replayedRuns = (await observe({ after: 0 })).entries.filter((e) => e.type === 'run.started').map((e) => e.request.mode);
  assert.deepEqual(replayedRuns, ['ask', 'edit', 'edit'], 'the replay asked and edited as the recording did');
  const replayedChoosers = (await ok('desktop.events', { after: 0 })).entries.filter((e) => e.type === 'chooser').map((e) => e.outcome);
  assert.equal(replayedChoosers[0], 'cancelled', `the replay cancelled the first chooser as the recording did: ${replayedChoosers.join(', ')}`);
  assert.deepEqual(replayed.session.pageErrors, [], 'the replayed editor raised no errors');

  passed = true;
  console.log('\njourneys: all checks passed');
} finally {
  let closedOk = true;
  for (const s of [replaySession, session].filter(Boolean)) {
    await s.close({ failed: !passed }).catch((e) => {
      closedOk = false;
      console.error('close failed', e);
    });
  }
  if (passed && closedOk) cleanup();
  else console.log(`kept ${WORK}`);
  if (!passed || !closedOk) process.exitCode = 1;
}
