/**
 * The publication's parts (#1154), apart from the controller: Git's names worked out without writing (the same the
 * repository gives), trees made of blobs already written, what keeps a credential out, the published state's
 * documents, and the components the published website imports.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { openRepo } from '../../src/main/git/repo';
import { createGitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { createGitService } from '../../src/main/git/service';
import { GitError, type GitRepository } from '../../src/main/git/protocol';
import { blobOid, commitPublication, credentialProblem, PUBLISH_BRANCH, publicationState, treeOid, type PublicationFile } from '../../src/main/publication';
import { unusedComponents } from '../../src/main/export';

let root: string;
const clients: Array<ReturnType<typeof createGitClient>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-publication-'));
});
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  rmSync(root, { recursive: true, force: true });
});

const text = (s: string) => Buffer.from(s);
const file = (path: string, s: string, executable = false): PublicationFile => ({ path, size: text(s).length, oid: blobOid(text(s)), executable, read: async () => text(s) });
/** The repository of the project at `root` through the real client and the worker's service, in this process. */
function viaClient(dir: string): GitRepository {
  const client = createGitClient(() => {
    const on: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (e: string, x?: unknown) => (on[e] ?? []).forEach((l) => l(x));
    const service = createGitService((reply) => setImmediate(() => emit('message', structuredClone(reply))));
    let alive = true;
    return {
      postMessage: (m) => void service.handle(structuredClone(m)),
      on: (e: string, l: (x?: unknown) => void) => ((on[e] ??= []).push(l), undefined),
      kill: () => (alive ? ((alive = false), setImmediate(() => emit('exit', 0)), true) : false)
    } as GitWorkerHandle;
  });
  clients.push(client);
  return client.repository(dir);
}
const write = (dir: string, rel: string, s: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), s);
};

