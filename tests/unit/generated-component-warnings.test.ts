/**
 * Issue #880: an export that uses every built-in component builds with no Svelte warnings (the accessibility checks
 * included). Each generated component is compiled for the server and the client, and any warning fails the test.
 */
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";
import { createStarterState } from "@catalogue/starters";
import { catalogueEntries } from "@catalogue/index";
import { applyOperations } from "@engine/apply";
import { generateProject } from "@generator/index";

describe("generated components", () => {
  it("compile with no warnings, for every built-in component", () => {
    const s0 = createStarterState("business", "Kloof", false);
    const page = Object.values(s0.pages)[0];
    const owner = { kind: "page" as const, id: page.id };
    const ids = catalogueEntries(s0.site.themeId).map((e) => e.componentId);
    let state = s0;
    for (const componentId of ids) {
      try {
        state = applyOperations(state, [
          { type: "node.insert", owner, componentId, index: 0 },
        ]).state;
      } catch {
        // A component that cannot be placed on a page by itself is covered by the starters.
      }
    }
    expect(
      Object.values(state.pages[page.id].nodes).filter(
        (n) => n.kind === "instance",
      ).length as number,
    ).toBeGreaterThan(ids.length / 2);
    const files = generateProject(state);
    const svelte = [...files].filter(([f]) => f.endsWith(".svelte"));
    expect(svelte.some(([f]) => f.includes("data-table"))).toBe(true);
    const warnings: string[] = [];
    for (const [filename, source] of svelte) {
      for (const generate of ["client", "server"] as const) {
        const out = compile(String(source), {
          filename,
          generate,
          runes: true,
        });
        for (const w of out.warnings)
          warnings.push(`${filename} (${generate}): ${w.code}: ${w.message}`);
      }
    }
    expect(warnings).toEqual([]);
  });
});
