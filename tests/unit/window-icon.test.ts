import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aboutIcon, windowIcon } from '../../src/main/window-icon';

const here = join('/app', 'out', 'main');
const resourcesPath = join('/opt', 'SiteOrigin Builder', 'resources');
const devIcon = join('/app', 'build', 'icon-flat.png');
const shippedIcon = join(resourcesPath, 'icon.png');
const all = () => true;

describe('the window icon', () => {
  it('gives a Windows or Linux development window the app icon, not Electron’s', () => {
    expect(windowIcon({ platform: 'win32', packaged: false, here, resourcesPath, exists: all })).toBe(devIcon);
    expect(windowIcon({ platform: 'linux', packaged: false, here, resourcesPath, exists: all })).toBe(devIcon);
  });

  it('gives a packaged Linux window the icon shipped beside its resources', () => {
    expect(windowIcon({ platform: 'linux', packaged: true, here, resourcesPath, exists: all })).toBe(shippedIcon);
  });

  it('leaves macOS and a packaged Windows app to the icon their bundle or executable carries', () => {
    for (const packaged of [true, false]) expect(windowIcon({ platform: 'darwin', packaged, here, resourcesPath, exists: all })).toBeUndefined();
    expect(windowIcon({ platform: 'win32', packaged: true, here, resourcesPath, exists: all })).toBeUndefined();
  });

  it('names no icon that is not there, so the platform’s own is kept', () => {
    expect(windowIcon({ platform: 'linux', packaged: true, here, resourcesPath, exists: () => false })).toBeUndefined();
  });

  it('finds the icon in this checkout for a development run', () => {
    expect(windowIcon({ platform: 'linux', packaged: false, here: join(process.cwd(), 'out', 'main'), resourcesPath })).toBe(join(process.cwd(), 'build', 'icon-flat.png'));
  });
});

describe('the icon Help › About shows', () => {
  const execPath = join('C:', 'Program Files', 'SiteOrigin Builder', 'SiteOrigin Builder.exe');

  it('takes a packaged Windows app’s own icon from its executable, rather than the generic information sign', () => {
    expect(aboutIcon({ platform: 'win32', packaged: true, here, resourcesPath, execPath, exists: () => false })).toEqual({ executable: execPath });
  });

  it('shows the window’s icon in a Windows or Linux development run, and in a packaged Linux app', () => {
    expect(aboutIcon({ platform: 'win32', packaged: false, here, resourcesPath, execPath, exists: all })).toEqual({ file: devIcon });
    expect(aboutIcon({ platform: 'linux', packaged: false, here, resourcesPath, execPath, exists: all })).toEqual({ file: devIcon });
    expect(aboutIcon({ platform: 'linux', packaged: true, here, resourcesPath, execPath, exists: all })).toEqual({ file: shippedIcon });
  });

  it('names nothing on macOS, whose About panel shows the bundle’s icon, or when the icon file is missing', () => {
    for (const packaged of [true, false]) expect(aboutIcon({ platform: 'darwin', packaged, here, resourcesPath, execPath, exists: all })).toBeUndefined();
    expect(aboutIcon({ platform: 'linux', packaged: true, here, resourcesPath, execPath, exists: () => false })).toBeUndefined();
  });
});
