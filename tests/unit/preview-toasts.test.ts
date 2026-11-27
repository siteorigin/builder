import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/renderer/src/styles/primitives.css", "utf8");

describe("toasts over the canvas's foot (#562)", () => {
  it("stand above the foot the canvas measures, never at a fixed offset over it", () => {
    // The canvas says how high its foot stands on the body (src/renderer/src/lib/canvas-foot.ts); with nothing there the
    // notices keep their own place, clear of the window's foot.
    expect(css).toMatch(/--notices-bottom: var\(--notices-over-foot, 40px\);/);
    expect(css).not.toMatch(/body\.previewing/);
    expect(css).not.toMatch(/--notices-bottom: \d+px/);
  });
});
