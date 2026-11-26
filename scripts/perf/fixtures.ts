/**
 * The benchmark's fixture projects, built the same way every time (scripts/perf/README.md): `small` is a new project
 * from the Business starter, and `large` that starter grown to 50 pages, 500 posts, 300 library images and 30 project
 * components through the same edit operations the editor sends.
 *
 * Everything that would differ between builds is fixed: element IDs come from a seeded generator in place of the
 * random one while the state is made, dates are constants, and the images are drawn here, uncompressed. `hash` covers
 * the canonical documents and the asset files, so two builds of a fixture can be compared byte for byte.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { applyOperations } from '@engine/apply';
import { createStarterState } from '@catalogue/starters';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, OwnerRef, ProjectState } from '@shared/types';
import { stateToDocs } from '../../src/main/project/documents';

export type FixtureName = 'small' | 'large';

export interface FixtureSpec {
  name: FixtureName;
  /** The site's name, which is also how Welcome lists it. */
  title: string;
  /** Pages beyond the starter's own three. */
  pages: number;
  entries: number;
  assets: number;
  components: number;
}

export const FIXTURES: Record<FixtureName, FixtureSpec> = {
  small: { name: 'small', title: 'Perf small', pages: 0, entries: 0, assets: 0, components: 0 },
  large: { name: 'large', title: 'Perf large', pages: 47, entries: 500, assets: 300, components: 30 }
};

/** The repository root, where the starter template lives. */
export const ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATE = join(ROOT, 'templates', 'sveltekit-brochure', 'files');
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const PAGE_STARTERS = ['services', 'about', 'faq', 'pricing', 'intro', 'contact'] as const;

/** Run `fn` with `crypto.getRandomValues` (which every new ID comes from) replaced by a generator seeded with `seed`. */
export function seeded<T>(seed: string, fn: () => T): T {
  const crypto = globalThis.crypto;
  let x = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  const next = () => {
    // xorshift32: plenty for IDs that only need to be the same on every build.
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const fill = <A extends ArrayBufferView | null>(array: A): A => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
    }
    return array;
  };
  Object.defineProperty(crypto, 'getRandomValues', { value: fill, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    delete (crypto as { getRandomValues?: unknown }).getRandomValues;
  }
}

