import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, OwnerRef } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';
import { copyProjectSource } from '../../src/main/export';

// Copy in one project, then ⌘V in another (#240): a duplicated project shares its page and element IDs with the
// original, so nothing may be looked up by them in the project pasted into. Copies stay with the project they were
// copied in, and a paste anywhere else says so and changes nothing. The editor's own copy and paste run against real
// project sessions behind a stand-in for the preload bridge, which, like the app, reaches only the open project.
let session: ProjectSession;
let opening = '';
let openings = 0;
/** Every copy request as it reached the app: the opening it named, and the project that was open then. */
const copyCalls: Array<{ key: string | undefined; to: ProjectSession; result?: { ok: boolean } }> = [];
/** The operations of every change the editor sent. */
const sent: string[] = [];
/** Whether the app refuses a copy sent from another opening; off to show the editor refuses it on its own. */
let trustOpening = true;
/** While set, a change is saved but its reply waits for this. */
let replyHeld: Promise<void> | null = null;
const inflight = new Set<Promise<unknown>>();
const track = <T>(p: Promise<T>): Promise<T> => {
  inflight.add(p);
  void p.finally(() => inflight.delete(p)).catch(() => undefined);
  return p;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; opening?: string } = {}) => {
      sent.push(...batch.operations.map((o) => o.type));
      if (opts.opening !== undefined && opts.opening !== opening) return Promise.resolve({ ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } });
      const held = replyHeld;
      return track(
        session
          .apply(batch, { label: opts.label ?? 'Edit', source: 'user' })
          .then(async (r) => (await held, r))
          .then(refresh)
      );
    },
    // Reaches the app a moment later, as a message does, and only the opening it was sent from.
    copy: (pageId: string, nodeId: string | string[], rev: number, key?: string) =>
      track(
        tick().then(async () => {
          const call: (typeof copyCalls)[number] = { key, to: session };
          copyCalls.push(call);
          call.result = key === opening || !trustOpening ? await session.copy(pageId, nodeId, rev) : { ok: false, message: 'That project is no longer open.' };
          return call.result;
        })
      ),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

/** Wait until nothing the editor asked for is still on its way. */
async function settle() {
  do await tick();
  while (inflight.size && (await Promise.allSettled([...inflight])));
  await tick();
}

// The editor's store is DOM code, outside this test project's types: loaded by a path the type checker does not
// follow, with just the shapes this test uses. Each test loads it afresh, so nothing copied in one reaches the next.
interface Toast {
  text: string;
  kind: string;
}
interface LayerSet {
  owner: OwnerRef;
  ids: string[];
  anchor: string;
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: LayerSet | null;
  pageId: string | null;
  definitionMode: unknown;
}
type Plan = { several: boolean };
const load = (path: string) => import(/* @vite-ignore */ path);
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };
let clipboard: { copySelection: (plan?: Plan | null) => boolean; pasteCopy: () => boolean; forgetCopy: () => void };
let actions: { planLayers: () => Plan | null };
const getState = () => store.getState();
const setState = (p: Partial<EditorState>) => store.setState(p);

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: session.dir } as unknown as ProjectSnapshot });
  return r;
}

const sessions: ProjectSession[] = [];
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-cross-paste-'));
  dirs.push(d);
  return d;
};
async function create(starter: 'business' | 'blank', name: string) {
  const s = await ProjectSession.create(scratch(), createStarterState(starter, name, false));
  sessions.push(s);
  return s;
}
/** Duplicate the project as the app does (its source copied to a new folder), and open the copy. */
async function duplicate(of: ProjectSession) {
  const dir = join(scratch(), 'copy');
  await copyProjectSource(of.dir, dir);
  const s = await ProjectSession.open(dir, 'test');
  sessions.push(s);
  return s;
}
/** Make `s` the open project in a new opening, as opening it from Recents does. */
function show(s: ProjectSession) {
  session = s;
  opening = `${s.dir}#${++openings}`;
  setState({ selection: null, layerSet: null, pageId: s.state.site.homePageId, definitionMode: null });
  refresh(null);
}
/** Close the open project, as the editor hears it: its copies go with it. */
function close() {
  clipboard.forgetCopy();
  setState({ snapshot: null, selection: null, layerSet: null, pageId: null });
}

beforeEach(async () => {
  trustOpening = true;
  replyHeld = null;
  copyCalls.splice(0);
  sent.splice(0);
  vi.resetModules();
  store = await load('../../src/renderer/src/store');
  clipboard = await load('../../src/renderer/src/lib/clipboard');
  actions = await load('../../src/renderer/src/lib/actions');
  setState({ toasts: [] });
});
afterEach(async () => {
  await settle();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const home = (s: ProjectSession): OwnerRef => ({ kind: 'page', id: s.state.site.homePageId });
const roots = (s: ProjectSession) => s.state.pages[s.state.site.homePageId].rootIds;
const hero = (s: ProjectSession) => roots(s).map((id) => s.state.pages[s.state.site.homePageId].nodes[id] as InstanceNode).find((n) => s.state.components[n.definitionId]?.componentId === 'hero.split')!;
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });
const entries = (s: ProjectSession) => s.historyInfo().entries.filter((e) => e.applied).length;
const lastToast = () => getState().toasts.at(-1);
const pastes = () => sent.filter((t) => t === 'node.paste').length;

