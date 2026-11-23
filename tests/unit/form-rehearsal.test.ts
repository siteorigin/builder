/**
 * Contact forms in the editor's preview (issue #193): the real preview bridge, the submission hold the instrumented
 * layout installs, and the contact form exactly as an export ships it, in a frame of a real headless browser, driven
 * the way the editor drives them. Every request the frame makes to the form service, and every POST to the site
 * itself, is captured and counted here, so nothing ever reaches a real service.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright';
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
const SENDING = 'Sending your message…';

/** A site with a contact form on its home page: its clean export and its instrumented preview. */
function site() {
  const s = createStarterState('business', 'Test Studio', false);
  const def = s.components[installComponent(s, 'contact.form')];
  const home = s.pages[s.site.homePageId];
  const node = makeInstance(def, { provider: 'endpoint', endpoint: ENDPOINT });
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  return { files: generateProject(s), dev: generateProject(s, { instrument: true }), formFile: defFile(def) };
}

/** The exported contact form, compiled for the browser with Svelte's runtime; `window.mountForm(props)` places one. */
async function bundleForm(source: string): Promise<string> {
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

/** The submission hold exactly as the instrumented layout installs it, before the page's own code runs. */
function holdFrom(layout: string): string {
  const hold = /\tif \(typeof window !== 'undefined' && !window\.__siteoriginBridge[\s\S]*?\n\t\}/.exec(layout)?.[0];
  if (!hold) throw new Error('The instrumented layout holds no submissions');
  return hold;
}

/**
 * The site's page in the editor's frame: the layout's hold, the form, then the bridge, in the order the preview
 * loads them (the bridge is imported once the page has mounted). `/held/` is the same page before its bridge loads.
 */
const framePage = (hold: string, withBridge: boolean) => `<!doctype html><html><head><meta charset="utf-8"><script>${hold}</script></head><body><main id="app"></main>
<script src="/form.js"></script>${withBridge ? '<script type="module" src="/bridge.js"></script>' : ''}</body></html>`;

/** The editor: it frames the page under the session's name and keeps every bridge message it receives. */
const hostPage = (path: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe name="${SESSION}" src="${path}" style="width:900px;height:900px;border:0"></iframe>
<script>
	window.received = [];
	window.addEventListener('message', (e) => window.received.push(e.data));
	window.toFrame = (type, payload) => document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: '${SESSION}', type, payload }, '*');
