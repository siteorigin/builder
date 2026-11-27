/**
 * Pushing a publication to a host (#1157), in a Git worker: the bundled Git's push, over HTTPS alone, of one pinned
 * commit to one branch (`refs/heads/siteorigin-publish`, there under the same name), fast-forward only. No tag follows
 * it, no other branch goes with it, and nothing is ever forced: a host whose branch holds a commit the publication
 * does not follow is told nothing and left as it is (`diverged`).
 *
 * The commit pushed must be the one the publication's branch points at as the push begins, so a saved version's
 * commit, whose history holds drafts and everything else a publication leaves out, can never be sent. What is sent is
 * that commit and what it holds that the host does not have yet, worked out from the host's own branches.
 *
 * The HTTP client is the app's own: it sends only the push's two requests (the host's list of branches, then the push
 * itself), to the approved repository alone, and follows no redirect, to the same host or any other: the bundled Git
 * would ask for a credential at one address and send the push to the first, so a redirect is refused before anything
 * else is sent (`redirect-refused`). The credential is given only after the host asks for one at that address, as
 * Basic authentication; it is never put in an address, a file or an error, and nothing the host says is passed on
 * either, since a host's error page or hook can repeat a credential.
 *
 * The repository is read through a view that writes nothing (the bundled Git would record where it left the host's
 * branch as a branch of its own, which the app does not keep). Once the push has been sent, a failure (a lost
 * connection, a reply that cannot be read, the push stopped) leaves whether the host moved its branch unknown:
 * `outcome-unknown`, which the caller settles by asking the host where its branch is (remoteTip).
 */
import { once } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import git, { type GitHttpRequest, type GitHttpResponse, type HttpClient, type PromiseFsClient } from 'isomorphic-git';
import { approveEndpoint, GitError, OID_RE, PUBLISH_BRANCH, remoteAuthOk, type GitErrorCode, type Oid, type PushReply, type RemoteTarget } from './protocol';
import type { Repo } from './repo';
import type { RepoFs } from './fs';

/** How Git names a branch that is not there. */
const NONE = '0'.repeat(40);
/** The most a host's answer may hold: a list of its branches, or a push's report. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface RemoteOptions {
  /** For tests only: the one certificate authority a host is trusted under. The app trusts the system's. */
  ca?: string;
}

/** `target` as a push may use it, or throws `invalid`: an approved address, as approved; the publication's branch; a credential or none. */
export function checkTarget(target: unknown): RemoteTarget {
  const t = target as RemoteTarget;
  if (!t || typeof t !== 'object' || typeof t.url !== 'string' || approveEndpoint(t.url) !== t.url) throw new GitError('invalid', 'A push needs an approved repository address.');
  if (t.ref !== PUBLISH_BRANCH) throw new GitError('invalid', 'A website is only pushed to its publication branch.');
  if (t.auth !== null && !remoteAuthOk(t.auth)) throw new GitError('invalid', 'That credential cannot be sent.');
  return { url: t.url, ref: PUBLISH_BRANCH, auth: t.auth ? { username: t.auth.username, password: t.auth.password } : null };
}

/** A response's headers as the bundled Git reads them: one string each. */
function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** A response's body, given up once it holds more than any Git host sends. */
async function* bounded(res: IncomingMessage): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    n += chunk.byteLength;
    if (n > MAX_RESPONSE_BYTES) {
      res.destroy();
      throw new GitError('unreachable', 'The host answered with more than a Git host sends.');
    }
    yield chunk;
  }
}

/** Send a request's body, waiting whenever the connection is full, then end it. */
async function sendBody(req: ClientRequest, body: GitHttpRequest['body']) {
  if (body) for await (const chunk of body) if (!req.write(chunk)) await once(req, 'drain');
  req.end();
}

interface RemoteHttp extends HttpClient {
  /** Close every connection still open (a reply the bundled Git did not read to its end). */
  close(): void;
}

/**
 * The push's HTTP client for the repository at `endpoint`: its two requests and nothing else, over HTTPS, the host's
 * certificate checked as ever. `posting` is told just before the push itself is sent.
 */
