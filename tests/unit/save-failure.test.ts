import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  failedFolder,
  saveFailureMessage,
  written,
  type WriteFailure,
} from "../../src/main/project/save-error";
import { saveFailureNotice } from "../../src/renderer/src/lib/savestate";
import {
  saveStatusAnnouncement,
  toolbarAnnouncement,
} from "../../src/renderer/src/lib/announce";

describe("the save indicator after a save fails (#753)", () => {
  it("names a failed save in words, says what failed and what to do", () => {
    const n = saveFailureNotice({
      kind: "failed",
      label: "Edit text",
      message: "ENOSPC: no space left on device",
    });
    expect(n.text).toBe("Save failed");
    expect(n.title).toMatch(/Project health/);
    expect(n.what).toBe(
      "“Edit text” could not be saved to this computer. Everything saved before it is unchanged.",
    );
    expect(n.next).toMatch(/make the change again/);
  });

  it("names an unfinished save, and says reopening the project finishes it", () => {
    const n = saveFailureNotice({
      kind: "unfinished",
      message:
        "A save did not finish. Close and reopen the project to recover it.",
    });
    expect(n.text).toBe("Save not finished");
    expect(n.what).toBe(
      "A save did not finish, so nothing more is saved for now.",
    );
    // Reopening finishes the save (#1435): never said to lose it.
    expect(n.next).toBe(
      "Check that the project folder can be written to, then close and reopen the project to finish saving it. Changes you make until then are not saved.",
    );
    const named = saveFailureNotice({
      kind: "unfinished",
      label: "Two pages",
      message: "",
    });
    expect(named.what).toMatch(/^Saving “Two pages” did not finish/);
    expect(named.next).toMatch(/to finish saving “Two pages”\./);
  });

  it("is announced as it appears, and as a later save clears it", () => {
    expect(saveStatusAnnouncement("saved", "failed")).toMatch(/^Save failed/);
    // A save in flight after the failure settles from the failure, not from "saved".
    const busy = toolbarAnnouncement("failed", "busy", "saved", false, null);
    expect(busy).toEqual({ say: "", before: "failed" });
    expect(
      toolbarAnnouncement("busy", "saved", busy.before, false, null).say,
    ).toBe("Saved again. All changes saved");
  });
});

