/**
 * A Foundation page printed as a handout, in real headless browsers. The generated layout and contact page (contact
 * details, FAQ, pricing and a contact form) are compiled for the client and mounted with the theme CSS exactly as an
 * exported site ships it. Chromium prints it to an A4 PDF, as its print dialog does, and the test reads the text on
 * each sheet. WebKit, which cannot print to PDF here, is checked under print media instead.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, InstanceNode, ListItem } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { pdfPages, pdfSheets, squash, type PdfSheet } from './pdf-text';

const ORIGIN = 'https://site.test';
const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));
const CAN_PRINT = ENGINES.some(([name]) => name === 'chromium');

const QUESTIONS = [
  ['How long does a typical project take?', 'Most design projects take six to ten weeks from the first meeting to final drawings. We agree a schedule with you at the start.'],
  ['Do you work outside the local area?', 'Yes. We regularly work across the region and can arrange remote consultations for early planning.'],
  // Several lines long, so a page break could fall inside it.
  [
    'How are your fees calculated?',
    'We quote a fixed fee for each stage once we understand the scope, so you always know the cost before work begins. Concept design, detailed design and tender drawings are priced separately, and you can stop after any stage. Site visits during construction are charged at an hourly rate that we confirm in writing before the first visit.'
  ],
  ['Can you recommend builders?', 'We work with a small group of trusted contractors and are happy to introduce them, or to work with your own builder.']
] as const;
const PLANS = [
  { name: 'Discovery visit', price: '$350', description: 'A focused session to explore ideas and priorities.', features: ['Two-hour site visit', 'Written summary', 'Budget guidance'], action: 'Book a session' },
  { name: 'Studio design', price: '$4,800', description: 'A complete design package ready for builders to quote.', features: ['Concept and detailed design', 'Materials and finishes', 'Drawings for tender', 'Three review meetings'], action: 'Start a project' },
  { name: 'Full service', price: '$9,500', description: 'Design plus coordination through to handover.', features: ['Everything in Design', 'Contractor coordination', 'Weekly site reports'], action: 'Talk to us' }
];
const FORM_HEADING = 'Send us a message';
const FIELDS = ['Your full name', 'Your email address', 'Best phone number', 'How can we help?'];
const SUBMIT = 'Send the enquiry';
const CONTACT_VALUES = ['hello@example.com', '+1 555 0134', '12 Harbour Lane, Millbrook', 'Monday to Friday, 9am – 5pm'];
const HEADER_ACTION = 'Book a site visit';
const COPYRIGHT = '© 2026 Test Studio. All rights reserved.';
const PLAIN_HEADING = 'Getting to the studio';
const PLAIN_TEXT = 'The studio is a short walk from Millbrook station, with parking on Harbour Lane.';
const PLAIN_MORE = 'Visitors are welcome by appointment on weekdays.';
/** Each section heading, with the first thing it introduces. */
const HEADINGS: Array<[string, string]> = [
  ['Frequently asked questions', QUESTIONS[0][0]],
  ['Clear packages, no surprises', PLANS[0].description],
  [FORM_HEADING, FIELDS[0]],
  [PLAIN_HEADING, PLAIN_TEXT]
];
/** The sections the page-break sweep moves a sheet boundary through, by their root element. */
const SECTIONS: Array<[string, string]> = [
  ['the FAQ', '.so-foundation-faq-list__root'],
  ['the pricing plans', '.so-foundation-pricing-plans__root'],
  ['the contact form', 'section.so-form'],
  ['a section of plain text', '.so-foundation-layout-section__root']
];

/**
 * The exported contact page: contact details and the FAQ from the starter, then pricing, a contact form, and a plain
 * section whose heading is not in a heading group.
 */
