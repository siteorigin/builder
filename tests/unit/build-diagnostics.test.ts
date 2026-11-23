import { describe, expect, it } from 'vitest';
import { ERROR_LIMITS, errorChain, maskSecrets, serializeBuildError } from '../../src/runtime/build-diagnostics';

describe('serializeBuildError', () => {
  it('keeps the cause a wrapper hides, with the fields Vite and Rollup attach', () => {
    const plugin = Object.assign(new Error('Unexpected token'), { plugin: 'vite-plugin-svelte', id: '/p/src/lib/Hero.svelte', loc: { file: '/p/src/lib/Hero.svelte', line: 12, column: 3 }, frame: '12: <h1>{</h1>', code: 'PARSE_ERROR' });
    const wrapper = new Error('Prerendering failed', { cause: plugin });
    const info = serializeBuildError(wrapper);
    expect(info.message).toBe('Prerendering failed');
    expect(info.cause).toMatchObject({ message: 'Unexpected token', plugin: 'vite-plugin-svelte', id: '/p/src/lib/Hero.svelte', loc: { file: '/p/src/lib/Hero.svelte', line: 12, column: 3 }, frame: '12: <h1>{</h1>', code: 'PARSE_ERROR' });
    expect(info.cause?.stack).toContain('Unexpected token');
    expect(errorChain(info).map((e) => e.message)).toEqual(['Prerendering failed', 'Unexpected token']);
  });

  it('survives a cause that points back at the error', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(errorChain(serializeBuildError(a)).map((e) => e.message)).toEqual(['a', 'b']);
  });

  it('stops following causes after a few levels', () => {
    let e = new Error('level 0');
    for (let i = 1; i < 20; i++) e = new Error(`level ${i}`, { cause: e });
    expect(errorChain(serializeBuildError(e))).toHaveLength(ERROR_LIMITS.depth);
  });

  it('takes anything that was thrown', () => {
    expect(serializeBuildError('plain text')).toEqual({ message: 'plain text' });
    expect(serializeBuildError(undefined)).toEqual({ message: 'undefined' });
    expect(serializeBuildError(null)).toEqual({ message: 'null' });
    expect(serializeBuildError({ message: 'from an object', code: 7 })).toMatchObject({ message: 'from an object', code: '7' });
    expect(serializeBuildError(Object.create(null)).message).toBe('[object Object]');
  });

  it('survives properties that throw when read', () => {
    const hostile = {
      get message(): string {
        throw new Error('no');
      },
      get stack(): string {
        throw new Error('no');
      },
      get cause(): unknown {
        throw new Error('no');
      }
    };
    expect(serializeBuildError(hostile).message).toBe('[object Object]');
  });

  it('survives a thrown value that cannot even be turned into text', () => {
    const tagged = {
      get [Symbol.toStringTag](): string {
        throw new Error('no');
      },
      toString: undefined as unknown as () => string
    };
    expect(serializeBuildError(tagged)).toEqual({ message: '[a value that cannot be shown]' });
    expect(serializeBuildError(Symbol('s')).message).toBe('Symbol(s)');
    expect(serializeBuildError(10n).message).toBe('10');
    expect(serializeBuildError(() => 1).message).toContain('=>');
  });

  it('stops following causes at its own depth limit, whatever walks the result', () => {
    let e = new Error('level 0');
    for (let i = 1; i < 20; i++) e = new Error(`level ${i}`, { cause: e });
    let depth = 0;
    for (let c: { cause?: unknown } | undefined = serializeBuildError(e); c; c = c.cause as { cause?: unknown } | undefined) depth++;
    expect(depth).toBe(ERROR_LIMITS.depth);
  });

  it('prefers a Vite error’s own module and location over a compiler’s', () => {
    const e = Object.assign(new Error('x'), { id: '/p/a.svelte', filename: '/p/b.svelte', loc: { file: '/p/a.svelte', line: 1 }, start: { line: 9 } });
    expect(serializeBuildError(e)).toMatchObject({ id: '/p/a.svelte', loc: { file: '/p/a.svelte', line: 1 } });
  });

  it('bounds what it keeps, leaving each cause its own message', () => {
    const cause = new Error('the real problem');
    const wrapper = Object.assign(new Error('x'.repeat(50_000), { cause }), { frame: 'f'.repeat(50_000) });
    wrapper.stack = 's'.repeat(50_000);
    const info = serializeBuildError(wrapper);
    expect(info.message.length).toBeLessThanOrEqual(ERROR_LIMITS.message + 1);
    expect(info.stack!.length).toBeLessThanOrEqual(ERROR_LIMITS.stack + 1);
    expect(info.frame!.length).toBeLessThanOrEqual(ERROR_LIMITS.frame + 1);
    expect(info.cause?.message).toBe('the real problem');
  });

  it('reads a Svelte compiler error’s own fields', () => {
    const e = Object.assign(new Error('Unexpected block closing tag'), { filename: '/p/src/routes/+page.svelte', start: { line: 4, column: 0 } });
    expect(serializeBuildError(e)).toMatchObject({ id: '/p/src/routes/+page.svelte', loc: { line: 4, column: 0 } });
  });
});

