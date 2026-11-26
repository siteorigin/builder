import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from './menu-commands';

/** What the application menu's own items do: hand a File command to the editor, or route Undo and Redo through it. */
export interface AppMenuActions {
  command: (cmd: MenuCommand) => void;
  history: (action: 'undo' | 'redo') => NonNullable<MenuItemConstructorOptions['click']>;
  /** Open the third-party notices file (noticesFile) with the desktop's text viewer. */
  openNotices: () => void;
}

/** The notices file the build writes (build/notices.cjs): beside LICENSE.txt in a packaged app's resources, under .tmp/notices after `npm run build`. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

/** Where the third-party notices are, for a packaged app (its resources folder) or a development one (the repository). */
export function noticesFile(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, NOTICES_FILE) : join(appPath, '.tmp', 'notices', NOTICES_FILE);
}

/**
 * The application menu bar for a platform, as data: File (with Open Project Folder… where the pickers cannot take a file
 * or a folder at once), Edit (Undo and Redo routed through the editor, then Electron's text roles), View, Window and Help
 * (the third-party notices).
 * Export and Close Project are offered only while a project is open. No Electron import, so the menu can be listed for
 * every platform in a test (tests/coverage/surfaces.ts).
 */
export function appMenuTemplate(platform: NodeJS.Platform, projectOpen: boolean, actions: AppMenuActions): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
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
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
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
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    editMenu,
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ id: 'third-party-notices', label: 'Third-Party Notices', click: () => actions.openNotices() }] }
  ];
}
