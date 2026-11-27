/**
 * What Git the app has (#1152): the bundled pure-JavaScript Git, which every versions repository is written with and
 * which needs nothing installed, and the computer's own Git, when it has one. The computer's is only reported: a later
 * backend could use it, or a Git downloaded on demand, on the same repositories, since they are plain Git.
 */
import { detectSystemGit, type SystemGit } from './system-git';
import type { GitClient } from './client';

export interface GitRuntimeStatus {
  /** The bundled Git: its version when its worker started and answered, or why it did not. */
  bundled: { engine: 'isomorphic-git'; ready: true; version: string } | { engine: 'isomorphic-git'; ready: false; reason: string };
  system: SystemGit;
}

/** Both, looked at side by side; never rejects. The bundled one is asked through its worker, so a ready one has started. */
export async function gitRuntimeStatus(client: Pick<GitClient, 'version'>, detect: () => Promise<SystemGit> = detectSystemGit): Promise<GitRuntimeStatus> {
  const [bundled, system] = await Promise.all([
    client.version({ timeoutMs: 30_000 }).then(
      (version) => ({ engine: 'isomorphic-git' as const, ready: true as const, version }),
      (e: unknown) => ({ engine: 'isomorphic-git' as const, ready: false as const, reason: e instanceof Error ? e.message : String(e) })
    ),
    detect().catch((): SystemGit => ({ status: 'missing' }))
  ]);
  return { bundled, system };
}
