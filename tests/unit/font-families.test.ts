/**
 * Static fonts named the legacy way (#1469): a file whose family is "IBM Plex Mono Medium", with no typographic family,
 * joins IBM Plex Mono at its own weight when the library or the same import has IBM Plex Mono, and keeps its own
 * family otherwise.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => ({}) }
}));

const { importAssetBatch, stopMediaWorker } = await import('../../src/main/project/assets');
const { fontFaceCss, projectFontFamilies } = await import('@shared/fonts');
type AssetRecord = import('@shared/types').AssetRecord;
type ProjectState = import('@shared/types').ProjectState;

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);

/** A name table with the legacy family (ID 1), the subfamily (ID 2) and, when given, the typographic family (ID 16). */
function nameTable(family: string, typographic?: string): Buffer {
  const names: Array<[number, string]> = [[1, family], [2, 'Regular'], ...(typographic ? [[16, typographic] as [number, string]] : [])];
  const strings = names.map(([, v]) => Buffer.from(v, 'utf16le').swap16());
  let at = 0;
  const records = names.map(([id], k) => {
    const r = Buffer.concat([u16(3), u16(1), u16(0x409), u16(id), u16(strings[k].length), u16(at)]);
    at += strings[k].length;
    return r;
  });
  return Buffer.concat([u16(0), u16(names.length), u16(6 + names.length * 12), ...records, ...strings]);
}

/** An uncompressed WOFF font holding a name table and an OS/2 table with the weight class and italic bit. */
function woff(family: string, weight: number, opts: { italic?: boolean; typographic?: string } = {}): Buffer {
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(opts.italic ? 1 : 0x40, 62);
  const tables: Array<[string, Buffer]> = [['OS/2', os2], ['name', nameTable(family, opts.typographic)]];
  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 'ascii');
  header.writeUInt16BE(tables.length, 12);
  let offset = 44 + tables.length * 20;
  const dir = tables.map(([tag, raw]) => {
    const e = Buffer.alloc(20);
    e.write(tag, 0, 'ascii');
    e.writeUInt32BE(offset, 4);
    e.writeUInt32BE(raw.length, 8);
    e.writeUInt32BE(raw.length, 12);
    offset += raw.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...tables.map(([, raw]) => raw)]);
}

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-font-families-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
afterAll(() => stopMediaWorker());

const fence = async (write: () => Promise<void>) => (await write(), true);

/** Import font files into a fresh project holding `library`, and the records the import adds. */
async function importFonts(files: Array<[string, Buffer]>, library: AssetRecord[] = []) {
  const src = temp();
  const paths = files.map(([name, data]) => {
    const p = join(src, name);
    writeFileSync(p, data);
    return p;
  });
  const out = await importAssetBatch(temp(), paths.map((path) => ({ path, opts: {} })), [...library], fence, { parallel: 3, go: () => true });
  return out.map((o) => {
    if (!o || 'error' in o) throw new Error(o ? o.error.message : 'not started');
    return o.record;
  });
}

const faces = (records: AssetRecord[]) => records.map((r) => [r.name, r.font!.family, r.font!.weight, r.font!.style]);
const stateOf = (records: AssetRecord[]) => ({ assets: { schemaVersion: 1, assets: Object.fromEntries(records.map((r) => [r.id, r])) } }) as unknown as ProjectState;

describe('a legacy-named weight of a static font family (#1469)', () => {
  const regular = woff('IBM Plex Mono', 400);
  const medium = woff('IBM Plex Mono Medium', 500);

  it('joins the family imported with it, in either order, and is used for that weight in the export', async () => {
    for (const order of [[['regular.woff', regular], ['medium.woff', medium]], [['medium.woff', medium], ['regular.woff', regular]]] as Array<Array<[string, Buffer]>>) {
      const records = await importFonts(order);
      expect(faces(records).sort()).toEqual([
        ['IBM Plex Mono Medium', 'IBM Plex Mono', '500', 'normal'],
        ['IBM Plex Mono Regular', 'IBM Plex Mono', '400', 'normal']
      ]);
      const state = stateOf(records);
      expect(projectFontFamilies(state).map((f) => [f.family, f.faces.length])).toEqual([['IBM Plex Mono', 2]]);
      expect(fontFaceCss(state)).toMatch(/font-family: ?'IBM Plex Mono';[^}]*font-weight: ?500/);
      expect(fontFaceCss(state)).not.toContain('IBM Plex Mono Medium');
    }
  });

  it('joins a family already in the library, named as the library names it', async () => {
    const [first] = await importFonts([['regular.woff', woff('ibm plex mono', 400)]]);
    const [added] = await importFonts([['medium-italic.woff', woff('IBM Plex Mono Medium Italic', 500, { italic: true })]], [first]);
    expect(faces([added])).toEqual([['ibm plex mono Medium Italic', 'ibm plex mono', '500', 'italic']]);
  });

  it('keeps its own family when nothing it could join is there, or its weight does not bear the word out', async () => {
    // Arial Black is a family of its own when imported alone.
    expect(faces(await importFonts([['black.woff', woff('Arial Black', 900)]]))).toEqual([['Arial Black Black', 'Arial Black', '900', 'normal']]);
    // Archivo Black is a regular weight, so it is no weight of Archivo.
    const records = await importFonts([['archivo.woff', woff('Archivo', 400)], ['archivo-black.woff', woff('Archivo Black', 400)]]);
    expect(faces(records).map((f) => f[1]).sort()).toEqual(['Archivo', 'Archivo Black']);
    // A typographic family is taken as it is.
    const named = await importFonts([['serif.woff', woff('Source Serif 4', 400)], ['black.woff', woff('Source Serif 4 Black', 900, { typographic: 'Source Serif 4 Display' })]]);
    expect(faces(named).map((f) => f[1]).sort()).toEqual(['Source Serif 4', 'Source Serif 4 Display']);
  });
});
