import { mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { generateProject, packFileCopies } from '@generator/index';
import { registerBuiltinPacks } from '../src/main/packs/build';
import { readPackFile } from '../src/main/packs/files';
import { setSiteIconRenderer, SiteIconMaker } from '../src/main/project/site-icons';
import { renderSiteIcons } from '../src/main/project/image-variants';

registerBuiltinPacks();

const out = process.argv[2];
const state = createStarterState((process.argv[3] as 'business' | 'blank') ?? 'business', 'Harbour Lane Studio', false);
if (!existsSync(join(out, 'package.json'))) cpSync('templates/sveltekit-brochure/files', out, { recursive: true });
const files = generateProject(state, { instrument: process.argv[4] === 'dev' });
for (const [p, c] of files) { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), c); }
for (const c of packFileCopies(state)) { mkdirSync(dirname(join(out, c.path)), { recursive: true }); writeFileSync(join(out, c.path), await readPackFile(c.pack, c.file)); }
// The home-screen icons, drawn here in this process (the app draws them in its media worker).
setSiteIconRenderer(async (data, mime, icons) => ({ ok: true, icons: await renderSiteIcons(data, mime, icons) }));
for (const [p, c] of (await new SiteIconMaker().make(out, state)).files ?? []) writeFileSync(join(out, p), c);
console.log('wrote', files.size, 'files');
