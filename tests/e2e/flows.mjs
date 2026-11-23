// Editing flows against the real app: inline text, insert, responsive override, undo, reorder, export.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('flows');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');
const read = (rel) => readFileSync(join(dir, rel), 'utf8');
await win.waitForTimeout(1500);
await win.screenshot({ path: join(OUT, '10-images.png') });

step('inline text edit');
const h1 = frame.locator('h1').first();
await h1.click();
await win.waitForTimeout(300);
await h1.dblclick();
await win.waitForTimeout(300);
await win.keyboard.type('Rooms that work beautifully');
await win.keyboard.press('Enter');
await eventually(() => assert.ok(read('src/routes/+page.svelte').includes('Rooms that work beautifully'), 'the new heading is written to the page source'));
assert.ok(!read('src/routes/+page.svelte').includes('data-so-'), 'no editor instrumentation in the page source');
await eventually(async () => assert.equal(await h1.innerText(), 'Rooms that work beautifully', 'the preview shows the new heading'));

step('inline rich text: bold, italic and a page link');
const rich = frame.locator('.so-rich', { hasText: 'That conversation shapes' }).first();
await rich.scrollIntoViewIfNeeded();
await rich.click();
await win.waitForTimeout(300);
await rich.dblclick();
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
await rich.evaluate((el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.nodeValue.indexOf('conversation');
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + 'conversation'.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
});
await win.keyboard.press(`${MOD}+b`);
await win.keyboard.press(`${MOD}+i`);
await win.keyboard.press(`${MOD}+k`);
await eventually(async () => assert.equal(await win.locator('[role="dialog"]').count(), 0, 'the command menu stays closed while editing text'));
await win.keyboard.type('/about/');
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"]').count(), 1, 'the words are linked'));
await win.keyboard.press(`${MOD}+Enter`);
const richSpan = async () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const about = Object.values(s.state.pages).find((x) => x.title === 'About');
    for (const n of Object.values(page.nodes)) {
      for (const b of Array.isArray(n.props?.body) ? n.props.body : []) {
        const span = b.spans?.find((x) => x.text === 'conversation');
        if (span) return { span, about: about.id };
      }
    }
    return null;
  });
await eventually(async () => {
  const found = await richSpan();
  assert.ok(found, 'the edited words are stored as their own span');
  assert.deepEqual(found.span, { text: 'conversation', strong: true, em: true, link: { type: 'page', target: found.about } }, 'bold, italic and the page ID are stored together');
});
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"] strong em').count(), 1, 'the preview shows the linked bold italic words'));
assert.ok(!read('src/lib/siteorigin/runtime/RichText.svelte').includes('data-so-'), 'no editor instrumentation in the rich text helper');

step('insert pricing via Insert panel');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Pricing' }).click();
await eventually(async () => assert.equal(await frame.locator('text=Clear packages, no surprises').count(), 1, 'one pricing section is inserted'));
await win.screenshot({ path: join(OUT, '11-inserted.png') });

step('phone-only padding override on selected section');
const phoneRule = /@media \(max-width: 767\.98px\)[\s\S]*padding-block: var\(--so-space-lg\)/;
const siteCss = () => read('src/lib/siteorigin/styles/site.css');
assert.doesNotMatch(siteCss(), phoneRule, 'no phone padding rule before the edit');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
await win.getByRole('button', { name: 'Style', exact: true }).last().click();
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'Phone', exact: true }).click();
await win.locator('.style-row', { hasText: 'Vertical padding' }).first().locator('select').selectOption('token:space.lg');
await eventually(() => assert.match(siteCss(), phoneRule, 'the phone-only padding rule is generated'));
await win.screenshot({ path: join(OUT, '12-phone.png') });

