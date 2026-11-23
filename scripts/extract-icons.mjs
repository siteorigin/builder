// Extracts a curated subset of Lucide icons (ISC licence) into static website icon data.
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['arrow-right','arrow-up-right','check','circle-check','star','heart','leaf','house','building-2','hammer','wrench','paintbrush','palette','pen-tool','ruler','sparkles','sun','moon','shield-check','clock','calendar','phone','mail','map-pin','message-circle','users','user','briefcase','chart-line','target','lightbulb','rocket','compass','camera','image','coffee','gift','globe','lock','zap','award','handshake','thumbs-up','scissors','truck','stethoscope','graduation-cap','layers','layout-grid','quote','plus','minus','menu','x','chevron-down','sofa','trees','flower-2','dumbbell','utensils','music','book-open','code','heart-handshake','badge-check','instagram','facebook','linkedin','twitter','youtube'];
const out = {};
for (const n of names) {
  let src;
  try { src = readFileSync(`node_modules/lucide-react/dist/esm/icons/${n}.mjs`, 'utf8'); } catch { console.error('missing', n); continue; }
  const m = src.match(/const __iconData = (\{[\s\S]*?\});\n/);
  if (!m) { console.error('unparsed', n); continue; }
  const node = Function(`return ${m[1]}`)().node;
  out[n] = node.map(([tag, attrs]) => { const { key, ...rest } = attrs; return [tag, rest]; });
}
writeFileSync('src/catalogue/foundation/icons.ts', `/* Icon data from Lucide (https://lucide.dev), ISC licence. Copyright (c) Lucide contributors. */\nexport type IconElement = [string, Record<string, string | number>];\nexport const ICONS: Record<string, IconElement[]> = ${JSON.stringify(out)};\n`);
console.log(Object.keys(out).length, 'icons');
