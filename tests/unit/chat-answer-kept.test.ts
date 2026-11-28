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
  activeRunId: string | null;
  runStatus: string | null;
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

describe('keepUnsentAnswer on leaving', () => {
  const asked = (id = 'c_a') => ({ id, messages: [{ id: 'm_1', role: 'assistant', runId: 'r1', text: '', questions: [{ id: 'q1', text: 'Which tone?' }] }] });
  const waiting = (conversation: unknown, key = 'r1:q1') => setState({ conversation: conversation as never, activeRunId: 'r1', runStatus: 'awaiting-input', chatAnswer: { key, text: 'Detailed answer' } });
  beforeEach(() => setState({ conversation: null, activeRunId: null, runStatus: null, chatDrafts: {}, chatAnswer: { key: '', text: '' } }));

  it('moves the answer typed to the waiting question into the conversation draft and clears it', () => {
    waiting(asked());
    keepUnsentAnswer();
    expect(getState().chatDrafts).toEqual({ c_a: 'Detailed answer' });
    expect(getState().chatAnswer.text).toBe('');
  });
  it('drops text typed to a question that is no longer the one waiting', () => {
    waiting(asked(), 'r0:q0');
    keepUnsentAnswer();
    expect(getState().chatDrafts).toEqual({});
    expect(getState().chatAnswer.text).toBe('');
  });
  it('does nothing with no answer typed', () => {
    setState({ conversation: asked() });
    const before = getState().chatDrafts;
    keepUnsentAnswer();
    expect(getState().chatDrafts).toBe(before);
  });
});
