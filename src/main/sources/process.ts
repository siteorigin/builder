/** The sync worker's utility process, started for each sync (see client.ts), and the user's secret store. */
import { app, utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncRunner } from './client';
import { createSecretStore } from './secrets';

/**
 * Only what a process needs to start, find its temporary folder and reach the network through the system's proxy:
 * none of the app's own settings or keys. The secrets a sync needs are sent in its request, never set here.
 */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_SOURCE_SYNC: '1' };
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export const sourceSyncRunner = createSyncRunner(() =>
  utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'source-sync-worker.js'), [], { serviceName: 'SiteOrigin source sync', env: workerEnv() })
);

/** End every sync in progress (the project closed, or the app is quitting). */
export const stopSourceSyncs = () => sourceSyncRunner.stop();

/** The user's source secrets: `userData/source-secrets.json`, mode 0600. */
export const sourceSecrets = createSecretStore(() => join(app.getPath('userData'), 'source-secrets.json'));