function remoteHttp(endpoint: string, opts: { ca?: string; signal: AbortSignal; posting?: () => void }): RemoteHttp {
  const discovery = `${endpoint}/info/refs?service=git-receive-pack`;
  const push = `${endpoint}/git-receive-pack`;
  const open = new Set<ClientRequest>();
  return {
    async request({ url, method = 'GET', headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
      if (!((method === 'GET' && url === discovery) || (method === 'POST' && url === push))) throw new GitError('invalid', 'The push asked to reach an address other than the repository’s.');
      if (opts.signal.aborted) throw new GitError('cancelled', 'The push was stopped.');
      if (method === 'POST') opts.posting?.();
      // No connection is kept for another request: each is the repository's own, with this push's trust.
      const req = httpsRequest(url, { method, headers, signal: opts.signal, agent: false, ...(opts.ca ? { ca: opts.ca } : {}) });
      open.add(req);
      req.once('close', () => open.delete(req));
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        req.once('response', resolve);
        req.once('error', reject);
        sendBody(req, body).catch((e: unknown) => req.destroy(e instanceof Error ? e : new Error(String(e))));
      });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        req.destroy();
        throw new GitError('redirect-refused', 'The host answered with a redirect to another address, which is never followed, so nothing was sent there.');
      }
      return { url, method, statusCode: status, statusMessage: res.statusMessage ?? '', headers: flatHeaders(res), body: bounded(res) };
    },
    close() {
      for (const req of open) req.destroy();
      open.clear();
    }
  };
}

/** The bundled Git's sign-in callbacks: the credential, given only for the repository itself, once; none after it is refused. */
function signIn(target: RemoteTarget) {
  return {
    onAuth: (url: string) => (url === target.url && target.auth ? { username: target.auth.username, password: target.auth.password } : undefined),
    onAuthFailure: () => undefined
  };
}

/**
 * The repository's files as a push reads them: every read the bundled Git makes, and no write. The one write a push
 * makes once it has landed, a note of where it left the host's branch (`refs/remotes/origin/…`), is taken and dropped.
 */
function readOnly(gitdir: string, files: RepoFs['promises']): PromiseFsClient {
  const note = join(gitdir, 'refs', 'remotes', 'origin', PUBLISH_BRANCH.slice('refs/heads/'.length));
  let noted = false;
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error('A push never writes to the versions repository.'), { code: 'EROFS' });
  };
  return {
    promises: {
      ...files,
      writeFile: async (path: string) => {
        if (path === note && !noted) {
          noted = true;
          return;
        }
        return refuse();
      },
      mkdir: refuse,
      rmdir: refuse,
      unlink: refuse,
      symlink: refuse,
      chmod: refuse
    }
  };
}

const TLS_CODES = /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_|ERR_SSL_)/;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED']);

/**
 * A failure of a push, or of a look at the host's branch, in the app's words, never the host's or the bundled Git's
 * (either can repeat a credential). After the push was sent, anything but the host's own report is `outcome-unknown`.
 */
function remoteFailure(e: unknown, at: { posted: boolean; signal: AbortSignal; previous?: Oid | null }): GitError {
  const fail = (code: GitErrorCode, message: string, actual?: Oid | null) => new GitError(code, message, actual);
  const unknown = () => fail('outcome-unknown', 'The push was sent, but its reply was lost, so the host may or may not have taken it: look at the host’s branch again.');
  const code = (e as { code?: string })?.code;
  const data = (e as { data?: Record<string, unknown> })?.data ?? {};
  if (code === 'PushRejectedError') return fail('diverged', 'The host’s publication branch holds a commit this publication does not follow, so nothing was sent and the host was left as it is.', at.previous ?? null);
  if (code === 'HttpError') {
    const status = Number(data.statusCode);
    // Signing in is checked before anything sent is taken: a refusal moves nothing.
    if (status === 401 || status === 403 || status === 203) return fail('auth-rejected', 'The host refused the credential, so nothing was published.');
    if (at.posted) return unknown();
    return fail('unreachable', status === 404 ? 'The host has no repository at that address.' : `The host answered as no Git host does (HTTP ${status}), so nothing was sent.`);
  }
  if (e instanceof GitError && (e.code === 'redirect-refused' || e.code === 'invalid')) return e;
  if (at.posted) return unknown();
  if (at.signal.aborted) return fail('cancelled', 'The push was stopped before anything was sent.');
  if (e instanceof GitError) return e;
  if (code === 'SmartHttpError') return fail('unreachable', 'That address is not a Git repository the app can publish to.');
  if (typeof code === 'string' && TLS_CODES.test(code)) return fail('unreachable', 'The host’s certificate could not be trusted, so nothing was sent.');
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return fail('unreachable', 'The host could not be reached, so nothing was sent.');
  return fail('failed', 'The push could not be made, and nothing was sent.');
}

