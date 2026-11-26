import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from './menu-commands';

/** What the application menu's own items do: hand a command to the editor, route Undo and Redo through it, open a
 *  link outside the app, show the app's name and version (Windows and Linux, which have no About panel), or open the
 *  third-party notices. */
export interface AppMenuActions {
  command: (cmd: MenuCommand) => void;
  history: (action: 'undo' | 'redo') => NonNullable<MenuItemConstructorOptions['click']>;
  openLink: (url: string) => void;
  about: () => void;
  /** Open the third-party notices file (noticesFile) with the desktop's text viewer. */
  openNotices: () => void;
}

/** The notices file the build writes (build/notices.cjs): beside LICENSE.txt in a packaged app's resources, under .tmp/notices after `npm run build`. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

/** Where the third-party notices are, for a packaged app (its resources folder) or a development one (the repository). */
export function noticesFile(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, NOTICES_FILE) : join(appPath, '.tmp', 'notices', NOTICES_FILE);
}

export interface AppMenuOptions {
  /** A project is open: Export and Close Project are offered. */
  projectOpen: boolean;
  /** Reload and the developer tools are offered: a development build, or Developer mode on. */
  developer: boolean;
}

/** Whether the menu offers Reload and the developer tools: in a development build run by a person (an automated run
 *  gets the menu an author has, so a test sees it), or with Developer mode on. */
export function offersDeveloperItems({ packaged, automated, developerMode }: { packaged: boolean; automated: boolean; developerMode: boolean }): boolean {
  return (!packaged && !automated) || developerMode;
}

/** The Help menu's link. */
export const WEBSITE_URL = 'https://siteorigin.com';

/**
 * The application menu bar for a platform, as data: the app menu (macOS, with Settings…), File (with Open Project
 * Folder… where the pickers cannot take a file or a folder at once, and Settings… off macOS), Edit (Undo and Redo
 * routed through the editor, then Electron's text roles), View, Window and Help (the website, the third-party notices,
 * and About off macOS). Export and Close Project are offered only while a project is open; Reload and the developer
 * tools only to developers. No Electron import, so the menu can be listed for every platform in a test
 * (tests/coverage/surfaces.ts).
 */
export function appMenuTemplate(platform: NodeJS.Platform, { projectOpen, developer }: AppMenuOptions, actions: AppMenuActions): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const settings: MenuItemConstructorOptions = { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => actions.command('settings') };
  const send = (cmd: MenuCommand) => () => actions.command(cmd);
  // Electron's own Edit menu, with Undo and Redo routed through the editor.
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { id: 'edit-undo', label: 'Undo', accelerator: 'CommandOrControl+Z', click: actions.history('undo') },
      { id: 'edit-redo', label: 'Redo', accelerator: platform === 'win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z', click: actions.history('redo') },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            { label: 'Substitutions', submenu: [{ role: 'showSubstitutions' }, { type: 'separator' }, { role: 'toggleSmartQuotes' }, { role: 'toggleSmartDashes' }, { role: 'toggleTextReplacement' }] },
            { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
          ] satisfies MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] satisfies MenuItemConstructorOptions[]))
    ]
  };
  // Electron's own View menu, less Reload and the developer tools for anyone but a developer.
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      ...(developer ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] satisfies MenuItemConstructorOptions[]) : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  };
  return [
    ...(isMac
      ? [
          {
            // macOS names the first menu after the app whatever its label says; the label names it for the tests.
            label: 'SiteOrigin Builder',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ] satisfies MenuItemConstructorOptions[]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
        // Open Project's picker takes a file or ZIP file here; a project folder has its own.
        ...(isMac ? [] : [{ label: 'Open Project Folder…', click: send('open-project-folder') }]),
        { type: 'separator' },
        { id: 'export', label: 'Export…', accelerator: 'CmdOrCtrl+E', enabled: projectOpen, click: send('export') },
        { type: 'separator' },
        { id: 'close-project', label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', enabled: projectOpen, click: send('close-project') },
        // macOS keeps Settings in the app menu; Windows and Linux have none.
        ...(isMac ? [] : [{ type: 'separator' as const }, settings, { type: 'separator' as const }]),
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    editMenu,
    viewMenu,
    { role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: 'SiteOrigin Website', click: () => actions.openLink(WEBSITE_URL) },
        { id: 'third-party-notices', label: 'Third-Party Notices', click: () => actions.openNotices() },
        // macOS shows the version in the app menu's About panel.
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'About SiteOrigin Builder', click: actions.about }])
      ]
    }
  ];
}