describe("Git's names, worked out without writing", () => {
  it('names a tree as the repository does, folders sorted as Git sorts them, a file that runs by its mode', async () => {
    // Through the client, which copies each file input as a worker gets it.
    const repo = viaClient(root);
    await repo.init();
    // `a.b` sorts before the folder `a` (as `a/`), `a-b` before both; names outside ASCII by their bytes, which puts
    // `！` (U+FF01) before an emoji, where JavaScript's own order of UTF-16 units puts it after.
    const files = [file('a/x.txt', 'x'), file('a.b', 'ab'), file('a-b', 'a-b'), file('z/é.txt', 'é'), file('z/ü/deep.json', '{}'), file('z/\u{1F600}.txt', 'smile'), file('z/\uFF01.txt', 'bang'), file('scripts/check.sh', '#!/bin/sh\n', true), file('README.md', 'Hello')];
    for (const f of files) expect(await repo.writeBlob({ bytes: await f.read() })).toBe(f.oid);
    const tree = await repo.writeFiles(files.map((f) => ({ path: f.path, oid: f.oid, ...(f.executable ? { mode: '100755' as const } : {}) })));
    expect(treeOid(files)).toBe(tree);
    const scripts = (await repo.readTree(tree)).find((e) => e.path === 'scripts')!;
    expect(await repo.readTree(scripts.oid)).toEqual([{ mode: '100755', path: 'check.sh', oid: files[7].oid, type: 'blob' }]);
    const z = (await repo.readTree(tree)).find((e) => e.path === 'z')!;
    expect((await repo.readTree(z.oid)).map((e) => e.path)).toEqual(['é.txt', 'ü', '\uFF01.txt', '\u{1F600}.txt']);
    // The same files in another order are the same tree.
    expect(treeOid([...files].reverse())).toBe(tree);
  });

  it('makes a tree of blobs already written, and refuses one that is missing or is not a file', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await repo.writeBlob({ bytes: text('a') });
    const tree = await repo.writeFiles([{ path: 'a.txt', oid: a }]);
    expect(new TextDecoder().decode(await repo.readBlob(tree, 'a.txt'))).toBe('a');
    await expect(repo.writeFiles([{ path: 'b.txt', oid: blobOid(text('never written')) }])).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.writeFiles([{ path: 'nested', oid: tree }])).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.writeFiles([{ path: 'c.txt', oid: 'not an oid' }])).rejects.toMatchObject({ code: 'invalid' });
    // A blob counts toward a file's limit and the tree's as its own size does.
    await expect(openRepo(root, { limits: { maxBlobBytes: 0 } }).writeFiles([{ path: 'a.txt', oid: a }])).rejects.toMatchObject({ code: 'too-large' });
    const bb = await repo.writeBlob({ bytes: text('bb') });
    await expect(openRepo(root, { limits: { maxTotalBytes: 2 } }).writeFiles([{ path: 'a.txt', oid: a }, { path: 'b.txt', oid: bb }])).rejects.toMatchObject({ code: 'too-large' });
    expect(await openRepo(root, { limits: { maxTotalBytes: 3 } }).writeFiles([{ path: 'a.txt', oid: a }, { path: 'b.txt', oid: bb }])).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the publication history', () => {
  it('starts with a root commit, follows the last publication, makes no commit for the same website, and moves only from where it was read', async () => {
    const repo = viaClient(root);
    // The repository is made on the first publication.
    const first = await commitPublication(repo, [file('index.html', 'one')], null, { now: 1_790_000_000_000 });
    expect(first.changed).toBe(true);
    expect((await repo.readCommit(first.commit)).parents).toEqual([]);
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(first.commit);
    const last = { commit: first.commit, tree: first.tree };
    expect(await commitPublication(repo, [file('index.html', 'one')], last)).toEqual({ ...last, changed: false });
    const second = await commitPublication(repo, [file('index.html', 'two')], last);
    expect((await repo.readCommit(second.commit)).parents).toEqual([first.commit]);
    // One prepared from what was read before the second moved the branch is refused, not put on top of it unseen.
    await expect(commitPublication(repo, [file('index.html', 'three')], last)).rejects.toMatchObject({ code: 'conflict' });
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(second.commit);
    const commit = await repo.readCommit(second.commit);
    expect(commit.author).toMatchObject({ name: 'SiteOrigin Builder', email: 'publish@siteorigin.invalid', timezoneOffset: 0 });
    expect(new TextDecoder().decode(await repo.readBlob(second.commit, 'index.html'))).toBe('two');
    // The website as it was when the branch was read, while another publication moved it since: not said to be the last.
    await expect(commitPublication(repo, [file('index.html', 'one')], last)).rejects.toMatchObject({ code: 'conflict' });
    // A file changed between being listed and being written is not committed as either.
    const drifted = { ...file('index.html', 'four'), read: async () => text('five') };
    await expect(commitPublication(repo, [drifted], { commit: second.commit, tree: second.tree })).rejects.toMatchObject({ code: 'changed' });
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(second.commit);
  });

  it('reads the branch back when the worker lost whether it moved, and says so only when it cannot tell', async () => {
    const repo = viaClient(root);
    const lost = (moves: boolean, readable = true): GitRepository => ({
      ...repo,
      advanceRef: async (ref, next, expected) => {
        if (moves) await repo.advanceRef(ref, next, expected);
        throw new GitError('outcome-unknown', 'lost');
      },
      resolveRef: readable ? repo.resolveRef : async () => Promise.reject(new GitError('crashed', 'gone'))
    });
    const moved = await commitPublication(lost(true), [file('index.html', 'one')], null);
    expect(moved).toMatchObject({ changed: true });
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(moved.commit);
    const last = { commit: moved.commit, tree: moved.tree };
    await expect(commitPublication(lost(false), [file('index.html', 'two')], last)).rejects.toMatchObject({ code: 'outcome-unknown' });
    await expect(commitPublication(lost(true, false), [file('index.html', 'three')], last)).rejects.toMatchObject({ code: 'outcome-unknown' });
  });
});

