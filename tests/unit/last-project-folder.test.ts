/** New project proposes the folder the last project was created in (#876), and nothing once that folder is gone. */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => env.userData, isPackaged: false },
}));

const dirs: string[] = [];
let root = "";
beforeEach(() => {
  env.userData = realpathSync(mkdtempSync(join(tmpdir(), "so-last-userdata-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-last-sites-")));
  dirs.push(env.userData, root);
  vi.resetModules();
});
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);

describe("last project folder", () => {
  it("has no suggestion before a project is created", async () => {
    const s = await import("../../src/main/settings");
    expect(await s.usableProjectParent()).toBeUndefined();
  });

  it("suggests the remembered folder, also after a restart", async () => {
    const parent = join(root, "Websites");
    mkdirSync(parent);
    const s = await import("../../src/main/settings");
    await s.rememberProjectParent(parent);
    expect(await s.usableProjectParent()).toBe(parent);
    vi.resetModules();
    expect(
      await (await import("../../src/main/settings")).usableProjectParent(),
    ).toBe(parent);
  });

  it("suggests nothing once the folder is gone or is a file", async () => {
    const parent = join(root, "Websites");
    mkdirSync(parent);
    const s = await import("../../src/main/settings");
    await s.rememberProjectParent(parent);
    rmSync(parent, { recursive: true });
    expect(await s.usableProjectParent()).toBeUndefined();
    writeFileSync(parent, "x");
    expect(await s.usableProjectParent()).toBeUndefined();
  });
});
