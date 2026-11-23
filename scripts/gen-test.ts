import { mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { generateProject, packFileCopies } from '@generator/index';
import { registerBuiltinPacks } from '../src/main/packs/build';
import { readPackFile } from '../src/main/packs/files';

registerBuiltinPacks();

const out = process.argv[2];
const state = createStarterState((process.argv[3] as 'business' | 'blank') ?? 'business', 'Harbour Lane Studio', false);
if (!existsSync(join(out, 'package.json'))) cpSync('templates/sveltekit-brochure/files', out, { recursive: true });
const files = generateProject(state, { instrument: process.argv[4] === 'dev' });
for (const [p, c] of files) { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), c); }
for (const c of packFileCopies(state)) { mkdirSync(dirname(join(out, c.path)), { recursive: true }); writeFileSync(join(out, c.path), await readPackFile(c.pack, c.file)); }
console.log('wrote', files.size, 'files');
