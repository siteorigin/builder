/**
 * The website tools check (Electron utility process): works out the packages `npm ci` installs into a folder, with
 * npm's own dependency resolver, and which of them the npm caches already hold (availability.ts), so the main
 * process, which serves the editor, never loads that resolver or waits on it. Started by tools-client.ts.
 */
import { cacheCoverage, lockedPackages } from './availability';
import type { ToolsCheckReply, ToolsCheckRequest } from './tools-client';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: ToolsCheckRequest }) => void) => void; postMessage: (m: ToolsCheckReply) => void } }).parentPort;

port.on('message', async ({ data: m }) => {
  try {
    const packages = await lockedPackages(m.npmDir, m.dir, {}, m.cache);
    port.postMessage({ id: m.id, ok: true, packages, ...cacheCoverage(packages, m.caches) });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
