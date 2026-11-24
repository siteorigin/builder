import { promises as fsp } from 'node:fs';

/**
 * Unit tests check what reaches the disk and in which order, never whether the disk itself kept it, so flushing to
 * the device is skipped: with many test files writing at once, real flushes queue behind each other for seconds. The
 * flush order is checked by tests/unit/crash-durability.test.ts, which records every call to `sync`.
 */
const probe = await fsp.open(import.meta.filename, 'r');
const FileHandle = Object.getPrototypeOf(probe) as { sync: (this: { fd: number }) => Promise<void> };
await probe.close();
// Still refuses a handle that is already closed, as a real flush does.
FileHandle.sync = async function () {
  if (this.fd < 0) throw Object.assign(new Error('EBADF: bad file descriptor, fsync'), { code: 'EBADF' });
};

// The authored theme packs, registered as the app registers their built releases at startup.
const { registerBuiltinPacks } = await import('../../src/main/packs/build');
registerBuiltinPacks();
