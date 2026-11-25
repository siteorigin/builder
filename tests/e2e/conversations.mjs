// Finding, naming and removing single AI conversations (issue #235), as the issue verifies it: two similarly worded
// briefs and a cancelled experiment, with a scripted model behind the app's real adapter and orchestrator. The keeper
// is continued (and moves to the top by its latest activity), renamed, found by a distinctive phrase, and the
// experiment alone is deleted (after one cancelled attempt). The project is closed and opened again: the kept
// threads and their messages, the site edit the keeper made and its step in History are all still there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from '../driver/session.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('conversations');
const session = new Session({ parentDir: WORK });
let passed = false;
let n = 0;

const call = (op, args, extra = {}) => session.call({ v: 1, id: `r${++n}`, op, ...(args ? { args } : {}), ...extra });
const explain = (reply) => (reply.ok ? '' : `${reply.error.code} ${reply.error.message} ${JSON.stringify(reply.error.details ?? {})}`);
const ok = async (op, args, extra) => {
  const reply = await call(op, args, extra);
  assert.equal(reply.ok, true, `${op} ${JSON.stringify(args ?? {})}: ${explain(reply)}`);
  return reply.result;
};
const find = async (role, name, extra = {}) => (await ok('ui.locate', { role, name, scope: 'editor', ...extra })).node;
const click = async (role, name, extra = {}) => ok('ui.click', { target: { ref: (await find(role, name, extra)).ref } });
const press = (key) => ok('ui.press', { key });

let latest = 0;
const observe = async (args = {}) => {
  const r = await ok('assistant.observe', args);
  latest = Math.max(latest, r.next);
  return r;
};
const mark = async () => (await observe({ after: latest })).next;
const shown = async () => (await observe({ after: latest })).shown;
const wait = (runId, after, timeoutMs = 30000) => ok('assistant.wait', { runId, ...(after !== undefined ? { after } : {}) }, { timeoutMs });
const startedBy = (after, text) =>
  eventually(async () => {
    const s = (await observe({ after })).entries.find((e) => e.type === 'run.started' && e.request.text === text);
    assert.ok(s, `a run started for "${text}"`);
    return s;
  }, 15000);
async function send(text) {
  const box = await find('textbox', 'Message');
  await ok('ui.fill', { target: { ref: box.ref }, text });
  const at = await mark();
  await press('Enter');
  return startedBy(at, text);
}
const script = (args) => ok('assistant.script', args);
const gateState = async (name) => (await observe({ after: latest })).script.gates.find((g) => g.name === name)?.state;

const page = () => session.page;
const saved = () => page().evaluate(() => window.builder.project.snapshot());
const applied = async () => (await saved()).history.entries.filter((e) => e.applied).length;
/** The saved conversations, as Earlier conversations lists them: newest activity first. */
const listed = async () => (await page().evaluate(() => window.builder.ai.conversations())).list;

const manager = () => page().getByRole('dialog', { name: 'AI conversations' });
const row = (id) => manager().locator(`li[data-conversation-id="${id}"]`);
const openManager = async () => {
  await page().getByRole('button', { name: 'Earlier conversations' }).click();
  await page().getByRole('menuitem', { name: 'Find, rename or remove…' }).click();
  await manager().waitFor();
};

const BRIEF = 'Write a homepage design brief for Kiln and Clay, a calm ceramics studio';
const KEEPER = `${BRIEF} that runs weekend wheel-throwing workshops for beginners`;
const SECOND = `${BRIEF} that sells glazed tableware online and ships across the country`;
const EXPERIMENT = 'Interview me about the Contact page';
const PHRASE = 'terracotta accent';
const CONTINUED = `Add a ${PHRASE} to the hero and keep the photography warm`;
const NAME = 'Homepage brief (keeper)';
const DRAFT = 'Also ask me about opening hours';

