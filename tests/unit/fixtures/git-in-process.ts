/**
 * The Git worker's service run in the test's own process, behind the real client (#1153): requests are copied as
 * Electron's port would copy them, one at a time, so saved versions use Git as the app does without a utility process.
 * `calls` counts every request, so a test can show that nothing reached Git.
 */
import { createGitClient, type GitClient, type GitWorkerHandle } from '../../../src/main/git/client';
import { createGitService } from '../../../src/main/git/service';
import type { GitOp, GitReply, GitRequest } from '../../../src/main/git/protocol';
import { useVersionsGit } from '../../../src/main/project/versions-git';

export interface TestGit {
  client: GitClient;
  /** Every operation sent to the worker, in order. */
  calls: Array<GitOp['op']>;
  /** Whether a version saved now goes to Git. */
  enabled: boolean;
}

export function inProcessGit(): TestGit {
  const calls: Array<GitOp['op']> = [];
  const spawn = (): GitWorkerHandle => {
    const listeners: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (e: string, x?: unknown) => (listeners[e] ?? []).forEach((l) => l(x));
    let alive = true;
    const service = createGitService((r: GitReply) => setTimeout(() => alive && emit('message', structuredClone(r))));
    return {
      postMessage: (m: GitRequest) => {
        if (!alive) throw new Error('gone');
        if (m.op !== 'cancel') calls.push(m.op);
        void service.handle(structuredClone(m));
      },
      on: (e: string, l: (x?: unknown) => void) => ((listeners[e] ??= []).push(l), undefined),
      kill: () => {
        if (!alive) return false;
        alive = false;
        setTimeout(() => emit('exit', 0));
        return true;
      }
    } as GitWorkerHandle;
  };
  const git: TestGit = { client: createGitClient(spawn, { idleMs: 50 }), calls, enabled: true };
  return git;
}

/** Saved versions in this test file reach Git through `git` (enabled as it says), until `stop`. */
export function useTestGit(git: TestGit): () => void {
  useVersionsGit({ enabled: () => git.enabled, repository: (root) => git.client.repository(root) });
  return () => {
    useVersionsGit(null);
    git.client.stop();
  };
}
