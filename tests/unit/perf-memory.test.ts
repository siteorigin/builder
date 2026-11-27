import { describe, expect, it } from 'vitest';
import { attribute, byRole, complete, electronRole, electronSource, growthMetrics, MEMORY_PROTOCOL, memorySource, mergeFacts, MemoryProbe, parseFootprints, parseMemoryTable, withFootprints, readingMetrics, startedMs, utilityRole, type AppFacts, type Clock, type MemoryReading, type MemoryRow, type MemorySource, type PeakHow, type RestHow } from '../../scripts/perf/memory';
import { Collector } from '../../scripts/perf/results';

const MiB = 2 ** 20;
const APP = '/apps/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder';
const HELPER = '/apps/SiteOrigin Builder.app/Contents/Frameworks/SiteOrigin Builder Helper.app/Contents/MacOS/SiteOrigin Builder Helper';
const row = (pid: number, ppid: number, mib: number, command = HELPER, started = `t${pid}`): MemoryRow => ({ pid, ppid, pgid: 1, bytes: mib * MiB, started, command });

/** An app with a project open: main 1, editor 2, preview 3, gpu 4, network 5, dev server 6 (and its esbuild 10), two
 *  media workers 7 and 8, the thumbnails' window 9, and npm run by the app's own executable 11. */
const facts: AppFacts = {
  main: 1,
  editor: 2,
  preview: 3,
  windows: [{ pid: 9, focusable: false }],
  processes: [
    { pid: 1, type: 'Browser', label: null },
    { pid: 2, type: 'Tab', label: null },
    { pid: 3, type: 'Tab', label: null },
    { pid: 4, type: 'GPU', label: 'GPU' },
    { pid: 5, type: 'Utility', label: 'network.mojom.NetworkService' },
    { pid: 6, type: 'Utility', label: 'SiteOrigin project runtime' },
    { pid: 7, type: 'Utility', label: 'SiteOrigin media' },
    { pid: 8, type: 'Utility', label: 'SiteOrigin media' },
    { pid: 9, type: 'Tab', label: null }
  ]
};
const rows: MemoryRow[] = [row(1, 0, 190, APP), row(2, 1, 150), row(3, 1, 170), row(4, 1, 100), row(5, 1, 40), row(6, 1, 440), row(7, 1, 70), row(8, 1, 60), row(9, 1, 80), row(10, 6, 30, '/p/node_modules/@esbuild/darwin-arm64/bin/esbuild'), row(11, 1, 90, APP)];
const known = (f: AppFacts, r: MemoryRow[] = rows) => mergeFacts([{ facts: f, rows: r }]);
const roles = (r: MemoryRow[], f = known(facts, r), remembered?: Map<string, string>) => attribute(r, f, remembered).map((p) => p.role);

describe('the process table with memory', () => {
  it('read RSS in KiB as bytes, a start time of five words, and an executable with spaces, on macOS and Linux', () => {
    const text = [
      '  101     1   101 194560 Wed Nov 26 20:41:00 2026 /apps/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder',
      '  102   101   101  83200 Thu Nov  6 09:01:02 2026 /apps/X.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)',
      '  103   101   101      0 Thu Nov  6 09:01:02 2026 esbuild',
      'garbage line',
      '  104   101   101      - Thu Nov  6 09:01:02 2026 zombie'
    ].join('\n');
    expect(parseMemoryTable(text, 'darwin')).toEqual([
      { pid: 101, ppid: 1, pgid: 101, bytes: 194560 * 1024, started: 'Wed Nov 26 20:41:00 2026', command: '/apps/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder' },
      { pid: 102, ppid: 101, pgid: 101, bytes: 83200 * 1024, started: 'Thu Nov 6 09:01:02 2026', command: '/apps/X.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)' },
      { pid: 103, ppid: 101, pgid: 101, bytes: 0, started: 'Thu Nov 6 09:01:02 2026', command: 'esbuild' }
    ]);
    // Linux's comm is a short name; the columns are the same.
    expect(parseMemoryTable('  7 1 7 2048 Mon Jan  5 10:00:00 2026 npm ci\n', 'linux')).toEqual([{ pid: 7, ppid: 1, pgid: 7, bytes: 2048 * 1024, started: 'Mon Jan 5 10:00:00 2026', command: 'npm ci' }]);
  });

  it('read each process’s footprint from top on macOS, in place of its RSS, keeping one top did not list as unknown', () => {
    const top = ['Processes: 392 total', 'PhysMem: 34G used (3041M wired, 11G compressor), 1944M unused.', '', 'PID    MEM', '101    735M+', '102    3248K', '103    0B', '104    12G', '105    1.5M-', '106*   12M', '107-   2M'].join('\n');
    const footprints = parseFootprints(top);
    expect([...footprints]).toEqual([
      [101, 735 * MiB],
      [102, 3248 * 1024],
      [103, 0],
      [104, 12 * 2 ** 30],
      [105, 1.5 * MiB],
      [106, 12 * MiB],
      [107, 2 * MiB]
    ]);
    // 108 started between ps and top: it stays in the table (who is whose), with no figure, and its sample is incomplete.
    // 109 is a zombie (no RSS, not among top's tasks): it holds nothing.
    const rows = [row(101, 1, 200), row(102, 101, 5), row(108, 101, 9), row(109, 101, 0)];
    const read = withFootprints(rows, footprints);
    expect(read.map((r) => [r.pid, r.bytes])).toEqual([
      [101, 735 * MiB],
      [102, 3248 * 1024],
      [108, NaN],
      [109, 0]
    ]);
    expect([complete(read), complete(read.slice(0, 2)), complete([])]).toEqual([false, true, false]);
    expect(['darwin', 'linux', 'win32'].map((p) => memorySource(p as NodeJS.Platform))).toEqual(['top footprint', 'ps rss', 'CIM WorkingSetSize']);
  });

  it('read the working set in bytes and no group on Windows, skipping a row without its start', () => {
    expect(parseMemoryTable('4 0 1024 638000000000000000 System\r\n2200 2100 199229440 638123456789012345 SiteOrigin Builder.exe\r\n2300 2200 1024  \r\n', 'win32')).toEqual([
      { pid: 4, ppid: 0, bytes: 1024, started: '638000000000000000', command: 'System' },
      { pid: 2200, ppid: 2100, bytes: 199229440, started: '638123456789012345', command: 'SiteOrigin Builder.exe' }
    ]);
  });
});

