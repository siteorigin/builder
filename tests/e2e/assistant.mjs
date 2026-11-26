// The Builder assistant exercised as a user, through the test driver (issue #495). One isolated session with a
// scripted model behind the app's real local adapter and orchestrator; every step a person takes goes through the
// driver's actions on the chat panel (the composer, the mode menu, the image picker, the scope and question controls,
// Stop, the result card and the conversation history), and every check reads `assistant.observe` and `assistant.wait`
// (each run by its own conversation, message and run IDs), the preview, or the saved project.
//
// A read-only question with an attached image; an edit of a selected element whose target stays frozen when the
// selection changes mid-run, landing as one Undo step that Undo turn reverts; a wider-scope request declined and
// then approved; a two-question interview answered with a choice and a typed answer; an attempted thread switch
// mid-run, refused, with the dock switched away and back; Stop and undo; a provider failure and Edit and try again;
// the earlier thread reopened and the project closed and opened again, its transcript and preview as they were left.
// A wait for a held run times out while other runs are finished: one run's events never end another's wait.
import assert from 'node:assert/strict';
import { LIVE_OPT_IN } from '../driver/assistant.ts';
import { Session } from '../driver/session.ts';
import { MockOpenAIServer, envelopeReply, textReply } from '../unit/mock-openai-server.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('assistant');
const session = new Session({ parentDir: WORK });
/** The session the helpers below talk to: the scripted one, then the one with a configured provider. */
let current = session;
let live = null;
let provider = null;
let passed = false;
let n = 0;

const call = (op, args, extra = {}) => current.call({ v: 1, id: `r${++n}`, op, ...(args ? { args } : {}), ...extra });
const explain = (reply) => (reply.ok ? '' : `${reply.error.code} ${reply.error.message} ${JSON.stringify(reply.error.details ?? {})}`);
const ok = async (op, args, extra) => {
  const reply = await call(op, args, extra);
  assert.equal(reply.ok, true, `${op} ${JSON.stringify(args ?? {})}: ${explain(reply)}`);
  return reply.result;
};
const refused = async (op, args, code, extra) => {
  const reply = await call(op, args, extra);
  assert.equal(reply.ok, false, `${op} ${JSON.stringify(args ?? {})} is refused`);
  assert.equal(reply.error.code, code, `${op}: ${explain(reply)}`);
  return reply.error;
};

// What a person does: find a control as the editor shows it, and use it.
const find = async (role, name, extra = {}) => (await ok('ui.locate', { role, name, scope: 'editor', ...extra })).node;
const click = async (role, name, extra = {}) => ok('ui.click', { target: { ref: (await find(role, name, extra)).ref } });
const press = (key) => ok('ui.press', { key });
/** The last of several same-named controls in the editor (in document order): the one on the latest card. */
async function clickLatest(role, name) {
  const r = await call('ui.locate', { role, name, scope: 'editor' });
  const ref = r.ok ? r.result.node.ref : (assert.equal(r.error.code, 'AMBIGUOUS_TARGET', explain(r)), r.error.details.candidates.at(-1).ref);
  return ok('ui.click', { target: { ref } });
}

// What the assistant did, and what the chat panel shows.
let latest = 0;
const observe = async (args = {}) => {
  const r = await ok('assistant.observe', args);
  latest = Math.max(latest, r.next);
  return r;
};
/** A cursor at the latest thing the assistant did. */
const mark = async () => (await observe({ after: latest })).next;
const shown = async () => (await observe({ after: latest })).shown;
const wait = (runId, after, timeoutMs = 30000) => ok('assistant.wait', { runId, ...(after !== undefined ? { after } : {}) }, { timeoutMs });
/** The run a message started, found by its request after `after`. */
const startedBy = (after, text) =>
  eventually(async () => {
    const s = (await observe({ after })).entries.find((e) => e.type === 'run.started' && e.request.text === text);
    assert.ok(s, `a run started for "${text}"`);
    return s;
  }, 15000);
