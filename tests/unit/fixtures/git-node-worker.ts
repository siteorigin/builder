/**
 * The Git worker's service in a plain Node process, for tests that kill a real worker (git-worker-process.test.ts):
 * Electron's port is replaced by Node's IPC channel. With GIT_TEST_STOP_AT, the worker says when it reaches that point
 * of a write and then never goes on, so the test can kill it exactly there.
 */
import type { FaultPoint } from '../../../src/main/git/fs';
import type { GitRequest } from '../../../src/main/git/protocol';
import { createGitService } from '../../../src/main/git/service';

const stopAt = process.env.GIT_TEST_STOP_AT as FaultPoint | undefined;
const send = (m: unknown) => process.send!(m);
const service = createGitService(send, {
  lockMinAgeMs: Number(process.env.GIT_TEST_LOCK_MIN_AGE_MS ?? 2000),
  fault: stopAt ? (point) => (point === stopAt ? (send({ stoppedAt: point }), new Promise<never>(() => undefined)) : undefined) : undefined
});
process.on('message', (m) => void service.handle(m as GitRequest));
send({ ready: true });