describe('process roles', () => {
  it('name the app’s helpers by what they are and Chromium’s by their service', () => {
    expect(['SiteOrigin project runtime', 'SiteOrigin project build', 'SiteOrigin media', 'SiteOrigin import reader', 'SiteOrigin source sync', 'SiteOrigin font check'].map(utilityRole)).toEqual(['devServer', 'projectBuild', 'media', 'importReader', 'sourceSync', 'fontCheck']);
    expect(['network.mojom.NetworkService', 'storage.mojom.StorageService', 'data_decoder.mojom.DataDecoderService', 'Video Capture', null].map(utilityRole)).toEqual(['network', 'storage', 'dataDecoder', 'videoCapture', 'utility']);
    expect(['Browser', 'GPU', 'Tab', 'Zygote', 'Sandbox helper', 'Pepper Plugin'].map((type) => electronRole({ type, label: null }))).toEqual(['main', 'gpu', 'renderer', 'zygote', 'sandboxHelper', 'pepperPlugin']);
  });

  it('give every process a role, never a pid, and keep two workers of one role as two processes', () => {
    const got = attribute(rows, known(facts));
    expect(got.map((p) => [p.role, p.bytes / MiB])).toEqual([
      ['devServer', 440],
      ['devServer.esbuild', 30],
      ['editor', 150],
      ['gpu', 100],
      ['main', 190],
      ['main.unlisted', 90],
      ['media', 70],
      ['media', 60],
      ['network', 40],
      ['preview', 170],
      ['thumbnails', 80]
    ]);
    expect(byRole(got).media).toEqual({ processes: 2, bytes: 130 * MiB });
    expect(byRole(got).main).toEqual({ processes: 1, bytes: 190 * MiB });
    // A window that can take focus is not the thumbnails' hidden one.
    expect(roles(rows, known({ ...facts, windows: [{ pid: 9, focusable: true }] }))).toContain('window');
  });

  it('keep calling the preview’s renderer the preview once its frame has gone, and name an orphaned child by what it ran under', () => {
    const remembered = new Map<string, string>();
    attribute(rows, known(facts), remembered);
    // The project closed: no frame and no dev server; esbuild was left behind with a parent the table no longer has.
    const closed = { ...facts, preview: null, windows: [], processes: facts.processes.filter((p) => p.pid <= 5) };
    const later = [row(1, 0, 190, APP), row(2, 1, 150), row(3, 1, 120), row(10, 6, 30, 'esbuild')];
    expect(roles(later, known(closed, later), remembered)).toEqual(['devServer.esbuild', 'editor', 'main', 'preview']);
    // Never seen as anything: a renderer, and an orphan.
    const fresh = [row(1, 0, 1, APP), row(12, 1, 1), row(13, 99, 1, 'esbuild')];
    expect(roles(fresh, known({ ...closed, processes: [...closed.processes, { pid: 12, type: 'Tab', label: null }] }, fresh))).toEqual(['main', 'orphan.esbuild', 'renderer']);
  });

  it('count a preview that shares the editor’s process once, as the editor', () => {
    const two = [row(1, 0, 190, APP), row(2, 1, 150)];
    expect(attribute(two, known({ ...facts, preview: 2 }, two))).toEqual([
      { role: 'editor', bytes: 150 * MiB, pid: 2 },
      { role: 'main', bytes: 190 * MiB, pid: 1 }
    ]);
  });

  it('tell when a process started, from ps and from Windows ticks', () => {
    expect(startedMs({ pid: 1, ppid: 0, started: 'Wed Nov 26 20:41:00 2026' })).toBe(new Date(2026, 10, 26, 20, 41, 0).getTime());
    // Windows gives UTC ticks (100 ns since 0001), whatever the clocks did meanwhile.
    const at = Date.UTC(2026, 10, 26, 18, 41, 0, 123);
    expect(startedMs({ pid: 1, ppid: 0, started: String(621355968000000000n + BigInt(at) * 10000n) })).toBe(at);
    expect([startedMs({ pid: 1, ppid: 0 }), startedMs({ pid: 1, ppid: 0, started: 'soon' })]).toEqual([null, null]);
  });

  it('leave out what the app says of a pid whose process started at another time than Electron created it', () => {
    const started = 'Wed Nov 26 20:41:00 2026';
    const at = new Date(2026, 10, 26, 20, 41, 0).getTime();
    const two = [row(1, 0, 190, APP, started), row(7, 1, 70, HELPER, started)];
    const media = (created: number) => ({ ...facts, editor: null, preview: null, windows: [], processes: [{ pid: 1, type: 'Browser', label: null }, { pid: 7, type: 'Utility', label: 'SiteOrigin media', created }] });
    // ps gives whole seconds: a creation within them is the same process.
    expect(roles(two, mergeFacts([{ facts: media(at + 900), rows: two }]))).toEqual(['main', 'media']);
    // A worker created a minute later is another process that the pid now names.
    expect(roles(two, mergeFacts([{ facts: media(at + 60_000), rows: two }]))).toEqual(['main', 'main.siteoriginBuilderHelper']);
    // The pid's old process and its replacement were both sampled before the answer came: it goes to the one it
    // describes, or, when both started within the time ps gives starts to, to neither.
    const old = row(7, 1, 70, HELPER, started);
    const next = row(7, 1, 20, HELPER, 'Wed Nov 26 20:41:05 2026');
    const near = row(7, 1, 20, HELPER, 'Wed Nov 26 20:41:01 2026');
    const main = row(1, 0, 190, APP, started);
    const answered = (created: number, sampled: MemoryRow[]) => mergeFacts([{ facts: media(created), rows: [main, ...sampled] }]);
    const roleOf = (r: MemoryRow, f: ReturnType<typeof mergeFacts>) => attribute([main, r], f).find((p) => p.pid === 7)!.role;
    expect([roleOf(old, answered(at + 900, [old, next])), roleOf(next, answered(at + 900, [old, next]))]).toEqual(['media', 'main.siteoriginBuilderHelper']);
    expect([roleOf(old, answered(at + 5000, [old, next])), roleOf(next, answered(at + 5000, [old, next]))]).toEqual(['main.siteoriginBuilderHelper', 'media']);
    expect([roleOf(old, answered(at + 900, [old, near])), roleOf(near, answered(at + 900, [old, near]))]).toEqual(['main.siteoriginBuilderHelper', 'main.siteoriginBuilderHelper']);
  });

  it('start no further call to the app once the probe is closed while a collection is under way', async () => {
    const calls: string[] = [];
    let mainGc!: () => void;
    const app = {
      evaluate: (fn: unknown, arg?: unknown) => {
        calls.push(typeof arg === 'number' ? `main gc ×${arg}` : 'evaluate');
        return typeof arg === 'number' ? new Promise<void>((r) => (mainGc = r)) : Promise.resolve(null);
      }
    };
    const win = {
      isClosed: () => false,
      url: () => 'app://editor/index.html',
      evaluate: async () => (calls.push('frame name'), 'so-1'),
      frames: () => [],
      mainFrame: () => null,
      context: () => ({ newCDPSession: async () => (calls.push('cdp'), { send: async () => ({}), detach: async () => undefined }) })
    };
    const source = electronSource(app as never, () => win as never);
    const stop = new AbortController();
    const collecting = source.collect(2, stop.signal);
    stop.abort();
    mainGc();
    await expect(collecting).rejects.toThrow('the memory probe was closed');
    // Each pass in the main process is its own call: not even the second one starts.
    expect(calls).toEqual(['main gc ×1']);
    // Nor the facts once the preview's name is in, nor the heap once its session is open.
    calls.length = 0;
    const late = new AbortController();
    win.evaluate = async () => (late.abort(), calls.push('frame name'), 'so-1');
    await expect(source.facts(late.signal)).rejects.toThrow('the memory probe was closed');
    const heap = new AbortController();
    win.context = () => ({ newCDPSession: async () => (heap.abort(), calls.push('cdp'), { send: async () => (calls.push('send'), {}), detach: async () => void calls.push('detach') }) });
    await expect(source.heap(heap.signal)).rejects.toThrow('the memory probe was closed');
    expect(calls).toEqual(['frame name', 'evaluate', 'cdp', 'detach']);
  });

  it('read the main process alone while the editor has no window, and the editor again in the window that replaces it', async () => {
    const calls: string[] = [];
    const app = {
      evaluate: async (_fn: unknown, arg?: unknown) => {
        if (typeof arg === 'number') return void calls.push('main gc');
        if (arg && typeof arg === 'object') return (calls.push(`facts for ${(arg as { editorUrl: string }).editorUrl || 'no editor'}`), { main: 1, editor: null, preview: null, windows: [], processes: [] });
        return (calls.push('main heap'), 40);
      }
    };
    const page = (closed: boolean) => ({
      isClosed: () => closed,
      url: () => 'app://editor/index.html#/',
      evaluate: async () => (calls.push('frame name'), null),
      frames: () => [],
      mainFrame: () => null,
      context: () => ({ newCDPSession: async () => (calls.push('cdp'), { send: async () => ({ usedSize: 30 }), detach: async () => undefined }) })
    });
    let win = page(false);
    const source = electronSource(app as never, () => win as never);
    await source.facts();
    // Closed: no call reaches its page, and the main process is still asked about the editor at the address it had.
    win = page(true);
    calls.length = 0;
    await source.facts();
    expect(await source.collect(2)).toEqual(['main']);
    expect(await source.heap()).toEqual({ main: 40 });
    expect(calls).toEqual(['facts for app://editor/index.html', 'main gc', 'main gc', 'main heap']);
    // A window brought up again is the editor, collected and read as before.
    win = page(false);
    calls.length = 0;
    expect(await source.collect(1)).toEqual(['main', 'editor']);
    expect(await source.heap()).toEqual({ main: 40, editor: 30 });
    expect(calls).toEqual(['main gc', 'cdp', 'frame name', 'main heap', 'cdp']);
  });

  it('never give a process the role of an earlier one that had its pid', () => {
    // pid 7 was a media worker; later the OS gave it to a helper (another start time) the app has not described yet.
    const before = [row(1, 0, 190, APP), row(7, 1, 70)];
    const after = [row(1, 0, 190, APP), row(7, 1, 20, HELPER, 'later')];
    const merged = mergeFacts([
      { facts: { ...facts, editor: null, preview: null, windows: [] }, rows: before },
      { facts: { ...facts, editor: null, preview: null, windows: [], processes: [{ pid: 1, type: 'Browser', label: null }] }, rows: after }
    ]);
    expect(attribute(after, merged).map((p) => p.role)).toEqual(['main', 'main.siteoriginBuilderHelper']);
    expect(attribute(before, merged).map((p) => p.role)).toEqual(['main', 'media']);
  });
});

