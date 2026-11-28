/**
 * The arrow on Foundation's text links (`.so-btn--text`) is decorative, so it carries an empty alternative text
 * (issue #1467): a generated glyph without one joins the link's accessible name ("Read in English←"). A plain
 * declaration comes first for browsers that reject the alternative-text syntax, so they keep the arrow.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RELEASES = [
  "resources/packs/foundation/pack.json",
  "resources/packs-dev/foundation-alt/pack.json",
];

describe.each(RELEASES)("%s", (file) => {
  const text = JSON.stringify(JSON.parse(readFileSync(file, "utf8")));

  it("gives the text link arrow an empty alternative text in both directions, with a plain fallback before it", () => {
    expect(text).toContain(
      ".so-btn--text::after { content: '→'; content: '→' / '';",
    );
    expect(text).toContain(
      ".so-btn--text:dir(rtl)::after { content: '←'; content: '←' / '';",
    );
  });

  it("declares the arrow glyph only as that pair, and never overrides it later", () => {
    const arrows = [...text.matchAll(/content:\s*'([→←])'(\s*\/\s*'')?\s*;/g)];
    expect(arrows.map((m) => `${m[1]}${m[2] ? "/" : ""}`)).toEqual([
      "→",
      "→/",
      "←",
      "←/",
    ]);
  });
});
