// The model-driven smoke test (issue #498): an external model, Codex, with only the test driver's published MCP tools
// (tests/driver/mcp.ts) and no knowledge of this repository, explores a fresh session of the built app and takes the
// principal journey: creates a site, edits it, asks the Builder assistant a question, asks it for an edit, answers its
// request to change more, looks at the answer and the preview, undoes and redoes, exports, and checks what was saved.
//
// It costs Codex usage, so it is never part of `npm test` or `npm run test:e2e`: run it on purpose, after `npm run build`.
//
//   npm run test:model-smoke                # the journey (MODEL=gpt-6.2-sol EFFORT=medium by default)
//   npm run test:model-smoke -- --probe     # only checks that Codex starts with the Builder tools and nothing else
//
// Codex runs in an empty folder outside the checkout with a read-only sandbox, its shell, browser, image, app, plugin
// and sub-agent tools turned off, no user configuration or rules, and one MCP server: the Builder driver, whose own tools
// are approved (they only reach the disposable session). The verdict never trusts what the model says it did:
// - its transcript must hold only Builder tool calls (any other tool, even an attempt, fails the run);
// - the session's own record (replay.json) must prove the journey (tests/coverage/journey-proof.ts), the same check
//   tests/e2e/journeys.mjs holds the deterministic journey to;
// - the record is then replayed from Node in a fresh session (tests/driver/replay.ts), and the result reported.
//
// Everything is kept in .tmp/model-smoke/<run>/: transcript.jsonl (every event, with host paths, credentials and image
// data taken out), evidence/ (the session's replay.json and screenshots), proof.txt and summary.json.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describeProof, proveJourney } from '../tests/coverage/journey-proof.ts';
import { hideDeep, machineRoots, pathHider } from '../tests/driver/evidence.ts';
import { codexConfig, thisNode } from '../tests/driver/mcp.ts';
import { replay } from '../tests/driver/replay.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROBE = process.argv.includes('--probe');
const NO_REPLAY = process.argv.includes('--no-replay');
const MODEL = process.env.MODEL ?? 'gpt-6.2-sol';
const EFFORT = process.env.EFFORT ?? 'medium';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MIN ?? (PROBE ? 5 : 60)) * 60_000;
const SERVER = 'siteorigin_builder';

/** Codex's own tools that could read or change anything outside the Builder session: all turned off. */
const DISABLED = ['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'multi_agent', 'multi_agent_v2'];
/** Transcript items that are not tool use. */
const TALK = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = join(ROOT, '.tmp', 'model-smoke', `${stamp}${PROBE ? '-probe' : ''}`);
const CLIENT = join(RUN, 'client');
const SESSIONS = join(RUN, 'sessions');
const EVIDENCE = join(RUN, 'evidence');
mkdirSync(CLIENT, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

const hide = pathHider([{ path: CLIENT, label: '<client>' }, { path: SESSIONS, label: '<sessions>' }, { path: RUN, label: '<run>' }, { path: ROOT, label: '<repo>' }, ...machineRoots()]);
const CREDENTIAL = /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;
/** An event as it is kept: host paths named by label, anything like a credential and any image data taken out. */
function redact(event) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      if (v.type === 'image' && typeof v.data === 'string') return { type: 'image', mimeType: v.mimeType, bytes: Math.floor((v.data.length * 3) / 4), data: '[image data left out]' };
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
    }
    return typeof v === 'string' ? v.replace(CREDENTIAL, '[redacted]') : v;
  };
  return hideDeep(strip(event), hide);
}

const NAME = 'Lantern Lane Bakery';
const HEADING = 'Fresh bread from the lantern oven';
const QUESTION = 'What does the main heading on the home page say?';
const ANSWER = `It says “${HEADING}”.`;
const NEW_NAME = 'Lantern Lane Kitchen';

