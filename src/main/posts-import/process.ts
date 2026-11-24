/** The import reader's utility process, started for each read (see client.ts). */
import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceReader } from './client';

/** Only what a process needs to start and find its temporary folder: none of the app's own settings or keys. */
function readerEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_IMPORT_READER: '1' };
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export const postReader = createSourceReader(() =>
  utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'posts-import-worker.js'), [], { serviceName: 'SiteOrigin import reader', env: readerEnv() })
);

/** End every read in progress (the project closed, or the app is quitting). */
export const stopPostReads = () => postReader.stop();
