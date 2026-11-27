/**
 * Private files that never leave the project folder, by name, wherever they are in it: credentials and keys (Wrangler's
 * local secrets, `.dev.vars` and `.dev.vars.<environment>`, among them), and the app's own credential files
 * (`api-keys.json`, the source secrets of #676, the remote publishing tokens of #1157) should a copy of one land in a project,
 * with the copies an editor or a file manager leaves (`source-secrets.json~`, `.source-secrets.json.swp`,
 * `api-keys (1).json`, `source-secrets (copy).json`, `Copy of api-keys.json`). Only `.json` files: a library image
 * named after them is not one. Without case: on a case-insensitive disk, another spelling is the same file. Any
 * character after a name's start, a line break included: a file may be named with one.
 */
export const PRIVATE_FILE = /^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/is;

/** The app's own credential files, by the name before `.json`. */
export const CREDENTIAL_STEMS: readonly string[] = ['source-secrets', 'api-keys', 'remote-credentials'];

/**
 * Whether `name` is one of the app's credential files or a copy of one: told apart without a pattern that could take
 * long on a hostile name. Before `.json` is the file's name and nothing but what a copy adds (spaces, hyphens,
 * underscores, numbers, brackets, "copy"); after it, anything an editor adds (`~`, `#`, `.swp`, `.bak`).
 */
function isCredentialFile(name: string): boolean {
  let n = name.toLowerCase().replace(/^[.#]+/, '');
  if (n.startsWith('copy of ')) n = n.slice('copy of '.length);
  const at = n.indexOf('.json');
  const after = at < 0 ? '' : n.slice(at + 5);
  if (at < 0 || !(after === '' || after[0] === '~' || after[0] === '#' || after[0] === '.')) return false;
  const stem = n.slice(0, at);
  const base = CREDENTIAL_STEMS.find((s) => stem.startsWith(s));
  return !!base && stem.slice(base.length).split('copy').join('').replace(/[\s_\-()0-9]/g, '') === '';
}

/** Whether a file named `name` is private (see PRIVATE_FILE and isCredentialFile). */
export const isPrivateFileName = (name: string): boolean => PRIVATE_FILE.test(name) || isCredentialFile(name);
