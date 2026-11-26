/**
 * Reading a value out of what a source sent by its path ("fields.avatar.url", "items[0].title"), and filling in the
 * secrets a source's settings name (`${secret:NAME}`). Both run in the sync worker, on what a server sent: a path only
 * ever reads an object's own properties, so nothing a record holds can reach the language's own (`__proto__`).
 */

/** One step of a path: an object's property, or a list's position. */
type Step = string | number;

const STEP_RE = /^[^.[\]]+$/;

/** A path's steps, or null when it is not one: dot-separated names, with `[n]` (or `.n`) for a position in a list. */
export function pathSteps(path: string): Step[] | null {
  if (typeof path !== 'string' || !path.trim() || path.length > 300) return null;
  const steps: Step[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d{1,6}\])*)$/.exec(part);
    if (!m) return null;
    const [, name, indexes] = m;
    if (name) {
      if (!STEP_RE.test(name)) return null;
      steps.push(/^\d{1,6}$/.test(name) ? Number(name) : name);
    } else if (!indexes) return null;
    for (const i of indexes.matchAll(/\[(\d{1,6})\]/g)) steps.push(Number(i[1]));
  }
  return steps;
}

/** Whether `path` is one a mapping can follow. */
export const isPath = (path: unknown): path is string => typeof path === 'string' && pathSteps(path) !== null;

/** The value at `path` in `value`, or undefined when any step is not there. */
export function readPath(value: unknown, path: string): unknown {
  const steps = pathSteps(path);
  if (!steps) return undefined;
  let at: unknown = value;
  for (const step of steps) {
    if (at === null || typeof at !== 'object') return undefined;
    if (Array.isArray(at)) {
      if (typeof step !== 'number' || step >= at.length) return undefined;
      at = at[step];
    } else {
      const key = String(step);
      if (!Object.hasOwn(at, key)) return undefined;
      at = (at as Record<string, unknown>)[key];
    }
  }
  return at;
}

const SECRET_RE = /\$\{secret:([A-Za-z][A-Za-z0-9_-]{0,63})\}/g;

/**
 * What is wrong with how `text` names secrets, or null: every `${` starts a `${secret:NAME}` naming one by a name a
 * secret can have, so a mistyped one is said rather than sent as it is.
 */
export function secretTemplateProblem(text: string): string | null {
  const bare = text.replace(SECRET_RE, '');
  return bare.includes('${') ? 'it names a secret in a way that cannot be read: write ${secret:NAME}, where NAME is a letter, then letters, numbers, hyphens and underscores.' : null;
}

/** The secrets `text` names with `${secret:NAME}`, once each. */
export function interpolatedSecretNames(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_RE)].map((m) => m[1]))];
}

/**
 * `text` with each `${secret:NAME}` replaced by that secret's value. A secret it names that was not sent (the store has
 * no such secret) is an error the caller reports in its own words, never by the value.
 */
export function fillSecrets(text: string, secrets: Readonly<Record<string, string>>): { text: string; missing: string | null } {
  let missing: string | null = null;
  const out = text.replace(SECRET_RE, (_all, name: string) => {
    if (Object.hasOwn(secrets, name)) return secrets[name];
    missing ??= name;
    return '';
  });
  return { text: out, missing };
}

/** `fillSecrets` for JSON text: each secret written as a JSON string holds it, so a quote in one never ends the string. */
export function fillSecretsJson(text: string, secrets: Readonly<Record<string, string>>): { text: string; missing: string | null } {
  return fillSecrets(text, Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)])));
}
