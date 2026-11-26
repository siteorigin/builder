/**
 * `npm run sync` in an exported project (#680): sync every external source the project's settings name into its
 * collection's entry files and the library's images, with nothing of SiteOrigin Builder installed, so a CI job or a
 * webhook can keep the canonical documents current. It is this app's own sync, built into one file
 * (`scripts/sync-sources.mjs`, see scripts/sync-cli.mjs): each source is read in a child process of its own, ended when
 * it answers or takes too long, signed in with the secrets its settings name, from environment variables
 * (`${secret:contentful-token}` is CONTENTFUL_TOKEN); the records are reconciled and checked as the app checks a sync,
 * and every file lands, or none does. The site's pages are made from these documents by SiteOrigin Builder, so a build
 * shows the refreshed entries once the project has been opened in it again.
 */
import { fork } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetRecord, ProjectState, SourceDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { registerPacks, type ThemePack } from '@catalogue/index';
import { BUILTIN_PACKS } from '@catalogue/builtin';
import { MIN_SECRET_LENGTH, sourceSecretNames } from '@shared/sources';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { readState, stateToDocs } from '../project/documents';
import { imageProblem, imageInfo } from '../project/media';
import { sha } from '../project/fsutil';
import { createSyncRunner, SyncError, type SyncHandle, type SyncRunner } from './client';
import { holdsSecret, pictureName, SECRET_IN_RECORDS, sourceRequest, syncPreflight } from './sync';
import { knownHashes, planIsEmpty, planSourceSync, SyncPlanError, syncOperations } from './reconcile';
import { redactSecrets } from './redact';
import type { SyncImage, SyncReply, SyncRequest } from './protocol';
import { runSync } from './run';
import { ADAPTERS } from './adapters';
import { checkHost, fetchImage } from './fetch-image';

/** The flag the script starts its own child with, to read one source. */
export const WORKER_FLAG = '--sync-worker';
/** Where a sync keeps the files it is writing until all are in place: a sync cut short is finished by the next. */
export const PENDING_DIR = '.siteorigin/sync-pending';

/** The environment variable a secret's name is read from: `contentful-token` is CONTENTFUL_TOKEN. */
export const secretEnvName = (name: string) => name.toUpperCase().replace(/-/g, '_');

export class SyncCliError extends Error {}

/** A file a sync writes (its text or bytes), or takes away (null), by its path in the project. */
export interface PlannedWrite {
  rel: string;
  data: string | Uint8Array | null;
}

/** Only the canonical documents and the library's own files are ever written. */
const WRITABLE = /^(?:siteorigin\/(?:assets|site)\.json|siteorigin\/collections\/[a-z0-9][a-z0-9-]*\/(?:collection\.json|entries\/en_[A-Za-z0-9_-]+\.json)|static\/assets\/[a-z0-9][a-z0-9-]*\.(?:jpg|png|webp|gif|avif))$/;

/** `rel` inside `dir`, through no link that leads elsewhere. */
function inside(dir: string, rel: string): string {
  if (!WRITABLE.test(rel)) throw new SyncCliError(`A sync never writes ${rel}.`);
  const root = realpathSync(dir);
  const abs = resolve(root, rel);
  let probe = dirname(abs);
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== root && !real.startsWith(root + sep)) throw new SyncCliError(`${rel} is reached through a link that leads out of the project.`);
      break;
    } catch (e) {
      if (e instanceof SyncCliError) throw e;
      probe = dirname(probe);
    }
  }
  return abs;
}

/**
 * Finish a sync that was cut short: every file its plan names is put in place, in order, and the plan let go. A plan
 * not yet written in full is a sync that wrote nothing, and is let go.
 */
