/**
 * The endpoints' environment variables (#1481): names declared for SvelteKit in src/env.js (the developer's own never
 * replaced), and values kept in the project's .env, which Vite reads back exactly, and which no export, saved version
 * or preview ever carries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resolveConfig } from 'vite';
import { dotenvNames, ENV_DECLARATIONS, ENV_DECLARATIONS_FILE, ENV_NAMES_FILE, envNameProblem, envValueProblem, LOCAL_ENV_FILE, readEnvNames, setDotenv } from '@shared/endpoint-env';
import { changeEndpointVariable, readEndpointEnvironment } from '../../src/main/project/endpoint-env';
import { copyProjectSource } from '../../src/main/export';
import { snapshotPlace } from '../../src/main/project/snapshot-inventory';
import { isPrivateFileName } from '../../src/main/project/private-files';
import { previewFsPolicy, unwatched } from '../../src/runtime/policy';

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-endpoint-env-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const open = async (w: () => Promise<void>) => (await w(), true);

describe('a variable’s name and value', () => {
  it('is a name a shell and SvelteKit take, and not one the server or JavaScript keeps', () => {
    for (const n of ['SEARCH_API_KEY', '_private', 'key2']) expect(envNameProblem(n), n).toBeNull();
    for (const n of ['2KEY', 'MY-KEY', 'MY KEY', '', 'PORT', 'origin', 'NODE_ENV', 'PUBLIC_KEY', 'class', 'eval', 'arguments', 'x'.repeat(129)]) expect(envNameProblem(n), n).not.toBeNull();
    // Vite sends its own prefix's values to the browser with any module that reads import.meta.env.
    expect(envNameProblem('VITE_SERVICE_TOKEN')).toContain('VITE_');
    expect(envNameProblem('vite_token')).toContain('VITE_');
    expect(envValueProblem('a\nb')).toContain('line breaks');
    expect(envValueProblem('x'.repeat(9000))).toContain('at most');
    expect(envValueProblem(`it's "quoted" and \`ticked\``)).toContain('all at once');
    expect(envValueProblem(`it's "quoted"`)).toBeNull();
  });

  it('is written to .env so Vite reads back exactly what was typed, leaving the file’s other lines as they were', () => {
    const dir = temp();
    const values = ['plain', 'with space', 'sk_live$abc${HOME}', "it's", 'say "hi" $x', `it's "both"`, 'a#b', 'back\\slash', 'tab\there', '=leading', ''];
    let text = '# keys for local testing\nOTHER=1\n\nexport KEPT="kept value"\n';
    values.forEach((v, i) => (text = setDotenv(text, `V${i}`, v)));
    writeFileSync(join(dir, '.env'), text);
    const read = loadEnv('development', dir, '');
    values.forEach((v, i) => expect(read[`V${i}`], JSON.stringify(v)).toBe(v));
    expect(read.OTHER).toBe('1');
    expect(read.KEPT).toBe('kept value');
    expect(text.startsWith('# keys for local testing\nOTHER=1\n\nexport KEPT="kept value"\n')).toBe(true);
  });

  it('reads a quoted value over several lines as one, never a line inside it as a variable, and clears all of it', () => {
    const text = 'A=1\nCERT="-----BEGIN-----\nTOKENFRAGMENT=abc\n-----END-----"\nB=2\n';
    expect(dotenvNames(text)).toEqual(['A', 'CERT', 'B']);
    expect(setDotenv(text, 'CERT', null)).toBe('A=1\nB=2\n');
    expect(setDotenv(text, 'CERT', 'short')).toBe('A=1\nCERT=short\nB=2\n');
    const dir = temp();
    writeFileSync(join(dir, '.env'), setDotenv(text, 'CERT', null));
    expect(loadEnv('development', dir, '')).toMatchObject({ A: '1', B: '2' });
    expect(loadEnv('development', dir, '').TOKENFRAGMENT).toBeUndefined();
  });

  it('is changed on its own line and removed with it, the rest kept, line endings and all', () => {
    expect(setDotenv('A=1\r\nB=2\r\n', 'A', 'x')).toBe('A=x\r\nB=2\r\n');
    expect(setDotenv('A=1\nB=2\nA=3\n', 'A', null)).toBe('B=2\n');
    expect(setDotenv('A=1\nB=2\nA=3\n', 'A', 'y')).toBe('A=y\nB=2\n');
    expect(setDotenv('A=1', 'B', '2')).toBe('A=1\nB=2\n');
    expect(setDotenv('A=1\n', 'A', null)).toBe('');
    expect(dotenvNames('# c\nA=1\nexport B = 2\n  C=\nnot a line\nA=4')).toEqual(['A', 'B', 'C']);
    expect(readEnvNames('["A","A","bad-name",3,"B"]')).toEqual(['A', 'B']);
    expect(readEnvNames('{')).toEqual([]);
  });
});

describe('the project’s environment', () => {
  it('declares a variable for SvelteKit and keeps its value in a private .env, saying only whether it has one', async () => {
    const dir = temp();
    const r = await changeEndpointVariable(dir, { name: 'SEARCH_KEY', declare: true, value: 'sk_live_123' }, open);
    expect(r).toEqual({ ok: true, changed: true, environment: { variables: [{ name: 'SEARCH_KEY', local: true, declared: true }], declarations: 'managed' } });
    expect(JSON.stringify(r)).not.toContain('sk_live_123');
    expect(JSON.parse(readFileSync(join(dir, ENV_NAMES_FILE), 'utf8'))).toEqual(['SEARCH_KEY']);
    expect(readFileSync(join(dir, ENV_DECLARATIONS_FILE), 'utf8')).toBe(ENV_DECLARATIONS);
    expect(loadEnv('development', dir, '').SEARCH_KEY).toBe('sk_live_123');
    if (process.platform !== 'win32') expect(statSync(join(dir, LOCAL_ENV_FILE)).mode & 0o777).toBe(0o600);
    // Nothing left behind by the write.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // A second variable, declared with no value here, and a value cleared.
    await changeEndpointVariable(dir, { name: 'MAIL_TOKEN', declare: true }, open);
    const cleared = await changeEndpointVariable(dir, { name: 'SEARCH_KEY', value: null }, open);
    expect(cleared).toMatchObject({ ok: true, changed: true, environment: { variables: [{ name: 'SEARCH_KEY', local: false, declared: true }, { name: 'MAIL_TOKEN', local: false, declared: true }] } });
    expect(existsSync(join(dir, LOCAL_ENV_FILE))).toBe(false);
    expect(await changeEndpointVariable(dir, { name: 'MAIL_TOKEN', declare: true }, open)).toMatchObject({ ok: true, changed: false });
  });

  it('takes the declarations away with the last variable, and lists one .env sets but nothing declares', async () => {
    const dir = temp();
    await changeEndpointVariable(dir, { name: 'A_KEY', declare: true, value: 'one' }, open);
    writeFileSync(join(dir, LOCAL_ENV_FILE), `${readFileSync(join(dir, LOCAL_ENV_FILE), 'utf8')}LOOSE=1\n`);
    expect((await readEndpointEnvironment(dir)).variables).toEqual([
      { name: 'A_KEY', local: true, declared: true },
      { name: 'LOOSE', local: true, declared: false }
    ]);
    await changeEndpointVariable(dir, { name: 'A_KEY', declare: false, value: null }, open);
    expect(existsSync(join(dir, ENV_NAMES_FILE))).toBe(false);
    expect(existsSync(join(dir, ENV_DECLARATIONS_FILE))).toBe(false);
    expect(readFileSync(join(dir, LOCAL_ENV_FILE), 'utf8')).toBe('LOOSE=1\n');
  });

  it('never replaces a src/env.js of the developer’s own', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'src'));
    const own = "import { defineEnvVars } from '@sveltejs/kit/env';\nexport const variables = defineEnvVars({ API_URL: {} });\n";
    writeFileSync(join(dir, ENV_DECLARATIONS_FILE), own);
    const r = await changeEndpointVariable(dir, { name: 'TOKEN', declare: true }, open);
    expect(r).toMatchObject({ ok: true, environment: { declarations: 'own' } });
    expect(readFileSync(join(dir, ENV_DECLARATIONS_FILE), 'utf8')).toBe(own);
    await changeEndpointVariable(dir, { name: 'TOKEN', declare: false }, open);
    expect(readFileSync(join(dir, ENV_DECLARATIONS_FILE), 'utf8')).toBe(own);
  });

  it('counts a src/env.ts, or a src/env folder, as the developer’s own declarations, and writes no src/env.js beside it', async () => {
    for (const own of ['src/env.ts', 'src/env/index.js']) {
      const dir = temp();
      mkdirSync(join(dir, own, '..'), { recursive: true });
      writeFileSync(join(dir, own), 'export const variables = {};\n');
      expect(await changeEndpointVariable(dir, { name: 'TOKEN', declare: true }, open)).toMatchObject({ ok: true, environment: { declarations: 'own' } });
      expect(existsSync(join(dir, ENV_DECLARATIONS_FILE)), own).toBe(false);
    }
  });

  it('keeps .env within what it can read back', async () => {
    const dir = temp();
    for (let i = 0; i < 127; i++) expect((await changeEndpointVariable(dir, { name: `K${i}`, value: 'v'.repeat(8192) }, open)).ok, `K${i}`).toBe(true);
    expect(await changeEndpointVariable(dir, { name: 'ONE_MORE', value: 'v'.repeat(8192) }, open)).toMatchObject({ ok: false, message: expect.stringContaining('larger than') });
    expect((await readEndpointEnvironment(dir)).variables.length).toBe(127);
  });

  it('refuses a bad change, a .env reached through a link, and a project it may no longer write', async () => {
    const dir = temp();
    expect(await changeEndpointVariable(dir, { name: 'PORT', declare: true }, open)).toMatchObject({ ok: false });
    expect(await changeEndpointVariable(dir, { name: 'OK', value: 'a\nb' }, open)).toMatchObject({ ok: false });
    expect(await changeEndpointVariable(dir, { name: 'OK', declare: true }, async () => false)).toMatchObject({ ok: false });
    expect(existsSync(join(dir, ENV_NAMES_FILE))).toBe(false);
    const elsewhere = temp();
    writeFileSync(join(elsewhere, 'secrets'), 'X=1\n');
    symlinkSync(join(elsewhere, 'secrets'), join(dir, LOCAL_ENV_FILE));
    expect(await changeEndpointVariable(dir, { name: 'OK', value: 'v' }, open)).toMatchObject({ ok: false, message: expect.stringContaining('.env') });
    expect(readFileSync(join(elsewhere, 'secrets'), 'utf8')).toBe('X=1\n');
  });

  it('never serves the local values, by Vite’s own reading of the policy, whatever SvelteKit’s output folder is called', async () => {
    const dir = temp();
    const config = await resolveConfig({ configFile: false, root: dir, logLevel: 'silent', server: { fs: previewFsPolicy(dir) } }, 'serve');
    const deny = (config as unknown as { fsDenyGlob: (p: string) => boolean }).fsDenyGlob;
    for (const f of ['.env', '.env.development.local', '.env.a1b2c3.tmp', '.svelte-kit/generated/dev/env/config.js', '.svelte-kit/generated/dev/env/private/server.js', 'kit-cache/generated/dev/env/config.js', '.svelte-kit/generated/build/env/config.js'])
      expect(deny(`${dir}/${f}`), f).toBe(true);
    for (const f of ['.svelte-kit/generated/dev/env/public/client.js', 'src/env.js', 'src/env-names.json', 'src/routes/api/search/+server.ts']) expect(deny(`${dir}/${f}`), f).toBe(false);
  });

  it('leaves SvelteKit’s generated environment out of a copy of the project, wherever its output folder is', async () => {
    const dir = temp();
    for (const f of ['kit-cache/generated/dev/env/config.js', 'kit-cache/generated/dev/env/private/server.js', 'kit-cache/generated/client/app.js', 'src/routes/+page.svelte']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
    const copy = join(temp(), 'copy');
    await copyProjectSource(dir, copy);
    expect(existsSync(join(copy, 'kit-cache/generated/dev/env/config.js'))).toBe(false);
    expect(existsSync(join(copy, 'kit-cache/generated/dev/env/private/server.js'))).toBe(false);
    expect(existsSync(join(copy, 'kit-cache/generated/client/app.js'))).toBe(true);
    expect(existsSync(join(copy, 'src/routes/+page.svelte'))).toBe(true);
  });

  it('keeps .env and its temporary copies out of exports, saved versions and the preview, while the declarations go with the project', async () => {
    const dir = temp();
    await changeEndpointVariable(dir, { name: 'SEARCH_KEY', declare: true, value: 'sk_live_123' }, open);
    for (const name of ['.env', '.env.a1b2c3d4e5f6.tmp']) {
      expect(isPrivateFileName(name), name).toBe(true);
      expect(snapshotPlace(name), name).toEqual({ kind: 'excluded', reason: 'private' });
    }
    expect(snapshotPlace(ENV_NAMES_FILE)).toEqual({ kind: 'tree' });
    expect(snapshotPlace(ENV_DECLARATIONS_FILE)).toEqual({ kind: 'tree' });
    const copy = join(temp(), 'copy');
    await copyProjectSource(dir, copy);
    expect(existsSync(join(copy, LOCAL_ENV_FILE))).toBe(false);
    expect(existsSync(join(copy, ENV_NAMES_FILE))).toBe(true);
    expect(existsSync(join(copy, ENV_DECLARATIONS_FILE))).toBe(true);
    // The preview serves none of it, nor the modules SvelteKit writes the private values into as it reads them.
    const deny = previewFsPolicy(dir).deny;
    expect(deny).toEqual(expect.arrayContaining(['.env', '.env.*', '**/generated/*/env/config.js', '**/generated/*/env/private/**']));
  });

  it('is not watched by the dev server at the project’s top, which the editor restarts for itself', () => {
    const ignored = unwatched('/work/site', 'darwin');
    for (const p of ['/work/site/.env', '/work/site/.env.local', '/work/site/.env.development.local', '/work/site/.env.a1b2.tmp']) expect(ignored(p), p).toBe(true);
    for (const p of ['/work/site/src/.env', '/work/site/src/env.js', '/work/site/src/env-names.json', '/work/site/.envrc-notes/x', '/work/site/environment.js']) expect(ignored(p), p).toBe(false);
    expect(unwatched('C:\\Users\\Ana\\site', 'win32')('C:/Users/Ana/site/.ENV')).toBe(true);
  });
});
