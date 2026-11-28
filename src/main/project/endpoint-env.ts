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
import { dotenvNames, ENV_DECLARATIONS, ENV_DECLARATIONS_FILE, ENV_NAMES_FILE, envNameProblem, envNamesJson, envValueProblem, LOCAL_ENV_FILE, managedDeclarations, MAX_ENV_NAMES, readEnvNames, setDotenv, type EndpointEnvironment, type EnvChange } from '@shared/endpoint-env';
import { atomicWrite, safeJoinLooking } from './fsutil';

export type { EnvChange };

/** The largest .env the panel reads, in bytes. */
const MAX_DOTENV_BYTES = 256 * 1024;

/** A plain file's text below `dir`, null when nothing is there; refused through a link or for anything but a file. */
async function readPlain(dir: string, rel: string, max: number): Promise<string | null> {
  const { abs, st } = safeJoinLooking(dir, rel);
  if (st === null) return null;
  if (st === undefined) throw new Error(`${rel} is not a plain file in the project (it is a folder, or reached through a link), so it is left as it is.`);
  if (Number(st.size) > max) throw new Error(`${rel} is too large to read here.`);
  return fs.readFile(abs, 'utf8');
}

/** The project's environment, as the Endpoints panel shows it: names, and whether each has a local value. */
export async function readEndpointEnvironment(dir: string): Promise<EndpointEnvironment> {
  const [names, dotenv, declarations] = await Promise.all([readPlain(dir, ENV_NAMES_FILE, 64 * 1024).then(readEnvNames), readPlain(dir, LOCAL_ENV_FILE, MAX_DOTENV_BYTES).then((t) => t ?? ''), readPlain(dir, ENV_DECLARATIONS_FILE, 256 * 1024)]);
  const local = new Set(dotenvNames(dotenv));
  // A variable .env sets that no declaration names is listed too, so it can be declared: undeclared, no endpoint can read it.
  const undeclared = [...local].filter((n) => !names.includes(n) && !envNameProblem(n));
  return {
    variables: [...names.map((name) => ({ name, local: local.has(name), declared: true })), ...undeclared.map((name) => ({ name, local: true, declared: false }))],
    declarations: managedDeclarations(declarations) ? 'managed' : 'own'
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
  const { abs, st } = safeJoinLooking(dir, LOCAL_ENV_FILE);
  if (st === undefined) throw new Error(`${LOCAL_ENV_FILE} is not a plain file in the project, so it is left as it is.`);
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
      const [namesText, dotenv, declarations] = await Promise.all([readPlain(dir, ENV_NAMES_FILE, 64 * 1024), readPlain(dir, LOCAL_ENV_FILE, MAX_DOTENV_BYTES), readPlain(dir, ENV_DECLARATIONS_FILE, 256 * 1024)]);
      const names = readEnvNames(namesText);
      if (change.declare !== undefined) {
        const has = names.includes(change.name);
        if (change.declare && !has && names.length >= MAX_ENV_NAMES) {
          refused = `A project can declare at most ${MAX_ENV_NAMES} variables here.`;
          return;
        }
        const next = change.declare ? (has ? names : [...names, change.name]) : names.filter((n) => n !== change.name);
        if (next.length !== names.length) {
          const managed = managedDeclarations(declarations);
          if (next.length) {
            await atomicWrite(safeJoinLooking(dir, ENV_NAMES_FILE).abs, envNamesJson(next));
            if (managed && declarations !== ENV_DECLARATIONS) await atomicWrite(safeJoinLooking(dir, ENV_DECLARATIONS_FILE).abs, ENV_DECLARATIONS);
          } else {
            await fs.rm(safeJoinLooking(dir, ENV_NAMES_FILE).abs, { force: true });
            if (managed && declarations !== null) await fs.rm(safeJoinLooking(dir, ENV_DECLARATIONS_FILE).abs, { force: true });
          }
          changed = true;
        }
      }
      if (change.value !== undefined) {
        const before = dotenv ?? '';
        const after = setDotenv(before, change.name, change.value);
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
