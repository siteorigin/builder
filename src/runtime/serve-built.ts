/**
 * A website built as a Node.js server (SvelteKit's adapter-node, shared/deploy-target.ts), served on loopback so the
 * export can open its pages as visitors will get them: its prerendered pages, its assets and its own API endpoints,
 * answered by the server the build wrote (`handler.js`), not a stand-in. Run in the project runtime worker, a utility
 * process of its own whose environment the main process constructs, never in the main process: it runs the project's
 * code. Kept apart from the worker so it can be tested.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** adapter-node's request handler, as handler.js exports it: Connect-style, calling `next` when nothing answered. */
type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

/** How the built server's handler is loaded: imported from its folder, unless a test says otherwise. */
export type HandlerLoader = (file: string) => Promise<{ handler?: unknown }>;

const importHandler: HandlerLoader = (file) => import(pathToFileURL(file).href) as Promise<{ handler?: unknown }>;

/**
 * Serve the Node.js server built into `dir` (adapter-node's output folder) on a free loopback port, and say where.
 * The port is bound before the server is loaded, so it is told the address it is served at (ORIGIN, which it reads as
 * it loads): a form it is sent and the addresses it writes name that address, not one it guessed. A server that cannot
 * be loaded stops the listener and throws.
 */
export async function serveBuilt(dir: string, load: HandlerLoader = importHandler): Promise<{ url: string; server: Server }> {
  let handler: Handler | null = null;
  const server = createServer((req, res) => {
    if (!handler) {
      res.statusCode = 503;
      return res.end();
    }
    void handler(req, res, () => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found.');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ORIGIN = url;
  try {
    const mod = await load(join(dir, 'handler.js'));
    if (typeof mod?.handler !== 'function') throw new Error('The built server has no request handler in handler.js.');
    handler = mod.handler as Handler;
  } catch (e) {
    server.closeAllConnections();
    server.close();
    throw e;
  }
  return { url, server };
}
