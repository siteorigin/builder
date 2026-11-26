import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import { Collector, Trace } from '../../scripts/perf/results';
import { CHAT_CASES, CHAT_REPLY_CHECKPOINTS, CHAT_TYPED, chainFor, chat, chatReply, chatReplyFirst, chatReplyLast, chatSeed, edit, expect as check, findHeading, launch, open, PANELS, panels, runChain, SHOWN_PANELS, type FixtureFacts, type Scenario, type ScenarioContext } from '../../scripts/perf/scenarios';
import { FIXTURES } from '../../scripts/perf/fixtures';

let seq = 0;
const m = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'main', pid: 1, seq: ++seq, ...extra });
const r = (name: string, t: number, extra: Partial<PerfRecord> = {}) => m(name, t, { proc: 'renderer', pid: 2, ...extra });
const span = (name: string, t: number, ms: number, extra: Partial<PerfRecord> = {}) => m(name, t, { kind: 'span', ms, ...extra });

const facts: FixtureFacts = { spec: FIXTURES.small, pages: 3, entries: 0, assets: 0, projectComponents: 0, homePageId: 'pg_home', homeRoute: '/', heroId: 'n_hero', heading: 'Welcome' };

describe('the scenario chain', () => {
  it('runs each scenario after the ones it follows', () => {
    expect(chainFor(['edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(chainFor(['chat']).map((s) => s.name)).toEqual(['launch', 'open', 'chat']);
    expect(chainFor(['open']).map((s) => s.name)).toEqual(['launch', 'open']);
    expect(chainFor(['launch']).map((s) => s.name)).toEqual(['launch']);
    expect(chainFor(['edit', 'launch', 'open']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(chainFor(['panels']).map((s) => s.name)).toEqual(['launch', 'open', 'panels']);
    expect(chainFor(['panels', 'edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit', 'panels']);
    expect(chainFor([])).toEqual([]);
    expect(() => chainFor(['nope'])).toThrow('Unknown scenario');
  });

  const fake = (name: string, how: { run?: () => Promise<void>; missing?: string[] } = {}): Scenario => ({
    name,
    after: null,
    description: name,
    run: how.run ?? (async () => {}),
    measure: () => {
      const c = new Collector();
      for (const x of how.missing ?? []) c.need(x, undefined);
      c.count(`${name}.n`, 1);
      return c;
    }
  });
  const ctx = { fixture: facts } as unknown as ScenarioContext;
  const trace = async () => new Trace([]);

  it('stops at a scenario that did not get the app where the next starts, and says why', async () => {
    const out = await runChain([fake('a'), fake('b', { run: async () => check(false, 'the preview never showed it') }), fake('c')], ctx, trace, 1000);
    expect(out.map((o) => [o.scenario, o.ok, o.error?.stage, o.error?.message])).toEqual([
      ['a', true, undefined, undefined],
      ['b', false, 'b', 'predicate: the preview never showed it'],
      ['c', false, 'b', 'not run: b failed (predicate: the preview never showed it)']
    ]);
    expect(out[0].metrics).toEqual({ 'a.n': { unit: 'count', value: 1 } });
  });

  it('fails only the scenario whose trace lacks a mark, and goes on', async () => {
    const out = await runChain([fake('a', { missing: ['launch.loadPacks'] }), fake('b')], ctx, trace, 1000);
    expect(out.map((o) => [o.scenario, o.ok, o.error?.message ?? null])).toEqual([
      ['a', false, 'missing from the trace: launch.loadPacks'],
      ['b', true, null]
    ]);
  });

  it('fails a scenario on a trace with a broken line, and one that runs past its deadline', async () => {
    const broken = await runChain([fake('a')], ctx, async () => new Trace([], true), 1000);
    expect(broken[0]).toMatchObject({ ok: false, error: { message: 'the trace has a line that could not be read' } });
    const slow = await runChain([fake('a', { run: () => new Promise(() => {}) }), fake('b')], ctx, trace, 20);
    expect(slow.map((o) => o.error?.message)).toEqual(['a did not finish within 0s', 'not run: a failed (a did not finish within 0s)']);
  });
});

describe('launch metrics', () => {
  it('time every milestone from the process being created', () => {
    const t = new Trace([
      m('launch.processStart', 1000),
      m('launch.mainLoaded', 1150),
      m('launch.appReady', 1200),
      span('main.stall', 1180, 60),
      span('launch.loadPacks', 1350, 140),
      m('launch.windowCreated', 1400, { c: { 'files.read': 40, 'files.hashed': 38 } }),
      m('launch.readyToShow', 1600),
      r('launch.firstRender', 1620),
      r('launch.firstInteractive', 1640),
      r('launch.recentsShown', 1660, { c: { 'react.commits': 5 } }),
      // After the window of the launch: not its stall.
      span('main.stall', 5000, 900)
    ]);
    const got = launch.measure(t, facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      'launch.mainLoaded': '150 ms',
      'launch.appReady': '200 ms',
      'launch.windowCreated': '400 ms',
      'launch.readyToShow': '600 ms',
      'launch.firstRender': '620 ms',
      'launch.firstInteractive': '640 ms',
      'launch.recentsShown': '660 ms',
      'launch.loadPacks': '140 ms',
      'launch.rendererCommits': '5 count',
      'launch.filesReadBeforeWindow': '40 count',
      'launch.filesHashedBeforeWindow': '38 count',
      'launch.mainStallMax': '60 ms'
    });
    for (const drop of ['launch.windowCreated', 'launch.readyToShow']) expect(launch.measure(new Trace(t.records.filter((x) => x.name !== drop)), facts).missing).toEqual([drop]);
  });
});

describe('open metrics', () => {
  const trace = (drop: (x: PerfRecord) => boolean = () => false) =>
    new Trace(
      [
        // An earlier open, before this scenario: never its request.
        r('open.requested', 100),
        r('scenario.start', 900, { attrs: { scenario: 'open' } }),
        m('scenario.start', 900, { attrs: { scenario: 'open' } }),
        r('open.requested', 1000, { c: { 'react.commits': 6 } }),
        span('session.open.lock', 1010, 5),
        span('session.open.recover', 1012, 1),
        span('session.open.read', 1030, 15),
        span('session.open.localState', 1032, 1),
        span('session.open.validate', 1050, 16),
        span('session.publish', 1600, 540, { dc: { 'files.read': 100, 'files.hashed': 200, 'fs.writes': 2 } }),
        span('session.open.sweep', 1602, 1),
        span('session.open', 1603, 600, { dc: { 'files.read': 170, 'files.hashed': 210, 'fs.durableWrites': 1, 'fs.fsyncs': 4 } }),
        span('controller.open', 1690, 680),
        m('controller.snapshotSent', 1700, { attrs: { revision: 0, bytes: 300 } }),
        span('controller.assetCheck', 1701, 1),
        span('controller.attach', 1705, 15, { dc: { 'files.read': 3, 'fs.durableWrites': 1, 'fs.fsyncs': 2 } }),
        r('renderer.commit', 1720, { attrs: { revision: null, screen: 'welcome' } }),
        r('renderer.commit', 1730, { attrs: { revision: 0, screen: 'editor' } }),
        m('runtime.forked', 1740),
        m('runtime.ready', 2000),
        span('controller.startRuntime', 2001, 290, { dc: { 'files.read': 4, 'files.hashed': 1 } }),
        m('controller.snapshotSent', 2002, { attrs: { revision: 0, bytes: 200 } }),
        // Not the home page ready to edit: Preview mode, a component preview, another page.
        r('canvas.ready', 2100, { attrs: { revision: 0, path: '/', mode: 'preview', studio: false } }),
        r('canvas.ready', 2200, { attrs: { revision: 0, path: '/', mode: 'edit', studio: true } }),
        r('canvas.ready', 2300, { attrs: { revision: 0, path: '/about/', mode: 'edit', studio: false } }),
        r('canvas.ready', 2500, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false }, c: { 'react.commits': 20 } }),
        // After the canvas was ready: counted as a reload, not as a snapshot of the open.
        m('controller.snapshotSent', 2600, { attrs: { revision: 0, bytes: 9999 } }),
        m('session.reloadFromDisk', 3000),
        m('scenario.end', 4000, { attrs: { scenario: 'open' } }),
        m('session.reloadFromDisk', 4500)
      ].filter((x) => !drop(x))
    );

  it('time the open from the click to the home page ready to edit', () => {
    const got = open.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect(v('open.canvasReady')).toBe(1500);
    expect([v('open.controller'), v('open.session'), v('open.publish'), v('open.attach'), v('open.startRuntime')]).toEqual([680, 600, 540, 15, 290]);
    expect([v('open.session.lock'), v('open.session.read'), v('open.session.validate'), v('open.session.sweep')]).toEqual([5, 15, 16, 1]);
    expect([v('open.firstSnapshotSent'), v('open.editorShown'), v('open.runtimeForked'), v('open.runtimeReady')]).toEqual([700, 730, 740, 1000]);
    expect([v('open.filesRead'), v('open.filesHashed'), v('open.durableWrites'), v('open.fsyncs')]).toEqual([177, 211, 2, 6]);
    expect([v('open.publishFilesRead'), v('open.publishFilesHashed'), v('open.publishFilesWritten')]).toEqual([100, 200, 2]);
    expect([v('open.snapshotsSent'), v('open.snapshotBytes'), v('open.reloadFromDisk'), v('open.rendererCommits')]).toEqual([2, 500, 1, 14]);
    expect(got.metrics['open.snapshotBytes'].unit).toBe('bytes');
  });

  it('name what is missing instead of timing another event', () => {
    expect(open.measure(trace((x) => x.name === 'canvas.ready' && x.t === 2500), facts).missing).toEqual(['canvas.ready']);
    expect(open.measure(trace((x) => x.name === 'canvas.ready' && x.t === 2500), facts).metrics['open.canvasReady']).toBeUndefined();
    expect(open.measure(trace((x) => x.name === 'scenario.end'), facts).missing).toEqual(['scenario.end (main)']);
    expect(open.measure(trace((x) => x.name === 'session.publish'), facts).missing).toEqual(['session.publish']);
  });
});

describe('edit metrics', () => {
  const base = 7;
  const target = 8;
  function trace(drop: (x: PerfRecord) => boolean = () => false) {
    return new Trace(
      [
        r('scenario.start', 9000, { attrs: { scenario: 'edit' }, c: { 'react.commits': 100 } }),
        m('scenario.start', 9000, { attrs: { scenario: 'edit' } }),
        r('edit.requested', 10_000, { attrs: { revision: base, operations: 1 }, c: { 'react.commits': 110 } }),
        // Another revision's records inside the window: never taken for this edit.
        r('canvas.revisionApplied', 10_002, { attrs: { revision: base } }),
        m('session.changed', 10_003, { attrs: { revision: base } }),
        m('controller.snapshotSent', 10_004, { attrs: { revision: base, bytes: 5 } }),
        span('controller.apply', 10_005, 4, { attrs: { revision: base }, dc: { 'fs.durableWrites': 99 } }),
        span('session.validateOperations', 10_010, 1),
        span('session.applyOperations', 10_012, 2),
        span('session.validateState', 10_020, 5),
        span('session.generate', 10_030, 4, { attrs: { variant: 'clean' } }),
        span('session.generate', 10_034, 3, { attrs: { variant: 'dev' } }),
        span('session.publish', 10_080, 30, { dc: { 'files.read': 1, 'files.hashed': 13, 'fs.writes': 5 } }),
        m('runtime.release', 10_082),
        span('session.persist', 10_100, 70),
        m('session.changed', 10_101, { attrs: { revision: target } }),
        m('controller.snapshotSent', 10_105, { attrs: { revision: target, bytes: 120_000 } }),
        span('session.apply', 10_106, 95, { attrs: { revision: target } }),
        span('controller.apply', 10_107, 105, { attrs: { revision: target }, dc: { 'fs.durableWrites': 9, 'fs.fsyncs': 19, 'fs.writes': 11 } }),
        r('renderer.snapshotReceived', 10_108, { attrs: { revision: target } }),
        m('runtime.published', 10_110, { attrs: { revision: target } }),
        r('renderer.commit', 10_115, { attrs: { revision: target } }),
        span('main.stall', 10_120, 70),
        r('canvas.revisionApplied', 10_140, { attrs: { revision: target } }),
        m('session.reloadFromDisk', 10_500),
        m('controller.snapshotSent', 10_600, { attrs: { revision: target, bytes: 1000 } }),
        m('scenario.end', 11_640, { attrs: { scenario: 'edit' } }),
        r('scenario.end', 11_641, { attrs: { scenario: 'edit' }, c: { 'react.commits': 160 } }),
        // After the scenario: none of its counts.
        m('session.reloadFromDisk', 12_000),
        m('controller.snapshotSent', 12_001, { attrs: { revision: target, bytes: 7 } }),
        span('main.stall', 12_002, 900)
      ].filter((x) => !drop(x))
    );
  }

  it('time an edit from the editor sending it, by the revision it made', () => {
    const got = edit.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      'edit.apply': '105 ms',
      'edit.sessionApply': '95 ms',
      'edit.validateOperations': '1 ms',
      'edit.applyOperations': '2 ms',
      'edit.validate': '5 ms',
      'edit.generate': '7 ms',
      'edit.persist': '70 ms',
      'edit.publish': '30 ms',
      'edit.hmrRelease': '82 ms',
      'edit.changed': '101 ms',
      'edit.snapshotSent': '105 ms',
      'edit.snapshotReceived': '108 ms',
      'edit.rendererCommit': '115 ms',
      'edit.previewPublished': '110 ms',
      'edit.previewApplied': '140 ms',
      'edit.durableWrites': '9 count',
      'edit.fsyncs': '19 count',
      'edit.fileWrites': '11 count',
      'edit.publishFilesRead': '1 count',
      'edit.publishFilesHashed': '13 count',
      'edit.publishFilesWritten': '5 count',
      'edit.snapshotsSent': '3 count',
      'edit.snapshotBytes': '121005 bytes',
      'edit.reloadFromDisk': '1 count',
      'edit.rendererCommits': '50 count',
      'edit.mainStallMax': '70 ms'
    });
  });

  it('name a mark that is missing instead of reporting a time without it', () => {
    const without = (name: string, rev = target) => edit.measure(trace((x) => x.name === name && (x.attrs?.revision === rev || x.attrs?.revision === undefined)), facts);
    // The other revision's acknowledgement is there, but is not this edit's.
    expect(without('canvas.revisionApplied').missing).toEqual(['canvas.revisionApplied']);
    expect(without('canvas.revisionApplied').metrics['edit.previewApplied']).toBeUndefined();
    expect(without('session.changed').missing).toEqual(['session.changed']);
    // A sum of one variant would look faster than it is.
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'clean'), facts).missing).toEqual(['session.generate (clean)']);
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'clean'), facts).metrics['edit.generate']).toBeUndefined();
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'dev'), facts).missing).toEqual(['session.generate (dev)']);
  });

  it('count every generation of each variant, and refuse one without a length', () => {
    const twice = new Trace([...trace().records, span('session.generate', 10_036, 2, { attrs: { variant: 'dev' } })]);
    expect(edit.measure(twice, facts).metrics['edit.generate'].value).toBe(9);
    const lengthless = new Trace(trace().records.map((x) => (x.name === 'session.generate' && x.attrs?.variant === 'dev' ? { ...x, kind: 'mark' as const, ms: undefined } : x)));
    expect(edit.measure(lengthless, facts).missing).toEqual(['edit.generate (a finite time)']);
  });

  it('leave React commits missing when the editor could not count them, never a false zero', () => {
    const uncounted = new Trace([...trace().records, r('perf.reactCommitsUncounted', 100)]);
    const got = edit.measure(uncounted, facts);
    expect(got.missing).toEqual(['edit.rendererCommits (the editor could not count React commits)']);
    expect(got.metrics['edit.rendererCommits']).toBeUndefined();
  });

  it('leave the bytes sent missing when a snapshot’s size could not be told, never short', () => {
    const unsized = new Trace(trace().records.map((x) => (x.name === 'controller.snapshotSent' && x.t === 10_600 ? { ...x, attrs: { revision: target, bytes: null } } : x)));
    const got = edit.measure(unsized, facts);
    expect(got.missing).toEqual(['edit.snapshotBytes (a snapshot whose size could not be told)']);
    expect(got.metrics['edit.snapshotBytes']).toBeUndefined();
    expect(got.metrics['edit.snapshotsSent'].value).toBe(3);
  });
});

