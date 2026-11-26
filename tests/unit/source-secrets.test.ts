/**
 * The secrets external sources sign in with (#676): kept in the user's own source-secrets.json, readable only by their
 * account and never by the project; named, by project, so two projects keep their own; and taken out of anything a
 * source says before it is shown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretStore } from '../../src/main/sources/secrets';
import { redactSecrets } from '../../src/main/sources/redact';
import { holdsSecretValue } from '@shared/sources';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'so-secrets-'));
  dirs.push(dir);
  const file = join(dir, 'source-secrets.json');
  return { file, secrets: createSecretStore(() => file) };
}

describe('the source secret store', () => {
  it('keeps each project’s secrets apart, readable only by the user, and hands out only those asked for', async () => {
    const { file, secrets } = store();
    await secrets.set('proj_a', 'token', '  tok-aaaa-1111  ');
    await secrets.set('proj_b', 'token', 'tok-bbbb-2222');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await secrets.names('proj_a')).toEqual(['token']);
    expect(await secrets.resolve('proj_a', ['token'])).toEqual({ token: 'tok-aaaa-1111' });
    expect(await secrets.resolve('proj_b', ['token'])).toEqual({ token: 'tok-bbbb-2222' });
    await expect(secrets.resolve('proj_a', ['token', 'other'])).rejects.toThrow('The secret "other" is not saved for this project.');
    // Replaced, the file is still the user's alone.
    await secrets.set('proj_a', 'token', 'tok-aaaa-3333');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await secrets.set('proj_a', 'token', null);
    expect(await secrets.names('proj_a')).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ proj_b: { token: 'tok-bbbb-2222' } });
  });

  it('loses neither of two changes made at once', async () => {
    const { secrets } = store();
    await Promise.all([secrets.set('p', 'one', 'value-1'), secrets.set('p', 'two', 'value-2'), secrets.set('q', 'one', 'value-3')]);
    expect(await secrets.names('p')).toEqual(['one', 'two']);
    expect(await secrets.values('q')).toEqual(['value-3']);
  });

  it('refuses a bad name or value before anything is written, and never writes over a damaged file', async () => {
    const { file, secrets } = store();
    await expect(secrets.set('p', '1token', 'value-1')).rejects.toThrow(/name/);
    await expect(secrets.set('p', 'constructor', 'value-1')).rejects.toThrow(/name/);
    await expect(secrets.set('p', 'token', 'abc')).rejects.toThrow('A secret is at least 4 characters.');
    expect(() => statSync(file)).toThrow();
    writeFileSync(file, '{"other": {"token": "keep-me"}');
    await expect(secrets.set('p', 'token', 'value-1')).rejects.toThrow(/damaged/);
    await expect(secrets.names('p')).rejects.toThrow(/damaged/);
    expect(readFileSync(file, 'utf8')).toBe('{"other": {"token": "keep-me"}');
  });
});

describe('taking secrets out of what a source says', () => {
  it('replaces each secret as written, as an address or JSON carries it, and the longest first', () => {
    const secrets = ['s3cr3t/t0ken+x', 's3cr3t'];
    const said = `refused s3cr3t/t0ken+x at https://api.example/?key=${encodeURIComponent('s3cr3t/t0ken+x')} body {"t":${JSON.stringify('s3cr3t/t0ken+x')}} and s3cr3t`;
    const out = redactSecrets(said, secrets);
    expect(out).not.toContain('s3cr3t');
    expect(out).toBe('refused [secret] at https://api.example/?key=[secret] body {"t":"[secret]"} and [secret]');
    expect(redactSecrets('nothing here', secrets)).toBe('nothing here');
  });

  it('finds a secret written into a document, escaped or not', () => {
    expect(holdsSecretValue(JSON.stringify({ name: 'Team tok"en-1' }), ['tok"en-1'])).toBe(true);
    expect(holdsSecretValue('{"name":"Team"}', ['tok"en-1'])).toBe(false);
  });
});
