/**
 * Private files that never leave the project folder, by name, wherever they are in it: credentials and keys, and the
 * app's own credential files (`api-keys.json`, the source secrets of #676) should a copy of one land in a project,
 * with any copy an editor left beside it (`source-secrets.json~`, `.source-secrets.json.swp`, `#api-keys.json#`).
 * Without case: on a case-insensitive disk, another spelling is the same file.
 */
export const PRIVATE_FILE =
  /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg)|[.#]?(source-secrets|api-keys)\.json([~#]|\..*)?)$/i;

/** Whether a file named `name` is private (see PRIVATE_FILE). */
export const isPrivateFileName = (name: string): boolean => PRIVATE_FILE.test(name);
