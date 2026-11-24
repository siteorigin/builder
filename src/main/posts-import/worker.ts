/**
 * Import reader (Electron utility process): reads a WordPress export or a folder of Markdown posts for the import, so
 * the editor's main process never parses a file from elsewhere. Started for each read by client.ts.
 */
import type { ReadReply, ReadRequest } from './client';
import { readWordPress } from './wxr';
import { readMarkdownFolder } from './folder';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: ReadRequest }) => void) => void; postMessage: (m: ReadReply) => void } }).parentPort;

port.on('message', async ({ data: m }) => {
  try {
    const source = m.kind === 'wordpress' ? await readWordPress(m.path, m.pages) : await readMarkdownFolder(m.path, m.pages);
    port.postMessage({ id: m.id, ok: true, source });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : 'The posts could not be read.' });
  }
});