describe('what keeps a credential out', () => {
  // Quotes, slashes and pluses, so JSON and an address each write it differently from how it was saved.
  const KEY = 'sk/test+9f8e7d6c "5b4a3f2e1d0c"';
  const at = (path: string, s: string | Buffer) => [{ path, read: async () => (typeof s === 'string' ? text(s) : s) }];

  it('stops for a secret as written, escaped as JSON writes it, or encoded in an address, naming the file and never the secret', async () => {
    const forms = [`const key = ${"`"}${KEY}${"`"};`, JSON.stringify({ k: KEY }), `https://api.example/?key=${encodeURIComponent(KEY)}`, `token=${new URLSearchParams({ v: KEY }).toString().slice(2)}`];
    for (const [i, s] of forms.entries()) {
      if (i > 0) expect(s, 'the form differs from the secret as saved').not.toContain(KEY);
      const problem = await credentialProblem(at('src/routes/+page.svelte', s), [KEY]);
      expect(problem).toBe('src/routes/+page.svelte holds one of your secrets. Take it out, then prepare the publication again.');
      expect(problem).not.toContain(KEY);
    }
    // In a text file saved as UTF-16, either way round, as some editors save one.
    expect(await credentialProblem(at('static/notes.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key: ${KEY}`, 'utf16le')])), [KEY])).toMatch(/^static\/notes\.txt holds one of your secrets/);
    expect(await credentialProblem(at('static/notes.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`key: ${KEY}`, 'utf16le').swap16()])), [KEY])).toMatch(/^static\/notes\.txt holds one of your secrets/);
    // One cut short by a byte is read as far as it goes.
    expect(await credentialProblem(at('static/cut.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`key: ${KEY}`, 'utf16le').swap16(), Buffer.from([0x00])])), [KEY])).toMatch(/^static\/cut\.txt holds one of your secrets/);
    // What is searched is what is committed: a file whose bytes are not the ones listed stops.
    expect(await credentialProblem([{ path: 'a.txt', oid: blobOid(text('listed')), read: async () => text('other') }], [])).toBe('a.txt changed while the publication was being prepared. Prepare the publication again.');
    // A file named with a secret is not named.
    const named = await credentialProblem(at(`static/${encodeURIComponent(KEY)}.txt`, 'nothing'), [KEY]);
    expect(named).toMatch(/^A file of the website is named with one of your secrets\./);
    expect(named).not.toContain(encodeURIComponent(KEY));
    // A secret too short to tell from ordinary text is not looked for; the site's own words are its own.
    expect(await credentialProblem(at('README.md', 'abc and more'), ['abc'])).toBeNull();
  });

  it('stops for an address that carries a password or token, a lockfile’s among them, and npm credentials', async () => {
    const lock = (resolved: string) => JSON.stringify({ packages: { 'node_modules/x': { resolved } } }, null, 2);
    for (const [path, s] of [
      ['package-lock.json', lock('https://deploy:s3cr3t@npm.example.com/x/-/x-1.0.0.tgz')],
      ['package-lock.json', lock('https://npm.example.com/x/-/x-1.0.0.tgz?access_token=abcdef123456')],
      ['src/lib/db.js', 'const url = "postgres://admin:hunter22@db.internal:5432/site";'],
      ['static/notes', 'clone https://ghp_abcdefghijklmnopqrstuvwx@github.com/acme/site.git'],
      ['package.json', JSON.stringify({ config: { '//registry.example.com/:_authToken': 'npm_abcdef' } })],
      ['README.md', '_auth=ZGVwbG95OnMzY3IzdA=='],
      ['src/lib/config.js', 'export default { _password: "hunter2hunter2" };'],
      ['src/escaped.json', '{"url":"https:\\/\\/user:pass@host.example"}'],
      // A signed storage link pasted into a page: its credential is in its query, its name sometimes encoded.
      ['src/routes/+page.svelte', '<a href="https://bucket.s3.example.com/report.pdf?X-Amz-Credential=AKIAEXAMPLE%2F20260101&X-Amz-Signature=abc123">Report</a>'],
      ['src/routes/+page.svelte', '<a href="https://files.example.com/a.pdf?client%5Fsecret=abcdef123456">Report</a>'],
      // In HTML, its parts joined as HTML writes an ampersand.
      ['static/report.html', '<a href="https://bucket.s3.example.com/r.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Credential=AKIAEXAMPLE%2F2026">Report</a>'],
      // A lockfile's token named as code names one.
      ['package-lock.json', lock('https://npm.example.com/x/-/x-1.0.0.tgz?accessToken=abcdef123456')],
      ['src/a.html', '<a href="//downloads.example.com/archive?private_token=abcd1234efgh5678">x</a>'],
      ['src/a.js', 'fetch("https://api.example.com/Products(42)?client_secret=abcd1234efgh5678")'],
      ['src/db.js', 'const db = "postgresql://db.example.com/site?password=R7M4Q9V2K8B3N6T5";'],
      ['package.json', JSON.stringify({ config: { '//registry.example.com/:_authToken': 'process.env-build-7d9ba421c12a' } })]
    ]) {
      const problem = await credentialProblem(at(path, s), []);
      expect(problem, s).toBe(`${path} holds a web address or setting with a password or access token in it. Take the credential out, then prepare the publication again.`);
      expect(problem).not.toMatch(/s3cr3t|hunter|ghp_|abcdef/);
    }
    // Addresses with no credential in them, a username alone in another scheme, a public token in a page's own
    // address (a map's), and npm settings left empty or filled from the environment are fine.
    for (const s of [
      'resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz"',
      'git+ssh://git@github.com/acme/site.git',
      'mailto:hello@example.com',
      'See https://example.com or write to team@example.com',
      'http://localhost:5173/',
      '<iframe src="https://maps.example.com/embed?key=AIzaPublicMapsKey123&q=Shop"></iframe>',
      'Set _authToken=${NPM_TOKEN} in your .npmrc',
      "let _password = '';",
      'export default { _password: process.env.NPM_PASSWORD };',
      // Examples and values filled in when the site runs.
      'Sign in at https://shop.example.com/login?password=YOUR_PASSWORD',
      'fetch(`https://api.example.com/x?password=${env.PASSWORD}`)',
      'const q = "?password=hunter2hunter2";',
      '<a href="https://docs.example.com/accounts#search?lang=en&amp;password=reset-options">Reset</a>'
    ])
      expect(await credentialProblem(at('src/a.js', s), []), s).toBeNull();
    // A lockfile's public cache key is no credential.
    expect(await credentialProblem(at('package-lock.json', lock('https://registry.example.com/x/-/x-1.0.0.tgz?cacheKey=a93f84c17d25')), [])).toBeNull();
    // A binary file is not read as text.
    expect(await credentialProblem(at('static/a.png', Buffer.concat([Buffer.from([0x89, 0, 0]), text(KEY)])), [KEY])).toBeNull();
  });
});

describe('the published state', () => {
  function sourced(): ProjectState {
    let state = createStarterState('blank', 'Bookshop', false);
    state = applyOperations(state, [
      { type: 'collection.create', collectionId: 'books' },
      { type: 'entry.create', collectionId: 'books', entryId: 'en_live1', title: 'Out now', publishedAt: '2026-01-12', draft: false },
      { type: 'entry.create', collectionId: 'books', entryId: 'en_draft1', title: 'Coming in spring', publishedAt: '2026-01-13', draft: true },
      { type: 'page.create', pageId: 'pg_secret1', title: 'Launch plans' },
      { type: 'page.update', pageId: 'pg_secret1', draft: true }
    ]).state;
    const c = state.collections.books;
    // Synced from a source, as a sync leaves them.
    c.settings.sourceId = 'catalogue';
    for (const e of Object.values(c.entries)) e.source = { sourceId: 'catalogue', externalId: e.id, syncedAt: '2026-01-14T00:00:00Z', contentHash: 'abc' };
    c.settings.fields.related = { type: 'reference', label: 'Related', collection: 'books', multiple: true, default: ['en_draft1'] } as never;
    c.settings.fields.next = { type: 'reference', label: 'Next', collection: 'books', default: '' } as never;
    c.settings.fields.note = { type: 'string', label: 'Note', default: '' } as never;
    c.entries.en_live1.values = { related: ['en_live1', 'en_draft1'], next: 'en_draft1', note: 'en_draft1' };
    // An old address of the author's own, kept as it is.
    state.site.redirects = [{ from: '/old-shop/', pageId: state.site.homePageId, custom: true }];
    state.sources = { catalogue: { schemaVersion: 1, id: 'catalogue', name: 'Catalogue', adapter: 'json' } as never };
    state.brief = { schemaVersion: 1, description: 'Our secret plans', notes: '' } as never;
    state.published = { pages: { '/launch-plans/': 'pg_secret1' } };
    state.manifest.workingCopyName = 'Greg’s laptop copy';
    return state;
  }

  it('leaves out drafts, the brief, sources and what only the project records, and detaches every collection', () => {
    const state = sourced();
    const before = JSON.stringify(state);
    const p = publicationState(state);
    expect(JSON.stringify(state), 'the project is left as it was').toBe(before);
    expect(Object.hasOwn(p.pages, 'pg_secret1')).toBe(false);
    expect(Object.keys(p.collections.books.entries)).toEqual(['en_live1']);
    expect(p.brief).toBeUndefined();
    expect(p.sources).toBeUndefined();
    expect(p.published).toBeUndefined();
    expect(p.manifest.workingCopyName).toBeUndefined();
    expect(p.manifest.projectId).toBe(state.manifest.projectId);
    expect(p.collections.books.settings.sourceId).toBeUndefined();
    expect(p.collections.books.entries.en_live1.source).toBeUndefined();
    // Its synced words stay: they are the site's own now.
    expect(p.collections.books.entries.en_live1.title).toBe('Out now');
    // No reference names the withheld entry; a field of another kind says what it says.
    expect(p.collections.books.entries.en_live1.values).toEqual({ related: ['en_live1'], next: '', note: 'en_draft1' });
    expect((p.collections.books.settings.fields.related as { default: string[] }).default).toEqual([]);
    // The redirect the project keeps is the very one, so its document reads the same with drafts or without.
    expect(p.site.redirects).toEqual([{ from: '/old-shop/', pageId: state.site.homePageId, custom: true }]);
    expect(JSON.stringify({ ...p, collections: { books: { ...p.collections.books, entries: { en_live1: { ...p.collections.books.entries.en_live1, values: {} } } } } })).not.toMatch(/en_draft1|Coming in spring|Launch plans|secret plans|catalogue/);
  });
});

describe('the components the published website imports', () => {
  const def = (id: string, extra: Partial<ComponentDefinition> = {}) => ({ id, name: id, kind: 'managed', ...extra }) as ComponentDefinition;

  it('follows imports from the site’s own files through component files, dependencies and designs, and keeps nothing a comment or a word mentions', async () => {
    const dir = join(root, 'site');
    const gen = 'src/lib/siteorigin/generated';
    const state = {
      site: { webmcp: false },
      components: {
        hero: def('hero'),
        card: def('card'),
        orphan: def('orphan'),
        lazy: def('lazy'),
        coded: def('coded', { kind: 'code', sourcePath: 'src/lib/siteorigin/custom/Coded.svelte', dependencies: ['badge'] }),
        badge: def('badge'),
        design: def('design'),
        converted: def('converted', { kind: 'code', sourcePath: 'src/lib/siteorigin/custom/Converted.svelte', generatedFrom: 'design' }),
        raw: def('raw'),
        old: def('old'),
        unused: def('unused', { kind: 'code', sourcePath: 'src/lib/siteorigin/custom/Unused.svelte' })
      }
    } as unknown as ProjectState;
    write(dir, 'src/routes/+page.svelte', `<script>\n  import Hero from '$lib/siteorigin/generated/hero.svelte';\n  import Coded from '$lib/siteorigin/custom/Coded.svelte';\n</script>\n<!-- formerly imported orphan.svelte -->\n<p>See unused.svelte</p>`);
    write(dir, 'src/routes/later/+page.svelte', `<script>\n  const Lazy = import('$lib/siteorigin/generated/lazy.svelte');\n  import Converted from '$lib/siteorigin/custom/Converted.svelte';\n  import source from '$lib/siteorigin/generated/raw.svelte?raw';\n  // import Old from '$lib/siteorigin/generated/old.svelte';\n  /* import Old from '$lib/siteorigin/generated/old.svelte'; */\n</script>`);
    for (const f of ['design', 'raw', 'old']) write(dir, `${gen}/${f}.svelte`, '<p></p>');
    write(dir, 'src/lib/siteorigin/custom/Converted.svelte', '<p>converted</p>');
    write(dir, `${gen}/hero.svelte`, `<script>import Card from './card.svelte';</script>`);
    write(dir, `${gen}/card.svelte`, '<div></div>');
    write(dir, `${gen}/orphan.svelte`, `<script>import Card from './card.svelte';</script><p>Embargoed sentence</p>`);
    write(dir, `${gen}/lazy.svelte`, '<p></p>');
    write(dir, `${gen}/badge.svelte`, '<p></p>');
    write(dir, 'src/lib/siteorigin/custom/Coded.svelte', '<p>coded</p>');
    write(dir, 'src/lib/siteorigin/custom/Unused.svelte', `<script>import Orphan from '$lib/siteorigin/generated/orphan.svelte';</script>`);
    // Imported only in comments: old. Through the design converted code was made from: design. With a query: raw.
    expect(await unusedComponents(dir, state)).toEqual(['old', 'orphan', 'unused']);
  });
});
