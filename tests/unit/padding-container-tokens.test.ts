import { describe, expect, it } from "vitest";
import { STYLE_PROP_MAP, menuTokens, validateStyleValue } from "@shared/styles";
import type { TokenDef } from "@shared/types";

const c = (id: string): TokenDef => ({ id, label: id, group: "container", value: "720px" }) as TokenDef;
const tokens = [c("container.gutter"), c("container.reading"), c("container.content"), { id: "space.md", label: "M", group: "space", value: "16px" } as TokenDef];
const PROPS = ["paddingInline", "paddingInlineStart", "paddingInlineEnd"];

describe("side padding tokens", () => {
  it.each(PROPS)("%s lists the spacing sizes and the page gutter, not the page widths", (p) => {
    const def = STYLE_PROP_MAP[p];
    expect(menuTokens(tokens, def.tokenGroup, def.containerTokens).map((t) => t.id)).toEqual(["container.gutter", "space.md"]);
  });
  it.each(PROPS)("%s refuses a page width token", (p) => {
    expect(validateStyleValue(p, { token: "container.reading" })).toMatch(/Max width/);
    expect(validateStyleValue(p, { token: "container.gutter" })).toBeNull();
    expect(validateStyleValue(p, { token: "space.md" })).toBeNull();
  });
  it("Max width still lists the page widths", () => {
    const def = STYLE_PROP_MAP.maxWidth;
    expect(menuTokens(tokens, def.tokenGroup, def.containerTokens).map((t) => t.id)).toContain("container.reading");
    expect(validateStyleValue("maxWidth", { token: "container.content" })).toBeNull();
  });
});
