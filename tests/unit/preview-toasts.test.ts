import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/renderer/src/styles.css", "utf8");
const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(sel + " {")) ?? "";
const px = (decl: string, prop: string) => Number(new RegExp(`${prop}: (\\d+)px`).exec(decl)?.[1]);

describe("toasts while previewing (#562)", () => {
  it("lifts the toast stack above the Previewing bar", () => {
    const pill = rule(".preview-pill");
    const toasts = rule("body:has(.preview-pill:not([inert] *)) .toasts");
    expect(toasts).not.toBe("");
    // The bar is 18px above the canvas floor, itself 28px (the status bar) above the window bottom, and 36px tall.
    const barTop = px(pill, "bottom") + 28 + 36;
    expect(px(toasts, "bottom")).toBeGreaterThanOrEqual(barTop);
  });
});
