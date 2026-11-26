/**
 * Taking secrets out of what a source says. A sync's errors come from someone else's server, which may echo the request
 * it refused, its token and all; they are shown to the author and may be logged, so every secret value is taken out
 * first, as written and as an address or a JSON body would carry it.
 */
import { MIN_SECRET_LENGTH, secretForms } from '@shared/sources';

export const REDACTED = '[secret]';

/** `text` with every one of the secret `values` it holds replaced by [secret]. */
export function redactSecrets(text: string, values: readonly string[]): string {
  const forms = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) continue;
    for (const f of secretForms(v)) forms.add(f);
  }
  let out = text;
  // Longest first, so a value inside another is never left half shown.
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(REDACTED);
  return out;
}
