/**
 * Loading theme packs from disk: valid releases load from the app's resources and the person's packs folder,
 * and a malformed or unsafe one is refused whole with a reason, while the others still load.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ComponentDefinition } from '@shared/types';
import type { AuthoredPack, PackManifest } from '@catalogue/pack';
import { createPack } from '@catalogue/dsl';
import { FOUNDATION_PACK } from '@catalogue/builtin';
import { buildPack, fileSource, registerBuiltinPacks, writeRelease } from '../../src/main/packs/build';
import { loadPackDir, loadPacks, type PackRoot } from '../../src/main/packs/loader';
import { readPackFile, registerPackFiles } from '../../src/main/packs/files';
import { loadInstalledPacks, packPreview } from '../../src/main/packs/installed';
import { findTheme } from '@catalogue/index';
import { sha } from '../../src/main/project/fsutil';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
// Some tests load packs the way the app does, which replaces the registered packs.
afterAll(() => registerBuiltinPacks());

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-packs-'));
  dirs.push(d);
  return d;
};

/** A managed stand-in for a code component: the same contract, drawn from data. */
const asManaged = (c: ComponentDefinition): ComponentDefinition => {
  const { source: _source, ...rest } = c;
  void _source;
  return { ...rest, kind: 'managed', tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: [] } } } };
};

/**
 * A third-party pack: Foundation's components under another identity, with one font. `reuse` keeps Foundation's
 * own code components as they are; otherwise the pack brings data only.
 */
function studio(id = 'studio', reuse = false): AuthoredPack {
  const { components, fonts, ...meta } = FOUNDATION_PACK;
  const author = createPack({ ...meta, id, name: 'Studio', version: '1.0.0', license: 'MIT', fonts: fonts.filter((f) => f.name === 'Lora') });
  return author.define(components.map((c) => author.adopt(c.kind === 'code' && !reuse ? asManaged(c) : c)));
}
/** Make a component of a release a code component with this source. */
const asCode = (m: PackManifest, i: number, source: string) => {
  Object.assign(m.components[i], { kind: 'code', source });
  delete m.components[i].tree;
};

let light: Buffer;
let dark: Buffer;
/** Write a release of `pack` into `root`, with two (different) preview images. Returns its folder. */
async function release(root: string, pack: AuthoredPack = studio()): Promise<string> {
  light ??= await sharp({ create: { width: 8, height: 5, channels: 3, background: '#e0e0e0' } }).webp().toBuffer();
  dark ??= await sharp({ create: { width: 8, height: 5, channels: 3, background: '#202020' } }).webp().toBuffer();
  const { pack: built, files } = buildPack(pack);
  const previews = { 'hero.split': { default: 'previews/hero.split.webp', variants: { tone: { inverse: 'previews/hero.split--tone-inverse.webp' } } } };
  const dir = join(root, built.id);
  writeRelease(dir, { ...built, previews }, files, new Map([['previews/hero.split.webp', light], ['previews/hero.split--tone-inverse.webp', dark]]));
  return dir;
}

const user = (dir: string): PackRoot => ({ dir, source: 'user' });
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as PackManifest;
/** Change a release's manifest (and nothing else). */
function edit(dir: string, change: (m: PackManifest) => void) {
  const m = manifestOf(dir);
  change(m);
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(m));
}
/** Replace a file in a release and list its new size and hash, so only the content check can catch it. */
function replaceListed(dir: string, file: string, bytes: Buffer) {
  writeFileSync(join(dir, file), bytes);
  edit(dir, (m) => (m.files[file] = { size: bytes.length, sha256: sha(bytes) }));
}
const firstFont = (dir: string) => manifestOf(dir).fonts[0].faces[0].file;