const PROMPT = PROBE
  ? `You have MCP tools from a server called ${SERVER}. Call its session_describe tool once, then reply with the word DONE and the number of ${SERVER} tools you can see. Do not call any other tool.`
  : `You are testing SiteOrigin Builder, a desktop website builder, through the ${SERVER} MCP tools. They drive a disposable, headless copy of the app as a person would. Use only those tools: no shell, no files, no web. Discover what you need from the tools' descriptions and from what the app shows you (ui_snapshot, ui_locate); act on the controls a person would use.

Do this, checking each outcome before moving on:
1. Start a new session at the Welcome screen with keepArtifacts "always", and look at what it offers.
2. Create a new website called "${NAME}" from Welcome, keeping the defaults, and wait until its preview is ready.
3. On the home page, change the main heading to exactly "${HEADING}" (select the hero section, edit its Heading in the Inspector, and leave the field so it is committed). Confirm it was saved: project_summary with find "${HEADING}" should find it.
4. Open the AI assistant panel. The assistant inside the app is scripted: before each message you send it, set its reply with assistant_script. Switch the next message to Ask (a read-only question), script the reply with scenario "read-and-answer" and params { "text": "${ANSWER}" }, then type and send: "${QUESTION}". Wait for its run to finish and read its answer as the chat shows it.
5. Switch the next message back to Edit, with the hero section still selected. Script scenario "widen" with params { "question": "May I rename the whole site?", "siteName": "${NEW_NAME}", "then": "Renamed the site." }, then send: "Rename the site to ${NEW_NAME}". The assistant will ask to change more than the selection: allow it. Wait for the run to finish, then check the preview shows the new name.
6. Undo once with the app's own Undo, and check the site name in the preview went back. Then Redo, and check the new name is back.
7. Export the website as files to a folder. When the app asks for a folder, answer its chooser with desktop_setAnswers: an open dialog, selection "folder", paths ["exports"]. Wait for the export to finish, then check with exports_inspect that the exported files contain "${HEADING}".
8. Call evidence_save, then session_close with keepArtifacts "always".

If something fails, read the error's details and hint, observe again, and try another way a person would. Finish with a short report: each step, what you checked, and anything that surprised you.`;