/** Type a message into the composer and press Enter, as a person sends it; the run it started. */
async function send(text) {
  const box = await find('textbox', 'Message');
  await ok('ui.fill', { target: { ref: box.ref }, text });
  const at = await mark();
  await press('Enter');
  return startedBy(at, text);
}
const script = (args) => ok('assistant.script', args);
const gateState = async (name) => (await observe({ after: latest })).script.gates.find((g) => g.name === name)?.state;

// The preview, as a person sees it.
const previewHas = (role, name) =>
  eventually(async () => {
    const r = await call('ui.locate', { role, name, scope: 'preview' });
    assert.equal(r.ok, true, `the preview shows ${role} "${name}": ${explain(r)}`);
  }, 20000);
const previewLacks = async (role, name) => {
  const r = await call('ui.locate', { role, name, scope: 'preview' });
  assert.equal(r.ok ? 'found' : r.error.code, 'TARGET_NOT_FOUND', `the preview no longer shows ${role} "${name}"`);
};

// Read-only checks of the saved project: the steps History can undo, the site's name, and Home's sections.
const saved = () => session.page.evaluate(() => window.builder.project.snapshot());
const applied = async () => (await saved()).history.entries.filter((e) => e.applied).length;
const siteName = async () => (await saved()).state.site.name;
/** A prop of Home's first (the hero) or last (the call to action) section. */
const homeProp = async (which, prop) => {
  const { state } = await saved();
  const home = state.pages[state.site.homePageId];
  return home.nodes[which === 'hero' ? home.rootIds[0] : home.rootIds.at(-1)].props[prop];
};

const HERO = 'Calm, considered spaces for everyday life';
const CTA = 'Let’s make your space work better';