describe('loading a theme pack release', () => {
  it('loads a valid pack exactly as it was built, with its digest and files', async () => {
    const root = tmp();
    const dir = await release(root);
    const { pack, files } = await loadPackDir(dir, user(root));
    expect(pack.id).toBe('studio');
    expect(pack.source).toBe('user');
    expect(pack.digest).toBe(sha(readFileSync(join(dir, 'pack.json'))));
    // Definitions are kept byte for byte, so their lock hashes match what the author built.
    expect(JSON.stringify(pack.components)).toBe(JSON.stringify(studio().components));
    expect(pack.components[0].id).toBe('studio.shell.header');
    expect(pack.fonts.map((f) => f.name)).toEqual(['Lora']);
    // The article layout a new collection starts with comes through as built.
    expect(pack.articleTemplate?.rootIds).toHaveLength(1);
    expect(pack.articleTemplate).toEqual(studio().articleTemplate);
    expect([...files.keys()].sort()).toEqual(Object.keys(manifestOf(dir).files).sort());
    expect(files.get(firstFont(dir))!.sha256).toBe(fileSource(join(dir, firstFont(dir))).sha256);
  });

  const refusals: Array<[string, (dir: string) => void | Promise<void>, RegExp]> = [
    ['a manifest that is not JSON', (d) => writeFileSync(join(d, 'pack.json'), '{ "id": '), /pack\.json is not valid JSON/],
    ['a newer release format', (d) => edit(d, (m) => (m.format = 2)), /release format 2; this app reads format 1/],
    ['a missing name', (d) => edit(d, (m) => delete (m as Partial<PackManifest>).name), /malformed at name/],
    // A pack's article layout is elements and text only: a placed component could be one the project lacks.
    ['an article layout that places a component', (d) => edit(d, (m) => (m.articleTemplate = { rootIds: ['a'], nodes: { a: { id: 'a', kind: 'instance', definitionId: 'x', props: {} } } })), /malformed at articleTemplate\.nodes\.a\.kind/],
    ['an unknown top-level field (an install hook)', (d) => edit(d, (m) => Object.assign(m, { postinstall: 'node evil.js' })), /malformed at the top level/],
    ['a folder named for another pack', (d) => edit(d, (m) => (m.id = 'other')), /folder is named "studio" but holds the pack "other"/],
    ['a component under another pack ID', (d) => edit(d, (m) => (m.components[2].id = 'foundation.hero.centered')), /must be "studio\.hero\.centered"/],
    ['a component that claims another pack', (d) => edit(d, (m) => (m.components[2].provenance = { ...m.components[2].provenance, pack: 'foundation' })), /comes from another pack/],
    ['a licence that forbids publishing', (d) => edit(d, (m) => (m.components[3].license = 'LicenseRef-Proprietary')), /does not allow it to be published/],
    ['a font licence that forbids publishing', (d) => edit(d, (m) => (m.fonts[0].license = 'LicenseRef-Desktop-Only')), /font Lora has the licence/],
    ['an element whose child is missing', (d) => edit(d, (m) => (m.components[2].tree!.nodes[m.components[2].tree!.rootIds[0]] as { children: string[] }).children.push('ghost')), /lists a child "ghost" that does not exist/],
    ['a component part with no element', (d) => edit(d, (m) => (Object.values(m.components[2].parts)[0].nodeId = 'ghost')), /refers to an element that does not exist/],
    ['base CSS that imports a stylesheet', (d) => edit(d, (m) => (m.baseCss += '\n@import "https://example.com/x.css";')), /@import/],
    ['base CSS that loads a resource', (d) => edit(d, (m) => (m.baseCss += '\nbody { background: url(https://example.com/pixel.gif); }')), /loads a resource/],
    ['a code component with code that reads files', (d) => edit(d, (m) => asCode(m, 0, `<script>\n\timport { readFileSync } from 'node:fs';\n</script>\n<p>{readFileSync('/etc/hosts', 'utf8')}</p>`)), /shell\.header has code of its own, which an installed pack may not bring/],
    ['even harmless code of its own', (d) => edit(d, (m) => asCode(m, 0, `<p>Hello</p>\n`)), /shell\.header has code of its own/],
    ['an element inside its own child', (d) => edit(d, (m) => {
      const def = m.components[2];
      const root = def.tree!.rootIds[0];
      const child = (def.tree!.nodes[root] as { children: string[] }).children[0];
      def.tree!.nodes[child] = { ...def.tree!.nodes[child], kind: 'element', tag: 'div', children: [root] } as never;
    }), /contains itself/],
    ['base CSS that loads a resource between two strings that look like a comment', (d) => edit(d, (m) => (m.baseCss += '\n.a::before { content: "/*"; } body { background: url(https://example.com/pixel.gif); } .b::after { content: "*/"; }')), /loads a resource/],
    ['a code component that names its own source file', (d) => edit(d, (m) => Object.assign(m.components[0], { sourcePath: 'src/routes/+layout.svelte' })), /names a source file/],
    ['two slots that would generate one name', (d) => edit(d, (m) => (m.components[2].slots = { '1up': { label: 'One' }, _1up: { label: 'Other' } })), /the slots "1up" and "_1up" would generate the same name/],
    ['base CSS that hides url() after an escaped quote', (d) => edit(d, (m) => (m.baseCss += '\n.a\\"b { background: url(https://example.com/pixel.gif); }')), /loads a resource/],
    ['a development fixture', (d) => edit(d, (m) => (m.devOnly = true)), /Development fixtures cannot be installed/],
    ['a file path that leaves the pack', (d) => edit(d, (m) => (m.files['fonts/../../../evil.woff2'] = { size: 1, sha256: '0'.repeat(64) })), /malformed at files/],
    ['a used file that is not listed', (d) => edit(d, (m) => delete m.files[m.fonts[0].faces[0].file]), /is used but not listed/],
    ['a listed file nothing uses', (d) => edit(d, (m) => (m.files['previews/extra.webp'] = m.files['previews/hero.split.webp'])), /previews\/extra\.webp is listed but nothing in the pack uses it/],
    ['a preview for a component the pack does not have', (d) => edit(d, (m) => (m.previews!['ghost.section'] = { default: 'previews/hero.split.webp' })), /preview for ghost\.section, which the pack does not have/],
    ['UI state with a name that cannot be an identifier', (d) => edit(d, (m) => (m.components[2].state = { 'open-now': { type: 'boolean', label: 'Open', initial: false } })), /"open-now" is not a name UI state can have/],
    ['a condition that reads UI state the component does not declare', (d) => edit(d, (m) => (m.components[2].tree!.nodes[m.components[2].tree!.rootIds[0]].when = { $state: 'open' })), /reads the UI state "open", which the component does not declare/],
    ['a comparison with UI state the component does not declare', (d) => edit(d, (m) => (m.components[2].tree!.nodes[m.components[2].tree!.rootIds[0]].unless = { ref: { $state: 'tab' }, eq: 'a' })), /reads the UI state "tab", which the component does not declare/],
    ['a yes/no state compared with text', (d) => edit(d, (m) => {
      const c = m.components[2];
      c.state = { open: { type: 'boolean', label: 'Open', initial: false } };
      c.tree!.nodes[c.tree!.rootIds[0]].when = { ref: { $state: 'open' }, eq: 'true' };
    }), /compares a yes\/no state with "true"/],
    ['UI state read as text', (d) => edit(d, (m) => {
      const c = m.components[2];
      c.state = { open: { type: 'boolean', label: 'Open', initial: false } };
      const text = Object.values(c.tree!.nodes).find((n) => n.kind === 'text');
      if (!text || text.kind !== 'text') throw new Error('The component has no text to test with.');
      text.text = { $state: 'open' } as never;
    }), /reads UI state as its text/],
    ['a condition naming UI state that is neither a read nor one comparison', (d) => edit(d, (m) => {
      const c = m.components[2];
      c.state = { open: { type: 'boolean', label: 'Open', initial: false } };
      c.tree!.nodes[c.tree!.rootIds[0]].when = { ref: { $state: 'open' }, eq: true, ne: false } as never;
    }), /neither UI state nor a comparison of it with one value/],
    ['a category filter on an element that is not a repeat', (d) => edit(d, (m) => ((m.components[2].tree!.nodes[m.components[2].tree!.rootIds[0]] as unknown as { filter: unknown }).filter = { field: 'title' })), /has a category filter, which only a repeat can/],
    ['more UI state than a component may have', (d) => edit(d, (m) => (m.components[2].state = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`flag${i}`, { type: 'boolean', label: 'Flag', initial: false }])))), /more than 20 UI state variables/],
    ['a button that toggles a choice', (d) => edit(d, (m) => {
      const c = m.components[2];
      c.state = { tab: { type: 'enum', label: 'Tab', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: 'a' } };
      const link = Object.values(c.tree!.nodes).find((n) => n.kind === 'link');
      if (!link || link.kind !== 'link') throw new Error('The component has no button to test with.');
      link.stateAction = { state: 'tab', op: 'toggle' };
    }), /toggles the choice "tab"/],
    ['a button that sets a choice to a value it does not offer', (d) => edit(d, (m) => {
      const c = m.components[2];
      c.state = { tab: { type: 'enum', label: 'Tab', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: 'a' } };
      const link = Object.values(c.tree!.nodes).find((n) => n.kind === 'link');
      if (!link || link.kind !== 'link') throw new Error('The component has no button to test with.');
      link.stateAction = { state: 'tab', op: 'set', value: 'c' };
    }), /sets "tab" to "c", which is not one of its options/],
    ['a font file changed after it was built', (d) => writeFileSync(join(d, firstFont(d)), Buffer.concat([readFileSync(join(d, firstFont(d))), Buffer.from('x')])), /bytes, but the pack lists/],
    ['a font file with the same size but other bytes', (d) => {
      const f = join(d, firstFont(d));
      const b = readFileSync(f);
      b[b.length - 1] ^= 0xff;
      writeFileSync(f, b);
    }, /does not match the hash the pack lists/],
    ['a font that is not a WOFF2 file', (d) => replaceListed(d, firstFont(d), Buffer.from('<script>alert(1)</script>')), /is not a WOFF2 font/],
    ['a preview that is not a WebP image', (d) => replaceListed(d, 'previews/hero.split.webp', Buffer.from('GIF89a')), /is not a WebP image/],
    ['a font file that is a link', (d) => {
      const f = join(d, firstFont(d));
      const elsewhere = join(tmp(), 'font.woff2');
      cpSync(f, elsewhere);
      rmSync(f);
      symlinkSync(elsewhere, f);
    }, /is a link, which packs may not contain/],
    ['a fonts folder that is a link', (d) => {
      const elsewhere = join(tmp(), 'fonts');
      cpSync(join(d, 'fonts'), elsewhere, { recursive: true });
      rmSync(join(d, 'fonts'), { recursive: true });
      symlinkSync(elsewhere, join(d, 'fonts'));
    }, /fonts is a link/],
    ['a font larger than the limit', (d) => edit(d, (m) => (m.files[m.fonts[0].faces[0].file].size = 5 * 1024 * 1024)), /is larger than 4096 KB/],
    ['a pack licence that forbids publishing', (d) => edit(d, (m) => (m.license = 'LicenseRef-Proprietary')), /The pack's licence "LicenseRef-Proprietary" does not allow/],
    ['an element ID that could break out of generated markup', (d) => edit(d, (m) => {
      const def = m.components[2];
      const root = def.tree!.rootIds[0];
      const bad = 'x" onmouseover="alert(1)';
      def.tree!.nodes[bad] = { ...def.tree!.nodes[root], id: bad };
      delete def.tree!.nodes[root];
      def.tree!.rootIds[0] = bad;
      for (const part of Object.values(def.parts)) if (part.nodeId === root) part.nodeId = bad;
    }), /the element ID "x" onmouseover="alert\(1\)" may only use letters, digits/],
    ['an element inside itself', (d) => edit(d, (m) => {
      const def = m.components[2];
      const root = def.tree!.rootIds[0];
      (def.tree!.nodes[root] as { children: string[] }).children.push(root);
    }), /contains itself/],
    ['base CSS that hides url() behind escapes', (d) => edit(d, (m) => (m.baseCss += '\nbody { background: \\75 rl(https://example.com/pixel.gif); }')), /loads a resource/],
    ['base CSS that loads a resource beside an inline image', (d) => edit(d, (m) => (m.baseCss += '\nbody { background: url("data:image/png;base64,iVBORw0KGgo="), url(https://example.com/pixel.gif); }')), /loads a resource/],
    ['base CSS that hides url() between strings that look like an inline image', (d) => edit(d, (m) => (m.baseCss += `\n.a::before { content: 'url("data:image/'; } body { background: url(https://example.com/pixel.gif); } .b::after { content: '")'; }`)), /loads a resource/],
    ['base CSS that writes an inline image with an escape', (d) => edit(d, (m) => (m.baseCss += '\nbody { background: url("data:image/svg+xml,\\") url(https://example.com/pixel.gif) "); }')), /loads a resource/],
    ['base CSS that inlines something other than an image', (d) => edit(d, (m) => (m.baseCss += '\nbody { background: url("data:text/css,body{}"); }')), /loads a resource/],
    ['base CSS that hides @import behind escapes', (d) => edit(d, (m) => (m.baseCss = '@\\69 mport "https://example.com/x.css";\n' + m.baseCss)), /@import/],
    ['a token that refers to a token by number', (d) => edit(d, (m) => ((m.tokens[0] as { value: unknown }).value = { token: 7 })), /malformed at tokens\.0\.value/],
    ['a token value that could leave its rule', (d) => edit(d, (m) => ((m.tokens[0] as { value: unknown }).value = 'red; } body { display: none')), /malformed at tokens\.0\.value/],
    ['a contrast pair without its colours', (d) => edit(d, (m) => (m.contrastPairs = [{} as never])), /malformed at contrastPairs\.0/],
    ['two components that generate the same files', (d) => edit(d, (m) => {
      const twin = structuredClone(m.components[3]);
      const id = m.components[3].componentId!.replace('.', '-');
      Object.assign(twin, { componentId: id, id: `studio.${id}`, provenance: { ...twin.provenance, componentId: id } });
      m.components.push(twin);
    }), /would generate the same files as/],
    ['a variant option ID the generator cannot use', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.variantAxes?.tone)!;
      def.variantAxes!.tone.options['dark mode'] = { label: 'Dark mode' };
    }), /variant or option ID that is not allowed/],
    ['a list property without fields', (d) => edit(d, (m) => {
      const def = m.components.find((c) => Object.values(c.properties).some((p) => p.type === 'list'))!;
      const name = Object.keys(def.properties).find((k) => def.properties[k].type === 'list')!;
      delete (def.properties[name] as { fields?: unknown }).fields;
    }), /the list property "[^"]+" has no fields/],
    ['an object property without fields (issue #96)', (d) => edit(d, (m) => {
      (m.components[2].properties as Record<string, unknown>).action = { type: 'object', label: 'Action', default: {} };
    }), /the object property "action" has no fields or no default/],
    ['an object field that is no field (issue #96)', (d) => edit(d, (m) => {
      (m.components[2].properties as Record<string, unknown>).action = { type: 'object', label: 'Action', fields: { caption: null }, default: {} };
    }), /the field "caption" of "action" has no type or no default/],
    ['a choice field without options inside an object (issue #96)', (d) => edit(d, (m) => {
      (m.components[2].properties as Record<string, unknown>).action = { type: 'object', label: 'Action', fields: { size: { type: 'enum', label: 'Size', default: 'small' } }, default: { size: 'small' } };
    }), /the choice field "size" of "action" has no options/],
    ['slot content that names no element (issue #96)', (d) => edit(d, (m) => {
      const host = m.components.find((c) => c.kind === 'managed' && c.tree)!;
      const target = m.components.find((c) => c.slots)!;
      const root = host.tree!.rootIds[0];
      host.tree!.nodes.placed = { id: 'placed', kind: 'instance', definitionId: target.id, props: {}, slots: { [Object.keys(target.slots!)[0]]: ['ghost'] } } as never;
      (host.tree!.nodes[root] as { children: string[] }).children.push('placed');
    }), /puts "ghost" in a slot, which does not exist/],
    ['a condition reading an item field outside any list (issue #96)', (d) => edit(d, (m) => {
      const def = m.components[2];
      def.tree!.nodes[def.tree!.rootIds[0]].when = { $item: 'nope' };
    }), /uses the item field "nope"/],
    ['a token property without its group (issue #96)', (d) => edit(d, (m) => {
      (m.components[2].properties as Record<string, unknown>).accent = { type: 'token', label: 'Accent', default: { token: 'color.brand' } };
    }), /the token property "accent" has no token group/],
    ['a slot limit that is not a whole number (issue #96)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.slots)!;
      (def.slots![Object.keys(def.slots!)[0]] as { max?: unknown }).max = -1;
    }), /malformed at components\.\d+\.slots/],
    ['a condition reading an object field the property does not have (issue #96)', (d) => edit(d, (m) => {
      const def = m.components[2];
      const root = def.tree!.rootIds[0];
      (def.properties as Record<string, unknown>).action = { type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label', default: '' } }, default: { label: '' } };
      def.tree!.nodes[root].when = { ref: { $prop: 'action', field: 'colour' }, eq: 'red' };
    }), /uses the field "colour" of "action"/],
    ['a carousel mark on a list that is no longer a plain list (issue #381)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.componentId === 'media.carousel')!;
      (def.tree!.nodes.track as { tag: string }).tag = 'div';
    }), /node "track" is marked as a carousel, which only a bulleted list \(ul\)/],
    ['a carousel mark on text (issue #381)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.componentId === 'media.carousel')!;
      (def.tree!.nodes.caption as { carousel?: boolean }).carousel = true;
    }), /node "caption" is marked as a carousel/],
    ['a divider shape there is no drawing for (issue #356)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.componentId === 'media.carousel')!;
      def.tree!.nodes.caption = { id: 'caption', kind: 'divider', shape: 'zigzag' } as never;
    }), /node "caption" has a shape that is not one of line, angle, wave, icon/],
    ['an icon on a divider that shows none (issue #356)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.componentId === 'media.carousel')!;
      def.tree!.nodes.caption = { id: 'caption', kind: 'divider', shape: 'wave', icon: 'star' } as never;
    }), /node "caption" names an icon, which only a divider of shape "icon" shows/],
    ['a dialog mark on text (issue #378)', (d) => edit(d, (m) => {
      const def = m.components.find((c) => c.componentId === 'media.carousel')!;
      (def.tree!.nodes.caption as { overlay?: string }).overlay = 'dialog';
    }), /node "caption" shows over the page as a dialog or drawer, which only a container can/],
    ['a WOFF2 file cut short', (d) => {
      const f = firstFont(d);
      replaceListed(d, f, readFileSync(join(d, f)).subarray(0, 200));
    }, /is not a WOFF2 font/],
    ['an image listed as a font face', (d) => {
      const m = manifestOf(d);
      const face = m.fonts[0].faces[0].file;
      writeFileSync(join(d, 'fonts', 'face.webp'), readFileSync(join(d, 'previews', 'hero.split.webp')));
      edit(d, (x) => {
        x.fonts[0].faces[0].file = 'fonts/face.webp';
        x.files['fonts/face.webp'] = x.files['previews/hero.split.webp'];
        delete x.files[face];
      });
    }, /fonts\/face\.webp, which is not a \.woff2 file/]
  ];

  it('accepts base CSS that only mentions url() in a comment or a string or draws an inline image, and element IDs a generator can use', async () => {
    const root = tmp();
    const dir = await release(root);
    edit(dir, (m) => {
      m.baseCss += '\n/* Fonts come from the pack, never url() or @import. */\n.note::before { content: "\\75 rl() is not loaded here"; }';
      // An icon written inline loads nothing.
      m.baseCss += `\n.badge::after { background: rgb(0 0 0 / 0.6) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3C/svg%3E") center / 1rem no-repeat; }`;
      const def = m.components[2];
      const root = def.tree!.rootIds[0];
      def.tree!.nodes['2up'] = { ...def.tree!.nodes[root], id: '2up' };
      delete def.tree!.nodes[root];
      def.tree!.rootIds[0] = '2up';
      for (const part of Object.values(def.parts)) if (part.nodeId === root) part.nodeId = '2up';
    });
    await expect(loadPackDir(dir, user(root))).resolves.toBeTruthy();
  });

  it.each(refusals)('refuses %s, saying why', async (_what, damage, reason) => {
    const root = tmp();
    const dir = await release(root);
    await damage(dir);
    await expect(loadPackDir(dir, user(root))).rejects.toThrow(reason);
  });

  it('refuses a pack folder that is itself a link', async () => {
    const elsewhere = tmp();
    const dir = await release(elsewhere);
    const root = tmp();
    symlinkSync(dir, join(root, 'studio'));
    const { packs, refused } = await loadPacks([user(root)]);
    expect(packs).toEqual([]);
    expect(refused).toEqual([{ dir: join(root, 'studio'), reason: expect.stringMatching(/is a link/) }]);
  });
});

