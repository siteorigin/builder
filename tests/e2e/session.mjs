// The isolated test session (tests/driver, issue #491) against the built app. A separate Node client starts a
// session, makes several calls against the same window, reads the session's and the build's identity, and closes it.
// Two sessions one after another share no project, settings, API key or chat; two at once each get an app of their
// own, and a session never reaches a Builder already running in the profile its caller names. A start that runs out
// of time, a close while the app is still launching, and a client that disappears all end the app and every process
// it started (the preview's dev server, npm) and remove the run's data, keeping only the artifacts asked for and never
// a folder the caller owns. A replaced editor window is reported, not used silently.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { connect } from '../driver/client.ts';
import { isAlive, ownedProcesses, processTable } from '../driver/processes.ts';
import { Session, isInside } from '../driver/session.ts';
import { envelopeReply } from '../unit/mock-openai-server.ts';
import { eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('session');
const sessions = [];
const clients = [];
let passed = false;

let n = 0;
const req = (op, extra = {}) => ({ v: 1, id: `e${++n}`, op, ...extra });
const ok = (reply, what) => {
  assert.equal(reply.ok, true, `${what}: ${reply.ok ? '' : `${reply.error.code} ${reply.error.message}`}`);
  return reply.result;
};
const code = (reply) => (reply.ok ? 'ok' : reply.error.code);
const session = (opts = {}) => {
  const s = new Session({ parentDir: WORK, ...opts });
  sessions.push(s);
  return s;
};
/** Every one of `pids` has ended. */
const allGone = (pids, what, ms = 30000) => eventually(() => assert.deepEqual(pids.filter(isAlive), [], `${what}: still running`), ms, 200);
/** Every process's command line, by pid: checks that do not rely on the session's own bookkeeping. */
const commands = () =>
  new Promise((resolve, reject) =>
    execFile('ps', ['-A', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      if (e) return reject(e);
      const map = new Map();
      for (const line of String(out).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) map.set(Number(m[1]), m[2]);
      }
      resolve(map);
    })
  );
/** Processes whose command line names `dir`. */
const naming = async (dir) => [...(await commands())].filter(([, c]) => c.includes(dir)).map(([pid, c]) => `${pid} ${c}`);
/** Of `pids`, those that are Electron utility processes: the preview's dev server runs as one. */
const utilities = async (pids) => {
  const all = await commands();
  return pids.filter((pid) => /--type=utility\b/.test(all.get(pid) ?? '') && /node\.mojom\.NodeService/.test(all.get(pid) ?? ''));
};

