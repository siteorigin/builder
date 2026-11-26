/**
 * Sync worker (Electron utility process): reads an external source's records and fetches their pictures, so the
 * editor's main process never talks to someone else's server and never parses what it sends. Started for each sync
 * by client.ts, and ended as soon as it answers.
 */
import type { SyncReply, SyncRequest } from './protocol';
import { ADAPTERS } from './adapters';
import { checkHost, fetchImage } from './fetch-image';
import { runSync } from './run';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: SyncRequest }) => void) => void; postMessage: (m: SyncReply) => void } }).parentPort;

port.on('message', async ({ data: m }) => {
  let reply: SyncReply;
  try {
    reply = await runSync(m, { adapters: ADAPTERS, fetchImage, checkHost });
  } catch {
    reply = { id: m?.id ?? 0, ok: false, code: 'failed' };
  }
  port.postMessage(reply);
});
