/**
 * Capture sheets for reviewing the app icon where people actually see it: the master, a macOS Dock among real
 * neighbours (drawn by macOS itself, from the asset catalog and .icns the app ships, so macOS 26's own treatment is
 * what shows), the small sizes, the Windows taskbar and Start menu, a Linux dash, and the in-app mark. Opt-in and never
 * part of a build or test run:
 *
 *   ICON_CAPTURE_DIR=/some/dir node scripts/app-icon/capture.mjs
 *
 * It reads the shipped files that scripts/app-icon/build.mjs writes (build/Assets.car, icon.icns, icon.ico,
 * icon-flat.png), and draws the in-app mark with AppMark's own code. ICON_SOURCE=<a 1024 px PNG> captures a candidate
 * in their place. The macOS sheets need macOS (swift); elsewhere they are skipped and named. Every sheet is checked
 * after it is written, and the run fails rather than leave a sheet it could not verify.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { appMarkMarkup, MARK_VIEWBOX } from '../../src/shared/app-icon.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.env.ICON_CAPTURE_DIR;
if (!out) throw new Error('Set ICON_CAPTURE_DIR to the directory the sheets go in.');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'app-icon-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const candidate = process.env.ICON_SOURCE && resolve(process.env.ICON_SOURCE);
const shipped = (name) => join(root, 'build', name);
if (!candidate) {
  const drawing = statSync(join(root, 'src/shared/app-icon.ts')).mtimeMs;
  for (const f of ['icon.png', 'icon-flat.png', 'icon.ico', 'icon.icns', 'Assets.car', 'icons/48x48.png']) {
    if (!existsSync(shipped(f))) throw new Error(`Missing build/${f}: run node scripts/app-icon/build.mjs`);
    if (statSync(shipped(f)).mtimeMs + 1000 < drawing) throw new Error(`build/${f} is older than src/shared/app-icon.ts: run node scripts/app-icon/build.mjs`);
  }
}
const resized = (file, px, kernel = 'lanczos3') => sharp(file, { density: 300 }).resize(px, px, { kernel }).png().toBuffer();

/** The .icns's own renditions by pixel size (what macOS before 26, and the disk image, show). */
const icnsReps = new Map();
if (!candidate && process.platform === 'darwin') {
  const set = join(work, 'shipped.iconset');
  execFileSync('iconutil', ['-c', 'iconset', shipped('icon.icns'), '-o', set]);
  for (const f of readdirSync(set)) {
    const m = f.match(/^icon_(\d+)x\d+(@2x)?\.png$/);
    if (m) icnsReps.set(Number(m[1]) * (m[2] ? 2 : 1), join(set, f));
  }
}
/** The .ico's own entries by size (Windows scales the nearest larger one for sizes it lacks). */
const icoEntries = new Map();
if (!candidate) {
  const ico = readFileSync(shipped('icon.ico'));
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const at = 6 + 16 * i;
    icoEntries.set(ico.readUInt8(at) || 256, ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8)));
  }
}
const art = {
  mac: (px) => (candidate ? resized(candidate, px) : icnsReps.has(px) ? readFileSync(icnsReps.get(px)) : resized(shipped('icon.png'), px)),
  win: (px) => {
    if (candidate) return resized(candidate, px);
    const size = [...icoEntries.keys()].sort((a, b) => a - b).find((s) => s >= px) ?? 256;
    return size === px ? Promise.resolve(icoEntries.get(size)) : resized(icoEntries.get(size), px);
  },
  linux: (px) => {
    if (candidate) return resized(candidate, px);
    // The hicolor size at or above px, scaled as the desktop would.
    const size = [16, 24, 32, 48, 64, 128, 256, 512].find((s) => s >= px) ?? 512;
    return resized(shipped(`icons/${size}x${size}.png`), px);
  },
  /** The in-app mark, drawn by AppMark's code; a candidate's is its tile, cropped from the master. */
  mark: async (px) => candidate
    ? sharp(await resized(candidate, Math.round((px * 1024) / 824))).extract({ left: Math.round((px * 100) / 824), top: Math.round((px * 100) / 824), width: px, height: px }).toBuffer()
    : sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${MARK_VIEWBOX}">${appMarkMarkup(px, 'm')}</svg>`), { density: 300 }).resize(px, px).png().toBuffer(),
  readme: (px) => resized(candidate ?? shipped('icon-flat.png'), px),
};

