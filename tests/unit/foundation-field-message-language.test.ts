/**
 * Foundation's forms show the browser's own `validationMessage` under a field (issue #1525). It is in the browser's
 * language, which a page cannot read, so it must not inherit the page's `lang` and direction: `lang=""` marks the
 * language as unknown and `dir="auto"` takes the direction from the words.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RELEASES = [
  "resources/packs/foundation/pack.json",
  "resources/packs-dev/foundation-alt/pack.json",
];

describe.each(RELEASES)("%s", (file) => {
  const pack = JSON.parse(readFileSync(file, "utf8")) as {
    components: Array<{ componentId: string; source?: string }>;
  };

  it.each(["contact.form", "block.signup"])(
    "isolates the browser's field message in %s",
    (id) => {
      const source = pack.components.find((c) => c.componentId === id)?.source;
      const shown = [
        ...(source ?? "").matchAll(/<(\w+)([^<>]*)>\{problems\[i\]\}</g),
      ];
      expect(shown).toHaveLength(1);
      const [, tag, attributes] = shown[0];
      // Isolated inside the row's own span, so the row keeps the page's direction and alignment.
      expect(tag).toBe("bdi");
      expect(source).toContain("<span><bdi");
      expect(attributes.trim().split(/\s+/).sort()).toEqual([
        'dir="auto"',
        'lang=""',
      ]);
      // The snippet is used, and its words are the control's validationMessage.
      expect(source).toContain("{@render fieldError(i)}");
      expect(source).toContain("? control.validationMessage : ''");
    },
  );
});
