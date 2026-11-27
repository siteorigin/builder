/**
 * How a publication reaches a host (#1157), as the main process asks for it: a push of one prepared commit, pinned, to
 * the publication's branch at an approved address, fast-forward only. The HTTPS Git transport here sends it through
 * the push worker (git/remote.ts); SiteOrigin Hosting can stand behind the same interface later, with a deployment
 * receipt of its own.
 *
 * A push whose reply was lost (the connection dropped, the worker went down, the push was stopped once sent) is
 * settled by asking the host where its branch is: there at the pinned commit, the push landed. Anything else (the old
 * commit, none, or no answer) leaves it unknown, since the host may still be taking it; pushing again settles it for
 * good, because a push the host already has sends nothing.
 */
import { approveEndpoint, GitError, OID_RE, PUBLISH_BRANCH, type CallOptions, type Oid, type PushReply, type RemoteTarget } from '../git/protocol';
import type { DeploymentReceipt } from './binding';
import type { RemoteCredential } from './credentials';

export interface PushRequest {
  /** The approved repository address (approveEndpoint), exactly as approved. */
  endpoint: string;
  /** The remote binding the push is made for: opaque, never sent. */
  binding: string;
  /** The one branch a publication is pushed to, there under the same name. No tag follows it; no other goes with it. */
  ref: typeof PUBLISH_BRANCH;
  /** The prepared commit: exactly this is sent, and only while it is the publication branch's commit. */
  commit: Oid;
  /** The credential for the approved address, asked for once it is approved; null to push without one. */
  credentials: (endpoint: string) => Promise<RemoteCredential | null>;
  signal?: AbortSignal;
}

export interface PushOutcome {
  commit: Oid;
  /** False when the host already held the commit, so nothing was sent. */
  uploaded: boolean;
  /** True when the reply was lost and the host's branch showed the push had landed. */
  reconciled: boolean;
  /** What the provider said of the commit going live, when it says anything. */
  receipt: DeploymentReceipt | null;
}

export interface RemotePushTransport {
  /** Push `request.commit` from the versions repository of the project at `root`; rejects with a GitError, moving nothing it was not asked to. */
  push(root: string, request: PushRequest): Promise<PushOutcome>;
  /** The commit the host's publication branch is at, or null when it has none. */
  tip(request: Omit<PushRequest, 'commit'>): Promise<Oid | null>;
}

/** What the transport needs of the push worker's client. */
export interface RemoteGit {
  push(root: string, target: RemoteTarget, commit: Oid, opts?: CallOptions): Promise<PushReply>;
  remoteTip(target: RemoteTarget, opts?: CallOptions): Promise<Oid | null>;
}

/** How long settling a lost reply may take: a look at the host's branches, not an upload. */
const LOOKUP_MS = 60_000;

/** The request's target, checked, with the credential the callback gives for the approved address. */
async function targetOf(request: Omit<PushRequest, 'commit'>): Promise<RemoteTarget> {
  if (request.ref !== PUBLISH_BRANCH) throw new GitError('invalid', 'A website is only pushed to its publication branch.');
  const url = approveEndpoint(request.endpoint);
  if (url !== request.endpoint) throw new GitError('invalid', 'A push needs an approved repository address.');
  const credential = await request.credentials(url);
  return { url, ref: PUBLISH_BRANCH, auth: credential ? { username: credential.username, password: credential.token } : null };
}

export function httpsGitTransport(git: RemoteGit, opts: { lookupMs?: number } = {}): RemotePushTransport {
  const lookupMs = opts.lookupMs ?? LOOKUP_MS;
  return {
    async push(root, request) {
      if (typeof request.commit !== 'string' || !OID_RE.test(request.commit)) throw new GitError('invalid', 'A push needs the commit to send.');
      const target = await targetOf(request);
      const call = request.signal ? { signal: request.signal } : {};
      try {
        const r = await git.push(root, target, request.commit, call);
        return { commit: request.commit, uploaded: r.uploaded, reconciled: false, receipt: null };
      } catch (e) {
        // Stopped by the caller, it stays unknown: the next push settles it.
        if (!(e instanceof GitError && e.code === 'outcome-unknown') || request.signal?.aborted) throw e;
        const tip = await git.remoteTip(target, { timeoutMs: lookupMs }).catch(() => undefined);
        if (tip === request.commit) return { commit: request.commit, uploaded: true, reconciled: true, receipt: null };
        throw e;
      }
    },
    async tip(request) {
      const target = await targetOf(request);
      return git.remoteTip(target, request.signal ? { signal: request.signal } : {});
    }
  };
}
