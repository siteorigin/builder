// The test session's request handling and the stdio host around it (tests/driver/session.ts, host.ts, client.ts),
// without launching the app: requests are answered one at a time, a start can be cut short by a deadline or by
// closing, the client going away closes the session, and only what the session made is removed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from '../driver/client.ts';
import { serve } from '../driver/host.ts';
import type { HostedSession } from '../driver/host.ts';
import type { Failure, Reply, Success } from '../driver/protocol.ts';
import { OPERATIONS, Session, isInside, sessionEnv } from '../driver/session.ts';
import type { StartPhase } from '../driver/session.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'driver-host-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A checkout with a built app that is never launched: enough for a session to start making its folders. */
const appRoot = join(scratch, 'app');
mkdirSync(join(appRoot, 'out', 'main'), { recursive: true });
mkdirSync(join(appRoot, 'out', 'renderer'), { recursive: true });
writeFileSync(join(appRoot, 'out', 'main', 'index.js'), '// main');
writeFileSync(join(appRoot, 'out', 'renderer', 'index.html'), '<!doctype html>');
writeFileSync(join(appRoot, 'package.json'), '{"version":"9.9.9"}');

let n = 0;
const req = (op: string, extra: Record<string, unknown> = {}) => ({ v: 1, id: `t${++n}`, op, ...extra });
const ok = <T>(r: Reply): Success<T> => {
  if (!r.ok) throw new Error(`${r.op} failed: ${r.error.code} ${r.error.message}`);
  return r as Success<T>;
};
const err = (r: Reply): Failure => {
  if (r.ok) throw new Error(`${r.op} succeeded`);
  return r;
};

/** A session whose start stops at `phase` until released, in a parent folder of its own. */
function heldSession(phase: StartPhase) {
  const parentDir = mkdtempSync(join(scratch, 'parent-'));
  let release!: () => void;
  let reached!: () => void;
  const atPhase = new Promise<void>((r) => (reached = r));
  const held = new Promise<void>((r) => (release = r));
  const session = new Session({ appRoot, parentDir, hooks: { phase: (p) => (p === phase ? (reached(), held) : undefined) } });
  return { session, parentDir, atPhase, release };
}

describe('a session before it starts', () => {
  it('describes itself and every operation, with its kind and deadline', async () => {
    const s = new Session({ appRoot });
    const d = ok<any>(await s.call(req('session.describe'))).result;
    expect(d.protocol).toBe(1);
    expect(d.session).toMatchObject({ id: s.id, state: 'new', root: null, pid: null, processes: [], window: null });
    expect(d.capabilities.map((c: any) => [c.op, c.kind])).toEqual([
      ['session.start', 'session'],
      ['session.describe', 'session'],
      ['window.info', 'observe'],
      ['session.close', 'session']
    ]);
    for (const c of d.capabilities) expect(c.defaultTimeoutMs).toBe(OPERATIONS[c.op].defaultTimeoutMs);
  });

  it('answers what it cannot do with the matching error', async () => {
    const s = new Session({ appRoot });
    expect(err(await s.call(req('window.info'))).error.code).toBe('NOT_STARTED');
    expect(err(await s.call(req('window.click'))).error).toMatchObject({ code: 'UNKNOWN_OP', details: { ops: Object.keys(OPERATIONS) } });
    const broken = err(await s.call('{"v":1,'));
    expect([broken.id, broken.error.code]).toEqual([null, 'BAD_REQUEST']);
    expect(err(await s.call(req('session.start', { args: { fixture: 'unknown' } }))).error.code).toBe('BAD_REQUEST');
    expect(err(await s.call(req('session.start', { args: { artifactsDir: 'relative/path' } }))).error.code).toBe('BAD_REQUEST');
    expect(err(await s.call(req('session.start', { args: { colour: 'red' } }))).error.code).toBe('BAD_REQUEST');
    expect(s.state).toBe('new');
  });

  it('refuses to start without a built app, leaving nothing behind', async () => {
    const parentDir = mkdtempSync(join(scratch, 'parent-'));
    const s = new Session({ appRoot: join(scratch, 'no-build'), parentDir });
    expect(err(await s.call(req('session.start'))).error.code).toBe('BUILD_MISSING');
    expect(readdirSync(parentDir)).toEqual([]);
  });
});

