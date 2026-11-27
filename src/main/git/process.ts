/** The Git worker's utility process (worker.ts), started when a versions repository is first used (see client.ts). */
import { app, utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitClient } from './client';
import { gitRuntimeStatus, type GitRuntimeStatus } from './runtime';

/**
 * Only what a process needs to find its temporary folder: none of the app's settings or keys, and no PATH, since the
 * bundled Git runs no program.
 */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_GIT_WORKER: '1', SITEORIGIN_GIT_HOST: hostId() };
  for (const k of ['SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** The app's own id for this computer (fs.ts HOST), kept in userData: two computers can share a hostname. */
function hostId(file = join(app.getPath('userData'), 'git-host-id')): string {
  const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (/^[0-9a-f]{8}$/.test(kept)) return kept;
  const id = randomBytes(4).toString('hex');
  writeFileSync(file, id);
  return id;
}

const forkWorker = (serviceName: string) => () => utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'git-worker.js'), [], { serviceName, env: workerEnv(), stdio: 'ignore' });

export const gitClient = createGitClient(forkWorker('SiteOrigin versions'));

/**
 * The pushes to hosts (#1157): a worker of their own, started when one is first made, so an upload that takes a while
 * never holds up saving a version, which the other worker does meanwhile. It only reads a repository.
 */
export const remoteGitClient = createGitClient(forkWorker('SiteOrigin publishing'), { timeoutMs: 60 * 60_000 });

/** The bundled Git, and the computer's own if it has one (Settings, #1153). */
export const gitRuntime = (): Promise<GitRuntimeStatus> => gitRuntimeStatus(gitClient);

/** End the workers (the app is quitting). */
export const stopGitWorker = () => {
  gitClient.stop();
  remoteGitClient.stop();
};
