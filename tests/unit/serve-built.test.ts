/**
 * A website built as a Node.js server, served on loopback for the export's checks (#1481, runtime/serve-built.ts):
 * its own handler answers, told the address it is served at, and a server that cannot be loaded leaves no listener.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { serveBuilt } from '../../src/runtime/serve-built';

const origin = process.env.ORIGIN;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  if (origin === undefined) delete process.env.ORIGIN;
  else process.env.ORIGIN = origin;
});

describe('a built Node.js server, served for the export’s checks', () => {
  it('answers with the build’s own handler, which reads the address it is served at, and is not found where it calls next', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-serve-built-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'handler.js'), `export const handler = (req, res, next) => (req.url === '/api/hi' ? res.end(JSON.stringify({ origin: process.env.ORIGIN })) : next());\n`);
    const { url, server } = await serveBuilt(dir);
    servers.push(server);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${url}/api/hi`)).json()).toEqual({ origin: url });
    const missing = await fetch(`${url}/nowhere/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not found.');
  });

  it('leaves no listener behind when the build’s server cannot be loaded, or has no handler', async () => {
    let at = '';
    await expect(
      serveBuilt('/nowhere', async () => {
        at = process.env.ORIGIN!;
        throw new Error('Cannot find module ./server/index.js');
      })
    ).rejects.toThrow('Cannot find module');
    await expect(fetch(at)).rejects.toThrow();
    await expect(serveBuilt('/nowhere', async () => ({ handler: 'not a function' }))).rejects.toThrow('no request handler');
  });
});
