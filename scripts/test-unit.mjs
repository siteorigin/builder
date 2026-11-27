import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
// Folder tests share filesystem state, and the browser interaction tests need predictable
// timing for pointer, selection, and smooth-scroll assertions under the full suite's load.
const serial = [
  'tests/unit/asset-files.test.ts',
  'tests/unit/duplicate-project.test.ts',
  'tests/unit/folder-gone.test.ts',
  'tests/unit/folder-watch.test.ts',
  'tests/unit/inline-edit-header.test.ts',
  'tests/unit/open-project.test.ts',
  'tests/unit/rich-toolbar.test.ts'
];

for (const args of [
  ['run', ...serial.flatMap((file) => ['--exclude', file])],
  ...serial.map((file) => ['run', file, '--maxWorkers', '1'])
]) {
  const result = spawnSync(process.execPath, [vitest, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
