/**
 * The contact form as a visitor uses it, in a real headless browser: the generated component is compiled for
 * the client, bundled with Svelte's browser runtime and mounted on a stand-in page, beside the draft keeper the
 * generated layout runs. Its POSTs are intercepted and held, so each reply can be delayed, failed or let through.
 * No real enquiry is ever sent.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { validateState } from '@engine/validate';
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
/** A required single-choice question, for the rings of an unanswered one. */
const CHOICE = { id: 'f4', label: 'Service', name: 'service', type: 'choice', required: true, placeholder: '', options: [{ id: 'o1', label: 'Kitchen' }, { id: 'o2', label: 'Lighting' }] };
const SENT = 'Thank you. Your message has been sent.';
const FAILED = 'Sorry, your message could not be sent. Please try again or contact us directly.';

/** An exported site with a contact form on its home page. */
function exportedSite() {
  const s = createStarterState('business', 'Test Studio', false);
  const def = s.components[installComponent(s, 'contact.form')];
  const node = makeInstance(def, { provider: 'netlify' });
  const home = s.pages[s.site.homePageId];
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  return { files: generateProject(s), formFile: defFile(def) };
}

/** The contact form exactly as an exported site ships it. */
function exportedFormSource(): string {
  const { files, formFile } = exportedSite();
  const source = files.get(formFile);
  if (!source) throw new Error('The export has no contact form component');
  return source;
}

/**
 * SvelteKit's `snapshot` as its router drives it (`@sveltejs/kit` 3.4, runtime/client/snapshots.js): a mounted
 * component's registration is captured by id just before the page is left, and handed back after the page it
 * returns to has mounted. The layout's registration stays mounted throughout. Ids must be unique among mounted
 * registrations, as SvelteKit insists in development. Values go through JSON, as SvelteKit stores them in the
 * tab's session storage.
 */
const NAVIGATION_STUB = `import { onMount } from 'svelte';
const registrations = new Set();
export function snapshot(options) {
	const registration = { ...options };
	onMount(() => {
		if ([...registrations].some((r) => r.id === registration.id)) throw new Error('Two snapshots share the id ' + registration.id);
		registrations.add(registration);
		return () => registrations.delete(registration);
	});
}
window.snapshotRegistrations = () => [...registrations].map((r) => ({ id: r.id, reset: typeof r.reset === 'function' }));
window.captureSnapshots = () => Object.fromEntries([...registrations].map((r) => [r.id, JSON.stringify(r.capture() ?? null)]));
window.restoreSnapshots = (values) => {
	for (const r of registrations) if (values && Object.hasOwn(values, r.id)) r.restore(JSON.parse(values[r.id]));
};`;

/** `$app/state`: the page the router is on, which a test can move to stand for another page of the site. */
const STATE_STUB = `export const page = {
	get url() {
		return new URL(window.pagePath ?? location.pathname, location.href);
	}
};`;

/**
 * The component, the exported draft keeper and Svelte's browser runtime as one script. It mounts a stand-in for
 * the root layout, which runs the keeper for as long as the page is open, and defines `window.mountForm(props,
 * inShell)`, which adds a form to the page's <main> or to the header and footer around it, and
 * `window.unmountForms()`, which takes the page's forms off it as leaving the page does.
 */
