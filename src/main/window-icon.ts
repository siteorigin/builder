import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The picture a window shows in its title bar and the taskbar, or undefined to leave it to the platform.
 *
 * macOS takes the icon from the app bundle (and, in development, the dock icon set at startup). A packaged Windows
 * app takes it from its executable. Everywhere else a window shows Electron's own icon unless it is given one: a
 * Windows or Linux development run, and a packaged Linux app, whose executable carries no icon. Those use the app's
 * edge-to-edge icon (build/icon-flat.png, the one Windows and Linux are packaged with) from the source tree in
 * development, and the copy shipped beside the app's resources when packaged (electron-builder.yml).
 */
export function windowIcon(opts: { platform: NodeJS.Platform; packaged: boolean; here: string; resourcesPath: string; exists?: (path: string) => boolean }): string | undefined {
  const { platform, packaged, here, resourcesPath, exists = existsSync } = opts;
  if (platform === 'darwin' || (packaged && platform === 'win32')) return undefined;
  const icon = packaged ? join(resourcesPath, 'icon.png') : join(here, '..', '..', 'build', 'icon-flat.png');
  return exists(icon) ? icon : undefined;
}

/**
 * Where Help › About on Windows and Linux takes its picture from, which a message box otherwise draws as the platform's
 * generic "information" sign: the executable itself for a packaged Windows app (its icon is the app's, and nothing
 * else of it ships), the window's icon file everywhere else. macOS shows its own About panel, with the bundle's icon.
 */
export function aboutIcon(opts: { platform: NodeJS.Platform; packaged: boolean; here: string; resourcesPath: string; execPath: string; exists?: (path: string) => boolean }): { executable: string } | { file: string } | undefined {
  if (opts.platform === 'darwin') return undefined;
  if (opts.packaged && opts.platform === 'win32') return { executable: opts.execPath };
  const file = windowIcon(opts);
  return file ? { file } : undefined;
}