/** A small PNG drawn from `i`: a two-colour gradient, stored uncompressed so its bytes never depend on zlib's version. */
export function fixturePng(i: number, width = 96, height = 72): Buffer {
  const rows: Buffer[] = [];
  const [r, g, b] = [(i * 53) % 256, (i * 97) % 256, (i * 151) % 256];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (r + x * 2) & 0xff;
      row[2 + x * 3] = (g + y * 3) & 0xff;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const pad = (n: number, width = 3) => String(n).padStart(width, '0');

function run(state: ProjectState, ops: EditOperation[]): { state: ProjectState; results: Array<Record<string, unknown>> } {
  return applyOperations(state, ops) as { state: ProjectState; results: Array<Record<string, unknown>> };
}

/** The fixture's project state and its library's files, the same on every call. */
export function fixtureState(spec: FixtureSpec): { state: ProjectState; files: Map<string, Buffer> } {
  return seeded(`siteorigin-perf:${spec.name}`, () => {
    let state = createStarterState('business', spec.title, false);
    state.manifest.createdAt = CREATED_AT;
    const files = new Map<string, Buffer>();

    // The library: images only, each with its own file.
    const assets: AssetRecord[] = [];
    for (let i = 1; i <= spec.assets; i++) {
      const bytes = fixturePng(i);
      const file = `static/assets/fixture-${pad(i)}.png`;
      files.set(file, bytes);
      assets.push({ id: `img-${pad(i)}`, name: `Fixture image ${pad(i)}`, file, mime: 'image/png', bytes: bytes.length, width: 96, height: 72, hash: createHash('sha256').update(bytes).digest('hex'), kind: 'image', createdAt: CREATED_AT });
    }
    if (assets.length) state = run(state, assets.map((asset) => ({ type: 'asset.add', asset }) as EditOperation)).state;

    // Pages, after the starter's own, each with a starter's sections.
    const pages: string[] = [];
    for (let i = 1; i <= spec.pages; i++) {
      const pageId = `pg_fx${pad(i)}`;
      pages.push(pageId);
      state = run(state, [{ type: 'page.create', pageId, title: `Fixture page ${pad(i)}`, route: `/fixture-${pad(i)}/`, starter: PAGE_STARTERS[i % PAGE_STARTERS.length] } as EditOperation]).state;
    }

    // Project components, each showing one library image, placed one to a page.
    for (let i = 1; i <= spec.components; i++) {
      const made = run(state, [
        {
          type: 'component.upsert',
          name: `Fixture card ${pad(i, 2)}`,
          properties: {},
          nodes: [
            { kind: 'element', id: 'root', tag: 'article', children: ['title', 'body', 'pic'] },
            { kind: 'text', id: 'title', tag: 'h3', text: `Card ${pad(i, 2)}` },
            { kind: 'text', id: 'body', tag: 'p', text: `A project component the benchmark places on fixture page ${pad(i)}.` },
            { kind: 'image', id: 'pic', image: { assetId: assets.length ? assets[(i - 1) % assets.length].id : null, alt: `Fixture image ${pad(i)}` } }
          ]
        } as EditOperation
      ]);
      const definitionId = made.results[0].definitionId as string;
      const owner: OwnerRef = { kind: 'page', id: pages[(i - 1) % Math.max(1, pages.length)] ?? state.site.homePageId };
      const section = run(made.state, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' } as EditOperation]);
      state = run(section.state, [{ type: 'node.insert', owner, parentId: section.results[0].nodeId as string, slot: 'content', definitionId } as EditOperation]).state;
    }

    // Posts: the ready-made blog, every entry published with a short body.
    if (spec.entries) {
      const ops: EditOperation[] = [{ type: 'collection.create', collectionId: 'posts' } as EditOperation];
      for (let i = 1; i <= spec.entries; i++) {
        const day = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
        ops.push({
          type: 'entry.create',
          collectionId: 'posts',
          entryId: `en_fx${pad(i, 4)}`,
          title: `Fixture post ${pad(i, 4)}`,
          publishedAt: day,
          draft: false,
          excerpt: `The benchmark's post number ${i}.`,
          body: [`Post ${i} of the large fixture.`, 'A second paragraph, so every entry has a little body to generate.']
        } as EditOperation);
      }
      state = run(state, ops).state;
    }
    return { state, files };
  });
}

/** SHA-256 over the canonical documents and library files, by path. */
export function fixtureHash(state: ProjectState, files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  const all = new Map<string, string | Buffer>([...stateToDocs(state), ...files]);
  for (const path of [...all.keys()].sort()) hash.update(path).update('\0').update(all.get(path)!).update('\0');
  return hash.digest('hex').slice(0, 16);
}

/**
 * Write the fixture's project into the empty folder `dir`, as a new project is made (controller.ts `create`): the
 * template, its package named for the site, the library's files, then the documents and generated files through
 * ProjectSession.create. Its website tools are not installed: the first open in the app does that.
 */
export async function writeFixture(dir: string, spec: FixtureSpec): Promise<{ hash: string; docs: number }> {
  const { state, files } = fixtureState(spec);
  mkdirSync(dir, { recursive: true });
  cpSync(TEMPLATE, dir, { recursive: true });
  const slug = `perf-${spec.name}`;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.name = slug;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  lock.name = slug;
  if (lock.packages?.['']) lock.packages[''].name = slug;
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, '\t') + '\n');
  for (const [path, bytes] of files) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  // Loaded only here: a session pulls in the generator and the packs, which the pure helpers above do not need.
  const { ProjectSession } = await import('../../src/main/project/session');
  const session = await ProjectSession.create(dir, state);
  await session.close();
  return { hash: fixtureHash(state, files), docs: stateToDocs(state).size };
}