function exportedSite() {
  const s = createStarterState('business', 'Test Studio', false);
  const contact = s.pages[s.site.pageOrder[2]];
  if (contact.route !== '/contact/') throw new Error(`Expected the starter's contact page, got ${contact.route}`);
  const add = (componentId: string, props: Record<string, unknown>) => {
    const node: InstanceNode = makeInstance(s.components[installComponent(s, componentId)], props);
    contact.nodes[node.id] = node;
    contact.rootIds.push(node.id);
    return node;
  };
  const faq = contact.rootIds.map((id) => contact.nodes[id]).find((n): n is InstanceNode => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'faq.list');
  if (!faq) throw new Error("Expected the starter's contact page to hold an FAQ");
  faq.props.items = (faq.props.items as ListItem[]).map((item, i) => ({ ...item, question: QUESTIONS[i][0], answer: QUESTIONS[i][1] }));
  const pricing = add('pricing.plans', {});
  // Each plan's action goes somewhere, so it is shown (a button without a destination is left out).
  pricing.props.plans = (pricing.props.plans as ListItem[]).map((plan, i) => ({ ...plan, name: PLANS[i].name, price: PLANS[i].price, actionLink: { type: 'email', target: 'hello@example.com' } }));
  for (const [i, plan] of PLANS.entries()) {
    const stored = (pricing.props.plans as ListItem[])[i];
    if (stored.description !== plan.description || stored.actionLabel !== plan.action) throw new Error(`The default plan ${i + 1} has changed`);
  }
  add('contact.form', {
    provider: 'netlify',
    submitLabel: SUBMIT,
    fields: FIELDS.map((label, i) => ({ id: `f${i}`, label, name: '', type: i === 3 ? 'textarea' : 'text', required: i < 2, placeholder: '' }))
  });
  const plain = add('layout.section', {});
  const text = (id: string, tag: 'h2' | 'p', value: string): GraphNode => ({ id, kind: 'text', tag, text: value });
  // A heading and its text. (Chromium can still part a heading from a lone last line when the section's bottom
  // padding no longer fits on the sheet: it does not move the padded section on to the next sheet instead.)
  const children = [text('n-plain-heading', 'h2', PLAIN_HEADING), text('n-plain-text', 'p', PLAIN_TEXT), text('n-plain-more', 'p', PLAIN_MORE)];
  plain.slots = { content: children.map((c) => c.id) };
  for (const child of children) contact.nodes[child.id] = child;
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  header.props = { ...header.props, ctaLabel: HEADER_ACTION, ctaLink: { type: 'email', target: 'hello@example.com' } };
  // The starter dates its copyright from the clock; the test needs the same text every year.
  const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
  footer.props = { ...footer.props, copyright: COPYRIGHT };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css, pageFile: pageFile(contact) };
}

/** The layout and contact page as one script that defines `window.mountSite()`. */
async function bundleSite(files: Map<string, string>, page: string): Promise<string> {
  const src = new Map<string, string>();
  for (const [path, text] of files) src.set(`\0site/${path}`, text);
  src.set('\0site/Entry.svelte', `<script>import Layout from './src/routes/+layout.svelte'; import Page from './${page}';</script><Layout><Page /></Layout>`);
  const entry = [
    "import { flushSync, mount } from 'svelte';",
    "import Entry from '\0site/Entry.svelte';",
    "window.mountSite = () => { mount(Entry, { target: document.getElementById('app') }); flushSync(); };"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exported-site',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          // Stylesheets are inlined in the page; fonts fall back to the system stack.
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (id === '\0$app/paths') return 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;';
          if (id === '\0$app/state') return 'export const page = { route: { id: "/contact" }, url: new URL("https://site.test/contact/") };';
          if (id === '\0$app/navigation') return 'export function afterNavigate() {} export function beforeNavigate() {} export function snapshot() {}';
          const text = src.get(id);
          if (text === undefined) return null;
          return id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate: 'client', css: 'injected' }).js.code : text;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

const site = exportedSite();
let script: Promise<string> | undefined;
const bundled = () => (script ??= bundleSite(site.files, site.pageFile));