try {
  await session.start({ fixture: 'business-v1' });
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });

  step('the keeper: a brief whose run renames the site');
  // An edit starts on the open page; renaming the site needs the whole site.
  await page().locator('.composer .scope-chip').click();
  await page().getByRole('menuitemradio', { name: /^Whole site/ }).click();
  await eventually(async () => assert.match(await page().locator('.composer .scope-chip').getAttribute('aria-label'), /Whole site/));
  await script({
    steps: [
      { tool: 'update_site_brand', args: { siteName: 'Kiln and Clay Studio' }, status: 'Renaming the site' },
      { tool: 'finish', args: { message: 'Drafted the brief and renamed the site.' } }
    ]
  });
  const keeper = await send(KEEPER);
  const keptRun = await wait(keeper.runId);
  assert.deepEqual([keptRun.reason, keptRun.run.status], ['terminal', 'completed']);
  const keeperId = keeper.conversationId;
  const historyAfter = await applied();
  assert.equal((await saved()).state.site.name, 'Kiln and Clay Studio');

  step('a second brief, worded the same way at first, in a new conversation');
  await click('button', 'New conversation');
  await script({ steps: [{ tool: 'finish', args: { message: 'Here is a brief for the shop.' } }] });
  const second = await send(SECOND);
  assert.equal((await wait(second.runId)).run.status, 'no-changes');
  const secondId = second.conversationId;
  assert.notEqual(secondId, keeperId);

  step('an interview experiment, stopped');
  await click('button', 'New conversation');
  await script({ steps: [{ tool: 'finish', args: { message: 'Who is the Contact page for?' }, gate: 'interview-held' }] });
  const experiment = await send(EXPERIMENT);
  await eventually(async () => assert.equal(await gateState('interview-held'), 'reached'));
  let at = await mark();
  await click('button', 'Stop and undo');
  assert.equal((await wait(experiment.runId, at)).run.status, 'cancelled');
  await ok('assistant.release', { gate: 'interview-held' });
  const experimentId = experiment.conversationId;
  // Saved when its run ended, as every conversation is.
  await eventually(async () => assert.deepEqual((await listed()).map((c) => c.id), [experimentId, secondId, keeperId], 'newest activity first'));

  step('the two briefs read apart: titles cut at a word, the manager shows each opening request in full');
  const titles = Object.fromEntries((await listed()).map((c) => [c.id, c.title]));
  assert.equal(titles[keeperId], titles[secondId], 'the same opening words make the same title');
  assert.match(titles[keeperId], /^Write a homepage design brief for Kiln and Clay, a calm\S*…$/, `cut at a word: ${titles[keeperId]}`);
  await openManager();
  await eventually(async () => assert.equal(await manager().locator('li').count(), 3));
  assert.equal(await row(keeperId).locator('.conversation-prompt').innerText(), KEEPER);
  assert.equal(await row(secondId).locator('.conversation-prompt').innerText(), SECOND);
  assert.match(await row(experimentId).innerText(), /1 request · Last active today/);

  step('the keeper reopened from the manager and continued: it moves to the top');
  await row(keeperId).getByRole('button', { name: /^Open/ }).click();
  await manager().waitFor({ state: 'detached' });
  await eventually(async () => assert.equal((await shown()).conversationId, keeperId));
  await script({ steps: [{ tool: 'finish', args: { message: 'Noted the accent for the hero.' } }] });
  const continued = await send(CONTINUED);
  assert.equal(continued.conversationId, keeperId);
  await wait(continued.runId);
  await eventually(async () => assert.deepEqual((await listed()).map((c) => c.id), [keeperId, experimentId, secondId], 'the keeper, continued last, comes first'));
  await page().getByRole('button', { name: 'Earlier conversations' }).click();
  const menuItems = page().locator('.menu [role="menuitemradio"]');
  await menuItems.first().waitFor();
  assert.equal(await menuItems.first().getAttribute('aria-checked'), 'true', 'the open conversation, first in the menu');
  assert.match(await menuItems.first().innerText(), /\d{1,2}[:.]\d{2}/, 'today’s activity is a time of day, not just “Today”');
  await press('Escape');

  step('the keeper renamed in the manager; the chat shows its name');
  await openManager();
  await row(keeperId).getByRole('button', { name: /^Rename/ }).click();
  const nameField = row(keeperId).getByRole('textbox');
  await nameField.fill(NAME);
  await nameField.press('Enter');
  await eventually(async () => assert.equal(await row(keeperId).locator('.conversation-title').innerText(), NAME));
  await eventually(async () => assert.equal(await page().locator('.chat-title').innerText(), NAME));
  assert.equal((await listed()).find((c) => c.id === keeperId)?.title, NAME);

  step('found by a distinctive phrase from a later request');
  const search = manager().getByRole('searchbox', { name: 'Find a conversation' });
  await search.fill('TERRACOTTA accent');
  await eventually(async () => assert.equal(await manager().locator('li').count(), 1));
  assert.equal(await manager().locator('li').getAttribute('data-conversation-id'), keeperId);
  assert.equal(await row(keeperId).locator('[data-testid="conversation-match"] mark').innerText(), PHRASE);
  await search.fill('');
  await eventually(async () => assert.equal(await manager().locator('li').count(), 3));
  // By its new name, from the whole list: the name is marked where it matched.
  await search.fill('keeper');
  await eventually(async () => assert.equal(await manager().locator('li').count(), 1), 5000);
  assert.equal(await manager().locator('li').getAttribute('data-conversation-id'), keeperId);
  assert.equal(await row(keeperId).locator('.conversation-title mark').innerText(), 'keeper');
  await search.fill('');
  await eventually(async () => assert.equal(await manager().locator('li').count(), 3));

  step('the experiment opened, with a message left unsent in it');
  await row(experimentId).getByRole('button', { name: /^Open/ }).click();
  await manager().waitFor({ state: 'detached' });
  await eventually(async () => assert.equal((await shown()).conversationId, experimentId));
  const box = await find('textbox', 'Message');
  await ok('ui.fill', { target: { ref: box.ref }, text: DRAFT });
  await eventually(async () => assert.equal((await shown()).composer.value, DRAFT));

  step('deleting it: cancelled once, then confirmed; its draft goes with it, nothing else does');
  await openManager();
  const confirm = page().getByRole('dialog', { name: 'Delete this conversation?' });
  await row(experimentId).getByRole('button', { name: /^Delete/ }).click();
  await confirm.waitFor();
  const asked = await confirm.innerText();
  assert.match(asked, /Changes the AI made to your site stay/);
  assert.match(asked, /The message you haven’t sent in it goes too/);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(await manager().locator('li').count(), 3, 'a cancelled delete deletes nothing');
  await row(experimentId).getByRole('button', { name: /^Delete/ }).click();
  await confirm.getByRole('button', { name: 'Delete conversation' }).click();
  await eventually(async () => assert.equal(await manager().locator('li').count(), 2));
  assert.deepEqual((await listed()).map((c) => c.id), [keeperId, secondId]);
  await manager().getByRole('button', { name: 'Close', exact: true }).last().click();
  await manager().waitFor({ state: 'detached' });
  // The open one gave way to a new conversation, with an empty composer.
  await eventually(async () => {
    const s = await shown();
    assert.notEqual(s.conversationId, experimentId);
    assert.deepEqual([s.messages.length, s.composer.value], [0, '']);
  });
  assert.equal(await page().locator('.chat-title').innerText(), 'New conversation');
  assert.equal(await applied(), historyAfter, 'History is as it was');

  step('a rename or delete from another opening of the project, or naming none, changes nothing');
  const refusedBy = (args) => page().evaluate(([fn, a]) => window.builder.ai[fn](...a).then(() => 'done', (e) => e.message), args);
  assert.match(await refusedBy(['renameConversation', [secondId, 'Not this', 'an-earlier-opening']]), /project changed/);
  assert.match(await refusedBy(['deleteConversation', [secondId]]), /project changed/);
  assert.deepEqual((await listed()).map((c) => [c.id, c.title]), [[keeperId, NAME], [secondId, titles[secondId]]]);

  step('the project closed and opened again: the kept threads, their messages and the site edit are there');
  const dir = (await saved()).dir;
  await ok('menu.invoke', { path: ['File', 'Close Project'] });
  await eventually(async () => assert.equal((await ok('ui.snapshot', { scope: 'editor', maxNodes: 5 })).context.screen, 'welcome'), 30000);
  // The Welcome screen's cards settle in as it appears: a click on one still moving is tried again once it stops.
  await eventually(() => click('button', 'Last opened just now Open', { exact: false, region: 'Recent projects' }), 15000, 300);
  await eventually(async () => assert.equal((await ok('ui.snapshot', { scope: 'editor', maxNodes: 5 })).context.preview?.state, 'ready'), 60000);
  await click('tab', 'AI', { exact: false, region: 'Right panel views' });
  // The new conversation left open was never sent to, so the one continued most recently opens: the keeper.
  const again = await eventually(async () => {
    const s = await shown();
    assert.equal(s.conversationId, keeperId, 'the keeper opens again');
    return s;
  }, 30000);
  const workspace = JSON.parse(readFileSync(join(dir, '.siteorigin', 'workspace.json'), 'utf8'));
  assert.equal(Object.hasOwn(workspace.chatDrafts ?? {}, experimentId), false, 'the deleted thread’s draft is gone');
  assert.notEqual(workspace.chatConversation, experimentId);
  assert.deepEqual(
    again.messages.filter((m) => m.role === 'user').map((m) => m.text),
    [KEEPER, CONTINUED],
    'every request in it, word for word'
  );
  await eventually(async () => assert.equal(await page().locator('.chat-title').innerText(), NAME));
  const after = await listed();
  assert.deepEqual(
    after.map((c) => [c.id, c.title]),
    [
      [keeperId, NAME],
      [secondId, titles[secondId]]
    ]
  );
  assert.deepEqual(after[1].prompts, [SECOND]);
  const chat = join(dir, '.siteorigin', 'sessions', 'chat');
  assert.equal(existsSync(join(chat, `${experimentId}.json`)), false, 'the experiment’s file is gone');
  assert.deepEqual(readdirSync(chat).sort(), [`${keeperId}.json`, `${secondId}.json`].sort());
  const reopened = await saved();
  assert.equal(reopened.state.site.name, 'Kiln and Clay Studio', 'the keeper’s site edit is still there');
  assert.equal(reopened.history.entries.filter((e) => e.applied).length, historyAfter, 'and its step in History');

  assert.deepEqual(session.pageErrors, [], 'no page errors');
  assert.equal((await ok('session.close')).ended, 'quit');
  passed = true;
  console.log('\nconversations: all checks passed');
} finally {
  const closed = await session.close({ failed: !passed }).catch((e) => e);
  if (!passed && closed) console.log('session closed:', JSON.stringify(closed));
  if (passed) cleanup();
}