const reading = (label: string, roleMiB: Record<string, [number, number]>, heap?: [number, number], kind: 'rest' | 'peak' = 'rest'): MemoryReading => {
  const r = Object.fromEntries(Object.entries(roleMiB).map(([k, [n, mib]]) => [k, { processes: n, bytes: mib * MiB }]));
  return {
    label,
    kind,
    at: 0,
    processes: [],
    roles: r,
    total: Object.values(r).reduce((n, x) => n + x.bytes, 0),
    count: Object.values(r).reduce((n, x) => n + x.processes, 0),
    ...(heap ? { heap: { main: heap[0] * MiB, editor: heap[1] * MiB } } : {}),
    how: { source: 'ps rss', protocol: 1, periodMs: 200, samples: 3, maxGapMs: 210, durationMs: 400, incomplete: 0 }
  };
};
const values = (m: Collector) => Object.fromEntries(Object.entries(m.metrics).map(([k, v]) => [k, `${v.unit === 'memory' ? v.value / MiB : v.value} ${v.unit}`]));

describe('memory metrics', () => {
  it('report a reading’s total, count, each role and the heaps, a peak under its own name, and a missing reading as missing', () => {
    const m = new Collector();
    readingMetrics(m, 'canvas', reading('canvas', { main: [1, 190], media: [2, 130] }, [30, 20]));
    readingMetrics(m, 'open', reading('open', { main: [1, 250], media: [2, 150] }, undefined, 'peak'));
    readingMetrics(m, 'closed', undefined);
    expect(values(m)).toEqual({
      'memory.canvas.total': '320 memory',
      'memory.canvas.processes': '3 count',
      'memory.canvas.mem.main': '190 memory',
      'memory.canvas.processes.main': '1 count',
      'memory.canvas.mem.media': '130 memory',
      'memory.canvas.processes.media': '2 count',
      'memory.canvas.heap.main': '30 memory',
      'memory.canvas.heap.editor': '20 memory',
      'memory.open.peak.total': '400 memory',
      'memory.open.peak.processes': '3 count',
      'memory.open.peak.mem.main': '250 memory',
      'memory.open.peak.processes.main': '1 count',
      'memory.open.peak.mem.media': '150 memory',
      'memory.open.peak.processes.media': '2 count'
    });
    expect(m.missing).toEqual(['memory reading closed']);
    // With no editor window there is no editor heap: the reading has the main process's alone, and so does growth to it.
    const none = new Collector();
    const noWindow = { ...reading('noWindow', { main: [1, 200] }), heap: { main: 32 * MiB } };
    readingMetrics(none, 'noWindow', noWindow);
    growthMetrics(none, 'hidden', reading('canvas', { main: [1, 190] }, [30, 20]), noWindow);
    expect(Object.keys(values(none)).filter((k) => k.includes('.heap.'))).toEqual(['memory.noWindow.heap.main', 'memory.hidden.growth.heap.main']);
  });

  it('report growth as the signed difference of two readings, a role in one only counting as none in the other', () => {
    const m = new Collector();
    growthMetrics(m, 'close', reading('welcome', { main: [1, 190], renderer: [1, 20] }, [30, 20]), reading('closed', { main: [1, 230], preview: [2, 120] }, [35, 18]));
    expect(values(m)).toEqual({
      'memory.close.growth.total': '140 memory',
      'memory.close.growth.processes': '1 count',
      'memory.close.growth.mem.main': '40 memory',
      'memory.close.growth.processes.main': '0 count',
      'memory.close.growth.mem.preview': '120 memory',
      'memory.close.growth.processes.preview': '2 count',
      'memory.close.growth.mem.renderer': '-20 memory',
      'memory.close.growth.processes.renderer': '-1 count',
      'memory.close.growth.heap.main': '5 memory',
      'memory.close.growth.heap.editor': '-2 memory'
    });
  });
});