step('undo / redo');
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(() => assert.doesNotMatch(siteCss(), /padding-block: var\(--so-space-lg\)/, 'undo removes the padding rule'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(() => assert.match(siteCss(), phoneRule, 'redo restores the padding rule'));

step('copy a section, delete it, then paste it on another page');
const sectionsOn = (title) =>
  win.evaluate(async (t) => {
    const s = await window.builder.project.snapshot();
    const p = Object.values(s.state.pages).find((x) => x.title === t);
    return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name ?? p.nodes[id].kind);
  }, title);
const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first();
assert.ok(!(await sectionsOn('Contact')).includes('Services grid'), 'Contact starts without a services grid');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
await win.keyboard.press(`${MOD}+c`);
await win.locator('.toast', { hasText: 'Copied Services grid' }).waitFor();
await win.keyboard.press('Delete');
await eventually(async () => assert.ok(!(await sectionsOn('Home')).includes('Services grid'), 'the original section is deleted'));
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Contact').click();
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.ok((await sectionsOn('Contact')).includes('Services grid'), 'the copy is pasted on Contact although its original is gone'));
await eventually(() => assert.ok(read('src/routes/contact/+page.svelte').includes('Everything your project needs, in one place'), 'the copy is written to the Contact page'));
assert.equal(await win.locator('.toast.error').count(), 0, 'no paste error is shown');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.ok(!(await sectionsOn('Contact')).includes('Services grid'), 'undo takes the paste back'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.ok((await sectionsOn('Home')).includes('Services grid'), 'a second undo restores the original'));
await pageRow('Home').click();

step('place a library image already used in the Gallery from Assets (#13)');
const readingAlt = 'A reading corner with an armchair and shelves of books';
const placedReading = () =>
  win.evaluate(async () => {
    const snap = await window.builder.project.snapshot();
    const home = snap.state.pages[snap.state.site.homePageId];
    return Object.values(home.nodes).filter((n) => n.kind === 'image' && n.image.assetId === 'a_reading').map((n) => n.image.alt);
  });
const homeSections = () => win.evaluate(async () => {
  const snap = await window.builder.project.snapshot();
  return snap.state.pages[snap.state.site.homePageId].rootIds.length;
});
assert.deepEqual(await placedReading(), [], 'the reading nook starts out only in the Gallery');
const sectionsBefore = await homeSections();
const previewReading = frame.locator(`img[alt="${readingAlt}"]`);
await win.locator('.rail [aria-label="Assets"]').click();
await win.locator('[data-asset="a_reading"]').click();
// Its Gallery use selects the Gallery on Home: the copy goes right after it, in a section of its own.
await win.locator('button.asset-use[title="Show Gallery on Home"]').click();
const placeWhere = win.getByTestId('asset-place-where');
await eventually(async () => assert.equal(await placeWhere.innerText(), 'Goes in a new section after Gallery on Home. Select something on the page to put it elsewhere.'));
const shownBefore = await previewReading.count();
await win.getByRole('button', { name: 'Place on page' }).click();
await eventually(async () => assert.deepEqual(await placedReading(), [readingAlt], 'one new image on Home, with the suggested alt text'));
assert.equal(await homeSections(), sectionsBefore + 1, 'in a new section');
assert.equal(
  await win.evaluate(async () => {
    const snap = await window.builder.project.snapshot();
    const home = snap.state.pages[snap.state.site.homePageId];
    const at = home.rootIds.findIndex((id) => snap.state.components[home.nodes[id].definitionId]?.name === 'Gallery');
    const next = home.nodes[home.rootIds[at + 1]];
    return (next.slots?.content ?? []).map((id) => home.nodes[id].image?.assetId).join();
  }),
  'a_reading',
  'the new section is the one right after the Gallery'
);
await eventually(async () => assert.equal(await previewReading.count(), shownBefore + 1, 'the preview shows the placed copy beside the Gallery’s'));
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Image' }).waitFor();
await win.screenshot({ path: join(OUT, '16-placed-image.png') });
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await placedReading(), [], 'one Undo takes the placed copy away'));
assert.equal(await homeSections(), sectionsBefore, 'and its section with it');
await eventually(async () => assert.equal(await previewReading.count(), shownBefore, 'the preview shows only the Gallery’s copy again'));

step('drag to reorder: canvas grip and layers');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await win.waitForTimeout(800);
const order = async () =>
  (
    await win.evaluate(async () => {
      const s = await window.builder.project.snapshot();
      const p = s.state.pages[s.state.site.homePageId];
      return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name);
    })
  ).slice(0, 3);
assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid']);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).click();
await win.waitForTimeout(800);
const gb = await win.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
assert.ok(gb, 'the selection chip shows a drag grip');
const wrap = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await win.mouse.down();
await win.mouse.move(wrap.x + wrap.width / 2, wrap.y + 620, { steps: 8 });
await win.waitForTimeout(200);
await win.screenshot({ path: join(OUT, '16-drag.png') });
await win.mouse.up();
await eventually(async () => assert.deepEqual(await order(), ['Logo strip', 'Split hero', 'Services grid'], 'the canvas drag moves the hero below the logo strip'));
await win.locator('.list-item', { hasText: 'Split hero' }).dragTo(win.locator('.list-item', { hasText: 'Logo strip' }), { targetPosition: { x: 40, y: 4 } });
await eventually(async () => assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid'], 'the Layers drag moves the hero back to the top'));

step('edit a component everywhere: canvas, layers and inspector agree');
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'entering outlines the design on the canvas'));
// A click in the page picks the design's own node under the pointer: Layers and the inspector follow it.
const gridId = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  return s.state.pages[s.state.site.homePageId].rootIds[2];
});
const gridHeading = frame.locator(`[data-so-ctx$="|${gridId}"] h2`).first();
const headingNode = await gridHeading.getAttribute('data-so-node');
await gridHeading.click();
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${headingNode}"]`).getAttribute('aria-selected'), 'true', 'Layers selects the picked node of the design'));
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the picked node is outlined'));
await win.locator('.insp-scope.definition').first().waitFor();
// And back: Escape shows the overview, then the Layers row outlines that node on the canvas again.
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await win.locator('.ov-selected').count(), 0, 'Escape clears the selection'));
await win.locator(`[role="tree"] [data-node="${headingNode}"]`).click();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'a Layers pick in the design is outlined on the canvas'));
await win.locator('.insp-scope.definition').first().waitFor();
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

step('tone and layout combine, and a code component offers its tone');
const axis = (label) => win.locator('#dock-panel-inspect .field', { hasText: new RegExp(`^${label}`) }).locator('select').first();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
await axis('Tone').selectOption('inverse');
await axis('Layout').selectOption('four-columns');
await eventually(() => {
  const page = read('src/routes/+page.svelte');
  assert.match(page, /variant_tone="inverse"/, 'the section keeps its dark tone');
  assert.match(page, /variant_layout="four-columns"/, 'alongside its four-column layout');
});
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Contact form' }).click();
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Contact form' }).waitFor();
await axis('Tone').selectOption('muted');
await eventually(() => assert.match(read('src/routes/+page.svelte'), /variant="muted"/, 'the form takes the tone chosen in the Inspector'));
await eventually(async () => assert.equal(await frame.locator('section.so-form--muted').count(), 1, 'the preview shows the form in that tone'));

step('a contact form shows only the setting its service needs, and keeps the others');
const inspector = win.locator('#dock-panel-inspect');
const setting = (label) => inspector.getByLabel(label, { exact: true });
const SETTINGS = ['Form endpoint URL', 'Web3Forms access key', 'Netlify form name'];
const noteOf = (control) =>
  control.evaluate((el) => {
    const note = document.getElementById(el.getAttribute('aria-describedby') ?? '');
    return {
      text: note?.textContent ?? '',
      visible: !!note && note.checkVisibility() && !!el.closest('.field')?.contains(note),
      warnings: [...(note?.querySelectorAll('.field-warning') ?? [])].map((w) => w.textContent)
    };
  });
// The placed form's service values and its own FORM_UNCONNECTED message, from the project itself.
const formState = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'contact.form');
    const { provider, endpoint, accessKey, formName } = node.props;
    const warning = s.diagnostics.filter((d) => d.code === 'FORM_UNCONNECTED' && d.nodeId === node.id).map((d) => d.message).join(' ');
    return { provider, endpoint, accessKey, formName, warning };
  });
// Exactly one service setting is in the inspector. Its own visible note gives the setup steps and, while the form
// cannot send, exactly one warning, which the project check repeats.
const showsOnly = (label, setup, warning) =>
  eventually(async () => {
    for (const other of SETTINGS) assert.equal(await setting(other).count(), other === label ? 1 : 0, `${other} is ${other === label ? 'shown' : 'hidden'} for this service`);
    const note = await noteOf(setting(label));
    assert.ok(note.visible, `the note under ${label} is visible in its field`);
    for (const text of setup) assert.ok(note.text.includes(text), `the note under ${label} says “${text}”: ${note.text}`);
    assert.deepEqual(note.warnings, warning ? [warning] : [], `the note under ${label} warns ${warning ? `“${warning}”` : 'nothing'}`);
    const { warning: check } = await formState();
    if (warning) assert.ok(check.endsWith(warning), `the project check says “${warning}”: ${check}`);
    else assert.equal(check, '', 'the project check has nothing to say about the form');
  });
