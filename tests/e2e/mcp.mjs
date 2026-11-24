// The test driver over local stdio MCP (tests/driver/mcp.ts, issue #496), against the built app. Every step goes
// through an independent client, the official MCP SDK's, talking to `node tests/driver/mcp.ts` as Codex would: it
// initializes and lists the tools, starts a session at Welcome, inspects it, opens the New project dialog, fills its
// name and reads it back, captures the screen and fetches the image, cancels with Escape, recovers from a stale ref,
// sends input the driver refuses, and closes. A second session is then left open while the client disconnects: the
// server, its session host, the app and every process it started end, and the run's folder is removed. Checks outside
// the client (whether a process is alive, whether a folder exists) only read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_PATH } from '../driver/mcp.ts';
import { isAlive, processTable } from '../driver/processes.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('mcp');
let passed = false;
let client = null;
let transport = null;
const roots = [];

const connectClient = async () => {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', MCP_PATH], env: { WORK }, stderr: 'inherit' });
  client = new Client({ name: 'mcp-e2e', version: '1.0.0' });
  await client.connect(transport);
};
/** One tool call; a session start can take minutes on a cold machine. */
const tool = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
const reply = async (name, args) => {
  const r = await tool(name, args);
  assert.ok(r.structuredContent, `${name} answers with structured content`);
  assert.deepEqual(JSON.parse(r.content.at(-1).text), r.structuredContent, `${name}: the text is the same reply`);
  return r;
};
const ok = async (name, args) => {
  const r = await reply(name, args);
  assert.ok(!r.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(r.structuredContent.error ?? null)}`);
  assert.equal(r.structuredContent.ok, true);
  return r.structuredContent.result;
};
const refused = async (name, args, code) => {
  const r = await reply(name, args);
  assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} fails`);
  assert.equal(r.structuredContent.error.code, code, `${name}: ${r.structuredContent.error.message}`);
  return r.structuredContent.error;
};
const allGone = (pids, what, ms = 60_000) => eventually(() => assert.deepEqual(pids.filter(isAlive), [], `${what}: still running`), ms, 200);