/** A clock whose sleeps move time on and pass at the next turn of the event loop, as a real one's would. */
function fakeClock(): Clock & { t: number } {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += Math.max(0, ms);
      await new Promise((r) => setImmediate(r));
    }
  };
  return c;
}

/** A source whose table is a function of the clock (or of the call), logging what the probe asked of it and when. */
function fakeSource(table: (t: number, call: number) => MemoryRow[], clock: { t: number }, f: (t: number, call: number) => AppFacts = () => facts) {
  const calls = { table: 0, facts: 0, collect: 0, heap: 0, log: [] as string[] };
  const src: MemorySource = {
    source: 'ps rss',
    table: async () => {
      calls.log.push(`table@${clock.t}`);
      return table(clock.t, calls.table++);
    },
    facts: async () => f(clock.t, calls.facts++),
    collect: async (passes) => {
      calls.collect++;
      calls.log.push(`collect×${passes}@${clock.t}`);
      return ['main', 'editor'];
    },
    heap: async () => {
      calls.heap++;
      calls.log.push(`heap@${clock.t}`);
      return { main: (30 + calls.heap) * MiB, editor: 20 * MiB };
    }
  };
  return { src, calls };
}

const REST = { settleMs: 3000, stableGapMs: 500, stableMaxMs: 15_000, gcPasses: 2, postGcMs: 1000, retries: 3 };
const welcomeRows = [row(1, 0, 190, APP), row(2, 1, 150), row(4, 1, 100), row(5, 1, 40)];

