/**
 * Creating or saving a code component that has several check warnings shows every one of them, in a notice that stays
 * until it is dismissed (#1332), rather than the count and the first warning for four seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { builder: { platform: "test" } });

interface Toast {
  text: string;
  kind: string;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load("../../src/renderer/src/store")) as {
  warningsToast: (done: "Saved" | "Created", warnings: string[]) => void;
  getState: () => { toasts: Toast[] };
  setState: (s: object) => void;
};

beforeEach(() => {
  vi.useFakeTimers();
  store.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("warnings after a code component is created or saved", () => {
  it("lists every warning and stays past the usual few seconds", () => {
    store.warningsToast("Created", [
      "first problem",
      "second problem",
      "third problem",
    ]);
    vi.advanceTimersByTime(60_000);
    const [t] = store.getState().toasts;
    expect(t.text).toBe(
      "Created with 3 warnings.\n• first problem\n• second problem\n• third problem",
    );
  });

  it("keeps a single warning on one line", () => {
    store.warningsToast("Saved", ["only problem"]);
    expect(store.getState().toasts[0].text).toBe(
      "Saved with 1 warning. only problem",
    );
  });
});

describe("the same warnings said again", () => {
  it("replace the earlier notice instead of stacking", () => {
    store.warningsToast("Saved", ["a", "b"]);
    store.warningsToast("Saved", ["a", "b"]);
    expect(store.getState().toasts).toHaveLength(1);
  });
});