const font = `-apple-system, 'SF Pro Text', 'Segoe UI', sans-serif`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const label = (text, x, y, { size = 22, fill = '#555', weight = 500, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(text)}</text>`;
const written = [];
async function sheet(name, width, height, background, layers, overlaySvg = '') {
  const file = join(out, name);
  const base = sharp({ create: { width, height, channels: 4, background } });
  const all = [...layers];
  if (overlaySvg) all.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlaySvg}</svg>`), top: 0, left: 0 });
  await base.composite(all).png().toFile(file);
  const meta = await sharp(file).metadata();
  if (meta.width !== width || meta.height !== height) throw new Error(`${name} came out ${meta.width}x${meta.height}`);
  written.push(file);
}
const bg = (svgBody, w, h) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svgBody}</svg>`), top: 0, left: 0 });

// 1. The master, on a light and a dark desktop.
{
  const ic = await sharp(await art.mac(1024)).resize(520, 520).png().toBuffer();
  await sheet('01-master.png', 1200, 640, '#ffffff', [
    bg(`<rect width="600" height="640" fill="#e8ebf0"/><rect x="600" width="600" height="640" fill="#1c1e24"/>`, 1200, 640),
    { input: ic, left: 40, top: 70 }, { input: ic, left: 640, top: 70 },
  ], label(`${candidate ? 'Candidate' : 'build/icon.png'}, 1024 shown at 520 — light desktop`, 40, 44) + label('dark desktop', 640, 44, { fill: '#aaa' }));
}

// 2-4. macOS, drawn by macOS: Dock rows among real neighbours, and a 256 px row to check the squircle.
const macSkipped = process.platform !== 'darwin';
/** What macOS itself drew at 16 and 32 px, for sheet 5. */
const macDrawn = {};
if (!macSkipped) {
  {
    // A throwaway bundle at a fresh path, so the system's icon cache cannot hand back an earlier icon.
    const app = join(work, `SiteOrigin Builder ${Date.now()}.app`);
    mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
    // A real executable, or macOS draws its "can't be opened" badge over the icon.
    mkdirSync(join(app, 'Contents/MacOS'));
    copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/capture'));
    // The shipped icon as the packaged app carries it (the .icns, and the asset catalog macOS 26 prefers), or a
    // candidate as a plain .icns.
    let iconName = '';
    if (candidate) {
      const set = join(work, 'candidate.iconset');
      mkdirSync(set);
      for (const s of [16, 32, 128, 256, 512]) {
        writeFileSync(join(set, `icon_${s}x${s}.png`), await resized(candidate, s));
        writeFileSync(join(set, `icon_${s}x${s}@2x.png`), await resized(candidate, s * 2));
      }
      execFileSync('iconutil', ['-c', 'icns', set, '-o', join(app, 'Contents/Resources/icon.icns')]);
    } else {
      copyFileSync(shipped('icon.icns'), join(app, 'Contents/Resources/icon.icns'));
      copyFileSync(shipped('Assets.car'), join(app, 'Contents/Resources/Assets.car'));
      iconName = '<key>CFBundleIconName</key><string>AppIcon</string>';
    }
    writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIconFile</key><string>icon.icns</string>${iconName}<key>CFBundleExecutable</key><string>capture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIdentifier</key><string>com.siteorigin.builder.iconcapture${Date.now()}</string><key>CFBundleName</key><string>SiteOrigin Builder</string></dict></plist>`);
    const neighbours = [
      '/System/Library/CoreServices/Finder.app', '/Applications/Safari.app', '/System/Applications/Notes.app',
      '/Applications/Pages.app', '/Applications/Xcode.app', '/Applications/Visual Studio Code.app',
      '/Applications/Obsidian.app', '/Applications/Slack.app', '/System/Applications/Mail.app', '/System/Applications/Photos.app',
    ].filter(existsSync).map((p) => realpathSync(p)).slice(0, 8); // resolved, or a symlinked app gets an alias badge
    const rendered = new Map();
    const render = (px) => {
      if (rendered.has(px)) return rendered.get(px);
      const dir = join(work, `r${px}`);
      mkdirSync(dir);
      execFileSync('swift', [join(root, 'scripts/app-icon/system-icon.swift'), String(px), dir, ...neighbours, app]);
      const byName = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.png$/, ''), join(dir, f)]));
      const ours = byName[app.split('/').pop().replace(/\.app$/, '')];
      if (!ours) throw new Error('macOS did not render the capture bundle');
      const result = { ours, others: neighbours.map((n) => byName[n.split('/').pop().replace(/\.app$/, '')]).filter(Boolean) };
      rendered.set(px, result);
      return result;
    };
    const dockRow = async (name, dark) => {
      const { ours, others } = render(128);
      const row = [...others.slice(0, 5), ours, ...others.slice(5)];
      const w = 160 + row.length * 140, h = 420;
      const wall = dark
        ? `<defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2540"/><stop offset="1" stop-color="#0b0f1a"/></linearGradient></defs>`
        : `<defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dfe9f5"/><stop offset="1" stop-color="#f6efe6"/></linearGradient></defs>`;
      const dock = dark ? `fill="#2a2d35" fill-opacity="0.72" stroke="#ffffff" stroke-opacity="0.14"` : `fill="#ffffff" fill-opacity="0.55" stroke="#ffffff" stroke-opacity="0.8"`;
      const ourX = 80 + 5 * 140 + 6;
      await sheet(name, w, h, '#000000', [
        bg(`${wall}<rect width="${w}" height="${h}" fill="url(#w)"/><rect x="60" y="230" width="${w - 120}" height="164" rx="40" ${dock} stroke-width="1.5"/>`, w, h),
        ...row.map((f, i) => ({ input: f, left: 80 + i * 140 + 6, top: 246 })),
      ], label(`macOS Dock, ${dark ? 'dark' : 'light'} — rendered by macOS at 64 pt @2x; ours is 6th`, 60, 60, { fill: dark ? '#c8cbd3' : '#444' }) +
        `<circle cx="${ourX + 64}" cy="384" r="4" fill="${dark ? '#ffffff' : '#222'}" fill-opacity="0.75"/>`);
    };
    await dockRow('02-macos-dock-light.png', false);
    await dockRow('03-macos-dock-dark.png', true);
    // macOS 26 shrinks an icon it does not take for one of its own into a grey tile ("icon jail"), size by size: a
    // legacy .icns always at 16 and 32 px, and at any size when a shape strays outside Apple's tile. A jailed icon is
    // the artwork shrunk to about four fifths inside a grey frame, so compare the middle of what macOS drew with the
    // artwork at full size and shrunk: whichever it is closer to says which it is. (The middle, because the glass edge
    // and the frame both sit at the rim.) A candidate is previewed as a plain .icns, boxed below 128 px whatever its shape.
    const middle = async (input, px, scale) => {
      const s = Math.round(px * scale), m = Math.round(px * 0.25), w = px - 2 * m;
      const art = await sharp(input).resize(s, s).png().toBuffer();
      const canvas = await sharp({ create: { width: px, height: px, channels: 4, background: '#808080' } })
        .composite([{ input: art, left: Math.round((px - s) / 2), top: Math.round((px - s) / 2) }]).png().toBuffer();
      return sharp(canvas).extract({ left: m, top: m, width: w, height: w }).flatten({ background: '#808080' }).raw().toBuffer();
    };
    const distance = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    for (const px of candidate ? [128, 256, 512] : [16, 32, 64, 128, 256, 512]) {
      const { ours: drawn } = render(px);
      // macOS 26 draws the asset catalog's one drawing at every size, so it is compared with the full drawing.
      const art = candidate ?? shipped('icon.png');
      const seen = await middle(drawn, px, 1);
      const [asDrawn, asJailed] = [distance(seen, await middle(art, px, 1)), Math.min(distance(seen, await middle(art, px, 0.8)), distance(seen, await middle(art, px, 0.75)))];
      if (asJailed < asDrawn) throw new Error(`At ${px} px macOS drew the icon shrunk inside a grey tile (icon jail): ${asJailed.toFixed(1)} from the shrunk artwork against ${asDrawn.toFixed(1)} from the artwork. Keep every shape inside the tile.`);
    }
    if (!candidate) for (const px of [16, 32]) macDrawn[px] = render(px).ours;
    console.log(`macOS draws the icon as drawn at ${candidate ? '128' : '16'}-512 px (no icon jail)`);
    {
      const { ours, others } = render(256);
      const row = [ours, ...others.slice(0, 3)];
      const w = 80 + row.length * 300, h = 760;
      await sheet('04-macos-256.png', w, h, '#ffffff', [
        bg(`<rect width="${w}" height="380" fill="#ececef"/><rect y="380" width="${w}" height="380" fill="#1e1f23"/>`, w, h),
        ...row.flatMap((f, i) => [{ input: f, left: 60 + i * 300, top: 80 }, { input: f, left: 60 + i * 300, top: 460 }]),
      ], label('Drawn by macOS at 256 px: ours first, then system apps for squircle size and weight', 60, 48) +
        label('same on dark', 60, 428, { fill: '#aaa' }));
    }
  }
}