export async function finishPending(dir: string): Promise<boolean> {
  const pending = join(dir, PENDING_DIR);
  let plan: Array<{ rel: string; staged: string | null }>;
  try {
    plan = JSON.parse(await fs.readFile(join(pending, 'plan.json'), 'utf8'));
  } catch {
    await fs.rm(pending, { recursive: true, force: true });
    return false;
  }
  for (const { rel, staged } of plan) {
    const target = inside(dir, rel);
    const st = await fs.lstat(target).catch(() => null);
    if (st?.isSymbolicLink()) throw new SyncCliError(`${rel} is a link, which a sync never writes through.`);
    if (staged === null) await fs.rm(target, { force: true });
    else {
      const from = join(pending, staged);
      // Already moved by the sync that was cut short.
      if (!(await fs.stat(from).catch(() => null))) continue;
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.rename(from, target);
    }
  }
  await fs.rm(pending, { recursive: true, force: true });
  return true;
}

/** Write every file of `writes`, or (cut short) leave a plan the next sync finishes. */
export async function commitWrites(dir: string, writes: readonly PlannedWrite[]): Promise<void> {
  const pending = join(dir, PENDING_DIR);
  await fs.rm(pending, { recursive: true, force: true });
  await fs.mkdir(pending, { recursive: true });
  const plan = writes.map((w, i) => {
    inside(dir, w.rel);
    return { rel: w.rel, staged: w.data === null ? null : String(i) };
  });
  for (const [i, w] of writes.entries()) if (w.data !== null) await fs.writeFile(join(pending, String(i)), w.data);
  // The plan last, by rename: until it is there, nothing has been written.
  await fs.writeFile(join(pending, 'plan.tmp'), JSON.stringify(plan));
  await fs.rename(join(pending, 'plan.tmp'), join(pending, 'plan.json'));
  await finishPending(dir);
}

/** The secrets every source signs in with, from the environment, or why they cannot be read. */
export function secretsFromEnv(sources: readonly SourceDoc[], env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const names = [...new Set(sources.flatMap((s) => sourceSecretNames(s)))].sort();
  const byVar = new Map<string, string>();
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const v = secretEnvName(name);
    if (byVar.has(v) && byVar.get(v) !== name) throw new SyncCliError(`The secrets ${byVar.get(v)} and ${name} are both read from ${v}. Rename one of them in SiteOrigin Builder.`);
    byVar.set(v, name);
    const value = env[v];
    if (typeof value !== 'string' || !value) missing.push(v);
    else if (value.length < MIN_SECRET_LENGTH) throw new SyncCliError(`${v} is shorter than any secret can be.`);
    else out[name] = value;
  }
  if (missing.length) throw new SyncCliError(`Set ${missing.join(', ')} to the secret${missing.length === 1 ? '' : 's'} the project's sources sign in with, then sync again.`);
  return out;
}

/** A fetched picture as a library image: the one the library has with the same bytes, or a new record and its file. */
async function libraryImage(dir: string, img: SyncImage, name: string, known: readonly AssetRecord[], createdAt: string): Promise<{ record: AssetRecord; file?: PlannedWrite }> {
  const buf = Buffer.from(img.bytes);
  const problem = imageProblem(buf, img.mime);
  if (problem) throw new SyncCliError(`${name}${img.ext} cannot be a library image (${problem}).`);
  const hash = sha(buf);
  for (const dup of known.filter((a) => a.hash === hash && a.mime === img.mime)) {
    const there = await fs.readFile(inside(dir, dup.file)).catch(() => null);
    if (there && sha(there) === hash) return { record: dup };
  }
  const file = `static/assets/${slugify(name) || 'image'}-${hash.slice(0, 8)}${img.ext}`;
  const there = await fs.readFile(inside(dir, file)).catch(() => null);
  if (there && !there.equals(buf)) throw new SyncCliError(`A different file already has the name ${file.split('/').pop()} in static/assets/.`);
  const info = imageInfo(buf, img.mime);
  const record: AssetRecord = { id: newId('a'), name: name.trim().slice(0, 200) || 'Image', file, mime: img.mime, bytes: buf.length, hash, kind: 'image', createdAt, ...(info ? { width: info.width, height: info.height } : {}) };
  return { record, ...(there ? {} : { file: { rel: file, data: buf } }) };
}

