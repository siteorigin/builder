// The model-driven smoke test (issue #498): an external model, Codex, with the test driver's published MCP tools
// (tests/driver/mcp.ts) and no knowledge of this repository, explores a fresh session of the built app and takes the
// principal journey: creates a site, edits it, asks the Builder assistant a question, asks it for an edit, allows its
// request to change more, looks at the answer and the preview, undoes and redoes, exports, and checks what was saved.
//
// It costs Codex usage, so it is never part of `npm test` or `npm run test:e2e`: run it on purpose, after `npm run build`.
//
//   npm run test:model-smoke                # the journey (MODEL=gpt-6.2-sol EFFORT=medium by default)
//   npm run test:model-smoke -- --probe     # only checks that Codex starts with the Builder tools and calls one
//   npm run test:model-smoke -- --no-replay # the journey without replaying its record (the verdict says so)
//   npm run test:model-smoke -- --keep-screens  # also keep the session's closing screenshots (pixels are not redacted)
//
// Codex runs in an empty folder in the OS temporary folder, outside any repository, with a read-only sandbox, no user
// configuration, rules or project documents, its shell, browser, image, app, plugin and sub-agent tools turned off, and
// one MCP server: the Builder driver, whose tools are approved (they reach only the disposable session). Codex cannot list
// what it was given, so the transcript is the check: the verdict never trusts what the model says it did.
// - The transcript must hold only Builder tool calls (any other tool, even an attempt, fails the run) and be read whole.
// - The session's own record (replay.json) must prove the journey with this run's expected text and names
//   (tests/coverage/journey-proof.ts), the same check tests/e2e/journeys.mjs holds the deterministic journey to.
// - The record is replayed from Node in a fresh session (tests/driver/replay.ts), which must end with the edit saved and
//   the site renamed. A replay that stops at a step the record marks as not replayable (a click on screenshot pixels) is
//   reported as partial, not failed: the model was asked to act on refs, but a person's way of acting is still valid.
//
// Everything is kept in .tmp/model-smoke/<run>/: transcript.jsonl (every event, with host paths, the user's name,
// credentials and image data taken out), report.md (the model's own account, redacted the same way), evidence/ (the
// session's replay.json and app.log, redacted the same way), proof.txt and summary.json. No screenshot is kept unless
// asked for (--keep-screens): pixels cannot be redacted, and a dialog can show a folder path.
//
// The Builder tools can do whatever a person can in the app, which includes turning on Developer mode, where the app runs
// code a person writes with the permissions of whoever runs the test. The model is told not to, and a record that shows
// it did fails the run; run this only on a machine and account you would let such code run on.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describeProof, forbiddenSteps, proveJourney } from '../tests/coverage/journey-proof.ts';
import { auditTranscript, redactEvent, redactText } from '../tests/coverage/transcript.ts';
import { machineRoots, pathHider } from '../tests/driver/evidence.ts';
import { thisNode } from '../tests/driver/mcp.ts';
import { replay } from '../tests/driver/replay.ts';
import { Session } from '../tests/driver/session.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROBE = process.argv.includes('--probe');
const NO_REPLAY = process.argv.includes('--no-replay');
const KEEP_SCREENS = process.argv.includes('--keep-screens');
const MODEL = process.env.MODEL ?? 'gpt-6.2-sol';
const EFFORT = process.env.EFFORT ?? 'medium';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MIN ?? (PROBE ? 5 : 60)) * 60_000;
const SERVER = 'siteorigin_builder';

