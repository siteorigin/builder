/**
 * An answer typed to a waiting question and left unsent when the project is left is kept as that conversation's
 * unsent message, after any message already being written, so it can be recovered when the project is reopened (#1471).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keepAnswer } from "../../src/renderer/src/lib/chatDrafts";

vi.stubGlobal("window", {
  builder: {
    project: { saveLocalState: async () => {} },
    ai: { stop: async () => {} },
    platform: "darwin",
  },
});

// The editor's store is DOM code, outside this test project's types: loaded by a path the type checker does not follow.
interface EditorState {
  conversation: { id: string } | null;
  chatDrafts: Record<string, string>;
  chatAnswer: { key: string; text: string };
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { getState, setState, keepUnsentAnswer } = (await load(
  "../../src/renderer/src/store",
)) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  keepUnsentAnswer: () => void;
};

describe("keepAnswer", () => {
  it("becomes the draft of an empty composer", () => {
    expect(keepAnswer({}, "c_a", "Warm and local")).toEqual({
      c_a: "Warm and local",
    });
  });
  it("goes after a message being written, never over it", () => {
    expect(keepAnswer({ c_a: "Make it bolder" }, "c_a", "Warm")).toEqual({
      c_a: "Make it bolder\n\nWarm",
    });
  });
  it("ignores a blank answer and other conversations", () => {
    const drafts = { c_b: "Other" };
    expect(keepAnswer(drafts, "c_a", "  \n")).toBe(drafts);
    expect(keepAnswer(drafts, "c_a", "Hi")).toEqual({
      c_b: "Other",
      c_a: "Hi",
    });
  });
});

describe("keepUnsentAnswer on leaving", () => {
  beforeEach(() =>
    setState({
      conversation: null,
      chatDrafts: {},
      chatAnswer: { key: "", text: "" },
    }),
  );
  it("moves the typed answer into the open conversation draft and clears it", () => {
    setState({
      conversation: { id: "c_a" },
      chatAnswer: { key: "r1:q1", text: "Detailed answer" },
    });
    keepUnsentAnswer();
    expect(getState().chatDrafts).toEqual({ c_a: "Detailed answer" });
    expect(getState().chatAnswer.text).toBe("");
  });
  it("does nothing with no answer typed", () => {
    setState({ conversation: { id: "c_a" } });
    const before = getState().chatDrafts;
    keepUnsentAnswer();
    expect(getState().chatDrafts).toBe(before);
  });
});
