/** The Git worker's utility process (worker.ts), started when a versions repository is first used (see client.ts). */
import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitClient } from './client';
import { gitRuntimeStatus, type GitRuntimeStatus } from './runtime';

/**
 * Only what a process needs to find its temporary folder: none of the app's settings or keys, and no PATH, since the
 * bundled Git runs no program.
 */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_GIT_WORKER: '1' };
  for (const k of ['SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export const gitClient = createGitClient(() =>
  utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'git-worker.js'), [], { serviceName: 'SiteOrigin versions', env: workerEnv(), stdio: 'ignore' })
);

/** The bundled Git, and the computer's own if it has one (Settings, #1153). */
export const gitRuntime = (): Promise<GitRuntimeStatus> => gitRuntimeStatus(gitClient);

/** End the worker (the app is quitting). */
export const stopGitWorker = () => gitClient.stop();