function codexArgs() {
  const node = thisNode();
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
    `${server}.command=${toml(node)}`,
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

/** Run Codex to the end (or the deadline), keeping its events redacted as they arrive. */
async function runCodex() {
  const out = createWriteStream(join(RUN, 'transcript.jsonl'));
  const events = [];
  let tail = '';
  const child = spawn('codex', codexArgs(), { cwd: CLIENT, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const stop = (sig) => {
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => {
    console.error(`model-smoke: Codex ran past ${TIMEOUT_MS / 60000} minutes; stopping it`);
    stop('SIGTERM');
    setTimeout(() => stop('SIGKILL'), 15000).unref();
  }, TIMEOUT_MS);
  const onSignal = (sig) => {
    stop(sig);
    process.exitCode = 1;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
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
    const kept = redact(event);
    events.push(kept);
    out.write(`${JSON.stringify(kept)}\n`);
    const item = kept.item;
    if (kept.type === 'item.completed' && item?.type === 'mcp_tool_call') console.log(`  ${item.tool}${item.status === 'failed' || item.error ? ' (failed)' : ''}`);
  });
  const code = await new Promise((done) => child.on('close', (c) => done(c ?? 1)));
  clearTimeout(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await new Promise((done) => out.end(done));
  return { code, events, stderrTail: hide(tail) };
}

/** Every tool the model used or tried: only the Builder server's are allowed. */
function audit(events) {
  const calls = [];
  const foreign = [];
  for (const e of events) {
    if (e.type !== 'item.completed' && e.type !== 'item.started') continue;
    const item = e.item ?? {};
    if (TALK.has(item.type)) continue;
    if (item.type === 'mcp_tool_call' && item.server === SERVER) {
      if (e.type === 'item.completed') calls.push({ tool: item.tool, ok: item.status !== 'failed' && !item.error });
      continue;
    }
    foreign.push(`${item.type}${item.server ? ` ${item.server}` : ''}${item.tool ? ` ${item.tool}` : ''}${item.command ? `: ${String(item.command).slice(0, 80)}` : ''}`);
  }
  return { calls, foreign: [...new Set(foreign)] };
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

/** Processes still running from this run's sessions: there should be none once Codex has gone. */
function leftovers() {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('pgrep', ['-f', SESSIONS], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const summary = { run: hide(RUN), probe: PROBE, model: MODEL, effort: EFFORT, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() };
let verdict = false;
try {
  if (!existsSync(join(ROOT, 'out/main/index.js'))) throw new Error('No built app in out/: run `npm run build` first.');
  summary.codex = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
  summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  summary.dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  console.log(`model-smoke: ${PROBE ? 'probe' : 'journey'} with ${MODEL} (${EFFORT}), ${summary.codex}; run folder ${RUN}`);
  if (process.env.SMOKE_PRINT_CONFIG) console.log(codexConfig());

  const { code, events, stderrTail } = await runCodex();
  summary.codexExit = code;
  const { calls, foreign } = audit(events);
  summary.toolCalls = calls.length;
  summary.failedToolCalls = calls.filter((c) => !c.ok).length;
  summary.tools = Object.fromEntries([...new Set(calls.map((c) => c.tool))].sort().map((t) => [t, calls.filter((c) => c.tool === t).length]));
  summary.foreignTools = foreign;
  const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage).filter(Boolean);
  if (usage.length) summary.usage = usage.at(-1);
  const final = events.filter((e) => e.item?.type === 'agent_message').at(-1)?.item?.text ?? '';
  writeFileSync(join(RUN, 'report.md'), `${final}\n`);
  if (code !== 0) console.error(`model-smoke: Codex exited ${code}\n${stderrTail}`);
  if (foreign.length) console.error(`model-smoke: the model used tools other than the Builder's: ${foreign.join('; ')}`);

  if (PROBE) {
    verdict = code === 0 && !foreign.length && calls.some((c) => c.tool === 'session_describe' && c.ok);
    console.log(`model-smoke probe: ${verdict ? 'Codex reached the Builder tools and nothing else' : 'FAILED'}\n${final}`);
  } else {
    const kept = records();
    if (!kept.length) throw new Error('The session kept no replay.json: did the model close it with keepArtifacts "always"?');
    const { path: recordPath, record } = kept.at(-1);
    const sessionDir = resolve(recordPath, '..');
    cpSync(sessionDir, EVIDENCE, { recursive: true });
    summary.record = { file: 'evidence/replay.json', sha256: createHash('sha256').update(readFileSync(recordPath)).digest('hex'), steps: record.steps.length, complete: record.complete, fixture: record.scenario.fixture, build: record.build?.fingerprint ?? null };
    const proof = proveJourney(record);
    const proofText = describeProof(proof);
    writeFileSync(join(RUN, 'proof.txt'), `${proofText}\n`);
    summary.proof = Object.fromEntries(proof.witnesses.map((w) => [w.id, w.seq]));
    console.log(`\nThe session's record:\n${proofText}`);
    verdict = code === 0 && !foreign.length && proof.ok;
    if (!NO_REPLAY) {
      const replayDir = join(RUN, 'replay');
      mkdirSync(replayDir, { recursive: true });
      const r = await replay(record, { session: { parentDir: replayDir } });
      try {
        summary.replay = r.ok ? { ok: true, replayed: r.steps.filter((s) => s.status === 'replayed').length, skipped: r.steps.filter((s) => s.status === 'skipped').length } : { ok: false, at: r.divergence?.seq, op: r.divergence?.op, reason: hide(r.divergence?.reason ?? '') };
        if (r.ok) {
          const again = await r.session.call({ v: 1, id: 'smoke-check', op: 'project.summary', args: { find: HEADING } });
          summary.replay.project = again.ok ? { site: again.result.project?.site?.name ?? null, found: again.result.project?.find?.matches.length ?? 0 } : again.error.code;
        }
      } finally {
        await r.session.close({ failed: !r.ok }).catch(() => undefined);
      }
      console.log(`Replayed from Node in a fresh session: ${summary.replay.ok ? `all ${summary.replay.replayed} steps it repeats` : `diverged at step ${summary.replay.at} (${summary.replay.op}): ${summary.replay.reason}`}`);
    }
  }
} catch (e) {
  summary.error = hide(String(e?.stack ?? e));
  console.error(`model-smoke: ${summary.error}`);
} finally {
  const left = leftovers();
  summary.leftoverProcesses = left.length;
  if (left.length) {
    console.error(`model-smoke: ${left.length} processes of this run were still running; ending them`);
    for (const pid of left) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
  rmSync(CLIENT, { recursive: true, force: true });
  rmSync(SESSIONS, { recursive: true, force: true });
  rmSync(join(RUN, 'replay'), { recursive: true, force: true });
  summary.verdict = verdict && !left.length ? 'pass' : 'fail';
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(RUN, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nmodel-smoke: ${summary.verdict.toUpperCase()}. Kept in ${RUN}`);
  if (summary.verdict !== 'pass') process.exitCode = 1;
}
