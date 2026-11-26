/**
 * The credentials external sources sign in with: a file of the user's own (`userData/source-secrets.json`), readable
 * only by their account, as API keys are (see settings.ts). Never the operating system keychain, so the app never asks
 * for its access; never the project, its history, logs or exports. A source's settings name a secret; its value lives
 * here, by project, so two projects can each have a "token" of their own.
 */
import { promises as fs } from 'node:fs';
import { atomicWrite } from '../project/fsutil';
import { isSecretName, MIN_SECRET_LENGTH } from '@shared/sources';

/** Secrets by project ID, then by name. */
type SecretFile = Record<string, Record<string, string>>;

/** The longest secret kept: a signed token can be long, but a value this large is no token. */
export const MAX_SECRET_LENGTH = 16_384;

export interface SecretStore {
  /** Keep `value` as project `projectId`'s secret `name`, or forget it (null). */
  set(projectId: string, name: string, value: string | null): Promise<void>;
  /** The names of the secrets project `projectId` has, never their values. */
  names(projectId: string): Promise<string[]>;
  /**
   * The values of `names` for project `projectId`, by name, for the sync worker that signs in with them. Rejects,
   * naming the first one missing, unless it has every one.
   */
  resolve(projectId: string, names: readonly string[]): Promise<Record<string, string>>;
  /** Every value kept for project `projectId`, to look for in what a sync brings and take out of what it says. */
  values(projectId: string): Promise<string[]>;
}

export class SecretStoreError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createSecretStore(file: () => string): SecretStore {
  // Writes go one after another, so two changes at once never lose one of them.
  let writes: Promise<unknown> = Promise.resolve();
  /**
   * The file as stored. Only a file that is not there is an empty store: one that cannot be read, or is damaged, stops
   * the read, so the next change never writes over every other project's secrets.
   */
  const read = async (): Promise<SecretFile> => {
    let text: string;
    try {
      text = await fs.readFile(file(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new SecretStoreError('Your saved source secrets could not be read.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed) || !Object.values(parsed).every((p) => isRecord(p) && Object.values(p).every((v) => typeof v === 'string')))
      throw new SecretStoreError('Your saved source secrets are damaged, so they were left as they are. Remove source-secrets.json from the app’s data folder to start again.');
    return parsed as SecretFile;
  };
  const of = (all: SecretFile, projectId: string): Record<string, string> => (Object.hasOwn(all, projectId) ? all[projectId] : {});
  const settled = () => writes.then(() => undefined);
  return {
    set(projectId, name, value) {
      // Checked before anything is read or written, so a refused secret leaves the saved one as it was.
      if (!projectId) return Promise.reject(new SecretStoreError('A secret belongs to a project.'));
      if (!isSecretName(name)) return Promise.reject(new SecretStoreError('A secret’s name is letters, numbers, hyphens and underscores, starting with a letter.'));
      const v = value === null ? null : value.trim();
      if (v !== null && (v.length < MIN_SECRET_LENGTH || v.length > MAX_SECRET_LENGTH))
        return Promise.reject(new SecretStoreError(v.length > MAX_SECRET_LENGTH ? 'That secret is too long.' : `A secret is at least ${MIN_SECRET_LENGTH} characters.`));
      const write = writes.then(async () => {
        const all = await read();
        const mine = { ...of(all, projectId) };
        if (v === null) delete mine[name];
        else mine[name] = v;
        if (Object.keys(mine).length) all[projectId] = mine;
        else delete all[projectId];
        // Created with 0600 before the rename, so the secrets are never briefly readable by other accounts.
        await atomicWrite(file(), JSON.stringify(all), { mode: 0o600 });
      });
      writes = write.catch(() => undefined);
      return write;
    },
    async names(projectId) {
      await settled();
      return Object.keys(of(await read(), projectId))
        .filter(isSecretName)
        .sort();
    },
    async resolve(projectId, names) {
      await settled();
      const mine = of(await read(), projectId);
      const out: Record<string, string> = {};
      for (const n of names) {
        if (!Object.hasOwn(mine, n)) throw new SecretStoreError(`The secret "${n}" is not saved for this project. Add it before syncing.`);
        out[n] = mine[n];
      }
      return out;
    },
    async values(projectId) {
      await settled();
      return Object.values(of(await read(), projectId));
    }
  };
}