try {
  step('a client starts a session and reads who it is: session, build, app and capabilities');
  const callerArtifacts = join(WORK, 'caller-artifacts');
  mkdirSync(callerArtifacts);
  writeFileSync(join(callerArtifacts, 'sentinel.txt'), 'the caller’s own file');
  const client = await connect({ env: { WORK }, stderr: { file: join(WORK, 'host-1.log') } });
  clients.push(client);
  const started = ok(await client.request('session.start', { fixture: 'welcome', artifactsDir: callerArtifacts, keepArtifacts: 'always' }), 'session.start');
  const one = started.session;
  assert.equal(started.protocol, 1);
  assert.equal(one.state, 'ready');
  assert.ok(isInside(WORK, one.root), 'the run root is made where it was asked for');
  assert.match(started.build.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.ok(started.build.files >= 3 && started.build.git?.head, 'the build names its files and the checkout');
  assert.ok(started.app.electron && started.app.version, 'the app names its versions');
  for (const k of ['userData', 'sessionData', 'documents']) assert.ok(isInside(one.root, started.app.paths[k]), `the app's ${k} is the session's own (${started.app.paths[k]})`);
  assert.equal(started.app.paths.documents, one.paths.workspace);
  assert.equal(one.provider.kind, 'scripted', 'the default AI provider is a local scripted server that costs nothing');
  assert.match(one.provider.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(one.headless, true);
  assert.ok(one.processes[0] === one.pid && one.processes.length >= 3, `the session owns the app and its helpers (${one.processes})`);
  assert.ok((await naming(one.root)).length > 0, 'the app names its own profile from the start (a control for the checks below)');
  assert.deepEqual(
    started.capabilities.map((c) => `${c.op}:${c.kind}`),
    [
      'session.start:session',
      'session.describe:session',
      'window.info:observe',
      'window.close:act',
      'menu.list:observe',
      'menu.invoke:act',
      'desktop.setAnswers:fixture',
      'desktop.events:observe',
      'files.stageImport:fixture',
      'files.list:observe',
      'session.close:session'
    ]
  );

  step('several calls in a row run against the same, hidden window');
  const first = ok(await client.request('window.info'), 'window.info');
  const again = ok(await client.request('window.info'), 'window.info again');
  assert.deepEqual(one.window, { generation: 1, nativeId: first.nativeId });
  assert.deepEqual([first.generation, again.generation, again.nativeId], [1, 1, first.nativeId]);
  assert.equal(first.url, 'app://editor/index.html');
  assert.equal(first.visible, false, 'the window is never shown');
  assert.equal(first.focused, false);
  assert.equal(ok(await client.request('session.describe'), 'describe').session.pid, one.pid);

  step('a call past its deadline is answered TIMEOUT; a read leaves the session usable');
  const slow = await client.request('window.info', undefined, { timeoutMs: 1 });
  assert.equal(code(slow), 'TIMEOUT');
  assert.deepEqual(slow.error.details, { phase: 'window.info', sessionState: 'ready' });
  assert.equal(ok(await client.request('window.info'), 'window.info after the timeout').nativeId, first.nativeId);

  step('more sessions at the same time, two launching together in one process, each get an app of their own');
  const beside = [session(), session()];
  await Promise.all(beside.map((s) => s.start({ fixture: 'welcome', keepArtifacts: 'never' })));
  const pids = new Set([one.pid, ...beside.map((s) => s.pid)]);
  assert.equal(pids.size, 3, `three apps (${[...pids]})`);
  for (const s of beside) {
    assert.notEqual(s.paths.root, one.root);
    assert.equal(s.app.process().pid, s.pid, 'each session holds the app it launched');
    assert.equal(code(await s.call(req('window.info'))), 'ok');
  }
  assert.equal(ok(await client.request('window.info'), 'the first session after the others started').nativeId, first.nativeId);
  for (const s of beside) await allGone((await s.close()).processes, 'a concurrent session');

  step('a Builder already running in the profile the caller names is never reached');
  // A stand-in for the person's own Builder: started the old way, in a profile the caller's environment points to.
  const devWork = join(WORK, 'developer');
  mkdirSync(devWork);
  const dev = await launch(devWork);
  try {
    await dev.app.evaluate(({ app }) => {
      globalThis.secondInstances = 0;
      app.on('second-instance', () => globalThis.secondInstances++);
    });
    const callerProfile = process.env.SITEORIGIN_USER_DATA;
    process.env.SITEORIGIN_USER_DATA = join(devWork, 'userdata');
    let isolated;
    try {
      isolated = session();
      await isolated.start({ fixture: 'welcome', keepArtifacts: 'never' });
    } finally {
      if (callerProfile === undefined) delete process.env.SITEORIGIN_USER_DATA;
      else process.env.SITEORIGIN_USER_DATA = callerProfile;
    }
    const d = await isolated.describe();
    assert.notEqual(isolated.pid, dev.app.process().pid);
    assert.ok(isInside(isolated.paths.root, d.app.paths.userData), `the session's app uses its own profile (${d.app.paths.userData})`);
    assert.equal(await dev.app.evaluate(() => globalThis.secondInstances), 0, 'the running Builder was not told of a second launch');
    assert.equal(code(await isolated.call(req('window.info'))), 'ok');
    await allGone((await isolated.close()).processes, 'the isolated session');
  } finally {
    await dev.app.close().catch(() => undefined);
  }

  step('closing ends every process and removes the run, keeping the artifacts asked for');
  const closed = ok(await client.request('session.close'), 'session.close');
  assert.equal(closed.ended, 'quit');
  for (const pid of one.processes) assert.ok(closed.processes.includes(pid), `close accounts for ${pid}`);
  await allGone([...one.processes, ...closed.processes], 'after session.close');
  assert.equal(existsSync(one.root), false, 'the run root is gone');
  assert.equal(closed.artifacts, join(callerArtifacts, one.id));
  assert.ok(existsSync(join(closed.artifacts, 'app.log')), 'the app log was kept');
  assert.equal(readFileSync(join(callerArtifacts, 'sentinel.txt'), 'utf8'), 'the caller’s own file', 'the caller’s own file is untouched');
  assert.deepEqual(await client.exited, { code: 0, signal: null }, 'the host exits once its session is closed');

  step('session A: a project, a setting, an API key, a recent project and a chat');
  const a = session();
  const aBegan = Date.now();
  await a.start({ fixture: 'business-v1', keepArtifacts: 'never' });
  const fixtureStartMs = Date.now() - aBegan;
  const pa = a.page;
  const projectA = (await a.describe()).session.project;
  assert.ok(projectA && isInside(a.paths.projects, projectA), `the fixture project is in A's workspace (${projectA})`);
  await pa.evaluate(() => window.builder.app.setSettings({ appearance: 'dark' }));
  await pa.evaluate(() => window.builder.ai.setKey('openai', 'sk-test-session-a-not-real'));
  assert.equal((await pa.evaluate(() => window.builder.ai.providers())).find((p) => p.id === 'openai').configured, true);
  a.mock.script(envelopeReply('finish', { message: 'Hello from session A.' }));
  await pa.locator('.dock-tab', { hasText: 'AI' }).click();
  await pa.getByRole('button', { name: /^Ask: a read-only question/ }).click();
  const message = pa.getByRole('textbox', { name: 'Message' });
  await message.fill('Say hello, and leave the site unchanged.');
  await message.press('Enter');
  await pa.locator('.chat-log').getByText('Hello from session A.').waitFor({ timeout: 30000 });
  assert.ok(a.mock.requests.some((r) => r.method === 'POST'), 'the chat went to A’s scripted server');
  assert.ok((await pa.evaluate(() => window.builder.projects.recents())).some((r) => r.dir === projectA));
  const rootA = a.paths.root;
  const providerA = a.mock.baseURL;
  const closedA = await a.close();
  await allGone(closedA.processes, 'session A');
  assert.equal(existsSync(rootA), false);

  step('session B starts clean: no recent project, default settings, no key, no chat, an empty workspace');
  const b = session();
  await b.start({ fixture: 'welcome', keepArtifacts: 'never' });
  const pb = b.page;
  assert.deepEqual(await pb.evaluate(() => window.builder.projects.recents()), []);
  const settingsB = await pb.evaluate(() => window.builder.app.getSettings());
  assert.equal(settingsB.appearance, 'system');
  assert.equal(settingsB.ai.local.baseURL, b.mock.baseURL);
  assert.notEqual(b.mock.baseURL, providerA, 'B talks to its own scripted server');
  assert.equal((await pb.evaluate(() => window.builder.ai.providers())).find((p) => p.id === 'openai').configured, false, 'A’s key is not in B');
  assert.equal(await pb.evaluate(() => window.builder.dialogs.defaultProjectsFolder()), b.paths.projects, 'new projects default to B’s own workspace');
  assert.deepEqual(readdirSync(b.paths.projects), []);
  assert.equal(existsSync(projectA), false, 'A’s project, and the chat in it, are gone');
  assert.equal(b.mock.requests.filter((r) => r.method === 'POST').length, 0, 'B has had no chat');
  await allGone((await b.close()).processes, 'session B');

  step('a replaced editor window is reported, and used only once the client names it');
  const w = session();
  await w.start({ keepArtifacts: 'never' });
  const events = [];
  const call = async (frame) => {
    const r = await w.call(frame);
    events.push(...r.events);
    return r;
  };
  const before = ok(await call(req('window.info')), 'window.info');
  await w.app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.close();
  });
  if (process.platform === 'darwin') {
    // On macOS the app keeps running without a window, and brings up a new one when it is activated.
    await eventually(async () => assert.equal(code(await call(req('window.info'))), 'WINDOW_CLOSED'), 15000);
    await w.app.evaluate(({ app }) => app.emit('activate'));
    const replaced = await eventually(async () => {
      const r = await call(req('window.info'));
      assert.equal(code(r), 'WINDOW_REPLACED');
      return r;
    }, 30000);
    assert.deepEqual([replaced.error.details.from, replaced.error.details.to], [1, 2]);
    assert.ok(events.some((e) => e.type === 'window.closed' && e.generation === 1), 'the closed window was reported');
    assert.ok(events.some((e) => e.type === 'window.replaced' && e.from === 1 && e.to === 2), 'the replacement was reported');
    const after = ok(await call(req('window.info', { expectWindow: 2 })), 'window.info on the new window');
    assert.equal(after.generation, 2);
    assert.notEqual(after.nativeId, before.nativeId);
    assert.equal(ok(await call(req('window.info')), 'window.info once acknowledged').generation, 2);
    assert.equal(code(await call(req('window.info', { expectWindow: 1 }))), 'WINDOW_REPLACED', 'the old window is never used again');
    assert.equal(code(await call(req('window.info', { expectWindow: 3 }))), 'WINDOW_REPLACED', 'nor a window that does not exist');
  } else {
    // Elsewhere the last window closing quits the app.
    await eventually(async () => assert.equal(code(await call(req('window.info'))), 'APP_EXITED'), 15000);
  }
  await allGone((await w.close()).processes, 'the replaced-window session');

  step('closing while the app is still launching kills it before Playwright hands it over');
  let spawned = null;
  const early = session({
    hooks: {
      phase: (p, s) => {
        if (p !== 'app.spawned') return;
        spawned = s.pid;
        void s.close();
      }
    }
  });
  await assert.rejects(early.start({ fixture: 'welcome' }), (e) => e.code === 'CLOSED');
  assert.ok(spawned, 'the app had been spawned');
  const earlyClosed = await early.close();
  assert.equal(earlyClosed.ended, 'killed');
  assert.ok(earlyClosed.processes.includes(spawned));
  await allGone(ownedProcesses(await processTable(), spawned), 'the app closed mid-launch, and its group');
  assert.equal(existsSync(early.paths.root), false);

  step('a start that runs out of time ends the app and its preview, keeping only its failure artifacts');
  const seen = new Set();
  let previewWorkers = [];
  let sampler;
  const sample = async (s) => {
    if (s.pid) for (const pid of ownedProcesses(await processTable(), s.pid)) seen.add(pid);
  };
  const late = session({
    hooks: {
      phase: async (p, s) => {
        if (p === 'app.spawned') sampler = setInterval(() => void sample(s).catch(() => undefined), 250);
        // Once the preview is up, the start waits here until its deadline passes.
        if (p === 'fixture.ready') {
          await sample(s);
          previewWorkers = await utilities([...seen]);
          return new Promise(() => undefined);
        }
      }
    }
  });
  let timedOut;
  // Long enough to reach the preview, as session A's start did, so the deadline passes while the start waits there.
  await assert.rejects(late.start({ fixture: 'business-v1' }, { timeoutMs: fixtureStartMs + 20000 }), (e) => ((timedOut = e), e.code === 'TIMEOUT'));
  clearInterval(sampler);
  console.log(`timed out at ${timedOut.details.phase}, having seen ${seen.size} processes of the session's, ${previewWorkers.length} of them utility processes`);
  assert.equal(timedOut.details.phase, 'fixture.ready');
  assert.equal(timedOut.details.sessionState, 'closed');
  assert.ok(previewWorkers.length >= 1, `the preview's dev server was running (${[...seen]})`);
  await allGone([...seen], 'after the start timed out');
  assert.deepEqual(await naming(late.paths.root), [], 'no process names the run root');
  const keptLate = timedOut.details.artifacts;
  assert.equal(keptLate, late.paths.artifacts);
  assert.ok(existsSync(join(keptLate, 'app.log')) && existsSync(join(keptLate, 'session.json')), 'the failure artifacts were kept');
  assert.deepEqual(readdirSync(late.paths.root).sort(), ['.siteorigin-test-session.json', 'artifacts'], 'only the artifacts were kept');

  step('a client that disappears takes its session, the app and its preview with it');
  const script = join(WORK, 'vanishing-client.mjs');
  writeFileSync(
    script,
    `import { connect } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../driver/client.ts')).href)};
const client = await connect({ env: { WORK: process.argv[2] }, stderr: { file: process.argv[3] } });
const r = await client.request('session.start', { fixture: 'business-v1', keepArtifacts: 'never' });
if (!r.ok) { console.error(JSON.stringify(r.error)); process.exit(2); }
const d = await client.request('session.describe');
console.log(JSON.stringify({ host: client.pid, root: d.result.session.root, processes: d.result.session.processes }));
setInterval(() => undefined, 1000);
`
  );
  const vanishing = spawn(process.execPath, ['--no-warnings', script, WORK, join(WORK, 'host-vanishing.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the vanishing client did not report its session in time')), 240000);
    vanishing.once('exit', (c) => reject(new Error(`the vanishing client exited early (${c})`)));
    createInterface({ input: vanishing.stdout }).once('line', (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  vanishing.removeAllListeners('exit');
  assert.ok(info.processes.every(isAlive), `the app is running (${info.processes})`);
  assert.ok((await utilities(info.processes)).length >= 1, `the preview's dev server is running (${info.processes})`);
  vanishing.kill('SIGKILL');
  await allGone([info.host, ...info.processes], 'after the client disappeared', 60000);
  await eventually(() => assert.equal(existsSync(info.root), false, 'the run root is gone'), 30000);
  assert.deepEqual(await naming(info.root), []);

  passed = true;
  console.log('\nsession: PASS');
} finally {
  for (const s of sessions) await s.close().catch(() => undefined);
  for (const c of clients) await c.disconnect(30000).catch(() => undefined);
  if (passed) cleanup();
  else process.exitCode = 1;
}
