/**
 * An open FAQ row keeps keyboard focus on its question (issue #1400). The focus ring sits 3px off the summary with a
 * 2px line, so the answer starts below those 5px instead of being pulled up under the ring, and the open summary's
 * bottom padding gives that distance back so the spacing is unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RELEASES = [
  "resources/packs/foundation/pack.json",
  "resources/packs-dev/foundation-alt/pack.json",
];

describe.each(RELEASES)("%s", (file) => {
  const pack = JSON.parse(readFileSync(file, "utf8")) as { components: Array<{ id: string; source: string }> };
  const source = pack.components.find((c) => c.id.endsWith("faq.list"))!.source;

  it("starts the answer below the focus ring instead of pulling it up under it", () => {
    const answer = /\.faq__answer \{([^}]*)\}/.exec(source)![1];
    expect(answer).toMatch(/margin-block:\s*5px var\(--so-space-lg\)/);
    expect(answer).not.toMatch(/\*\s*-1/);
  });

  it("shortens the open summary's bottom padding by the same distance", () => {
    expect(source).toMatch(
      /\.faq__item\[open\] > \.faq__summary \{\s*padding-block-end: max\(0px, calc\(var\(--so-space-lg\) - var\(--so-space-md\) - 5px\)\);/,
    );
  });
});
