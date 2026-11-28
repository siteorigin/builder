/**
 * Text typed or pasted on the canvas that is longer than its field takes (#1447): the field's own limit refuses it,
 * the toast names that limit (2,000 characters for a section's heading, not the page's old 20,000 cut-off), and the
 * text is offered back with Copy text instead of being dropped. Text the page could not even send names the limit of
 * the field it was for, and points to no panel. The editor's actions run against a real project session behind a
 * stand-in for the preload bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, OwnerRef, ProjectState, RichText } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { P } from '@catalogue/dsl';
import { ProjectSession } from '../../src/main/project/session';
import { codeTextTarget, type CodeTextTarget } from '../../src/renderer/src/lib/model';
import { richDom } from '../../src/renderer/src/lib/richtext';
import { projectDesign } from './fixtures/packs';

let session: ProjectSession;
const opening = 'opening#too-long';
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh),
    undo: () => session.undo().then(refresh),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

interface Toast {
  text: string;
  kind: string;
  action?: { label: string; copies?: { label: string; text: string } };
}
const load = (path: string) => import(/* @vite-ignore */ path);
const actions = (await load('../../src/renderer/src/lib/actions')) as {
  commitText: (ref: ElementRef, text: string | RichText) => Promise<'restore' | void>;
  commitCodeText: (t: CodeTextTarget, text: string | RichText) => Promise<'restore' | void>;
  canvasTextLimit: (snapshot: ProjectSnapshot, edit: { ref: ElementRef; code?: CodeTextTarget }) => number | null;
  canvasTooLargeReport: (cancel: { length?: unknown; structure?: unknown }, limit: number | null) => string;
};
const store = (await load('../../src/renderer/src/store')) as { setState: (p: Record<string, unknown>) => void; getState: () => { toasts: Toast[]; snapshot: ProjectSnapshot } };

function refresh<T>(r: T): T {
  store.setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

/** A design of the project's own whose eyebrow a placement fills in (a 2,000-character text) and whose note takes 300. */
function withBand(state: ProjectState): ProjectState {
  projectDesign(state, {
    componentId: 'test.band',
    name: 'Band',
    properties: { eyebrow: P.str('Eyebrow', 'Welcome'), note: P.str('Note', 'Short', { maxLength: 300 }), body: P.rich('Body', ['Hello']) },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] } },
    build: (b) => b.el('root', 'section', { name: 'Section' }, [b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow' }), b.text('note', 'p', { $prop: 'note' }, { name: 'Note' }), b.rich('body', { $prop: 'body' }, { name: 'Body' })])
  });
  return state;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-too-long-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, withBand(createStarterState('business', 'Studio', false)));
  store.setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'edit' });
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const homeId = () => session.state.site.homePageId;
const home = (): OwnerRef => ({ kind: 'page', id: homeId() });
const codeText = (node: string, bind: string) => codeTextTarget(session.state, { ctx: `page:${homeId()}`, node, bind });
/** The home page's hero heading, which its section's code marks for typing over. */
function heroHeading(): CodeTextTarget {
  const id = session.state.pages[homeId()].rootIds.find((n) => codeText(n, 'heading'))!;
  return codeText(id, 'heading')!;
}
/** The band, placed on the home page the first time it is asked for, and its text bound to `prop`. */
async function bandText(prop: 'eyebrow' | 'note' | 'body'): Promise<ElementRef> {
  if (!Object.hasOwn(session.state.pages[homeId()].nodes, 'n_band')) {
    const placed = await bridge.project.apply({ operations: [{ type: 'node.insert', newNodeId: 'n_band', owner: home(), parentId: null, index: 0, definitionId: 'foundation.test.band' }] }, { label: 'Add Band' });
    expect(placed.ok).toBe(true);
  }
  return { owner: home(), instancePath: ['n_band'], nodeId: prop };
}
const lastToast = () => store.getState().toasts.at(-1);

