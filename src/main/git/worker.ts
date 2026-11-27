/**
 * Git worker (Electron utility process, #1152): reads and writes projects' versions repositories with the bundled
 * pure-JavaScript Git, so hashing and compressing a folder of pictures never holds up the editor's main process.
 * Started on demand by client.ts, one at a time.
 */
import type { GitReply, GitRequest } from './protocol';
import { createGitService } from './service';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: GitRequest }) => void) => void; postMessage: (m: GitReply) => void } }).parentPort;

const service = createGitService((reply) => port.postMessage(reply));
port.on('message', ({ data }) => void service.handle(data));