const service = setting('Form service');
const ENDPOINT_SETUP = ['paste the HTTPS endpoint it gives you', 'https://formspree.io/f/abc123'];
const WEB3_SETUP = ['web3forms.com', 'emails you an access key'];
const NETLIFY_SETUP = ['hosted on Netlify', 'form detection', 'then deploy'];
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Add the HTTPS endpoint your form service gives you.');
assert.equal(await service.getAttribute('aria-describedby'), null, 'the service list carries none of the setting’s note');
await service.selectOption('web3forms');
await showsOnly('Web3Forms access key', WEB3_SETUP, 'Add your Web3Forms access key.');
await setting('Web3Forms access key').fill('e2e-test-key');
await setting('Web3Forms access key').press('Enter');
await showsOnly('Web3Forms access key', WEB3_SETUP, null);
await service.selectOption('netlify');
await showsOnly('Netlify form name', NETLIFY_SETUP, null);
assert.equal(await setting('Netlify form name').inputValue(), 'contact', 'Netlify starts with a form name');
await setting('Netlify form name').fill('');
await setting('Netlify form name').press('Enter');
await showsOnly('Netlify form name', NETLIFY_SETUP, 'Add a form name for Netlify Forms.');
// A name typed and not yet committed is still a draft when the author moves to the service list.
await setting('Netlify form name').fill('enquiries');
assert.equal((await formState()).formName, '', 'the typed name is still a draft');
await service.focus();
await service.selectOption('endpoint');
await eventually(async () => {
  const { provider, formName } = await formState();
  assert.deepEqual({ provider, formName }, { provider: 'endpoint', formName: 'enquiries' }, 'leaving the name for the service list saves it');
});
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Add the HTTPS endpoint your form service gives you.');
await setting('Form endpoint URL').fill('http://insecure.example/f');
await setting('Form endpoint URL').press('Enter');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Use the full HTTPS endpoint your form service gives you, starting with https://.');
await setting('Form endpoint URL').fill('https://formspree.io/f/e2etest');
await setting('Form endpoint URL').press('Enter');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, null);
await service.selectOption('netlify');
await showsOnly('Netlify form name', NETLIFY_SETUP, null);
assert.equal(await setting('Netlify form name').inputValue(), 'enquiries', 'the Netlify form name typed before the switch is kept, and connects the form');
await service.selectOption('endpoint');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, null);
assert.equal(await setting('Form endpoint URL').inputValue(), 'https://formspree.io/f/e2etest', 'switching back shows the endpoint entered before');
await service.selectOption('web3forms');
await showsOnly('Web3Forms access key', WEB3_SETUP, null);
assert.equal(await setting('Web3Forms access key').inputValue(), 'e2e-test-key', 'switching back shows the key entered before');
assert.deepEqual(await formState(), { provider: 'web3forms', endpoint: 'https://formspree.io/f/e2etest', accessKey: 'e2e-test-key', formName: 'enquiries', warning: '' }, 'the project keeps every service’s setting');
await eventually(async () => assert.equal(await frame.locator('form.so-form__form input[name="access_key"]').inputValue(), 'e2e-test-key', 'the preview form sends that key to Web3Forms'));

step('a contact form practises its sends in Preview, and sends one real message only when the author confirms a live test (issue #193)');
// The service is answered here and counted. A .test address never resolves, so nothing could reach a real service.
const ENDPOINT = 'https://forms.e2e.test/f/rehearsal';
const delivered = [];
const deliver = async (route) => {
  delivered.push({ method: route.request().method(), url: route.request().url(), body: route.request().postData() ?? '' });
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
};
await app.context().route('https://forms.e2e.test/**', deliver);
await service.selectOption('endpoint');
await setting('Form endpoint URL').fill(ENDPOINT);
await setting('Form endpoint URL').press('Enter');
const contact = frame.locator('form.so-form__form');
await eventually(async () => assert.equal(await contact.getAttribute('action'), ENDPOINT, 'the preview form posts to the endpoint'));
const answer = async () => {
  await contact.getByLabel('Name').fill('Ada');
  await contact.getByLabel('Email').fill('ada@example.com');
  await contact.getByLabel('Message').fill('A rehearsal enquiry');
};
const formStatus = () => frame.locator('.so-form__status[role="status"]').innerText();
const formAlert = () => frame.locator('.so-form__status[role="alert"]').innerText();
const practicePanel = win.locator('.form-practice');
const practiceNote = () => practicePanel.locator('[role="status"]').innerText();

