/**
 * The contact form as a visitor uses it, in a real headless browser: the generated component is compiled for
 * the client, bundled with Svelte's browser runtime and mounted on a stand-in page. Its POSTs are intercepted
 * and held, so each reply can be delayed, failed or let through. No real enquiry is ever sent.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { defFile, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://site.test';
const FIELDS = [
  { id: 'f1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { id: 'f2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
  { id: 'f3', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
];
const SENT = 'Thank you. Your message has been sent.';
const FAILED = 'Sorry, your message could not be sent. Please try again or contact us directly.';

/** The contact form exactly as an exported site ships it. */
function exportedFormSource(): string {
  const s = createStarterState('business', 'Test Studio', false);
  const def = s.components[installComponent(s, 'contact.form')];
  const node = makeInstance(def, { provider: 'netlify' });
  const home = s.pages[s.site.homePageId];
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  const source = generateProject(s).get(defFile(def));
  if (!source) throw new Error('The export has no contact form component');
  return source;
}

/** The component and Svelte's browser runtime as one script that defines `window.mountForm(props)`. */
async function bundleForm(): Promise<string> {
  const component = compile(exportedFormSource(), { filename: 'ContactForm.svelte', generate: 'client', css: 'injected', runes: true }).js.code;
  const modules: Record<string, string> = {
    '\0entry': "import { mount } from 'svelte'; import Form from '\0form'; window.mountForm = (props) => mount(Form, { target: document.getElementById('app'), props });",
    '\0form': component
  };
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    plugins: [{ name: 'contact-form', resolveId: (id) => (id in modules ? id : null), load: (id) => modules[id] ?? null }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The form did not bundle');
  return chunk.code;
}

interface Post {
  path: string;
  body: Record<string, string>;
  respond: (status: number) => Promise<void>;
}

describe.skipIf(!browserInstalled)('contact form with a slow form service', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundleForm(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Runs `body` against a fresh page with the form mounted; every POST waits until the test answers it. */
  async function withForm(props: Record<string, unknown>, body: (form: Awaited<ReturnType<typeof openForm>>) => Promise<void>) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const form = await openForm(page, props);
    try {
      await body(form);
    } finally {
      await form.releaseAll();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  }

  async function openForm(page: Page, props: Record<string, unknown>) {
    const held: Array<Route> = [];
    const waiting: Post[] = [];
    const listeners: Array<(p: Post) => void> = [];
    const posts: Post[] = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET') {
        if (url.pathname === '/form.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="/form.js"></script></body></html>' });
      }
      held.push(route);
      const data = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] ?? '' } }).formData();
      const post: Post = {
        path: url.pathname,
        body: Object.fromEntries([...data].map(([k, v]) => [k, String(v)])),
        respond: async (status) => {
          held.splice(held.indexOf(route), 1);
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: status < 400 }) });
        }
      };
      posts.push(post);
      const listener = listeners.shift();
      if (listener) listener(post);
      else waiting.push(post);
    });
    await page.goto(`${ORIGIN}/contact/`);
    // Runs in the page, so it is passed as text (the Node project has no DOM types).
    await page.evaluate(`window.mountForm(${JSON.stringify(props)})`);
    const field = (label: string) => page.getByLabel(label);
    return {
      page,
      field,
      posts,
      button: page.locator('.so-form__actions button'),
      status: () => page.locator('.so-form__status[role="status"]').innerText(),
      alert: () => page.locator('.so-form__status[role="alert"]').innerText(),
      nextPost: () => new Promise<Post>((resolve) => (waiting.length ? resolve(waiting.shift()!) : listeners.push(resolve))),
      editable: async () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).isEditable())),
      values: async () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).inputValue())),
      /** Types at the end of a field the way a visitor would, with real key presses. */
      typeInto: async (label: string, text: string) => {
        await field(label).focus();
        await page.keyboard.press('End');
        await page.keyboard.type(text);
      },
      releaseAll: async () => {
        for (const route of held.splice(0)) await route.abort().catch(() => {});
      }
    };
  }

  it('sends what the visitor saw, keeps every field read-only until the reply, then resets', async () => {
    await withForm({ provider: 'netlify', formName: 'contact', fields: FIELDS }, async ({ page, field, posts, button, status, nextPost, editable, values, typeInto }) => {
      await field('Name').fill('Ada');
      await field('Message').fill('First request');
      await field('Email').fill('ada@example.com');
      await field('Email').press('Enter');
      const post = await nextPost();
      expect(post.path).toBe('/contact/');
      expect(post.body).toMatchObject({ 'form-name': 'contact', name: 'Ada', email: 'ada@example.com', message: 'First request' });

      // While the reply is held back, nothing the visitor does changes what is being sent.
      await expect.poll(() => button.innerText()).toBe('Sending…');
      expect(await status()).toBe('Sending your message…');
      expect(await editable()).toEqual([false, false, false]);
      await typeInto('Message', ', corrected date');
      await typeInto('Name', ' Lovelace');
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'First request']);
      await field('Email').press('Enter');
      await page.evaluate(`document.querySelector('form').requestSubmit()`);

      await post.respond(200);
      await expect.poll(status).toBe(SENT);
      expect(await values()).toEqual(['', '', '']);
      expect(await editable()).toEqual([true, true, true]);
      expect(posts).toHaveLength(1);
    });
  }, 20_000);

  it('clears the sent message as soon as the visitor starts the next enquiry', async () => {
    await withForm({ provider: 'netlify', formName: 'contact', fields: FIELDS }, async ({ field, button, status, nextPost, typeInto }) => {
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Message').fill('First request');
      await button.click();
      await (await nextPost()).respond(200);
      await expect.poll(status).toBe(SENT);

      await typeInto('Message', 'Second');
      expect(await status()).toBe('');
      expect(await field('Message').inputValue()).toBe('Second');
    });
  }, 20_000);

  it('keeps the draft after a failure, clears the error once it is corrected, and sends the correction on retry', async () => {
    await withForm({ provider: 'endpoint', endpoint: `${ORIGIN}/f/abc`, fields: FIELDS }, async ({ field, button, status, alert, nextPost, editable, values, typeInto }) => {
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Message').fill('First request');
      await button.click();
      const first = await nextPost();
      expect(first.path).toBe('/f/abc');
      expect(first.body).toMatchObject({ name: 'Ada', message: 'First request' });
      expect(await editable()).toEqual([false, false, false]);

      await first.respond(500);
      await expect.poll(alert).toBe(FAILED);
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'First request']);
      expect(await editable()).toEqual([true, true, true]);
      expect(await button.innerText()).toBe('Send message');

      // The failure was about the last attempt; once the draft changes it no longer describes it.
      await typeInto('Message', ', corrected date');
      expect(await alert()).toBe('');

      await button.click();
      const retry = await nextPost();
      expect(retry.body).toMatchObject({ name: 'Ada', message: 'First request, corrected date' });
      expect(await editable()).toEqual([false, false, false]);
      await retry.respond(200);
      await expect.poll(status).toBe(SENT);
      expect(await alert()).toBe('');
      expect(await values()).toEqual(['', '', '']);
    });
  }, 20_000);
});
