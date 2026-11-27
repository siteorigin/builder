import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addoBox, appIconLayers, appIconSvg, appMarkMarkup, DESIGNS, detailFor, squircle } from '../../src/shared/app-icon';

const build = join(process.cwd(), 'build');

/** The tile's outline as a polygon, flattened from its path (M, L and C commands only). */
function outline(d: string): [number, number][] {
  const points: [number, number][] = [];
  let at: [number, number] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'M' || cmd === 'L') points.push((at = [n[0], n[1]]));
    if (cmd === 'C') {
      const [x1, y1, x2, y2, x, y] = n;
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const u = 1 - t;
        points.push([u ** 3 * at[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x, u ** 3 * at[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y]);
      }
      at = [x, y];
    }
  }
  return points;
}

function inside([x, y]: [number, number], poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('the app icon', () => {
  it('keeps Addo well inside the tile at every size, so macOS never crops or boxes him', () => {
    const margin = 40;
    const tile = outline(squircle(margin, margin, 824 - 2 * margin, 214 * ((824 - 2 * margin) / 824)));
    for (const [detail, d] of Object.entries(DESIGNS)) {
      const [x0, y0, x1, y1] = addoBox(d);
      // His box's sides at mid-height and its corners' inner points (the box corners themselves are empty space).
      for (const point of [[x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]] as [number, number][]) {
        expect(inside(point, tile), `${detail}: Addo reaches ${point}, outside the tile`).toBe(true);
      }
    }
  });

  it('draws each size with the detail it can carry', () => {
    expect([16, 20, 32, 36, 40, 48, 1024].map(detailFor)).toEqual(['tiny', 'small', 'small', 'small', 'full', 'full', 'full']);
  });

  it('ships generated files that match the drawing (run node scripts/app-icon/build.mjs after changing it)', () => {
    expect(readFileSync(join(build, 'AppIcon.icon', 'Assets', 'addo.svg'), 'utf8')).toBe(appIconLayers().addo);
    expect(readFileSync(join(build, 'icon.svg'), 'utf8')).toContain(appIconSvg({ frame: 'mac' }));
    expect(readFileSync(join(process.cwd(), 'relay', 'viewer', 'mark.svg'), 'utf8')).toContain(appMarkMarkup(24, 'mark'));
  });

  it('names the same asset catalog icon in the bundle as the build compiles', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    const script = readFileSync(join(process.cwd(), 'scripts', 'app-icon', 'build.mjs'), 'utf8');
    expect(builder).toMatch(/CFBundleIconName: AppIcon\b/);
    expect(script).toMatch(/'--app-icon', 'AppIcon'/);
  });
});
