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
const copies: Array<{ ok: boolean }> = [];
/** Whether the app refuses a copy sent from another opening; off to show the editor refuses it on its own. */
let trustOpening = true;
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; opening?: string } = {}) => {
      if (opts.opening !== undefined && opts.opening !== opening) return Promise.resolve({ ok: false, revision: session.revision, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.', recoverable: false } });
      return session.apply(batch, { label: opts.label ?? 'Edit', source: 'user' }).then(refresh);
    },
    // Reaches the open project a moment later, as a message to the app does, and only the opening it was sent from.
    copy: (pageId: string, nodeId: string | string[], rev: number, key?: string) =>
      new Promise((r) => setTimeout(r, 0))
        .then(() => (key === opening || !trustOpening ? session.copy(pageId, nodeId, rev) : { ok: false, message: 'That project is no longer open.' }))
        .then((r) => (copies.push(r), r)),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

// The editor's store is DOM code, outside this test project's types: loaded by a path the type checker does not
// follow, with just the shapes this test uses.
interface Toast {
  text: string;
  kind: string;
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: unknown;
  pageId: string | null;
  definitionMode: unknown;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { getState, setState } = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };
const clipboard = (await load('../../src/renderer/src/lib/clipboard')) as { copySelection: () => boolean; pasteCopy: () => boolean; forgetCopy: () => void };

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
  const dir = scratch();
  const s = await ProjectSession.create(dir, createStarterState(starter, name, false));
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

beforeEach(() => {
  trustOpening = true;
  copies.splice(0);
  setState({ toasts: [] });
  clipboard.forgetCopy();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const home = (s: ProjectSession): OwnerRef => ({ kind: 'page', id: s.state.site.homePageId });
const roots = (s: ProjectSession) => s.state.pages[s.state.site.homePageId].rootIds;
const hero = (s: ProjectSession) => roots(s).map((id) => s.state.pages[s.state.site.homePageId].nodes[id] as InstanceNode).find((n) => s.state.components[n.definitionId]?.componentId === 'hero.split')!;
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });
const entries = (s: ProjectSession) => s.historyInfo().entries.filter((e) => e.applied).length;
const lastToast = () => getState().toasts.at(-1);

/** Change the hero's heading in the open project `s`, as the Inspector does. */
async function setHeading(s: ProjectSession, text: string) {
  const r = await bridge.project.apply({ operations: [{ type: 'instance.setProp', owner: home(s), nodeId: hero(s).id, prop: 'heading', value: text }] }, { label: 'Edit heading', opening });
  expect(r.ok).toBe(true);
  expect(hero(s).props.heading).toBe(text);
}

/** Select the first section on Home and press ⌘C, waiting for the copy to be confirmed. */
async function copyFirstSection(s: ProjectSession) {
  setState({ selection: ref(home(s), roots(s)[0]) });
  expect(clipboard.copySelection()).toBe(true);
  await vi.waitFor(() => expect(lastToast()?.text).toMatch(/^Copied /));
}

/** ⌘V in the open project: the key is taken, nothing in the project changes, and the reason is shown. */
async function pasteIsRefused(s: ProjectSession, reason: RegExp) {
  const pages = JSON.stringify(s.state.pages);
  const n = entries(s);
  const toasts = getState().toasts.length;
  expect(clipboard.pasteCopy()).toBe(true);
  await vi.waitFor(() => expect(getState().toasts.length).toBe(toasts + 1));
  // Anything a paste would have done has had its chance to land.
  await new Promise((r) => setTimeout(r, 50));
  expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(reason) });
  expect(JSON.stringify(s.state.pages)).toBe(pages);
  expect(entries(s)).toBe(n);
}

const ELSEWHERE = /^Nothing was pasted\. Split hero was copied in another project/;

