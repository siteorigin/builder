/**
 * Issue #880: an export that uses every built-in component builds with no Svelte warnings (the accessibility checks
 * included). Each generated component of every theme is compiled for the server and the client, and any warning fails.
 */
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";
import { createStarterState } from "@catalogue/starters";
import { catalogueEntries, listThemes } from "@catalogue/index";
import { applyOperations } from "@engine/apply";
import { defFile, generateProject } from "@generator/index";

describe("generated components", () => {
  for (const theme of listThemes()) {
    it(`compile with no warnings, for every component of ${theme.id}`, () => {
      let state = createStarterState("business", "Kloof", false);
      state = applyOperations(state, [
        { type: "theme.apply", themeId: theme.id },
      ]).state;
      const page = Object.values(state.pages)[0];
      const owner = { kind: "page" as const, id: page.id };
      for (const { componentId } of catalogueEntries(theme.id)) {
        state = applyOperations(state, [
          { type: "node.insert", owner, componentId, index: 0 },
        ]).state;
      }
      const files = generateProject(state);
      const used = new Set(
        Object.values(state.pages[page.id].nodes).flatMap((n) =>
          n.kind === "instance"
            ? [defFile(state.components[n.definitionId])]
            : [],
        ),
      );
      expect(used.size).toBeGreaterThan(0);
      for (const f of used) expect(files.has(f), f).toBe(true);
      const warnings: string[] = [];
      for (const [filename, source] of files) {
        if (!filename.endsWith(".svelte")) continue;
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
  }
});
