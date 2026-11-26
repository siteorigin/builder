import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The picture a window shows in its title bar and the taskbar, or undefined to leave it to the platform.
 *
 * macOS takes the icon from the app bundle (and, in development, the dock icon set at startup). A packaged Windows
 * app takes it from its executable. Everywhere else a window shows Electron's own icon unless it is given one: a
 * Windows or Linux development run, and a packaged Linux app, whose executable carries no icon. Those use the app's
 * icon from the source tree in development, and the copy shipped beside the app's resources when packaged.
 */
export function windowIcon(opts: { platform: NodeJS.Platform; packaged: boolean; here: string; resourcesPath: string; exists?: (path: string) => boolean }): string | undefined {
  const { platform, packaged, here, resourcesPath, exists = existsSync } = opts;
  if (platform === 'darwin' || (packaged && platform === 'win32')) return undefined;
  const icon = packaged ? join(resourcesPath, 'icon.png') : join(here, '..', '..', 'build', 'icon.png');
  return exists(icon) ? icon : undefined;
}