try {
  await session.start({ fixture: 'business-v1' });

  step('fixture: one image in the library, added through Assets from the session’s imports');
  const staged = await ok('files.stageImport', { name: 'studio-front.jpg', sample: 'hero.jpg' });
  await ok('desktop.setAnswers', { answers: [{ dialog: 'open', selection: 'files', paths: [staged.logical] }] });
  await click('button', 'Assets');
  await session.page.locator('.asset-add, .asset-drop').first().click();
  const { id: assetId, name: assetName } = await eventually(async () => {
    const images = Object.values((await session.page.evaluate(() => window.builder.project.snapshot())).state.assets.assets).filter((a) => a.kind === 'image');
    assert.equal(images.length, 1, 'the image is in the library');
    return images[0];
  }, 60000);

  step('thread A: a read-only question about the page, with the image attached from the composer’s picker');
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });
  const threadA = (await shown()).conversationId;
  assert.ok(threadA, 'the panel names the conversation it shows');
  await click('button', 'What your next message does: Edit');
  await click('menuitemradio', 'Ask', { exact: false });
  assert.equal((await shown()).composer.placeholder, 'What would you like to know?', 'the composer asks a question now');
  await click('button', 'Add images from Assets');
  await click('menuitemcheckbox', assetName);
  await eventually(async () => assert.deepEqual((await shown()).composer.images, [assetId], 'the image goes with the message'));
  if ((await call('ui.locate', { role: 'menu', scope: 'editor' })).ok) await press('Escape');
  const historyBefore = await applied();
  const nameBefore = await siteName();
  // The scripted model tries to change the site first, then reads the page and answers with what it read.
  await script({
    steps: [
      { tool: 'update_site_brand', args: { siteName: 'Never Renamed' }, status: 'Trying a change' },
      { tool: 'read_page', args: { pageId: { $context: 'pageId' } }, status: 'Reading the page' },
      { tool: 'finish', args: { message: { $result: 'sections.0.props.heading' } }, status: 'Answering' }
    ]
  });
  const ask = await send('What does the hero heading say?');
  assert.equal(ask.conversationId, threadA);
  assert.deepEqual([ask.request.mode, ask.request.images], ['ask', [assetId]], 'a question, with its image');
  const asked = await wait(ask.runId);
  assert.equal(asked.reason, 'terminal');
  assert.deepEqual([asked.run.status, asked.run.result.ask, asked.run.text], ['no-changes', true, HERO], 'the answer is what the read returned');
  assert.match(asked.run.steps.find((st) => st.status === 'error')?.detail ?? '', /Unknown tool/, 'a question cannot change the site');
  assert.equal(await siteName(), nameBefore);
  assert.equal(asked.shown.reply.result.heading, 'Answered · site unchanged', 'the reply says nothing changed');
  assert.equal(asked.shown.reply.result.reply, true, 'an answer reads as a reply, with no card');
  assert.match(asked.shown.request.caption, /Question · read only/);
  assert.deepEqual(asked.shown.request.images, [assetId], 'the request shows its image');
  // The model is the one the composer names for the next message, so it is in the turn's details, not repeated under it.
  assert.equal(asked.shown.reply.model, undefined, 'the composer\'s own model is not repeated under the turn');
  // Every step of the run in the order the app sent it, all under the run's own IDs.
  const askEntries = (await observe({ runId: ask.runId })).entries;
  assert.ok(askEntries.every((e) => e.runId === ask.runId && e.conversationId === threadA && e.messageId === ask.messageId));
  const order = askEntries.map((e) => e.type);
  assert.equal(order[0], 'run.started');
  assert.ok(order.indexOf('step') > 0 && order.indexOf('step') < order.indexOf('result'), `steps come before the result (${order.join(', ')})`);
  assert.deepEqual(askEntries.map((e) => e.seq), [...askEntries.map((e) => e.seq)].sort((a, b) => a - b), 'in order');
  assert.equal(await applied(), historyBefore, 'a question adds nothing to History');
  await previewHas('heading', HERO);

  step('a selected element is edited; the target stays the one sent when the selection changes mid-run');
  await click('button', 'What your next message does: Ask, a read-only question');
  await click('menuitemradio', 'Edit', { exact: false });
  await click('button', 'Layers');
  await click('treeitem', 'Split hero', { exact: false });
  await eventually(async () => assert.match((await shown()).composer.scopeLabel, /Split hero/, 'the composer is about the hero'));
  await script({
    steps: [
      { tool: 'update_selected_props', args: { props: { heading: 'Rooms that work' } }, status: 'Shortening the heading', gate: 'edit-held' },
      { tool: 'update_selected_props', args: { props: { lead: 'Plans, materials and light, done well.' } }, status: 'Tightening the lead' },
      { tool: 'finish', args: { message: 'Shortened the heading and the lead.' } }
    ]
  });
  const historyBeforeEdit = await applied();
  const originalLead = await homeProp('hero', 'lead');
  const edit = await send('Make the hero shorter');
  assert.deepEqual([edit.request.target, edit.request.page], ['Split hero', 'Home'], 'the request names its target as it was sent');
  await eventually(async () => assert.equal(await gateState('edit-held'), 'reached'));
  await click('treeitem', 'Call to action', { exact: false });
  await eventually(async () => assert.doesNotMatch((await shown()).composer.scopeLabel, /Split hero/, 'the selection moved on'));
  await ok('assistant.release', { gate: 'edit-held' });
  const edited = await wait(edit.runId);
  assert.deepEqual([edited.reason, edited.run.status], ['terminal', 'completed']);
  await previewHas('heading', 'Rooms that work');
  await previewHas('heading', CTA);
  assert.deepEqual([await homeProp('hero', 'heading'), await homeProp('hero', 'lead')], ['Rooms that work', 'Plans, materials and light, done well.'], 'both changes landed on the hero');
  assert.equal(await homeProp('cta', 'heading'), CTA, 'and none on what was selected meanwhile');
  assert.equal(await applied(), historyBeforeEdit + 1, 'both changes are one step in History');
  assert.ok(edited.shown.reply.result.buttons.includes('Undo turn'));

  step('Undo turn reverts both changes, and the card says so');
  await click('button', 'Undo turn');
  await previewHas('heading', HERO);
  await eventually(async () => {
    const reply = (await shown()).messages.find((m) => m.runId === edit.runId);
    assert.match(reply.result.heading, /^Undone/, 'the turn reads as undone');
  });
  assert.equal(await applied(), historyBeforeEdit);
  assert.equal(await homeProp('hero', 'lead'), originalLead, 'the lead is back too');

  step('a wider change, declined: the run stays within the selection, and still edits it');
  // The Call to action is still selected; the request is limited to it. Changing the site's name is outside it.
  await script({
    steps: [
      { tool: 'request_wider_scope', args: { question: 'May I also rename the site?' }, status: 'Asking' },
      { tool: 'update_site_brand', args: { siteName: 'Harbour Light Studio' }, status: 'Renaming the site' },
      { tool: 'update_selected_props', args: { props: { lead: 'A free first conversation, whenever suits you.' } }, status: 'Editing the call to action' },
      { tool: 'finish', args: { message: 'Kept to the call to action.' } }
    ]
  });
  const decline = await send('Match the site name to the call to action');
  const widen1 = await wait(decline.runId);
  assert.equal(widen1.reason, 'input', 'the wait ends where the author must answer');
  assert.deepEqual([widen1.run.question.widen, widen1.run.question.choices], [true, ['Yes, allow changes across the whole site', 'No, only change the selection']]);
  assert.equal(widen1.question.questionId, widen1.run.question.questionId, 'the card shows that question');
  assert.match(widen1.question.scopeNote, /change the whole site/);
  let at = await mark();
  await click('button', 'No, only change the selection');
  const declined = await wait(decline.runId, at);
  assert.deepEqual([declined.reason, declined.run.questions[0].answer], ['terminal', 'No, only change the selection']);
  assert.deepEqual(declined.shown.reply.answers, [{ question: 'May I also rename the site?', answer: 'No, only change the selection' }]);
  assert.match(declined.run.steps.find((st) => st.status === 'error')?.detail ?? '', /Unknown tool/, `the change outside the selection was refused (${JSON.stringify(declined.run.steps)})`);
  assert.equal(await siteName(), nameBefore, 'the site keeps its name');
  assert.equal(await homeProp('cta', 'lead'), 'A free first conversation, whenever suits you.', 'the change inside it landed');

  step('a wider change, approved: the same change lands');
  await script({
    steps: [
      { tool: 'request_wider_scope', args: { question: 'May I also rename the site?' }, status: 'Asking' },
      { tool: 'update_site_brand', args: { siteName: 'Harbour Light Studio' }, status: 'Renaming the site' },
      { tool: 'finish', args: { message: 'Renamed the site too.' } }
    ]
  });
  const approve = await send('Match the site name to the call to action, please');
  assert.equal((await wait(approve.runId)).reason, 'input');
  at = await mark();
  await click('button', 'Yes, allow changes across the whole site');
  const approved = await wait(approve.runId, at);
  assert.deepEqual([approved.reason, approved.run.status], ['terminal', 'completed'], JSON.stringify(approved.run.steps));
  assert.equal(await siteName(), 'Harbour Light Studio');
  await previewHas('link', 'Harbour Light Studio');

  step('thread B: an interview, answered with a choice and then a typed answer');
  await click('button', 'New conversation');
  const threadB = await eventually(async () => {
    const c = (await shown()).conversationId;
    assert.ok(c && c !== threadA, 'a new conversation is shown');
    return c;
  });
  // The Call to action is still selected; an interview is about the page, so the scope chip goes to This page.
  await click('button', 'What the AI may change', { exact: false });
  await click('menuitemradio', 'This page · Home');
  await eventually(async () => assert.equal((await shown()).composer.scopeLabel, 'What the AI may change: Home'));
  await script({
    scenario: 'interview',
    params: {
      questions: [
        { question: 'Who is the Contact page mainly for?', choices: ['New clients', 'Existing clients', 'Both equally'] },
        { question: 'Which tone should it take?', choices: ['Warm and friendly', 'Calm and understated'] }
      ],
      then: 'Headline idea: Talk to us, whenever suits you.'
    }
  });
  const interview = await send('Interview me about the Contact page, then suggest a headline');
  assert.equal(interview.conversationId, threadB);
  const q1 = await wait(interview.runId);
  assert.deepEqual([q1.reason, q1.run.question.text, q1.question.choices], ['input', 'Who is the Contact page mainly for?', ['New clients', 'Existing clients', 'Both equally']]);
  at = await mark();
  await click('button', 'Both equally');
  const q2 = await wait(interview.runId, at);
  assert.equal(q2.reason, 'input');
  assert.equal(q2.run.question.text, 'Which tone should it take?', 'the next question, not the one just answered');
  assert.notEqual(q2.run.question.questionId, q1.run.question.questionId);
  const answerBox = await find('textbox', 'Your answer');
  await ok('ui.fill', { target: { ref: answerBox.ref }, text: 'Calm and understated' });
  at = await mark();
  await press('Enter');
  const interviewed = await wait(interview.runId, at);
  assert.equal(interviewed.reason, 'terminal');
  assert.deepEqual(
    interviewed.run.questions.map((q) => [q.text, q.answer]),
    [
      ['Who is the Contact page mainly for?', 'Both equally'],
      ['Which tone should it take?', 'Calm and understated']
    ]
  );
  assert.deepEqual(
    interviewed.shown.reply.answers.map((a) => [a.question, a.answer]),
    [
      ['Who is the Contact page mainly for?', 'Both equally'],
      ['Which tone should it take?', 'Calm and understated']
    ],
    'both answers are on the turn'
  );

  step('mid-run: switching threads is refused, the dock switches away and back, and the held run’s wait is its own');
  await click('button', 'What the AI may change', { exact: false });
  await click('menuitemradio', 'Call to action', { exact: false });
  await eventually(async () => assert.match((await shown()).composer.scopeLabel, /Call to action/));
  await script({
    steps: [
      { tool: 'update_selected_props', args: { props: { heading: 'Talk to the studio' } }, status: 'Changing the heading' },
      { tool: 'finish', args: { message: 'Changed the heading.' }, gate: 'stop-held' }
    ]
  });
  const historyBeforeStop = await applied();
  const held = await send('Make the call to action warmer');
  await eventually(async () => assert.equal(await gateState('stop-held'), 'reached'));
  await previewHas('heading', 'Talk to the studio');
  for (const name of ['Earlier conversations', 'New conversation']) {
    const e = await refused('ui.click', { target: { ref: (await find('button', name)).ref }, waitMs: 300 }, 'NOT_ACTIONABLE');
    assert.deepEqual([e.details.reason, e.details.dispatched], ['disabled', 'none'], `${name} cannot be used while the AI works`);
  }
  await click('tab', 'Inspector');
  const away = await observe({ runId: held.runId });
  assert.equal(away.shown.visible, false, 'the chat is out of sight');
  assert.deepEqual([away.runs[0].state, away.runs[0].conversationId], ['working', threadB], 'and the run goes on, still in its thread');
  // Every other run is finished, in this thread and the other: none of them ends a wait for this one.
  const timedOut = await refused('assistant.wait', { runId: held.runId }, 'TIMEOUT', { timeoutMs: 2500 });
  assert.deepEqual([timedOut.details.runId, timedOut.details.state], [held.runId, 'working']);
  assert.equal(await gateState('stop-held'), 'reached', 'and the session goes on');
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });

  step('Stop and undo: the run ends stopped, and its change is gone');
  at = await mark();
  await click('button', 'Stop and undo');
  const stopped = await wait(held.runId, at);
  assert.deepEqual([stopped.reason, stopped.run.status], ['terminal', 'cancelled']);
  assert.equal(stopped.shown.reply.result.heading, 'Stopped');
  await previewHas('heading', CTA);
  await previewLacks('heading', 'Talk to the studio');
  assert.equal(await applied(), historyBeforeStop, 'a stopped run leaves nothing to undo');
  await ok('assistant.release', { gate: 'stop-held' });

  step('a provider failure shows on its turn; Edit and try again sends the request again as a new run');
  await script({ scenario: 'fail', params: { message: 'The scripted model is unavailable.' } });
  const failing = await send('Suggest a tagline for the studio');
  const failed = await wait(failing.runId);
  assert.deepEqual([failed.reason, failed.run.status], ['terminal', 'failed']);
  assert.match(failed.shown.reply.result.summary, /The scripted model is unavailable/, 'the error is shown on the turn');
  assert.ok(failed.shown.reply.result.buttons.includes('Edit and try again'));
  await script({ steps: [{ tool: 'finish', args: { message: 'Tagline: Rooms that work.' }, gate: 'retry-held' }] });
  await clickLatest('button', 'Edit and try again');
  await eventually(async () => assert.equal((await shown()).composer.value, 'Suggest a tagline for the studio', 'the request is back in the composer'));
  at = await mark();
  await press('Enter');
  const retry = await startedBy(at, 'Suggest a tagline for the studio');
  assert.notEqual(retry.runId, failing.runId, 'a new run');
  assert.notEqual(retry.request.messageId, failing.request.messageId);
  assert.equal(retry.conversationId, threadB, 'in the same thread');
  // The same words, in the same thread, after a finished run: still not this run's ending.
  await refused('assistant.wait', { runId: retry.runId }, 'TIMEOUT', { timeoutMs: 2500 });
  assert.equal((await wait(failing.runId)).run.status, 'failed', 'the failed run’s own wait still says failed');
  await ok('assistant.release', { gate: 'retry-held' });
  const retried = await wait(retry.runId);
  assert.deepEqual([retried.reason, retried.run.status, retried.run.text], ['terminal', 'no-changes', 'Tagline: Rooms that work.']);

  step('thread A reopened from the history: its own turns, and none of B’s');
  const bIds = new Set((await shown()).messages.map((m) => m.messageId));
  await click('button', 'Earlier conversations');
  await click('menuitemradio', 'What does the hero heading say?', { exact: false });
  const reopened = await eventually(async () => {
    const s = await shown();
    assert.equal(s.conversationId, threadA);
    return s;
  });
  assert.ok(reopened.messages.length >= 8, 'every turn of A');
  assert.ok(reopened.messages.every((m) => !bIds.has(m.messageId)), 'no message of B');
  assert.deepEqual(
    reopened.messages.filter((m) => m.role === 'assistant').map((m) => m.runId),
    [ask.runId, edit.runId, decline.runId, approve.runId]
  );

  step('the project closed and opened again: the transcript and the preview as they were left');
  await ok('menu.invoke', { path: ['File', 'Close Project'] });
  await eventually(async () => assert.equal((await ok('ui.snapshot', { scope: 'editor', maxNodes: 5 })).context.screen, 'welcome'), 30000);
  // The one recent project (under the name the approved run gave the site), opened from its card.
  await eventually(() => click('button', 'Open', { exact: false, region: 'Last opened project' }), 15000, 300);
  await eventually(async () => assert.equal((await ok('ui.snapshot', { scope: 'editor', maxNodes: 5 })).context.preview?.state, 'ready'), 60000);
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });
  const again = await eventually(async () => {
    const s = await shown();
    assert.equal(s.conversationId, threadA, 'the conversation left open');
    assert.ok(s.messages.length >= 8);
    return s;
  }, 30000);
  const headings = Object.fromEntries(again.messages.filter((m) => m.role === 'assistant').map((m) => [m.runId, m.result?.heading]));
  assert.deepEqual(Object.keys(headings), [ask.runId, edit.runId, decline.runId, approve.runId]);
  assert.deepEqual([headings[ask.runId], headings[decline.runId], headings[approve.runId]], ['Answered · site unchanged', 'Completed', 'Completed']);
  assert.match(headings[edit.runId], /^Undone/, 'the undone turn still reads undone');
  assert.deepEqual(
    again.messages.filter((m) => m.role === 'user').map((m) => m.text),
    ['What does the hero heading say?', 'Make the hero shorter', 'Match the site name to the call to action', 'Match the site name to the call to action, please'],
    'every request, word for word'
  );
  await previewHas('link', 'Harbour Light Studio');
  await previewHas('heading', HERO);
  await previewHas('heading', CTA);
  // The runs are still known by their keys after the reopen: the journal outlives the project and the page.
  assert.equal((await wait(approve.runId)).run.status, 'completed');

  assert.deepEqual(session.pageErrors, [], 'no page errors');
  // Closing must account for everything the session started: a cleanup failure fails the run.
  assert.equal((await ok('session.close')).ended, 'quit');

  step('a configured provider, by explicit opt-in: requests capped and time bounded by the app itself');
  // A real provider costs money, so this one is a local server in this process; the session treats it as any other.
  provider = await new MockOpenAIServer().start();
  process.env[LIVE_OPT_IN] = '1';
  live = new Session({ parentDir: WORK });
  current = live;
  latest = 0;
  const LIMITS = { maxTurns: 3, timeoutMs: 30000 };
  const started = await ok('session.start', { fixture: 'business-v1', provider: 'configured', live: { provider: 'local', baseURL: provider.baseURL, model: 'test-model', ...LIMITS } });
  assert.deepEqual(started.session.provider, { kind: 'configured', provider: 'local', model: 'test-model', ...LIMITS });
  await refused('assistant.script', { scenario: 'answer', params: { text: 'x' } }, 'OP_FAILED');
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });
  const posts = () => provider.requests.filter((r) => r.method === 'POST').length;
  provider.script(envelopeReply('finish', { message: 'Hello from the local server.' }));
  const first = await send('Say hello');
  const greeted = await wait(first.runId);
  assert.equal(greeted.reason, 'terminal');
  assert.deepEqual([greeted.budget.maxTurns, greeted.budget.turnsUsed, greeted.budget.spent], [3, 1, false]);
  // The second request is held at the server, and stays there until the time runs out.
  let letGo;
  provider.script({ ...envelopeReply('finish', { message: 'Too late.' }), hold: new Promise((r) => (letGo = r)) }, textReply('OK'));
  const second = await send('Say more');
  await eventually(async () => assert.equal(posts(), 2, 'the second request reached the server'));
  // The third turn goes to a connection test; the fourth is past the cap while the deadline is still ahead.
  const testConnection = () => live.page.evaluate(() => window.builder.ai.testProvider('local'));
  assert.equal((await testConnection()).ok, true, 'a connection test within the cap reaches the server');
  assert.equal(posts(), 3);
  const capped = await testConnection();
  assert.match(capped.message, /allows no more AI requests/, 'past the cap, it does not');
  assert.equal((await observe({ after: latest })).budget.spent, false, 'refused by the cap, not the deadline');
  assert.equal(posts(), 3, 'nothing more reached the server');
  // The app stops the held run itself when the time runs out.
  const stoppedLive = await wait(second.runId, undefined, 60000);
  assert.deepEqual([stoppedLive.reason, stoppedLive.run.status], ['terminal', 'cancelled'], 'the deadline stopped the run');
  assert.deepEqual([stoppedLive.budget.turnsUsed, stoppedLive.budget.spent], [3, true]);
  letGo();
  const box = await find('textbox', 'Message');
  await ok('ui.fill', { target: { ref: box.ref }, text: 'One more, please' });
  const refusedAt = await mark();
  await press('Enter');
  await eventually(async () => assert.ok((await shown()).notices.some((x) => /allows no more AI requests/.test(x.text)), 'the editor says why nothing was sent'));
  assert.equal((await observe({ after: refusedAt })).entries.filter((e) => e.type === 'run.started').length, 0, 'no run started');
  assert.equal(posts(), 3, 'nothing more reached the server');
  assert.equal((await ok('session.close')).ended, 'quit');

  passed = true;
  console.log('\nassistant: all checks passed');
} finally {
  for (const s of [session, live]) {
    const closed = await s?.close({ failed: !passed }).catch((e) => e);
    if (!passed && closed) console.log('session closed:', JSON.stringify(closed));
  }
  await provider?.stop().catch(() => undefined);
  delete process.env[LIVE_OPT_IN];
  if (passed) cleanup();
}