describe('maskSecrets', () => {
  it('hides a quoted literal whatever the other kind of quote inside it, and a short one', () => {
    expect(maskSecrets(`const password = "it's-a-secret-1";`)).toBe('const password = "…";');
    expect(maskSecrets(`const apiKey = 'say "hi" 12345678';`)).toBe(`const apiKey = '…';`);
    expect(maskSecrets('{ "token": "abc" }')).toBe('{ "token": "…" }');
  });

  it('hides a literal whose closing quote was cut off, to the end of the line', () => {
    expect(maskSecrets('const password = "hunter2hunt')).toBe('const password = "…');
    expect(maskSecrets('line one\nconst secret = \'abc\nline three')).toBe("line one\nconst secret = '…\nline three");
  });

  it('leaves an expression named like a credential alone', () => {
    expect(maskSecrets('token = componentState.currentToken')).toBe('token = componentState.currentToken');
    expect(maskSecrets('password: string')).toBe('password: string');
  });

  it('hides a credential in a URL query by its decoded name, and only its value', () => {
    expect(maskSecrets('GET /x?mode=preview&access%5Ftoken=abc123&lang=en')).toBe('GET /x?mode=preview&access%5Ftoken=…&lang=en');
    expect(maskSecrets('https://ada:pw@example.com/x?a=b:c@d')).toBe('https://…@example.com/x?a=b:c@d');
    expect(maskSecrets('/search?q=token&page=2')).toBe('/search?q=token&page=2');
  });

  it('hides an Authorization header of any length, and a long Bearer token anywhere', () => {
    expect(maskSecrets('Authorization: Basic YTpi')).toBe('Authorization: Basic …');
    expect(maskSecrets('{ authorization: "Bearer x" }')).toBe('{ authorization: "Bearer …" }');
    expect(maskSecrets('sent Bearer abcdefghijklmnop1234 and sk-live_abcdefgh12345678')).toBe('sent Bearer … and sk-…');
    expect(maskSecrets('Basic settings are used')).toBe('Basic settings are used');
  });

  it('hides a credential in a nested URL, and a literal that holds an escaped quote', () => {
    expect(maskSecrets('redirect /login?next=/preview?token=placeholder&x=1')).toBe('redirect /login?next=/preview?token=…&x=1');
    expect(maskSecrets('const password = "say \\"hi\\" and more";')).toBe('const password = "…";');
    expect(maskSecrets("const secret = 'it\\'s hidden';")).toBe("const secret = '…';");
  });

  it('does not take long on a line of question marks', () => {
    const started = Date.now();
    maskSecrets('?'.repeat(60_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is applied before a thrown error is cut short, so a secret cannot be left half-hidden at the cut', () => {
    const message = `${'a'.repeat(ERROR_LIMITS.message - 30)} const password = "supersecretvalue12345"; tail`;
    const info = serializeBuildError(new Error(message));
    expect(info.message).not.toContain('supersecret');
    expect(info.message).toContain('password = "…"');
  });
});
