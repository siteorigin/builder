/** The website tools check's utility process (tools-worker.ts), started when a check is asked for (see tools-client.ts). */
import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolsChecker } from './tools-client';

/** Only what npm's resolver needs to start and find its folders: none of the app's own settings or keys. */
function checkEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_TOOLS_CHECK: '1' };
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export const toolsChecker = createToolsChecker(() =>
  utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'tools-worker.js'), [], { serviceName: 'SiteOrigin tools check', env: checkEnv(), stdio: 'ignore' })
);

/** End the check's process (the app is quitting). */
export const stopToolsChecks = () => toolsChecker.stop();