// 5. Small sizes at real pixels, and zoomed with hard pixels so the reviewer can read what 16 and 32 px really hold.
{
  const sizes = [16, 32, 48, 64, 128];
  const w = macDrawn[16] ? 2000 : 1400, h = 760;
  const layers = [bg(`<rect width="${w}" height="380" fill="#f5f5f7"/><rect y="380" width="${w}" height="380" fill="#1e1e22"/>`, w, h)];
  let x = 60;
  for (const s of sizes) {
    const img = await art.mac(s);
    layers.push({ input: img, left: x, top: 200 - s / 2 }, { input: img, left: x, top: 580 - s / 2 });
    x += s + 50;
  }
  const zoom = async (img) => sharp(img).resize(256, 256, { kernel: 'nearest' }).toBuffer();
  const zooms = [[await art.mac(16), 780], [await art.mac(32), 1080]];
  // macOS 26 draws the asset catalog's one drawing at every size: show what it drew, beside the .icns renditions.
  if (macDrawn[16]) zooms.push([readFileSync(macDrawn[16]), 1400], [readFileSync(macDrawn[32]), 1700]);
  for (const [img, left] of zooms) {
    const z = await zoom(img);
    layers.push({ input: z, left, top: 62 }, { input: z, left, top: 442 });
  }
  await sheet('05-small-sizes.png', w, h, '#ffffff', layers,
    label('Actual pixels: 16, 32, 48, 64, 128 (.icns)', 60, 44) + label('.icns 16 px ×16', 780, 44) + label('.icns 32 px ×8', 1080, 44) +
    (macDrawn[16] ? label('macOS 26, 16 px ×16', 1400, 44) + label('macOS 26, 32 px ×8', 1700, 44) : '') +
    label('on dark', 60, 424, { fill: '#aaa' }));
}

