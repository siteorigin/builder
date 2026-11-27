/**
 * A disposable HTTPS Git host for the remote push tests (#1157): Node's HTTPS server, with a certificate made for the
 * run alone, in front of stock Git's `git http-backend`, serving one bare repository (`/site.git`). It asks for a
 * username and token (Basic), records every request it was sent, and can be told to answer the next request with a
 * redirect, or to drop the reply to a push once the push has landed (a connection lost after the server acted).
 *
 * Stock Git only plays the host here: the app never runs it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { detectSystemGit } from '../../src/main/git/system-git';

const found = await detectSystemGit();
/** Stock Git, found as the app finds one; null where none is installed. */
export const STOCK_GIT = found.status === 'present' ? found.path : null;
/** Whether the host can run here: stock Git and openssl, which CI always has. */
export const HOST_AVAILABLE = !!STOCK_GIT && spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

export interface SeenRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  /** The Authorization header, as sent, or null. */
  authorization: string | null;
  /** The bytes its body carried. */
  bytes: number;
}

export interface GitHost {
  /** The repository's address: `https://127.0.0.1:<port>/site.git`. */
  url: string;
  origin: string;
  /** The certificate a client must trust to reach it. */
  ca: string;
  /** Its key and certificate, for a second host the same `ca` reaches. */
  certs: { key: string; cert: string };
  /** The bare repository on disk. */
  bare: string;
  requests: SeenRequest[];
  /** Answer the next request with a 302 to this address (its path and query kept), then go back to serving. */
  redirectNext: string | null;
  /** Let the next push land, then close the connection without its reply. */
  dropNextPushReply: boolean;
  /** Run once when the next push arrives, before the host reads it (another push landing meanwhile, say). */
  beforeNextPush: (() => void) | null;
  /** Close the next connection as soon as its request arrives, before anything is answered. */
  resetNext: boolean;
  /** Stock Git in the bare repository, with none of this computer's settings. */
  git(args: string[], input?: string): string;
  close(): Promise<void>;
}

const cleanEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Stock Git',
  GIT_AUTHOR_EMAIL: 'stock@example.invalid',
  GIT_COMMITTER_NAME: 'Stock Git',
  GIT_COMMITTER_EMAIL: 'stock@example.invalid',
  GIT_AUTHOR_DATE: '1790000500 +0000',
  GIT_COMMITTER_DATE: '1790000500 +0000'
});

/** Run stock Git with a clean environment; throws with its error output when it fails. */
export function stockGit(args: string[], opts: { cwd: string; home: string; input?: string }): string {
  if (!STOCK_GIT) throw new Error('No stock Git: CI must have one.');
  const r = spawnSync(STOCK_GIT, args, { cwd: opts.cwd, encoding: 'utf8', input: opts.input, env: cleanEnv(opts.home), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

/** A key and a certificate for 127.0.0.1 and localhost, made for this run and valid for a day. */
function certificate(dir: string): { key: string; cert: string } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`openssl could not make a certificate: ${r.stderr}`);
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

/**
 * Start a host whose repository takes pushes from `username` with `password`. `certs` reuses another host's
 * certificate, so one `ca` reaches both.
 */
export async function startGitHost(opts: { username: string; password: string; certs?: { key: string; cert: string }; signInToPushOnly?: boolean }): Promise<GitHost> {
  const dir = mkdtempSync(join(tmpdir(), 'so-git-host-'));
  try {
    return await serve(dir, opts);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

async function serve(dir: string, opts: { username: string; password: string; certs?: { key: string; cert: string }; signInToPushOnly?: boolean }): Promise<GitHost> {
  const home = join(dir, 'home');
  const root = join(dir, 'repos');
  stockGit(['init', '--quiet', '--bare', join(root, 'site.git')], { cwd: dir, home: dir });
  const bare = join(root, 'site.git');
  // A host refuses what does not follow its branch, as GitHub and others do; the app must never rely on it.
  stockGit(['config', 'receive.denyNonFastForwards', 'true'], { cwd: bare, home: dir });
  const { key, cert } = opts.certs ?? certificate(dir);
  const expected = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
  const sockets = new Set<Duplex>();
  const children = new Set<ChildProcess>();

  const host: GitHost = {
    url: '',
    origin: '',
    ca: cert,
    certs: { key, cert },
    bare,
    requests: [],
    redirectNext: null,
    dropNextPushReply: false,
    beforeNextPush: null,
    resetNext: false,
    git: (args, input) => stockGit(args, { cwd: bare, home: dir, input }),
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(
        [...children].map(
          (c) =>
            new Promise<void>((resolve) => {
              if (c.exitCode !== null || c.signalCode !== null) return resolve();
              c.once('close', () => resolve());
              c.kill('SIGKILL');
            })
        )
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const server: Server = createServer({ key, cert }, (req, res) => {
    const path = req.url ?? '/';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    const seen: SeenRequest = { method: req.method ?? 'GET', path, authorization, bytes: 0 };
    host.requests.push(seen);
    req.on('data', (b: Buffer) => (seen.bytes += b.byteLength));
    if (host.resetNext) {
      host.resetNext = false;
      req.socket.destroy();
      return;
    }
    if (host.redirectNext) {
      const to = host.redirectNext + path;
      host.redirectNext = null;
      req.resume();
      res.writeHead(302, { Location: to }).end();
      return;
    }
    const isPushRequest = req.method === 'POST' && path.split('?')[0].endsWith('/git-receive-pack');
    if (authorization !== expected && (!opts.signInToPushOnly || isPushRequest || authorization !== null)) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git"' }).end('Sign in');
      return;
    }
    const url = new URL(path, 'https://host.invalid');
    const isPush = req.method === 'POST' && url.pathname.endsWith('/git-receive-pack');
    const drop = isPush && host.dropNextPushReply;
    if (drop) host.dropNextPushReply = false;
    if (isPush && host.beforeNextPush) {
      const before = host.beforeNextPush;
      host.beforeNextPush = null;
      before();
    }
    const cgi = spawn(STOCK_GIT!, ['http-backend'], {
      env: {
        ...cleanEnv(home),
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        // Signed in: http-backend takes pushes only from a user the server vouches for.
        REMOTE_USER: opts.username,
        REMOTE_ADDR: '127.0.0.1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {})
      }
    });
    children.add(cgi);
    cgi.once('close', () => children.delete(cgi));
    cgi.on('error', () => {
      if (!res.headersSent) res.writeHead(500).end('No http-backend');
    });
    cgi.stdin.on('error', () => undefined);
    cgi.stderr.resume();
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on('data', (b: Buffer) => out.push(b));
    cgi.on('close', () => {
      // The push has landed (or been refused) by now: a dropped reply is lost after the host acted.
      if (drop) {
        req.socket.destroy();
        return;
      }
      const all = Buffer.concat(out);
      const end = all.indexOf('\r\n\r\n') >= 0 ? all.indexOf('\r\n\r\n') : all.indexOf('\n\n');
      const sep = all.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
      const head = all.subarray(0, end).toString('latin1').split(/\r?\n/);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers).end(all.subarray(end + sep));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host.origin = `https://127.0.0.1:${port}`;
  host.url = `${host.origin}/site.git`;
  return host;
}
