/**
 * The credentials external sources sign in with: a file of the user's own (`userData/source-secrets.json`), readable
 * only by their account, as API keys are (see settings.ts). Never the operating system keychain, so the app never asks
 * for its access; never the project, its history, logs or exports. A source's settings name a secret; its value lives
 * here, by project and by the folder the project is in, so two projects can each have a "token" of their own, and so
 * can two copies of one project (an editable ZIP opened into another folder carries the project's ID): saving a value
 * in the copy never changes what the original signs in with (#1543). A project moved to another folder asks again.
 */
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { atomicWrite } from '../project/fsutil';
import { isSecretName, MIN_SECRET_LENGTH } from '@shared/sources';

/** Secrets by project ID, then by the project's folder (canonical), then by name. */
type SecretFile = Record<string, Record<string, Record<string, string>>>;

/** The longest secret kept: a signed token can be long, but a value this large is no token. */
export const MAX_SECRET_LENGTH = 16_384;

/** The secrets of the projects in one folder: what a project open there signs in with. */
export interface SecretStore {
  /** Keep `value` as project `projectId`'s secret `name` in this folder, or forget it (null). */
  set(projectId: string, name: string, value: string | null): Promise<void>;
  /** The names of the secrets project `projectId` has in this folder, never their values. */
  names(projectId: string): Promise<string[]>;
  /**
   * The values of `names` for project `projectId` in this folder, by name, for the sync worker that signs in with them.
   * Rejects, naming the first one missing, unless it has every one.
   */
  resolve(projectId: string, names: readonly string[]): Promise<Record<string, string>>;
  /**
   * Every value kept for project `projectId`, in this folder and every other one a copy of it is in, to look for in
   * what a sync brings and take out of what it says: a copy's settings can hold the original's token.
   */
  values(projectId: string): Promise<string[]>;
}

/** The user's source secret file: the secrets of the projects in folder `dir` (canonical, as the project was opened). */
export interface SecretFileStore {
  in(dir: string): SecretStore;
}

export class SecretStoreError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createSecretStore(file: () => string): SecretFileStore {
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
    // Held to what a change may save, so no value is sent that the redaction would miss.
    const sound = (v: unknown) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && v.length <= MAX_SECRET_LENGTH;
    const folder = (f: unknown) => isRecord(f) && Object.entries(f).every(([k, v]) => isSecretName(k) && sound(v));
    if (!isRecord(parsed) || !Object.values(parsed).every((p) => isRecord(p) && Object.entries(p).every(([dir, f]) => isAbsolute(dir) && folder(f))))
      throw new SecretStoreError('Your saved source secrets are damaged, so they were left as they are. Remove source-secrets.json from the app’s data folder to start again.');
    return parsed as SecretFile;
  };
  const project = (all: SecretFile, projectId: string): Record<string, Record<string, string>> => (Object.hasOwn(all, projectId) ? all[projectId] : {});
  const of = (all: SecretFile, projectId: string, dir: string): Record<string, string> => {
    const folders = project(all, projectId);
    return Object.hasOwn(folders, dir) ? folders[dir] : {};
  };
  const settled = () => writes.then(() => undefined);
  return {
    in(dir) {
      return {
        set(projectId, name, value) {
          // Checked before anything is read or written, so a refused secret leaves the saved one as it was.
          if (!projectId) return Promise.reject(new SecretStoreError('A secret belongs to a project.'));
          if (!isAbsolute(dir)) return Promise.reject(new SecretStoreError('A secret belongs to a project’s folder.'));
          if (!isSecretName(name)) return Promise.reject(new SecretStoreError('A secret’s name is letters, numbers, hyphens and underscores, starting with a letter.'));
          const v = value === null ? null : value.trim();
          if (v !== null && (v.length < MIN_SECRET_LENGTH || v.length > MAX_SECRET_LENGTH))
            return Promise.reject(new SecretStoreError(v.length > MAX_SECRET_LENGTH ? 'That secret is too long.' : `A secret is at least ${MIN_SECRET_LENGTH} characters.`));
          const write = writes.then(async () => {
            const all = await read();
            const folders = { ...project(all, projectId) };
            const mine = { ...of(all, projectId, dir) };
            if (v === null) delete mine[name];
            else mine[name] = v;
            if (Object.keys(mine).length) folders[dir] = mine;
            else delete folders[dir];
            if (Object.keys(folders).length) all[projectId] = folders;
            else delete all[projectId];
            // Created with 0600 before the rename, so the secrets are never briefly readable by other accounts.
            await atomicWrite(file(), JSON.stringify(all), { mode: 0o600 });
          });
          writes = write.catch(() => undefined);
          return write;
        },
        async names(projectId) {
          await settled();
          return Object.keys(of(await read(), projectId, dir))
            .filter(isSecretName)
            .sort();
        },
        async resolve(projectId, names) {
          await settled();
          const mine = of(await read(), projectId, dir);
          const out: Record<string, string> = {};
          for (const n of names) {
            if (!Object.hasOwn(mine, n)) throw new SecretStoreError(`The secret "${n}" is not saved for this project. Add it before syncing.`);
            out[n] = mine[n];
          }
          return out;
        },
        async values(projectId) {
          await settled();
          return [...new Set(Object.values(project(await read(), projectId)).flatMap((f) => Object.values(f)))];
        }
      };
    }
  };
}