describe('a reading at rest', () => {
  it('fail a reading taken with the window in the other state than it expects', async () => {
    // With the editor's window: a reading that expects one is taken, one that expects none fails.
    const withEditor = fakeSource(() => welcomeRows, fakeClock());
    await expect(new MemoryProbe(withEditor.src, fakeClock(), REST).rest('noWindow', { window: false })).rejects.toThrow("memory reading noWindow: the editor's window is open");
    // Without it (the heap has no editor's): the reverse, so a window that closed by mistake never reads as a smaller app.
    const without = fakeSource(() => welcomeRows, fakeClock());
    without.src.heap = async () => ({ main: 31 * MiB });
    await expect(new MemoryProbe(without.src, fakeClock(), REST).rest('closed')).rejects.toThrow("memory reading closed: the editor's window is not open");
    const r = await new MemoryProbe(without.src, fakeClock(), REST).rest('noWindow', { window: false });
    expect(r.heap).toEqual({ main: 31 * MiB });
  });

  it('wait for the settle time and a settled set, collect garbage, read the heaps, then sample once', async () => {
    const clock = fakeClock();
    const { src, calls } = fakeSource(() => welcomeRows, clock);
    const probe = new MemoryProbe(src, clock, REST);
    const r = await probe.rest('welcome');
    expect(calls.log).toEqual(['table@3000', 'table@3500', 'collect×2@3500', 'heap@4500', 'table@4500']);
    expect(r).toMatchObject({ label: 'welcome', kind: 'rest', total: 480 * MiB, count: 4, heap: { main: 31 * MiB, editor: 20 * MiB } });
    expect(r.how).toEqual({ source: 'ps rss', protocol: MEMORY_PROTOCOL, waitedMs: 4500, settledMs: 500, collected: ['main', 'editor'], gcPasses: 2, postGcMs: 1000, retries: 0 } satisfies RestHow);
    expect(Object.keys(r.roles)).toEqual(['editor', 'gpu', 'main', 'network']);
    expect(probe.readings).toEqual([r]);
    expect(probe.seen().map((k) => k.pid)).toEqual([1, 2, 4, 5]);
  });

  it('keep the preview’s renderer as the preview while Chromium keeps it after the project closes', async () => {
    const clock = fakeClock();
    const open = [...welcomeRows, row(3, 1, 170)];
    // The frame is there for the canvas reading; after the close it is gone and its renderer stays on.
    const { src } = fakeSource(() => open, clock, (t) => (t < 10_000 ? facts : { ...facts, preview: null }));
    const probe = new MemoryProbe(src, clock, REST);
    expect((await probe.rest('canvas')).roles.preview).toEqual({ processes: 1, bytes: 170 * MiB });
    clock.t = 20_000;
    const closed = await probe.rest('closed');
    expect(closed.processes.map((p) => p.role)).toEqual(['editor', 'gpu', 'main', 'network', 'preview']);
    // A new probe, never told it was the preview, calls it a renderer.
    clock.t = 20_000;
    const fresh = new MemoryProbe(fakeSource(() => open, clock, () => ({ ...facts, preview: null })).src, clock, REST);
    expect((await fresh.rest('closed')).roles.renderer).toEqual({ processes: 1, bytes: 170 * MiB });
  });

  it('wait for a sample in which every process has its figure', async () => {
    const clock = fakeClock();
    // The worker's footprint is missing from two tables: once while settling, once in the sample after the collection.
    let n = 0;
    const { src } = fakeSource(() => {
      n++;
      return [...welcomeRows, { ...row(7, 1, 70), bytes: n === 2 || n === 4 ? NaN : 70 * MiB }];
    }, clock);
    const r = await new MemoryProbe(src, clock, REST).rest('canvas');
    expect([(r.how as RestHow).retries, r.roles.media, r.processes.every((p) => Number.isFinite(p.bytes))]).toEqual([1, { processes: 1, bytes: 70 * MiB }, true]);
  });

  it('take the sample again when the processes changed during the collection, counting every attempt’s wait', async () => {
    const clock = fakeClock();
    // A media worker starts during the first collection and another during the second, then the set holds.
    let collections = 0;
    const { src } = fakeSource(() => [...welcomeRows, ...(collections > 0 ? [row(7, 1, 70)] : []), ...(collections > 1 ? [row(8, 1, 60)] : [])], clock);
    const collect = src.collect;
    src.collect = async (n) => (collections++, collect(n));
    const r = await new MemoryProbe(src, clock, REST).rest('canvas');
    expect((r.how as RestHow).retries).toBe(2);
    expect((r.how as RestHow).settledMs).toBe(1500);
    expect(r.count).toBe(6);
  });

  it('take it again when a collection failed because a process went, and fail one that failed with the set unchanged', async () => {
    const clock = fakeClock();
    let gone = false;
    const { src } = fakeSource(() => (gone ? welcomeRows : [...welcomeRows, row(3, 1, 170)]), clock);
    let first = true;
    src.collect = async () => {
      if (first) {
        first = false;
        gone = true;
        throw new Error('Target closed');
      }
      return ['main', 'editor'];
    };
    const r = await new MemoryProbe(src, clock, REST).rest('closed');
    expect([(r.how as RestHow).retries, r.count]).toEqual([1, 4]);
    const broken = fakeSource(() => welcomeRows, clock);
    broken.src.collect = async () => {
      throw new Error('inspector refused');
    };
    await expect(new MemoryProbe(broken.src, clock, REST).rest('welcome')).rejects.toThrow('inspector refused');
  });

  it('fail when the processes keep changing at every collection, and when they never hold still', async () => {
    const clock = fakeClock();
    let collections = 0;
    const churn = fakeSource(() => [...welcomeRows, row(100 + collections, 1, 10)], clock);
    churn.src.collect = async () => (collections++, ['main', 'editor']);
    await expect(new MemoryProbe(churn.src, clock, REST).rest('canvas')).rejects.toThrow('kept changing while it was taken');
    expect(collections).toBe(3);
    // One pid, a new process each time (another start time): never the same set twice.
    const restless = fakeSource((_t, call) => [...welcomeRows, row(7, 1, 10, HELPER, `s${call}`)], clock);
    clock.t = 0;
    await expect(new MemoryProbe(restless.src, clock, REST).rest('canvas')).rejects.toThrow('never stopped changing');
    expect(clock.t).toBeLessThanOrEqual(3000 + 15_000 + 500);
  });
});

