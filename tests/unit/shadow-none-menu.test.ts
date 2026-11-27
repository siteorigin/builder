import { describe, expect, it } from "vitest";
import { STYLE_PROP_MAP, menuTokens as tokenOptions } from "@shared/styles";
import type { TokenDef } from "@shared/types";

const shadow = (id: string, value: TokenDef["value"]): TokenDef =>
  ({ id, label: id, group: "shadow", value }) as TokenDef;

describe("Shadow menu", () => {
  it("offers None, stored as none", () => {
    expect(STYLE_PROP_MAP.shadow.options).toEqual([
      { value: "none", label: "None" },
    ]);
  });
  it("leaves out shadow styles that draw nothing, directly or by following another", () => {
    const tokens = [
      shadow("shadow.sm", "none"),
      shadow("shadow.md", { token: "shadow.sm" }),
      shadow("shadow.lg", "0 4px 8px #0003"),
      {
        id: "radius.sm",
        label: "S",
        group: "radius",
        value: "4px",
      } as TokenDef,
    ];
    expect(tokenOptions(tokens, "shadow").map((t) => t.id)).toEqual([
      "shadow.lg",
    ]);
    expect(tokenOptions(tokens, "radius").map((t) => t.id)).toEqual([
      "radius.sm",
    ]);
  });
});