/** Change the hero's heading in the open project `s`, as the Inspector does. */
async function setHeading(s: ProjectSession, text: string) {
  const r = await bridge.project.apply({ operations: [{ type: 'instance.setProp', owner: home(s), nodeId: hero(s).id, prop: 'heading', value: text }] }, { label: 'Edit heading', opening });
  expect(r.ok).toBe(true);
  expect(hero(s).props.heading).toBe(text);
}

/** Press ⌘C on the section at `index` on Home, waiting for the copy to be confirmed. */
async function copySection(s: ProjectSession, index = 0) {
  setState({ selection: ref(home(s), roots(s)[index]), layerSet: null });
  expect(clipboard.copySelection()).toBe(true);
  await settle();
  expect(lastToast()?.text).toMatch(/^Copied /);
}

/** ⌘V in the open project `s`: the key is taken, nothing is sent to the project or changes in it, and the reason is
 *  shown at once. */
async function pasteIsRefused(s: ProjectSession, reason: RegExp) {
  const pages = JSON.stringify(s.state.pages);
  const [n, revision, pasted, toasts] = [entries(s), s.revision, pastes(), getState().toasts.length];
  expect(clipboard.pasteCopy()).toBe(true);
  expect(getState().toasts).toHaveLength(toasts + 1);
  expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(reason) });
  await settle();
  expect(pastes()).toBe(pasted);
  expect(JSON.stringify(s.state.pages)).toBe(pages);
  expect([entries(s), s.revision]).toEqual([n, revision]);
}

const ELSEWHERE = /^Nothing was pasted\. Split hero was copied in another project, and copies can only be pasted in the project they were copied in/;
const REOPENED = /^Nothing was pasted\. Closing the project cleared the copy of Split hero\. Copy it again to paste it\.$/;

