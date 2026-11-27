/**
 * The Git worker's side of the protocol (#1152), apart from the process it runs in: each request is an operation on a
 * project's repository, answered once; a `cancel` for one in progress is taken while it runs, and stops it at the
 * next file, or before its branch moves. worker.ts gives it Electron's port; tests give it a function.
 */
import { isAbsolute } from 'node:path';
import git from 'isomorphic-git';
import { openRepo, type Repo, type RepoOptions } from './repo';
import { pushCommit, remoteTip, type RemoteOptions } from './remote';
import { GitError, type GitOp, type GitReply, type GitRequest } from './protocol';

export interface GitService {
  /** Take one message; resolves once it is answered (a cancel is never answered). */
  handle(message: GitRequest): Promise<void>;
}

/** A request in progress: told to stop when its cancel comes, which a push hears at once through its signal. */
interface Running {
  cancelled: boolean;
  abort: AbortController;
}

export function createGitService(send: (reply: GitReply) => void, opts: RepoOptions & { remote?: RemoteOptions } = {}): GitService {
  const repos = new Map<string, Repo>();
  const running = new Map<number, Running>();
  const repo = (root: unknown): Repo => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new GitError('invalid', 'A repository request needs the project’s folder.');
    let r = repos.get(root);
    if (!r) repos.set(root, (r = openRepo(root, opts)));
    return r;
  };
  const run = (m: GitOp, token: Running): Promise<unknown> => {
    switch (m.op) {
      case 'version':
        return Promise.resolve(git.version());
      case 'init':
        return repo(m.root).init();
      case 'exists':
        return repo(m.root).exists();
      case 'writeBlob':
        return repo(m.root).writeBlob(m.input, token);
      case 'writeFiles':
        return repo(m.root).writeFiles(m.files, token);
      case 'writeCommit':
        return repo(m.root).writeCommit(m.commit, token);
      case 'readBlob':
        return repo(m.root).readBlob(m.oid, m.filepath);
      case 'readTree':
        return repo(m.root).readTree(m.oid);
      case 'readCommit':
        return repo(m.root).readCommit(m.oid);
      case 'listCommits':
        return repo(m.root).listCommits(m.ref, m.limit);
      case 'resolveRef':
        return repo(m.root).resolveRef(m.ref);
      case 'advanceRef':
        return repo(m.root).advanceRef(m.ref, m.next, m.expected, token);
      case 'push':
        return pushCommit(repo(m.root), m.target, m.commit, token.abort.signal, opts.remote);
      case 'remoteTip':
        return remoteTip(m.target, token.abort.signal, opts.remote);
      default:
        throw new GitError('invalid', 'The versions repository was asked for something it does not do.');
    }
  };
  return {
    async handle(m) {
      if (!m || typeof m.id !== 'number') return;
      if (m.op === 'cancel') {
        const token = running.get(m.target);
        if (token) {
          token.cancelled = true;
          token.abort.abort();
        }
        return;
      }
      const token: Running = { cancelled: false, abort: new AbortController() };
      running.set(m.id, token);
      let reply: GitReply;
      try {
        reply = { id: m.id, ok: true, value: (await run(m, token)) ?? null };
      } catch (e) {
        const g = e instanceof GitError ? e : new GitError('failed', e instanceof Error ? e.message : 'The versions repository could not be used.');
        reply = { id: m.id, ok: false, code: g.code, message: g.message, ...(g.actual !== undefined ? { actual: g.actual } : {}) };
      } finally {
        running.delete(m.id);
      }
      send(reply);
    }
  };
}