// 6. Windows 11: taskbar at 100% and 150%, light and dark, a Start menu entry and Alt+Tab, from the .ico's entries.
{
  const w = 1400, h = 700;
  const layers = [bg(`<rect width="${w}" height="${h}" fill="#dde3ea"/>
    <rect x="40" y="90" width="620" height="48" fill="#eef0f3"/><rect x="740" y="90" width="620" height="48" fill="#1f1f1f"/>
    <rect x="40" y="220" width="620" height="72" fill="#eef0f3"/><rect x="740" y="220" width="620" height="72" fill="#1f1f1f"/>
    <rect x="40" y="380" width="620" height="270" rx="8" fill="#f3f3f3"/><rect x="740" y="380" width="620" height="270" rx="8" fill="#2b2b2b"/>`, w, h)];
  const [ic24, ic36, ic32, ic48] = await Promise.all([24, 36, 32, 48].map((px) => art.win(px)));
  const glyph = (x, y, s, fill) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s / 5}" fill="${fill}"/>`;
  let shapes = '';
  for (const [left, dark] of [[40, false], [740, true]]) {
    const g = dark ? '#5a5a5a' : '#b9bec6';
    for (let i = 0; i < 6; i++) if (i !== 3) shapes += glyph(left + 200 + i * 44, 102, 24, g) + glyph(left + 160 + i * 66, 238, 36, g);
    layers.push({ input: ic24, left: left + 200 + 3 * 44, top: 102 }, { input: ic36, left: left + 160 + 3 * 66, top: 238 });
    shapes += `<rect x="${left + 200 + 3 * 44 + 6}" y="132" width="12" height="3" rx="1.5" fill="#4c9be8"/>`;
    shapes += `<rect x="${left + 160 + 3 * 66 + 10}" y="285" width="16" height="4" rx="2" fill="#4c9be8"/>`;
    const tc = dark ? '#ffffff' : '#1a1a1a';
    for (let i = 0; i < 4; i++) {
      const col = left + 40 + i * 140;
      if (i === 1) layers.push({ input: ic48, left: col + 30, top: 430 });
      else shapes += glyph(col + 34, 434, 40, g);
      shapes += label(i === 1 ? 'SiteOrigin' : 'App', col + 54, 512, { size: 15, fill: tc, anchor: 'middle', weight: 400 });
      if (i === 1) shapes += label('Builder', col + 54, 532, { size: 15, fill: tc, anchor: 'middle', weight: 400 });
    }
    layers.push({ input: ic32, left: left + 40, top: 584 });
    shapes += label('SiteOrigin Builder — Alt+Tab / title bar, 32 px', left + 86, 606, { size: 15, fill: tc, weight: 400 });
  }
  await sheet('06-windows.png', w, h, '#ffffff', layers,
    shapes + label('Windows 11 taskbar 100% (24 px), light / dark', 40, 70) + label('Taskbar 150% (36 px)', 40, 206) + label('Start menu (48 px) and Alt+Tab (32 px)', 40, 366));
}