describe('starting', () => {
  it('runs one request at a time, and a close ends a start under way and removes its folders', async () => {
    const { session, parentDir, atPhase } = heldSession('root');
    const starting = session.call(req('session.start'));
    await atPhase;
    const root = session.paths!.root;
    expect(existsSync(join(root, 'profile'))).toBe(true);
    const busy = err(await session.call(req('session.describe')));
    expect(busy.error).toMatchObject({ code: 'BUSY', retryable: true });
    const closed = ok<any>(await session.call(req('session.close')));
    expect(closed.result).toMatchObject({ artifacts: null, removed: [root], processes: [], ended: 'not-started' });
    expect(err(await starting).error.code).toBe('CLOSED');
    expect(readdirSync(parentDir)).toEqual([]);
    expect(err(await session.call(req('window.info'))).error.code).toBe('CLOSED');
    // Closing again gives the same answer and does nothing more.
    expect(ok<any>(await session.call(req('session.close'))).result).toEqual(closed.result);
  });

  it('a start past its deadline ends the session, keeping its failure artifacts and nothing else', async () => {
    const { session, parentDir } = heldSession('provider');
    const r = err(await session.call(req('session.start', { timeoutMs: 300 })));
    expect(r.error).toMatchObject({ code: 'TIMEOUT', retryable: false, details: { phase: 'provider', sessionState: 'closed' } });
    const artifacts = r.error.details!.artifacts as string;
    expect(isInside(parentDir, artifacts)).toBe(true);
    expect(readdirSync(artifacts).sort()).toEqual(['app.log', 'session.json']);
    const root = session.paths!.root;
    expect(readdirSync(root).sort()).toEqual(['.siteorigin-test-session.json', 'artifacts']);
    expect(session.state).toBe('closed');
  });

  it('keeps nothing when told to keep nothing', async () => {
    const { session, parentDir } = heldSession('provider');
    const r = err(await session.call(req('session.start', { timeoutMs: 300, args: { keepArtifacts: 'never' } })));
    expect(r.error.code).toBe('TIMEOUT');
    expect(r.error.details!.artifacts).toBeNull();
    expect(readdirSync(parentDir)).toEqual([]);
  });

  it('puts artifacts in a child of a caller-owned folder and never removes the folder itself', async () => {
    const callerDir = mkdtempSync(join(scratch, 'caller-'));
    writeFileSync(join(callerDir, 'sentinel.txt'), 'the caller’s');
    for (const keepArtifacts of ['always', 'never']) {
      const { session, parentDir, atPhase } = heldSession('root');
      const starting = session.call(req('session.start', { args: { artifactsDir: callerDir, keepArtifacts } }));
      await atPhase;
      expect(session.paths!.artifacts).toBe(join(callerDir, session.id));
      const closed = ok<any>(await session.call(req('session.close')));
      await starting;
      expect(readdirSync(parentDir)).toEqual([]);
      expect(existsSync(join(callerDir, 'sentinel.txt'))).toBe(true);
      expect(existsSync(join(callerDir, session.id))).toBe(keepArtifacts === 'always');
      expect(closed.result.artifacts).toBe(keepArtifacts === 'always' ? join(callerDir, session.id) : null);
    }
  });

  it('leaves a run folder alone once it no longer carries the session’s mark', async () => {
    const { session, atPhase } = heldSession('root');
    const starting = session.call(req('session.start', { args: { keepArtifacts: 'never' } }));
    await atPhase;
    const root = session.paths!.root;
    writeFileSync(join(root, '.siteorigin-test-session.json'), JSON.stringify({ sessionId: 'someone-else' }));
    expect(err(await session.call(req('session.close'))).error.code).toBe('CLEANUP_FAILED');
    await starting;
    expect(existsSync(join(root, 'profile'))).toBe(true);
  });
});

