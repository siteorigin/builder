import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, offersDeveloperItems, type AppMenuActions } from '../../src/main/app-menu';

const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
const actions = (): AppMenuActions & { command: ReturnType<typeof vi.fn>; openLink: ReturnType<typeof vi.fn>; about: ReturnType<typeof vi.fn> } =>
  ({ command: vi.fn(), history: () => () => undefined, openLink: vi.fn(), about: vi.fn(), openNotices: vi.fn() }) as never;
const menu = (p: NodeJS.Platform, label: string, developer = false, a = actions()) =>
  appMenuTemplate(p, { projectOpen: true, developer }, a).find((m) => m.label === label)?.submenu as MenuItemConstructorOptions[] | undefined;
const click = (item: MenuItemConstructorOptions | undefined) => (item!.click as () => void)();

describe('the application menu (#810)', () => {
  it('offers Settings… on Cmd/Ctrl+, in the app menu on macOS and the File menu elsewhere, sending the settings command', () => {
    for (const p of PLATFORMS) {
      const a = actions();
      const where = p === 'darwin' ? 'SiteOrigin Builder' : 'File';
      const item = menu(p, where, false, a)?.find((i) => i.label === 'Settings…');
      expect(item?.accelerator, p).toBe('CmdOrCtrl+,');
      click(item);
      expect(a.command).toHaveBeenCalledWith('settings');
      // Only one Settings… per platform.
      const all = appMenuTemplate(p, { projectOpen: false, developer: false }, a).flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : [])).filter((i) => i.label === 'Settings…');
      expect(all, p).toHaveLength(1);
    }
    // macOS keeps its own app menu items around Settings….
    expect(menu('darwin', 'SiteOrigin Builder')!.map((i) => i.role ?? i.label ?? i.type)).toEqual(['about', 'separator', 'Settings…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']);
    expect(appMenuTemplate('win32', { projectOpen: true, developer: false }, actions()).some((m) => m.label === 'SiteOrigin Builder')).toBe(false);
  });

  it('has a Help menu on every platform that links to the website, and About with the version off macOS', () => {
    for (const p of PLATFORMS) {
      const a = actions();
      const help = menu(p, 'Help', false, a)!;
      expect(help, p).toBeDefined();
      click(help.find((i) => i.label === 'SiteOrigin Website'));
      expect(a.openLink).toHaveBeenCalledWith('https://siteorigin.com');
      const about = help.find((i) => i.label === 'About SiteOrigin Builder');
      if (p === 'darwin') expect(about).toBeUndefined();
      else {
        click(about);
        expect(a.about).toHaveBeenCalledOnce();
      }
    }
  });

  it('offers Reload and the developer tools only to developers', () => {
    const dev = ['reload', 'forceReload', 'toggleDevTools'];
    for (const p of PLATFORMS) {
      const roles = (developer: boolean) => menu(p, 'View', developer)!.map((i) => i.role).filter(Boolean);
      expect(roles(false), p).toEqual(['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
      expect(roles(true), p).toEqual([...dev, 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
      // Nothing else in the menu offers them, nor the stock View menu that would.
      const everywhere = JSON.stringify(appMenuTemplate(p, { projectOpen: true, developer: false }, actions()));
      for (const r of [...dev, 'viewMenu']) expect(everywhere, `${p} ${r}`).not.toContain(`"${r}"`);
    }
  });

  it('counts a development build run by a person, or Developer mode, as a developer; an automated run as an author', () => {
    const cases = [
      [{ packaged: false, automated: false, developerMode: false }, true],
      [{ packaged: false, automated: true, developerMode: false }, false],
      [{ packaged: true, automated: false, developerMode: false }, false],
      [{ packaged: true, automated: false, developerMode: true }, true],
      [{ packaged: false, automated: true, developerMode: true }, true]
    ] as const;
    for (const [launch, developer] of cases) expect(offersDeveloperItems(launch), JSON.stringify(launch)).toBe(developer);
  });
});
