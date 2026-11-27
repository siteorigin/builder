// Exact library images in the AI chat (issue #12), in the real app: two different photos both imported as
// hero.jpg; the second attached from its details with "Use in AI chat", kept across a page switch, and removed before
// sending (a message sent then carries no image); attached again and sent by its asset ID with no picture data; then
// the assistant asks which photo to use, the author previews one by keyboard (Escape answers nothing) and picks the
// other one, and the model hears that exact asset ID. The model is a local OpenAI-compatible server in this process, scripted reply by reply, so nothing
// is sent to a real provider.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { copiesMade, createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';

const { WORK, SHOTS, cleanup } = scratch('ai-images');
const server = await new MockOpenAIServer().start();
let app;
let passed = false;

try {
  // Two visually different photos with the same file name, size and (empty) description.
  const photos = [];
  for (const [i, colour] of [
    [1, { r: 200, g: 90, b: 40 }],
    [2, { r: 40, g: 90, b: 200 }]
  ]) {
    const dir = join(WORK, `import-${i}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hero.jpg');
    await sharp({ create: { width: 900, height: 600, channels: 3, background: colour } }).jpeg({ quality: 80 }).toFile(file);
    photos.push(file);
  }

  const launched = await launch(WORK);
  app = launched.app;
  const { win, errors } = launched;
  await win.evaluate((baseURL) => window.builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL, allowRemote: false, toolMode: 'constrained-json' } } }), server.baseURL);
  await win.reload();
  await win.waitForSelector('.welcome');

  const message = () => win.getByRole('textbox', { name: 'Message' });
  const card = () => win.locator('.question-card');
  const log = () => win.locator('.chat-log');
  const composerImages = () => win.locator('.composer .image-chip');
  const posts = () => server.requests.filter((r) => r.method === 'POST');
  /** Whether a picture in the chat has loaded from the local preview. */
  const loaded = (locator) => locator.evaluate((img) => img.complete && img.naturalWidth > 0);
  /** Every string a request sent the model, wherever it sits in the message format. */
  const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  /** The editor context the latest request of a POST carried. */
  const editorContext = (post) => {
    const said = strings(post.body.messages).filter((t) => t.includes('<editor_context>')).at(-1);
    return JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec(said)[1]);
  };

  step('a blank project with two different photos, both named hero');
  await createProject(win, { name: 'Two Heroes', parentDir: WORK, starter: 'blank', sampleImages: false });
  const imported = await win.evaluate((paths) => window.builder.project.importAssets(paths, 'image'), photos);
  assert.equal(imported.ok, true, imported.message);
  const [first, second] = imported.assetIds;
  assert.ok(first && second && first !== second, 'two assets');
  const snap = await copiesMade(win, [first, second]);
  assert.equal(snap.state.assets.assets[first].name, snap.state.assets.assets[second].name, 'both are named the same');
  const name = snap.state.assets.assets[first].name;
  /** Where the preview serves an asset's file. */
  const servedAt = (id) => `/${snap.state.assets.assets[id].file.replace(/^static\//, '')}`;
  await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'page.create', title: 'About' }] }));

  step('the second photo, opened in Assets, says which one it is and goes to the AI chat');
  await win.getByRole('button', { name: 'Assets', exact: true }).click();
  await win.locator(`[data-asset="${second}"]`).click();
  const apart = win.getByTestId('asset-same-name');
  await apart.waitFor();
  // Told apart by what an author can see of it, never by its asset ID.
  assert.match(await apart.innerText(), /^Another image has this name\. This one: .+\.$/);
  assert.ok(!(await apart.innerText()).includes(second), 'the asset ID stays out of it');
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await message().waitFor();
  await eventually(async () => assert.deepEqual(await composerImages().evaluateAll((els) => els.map((e) => e.dataset.assetId)), [second]));
  await eventually(async () => assert.equal(await loaded(composerImages().locator('img')), true, 'the attached picture shows'));
  // Attaching it again keeps one.
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await eventually(async () => assert.equal(await composerImages().count(), 1));

  step('switching pages keeps the image; removing it before sending sends nothing');
  await win.getByRole('button', { name: 'Pages', exact: true }).click();
  await win.getByRole('listbox', { name: 'Pages' }).getByRole('option', { name: /About/ }).click();
  await eventually(async () => assert.equal(await win.locator('.composer .chip', { hasText: 'About' }).count(), 1));
  assert.deepEqual(await composerImages().evaluateAll((els) => els.map((e) => e.dataset.assetId)), [second], 'the image stays with the message');
  // Another image in the library has its name, so the chip names it by ID too.
  await win.locator('.composer .image-chip').getByText(second, { exact: true }).waitFor();
  const removedAt = posts().length;
  await win.getByRole('button', { name: `Remove ${name} (${second}) from the message` }).click();
  await eventually(async () => assert.equal(await composerImages().count(), 0));
  await win.waitForTimeout(300);
  assert.equal(posts().length, removedAt, 'removing an image sends nothing');
  server.script(envelopeReply('finish', { message: 'Nothing attached, noted.' }));
  await message().fill('What should the About page say?');
  await message().press('Enter');
  await log().getByText('Nothing attached, noted.').waitFor({ timeout: 15000 });
  assert.equal(editorContext(posts()[removedAt]).attachedImages, undefined, 'a removed image is not sent');

  step('attached again and sent: the model gets the asset ID and name, never the picture');
  const before = posts().length;
  await win.getByRole('button', { name: 'Assets', exact: true }).click();
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await eventually(async () => assert.equal(await composerImages().count(), 1));
  server.script(envelopeReply('request_clarification', { question: 'Which photo should the hero use?', assetIds: [first, second], choices: ['Keep it as it is'] }, 'Asking which photo'), envelopeReply('finish', { message: 'Using the photo you chose.' }));
  await message().fill('Use this photo for the About hero, and ask me to confirm between the two hero photos');
  await message().press('Enter');
  await card().waitFor({ timeout: 30000 });
  assert.deepEqual(editorContext(posts()[before]).attachedImages, [{ assetId: second, name }], 'the attached image reaches the model by ID and name alone');
  const body = JSON.stringify(posts()[before].body);
  assert.doesNotMatch(body, /static\/assets|\.jpg|data:image|base64|image_url/, 'no file path or picture data is sent');
  await log().locator('.msg-user .image-chip').first().waitFor();
  assert.deepEqual(await log().locator('.msg-user .image-chip').evaluateAll((els) => els.map((e) => e.dataset.assetId)), [second], 'the request shows its image');

  step('the question shows both photos as pictures, told apart by their IDs');
  const choices = card().locator('.image-choice');
  assert.deepEqual(await choices.evaluateAll((els) => els.map((e) => e.dataset.assetId)), [first, second]);
  for (const id of [first, second]) {
    await card().getByText(id, { exact: true }).waitFor();
    await eventually(async () => assert.equal(await loaded(card().locator(`[data-asset-id="${id}"] img`)), true, `${id} shows`), 30000);
  }
  const srcs = await choices.locator('img').evaluateAll((els) => els.map((e) => e.currentSrc || e.src));
  // A tile shows a generated smaller copy of its photo (#223); each still shows its own, never the other's.
  const filesOf = (id) => [snap.state.assets.assets[id].file, ...(snap.state.assets.assets[id].variants ?? []).map((v) => v.file)].map((f) => `/${f.replace(/^static\//, '')}`);
  srcs.forEach((s, i) => assert.ok(filesOf([first, second][i]).includes(new URL(s).pathname), `choice ${i + 1} shows its own photo or a smaller copy of it (${new URL(s).pathname})`));
  assert.notEqual(servedAt(first), servedAt(second), 'two different files');
  assert.ok(srcs.every((s) => /^http:\/\/(127\.0\.0\.1|localhost)/.test(s)), 'the pictures load from the local preview');
  assert.equal(await card().getByRole('button', { name: 'Keep it as it is' }).count(), 1, 'the text choice stays');
  await win.locator('.chat').screenshot({ path: join(SHOTS, 'ai-images-question.png') });

  step('a keyboard preview, closed with Escape, answers nothing');
  const asked = posts().length;
  await card().getByRole('button', { name: `Preview ${name} (${second})` }).focus();
  await win.keyboard.press('Enter');
  const dialog = win.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('heading', { name: `${name} (${second})` }).waitFor();
  await eventually(async () => assert.equal(await loaded(dialog.locator('img')), true, 'the larger picture shows'));
  assert.equal(new URL(await dialog.locator('img').evaluate((e) => e.currentSrc || e.src)).pathname, servedAt(second), 'the preview shows that photo');
  // Focus starts on Close, so an Enter still held from opening it never chooses.
  assert.equal(await win.evaluate(() => document.activeElement?.textContent?.trim()), 'Close');
  await dialog.screenshot({ path: join(SHOTS, 'ai-images-preview.png') });
  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await win.waitForTimeout(300);
  assert.equal(posts().length, asked, 'closing the preview sends nothing');
  assert.equal(await card().count(), 1, 'the question still waits');

  step('choosing the other photo from its preview answers with that exact photo');
  await card().getByRole('button', { name: `Preview ${name} (${first})` }).click();
  await dialog.getByRole('heading', { name: `${name} (${first})` }).waitFor();
  await dialog.getByRole('button', { name: 'Choose this picture' }).click();
  await log().getByText('Using the photo you chose.').waitFor({ timeout: 15000 });
  // The answer reaches the model inside its tool result, so its quotes may arrive escaped.
  const chosen = strings(posts().at(-1).body.messages).flatMap((t) => [...t.matchAll(/I chose the image \\?"([^"\\]*)\\?" \(assetId: ([\w-]+)\)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(chosen, [[name, first]], 'the model heard the chosen asset ID, and only that one');
  const answered = log().locator('.answered');
  assert.match(await answered.innerText(), /You chose:/);
  assert.deepEqual(await answered.locator('.image-chip').evaluateAll((els) => els.map((e) => e.dataset.assetId)), [first]);
  // The request is done: the composer is back, empty, without the image that was sent.
  await eventually(async () => assert.equal(await message().inputValue(), ''));
  assert.equal(await composerImages().count(), 0, 'the sent image left the composer');

  assert.deepEqual(errors, [], 'no page errors');
  passed = true;
  console.log('\nai-images: all checks passed');
} finally {
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  if (passed) cleanup();
}