describe('panels metrics', () => {
  const base = 4;
  const target = 5;
  /** The editor's counters at a mark: React's, and each panel's renders and render time, scaled by `k`. */
  const counters = (commits: number, renders: number, k: number, drop?: string): Record<string, number> => {
    const c: Record<string, number> = { 'react.commits': commits, 'react.renders': renders };
    PANELS.forEach((id, i) => {
      if (id === drop) return;
      c[`panel.${id}.renders`] = k * (i + 1);
      c[`panel.${id}.renderMs`] = k * (i + 1) * 0.5;
    });
    return c;
  };
  const phase = (name: string) => ({ attrs: { scenario: 'panels', phase: name } });
  function trace(drop: (x: PerfRecord) => boolean = () => false, unmounted?: string) {
    return new Trace(
      [
        // Before the scenario: a selection commit, never the click's.
        r('renderer.selectionCommit', 4000, { attrs: { selected: true } }),
        r('scenario.start', 5000, { attrs: { scenario: 'panels' }, c: counters(100, 1000, 1, unmounted) }),
        m('scenario.start', 5000, { attrs: { scenario: 'panels' } }),
        r('canvas.select', 5100),
        // The selection cleared on the way to the new one: not the commit that shows it.
        r('renderer.selectionCommit', 5104, { attrs: { selected: false } }),
        r('renderer.selectionCommit', 5130, { attrs: { selected: true } }),
        r('scenario.phase', 7000, { ...phase('clicked'), c: counters(110, 1600, 3) }),
        m('scenario.phase', 7000, phase('clicked')),
        // Showing the Inspector, between the windows: in neither.
        r('renderer.selectionCommit', 7100, { attrs: { selected: true } }),
        r('scenario.phase', 8000, { ...phase('edit'), c: counters(130, 2000, 10) }),
        m('scenario.phase', 8000, phase('edit')),
        r('edit.requested', 8200, { attrs: { revision: base, operations: 1 } }),
        // Another revision's records: never this edit's.
        r('renderer.snapshotReceived', 8201, { attrs: { revision: base } }),
        r('renderer.commit', 8202, { attrs: { revision: base } }),
        r('renderer.snapshotReceived', 8300, { attrs: { revision: target } }),
        r('renderer.commit', 8345, { attrs: { revision: target } }),
        r('scenario.end', 9000, { attrs: { scenario: 'panels' }, c: counters(145, 3000, 14) }),
        m('scenario.end', 9000, { attrs: { scenario: 'panels' } })
      ].filter((x) => !drop(x))
    );
  }

  it('time the click and the edit to their commits, and each panel’s renders in each window', () => {
    const got = panels.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect([v('panels.click.commit'), v('panels.edit.commit'), v('panels.edit.rendererCommit')]).toEqual([30, 45, 145]);
    expect([v('panels.click.rendererCommits'), v('panels.edit.rendererCommits'), v('panels.click.renders'), v('panels.edit.renders')]).toEqual([10, 15, 600, 1000]);
    // Each panel gained (k₂ − k₁)·(its place) renders, and half that in ms; nothing between the windows is counted.
    PANELS.forEach((id, i) => {
      expect(v(`panels.click.renders.${id}`)).toBe(2 * (i + 1));
      expect(v(`panels.click.renderMs.${id}`)).toBe(i + 1);
      expect(v(`panels.edit.renders.${id}`)).toBe(4 * (i + 1));
      expect(got.metrics[`panels.edit.renderMs.${id}`].unit).toBe('ms');
    });
    // The hidden panels are every one but the window's shown one: Project for the click, the Inspector for the edit.
    const all = PANELS.reduce((n, _, i) => n + i + 1, 0);
    const place = (id: string) => PANELS.indexOf(id as (typeof PANELS)[number]) + 1;
    expect([v('panels.click.hiddenRenders'), v('panels.click.hiddenRenderMs')]).toEqual([2 * (all - place(SHOWN_PANELS.click)), all - place(SHOWN_PANELS.click)]);
    expect(v('panels.edit.hiddenRenders')).toBe(4 * (all - place(SHOWN_PANELS.edit)));
  });

  it('name what is missing, and never count a panel the editor never had as doing nothing', () => {
    // The selection's commit is looked for only after the click: without the click there is neither.
    expect(panels.measure(trace((x) => x.name === 'canvas.select'), facts).missing).toEqual(['canvas.select', 'renderer.selectionCommit']);
    expect(panels.measure(trace((x) => x.name === 'renderer.selectionCommit' && x.t === 5130), facts).missing).toEqual(['renderer.selectionCommit']);
    expect(panels.measure(trace((x) => x.name === 'renderer.commit' && x.attrs?.revision === target), facts).missing).toEqual(['renderer.commit']);
    expect(panels.measure(trace((x) => x.name === 'scenario.phase' && x.attrs?.phase === 'edit'), facts).missing).toContain('scenario.phase edit (renderer)');
    const gone = panels.measure(trace(undefined, 'insert'), facts);
    expect(gone.missing).toEqual(['panels.click (the insert panel was not mounted)']);
    expect(gone.metrics['panels.click.renders.insert']).toBeUndefined();
    const uncounted = new Trace(trace().records.map((x) => (x.name === 'scenario.start' && x.proc === 'renderer' ? { ...x, c: { 'react.commits': 100 } } : x)));
    expect(panels.measure(uncounted, facts).missing).toEqual(['panels.click (the editor did not count component renders)']);
  });
});