// 7. Linux (GNOME): the dash and the app grid, from the per-size PNGs Linux is packaged with.
{
  const w = 1200, h = 520;
  const [ic48, ic96] = await Promise.all([art.linux(48), art.linux(96)]);
  const layers = [bg(`<rect width="${w}" height="${h}" fill="#2c2f38"/><rect x="40" y="70" width="560" height="80" rx="24" fill="#3a3d46"/>`, w, h)];
  let shapes = '';
  for (let i = 0; i < 7; i++) if (i !== 4) shapes += `<circle cx="${90 + i * 72}" cy="110" r="24" fill="#6b6f7a"/>`;
  layers.push({ input: ic48, left: 90 + 4 * 72 - 24, top: 86 });
  for (let i = 0; i < 5; i++) {
    const x = 60 + i * 220;
    if (i === 2) layers.push({ input: ic96, left: x + 52, top: 230 });
    else shapes += `<rect x="${x + 52}" y="230" width="96" height="96" rx="22" fill="#5d616c"/>`;
    shapes += label(i === 2 ? 'SiteOrigin Builder' : 'App', x + 100, 360, { size: 17, fill: '#ffffff', anchor: 'middle', weight: 400 });
  }
  await sheet('07-linux.png', w, h, '#000000', layers, shapes + label('GNOME dash (48 px) and app grid (96 px)', 40, 44, { fill: '#c8cbd3' }));
}

