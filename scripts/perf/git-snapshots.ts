/**
 * What saving a version in the bundled Git's repository costs (#1152), on the benchmark's starter fixture and on a
 * media-heavy one: the time a first snapshot takes, the time a snapshot of the same files takes again, the peak memory
 * of the process doing it, and how much the repository grows each time. Each trial runs in a fresh Node process doing
 * what the Git worker does, so the memory is that work's own.
 *
 *   npm run perf:git                                  # both fixtures, 3 trials each
 *   npm run perf:git -- --fixture media --trials 5 --out .tmp/perf/git.json
 *
 * The media fixture is the `large` fixture (50 pages, 500 posts, 300 small library images) with 16 pictures of 4 MiB
 * and 2 of 24 MiB added, their bytes random as a camera's compressed ones are.
 */
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FIXTURES, ROOT, fixtureState } from './fixtures';
import { registerBuiltinPacks } from '../../src/main/packs/build';
import { stateToDocs } from '../../src/main/project/documents';
import { openRepo } from '../../src/main/git/repo';
import { VERSIONS_BRANCH, type FileInput, type Identity } from '../../src/main/git/protocol';

type Fixture = 'starter' | 'media';
const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };

interface Trial {
  firstMs: number;
  unchangedMs: number;
  /** Whether the second snapshot's tree was the first's, as it should be for the same files. */
  sameTree: boolean;
  peakRssBytes: number;
  repoBytesAfterFirst: number;
  repoGrowthUnchanged: number;
}

/** Bytes of every file under a folder. */
function bytesUnder(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) n += statSync(join(e.parentPath, e.name)).size;
  return n;
}

/** The fixture's project folder (media files on disk), and its snapshot: documents inline, media read from the disk. */
function prepare(fixture: Fixture, dir: string): { files: FileInput[]; inputBytes: number } {
  const { state, files: media } = fixtureState(fixture === 'starter' ? FIXTURES.small : FIXTURES.large);
  if (fixture === 'media') {
    for (let i = 0; i < 16; i++) media.set(`static/assets/photo-${i}.jpg`, randomBytes(4 * 1024 * 1024));
    for (let i = 0; i < 2; i++) media.set(`static/assets/large-${i}.jpg`, randomBytes(24 * 1024 * 1024));
  }
  const files: FileInput[] = [];
  let inputBytes = 0;
  for (const [path, text] of stateToDocs(state)) {
    const bytes = new TextEncoder().encode(text);
    files.push({ path, bytes });
    inputBytes += bytes.byteLength;
  }
  for (const [path, bytes] of media) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), bytes);
    files.push({ path, source: path });
    inputBytes += bytes.byteLength;
  }
  return { files, inputBytes };
}

/** One trial, in this (child) process: a first snapshot, then the same files again. */
async function trial(dir: string, files: FileInput[]): Promise<Trial> {
  const repo = openRepo(dir);
  await repo.init();
  const gitdir = join(dir, '.siteorigin', 'versions.git');
  const empty = bytesUnder(gitdir);
  let t = performance.now();
  const tree = await repo.writeFiles(files);
  const first = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'First version\n' });
  await repo.advanceRef(VERSIONS_BRANCH, first, null);
  const firstMs = performance.now() - t;
  const afterFirst = bytesUnder(gitdir);
  t = performance.now();
  const tree2 = await repo.writeFiles(files);
  const second = await repo.writeCommit({ tree: tree2, parents: [first], author: APP, committer: { ...APP, timestamp: APP.timestamp + 60 }, message: 'Same files\n' });
  await repo.advanceRef(VERSIONS_BRANCH, second, first);
  const unchangedMs = performance.now() - t;
  return {
    firstMs,
    unchangedMs,
    sameTree: tree2 === tree,
    // maxRSS is in kibibytes.
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    repoBytesAfterFirst: afterFirst - empty,
    repoGrowthUnchanged: bytesUnder(gitdir) - afterFirst
  };
}

/** A trial in a fresh process, as the Git worker would run it. */
function trialInChild(dir: string, fixture: Fixture): Promise<Trial> {
  return new Promise((done, fail) => {
    const child = fork(import.meta.filename, ['--child', dir, '--fixture', fixture], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', (m: { trial?: Trial; error?: string }) => (m.trial ? done(m.trial) : fail(new Error(m.error))));
    child.once('exit', (code) => code && fail(new Error(`the trial exited with ${code}`)));
  });
}

const fmtMs = (ms: number) => `${ms.toFixed(0)} ms`;
const fmtMiB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  // The fixtures are made from the theme packs, as the benchmark's are (run.ts).
  registerBuiltinPacks(ROOT);
  const { values } = parseArgs({ options: { child: { type: 'string' }, fixture: { type: 'string' }, trials: { type: 'string' }, out: { type: 'string' } } });
  if (values.child) {
    // The child: the files are listed again here from the folder the parent prepared, rather than sent.
    const fixture = values.fixture as Fixture;
    const { state } = fixtureState(fixture === 'starter' ? FIXTURES.small : FIXTURES.large);
    const files: FileInput[] = [...stateToDocs(state)].map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) }));
    for (const e of existsSync(join(values.child, 'static')) ? readdirSync(join(values.child, 'static'), { recursive: true, withFileTypes: true }) : [])
      if (e.isFile()) {
        const path = join(e.parentPath, e.name).slice(values.child.length + 1).split('\\').join('/');
        files.push({ path, source: path });
      }
    try {
      process.send!({ trial: await trial(values.child, files) });
    } catch (e) {
      process.send!({ error: e instanceof Error ? e.stack : String(e) });
    }
    return;
  }
  const fixtures: Fixture[] = values.fixture ? [values.fixture as Fixture] : ['starter', 'media'];
  const trials = Number(values.trials ?? 3);
  const results: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, node: process.version, at: new Date().toISOString(), fixtures: {} };
  const rows: string[] = ['| Fixture | Files | Input | First snapshot | Unchanged snapshot | Peak RSS | Repository after first | Growth, unchanged |', '|---|---|---|---|---|---|---|---|'];
  for (const fixture of fixtures) {
    const work = mkdtempSync(join(tmpdir(), `so-perf-git-${fixture}-`));
    try {
      const { files, inputBytes } = prepare(fixture, work);
      const runs: Trial[] = [];
      for (let i = 0; i < trials; i++) {
        rmSync(join(work, '.siteorigin'), { recursive: true, force: true });
        runs.push(await trialInChild(work, fixture));
      }
      (results.fixtures as Record<string, unknown>)[fixture] = { files: files.length, inputBytes, trials: runs };
      const m = (k: keyof Trial) => median(runs.map((r) => r[k] as number));
      rows.push(`| ${fixture} | ${files.length} | ${fmtMiB(inputBytes)} | ${fmtMs(m('firstMs'))} | ${fmtMs(m('unchangedMs'))} | ${fmtMiB(m('peakRssBytes'))} | ${fmtMiB(m('repoBytesAfterFirst'))} | ${(m('repoGrowthUnchanged') / 1024).toFixed(1)} KiB |`);
      if (!runs.every((r) => r.sameTree)) throw new Error(`${fixture}: the same files made a different tree`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const out = resolve(values.out ?? join('.tmp', 'perf', `git-snapshots-${Date.now()}.json`));
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`Medians of ${trials} trials each (${results.platform}, Node ${process.version}):\n\n${rows.join('\n')}\n\nWritten to ${out}`);
}

await main();