async function bundleForm(): Promise<string> {
  const { files, formFile } = exportedSite();
  const compiled = (source: string, filename: string) => compile(source, { filename, generate: 'client', css: 'injected', runes: true }).js.code;
  const layout = files.get('src/routes/+layout.svelte') ?? '';
  // The keeper exactly as the export ships it, and only if the exported layout really runs it.
  if (!layout.includes("import { keepDrafts } from '../lib/siteorigin/runtime/drafts.js';") || !/^\tkeepDrafts\(\);$/m.test(layout)) throw new Error('The exported layout does not keep drafts');
  const modules: Record<string, string> = {
    '\0entry': `import { flushSync, mount, unmount } from 'svelte'; import Form from '\0form'; import Layout from '\0layout';
mount(Layout, { target: document.body.appendChild(document.createElement('div')) });
flushSync();
const forms = [];
window.mountForm = (props, inShell = false) => {
	const target = document.getElementById(inShell ? 'shell' : 'app').appendChild(document.createElement('div'));
	const form = mount(Form, { target, props });
	if (!inShell) forms.push(form);
	flushSync();
};
window.unmountForms = () => {
	for (const form of forms.splice(0)) unmount(form);
	document.getElementById('app').replaceChildren();
};`,
    '\0form': compiled(files.get(formFile)!, 'ContactForm.svelte'),
    '\0layout': compiled(`<script>\n\timport { keepDrafts } from '\\0drafts';\n\tkeepDrafts();\n</script>\n`, 'Layout.svelte'),
    '\0drafts': files.get(`${RUNTIME_DIR}/drafts.js`)!,
    '../runtime/visitor-text.js': files.get(`${RUNTIME_DIR}/visitor-text.js`)!,
    '../runtime/util.js': files.get(`${RUNTIME_DIR}/util.js`)!,
    '$app/navigation': NAVIGATION_STUB,
    '$app/state': STATE_STUB
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
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="shell"></div><main id="app"></main>
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
    // Among the forms' fields: a form itself is named by its heading ("Send us a message"), which holds a field's label.
    const field = (label: string) => page.locator('form').getByLabel(label);
    return {
      page,
      field,
      posts,
      button: page.locator('.so-form__actions button'),
      status: () => page.locator('.so-form__status[role="status"]').innerText(),
      alert: () => page.locator('.so-form__status[role="alert"]').innerText(),
      // Why the form cannot be sent, in its status line under the button.
      notice: () => page.locator('.so-form__status--setup[role="status"]').innerText(),
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
      /** What the router keeps for this history entry when the visitor moves to another one. */
      capture: () => page.evaluate<Record<string, string>>('window.captureSnapshots()'),
      /** Leaves the page as client-side navigation does: the entry's snapshot is captured, then every form unmounts. */
      leave: async () => {
        const kept = await page.evaluate<Record<string, string>>('window.captureSnapshots()');
        await page.evaluate('window.unmountForms()');
        return kept;
      },
      /**
       * Comes to the page with these forms: a new visit when nothing was kept, or Back to an entry, whose snapshot
       * the router hands back once the page has mounted.
       */
      arrive: async (forms: Array<Record<string, unknown>>, kept?: Record<string, string>) => {
        for (const p of forms) await page.evaluate(`window.mountForm(${JSON.stringify(p)})`);
        if (kept) await page.evaluate(`window.restoreSnapshots(${JSON.stringify(kept)})`);
      },
      /** Adds a form to the header or footer, which stays mounted as the visitor moves between pages. */
      inShell: (props: Record<string, unknown>) => page.evaluate(`window.mountForm(${JSON.stringify(props)}, true)`),
      /** Restores a kept snapshot into the forms still mounted, as a Back between two entries of one page does. */
      restore: (kept: Record<string, string>) => page.evaluate(`window.restoreSnapshots(${JSON.stringify(kept)})`),
      /** The page the router reports, standing for another page of the site. */
      onPage: (path: string) => page.evaluate(`window.pagePath = ${JSON.stringify(path)}`),
      registrations: () => page.evaluate<Array<{ id: string; reset: boolean }>>('window.snapshotRegistrations()')
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

  it('heads the emptied form with the sent message, focused, and clears it as soon as the visitor starts the next enquiry', async () => {
    await withForm({ provider: 'netlify', formName: 'contact', fields: FIELDS }, async ({ page, field, button, status, nextPost, typeInto }) => {
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Message').fill('First request');
      await button.click();
      await (await nextPost()).respond(200);
      await expect.poll(status).toBe(SENT);
      // Out of sight of the button at the form's end, the confirmation takes the focus.
      await expect.poll(() => page.evaluate<string | null>(`document.activeElement?.getAttribute('role') ?? null`)).toBe('status');

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
      expect(first.entries.map(([k]) => k)).toEqual(['name', 'email', 'message', '_gotcha']);
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

  it('draws what is wrong in the error colour of the form’s ground: the light grounds’, or dark sections’ (#1016)', async () => {
    // The site's colours as the theme's stylesheet sets them, each one distinct so the test can tell which is drawn.
    const COLORS = `:root { --so-color-text: rgb(17, 17, 17); --so-color-on-inverse: rgb(240, 240, 240); --so-color-surface: rgb(255, 255, 255);
      --so-color-inverse: rgb(20, 33, 29); --so-color-error: rgb(179, 38, 30); --so-color-error-on-inverse: rgb(255, 138, 128); }`;
    for (const [variant, ground] of [['default', 'rgb(179, 38, 30)'], ['inverse', 'rgb(255, 138, 128)']] as const)
      await withForm({ provider: 'endpoint', endpoint: `${ORIGIN}/f/abc`, fields: [...FIELDS, CHOICE], variant }, async ({ page, field, button, nextPost, alert }) => {
        await page.addStyleTag({ content: COLORS });
        // Sent from a script, which has the browser refuse every unanswered field in one attempt.
        await page.evaluate(`document.querySelector('form').requestSubmit()`);
        const wrong = page.locator('.so-form__control[aria-invalid="true"]').first();
        await expect.poll(() => wrong.count()).toBe(1);
        const drawn = (selector: string, props: string[]) =>
          page.evaluate(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return ${JSON.stringify(props)}.map((p) => s.getPropertyValue(p)); })()`);
        // The message and its mark in the ground's error colour; the field's outer edge on the ground, its inner edge
        // on the field's own card-coloured fill, so each reads where it is drawn. The heavier edge stays.
        expect(await drawn('.so-form__error', ['color']), variant).toEqual([ground]);
        // Polled: the edge eases in.
        await expect.poll(() => drawn('.so-form__control[aria-invalid="true"]', ['border-top-color', 'box-shadow']), { message: variant }).toEqual([ground, 'rgb(179, 38, 30) 0px 0px 0px 1px inset']);
        // The unanswered choices' rings too, at rest and under the pointer.
        await expect.poll(() => drawn('.so-form__choices--invalid input', ['border-top-color', 'box-shadow']), { message: `${variant} choices` }).toEqual([ground, 'rgb(179, 38, 30) 0px 0px 0px 1px inset']);
        // Under the pointer, read once the edge has had time to ease to whatever it turns to (a poll would take the first).
        const settle = () => page.waitForTimeout(400);
        await page.locator('.so-form__choices--invalid .so-form__choice').first().hover();
        await settle();
        expect(await drawn('.so-form__choices--invalid .so-form__choice:hover input', ['border-top-color']), `${variant} choice on hover`).toEqual([ground]);
        // A field to put right keeps its edge under the pointer once it no longer has focus.
        await page.evaluate(`document.activeElement.blur()`);
        await wrong.hover();
        await expect.poll(() => page.evaluate(`document.querySelector('.so-form__control[aria-invalid="true"]').matches(':hover:not(:focus)')`)).toBe(true);
        await settle();
        expect(await drawn('.so-form__control[aria-invalid="true"]', ['border-top-color']), `${variant} on hover`).toEqual([ground]);
        // A failed send says so in the same colour.
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('Hello');
        await page.getByRole('radio', { name: 'Kitchen' }).check();
        await button.click();
        await (await nextPost()).respond(500);
        await expect.poll(alert).toBe(FAILED);
        expect(await drawn('.so-form__status[role="alert"]', ['color']), variant).toEqual([ground]);
      });
  }, 30_000);

  it('refuses to send two answers under one key, and says why (issue #198)', async () => {
    // The stock form with "EMAIL" typed into Phone's field name, as in the issue.
    const fields = [
      { id: 'item-1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
      { id: 'item-2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
      { id: 'item-3', label: 'Phone', name: 'EMAIL', type: 'tel', required: false, placeholder: '' },
      { id: 'item-4', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
    ];
    await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ page, field, button, notice, posts, fetches }) => {
      // Any POST, a native one included, is counted the moment it starts.
      let sends = 0;
      page.on('request', (r) => void (r.method() === 'POST' && sends++));
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Phone').fill('+44 20 7946 0000');
      await field('Message').fill('Hello');
      expect(await button.isDisabled()).toBe(true);
      expect(await notice()).toBe('Two fields of this form have the same name, so it cannot be sent.');
      // Neither Enter nor a scripted submit sends it.
      await field('Email').press('Enter');
      await page.evaluate(`document.querySelector('form').requestSubmit()`);
      await page.waitForTimeout(250);
      expect(await fetches()).toBe(0);
      expect(sends).toBe(0);
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
      expect(validateState(session.state).filter((d) => d.code === 'FORM_FIELD_KEYS').map((d) => d.message)).toEqual([expect.stringContaining('“Email” and “Phone” fields are both sent as “email”')]);
      await edit({ type: 'instance.setProp', itemId: idOf('Phone'), field: 'name', value: '' });
      await edit({ type: 'instance.setProp', itemId: idOf('Email'), field: 'label', value: 'Courriel' });
      await edit({ type: 'instance.listMove', itemId: idOf('Company'), index: 0 });
      await session.close();

      const again = await ProjectSession.open(dir, 'test');
      let fields: ListItem[];
      try {
        expect(fieldsIn(again.state).map((f) => [f.label, f.name])).toEqual([
          ['Company', 'company'],
          ['Name', 'name'],
          ['Courriel', 'email'],
          ['Phone', 'phone'],
          ['Message', 'message']
        ]);
        const files = generateProject(again.state);
        // The export ships the component this suite runs; the form is mounted with the fields its page passes.
        expect(files.get(defFile(again.state.components[defId]))).toBe(exportedFormSource());
        const emitted = /^\tfields=\{(.*)\}$/m.exec(files.get('src/routes/+page.svelte')!);
        if (!emitted) throw new Error('The exported page passes the form no fields');
        fields = JSON.parse(emitted[1]);
        expect(fields.map((f) => f.name)).toEqual(['company', 'name', 'email', 'phone', 'message']);
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

  describe('single-choice questions and checkboxes (issue #238)', () => {
    const SERVICE = 'Which service are you interested in?';
    const ENDPOINT = `${ORIGIN}/f/abc`;
    let serverForm: Component<Record<string, unknown>>;
    let dir: string;

    beforeAll(async () => {
      // The exported component rendered on the server, as a page reaches a visitor whose JavaScript is off.
      mkdirSync(resolve('.tmp'), { recursive: true });
      dir = mkdtempSync(join(resolve('.tmp'), 'contact-form-ssr-'));
      // Beside the runtime it imports, as in the exported site.
      mkdirSync(join(dir, 'components'));
      mkdirSync(join(dir, 'runtime'));
      for (const file of ['visitor-text.js', 'util.js']) writeFileSync(join(dir, 'runtime', file), exportedSite().files.get(`${RUNTIME_DIR}/${file}`)!);
      writeFileSync(join(dir, 'components', 'form.js'), compile(exportedFormSource(), { filename: 'ContactForm.svelte', generate: 'server', runes: true }).js.code);
      serverForm = (await import(/* @vite-ignore */ join(dir, 'components', 'form.js'))).default;
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * The fields of a form authored in the editor and exported: the stock fields, then a required question whose
     * second choice was renamed after it was made, an optional checkbox and a required one.
     */
    function authoredFields(props: Record<string, unknown>): Array<Record<string, unknown>> {
      const s = createStarterState('business', 'Test Studio', false);
      const defId = installComponent(s, 'contact.form');
      const node = makeInstance(s.components[defId], props);
      const home = s.pages[s.site.homePageId];
      home.nodes[node.id] = node;
      home.rootIds.push(node.id);
      const at = (op: Record<string, unknown>) => ({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id, prop: 'fields', ...op }) as EditOperation;
      let state = applyOperations(s, [
        at({ type: 'instance.listInsert', item: { label: SERVICE, type: 'choice', required: true, options: ['Kitchen', 'Lighting', 'Other'] } }),
        at({ type: 'instance.listInsert', item: { label: 'Send me a copy', type: 'checkbox' } }),
        at({ type: 'instance.listInsert', item: { label: 'I agree to be contacted', type: 'checkbox', required: true } })
      ]).state;
      const service = ((state.pages[state.site.homePageId].nodes[node.id] as InstanceNode).props.fields as ListItem[]).find((f) => f.label === SERVICE)!;
      const renamed = (service.options as Array<Record<string, string>>).map((o) => (o.label === 'Lighting' ? { ...o, label: 'Éclairage' } : o));
      state = applyOperations(state, [at({ type: 'instance.setProp', itemId: service.id, field: 'options', value: renamed })]).state;
      const files = generateProject(state);
      expect(files.get(defFile(state.components[defId]))).toBe(exportedFormSource());
      const emitted = /^\tfields=\{(.*)\}$/m.exec(files.get('src/routes/+page.svelte')!);
      if (!emitted) throw new Error('The exported page passes the form no fields');
      return JSON.parse(emitted[1]);
    }

    /** What the service receives: the stock answers, the renamed choice under the value it was made with, consent. */
    const ANSWERS: Array<[string, string]> = [
      ['name', 'Ada'],
      ['email', 'ada@example.com'],
      ['phone', ''],
      ['message', 'A new kitchen'],
      ['which-service-are-you-interested-in', 'Lighting'],
      ['i-agree-to-be-contacted', 'yes']
    ];

    /** Fills in the text answers, then shows that neither the unanswered question nor unticked consent lets it go. */
    async function answerAll(page: Page, submit: () => Promise<void>, sent: () => Promise<number> | number) {
      // The question is a radio group named by its legend.
      const question = page.getByRole('radiogroup', { name: SERVICE });
      expect(await question.getByRole('radio').count()).toBe(3);
      expect(await question.getByRole('radio', { name: 'Éclairage', exact: true }).getAttribute('value')).toBe('Lighting');
      await page.locator('form').getByLabel('Name').fill('Ada');
      await page.locator('form').getByLabel('Email').fill('ada@example.com');
      await page.locator('form').getByLabel('Message').fill('A new kitchen');
      await submit();
      await page.waitForTimeout(250);
      expect(await sent()).toBe(0);
      expect(await page.locator('input[type="radio"]:invalid').count()).toBe(3);
      await question.getByRole('radio', { name: 'Éclairage', exact: true }).check();
      expect(await page.locator('input[type="radio"]:invalid').count()).toBe(0);
      await submit();
      await page.waitForTimeout(250);
      expect(await sent()).toBe(0);
      // Only the required checkbox holds it back; the optional one is simply not sent while unticked.
      expect(await page.locator('input[type="checkbox"]:invalid').count()).toBe(1);
      await page.getByRole('checkbox', { name: 'I agree to be contacted' }).check();
      expect(await page.getByRole('checkbox', { name: 'Send me a copy' }).isChecked()).toBe(false);
    }

    it('asks with labelled native controls, sends nothing until required answers are given, then sends the visitor’s choice', async () => {
      const fields = authoredFields({ provider: 'netlify', formName: 'contact' });
      await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ page, button, status, alert, nextPost, fetches, posts }) => {
        await answerAll(page, () => button.click(), fetches);
        await button.click();
        const failed = await nextPost();
        expect(failed.entries).toEqual([['form-name', 'contact'], ...ANSWERS, ['bot-field', '']]);
        // While the reply is held back the answers cannot change, as the text fields cannot.
        const kitchen = page.getByRole('radio', { name: 'Kitchen' });
        const agree = page.getByRole('checkbox', { name: 'I agree to be contacted' });
        await expect.poll(() => kitchen.isDisabled()).toBe(true);
        expect(await agree.isDisabled()).toBe(true);
        expect(await page.getByRole('checkbox', { name: 'Send me a copy' }).isDisabled()).toBe(true);
        await failed.respond(500);
        await expect.poll(alert).toBe(FAILED);
        // A failure keeps every answer, and lets the visitor change them again.
        expect(await page.getByRole('radio', { name: 'Éclairage' }).isChecked()).toBe(true);
        expect(await agree.isChecked()).toBe(true);
        expect(await kitchen.isEnabled()).toBe(true);
        await page.getByRole('checkbox', { name: 'Send me a copy' }).check();
        await button.click();
        const sent = await nextPost();
        expect(sent.entries).toEqual([['form-name', 'contact'], ...ANSWERS.slice(0, 5), ['send-me-a-copy', 'yes'], ANSWERS[5], ['bot-field', '']]);
        await sent.respond(200);
        await expect.poll(status).toBe(SENT);
        expect(await page.locator('input:checked').count()).toBe(0);
        expect(await kitchen.isEnabled()).toBe(true);
        expect(posts).toHaveLength(2);
      });
    }, 20_000);

    it('refuses to send while a question has nothing to choose from, and says why', async () => {
      const fields = [...FIELDS, { id: 'f4', label: SERVICE, name: 'service', type: 'choice', required: true, placeholder: '', options: [] }];
      await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ page, button, notice, fetches }) => {
        expect(await page.getByRole('radiogroup', { name: SERVICE }).getByRole('radio').count()).toBe(0);
        expect(await button.isDisabled()).toBe(true);
        expect(await notice()).toBe('A question in this form has no answers to choose from yet, so it cannot be sent.');
        await page.evaluate(`document.querySelector('form').requestSubmit()`);
        await page.waitForTimeout(250);
        expect(await fetches()).toBe(0);
      });
    }, 20_000);

    it('sends the same answers without JavaScript, and the browser holds back an unanswered required one', async () => {
      const props = { provider: 'endpoint', endpoint: ENDPOINT };
      const fields = authoredFields(props);
      const html = render(serverForm, { props: { ...props, fields } }).body;
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        const posts: Array<{ url: string; type: string; entries: Array<[string, string]> }> = [];
        await page.route(`${ORIGIN}/**`, async (route) => {
          const request = route.request();
          if (request.method() === 'GET') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><main>${html}</main></body></html>` });
          const type = request.headers()['content-type'] ?? '';
          const data = await new Response(request.postDataBuffer(), { headers: { 'content-type': type } }).formData();
          posts.push({ url: request.url(), type, entries: [...data].map(([k, v]) => [k, String(v)]) });
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><p>Received</p>' });
        });
        await page.goto(`${ORIGIN}/contact/`);
        const button = page.getByRole('button', { name: 'Send message' });
        await answerAll(page, () => button.click(), () => posts.length);
        await Promise.all([page.waitForURL(ENDPOINT), button.click()]);
        // An ordinary form post, straight to the service.
        expect(posts).toEqual([{ url: ENDPOINT, type: 'application/x-www-form-urlencoded', entries: [...ANSWERS, ['_gotcha', '']] }]);
      } finally {
        await context.close();
      }
    }, 20_000);
  });

  describe('in the tab history (issue #274)', () => {
    const PROPS = { provider: 'endpoint', endpoint: `${ORIGIN}/f/abc`, fields: FIELDS };
    const ENQUIRY = ['Ada', 'ada@example.com', 'A question about materials'];
    const EMPTY = ['', '', ''];
    type Kept = Record<string, string>;
    /** What the layout's registration kept for an entry: the page, and a draft per form that had one. */
    const kept = (snapshot: Kept) =>
      JSON.parse(snapshot['siteorigin-drafts'] ?? 'null') as { path: string; drafts: Array<{ key: string; n: number; message: string; values: string[][] }> } | null;
    /** Everything the page keeps in storage, as text, to search for answers. */
    const stored = (page: Page) => page.evaluate<string>('JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } })');
    const fillEnquiry = async (field: (label: string) => ReturnType<Page['getByLabel']>) => {
      await field('Name').fill('Ada');
      await field('Email').fill('ada@example.com');
      await field('Message').fill('A question about materials');
    };

    it('brings an unsent enquiry back on Back to its entry, not to a new visit, and sends nothing', async () => {
      await withForm(PROPS, async ({ page, field, values, leave, arrive, fetches, posts, registrations }) => {
        // One registration for the whole site, held by the layout, and no reset: a new entry never clears a form.
        expect(await registrations()).toEqual([{ id: 'siteorigin-drafts', reset: false }]);
        // A form that has not opted in is never kept, whatever its controls are marked with.
        await page.evaluate(`document.getElementById('app').insertAdjacentHTML('beforeend', '<form><input data-draft-field="f1" value="Not kept"></form>')`);
        await fillEnquiry(field);
        const typedIn = await leave();
        // The page, then the answers by field id: never the provider's hidden fields or the spam trap.
        expect(kept(typedIn)).toEqual({
          path: '/contact',
          drafts: [{ key: 'page f1 f2 f3', n: 0, message: expect.any(String), values: [['f1', 'Ada'], ['f2', 'ada@example.com'], ['f3', 'A question about materials']] }]
        });
        // Following a link back to the page is a new visit, which starts empty.
        await arrive([PROPS]);
        expect(await values()).toEqual(EMPTY);
        const newVisit = await leave();
        expect(kept(newVisit)).toBeNull();
        await arrive([PROPS], typedIn);
        expect(await values()).toEqual(ENQUIRY);
        await leave();
        await arrive([PROPS], newVisit);
        expect(await values()).toEqual(EMPTY);
        expect(await fetches()).toBe(0);
        expect(posts).toHaveLength(0);
        // Nothing the visitor typed went into the address or into storage of the site's own.
        expect(page.url()).toBe(`${ORIGIN}/contact/`);
        expect(await stored(page)).not.toMatch(/Ada|example\.com|materials/);
      });
    }, 20_000);

    it('never hands one page’s draft to another page that reuses its history entry', async () => {
      await withForm(PROPS, async ({ field, values, leave, arrive, onPage }) => {
        // A site published under a sub-path, on a host that also answers without the trailing slash.
        await onPage('/studio/contact/');
        await fillEnquiry(field);
        const contact = await leave();
        await onPage('/studio/contact');
        await arrive([PROPS], contact);
        expect(await values()).toEqual(ENQUIRY);
        // SvelteKit reuses an abandoned entry's slot for an in-page link on another page, with the old snapshot in it.
        for (const other of ['/studio/', '/studio/about/', '/']) {
          await leave();
          await onPage(other);
          await arrive([PROPS], contact);
          expect(await values(), other).toEqual(EMPTY);
        }
      });
    }, 20_000);

    it('never brings a sent message back, from its own entry, an older one, or after a reload', async () => {
      await withForm(PROPS, async ({ page, field, button, status, values, capture, leave, arrive, nextPost }) => {
        // The visitor leaves the enquiry unsent and comes back to it with Back, then sends it.
        await fillEnquiry(field);
        const typedIn = await leave();
        await arrive([PROPS], typedIn);
        // SvelteKit also keeps the entry's snapshot when the tab is hidden; here that happens just before sending.
        const hidden = await capture();
        await button.click();
        const post = await nextPost();
        // A message on its way is no longer a draft, whatever the reply.
        expect(kept(await capture())).toBeNull();
        await post.respond(200);
        await expect.poll(status).toBe(SENT);

        const sentIn = await leave();
        expect(kept(sentIn)).toBeNull();
        for (const older of [typedIn, hidden]) {
          await arrive([PROPS], older);
          expect(await values()).toEqual(EMPTY);
          await leave();
        }
        await page.reload();
        await arrive([PROPS], typedIn);
        expect(await values()).toEqual(EMPTY);
        // The tab remembers only an opaque id for the sent message.
        expect(await stored(page)).not.toMatch(/Ada|example\.com|materials/);
      });
    }, 20_000);

    it('does not bring back a message the visitor left while it was sending, once it has been sent', async () => {
      await withForm(PROPS, async ({ field, button, values, capture, leave, arrive, nextPost }) => {
        await fillEnquiry(field);
        const beforeSending = await capture();
        await button.click();
        const post = await nextPost();
        const leftWhileSending = await leave();
        expect(kept(leftWhileSending)).toBeNull();
        await post.respond(200);
        await arrive([PROPS], leftWhileSending);
        expect(await values()).toEqual(EMPTY);
        await leave();
        await arrive([PROPS], beforeSending);
        expect(await values()).toEqual(EMPTY);
      });
    }, 20_000);

    it('gives a message back after a failed send, older copies included, and keeps an unsent draft from another visit after a send', async () => {
      await withForm(PROPS, async ({ page, field, button, status, alert, values, capture, leave, arrive, nextPost }) => {
        await fillEnquiry(field);
        const typedIn = await leave();
        await arrive([PROPS], typedIn);
        await button.click();
        const failing = await nextPost();
        // A second submit while the first is on its way is refused by the form and changes nothing here.
        await page.evaluate(`document.querySelector('main form').requestSubmit()`);
        await failing.respond(500);
        await expect.poll(alert).toBe(FAILED);
        const failedIn = await leave();
        expect(kept(failedIn)?.drafts.map((d) => d.message)).toEqual(kept(typedIn)?.drafts.map((d) => d.message));
        for (const entry of [failedIn, typedIn]) {
          await arrive([PROPS], entry);
          expect(await values()).toEqual(ENQUIRY);
          await leave();
        }

        // A later visit sends a different enquiry, kept by its entry before it went; the unsent one is still the visitor's.
        await arrive([PROPS]);
        await field('Name').fill('Grace');
        await field('Email').fill('grace@example.com');
        await field('Message').fill('Something else');
        const laterVisit = await capture();
        await button.click();
        await (await nextPost()).respond(200);
        await expect.poll(status).toBe(SENT);
        await leave();
        await arrive([PROPS], laterVisit);
        expect(await values()).toEqual(EMPTY);
        await leave();
        await arrive([PROPS], typedIn);
        expect(await values()).toEqual(ENQUIRY);
      });
    }, 20_000);

    it('keeps and retires the drafts of a form whose answers are named like the form’s own methods', async () => {
      // Each named control shadows the form's property of that name (form.matches is the "matches" answer).
      const SHADOWING = {
        ...PROPS,
        fields: [
          { id: 'm1', label: 'Matches', name: 'matches', type: 'text', required: true, placeholder: '' },
          { id: 'm2', label: 'Closest', name: 'closest', type: 'text', required: true, placeholder: '' },
          { id: 'm3', label: 'Query', name: 'querySelectorAll', type: 'textarea', required: true, placeholder: '' }
        ]
      };
      await withForm(SHADOWING, async ({ field, button, status, leave, arrive, nextPost }) => {
        const answers = () => Promise.all(['Matches', 'Closest', 'Query'].map((l) => field(l).inputValue()));
        await field('Matches').fill('a');
        await field('Closest').fill('b');
        await field('Query').fill('c');
        const typedIn = await leave();
        await arrive([SHADOWING], typedIn);
        expect(await answers()).toEqual(['a', 'b', 'c']);
        await button.click();
        await (await nextPost()).respond(200);
        await expect.poll(status).toBe(SENT);
        await leave();
        await arrive([SHADOWING], typedIn);
        expect(await answers()).toEqual(['', '', '']);
      });
    }, 20_000);

    it('keeps each copy of one form apart, and a form in the header or footer apart from the page’s', async () => {
      const OTHER = { ...PROPS, fields: FIELDS.map((f) => ({ ...f, id: `other-${f.id}` })) };
      await withForm(PROPS, async ({ page, leave, arrive, inShell }) => {
        // Two copies with the same fields, as a project component that wraps the form and is placed twice renders,
        // with a different form between them. Only the second copy is filled in.
        await arrive([OTHER, PROPS]);
        const input = (n: number, name: string) => page.locator('main .so-form__form').nth(n).locator(`[name="${name}"]`);
        await input(2, 'name').fill('Grace');
        const twoCopies = await leave();
        // Back to the page with the other form not shown this time: each copy is still known by its own place.
        await arrive([PROPS, PROPS], twoCopies);
        expect([await input(0, 'name').inputValue(), await input(1, 'name').inputValue()]).toEqual(['', 'Grace']);
        await leave();

        // The same form in the footer and on the page: the page's draft never moves into the footer when the page's
        // form is not there to take it.
        await inShell(PROPS);
        await arrive([PROPS]);
        await input(0, 'name').fill('Ada');
        const withPageForm = await leave();
        await arrive([], withPageForm);
        expect(await page.locator('#shell [name="name"]').inputValue()).toBe('');
      });
    }, 20_000);

    it('never puts an older draft over what the visitor has since typed, emptied or been given back, and fills only empty answers', async () => {
      await withForm(PROPS, async ({ page, field, button, status, values, leave, arrive, restore, nextPost }) => {
        await fillEnquiry(field);
        const older = await leave();
        await arrive([PROPS]);
        await field('Name').fill('Newer');
        const newer = await leave();

        // Back between two entries of one page leaves the form on screen and hands back the older entry's draft.
        await arrive([PROPS], newer);
        // Emptied without an input event, which typing would fire: being given a draft back already settles it.
        await page.evaluate(`document.querySelector('main [name="message"]').value = ''`);
        await restore(older);
        expect(await values()).toEqual(['Newer', '', '']);
        await leave();

        // Typed in, then emptied: the visitor's emptiness stands.
        await arrive([PROPS]);
        await field('Name').fill('Briefly');
        await field('Name').fill('');
        await restore(older);
        expect(await values()).toEqual(EMPTY);
        await leave();

        // Filled in before the page was ready (no input event reached the keeper): that answer stays, the rest return.
        await arrive([PROPS]);
        await page.evaluate(`document.querySelector('main [name="email"]').value = 'early@example.com'`);
        await restore(older);
        expect(await values()).toEqual(['Ada', 'early@example.com', 'A question about materials']);
        // That form now holds the older message, so sending it retires every copy of it.
        await button.click();
        await (await nextPost()).respond(200);
        await expect.poll(status).toBe(SENT);
        await leave();
        await arrive([PROPS], older);
        expect(await values()).toEqual(EMPTY);
      });
    }, 20_000);

    it('brings back a ticked choice and checkbox, never takes untouched ones for a draft, and keeps one ticked since (issue #238)', async () => {
      const CHOICES = {
        provider: 'endpoint',
        endpoint: `${ORIGIN}/f/abc`,
        fields: [
          { id: 'f1', label: 'Name', name: 'name', type: 'text', required: false, placeholder: '' },
          {
            id: 'f4',
            label: 'Service',
            name: 'service',
            type: 'choice',
            required: true,
            placeholder: '',
            options: [
              { id: 'c1', label: 'Kitchen', value: 'Kitchen' },
              { id: 'c2', label: 'Éclairage', value: 'Lighting' }
            ]
          },
          { id: 'f5', label: 'Send me a copy', name: 'copy', type: 'checkbox', required: false, placeholder: '' }
        ]
      };
      await withForm(CHOICES, async ({ page, leave, arrive, restore }) => {
        const ticked = () => page.evaluate<string[]>(`[...document.querySelectorAll('main input:checked')].map((i) => i.value)`);
        // Radio buttons and a checkbox nobody touched hold no draft, whatever their values are.
        expect(kept(await leave())).toBeNull();
        await arrive([CHOICES]);
        await page.getByLabel('Éclairage').check();
        await page.getByLabel('Send me a copy').check();
        const answered = await leave();
        // Each answer once, by field id: the id of the ticked choice, and the checkbox's value.
        expect(kept(answered)).toEqual({
          path: '/contact',
          drafts: [{ key: 'page f1 f4:radio f5:checkbox', n: 0, message: expect.any(String), values: [['f1', ''], ['f4', 'c2'], ['f5', 'yes']] }]
        });
        await arrive([CHOICES]);
        expect(await ticked()).toEqual([]);
        await leave();
        await arrive([CHOICES], answered);
        expect(await ticked()).toEqual(['Lighting', 'yes']);
        await leave();
        // A choice made before the draft came back (no input event reached the keeper) stays; the checkbox returns.
        await arrive([CHOICES]);
        await page.evaluate(`document.querySelector('main input[value="Kitchen"]').checked = true`);
        await restore(answered);
        expect(await ticked()).toEqual(['Kitchen', 'yes']);
        await leave();
        // The choice was removed and another made with its value: the visitor never picked that one.
        const REPLACED = { ...CHOICES, fields: CHOICES.fields.map((f) => (f.id === 'f4' ? { ...f, options: [f.options![0], { id: 'c3', label: 'Call me', value: 'Lighting' }] } : f)) };
        await arrive([REPLACED], answered);
        expect(await ticked()).toEqual(['yes']);
      });
    }, 20_000);
  });
});