describe("what the editor says about a change the project folder could not take (#1435)", () => {
  const project = join(tmpdir(), "so-save-error-project");
  const fsError = (code: string, path: string, extra: object = {}) =>
    Object.assign(new Error(`${code}: failed, open '${path}'`), {
      code,
      path,
      ...extra,
    });

  it("names the folder a file was being written in, never the file", () => {
    const tmp = join(project, "siteorigin", "pages", ".89cc97f77daa.tmp");
    expect(failedFolder(fsError("EACCES", tmp), project)).toBe(
      "siteorigin/pages",
    );
    // A rename names the file it was moving onto.
    expect(
      failedFolder(
        fsError("EPERM", tmp, {
          dest: join(project, "siteorigin", "components", "hero.json"),
        }),
        project,
      ),
    ).toBe("siteorigin/components");
    expect(
      failedFolder(fsError("EACCES", join(project, "site.json")), project),
    ).toBe("");
    // Outside the project, or no path at all: no folder is named.
    expect(
      failedFolder(
        fsError("EACCES", join(tmpdir(), "elsewhere", "a.json")),
        project,
      ),
    ).toBeNull();
    expect(failedFolder(new Error("no path"), project)).toBeNull();
  });

  it("names a folder opened to flush it as itself, and a file there as its folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-save-error-"));
    try {
      mkdirSync(join(dir, "static"));
      writeFileSync(join(dir, "static", "robots.txt"), "");
      expect(failedFolder(fsError("EIO", join(dir, "static")), dir)).toBe(
        "static",
      );
      expect(
        failedFolder(fsError("EIO", join(dir, "static", "robots.txt")), dir),
      ).toBe("static");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says why in plain words, and whether reopening the project finishes it", () => {
    const tmp = join(project, "siteorigin", "pages", ".89cc97f77daa.tmp");
    expect(saveFailureMessage(fsError("EACCES", tmp), project, "failed")).toBe(
      "That change could not be saved: the folder “siteorigin/pages” cannot be written to. Check that you can save files there, then try again.",
    );
    expect(
      saveFailureMessage(fsError("EACCES", tmp), project, "unfinished"),
    ).toBe(
      "That change is not saved yet: the folder “siteorigin/pages” cannot be written to. Check that you can save files there, then close and reopen the project to finish saving it.",
    );
    expect(saveFailureMessage(fsError("EROFS", tmp), project, "failed")).toBe(
      "That change could not be saved: the folder “siteorigin/pages” is on a drive that cannot be written to. Move the project to a drive you can save to, then try again.",
    );
    expect(saveFailureMessage(fsError("EPERM", tmp), project, "failed")).toBe(
      "That change could not be saved: the folder “siteorigin/pages” cannot be written to. Check that you can save files there, then try again.",
    );
    // Its documents are in place; only the rest of the save waits on reopening.
    expect(saveFailureMessage(fsError("EACCES", tmp), project, "landed")).toBe(
      "That change is saved, but saving did not finish: the folder “siteorigin/pages” cannot be written to. Check that you can save files there, then close and reopen the project to finish.",
    );
    // Nothing of it written, and nothing more saved until reopening, which does not save it.
    expect(saveFailureMessage(fsError("EACCES", tmp), project, "blocked")).toBe(
      "That change could not be saved: the folder “siteorigin/pages” cannot be written to. Check that you can save files there, then close and reopen the project, and make the change again.",
    );
    expect(saveFailureMessage(fsError("ENOSPC", tmp), project, "failed")).toBe(
      "That change could not be saved: there is not enough space on the disk. Free up some space, then try again.",
    );
    expect(
      saveFailureMessage(
        fsError("EACCES", join(project, "site.json")),
        project,
        "failed",
      ),
    ).toMatch(/: the project folder cannot be written to\./);
    expect(
      saveFailureMessage(
        fsError("EIO", join(tmpdir(), "elsewhere", "a.json")),
        project,
        "failed",
      ),
    ).toBe(
      "That change could not be saved: a folder it is saved in could not be written to. Check that you can save files there, then try again.",
    );
    for (const code of ["EACCES", "EPERM", "EROFS", "ENOSPC", "EIO"])
      for (const kind of [
        "failed",
        "unfinished",
        "landed",
        "blocked",
      ] as const) {
        const text = saveFailureMessage(fsError(code, tmp), project, kind);
        expect(text).not.toContain(code);
        expect(text).not.toContain(".tmp");
        expect(text).not.toContain(project);
      }
  });

  it("keeps the words of an error that is not the file system's", () => {
    const pin = new Error("The theme “Harbour” is not installed.");
    expect(saveFailureMessage(pin, project, "failed")).toBe(
      "That change could not be saved: The theme “Harbour” is not installed.",
    );
    expect(saveFailureMessage(pin, project, "unfinished")).toBe(
      "That change is not saved yet: The theme “Harbour” is not installed. Close and reopen the project to finish saving it.",
    );
  });
});

describe("the editor's change as main answers it (#1435)", () => {
  const project = join(tmpdir(), "so-save-error-project");
  const session = (kind: WriteFailure | null) => ({
    dir: project,
    revision: 7,
    writeFailure: () => kind,
  });
  const tmp = join(project, "siteorigin", "pages", ".89cc97f77daa.tmp");
  const eacces = () =>
    Object.assign(new Error(`EACCES: permission denied, open '${tmp}'`), {
      code: "EACCES",
      path: tmp,
    });

  it("answers a save that could not be written with what became of it", async () => {
    expect(
      await written(session("unfinished"), Promise.reject(eacces())),
    ).toEqual({
      ok: false,
      revision: 7,
      error: {
        code: "SAVE_FAILED",
        message: expect.stringMatching(
          /^That change is not saved yet: the folder “siteorigin\/pages”/,
        ),
        recoverable: false,
        details: { save: "unfinished" },
      },
    });
    expect(
      (await written(session("failed"), Promise.reject(eacces()))).error,
    ).toMatchObject({ recoverable: true, details: { save: "failed" } });
  });

  it("answers a file system failure that never reached the save as one that wrote nothing", async () => {
    // The project's lock could not be checked, say: nothing of the change was written.
    expect(
      (await written(session(null), Promise.reject(eacces()))).error,
    ).toMatchObject({
      code: "SAVE_FAILED",
      recoverable: true,
      details: { save: "failed" },
    });
  });

  it("throws any other error as it is, and passes an answer through", async () => {
    const bug = new TypeError("x is not a function");
    await expect(written(session(null), Promise.reject(bug))).rejects.toBe(
      bug,
    );
    const ok = { ok: true, revision: 8 };
    expect(await written(session(null), Promise.resolve(ok))).toBe(ok);
  });
});