try {
  step('initialize and discover the tools, with nothing launched yet');
  await connectClient();
  assert.equal(client.getServerVersion().name, 'siteorigin-builder-driver');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['session_start', 'session_describe', 'ui_snapshot', 'ui_locate', 'ui_waitFor', 'ui_click', 'ui_fill', 'ui_press', 'evidence_read', 'menu_invoke', 'desktop_setAnswers', 'session_close'])
    assert.ok(names.includes(n), `${n} is listed`);
  assert.match(tools.find((t) => t.name === 'desktop_setAnswers').description, /Kind: fixture/);
  assert.match(tools.find((t) => t.name === 'ui_click').description, /Kind: act/);
  assert.equal('headed' in tools.find((t) => t.name === 'session_start').inputSchema.properties, false, 'a window cannot be asked for');

  step('launch at Welcome, headless, and inspect it');
  const started = await ok('session_start', { fixture: 'welcome' });
  const first = started.session;
  roots.push(first.root);
  assert.equal(first.state, 'ready');
  assert.equal(first.headless, true);
  assert.ok(first.root.startsWith(WORK), `the run is in the client's WORK (${first.root})`);
  const welcome = await ok('ui_snapshot', { scope: 'editor' });
  assert.equal(welcome.context.screen, 'welcome');
  const workspace = (await ok('files_list', { path: 'workspace' })).entries.map((e) => e.name).sort();

  step('open New project, fill its name and read it back');
  const newProject = (await ok('ui_locate', { role: 'button', name: 'New project', scope: 'editor' })).node;
  const clicked = await ok('ui_click', { target: { ref: newProject.ref } });
  assert.equal(clicked.dispatched, 'complete');
  const dialog = (await ok('ui_waitFor', { role: 'dialog', name: 'New project', scope: 'editor' })).node;
  const field = (await ok('ui_locate', { role: 'textbox', name: 'Project name', within: dialog.ref })).node;
  await ok('ui_fill', { target: { ref: field.ref }, text: 'MCP smoke' });
  assert.equal((await ok('ui_locate', { ref: field.ref })).node.value, 'MCP smoke', 'the field holds what was filled');

  step('capture the screen and fetch the image');
  const shot = await ok('ui_snapshot', { scope: 'editor', maxNodes: 20, screenshot: true });
  assert.equal(shot.context.dialog?.name, 'New project');
  const editorShot = shot.screenshots.editor;
  assert.ok(editorShot?.id, `a screenshot was taken (${JSON.stringify(shot.screenshots)})`);
  const evidence = await reply('evidence_read', { id: editorShot.id });
  assert.ok(!evidence.isError, JSON.stringify(evidence.structuredContent.error ?? null));
  const image = evidence.content.find((c) => c.type === 'image');
  assert.equal(image?.mimeType, 'image/png', 'the image comes back as an image block');
  const png = Buffer.from(image.data, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [editorShot.width, editorShot.height], 'of the size the observation reported');
  const meta = evidence.structuredContent.result;
  assert.equal(meta.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(meta.bytes, png.length);
  assert.equal(JSON.stringify(evidence.structuredContent).includes(image.data), false, 'the base64 is only in the image block');
  await refused('evidence_read', { id: '9999-editor' }, 'BAD_REQUEST');

  step('cancel with Escape: Welcome again, nothing made');
  await ok('ui_press', { key: 'Escape' });
  assert.equal((await ok('ui_waitFor', { ref: dialog.ref, state: 'absent' })).state, 'absent');
  const back = await ok('ui_snapshot', { scope: 'editor', maxNodes: 20 });
  assert.equal(back.context.screen, 'welcome');
  assert.equal(back.context.dialog, null);
  assert.deepEqual((await ok('files_list', { path: 'workspace' })).entries.map((e) => e.name).sort(), workspace, 'nothing was created');

  step('a stale ref is refused with a reason, and a fresh observation recovers');
  const stale = await refused('ui_fill', { target: { ref: field.ref }, text: 'Too late' }, 'STALE_REF');
  assert.ok(stale.details?.reason && stale.details?.hint, `it says why and what to do (${JSON.stringify(stale.details)})`);
  await ok('ui_click', { target: { ref: (await ok('ui_locate', { role: 'button', name: 'New project', scope: 'editor' })).node.ref } });
  const again = (await ok('ui_waitFor', { role: 'dialog', name: 'New project', scope: 'editor' })).node;
  const fresh = (await ok('ui_locate', { role: 'textbox', name: 'Project name', within: again.ref })).node;
  assert.notEqual(fresh.ref, field.ref, 'the field in the reopened dialog has a ref of its own');
  await ok('ui_fill', { target: { ref: fresh.ref }, text: 'Recovered' });
  assert.equal((await ok('ui_locate', { ref: fresh.ref })).node.value, 'Recovered');
  await ok('ui_press', { key: 'Escape' });
  await ok('ui_waitFor', { role: 'dialog', name: 'New project', state: 'absent', scope: 'editor' });

  step('input the driver refuses is a tool error the session survives');
  await refused('ui_snapshot', { maxNodes: 0 }, 'BAD_REQUEST');
  await refused('ui_click', {}, 'BAD_REQUEST');
  await refused('ui_press', { key: 'Esc' }, 'BAD_REQUEST');
  await refused('session_start', { headed: true }, 'BAD_REQUEST');
  await refused('session_start', {}, 'ALREADY_STARTED');
  await assert.rejects(tool('ui.click', {}), /-32602|no tool/i, 'a tool that is not there is a protocol error');
  assert.equal((await ok('ui_snapshot', { scope: 'editor', maxNodes: 5 })).context.screen, 'welcome', 'and the session goes on');

  step('close: the app ends and the run is removed');
  const closed = await ok('session_close', {});
  assert.equal(closed.ended, 'quit');
  assert.equal(closed.artifacts, null, 'a run that passed keeps no artifacts');
  await allGone(first.processes, 'after session_close');
  assert.equal(existsSync(first.root), false, 'the run root is gone');

  step('a new session over the same connection, then the client disconnects without closing it');
  const second = (await ok('session_start', { fixture: 'welcome' })).session;
  roots.push(second.root);
  assert.notEqual(second.id, first.id, 'a session of its own');
  assert.ok(second.processes.every(isAlive), 'its app is running');
  const server = transport.pid;
  const host = (await processTable()).find((e) => e.ppid === server)?.pid;
  assert.ok(host && isAlive(host), 'a session host serves it');
  await client.close();
  client = null;
  await allGone([server, host, ...second.processes], 'after the client disconnected');
  await eventually(() => assert.equal(existsSync(second.root), false, 'the run root is gone'), 30_000);

  passed = true;
  console.log('\nmcp: PASS');
} finally {
  if (client) await client.close().catch(() => undefined);
  if (passed) cleanup();
  else console.log(`kept ${WORK} (runs: ${roots.join(', ')})`);
}
