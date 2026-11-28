/**
 * The environment variables of the project's endpoints on disk (#1481, shared/endpoint-env.ts): their names in
 * src/env-names.json, declared by the src/env.js the panel writes, and their local values in the project's .env. A
 * value is read and written here and nowhere else: what leaves is whether a variable has one. .env is written whole,
 * mode 0600, through a temporary file whose name is itself private (`.env.<random>.tmp`), so neither an export, a
 * saved version nor the preview server ever has it (main/project/private-files.ts, runtime/policy.ts). Nothing here
 * depends on Electron, so it is unit tested directly.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dotenvNames, ENV_DECLARATIONS, ENV_DECLARATIONS_FILE, ENV_NAMES_FILE, envNameProblem, envNamesJson, envValueProblem, LOCAL_ENV_FILE, managedDeclarations, MAX_DOTENV_BYTES, MAX_ENV_NAMES, OTHER_DECLARATION_FILES, readEnvNames, setDotenv, type EndpointEnvironment, type EnvChange } from '@shared/endpoint-env';
import { atomicWrite } from './fsutil';
import { lookPlain } from './endpoints';

export type { EnvChange };

/** A plain file's text below `dir`, null when nothing is there; refused through a link or for anything but a file. */
async function readPlain(dir: string, rel: string, max: number): Promise<string | null> {
  const { abs, kind } = plainAt(dir, rel);
  if (kind === 'missing') return null;
  if ((await fs.stat(abs)).size > max) throw new Error(`${rel} is too large to read here.`);
  return fs.readFile(abs, 'utf8');
}

/** `rel` below `dir` when it is a plain file or nothing; anything else (a link, a folder) is refused. */
function plainAt(dir: string, rel: string): { abs: string; kind: 'file' | 'missing' } {
  const at = lookPlain(dir, rel);
  if (at.kind === 'other') throw new Error(`${rel} is not a plain file in the project (it is a folder, or reached through a link), so it is left as it is.`);
  return { abs: at.abs, kind: at.kind };
}

/**
 * Whether the declarations SvelteKit reads are the panel's own: a src/env.js it wrote, or none, with no other file
 * SvelteKit would take them from instead (src/env.ts, a src/env folder).
 */
async function declarationsManaged(dir: string, declarations: string | null): Promise<boolean> {
  if (!managedDeclarations(declarations)) return false;
  return OTHER_DECLARATION_FILES.every((f) => lookPlain(dir, f).kind === 'missing');
}

/** The project's environment, as the Endpoints panel shows it: names, and whether each has a local value. */
export async function readEndpointEnvironment(dir: string): Promise<EndpointEnvironment> {
  const [names, dotenv, declarations] = await Promise.all([readPlain(dir, ENV_NAMES_FILE, 64 * 1024).then(readEnvNames), readPlain(dir, LOCAL_ENV_FILE, MAX_DOTENV_BYTES).then((t) => t ?? ''), readPlain(dir, ENV_DECLARATIONS_FILE, 256 * 1024)]);
  const managed = await declarationsManaged(dir, declarations);
  const local = new Set(dotenvNames(dotenv));
  // A variable .env sets that no declaration names is listed too, so it can be declared: undeclared, no endpoint can read it.
  const undeclared = [...local].filter((n) => !names.includes(n) && !envNameProblem(n));
  return {
    variables: [...names.map((name) => ({ name, local: local.has(name), declared: true })), ...undeclared.map((name) => ({ name, local: true, declared: false }))],
    declarations: managed ? 'managed' : 'own'
  };
}


/** Why `change` cannot be made, or null. */
export function envChangeProblem(change: EnvChange): string | null {
  if (!change || typeof change !== 'object' || typeof change.name !== 'string') return 'Name the variable.';
  const name = envNameProblem(change.name);
  if (name) return name;
  if (change.declare !== undefined && typeof change.declare !== 'boolean') return 'Say whether the variable is declared.';
  if (change.value !== undefined && change.value !== null && typeof change.value !== 'string') return 'A value must be text.';
  if (typeof change.value === 'string') return envValueProblem(change.value);
  return null;
}