describe('chat metrics', () => {
  /**
   * One case's window: typing (a span per key, each `keyMs` long in turn), then a reply streamed (an event span each),
   * with the counters each process carries on its marks, and a decoy of each span just outside the window.
   */
  function chatCase(key: string, at: number, o: { keyMs?: number[]; keys?: number; events?: number[]; sent?: number; renders?: [number, number, number, number]; bytes?: [number, number] } = {}): PerfRecord[] {
    const [k0, k1, s0, s1] = o.renders ?? [0, 98, 98, 200];
    const c = (commits: number, renders: number) => ({ c: { 'react.commits': commits, 'chat.messageRenders': renders, 'chat.textParses': Math.floor(renders / 2) } });
    const [b0, b1] = o.bytes ?? [1000, 9000];
    const keyMs = o.keyMs ?? [0.5, 0.7, 0.6];
    const keys = o.keys ?? CHAT_TYPED.length;
    const events = o.events ?? [1.5, 2.5, 2];
    const sent = o.sent ?? events.length;
    return [
      r('chat.keystroke', at - 1, { kind: 'span', ms: 50, attrs: { commits: 1 } }),
      r('chat.typeStart', at, { attrs: { at: key }, ...c(10, k0) }),
      ...Array.from({ length: keys }, (_, i) => r('chat.keystroke', at + 1 + i * 0.1, { kind: 'span', ms: keyMs[i % keyMs.length], attrs: { commits: 1 } })),
      r('chat.typeEnd', at + 10, { attrs: { at: key }, ...c(13, k1) }),
      m('chat.streamStart', at + 11, { attrs: { at: key }, c: { 'ipc.aiEvent.sends': 5, 'ipc.aiEvent.bytes': b0 } }),
      r('chat.streamStart', at + 11.5, { attrs: { at: key }, ...c(13, s0) }),
      ...events.map((ms, i) => r('chat.aiEvent', at + 20 + i * 10, { kind: 'span', ms, attrs: { kind: 'text', commits: 1 } })),
      m('chat.streamEnd', at + 90, { attrs: { at: key }, c: { 'ipc.aiEvent.sends': 5 + sent, 'ipc.aiEvent.bytes': b1 } }),
      r('chat.streamEnd', at + 90.5, { attrs: { at: key }, ...c(13 + events.length, s1) }),
      r('chat.aiEvent', at + 91, { kind: 'span', ms: 50, attrs: { kind: 'status', commits: 1 } })
    ];
  }
  const both = () => [...chatCase('at6', 1000, { renders: [0, 4, 4, 20], events: [1, 3] }), ...chatCase('at100', 2000, { keyMs: [1, 2, 3, 4], bytes: [9000, 40_000] })];

  it('report each conversation’s keystrokes and streamed events, by its own marks', () => {
    const got = chat.measure(new Trace(both()), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('chat.at6.keystrokes'), v('chat.at6.keyMs'), v('chat.at6.keyCommits'), v('chat.at6.keyMessageRenders')]).toEqual([66, 0.6, 3, 4]);
    expect([v('chat.at100.keystrokes'), v('chat.at100.keyMs'), v('chat.at100.keyMessageRenders'), v('chat.at100.keyTextParses')]).toEqual([66, 2, 98, 49]);
    expect([v('chat.at6.events'), v('chat.at6.eventsHandled'), v('chat.at6.eventMs'), v('chat.at6.eventMsTotal'), v('chat.at6.replyMs')]).toEqual([2, 2, 2, 4, 1030 - 1011.5]);
    expect([v('chat.at100.events'), v('chat.at100.eventsHandled'), v('chat.at100.eventMs'), v('chat.at100.eventMsTotal'), v('chat.at100.replyMs')]).toEqual([3, 3, 2, 6, 2040 - 2011.5]);
    expect([v('chat.at100.streamCommits'), v('chat.at100.streamMessageRenders'), v('chat.at100.streamTextParses')]).toEqual([3, 102, 100 - 49]);
    expect(got.metrics['chat.at100.eventBytes']).toEqual({ unit: 'bytes', value: 31_000 });
    expect(got.metrics['chat.at6.eventBytes']).toEqual({ unit: 'bytes', value: 8000 });
  });

  it('take the longest main-process stall inside each reply only', () => {
    const stall = (t: number, ms: number) => m('main.stall', t, { kind: 'span', ms });
    const got = chat.measure(new Trace([...both(), stall(1050, 70), stall(2050, 90), stall(1500, 400)]), facts);
    expect([got.metrics['chat.at6.mainStallMax'].value, got.metrics['chat.at100.mainStallMax'].value]).toEqual([70, 90]);
  });

  it('name a conversation whose marks or spans are missing or short instead of reporting less work', () => {
    const got = chat.measure(new Trace([...chatCase('at6', 1000, { keys: 0 }), ...chatCase('at100', 2000, { events: [] })]), facts);
    expect(got.missing).toEqual(['chat.keystroke spans (at6: 0 of 66)', 'chat.aiEvent spans (at100: 0 of 0 sent)']);
    expect(got.metrics['chat.at6.keyMs']).toBeUndefined();
    // A trace that lost one key's span, or one event's, is not a faster run.
    const short = chat.measure(new Trace([...chatCase('at6', 1000, { keys: 65 }), ...chatCase('at100', 2000, { sent: 4 })]), facts);
    expect(short.missing).toEqual(['chat.keystroke spans (at6: 65 of 66)', 'chat.aiEvent spans (at100: 3 of 4 sent)']);
    const half = chat.measure(new Trace(chatCase('at6', 1000)), facts);
    expect(half.missing).toContain('chat.typeStart (at100, renderer)');
    expect(half.missing).toContain('chat.streamEnd (at100, main)');
  });

  it('leave the bytes sent missing when an event’s size could not be told, never short', () => {
    const records = both().map((x) => (x.name === 'chat.streamEnd' && x.proc === 'main' && x.attrs?.at === 'at6' ? { ...x, c: { ...x.c, 'ipc.aiEvent.unsized': 1 } } : x));
    const got = chat.measure(new Trace(records), facts);
    expect(got.missing).toEqual(['chat.at6.eventBytes (an event whose size could not be told)']);
  });

  it('seed each conversation with the earlier turns its log holds, and stream a reply that starts and ends as checked', () => {
    for (const c of CHAT_CASES) {
      const seeded = chatSeed(c, facts);
      expect(seeded.id).toBe(c.id);
      expect(seeded.messages).toHaveLength(c.earlier);
      expect(seeded.messages.map((x) => x.role)).toEqual(Array.from({ length: c.earlier }, (_, i) => (i % 2 ? 'assistant' : 'user')));
      expect(new Set(seeded.messages.map((x) => x.id)).size).toBe(c.earlier);
      const reply = chatReply(c.key);
      expect(reply.startsWith(chatReplyFirst(c.key))).toBe(true);
      expect(reply.endsWith(chatReplyLast(c.key))).toBe(true);
      expect(reply.length).toBeGreaterThan(2000);
      // Each checkpoint in order, after the first sentence and well before the last.
      const at = CHAT_REPLY_CHECKPOINTS.map((p) => reply.indexOf(p));
      expect(at.every((x, i) => x > (i ? at[i - 1] : chatReplyFirst(c.key).length) && x < reply.length - 200)).toBe(true);
      // Asked and answered, then edited: both kinds of turn, as stored ones are.
      expect(new Set(seeded.messages.filter((x) => x.role === 'assistant').map((x) => x.result?.status))).toEqual(new Set(c.earlier > 2 ? ['no-changes', 'completed'] : ['no-changes']));
      // Real Markdown: a list, a table and emphasis.
      expect(reply).toMatch(/^1\. \*\*/m);
      expect(reply).toMatch(/^\| --- \|/m);
    }
    expect(CHAT_CASES.map((c) => c.earlier + 2)).toEqual([6, 100]);
  });
});

describe('fixture facts', () => {
  it('find the first placement with a heading, or the one with an ID', () => {
    const page = { nodes: [{ id: 'a', props: { title: 'x' } }, { id: 'b', props: { heading: 'First' }, children: [{ id: 'c', props: { heading: 'Inner' } }] }, { id: 'd', props: { heading: 'Later' } }] };
    expect(findHeading(page)).toEqual({ id: 'b', heading: 'First' });
    expect(findHeading(page, 'd')).toEqual({ id: 'd', heading: 'Later' });
    expect(findHeading(page, 'zz')).toBeNull();
  });
});
