// The AI's clarification questions in the real app (issue #22): an interview of two questions answered once with a
// choice and once from the composer with Enter, every question and answer kept on the turn and after reopening the
// thread, an empty answer that sends nothing, a message drafted before the question that is kept aside and comes
// back, and ordinary chat afterwards. The model is a local OpenAI-compatible server in this process, scripted
// reply by reply, so nothing is sent to a real provider.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';

const { WORK, SHOTS, cleanup } = scratch('ai-questions');
const server = await new MockOpenAIServer().start();
let app;
let passed = false;

try {
  const launched = await launch(WORK);
  app = launched.app;
  const { win, errors } = launched;
  await win.evaluate((baseURL) => window.builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL, allowRemote: false, toolMode: 'constrained-json' } } }), server.baseURL);
  await win.reload();
  await win.waitForSelector('.welcome');

  const message = () => win.getByRole('textbox', { name: 'Message' });
  const answerBox = () => win.getByRole('textbox', { name: 'Your answer' });
  const card = () => win.locator('.question-card');
  const log = () => win.locator('.chat-log');
  /** The question and answer blocks a turn shows. */
  const exchanges = () => log().locator('.answered');
  const posts = () => server.requests.filter((r) => r.method === 'POST');
  /** Everything the model was sent in its latest request, as text. */
  const lastSent = () => JSON.stringify(posts().at(-1)?.body.messages ?? []);
  /** What the user side said in the latest request (requests, answers and tool results), never the assistant's own words. */
  const userSaid = () => JSON.stringify((posts().at(-1)?.body.messages ?? []).filter((m) => m.role === 'user' || m.role === 'tool'));

  const audience = { question: 'Who is the Contact page mainly for?', choices: ['New clients', 'Existing clients', 'Both equally'] };
  const tone = { question: 'Which tone should it take?', choices: ['Warm and friendly', 'Calm and understated', 'Direct and brisk'] };

  step('a project, with the AI tab open');
  await createProject(win, { name: 'Kloof Light Studio', parentDir: WORK, starter: 'blank', sampleImages: false });
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();

  step('an interview request; a message drafted while the AI starts');
  // The first question takes a moment, as a real model would, so there is time to draft the next message.
  server.script({ ...envelopeReply('request_clarification', audience, 'Asking about the audience'), delayMs: 2500 }, envelopeReply('request_clarification', tone, 'Asking about the tone'), envelopeReply('finish', { message: 'Headline idea: Talk to us, whenever suits you.' }));
  await message().fill('Interview me about the Contact page in two separate questions, then suggest a headline in chat only');
  await message().press('Enter');
  await eventually(async () => assert.equal(await message().inputValue(), ''));
  await message().fill('Now make the footer darker');

  step('the first question waits above the composer, which becomes the answer box');
  await card().getByText(audience.question).waitFor({ timeout: 30000 });
  assert.equal(await answerBox().inputValue(), '', 'the answer box starts empty; the drafted message is set aside');
  assert.match(await card().innerText(), /Your unsent message is kept for afterwards/);
  assert.equal(await win.getByRole('textbox', { name: 'Message' }).count(), 0, 'one text box while a question waits');

  step('while it waits, the editor says who must act and nothing keeps moving (issue #267)');
  const toolbarState = win.locator('.toolbar .save-state');
  assert.match(await toolbarState.innerText(), /AI is waiting for you/);
  assert.match(await win.locator('.ai-veil').innerText(), /question for you/);
  assert.equal(await win.locator('.dock-tab .live').getAttribute('aria-label'), 'Waiting for your answer');
  assert.equal(await win.locator('.chat .spinner').count(), 0, 'no spinner in the chat while it waits');
  assert.equal(await log().getAttribute('aria-busy'), null, 'the log is ready while the question waits for the author');
  const running = () => win.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity).length);
  assert.equal(await running(), 0, 'no animation runs without end while the AI waits for an answer');

  step('an empty answer sends nothing');
  const before = posts().length;
  await answerBox().press('Enter');
  assert.equal(await win.getByRole('button', { name: 'Send answer' }).isDisabled(), true);
  await win.waitForTimeout(400);
  assert.equal(posts().length, before);
  assert.equal(await card().getByText(audience.question).count(), 1, 'still waiting on the first question');

  step('a choice answers the first question; the second keeps the first exchange in view');
  // Text half typed for the first question belongs to it, and never carries over to the next.
  await answerBox().fill('Maybe new');
  await card().getByRole('button', { name: 'Both equally' }).click();
  await card().getByText(tone.question).waitFor({ timeout: 15000 });
  await exchanges().getByText(audience.question).waitFor();
  assert.match(await exchanges().first().innerText(), /You answered: Both equally/);
  assert.equal(await answerBox().inputValue(), '', 'the next question starts with an empty answer box');
  assert.match(userSaid(), /Both equally/, 'the model heard the first answer');
  assert.doesNotMatch(userSaid(), /Maybe new/);

  await win.locator('.chat').screenshot({ path: join(SHOTS, 'ai-questions-waiting.png') });

  step('the composer answers the second question with Enter');
  await answerBox().fill('Calm and understated');
  await answerBox().press('Enter');
  await log().getByText('No changes made').waitFor({ timeout: 15000 });
  assert.equal(await card().count(), 0, 'no question waits once the request is done');
  assert.deepEqual(await exchanges().allInnerTexts(), [`${audience.question}\nYou answered: Both equally`, `${tone.question}\nYou answered: Calm and understated`], 'both exchanges, in the order asked');
  assert.match(await log().innerText(), /Talk to us, whenever suits you/);
  assert.match(userSaid(), /Calm and understated/, 'the model heard the typed answer');

  step('back to ordinary chat: the drafted message returns and sends as a new request');
  await eventually(async () => assert.equal(await message().inputValue(), 'Now make the footer darker'));
  server.script(envelopeReply('finish', { message: 'Noted, nothing to change yet.' }));
  // An Enter straight after the typed answer is taken as the same key press, so press until the message goes.
  await eventually(
    async () => {
      if (await message().inputValue()) await message().press('Enter');
      assert.equal(await message().inputValue(), '');
    },
    10000,
    400
  );
  await log().getByText('Noted, nothing to change yet.').waitFor({ timeout: 15000 });
  await eventually(async () => assert.equal(await message().inputValue(), ''));
  const followUp = lastSent();
  for (const said of [audience.question, 'Both equally', tone.question, 'Calm and understated']) assert.ok(followUp.includes(said), `the next request includes "${said}"`);

  step('reopening the thread shows every question and answer');
  await win.getByRole('button', { name: 'New conversation' }).click();
  await eventually(async () => assert.equal(await exchanges().count(), 0));
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await win.locator('.menu [role^="menuitem"]', { hasText: 'Interview me about the Contact page' }).click();
  await exchanges().getByText(tone.question).waitFor();
  assert.deepEqual(await exchanges().allInnerTexts(), [`${audience.question}\nYou answered: Both equally`, `${tone.question}\nYou answered: Calm and understated`]);

  assert.deepEqual(errors, [], 'no page errors');
  passed = true;
  console.log('\nai-questions: all checks passed');
} finally {
  // A failed run still closes the app and the model server, so the script ends instead of hanging; it keeps
  // its scratch folder for inspection.
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  if (passed) cleanup();
}