describe('loading every installed pack', () => {
  it('loads valid packs from the app and the packs folder, and refuses a bad one without stopping', async () => {
    const bundled = tmp();
    const mine = tmp();
    await release(bundled, studio('studio'));
    await release(mine, studio('atelier'));
    const broken = await release(mine, studio('broken'));
    writeFileSync(join(broken, 'pack.json'), 'not json');
    mkdirSync(join(mine, '.cache'));
    const { packs, refused } = await loadPacks([{ dir: bundled, source: 'bundled' }, user(mine), user(join(mine, 'missing'))]);
    expect(packs.map((p) => [p.pack.id, p.pack.source])).toEqual([
      ['studio', 'bundled'],
      ['atelier', 'user']
    ]);
    expect(refused).toEqual([{ dir: broken, reason: expect.stringMatching(/^pack\.json is not valid JSON/) }]);
  });

  it('never lets an installed pack replace one that ships with the app', async () => {
    const bundled = tmp();
    const mine = tmp();
    await release(bundled);
    const theirs = await release(mine);
    const { packs, refused } = await loadPacks([{ dir: bundled, source: 'bundled' }, user(mine)]);
    expect(packs.map((p) => p.pack.source)).toEqual(['bundled']);
    expect(refused).toEqual([{ dir: theirs, packId: 'studio', reason: expect.stringMatching(/ships with SiteOrigin Builder, so an installed pack cannot replace it/) }]);
  });

  it("keeps the built-in IDs for the app even when its own releases are missing", async () => {
    const mine = tmp();
    const theirs = [await release(mine, studio('foundation')), await release(mine, studio('foundation-alt'))];
    const { packs, refused } = await loadPacks([{ dir: tmp(), source: 'bundled' }, user(mine)]);
    expect(packs).toEqual([]);
    expect(refused).toEqual(theirs.map((dir, i) => ({ dir, packId: ['foundation', 'foundation-alt'][i], reason: expect.stringMatching(/ships with SiteOrigin Builder/) })));
  });

  it("lets an installed pack reuse the app's own code unchanged, and only then", async () => {
    const bundled = tmp();
    const { pack, files } = buildPack(FOUNDATION_PACK);
    writeRelease(join(bundled, 'foundation'), pack, files);
    const mine = tmp();
    const reuses = await release(mine, studio('atelier', true));
    const loaded = await loadPacks([{ dir: bundled, source: 'bundled' }, user(mine)]);
    expect(loaded.packs.map((p) => p.pack.id)).toEqual(['foundation', 'atelier']);
    // Without the app's own pack to compare with, the same code is the pack's own, which it may not bring.
    const alone = await loadPacks([user(mine)]);
    expect(alone.refused).toEqual([{ dir: reuses, reason: expect.stringMatching(/has code of its own/) }]);
  });

  it('loads neither of two installed packs that claim one ID', async () => {
    const a = tmp();
    const b = tmp();
    await release(a);
    await release(b);
    const { packs, refused } = await loadPacks([user(a), user(b)]);
    expect(packs).toEqual([]);
    expect(refused.map((r) => r.reason)).toEqual([expect.stringMatching(/More than one installed pack has the ID "studio"/), expect.stringMatching(/More than one/)]);
  });

  it('says so when the built-in theme is missing, and registers what did load', async () => {
    const mine = tmp();
    await release(mine);
    const catalogue = await loadInstalledPacks([{ dir: tmp(), source: 'bundled' }, user(mine)]);
    expect(catalogue.packs.map((p) => p.id)).toEqual(['studio']);
    expect(catalogue.refused[0].reason).toMatch(/built-in theme is missing/);
    expect(catalogue.userDir).toBe(mine);
    expect(findTheme('studio')?.source).toBe('user');
    const shown = (url: string | null) => {
      expect(url).toMatch(/^data:image\/webp;base64,/);
      return Buffer.from(url!.replace(/^data:image\/webp;base64,/, ''), 'base64');
    };
    expect(shown(await packPreview('studio', 'previews/hero.split.webp')).equals(light)).toBe(true);
    expect(shown(await packPreview('studio', 'previews/hero.split--tone-inverse.webp')).equals(dark)).toBe(true);
    // Only listed preview images are served, never fonts or paths outside the pack.
    expect(await packPreview('studio', firstFont(join(mine, 'studio')))).toBeNull();
    expect(await packPreview('studio', 'previews/../pack.json')).toBeNull();
  });
});

describe('reading a loaded pack file', () => {
  it('returns the validated bytes, and refuses a file replaced after loading', async () => {
    const root = tmp();
    const dir = await release(root);
    const { pack, files } = await loadPackDir(dir, user(root));
    registerPackFiles(pack.id, files);
    const font = firstFont(dir);
    expect(sha(await readPackFile('studio', font))).toBe(files.get(font)!.sha256);
    const b = readFileSync(join(dir, font));
    b[b.length - 1] ^= 0xff;
    writeFileSync(join(dir, font), b);
    await expect(readPackFile('studio', font)).rejects.toThrow(/changed after it was loaded/);
    // A file grown far past its listed size is refused without being read whole.
    writeFileSync(join(dir, font), Buffer.alloc(files.get(font)!.size * 4));
    await expect(readPackFile('studio', font)).rejects.toThrow(/changed after it was loaded/);
    await expect(readPackFile('studio', 'fonts/other.woff2')).rejects.toThrow(/has no file/);
  });
});