describe('paste after switching projects (#240)', () => {
  it('pastes nothing into a duplicate whose content differs, and says the copy belongs to the other project', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    expect(hero(dup).id).toBe(hero(original).id);
    show(original);
    await setHeading(original, 'Spring opening reception');
    await copyFirstSection(original);
    expect(lastToast()?.text).toBe('Copied Split hero. Paste it on any page with ⌘V.');
    close();

    show(dup);
    setState({ selection: ref(home(dup), roots(dup)[0]) });
    await pasteIsRefused(dup, ELSEWHERE);
    expect(roots(dup)).toHaveLength(8);
    expect(hero(dup).props.heading).toBe('Calm, considered spaces for everyday life');
    expect(JSON.stringify(dup.state.pages)).not.toContain('Spring opening reception');
  });

  it('also when the other project opened without this one closing first', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(dup);
    await setHeading(dup, 'Summer open studio');
    await copyFirstSection(dup);
    show(original);
    await pasteIsRefused(original, ELSEWHERE);
    expect(hero(original).props.heading).toBe('Calm, considered spaces for everyday life');
    // Pressed again, it still explains rather than going quiet.
    await pasteIsRefused(original, ELSEWHERE);
  });

  it('pastes nothing into an unrelated project', async () => {
    const business = await create('business', 'Business');
    const blank = await create('blank', 'Blank');
    show(business);
    await copyFirstSection(business);
    close();
    show(blank);
    await pasteIsRefused(blank, ELSEWHERE);
    expect(JSON.stringify(blank.state)).not.toContain('Calm, considered spaces');
  });

  it('asks for a fresh copy after the same project was closed and opened again', async () => {
    const s = await create('business', 'Business');
    show(s);
    await copyFirstSection(s);
    close();
    show(s);
    await pasteIsRefused(s, /^Nothing was pasted\. Closing the project cleared the copy of Split hero\. Copy it again/);
  });

  it('drops a paste still waiting for its copy once the project closes, even when the same project opens again', async () => {
    // As an app that took the copy in whichever project was open when it arrived: the editor alone must refuse it.
    trustOpening = false;
    const s = await create('business', 'Business');
    show(s);
    const n = roots(s).length;
    const history = entries(s);
    setState({ selection: ref(home(s), roots(s)[0]) });
    expect(clipboard.copySelection()).toBe(true);
    expect(clipboard.pasteCopy()).toBe(true);
    close();
    show(s);
    await vi.waitFor(() => expect(copies).toHaveLength(1));
    expect(copies[0]).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(roots(s)).toHaveLength(n);
    expect(entries(s)).toBe(history);
    // Pressed now, it explains instead.
    await pasteIsRefused(s, /^Nothing was pasted\. Closing the project cleared the copy of Split hero/);
  });

  it('pastes what this project copied once it copies something itself', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(original);
    await copyFirstSection(original);
    close();
    show(dup);
    await setHeading(dup, 'Copied here');
    await copyFirstSection(dup);
    const n = roots(dup).length;
    expect(clipboard.pasteCopy()).toBe(true);
    await vi.waitFor(() => expect(roots(dup)).toHaveLength(n + 1));
    const pasted = dup.state.pages[dup.state.site.homePageId].nodes[roots(dup)[1]] as InstanceNode;
    expect(pasted.props.heading).toBe('Copied here');
    expect(lastToast()?.kind).not.toBe('error');
  });

  it('never takes a copy in a project other than the one it was pressed in', async () => {
    const original = await create('business', 'Business');
    const dup = await duplicate(original);
    show(original);
    await setHeading(original, 'Spring opening reception');
    setState({ selection: ref(home(original), roots(original)[0]) });
    // ⌘C, and the duplicate opens before the copy is taken: the copy is refused rather than taken from the duplicate.
    expect(clipboard.copySelection()).toBe(true);
    show(dup);
    await new Promise((r) => setTimeout(r, 50));
    expect(copies.at(-1)).toMatchObject({ ok: false });
    expect(getState().toasts.filter((t) => t.text.startsWith('Copied'))).toHaveLength(0);
    await pasteIsRefused(dup, ELSEWHERE);
  });
});