export interface SyncCliOptions {
  env: Readonly<Record<string, string | undefined>>;
  runner: SyncRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Sync every source of the project in `dir`: read, reconciled and checked in memory, then every file written at once.
 * Resolves with what changed, by source; rejects with a SyncCliError (nothing written) when any source cannot be synced.
 */
export async function syncProject(dir: string, opts: SyncCliOptions): Promise<Array<{ sourceId: string; created: number; updated: number; removed: number; unpublished: number; images: number }>> {
  const log = opts.log ?? (() => undefined);
  if (await finishPending(dir)) log('Finished the files of a sync that was cut short.');
  const start = await readState(dir);
  let state: ProjectState = start;
  const sources = Object.keys(start.sources ?? {})
    .sort()
    .map((id) => start.sources![id]);
  if (!sources.length) {
    log('This project has no external sources.');
    return [];
  }
  const secrets = secretsFromEnv(sources, opts.env);
  const values = [...new Set(Object.values(secrets))];
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const images: PlannedWrite[] = [];
  const out = [];
  for (const source of sources) {
    const say = (why: string) => new SyncCliError(`“${source.name}” was not synced: ${redactSecrets(why, values)}`);
    if (source.converter && typeof source.converter.code !== 'string') throw say(`its ${source.converter.file} is missing.`);
    try {
      planSourceSync(state, source, [], new Date(0).toISOString());
    } catch (e) {
      if (e instanceof SyncPlanError) throw say(e.message);
      throw e;
    }
    const own = Object.fromEntries(sourceSecretNames(source).map((n) => [n, secrets[n]]));
    let result;
    try {
      result = await opts.runner.run(source.name, { ...sourceRequest(state, source), secrets: own, known: knownHashes(state, source) });
    } catch (e) {
      throw new SyncCliError(e instanceof SyncError ? redactSecrets(e.message, values) : `“${source.name}” was not synced: it could not be read.`);
    }
    const refused = syncPreflight(state, source, result.records, now, values);
    if (refused) throw say(refused === SECRET_IN_RECORDS ? `${SECRET_IN_RECORDS}.` : refused);
    const plan = planSourceSync(state, source, result.records, now);
    if (planIsEmpty(plan)) {
      log(`${source.name}: up to date (${plan.unchanged} unchanged).`);
      out.push({ sourceId: source.id, created: 0, updated: 0, removed: 0, unpublished: 0, images: 0 });
      continue;
    }
    const fetched = new Map(result.images.map((img) => [img.key, img]));
    const known = Object.values(state.assets.assets);
    const added: AssetRecord[] = [];
    const assetIds = new Map<string, string>();
    for (const [key, wanted] of plan.images) {
      const img = fetched.get(key);
      if (!img) throw say('a picture could not be fetched.');
      const name = pictureName(wanted.name, wanted.url);
      if (holdsSecret(name, values) || values.some((v) => v.length >= MIN_SECRET_LENGTH && Buffer.from(img.bytes).includes(v))) throw say(`${SECRET_IN_RECORDS}.`);
      const got = await libraryImage(dir, img, name, [...known, ...added], now);
      if (holdsSecret(got.record.file, values)) throw say(`${SECRET_IN_RECORDS}.`);
      if (!known.includes(got.record) && !added.includes(got.record)) added.push(got.record);
      if (got.file && !images.some((f) => f.rel === got.file!.rel)) images.push(got.file);
      assetIds.set(key, got.record.id);
    }
    const ops: EditOperation[] = [...added.map((asset) => ({ type: 'asset.add', asset }) as EditOperation), ...syncOperations(plan, state, assetIds)];
    try {
      state = applyOperations(state, ops, { sourceSync: { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance } }).state;
    } catch (e) {
      throw say((e as Error).message.replace(/^Operation \d+ \([\w.]+\): /, ''));
    }
    const counts = { created: plan.creates.length, updated: plan.updates.length + plan.republish.length, removed: plan.remove.length, unpublished: plan.unpublish.length, images: added.length };
    log(`${source.name}: ${counts.created} added, ${counts.updated} updated, ${counts.unpublished} made drafts, ${counts.removed} removed, ${plan.unchanged} unchanged, ${counts.images} new pictures.`);
    out.push({ sourceId: source.id, ...counts });
  }
  // Only the documents a sync changed, as the app writes them: an entry it left alone keeps its file as it is.
  const before = stateToDocs(start);
  const after = stateToDocs(state);
  const docs: PlannedWrite[] = [];
  const removed: PlannedWrite[] = [];
  for (const [rel, text] of after) if (before.get(rel) !== text) docs.push({ rel, data: text });
  for (const rel of before.keys()) if (!after.has(rel)) removed.push({ rel, data: null });
  // Pictures first, then the library that names them, then what shows them; what was removed goes last.
  const assets = docs.filter((d) => d.rel === 'siteorigin/assets.json');
  const writes = [...images, ...assets, ...docs.filter((d) => d.rel !== 'siteorigin/assets.json'), ...removed];
  if (holdsSecret(writes.map((w) => (typeof w.data === 'string' ? w.data : '')).join('\n'), values)) throw new SyncCliError(`Nothing was synced: ${SECRET_IN_RECORDS}.`);
  if (writes.length) await commitWrites(dir, writes);
  return out;
}

/** Only what a process needs to start and find its temporary folder: the secrets a source needs go in its request. */
function workerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (env[k]) out[k] = env[k]!;
  return out;
}