await answer();
await contact.getByRole('button', { name: 'Send message' }).press('Enter');
await contact.getByLabel('Email').press('Enter');
await win.waitForTimeout(600);
assert.equal(delivered.length, 0, 'Edit sends nothing');
assert.equal(await formStatus(), '', 'Edit shows no sent message');

await win.locator('button[title^="Preview:"]').click();
await eventually(async () => {
  const text = await practicePanel.innerText();
  assert.ok(text.includes('Form sends are simulated in Preview. Nothing is sent unless you test live delivery.'), `Preview says before any send that sends are simulated: ${text}`);
  assert.ok(text.includes('sends to forms.e2e.test/f/rehearsal'), `and where the form sends once published: ${text}`);
});
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its sent message. Nothing was sent.', 'Preview explains the practice send'));
assert.equal(await formStatus(), 'Thank you. Your message has been sent.', 'the form shows its own sent message');
assert.equal(delivered.length, 0, 'a practice send in Preview sends nothing');

await practicePanel.getByRole('button', { name: 'Error', exact: true }).click();
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its error message. Nothing was sent.', 'Preview explains the failed practice send'));
assert.equal(await formAlert(), 'Sorry, your message could not be sent. Please try again or contact us directly.', 'the form shows its own error message');
assert.equal(await contact.getByLabel('Message').inputValue(), 'A rehearsal enquiry', 'a failed send keeps the answers');
assert.equal(delivered.length, 0, 'a failed practice send sends nothing');

await practicePanel.getByRole('button', { name: /Test live delivery/ }).click();
await eventually(async () => {
  const text = await practicePanel.innerText();
  assert.ok(text.includes('Send one real test message?') && text.includes('go to forms.e2e.test/f/rehearsal'), `the live test names where it sends before it sends: ${text}`);
});
assert.equal(delivered.length, 0, 'opening the live test sends nothing');
await practicePanel.getByRole('button', { name: 'Send one real test message' }).click();
await eventually(() => assert.equal(delivered.length, 1, 'the confirmed live test sends one message'));
assert.equal(delivered[0].method, 'POST');
assert.equal(delivered[0].url, ENDPOINT, 'the live test goes to the address the author confirmed');
assert.ok(delivered[0].body.includes('A rehearsal enquiry'), 'the live test sends the answers in the form');
await eventually(async () => assert.equal(await practiceNote(), 'Live test sent to forms.e2e.test/f/rehearsal. The service answered with status 200. Check the service to see the message arrived.', 'Preview reports what the service answered'));

await practicePanel.getByRole('button', { name: 'Success', exact: true }).click();
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its sent message. Nothing was sent.', 'the next send is a practice again'));
assert.equal(delivered.length, 1, 'only the confirmed live test was sent');
await win.locator('button[title^="Edit:"]').click();
await app.context().unroute('https://forms.e2e.test/**', deliver);

