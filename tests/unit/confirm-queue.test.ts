import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

/** The store is renderer code (it reads `window`), outside the Node type-check project, so it is loaded by
 *  path at run time, after a bare `window.builder` exists for it to read. */
type Store = {
  confirmDialog: (req: { title: string; body: string; confirmLabel: string }) => Promise<boolean | null>;
  getConfirm: () => { id: number; title: string; resolve: (ok: boolean | null) => void } | null;
  pendingConfirms: () => readonly { id: number; title: string; resolve: (ok: boolean | null) => void }[];
  onConfirmChange: (fn: () => void) => () => void;
};
let store: Store;
let leave: { projectClosed: () => void };
beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { builder: { platform: 'test' } };
  store = (await import(/* @vite-ignore */ resolve('src/renderer/src/store.ts'))) as Store;
  leave = (await import(/* @vite-ignore */ resolve('src/renderer/src/lib/leave.ts'))) as typeof leave;
});

const ask = (title: string) => store.confirmDialog({ title, body: title, confirmLabel: 'Yes' });
const getConfirm = () => store.getConfirm();
const pendingConfirms = () => store.pendingConfirms();
const onConfirmChange = (fn: () => void) => store.onConfirmChange(fn);

describe('confirmDialog', () => {
  it('shows one question at a time and asks the rest in the order they were asked', async () => {
    const first = ask('first');
    const second = ask('second');
    const third = ask('third');
    expect(getConfirm()?.title).toBe('first');
    expect(pendingConfirms().map((q) => q.title)).toEqual(['first', 'second', 'third']);

    getConfirm()!.resolve(true);
    expect(await first).toBe(true);
    // The next question takes the screen only once the first is answered.
    expect(getConfirm()?.title).toBe('second');

    getConfirm()!.resolve(false);
    expect(await second).toBe(false);
    expect(getConfirm()?.title).toBe('third');

    getConfirm()!.resolve(null);
    expect(await third).toBe(null);
    expect(getConfirm()).toBeNull();
  });

  it('gives each question its own dialog identity', () => {
    void ask('a');
    void ask('b');
    const [a, b] = pendingConfirms();
    expect(a.id).not.toBe(b.id);
    a.resolve(null);
    b.resolve(null);
  });

  it('answers a question once, however many times it is dismissed', async () => {
    const first = ask('first');
    const second = ask('second');
    const open = getConfirm()!;
    open.resolve(true);
    open.resolve(false);
    expect(await first).toBe(true);
    // The late dismissal of the answered question leaves the one now on screen alone.
    expect(getConfirm()?.title).toBe('second');
    getConfirm()!.resolve(true);
    expect(await second).toBe(true);
  });

  it('answers a waiting question without disturbing the one on screen', async () => {
    const first = ask('first');
    const second = ask('second');
    pendingConfirms()[1].resolve(null);
    expect(await second).toBe(null);
    expect(getConfirm()?.title).toBe('first');
    getConfirm()!.resolve(true);
    expect(await first).toBe(true);
    expect(getConfirm()).toBeNull();
  });

  it('keeps the order of the rest when one in the middle is dismissed', async () => {
    const a = ask('a');
    const b = ask('b');
    const c = ask('c');
    let calls = 0;
    const off = onConfirmChange(() => calls++);
    pendingConfirms()[1].resolve(false);
    expect(await b).toBe(false);
    expect(calls).toBe(0);
    getConfirm()!.resolve(true);
    getConfirm()!.resolve(null);
    expect([await a, await c]).toEqual([true, null]);
    off();
  });

  it('tells listeners when the question on screen changes, not when one only joins the line', () => {
    let calls = 0;
    const off = onConfirmChange(() => calls++);
    void ask('first');
    expect(calls).toBe(1);
    void ask('second');
    expect(calls).toBe(1);
    getConfirm()!.resolve(true);
    expect(calls).toBe(2);
    getConfirm()!.resolve(true);
    expect(calls).toBe(3);
    off();
  });

  it('drops every waiting question about a project that has closed, and keeps the others', async () => {
    const other = ask('Something else');
    const leaving = ask('Leave without your last change?');
    const leavingAgain = ask('Leave without your last change?');
    leave.projectClosed();
    expect(await leaving).toBe(null);
    expect(await leavingAgain).toBe(null);
    expect(pendingConfirms().map((q) => q.title)).toEqual(['Something else']);
    getConfirm()!.resolve(true);
    expect(await other).toBe(true);
  });

  it('answers a leave question already on screen when the project closes', async () => {
    const leaving = ask('Leave without your last change?');
    const other = ask('Something else');
    expect(getConfirm()?.title).toBe('Leave without your last change?');
    leave.projectClosed();
    expect(await leaving).toBe(null);
    expect(getConfirm()?.title).toBe('Something else');
    getConfirm()!.resolve(false);
    expect(await other).toBe(false);
  });
});
