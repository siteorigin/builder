/**
 * The credentials the app signs in to hosts with when it pushes a publication (#1157): a file of the user's own
 * (`userData/remote-credentials.json`), readable only by their account, as API keys and source secrets are. Never the
 * operating system keychain, so the app never asks for its access; never the project, its history, a repository's
 * settings, an address, logs, exports or the editor's window.
 *
 * Each is kept for one remote binding (an opaque random ID that the project's own `.siteorigin/remote.json` holds) and
 * given out only for that binding of that very project, in that very folder, at that very repository address. A copy
 * of the project made outside the app carries the binding's ID and the project's, but not its folder, so it gets none;
 * a copy the app makes carries neither, and a binding moved to another address gets none until it is signed in again.
 */
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { atomicWrite } from '../project/fsutil';
import { approveEndpoint, GitError, MIN_REMOTE_TOKEN, remoteAuthOk } from '../git/protocol';

/** The credential file's name in the app's data folder (private-files.ts keeps it, and copies of it, out of projects). */
export const REMOTE_CREDENTIALS_FILE = 'remote-credentials.json';

/** A remote binding's ID: random, and nothing else. */
export const BINDING_ID_RE = /^rb_[0-9a-f]{24}$/;

export interface RemoteCredential {
  username: string;
  token: string;
}

/** What a credential is kept for: a project, the folder it is in (canonical), and the repository address it signs in to. */
export interface CredentialOwner {
  projectId: string;
  dir: string;
  url: string;
}

type Entry = CredentialOwner & RemoteCredential;
/** Credentials by binding ID. */
type CredentialFile = Record<string, Entry>;

export interface RemoteCredentialStore {
  /** Keep `credential` for binding `binding` of `owner`, in place of any kept for it. */
  set(binding: string, owner: CredentialOwner, credential: RemoteCredential): Promise<void>;
  /**
   * Forget the credential kept for binding `binding`, only when it was kept for exactly `owner`: a copy of the project
   * made outside the app carries the binding's ID, and disconnecting it leaves the original's credential as it is.
   */
  forget(binding: string, owner: CredentialOwner): Promise<void>;
  /** The credential kept for binding `binding`, only when it was kept for exactly `owner`; null otherwise. */
  resolve(binding: string, owner: CredentialOwner): Promise<RemoteCredential | null>;
  /** Every token kept, for a publication to be searched for: never shown, logged or sent. */
  values(): Promise<string[]>;
}

export class RemoteCredentialError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function ownerOk(o: unknown): o is CredentialOwner {
  const v = o as CredentialOwner;
  if (!isRecord(v) || typeof v.projectId !== 'string' || !v.projectId || typeof v.dir !== 'string' || !isAbsolute(v.dir) || typeof v.url !== 'string') return false;
  try {
    return approveEndpoint(v.url) === v.url;
  } catch {
    return false;
  }
}

const entryOk = (e: unknown): e is Entry => ownerOk(e) && remoteAuthOk({ username: (e as Entry).username, password: (e as Entry).token });

export function createRemoteCredentialStore(file: () => string): RemoteCredentialStore {
  // Writes go one after another, so two changes at once never lose one of them.
  let writes: Promise<unknown> = Promise.resolve();
  /**
   * The file as stored. Only a file that is not there is an empty store: one that cannot be read, or is damaged, stops
   * the read, so the next change never writes over every other credential.
   */
  const read = async (): Promise<CredentialFile> => {
    let text: string;
    try {
      text = await fs.readFile(file(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new RemoteCredentialError('Your saved publishing credentials could not be read.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed) || !Object.entries(parsed).every(([k, v]) => BINDING_ID_RE.test(k) && entryOk(v)))
      throw new RemoteCredentialError(`Your saved publishing credentials are damaged, so they were left as they are. Remove ${REMOTE_CREDENTIALS_FILE} from the app’s data folder to start again.`);
    return parsed as CredentialFile;
  };
  const change = (f: (all: CredentialFile) => void): Promise<void> => {
    const write = writes.then(async () => {
      const all = await read();
      f(all);
      // Created with 0600 before the rename, so the credentials are never briefly readable by other accounts.
      await atomicWrite(file(), JSON.stringify(all), { mode: 0o600 });
    });
    writes = write.catch(() => undefined);
    return write;
  };
  const settled = () => writes.then(() => undefined);
  return {
    set(binding, owner, credential) {
      // Checked before anything is read or written, so a refused credential leaves the saved one as it was.
      if (!BINDING_ID_RE.test(binding)) return Promise.reject(new RemoteCredentialError('A credential belongs to a remote binding.'));
      if (!ownerOk(owner)) return Promise.reject(new GitError('invalid', 'A credential belongs to a project and a repository address.'));
      const token = typeof credential?.token === 'string' ? credential.token.trim() : '';
      const username = typeof credential?.username === 'string' ? credential.username.trim() : '';
      if (!remoteAuthOk({ username, password: token })) return Promise.reject(new GitError('invalid', `A credential is a username without a colon and an access token of ${MIN_REMOTE_TOKEN} characters or more, each on one line.`));
      const entry: Entry = { projectId: owner.projectId, dir: owner.dir, url: owner.url, username, token };
      return change((all) => {
        all[binding] = entry;
      });
    },
    forget(binding, owner) {
      if (!BINDING_ID_RE.test(binding)) return Promise.resolve();
      return change((all) => {
        const e = Object.hasOwn(all, binding) ? all[binding] : null;
        if (e && e.projectId === owner.projectId && e.dir === owner.dir && e.url === owner.url) delete all[binding];
      });
    },
    async resolve(binding, owner) {
      await settled();
      if (!BINDING_ID_RE.test(binding)) return null;
      const all = await read();
      const e = Object.hasOwn(all, binding) ? all[binding] : null;
      if (!e || e.projectId !== owner.projectId || e.dir !== owner.dir || e.url !== owner.url) return null;
      return { username: e.username, token: e.token };
    },
    async values() {
      await settled();
      return Object.values(await read()).map((e) => e.token);
    }
  };
}
