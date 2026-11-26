/** The provider settings checks that need no network: a key's shape, and a server address typed without its scheme. */
import { describe, expect, it } from "vitest";
import { checkLocalBaseURL, keyDoubt } from "../../src/shared/local";

const anthropicKey = `sk-ant-api03-${"a1B2c3D4".repeat(6)}`;
const openaiKey = `sk-proj-${"a1B2c3D4".repeat(6)}`;

describe("keyDoubt", () => {
  it("questions text that cannot be a key, and a key from the other provider", () => {
    expect(keyDoubt("openai", "hello")).toMatch(/OpenAI keys start with sk-/);
    expect(keyDoubt("anthropic", "hello")).toMatch(/sk-ant-/);
    expect(keyDoubt("openai", anthropicKey)).toMatch(/Anthropic key/);
    expect(keyDoubt("anthropic", openaiKey)).toMatch(/OpenAI key/);
    expect(
      keyDoubt("openai", "sk-two words here that are long"),
    ).not.toBeNull();
  });
  it("accepts keys of the right shape, and never questions a local server key", () => {
    expect(keyDoubt("openai", ` ${openaiKey} `)).toBeNull();
    expect(keyDoubt("openai", "sk-" + "x".repeat(40))).toBeNull();
    expect(keyDoubt("anthropic", anthropicKey)).toBeNull();
    expect(keyDoubt("local", "hello")).toBeNull();
  });
});

describe("a server address without a scheme", () => {
  it.each([
    ["localhost:11434", "http://localhost:11434/v1"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
    ["localhost:1234/v1", "http://localhost:1234/v1"],
    ["[::1]:8080", "http://[::1]:8080/v1"],
    ["http://localhost:11434", "http://localhost:11434/v1"],
  ])("takes %s as %s", (typed, url) => {
    expect(checkLocalBaseURL(typed)).toMatchObject({ ok: true, url });
  });
  it("still refuses what is not an address, another scheme, or another machine", () => {
    expect(checkLocalBaseURL("not a url").ok).toBe(false);
    expect(checkLocalBaseURL("ftp://127.0.0.1/v1").ok).toBe(false);
    expect(checkLocalBaseURL("example.com:8080").ok).toBe(false);
  });
});
