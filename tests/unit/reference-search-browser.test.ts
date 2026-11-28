/**
 * A single reference field over a long list of entries (#1521) is a searchable picker (found by title, date, address or
 * author) rather than one native menu; a short list keeps the plain menu. The real EntryValueFields run in a real
 * browser with a stand-in for the form's `set`.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { build, type Rolldown } from "vite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { ProjectState } from "@shared/types";
import type { EditOperation } from "@shared/ops";
import { createStarterState } from "@catalogue/starters";
import { run } from "./fixtures/seo-site";

const browserInstalled = existsSync(chromium.executablePath());
const SITE = "http://reference-search.test";
const src = (path: string) => JSON.stringify(resolve("src", path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { EntryValueFields } from ${src("renderer/src/panels/EntryValueFields")};`,
  "window.sets = [];",
  "window.mount = (state) => {",
  "  const collection = state.collections.trials; const entry = collection.entries.en_trial;",
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(EntryValueFields, { state, collection, entry, set: (name, value) => { window.sets.push([name, value]); return true; }, refuse: () => false })));",
  "};",
].join("\n");

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: Object.fromEntries(
        ["shared", "engine", "generator", "catalogue", "agent", "runtime"].map(
          (n) => [`@${n}`, resolve("src", n)],
        ),
      ),
    },
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "reference-search",
        enforce: "pre",
        resolveId: (id, importer) =>
          id === "\0entry"
            ? id
            : id.endsWith(".css") &&
                importer &&
                existsSync(resolve(dirname(importer), id))
              ? "\0empty"
              : null,
        load: (id) => (id === "\0entry" ? ENTRY : id === "\0empty" ? "" : null),
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: "\0entry",
        output: { format: "iife", codeSplitting: false },
      },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find(
    (o) => o.type === "chunk",
  );
  if (!chunk || chunk.type !== "chunk")
    throw new Error("The panel did not bundle");
  return chunk.code;
}

function site(posts: number): ProjectState {
  const ops: EditOperation[] = [
    { type: "collection.create", collectionId: "posts" },
  ];
  for (let i = 1; i <= posts; i++)
    ops.push({
      type: "entry.create",
      collectionId: "posts",
      entryId: `en_p${i}`,
      title: i === 7 ? "Why drip lines fail in August" : `Field diary ${i}`,
      publishedAt: `2026-0${(i % 9) + 1}-10`,
      draft: i === 3,
      ...(i === 5 ? { author: "Mara Quill" } : {}),
    });
  ops.push(
    {
      type: "collection.create",
      collectionId: "trials",
      kind: "structured",
      name: "Field Trials",
      singularName: "Trial",
      fields: {
        writeup: { type: "reference", label: "Write-up", collection: "posts" },
      },
    },
    {
      type: "entry.create",
      collectionId: "trials",
      entryId: "en_trial",
      title: "Trial one",
      draft: false,
    },
  );
  return run(createStarterState("business", "Riverside Studio", false), ...ops);
}

describe.skipIf(!browserInstalled)(
  "searching a reference field (#1521)",
  { timeout: 30_000 },
  () => {
    let browser: Browser;
    let script: string;
    let context: BrowserContext;
    let page: Page;
    let errors: string[];
    const mount = (state: ProjectState) =>
      page.evaluate(
        (s) => (globalThis as unknown as { mount(s: unknown): void }).mount(s),
        state as unknown,
      );
    const sets = () =>
      page.evaluate(() => (globalThis as unknown as { sets: unknown[] }).sets);

    beforeAll(async () => {
      [script, browser] = await Promise.all([
        bundle(),
        chromium.launch({ headless: true }),
      ]);
    }, 120_000);
    afterAll(async () => {
      await browser?.close();
    }, 60_000);
    beforeEach(async () => {
      context = await browser.newContext({
        viewport: { width: 900, height: 900 },
      });
      context.setDefaultTimeout(5_000);
      page = await context.newPage();
      errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(`${SITE}/**`, (route) =>
        new URL(route.request().url()).pathname === "/app.js"
          ? route.fulfill({
              contentType: "text/javascript; charset=utf-8",
              body: script,
            })
          : route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script src="/app.js"></script>`,
            }),
      );
      await page.goto(`${SITE}/`);
    });
    afterEach(async () => {
      await context?.close();
      expect(errors).toEqual([]);
    });

    it("keeps the plain menu for a short list", async () => {
      await mount(site(5));
      expect(await page.locator("select").count()).toBe(1);
      expect(await page.getByLabel("Find in Posts").count()).toBe(0);
    });

    it("narrows a long list by title, author and date, and chooses one", async () => {
      await mount(site(30));
      expect(await page.locator("select").count()).toBe(0);
      const find = page.getByLabel("Find in Posts");
      expect(await page.getByRole("radio").count()).toBe(30);
      await find.fill("drip lines");
      expect(await page.getByRole("radio").count()).toBe(1);
      await find.fill("quill");
      expect(await page.getByRole("radio").count()).toBe(1);
      await find.fill("draft");
      expect(await page.getByRole("radio").count()).toBe(1);
      await find.fill("zzz");
      expect(await page.getByRole("radio").count()).toBe(0);
      await find.fill("drip");
      await page.getByRole("radio").first().click();
      expect(await sets()).toEqual([["writeup", "en_p7"]]);
    });
  },
);