/** Write .env whole, mode 0600, through a temporary file with a private name, never through a link. */
async function writeDotenv(dir: string, text: string): Promise<void> {
  const { abs } = plainAt(dir, LOCAL_ENV_FILE);
  if (!text) {
    await fs.rm(abs, { force: true });
    return;
  }
  const tmp = join(dir, `${LOCAL_ENV_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Make `change` in the project at `dir`, inside `fence` (the controller's writeFence). Declaring a name adds it to
 * src/env-names.json and, while src/env.js is the panel's own (or there is none), writes the declarations that read
 * it; the last name undeclared takes both away. The developer's own src/env.js is never replaced. Says whether
 * anything changed, which the caller restarts the preview for.
 */
export async function changeEndpointVariable(dir: string, change: EnvChange, fence: (write: () => Promise<void>) => Promise<boolean>): Promise<{ ok: true; changed: boolean; environment: EndpointEnvironment } | { ok: false; message: string }> {
  const problem = envChangeProblem(change);
  if (problem) return { ok: false, message: problem };
  let changed = false;
  let refused: string | null = null;
  try {
    const wrote = await fence(async () => {
      const [namesText, declarations] = await Promise.all([readPlain(dir, ENV_NAMES_FILE, 64 * 1024), readPlain(dir, ENV_DECLARATIONS_FILE, 256 * 1024)]);
      const names = readEnvNames(namesText);
      // Refused whole before anything is written: a value .env has no room for declares nothing either.
      if (typeof change.value === 'string' && Buffer.byteLength(setDotenv((await readPlain(dir, LOCAL_ENV_FILE, MAX_DOTENV_BYTES)) ?? '', change.name, change.value)) > MAX_DOTENV_BYTES) {
        refused = `.env would be larger than ${MAX_DOTENV_BYTES / 1024 / 1024} MB: remove a variable you no longer need first.`;
        return;
      }
      if (change.declare !== undefined) {
        const has = names.includes(change.name);
        if (change.declare && !has && names.length >= MAX_ENV_NAMES) {
          refused = `A project can declare at most ${MAX_ENV_NAMES} variables here.`;
          return;
        }
        const next = change.declare ? (has ? names : [...names, change.name]) : names.filter((n) => n !== change.name);
        if (next.length !== names.length) {
          const managed = await declarationsManaged(dir, declarations);
          if (next.length) {
            await atomicWrite(plainAt(dir, ENV_NAMES_FILE).abs, envNamesJson(next));
            if (managed && declarations !== ENV_DECLARATIONS) await atomicWrite(plainAt(dir, ENV_DECLARATIONS_FILE).abs, ENV_DECLARATIONS);
          } else {
            await fs.rm(plainAt(dir, ENV_NAMES_FILE).abs, { force: true });
            if (managed && declarations !== null) await fs.rm(plainAt(dir, ENV_DECLARATIONS_FILE).abs, { force: true });
          }
          changed = true;
        }
      }
      if (change.value !== undefined) {
        // Read just before it is replaced, so a change made to it in another editor meanwhile is kept.
        const before = (await readPlain(dir, LOCAL_ENV_FILE, MAX_DOTENV_BYTES)) ?? '';
        const after = setDotenv(before, change.name, change.value);
        if (Buffer.byteLength(after) > MAX_DOTENV_BYTES) {
          refused = `.env would be larger than ${MAX_DOTENV_BYTES / 1024 / 1024} MB: remove a variable you no longer need first.`;
          return;
        }
        if (after !== before) {
          await writeDotenv(dir, after);
          changed = true;
        }
      }
    });
    if (!wrote) return { ok: false, message: 'The project can’t be changed here now.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (refused) return { ok: false, message: refused };
  return { ok: true, changed, environment: await readEndpointEnvironment(dir) };
}