/** A runner that reads each source in a child process of this script, as the app reads each in a worker of its own. */
export function childRunner(script: string): SyncRunner {
  return createSyncRunner((): SyncHandle => {
    const child = fork(script, [WORKER_FLAG], { serialization: 'advanced', env: workerEnv(process.env), execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    return {
      postMessage: (m: SyncRequest) => void child.send(m),
      on: (event: string, listener: (...a: never[]) => void) => child.on(event, listener as (...a: unknown[]) => void),
      kill: () => child.kill()
    } as SyncHandle;
  });
}

/** The child's side: read the one source it is asked for, answer, and end. */
function serveWorker() {
  process.once('message', async (m: SyncRequest) => {
    let reply: SyncReply;
    try {
      reply = await runSync(m, { adapters: ADAPTERS, fetchImage, checkHost });
    } catch {
      reply = { id: m?.id ?? 0, ok: false, code: 'failed' };
    }
    process.send!(reply, () => process.exit(0));
  });
}

/**
 * The themes that ship with the app, as checking a sync against the project needs them: their tokens, components and
 * which fonts they have, without the font files (a check compares the project before and after the sync, so what a
 * file would add reads the same on both sides). A project on another theme is checked against the default one.
 */
export function registerSyncPacks() {
  registerPacks(BUILTIN_PACKS.map(({ fonts, ...pack }) => ({ ...pack, fonts: fonts.map(({ css: _css, noticeFile: _notice, subsets: _subsets, ...f }) => ({ ...f, notice: '', faces: [] })), source: 'bundled' }) as ThemePack));
}

/** `node scripts/sync-sources.mjs [project folder]`. */
export async function cli(argv: readonly string[], script: string): Promise<number> {
  registerSyncPacks();
  const dir = resolve(argv[0] ?? process.cwd());
  try {
    await fs.access(join(dir, 'siteorigin.project.json'));
  } catch {
    console.error(`${relative(process.cwd(), dir) || '.'} is not a SiteOrigin Builder project: it has no siteorigin.project.json.`);
    return 1;
  }
  try {
    await syncProject(dir, { env: process.env, runner: childRunner(script), log: (line) => console.log(line) });
    return 0;
  } catch (e) {
    console.error(e instanceof SyncCliError ? e.message : `The sync failed: ${(e as Error).message}`);
    return 1;
  }
}

/** Run as the script itself: the bundle's entry (standalone-entry.ts) calls it. */
export function runAsScript() {
  const script = fileURLToPath(import.meta.url);
  let invoked = '';
  try {
    invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
  } catch {
    // Not a file.
  }
  if (invoked !== realpathSync(script)) return;
  if (process.argv[2] === WORKER_FLAG) serveWorker();
  else void cli(process.argv.slice(2), script).then((code) => (process.exitCode = code));
}