describe('paste after switching projects (#240)', () => {
  it('pastes nothing and says nothing while nothing was copied', async () => {
    show(await create('business', 'Business'));
    expect(clipboard.pasteCopy()).toBe(false);
    expect(getState().toasts).toEqual([]);
  });

  it('pastes nothing into a duplicate whose content differs, and says the copy belongs to the other project', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    expect(hero(dup).id).toBe(hero(original).id);
    show(original);
    await setHeading(original, 'Spring opening reception');
    await copySection(original);
    expect(lastToast()?.text).toBe('Copied Split hero. Paste it on any page with ⌘V.');
    close();

    show(dup);
    setState({ selection: ref(home(dup), roots(dup)[0]) });
    await pasteIsRefused(dup, ELSEWHERE);
    expect(roots(dup)).toHaveLength(8);
    expect(hero(dup).props.heading).toBe('Calm, considered spaces for everyday life');
    expect(JSON.stringify(dup.state.pages)).not.toContain('Spring opening reception');
  });

  it('also when the other project opened without this one closing first, every time ⌘V is pressed', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(dup);
    await setHeading(dup, 'Summer open studio');
    await copySection(dup);
    show(original);
    await pasteIsRefused(original, ELSEWHERE);
    expect(hero(original).props.heading).toBe('Calm, considered spaces for everyday life');
    await pasteIsRefused(original, ELSEWHERE);
  });

  it('pastes nothing into an unrelated project, naming what was copied there', async () => {
    const business = await create('business', 'Business');
    const blank = await create('blank', 'Blank');
    show(business);
    const [first, second] = roots(business);
    setState({ selection: ref(home(business), second), layerSet: { owner: home(business), ids: [first, second], anchor: first } });
    expect(clipboard.copySelection()).toBe(true);
    await settle();
    const label = /^Copied (.+)\. Paste them on any page with ⌘V\.$/.exec(lastToast()?.text ?? '')?.[1];
    expect(label).toMatch(/^Split hero and .+/);
    close();
    show(blank);
    const escaped = label!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await pasteIsRefused(blank, new RegExp(`^Nothing was pasted\\. ${escaped} were copied in another project`));
    expect(JSON.stringify(blank.state)).not.toContain('Calm, considered spaces');
  });

  it('asks for a fresh copy after the same project was closed and opened again', async () => {
    const s = await create('business', 'Business');
    show(s);
    await copySection(s);
    close();
    show(s);
    await pasteIsRefused(s, REOPENED);
  });

  it('also when the same folder opens again without the editor hearing it close', async () => {
    const s = await create('business', 'Business');
    show(s);
    await copySection(s);
    show(s);
    await pasteIsRefused(s, REOPENED);
  });

  it('drops a paste still waiting for its copy once the project closes, even when the same project opens again', async () => {
    // As an app that took the copy in whichever project was open when it arrived: the editor alone must refuse it.
    trustOpening = false;
    const s = await create('business', 'Business');
    show(s);
    const [n, history] = [roots(s).length, entries(s)];
    setState({ selection: ref(home(s), roots(s)[0]) });
    expect(clipboard.copySelection()).toBe(true);
    expect(clipboard.pasteCopy()).toBe(true);
    close();
    show(s);
    await settle();
    expect(copyCalls.map((c) => c.result?.ok)).toEqual([true]);
    expect(pastes()).toBe(0);
    expect([roots(s).length, entries(s)]).toEqual([n, history]);
    // Pressed now, it explains instead.
    await pasteIsRefused(s, REOPENED);
  });

  it('never selects what a paste made once the project has closed and opened again before its reply arrived', async () => {
    const s = await create('business', 'Business');
    show(s);
    await copySection(s);
    setState({ selection: null, layerSet: null });
    const n = roots(s).length;
    let release!: () => void;
    replyHeld = new Promise<void>((r) => (release = r));
    try {
      expect(clipboard.pasteCopy()).toBe(true);
      await vi.waitFor(() => expect(roots(s)).toHaveLength(n + 1));
      show(s);
    } finally {
      release();
    }
    await settle();
    expect(getState().selection).toBeNull();
    expect(getState().layerSet).toBeNull();
  });

  it('pastes what this project copied once it copies something itself', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(original);
    await copySection(original);
    close();
    show(dup);
    await setHeading(dup, 'Copied here');
    await copySection(dup);
    const n = roots(dup).length;
    expect(clipboard.pasteCopy()).toBe(true);
    await settle();
    expect(roots(dup)).toHaveLength(n + 1);
    const pasted = dup.state.pages[dup.state.site.homePageId].nodes[roots(dup)[1]] as InstanceNode;
    expect(pasted.props.heading).toBe('Copied here');
    expect(getState().selection?.nodeId).toBe(pasted.id);
  });

  it('never takes a copy in a project other than the one it was pressed in, though the duplicate matches it', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(dup);
    await setHeading(dup, 'Calm and bright');
    show(original);
    await setHeading(original, 'Spring opening reception');
    // Only the opening tells them apart: the same IDs at the same revision.
    expect([hero(dup).id, dup.revision]).toEqual([hero(original).id, original.revision]);
    const pressedIn = opening;
    const [fromDup, fromOriginal] = [vi.spyOn(dup, 'copy'), vi.spyOn(original, 'copy')];
    setState({ selection: ref(home(original), roots(original)[0]) });
    // ⌘C, and the duplicate opens before the request reaches the app.
    expect(clipboard.copySelection()).toBe(true);
    show(dup);
    await settle();
    expect(copyCalls.map((c) => [c.key, c.to])).toEqual([[pressedIn, dup]]);
    expect(copyCalls[0].result).toMatchObject({ ok: false });
    expect(fromDup).not.toHaveBeenCalled();
    expect(fromOriginal).not.toHaveBeenCalled();
    expect(getState().toasts.filter((t) => t.text.startsWith('Copied'))).toEqual([]);
    await pasteIsRefused(dup, ELSEWHERE);
  });

  it('names the latest copy that was taken, not a later one that was refused', async () => {
    const business = await create('business', 'Business');
    const blank = await create('blank', 'Blank');
    show(business);
    await copySection(business);
    // A second copy, of the section after the hero, against a revision the project has moved past.
    setState({ selection: ref(home(business), roots(business)[1]), snapshot: { ...getState().snapshot!, revision: business.revision - 1 } });
    expect(clipboard.copySelection()).toBe(true);
    await settle();
    expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/changed while copying/) });
    close();
    show(blank);
    await pasteIsRefused(blank, ELSEWHERE);
  });

  it('keeps naming the last copy taken after a later one fails in another project', async () => {
    const a = await create('business', 'Business');
    const b = await create('business', 'Other business');
    const c = await create('blank', 'Blank');
    show(a);
    await copySection(a);
    show(b);
    // A copy in B that fails in front of the author, against a revision B has moved past.
    setState({ selection: ref(home(b), roots(b)[1]), snapshot: { ...getState().snapshot!, revision: b.revision - 1 } });
    expect(clipboard.copySelection()).toBe(true);
    await settle();
    expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/changed while copying/) });
    close();
    show(c);
    await pasteIsRefused(c, ELSEWHERE);
  });

  it('ignores a Copy menu made in a project that has since closed, keeping this project’s own copy', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(original);
    setState({ selection: ref(home(original), roots(original)[2]) });
    const stale = actions.planLayers();
    expect(stale).not.toBeNull();
    show(dup);
    await setHeading(dup, 'Copied here');
    await copySection(dup);
    const calls = copyCalls.length;
    expect(clipboard.copySelection(stale)).toBe(true);
    await settle();
    expect(copyCalls).toHaveLength(calls);
    const n = roots(dup).length;
    expect(clipboard.pasteCopy()).toBe(true);
    await settle();
    expect(roots(dup)).toHaveLength(n + 1);
    expect((dup.state.pages[dup.state.site.homePageId].nodes[roots(dup)[1]] as InstanceNode).props.heading).toBe('Copied here');
  });
});