step('repeatable lists: capacity, and focus after a move to either end');
if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const cards = win.locator('#dock-panel-inspect [data-list]').first();
await cards.waitFor();
const rows = cards.locator('.list-editor-head button.title');
const titles = async () => (await rows.allInnerTexts()).map((t) => t.trim());
const maxOf = async () => Number((await cards.locator('.insp-count').innerText()).split('/')[1]);
const max = await maxOf();
assert.ok(max >= (await rows.count()), 'the count shows the maximum from the schema');
await cards.getByRole('button', { name: /^Add / }).click(); // Four cards, so a middle card can move without reaching an end.
await eventually(async () => assert.equal(await rows.count(), 4, 'a card is added'));
const count = 4;
assert.equal((await cards.locator('.insp-count').innerText()).trim(), `4 / ${max}`, 'the count shows the schema maximum');
const subject = (await titles())[1];
const focusedId = () => win.evaluate(() => document.activeElement?.id ?? '');
const status = () => cards.locator('[role="status"]').innerText();
const moveTo = async (dir, expectedIndex) => {
  const button = cards.locator('.list-editor-item', { has: win.locator('button.title', { hasText: subject }) }).getByRole('button', { name: `Move ${subject} ${dir}` });
  await button.focus();
  await win.keyboard.press('Enter');
  await eventually(async () => assert.equal((await titles())[expectedIndex], subject, `${subject} moves ${dir} to position ${expectedIndex + 1}`));
  await eventually(async () => assert.match(await status(), new RegExp(`${subject} moved to position ${expectedIndex + 1} of ${count}`), 'the new position is announced'));
};
const focusedCard = async () => win.evaluate(() => document.activeElement?.closest('.list-editor-item')?.querySelector('button.title')?.textContent?.trim());
// Intermediate moves keep focus on the button that moved the card.
await moveTo('down', 2);
await eventually(async () => {
  assert.match(await focusedId(), /^list-down-/, 'focus stays on Move down for a move that is not the last');
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Move ${subject} down`, 'on the moved card\'s own button');
});
await moveTo('up', 1);
await eventually(async () => {
  assert.match(await focusedId(), /^list-up-/, 'focus stays on Move up for a move that is not the first');
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Move ${subject} up`, 'on the moved card\'s own button');
});
// Reaching either end disables the button that was used, so focus goes to the card's disclosure.
await moveTo('up', 0);
await eventually(async () => assert.match(await focusedId(), /^list-head-/, 'focus lands on the disclosure at the top'));
assert.equal(await focusedCard(), subject, 'the disclosure is the moved card');
await moveTo('down', 1);
await moveTo('down', 2);
await moveTo('down', 3);
await eventually(async () => assert.match(await focusedId(), /^list-head-/, 'focus lands on the disclosure at the bottom'));
assert.equal(await focusedCard(), subject, 'the disclosure is still the moved card');

// At the maximum Add stays in the tab order, says why, and adds nothing.
const addButton = cards.getByRole('button', { name: /^Add / });
for (let n = 4; n < max; n++) {
  await addButton.click();
  await eventually(async () => assert.equal(await rows.count(), n + 1, 'a card is added'));
}
await eventually(async () => assert.equal(await addButton.getAttribute('aria-disabled'), 'true', 'Add is marked unavailable at the maximum'));
assert.equal(await addButton.evaluate((el) => el.disabled), false, 'Add is not natively disabled, so it keeps its place in the tab order');
await addButton.focus();
assert.equal(await win.evaluate(() => document.activeElement?.classList.contains('insp-add')), true, 'Add can be focused at the maximum');
assert.match(await cards.locator('.insp-note').innerText(), new RegExp(`at most ${max} items`), 'the limit is explained at the add action');
assert.equal(await addButton.getAttribute('aria-describedby'), await cards.locator('.insp-note').getAttribute('id'), 'the explanation describes Add');
const revision = () => win.evaluate(async () => (await window.builder.project.snapshot()).revision);
const before = await revision();
await addButton.click({ force: true });
await win.waitForTimeout(400);
assert.equal(await rows.count(), max, 'a click at the maximum adds nothing');
assert.equal(await revision(), before, 'and sends no edit');
assert.equal((await cards.locator('.insp-count').innerText()).trim(), `${max} / ${max}`);

step('site styles and chat panels');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await win.screenshot({ path: join(OUT, '13-styles.png') });
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.locator('.chat-empty').waitFor(); // No provider is connected in this run.
await win.screenshot({ path: join(OUT, '14-chat.png') });
if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
await win.waitForTimeout(300);
await win.screenshot({ path: join(OUT, '15-layers.png') });

step('export static');
const t0 = Date.now();
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
console.log('export:', er.message, Date.now() - t0, 'ms');
assert.equal(er.ok, true, `static export succeeds: ${er.message} ${er.warnings?.join(' ')}`);
const about = readFileSync(join(exportDir, 'about/index.html'), 'utf8');
assert.ok(about.includes('A small studio with a long view'), 'the About page is prerendered with its content');
assert.doesNotMatch(about, /data-so-|siteorigin-bridge/, 'no editor markup in the export');
assert.ok(readFileSync(join(exportDir, 'index.html'), 'utf8').includes('Rooms that work beautifully'), 'the exported home page has the edited heading');
assert.ok(!readdirSync(exportDir).includes('.siteorigin'), 'no editor state in the export');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nflows: passed');
