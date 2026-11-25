import { describe, expect, it } from "vitest";
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
    expect(n.next).toMatch(/Close and reopen the project/);
    expect(
      saveFailureNotice({ kind: "unfinished", label: "Two pages", message: "" })
        .what,
    ).toMatch(/^Saving “Two pages” did not finish/);
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