/**
 * The commit the host's publication branch is at, or null when it has none: its own list of branches, the exact name
 * looked for (a longer name sharing its start is another branch).
 */
export async function remoteTip(target: unknown, signal: AbortSignal, opts: RemoteOptions = {}): Promise<Oid | null> {
  const t = checkTarget(target);
  const http = remoteHttp(t.url, { ca: opts.ca, signal });
  try {
    const refs = await git.listServerRefs({ http, url: t.url, forPush: true, protocolVersion: 1, prefix: PUBLISH_BRANCH, corsProxy: '', ...signIn(t) });
    const hit = refs.find((r) => r.ref === PUBLISH_BRANCH);
    if (hit && !OID_RE.test(hit.oid)) throw new GitError('unreachable', 'The host named its branch’s commit in a way no Git host does.');
    return hit ? hit.oid : null;
  } catch (e) {
    throw remoteFailure(e, { posted: false, signal });
  } finally {
    http.close();
  }
}

/**
 * Push `commit`, the publication's branch's commit now, to the host's publication branch, only as a fast-forward of
 * where the host has it. A host already there is sent nothing. A refusal the host reports after a branch of its moved
 * meanwhile is told apart from one of its own by looking at that branch again.
 */
export async function pushCommit(repo: Pick<Repo, 'source'>, target: unknown, commit: unknown, signal: AbortSignal, opts: RemoteOptions = {}): Promise<PushReply> {
  const t = checkTarget(target);
  if (typeof commit !== 'string' || !OID_RE.test(commit)) throw new GitError('invalid', 'A push needs the commit to send.');
  const { gitdir, files, tip } = await repo.source(PUBLISH_BRANCH);
  if (tip !== commit) throw new GitError('conflict', 'That is not the publication last prepared, so it was not pushed. Prepare the publication again, then push it.', tip);
  let posted = false;
  let previous: Oid | null | undefined;
  let held = false;
  const http = remoteHttp(t.url, { ca: opts.ca, signal, posting: () => (posted = true) });
  try {
    await git.push({
      fs: readOnly(gitdir, files),
      http,
      gitdir,
      url: t.url,
      ref: commit,
      remoteRef: PUBLISH_BRANCH,
      remote: 'origin',
      corsProxy: '',
      force: false,
      ...signIn(t),
      onPrePush: ({ localRef, remoteRef }) => {
        // The one push asked for, to the one branch: a host that lists a longer name the bundled Git took for it is not.
        if (localRef.oid !== commit || remoteRef.ref !== PUBLISH_BRANCH || !OID_RE.test(remoteRef.oid)) throw new GitError('invalid', 'The host’s branches are not what a push to it needs.');
        previous = remoteRef.oid === NONE ? null : remoteRef.oid;
        held = previous === commit;
        return !held;
      }
    });
    return { previous: previous ?? null, uploaded: true };
  } catch (e) {
    if (held && (e as { code?: string })?.code === 'UserCanceledError') return { previous: commit, uploaded: false };
    if ((e as { code?: string })?.code === 'GitPushError') {
      // The host's own report: it did not take the update. Its branch says whether another push moved it meanwhile.
      const now = await remoteTip(t, signal, opts).catch(() => undefined);
      if (now === commit) return { previous: previous ?? null, uploaded: true };
      if (now !== undefined && now !== (previous ?? null)) throw new GitError('diverged', 'The host’s publication branch moved while the push was sent, so it was left as it is.', now);
      if (now === undefined) throw remoteFailure(new Error('lost'), { posted: true, signal });
      throw new GitError('rejected', 'The host refused the update to its publication branch.');
    }
    throw remoteFailure(e, { posted, signal, previous });
  } finally {
    http.close();
  }
}
