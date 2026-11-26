import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/shared/ids';
import { readState, stateToDocs } from '../../src/main/project/documents';
import { FIXTURES, fixtureHash, fixturePng, fixtureState, seeded, templateHash, writeFixture } from '../../scripts/perf/fixtures';
import { findHeading, fixtureFacts } from '../../scripts/perf/scenarios';

describe('benchmark fixtures', () => {
  it('are the same on every build', () => {
    for (const spec of Object.values(FIXTURES)) {
      const a = fixtureState(spec);
      const b = fixtureState(spec);
      expect([...stateToDocs(a.state)]).toEqual([...stateToDocs(b.state)]);
      expect(fixtureHash(a.state, a.files)).toBe(fixtureHash(b.state, b.files));
    }
    expect(fixtureHash(fixtureState(FIXTURES.small).state, new Map())).not.toBe(fixtureHash(fixtureState(FIXTURES.large).state, new Map()));
  });

  it('give the large project 50 pages, 500 posts, 300 library images and 30 project components', () => {
    const { state, files } = fixtureState(FIXTURES.large);
    const facts = fixtureFacts(FIXTURES.large, state);
    expect(facts).toMatchObject({ pages: 50, entries: 500, assets: 300, projectComponents: 30 });
    expect(files.size).toBe(300);
    expect(findHeading(state.pages[state.site.homePageId], facts.heroId)?.heading).toBe(facts.heading);
    // Published posts, and every project component placed once, showing a library image.
    const posts = Object.values((state.collections as Record<string, { entries: Record<string, { draft?: boolean }> }>).posts.entries);
    expect(posts.filter((e) => e.draft === false)).toHaveLength(500);
    const projectIds = new Set(Object.values(state.components).filter((c) => c.owner === 'project').map((c) => c.id));
    const placed = JSON.stringify(state.pages).match(/"definitionId":"([^"]+)"/g)!.map((x) => x.slice(16, -1)).filter((id) => projectIds.has(id));
    expect(new Set(placed).size).toBe(30);
    const images = Object.values(state.components).filter((c) => c.owner === 'project').map((c) => JSON.stringify(c).match(/"assetId":"(img-\d+)"/)?.[1]);
    expect(images.every((id) => !!id && Object.hasOwn(state.assets.assets, id))).toBe(true);
    // The small one is the Business starter as a new project has it.
    expect(fixtureFacts(FIXTURES.small, fixtureState(FIXTURES.small).state)).toMatchObject({ pages: 3, entries: 0, assets: 0, projectComponents: 0 });
  });

  it('seed IDs only while a fixture is made, and leave the random source exactly as it was', () => {
    const original = globalThis.crypto.getRandomValues;
    const inside = [seeded('s', () => newId()), seeded('s', () => newId())];
    expect(inside[0]).toBe(inside[1]);
    expect(seeded('t', () => newId())).not.toBe(inside[0]);
    expect(() => seeded('s', () => { throw new Error('boom'); })).toThrow('boom');
    expect(globalThis.crypto.getRandomValues).toBe(original);
    // Nested, the outer seed's sequence carries on after the inner one.
    expect(seeded('s', () => [newId(), seeded('x', () => newId()), newId()])[2]).toBe(seeded('s', () => [newId(), newId()])[1]);
    expect(newId()).not.toBe(newId());
  });

  it('hash every document and library file by path, and nothing else', () => {
    const { state, files } = fixtureState(FIXTURES.large);
    const hash = fixtureHash(state, files);
    const changed = new Map(files);
    const [first] = [...files.keys()];
    changed.set(first, Buffer.concat([files.get(first)!.subarray(0, -1), Buffer.from([0])]));
    expect(fixtureHash(state, changed)).not.toBe(hash);
    const moved = new Map([...files].map(([k, v], i) => [i === 0 ? k.replace('fixture-', 'moved-') : k, v]));
    expect(fixtureHash(state, moved)).not.toBe(hash);
    expect(fixtureHash(state, new Map([...files].reverse()))).toBe(hash);
    expect(templateHash()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('draw valid PNGs whose bytes depend only on their number', () => {
    const png = fixturePng(7);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(72);
    expect(fixturePng(7).equals(png)).toBe(true);
    expect(fixturePng(8).equals(png)).toBe(false);
  });

  describe('on disk', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    it('write the large project whole: its documents, every library file and the generated site', async () => {
      dir = mkdtempSync(join(tmpdir(), 'perf-fixture-'));
      const project = join(dir, 'project');
      const { hash, docs } = await writeFixture(project, FIXTURES.large);
      const { state, files } = fixtureState(FIXTURES.large);
      expect(hash).toBe(fixtureHash(state, files));
      expect(docs).toBe(stateToDocs(state).size);
      for (const [path, bytes] of files) expect(readFileSync(join(project, path)).equals(bytes)).toBe(true);
      const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
      expect([lock.name, lock.packages[''].name]).toEqual(['perf-large', 'perf-large']);
      const generated = Object.keys(JSON.parse(readFileSync(join(project, 'siteorigin', 'generated-manifest.json'), 'utf8')).files);
      expect(generated.length).toBeGreaterThan(50);
      for (const f of generated.slice(0, 20)) expect(existsSync(join(project, f))).toBe(true);
      expect([...stateToDocs(await readState(project))]).toEqual([...stateToDocs(state)]);
    }, 120_000);

    it('are written as a new project is, and read back as the same project', async () => {
      dir = mkdtempSync(join(tmpdir(), 'perf-fixture-'));
      const project = join(dir, 'project');
      const { hash } = await writeFixture(project, FIXTURES.small);
      const { state, files } = fixtureState(FIXTURES.small);
      expect(hash).toBe(fixtureHash(state, files));
      expect(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).name).toBe('perf-small');
      expect(existsSync(join(project, 'siteorigin', 'generated-manifest.json'))).toBe(true);
      const read = await readState(project);
      expect([...stateToDocs(read)]).toEqual([...stateToDocs(state)]);
    });
  });
});
