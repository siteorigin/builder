// The theme releases built from siteorigin/builder-components and committed here (#997): they load as the app loads
// them at startup and are the releases the lock pins, so a change to the pack format or the schema that stops them
// loading fails here, on PR CI too (vitest.config.ts reruns the suite when a release or the lock changes).
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PACK_MANIFEST, type PackManifest } from '@catalogue/pack';
import type { ThemePack } from '@catalogue/pack';
import { defaultTheme, findTheme } from '@catalogue/index';
import { loadPackDir } from '../../src/main/packs/loader';
import { loadBundledPacks, loadInstalledPacks, packPreview, packRoots } from '../../src/main/packs/installed';
import { sha } from '../../src/main/project/fsutil';
import { packFileInfo } from '../../src/main/packs/files';
import { restorePacks } from './fixtures/packs';
import { CHECKOUT_ENV, LOCKED_RELEASES, LOCK_FILE, committedReleaseProblems, findCheckout, lockJson, missingPreviews, readLock } from '../../scripts/packs/locked-releases';

const ROOT = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-committed-packs-'));
  dirs.push(d);
  return d;
};

/** An app resources folder holding only the committed releases and the lock, copied from this checkout. */
function committedCopy(): string {
  const root = tmp();
  for (const r of LOCKED_RELEASES) cpSync(join(ROOT, r.dir, r.id), join(root, r.dir, r.id), { recursive: true });
  cpSync(join(ROOT, LOCK_FILE), join(root, LOCK_FILE));
  return root;
}

/** Change a copied release's pack.json and pin the lock to the result, so only what `change` did is wrong with it. */
function repin(root: string, id: string, change: (m: PackManifest, dir: string) => void): void {
  const r = LOCKED_RELEASES.find((x) => x.id === id)!;
  const dir = join(root, r.dir, r.id);
  const manifest = JSON.parse(readFileSync(join(dir, PACK_MANIFEST), 'utf8')) as PackManifest;
  change(manifest, dir);
  const raw = JSON.stringify(manifest, null, '\t') + '\n';
  writeFileSync(join(dir, PACK_MANIFEST), raw);
  const lock = readLock(root);
  writeFileSync(join(root, LOCK_FILE), lockJson({ ...lock, packs: { ...lock.packs, [id]: { ...lock.packs[id], digest: sha(Buffer.from(raw)) } } }));
}

