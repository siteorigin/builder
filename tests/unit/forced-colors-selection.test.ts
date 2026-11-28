import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Forced colours remove box-shadows and background images, so the canvas selection ring and the selected Layers row
// are drawn from outlines and system colours there (#1551).
function forcedBlocks(path: string): string {
  const css = readFileSync(path, "utf8");
  const out: string[] = [];
  let at = css.indexOf("@media (forced-colors: active)");
  while (at !== -1) {
    let depth = 0;
    let i = css.indexOf("{", at);
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(start, i));
    at = css.indexOf("@media (forced-colors: active)", i);
  }
  return out.join("\n");
}

describe("forced colours keep the selection visible", () => {
  it("draws the canvas selection and hover as outlines", () => {
    const css = forcedBlocks("src/renderer/src/panels/Canvas.css");
    expect(css).toMatch(/\.ov-selected \{[^}]*outline: 3px solid SelectedItem/);
    expect(css).toMatch(/\.ov-hover \{[^}]*outline: 2px solid CanvasText/);
  });

  it("fills the selected layer row in the system selected colours", () => {
    const css = forcedBlocks("src/renderer/src/panels/LayersPanel.css");
    expect(css).toMatch(
      /\.layer-row\.selected \{[^}]*background: SelectedItem; color: SelectedItemText/,
    );
    expect(css).toMatch(
      /\.layer-row\.selected\.member[^{]*\{[^}]*outline: 2px dashed SelectedItem/,
    );
  });
});