/** Codex's own tools that could read or change anything outside the Builder session: all turned off. */
const DISABLED = ['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'multi_agent', 'multi_agent_v2'];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = join(ROOT, '.tmp', 'model-smoke', `${stamp}${PROBE ? '-probe' : ''}`);
const SESSIONS = join(RUN, 'sessions');
const REPLAY_DIR = join(RUN, 'replay');
const EVIDENCE = join(RUN, 'evidence');
mkdirSync(SESSIONS, { recursive: true });
// Outside the checkout and any repository: Codex finds no project documents or skills from where it runs.
const CLIENT = mkdtempSync(join(realpathSync(tmpdir()), 'so-model-smoke-client-'));

const hide = pathHider([{ path: CLIENT, label: '<client>' }, { path: SESSIONS, label: '<sessions>' }, { path: RUN, label: '<run>' }, { path: ROOT, label: '<repo>' }, ...machineRoots()]);
const USER = basename(homedir());
const redact = (event) => redactEvent(event, hide, USER);
const text = (s) => redactText(String(s), hide, USER);

const NAME = 'Lantern Lane Bakery';
const HEADING = 'Fresh bread from the lantern oven';
const QUESTION = 'What does the main heading on the home page say?';
const ANSWER = `It says “${HEADING}”.`;
const NEW_NAME = 'Lantern Lane Kitchen';
const EXPECT = { edit: HEADING, oldName: NAME, newName: NEW_NAME, answer: ANSWER };

const PROMPT = PROBE
  ? `You have MCP tools from a server called ${SERVER}. Call its session_describe tool once, then reply with the word DONE and the number of ${SERVER} tools you can see. Do not call any other tool.`
  : `You are testing SiteOrigin Builder, a desktop website builder, through the ${SERVER} MCP tools. They drive a disposable, headless copy of the app as a person would. Use only those tools: no shell, no files, no web. Discover what you need from the tools' descriptions and from what the app shows you (ui_snapshot, ui_locate), and act on the controls a person would use, by the refs those observations give (not by screenshot pixels), so the run can be replayed.

Do not turn on Developer mode or open the app's settings for it: this test does not need it.

Do this, checking each outcome before moving on:
1. Start a new session at the Welcome screen with keepArtifacts "always", and look at what it offers.
2. Create a new website called "${NAME}" from Welcome, keeping the defaults, and wait until its preview is ready.
3. On the home page, change the main heading to exactly "${HEADING}" (select the hero section, edit its Heading in the Inspector, and leave the field so it is committed). Confirm it was saved: project_summary with find "${HEADING}" should find it.
4. Open the AI assistant panel. The assistant inside the app is scripted: before each message you send it, set its reply with assistant_script. Switch the next message to Ask (a read-only question), script the reply with scenario "read-and-answer" and params { "text": "${ANSWER}" }, then type and send: "${QUESTION}". Wait for its run to finish (assistant_wait) and read its answer as the chat shows it.
5. Switch the next message back to Edit, with the hero section still selected. Script scenario "widen" with params { "question": "May I rename the whole site?", "siteName": "${NEW_NAME}", "then": "Renamed the site." }, then send: "Rename the site to ${NEW_NAME}". The assistant will ask to change more than the selection: allow it. Wait for the run to finish, then check that the preview shows the new name: a wait_for ui.present (or ui_locate) with scope "preview" for a link named exactly "${NEW_NAME}".
6. Undo once with the app's own Undo, and check the same way that the preview's link is named exactly "${NAME}" again. Then Redo, and check that it is "${NEW_NAME}" again.
7. Export the website as files to a folder. The app asks for the folder with a native chooser that you answer in advance: before you click the choice that exports the website files, queue its answer with desktop_setAnswers (an open dialog, selection "folder", paths ["exports"]). Wait for the export to finish (wait_for export.finished), then check with exports_inspect, on the folder that export names and with find "${HEADING}", that its files contain the heading.
8. Call evidence_save, then session_close with keepArtifacts "always".

If something fails, read the error's details and hint, observe again, and try another way a person would. Finish with a short report: each step, what you checked, and anything that surprised you.`;

function codexArgs() {
  const toml = (s) => JSON.stringify(s);
  const server = `mcp_servers.${SERVER}`;
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '-C',
    CLIENT,
    '-s',
    'read-only',
    '-m',
    MODEL,
    '-c',
    `model_reasoning_effort=${toml(EFFORT)}`,
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'project_doc_max_bytes=0',
    ...DISABLED.flatMap((f) => ['--disable', f]),
    '-c',
    `${server}.command=${toml(thisNode())}`,
    '-c',
    `${server}.args=[${toml(join(ROOT, 'tests/driver/mcp.ts'))}]`,
    '-c',
    `${server}.cwd=${toml(ROOT)}`,
    '-c',
    `${server}.env={ WORK = ${toml(SESSIONS)} }`,
    ...(process.platform === 'linux' ? ['-c', `${server}.env_vars=["DISPLAY","XAUTHORITY"]`] : []),
    '-c',
    `${server}.startup_timeout_sec=30`,
    '-c',
    `${server}.tool_timeout_sec=360`,
    '-c',
    `${server}.default_tools_approval_mode="approve"`,
    '-'
  ];
}

