import { beforeAll, describe, expect, it } from "vitest";
import { createStarterState } from "@catalogue/starters";
import type { ProjectSnapshot } from "@shared/api";

/** Notices belong to the project they were raised in (#875): opening another one clears them. */
type AppModule = typeof import("../../src/renderer/src/App");
type StoreModule = typeof import("../../src/renderer/src/store");
const APP_PATH = "../../src/renderer/src/App";
const STORE_PATH = "../../src/renderer/src/store";
let app: AppModule;
let store: StoreModule;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    builder: {
      platform: "test",
      ai: {
        newConversation: () => Promise.resolve(null),
        conversation: () => Promise.resolve(null),
        listConversations: () => Promise.resolve([]),
      },
    },
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  store = (await import(/* @vite-ignore */ STORE_PATH)) as StoreModule;
  app = (await import(/* @vite-ignore */ APP_PATH)) as AppModule;
});

const snap = (key: string) =>
  ({
    state: createStarterState("blank"),
    workspaceKey: key,
    revision: 1,
    localState: {},
    runtime: { status: "stopped" },
  }) as unknown as ProjectSnapshot;

describe("notices across projects", () => {
  it("drops an error notice left by the previous project when another opens", () => {
    app.openSnapshot(snap("a"));
    store.toast('Language must be a code such as "en" or "en-AU".', "error");
    expect(store.getState().toasts).toHaveLength(1);
    app.openSnapshot(snap("b"));
    expect(store.getState().toasts).toEqual([]);
  });
});