describe('the committed theme releases', () => {
  it('load as the app loads them at startup, as the releases the lock pins', async () => {
    const root = committedCopy();
    const userData = tmp();
    const catalogue = await loadInstalledPacks(packRoots(root, userData));
    expect(catalogue.refused).toEqual([]);
    expect(catalogue.packs.map((p) => p.id)).toEqual(['foundation', 'foundation-alt']);
    const lock = readLock(ROOT);
    for (const pack of catalogue.packs) {
      expect(pack.source).toBe('bundled');
      expect({ version: pack.version, digest: pack.digest }).toEqual(lock.packs[pack.id]);
    }
    // They are the registry the test setup made, as the app's startup registers them.
    const foundation = catalogue.packs.find((p) => p.id === 'foundation')!;
    expect(defaultTheme()).toBe(foundation);
    expect(findTheme('foundation-alt')).toBe(catalogue.packs.find((p) => p.id === 'foundation-alt'));
    expect(findTheme('foundation-alt')?.devOnly).toBe(true);
    // builder-components' Foundation is made of Svelte components.
    expect(foundation.components.every((c) => c.kind === 'code')).toBe(true);
    // Their thumbnails are served to the editor from the release.
    const [componentId, previews] = Object.entries(foundation.previews ?? {})[0];
    expect(componentId).toBeTruthy();
    expect(await packPreview('foundation', previews.default)).toMatch(/^data:image\/webp;base64,./);
  });

  it('are the themes tests and scripts load, which refuse a release that does not load rather than go without it', async () => {
    const root = committedCopy();
    const lock = readLock(ROOT);
    try {
      const loaded = await loadBundledPacks(root);
      expect(loaded.map((p) => [p.id, p.digest])).toEqual([
        ['foundation', lock.packs.foundation.digest],
        ['foundation-alt', lock.packs['foundation-alt'].digest]
      ]);
      // They are what every lookup now reads, with their files read from this copy.
      expect(findTheme('foundation')).toBe(loaded[0]);
      expect(findTheme('foundation-alt')).toBe(loaded[1]);
      expect(defaultTheme()).toBe(loaded[0]);
      const face = loaded[0].fonts[0].faces[0].file;
      expect(packFileInfo('foundation', face)?.abs).toBe(join(root, 'resources', 'packs', 'foundation', ...face.split('/')));
      // A damaged font file: the app would start without the theme and say so; a test or a script stops.
      const fonts = join(root, 'resources', 'packs', 'foundation', 'fonts');
      const [font] = readdirSync(fonts);
      writeFileSync(join(fonts, font), 'not a font');
      await expect(loadBundledPacks(root)).rejects.toThrow(/^The bundled theme packs do not load: .*foundation: .*fonts\//);
      // The development fixture missing is an error too, never Foundation standing in for it.
      const other = committedCopy();
      rmSync(join(other, 'resources', 'packs-dev'), { recursive: true });
      await expect(loadBundledPacks(other)).rejects.toThrow(/^The bundled theme packs foundation-alt are missing from /);
      rmSync(join(root, 'resources', 'packs'), { recursive: true });
      await expect(loadBundledPacks(root)).rejects.toThrow(/No bundled theme pack is under/);
    } finally {
      await restorePacks();
    }
  });

  it('match the lock in this checkout, thumbnails and all', async () => {
    expect(await committedReleaseProblems(ROOT)).toEqual([]);
  });

  it('refuse a release that is not the one the lock pins', async () => {
    const root = committedCopy();
    const lock = readLock(root);
    writeFileSync(join(root, LOCK_FILE), lockJson({ ...lock, packs: { ...lock.packs, foundation: { ...lock.packs.foundation, digest: '0'.repeat(64) } } }));
    const problems = await committedReleaseProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`pins ${'0'.repeat(64)}`);
  });

  it('refuse a release of another version, or one that is or is not a development fixture where it should not be', async () => {
    const root = committedCopy();
    const lock = readLock(root);
    writeFileSync(join(root, LOCK_FILE), lockJson({ ...lock, packs: { ...lock.packs, 'foundation-alt': { ...lock.packs['foundation-alt'], version: '9.9.9' } } }));
    expect(await committedReleaseProblems(root)).toEqual([`resources/packs-dev/foundation-alt is version ${lock.packs['foundation-alt'].version}; ${LOCK_FILE} pins 9.9.9.`]);
    writeFileSync(join(root, LOCK_FILE), lockJson(lock));
    repin(root, 'foundation', (m) => void (m.devOnly = true));
    repin(root, 'foundation-alt', (m) => void delete m.devOnly);
    expect(await committedReleaseProblems(root)).toEqual(['resources/packs/foundation must not be a development fixture.', 'resources/packs-dev/foundation-alt must be a development fixture.']);
  });

  it('refuse a release whose code does not take what its manifest declares, as building it would', async () => {
    const root = committedCopy();
    repin(root, 'foundation', (m) => {
      const grid = m.components.find((c) => c.componentId === 'features.grid')!;
      Object.assign(grid.properties.eyebrow, { default: 'Something else' });
    });
    const problems = await committedReleaseProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^resources\/packs\/foundation: its code does not match its manifest\. Component features\.grid: .*eyebrow/);
  });

  it('refuse files in a release that its pack.json does not list, which packaging would ship', async () => {
    const root = committedCopy();
    writeFileSync(join(root, 'resources', 'packs', 'foundation', 'previews', 'left-over.webp'), 'x');
    expect(await committedReleaseProblems(root)).toEqual(['resources/packs/foundation holds previews/left-over.webp, which its pack.json does not list.']);
  });

  it('refuse a lock that is missing or not the shape it is written in', async () => {
    const root = committedCopy();
    const lock = readLock(root);
    // Exactly as the refresh writes it, so a refresh that changes nothing changes no byte.
    expect(readFileSync(join(root, LOCK_FILE), 'utf8')).toBe(lockJson(lock));
    expect(lockJson(lock)).toBe(
      `{\n\t"builderComponentsCommit": "${lock.builderComponentsCommit}",\n\t"packs": {\n${LOCKED_RELEASES.map(({ id }) => `\t\t"${id}": {\n\t\t\t"version": "${lock.packs[id].version}",\n\t\t\t"digest": "${lock.packs[id].digest}"\n\t\t}`).join(',\n')}\n\t}\n}\n`
    );
    const write = (v: unknown) => writeFileSync(join(root, LOCK_FILE), JSON.stringify(v));
    write({ ...lock, packs: { ...lock.packs, signal: lock.packs.foundation } });
    expect(() => readLock(root)).toThrow(`${LOCK_FILE} must pin exactly foundation, foundation-alt (it pins foundation, foundation-alt, signal).`);
    write({ ...lock, packs: { ...lock.packs, foundation: { ...lock.packs.foundation, digest: 'abc' } } });
    expect(() => readLock(root)).toThrow(`${LOCK_FILE}: foundation needs a version and a SHA-256 digest.`);
    write({ ...lock, packs: { ...lock.packs, foundation: { ...lock.packs.foundation, version: '' } } });
    expect(() => readLock(root)).toThrow(`${LOCK_FILE}: foundation needs a version and a SHA-256 digest.`);
    write({ ...lock, builderComponentsCommit: 'main' });
    expect(() => readLock(root)).toThrow(`${LOCK_FILE} names no builder-components commit.`);
    rmSync(join(root, LOCK_FILE));
    expect(await committedReleaseProblems(root)).toEqual([`${LOCK_FILE} is missing.`]);
  });

  it('refuse a missing release, and a lock that pins other packs', async () => {
    const root = committedCopy();
    rmSync(join(root, 'resources', 'packs-dev', 'foundation-alt'), { recursive: true });
    expect((await committedReleaseProblems(root)).join('\n')).toMatch(/foundation-alt does not load/);
    const lock = readLock(root);
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ ...lock, packs: { foundation: lock.packs.foundation } }));
    expect(await committedReleaseProblems(root)).toEqual([`${LOCK_FILE} must pin exactly foundation, foundation-alt (it pins foundation).`]);
  });

  it('refuse a release missing a thumbnail, even one that loads and matches its lock', async () => {
    const root = committedCopy();
    let missing = '';
    repin(root, 'foundation', (m, dir) => {
      const [componentId, previews] = Object.entries(m.previews ?? {}).find(([, p]) => p.variants && Object.keys(p.variants).length)!;
      const [axis, options] = Object.entries(previews.variants!)[0];
      const [option] = Object.keys(options);
      // The thumbnail goes from the release whole, as a build that never drew it leaves it.
      delete m.files[options[option]];
      rmSync(join(dir, options[option]));
      delete options[option];
      missing = `${componentId} ${axis}=${option}`;
    });
    expect(await committedReleaseProblems(root)).toEqual([`resources/packs/foundation has no thumbnail for ${missing}.`]);
  });

  it('count a thumbnail of the defaults and of each other option, for every component but the shell', () => {
    const def = (componentId: string, category: string, variantAxes?: Record<string, { default: string; options: Record<string, object> }>) => ({ componentId, category, variantAxes }) as unknown as ThemePack['components'][number];
    const pack = {
      components: [def('shell.header', 'shell'), def('hero.split', 'hero', { tone: { default: 'default', options: { default: {}, inverse: {}, muted: {} } } }), def('cta.banner', 'conversion')],
      previews: { 'hero.split': { default: 'previews/hero.split.webp', variants: { tone: { inverse: 'previews/hero.split--tone-inverse.webp' } } } }
    } as unknown as ThemePack;
    expect(missingPreviews(pack)).toEqual(['hero.split tone=muted', 'cta.banner']);
  });
});