// An interruption stops Codex (and with it the MCP server, which ends its sessions), skips the replay, and fails the run;
// the cleanup below still runs. A second one goes straight to SIGKILL.
let interrupted = false;
let stopCodex = () => undefined;
const onSignal = (sig) => {
  if (interrupted) stopCodex('SIGKILL');
  interrupted = true;
  console.error(`model-smoke: ${sig}; stopping`);
  stopCodex('SIGTERM');
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/** Run Codex to the end (or the deadline), keeping its events redacted as they arrive. */
async function runCodex() {
  const out = createWriteStream(join(RUN, 'transcript.jsonl'));
  /** The events as they came, for the audit (redaction could change what it reads), and as they are kept. */
  const raw = [];
  const events = [];
  let tail = '';
  const child = spawn('codex', codexArgs(), { cwd: CLIENT, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  stopCodex = (sig) => {
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => {
    console.error(`model-smoke: Codex ran past ${TIMEOUT_MS / 60000} minutes; stopping it`);
    stopCodex('SIGTERM');
    setTimeout(() => stopCodex('SIGKILL'), 15000).unref();
  }, TIMEOUT_MS);
  child.stdin.end(PROMPT);
  child.stderr.on('data', (d) => (tail = (tail + d.toString()).slice(-4000)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { type: 'unparsed', text: line.slice(0, 2000) };
    }
    raw.push(event);
    const kept = redact(event);
    events.push(kept);
    out.write(`${JSON.stringify(kept)}\n`);
    const item = kept.item;
    if (kept.type === 'item.completed' && item?.type === 'mcp_tool_call') console.log(`  ${item.tool}${item.status === 'failed' || item.error ? ' (failed)' : ''}`);
  });
  const code = await new Promise((done) => child.on('close', (c) => done(c ?? 1)));
  clearTimeout(timer);
  await new Promise((done) => out.end(done));
  return { code, raw, events, stderrTail: text(tail) };
}

/** The replay records the session wrote, newest last. */
function records() {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'replay.json') found.push(p);
    }
  };
  if (existsSync(SESSIONS)) walk(SESSIONS);
  return found.map((p) => ({ path: p, record: JSON.parse(readFileSync(p, 'utf8')) })).sort((a, b) => String(a.record.savedAt).localeCompare(String(b.record.savedAt)));
}

/**
 * The session's evidence, as it is kept: replay.json and app.log redacted as the transcript is, and the screenshots the
 * record and the close named; the screenshots of every observation are left out (their pixels can show a folder path).
 */
function keepEvidence(artifacts, record) {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'replay.json'), `${JSON.stringify(redact(record), null, 2)}\n`);
  if (existsSync(join(artifacts, 'app.log'))) writeFileSync(join(EVIDENCE, 'app.log'), text(readFileSync(join(artifacts, 'app.log'), 'utf8')));
  const named = KEEP_SCREENS ? [record.evidence?.screenshots?.editor, record.evidence?.screenshots?.preview, 'final.png'].filter((f) => typeof f === 'string' && !f.includes('..')) : [];
  const kept = [];
  for (const f of new Set(named)) {
    if (!existsSync(join(artifacts, f))) continue;
    copyFileSync(join(artifacts, f), join(EVIDENCE, basename(f)));
    kept.push(basename(f));
  }
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(join(dir, e.name)) : /\.png$/.test(e.name) && all.push(e.name));
  };
  walk(artifacts);
  return { screenshots: kept, leftOut: all.length - kept.length };
}

