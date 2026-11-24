/** The benchmark's `--provider local` path, through the real CLI, against the in-process mock server only. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LOCAL_PROFILE, LOCAL_MODEL_PROFILES } from '@agent/models';
import { EVAL_CASES } from '../../scripts/eval/cases';
import { runSuite } from '../../scripts/eval/harness';
import { resolveLocalRun } from '../../scripts/eval/local';
import { envelopeReply, MockOpenAIServer, textReply } from './mock-openai-server';

let server: MockOpenAIServer;
let dir: string;
beforeEach(async () => {
  server = await new MockOpenAIServer().start();
  dir = mkdtempSync(join(tmpdir(), 'so-eval-local-'));
});
afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

const CLOUD_KEYS = { OPENAI_API_KEY: 'sk-cloud-key-must-not-leave', ANTHROPIC_API_KEY: 'sk-ant-cloud-key-must-not-leave' };
const NO_KEYS = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };

function cli(args: string[], env: Record<string, string> = CLOUD_KEYS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.node.json', 'scripts/eval-agent.ts', ...args],
      { timeout: 60000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, stdout, stderr })
    );
  });
}

describe('resolveLocalRun', () => {
  it('uses the first model the server lists when none is named', async () => {
    server.models = { data: [{ id: 'first-model' }, { id: 'second-model' }] };
    const run = await resolveLocalRun({ baseURL: server.baseURL });
    expect(run).toMatchObject({ model: 'first-model', remote: false });
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
  });

  it('selects tool calling the way the app does', async () => {
    const auto = await resolveLocalRun({ baseURL: server.baseURL, model: 'm' });
    expect(auto.make().capabilities()).toMatchObject({ toolCalling: DEFAULT_LOCAL_PROFILE.toolCalling, contextWindowTokens: DEFAULT_LOCAL_PROFILE.contextWindow, maxOutputTokens: DEFAULT_LOCAL_PROFILE.maxOutput });
    const native = await resolveLocalRun({ baseURL: server.baseURL, model: 'm', toolMode: 'native' });
    expect(native.make().capabilities().toolCalling).toBe('native');
    await expect(resolveLocalRun({ baseURL: server.baseURL, model: 'm', toolMode: 'magic' })).rejects.toThrow(/tool-mode/);
  });

  it('applies the loopback rule and looks nothing up on another machine', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{"data":[]}');
    }) as typeof globalThis.fetch;
    await expect(resolveLocalRun({ baseURL: 'http://models.invalid/v1', model: 'm' }, fetch)).rejects.toThrow(/--allow-remote/);
    await expect(resolveLocalRun({ baseURL: 'http://models.invalid/v1', allowRemote: true }, fetch)).rejects.toThrow(/--model/);
    await expect(resolveLocalRun({ baseURL: 'http://models.invalid/v1', model: 'm', allowRemote: true }, fetch)).resolves.toMatchObject({ remote: true });
    expect(calls).toBe(0);
  });
});

describe('the benchmark uses the capability profile', () => {
  const heroCase = EVAL_CASES.filter((c) => c.id === 'copy-edit-hero-heading');
  const offered = () => JSON.stringify(server.requests.find((q) => q.method === 'POST')!.body.tools ?? server.requests.find((q) => q.method === 'POST')!.body.response_format);
  const suite = async (toolMode: string) => {
    const run = await resolveLocalRun({ baseURL: server.baseURL, model: 'profiled-native-model', toolMode });
    const capabilities = run.make().capabilities();
    await runSuite(heroCase, { adapterName: 'local', model: run.model, adapter: run.make }, capabilities);
    return capabilities;
  };
  const entry = { match: /^profiled-native-model$/, profile: { toolCalling: 'native' as const, contextWindow: 128000 } };
  beforeEach(() => void LOCAL_MODEL_PROFILES.push(entry));
  afterEach(() => void LOCAL_MODEL_PROFILES.splice(LOCAL_MODEL_PROFILES.indexOf(entry), 1));

  it('auto follows the model entry, which keeps the general tools', async () => {
    server.script(textReply('Nothing changed.'), textReply('Nothing changed.'));
    expect(await suite('auto')).toMatchObject({ toolCalling: 'native', contextWindowTokens: 128000 });
    expect(offered()).toContain('"apply_operations"');
  }, 60000);

  it('the constrained override gets the small tool set', async () => {
    server.script(envelopeReply('finish', { message: 'Nothing changed.' }), envelopeReply('finish', { message: 'Nothing changed.' }));
    expect((await suite('constrained-json')).toolCalling).toBe('constrained-json');
    expect(offered()).not.toContain('"apply_operations"');
  }, 60000);
});

describe('eval:agent --provider local', () => {
  it.each([
    ['no cloud keys set', NO_KEYS],
    ['cloud keys set', CLOUD_KEYS]
  ])('runs on loopback with no key, no cost warning and no --yes (%s)', async (_label, env) => {
    server.models = { data: [{ id: 'first-model' }, { id: 'second-model' }] };
    server.script(...Array.from({ length: 4 }, () => envelopeReply('finish', { message: 'Nothing changed.' })));
    const out = join(dir, 'report.json');
    const r = await cli(['--live', '--provider', 'local', '--base-url', server.baseURL, '--cases', 'copy-edit-hero-heading', '--out', out], env);
    // The mock changes nothing, so the case is graded as failed; the run itself completed.
    expect(r.code).toBe(1);
    expect(r.stderr).not.toMatch(/WARNING|cost|\$/);
    expect(server.requests.some((q) => q.method === 'GET' && q.url === '/v1/models')).toBe(true);
    const posts = server.requests.filter((q) => q.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].body.model).toBe('first-model');
    expect(posts[0].body.response_format.type).toBe('json_schema');
    expect(server.requests.every((q) => q.headers.authorization === undefined)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8')).adapter).toMatchObject({ name: 'local', model: 'first-model' });
  }, 90000);

  it('honors the tool mode flag', async () => {
    server.script(...Array.from({ length: 4 }, () => envelopeReply('finish', { message: 'Nothing changed.' })));
    await cli(['--live', '--provider', 'local', '--base-url', server.baseURL, '--model', 'test-model', '--tool-mode', 'native', '--cases', 'copy-edit-hero-heading', '--out', join(dir, 'native.json')]);
    const first = server.requests.find((q) => q.method === 'POST')!;
    expect(first.body.response_format).toBeUndefined();
    expect(first.body.tools.length).toBeGreaterThan(0);
  }, 90000);

  it('refuses another machine without --allow-remote, and asks before sending with it', async () => {
    // Every fetch the CLI attempts is logged, including one that would fail to resolve.
    const log = join(dir, 'fetches.log');
    const trap = join(dir, 'trap.mjs');
    writeFileSync(trap, `import { appendFileSync } from 'node:fs';\nconst real = globalThis.fetch;\nglobalThis.fetch = (...a) => { appendFileSync(${JSON.stringify(log)}, String(a[0]) + '\\n'); return real(...a); };\n`);
    const env = { ...CLOUD_KEYS, NODE_OPTIONS: `--import=${pathToFileURL(trap).href}` };
    const remote = ['--live', '--provider', 'local', '--base-url', 'http://models.invalid/v1', '--cases', 'copy-edit-hero-heading'];
    const refused = await cli([...remote, '--model', 'm', '--out', join(dir, 'a.json')], env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/--allow-remote/);
    const gated = await cli([...remote, '--allow-remote', '--model', 'm', '--out', join(dir, 'b.json')], env);
    expect(gated.code).toBe(2);
    expect(gated.stderr).toMatch(/another machine/);
    expect(gated.stderr).toMatch(/Nothing was sent/);
    const noModel = await cli([...remote, '--allow-remote', '--out', join(dir, 'c.json')], env);
    expect(noModel.code).toBe(2);
    expect(noModel.stderr).toMatch(/--model/);
    expect(existsSync(log)).toBe(false);
  }, 120000);

  it('keeps the cloud argument rules', async () => {
    const noModel = await cli(['--live', '--provider', 'openai']);
    expect(noModel.code).toBe(2);
    expect(noModel.stderr).toContain('--live needs --provider and --model.');
    const localFlag = await cli(['--live', '--provider', 'openai', '--model', 'm', '--allow-remote']);
    expect(localFlag.code).toBe(2);
    expect(localFlag.stderr).toMatch(/only to --provider local/);
    // A cloud key is never pointed at another server, here the local mock.
    for (const provider of ['openai', 'anthropic']) {
      const redirected = await cli(['--live', '--provider', provider, '--model', 'm', '--base-url', server.baseURL, '--yes', '--cases', 'copy-edit-hero-heading', '--out', join(dir, `${provider}.json`)]);
      expect(redirected.code).toBe(2);
      expect(redirected.stderr).toMatch(/--base-url.*only to --provider local/);
    }
    expect(server.requests).toEqual([]);
  }, 60000);
});