describe('finding a builder-components checkout', () => {
  it('takes the one the environment names, and refuses a folder that is not one', () => {
    const root = tmp();
    const checkout = join(tmp(), 'components');
    mkdirSync(join(checkout, 'themes'), { recursive: true });
    writeFileSync(join(checkout, 'themes', 'index.ts'), '');
    expect(findCheckout(root, { [CHECKOUT_ENV]: checkout })).toBe(checkout);
    expect(() => findCheckout(root, { [CHECKOUT_ENV]: join(root, 'missing') })).toThrow(/is not a builder-components checkout/);
  });

  it('takes a relative path from the checkout it builds, before one beside it', () => {
    const parent = tmp();
    const root = join(parent, 'builder');
    for (const d of [join(parent, 'builder-components'), join(parent, 'named')]) {
      mkdirSync(join(d, 'themes'), { recursive: true });
      writeFileSync(join(d, 'themes', 'index.ts'), '');
    }
    mkdirSync(root);
    expect(findCheckout(root, { [CHECKOUT_ENV]: '  ../named ' })).toBe(join(parent, 'named'));
    expect(findCheckout(root, { [CHECKOUT_ENV]: '' })).toBe(join(parent, 'builder-components'));
  });

  it('finds one beside the main checkout from a worktree of it', () => {
    const parent = tmp();
    const main = join(parent, 'checkout');
    const worktree = join(parent, 'worktrees', 'feature');
    mkdirSync(main);
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'ignore' });
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', worktree);
    expect(findCheckout(worktree, {})).toBeNull();
    mkdirSync(join(parent, 'builder-components', 'themes'), { recursive: true });
    writeFileSync(join(parent, 'builder-components', 'themes', 'index.ts'), '');
    // Git names the main checkout by its real path.
    expect(findCheckout(worktree, {})).toBe(join(realpathSync(parent), 'builder-components'));
  });

  it('finds one beside the checkout, and none when there is none', () => {
    const parent = tmp();
    const root = join(parent, 'builder');
    mkdirSync(root);
    expect(findCheckout(root, {})).toBeNull();
    mkdirSync(join(parent, 'builder-components', 'themes'), { recursive: true });
    writeFileSync(join(parent, 'builder-components', 'themes', 'index.ts'), '');
    expect(findCheckout(root, {})).toBe(join(parent, 'builder-components'));
  });
});
