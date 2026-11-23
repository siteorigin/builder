// Extracts a curated subset of Lucide icons (ISC licence) into static website icon data.
// Run from the repository root: node scripts/extract-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['arrow-right','arrow-up-right','check','circle-check','star','heart','leaf','house','building-2','hammer','wrench','paintbrush','palette','pen-tool','ruler','sparkles','sun','moon','shield-check','clock','calendar','phone','mail','map-pin','message-circle','users','user','briefcase','chart-line','target','lightbulb','rocket','compass','camera','image','coffee','gift','globe','lock','zap','award','handshake','thumbs-up','scissors','truck','stethoscope','graduation-cap','layers','layout-grid','quote','plus','minus','menu','x','chevron-down','sofa','trees','flower-2','dumbbell','utensils','music','book-open','code','heart-handshake','badge-check'];

// Lucide 1.x no longer ships brand icons. These outlines are from Lucide 0.5xx (ISC licence), except
// x-twitter, an original outline of the X logo drawn on the same 24px grid and stroke style.
const BRANDS = {
  instagram: [['rect', { width: '20', height: '20', x: '2', y: '2', rx: '5', ry: '5' }], ['path', { d: 'M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z' }], ['line', { x1: '17.5', x2: '17.51', y1: '6.5', y2: '6.5' }]],
  facebook: [['path', { d: 'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z' }]],
  linkedin: [['path', { d: 'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z' }], ['rect', { width: '4', height: '12', x: '2', y: '9' }], ['circle', { cx: '4', cy: '4', r: '2' }]],
  youtube: [['path', { d: 'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17' }], ['path', { d: 'm10 15 5-3-5-3z' }]],
  github: [['path', { d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4' }], ['path', { d: 'M9 18c-4.51 2-5-2-7-2' }]],
  'x-twitter': [['path', { d: 'M4 4h4.5L20 20h-4.5z' }], ['path', { d: 'M20 4l-6.6 7.3' }], ['path', { d: 'M10.6 12.7 4 20' }]]
};

function load(n) {
  let src = readFileSync(`node_modules/lucide-react/dist/esm/icons/${n}.mjs`, 'utf8');
  // Renamed icons are re-exports of their new name.
  const alias = src.match(/export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/);
  if (alias) src = readFileSync(`node_modules/lucide-react/dist/esm/icons/${alias[1]}.mjs`, 'utf8');
  return src;
}

const out = {};
const failed = [];
for (const n of names) {
  let src;
  try { src = load(n); } catch { failed.push(`missing ${n}`); continue; }
  const m = src.match(/const __iconData = (\{[\s\S]*?\});\n/);
  if (!m) { failed.push(`unparsed ${n}`); continue; }
  const node = Function(`return ${m[1]}`)().node;
  out[n] = node.map(([tag, attrs]) => { const { key, ...rest } = attrs; return [tag, rest]; });
}
// Never overwrite the catalogue with a partial set.
if (failed.length) {
  console.error(failed.join('\n'));
  process.exit(1);
}
Object.assign(out, BRANDS);
writeFileSync('src/catalogue/foundation/icons.ts', `/* Icon data from Lucide (https://lucide.dev), ISC licence. Copyright (c) Lucide contributors. */\nexport type IconElement = [string, Record<string, string | number>];\nexport const ICONS: Record<string, IconElement[]> = ${JSON.stringify(out)};\n`);
console.log(Object.keys(out).length, 'icons');