// 8. Where the mark lives in the app and the repo: the toolbar (22 px), Welcome (48 px), and the README header (64 px).
{
  const w = 1200, h = 420;
  const layers = [bg(`<rect width="600" height="${h}" fill="#f4f6f9"/><rect x="600" width="600" height="${h}" fill="#171c25"/>
    <rect x="40" y="70" width="520" height="44" fill="#ffffff" stroke="#e3e7ee"/><rect x="640" y="70" width="520" height="44" fill="#1d232e" stroke="#2a3140"/>`, w, h)];
  let shapes = '';
  for (const [left, dark] of [[40, false], [640, true]]) {
    layers.push({ input: await art.mark(22), left: left + 14, top: 81 });
    for (let i = 0; i < 4; i++) shapes += `<rect x="${left + 60 + i * 34}" y="83" width="18" height="18" rx="4" fill="${dark ? '#4a5263' : '#c5ccd8'}"/>`;
    layers.push({ input: await art.mark(48), left: left + 20, top: 170 });
    shapes += label('SiteOrigin Builder', left + 84, 202, { size: 22, weight: 600, fill: dark ? '#e8ecf3' : '#23304f' });
    layers.push({ input: await art.readme(64), left: left + 20, top: 290 });
    shapes += label('README header, build/icon-flat.png at 64', left + 100, 328, { size: 15, fill: dark ? '#9aa3b2' : '#5b6475', weight: 400 });
  }
  await sheet('08-in-app.png', w, h, '#ffffff', layers, shapes + label('In the app: toolbar (22 px), Welcome (48 px)', 40, 44) + label('dark', 640, 44, { fill: '#9aa3b2' }));
}

// 9. macOS 26's six appearances (default, dark, tinted light and dark, clear light and dark), drawn by Icon Composer's
// own renderer from build/AppIcon.icon. Needs Xcode 26; skipped and named otherwise.
const ictool = '/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool';
const appearancesSkipped = candidate || !existsSync(ictool);
if (!appearancesSkipped) {
  const looks = ['Default', 'Dark', 'TintedLight', 'TintedDark', 'ClearLight', 'ClearDark'];
  const layers = [bg(`<rect width="1180" height="760" fill="#8a909b"/>`, 1180, 760)];
  let text = label('macOS 26 appearances, from build/AppIcon.icon (Icon Composer renderer, 256 px)', 40, 44, { fill: '#fff' });
  for (const [i, look] of looks.entries()) {
    const file = join(work, `${look}.png`);
    execFileSync(ictool, [shipped('AppIcon.icon'), '--export-image', '--output-file', file, '--platform', 'macOS', '--rendition', look, '--width', '256', '--height', '256', '--scale', '1'], { stdio: 'ignore' });
    if (!existsSync(file)) throw new Error(`Icon Composer drew no ${look} appearance`);
    const x = 60 + (i % 3) * 370, y = 90 + Math.floor(i / 3) * 340;
    layers.push({ input: await sharp(file).resize(256, 256).png().toBuffer(), left: x, top: y });
    text += label(look, x + 128, y + 290, { fill: '#fff', anchor: 'middle', size: 20 });
  }
  await sheet('09-appearances.png', 1180, 760, '#000000', layers, text);
}

console.log(`CAPTURED ${written.length} sheets in ${out}${macSkipped ? ' (macOS sheets skipped: not on macOS)' : ''}${appearancesSkipped ? ' (appearance sheet skipped: a candidate, or no Xcode 26)' : ''}`);
for (const f of written) console.log(f);