/** A source whose table follows `script` one sample at a time, and work that ends once `samples` have been taken. */
function peakSetup(script: MemoryRow[][], samples: number, f?: (t: number, call: number) => AppFacts) {
  const clock = fakeClock();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const s = fakeSource(
    (_t, call) => {
      if (call + 1 >= samples) release();
      return script[Math.min(call, script.length - 1)];
    },
    clock,
    f
  );
  return { clock, ...s, done };
}
const turn = () => new Promise((r) => setImmediate(r));

describe('a peak', () => {
  const at = (main: number, dev: number, extra: MemoryRow[] = []) => [row(1, 0, main, APP), row(2, 1, 150), row(6, 1, dev), ...extra];

  it('keep the highest total and each role’s highest, which need not come at once, sampled through the work', async () => {
    const { clock, src, calls, done } = peakSetup([at(190, 400), at(260, 400), at(200, 410), at(200, 520, [row(7, 1, 30), row(8, 1, 40)]), at(195, 430)], 5);
    const probe = new MemoryProbe(src, clock, REST, 200);
    const result = await probe.peak('open', async () => {
      await done;
      return 'opened';
    });
    expect(result).toBe('opened');
    const r = probe.readings[0];
    expect(r.kind).toBe('peak');
    expect([r.roles.main.bytes / MiB, r.roles.devServer.bytes / MiB, r.roles.media]).toEqual([260, 520, { processes: 2, bytes: 70 * MiB }]);
    // The highest total (200 + 150 + 520 + 70) is less than the sum of each role's highest (260 + 150 + 520 + 70).
    expect([r.total / MiB, r.count]).toEqual([940, 5]);
    // Five samples a period apart, and the last one as soon as the work is done.
    expect(calls.table).toBe(6);
    expect(r.how).toEqual({ source: 'ps rss', protocol: MEMORY_PROTOCOL, periodMs: 200, samples: 6, maxGapMs: 200, durationMs: 800, incomplete: 0 } satisfies PeakHow);
  });

  it('leave out of the peak a sample in which a process had no figure, and count it', async () => {
    const unknown = { ...row(6, 1, 0), bytes: NaN };
    const { clock, src, done } = peakSetup([at(190, 400), [row(1, 0, 900, APP), row(2, 1, 150), unknown], at(200, 410)], 4);
    const probe = new MemoryProbe(src, clock, REST, 200);
    await probe.peak('open', () => done);
    const r = probe.readings[0];
    expect([r.roles.main.bytes / MiB, r.total / MiB, (r.how as PeakHow).incomplete]).toEqual([200, 760, 1]);
    // No complete sample at all: no peak, never a zero one.
    const blind = peakSetup([[row(1, 0, 190, APP), unknown]], 3);
    await expect(new MemoryProbe(blind.src, blind.clock, REST, 200).peak('open', () => blind.done)).rejects.toThrow('none of its 4 samples had every process');
  });

  it('ask the app who a process is when one appears, and again for one that appears while it answers', async () => {
    const media = row(7, 1, 90);
    const reader = row(12, 1, 50);
    const plain = { ...facts, preview: null, windows: [] };
    // Only the answers given while each was alive describe it: the worker and the import reader each come and go.
    const describe = (_t: number, call: number): AppFacts => ({
      ...plain,
      processes: [...plain.processes.filter((p) => p.pid !== 7 && p.pid !== 8), ...(call === 1 ? [{ pid: 7, type: 'Utility', label: 'SiteOrigin media' }] : []), ...(call === 2 ? [{ pid: 12, type: 'Utility', label: 'SiteOrigin import reader' }] : [])]
    });
    const { clock, src, done } = peakSetup([at(190, 400), at(190, 400, [media]), at(190, 400, [reader]), at(190, 400)], 5, describe);
    let answering = 0;
    const ask = src.facts;
    // The first ask is slow, so the reader appears while it is answered.
    src.facts = async () => {
      if (answering++ === 1) for (let i = 0; i < 4; i++) await turn();
      return ask();
    };
    const probe = new MemoryProbe(src, clock, REST, 200);
    await probe.peak('import', () => done);
    expect(probe.readings[0].roles.media).toEqual({ processes: 1, bytes: 90 * MiB });
    expect(probe.readings[0].roles.importReader).toEqual({ processes: 1, bytes: 50 * MiB });
  });

  it('stop sampling when the work fails, record nothing, pass the failure on, and take the next peak', async () => {
    const { clock, src, calls, done } = peakSetup([at(190, 400)], 3);
    const probe = new MemoryProbe(src, clock, REST, 200);
    await expect(
      probe.peak('open', async () => {
        await done;
        throw new Error('the canvas never showed it');
      })
    ).rejects.toThrow('the canvas never showed it');
    const after = calls.table;
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.table).toBe(after);
    expect(probe.readings).toEqual([]);
    await probe.peak('again', async () => {
      while (calls.table < after + 3) await turn();
    });
    expect(probe.readings.map((r) => r.label)).toEqual(['again']);
  });

  it('fail the peak, once the work is done, when the table could not be read, and record nothing', async () => {
    const { clock, src } = peakSetup([at(190, 400)], 99);
    let n = 0;
    const table = src.table;
    src.table = async () => {
      if (++n === 3) throw new Error('ps timed out');
      return table();
    };
    const probe = new MemoryProbe(src, clock, REST, 200);
    let worked = false;
    await expect(
      probe.peak('open', async () => {
        while (n < 3) await turn();
        worked = true;
      })
    ).rejects.toThrow('the process table could not be read (ps timed out)');
    expect(worked).toBe(true);
    expect(probe.readings).toEqual([]);
  });

  it('ask the app nothing more once the probe is closed, even for a process that appears in a sample already out', async () => {
    const clock = fakeClock();
    let answer: ((rows: MemoryRow[]) => void) | null = null;
    const { src, calls } = fakeSource(() => welcomeRows, clock);
    const table = src.table;
    src.table = () => (calls.table === 2 ? new Promise<MemoryRow[]>((r) => (answer = r)) : table());
    const probe = new MemoryProbe(src, clock, REST, 200);
    const peak = probe.peak('open', () => new Promise<void>(() => {}));
    while (!answer) await turn();
    const asked = calls.facts;
    const closing = probe.dispose();
    (answer as (rows: MemoryRow[]) => void)([...welcomeRows, row(7, 1, 70)]);
    await closing;
    for (let i = 0; i < 5; i++) await turn();
    expect(calls.facts).toBe(asked);
    void peak.catch(() => undefined);
  });

  it('publish no reading at rest whose heaps came back after the probe was closed', async () => {
    const clock = fakeClock();
    let heap: ((h: { main: number; editor: number }) => void) | null = null;
    const { src, calls } = fakeSource(() => welcomeRows, clock);
    src.heap = () => new Promise((r) => (heap = r));
    const probe = new MemoryProbe(src, clock, REST);
    const reading = probe.rest('welcome');
    while (!heap) await turn();
    const tables = calls.table;
    const closing = probe.dispose();
    (heap as (h: { main: number; editor: number }) => void)({ main: 1, editor: 1 });
    await closing;
    await expect(reading).rejects.toThrow('the memory probe was closed');
    expect([probe.readings, calls.table]).toEqual([[], tables]);
  });

  it('stop sampling when the probe is closed mid-peak, and never start work, or another peak’s, after', async () => {
    const { clock, src, calls } = peakSetup([at(190, 400)], 99);
    const probe = new MemoryProbe(src, clock, REST, 200);
    let release!: () => void;
    const peak = probe.peak('open', () => new Promise<void>((r) => (release = r)));
    while (calls.table < 3) await turn();
    await probe.dispose();
    const after = calls.table;
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.table).toBe(after);
    release();
    await expect(peak).rejects.toThrow('the memory probe was closed');
    let started = false;
    await expect(probe.peak('later', async () => void (started = true))).rejects.toThrow('the memory probe was closed');
    await expect(probe.rest('later')).rejects.toThrow('the memory probe was closed');
    expect(started).toBe(false);
    await probe.dispose();
  });

  it('never start the work when the probe is closed before the first sample is in, and wait for calls already made', async () => {
    const clock = fakeClock();
    let answer: ((rows: MemoryRow[]) => void) | null = null;
    const { src } = fakeSource(() => welcomeRows, clock);
    src.table = () => new Promise<MemoryRow[]>((r) => (answer = r));
    const probe = new MemoryProbe(src, clock, REST, 200);
    let started = false;
    const peak = probe.peak('open', async () => void (started = true));
    while (!answer) await turn();
    let disposed = false;
    const closing = probe.dispose().then(() => (disposed = true));
    await turn();
    // The table call is still out: closing waits for it.
    expect(disposed).toBe(false);
    (answer as (rows: MemoryRow[]) => void)(welcomeRows);
    await closing;
    await expect(peak).rejects.toThrow('the memory probe was closed');
    expect(started).toBe(false);
    // And gives up waiting on a call that never returns.
    const stuck = fakeSource(() => welcomeRows, clock);
    stuck.src.table = () => new Promise<MemoryRow[]>(() => {});
    const wedged = new MemoryProbe(stuck.src, clock, REST, 200);
    void wedged.peak('open', async () => {}).catch(() => undefined);
    await turn();
    await wedged.dispose(20);
  });

  it('refuse a second peak while one is being sampled, from the moment the first is asked for', async () => {
    const { clock, src, done } = peakSetup([at(190, 400)], 3);
    const probe = new MemoryProbe(src, clock, REST, 200);
    const first = probe.peak('open', () => done);
    await expect(probe.peak('other', async () => {})).rejects.toThrow('another peak is being sampled');
    await first;
  });
});
