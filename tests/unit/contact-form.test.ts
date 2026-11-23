/**
 * The contact form as a visitor uses it, in a real headless browser: the generated component is compiled for
 * the client, bundled with Svelte's browser runtime and mounted on a stand-in page. Its POSTs are intercepted
 * and held, so each reply can be delayed, failed or let through. No real enquiry is ever sent.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { defFile, generateProject } from '@generator/index';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { ProjectSession } from '../../src/main/project/session';

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
    plugins: [{ name: 'contact-form', resolveId: (id) => (id in modules ? id : null), load: (id) => modules[id] ?? null }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The form did not bundle');
  return chunk.code;
}

// Counts sends in the page itself, so a second send is seen the moment it starts, not when it is intercepted.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div>
<script>window.fetches = 0; const send = window.fetch; window.fetch = function (...args) { window.fetches++; return send.apply(this, args); };</script>
<script src="/form.js"></script></body></html>`;

interface Post {
  path: string;
  body: Record<string, string>;
  /** Every submitted entry in order, so a key sent twice is seen twice. */
  entries: Array<[string, string]>;
  respond: (status: number) => Promise<void>;
}

describe.skipIf(!browserInstalled)('contact form with a slow form service', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    // Settled separately, so a browser that launched is still closed when the bundle fails.
    const [bundled, launched] = await Promise.allSettled([bundleForm(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Runs `body` against a fresh page with the form mounted; every POST waits until the test answers it. */
  async function withForm(props: Record<string, unknown>, body: (form: Awaited<ReturnType<typeof openForm>>) => Promise<void>) {
    const context = await browser.newContext();
    const held: Route[] = [];
    try {
      const page = await context.newPage();
      await body(await openForm(page, props, held));
    } finally {
      for (const route of held.splice(0)) await route.abort().catch(() => {});
      for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  }

  async function openForm(page: Page, props: Record<string, unknown>, held: Route[]) {
    const waiting: Post[] = [];
    const listeners: Array<(p: Post) => void> = [];
    const posts: Post[] = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET') {
        if (url.pathname === '/form.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE });
      }
      held.push(route);
      let entries: Array<[string, string]>;
      try {
        const data = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] ?? '' } }).formData();
        entries = [...data].map(([k, v]) => [k, String(v)]);
      } catch {
        entries = [['unparsed', request.postData() ?? '']];
      }
      const body = Object.fromEntries(entries);
      const post: Post = {
        path: url.pathname,
        body,
        entries,
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
      /** Calls to fetch so far, counted in the page as each send starts. */
      fetches: () => page.evaluate<number>('window.fetches'),
      nextPost: () =>
        new Promise<Post>((resolve, reject) => {
          if (waiting.length) return resolve(waiting.shift()!);
          const take = (p: Post) => (clearTimeout(timer), resolve(p));
          const timer = setTimeout(() => (listeners.splice(listeners.indexOf(take), 1), reject(new Error('No POST reached the form service within 5s'))), 5000);
          listeners.push(take);
        }),
      editable: async () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).isEditable())),
      values: async () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).inputValue())),
      /** Types at the end of a field the way a visitor would, with real key presses. */
      typeInto: async (label: string, text: string) => {
        await field(label).focus();
        await page.keyboard.press('End');
        await page.keyboard.type(text);
      },
    };
  }

  it('sends what the visitor saw, keeps the fields read-only until the reply, then resets', async () => {
    await withForm({ provider: 'netlify', formName: 'contact', fields: FIELDS }, async ({ page, field, posts, button, status, nextPost, fetches, editable, values, typeInto }) => {
      await field('Name').fill('Ada');
      await field('Message').fill('First request');
      await field('Email').fill('ada@example.com');
      await field('Email').press('Enter');
      const post = await nextPost();
      expect(post.path).toBe('/contact/');
      expect(post.body).toMatchObject({ 'form-name': 'contact', name: 'Ada', email: 'ada@example.com', message: 'First request' });

      // While the reply is held back the draft cannot change, so the reset after success has nothing newer to discard.
      await expect.poll(() => button.innerText()).toBe('Sending…');
      expect(await status()).toBe('Sending your message…');
      expect(await editable()).toEqual([false, false, false]);
      await typeInto('Message', ', corrected date');
      await typeInto('Name', ' Lovelace');
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'First request']);
      // Neither Enter nor a scripted submit starts a second send while the first is in flight.
      await field('Email').press('Enter');
      await page.evaluate(`document.querySelector('form').requestSubmit()`);
      expect(await fetches()).toBe(1);

      await post.respond(200);
      await expect.poll(status).toBe(SENT);
      expect(await values()).toEqual(['', '', '']);
      expect(await editable()).toEqual([true, true, true]);
      expect(posts).toHaveLength(1);
      expect(await fetches()).toBe(1);
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

      // A text input this time; the failure case below edits the textarea.
      await typeInto('Name', 'Grace');
      expect(await status()).toBe('');
      expect(await field('Name').inputValue()).toBe('Grace');
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

  it('refuses to send two answers under one key, and says why (issue #198)', async () => {
    // The stock form with "EMAIL" typed into Phone's field name, as in the issue.
    const fields = [
      { id: 'item-1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
      { id: 'item-2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
      { id: 'item-3', label: 'Phone', name: 'EMAIL', type: 'tel', required: false, placeholder: '' },
      { id: 'item-4', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
    ];
    await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ page, field, button, status, posts, fetches }) => {
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Phone').fill('+44 20 7946 0000');
      await field('Message').fill('Hello');
      expect(await button.isDisabled()).toBe(true);
      expect(await status()).toBe('Two fields of this form have the same name, so it cannot be sent.');
      // Neither Enter nor a scripted submit sends it.
      await field('Email').press('Enter');
      await page.evaluate(`document.querySelector('form').requestSubmit()`);
      await page.waitForTimeout(250);
      expect(await fetches()).toBe(0);
      expect(posts).toHaveLength(0);
    });
  }, 20_000);

  it('sends each answer under its own key after fields are added, renamed, reordered, saved, reopened and exported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-form-post-'));
    try {
      const start = createStarterState('business', 'Test Studio', false);
      const defId = installComponent(start, 'contact.form');
      const node = makeInstance(start.components[defId], { provider: 'netlify', formName: 'contact' });
      const home = start.pages[start.site.homePageId];
      home.nodes[node.id] = node;
      home.rootIds.push(node.id);
      const session = await ProjectSession.create(dir, start);
      const fieldsIn = (s: ProjectState) => (s.pages[s.site.homePageId].nodes[node.id] as InstanceNode).props.fields as ListItem[];
      const idOf = (label: string) => fieldsIn(session.state).find((f) => f.label === label)!.id;
      const edit = async (op: Record<string, unknown>) => {
        const r = await session.apply({ operations: [{ owner: { kind: 'page', id: start.site.homePageId }, nodeId: node.id, prop: 'fields', ...op } as EditOperation] }, { label: 'Edit fields' });
        expect(r.ok).toBe(true);
      };
      await edit({ type: 'instance.listInsert', item: { label: 'Company' } });
      await edit({ type: 'instance.setProp', itemId: idOf('Phone'), field: 'name', value: 'EMAIL' });
      await edit({ type: 'instance.setProp', itemId: idOf('Phone'), field: 'name', value: '' });
      await edit({ type: 'instance.setProp', itemId: idOf('Email'), field: 'label', value: 'Courriel' });
      await edit({ type: 'instance.listMove', itemId: idOf('Company'), index: 0 });
      await session.close();

      const again = await ProjectSession.open(dir, 'test');
      let fields: ListItem[];
      try {
        fields = fieldsIn(again.state);
        expect(fields.map((f) => [f.label, f.name])).toEqual([
          ['Company', 'company'],
          ['Name', 'name'],
          ['Courriel', 'email'],
          ['Phone', 'phone'],
          ['Message', 'message']
        ]);
        const files = generateProject(again.state);
        // The export ships the component this suite runs, and these fields on the page.
        expect(files.get(defFile(again.state.components[defId]))).toBe(exportedFormSource());
        for (const f of fields) expect(files.get('src/routes/+page.svelte')).toContain(JSON.stringify(f.name));
      } finally {
        await again.close();
      }

      await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ field, button, nextPost }) => {
        await field('Company').fill('Acme');
        await field('Name').fill('Ada');
        await field('Courriel').fill('ada@example.com');
        await field('Phone').fill('+44 20 7946 0000');
        await field('Message').fill('Hello');
        await button.click();
        const post = await nextPost();
        expect(post.entries).toEqual([
          ['form-name', 'contact'],
          ['company', 'Acme'],
          ['name', 'Ada'],
          ['email', 'ada@example.com'],
          ['phone', '+44 20 7946 0000'],
          ['message', 'Hello'],
          ['bot-field', '']
        ]);
        await post.respond(200);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
