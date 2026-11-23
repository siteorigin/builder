/**
 * The contact form as a visitor uses it, in a real headless browser: the generated component is compiled for
 * the client, bundled with Svelte's browser runtime and mounted on a stand-in page, beside the draft keeper the
 * generated layout runs. Its POSTs are intercepted and held, so each reply can be delayed, failed or let through.
 * No real enquiry is ever sent.
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
window.snapshotIds = () => [...registrations].map((r) => r.id);
window.captureSnapshots = () => Object.fromEntries([...registrations].map((r) => [r.id, JSON.stringify(r.capture() ?? null)]));
window.restoreSnapshots = (values) => {
	for (const r of registrations) if (values && Object.hasOwn(values, r.id)) r.restore(JSON.parse(values[r.id]));
};`;

/**
 * The component, the exported draft keeper and Svelte's browser runtime as one script. It mounts a stand-in for
 * the root layout, which runs the keeper for as long as the page is open, and defines `window.mountForm(props)`,
 * which adds a form to the page, and `window.unmountForms()`, which takes every form off it as leaving it does.
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
window.mountForm = (props) => {
	const target = document.getElementById('app').appendChild(document.createElement('div'));
	forms.push(mount(Form, { target, props }));
	flushSync();
};
window.unmountForms = () => {
	for (const form of forms.splice(0)) unmount(form);
	document.getElementById('app').replaceChildren();
};`,
    '\0form': compiled(files.get(formFile)!, 'ContactForm.svelte'),
    '\0layout': compiled(`<script>\n\timport { keepDrafts } from '\\0drafts';\n\tkeepDrafts();\n</script>\n`, 'Layout.svelte'),
    '\0drafts': files.get(`${RUNTIME_DIR}/drafts.js`)!,
    '$app/navigation': NAVIGATION_STUB
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
      /** Restores a kept snapshot into the forms still mounted, as a Back between two entries of one page does. */
      restore: (kept: Record<string, string>) => page.evaluate(`window.restoreSnapshots(${JSON.stringify(kept)})`),
      snapshotIds: () => page.evaluate<string[]>('window.snapshotIds()')
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

  it('refuses to send two answers under one key, and says why (issue #198)', async () => {
    // The stock form with "EMAIL" typed into Phone's field name, as in the issue.
    const fields = [
      { id: 'item-1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
      { id: 'item-2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
      { id: 'item-3', label: 'Phone', name: 'EMAIL', type: 'tel', required: false, placeholder: '' },
      { id: 'item-4', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
    ];
    await withForm({ provider: 'netlify', formName: 'contact', fields }, async ({ page, field, button, status, posts, fetches }) => {
      // Any POST, a native one included, is counted the moment it starts.
      let sends = 0;
      page.on('request', (r) => void (r.method() === 'POST' && sends++));
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

  describe('in the tab history (issue #274)', () => {
    const PROPS = { provider: 'endpoint', endpoint: `${ORIGIN}/f/abc`, fields: FIELDS };
    const ENQUIRY = ['Ada', 'ada@example.com', 'A question about materials'];
    const EMPTY = ['', '', ''];
    /** What the layout's registration kept for an entry: one draft per form that had one. */
    const drafts = (kept: Record<string, string>) => JSON.parse(kept['siteorigin-drafts'] ?? 'null') as Array<{ key: string; n: number; message: string; values: string[][] }> | null;
    /** Everything the page keeps in storage, as text, to search for answers. */
    const stored = (page: Page) => page.evaluate<string>('JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } })');

    it('brings an unsent enquiry back on Back to its entry, not to a new visit, and sends nothing', async () => {
      await withForm(PROPS, async ({ page, field, values, leave, arrive, fetches, posts, snapshotIds }) => {
        // One registration for the whole site, held by the layout, whatever the forms on the page.
        expect(await snapshotIds()).toEqual(['siteorigin-drafts']);
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('A question about materials');
        const typedIn = await leave();
        // The answers by field id, never the provider's hidden fields or the spam trap.
        expect(drafts(typedIn)?.map((d) => d.values)).toEqual([[['f1', 'Ada'], ['f2', 'ada@example.com'], ['f3', 'A question about materials']]]);
        // Following a link back to the page is a new visit, which starts empty.
        await arrive([PROPS]);
        expect(await values()).toEqual(EMPTY);
        const newVisit = await leave();
        expect(drafts(newVisit)).toBeNull();
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

    it('never brings a sent message back, from its own entry, an older one, or after a reload', async () => {
      await withForm(PROPS, async ({ page, field, button, status, values, capture, leave, arrive, nextPost }) => {
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('A question about materials');
        // An in-page link moves to a new entry with the form still on screen; the entry left keeps the draft.
        const beforeSending = await capture();
        expect(drafts(beforeSending)).toHaveLength(1);
        await button.click();
        const post = await nextPost();
        // A message on its way is no longer a draft, whatever the reply.
        expect(drafts(await capture())).toBeNull();
        await post.respond(200);
        await expect.poll(status).toBe(SENT);

        const sentIn = await leave();
        await arrive([PROPS], sentIn);
        expect(await values()).toEqual(EMPTY);
        await leave();
        await arrive([PROPS], beforeSending);
        expect(await values()).toEqual(EMPTY);
        await page.reload();
        await arrive([PROPS], beforeSending);
        expect(await values()).toEqual(EMPTY);
        // The tab remembers only an opaque id for the sent message.
        expect(await stored(page)).not.toMatch(/Ada|example\.com|materials/);
      });
    }, 20_000);

    it('does not bring back a message the visitor left while it was sending, once it has been sent', async () => {
      await withForm(PROPS, async ({ field, button, values, capture, leave, arrive, nextPost }) => {
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('A question about materials');
        const beforeSending = await capture();
        await button.click();
        const post = await nextPost();
        const leftWhileSending = await leave();
        expect(drafts(leftWhileSending)).toBeNull();
        await post.respond(200);
        await arrive([PROPS], leftWhileSending);
        expect(await values()).toEqual(EMPTY);
        await leave();
        await arrive([PROPS], beforeSending);
        expect(await values()).toEqual(EMPTY);
      });
    }, 20_000);

    it('keeps the draft of a send that failed, and an unsent draft from another visit after a send', async () => {
      await withForm(PROPS, async ({ page, field, button, status, alert, values, leave, arrive, nextPost }) => {
        await field('Name').fill('Ada');
        await field('Email').fill('ada@example.com');
        await field('Message').fill('A question about materials');
        await button.click();
        await (await nextPost()).respond(500);
        await expect.poll(alert).toBe(FAILED);
        const failedIn = await leave();
        await arrive([PROPS], failedIn);
        expect(await values()).toEqual(ENQUIRY);

        // A later visit sends a different enquiry; the one left unsent in the earlier entry is still the visitor's.
        await leave();
        await arrive([PROPS]);
        await field('Name').fill('Grace');
        await field('Email').fill('grace@example.com');
        await field('Message').fill('Something else');
        await button.click();
        await (await nextPost()).respond(200);
        await expect.poll(status).toBe(SENT);
        await leave();
        await arrive([PROPS], failedIn);
        expect(await values()).toEqual(ENQUIRY);
        expect(page.url()).toBe(`${ORIGIN}/contact/`);
      });
    }, 20_000);

    it('keeps each copy of one form apart, and never puts an older draft over what the visitor has since typed', async () => {
      await withForm(PROPS, async ({ page, leave, arrive, restore }) => {
        // Two copies with the same fields, as a project component that wraps the form and is placed twice renders.
        await arrive([PROPS]);
        const input = (n: number, name: string) => page.locator('.so-form__form').nth(n).locator(`[name="${name}"]`);
        await input(0, 'name').fill('Ada');
        await input(1, 'name').fill('Grace');
        const kept = await leave();
        expect(drafts(kept)?.map((d) => [d.key, d.n])).toEqual([['f1 f2 f3', 0], ['f1 f2 f3', 1]]);
        await arrive([PROPS, PROPS], kept);
        expect([await input(0, 'name').inputValue(), await input(1, 'name').inputValue()]).toEqual(['Ada', 'Grace']);

        // Back between two entries of this page leaves the forms on screen and hands back the older entry's drafts.
        const older = { 'siteorigin-drafts': kept['siteorigin-drafts'].replace(/Ada|Grace/g, 'Older') };
        await input(0, 'message').fill('Typed since');
        await restore(older);
        // Neither the copy typed in since nor the one already given its draft back takes the older one.
        expect([await input(0, 'name').inputValue(), await input(0, 'message').inputValue(), await input(1, 'name').inputValue()]).toEqual(['Ada', 'Typed since', 'Grace']);

        // On a new visit, a form the visitor typed in and then emptied stays empty, and one that holds answers the
        // keeper never saw typed (filled in before the page was ready) keeps them.
        await leave();
        await arrive([PROPS, PROPS]);
        await input(0, 'name').fill('Briefly');
        await input(0, 'name').fill('');
        await page.evaluate(`document.querySelectorAll('.so-form__form')[1].querySelector('[name="name"]').value = 'Early'`);
        await restore(older);
        expect([await input(0, 'name').inputValue(), await input(1, 'name').inputValue(), await input(1, 'message').inputValue()]).toEqual(['', 'Early', '']);
      });
    }, 20_000);
  });
});
