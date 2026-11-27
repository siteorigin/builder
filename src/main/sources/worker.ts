/**
 * Sync worker (Electron utility process): reads an external source's records and fetches their pictures, so the
 * editor's main process never talks to someone else's server and never parses what it sends. Started for each sync
 * by client.ts, and ended as soon as it answers.
 */
import type { SyncReply, SyncRequest } from './protocol';
import { ADAPTERS } from './adapters';
import { checkHost, createFetchImage, createHostCheck, fetchImage, systemLookup } from './fetch-image';
import { readTestHosts, testHostFetch, testHostLookup } from './test-hosts';
import { runSync } from './run';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: SyncRequest }) => void) => void; postMessage: (m: SyncReply) => void } }).parentPort;

// Picture hosts a test serves on this computer, which only an automated run's main process names (test-hosts.ts).
const testHosts = readTestHosts(process.env);
const pictures = testHosts
  ? { fetchImage: createFetchImage(testHostLookup(testHosts, systemLookup), testHostFetch(testHosts)), checkHost: createHostCheck(testHostLookup(testHosts, systemLookup)) }
  : { fetchImage, checkHost };

port.on('message', async ({ data: m }) => {
  let reply: SyncReply;
  try {
    reply = await runSync(m, { adapters: ADAPTERS, ...pictures });
  } catch {
    reply = { id: m?.id ?? 0, ok: false, code: 'failed' };
  }
  port.postMessage(reply);
});