/** Opens the mounted contact page with these FAQ questions (by position) opened as a visitor opens them. */
async function openSite(browser: Browser, open: number[], width = 1280): Promise<Page> {
  const code = await bundled();
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: code });
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${site.css}</style></head><body><div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountSite()</script></body></html>`
    });
  });
  await page.goto(`${ORIGIN}/contact/`);
  await page.waitForSelector('details summary');
  for (const i of open) await page.locator('details > summary').nth(i).click();
  return page;
}

const openStates = (page: Page) => page.evaluate<boolean[]>("[...document.querySelectorAll('details')].map((d) => d.open)");
const expected = (open: number[]) => QUESTIONS.map((_, i) => open.includes(i));

/** Prints the page as Chrome's A4 print does by default (0.4 inch margins, no background graphics). */
const printPdf = (page: Page) => page.pdf({ format: 'A4', margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' }, printBackground: false });
/** Each printed sheet's text. */
const print = async (page: Page) => pdfPages(await printPdf(page));

/** The sheets (by number) whose text holds this phrase, ignoring how it wrapped. */
const sheetsWith = (sheets: string[], phrase: string) => sheets.flatMap((text, i) => (squash(text).includes(squash(phrase)) ? [i] : []));

if (!CAN_PRINT) describe.skip('printing a Foundation page (needs Chromium)', () => it('prints in a browser', () => {}));

describe.runIf(CAN_PRINT)('printing a Foundation page as a handout in chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    const [code, launched] = await Promise.allSettled([bundled(), chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (code.status === 'rejected') throw code.reason;
    if (launched.status === 'rejected') throw launched.reason;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    ['every question closed', []],
    ['only the first question open', [0]],
    ['every question open', [0, 1, 2, 3]]
  ] as Array<[string, number[]]>)('prints every FAQ answer with %s, and leaves the questions as the visitor left them', async (_label, open) => {
    const page = await openSite(browser, open);
    try {
      expect(await openStates(page)).toEqual(expected(open));
      const sheets = await print(page);
      for (const [question, answer] of QUESTIONS) {
        expect(sheetsWith(sheets, question), question).toHaveLength(1);
        expect(sheetsWith(sheets, answer), answer).toEqual(sheetsWith(sheets, question));
      }
      // Printing (and so closing the print dialog, printed or cancelled) changes no question's open state.
      expect(await openStates(page)).toEqual(expected(open));
      // Nor does the print preview switching to print media and back.
      await page.emulateMedia({ media: 'print' });
      await page.emulateMedia({ media: null });
      expect(await openStates(page)).toEqual(expected(open));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('keeps the contact details and leaves out controls that only work on screen', async () => {
    const page = await openSite(browser, []);
    try {
      // Controls from an author's own component: a form's submit, reset and typeless buttons, which do nothing on
      // paper, and a button whose label is a contact detail it copies, which a handout keeps.
      await page.evaluate(`(() => {
        const own = document.createElement('div');
        own.innerHTML = '<form><input type="submit" value="Send the request"><button type="reset">Clear the request</button><button>Request a callback</button></form>'
          + '<button type="button" aria-label="Copy email address">studio@example.com</button>';
        document.querySelector('.so-foundation-layout-section__root p').after(own);
      })()`);
      const text = squash((await print(page)).join('\n'));
      for (const value of [...CONTACT_VALUES, 'studio@example.com']) expect(text, value).toContain(squash(value));
      for (const field of FIELDS) expect(text, field).toContain(squash(field));
      for (const plan of PLANS) expect(text, plan.action).toContain(squash(plan.action));
      for (const control of [SUBMIT, HEADER_ACTION, 'Send the request', 'Clear the request', 'Request a callback', 'Open menu', 'Skip to content', 'This form is not connected to a form service yet', 'Leave this field empty'])
        expect(text, control).not.toContain(squash(control));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('hides the menu button and an open phone menu, the FAQ toggle icons, the form actions and messages, and unsticks the header in print', async () => {
    const page = await openSite(browser, [], 390);
    try {
      await page.click('.so-header__toggle');
      // A disclosure of the author's own whose icon says something (here, that weekend visits are included).
      await page.evaluate(`(() => {
        const own = document.createElement('details');
        own.innerHTML = '<summary>Weekend visits <span class="so-icon" id="status-icon">✓</span></summary><p>By appointment.</p>';
        document.querySelector('.so-foundation-layout-section__root p').after(own);
      })()`);
      const styles = () =>
        page.evaluate<Record<string, string>>(`(() => {
          const display = (sel) => [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).display).join(',');
          return {
            toggle: display('.so-header__toggle'),
            nav: display('.so-header__nav'),
            icons: display('.so-foundation-faq-list__toggle-icon'),
            status: display('#status-icon'),
            formActions: display('.so-form__actions'),
            formMessages: display('.so-form__messages'),
            header: getComputedStyle(document.querySelector('.so-header')).position
          };
        })()`);
      // On screen the phone menu is open, below its button, in a header that sticks.
      const screen = await styles();
      expect(screen.toggle).not.toBe('none');
      expect(screen.nav).not.toBe('none');
      expect(screen.icons.split(',')).not.toContain('none');
      expect(screen.status).not.toBe('none');
      expect(screen.formActions).not.toBe('none');
      expect(screen.formMessages).not.toBe('none');
      expect(screen.header).toBe('sticky');
      await page.emulateMedia({ media: 'print' });
      expect(await styles()).toEqual({ toggle: 'none', nav: 'none', icons: 'none,none,none,none', status: screen.status, formActions: 'none', formMessages: 'none', header: 'static' });
      const text = squash((await print(page)).join('\n'));
      expect(text).not.toContain(squash(HEADER_ACTION));
      expect(text).toContain(squash(QUESTIONS[3][1]));
      expect(text).toContain(squash('By appointment.'));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('prints the whole of a closed answer longer than a sheet', async () => {
    const page = await openSite(browser, []);
    try {
      const last = 'This is the last sentence of a very long answer.';
      await page.evaluate(`(() => {
        const answer = document.querySelectorAll('details > p')[3];
        answer.textContent = Array.from({ length: 90 }, (_, i) => 'Sentence ' + (i + 1) + ' of a long answer about builders.').join(' ') + ' ${last}';
      })()`);
      const sheets = await print(page);
      const [first, end] = [sheetsWith(sheets, 'Sentence 1 of a long answer'), sheetsWith(sheets, last)];
      expect(first).toHaveLength(1);
      expect(end).toHaveLength(1);
      expect(end[0]).toBeGreaterThan(first[0]);
      expect(await openStates(page)).toEqual(expected([]));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it(`prints light text on a dark band (the footer, a plan's button and badge) in its own colours, not pale grey`, async () => {
    const page = await openSite(browser, []);
    try {
      await page.emulateMedia({ media: 'print' });
      // Each sample's text colour and the colour of the nearest background behind it, as the page styles them.
      const samples = await page.evaluate<Array<{ text: string; color: string; background: string }>>(`(() => {
        const rgb = (value) => {
          const [r, g, b] = (value.match(/[\\d.]+/g) || []).map(Number);
          return '#' + [r, g, b].map((v) => Math.round(value.startsWith('color(') ? v * 255 : v).toString(16).padStart(2, '0')).join('');
        };
        const behind = (el) => {
          for (let node = el; node; node = node.parentElement) {
            const bg = getComputedStyle(node).backgroundColor;
            if (bg && bg !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(bg)) return rgb(bg);
          }
          return '#ffffff';
        };
        const find = (text) => [...document.querySelectorAll('body *')].find((el) => el.children.length === 0 && el.textContent.trim() === text);
        return [${JSON.stringify(COPYRIGHT)}, ${JSON.stringify(PLANS[0].action)}, 'Most popular'].map((text) => {
          const el = find(text);
          if (!el) throw new Error('No element shows ' + text);
          return { text, color: rgb(getComputedStyle(el).color), background: behind(el) };
        });
      })()`);
      // Ends the emulation (an emulated screen medium would print with screen styles).
      await page.emulateMedia({ media: null });
      const sheets: PdfSheet[] = pdfSheets(await printPdf(page));
      for (const { text, color, background } of samples) {
        // Light on dark, as designed: the case a printer without background graphics turns pale grey.
        expect(background, text).not.toBe('#ffffff');
        const shows = (run: { text: string }) => squash(run.text).includes(squash(text));
        const sheet = sheets.find((s) => s.runs.some(shows));
        expect(sheet, text).toBeDefined();
        const runs = sheet!.runs.filter(shows);
        expect(runs.map((run) => run.fill), text).toEqual([color]);
        expect([...sheet!.fills], text).toContain(background);
      }
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it.each(SECTIONS)('keeps plans, the form, questions and headings whole on a sheet as a page break moves through %s', async (_name, root) => {
    const page = await openSite(browser, []);
    try {
      // Pushes the section down in steps of a few lines, through a whole sheet, so a page boundary crosses each part.
      for (let shift = 0; shift < 1080; shift += 40) {
        await page.evaluate(`(() => {
          let spacer = document.getElementById('print-shift');
          if (!spacer) { spacer = document.createElement('div'); spacer.id = 'print-shift'; document.querySelector(${JSON.stringify(root)}).before(spacer); }
          spacer.style.height = '${shift}px';
        })()`);
        const sheets = await print(page);
        const at = `${shift}px down`;
        for (const plan of PLANS) {
          const parts = [plan.name, plan.price, plan.description, ...plan.features, plan.action];
          const where = parts.map((part) => sheetsWith(sheets, part));
          expect(where[0], `${plan.name} ${at}`).toHaveLength(1);
          expect(where, `${plan.name} ${at}`).toEqual(parts.map(() => where[0]));
        }
        const form = [FORM_HEADING, ...FIELDS].map((part) => sheetsWith(sheets, part));
        expect(form[0], `the form ${at}`).toHaveLength(1);
        expect(form, `the form ${at}`).toEqual(form.map(() => form[0]));
        for (const [question, answer] of QUESTIONS) {
          expect(sheetsWith(sheets, question), `${question} ${at}`).toHaveLength(1);
          expect(sheetsWith(sheets, answer), `${question} ${at}`).toEqual(sheetsWith(sheets, question));
        }
        for (const [heading, first] of HEADINGS) {
          expect(sheetsWith(sheets, heading), `${heading} ${at}`).toHaveLength(1);
          expect(sheetsWith(sheets, first), `${heading} ${at}`).toEqual(sheetsWith(sheets, heading));
        }
      }
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe.each(ENGINES.filter(([name]) => name === 'webkit'))('printing a Foundation page in %s', (_name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    const [code, launched] = await Promise.allSettled([bundled(), engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (code.status === 'rejected') throw code.reason;
    if (launched.status === 'rejected') throw launched.reason;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('shows every FAQ answer under print media with only the first question open, and keeps that state', async () => {
    const page = await openSite(browser, [0]);
    try {
      const visible = () => page.evaluate<boolean[]>("[...document.querySelectorAll('details > p')].map((p) => p.checkVisibility() && p.getBoundingClientRect().height > 0)");
      expect(await visible()).toEqual(expected([0]));
      await page.emulateMedia({ media: 'print' });
      expect(await visible()).toEqual(QUESTIONS.map(() => true));
      await page.emulateMedia({ media: null });
      expect(await visible()).toEqual(expected([0]));
      expect(await openStates(page)).toEqual(expected([0]));
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
