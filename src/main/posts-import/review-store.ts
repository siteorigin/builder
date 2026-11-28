/**
 * A posts import's plan kept on disk while the author reviews it (#1047). A plan carries every post's text (up to 1,000
 * posts, each up to what a post holds), and a review can sit open for as long as the author likes, so the main
 * process keeps only where the plan is and the digest of what was written. It is written once, whole, into a private
 * folder of its own under the app's data folder, and read back only by the import it was made for, which takes it
 * only when the bytes are exactly the ones written. It is removed when the review is imported, cancelled or replaced,
 * or its project closes; what a crash left is swept before the next review of a later run (sweepPlans).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { openRegularFile, readAtMost } from '../regular-file';

export interface StoredPlan {
  /** The folder made for it (mode 0700), and the file in it. */
  dir: string;
  file: string;
  bytes: number;
  sha256: string;
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Write `plan` whole into a new private folder inside `root`. Nothing is left behind when it cannot be written. */
export async function storePlan(plan: unknown, root: string): Promise<StoredPlan> {
  const data = serialize(plan);
  const sha256 = digest(data);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(join(root, 'review-'));
  const file = join(dir, 'plan.bin');
  try {
    await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    await dropPlan({ dir });
    throw e;
  }
  return { dir, file, bytes: data.length, sha256 };
}

/** The plan `stored` names, or a rejection when its file is gone or is not exactly the bytes written. */
export async function loadPlan<T>(stored: StoredPlan): Promise<T> {
  const changed = () => new Error('The review’s plan changed on disk.');
  // A regular file, never through a link, and never more than was written: one grown since is refused unread.
  const { handle, stat } = await openRegularFile(stored.file);
  let data: Buffer | null;
  try {
    if (stat.size !== stored.bytes) throw changed();
    data = await readAtMost(handle, stat.size, stored.bytes);
  } finally {
    await handle.close();
  }
  // The very bytes hashed are the ones read back.
  if (!data || data.length !== stored.bytes || digest(data) !== stored.sha256) throw changed();
  return deserialize(data) as T;
}

/**
 * Remove every plan kept in `root`: called once a run, before its first review is kept, when every one there was kept
 * by an earlier run of this profile (the app runs once per profile) that ended without removing it.
 */
export async function sweepPlans(root: string): Promise<void> {
  const left = await fs.readdir(root).catch(() => [] as string[]);
  await Promise.all(left.map((name) => fs.rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)));
}

/** Remove a stored plan's folder; one already gone is fine. */
export async function dropPlan(stored: Pick<StoredPlan, 'dir'> | null | undefined): Promise<void> {
  if (!stored) return;
  await fs.rm(stored.dir, { recursive: true, force: true }).catch(() => undefined);
}