</script></body></html>`;

interface PreviewForm {
  id: string;
  label: string;
  place: string;
  service: string;
  destination: string;
  live: boolean;
}

describe('the instrumented layout', () => {
  it('holds submissions until the bridge runs, and only in the preview', () => {
    const { files, dev } = site();
    expect(holdFrom(dev.get('src/routes/+layout.svelte')!)).toContain("document.addEventListener('submit', window.__siteoriginHold, true)");
    for (const [path, content] of files) expect(content.includes('__siteorigin'), path).toBe(false);
  });
});

describe.skipIf(!browserInstalled)('contact forms in the preview (issue #193)', () => {
  let browser: Browser;
  let script: string;
  let hold: string;

  beforeAll(async () => {
    const { files, dev, formFile } = site();
    hold = holdFrom(dev.get('src/routes/+layout.svelte')!);
    const [bundled, launched] = await Promise.allSettled([bundleForm(files.get(formFile)!), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh editor with a contact form placed. The service answers every request it gets with `service.status`. */
  async function withPreview(body: (t: Awaited<ReturnType<typeof open>>) => Promise<void>, props: Record<string, unknown> = {}, path = '/contact/') {
    const context = await browser.newContext();
    try {
      await body(await open(await context.newPage(), props, path));
    } finally {
      await context.close();
    }
  }

  async function open(page: Page, props: Record<string, unknown>, path: string) {
    /** Every request that reached the service. */
    const service = { requests: [] as Array<{ method: string; url: string; body: string }>, status: 200 };
    const capture = (r: Request) => service.requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' });
    await page.route(`${SERVICE}/**`, async (route) => {
      capture(route.request());
      await route.fulfill({ status: service.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: service.status < 400 }) });
    });
    await page.route(`${SITE}/**`, (route) => {
      const request = route.request();
      // A POST to the site itself (Netlify Forms post to their own page) is a send too.
      if (request.method() !== 'GET') {
        capture(request);
        return route.fulfill({ status: 404, body: '' });
      }
      const at = new URL(request.url()).pathname;
      if (at === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (at === '/form.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (at === '/contact/' || at === '/held/') return route.fulfill({ contentType: 'text/html', body: framePage(hold, at === '/contact/') });
      return route.fulfill({ contentType: 'text/html', body: hostPage(path) });
    });
    // The host's load waits for its frame's.
    await page.goto(`${SITE}/`);
    const frame = page.frame({ name: SESSION });
    if (!frame) throw new Error('The editor has no preview frame');
    const mount = (p: Record<string, unknown>) => frame.evaluate(`window.mountForm(${JSON.stringify({ heading: 'Send us a message', provider: 'endpoint', endpoint: ENDPOINT, fields: FIELDS, ...p })})`);
    await mount(props);
    const received = () => page.evaluate<Array<{ type: string; payload: Record<string, unknown> }>>('window.received');
    /** Payloads of one type the bridge has sent the editor, in order. */
    const sent = async (type: string) => (await received()).filter((m) => m.type === type).map((m) => m.payload);
    if (path === '/contact/') await expect.poll(async () => (await sent('ready')).length).toBe(1);
    const contact = frame.locator('form.so-form__form').first();
    const field = (label: string) => contact.getByLabel(label);
    const form = {
      page,
      frame,
      service,
      field,
      sent,
      mount,
      toFrame: (type: string, payload: Record<string, unknown> = {}) => page.evaluate(`window.toFrame(${JSON.stringify(type)}, ${JSON.stringify(payload)})`),
      button: contact.locator('.so-form__actions button'),
      status: () => frame.locator('.so-form__status[role="status"]').first().innerText(),
      alert: () => frame.locator('.so-form__status[role="alert"]').first().innerText(),
      values: () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).inputValue())),
      fill: async (email = 'ada@example.com') => {
        await field('Name').fill('Ada');
        await field('Email').fill(email);
        await field('Message').fill('A rehearsal enquiry');
      },
      /** Whether the browser's own checks would let the form be submitted. */
      valid: () => frame.evaluate<boolean>(`document.querySelector('form.so-form__form').checkValidity()`),
      /** The forms the bridge last listed for the editor. */
      forms: async () => ((await sent('forms')).at(-1)?.forms ?? []) as PreviewForm[],
      /** The id of the nth listed form, once the bridge has listed `count` of them. */
      formId: async (n = 0, count = 1) => {
        await expect.poll(async () => (await form.forms()).length).toBe(count);
        return (await form.forms())[n].id;
      },
      /** What the bridge has told the editor about sends, without form ids. */
      results: async () => (await sent('formResult')).map(({ id: _id, ...rest }) => rest),
      /** Which listed form each report was about. */
      resultIds: async () => (await sent('formResult')).map((r) => r.id),
      setMode: async (mode: 'edit' | 'preview') => {
        await form.toFrame('mode', { mode });
        // Commands arrive in order: once this one is answered, the mode has changed.
        const before = (await sent('measured')).length;
        await form.toFrame('measure', { requestId: 'mode', descs: [] });
        await expect.poll(async () => (await sent('measured')).length).toBeGreaterThan(before);
      },
      preview: () => form.setMode('preview'),
      /** Adds a form of the page's own code that posts with `send` (JavaScript run in the page, given the form as `form`). */
      addCustomForm: (id: string, action: string, send: string) =>
        frame.evaluate(`(() => {
          document.getElementById('app').insertAdjacentHTML('beforeend', '<form id="${id}" method="post" action="${action}"><input name="q" value="Hello"></form>');
          const form = document.getElementById('${id}');
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            window.customResults ??= {};
            try {
              window.customResults['${id}'] = await (async () => { ${send} })();
            } catch (error) {
              window.customResults['${id}'] = String(error.name);
            }
          });
        })()`),
      submitCustom: (id: string) => frame.evaluate(`document.getElementById('${id}').requestSubmit()`),
      customResult: (id: string) => frame.evaluate(`window.customResults?.['${id}']`)
    };
    return form;
  }

  it('sends nothing in Edit, however the form is submitted', async () => {
    await withPreview(async ({ frame, fill, field, service, status, values, results, valid, addCustomForm, submitCustom, customResult }) => {
      await fill();
      // The answers would pass the browser's checks: only Edit stops them.
      expect(await valid()).toBe(true);
      await field('Email').press('Enter');
      await frame.evaluate(`document.querySelector('form').requestSubmit()`);
      // A form of the page's own code too.
      await addCustomForm('own', `${SERVICE}/f/own`, `return (await fetch('${SERVICE}/f/own', { method: 'POST', body: new FormData(form) })).status;`);
      await submitCustom('own');
      await frame.waitForTimeout(400);
      expect(await customResult('own')).toBeUndefined();
      expect(service.requests).toHaveLength(0);
      expect(await status()).toBe('');
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'A rehearsal enquiry']);
      expect(await results()).toEqual([]);
    });
  }, 30_000);

  it('lists each form with where it sends when published, and where it is', async () => {
    await withPreview(async ({ frame, forms }) => {
      await frame.evaluate(`document.body.insertAdjacentHTML('beforeend', '<footer data-so-ctx="shell:footer"><form method="post" action="${SERVICE}/f/news?list=monthly#top" aria-label="Newsletter"></form></footer>')`);
      await expect.poll(forms).toEqual([
        { id: expect.any(String), label: 'Send us a message', place: 'page', service: 'endpoint', destination: ENDPOINT, live: true },
        { id: expect.any(String), label: 'Newsletter', place: 'footer', service: 'endpoint', destination: `${SERVICE}/f/news?list=monthly`, live: true }
      ]);
    });
  }, 30_000);

  it('still lists a form one of whose fields is named like a form method', async () => {
    await withPreview(
      async ({ forms }) => {
        await expect.poll(async () => (await forms()).map((f) => f.label)).toEqual(['Send us a message']);
      },
      { fields: [...FIELDS, { id: 'f4', label: 'Closest branch', name: 'closest', type: 'text', required: false, placeholder: '' }] }
    );
  }, 30_000);

  it('practises a send in Preview: the form shows sending, then its sent message, and nothing is sent', async () => {
    await withPreview(async ({ fill, field, service, status, values, button, results, preview }) => {
      await preview();
      // The browser's own checks still run: a form with a required answer missing, or not valid, is never submitted.
      await field('Name').fill('Ada');
      await field('Email').press('Enter');
      await field('Email').fill('not an email');
      await field('Email').press('Enter');
      await field('Email').fill('ada@example.com');
      await field('Email').press('Enter');
      expect(await status()).toBe('');
      expect(await results()).toEqual([]);

      await fill();
      await field('Email').press('Enter');
      await expect.poll(status).toBe(SENDING);
      expect(await button.innerText()).toBe('Sending…');
      await expect.poll(results).toEqual([{ kind: 'practice', result: 'sending' }]);
      await expect.poll(status, { timeout: 5000 }).toBe(SENT);
      expect(await values()).toEqual(['', '', '']);
      await expect.poll(results).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'success' }
      ]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a failed send when the author asks for one, keeping the answers', async () => {
    await withPreview(async ({ fill, field, service, status, alert, values, results, toFrame, preview }) => {
      await preview();
      await toFrame('formPractice', { result: 'error' });
      await fill();
      await field('Email').press('Enter');
      await expect.poll(status).toBe(SENDING);
      await expect.poll(alert, { timeout: 5000 }).toBe(FAILED);
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'A rehearsal enquiry']);
      await expect.poll(results).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'error' }
      ]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('sends exactly one real message for a confirmed live test, and practises again after it', async () => {
    await withPreview(async ({ fill, field, service, status, values, results, toFrame, formId, preview }) => {
      await preview();
      await fill();
      service.status = 202;
      await toFrame('formLiveTest', { id: await formId(), target: ENDPOINT, requestId: 'live-1' });
      await expect.poll(() => service.requests.length).toBe(1);
      expect(service.requests[0]).toMatchObject({ method: 'POST', url: ENDPOINT });
      expect(service.requests[0].body).toContain('A rehearsal enquiry');
      await expect.poll(status).toBe(SENT);
      await expect.poll(results).toEqual([
        { requestId: 'live-1', kind: 'live', result: 'sending', destination: ENDPOINT },
        { requestId: 'live-1', kind: 'live', result: 'sent', status: 202, destination: ENDPOINT }
      ]);
      expect(await field('Name').inputValue()).toBe('');

      // The next ordinary send is a practice again.
      await fill();
      await field('Email').press('Enter');
      await expect.poll(results, { timeout: 5000 }).toHaveLength(4);
      expect((await results()).slice(2)).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'success' }
      ]);
      expect(await values()).toEqual(['', '', '']);
      expect(service.requests).toHaveLength(1);
    });
  }, 30_000);

  it('reports what a live test got back when the service refuses it', async () => {
    await withPreview(async ({ fill, service, alert, results, toFrame, formId, preview }) => {
      await preview();
      await fill();
      service.status = 422;
      await toFrame('formLiveTest', { id: await formId(), target: ENDPOINT, requestId: 'live-1' });
      await expect.poll(alert).toBe(FAILED);
      await expect.poll(async () => (await results()).at(-1)).toEqual({ requestId: 'live-1', kind: 'live', result: 'refused', status: 422, destination: ENDPOINT });
      expect(service.requests).toHaveLength(1);
    });
  }, 30_000);

  it('never lets a live test confirmed during a practice send deliver a later, ordinary send (review)', async () => {
    await withPreview(async ({ fill, field, service, status, alert, results, toFrame, formId, preview }) => {
      await preview();
      await toFrame('formPractice', { result: 'error' });
      await fill();
      await field('Email').press('Enter');
      await expect.poll(status).toBe(SENDING);
      // The form is still sending its practice, so it does not send for the live test.
      await toFrame('formLiveTest', { id: await formId(), target: ENDPOINT, requestId: 'live-1' });
      await expect.poll(alert, { timeout: 5000 }).toBe(FAILED);
      await field('Message').fill('A different enquiry');
      await field('Email').press('Enter');
      await expect.poll(async () => (await results()).filter((r) => r.kind === 'live')).toEqual([{ requestId: 'live-1', kind: 'live', result: 'not-sent' }]);
      await expect.poll(async () => (await results()).at(-1), { timeout: 5000 }).toEqual({ kind: 'practice', result: 'error' });
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('sends nothing for a live test the form cannot pass, or one confirmed for settings that have changed', async () => {
    await withPreview(async ({ frame, fill, field, service, results, toFrame, forms, formId, preview }) => {
      // Not in Preview.
      await fill();
      await toFrame('formLiveTest', { id: await formId(), target: ENDPOINT, requestId: 'edit' });
      await expect.poll(results).toEqual([{ requestId: 'edit', kind: 'live', result: 'unavailable' }]);

      await preview();
      await field('Email').fill('not an email');
      await toFrame('formLiveTest', { id: await formId(), target: ENDPOINT, requestId: 'invalid' });
      await expect.poll(results).toHaveLength(2);
      expect((await results())[1]).toEqual({ requestId: 'invalid', kind: 'live', result: 'invalid' });
      await field('Email').fill('ada@example.com');

      // The author was shown another address than the one the form sends to.
      await toFrame('formLiveTest', { id: await formId(), target: `${SERVICE}/f/other`, requestId: 'elsewhere' });
      await expect.poll(results).toHaveLength(3);
      expect((await results())[2]).toEqual({ requestId: 'elsewhere', kind: 'live', result: 'unavailable' });

      // The author confirmed the test for one destination; the form now sends somewhere else.
      const confirmed = await formId();
      await frame.evaluate(`document.querySelector('form').setAttribute('action', '${SERVICE}/f/other')`);
      await expect.poll(async () => (await forms())[0].id).not.toBe(confirmed);
      await toFrame('formLiveTest', { id: confirmed, target: ENDPOINT, requestId: 'stale' });
      await expect.poll(results).toHaveLength(4);
      expect((await results())[3]).toEqual({ requestId: 'stale', kind: 'live', result: 'unavailable' });

      // Or its service's key changed, where it posts staying the same.
      const keyed = (await forms())[0].id;
      await frame.evaluate(`document.querySelector('form').insertAdjacentHTML('afterbegin', '<input type="hidden" name="access_key" value="another-inbox">')`);
      await expect.poll(async () => (await forms())[0].id).not.toBe(keyed);
      await toFrame('formLiveTest', { id: keyed, target: `${SERVICE}/f/other`, requestId: 'rekeyed' });
      await expect.poll(results).toHaveLength(5);
      expect((await results())[4]).toEqual({ requestId: 'rekeyed', kind: 'live', result: 'unavailable' });
      await frame.waitForTimeout(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('tests the form the author confirmed when two forms send to the same service (review)', async () => {
    await withPreview(async ({ frame, service, results, resultIds, toFrame, formId, mount, preview }) => {
      await mount({ heading: 'Book a visit' });
      const second = frame.locator('form.so-form__form').nth(1);
      await preview();
      await second.getByLabel('Name').fill('Grace');
      await second.getByLabel('Email').fill('grace@example.com');
      await second.getByLabel('Message').fill('A visit next week');
      const id = await formId(1, 2);
      await toFrame('formLiveTest', { id, target: ENDPOINT, requestId: 'live-1' });
      await expect.poll(() => service.requests.length).toBe(1);
      expect(service.requests[0].body).toContain('A visit next week');
      await expect.poll(async () => (await results()).at(-1)).toMatchObject({ kind: 'live', result: 'sent' });
      expect(new Set(await resultIds())).toEqual(new Set([id]));
    });
  }, 30_000);

  it('practises a Netlify form, which posts to its own page, and offers no live test', async () => {
    await withPreview(
      async ({ fill, field, service, status, forms, preview }) => {
        await expect.poll(forms).toEqual([{ id: expect.any(String), label: 'Send us a message', place: 'page', service: 'netlify', destination: '', live: false }]);
        await preview();
        await fill();
        await field('Email').press('Enter');
        await expect.poll(status, { timeout: 5000 }).toBe(SENT);
        expect(service.requests).toHaveLength(0);
      },
      { provider: 'netlify', formName: 'contact' }
    );
  }, 30_000);

  it('practises a form whose own code waits, then sends somewhere other than its action', async () => {
    await withPreview(async ({ service, preview, addCustomForm, submitCustom, customResult }) => {
      await preview();
      await addCustomForm('custom', `${SERVICE}/f/custom`, `await new Promise((r) => setTimeout(r, 300)); return (await fetch('${SERVICE}/relay', { method: 'POST', body: new FormData(form) })).status;`);
      await submitCustom('custom');
      await expect.poll(() => customResult('custom'), { timeout: 5000 }).toBe(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a form that sends with XMLHttpRequest, and lets a confirmed live test of it through', async () => {
    const xhr = (result: string) =>
      `return await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('POST', '${SERVICE}/f/xhr'); x.onload = () => resolve('${result}:' + x.status); x.onerror = () => resolve('${result}:error'); x.send(new FormData(form)); });`;
    await withPreview(async ({ service, results, preview, toFrame, addCustomForm, submitCustom, customResult, forms }) => {
      await preview();
      await addCustomForm('ok', `${SERVICE}/f/xhr`, xhr('ok'));
      await submitCustom('ok');
      await expect.poll(() => customResult('ok'), { timeout: 5000 }).toBe('ok:200');
      await toFrame('formPractice', { result: 'error' });
      await submitCustom('ok');
      await expect.poll(() => customResult('ok'), { timeout: 5000 }).toBe('ok:error');
      expect(service.requests).toHaveLength(0);
      await expect.poll(async () => (await results()).map((r) => r.result)).toEqual(['sending', 'success', 'sending', 'error']);

      await expect.poll(async () => (await forms()).length).toBe(2);
      const id = (await forms()).find((f) => f.destination === `${SERVICE}/f/xhr`)!.id;
      await toFrame('formLiveTest', { id, target: `${SERVICE}/f/xhr`, requestId: 'live-xhr' });
      await expect.poll(() => customResult('ok'), { timeout: 5000 }).toBe('ok:200');
      expect(service.requests).toMatchObject([{ method: 'POST', url: `${SERVICE}/f/xhr` }]);
      await expect.poll(async () => (await results()).at(-1)).toMatchObject({ kind: 'live', result: 'sent', status: 200 });
    });
  }, 30_000);

  it('lets only a send made within the confirmed submission be live: a form that waits first practises', async () => {
    await withPreview(async ({ service, results, preview, toFrame, addCustomForm, customResult, forms }) => {
      await preview();
      await addCustomForm('slow', `${SERVICE}/f/slow`, `await new Promise((r) => setTimeout(r, 300)); return (await fetch('${SERVICE}/f/slow', { method: 'POST', body: new FormData(form) })).status;`);
      await expect.poll(async () => (await forms()).length).toBe(2);
      const id = (await forms()).find((f) => f.destination === `${SERVICE}/f/slow`)!.id;
      await toFrame('formLiveTest', { id, target: `${SERVICE}/f/slow`, requestId: 'live-1' });
      await expect.poll(results).toEqual([{ requestId: 'live-1', kind: 'live', result: 'not-sent' }]);
      await expect.poll(() => customResult('slow'), { timeout: 5000 }).toBe(200);
      await expect.poll(async () => (await results()).slice(1)).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'success' }
      ]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a send that comes after the visitor has moved to another page, and says nothing of one left behind', async () => {
    await withPreview(async ({ frame, fill, field, service, results, preview, setMode, addCustomForm, submitCustom, customResult }) => {
      await preview();
      // A form that waits, then sends to an address of its own; the visitor moves on, and the form leaves the page.
      await addCustomForm('relay', `${SERVICE}/f/relay`, `await new Promise((r) => setTimeout(r, 400)); return (await fetch('${SERVICE}/relay', { method: 'POST', body: new FormData(form) })).status;`);
      await submitCustom('relay');
      await frame.evaluate(`(() => { window.dispatchEvent(new Event('siteorigin:navigated')); document.getElementById('relay').remove(); })()`);
      await expect.poll(() => customResult('relay'), { timeout: 5000 }).toBe(200);
      expect(service.requests).toHaveLength(0);
      const before = (await results()).length;

      // A practice send still waiting when the author leaves Preview tells the editor nothing more.
      await fill();
      await field('Email').press('Enter');
      await expect.poll(async () => (await results()).length).toBe(before + 1);
      await setMode('edit');
      await frame.waitForTimeout(1200);
      expect((await results()).slice(before)).toEqual([{ kind: 'practice', result: 'sending' }]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a form without method="post" whose own code posts', async () => {
    await withPreview(async ({ frame, service, preview, customResult }) => {
      await preview();
      await frame.evaluate(`(() => {
        document.getElementById('app').insertAdjacentHTML('beforeend', '<form id="plain"><input name="q" value="Hello"></form>');
        const form = document.getElementById('plain');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          window.customResults = { plain: (await fetch('${SERVICE}/subscribe', { method: 'POST', body: new FormData(form) })).status };
        });
        form.requestSubmit();
      })()`);
      await expect.poll(() => customResult('plain'), { timeout: 5000 }).toBe(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('never answers a practice XMLHttpRequest the page gave up', async () => {
    await withPreview(async ({ frame, service, preview, addCustomForm, submitCustom }) => {
      await preview();
      await addCustomForm('gaveup', `${SERVICE}/f/xhr`, `return await new Promise((resolve) => { const x = new XMLHttpRequest(); window.xhrLoads = 0; x.open('POST', '${SERVICE}/f/xhr'); x.onload = () => window.xhrLoads++; x.onabort = () => resolve('aborted'); x.send(new FormData(form)); setTimeout(() => x.abort(), 100); });`);
      await submitCustom('gaveup');
      await frame.waitForTimeout(1300);
      expect(await frame.evaluate('window.xhrLoads')).toBe(0);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('gives up a practice send its page cancels', async () => {
    await withPreview(async ({ service, results, preview, addCustomForm, submitCustom, customResult }) => {
      await preview();
      await addCustomForm('cancel', `${SERVICE}/f/cancel`, `const c = new AbortController(); setTimeout(() => c.abort(), 100); return (await fetch('${SERVICE}/f/cancel', { method: 'POST', body: new FormData(form), signal: c.signal })).status;`);
      await submitCustom('cancel');
      await expect.poll(() => customResult('cancel'), { timeout: 5000 }).toBe('AbortError');
      await new Promise((r) => setTimeout(r, 1000));
      expect(await results()).toEqual([{ kind: 'practice', result: 'sending' }]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('leaves a request no form made alone', async () => {
    await withPreview(async ({ frame, service, results, preview }) => {
      await preview();
      expect(await frame.evaluate(`fetch('${SERVICE}/api/search', { method: 'POST', body: 'q=rooms' }).then((r) => r.status)`)).toBe(200);
      expect(service.requests).toMatchObject([{ method: 'POST', url: `${SERVICE}/api/search` }]);
      expect(await results()).toEqual([]);
    });
  }, 30_000);

  it('holds every submission while the page is loading, before the bridge runs', async () => {
    await withPreview(
      async ({ frame, fill, field, service, status, addCustomForm, submitCustom, customResult }) => {
        await fill();
        await field('Email').press('Enter');
        await frame.evaluate(`document.querySelector('form').requestSubmit()`);
        // A form of the page's own code is held too.
        await addCustomForm('own', `${SERVICE}/f/own`, `return (await fetch('${SERVICE}/f/own', { method: 'POST', body: new FormData(form) })).status;`);
        await submitCustom('own');
        await frame.waitForTimeout(600);
        expect(await status()).toBe('');
        expect(await customResult('own')).toBeUndefined();
        expect(service.requests).toHaveLength(0);
      },
      {},
      '/held/'
    );
  }, 30_000);
});
