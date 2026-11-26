import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error the harness is plain JavaScript
import { launchEnv } from "../e2e/harness.mjs";

describe("the e2e harness launch environment", () => {
  it("keeps the settings and Documents folders inside the run’s scratch folder", () => {
    const env = launchEnv(
      "/scratch/run",
      {},
      { SITEORIGIN_DOCUMENTS: "/Users/me/Documents", PATH: "/bin" },
    );
    expect(env.SITEORIGIN_USER_DATA).toBe(join("/scratch/run", "userdata"));
    expect(env.SITEORIGIN_DOCUMENTS).toBe(join("/scratch/run", "documents"));
    expect(env.OPENAI_API_KEY).toBe("");
    expect(env.PATH).toBe("/bin");
  });

  it("lets a script override a variable explicitly", () => {
    expect(launchEnv("/s", { OPENAI_API_KEY: "k" }, {}).OPENAI_API_KEY).toBe(
      "k",
    );
  });
});