describe('text on the canvas longer than its field takes (#1447)', () => {
  it.each([3000, 25000])('refuses %i characters for the hero heading by its own 2,000-character limit, and offers them back to copy', async (n) => {
    const text = 'x'.repeat(n);
    const revision = session.revision;
    expect(await actions.commitCodeText(heroHeading(), text)).toBe('restore');
    expect(session.revision, 'nothing was stored').toBe(revision);
    const t = lastToast()!;
    expect(t.kind).toBe('error');
    expect(t.text).toMatch(/longer than 2000 characters/);
    expect(t.text).not.toMatch(/Inspector/);
    expect(t.action?.label).toBe('Copy text');
    expect(t.action?.copies?.text).toBe(text);
  });

  it('still saves a heading at its limit', async () => {
    const text = 'y'.repeat(2000);
    expect(await actions.commitCodeText(heroHeading(), text)).toBeUndefined();
    expect(lastToast()?.kind).not.toBe('error');
  });

  it('offers back text a placement’s own field refuses, by that field’s limit', async () => {
    const note = await bandText('note');
    const text = 'z'.repeat(301);
    expect(await actions.commitText(note, text)).toBe('restore');
    expect(lastToast()?.text).toMatch(/longer than 300 characters/);
    expect(lastToast()?.action?.copies?.text).toBe(text);
  });

  it('takes one rich run longer than 20,000 characters from the page, and offers it back when its field refuses it', async () => {
    const run = 'w'.repeat(25000);
    expect(richDom([{ tag: 'p', children: [run] }]), 'the page’s copy of it is read').not.toBeNull();
    const body = await bandText('body');
    const revision = session.revision;
    expect(await actions.commitText(body, [{ type: 'p', spans: [{ text: run }] }])).toBe('restore');
    expect(session.revision).toBe(revision);
    expect(lastToast()?.text).toMatch(/longer than 20000 characters/);
    expect(lastToast()?.action?.copies?.text).toBe(run);
  });

  it('knows the limit of the field each canvas text writes, or that nothing limits it', async () => {
    const snap = () => store.getState().snapshot;
    expect(actions.canvasTextLimit(snap(), { ref: { owner: home(), instancePath: [], nodeId: 'x' }, code: heroHeading() })).toBe(2000);
    const eyebrow = await bandText('eyebrow');
    const note = await bandText('note');
    expect(actions.canvasTextLimit(snap(), { ref: eyebrow })).toBe(2000);
    expect(actions.canvasTextLimit(snap(), { ref: note })).toBe(300);
    expect(actions.canvasTextLimit(snap(), { ref: await bandText('body') })).toBe(20000);
    // A page's own text, not bound to any field: nothing limits it but what the page can send.
    const added = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_holder', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', newNodeId: 'n_heading', owner: home(), parentId: 'n_holder', slot: 'content', primitive: 'heading', text: 'Welcome' }
        ]
      },
      { label: 'Add heading' }
    );
    expect(added.ok).toBe(true);
    expect(actions.canvasTextLimit(snap(), { ref: { owner: home(), instancePath: [], nodeId: 'n_heading' } })).toBeNull();
  });
});

describe('what the canvas says of text its page could not send', () => {
  it('names the limit of the field the text was for, and no panel to take it', () => {
    const said = actions.canvasTooLargeReport({ length: 200000 }, 2000);
    expect(said).toBe('That text was not kept: 200000 characters is longer than the 2000 allowed.');
    expect(said).not.toMatch(/Inspector/);
  });

  it('says the text is too long to send when its field has no limit of its own', () => {
    expect(actions.canvasTooLargeReport({ length: 200000 }, null)).toBe('That text is too long to send from the page (200000 characters), so it was not kept.');
    expect(actions.canvasTooLargeReport({}, null)).toBe('That text is too long to send from the page, so it was not kept.');
  });

  it('says formatting too intricate to copy is that, not length', () => {
    expect(actions.canvasTooLargeReport({ length: 10, structure: true }, 2000)).toMatch(/too much formatting/);
  });
});