describe('the app environment', () => {
  it('passes on only what an app needs to run, then the session’s own folders, headless', () => {
    const paths = { root: '/r', profile: '/r/profile', workspace: '/r/workspace', projects: '/r/workspace/SiteOrigin', home: '/r/home', tmp: '/r/tmp', artifacts: '/r/artifacts' };
    const base = {
      PATH: '/bin',
      LANG: 'en_ZA.UTF-8',
      LC_ALL: 'C',
      HOME: '/Users/me',
      OPENAI_API_KEY: 'sk-real',
      ANTHROPIC_API_KEY: 'sk-ant-real',
      SITEORIGIN_USER_DATA: '/Users/me/Library/SiteOrigin',
      SITEORIGIN_HEADED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      NODE_OPTIONS: '--require evil.js',
      npm_config_registry: 'https://example.invalid',
      AWS_SECRET_ACCESS_KEY: 'secret'
    };
    const env = sessionEnv(paths, { base });
    expect(env).toEqual({
      PATH: '/bin',
      LANG: 'en_ZA.UTF-8',
      LC_ALL: 'C',
      HOME: '/r/home',
      USERPROFILE: '/r/home',
      TMPDIR: '/r/tmp',
      TMP: '/r/tmp',
      TEMP: '/r/tmp',
      XDG_CONFIG_HOME: '/r/home/.config',
      XDG_CACHE_HOME: '/r/home/.cache',
      XDG_DATA_HOME: '/r/home/.local/share',
      SITEORIGIN_USER_DATA: '/r/profile',
      SITEORIGIN_DOCUMENTS: '/r/workspace',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      SITEORIGIN_HEADLESS: '1'
    });
    expect(sessionEnv(paths, { base, headed: true })).toMatchObject({ SITEORIGIN_HEADED: '1' });
    expect(sessionEnv(paths, { base, headed: true }).SITEORIGIN_HEADLESS).toBeUndefined();
  });
});

describe('the stdio host', () => {
  function fakeSession(answer: (frame: string) => Promise<Reply> | Reply) {
    const calls: string[] = [];
    let closes = 0;
    const session: HostedSession = {
      call: async (frame) => {
        calls.push(String(frame));
        return answer(String(frame));
      },
      close: async () => {
        closes++;
      }
    };
    return { session, calls, closes: () => closes };
  }
  const reply = (frame: string, extra: Partial<Success> = {}): Success => {
    const f = JSON.parse(frame);
    return { v: 1, id: f.id, op: f.op, ok: true, sessionId: 's', window: null, elapsedMs: 0, events: [], result: null, ...extra };
  };

  it('answers each line with one reply line, and ends once the session is closed', async () => {
    const fake = fakeSession((frame) => reply(frame));
    const input = new PassThrough();
    const lines: string[] = [];
    const ended = new Promise<string>((resolve) => serve({ session: fake.session, input, write: (line, done) => (lines.push(line), done()), onEnd: (reason) => resolve(reason) }));
    input.write('{"v":1,"id":"a","op":"session.describe"}\n\n   \n');
    input.write('{"v":1,"id":"b","op":"session.close"}\n');
    expect(await ended).toBe('closed');
    expect(fake.calls).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['a', 'b']);
    expect(fake.closes()).toBe(1);
  });

  it('closes the session when the client goes away, even with a request still running', async () => {
    let finish!: () => void;
    const fake = fakeSession((frame) => new Promise<Reply>((r) => (finish = () => r(reply(frame)))));
    const input = new PassThrough();
    const lines: string[] = [];
    const ended = new Promise<string>((resolve) => serve({ session: fake.session, input, write: (line, done) => (lines.push(line), done()), onEnd: (reason) => resolve(reason) }));
    input.write('{"v":1,"id":"a","op":"session.start"}\n');
    await new Promise((r) => setTimeout(r, 20));
    input.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.closes()).toBe(1);
    finish();
    expect(await ended).toBe('disconnected');
    expect(lines).toEqual([]);
  });

  it('a client disconnecting mid-start closes a real session and removes its folders', async () => {
    const { session, parentDir, atPhase } = heldSession('root');
    const input = new PassThrough();
    const ended = new Promise<string>((resolve) => serve({ session, input, write: (_line, done) => done(), onEnd: (reason) => resolve(reason) }));
    input.write(`${JSON.stringify(req('session.start'))}\n`);
    await atPhase;
    expect(readdirSync(parentDir)).toHaveLength(1);
    input.end();
    expect(await ended).toBe('disconnected');
    expect(session.state).toBe('closed');
    expect(readdirSync(parentDir)).toEqual([]);
  });

  it('runs as a process a client talks to, and exits once the client is gone', async () => {
    const client = await connect({ stderr: 'ignore' });
    client.sendRaw('this is not json');
    const d = ok<any>(await client.request('session.describe'));
    expect(d.result.session.state).toBe('new');
    expect(err(await client.request('window.info')).error.code).toBe('NOT_STARTED');
    expect(client.unmatched.map((r) => [r.id, !r.ok && r.error.code])).toEqual([[null, 'BAD_REQUEST']]);
    expect(await client.disconnect()).toEqual({ code: 0, signal: null });
    await expect(client.request('session.describe')).rejects.toThrow(/exited/);
  }, 30000);
});
