import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placementMap } from "../../src/renderer/src/lib/placement-map";

/** The Insert preview's placement map reads as a picture of the page, not as option buttons (#507). */
describe("placement map", () => {
  it("captions where the section goes and lists before, new, after", () => {
    const m = placementMap(
      { owner: "Home", before: "Split hero", after: "Contact details" },
      "Statistics",
    );
    expect(m.caption).toBe("Where it goes on Home");
    expect(m.rows).toEqual([
      { kind: "context", label: "Split hero" },
      { kind: "new", label: "Statistics" },
      { kind: "context", label: "Contact details" },
    ]);
  });

  it("names the edges when there is no neighbour", () => {
    const m = placementMap(
      { owner: "Home", before: null, after: null },
      "Statistics",
    );
    expect(m.rows.map((r) => r.label)).toEqual([
      "Top of Home",
      "Statistics",
      "End of Home",
    ]);
  });

  it("gives neighbour rows no border or box background, so they do not look like buttons", () => {
    const css = readFileSync("src/renderer/src/styles.css", "utf8");
    const rule = (sel: string) =>
      css
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(sel + " {")) ?? "";
    const ctx = rule(".insert-peek-map .ctx");
    expect(ctx).not.toBe("");
    expect(ctx).not.toMatch(/box-shadow|border|background/);
    expect(rule(".insert-peek-map")).toMatch(/cursor: default/);
  });
});
