// renderPages is what thumbnails and review captures both render generated pages through (#999).
import { describe, expect, it } from "vitest";
import { BUILTIN_PACKS } from "@catalogue/builtin";
import { registerPacks } from "@catalogue/index";
import { STYLES_DIR, generateProject, pageFile } from "@generator/index";
import { buildPack } from "../../src/main/packs/build";
import {
  packCss,
  previewProject,
  renderPages,
} from "../../scripts/packs/previews";

describe("renderPages", () => {
  it("renders generated pages to html carrying the pack css, in order", async () => {
    const { pack } = buildPack(
      BUILTIN_PACKS.find((p) => p.id === "foundation")!,
    );
    registerPacks([pack]);
    const { state, cases } = previewProject(pack);
    const generated = generateProject(state);
    const pages = cases.slice(0, 2).map((c) => pageFile(state.pages[c.pageId]));
    const html = await renderPages(generated, pages);
    expect(html).toHaveLength(2);
    for (const doc of html) {
      expect(doc.startsWith("<!doctype html>")).toBe(true);
      for (const sheet of [
        "tokens.css",
        "theme.css",
        "components.css",
        "site.css",
      ])
        expect(doc).toContain(
          (generated.get(`${STYLES_DIR}/${sheet}`) ?? "").slice(0, 120),
        );
      expect(doc).toContain('<main id="main">');
    }
    expect(html[0]).not.toBe(html[1]);
    expect(await renderPages(generated, pages.slice().reverse())).toEqual(
      html.slice().reverse(),
    );
    const block = await renderPages(generated, pages.slice(0, 1), {
      blocks: new Set(pages),
    });
    expect(block[0]).toContain("max-width:");
  });

  it("renders nothing for no pages", async () => {
    expect(await renderPages(new Map(), [])).toEqual([]);
  });
});
