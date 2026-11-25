import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/renderer/src/panels/InsertPanel.css", "utf8");

describe("Insert panel compact grid", () => {
  it('never breaks a label word mid-word ("Numbered" in the two-column Basic elements grid)', () => {
    expect(css).toMatch(
      /^\s*\.insert-grid\.compact:not\(\.list\):not\(\.managed\) \.insert-tile strong \{ overflow-wrap: normal; \}/m,
    );
    expect(css).toMatch(
      /^\s*\.insert-grid\.compact:not\(\.list\):not\(\.managed\) \{ grid-template-columns: repeat\(2, minmax\(min-content, 1fr\)\); \}/m,
    );
    // The library's long names keep wrapping inside the word.
    expect(css).not.toMatch(
      /^\s*\.insert-grid\.compact \.insert-tile strong \{[^}]*overflow-wrap: normal/m,
    );
  });
});