/**
 * This run's processes still running (its MCP server, session hosts, apps and preview servers), or null when they cannot
 * be listed. A session host names the run's folder only in its environment (WORK), so the scan reads each process's
 * command line and environment, and matches the folders as plain text.
 */
function leftovers() {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', process.platform === 'darwin' ? ['-A', '-ww', '-E', '-o', 'pid=,command='] : ['axeww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const pids = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    if (m[2].includes(RUN) || m[2].includes(CLIENT)) pids.push(Number(m[1]));
  }
  return pids;
}

/** End what is left and see that it went: true when nothing of this run is still running. */
async function reap() {
  let left = leftovers();
  if (left === null) return false;
  if (!left.length) return true;
  console.error(`model-smoke: ${left.length} processes of this run were still running; ending them`);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
  for (let i = 0; i < 20 && (left = leftovers())?.length; i++) await new Promise((r) => setTimeout(r, 500));
  return left !== null && !left.length;
}

const summary = { run: hide(RUN), probe: PROBE, model: MODEL, effort: EFFORT, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() };
/** Each part of the verdict: all must hold. */
const checks = {};
let replaySession = null;
try {
  if (!existsSync(join(ROOT, 'out/main/index.js'))) throw new Error('No built app in out/: run `npm run build` first.');
  summary.codex = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
  summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  summary.dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  console.log(`model-smoke: ${PROBE ? 'probe' : 'journey'} with ${MODEL} (${EFFORT}), ${summary.codex}; run folder ${RUN}`);

  const { code, raw, events, stderrTail } = await runCodex();
  summary.codexExit = code;
  const { calls, started, foreign, unreadable } = auditTranscript(raw, SERVER);
  summary.toolCalls = calls.length;
  summary.failedToolCalls = calls.filter((c) => !c.ok).length;
  summary.tools = Object.fromEntries([...new Set(calls.map((c) => c.tool))].sort().map((t) => [t, calls.filter((c) => c.tool === t).length]));
  summary.foreignTools = foreign.map(text);
  summary.unreadableEvents = unreadable;
  const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage).filter(Boolean);
  if (usage.length) summary.usage = usage.at(-1);
  const final = events.filter((e) => e.item?.type === 'agent_message').at(-1)?.item?.text ?? '';
  writeFileSync(join(RUN, 'report.md'), `${final}\n`);
  if (code !== 0) console.error(`model-smoke: Codex exited ${code}\n${stderrTail}`);
  if (foreign.length) console.error(`model-smoke: the model used tools other than the Builder's: ${foreign.join('; ')}`);
  checks.transcript = code === 0 && !foreign.length && !unreadable && !interrupted;

  if (PROBE) {
    checks.probe = started === 1 && calls.length === 1 && calls[0].tool === 'session_describe' && calls[0].ok;
    console.log(`model-smoke probe: ${checks.probe && checks.transcript ? 'Codex called the one Builder tool asked for, and nothing else' : 'FAILED'}\n${final}`);
  } else {
    const kept = records();
    if (!kept.length) throw new Error('The session kept no replay.json: did the model close it with keepArtifacts "always"?');
    const { path: recordPath, record } = kept.at(-1);
    summary.evidence = keepEvidence(resolve(recordPath, '..'), record);
    summary.record = { file: 'evidence/replay.json', sha256: createHash('sha256').update(readFileSync(recordPath)).digest('hex'), steps: record.steps.length, complete: record.complete, fixture: record.scenario.fixture, build: record.build?.fingerprint ?? null };
    const proof = proveJourney(record, EXPECT);
    const proofText = describeProof(proof);
    writeFileSync(join(RUN, 'proof.txt'), `${proofText}\n`);
    summary.proof = Object.fromEntries(proof.witnesses.map((w) => [w.id, w.seq]));
    checks.proof = proof.ok;
    const forbidden = forbiddenSteps(record);
    summary.forbiddenSteps = forbidden;
    checks.noDeveloperMode = !forbidden.length;
    if (forbidden.length) console.error(`model-smoke: the model turned on Developer mode (steps ${forbidden.join(', ')})`);
    console.log(`\nThe session's record:\n${proofText}`);

    if (NO_REPLAY || interrupted) {
      summary.replay = { outcome: 'skipped', why: interrupted ? 'interrupted' : '--no-replay' };
      checks.replay = !interrupted;
    } else {
      mkdirSync(REPLAY_DIR, { recursive: true });
      // The replay's session is held before it starts, so it is closed whatever the replay does.
      const r = await replay(record, { make: () => (replaySession = new Session({ parentDir: REPLAY_DIR })) });
      const counts = { replayed: r.steps.filter((s) => s.status === 'replayed').length, skipped: r.steps.filter((s) => s.status === 'skipped').length };
      if (r.ok) {
        const again = await replaySession.call({ v: 1, id: 'smoke-check', op: 'project.summary', args: { find: HEADING } });
        const site = again.ok ? (again.result.project?.site?.name ?? null) : null;
        const found = again.ok ? (again.result.project?.find?.matches.length ?? 0) : 0;
        summary.replay = { outcome: 'replayed', ...counts, project: again.ok ? { site: text(site ?? ''), found } : again.error.code };
        checks.replay = site === NEW_NAME && found > 0;
      } else {
        const reason = r.divergence?.reason ?? '';
        // A step the record itself marks as one it cannot repeat (screenshot pixels, text left out) ends the replay early.
        const at = record.steps.find((st) => st.seq === r.divergence?.seq);
        const unreplayable = !!at && (!!at.unreplayable || (at.targets ?? []).some((t) => !t.replayable));
        summary.replay = { outcome: unreplayable ? 'partial' : 'diverged', ...counts, at: r.divergence?.seq, op: r.divergence?.op, reason: text(reason) };
        checks.replay = unreplayable;
      }
      console.log(`Replayed from Node in a fresh session: ${summary.replay.outcome === 'replayed' ? `all ${counts.replayed} steps it repeats` : `${summary.replay.outcome} at step ${summary.replay.at} (${summary.replay.op}): ${summary.replay.reason}`}`);
    }
  }
} catch (e) {
  summary.error = text(e?.stack ?? e);
  checks.error = false;
  console.error(`model-smoke: ${summary.error}`);
} finally {
  if (replaySession) {
    const closed = await replaySession.close({ failed: checks.replay === false }).then(
      () => true,
      (e) => (console.error(`model-smoke: the replay's session did not close: ${text(e?.message ?? e)}`), false)
    );
    checks.replayClosed = closed;
  }
  // Nothing of this run may still be running before its folders go; if something is, they stay, and the run fails.
  checks.cleanup = await reap();
  if (checks.cleanup) {
    rmSync(CLIENT, { recursive: true, force: true });
    rmSync(SESSIONS, { recursive: true, force: true });
    rmSync(REPLAY_DIR, { recursive: true, force: true });
  } else console.error(`model-smoke: processes of this run are still running (or could not be listed); left ${CLIENT} and ${SESSIONS} in place`);
  checks.notInterrupted = !interrupted;
  summary.checks = checks;
  const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  summary.verdict = !pass ? 'fail' : summary.replay?.outcome === 'partial' ? 'pass (replay partial)' : summary.replay?.outcome === 'skipped' ? 'pass (replay skipped)' : 'pass';
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(RUN, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nmodel-smoke: ${summary.verdict.toUpperCase()}. Kept in ${RUN}`);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  if (!summary.verdict.startsWith('pass')) process.exitCode = 1;
}
