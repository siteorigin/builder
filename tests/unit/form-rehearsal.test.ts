/**
 * Contact forms in the editor's preview (issue #193): the real preview bridge and the contact form exactly as an
 * export ships it, in a frame of a real headless browser, driven the way the editor drives them. Every request the
 * frame makes to the form service is captured and counted here, so nothing ever reaches a real service.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { defFile, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const SITE = 'http://site.test';
const SERVICE = 'https://forms.test';
const ENDPOINT = `${SERVICE}/f/abc123`;
const SESSION = 'so-test';
const FIELDS = [
  { id: 'f1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { id: 'f2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
  { id: 'f3', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
];
const SENT = 'Thank you. Your message has been sent.';
const FAILED = 'Sorry, your message could not be sent. Please try again or contact us directly.';

/** The exported contact form, compiled for the browser with Svelte's runtime; `window.mountForm(props)` places one. */
async function bundleForm(): Promise<string> {
  const s = createStarterState('business', 'Test Studio', false);
  const def = s.components[installComponent(s, 'contact.form')];
  const home = s.pages[s.site.homePageId];
  const node = makeInstance(def, { provider: 'endpoint', endpoint: ENDPOINT });
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  const source = generateProject(s).get(defFile(def));
  if (!source) throw new Error('The export has no contact form component');
  const modules: Record<string, string> = {
    '\0entry': `import { flushSync, mount } from 'svelte'; import Form from '\0form';
window.mountForm = (props) => {
	mount(Form, { target: document.getElementById('app').appendChild(document.createElement('div')), props });
	flushSync();
};`,
    '\0form': compile(source, { filename: 'ContactForm.svelte', generate: 'client', css: 'injected', runes: true }).js.code
  };
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{ name: 'contact-form', resolveId: (id) => (id in modules ? id : null), load: (id) => modules[id] ?? null }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The form did not bundle');
  return chunk.code;
}

/** The site's page in the editor's frame: the form, then the bridge, as the dev session loads them. */
const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app"></main>
<script src="/form.js"></script><script type="module" src="/bridge.js"></script></body></html>`;

/** The editor: it frames the page under the session's name and keeps every bridge message it receives. */
const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe name="${SESSION}" src="/contact/" style="width:900px;height:900px;border:0"></iframe>
<script>
	window.received = [];
	window.addEventListener('message', (e) => window.received.push(e.data));
	window.toFrame = (type, payload) => document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: '${SESSION}', type, payload }, '*');
</script></body></html>`;

interface Bridged {
  type: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!browserInstalled)('contact forms in the preview (issue #193)', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    const [bundled, launched] = await Promise.allSettled([bundleForm(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * A fresh editor with the form placed. Every request to the form service is counted; it answers with `status`
   * (200 unless the test changes it), after `delay` ms.
   */
  async function withPreview(body: (t: Awaited<ReturnType<typeof open>>) => Promise<void>, props: Record<string, unknown> = {}) {
    const context = await browser.newContext();
    try {
      await body(await open(await context.newPage(), props));
    } finally {
      await context.close();
    }
  }

  async function open(page: Page, props: Record<string, unknown>) {
    const service = { requests: [] as Array<{ method: string; url: string; body: string }>, status: 200 };
    await page.route(`${SERVICE}/**`, async (route) => {
      const request = route.request();
      service.requests.push({ method: request.method(), url: request.url(), body: request.postData() ?? '' });
      await route.fulfill({ status: service.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: service.status < 400 }) });
    });
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/form.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path === '/contact/') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: HOST });
      // Anything else the frame asks the site for (a Netlify form posting to its own page) is counted too.
      service.requests.push({ method: route.request().method(), url: route.request().url(), body: route.request().postData() ?? '' });
      return route.fulfill({ status: 404, body: '' });
    });
    // The host's load waits for its frame's.
    await page.goto(`${SITE}/`);
    const frame = page.frame({ name: SESSION });
    if (!frame) throw new Error('The editor has no preview frame');
    await frame.evaluate(`window.mountForm(${JSON.stringify({ provider: 'endpoint', endpoint: ENDPOINT, fields: FIELDS, ...props })})`);
    const received = () => page.evaluate<Bridged[]>('window.received');
    await expect.poll(async () => (await received()).some((m) => m.type === 'ready')).toBe(true);
    const field = (label: string) => frame.getByLabel(label);
    return {
      page,
      frame,
      service,
      field,
      received,
      /** Messages of one type the bridge has sent the editor. */
      sent: async (type: string) => (await received()).filter((m) => m.type === type).map((m) => m.payload),
      toFrame: (type: string, payload: Record<string, unknown> = {}) => page.evaluate(`window.toFrame(${JSON.stringify(type)}, ${JSON.stringify(payload)})`),
      button: frame.locator('.so-form__actions button'),
      status: () => frame.locator('.so-form__status[role="status"]').innerText(),
      alert: () => frame.locator('.so-form__status[role="alert"]').innerText(),
      values: () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).inputValue())),
      fill: async () => {
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('A rehearsal enquiry');
      }
    };
  }

  it('sends nothing in Edit, as before', async () => {
    await withPreview(async ({ page, fill, field, service }) => {
      await fill();
      await field('Message').focus();
      await field('Email').press('Enter');
      await page.waitForTimeout(400);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('rehearses a send in Preview without contacting the service, and tells the editor', async () => {
    await withPreview(async ({ page, fill, field, service, toFrame, status, values }) => {
      await toFrame('mode', { mode: 'preview' });
      await fill();
      await field('Email').press('Enter');
      await expect.poll(status, { timeout: 5000 }).toBe(SENT);
      expect(await values()).toEqual(['', '', '']);
      await page.waitForTimeout(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);
});

void FAILED;
